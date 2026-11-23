import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { MessageId, RunId, ScheduledTaskUpsertInput, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as Secrets from "../secrets/SecretRequests.ts";
import * as Tasks from "./ScheduledTaskService.ts";
import * as State from "./ScheduledTaskState.ts";

const layerFiles = ServerConfig.layerTest(process.cwd(), { prefix: "scheduled-durability-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const input = Schema.decodeUnknownSync(ScheduledTaskUpsertInput)({
  id: "task:durability",
  title: "Review",
  prompt: "Review {{body.number}} {{body.missing}}",
  enabled: true,
  schedule: { type: "webhook" },
  projectId: "project:test",
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
});
const serviceLayer = (
  launch: Launch,
  threads: Partial<Threads.ThreadManagementService["Service"]> = {},
) =>
  Tasks.layer.pipe(
    Layer.provideMerge(State.layer),
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.mock(Scheduler.Scheduler)({
          register: (_name, work) => work.pipe(Effect.forkScoped, Effect.asVoid),
        }),
        Layer.mock(ThreadLaunch.ThreadLaunchService)({ launch }),
        Layer.mock(Threads.ThreadManagementService)(threads),
        Layer.mock(Secrets.SecretRequests)({}),
      ),
    ),
  );
type Launch = ThreadLaunch.ThreadLaunchService["Service"]["launch"];
const statePath = Effect.gen(function* () {
  return (yield* Path.Path).join(
    (yield* ServerConfig.ServerConfig).stateDir,
    "scheduled-task-state.json",
  );
});
const trigger = (
  task: { id: string; webhook?: { path: string } | undefined },
  relayDeliveryId: string,
) => ({
  hookId: task.id,
  token: task.webhook!.path.split("/").at(-1)!,
  relayDeliveryId,
  method: "POST",
  path: "/api/hooks/task",
  query: "",
  headers: { "content-type": "application/json" },
  bodyText: '{"number":7}',
  body: new TextEncoder().encode('{"number":7}'),
});

it.effect.each(["deleted chat", "missing projection", "transient error"] as const)(
  "records a webhook failure for a %s",
  (scenario) =>
    Effect.gen(function* () {
      const nextDispatch = yield* Deferred.make<void>();
      let attempts = 0;
      const missingProjection = (threadId: ThreadId) =>
        new Orchestrator.OrchestratorProjectionError({
          threadId,
          cause: new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId }),
        });
      const layer = serviceLayer(() => Effect.die("unexpected new chat"), {
        getThreadRecords: (threadId) =>
          scenario === "missing projection"
            ? Effect.fail(missingProjection(threadId))
            : Effect.succeed({ runs: [] } as never),
        sendToThread: ({ projectId, threadId }) =>
          Effect.gen(function* () {
            if (++attempts === 2) {
              yield* Deferred.succeed(nextDispatch, undefined);
              return yield* Effect.never;
            }
            return yield* scenario === "deleted chat"
              ? new Threads.ThreadManagementThreadNotFoundError({ projectId, threadId })
              : new Threads.ThreadManagementProjectionLoadError({
                  projectId,
                  threadId,
                  cause: scenario === "missing projection" ? missingProjection(threadId) : "busy",
                });
          }),
      });
      yield* Effect.gen(function* () {
        const service = yield* Tasks.ScheduledTaskService;
        const { task } = yield* service.upsert({ ...input, threadId: ThreadId.make("deleted") });
        const first = yield* service.triggerWebhook(trigger(task, "first"));
        assert(first._tag === "accepted");
        yield* service.subscribeList().pipe(
          Stream.filter(({ tasks }) =>
            tasks.some((t) => t.id === task.id && t.lastRunStatus === "failed"),
          ),
          Stream.runHead,
        );
        yield* service.triggerWebhook(trigger(task, "second"));
        // The per-task permit has passed to the next delivery, so the first worker finished.
        yield* Deferred.await(nextDispatch);
        const pending = (yield* (yield* State.ScheduledTaskState).read).deliveries;
        assert.equal(
          pending.some((entry) => entry.relayDeliveryId === "first"),
          scenario === "transient error",
        );
        if (scenario !== "transient error") {
          const reason =
            scenario === "deleted chat"
              ? `Thread deleted was not found in project ${task.projectId}.`
              : "No orchestration projection exists for thread deleted.";
          const { runs } = yield* service.listRuns({ id: task.id });
          assert.equal(runs.find((run) => run.id.endsWith("first"))?.error, reason);
          const { deliveries } = yield* service.listWebhookDeliveries({ id: task.id });
          assert.equal(
            deliveries.find((delivery) => delivery.id === first.deliveryId)?.error,
            reason,
          );
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, layerFiles))),
);

it.effect(
  "recovers accepted and waiting deliveries from disk and replays committed dispatch identities",
  () =>
    Effect.gen(function* () {
      const launches = yield* Queue.unbounded<ThreadLaunch.ThreadLaunchInput>();
      const hold = yield* Deferred.make<void>();
      const committed = new Set<string>();
      const effects: string[] = [];
      const launch: Launch = (request) =>
        Effect.gen(function* () {
          if (!committed.has(request.commandId)) {
            committed.add(request.commandId);
            effects.push(request.initialMessage!.text);
          }
          yield* Queue.offer(launches, request);
          yield* Deferred.await(hold);
          return {
            threadId: ThreadId.make(`thread:${request.commandId}`),
            resumed: false,
          } as never;
        });
      let webhookRequest: ReturnType<typeof trigger>;
      yield* Effect.gen(function* () {
        const service = yield* Tasks.ScheduledTaskService;
        const { task } = yield* service.upsert(input);
        webhookRequest = trigger(task, "first");
        assert.equal((yield* service.triggerWebhook(webhookRequest))._tag, "accepted");
        yield* Queue.take(launches); // The command committed, but the caller never saw its result.
        assert.equal((yield* service.triggerWebhook(trigger(task, "second")))._tag, "accepted");
        assert.lengthOf((yield* (yield* State.ScheduledTaskState).read).deliveries, 2);
      }).pipe(Effect.provide(serviceLayer(launch)));

      const fs = yield* FileSystem.FileSystem;
      const file = yield* statePath;
      assert.equal((yield* fs.stat(file)).mode & 0o777, 0o600);
      const saved = yield* fs.readFileString(file);
      assert.include(saved, '"prompt":"Review 7 "');
      assert.notInclude(saved, '"token"');

      yield* Effect.gen(function* () {
        const service = yield* Tasks.ScheduledTaskService;
        const recovered = yield* Queue.take(launches);
        assert.include(recovered.commandId, "delivery:relay:first");
        const duplicate = yield* service.triggerWebhook(webhookRequest!);
        assert.equal(duplicate._tag === "accepted" ? duplicate.outcome : "", "duplicate");
        assert.equal(yield* Queue.size(launches), 0);
        yield* Deferred.succeed(hold, undefined);
        const next = yield* Queue.take(launches);
        assert.include(next.commandId, "delivery:relay:second");
        assert.deepEqual(effects, ["Review 7 ", "Review 7 "]);
        // This persisted transition marks the second dispatch, with no sleeps or polling.
        yield* service.subscribeList().pipe(
          Stream.filter(
            ({ tasks }) => tasks[0]!.runCount >= 2 && tasks[0]!.lastRunStatus === "succeeded",
          ),
          Stream.runHead,
        );
      }).pipe(Effect.provide(serviceLayer(launch)));
    }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, layerFiles))),
);

it.effect("records dispatch separately from agent completion, paginates, and reloads history", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:history");
    const runs: Array<{
      id: RunId;
      userMessageId: MessageId;
      status: "queued" | "failed";
      completedAt: DateTime.Utc | null;
    }> = [];
    const layer = serviceLayer(
      (request) =>
        Effect.sync(() => {
          runs.push({
            id: RunId.make(`run:${request.commandId}`),
            userMessageId: request.initialMessage!.messageId!,
            status: "queued",
            completedAt: null,
          });
          return {
            threadId,
            projection: { thread: { id: threadId }, runs: [...runs] },
            resumed: false,
          } as never;
        }),
      { getThreadRecords: () => Effect.succeed({ runs } as never) },
    );
    yield* Effect.gen(function* () {
      const service = yield* Tasks.ScheduledTaskService;
      const { task } = yield* service.upsert({
        ...input,
        schedule: { type: "interval", everyMs: 60000 },
      });
      yield* service.runNow({ id: task.id });
      yield* service.runNow({ id: task.id });
      const first = yield* service.listRuns({ id: task.id, limit: 1 });
      assert.lengthOf(first.runs, 1);
      assert.equal(first.runs[0]!.dispatchStatus, "dispatched");
      assert.equal(first.runs[0]!.runStatus, "queued");
      assert.equal(first.runs[0]!.threadId, threadId);
      assert.isNotNull(first.nextCursor);
      const second = yield* service.listRuns({ id: task.id, before: first.nextCursor!, limit: 1 });
      assert.notEqual(first.runs[0]!.messageId, second.runs[0]!.messageId);
      assert.isNull(second.nextCursor);
      runs[1]!.status = "failed";
      runs[1]!.completedAt = now;
      const updated = (yield* service.listRuns({ id: task.id })).runs[0]!;
      assert.equal(updated.dispatchStatus, "dispatched");
      assert.equal(updated.runStatus, "failed");
      assert.equal(updated.finishedAt, DateTime.formatIso(now));
    }).pipe(Effect.provide(layer));
    yield* Effect.gen(function* () {
      const service = yield* Tasks.ScheduledTaskService;
      const history = yield* service.listRuns({ id: input.id! });
      assert.lengthOf(history.runs, 2);
      assert.equal(history.runs[0]!.runStatus, "failed");
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, layerFiles))),
);

it.effect(
  "previews the shared renderer with redaction, missing paths, and bounded output without dispatch or persistence",
  () =>
    Effect.gen(function* () {
      let dispatched = false;
      yield* Effect.gen(function* () {
        const service = yield* Tasks.ScheduledTaskService;
        const { task } = yield* service.upsert(input);
        const fs = yield* FileSystem.FileSystem;
        const file = yield* statePath;
        const before = yield* fs.exists(file);
        const preview = yield* service.previewWebhook({
          id: task.id,
          template: "{{headers}} {{query}} {{body.number}} {{body.nope}} {{headers.X-Event}}",
          method: "POST",
          path: "/sample",
          query: "token=secret&event=opened",
          headers: { Authorization: "private", "X-Event": "opened" },
          bodyText: '{"number":7}',
        });
        assert.notInclude(preview.prompt, "private");
        assert.notInclude(preview.prompt, "secret");
        assert.include(preview.prompt, "[redacted]");
        assert.include(preview.prompt, "7  opened");
        assert.deepEqual(preview.missing, ["body.nope"]);
        assert.equal(preview.characterCount, preview.prompt.length);
        assert.isFalse(preview.tooLong);
        const large = yield* service.previewWebhook({
          id: task.id,
          template: "{{body}}".repeat(100),
          method: "POST",
          path: "/sample",
          query: "",
          headers: {},
          bodyText: "x".repeat(65536),
        });
        assert.equal(large.characterCount, 6553600);
        assert.equal(large.prompt.length, 65536);
        assert.isTrue(large.tooLong);
        assert.isTrue(large.truncated);
        assert.isFalse(dispatched);
        assert.equal(yield* fs.exists(file), before);
        assert.lengthOf((yield* service.listWebhookDeliveries({ id: task.id })).deliveries, 0);
        assert.equal((yield* service.list()).tasks[0]!.runCount, 0);
      }).pipe(
        Effect.provide(
          serviceLayer(() =>
            Effect.sync(() => {
              dispatched = true;
              return {} as never;
            }),
          ),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, layerFiles))),
);

it.effect("preserves unreadable or malformed state instead of overwriting accepted work", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* statePath;
    yield* fs.writeFileString(file, "broken", { mode: 0o600 });
    const failure = yield* Effect.gen(function* () {
      yield* State.ScheduledTaskState;
    }).pipe(Effect.provide(State.layer), Effect.flip);
    assert.equal(failure.message, "Could not load scheduled task state.");
    assert.equal(yield* fs.readFileString(file), "broken");
  }).pipe(Effect.provide(layerFiles)),
);

it.effect(
  "does not claim or dispatch a relay delivery when its durable acceptance cannot be saved",
  () =>
    Effect.gen(function* () {
      const launches = yield* Queue.unbounded<ThreadLaunch.ThreadLaunchInput>();
      yield* Effect.gen(function* () {
        const service = yield* Tasks.ScheduledTaskService;
        const fs = yield* FileSystem.FileSystem;
        const file = yield* statePath;
        const { task } = yield* service.upsert(input);
        // A directory at the destination makes the atomic rename fail reliably on every platform.
        yield* fs.makeDirectory(file);
        const request = trigger(task, "storage-failure");
        const failure = yield* service.triggerWebhook(request).pipe(Effect.flip);
        assert.equal(failure.message, "Could not save scheduled task state.");
        assert.equal(yield* Queue.size(launches), 0);
        yield* fs.remove(file, { recursive: true });
        const accepted = yield* service.triggerWebhook(request);
        assert.equal(accepted._tag === "accepted" ? accepted.outcome : "", "accepted");
        yield* Queue.take(launches);
      }).pipe(
        Effect.provide(
          serviceLayer((request) => Queue.offer(launches, request).pipe(Effect.as({} as never))),
        ),
      );
    }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, layerFiles))),
);

it.effect("keeps failed dispatches as history without reporting an agent success", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const service = yield* Tasks.ScheduledTaskService;
      const { task } = yield* service.upsert({
        ...input,
        schedule: { type: "interval", everyMs: 60000 },
      });
      assert.equal((yield* service.runNow({ id: task.id })).task.lastRunStatus, "failed");
      const history = yield* service.listRuns({ id: task.id });
      assert.equal(history.runs[0]!.dispatchStatus, "failed");
      assert.isNull(history.runs[0]!.runStatus);
      assert.isNull(history.runs[0]!.runId);
      assert.isNull(history.runs[0]!.dispatchedAt);
    }).pipe(Effect.provide(serviceLayer(() => Effect.die("fixture dispatch failure"))));
  }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, layerFiles))),
);

it.effect(
  "bounds the occurrence ledger and keeps distinct manual runs at the same clock time",
  () =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const service = yield* Tasks.ScheduledTaskService;
        const { task } = yield* service.upsert({
          ...input,
          schedule: { type: "interval", everyMs: 60000 },
        });
        for (let i = 0; i < 52; i++) yield* service.runNow({ id: task.id });
        const history = yield* service.listRuns({ id: task.id, limit: 50 });
        assert.lengthOf(history.runs, 50);
        assert.equal(new Set(history.runs.map((run) => run.id)).size, 50);
        assert.isNull(history.nextCursor);
        const state = yield* State.ScheduledTaskState;
        assert.lengthOf((yield* state.read).runs, 50);
      }).pipe(Effect.provide(serviceLayer(() => Effect.succeed({} as never))));
    }).pipe(Effect.provide(Layer.mergeAll(Sqlite.layerMemory, layerFiles))),
);
