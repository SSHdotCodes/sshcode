import { assert, it as effectIt } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  RunId,
  type ServerProvider,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ExecutionResources from "../execution/ExecutionResources.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

import {
  makeSweep,
  MEDIA_LIMIT_MESSAGE,
  compactionCommand,
  mediaLimitRecoveryCommands,
} from "./MediaLimitRecoveryWorker.ts";

const provider = (names: ReadonlyArray<string>) =>
  ({ slashCommands: names.map((name) => ({ name })) }) as unknown as ServerProvider;

describe("media limit recovery", () => {
  it("matches the OpenCode Zen gateway's wording", () => {
    expect(
      "Upstream request failed: [airlock_error] inlined media exceeds the 33554432 byte total limit",
    ).toContain(MEDIA_LIMIT_MESSAGE);
  });

  it("uses the harness's own compaction command", () => {
    expect(compactionCommand(provider(["compact", "review"]))).toBe("/compact");
    expect(compactionCommand(provider(["compress", "summarize"]))).toBe("/compress");
    expect(compactionCommand(provider(["review"]))).toBeNull();
    expect(compactionCommand(undefined)).toBeNull();
  });

  it("compacts first, then queues one continuation, both keyed to the failed run", () => {
    const threadId = ThreadId.make("thread-media-limit");
    const [compact, resume] = mediaLimitRecoveryCommands(
      { threadId, runId: "run:thread-media-limit:ordinal:4" },
      "/compact",
    );
    expect(compact).toMatchObject({
      type: "message.dispatch",
      commandId: "media-limit-compact:run:thread-media-limit:ordinal:4",
      threadId,
      text: "/compact",
      dispatchMode: { type: "queue_after_active" },
    });
    expect(resume).toMatchObject({
      type: "message.dispatch",
      commandId: "media-limit-continue:run:thread-media-limit:ordinal:4",
      threadId,
      dispatchMode: { type: "queue_after_active" },
    });
    expect(resume?.type === "message.dispatch" ? resume.text : "").toMatch(/smaller size/);
  });
});

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted, which is enough to see what the
// orchestrator accepts and in which order the runs line up.
const layerOrchestrator = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "media-limit-recovery" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ExecutionResources.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

effectIt.effect(
  "the orchestrator starts the compaction and queues the continuation behind it",
  () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const threadId = ThreadId.make("thread:media-limit-recovery");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create:media-limit-recovery"),
        threadId,
        projectId: ProjectId.make("project:media-limit-recovery"),
        title: "media limit",
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      for (const command of mediaLimitRecoveryCommands(
        { threadId, runId: "run:thread:media-limit-recovery:ordinal:1" },
        "/compact",
      )) {
        yield* threads.dispatch(command);
      }
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const textOf = (messageId: string) =>
        projection.messages.find((message) => message.id === messageId)?.text ?? "";
      assert.deepEqual(
        projection.runs.map((run) => [
          textOf(run.userMessageId).slice(0, 8),
          run.status === "queued" ? "queued" : "starts",
        ]),
        [
          ["/compact", "starts"],
          ["Continue", "queued"],
        ],
      );
    }).pipe(Effect.provide(layerOrchestrator)),
);

effectIt.effect.each([
  "unchanged",
  "expired snooze",
  "new run",
  "provider",
  "model",
  "snooze",
  "settled",
  "pending request",
  "active",
  "archived",
  "deleted",
])("does not compact a stale media failure after provider lookup: %s", (change) =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("media-revalidate");
    const now = yield* DateTime.now;
    const stop = {
      threadId,
      runId: RunId.make("media-revalidate:failed"),
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-5.4" },
      completedAt: now,
    };
    const entered = yield* Deferred.make<void>();
    const ready = yield* Deferred.make<void>();
    const thread = {
      id: threadId,
      providerInstanceId: instanceId,
      modelSelection: stop.modelSelection,
      latestRunId: stop.runId,
      status: "failed",
      pendingRuntimeRequest: null,
      settledOverride: null,
      snoozedUntil: null,
      archivedAt: null,
      deletedAt: null,
    } as Record<string, unknown>;
    const dispatched: Array<unknown> = [];
    const sweep = yield* makeSweep.pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, {
        getSignedOutStops: () => Effect.succeed([stop]),
        getThreadShell: () => Effect.sync(() => (change === "deleted" ? null : thread)),
      } as never),
      Effect.provideService(ThreadManagementService.ThreadManagementService, {
        dispatch: (command: unknown) => Effect.sync(() => void dispatched.push(command)),
      } as never),
      Effect.provideService(ProviderRegistry.ProviderRegistry, {
        getProviders: Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(ready)),
          Effect.as([{ ...provider(["compact"]), instanceId }]),
        ),
      } as never),
    );
    const fiber = yield* sweep().pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    switch (change) {
      case "expired snooze":
        thread.snoozedUntil = DateTime.subtract(now, { hours: 1 });
        break;
      case "new run":
        thread.latestRunId = RunId.make("media-revalidate:new");
        break;
      case "provider":
        thread.providerInstanceId = ProviderInstanceId.make("other");
        break;
      case "model":
        thread.modelSelection = { ...stop.modelSelection, model: "other-model" };
        break;
      case "snooze":
        thread.snoozedUntil = DateTime.add(now, { hours: 1 });
        break;
      case "settled":
        thread.settledOverride = "settled";
        break;
      case "pending request":
        thread.pendingRuntimeRequest = {};
        break;
      case "active":
        thread.status = "running";
        break;
      case "archived":
        thread.archivedAt = now;
        break;
    }
    yield* Deferred.succeed(ready, undefined);
    yield* Fiber.join(fiber);
    assert.lengthOf(dispatched, change === "unchanged" || change === "expired snooze" ? 2 : 0);
  }),
);
