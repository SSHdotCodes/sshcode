import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  ContextHandoffId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { latestExecutedRun, runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { modelSwitchSince, unshownRunIds } from "./modelSwitch.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

// Differential check: every history-derived decision message dispatch makes from the
// narrow projection must equal the decision the old full command projection made.
const instance = ProviderInstanceId.make("codex");
const t0 = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
const at = (seconds: number) => DateTime.add(t0, { seconds });
const target: ModelSelection = { instanceId: instance, model: "target" };
const ACTIVE = new Set(["queued", "preparing", "starting", "running", "waiting"]);
const STATUSES: OrchestrationV2Run["status"][] = [
  ...Array<OrchestrationV2Run["status"]>(10).fill("completed"),
  "failed",
  "failed",
  "interrupted",
  "interrupted",
  "cancelled",
  "cancelled",
  "rolled_back",
  "rolled_back",
  "queued",
  "queued",
  "queued",
];
// Runs with no completion time win every "latest" aggregate, so keep them rare.
const status = (random: () => number): OrchestrationV2Run["status"] =>
  random() < 0.03
    ? random() < 0.5
      ? "running"
      : "waiting"
    : STATUSES[Math.floor(random() * STATUSES.length)]!;

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Projection = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "turnItems" | "providerTurns" | "messages"
>;

/** The orchestrator's modelSwitchFor, with every run on a distinct model. */
const switchFrom = (store: ProjectionStore.ProjectionStoreV2["Service"], threadId: ThreadId) =>
  Effect.fn(function* (projection: Projection) {
    const runIds = unshownRunIds(projection);
    if (runIds.length === 0) return modelSwitchSince(projection, target).modelSwitch?.from.model;
    const notifications = (yield* store.getThreadRecords(threadId, ["turnItems"], {
      turnItemTypes: ["notification"],
      turnItemRunIds: runIds,
    })).turnItems;
    return modelSwitchSince(
      { runs: projection.runs, turnItems: [...projection.turnItems, ...notifications] },
      target,
    ).modelSwitch?.from.model;
  });

const decisions = (projection: Projection, messageId: MessageId) => {
  const runs = projection.runs;
  const started = runs
    .filter((run) => run.startedAt !== null)
    .toSorted((l, r) => DateTime.Order(r.startedAt!, l.startedAt!) || r.ordinal - l.ordinal)[0];
  const latestCandidate = runs.reduce<OrchestrationV2Run | undefined>(
    (latest, run) =>
      run.status !== "rolled_back" &&
      run.status !== "queued" &&
      (latest === undefined || runRanAfter(run, latest))
        ? run
        : latest,
    undefined,
  );
  const active = runs.filter((run) => ACTIVE.has(run.status));
  return {
    executed: latestExecutedRun(runs)?.id ?? null,
    completed: runs.findLast((run) => run.status === "completed")?.id ?? null,
    handoff:
      runs.findLast((run) => ["completed", "failed", "interrupted"].includes(run.status))?.id ??
      null,
    started: started?.id ?? null,
    nextOrdinal: runs.reduce((max, run) => Math.max(max, run.ordinal), 0) + 1,
    any: runs.length > 0,
    latestCandidate: latestCandidate?.id ?? null,
    retries: runs
      .filter((run) => run.automaticProviderRetry?.status === "scheduled")
      .map((run) => run.id)
      .toSorted(),
    active: active.map((run) => run.id).toSorted(),
    held: runs
      .filter((run) => run.status === "queued" && run.queueHeld === true)
      .map((run) => run.id)
      .toSorted(),
    queuePosition: Math.max(
      0,
      ...runs.filter((r) => r.status === "queued").map((r) => r.queuePosition ?? r.ordinal),
    ),
    worktreeFailure: runs.some(
      (run) =>
        (run.status === "failed" || run.status === "interrupted") &&
        run.workspacePreparation?.type === "worktree",
    ),
    // Only consulted when the send queues (an active run or a worktree failure).
    existingItem:
      active.length > 0
        ? (projection.turnItems.find(
            (item) => item.type === "user_message" && item.messageId === messageId,
          )?.id ?? null)
        : "n/a",
    activeTurns: active
      .map(
        (run) =>
          `${run.id}=${projection.providerTurns
            .filter((turn) => turn.runAttemptId === run.activeAttemptId)
            .map((turn) => turn.id)
            .toSorted()
            .join(",")}`,
      )
      .toSorted(),
  };
};

const makeThread = (threadId: ThreadId): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:differential"),
  title: threadId,
  providerInstanceId: instance,
  modelSelection: { instanceId: instance, model: "m0" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: t0,
  updatedAt: t0,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const scenario = (
  seed: number,
  options: { threads: number; steps: number; external?: string; growth?: boolean },
) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const random = prng(seed);
    const pick = <A>(values: readonly A[]) => values[Math.floor(random() * values.length)]!;
    const threads = Array.from({ length: options.threads }, (_, n) =>
      ThreadId.make(`thread:${seed}:${n}`),
    );
    const maxOrdinal = new Map<ThreadId, number>();
    let eventCount = 0;
    const event = () => EventId.make(`event:${seed}:${eventCount++}`);
    const apply = store.apply;

    const runPayload = (
      threadId: ThreadId,
      ordinal: number,
      status: OrchestrationV2Run["status"],
    ): OrchestrationV2Run => {
      const id = RunId.make(`run:${threadId}:${ordinal}`);
      const terminal = !ACTIVE.has(status);
      return {
        id,
        threadId,
        ordinal,
        providerInstanceId: instance,
        modelSelection: { instanceId: instance, model: `m:${id}` },
        providerThreadId: ProviderThreadId.make(`pt:${threadId}`),
        userMessageId: MessageId.make(`message:${id}`),
        rootNodeId: null,
        activeAttemptId: RunAttemptId.make(`attempt:${id}`),
        status,
        ...(status === "queued" && random() < 0.4 ? { queueHeld: true } : {}),
        ...(status === "queued" ? { queuePosition: 1 + Math.floor(random() * 50) } : {}),
        requestedAt: at(ordinal),
        startedAt:
          status === "queued" || (status === "cancelled" && random() < 0.5)
            ? null
            : at(Math.floor(random() * 40)),
        completedAt: terminal ? at(Math.floor(random() * 40)) : null,
        checkpointId: null,
        contextHandoffId: random() < 0.08 ? ContextHandoffId.make(`handoff:${id}`) : null,
        ...(random() < 0.08
          ? {
              automaticProviderRetry: {
                attempt: 1,
                status: "scheduled" as const,
                scheduledAt: DateTime.formatIso(t0),
              },
            }
          : {}),
        ...(random() < 0.08
          ? { workspacePreparation: { type: "worktree" as const, baseRef: "main" } }
          : {}),
      };
    };

    const createRun = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const ordinal = (maxOrdinal.get(threadId) ?? 0) + (random() < 0.2 ? 2 : 1);
        maxOrdinal.set(threadId, ordinal);
        const payload = runPayload(threadId, ordinal, status(random));
        yield* apply({
          id: event(),
          type: "run.created",
          threadId,
          occurredAt: t0,
          payload,
        });
      });

    const readRun = (threadId: ThreadId, ordinal: number) =>
      store
        .getThreadRecords(threadId, ["runs"])
        .pipe(Effect.map((records) => records.runs.find((run) => run.ordinal === ordinal)));

    const updateRun = (threadId: ThreadId, recentOnly = false) =>
      Effect.gen(function* () {
        const runs = (yield* store.getThreadRecords(threadId, ["runs"])).runs;
        if (runs.length === 0) return;
        // Favour old runs so edits land in the cached historical prefix.
        const run = recentOnly
          ? runs[runs.length - 1 - Math.floor(random() * Math.min(10, runs.length))]!
          : random() < 0.7
            ? runs[Math.floor(random() * runs.length * 0.5)]!
            : pick(runs);
        const next = status(random);
        const fresh = runPayload(threadId, run.ordinal, next);
        let ordinal = run.ordinal;
        // A queued run that starts behind newer runs moves to the next ordinal.
        if (run.status === "queued" && next !== "queued" && random() < 0.5) {
          ordinal = (maxOrdinal.get(threadId) ?? 0) + 1;
          maxOrdinal.set(threadId, ordinal);
        }
        yield* apply({
          id: event(),
          type: "run.updated",
          threadId,
          occurredAt: t0,
          payload: {
            ...fresh,
            id: run.id,
            ordinal,
            userMessageId: run.userMessageId,
            activeAttemptId: run.activeAttemptId,
            modelSelection: run.modelSelection,
          },
        });
      });

    const TEXTS = ["hello", "hello", "/compact", " /COMPACT ", "/compact now", "/logout"];
    const upsertItem = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const max = maxOrdinal.get(threadId) ?? 0;
        if (max === 0) return;
        const run = yield* readRun(threadId, 1 + Math.floor(random() * max));
        if (run === undefined) return;
        const slot = Math.floor(random() * 120);
        const base = {
          id: TurnItemId.make(`item:${threadId}:${slot}`),
          threadId,
          runId: run.id,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: run.ordinal * 100 + (slot % 7),
          title: null,
          startedAt: t0,
          completedAt: t0,
          updatedAt: t0,
        };
        const payload: OrchestrationV2TurnItem =
          random() < 0.2
            ? {
                ...base,
                type: "notification",
                status: "completed",
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "wake",
              }
            : {
                ...base,
                type: "user_message",
                status: random() < 0.15 ? "pending" : "completed",
                messageId: MessageId.make(`dup:${threadId}:${slot % 9}`),
                text: pick(TEXTS),
                attachments: [],
                createdBy: "user",
                creationSource: "web",
                inputIntent: random() < 0.2 ? "queued_turn" : "turn_start",
              };
        yield* apply({
          id: event(),
          type: "turn-item.updated",
          threadId,
          occurredAt: t0,
          payload,
        });
      });

    const upsertTurn = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const max = maxOrdinal.get(threadId) ?? 0;
        if (max === 0) return;
        const run = yield* readRun(threadId, 1 + Math.floor(random() * max));
        if (run === undefined) return;
        const slot = Math.floor(random() * 60);
        yield* apply({
          id: event(),
          type: "provider-turn.updated",
          threadId,
          occurredAt: t0,
          payload: {
            id: ProviderTurnId.make(`turn:${threadId}:${slot}`),
            runAttemptId: random() < 0.05 ? null : run.activeAttemptId,
            nodeId: NodeId.make(`node:${run.id}`),
            providerThreadId: ProviderThreadId.make(`pt:${threadId}`),
            ordinal: slot + 1,
            nativeTurnRef: null,
            status: random() < 0.5 ? "running" : "completed",
            startedAt: t0,
            completedAt: null,
          },
        });
      });

    const externalWrite = (threadId: ThreadId) =>
      Effect.gen(function* () {
        if (options.external === undefined) return;
        const max = maxOrdinal.get(threadId) ?? 0;
        if (max === 0) return;
        const ordinal = 1 + Math.floor(random() * Math.max(1, max / 2));
        const kind = random();
        const completed = DateTime.formatIso(at(41 + Math.floor(random() * 5)));
        const scheduled = DateTime.formatIso(t0);
        const latestAttempt = (yield* store.getThreadRecords(threadId, ["runs"])).runs.findLast(
          (run) => ACTIVE.has(run.status),
        )?.activeAttemptId;
        yield* Effect.gen(function* () {
          const external = yield* SqlClient.SqlClient;
          if (kind < 0.25)
            yield* external`UPDATE orchestration_v2_projection_runs SET status = 'queued', completed_at = NULL,
              payload_json = json_set(payload_json, '$.status', 'queued', '$.completedAt', NULL, '$.startedAt', NULL)
              WHERE thread_id = ${threadId} AND ordinal = ${ordinal}`;
          else if (kind < 0.45)
            yield* external`UPDATE orchestration_v2_projection_runs SET
              payload_json = json_set(payload_json, '$.automaticProviderRetry', json_object('attempt', 1, 'status', 'scheduled', 'scheduledAt', ${scheduled}))
              WHERE thread_id = ${threadId} AND ordinal = ${ordinal}`;
          else if (kind < 0.7 && latestAttempt != null)
            yield* external`UPDATE orchestration_v2_projection_provider_turns SET run_attempt_id = ${latestAttempt},
              payload_json = json_set(payload_json, '$.runAttemptId', ${latestAttempt})
              WHERE provider_turn_id = ${`turn:${threadId}:${Math.floor(random() * 60)}`}`;
          else {
            const next = pick(["completed", "failed", "interrupted"]);
            yield* external`UPDATE orchestration_v2_projection_runs SET status = ${next}, completed_at = ${completed},
              payload_json = json_set(payload_json, '$.status', ${next}, '$.completedAt', ${completed})
              WHERE thread_id = ${threadId} AND ordinal = ${ordinal}`;
          }
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: options.external })));
      });

    const check = (threadId: ThreadId, label: string) =>
      Effect.gen(function* () {
        const max = maxOrdinal.get(threadId) ?? 0;
        const messageId = MessageId.make(
          random() < 0.5 ? `dup:${threadId}:${Math.floor(random() * 9)}` : "fresh",
        );
        const narrow = yield* store.getMessageDispatchProjection(threadId, {
          messageId,
          needsRunHistory: false,
        });
        const old = yield* store.getThreadRecords(
          threadId,
          ["runs", "turnItems", "providerTurns", "messages"],
          { turnItemTypes: ["user_message"], messageRoles: ["user"] },
        );
        const from = switchFrom(store, threadId);
        const expected = { ...decisions(old, messageId), from: yield* from(old) };
        const actual = { ...decisions(narrow, messageId), from: yield* from(narrow) };
        assert.deepEqual(actual, expected, `${label} seed=${seed} ${threadId} max=${max}`);
      });

    for (const threadId of threads) {
      yield* apply({
        id: event(),
        type: "thread.created",
        threadId,
        occurredAt: t0,
        payload: makeThread(threadId),
      });
      for (let n = 0; n < 34; n++) yield* createRun(threadId);
      for (let n = 0; n < 30; n++) yield* upsertItem(threadId);
    }

    for (let step = 0; step < options.steps; step++) {
      const threadId = pick(threads);
      const roll = random();
      const oldEdits = options.growth ? 0.202 : 0.25;
      if (roll < 0.2) yield* createRun(threadId);
      else if (roll < oldEdits) yield* updateRun(threadId);
      else if (roll < 0.25) yield* createRun(threadId);
      else if (roll < 0.35) yield* updateRun(threadId, true);
      else if (roll < 0.65) yield* upsertItem(threadId);
      else if (roll < 0.75) yield* upsertTurn(threadId);
      else if (roll < 0.78) {
        // A failed transaction: its writes are observed, then rolled back.
        yield* Effect.flip(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* updateRun(threadId);
              yield* upsertItem(threadId);
              yield* createRun(threadId);
              yield* store.getMessageDispatchProjection(threadId, { needsRunHistory: false });
              return yield* Effect.fail("roll back" as const);
            }),
          ),
        );
        // The rolled-back run's ordinal is free again.
        const runs = (yield* store.getThreadRecords(threadId, ["runs"])).runs;
        maxOrdinal.set(
          threadId,
          runs.reduce((m, r) => Math.max(m, r.ordinal), 0),
        );
      } else if (roll < 0.82 && options.external !== undefined) {
        yield* externalWrite(threadId);
        if (random() < 0.5) yield* check(threadId, `external ${step}`);
      } else yield* check(threadId, `step ${step}`);
    }
    for (const threadId of threads) yield* check(threadId, "final");
  });

it.effect.each([1, 2, 3, 4, 5, 6])(
  "narrow dispatch decisions equal the full projection (seed %s)",
  (seed) =>
    scenario(seed, { threads: 70, steps: 4000 }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);

it.effect.each([21, 22, 23, 24])(
  "narrow dispatch decisions hold while long chats grow (seed %s)",
  (seed) =>
    scenario(seed, { threads: 4, steps: 3000, growth: true }).pipe(
      Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);

it.effect.each([11, 12])("narrow dispatch decisions survive external commits (seed %s)", (seed) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const filename = dir + "/differential.sqlite";
    yield* scenario(seed, { threads: 8, steps: 1500, external: filename }).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerFromPath(filename))),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
