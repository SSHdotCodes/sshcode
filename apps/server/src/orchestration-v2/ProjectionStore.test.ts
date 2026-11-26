import * as ThreadUsageService from "../usage/ThreadUsageService.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { EMPTY_TOTALS } from "@t3tools/provider-core/server/usage";
import { assert, it, vi } from "@effect/vitest";
import {
  SECRET_REQUEST_TURN_ITEM_ID_PREFIX,
  EnvironmentId,
  EventId,
  CommandId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { publishAppMonitors } from "../monitors/appMonitorCounts.ts";
import { buildBoundedThreadStreamSnapshot } from "./ThreadStream.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  encodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";

const layerTest = Layer.mergeAll(
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const queryTransactions: Array<string | null> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") {
          statements.push(query);
          let parent = Option.getOrUndefined(span.parent);
          while (parent?._tag === "Span" && parent.name !== "sql.transaction") {
            parent = Option.getOrUndefined(parent.parent);
          }
          queryTransactions.push(parent?._tag === "Span" ? parent.spanId : null);
        }
      };
      return span;
    },
  });
  return { statements, tracer, queryTransactions };
};

const addRolledBackRecoveryCandidate = Effect.fn("addRolledBackRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:rolled-back`);
  const runId = RunId.make(`run:${suffix}:rolled-back`);
  const rootNodeId = NodeId.make(`node:${suffix}:rolled-back`);
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${suffix}:rolled-back`),
    rootNodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Rolled-back recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: run,
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:rolled-back`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "abandoned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-rolled-back`),
    type: "run.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: { ...run, status: "rolled_back", completedAt: now },
  });

  return threadId;
});

it.effect("runtime recovery finds retained runs without scanning completed tool history", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = yield* addRolledBackRecoveryCandidate("recovery-run-index");
    const { runs } = yield* store.getThreadRecords(threadId, ["runs"]);
    const run = runs[0]!;
    const activeRunId = RunId.make("run:recovery-run-index:active");
    const nativeRootId = NodeId.make("node:recovery-run-index:native-root");
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make("event:recovery-run-index:active-run"),
      type: "run.created",
      threadId,
      runId: activeRunId,
      driver,
      occurredAt: now,
      payload: { ...run, id: activeRunId, ordinal: 2, status: "running", completedAt: null },
    });
    yield* store.apply({
      id: EventId.make("event:recovery-run-index:native-root"),
      type: "node.updated",
      threadId,
      nodeId: nativeRootId,
      driver,
      occurredAt: now,
      payload: {
        id: nativeRootId,
        threadId,
        runId: null,
        rootNodeId: nativeRootId,
        parentNodeId: null,
        kind: "root_turn",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    for (const [suffix, runId, nodeId, ordinal] of [
      ["active", activeRunId, run.rootNodeId, 2],
      ["native", null, nativeRootId, 3],
      ["detached", null, null, 4],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`event:recovery-run-index:${suffix}-item`),
        type: "turn-item.updated",
        threadId,
        ...(runId === null ? {} : { runId }),
        driver,
        occurredAt: now,
        payload: {
          id: TurnItemId.make(`item:recovery-run-index:${suffix}`),
          threadId,
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          type: "assistant_message",
          status: "running",
          title: null,
          messageId: MessageId.make(`message:recovery-run-index:${suffix}`),
          text: "In progress",
          streaming: true,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
    }
    // These bodies must never be read or decoded to find pending background work.
    yield* sql`WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 200
    ) INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        type, status, ordinal, updated_at, payload_json)
      SELECT 'historical-tool:' || value, ${threadId}, ${run.id}, NULL, NULL, NULL,
        'command_execution', 'completed', value + 1, '2026-01-01T00:00:00.000Z', '{}'
      FROM sequence`;
    const { statements, tracer } = traceSqlStatements();
    const recovery = yield* store
      .getRuntimeRecoveryProjection(threadId)
      .pipe(Effect.withTracer(tracer));
    assert.deepEqual(
      recovery.runs.map(({ id }) => id),
      [run.id, activeRunId],
    );
    assert.deepEqual(
      recovery.turnItems.map(({ id }) => id),
      [
        "item:recovery-run-index:rolled-back",
        "item:recovery-run-index:active",
        "item:recovery-run-index:native",
      ],
    );
    const statement = statements.find((query) =>
      query.includes("SELECT payload_json FROM orchestration_v2_projection_runs AS run"),
    );
    assert.isDefined(statement);
    const plan = (yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${statement}`,
    )).map((row) => row.detail);
    assert.isTrue(
      plan.some((detail) =>
        detail.includes(
          "SEARCH item USING INDEX orchestration_v2_projection_turn_items_recovery_idx (thread_id=?)",
        ),
      ),
      plan.join("\n"),
    );
    // The only sort is the lost provider owner's run identities, never bodies.
    assert.isTrue(plan[0]?.includes("runs_thread_ordinal_idx"));
    const pendingItems = statements.find(
      (query) =>
        query.includes("SELECT item.payload_json") &&
        query.includes("orchestration_v2_projection_turn_items"),
    );
    assert.isDefined(pendingItems);
    const itemPlan = (yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${pendingItems}`,
    )).map((row) => row.detail);
    for (const index of ["recovery_idx", "thread_run_idx", "node_ordinal_idx"]) {
      assert.isTrue(
        itemPlan.some((detail) =>
          detail.includes(`orchestration_v2_projection_turn_items_${index}`),
        ),
        itemPlan.join("\n"),
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("subagent history uses index order with unstarted tasks first", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = yield* addRolledBackRecoveryCandidate("subagent-history-order");
    const now = yield* DateTime.now;
    for (const [suffix, startedAt] of [
      ["started-b", now],
      ["pending-b", null],
      ["started-a", now],
      ["pending-a", null],
    ] as const) {
      const id = NodeId.make(`node:subagent-history:${suffix}`);
      yield* store.apply({
        id: EventId.make(`event:subagent-history:${suffix}`),
        type: "subagent.updated",
        threadId,
        occurredAt: now,
        payload: {
          id,
          threadId,
          runId: null,
          parentNodeId: NodeId.make("node:subagent-history:parent"),
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Review the work",
          title: null,
          model: null,
          status: startedAt === null ? "pending" : "running",
          result: null,
          startedAt,
          completedAt: null,
          updatedAt: now,
        },
      });
    }
    const expected = ["pending-a", "pending-b", "started-a", "started-b"].map(
      (suffix) => `node:subagent-history:${suffix}`,
    );
    for (const read of [
      store.getThreadRecords(threadId, ["subagents"]),
      store
        .getThreadSnapshotWindow(threadId, { rowLimit: 10 })
        .pipe(Effect.map((snapshot) => snapshot.projection)),
    ]) {
      const { statements, tracer } = traceSqlStatements();
      const projection = yield* read.pipe(Effect.withTracer(tracer));
      assert.deepEqual(
        projection.subagents.map((subagent) => subagent.id),
        expected,
      );
      const query = statements.find((statement) =>
        /SELECT payload_json\s+FROM orchestration_v2_projection_subagents\s/.test(statement),
      );
      assert.isDefined(query);
      const plan = (yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)).map(
        (row) => row.detail,
      );
      assert.include(
        plan,
        "SEARCH orchestration_v2_projection_subagents USING INDEX orchestration_v2_projection_subagents_thread_idx (thread_id=?)",
      );
      assert.notInclude(plan, "USE TEMP B-TREE FOR ORDER BY");
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("record reads restrict provider histories to delivery identities", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("delivery-identities");
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (const suffix of ["selected", "history"]) {
      const id = ProviderThreadId.make(`provider-thread:${suffix}`);
      yield* store.apply({
        id: EventId.make(`event:delivery-identities:${suffix}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id,
          appThreadId: threadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          status: "active",
          firstRunOrdinal: 1,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    for (const [suffix, attempt] of [
      ["runless", null],
      ["selected", "current"],
      ["history", "old"],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`event:delivery-turn:${suffix}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`turn:${suffix}`),
          providerThreadId: ProviderThreadId.make(
            suffix === "history" ? "provider-thread:history" : "provider-thread:selected",
          ),
          nodeId: NodeId.make("node:delivery"),
          runAttemptId: attempt === null ? null : RunAttemptId.make(attempt),
          nativeTurnRef: null,
          ordinal: suffix === "selected" ? 1 : suffix === "history" ? 2 : 3,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
    }
    for (const read of [
      store.getThreadRecords(threadId, ["providerTurns"]),
      store.getTurnStartContext(threadId, RunId.make("new-run")),
    ]) {
      const { statements, tracer } = traceSqlStatements();
      const projection = yield* read.pipe(Effect.withTracer(tracer));
      assert.deepEqual(
        projection.providerTurns.map((turn) => turn.id),
        ["turn:history", "turn:selected", "turn:runless"],
      );
      const query = statements.find(
        (statement) =>
          statement.includes("payload_json") &&
          statement.includes("FROM orchestration_v2_projection_provider_turns"),
      );
      assert.isDefined(query);
      const plan = (yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`)).map(
        (row) => row.detail,
      );
      assert.include(
        plan,
        "SEARCH orchestration_v2_projection_provider_turns USING INDEX orchestration_v2_projection_provider_turns_thread_idx (thread_id=?)",
      );
      assert.include(
        plan,
        "SEARCH orchestration_v2_projection_provider_turns USING INTEGER PRIMARY KEY (rowid=?)",
        "Look up provider turn payloads after sorting row ids.",
      );
    }
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [RunAttemptId.make("current")],
      })).providerTurns.map((turn) => turn.id),
      ["turn:selected"],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [],
      })).providerTurns,
      [],
    );
    const selected = yield* store.getThreadRecords(threadId, ["providerThreads"], {
      providerThreadIds: [ProviderThreadId.make("provider-thread:selected")],
    });
    assert.deepEqual(
      selected.providerThreads.map((row) => row.id),
      ["provider-thread:selected"],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [],
      })).providerThreads,
      [],
    );
    // Unselected history must not be decoded, even if its payload is unreadable.
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}'
      WHERE provider_thread_id = 'provider-thread:history'`;
    assert.lengthOf(
      (yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [ProviderThreadId.make("provider-thread:selected")],
      })).providerThreads,
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "turn start seeks to the requested run even when the thread index supplies its order",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* addRolledBackRecoveryCandidate("turn-start-seek");
      // Two runs per thread is enough to make an ordered thread scan look cheap on average.
      yield* sql`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 1000)
      INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, type, status, ordinal, updated_at, payload_json)
      SELECT 'item-' || n, 'thread-' || (n / 100), 'run-' || (n / 50), 'command_execution',
        'completed', n, '2026-01-01', '{}' FROM seq`;
      yield* sql`ANALYZE`;
      const { statements, tracer } = traceSqlStatements();
      yield* store
        .getTurnStartContext(threadId, RunId.make("new-run"))
        .pipe(Effect.withTracer(tracer));
      const query = statements.find((statement) =>
        /SELECT payload_json\s+FROM orchestration_v2_projection_turn_items\s/.test(statement),
      );
      assert.isDefined(query);
      const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`);
      assert.isTrue(
        plan.some((row) => row.detail.includes("run_id=?")),
        JSON.stringify(plan),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect("empty turn item filters do not read historical rows", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("empty-item-filter");
    for (const filter of [
      { turnItemTypes: [] },
      { turnItemStatuses: [] },
      { turnItemRunIds: [] },
    ]) {
      const { statements, tracer } = traceSqlStatements();
      const records = yield* store
        .getThreadRecords(threadId, ["turnItems"], filter)
        .pipe(Effect.withTracer(tracer));
      assert.deepEqual(records.turnItems, []);
      assert.isFalse(
        statements.some((query) =>
          /SELECT payload_json\s+FROM orchestration_v2_projection_turn_items/.test(query),
        ),
      );
    }
  }).pipe(Effect.provide(layerTest)),
);

it.effect("single-type turn item reads seek the existing partial indexes", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = yield* addRolledBackRecoveryCandidate("partial-index");
    const now = yield* DateTime.now;
    yield* sql`WITH RECURSIVE sequence(value) AS (
      SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 100
    ) INSERT INTO orchestration_v2_projection_turn_items
      (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
        type, status, ordinal, updated_at, payload_json)
      SELECT 'bulk:' || value, ${threadId}, NULL, NULL, NULL, NULL,
        'command_execution', 'completed', value, ${DateTime.formatIso(now)}, '{}'
      FROM sequence`;
    yield* sql`ANALYZE`;
    const planFor = (filter: Parameters<typeof store.getThreadRecords>[2]) =>
      Effect.gen(function* () {
        const { statements, tracer } = traceSqlStatements();
        const records = yield* store
          .getThreadRecords(threadId, ["turnItems"], filter)
          .pipe(Effect.withTracer(tracer));
        assert.deepEqual(records.turnItems, []);
        const statement = statements.find(
          (query) =>
            query.includes("SELECT payload_json") &&
            query.includes("FROM orchestration_v2_projection_turn_items") &&
            query.includes("thread_id ="),
        );
        assert.isDefined(statement);
        return (yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
        )).map((row) => row.detail);
      });
    const userMessagePlan = yield* planFor({ turnItemTypes: ["user_message"] });
    assert.isTrue(
      userMessagePlan.some((detail) =>
        detail.includes("orchestration_v2_projection_turn_items_user_message_idx"),
      ),
      userMessagePlan.join("\n"),
    );
    const failedErrorPlan = yield* planFor({
      turnItemTypes: ["error"],
      turnItemStatuses: ["failed"],
    });
    assert.isTrue(
      failedErrorPlan.some((detail) =>
        detail.includes("orchestration_v2_projection_turn_items_failed_error_idx"),
      ),
      failedErrorPlan.join("\n"),
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "provider ownership reads seek each ownership index and deduplicate matching owners",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* addRolledBackRecoveryCandidate("indexed-provider-owners");
      const now = yield* DateTime.now;
      const nodeId = NodeId.make("node:indexed-provider-owner");
      yield* sql`INSERT INTO orchestration_v2_projection_nodes
      (node_id, thread_id, root_node_id, kind, status, payload_json)
      VALUES (${nodeId}, ${threadId}, ${nodeId}, 'agent', 'completed', '{}')`;
      yield* sql`WITH RECURSIVE sequence(value) AS (
        SELECT 1 UNION ALL SELECT value + 1 FROM sequence WHERE value < 1000
      ) INSERT INTO orchestration_v2_projection_nodes
        (node_id, thread_id, root_node_id, kind, status, payload_json)
        SELECT 'unowned:' || value, ${threadId}, ${nodeId}, 'tool_call', 'completed', '{}'
        FROM sequence`;
      for (const [suffix, firstRunOrdinal, appThreadId, ownerNodeId] of [
        ["direct", 3, threadId, null],
        ["node", 1, null, nodeId],
        ["delegated", 2, null, null],
        ["overlap", null, threadId, nodeId],
        ["unrelated", 1, null, null],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`event:indexed-provider-owner:${suffix}`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: ProviderThreadId.make(`provider-thread:${suffix}`),
            appThreadId,
            ownerNodeId,
            driver,
            providerInstanceId,
            providerSessionId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      for (const suffix of ["delegated", "overlap"]) {
        yield* sql`INSERT INTO orchestration_v2_projection_subagents
        (subagent_id, thread_id, parent_node_id, provider, provider_instance_id, provider_thread_id,
          origin, status, updated_at, payload_json)
        VALUES (${suffix}, ${threadId}, ${nodeId}, ${driver}, ${providerInstanceId},
          ${`provider-thread:${suffix}`}, 'app_owned', 'completed', ${DateTime.formatIso(now)}, '{}')`;
      }
      // The production statistics can prefer a whole-table scan for the OR of owners.
      yield* sql`ANALYZE`;
      const { statements, tracer } = traceSqlStatements();
      const records = yield* store
        .getThreadRecords(threadId, ["providerThreads"])
        .pipe(Effect.withTracer(tracer));
      assert.deepEqual(
        records.providerThreads.map((row) => row.id),
        [
          "provider-thread:overlap",
          "provider-thread:node",
          "provider-thread:delegated",
          "provider-thread:direct",
        ],
      );
      const filtered = yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [
          ProviderThreadId.make("provider-thread:node"),
          ProviderThreadId.make("provider-thread:unrelated"),
        ],
      });
      assert.deepEqual(
        filtered.providerThreads.map((row) => row.id),
        ["provider-thread:node"],
      );
      const statement = statements.find((query) =>
        query.includes("FROM orchestration_v2_projection_provider_threads"),
      );
      assert.isDefined(statement);
      const plan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
      )).map((row) => row.detail);
      assert.isFalse(
        plan.some((detail) =>
          /^SCAN (?:orchestration_v2_projection_provider_threads|provider|owned)\b/.test(detail),
        ),
        plan.join("\n"),
      );
      assert.isTrue(
        plan.some((detail) => detail.includes("provider_threads_owner_idx (owner_node_id>?)")),
        plan.join("\n"),
      );
      assert.isTrue(
        plan.some((detail) => /SEARCH node .*\(node_id=\?\)/u.test(detail)),
        plan.join("\n"),
      );
      assert.isFalse(
        plan.some((detail) => /(?:SCAN node\b|SEARCH node .*\(thread_id=\?)/u.test(detail)),
        plan.join("\n"),
      );
    }).pipe(Effect.provide(layerTest)),
);

const addOrphanedRecoveryCandidate = Effect.fn("addOrphanedRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:orphaned`);
  const runId = RunId.make(`run:${suffix}:missing`);
  const rootNodeId = NodeId.make(`node:${suffix}:orphaned`);

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Orphaned recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:orphaned`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "orphaned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });

  return threadId;
});

it("includes imported runless history when selecting fork context through a run", () => {
  const firstRunId = RunId.make("run:projection-imported-fork:1");
  const secondRunId = RunId.make("run:projection-imported-fork:2");
  const runOrdinalById = new Map([
    [firstRunId, 1],
    [secondRunId, 2],
  ]);

  assert.isTrue(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: null,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isFalse(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: undefined,
      itemRunId: null,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isTrue(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: firstRunId,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isFalse(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: secondRunId,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
});

// Recovery records the work, then a run.updated snapshot taken before it lands.
const restartCancelledWorkSurvivesStaleRunUpdate = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate("restart-cancelled-work-stale-update");
  const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
  const now = yield* DateTime.now;
  const work = [{ kind: "subagent" as const, label: "Background subagent test" }];
  yield* store.apply({
    id: EventId.make("event:restart-cancelled-work-stale-update:recorded"),
    type: "run.background-work-cancelled",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { runId: run.id, restartCancelledBackgroundWork: work },
  });
  yield* store.apply({
    id: EventId.make("event:restart-cancelled-work-stale-update:completed"),
    type: "run.updated",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { ...run, status: "completed", completedAt: now },
  });
  const updated = (yield* store.getThreadProjection(threadId)).runs[0];
  assert.equal(updated?.status, "completed");
  assert.deepEqual(updated?.restartCancelledBackgroundWork, work);
});

const delegatedTaskBindingSurvivesStaleRunUpdate = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate("delegated-task-binding-stale-update");
  const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
  const now = yield* DateTime.now;
  const delegatedTaskId = NodeId.make("node:delegated-task-binding-stale-update:follow-up");
  // A parent's follow-up was steered into this already running run and bound its task.
  yield* store.apply({
    id: EventId.make("event:delegated-task-binding-stale-update:bound"),
    type: "run.updated",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { ...run, status: "running", delegatedTaskId },
  });
  // The run's own completion is written from a copy taken before the binding.
  yield* store.apply({
    id: EventId.make("event:delegated-task-binding-stale-update:completed"),
    type: "run.updated",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { ...run, status: "completed", completedAt: now },
  });
  const updated = (yield* store.getThreadProjection(threadId)).runs[0];
  assert.equal(updated?.status, "completed");
  assert.equal(updated?.delegatedTaskId, delegatedTaskId);
  const [recorded] = (yield* store.getThreadRecords(threadId, ["runs"], { runIds: [run.id] })).runs;
  assert.equal(recorded?.status, "completed");
  assert.equal(recorded?.delegatedTaskId, delegatedTaskId);
});

const threadWorktreePathsReadActiveThreads = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const create = (id: string, input: { worktreePath: string | null; archived?: boolean }) => {
    const threadId = ThreadId.make(id);
    const thread = {
      createdBy: "user" as const,
      creationSource: "web" as const,
      id: threadId,
      projectId: ProjectId.make("project:worktree-paths"),
      title: id,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: input.worktreePath === null ? null : id,
      worktreePath: input.worktreePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: input.archived === true ? now : null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return store
      .apply({
        id: EventId.make(`event:${id}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      })
      .pipe(Effect.as(thread));
  };
  yield* create("thread:active", { worktreePath: "/worktrees/active" });
  yield* create("thread:archived", { worktreePath: "/worktrees/archived", archived: true });
  yield* create("thread:local", { worktreePath: null });
  const deleted = yield* create("thread:deleted", { worktreePath: "/worktrees/deleted" });
  yield* store.apply({
    id: EventId.make("event:thread:deleted:deleted"),
    type: "thread.deleted",
    threadId: deleted.id,
    occurredAt: now,
    payload: { ...deleted, deletedAt: now },
  });

  assert.deepEqual(yield* store.getThreadWorktreePaths(), [
    { threadId: ThreadId.make("thread:active"), worktreePath: "/worktrees/active" },
  ]);
  assert.sameDeepMembers(
    [...(yield* store.getThreadWorktreePaths({ includeArchived: true }))],
    [
      { threadId: ThreadId.make("thread:active"), worktreePath: "/worktrees/active" },
      { threadId: ThreadId.make("thread:archived"), worktreePath: "/worktrees/archived" },
    ],
  );
});

const liveThreadModelsReadOnlyChatsInFlight = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const create = (
    id: string,
    input: {
      readonly run: "running" | "waiting" | "queued" | "completed" | null;
      readonly archived?: boolean;
      readonly model?: string;
    },
  ) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make(id);
      const selection = { ...modelSelection, model: input.model ?? modelSelection.model };
      yield* store.apply({
        id: EventId.make(`event:${id}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user" as const,
          creationSource: "web" as const,
          id: threadId,
          projectId: ProjectId.make("project:live-models"),
          title: id,
          providerInstanceId,
          modelSelection: selection,
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: input.archived === true ? now : null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      if (input.run === null) return;
      const runId = RunId.make(`run:${id}`);
      const rootNodeId = NodeId.make(`node:${id}`);
      yield* store.apply({
        id: EventId.make(`event:${id}:run-created`),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection: selection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:${id}`),
          rootNodeId,
          activeAttemptId: null,
          status: input.run,
          requestedAt: now,
          startedAt: input.run === "queued" ? null : now,
          completedAt: input.run === "completed" ? now : null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
    });
  yield* create("thread:live-running", { run: "running", model: "model-a" });
  yield* create("thread:live-waiting", { run: "waiting", model: "model-b" });
  yield* create("thread:live-queued", { run: "queued" });
  yield* create("thread:live-finished", { run: "completed" });
  yield* create("thread:live-idle", { run: null });
  yield* create("thread:live-archived", { run: "running", archived: true });

  const live = yield* store.getLiveThreadModels();
  assert.deepEqual(
    live
      .map((thread) => [thread.threadId, thread.modelSelection.model])
      .toSorted(([left], [right]) => String(left).localeCompare(String(right))),
    [
      [ThreadId.make("thread:live-running"), "model-a"],
      [ThreadId.make("thread:live-waiting"), "model-b"],
    ],
  );
  // The same chats the chat list shows as active.
  const shell = yield* store.getShellSnapshot();
  assert.sameMembers(
    live.map((thread) => thread.threadId),
    shell.threads
      .filter((thread) => (thread.activityRunStatus ?? null) !== null)
      .map((thread) => thread.id),
  );
});

const commandReadsSkipSettledLeafNodes = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = yield* addRolledBackRecoveryCandidate("settled-leaf-nodes");
  const settledRun = (yield* store.getThreadProjection(threadId)).runs[0]!;
  const activeRun = {
    ...settledRun,
    id: RunId.make("run:settled-leaf-nodes:active"),
    ordinal: 2,
    userMessageId: MessageId.make("message:settled-leaf-nodes:active"),
    rootNodeId: NodeId.make("node:settled-leaf-nodes:active-root"),
    status: "running" as const,
    completedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:settled-leaf-nodes:active-run"),
    type: "run.created",
    threadId,
    runId: activeRun.id,
    nodeId: activeRun.rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: activeRun,
  });
  const nodes = [
    ["settled-root", settledRun, "root_turn", "completed"],
    ["settled-tool", settledRun, "tool_call", "completed"],
    ["settled-message", settledRun, "assistant_message", "failed"],
    ["settled-reasoning", settledRun, "reasoning", "cancelled"],
    ["settled-subagent", settledRun, "subagent", "completed"],
    ["settled-run-live-tool", settledRun, "tool_call", "running"],
    ["active-run-done-tool", activeRun, "tool_call", "completed"],
  ] as const;
  for (const [name, run, kind, status] of nodes) {
    const id = NodeId.make(`node:settled-leaf-nodes:${name}`);
    yield* store.apply({
      id: EventId.make(`event:settled-leaf-nodes:${name}`),
      type: "node.updated",
      threadId,
      runId: run.id,
      nodeId: id,
      driver,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: run.id,
        rootNodeId: kind === "root_turn" ? id : run.rootNodeId!,
        parentNodeId: kind === "root_turn" ? null : run.rootNodeId,
        kind,
        status,
        countsForRun: kind === "root_turn",
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: status === "running" ? null : now,
      },
    });
  }
  const nodeNames = (records: { readonly nodes: ReadonlyArray<{ readonly id: string }> }) =>
    records.nodes
      .map((node) => node.id.replace("node:settled-leaf-nodes:", ""))
      .filter((name) => nodes.some(([candidate]) => candidate === name))
      .toSorted();

  assert.deepEqual(
    nodeNames(yield* store.getThreadRecords(threadId, ["nodes"], { omitSettledLeafNodes: true })),
    ["active-run-done-tool", "settled-root", "settled-run-live-tool", "settled-subagent"],
  );
  assert.deepEqual(
    nodeNames(yield* store.getThreadRecords(threadId, ["nodes"])),
    nodes.map(([name]) => name).toSorted(),
  );
});

it.effect("memory command reads skip finished leaf nodes of finished runs", () =>
  commandReadsSkipSettledLeafNodes.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory worktree path lookup reads only active threads", () =>
  threadWorktreePathsReadActiveThreads.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory live chat lookup lists unarchived chats with a turn in flight", () =>
  liveThreadModelsReadOnlyChatsInFlight.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory projection keeps restart-cancelled work through a stale run.updated", () =>
  restartCancelledWorkSurvivesStaleRunUpdate.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory recovery selection ignores unfinished items from rolled-back runs", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("memory-recovery-candidates");

    assert.notInclude(yield* projectionStore.getRecoveryThreadIds("runtime"), threadId);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory recovery selection includes unfinished items from missing runs", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addOrphanedRecoveryCandidate("memory-recovery-candidates");

    assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), threadId);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

const runlessNativeSubagentNeedsRecovery = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate("runless-native-recovery");
  const now = yield* DateTime.now;
  const id = NodeId.make("node:runless-native-recovery");
  assert.notInclude(yield* store.getRecoveryThreadIds("runtime"), threadId);
  for (const status of ["pending", "running", "waiting", "completed"] as const) {
    yield* store.apply({
      id: EventId.make(`event:runless-native-recovery:${status}`),
      type: "subagent.updated",
      threadId,
      nodeId: id,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: null,
        parentNodeId: NodeId.make("node:runless-native-parent"),
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: { driver, nativeId: "runless-native", strength: "strong" },
        prompt: "Do the work",
        title: "Workflow member",
        model: null,
        status,
        result: null,
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        updatedAt: now,
      },
    });
    assert.equal(
      (yield* store.getRecoveryThreadIds("runtime")).includes(threadId),
      status !== "completed",
    );
  }
});

it.effect("memory recovery selects unfinished runless native subagents", () =>
  runlessNativeSubagentNeedsRecovery.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

const pendingChildQuestionsNewestFirst = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const parentThreadId = ThreadId.make("thread:pending-child-questions:parent");
  const childThreadId = ThreadId.make("thread:pending-child-questions:child");
  const deletedThreadId = ThreadId.make("thread:pending-child-questions:deleted");
  const remoteChildId = ThreadId.make("thread:pending-child-questions:remote-child");
  const forkThreadId = ThreadId.make("thread:pending-child-questions:fork");
  const runId = RunId.make("run:pending-child-questions:child");
  const nodeId = NodeId.make("node:pending-child-questions:child");
  for (const [threadId, deleted] of [
    [parentThreadId, false],
    [childThreadId, false],
    [deletedThreadId, true],
    [remoteChildId, false],
    [forkThreadId, false],
  ] as const) {
    yield* store.apply({
      id: EventId.make(`event:${threadId}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "agent",
        creationSource: "mcp",
        id: threadId,
        projectId: ProjectId.make("project:pending-child-questions"),
        title: threadId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage:
          threadId === parentThreadId
            ? { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }
            : {
                parentThreadId,
                ...(threadId === remoteChildId
                  ? { parentEnvironmentId: EnvironmentId.make("mac-test") }
                  : {}),
                relationshipToParent: threadId === forkThreadId ? "fork" : "subagent",
                rootThreadId: threadId === remoteChildId ? remoteChildId : parentThreadId,
              },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: deleted ? now : null,
      },
    });
  }
  yield* store.apply({
    id: EventId.make("event:pending-child-questions:node"),
    type: "node.updated",
    threadId: childThreadId,
    runId,
    nodeId,
    driver,
    occurredAt: now,
    payload: {
      id: nodeId,
      threadId: childThreadId,
      runId,
      rootNodeId: nodeId,
      parentNodeId: null,
      kind: "root_turn",
      status: "running",
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    },
  });
  const requests = [
    ["older", childThreadId, "user_input", "pending", -1_000],
    ["newer", childThreadId, "user_input", "pending", 0],
    ["approval", childThreadId, "command", "pending", 0],
    ["answered", childThreadId, "user_input", "resolved", 0],
    ["root", parentThreadId, "user_input", "pending", 0],
    ["deleted", deletedThreadId, "user_input", "pending", 0],
    ["remote", remoteChildId, "user_input", "pending", 1_000],
    ["fork", forkThreadId, "user_input", "pending", 2_000],
  ] as const;
  for (const [name, threadId, kind, status, offsetMillis] of requests) {
    const createdAt = DateTime.add(now, { milliseconds: offsetMillis });
    yield* store.apply({
      id: EventId.make(`event:pending-child-questions:${name}`),
      type: "runtime-request.updated",
      threadId,
      runId,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make(`request:pending-child-questions:${name}`),
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind,
        status,
        responseCapability: { type: "message" },
        createdAt,
        resolvedAt: status === "resolved" ? now : null,
      },
    });
  }

  const newer = RuntimeRequestId.make("request:pending-child-questions:newer");
  const older = RuntimeRequestId.make("request:pending-child-questions:older");
  const questions = yield* store.getPendingChildQuestions(10);
  const firstPage = yield* store.getPendingChildQuestions(1);
  assert.deepEqual(
    (yield* store.getPendingChildQuestions(1, {
      createdAt: firstPage[0]!.request.createdAt,
      requestId: firstPage[0]!.request.id,
    })).map((question) => question.request.id),
    [older],
  );
  assert.deepEqual(
    questions.map(({ threadId, runId, request }) => ({ threadId, runId, requestId: request.id })),
    [
      { threadId: childThreadId, runId, requestId: newer },
      { threadId: childThreadId, runId, requestId: older },
    ],
  );
  assert.deepEqual(
    (yield* store.getPendingChildQuestions(1)).map((question) => question.request.id),
    [newer],
  );
});

it.effect("memory pending child questions are bounded, newest first", () =>
  pendingChildQuestionsNewestFirst.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

// Project A holds an active thread, an archived thread and a fork of a run in
// an archived project B thread, so a project-scoped snapshot still has to load
// a fork source that is outside the project and archived.
const assertProjectScopedShells = Effect.fn("assertProjectScopedShells")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const projectId = ProjectId.make(`project:${suffix}:a`);
  const otherProjectId = ProjectId.make(`project:${suffix}:b`);
  const activeThreadId = ThreadId.make(`thread:${suffix}:a-active`);
  const archivedThreadId = ThreadId.make(`thread:${suffix}:a-archived`);
  const forkThreadId = ThreadId.make(`thread:${suffix}:a-fork`);
  const sourceThreadId = ThreadId.make(`thread:${suffix}:b-source`);
  const otherThreadId = ThreadId.make(`thread:${suffix}:b-other`);
  const sourceRunId = RunId.make(`run:${suffix}:b-source`);
  const sourceNodeId = NodeId.make(`node:${suffix}:b-source`);
  const createThread = (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly archived?: boolean;
    readonly forkedFromRunOf?: ThreadId;
  }) =>
    projectionStore.apply({
      id: EventId.make(`event:${input.threadId}:created`),
      type: "thread.created",
      threadId: input.threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: input.threadId,
        projectId: input.projectId,
        title: input.threadId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage:
          input.forkedFromRunOf === undefined
            ? { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId }
            : {
                parentThreadId: input.forkedFromRunOf,
                relationshipToParent: "fork",
                rootThreadId: input.forkedFromRunOf,
              },
        forkedFrom:
          input.forkedFromRunOf === undefined
            ? null
            : { type: "run", threadId: input.forkedFromRunOf, runId: sourceRunId },
        createdAt: now,
        updatedAt: now,
        archivedAt: input.archived === true ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });

  yield* createThread({ threadId: sourceThreadId, projectId: otherProjectId, archived: true });
  yield* createThread({ threadId: otherThreadId, projectId: otherProjectId });
  yield* createThread({ threadId: activeThreadId, projectId });
  yield* createThread({ threadId: archivedThreadId, projectId, archived: true });
  yield* createThread({ threadId: forkThreadId, projectId, forkedFromRunOf: sourceThreadId });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:source-run`),
    type: "run.created",
    threadId: sourceThreadId,
    runId: sourceRunId,
    nodeId: sourceNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: sourceRunId,
      threadId: sourceThreadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${suffix}:source-user`),
      rootNodeId: sourceNodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:source-item`),
    type: "turn-item.updated",
    threadId: sourceThreadId,
    runId: sourceRunId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`turn-item:${suffix}:source`),
      threadId: sourceThreadId,
      runId: sourceRunId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make(`message:${suffix}:source-assistant`),
      text: "Source answer",
      streaming: false,
    },
  });

  const unscoped = yield* projectionStore.getShellSnapshot();
  const inProject = (thread: { readonly projectId: ProjectId }) => thread.projectId === projectId;
  const active = yield* projectionStore.getShellSnapshot({ projectId, location: "active" });
  assert.deepEqual(active.threads, unscoped.threads.filter(inProject));
  assert.deepEqual(active.archivedThreads, []);
  assert.sameMembers(
    active.threads.map((thread) => thread.id),
    [activeThreadId, forkThreadId],
  );
  const fork = active.threads.find((thread) => thread.id === forkThreadId);
  assert.isAbove(fork?.visibleItemCount ?? 0, 0);

  const all = yield* projectionStore.getShellSnapshot({ projectId });
  assert.deepEqual(all.threads, active.threads);
  assert.deepEqual(all.archivedThreads, unscoped.archivedThreads.filter(inProject));
  assert.sameMembers(
    all.archivedThreads.map((thread) => thread.id),
    [archivedThreadId],
  );
  return { projectId, activeThreadId, forkThreadId, otherThreadId };
});

it.effect("memory shell snapshots scope to one project", () =>
  assertProjectScopedShells("memory-project-shell").pipe(
    Effect.asVoid,
    Effect.provide(ProjectionStore.layerMemory),
  ),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s shells read a subagent family and a worktree's threads", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:family");
    const worktreePath = "/repo/.t3/worktrees/family";
    const id = (name: string) => ThreadId.make(`thread:family:${name}`);
    const payloadOf = (input: {
      readonly name: string;
      readonly parent?: string;
      readonly root?: string;
      readonly worktreePath?: string;
      readonly archived?: boolean;
      readonly startedByUser?: boolean;
    }) =>
      ({
        createdBy: input.parent === undefined || input.startedByUser ? "user" : "agent",
        creationSource: input.parent === undefined || input.startedByUser ? "web" : "mcp",
        id: id(input.name),
        projectId,
        title: input.name,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: input.worktreePath ?? null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: input.parent === undefined ? null : id(input.parent),
          relationshipToParent: input.parent === undefined ? null : "subagent",
          rootThreadId: id(input.root ?? input.name),
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: input.archived === true ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      }) as const;
    const createThread = (input: Parameters<typeof payloadOf>[0]) =>
      store.apply({
        id: EventId.make(`event:family:${input.name}`),
        type: "thread.created",
        threadId: id(input.name),
        occurredAt: now,
        payload: payloadOf(input),
      });
    yield* createThread({ name: "root", worktreePath });
    yield* createThread({ name: "child", parent: "root", root: "root", worktreePath });
    yield* createThread({ name: "grandchild", parent: "child", root: "root" });
    yield* createThread({ name: "archived-child", parent: "root", root: "root", archived: true });
    yield* createThread({ name: "other", worktreePath: "/repo" });
    yield* createThread({ name: "other-child", parent: "other", root: "other", worktreePath });

    const family = (threadId: ThreadId) =>
      store
        .getShellSnapshot({ location: "active", subagentFamilyOf: threadId })
        .pipe(Effect.map((snapshot) => snapshot.threads.map((thread) => thread.id)));
    // Any member, or the root itself, names the same active subagent tree.
    assert.sameMembers([...(yield* family(id("root")))], [id("child"), id("grandchild")]);
    assert.sameMembers([...(yield* family(id("grandchild")))], [id("child"), id("grandchild")]);
    assert.deepEqual([...(yield* family(id("missing")))], []);

    const slim = yield* store.getShellSnapshot({ location: "active", omitIdleSubagents: "all" });
    assert.sameMembers(
      slim.threads.map((thread) => thread.id),
      [id("root"), id("other")],
    );
    const direct = yield* store.getThreadShell(id("grandchild"));
    assert.equal(direct?.id, id("grandchild"));
    const allSubagents = yield* store.getShellSnapshot({
      location: "active",
      allSubagentThreads: true,
    });
    assert.sameMembers(
      allSubagents.threads.map((thread) => thread.id),
      [id("child"), id("grandchild"), id("other-child")],
    );
    yield* createThread({ name: "user-child", parent: "child", root: "root", startedByUser: true });
    const kept = yield* store.getShellSnapshot({ location: "active", omitIdleSubagents: "all" });
    assert.sameMembers(
      kept.threads.map((thread) => thread.id),
      [id("root"), id("other"), id("child"), id("user-child")],
    );

    // Includes another root's idle child on the same path, which a shell may leave out.
    const onWorktree = yield* store.getShellSnapshot({ location: "active", worktreePath });
    assert.sameMembers(
      onWorktree.threads.map((thread) => thread.id),
      [id("root"), id("child"), id("other-child")],
    );
    // A fork keeps its deleted source's root, so the deleted root still names the live tree.
    yield* store.apply({
      id: EventId.make("event:family:root-deleted"),
      type: "thread.deleted",
      threadId: id("root"),
      occurredAt: now,
      payload: { ...payloadOf({ name: "root", worktreePath }), deletedAt: now },
    });
    assert.sameMembers(
      [...(yield* family(id("root")))],
      [id("child"), id("grandchild"), id("user-child")],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s chat visit snapshot is the unsettled shell's top-level chats", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const earlier = DateTime.subtract(now, { hours: 1 });
    const projectId = ProjectId.make("project:visit");
    const id = (name: string) => ThreadId.make(`thread:visit:${name}`);
    const sourceRunId = RunId.make("run:visit:source");
    const sourceNodeId = NodeId.make("node:visit:source");
    const createThread = (input: {
      readonly name: string;
      readonly parent?: string;
      readonly forkOf?: string;
      readonly settled?: boolean;
      readonly archived?: boolean;
      readonly visitedAt?: DateTime.Utc;
    }) =>
      store.apply({
        id: EventId.make(`event:visit:${input.name}`),
        type: "thread.created",
        threadId: id(input.name),
        occurredAt: now,
        payload: {
          createdBy: input.parent === undefined ? "user" : "agent",
          creationSource: input.parent === undefined ? "web" : "mcp",
          id: id(input.name),
          projectId,
          title: input.name,
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage:
            input.parent !== undefined
              ? {
                  parentThreadId: id(input.parent),
                  relationshipToParent: "subagent",
                  rootThreadId: id("open"),
                }
              : input.forkOf !== undefined
                ? {
                    parentThreadId: id(input.forkOf),
                    relationshipToParent: "fork",
                    rootThreadId: id("open"),
                  }
                : {
                    parentThreadId: null,
                    relationshipToParent: null,
                    rootThreadId: id(input.name),
                  },
          forkedFrom:
            input.forkOf === undefined
              ? null
              : { type: "run", threadId: id(input.forkOf), runId: sourceRunId },
          createdAt: now,
          updatedAt: now,
          archivedAt: input.archived === true ? now : null,
          settledOverride: null,
          settledAt: input.settled === true ? now : null,
          lastVisitedAt: input.visitedAt ?? null,
          deletedAt: null,
        },
      });
    yield* createThread({ name: "open", visitedAt: earlier });
    yield* createThread({ name: "settled", settled: true, visitedAt: earlier });
    yield* createThread({ name: "archived", archived: true });
    yield* createThread({ name: "child", parent: "open", visitedAt: now });
    yield* createThread({ name: "settled-child", parent: "open", settled: true });
    // The fork stays a candidate while its source, a subagent, is not one.
    yield* createThread({ name: "source", parent: "open" });
    yield* createThread({ name: "fork", forkOf: "source" });
    yield* store.apply({
      id: EventId.make("event:visit:source-run"),
      type: "run.created",
      threadId: id("source"),
      runId: sourceRunId,
      nodeId: sourceNodeId,
      driver,
      occurredAt: now,
      payload: {
        id: sourceRunId,
        threadId: id("source"),
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:visit:source-user"),
        rootNodeId: sourceNodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: now,
        startedAt: now,
        completedAt: now,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    yield* store.apply({
      id: EventId.make("event:visit:source-item"),
      type: "turn-item.updated",
      threadId: id("source"),
      runId: sourceRunId,
      occurredAt: now,
      payload: {
        id: TurnItemId.make("turn-item:visit:source"),
        threadId: id("source"),
        runId: sourceRunId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "assistant_message",
        messageId: MessageId.make("message:visit:source-assistant"),
        text: "Source answer",
        streaming: false,
      },
    });

    const unsettled = yield* store.getShellSnapshot({ location: "active", unsettledOnly: true });
    const visit = yield* store.getChatVisitSnapshot();
    assert.deepEqual(
      visit.threads,
      unsettled.threads.filter((thread) => thread.lineage.relationshipToParent !== "subagent"),
    );
    assert.deepEqual(
      new Map(visit.readMarks.map((mark) => [mark.threadId, mark.lastVisitedAt])),
      new Map(unsettled.threads.map((thread) => [thread.id, thread.lastVisitedAt])),
    );
    assert.sameMembers(
      visit.threads.map((thread) => thread.id),
      [id("open"), id("fork")],
    );
    assert.sameMembers(
      visit.readMarks.map((mark) => mark.threadId),
      [id("open"), id("child"), id("source"), id("fork")],
    );
    assert.isAbove(
      visit.threads.find((thread) => thread.id === id("fork"))?.visibleItemCount ?? 0,
      0,
    );
  }).pipe(Effect.provide(layer)),
);

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("trims bounded SQL tool payloads without changing wire snapshots or detail reads", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const at = yield* DateTime.now;
      const iso = DateTime.formatIso(at);
      const id = ThreadId.make("wire-sql-tools"),
        runId = RunId.make("wire-sql-tools-run");
      const thread = {
        id,
        projectId: ProjectId.make("wire-sql-tools-project"),
        title: "Tool history",
        createdBy: "user" as const,
        creationSource: "web" as const,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("wire-sql-tools-create"),
        type: "thread.created",
        threadId: id,
        occurredAt: at,
        payload: thread,
      });
      yield* store.apply({
        id: EventId.make("wire-sql-tools-run-create"),
        type: "run.created",
        threadId: id,
        occurredAt: at,
        payload: {
          id: runId,
          threadId: id,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("wire-sql-tools-input"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const large = "x".repeat(256 * 1024);
      const whitespace =
        "\t\n\v\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
      const commands = [
        large,
        "no such file\n" + large,
        " ".repeat(40_000) + "tail",
        whitespace.repeat(2_000),
        "😀".repeat(16_380) + "exit code: 2" + large,
        "a\0exit code: 2" + large,
        " ".repeat(40_000) + "\0exit code: 2",
        large + "exit code: 2",
      ].map((output) => ({ type: "command_execution", input: "command", output, exitCode: 0 }));
      const fields: ReadonlyArray<Record<string, unknown>> = [
        ...commands,
        { type: "command_execution", input: "command", outputOmitted: false, exitCode: 2 },
        {
          type: "command_execution",
          input: "command",
          output: whitespace.repeat(2_000),
          outputOmitted: true,
        },
        { type: "file_change", fileName: "large.ts", diffStr: large, oldStr: large, newStr: large },
        {
          type: "file_change",
          fileName: "failed.ts",
          diffStr: "Cannot edit\n" + large,
          oldStr: large,
          newStr: large,
          status: "failed",
        },
        {
          type: "handoff",
          summary: large,
          contextHandoffId: "handoff:wire-sql",
          fromProviderThreadIds: [],
          toProviderThreadId: "provider-thread:wire-sql",
          fromProviderInstanceIds: [],
          toProviderInstanceId: providerInstanceId,
          strategy: "manual_context",
        },
        {
          type: "dynamic_tool",
          toolName: "image_gen",
          input: {},
          output: [{ type: "image", mimeType: "image/png", data: large }],
        },
      ];
      const rows = fields.map((field, ordinal) => ({
        turn_item_id: `wire-sql-item:${ordinal}`,
        thread_id: id,
        run_id: runId,
        node_id: null,
        provider_thread_id: null,
        provider_turn_id: null,
        parent_item_id: null,
        ordinal,
        type: String(field.type),
        status: String(field.status ?? "completed"),
        updated_at: iso,
        payload_json: encodeUnknownJsonString({
          id: `wire-sql-item:${ordinal}`,
          threadId: id,
          runId,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: iso,
          completedAt: iso,
          updatedAt: iso,
          ...field,
        }),
      }));
      // Legacy rows may predate write-time output limits.
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
      const forkId = ThreadId.make("wire-sql-tools-fork");
      yield* store.apply({
        id: EventId.make("wire-sql-tools-fork-create"),
        type: "thread.created",
        threadId: forkId,
        occurredAt: at,
        payload: {
          ...thread,
          id: forkId,
          lineage: { parentThreadId: id, relationshipToParent: "fork", rootThreadId: id },
          forkedFrom: { type: "run", threadId: id, runId },
        },
      });
      for (const threadId of [id, forkId]) {
        const raw = yield* store.getThreadSnapshotWindow(threadId, { rowLimit: 100 });
        const trimmed = yield* store.getThreadSnapshotWindow(threadId, {
          rowLimit: 100,
          forWire: true,
        });
        for (const compactTurnItems of [false, true])
          for (const dedupeBodies of [false, true]) {
            assert.deepEqual(
              buildBoundedThreadStreamSnapshot({
                ...trimmed,
                compactTurnItems,
                dedupeBodies,
                compactIds: true,
              }),
              buildBoundedThreadStreamSnapshot({
                ...raw,
                compactTurnItems,
                dedupeBodies,
                compactIds: true,
              }),
            );
          }
        const first = trimmed.projection.visibleTurnItems.find(
          (row) => row.sourceItemId === "wire-sql-item:0",
        )?.item;
        assert.equal(first?.type === "command_execution" ? first.output?.length : -1, 32_768);
        const original = raw.projection.visibleTurnItems.find(
          (row) => row.sourceItemId === "wire-sql-item:0",
        )?.item;
        assert.equal(original?.type === "command_execution" ? original.output : undefined, large);
        const edit = trimmed.projection.visibleTurnItems.find(
          (row) => row.item.type === "file_change" && row.item.status === "completed",
        )?.item;
        assert.equal(edit?.type === "file_change" ? edit.diffOmitted : undefined, true);
        assert.equal(edit?.type === "file_change" ? edit.diffStr : undefined, undefined);
      }
      const detail = yield* store.getTurnItem({
        threadId: id,
        itemId: TurnItemId.make("wire-sql-item:0"),
      });
      assert.equal(detail?.type === "command_execution" ? detail.output : undefined, large);
    }),
  );

  it.effect(
    "SQL recovery selects unfinished runless native subagents",
    () => runlessNativeSubagentNeedsRecovery,
  );
  it.effect(
    "SQL pending child questions are bounded, newest first",
    () => pendingChildQuestionsNewestFirst,
  );
  it.effect(
    "worktree path lookup reads only active threads",
    () => threadWorktreePathsReadActiveThreads,
  );
  it.effect(
    "live chat lookup lists unarchived chats with a turn in flight",
    () => liveThreadModelsReadOnlyChatsInFlight,
  );

  it.effect(
    "keeps restart-cancelled work through a stale run.updated",
    () => restartCancelledWorkSurvivesStaleRunUpdate,
  );
  it.effect(
    "keeps a follow-up task's run binding through a stale run.updated",
    () => delegatedTaskBindingSurvivesStaleRunUpdate,
  );
  it.effect("records restart-cancelled work without regressing a run that completed since", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("restart-cancelled-work");
      const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      // Recovery read the run as waiting; its checkpoint completed it before the commit.
      yield* store.apply({
        id: EventId.make("event:restart-cancelled-work:completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        providerInstanceId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      const work = [{ kind: "subagent" as const, label: "Background subagent test" }];
      yield* store.apply({
        id: EventId.make("event:restart-cancelled-work:recorded"),
        type: "run.background-work-cancelled",
        threadId,
        runId: run.id,
        providerInstanceId,
        occurredAt: now,
        payload: { runId: run.id, restartCancelledBackgroundWork: work },
      });
      const recorded = (yield* store.getThreadProjection(threadId)).runs[0];
      assert.equal(recorded?.status, "completed");
      assert.deepEqual(recorded?.restartCancelledBackgroundWork, work);
      const [recovery] = (yield* store.getThreadRecords(threadId, ["runs"], {
        runIds: [run.id],
      })).runs;
      assert.equal(recovery?.status, "completed");
      assert.deepEqual(recovery?.restartCancelledBackgroundWork, work);
    }),
  );
  it.effect("command reads skip finished leaf nodes of finished runs", () =>
    Effect.gen(function* () {
      const { statements, tracer } = traceSqlStatements();
      yield* commandReadsSkipSettledLeafNodes.pipe(Effect.withTracer(tracer));
      const statement = statements.find(
        (query) =>
          query.includes("FROM orchestration_v2_projection_nodes AS node") &&
          query.includes("AND NOT"),
      );
      assert.isDefined(statement);
      const sql = yield* SqlClient.SqlClient;
      const plan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${statement}`,
      )).map((row) => row.detail);
      assert.isFalse(
        plan.some((detail) => detail.includes("CORRELATED")),
        plan.join("\n"),
      );
      assert.isTrue(
        plan.some((detail) => detail.includes("runs_recovery_idx")),
        plan.join("\n"),
      );
      assert.isFalse(
        plan.some((detail) => detail.includes("TEMP B-TREE")),
        plan.join("\n"),
      );
    }),
  );
  it.effect("limits turn-start history to the requested runs, including an empty selection", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("selected-turn-start-history");
      const runId = (yield* store.getThreadProjection(threadId)).runs[0]!.id;
      const history = yield* store.getTurnStartHistory(threadId);
      assert.isNotEmpty(history);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [runId]), history);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, []), []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [RunId.make("run:other")]), []);
    }),
  );
  it.effect("preserves stored provider usage when a terminal update omits it", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-usage-reload");
      const providerThreadId = ProviderThreadId.make("provider-thread:provider-usage-reload");
      const providerTurnId = ProviderTurnId.make("provider-turn:provider-usage-reload");
      const nodeId = NodeId.make("node:provider-usage-reload");
      const initialUsage = {
        usedTokens: 12_000,
        maxTokens: 200_000,
        inputTokens: 11_000,
        outputTokens: 1_000,
        updatedAt: "2026-08-29T12:00:00.000Z",
      } as const;
      const replacementUsage = {
        usedTokens: 18_000,
        maxTokens: 200_000,
        inputTokens: 16_000,
        outputTokens: 2_000,
        updatedAt: "2026-08-29T12:00:01.000Z",
      } as const;

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:provider-usage-reload"),
          title: "Provider usage reload",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      const providerTurn = {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:running"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, tokenUsage: initialUsage },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:completed"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, status: "completed", completedAt: now },
      });

      const reloaded = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(reloaded.providerTurns[0]?.tokenUsage, initialUsage);
      assert.strictEqual(reloaded.providerTurns[0]?.status, "completed");

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:replacement"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          ...providerTurn,
          status: "completed",
          completedAt: now,
          tokenUsage: replacementUsage,
        },
      });

      const replaced = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(replaced.providerTurns[0]?.tokenUsage, replacementUsage);
    }),
  );

  it.effect("bounds user turns through SQL and recovers every row through history pages", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:user-turn-pages");
      yield* projectionStore.apply({
        id: EventId.make("event:user-turn-pages:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:user-turn-pages"),
          title: "Bounded SQL history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      const allIds: string[] = [];
      let lastToolPayload = "";
      for (let turn = 1; turn <= 45; turn += 1) {
        const rows = Array.from({ length: 102 }, (_, offset) => {
          const ordinal = (turn - 1) * 102 + offset + 1;
          const id = `item:user-turn-pages:${ordinal}`;
          allIds.push(id);
          const base = {
            id,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
          };
          const item =
            offset < 2
              ? {
                  ...base,
                  type: "user_message",
                  createdBy: "user",
                  creationSource: "web",
                  messageId: `message:${id}`,
                  inputIntent: offset === 0 ? "turn_start" : "steer",
                  text: `Turn ${turn}`,
                  attachments: [],
                }
              : {
                  ...base,
                  type: "command_execution",
                  input: "command",
                  output: "x".repeat(2048),
                  exitCode: 0,
                };
          const payloadJson = encodeUnknownJsonString(item);
          if (offset >= 2) lastToolPayload = payloadJson;
          return {
            turn_item_id: id,
            thread_id: threadId,
            run_id: null,
            node_id: null,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal,
            type: item.type,
            status: "completed",
            updated_at: nowIso,
            payload_json: payloadJson,
          };
        });
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
      }
      const { statements, tracer } = traceSqlStatements();
      const initial = yield* Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(JSON, "parse")),
        (parse) =>
          projectionStore
            .getThreadSnapshotWindow(threadId, { rowLimit: 77, userTurnLimit: 10 })
            .pipe(
              Effect.withTracer(tracer),
              Effect.tap(() =>
                Effect.sync(() => {
                  // Tool outputs must not be allocated again just to collect cohort IDs.
                  assert.lengthOf(
                    parse.mock.calls.filter(([input]) => input === lastToolPayload),
                    1,
                  );
                }),
              ),
            ),
        (parse) => Effect.sync(() => parse.mockRestore()),
      );
      // Large threads blocked the server for over a second here. The boundary
      // must come from the user-message index rather than a scan of every tool
      // row, and payloads must not go through a sort after they are fetched.
      const windowStatement = statements.find((statement) => statement.includes("turn_anchors"));
      assert.isDefined(windowStatement);
      const windowPlan = yield* sql.unsafe<{ readonly parent: number; readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${windowStatement}`,
      );
      assert.match(
        windowPlan.map((row) => row.detail).join("\n"),
        /SEARCH item USING INDEX orchestration_v2_projection_turn_items_user_message_idx \(thread_id=\? AND ordinal<\?\)/,
      );
      const topLevel = windowPlan.filter((row) => row.parent === 0).map((row) => row.detail);
      assert.include(topLevel, "SEARCH item USING INTEGER PRIMARY KEY (rowid=?)");
      assert.notInclude(topLevel, "USE TEMP B-TREE FOR ORDER BY");
      const nodeStatement = statements.find((statement) =>
        statement.includes("WITH RECURSIVE retained"),
      );
      assert.isDefined(nodeStatement);
      const nodePlan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${nodeStatement}`,
      );
      assert.include(
        nodePlan.map((row) => row.detail),
        "SEARCH orchestration_v2_projection_nodes USING INDEX orchestration_v2_projection_nodes_live_idx (thread_id=?)",
      );
      const providerStatement = statements.find((statement) =>
        statement.includes("FROM orchestration_v2_projection_provider_threads"),
      );
      assert.isDefined(providerStatement);
      const providerPlan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${providerStatement}`,
      )).map((row) => row.detail);
      assert.isFalse(
        providerPlan.some((detail) =>
          /^SCAN (?:orchestration_v2_projection_provider_threads|provider|owned)\b/.test(detail),
        ),
        providerPlan.join("\n"),
      );
      assert.isTrue(
        providerPlan.some((detail) =>
          detail.includes("provider_threads_owner_idx (owner_node_id=?)"),
        ),
        providerPlan.join("\n"),
      );
      assert.lengthOf(initial.projection.turnItems, THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT);
      const bounded = buildBoundedThreadProjection({
        projection: initial.projection,
        snapshotSequence: 0,
      });
      assert.isAtMost(
        bounded.projection.visibleTurnItems.length,
        THREAD_HISTORY_PAGE_POLICY.maxTurnItems,
      );
      const loaded = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
      let cursor = bounded.historyCursor;
      for (let pages = 0; cursor !== null; pages += 1) {
        assert.isBelow(pages, allIds.length);
        const page = yield* projectionStore.getThreadHistoryPage(threadId, cursor);
        const indexPage = yield* projectionStore.getThreadHistoryPage(threadId, cursor, "missing");
        assert.deepEqual(page, indexPage);
        assert.isAbove(page.items.length, 0);
        assert.isAtMost(page.items.length, THREAD_HISTORY_PAGE_POLICY.maxTurnItems);
        loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.nextCursor;
      }
      assert.isNull(cursor);
      assert.deepEqual(loaded, allIds);
    }),
  );

  it.effect("keeps a still-open question's item in a SQL window it has left", () =>
    Effect.gen(function* () {
      // A question asked four turns ago and never answered. A phone loads one
      // user turn: without the question's item it shows no card, while the chat
      // list still says the chat needs an answer.
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:open-question-window");
      yield* projectionStore.apply({
        id: EventId.make("event:open-question-window:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:open-question-window"),
          title: "Asked a while ago",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      let ordinal = 0;
      const itemRow = (
        runId: string,
        item: Record<string, unknown>,
        placement: { readonly nodeId?: string; readonly status?: string } = {},
      ) => {
        ordinal += 1;
        const id = `turn-item:open-question-window:${ordinal}`;
        const nodeId = placement.nodeId ?? null;
        const status = placement.status ?? "completed";
        return {
          turn_item_id: id,
          thread_id: threadId,
          run_id: runId,
          node_id: nodeId,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: String(item.type),
          status,
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString({
            id,
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status,
            title: null,
            startedAt: nowIso,
            completedAt: status === "completed" ? nowIso : null,
            updatedAt: nowIso,
            ...item,
          }),
        };
      };
      const requestId = (key: string) => `runtime-request:open-question-window:${key}`;
      const nodeId = (key: string) => `node:open-question-window:${key}`;
      const question = (key: string) => ({
        type: "user_input_request",
        requestId: requestId(key),
        questions: [
          {
            id: "q1",
            header: "Deploy",
            question: "Deploy it?",
            options: [
              { label: "Yes", description: "Deploy now." },
              { label: "No", description: "Wait." },
            ],
          },
        ],
        responseMode: "message",
      });
      const itemIds = new Map<string, string>();
      for (let run = 1; run <= 5; run += 1) {
        const runId = `run:open-question-window:${run}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${run}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal: run,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:open-question-window:${run}`,
              rootNodeId: `node:open-question-window:run:${run}`,
              activeAttemptId: null,
              status: "completed",
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
        const rows = [
          itemRow(runId, {
            type: "user_message",
            createdBy: "user",
            creationSource: "web",
            messageId: `message:open-question-window:${run}`,
            inputIntent: "turn_start",
            text: `Turn ${run}`,
            attachments: [],
          }),
          itemRow(runId, { type: "command_execution", input: "command", output: "x", exitCode: 0 }),
        ];
        if (run === 1) {
          const open = itemRow(runId, question("open"), {
            nodeId: nodeId("open"),
            status: "waiting",
          });
          const answered = itemRow(runId, question("answered"), { nodeId: nodeId("answered") });
          itemIds.set("open", open.turn_item_id);
          itemIds.set("answered", answered.turn_item_id);
          rows.push(open, answered);
        }
        if (run === 5) itemIds.set("latestTurn", rows[0]!.turn_item_id);
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
      }
      for (const [key, status] of [
        ["open", "pending"],
        ["answered", "resolved"],
      ] as const) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_runtime_requests (
            runtime_request_id, thread_id, node_id, provider_turn_id, kind, status,
            created_at, resolved_at, payload_json
          ) VALUES (
            ${requestId(key)}, ${threadId}, ${nodeId(key)}, NULL, 'user_input', ${status},
            ${nowIso}, ${status === "resolved" ? nowIso : null},
            ${encodeUnknownJsonString({
              id: requestId(key),
              nodeId: nodeId(key),
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status,
              responseCapability: { type: "message" },
              createdAt: nowIso,
              resolvedAt: status === "resolved" ? nowIso : null,
            })}
          )
        `;
      }

      const { statements, tracer } = traceSqlStatements();
      const snapshot = yield* projectionStore
        .getThreadSnapshotWindow(threadId, { rowLimit: 77, userTurnLimit: 1 })
        .pipe(Effect.withTracer(tracer));
      const readIds = snapshot.projection.turnItems.map((item) => String(item.id));
      // The window is the newest turn. The open question rides along; the
      // answered one, asked in the same old turn, does not.
      assert.include(readIds, itemIds.get("latestTurn")!);
      assert.include(readIds, itemIds.get("open")!);
      assert.notInclude(readIds, itemIds.get("answered")!);

      // Both tables are reached through an index, never by a walk over the chat.
      const windowStatement = statements.find((statement) =>
        statement.includes("orchestration_v2_projection_runtime_requests AS request"),
      );
      assert.isDefined(windowStatement);
      const plan = (yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${windowStatement}`,
      )).map((row) => row.detail);
      const requestStep = plan.findIndex((detail) =>
        detail.startsWith(
          "SEARCH request USING INDEX orchestration_v2_projection_runtime_requests_thread_status_idx",
        ),
      );
      assert.isAtLeast(requestStep, 0);
      assert.match(
        plan[requestStep + 1] ?? "",
        /^SEARCH item USING INDEX orchestration_v2_projection_turn_items_node_ordinal_idx \(node_id=\?/,
      );
      assert.deepEqual(
        plan.filter((detail) => /^SCAN (request|item)\b/.test(detail)),
        [],
      );

      // What a client receives: the question's item, outside the rows it shows.
      const bounded = buildBoundedThreadProjection({
        projection: snapshot.projection,
        snapshotSequence: 0,
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: 1 },
      });
      assert.include(
        bounded.projection.turnItems.map((item) => String(item.id)),
        itemIds.get("open")!,
      );
      assert.notInclude(
        bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId)),
        itemIds.get("open")!,
      );

      // An older page is history only: it does not repeat the open question.
      const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 77,
        userTurnLimit: 1,
        anchorItemId: TurnItemId.make(itemIds.get("latestTurn")!),
        anchorThreadId: threadId,
      });
      assert.notInclude(
        older.projection.turnItems.map((item) => String(item.id)),
        itemIds.get("open")!,
      );
    }),
  );

  it.effect("caps a SQL window by runs that a notification started", () =>
    Effect.gen(function* () {
      // A thread woken by PR watches: 12 user turns, then 400 runs that a
      // notification started, with a user turn every 50 runs. The user-turn
      // window reached back to the 12th-newest user turn and read almost every row.
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:notification-turn-pages");
      yield* projectionStore.apply({
        id: EventId.make("event:notification-turn-pages:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:notification-turn-pages"),
          title: "Woken by notifications",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      const startedRuns = 412;
      const allIds: string[] = [];
      const startIds: string[] = [];
      let ordinal = 0;
      const itemRow = (runId: string, item: Record<string, unknown>) => {
        ordinal += 1;
        const id = `turn-item:notification-turn-pages:${ordinal}`;
        allIds.push(id);
        return {
          turn_item_id: id,
          thread_id: threadId,
          run_id: runId,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: String(item.type),
          status: "completed",
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString({
            id,
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            ...item,
          }),
        };
      };
      const command = { type: "command_execution", input: "command", output: "x", exitCode: 0 };
      const notification = (summary: string) => ({
        type: "notification",
        source: { kind: "monitor" },
        outcome: "completed",
        summary,
      });
      // The newest run is a wake queued behind the last one. It has no items yet,
      // like a run cancelled before it started.
      for (let run = 1; run <= startedRuns + 1; run += 1) {
        const runId = `run:notification-turn-pages:${run}`;
        const status = run > startedRuns ? "queued" : "completed";
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${run}, 'codex', NULL, ${status}, ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal: run,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:notification-turn-pages:${run}`,
              rootNodeId: `node:notification-turn-pages:${run}`,
              activeAttemptId: null,
              status,
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
        if (run > startedRuns) continue;
        const start =
          run <= 12 || run % 50 === 0
            ? {
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                messageId: `message:notification-turn-pages:${run}`,
                inputIntent: "turn_start",
                text: `Turn ${run}`,
                attachments: [],
              }
            : notification(`Wake ${run}`);
        // A row of the run (a handoff) can come before its first input. A wake
        // steered into the running turn follows it and starts no turn.
        const rows = [
          itemRow(runId, command),
          itemRow(runId, start),
          itemRow(runId, command),
          itemRow(runId, notification(`Steer ${run}`)),
        ];
        startIds.push(rows[1]!.turn_item_id);
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
      }

      const { statements, tracer } = traceSqlStatements();
      const initial = yield* projectionStore
        .getThreadSnapshotWindow(threadId, { rowLimit: 77, userTurnLimit: 10 })
        .pipe(Effect.withTracer(tracer));
      // The turn row budget also caps notification-driven cohorts.
      assert.deepEqual(
        initial.projection.turnItems.map((item) => String(item.id)),
        allIds.slice(-THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT),
      );
      // Each run's first input is read by run ID, newest run first, never by a
      // walk over every turn item in the thread.
      const windowStatement = statements.find((statement) => statement.includes("run_starts"));
      assert.isDefined(windowStatement);
      const windowPlan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${windowStatement}`,
      );
      const windowPlanDetails = windowPlan.map((row) => row.detail);
      assert.include(
        windowPlanDetails,
        "SEARCH recent_run USING INDEX orchestration_v2_projection_runs_thread_ordinal_idx (thread_id=? AND ordinal<?)",
      );
      assert.include(
        windowPlanDetails,
        "SEARCH first_input USING INDEX orchestration_v2_projection_turn_items_run_ordinal_idx (run_id=?)",
      );
      const bounded = buildBoundedThreadProjection({
        projection: initial.projection,
        snapshotSequence: 0,
      });
      assert.isAtMost(
        bounded.projection.visibleTurnItems.length,
        THREAD_HISTORY_PAGE_POLICY.maxTurnItems,
      );
      const loaded = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
      let cursor = bounded.historyCursor;
      for (let pages = 0; cursor !== null; pages += 1) {
        assert.isBelow(pages, allIds.length);
        const anchor = decodeThreadHistoryCursor(cursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 77,
          userTurnLimit: 20,
          anchorItemId: TurnItemId.make(anchor.si),
          anchorThreadId: ThreadId.make(anchor.st),
        });
        // Older windows stay bounded too.
        assert.isAtMost(snapshot.projection.turnItems.length, 152 * 4 + 1);
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: 0,
        });
        const localPage = yield* projectionStore.getThreadHistoryPage(threadId, cursor);
        const indexPage = yield* projectionStore.getThreadHistoryPage(threadId, cursor, "missing");
        assert.deepEqual(localPage, indexPage);
        loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.nextCursor;
      }
      assert.deepEqual(loaded, allIds);
    }),
  );

  it.effect(
    "bounds completed nodes within one long run while preserving ancestry and live work",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:bounded-node-history");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:bounded-node-history"),
            title: "Bounded SQL history",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const runId = RunId.make("run:bounded-node-history");
        const rootNodeId = NodeId.make("node:bounded-node-history:root");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:run"),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:bounded-node-history"),
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        const parentNodeId = NodeId.make("node:bounded-node-history:parent");
        const liveNodeId = NodeId.make("node:bounded-node-history:live");
        for (let index = -3; index < 1000; index++) {
          const id =
            index === -3
              ? rootNodeId
              : index === -2
                ? parentNodeId
                : index === -1
                  ? liveNodeId
                  : NodeId.make(`node:bounded-node-history:${index}`);
          yield* projectionStore.apply({
            id: EventId.make(`event:bounded-node-history:node:${index}`),
            type: "node.updated",
            threadId,
            runId,
            nodeId: id,
            driver,
            occurredAt: now,
            payload: {
              id,
              threadId,
              runId,
              rootNodeId,
              parentNodeId: index === -3 ? null : index === -2 ? rootNodeId : parentNodeId,
              kind: index === -3 ? "root_turn" : "assistant_message",
              status: index === -1 ? "running" : "completed",
              countsForRun: index === -3,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt:
                index === 998
                  ? null
                  : index === 999
                    ? DateTime.makeUnsafe("2020-01-01T00:00:00.000Z")
                    : now,
              completedAt: index === -1 ? null : now,
            },
          });
          if (index < 0) continue;
          yield* projectionStore.apply({
            id: EventId.make(`event:bounded-node-history:item:${index}`),
            type: "turn-item.updated",
            threadId,
            runId,
            nodeId: id,
            driver,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:bounded-node-history:${index}`),
              threadId,
              runId,
              nodeId: id,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: index,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "command_execution",
              input: `echo ${index}`,
              output: "ok",
              exitCode: 0,
            },
          });
        }
        const requestNodeId = NodeId.make("node:bounded-node-history:0");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:request"),
          type: "runtime-request.updated",
          threadId,
          runId,
          nodeId: requestNodeId,
          driver,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("request:bounded-node-history"),
            nodeId: requestNodeId,
            providerTurnId: ProviderTurnId.make("provider-turn:bounded-node-history"),
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make("session:bounded-node-history"),
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const { statements, tracer } = traceSqlStatements();
        const snapshot = yield* projectionStore
          .getThreadSnapshotWindow(threadId, { rowLimit: 75 })
          .pipe(Effect.withTracer(tracer));
        const nodeStatement = statements.find(
          (statement) =>
            statement.includes("payload_json") &&
            statement.includes("orchestration_v2_projection_nodes") &&
            !statement.includes("WITH RECURSIVE"),
        );
        assert.isDefined(nodeStatement);
        const nodePlan = yield* (yield* SqlClient.SqlClient).unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${nodeStatement}`,
        );
        const nodeLookups = nodePlan
          .map((row) => row.detail)
          .filter((detail) => detail.startsWith("SEARCH "));
        // Cost must follow the retained cohort, even when the thread has
        // thousands of completed nodes outside the requested window.
        assert.deepEqual(nodeLookups, [
          "SEARCH node USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes_1 (node_id=?)",
        ]);
        assert.notInclude(
          nodePlan.map((row) => row.detail),
          "USE TEMP B-TREE FOR ORDER BY",
        );
        assert.lengthOf(snapshot.projection.visibleTurnItems, 75);
        assert.lengthOf(snapshot.projection.nodes, 79);
        const retained = new Set(snapshot.projection.nodes.map((node) => node.id));
        assert.isTrue(retained.has(rootNodeId));
        assert.isTrue(retained.has(parentNodeId));
        assert.isTrue(retained.has(liveNodeId));
        assert.isTrue(retained.has(requestNodeId));
        assert.lengthOf(snapshot.projection.runtimeRequests, 1);
        assert.isFalse(retained.has(NodeId.make("node:bounded-node-history:1")));
        for (const row of snapshot.projection.visibleTurnItems)
          assert.isTrue(retained.has(row.item.nodeId!));
        const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 75,
          anchorItemId: TurnItemId.make("item:bounded-node-history:925"),
        });
        assert.lengthOf(older.projection.nodes, 79);
        assert.isTrue(
          older.projection.nodes.some(
            (node) => node.id === NodeId.make("node:bounded-node-history:851"),
          ),
        );
        const fullTrace = traceSqlStatements();
        const full = yield* projectionStore
          .getThreadSnapshot(threadId)
          .pipe(Effect.withTracer(fullTrace.tracer));
        assert.lengthOf(full.projection.nodes, 1003);
        const fullNodeStatement = fullTrace.statements.find(
          (statement) =>
            statement.includes("payload_json") &&
            statement.includes("FROM orchestration_v2_projection_nodes AS node"),
        );
        assert.isDefined(fullNodeStatement);
        const fullNodePlan = yield* (yield* SqlClient.SqlClient).unsafe<{
          readonly detail: string;
        }>(`EXPLAIN QUERY PLAN ${fullNodeStatement}`);
        // Full reads serve agent tools too. Sorting these bodies in SQLite
        // stalled the server on long chats, even when the client used a window.
        assert.notInclude(
          fullNodePlan.map((row) => row.detail),
          "USE TEMP B-TREE FOR ORDER BY",
        );
        const expectedOrder = yield* (yield* SqlClient.SqlClient)<{ readonly node_id: string }>`
          SELECT node_id FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId}
          ORDER BY COALESCE(started_at, ''), node_id ASC
        `;
        assert.deepEqual(
          full.projection.nodes.map((node) => node.id),
          expectedOrder.map((row) => row.node_id),
        );
        // Bounded reads keep the full read's payloads and ordering, including
        // null start times and equal timestamps.
        assert.deepEqual(
          snapshot.projection.nodes,
          full.projection.nodes.filter((node) => retained.has(node.id)),
        );
        const sql = yield* SqlClient.SqlClient;
        const duplicateItemId = TurnItemId.make("item:bounded-node-history:duplicate");
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
          SELECT ${duplicateItemId}, thread_id, run_id, node_id, provider_thread_id,
            provider_turn_id, parent_item_id, ordinal + 1, type, status, updated_at,
            json_set(payload_json, '$.id', ${duplicateItemId}, '$.ordinal', ordinal + 1)
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${TurnItemId.make("item:bounded-node-history:999")}
        `;
        const sharedNodeSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 76,
        });
        assert.lengthOf(sharedNodeSnapshot.projection.visibleTurnItems, 76);
        assert.deepEqual(sharedNodeSnapshot.projection.nodes, snapshot.projection.nodes);
      }),
  );

  it.effect(
    "omits historical ready handoffs and seeks bounded messages and runs by primary key",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const nowIso = DateTime.formatIso(now);
        const threadId = ThreadId.make("thread:bounded-handoff-and-message-seeks");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-handoff-seeks:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:bounded-handoff-seeks"),
            title: "Bounded handoffs and seeks",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        const makeHandoffJson = (id: string, targetRunId: string, status: "pending" | "ready") =>
          encodeUnknownJsonString({
            id,
            transferId: null,
            threadId,
            targetRunId,
            fromProviderThreadIds: [],
            toProviderThreadId: "provider-thread:handoff-seeks",
            coveredRunOrdinals: { from: 1, to: 1 },
            strategy: "full_thread_summary",
            status,
            summaryMessageId: null,
            summaryText: "synthetic summary",
            createdByProviderInstanceId: null,
            createdAt: nowIso,
            updatedAt: nowIso,
          });
        for (let ordinal = 1; ordinal <= 120; ordinal += 1) {
          const runId = `run:bounded-handoff-seeks:${ordinal}`;
          const messageId = `message:bounded-handoff-seeks:${ordinal}`;
          const itemId = `item:bounded-handoff-seeks:${ordinal}`;
          const handoffId = `handoff:bounded-handoff-seeks:${ordinal}`;
          yield* sql`
            INSERT INTO orchestration_v2_projection_runs (
              run_id, thread_id, ordinal, provider, provider_thread_id, status,
              requested_at, completed_at, payload_json
            ) VALUES (
              ${runId}, ${threadId}, ${ordinal}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
              ${encodeUnknownJsonString({
                id: runId,
                threadId,
                ordinal,
                providerInstanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: messageId,
                rootNodeId: `node:bounded-handoff-seeks:${ordinal}`,
                activeAttemptId: null,
                status: "completed",
                requestedAt: nowIso,
                startedAt: nowIso,
                completedAt: nowIso,
                checkpointId: null,
                contextHandoffId: handoffId,
              })}
            )
          `;
          yield* sql`
            INSERT INTO orchestration_v2_projection_messages (
              message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json
            ) VALUES (
              ${messageId}, ${threadId}, ${runId}, NULL, 'user', 0, ${nowIso}, ${nowIso},
              ${encodeUnknownJsonString({
                id: messageId,
                threadId,
                runId,
                nodeId: null,
                role: "user",
                text: `Synthetic message ${ordinal}`,
                attachments: [],
                streaming: false,
                createdBy: "user",
                creationSource: "web",
                createdAt: nowIso,
                updatedAt: nowIso,
              })}
            )
          `;
          yield* sql`
            INSERT INTO orchestration_v2_projection_turn_items (
              turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
              parent_item_id, ordinal, type, status, updated_at, payload_json
            ) VALUES (
              ${itemId}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
              'user_message', 'completed', ${nowIso},
              ${encodeUnknownJsonString({
                id: itemId,
                threadId,
                runId,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                type: "user_message",
                status: "completed",
                title: "User message",
                messageId,
                text: `Synthetic message ${ordinal}`,
                attachments: [],
                inputIntent: "turn_start",
                createdBy: "user",
                creationSource: "web",
                startedAt: nowIso,
                completedAt: nowIso,
                updatedAt: nowIso,
              })}
            )
          `;
          yield* sql`
            INSERT INTO orchestration_v2_projection_context_handoffs (
              context_handoff_id, thread_id, target_run_id, to_provider_thread_id,
              strategy, status, updated_at, payload_json
            ) VALUES (
              ${handoffId}, ${threadId}, ${runId}, 'provider-thread:handoff-seeks',
              'full_thread_summary', 'ready', ${nowIso},
              ${makeHandoffJson(handoffId, runId, "ready")}
            )
          `;
        }
        yield* sql`
          INSERT INTO orchestration_v2_projection_context_handoffs (
            context_handoff_id, thread_id, target_run_id, to_provider_thread_id,
            strategy, status, updated_at, payload_json
          ) VALUES (
            'handoff:bounded-handoff-seeks:pending', ${threadId}, 'run:bounded-handoff-seeks:pending',
            'provider-thread:handoff-seeks', 'full_thread_summary', 'pending', ${nowIso},
            ${makeHandoffJson("handoff:bounded-handoff-seeks:pending", "run:bounded-handoff-seeks:pending", "pending")}
          )
        `;

        const { statements, tracer } = traceSqlStatements();
        const snapshot = yield* projectionStore
          .getThreadSnapshotWindow(threadId, { rowLimit: 77, userTurnLimit: 1 })
          .pipe(Effect.withTracer(tracer));

        // Only pending handoffs plus handoffs for runs in the window are loaded;
        // 100+ older settled 'ready' handoffs must not be read or returned.
        const handoffIds = snapshot.projection.contextHandoffs.map((h) => String(h.id));
        assert.include(handoffIds, "handoff:bounded-handoff-seeks:pending");
        assert.include(handoffIds, "handoff:bounded-handoff-seeks:120");
        assert.notInclude(handoffIds, "handoff:bounded-handoff-seeks:1");
        assert.isBelow(handoffIds.length, 10);

        const messageStatement = statements.find(
          (statement) =>
            statement.includes("payload_json") &&
            statement.includes("orchestration_v2_projection_messages"),
        );
        assert.isDefined(messageStatement);
        const messagePlan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${messageStatement}`,
        );
        assert.isFalse(
          messagePlan.some((row) =>
            row.detail.includes("orchestration_v2_projection_messages_thread_created_idx"),
          ),
          `Expected PK/run_id seeks instead of full thread message scan: ${JSON.stringify(messagePlan)}`,
        );

        const runStatement = statements.find(
          (statement) =>
            statement.includes("SELECT run.payload_json") &&
            statement.includes("orchestration_v2_projection_runs") &&
            !statement.includes("WITH RECURSIVE"),
        );
        assert.isDefined(runStatement);
        const runPlan = yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${runStatement}`,
        );
        assert.isFalse(
          runPlan.some((row) =>
            row.detail.includes("orchestration_v2_projection_runs_thread_ordinal_idx"),
          ),
          `Expected PK/recovery_idx seeks instead of full thread run scan: ${JSON.stringify(runPlan)}`,
        );
      }),
  );

  it.effect("reads a fixed SQL turn-item window for long histories and repeated clients", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:bounded-sql-history");
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-sql-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:bounded-sql-history"),
          title: "Bounded SQL history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:${ordinal}`;
        const runId = `run:bounded-sql-history:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${ordinal}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:bounded-sql-history:${ordinal}`,
              rootNodeId: `node:bounded-sql-history:${ordinal}`,
              activeAttemptId: null,
              status: "completed",
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `command ${ordinal}`,
              input: `echo ${ordinal}`,
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const snapshots = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 76 }),
        ),
        { concurrency: 4 },
      );
      for (const snapshot of snapshots) {
        assert.lengthOf(snapshot.projection.turnItems, 76);
        assert.lengthOf(snapshot.projection.runs, 76);
        assert.lengthOf(snapshot.projection.visibleTurnItems, 76);
        assert.strictEqual(snapshot.projection.turnItems[0]?.ordinal, 925);
        assert.strictEqual(snapshot.projection.turnItems.at(-1)?.ordinal, 1_000);
      }
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'user_message', payload_json = json_set(payload_json,
          '$.type', 'user_message', '$.createdBy', 'user', '$.creationSource', 'web',
          '$.inputIntent', 'turn_start', '$.messageId', turn_item_id, '$.text', 'Turn',
          '$.attachments', json('[]'))
        WHERE thread_id = ${threadId} AND ordinal IN (1, 1000)
      `;
      const humanWindow = () =>
        projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 77,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        });
      assert.lengthOf(
        (yield* humanWindow()).projection.turnItems,
        THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
      );
      // With the newest user turn 1,000 rows back, the window pages from inside it.
      const setNewestTurnType = (type: "command_execution" | "user_message") => sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = ${type}, payload_json = json_set(payload_json, '$.type', ${type})
        WHERE thread_id = ${threadId} AND ordinal = 1000
      `;
      yield* setNewestTurnType("command_execution");
      assert.lengthOf((yield* humanWindow()).projection.turnItems, 77);
      yield* setNewestTurnType("user_message");

      // Fewer than 75 rows still need a byte pass after materializing wire payloads.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'assistant_message', payload_json = json_set(payload_json,
          '$.type', 'assistant_message', '$.text', ${"x".repeat(40_000)},
          '$.messageId', turn_item_id, '$.streaming', json('false'))
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 2 AND 70
      `;
      const byteCursor = encodeThreadHistoryCursor({
        snapshotSequence: 0,
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("turn-item:bounded-sql-history:71"),
        position: 70,
      });
      const bytePage = yield* projectionStore.getThreadHistoryPage(threadId, byteCursor);
      assert.isAbove(bytePage.items.length, 0);
      assert.isBelow(bytePage.items.length, 70);
      assert.isAtMost(
        Buffer.byteLength(JSON.stringify(bytePage.items), "utf8"),
        THREAD_HISTORY_PAGE_POLICY.maxEncodedBytes,
      );
      const byteIds = bytePage.items.map((row) => String(row.sourceItemId));
      let byteNext = bytePage.nextCursor;
      for (let pages = 0; byteNext !== null; pages += 1) {
        assert.isBelow(pages, 70);
        const page = yield* projectionStore.getThreadHistoryPage(threadId, byteNext);
        assert.isAbove(page.items.length, 0);
        byteIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        byteNext = page.nextCursor;
      }
      assert.deepEqual(
        byteIds,
        Array.from({ length: 70 }, (_, index) => `turn-item:bounded-sql-history:${index + 1}`),
      );

      // Selected message reads recover ordinals for only the loaded messages, while 69
      // unloaded assistant messages remain in the thread's history.
      const firstMessageId = MessageId.make("message:bounded-sql-history:1");
      const lastMessageId = MessageId.make("message:bounded-sql-history:1000");
      // This fork's paging fixture stores turn items directly; seed the two selected messages.
      for (const ordinal of [1, 1000]) {
        const id = MessageId.make(`message:bounded-sql-history:${ordinal}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:${id}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id,
            threadId,
            runId: RunId.make(`run:bounded-sql-history:${ordinal}`),
            nodeId: null,
            role: "user",
            text: "Selected input",
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      // Like every writer, each row has its message's run and the type of its message's role.
      const insertMessageItem = (
        suffix: string,
        itemThreadId: string,
        ordinal: number,
        messageId: string | null | undefined,
        runId: string,
      ) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${`turn-item:bounded-sql-history:ordinal-${suffix}`}, ${itemThreadId}, ${runId}, NULL,
          NULL, NULL, NULL, ${ordinal}, 'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({ messageId })}
        )
      `;
      yield* insertMessageItem(
        "duplicate",
        threadId,
        0,
        lastMessageId,
        "run:bounded-sql-history:1000",
      );
      yield* insertMessageItem(
        "other-thread",
        "thread:bounded-sql-history:other",
        -1,
        firstMessageId,
        "run:bounded-sql-history:1",
      );
      yield* insertMessageItem("null-id", threadId, -2, null, "run:bounded-sql-history:1");
      yield* insertMessageItem("missing-id", threadId, -3, undefined, "run:bounded-sql-history:1");
      const readMessageIds = (filter?: ProjectionStore.ProjectionRecordFilter) =>
        projectionStore
          .getThreadRecords(threadId, ["messages"], filter)
          .pipe(Effect.map(({ messages }) => messages.map((message) => message.id)));
      assert.deepEqual(yield* readMessageIds(), [lastMessageId, firstMessageId]);
      assert.deepEqual(yield* readMessageIds({ messageRoles: ["user", "assistant"] }), [
        lastMessageId,
        firstMessageId,
      ]);
      for (const filter of [
        {
          messageIds: [
            firstMessageId,
            lastMessageId,
            MessageId.make("message:bounded-sql-history:absent"),
          ],
        },
        { messageRoles: ["user" as const] },
        {
          messageRunIds: [
            RunId.make("run:bounded-sql-history:1"),
            RunId.make("run:bounded-sql-history:1000"),
          ],
        },
      ]) {
        assert.deepEqual(yield* readMessageIds(filter), [lastMessageId, firstMessageId]);
      }
      assert.deepEqual(yield* readMessageIds({ messageIds: [] }), []);
      assert.deepEqual(yield* readMessageIds({ messageIds: [firstMessageId] }), [firstMessageId]);
      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id LIKE 'turn-item:bounded-sql-history:ordinal-%'
      `;
      yield* sql`DELETE FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId} AND message_id IN (${firstMessageId}, ${lastMessageId})`;

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'command_execution', payload_json = json_set(payload_json, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 2 AND 70
      `;

      // A targeted page that needs more than 20 human turns must still reach its target
      // after the byte pass re-bounds it.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'user_message', payload_json = json_set(payload_json,
          '$.type', 'user_message', '$.createdBy', 'user', '$.creationSource', 'web',
          '$.inputIntent', 'turn_start', '$.messageId', turn_item_id, '$.text', 'Turn',
          '$.attachments', json('[]'))
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 600 AND 624
      `;
      const targetedPage = yield* projectionStore.getThreadHistoryPage(
        threadId,
        encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("turn-item:bounded-sql-history:625"),
          position: 624,
        }),
        "turn-item:bounded-sql-history:600",
      );
      assert.strictEqual(
        String(targetedPage.items[0]?.sourceItemId),
        "turn-item:bounded-sql-history:600",
      );
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'command_execution', payload_json = json_set(payload_json, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal BETWEEN 600 AND 624
      `;

      // A turn split by the row budget keeps an interrupt result's request on the same page.
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:500',
          type = CASE ordinal WHEN 500 THEN 'run_interrupt_request' ELSE 'run_interrupt_result' END,
          payload_json = json_set(payload_json,
            '$.runId', 'run:bounded-sql-history:500', '$.message', 'Stop',
            '$.type', CASE ordinal WHEN 500 THEN 'run_interrupt_request' ELSE 'run_interrupt_result' END)
        WHERE thread_id = ${threadId} AND ordinal IN (500, 580)
      `;
      const interruptPage = yield* projectionStore.getThreadHistoryPage(
        threadId,
        encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: threadId,
          sourceItemId: TurnItemId.make("turn-item:bounded-sql-history:590"),
          position: 589,
        }),
      );
      const interruptIds = interruptPage.items.map((row) => String(row.sourceItemId));
      assert.include(interruptIds, "turn-item:bounded-sql-history:580");
      assert.include(interruptIds, "turn-item:bounded-sql-history:500");
      assert.notInclude(interruptIds, "turn-item:bounded-sql-history:501");
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET run_id = 'run:bounded-sql-history:' || ordinal, type = 'command_execution',
          payload_json = json_set(payload_json,
            '$.runId', 'run:bounded-sql-history:' || ordinal, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal IN (500, 580)
      `;

      const retainedRequestPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH selected AS (
          SELECT run_id, type
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
          ORDER BY ordinal DESC, turn_item_id DESC
          LIMIT 77
        )
        SELECT request.payload_json
        FROM orchestration_v2_projection_turn_items AS request
        WHERE request.run_id IN (
            SELECT run_id FROM selected
            WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
          )
          AND request.type = 'run_interrupt_request'
      `;
      assert.isTrue(
        retainedRequestPlan.some((row) =>
          row.detail.includes("orchestration_v2_projection_turn_items_run_ordinal_idx"),
        ),
      );

      const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 76,
        anchorItemId: TurnItemId.make("turn-item:bounded-sql-history:925"),
      });
      assert.lengthOf(older.projection.turnItems, 76);
      assert.lengthOf(older.projection.runs, 76);
      assert.strictEqual(older.projection.turnItems[0]?.ordinal, 850);
      assert.strictEqual(older.projection.turnItems.at(-1)?.ordinal, 925);

      // A single item reads back with its full output, scoped to its thread.
      const itemId = TurnItemId.make("turn-item:bounded-sql-history:925");
      const stored = yield* projectionStore.getTurnItem({ threadId, itemId });
      assert.strictEqual(stored?.type === "command_execution" ? stored.output : undefined, "ok");
      assert.isNull(
        yield* projectionStore.getTurnItem({ threadId: ThreadId.make("thread:other"), itemId }),
      );

      const sqlPageLimit = THREAD_HISTORY_PAGE_POLICY.maxItems + 2;
      const initialSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
      });
      const initialPage = buildBoundedThreadProjection({
        projection: initialSnapshot.projection,
        snapshotSequence: initialSnapshot.snapshotSequence,
      });
      const loadedIds = initialPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let cursor = initialPage.historyCursor;
      let pageCount = 1;
      while (cursor !== null) {
        const anchorItemId = TurnItemId.make(decodeThreadHistoryCursor(cursor).si);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          userTurnLimit: 20,
          anchorItemId,
        });
        assert.isAtMost(
          snapshot.projection.visibleTurnItems.length,
          THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
        );
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        loadedIds.push(...page.items.map((row) => String(row.sourceItemId)));
        pageCount += 1;
        cursor = page.nextCursor;
      }

      assert.isAtLeast(pageCount, 3);
      assert.lengthOf(loadedIds, 1_000);
      assert.strictEqual(new Set(loadedIds).size, 1_000);
      assert.deepEqual(
        loadedIds.toSorted(
          (left, right) => Number(left.split(":").at(-1)) - Number(right.split(":").at(-1)),
        ),
        Array.from({ length: 1_000 }, (_, index) => `turn-item:bounded-sql-history:${index + 1}`),
      );

      // Physical insertion order must not change the ordinal/ID timeline order.
      const tiedIds = [
        TurnItemId.make("turn-item:bounded-sql-history:tie:b"),
        TurnItemId.make("turn-item:bounded-sql-history:tie:a"),
      ];
      for (const id of tiedIds) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          )
          SELECT ${id}, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, 2000, type, status, updated_at,
            json_set(payload_json, '$.id', ${id}, '$.ordinal', 2000)
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${itemId}
        `;
      }
      const tied = yield* projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 3 });
      assert.deepEqual(
        tied.projection.turnItems.map((item) => item.id),
        [TurnItemId.make("turn-item:bounded-sql-history:1000"), tiedIds[1], tiedIds[0]],
      );
      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id IN ${sql.in(tiedIds)}
      `;

      const hiddenRunId = RunId.make("run:bounded-sql-history:hidden-suffix");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${hiddenRunId}, ${threadId}, 1001, 'codex', NULL, 'rolled_back', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: hiddenRunId,
            threadId,
            ordinal: 1001,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:bounded-sql-history:hidden-suffix",
            rootNodeId: "node:bounded-sql-history:hidden-suffix",
            activeAttemptId: null,
            status: "rolled_back",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 1_001; ordinal <= 1_100; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:hidden:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${hiddenRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: hiddenRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "rolled back",
              input: "echo hidden",
              output: "hidden",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const hiddenSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const hiddenSuffixPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: hiddenSuffixSnapshot.projection,
        snapshotSequence: hiddenSuffixSnapshot.snapshotSequence,
      });
      assert.lengthOf(hiddenSuffixPage.projection.visibleTurnItems, 75);
      assert.strictEqual(hiddenSuffixPage.latestLocalTurnOrdinal, 1_100);
      assert.isTrue(hiddenSuffixPage.hasMoreHistory);
      assert.isFalse(
        hiddenSuffixPage.projection.visibleTurnItems.some((row) =>
          String(row.sourceItemId).includes(":hidden:"),
        ),
      );
      const hiddenSuffixCursor = hiddenSuffixPage.historyCursor;
      assert.isNotNull(hiddenSuffixCursor);
      const hiddenSuffixAnchor = TurnItemId.make(decodeThreadHistoryCursor(hiddenSuffixCursor!).si);
      const hiddenSuffixOlderSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        anchorItemId: hiddenSuffixAnchor,
      });
      const hiddenSuffixOlderPage = selectHistoryPageFromCursor({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        items: hiddenSuffixOlderSnapshot.projection.visibleTurnItems,
        cursor: hiddenSuffixCursor!,
        snapshotSequence: hiddenSuffixOlderSnapshot.snapshotSequence,
      });
      assert.lengthOf(hiddenSuffixOlderPage.items, 75);
      assert.isTrue(hiddenSuffixOlderPage.hasMoreHistory);

      const cancelledRunId = RunId.make("run:bounded-sql-history:cancelled-suffix");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${cancelledRunId}, ${threadId}, 1002, 'codex', NULL, 'cancelled', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: cancelledRunId,
            threadId,
            ordinal: 1002,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:bounded-sql-history:cancelled-suffix",
            rootNodeId: "node:bounded-sql-history:cancelled-suffix",
            activeAttemptId: null,
            status: "cancelled",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 1_101; ordinal <= 1_200; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:cancelled:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'user_message', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              createdBy: "user",
              creationSource: "web",
              id,
              threadId,
              runId: cancelledRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "cancelled queued message",
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "user_message",
              messageId: `message:bounded-sql-history:cancelled:${ordinal}`,
              inputIntent: "queued_turn",
              text: "cancelled",
              attachments: [],
            })}
          )
        `;
      }
      const runlessQueuedId = "turn-item:bounded-sql-history:runless-queued";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${runlessQueuedId}, ${threadId}, NULL, NULL, NULL, NULL, NULL, 1201,
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id: runlessQueuedId,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1201,
            status: "completed",
            title: "runless queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:bounded-sql-history:runless-queued",
            inputIntent: "queued_turn",
            text: "still visible",
            attachments: [],
          })}
        )
      `;
      const laterCancelledId = "turn-item:bounded-sql-history:cancelled:1202";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${laterCancelledId}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, 1202,
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id: laterCancelledId,
            threadId,
            runId: cancelledRunId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1202,
            status: "completed",
            title: "later cancelled queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:bounded-sql-history:cancelled:1202",
            inputIntent: "queued_turn",
            text: "cancelled",
            attachments: [],
          })}
        )
      `;
      const cancelledSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const cancelledSuffixPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: cancelledSuffixSnapshot.projection,
        snapshotSequence: cancelledSuffixSnapshot.snapshotSequence,
      });
      assert.strictEqual(cancelledSuffixPage.latestLocalTurnOrdinal, 1_202);
      assert.lengthOf(cancelledSuffixPage.projection.visibleTurnItems, 75);
      assert.isFalse(
        cancelledSuffixPage.projection.visibleTurnItems.some((row) =>
          String(row.sourceItemId).includes(":cancelled:"),
        ),
      );
      assert.isTrue(
        cancelledSuffixPage.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === runlessQueuedId,
        ),
      );

      const interruptRunId = RunId.make("run:bounded-sql-history:interrupt");
      const interruptNodeId = NodeId.make("node:bounded-sql-history:interrupt");
      const interruptRequestId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-request");
      const interruptResultId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-result");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${interruptRunId}, ${threadId}, 1003, 'codex', 'provider-thread:interrupt', 'completed',
          ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: interruptRunId,
            threadId,
            ordinal: 1003,
            providerInstanceId,
            modelSelection,
            providerThreadId: "provider-thread:interrupt",
            userMessageId: "message:interrupt",
            rootNodeId: interruptNodeId,
            activeAttemptId: "attempt:bounded-sql-history:interrupt",
            status: "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        ) VALUES (
          'attempt:bounded-sql-history:interrupt', ${threadId}, ${interruptRunId}, 1,
          ${interruptNodeId}, 'codex', ${providerInstanceId}, 'provider-thread:interrupt', NULL,
          'superseded',
          ${encodeUnknownJsonString({
            id: "attempt:bounded-sql-history:interrupt",
            runId: interruptRunId,
            attemptOrdinal: 1,
            rootNodeId: interruptNodeId,
            providerInstanceId,
            providerThreadId: "provider-thread:interrupt",
            providerTurnId: null,
            reason: "initial",
            status: "superseded",
            startedAt: nowIso,
            completedAt: nowIso,
          })}
        )
      `;
      const insertInterruptItem = (input: {
        id: TurnItemId;
        ordinal: number;
        type: "run_interrupt_request" | "run_interrupt_result";
      }) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${input.id}, ${threadId}, ${interruptRunId}, ${interruptNodeId}, NULL, NULL, NULL,
          ${input.ordinal}, ${input.type}, 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id: input.id,
            threadId,
            runId: interruptRunId,
            nodeId: interruptNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal,
            status: "completed",
            title: input.type,
            message: input.type === "run_interrupt_request" ? "Stopping" : "Stopped",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: input.type,
          })}
        )
      `;
      yield* insertInterruptItem({
        id: interruptRequestId,
        ordinal: 1_201,
        type: "run_interrupt_request",
      });
      for (let ordinal = 1_202; ordinal <= 1_281; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:interrupt-filler:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, NULL, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "filler",
              input: "echo filler",
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      yield* insertInterruptItem({
        id: interruptResultId,
        ordinal: 1_282,
        type: "run_interrupt_result",
      });

      const interruptSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      assert.isTrue(
        interruptSnapshot.projection.turnItems.some((item) => item.id === interruptRequestId),
      );
      assert.isTrue(
        interruptSnapshot.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === interruptResultId,
        ),
      );

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = json_set(payload_json, '$.createdBy', 'agent')
        WHERE thread_id = ${threadId} AND type = 'user_message'
      `;
      const agentPromptId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-filler:1281");
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'user_message',
          payload_json = json_set(payload_json,
            '$.type', 'user_message', '$.inputIntent', 'turn_start',
            '$.createdBy', 'agent', '$.creationSource', 'provider',
            '$.messageId', 'message:bounded-sql-history:agent-prompt',
            '$.text', 'Continue the child task', '$.attachments', json('[]'))
        WHERE turn_item_id = ${agentPromptId}
      `;
      const agentWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
      });
      assert.lengthOf(
        agentWindow.projection.visibleTurnItems.filter(
          (row) => row.item.type !== "run_interrupt_request",
        ),
        sqlPageLimit,
      );
      assert.isTrue(
        agentWindow.projection.visibleTurnItems.some((row) => row.sourceItemId === agentPromptId),
      );
    }),
  );

  it.effect("scopes actionable provider state to the requested bounded thread", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:bounded-provider-scope");
      const targetThreadId = ThreadId.make("thread:bounded-provider-scope:target");
      const unrelatedThreadId = ThreadId.make("thread:bounded-provider-scope:unrelated");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: String(threadId),
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      for (const threadId of [targetThreadId, unrelatedThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:thread:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
        const sessionId = ProviderSessionId.make(`provider-session:${threadId}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:session:${threadId}`),
          type: "provider-session.attached",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver,
            providerInstanceId,
            status: "running",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:provider-thread:${threadId}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId,
            providerSessionId: sessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 10,
      });

      assert.deepEqual(
        snapshot.projection.providerSessions.map((session) => session.id),
        [ProviderSessionId.make(`provider-session:${targetThreadId}`)],
      );
      assert.deepEqual(
        snapshot.projection.providerThreads.map((thread) => thread.id),
        [ProviderThreadId.make(`provider-thread:${targetThreadId}`)],
      );
    }),
  );

  it.effect("projects root provider owners into the shell in first-use order", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:provider-history");
      const threadId = ThreadId.make("thread:provider-history");
      const claudeInstanceId = ProviderInstanceId.make("claude");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      yield* projectionStore.apply({
        id: EventId.make("event:provider-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Provider history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const providerThreads = [
        // The root Codex conversation, then a Claude subagent it delegated to
        // (owned by a node, so not a handoff), then the handoff target.
        { suffix: "codex", instanceId: providerInstanceId, ownerNodeId: null, seconds: 0 },
        {
          suffix: "claude-subagent",
          instanceId: claudeInstanceId,
          ownerNodeId: NodeId.make("node:provider-history"),
          seconds: 1,
        },
        { suffix: "claude", instanceId: claudeInstanceId, ownerNodeId: null, seconds: 2 },
        // A second Codex conversation after handing back: no duplicate entry.
        { suffix: "codex-again", instanceId: providerInstanceId, ownerNodeId: null, seconds: 3 },
        // A model picked and abandoned in the menu: an empty session, never shown.
        {
          suffix: "picked-only",
          instanceId: ProviderInstanceId.make("picked-only"),
          ownerNodeId: null,
          seconds: 4,
        },
      ] as const;
      for (const providerThread of providerThreads) {
        const createdAt = DateTime.add(now, { seconds: providerThread.seconds });
        yield* projectionStore.apply({
          id: EventId.make(`event:provider-history:${providerThread.suffix}`),
          type: "provider-thread.updated",
          threadId,
          driver: providerThread.instanceId === claudeInstanceId ? claudeDriver : driver,
          occurredAt: createdAt,
          payload: {
            id: ProviderThreadId.make(`provider-thread:provider-history:${providerThread.suffix}`),
            driver: providerThread.instanceId === claudeInstanceId ? claudeDriver : driver,
            providerInstanceId: providerThread.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: providerThread.ownerNodeId,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal:
              providerThread.suffix === "picked-only" ? null : providerThread.seconds + 1,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
      }

      const shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.deepEqual(shell?.providerInstanceHistory, [providerInstanceId, claudeInstanceId]);
    }),
  );

  it.effect("shows the latest step and what the final reply asks on both shells", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:session-box");
      const runId = RunId.make("run:session-box");
      const rootNodeId = NodeId.make("node:session-box");
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:session-box"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:session-box:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:session-box"),
          title: "Session box",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:session-box:run"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: run,
      });
      const item = {
        threadId,
        runId,
        nodeId: rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:session-box:command"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          ...item,
          id: TurnItemId.make("item:session-box:command"),
          ordinal: 21,
          status: "running",
          type: "command_execution",
          input: "pnpm vitest run",
        },
      });
      const shells = Effect.gen(function* () {
        const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
          (row) => row.id === threadId,
        )!;
        const memoryShell = ProjectionStore.threadShellFromProjection(
          yield* projectionStore.getThreadProjection(threadId),
        );
        return [sqlShell, memoryShell, (yield* projectionStore.getThreadShell(threadId))!] as const;
      });
      for (const shell of yield* shells) {
        assert.equal(shell.currentStep?.itemType, "command_execution");
        assert.equal(shell.currentStep?.detail, "pnpm vitest run");
        assert.isNull(shell.replyAttention ?? null);
        assert.isNull(shell.replyPreview ?? null);
      }

      // Older rows may be updated later than the winning ordinal. Session boxes
      // still pick by run/ordinal, without materializing that older history.
      for (let n = 0; n < 20; n++) {
        yield* projectionStore.apply({
          id: EventId.make(`event:session-box:older:${n}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            ...item,
            id: TurnItemId.make(`item:session-box:older:${n}`),
            ordinal: n,
            status: "completed",
            type: "assistant_message",
            messageId: MessageId.make(`message:session-box:older:${n}`),
            text: "An earlier reply.",
            streaming: false,
            updatedAt: DateTime.add(now, { seconds: 1 }),
          },
        });
      }
      for (const shell of yield* shells) {
        assert.equal(shell.currentStep?.itemType, "command_execution");
        assert.equal(shell.currentStep?.detail, "pnpm vitest run");
        // While the run works the row reads what the agent last said in it; nothing is
        // asked of the user until the run ends.
        assert.equal(shell.replyPreview, "An earlier reply.");
        assert.isNull(shell.replyAttention ?? null);
      }

      yield* projectionStore.apply({
        id: EventId.make("event:session-box:reply"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          ...item,
          id: TurnItemId.make("item:session-box:reply"),
          ordinal: 22,
          status: "completed",
          completedAt: now,
          type: "assistant_message",
          messageId: MessageId.make("message:session-box:reply"),
          text: "## Result\n\nThe **tests** pass. Want me to also update the docs?",
          streaming: false,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:session-box:run-completed"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      for (const shell of yield* shells) {
        assert.isNull(shell.currentStep ?? null);
        assert.equal(shell.replyAttention, "decision");
        // One plain line for chat list rows, the same from memory and from SQL.
        assert.equal(shell.replyPreview, "Result The tests pass. Want me to also update the docs?");
        assert.isNull(shell.latestRequest ?? null);
      }

      // A typed request that moved on from the title shows its opening; a card answer
      // from the server doesn't count as one.
      const message = {
        threadId,
        runId,
        nodeId: rootNodeId,
        role: "user" as const,
        attachments: [],
        streaming: false,
        createdAt: now,
        updatedAt: now,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:session-box:request"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          ...message,
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make("message:session-box:request"),
          text: "And why does search on the iPhone drop the grid?\nMore detail here.",
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:session-box:answer"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: DateTime.add(now, { seconds: 1 }),
        payload: {
          ...message,
          createdBy: "user",
          creationSource: "server",
          id: MessageId.make("message:session-box:answer"),
          text: "Which option?\nTitle, plus what it's on now",
          createdAt: DateTime.add(now, { seconds: 1 }),
          updatedAt: DateTime.add(now, { seconds: 1 }),
        },
      });
      for (const shell of yield* shells) {
        assert.equal(shell.latestRequest, "Why does search on the iPhone drop the grid?");
      }
      // SQL shells use descending message identity to break equal timestamps.
      yield* projectionStore.apply({
        id: EventId.make("event:session-box:request:z"),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...message,
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make("message:session-box:z"),
          text: "Please explain the latest search results.",
        },
      });
      const [sqlShell, , directShell] = yield* shells;
      for (const shell of [sqlShell, directShell])
        assert.equal(shell.latestRequest, "Explain the latest search results.");
    }),
  );

  it.effect("shows the native goal of the active provider thread on the shell", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-goal");
      yield* projectionStore.apply({
        id: EventId.make("event:provider-goal:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:provider-goal"),
          title: "Provider goal",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: ProviderThreadId.make("provider-thread:provider-goal:first"),
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const applyProviderThread = (
        suffix: string,
        goal: OrchestrationV2ProviderThread["goal"],
        seconds: number,
      ) =>
        projectionStore.apply({
          id: EventId.make(`event:provider-goal:${suffix}:${seconds}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: DateTime.add(now, { seconds }),
          payload: {
            id: ProviderThreadId.make(`provider-thread:provider-goal:${suffix}`),
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            goal,
            createdAt: now,
            updatedAt: DateTime.add(now, { seconds }),
          },
        });
      const shellGoal = Effect.map(
        projectionStore.getShellSnapshot(),
        (snapshot) => snapshot.threads.find((thread) => thread.id === threadId)?.goal,
      );
      const goal = { objective: "Ship it", status: "active" as const, tokensUsed: 10 };

      yield* applyProviderThread("first", goal, 0);
      assert.deepEqual(yield* shellGoal, goal);
      // A handoff moves the conversation; the previous provider's goal stays behind.
      yield* applyProviderThread("second", null, 1);
      yield* projectionStore.apply({
        id: EventId.make("event:provider-goal:switch"),
        type: "thread.provider-switched",
        threadId,
        occurredAt: DateTime.add(now, { seconds: 1 }),
        payload: {
          ...(yield* projectionStore.getThread(threadId)),
          activeProviderThreadId: ProviderThreadId.make("provider-thread:provider-goal:second"),
        },
      });
      assert.isNull(yield* shellGoal);
    }),
  );

  it.effect("seeks the application sequence index for shell and pull request watermarks", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      for (const snapshot of [
        store.getShellSnapshot().pipe(Effect.asVoid),
        store.getPullRequestSnapshot({}).pipe(Effect.asVoid),
      ]) {
        const { tracer, statements } = traceSqlStatements();
        yield* snapshot.pipe(Effect.withTracer(tracer));
        const watermark = statements.find((query) =>
          query.includes("MAX(sequence) AS snapshot_sequence"),
        );
        assert.include(watermark, "INDEXED BY idx_orchestration_events_application_sequence");
      }
    }),
  );

  it.effect("reads the shell snapshot first and decodes it in a separate step", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const createThread = (threadId: ThreadId) =>
        projectionStore.apply({
          id: EventId.make(`event:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:shell-read"),
            title: "Shell read",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      const readThreadId = ThreadId.make("thread:shell-read:before");
      const laterThreadId = ThreadId.make("thread:shell-read:after");
      const shellIds = (snapshot: OrchestrationV2ThreadShellSnapshot) =>
        snapshot.threads
          .map((thread) => thread.id)
          .filter((id) => id === readThreadId || id === laterThreadId);

      yield* createThread(readThreadId);
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.linkedPullRequest', json(${JSON.stringify({
          projectId: "project:shell-read",
          repository: "acme/project",
          number: 42,
          url: "https://github.com/acme/project/pull/42",
        })})) WHERE thread_id = ${readThreadId}`;
      const trace = traceSqlStatements();
      const discovery = yield* projectionStore
        .getPullRequestSnapshot({})
        .pipe(Effect.withTracer(trace.tracer));
      assert.deepEqual(
        discovery.threads
          .map((thread) => thread.id)
          .filter((id) => id === readThreadId || id === laterThreadId),
        [readThreadId],
      );
      assert.strictEqual(discovery.snapshotSequence, 0);
      assert.strictEqual(trace.queryTransactions.length, 2);
      assert.isNotNull(trace.queryTransactions[0]);
      assert.strictEqual(new Set(trace.queryTransactions).size, 1);
      assert.isFalse(
        trace.statements.some((query) =>
          /orchestration_v2_projection_(runs|messages|turn_items|provider_threads)/.test(query),
        ),
      );
      const fullShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === readThreadId,
      )!;
      const metadata = discovery.threads.find((thread) => thread.id === readThreadId)!;
      for (const key of Object.keys(metadata) as Array<keyof typeof metadata>) {
        assert.deepEqual(metadata[key], fullShell[key]);
      }
      const narrow = yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId });
      assert.deepEqual(
        narrow.threads,
        discovery.threads.filter((thread) => thread.id === readThreadId),
      );
      const settledPayload = (settledAt: string | null, archivedAt: string | null) => sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.settledAt', ${settledAt}, '$.archivedAt', ${archivedAt})
        WHERE thread_id = ${readThreadId}
      `;
      yield* settledPayload(DateTime.formatIso(now), null);
      assert.isFalse(
        (yield* projectionStore.getPullRequestSnapshot({ unsettledOnly: true })).threads.some(
          (thread) => thread.id === readThreadId,
        ),
      );
      assert.strictEqual(
        (yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId })).threads.length,
        1,
      );
      yield* settledPayload(null, DateTime.formatIso(now));
      assert.isFalse(
        (yield* projectionStore.getPullRequestSnapshot({})).threads.some(
          (thread) => thread.id === readThreadId,
        ),
      );
      assert.strictEqual(
        (yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId })).threads.length,
        1,
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-11-03T00:00:00.000Z' WHERE thread_id = ${readThreadId}`;
      assert.deepEqual(
        (yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId })).threads,
        [],
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${readThreadId}`;
      yield* settledPayload(null, null);
      const decode = yield* sql.withTransaction(projectionStore.readShellSnapshot());
      // Commits between the read and the decode, as another request can while
      // the HTTP and WebSocket loaders decode outside their transaction.
      yield* createThread(laterThreadId);

      assert.deepEqual(shellIds(yield* decode), [readThreadId]);
      assert.sameMembers(shellIds(yield* projectionStore.getShellSnapshot()), [
        readThreadId,
        laterThreadId,
      ]);

      // No decoding under the read transaction: a payload that cannot decode
      // fails the returned step, not the read.
      const [stored] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${laterThreadId}
      `;
      const setPayload = (payload: string) =>
        sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload}
          WHERE thread_id = ${laterThreadId}`;
      yield* setPayload("{}");
      const failure = yield* sql
        .withTransaction(projectionStore.readShellSnapshot())
        .pipe(
          Effect.flatMap(Effect.flip),
          Effect.ensuring(Effect.orDie(setPayload(stored!.payload_json))),
        );
      assert.strictEqual(failure._tag, "ProjectionStoreReadError");
    }),
  );

  it.effect("reads only the requested project's threads into a scoped shell snapshot", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const { projectId, activeThreadId, forkThreadId, otherThreadId } =
        yield* assertProjectScopedShells("sql-project-shell");

      // A thread in another project that cannot decode fails the unscoped
      // snapshot, so a scoped snapshot that succeeds never read it.
      const [stored] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${otherThreadId}
      `;
      const setPayload = (payload: string) =>
        sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload}
          WHERE thread_id = ${otherThreadId}`;
      yield* setPayload("{}");
      const [unscoped, scoped] = yield* Effect.all([
        projectionStore.getShellSnapshot().pipe(Effect.flip),
        projectionStore.getShellSnapshot({ projectId, location: "active" }),
      ]).pipe(Effect.ensuring(Effect.orDie(setPayload(stored!.payload_json))));
      assert.strictEqual(unscoped._tag, "ProjectionStoreReadError");
      assert.sameMembers(
        scoped.threads.map((thread) => thread.id),
        [activeThreadId, forkThreadId],
      );
    }),
  );

  it.effect("does not treat visited or marked-unread state as thread activity", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const visitedOccurredAt = DateTime.add(createdAt, { seconds: 1 });
      const markedUnreadOccurredAt = DateTime.add(createdAt, { seconds: 2 });
      const threadId = ThreadId.make("thread:projection-read-state");
      const projectId = ProjectId.make("project:projection-read-state");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Projection read state",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:visited"),
        type: "thread.visited",
        threadId,
        occurredAt: visitedOccurredAt,
        payload: { ...thread, lastVisitedAt: createdAt },
      });

      const visited = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(visited.thread.lastVisitedAt, createdAt);
      assert.deepEqual(visited.thread.updatedAt, createdAt);

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:marked-unread"),
        type: "thread.marked-unread",
        threadId,
        occurredAt: markedUnreadOccurredAt,
        payload: thread,
      });

      const markedUnread = yield* projectionStore.getThreadProjection(threadId);
      assert.isNull(markedUnread.thread.lastVisitedAt);
      assert.deepEqual(markedUnread.thread.updatedAt, createdAt);
    }),
  );

  it.effect("dates thread activity by a run event and leaves the rest of the thread alone", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const runOccurredAt = DateTime.add(createdAt, { seconds: 5 });
      const threadId = ThreadId.make("thread:projection-activity");
      const runId = RunId.make("run:projection-activity");
      const rootNodeId = NodeId.make("node:projection-activity");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:projection-activity"),
        title: "Projection activity",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: "feature/activity",
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: createdAt,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-activity:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      const created = (yield* projectionStore.getThreadProjection(threadId)).thread;

      const { statements, tracer } = traceSqlStatements();
      yield* projectionStore
        .apply({
          id: EventId.make("event:projection-activity:run-created"),
          type: "run.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: runOccurredAt,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:projection-activity"),
            rootNodeId,
            activeAttemptId: null,
            status: "running" as const,
            requestedAt: runOccurredAt,
            startedAt: runOccurredAt,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        })
        .pipe(Effect.withTracer(tracer));
      // The thread row is patched in place, never read back to be re-encoded.
      assert.isEmpty(
        statements.filter(
          (statement) =>
            /^\s*SELECT/i.test(statement) &&
            statement.includes("orchestration_v2_projection_threads"),
        ),
      );

      const active = (yield* projectionStore.getThreadProjection(threadId)).thread;
      assert.deepEqual(active, { ...created, updatedAt: runOccurredAt });
      const shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (candidate) => candidate.id === threadId,
      );
      assert.deepEqual(shell?.updatedAt, runOccurredAt);
    }),
  );

  it.effect("preserves delegated completion ownership across stale run and task updates", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { seconds: 1 });
      const threadId = ThreadId.make("thread:projection-delegated-completion");
      const projectId = ProjectId.make("project:projection-delegated-completion");
      const runId = RunId.make("run:projection-delegated-completion");
      const rootNodeId = NodeId.make("node:projection-delegated-completion-root");
      const taskId = NodeId.make("node:projection-delegated-completion-task");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Delegated completion projection",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-delegated-completion"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        delegatedCompletion: {
          disposition: "stopped" as const,
          nextGeneration: 2,
          delivery: null,
        },
      };
      const task = {
        id: taskId,
        threadId,
        runId,
        parentNodeId: rootNodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Inspect the stop barrier.",
        title: null,
        model: null,
        completionWake: "always" as const,
        completionDelivery: {
          state: "disposed" as const,
          observedByRunId: null,
        },
        status: "running" as const,
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: run,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: task,
      });

      const { delegatedCompletion: _delegatedCompletion, ...staleRun } = run;
      const { completionDelivery: _completionDelivery, ...staleTask } = task;
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: later,
        payload: { ...staleRun, status: "interrupted", completedAt: later },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: later,
        payload: {
          ...staleTask,
          status: "interrupted",
          completedAt: later,
          updatedAt: later,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(projection.runs[0]?.delegatedCompletion, run.delegatedCompletion);
      assert.deepEqual(projection.subagents[0]?.completionDelivery, task.completionDelivery);
    }),
  );

  it.effect("only exposes interruptible runs through the shell activeRunId", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-shell-interruptible");
      const projectId = ProjectId.make("project:projection-shell-interruptible");
      const runId = RunId.make("run:projection-shell-interruptible");
      const rootNodeId = NodeId.make("node:projection-shell-interruptible");
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-shell-interruptible"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Interruptible shell run",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:running"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: run,
      });

      let shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "running");
      assert.equal(shell?.activeRunId, runId);
      assert.equal(
        shell?.latestRunRequestedAt && DateTime.toEpochMillis(shell.latestRunRequestedAt),
        DateTime.toEpochMillis(now),
      );
      assert.equal(
        shell?.latestRunStartedAt && DateTime.toEpochMillis(shell.latestRunStartedAt),
        DateTime.toEpochMillis(now),
      );
      assert.isNull(shell?.latestRunCompletedAt);

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:waiting"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: { ...run, status: "waiting" },
      });

      shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "waiting");
      assert.isNull(shell?.activeRunId);
      const later = DateTime.add(now, { hours: 1 });
      for (const status of ["queued", "cancelled"] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:clock:newer:${status}`),
          type: "run.updated",
          threadId,
          occurredAt: later,
          payload: {
            ...run,
            id: RunId.make("run:clock:newer"),
            ordinal: 2,
            status,
            requestedAt: later,
            startedAt: null,
            completedAt: status === "cancelled" ? later : null,
          },
        });
        for (const activityStatus of ["preparing", "running", "waiting", "completed"] as const) {
          yield* projectionStore.apply({
            id: EventId.make(`event:clock:${status}:${activityStatus}`),
            type: "run.updated",
            threadId,
            occurredAt: later,
            payload: {
              ...run,
              status: activityStatus,
              startedAt: activityStatus === "preparing" ? null : now,
              completedAt: activityStatus === "completed" ? later : null,
            },
          });
          const projection = yield* projectionStore.getThreadProjection(threadId);
          const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
            (row) => row.id === threadId,
          )!;
          const memoryShell = ProjectionStore.threadShellFromProjection(projection);
          const expected = activityStatus === "completed" ? null : DateTime.toEpochMillis(now);
          const timestamp = (value: DateTime.Utc | null | undefined) =>
            value == null ? null : DateTime.toEpochMillis(value);
          assert.equal(timestamp(sqlShell.activityRunStartedAt), expected);
          assert.equal(timestamp(memoryShell.activityRunStartedAt), expected);
          assert.equal(sqlShell.latestRunId, "run:clock:newer");
        }
      }

      // A held queue waits for the user, so both shells present the run before
      // it rather than reporting queued work.
      yield* projectionStore.apply({
        id: EventId.make("event:clock:newer:held"),
        type: "run.updated",
        threadId,
        occurredAt: later,
        payload: {
          ...run,
          id: RunId.make("run:clock:newer"),
          ordinal: 2,
          status: "queued",
          queueHeld: true,
          requestedAt: later,
          startedAt: null,
          completedAt: null,
        },
      });
      const heldProjection = yield* projectionStore.getThreadProjection(threadId);
      const heldSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const heldShell of [
        heldSqlShell,
        ProjectionStore.threadShellFromProjection(heldProjection),
      ]) {
        assert.equal(heldShell.latestRunId, runId);
        assert.equal(heldShell.status, "completed");
      }

      // With only held runs, nothing has executed: both shells read idle.
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:held-first"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: later,
        payload: { ...run, status: "queued", queueHeld: true, startedAt: null, completedAt: null },
      });
      const onlyHeldProjection = yield* projectionStore.getThreadProjection(threadId);
      const onlyHeldSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const onlyHeldShell of [
        onlyHeldSqlShell,
        ProjectionStore.threadShellFromProjection(onlyHeldProjection),
      ]) {
        assert.isNull(onlyHeldShell.latestRunId);
        assert.equal(onlyHeldShell.status, "idle");
      }

      // A wake run counts from the start of the work it continues.
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:wake"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: later,
        payload: {
          ...run,
          status: "running",
          requestedAt: later,
          startedAt: later,
          workStartedAt: now,
        },
      });
      const wakeProjection = yield* projectionStore.getThreadProjection(threadId);
      const wakeSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const wakeShell of [
        wakeSqlShell,
        ProjectionStore.threadShellFromProjection(wakeProjection),
      ]) {
        assert.equal(
          wakeShell.activityRunStartedAt && DateTime.toEpochMillis(wakeShell.activityRunStartedAt),
          DateTime.toEpochMillis(now),
        );
      }
    }),
  );

  it.effect("selects only threads with runtime state that needs recovery", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const settledThreadId = ThreadId.make("thread:recovery-candidates:settled");
      const runningThreadId = ThreadId.make("thread:recovery-candidates:running");
      const memberThreadId = ThreadId.make("thread:recovery-candidates:member");
      const childThreadId = ThreadId.make("thread:recovery-candidates:child");
      const rolledBackThreadId = yield* addRolledBackRecoveryCandidate("recovery-candidates");
      const orphanedThreadId = yield* addOrphanedRecoveryCandidate("recovery-candidates");
      const projectId = ProjectId.make("project:recovery-candidates");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Recovery candidate",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });

      for (const threadId of [settledThreadId, runningThreadId, memberThreadId, childThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
      }

      const runId = RunId.make("run:recovery-candidates:running");
      const rootNodeId = NodeId.make("node:recovery-candidates:running");
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:run-created"),
        type: "run.created",
        threadId: runningThreadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: runningThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:recovery-candidates:running"),
          rootNodeId,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const memberId = NodeId.make("node:recovery-candidates:member");
      const childRootNodeId = NodeId.make("node:recovery-candidates:child-root");
      const nativeTaskRef = { driver, nativeId: "workflow:agent:1", strength: "strong" as const };
      const memberNode = {
        id: memberId,
        threadId: memberThreadId,
        runId: null,
        parentNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        rootNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        kind: "subagent" as const,
        status: "running" as const,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: memberId,
          threadId: memberThreadId,
          runId: null,
          parentNodeId: memberNode.parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef,
          prompt: "Do the work",
          title: "Member",
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      for (const [threadId, node] of [
        [memberThreadId, memberNode],
        [
          childThreadId,
          {
            ...memberNode,
            id: childRootNodeId,
            threadId: childThreadId,
            parentNodeId: null,
            rootNodeId: childRootNodeId,
            kind: "root_turn" as const,
          },
        ],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:node:${node.id}`),
          type: "node.updated",
          threadId,
          nodeId: node.id,
          driver,
          occurredAt: now,
          payload: node,
        });
      }

      const recoveryThreadIds = yield* projectionStore.getRecoveryThreadIds("runtime");
      assert.include(recoveryThreadIds, runningThreadId);
      assert.include(recoveryThreadIds, orphanedThreadId);
      assert.include(recoveryThreadIds, memberThreadId);
      assert.include(recoveryThreadIds, childThreadId);
      assert.notInclude(recoveryThreadIds, settledThreadId);
      assert.notInclude(recoveryThreadIds, rolledBackThreadId);
      const memberRecovery = yield* projectionStore.getRuntimeRecoveryProjection(memberThreadId);
      const childRecovery = yield* projectionStore.getRuntimeRecoveryProjection(childThreadId);
      assert.deepEqual(
        memberRecovery.subagents.map((subagent) => subagent.id),
        [memberId],
      );
      assert.deepEqual(
        memberRecovery.nodes.map((node) => node.id),
        [memberId],
      );
      assert.deepEqual(
        childRecovery.nodes.map((node) => node.id),
        [childRootNodeId],
      );
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member-cancelled"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...memberRecovery.subagents[0]!,
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        },
      });
      assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), childThreadId);
    }),
  );

  it.effect("projects only the latest failed root turn's limit into SQL and memory shells", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("limit-shell");
      const otherThreadId = yield* addRolledBackRecoveryCandidate("other-limit-shell");
      const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const limitItem = {
        id: TurnItemId.make("limit-shell:error"),
        threadId,
        runId: original.id,
        nodeId: original.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "failed" as const,
        title: "Usage limit reached",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error" as const,
        failure: {
          class: "usage_limit" as const,
          message: "Plan limit reached.",
          resetAt: "2099-01-01T00:00:00.000Z",
          code: "usageLimitExceeded",
          retryable: null,
        },
      };
      const applyRun = (status: typeof original.status, rootNodeId = original.rootNodeId) =>
        store.apply({
          id: EventId.make(`event:limit-shell:run:${status}:${rootNodeId}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, rootNodeId, status },
        });
      const assertSummary = Effect.fnUntraced(function* (
        lastError: string | null,
        lastErrorClass: string | null,
      ) {
        const projection = yield* store.getThreadProjection(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        const shells = yield* store.getShellSnapshot();
        const sqlShell = shells.threads.find((row) => row.id === threadId)!;
        for (const shell of [memoryShell, sqlShell]) {
          assert.equal(shell.lastError, lastError);
          assert.equal(shell.lastErrorClass, lastErrorClass);
          assert.equal(
            shell.usageLimitResetAt,
            lastErrorClass === "usage_limit" ? "2099-01-01T00:00:00.000Z" : null,
          );
        }
        assert.isNull(shells.threads.find((row) => row.id === otherThreadId)!.lastErrorClass);
        const candidates = yield* store.getLimitRecoveryCandidates({
          now,
          autoResume: true,
          snooze: false,
        });
        const candidate = candidates.find((row) => row.id === threadId);
        if (lastErrorClass === "usage_limit") {
          assert.deepEqual(candidate, {
            id: sqlShell.id,
            lineage: sqlShell.lineage,
            creationSource: sqlShell.creationSource,
            status: sqlShell.status,
            lastErrorClass: sqlShell.lastErrorClass,
            usageLimitResetAt: sqlShell.usageLimitResetAt,
            latestRunId: sqlShell.latestRunId,
            latestRunCompletedAt: sqlShell.latestRunCompletedAt,
            updatedAt: sqlShell.updatedAt,
            archivedAt: sqlShell.archivedAt,
            settledOverride: sqlShell.settledOverride,
            pendingRuntimeRequest: null,
            limitRecovery: sqlShell.limitRecovery,
            snoozedUntil: sqlShell.snoozedUntil,
          });
        } else assert.isUndefined(candidate);
        assert.isUndefined(candidates.find((row) => row.id === otherThreadId));
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: limitItem,
      });
      yield* applyRun("failed");
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedRunId = RunId.make("run:limit-shell:queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:queued"),
        type: "run.created",
        threadId,
        runId: queuedRunId,
        nodeId: NodeId.make("node:limit-shell:queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: queuedRunId,
          ordinal: original.ordinal + 1,
          rootNodeId: NodeId.make("node:limit-shell:queued"),
          userMessageId: MessageId.make("message:limit-shell:queued"),
          status: "queued",
          startedAt: null,
          completedAt: null,
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedProjection = yield* store.getThreadProjection(threadId);
      const queuedMemoryShell = ProjectionStore.threadShellFromProjection(queuedProjection);
      const queuedSqlShell = (yield* store.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      assert.equal(queuedMemoryShell.status, "failed");
      assert.equal(queuedMemoryShell.latestRunId, original.id);
      assert.equal(queuedSqlShell.status, "failed");
      assert.equal(queuedSqlShell.latestRunId, original.id);
      assert.equal(queuedProjection.runs.find((run) => run.id === queuedRunId)?.status, "queued");
      const cancelledRunId = RunId.make("run:limit-shell:cancelled-queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued"),
        type: "run.created",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: cancelledRunId,
          ordinal: original.ordinal + 2,
          rootNodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          userMessageId: MessageId.make("message:limit-shell:cancelled-queued"),
          status: "cancelled",
          startedAt: null,
          completedAt: now,
        },
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued-message"),
        type: "turn-item.updated",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: TurnItemId.make("limit-shell:cancelled-queued-message"),
          threadId,
          runId: cancelledRunId,
          nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: MessageId.make("message:limit-shell:cancelled-queued"),
          inputIntent: "turn_start",
          text: "cancelled before the provider started",
          attachments: [],
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      // A restart continuation ran ahead of the held queue and ended before the
      // resumed failed run: the failure is still the latest executed run.
      const aheadRunId = RunId.make("run:limit-shell:ran-ahead");
      yield* store.apply({
        id: EventId.make("event:limit-shell:ran-ahead"),
        type: "run.created",
        threadId,
        runId: aheadRunId,
        nodeId: NodeId.make("node:limit-shell:ran-ahead"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: aheadRunId,
          ordinal: original.ordinal + 3,
          rootNodeId: NodeId.make("node:limit-shell:ran-ahead"),
          userMessageId: MessageId.make("message:limit-shell:ran-ahead"),
          status: "completed",
          startedAt: DateTime.subtract(now, { minutes: 10 }),
          completedAt: DateTime.subtract(now, { minutes: 5 }),
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const sql = yield* SqlClient.SqlClient;
      // The rest of this case treats the failed run as the latest run.
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${aheadRunId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${queuedRunId}`;
      yield* assertSummary("Plan limit reached.", "usage_limit");
      // Promoting or cancelling a queued message leaves a cancelled run before the active turn fails.
      const failed = {
        ...limitItem,
        failure: {
          ...limitItem.failure,
          class: "provider_error" as const,
          message: "Provider disconnected.",
        },
      };
      yield* store.apply({
        id: EventId.make("event:shell:terminal-failure"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: failed,
      });
      yield* assertSummary("Provider disconnected.", "provider_error");
      for (const shell of [
        ProjectionStore.threadShellFromProjection(yield* store.getThreadProjection(threadId)),
        (yield* store.getShellSnapshot()).threads.find((row) => row.id === threadId)!,
      ]) {
        assert.equal(shell.status, "failed");
        assert.equal(shell.latestRunId, original.id);
      }
      yield* store.apply({
        id: EventId.make("event:limit-shell:restore-limit"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: limitItem,
      });
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${cancelledRunId}`;
      const [originalRow] = yield* sql<{
        payload_json: string;
        archived_at: string | null;
      }>`SELECT payload_json, archived_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      for (const [field, value] of [
        ["archivedAt", DateTime.formatIso(now)],
        ["settledOverride", "settled"],
      ]) {
        // Mirrors the projection upsert, which writes archivedAt to its column too.
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, ${`$.${field}`}, ${value}),
            archived_at = json_extract(json_set(payload_json, ${`$.${field}`}, ${value}), '$.archivedAt')
          WHERE thread_id = ${threadId}`;
        assert.isUndefined(
          (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
            (row) => row.id === threadId,
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = ${originalRow!.payload_json}, archived_at = ${originalRow!.archived_at}
          WHERE thread_id = ${threadId}`;
      }
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${DateTime.formatIso(now)} WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${threadId}`;
      const recoveryOptions = { now, autoResume: false, snooze: false };
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates(recoveryOptions)).find(
          (row) => row.id === threadId,
        ),
      );
      const reset = DateTime.makeUnsafe(limitItem.failure.resetAt);
      const recovery = {
        runId: original.id,
        resetAt: limitItem.failure.resetAt,
        autoResume: true,
        requestId: CommandId.make("recovery:choice"),
      };
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.limitRecovery', json(${encodeUnknownJsonString(recovery)}))
        WHERE thread_id = ${threadId}`;
      // Armed future retries need no state decoding until they become due.
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, autoResume: true })).find(
          (row) => row.id === threadId,
        ),
      );
      const due = (yield* store.getLimitRecoveryCandidates({
        ...recoveryOptions,
        now: reset,
      })).find((row) => row.id === threadId)!;
      assert.deepEqual(due.limitRecovery, recovery);
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
        VALUES ('limit-shell:pending-request', ${threadId}, ${original.rootNodeId}, 'approval', 'pending', ${DateTime.formatIso(now)}, '{}')`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = 'limit-shell:pending-request'`;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', ${DateTime.formatIso(DateTime.add(reset, { minutes: 1 }))})
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', NULL, '$.limitRecovery.autoResume', json('false'))
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({
          ...recoveryOptions,
          now: reset,
          autoResume: true,
        })).find((row) => row.id === threadId),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      const session = {
        id: ProviderSessionId.make("session:limit-shell:shared"),
        driver,
        providerInstanceId,
        status: "ready" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      for (const boundThreadId of [threadId, otherThreadId]) {
        yield* store.apply({
          id: EventId.make(`event:limit-shell:bind:${boundThreadId}`),
          type: "provider-session.attached",
          threadId: boundThreadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-failed"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: { ...session, status: "error", lastError: "Provider process exited." },
      });
      yield* assertSummary("Provider process exited.", null);
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-recovered"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: session,
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      // A failed child is visible in history but does not replace the root's reason.
      yield* store.apply({
        id: EventId.make("event:limit-shell:child-error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:child-error"),
          nodeId: NodeId.make("child-node"),
          ordinal: 3,
          failure: { ...limitItem.failure, class: "provider_error", message: "Child failed." },
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      // A later ordinary root error replaces the limit classification.
      yield* store.apply({
        id: EventId.make("event:limit-shell:replacement"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:replacement"),
          ordinal: 4,
          failure: { ...limitItem.failure, class: "provider_error", message: "Provider failed." },
        },
      });
      yield* assertSummary("Provider failed.", "provider_error");
      for (const status of [
        "running",
        "completed",
        "interrupted",
        "cancelled",
        "rolled_back",
      ] as const) {
        yield* applyRun(status);
        yield* assertSummary(null, null);
      }
      // A new attempt's root cannot inherit an earlier attempt's limit.
      yield* applyRun("failed", NodeId.make("new-attempt-root"));
      yield* assertSummary(null, null);
    }),
  );

  it.effect.each([
    ["memory", ProjectionStore.layerMemory],
    ["SQL", layerTest],
  ] as const)(
    "%s finds unsnoozed chats whose latest run stopped signed out until something picks them up",
    ([, layer]) =>
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const threadId = yield* addRolledBackRecoveryCandidate("signed-out");
        const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
        const now = yield* DateTime.now;
        const prefix = "Claude could not authenticate.";
        const options = { since: DateTime.subtract(now, { hours: 1 }), messagePrefix: prefix };
        yield* store.apply({
          id: EventId.make("event:signed-out:error"),
          type: "turn-item.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("signed-out:error"),
            threadId,
            runId: original.id,
            nodeId: original.rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 2,
            status: "failed" as const,
            title: "Provider error",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "error" as const,
            failure: {
              class: "provider_error" as const,
              message: `${prefix} Run claude auth login, then send your message again.`,
              code: "api_error_401",
              retryable: null,
            },
          },
        });
        yield* store.apply({
          id: EventId.make("event:signed-out:run:failed"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, status: "failed", completedAt: now },
        });
        const expected = [
          { threadId, runId: original.id, providerInstanceId, modelSelection, completedAt: now },
        ];
        assert.deepEqual(yield* store.getSignedOutStops(options), expected);
        // A literal prefix: LIKE wildcards in it match only themselves.
        assert.deepEqual(
          yield* store.getSignedOutStops({ ...options, messagePrefix: "Claude_could%" }),
          [],
        );
        // Text anywhere in the message, for errors a gateway words with a prefix of its own.
        assert.deepEqual(
          yield* store.getSignedOutStops({ since: options.since, messageContains: "auth login" }),
          expected,
        );
        assert.deepEqual(
          yield* store.getSignedOutStops({ since: options.since, messageContains: "auth_login" }),
          [],
        );
        // A stop older than the window is left alone.
        assert.deepEqual(
          yield* store.getSignedOutStops({ ...options, since: DateTime.add(now, { minutes: 1 }) }),
          [],
        );
        // A message the user already sent picks the chat up.
        const thread = yield* store.getThread(threadId);
        yield* store.apply({
          id: EventId.make("event:signed-out:snooze"),
          type: "thread.snoozed",
          threadId,
          occurredAt: now,
          payload: { ...thread, snoozedUntil: DateTime.add(now, { hours: 1 }) },
        });
        assert.deepEqual(yield* store.getSignedOutStops(options), []);
        yield* store.apply({
          id: EventId.make("event:signed-out:expired-snooze"),
          type: "thread.snoozed",
          threadId,
          occurredAt: now,
          payload: { ...thread, snoozedUntil: DateTime.subtract(now, { minutes: 1 }) },
        });
        assert.deepEqual(yield* store.getSignedOutStops(options), expected);
        // Recovery must carry the failed run's provider, even after a new selection.
        yield* store.apply({
          id: EventId.make("event:signed-out:new-selection"),
          type: "thread.provider-switched",
          threadId,
          occurredAt: now,
          payload: {
            ...thread,
            providerInstanceId: ProviderInstanceId.make("other"),
            modelSelection: { instanceId: ProviderInstanceId.make("other"), model: "other-model" },
          },
        });
        assert.deepEqual(yield* store.getSignedOutStops(options), expected);

        const queuedRunId = RunId.make("run:signed-out:queued");
        yield* store.apply({
          id: EventId.make("event:signed-out:queued"),
          type: "run.created",
          threadId,
          runId: queuedRunId,
          nodeId: NodeId.make("node:signed-out:queued"),
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: {
            ...original,
            id: queuedRunId,
            ordinal: original.ordinal + 1,
            rootNodeId: NodeId.make("node:signed-out:queued"),
            userMessageId: MessageId.make("message:signed-out:queued"),
            status: "queued",
            startedAt: null,
            completedAt: null,
          },
        });
        assert.deepEqual(yield* store.getSignedOutStops(options), []);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("projects one shared provider session into multiple thread bindings", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-shared-provider-session");
      const firstThreadId = ThreadId.make("thread:projection-shared-provider-session:first");
      const secondThreadId = ThreadId.make("thread:projection-shared-provider-session:second");
      const providerSessionId = ProviderSessionId.make(
        "provider-session:projection-shared-provider-session",
      );
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Shared provider session",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      const session = {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "error" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: "provider process exited",
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:first-thread"),
        type: "thread.created",
        threadId: firstThreadId,
        occurredAt: now,
        payload: makeThread(firstThreadId),
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:second-thread"),
        type: "thread.created",
        threadId: secondThreadId,
        occurredAt: now,
        payload: makeThread(secondThreadId),
      });
      for (const [threadId, suffix] of [
        [firstThreadId, "first"],
        [secondThreadId, "second"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shared-provider-session:${suffix}-binding`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }

      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions.map(
          (value) => value.id,
        ),
        [providerSessionId],
      );
      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(secondThreadId)).providerSessions.map(
          (value) => value.id,
        ),
        [providerSessionId],
      );
      assert.deepEqual(
        (yield* projectionStore.getShellSnapshot()).threads
          .filter((thread) => thread.id === firstThreadId || thread.id === secondThreadId)
          .map((thread) => ({
            id: thread.id,
            lastError: thread.lastError,
          })),
        [
          { id: firstThreadId, lastError: "provider process exited" },
          { id: secondThreadId, lastError: "provider process exited" },
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:first-detached"),
        type: "provider-session.detached",
        threadId: firstThreadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: { providerSessionId, detachedAt: now },
      });

      assert.lengthOf(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions,
        0,
      );
      assert.lengthOf(
        (yield* projectionStore.getThreadProjection(secondThreadId)).providerSessions,
        1,
      );
    }),
  );

  it.effect("looks up a thread's last provider error through its own session bindings", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { minutes: 1 });
      const projectId = ProjectId.make("project:projection-session-error-lookup");
      const attachErroredSession = Effect.fnUntraced(function* (
        name: string,
        lastError: string,
        updatedAt: DateTime.Utc,
      ) {
        const threadId = ThreadId.make(`thread:projection-session-error-lookup:${name}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-session-error-lookup:${name}:thread`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: name,
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-session-error-lookup:${name}:session`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: updatedAt,
          payload: {
            id: ProviderSessionId.make(`provider-session:projection-session-error-lookup:${name}`),
            driver,
            providerInstanceId,
            status: "error",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: updatedAt,
            updatedAt,
            lastError,
          },
        });
        return threadId;
      });

      const failure = {
        class: "usage_limit" as const,
        message: "Plan limit reached.",
        resetAt: "2099-01-01T00:00:00.000Z",
        code: "usageLimitExceeded",
        retryable: null,
      };
      const threadId = yield* attachErroredSession("own", failure.message, now);
      // The own session repeats the root turn's limit, so the thread stays a
      // recovery candidate only while the lookup reads that session.
      const runId = RunId.make("run:projection-session-error-lookup:own");
      const rootNodeId = NodeId.make("node:projection-session-error-lookup:own");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-session-error-lookup:own:run"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-session-error-lookup:own"),
          rootNodeId,
          activeAttemptId: null,
          status: "failed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-session-error-lookup:own:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("projection-session-error-lookup:own:error"),
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "failed",
          title: "Usage limit reached",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure,
        },
      });
      // Every thread on the provider instance has its own session, and these
      // are newer. They must neither leak into the thread nor be walked for it.
      for (let index = 0; index < 24; index++) {
        yield* attachErroredSession(`other-${index}`, "other session failed", later);
      }

      const { statements, tracer } = traceSqlStatements();
      const shell = yield* projectionStore.getShellSnapshot().pipe(Effect.withTracer(tracer));
      assert.equal(
        shell.threads.find((thread) => thread.id === threadId)?.lastError,
        failure.message,
      );
      const candidates = yield* projectionStore
        .getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })
        .pipe(Effect.withTracer(tracer));
      // Another thread's newer error would replace the limit and drop the candidate.
      const candidate = candidates.find((row) => row.id === threadId);
      assert.isDefined(candidate);
      assert.include(candidate, {
        status: "failed",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: failure.resetAt,
        latestRunId: runId,
      });

      // One provider instance usually holds most sessions. Driving the lookup
      // from sessions walks all of them for every thread in the snapshot.
      for (const marker of ["AS blocking_failure_payload_json", "AS failure_payload_json"]) {
        const statement = statements.find((query) => query.includes(marker));
        assert.isDefined(statement, marker);
        const plan = (yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
        )).map((row) => row.detail);
        const bindingLookup = plan.findIndex((detail) => detail.startsWith("SEARCH binding "));
        const sessionLookup = plan.findIndex((detail) => detail.startsWith("SEARCH session "));
        assert.isAtLeast(bindingLookup, 0, marker);
        assert.include(
          plan[bindingLookup],
          "orchestration_v2_projection_provider_session_bindings_thread_idx (thread_id=?)",
        );
        assert.isAbove(sessionLookup, bindingLookup, marker);
        assert.include(plan[sessionLookup], "(provider_session_id=?)");
        const errorLookups = plan.filter(
          (detail) =>
            /^SEARCH (?:item|error) /.test(detail) && !detail.includes("(turn_item_id=?)"),
        );
        assert.lengthOf(errorLookups, marker.includes("blocking") ? 2 : 1, marker);
        for (const errorLookup of errorLookups) {
          assert.include(errorLookup, "turn_items_failed_error_idx");
          assert.include(errorLookup, "(thread_id=? AND run_id=? AND node_id=?)");
        }
      }
    }),
  );

  it.effect(
    "reads checkpoint context without decoding transcript or checkpoint file payloads",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:checkpoint-context");
        const runId = RunId.make("run:checkpoint-context");
        const nodeId = NodeId.make("node:checkpoint-context");
        const scopeId = CheckpointScopeId.make("scope:checkpoint-context");
        const checkpointId = CheckpointId.make("checkpoint:checkpoint-context");
        const ref = CheckpointRef.make("refs/t3/checkpoint-context/1");
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-context:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:checkpoint-context"),
            title: "Checkpoint context",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: "/repo/worktree",
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-context:run"),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:checkpoint-context"),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-context:scope"),
          type: "checkpoint-scope.created",
          threadId,
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId,
            runId,
            nodeId,
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/repo/worktree",
            createdAt: now,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make("event:checkpoint-context:checkpoint"),
          type: "checkpoint.captured",
          threadId,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId,
            scopeId,
            runId,
            nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref,
            status: "ready",
            files: [],
            capturedAt: now,
          },
        });
        // Old transcript shapes must not make a metadata-only diff unreadable.
        yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          'turn-item:checkpoint-context:obsolete', ${threadId}, ${runId}, ${nodeId}, NULL, NULL,
          NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(now)},
          ${encodeUnknownJsonString({ obsolete: "transcript shape" })}
        )
      `;
        assert.strictEqual(
          (yield* Effect.exit(projectionStore.getThreadProjection(threadId)))._tag,
          "Failure",
        );
        yield* sql`
        UPDATE orchestration_v2_projection_checkpoints
        SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
        WHERE checkpoint_id = ${checkpointId}
      `;
        assert.deepEqual(yield* projectionStore.getCheckpointContext(threadId), {
          runs: [{ id: runId, ordinal: 1, status: "completed" }],
          checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd: "/repo/worktree" }],
          checkpoints: [{ scopeId, runId, appRunOrdinal: 1, status: "ready", ref }],
        });
        const missing = yield* projectionStore
          .getCheckpointContext(ThreadId.make("thread:checkpoint-context:missing"))
          .pipe(Effect.flip);
        assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
      }),
  );

  it.effect("selects the latest pending secret even after its asking run ends", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const suffix = "shell-pending-secret";
      const threadId = yield* addRolledBackRecoveryCandidate(suffix);
      const original = yield* projectionStore.getThread(threadId);
      const parentId = ThreadId.make("shell-pending-secret-parent");
      yield* projectionStore.apply({
        id: EventId.make("shell-pending-secret-child-lineage"),
        type: "thread.metadata-updated",
        threadId,
        occurredAt: original.updatedAt,
        payload: {
          ...original,
          createdBy: "agent",
          creationSource: "mcp",
          lineage: {
            parentThreadId: parentId,
            rootThreadId: parentId,
            relationshipToParent: "subagent",
          },
        },
      });
      const runId = RunId.make(`run:${suffix}:rolled-back`);
      const nodeId = NodeId.make(`node:${suffix}:rolled-back`);
      const now = yield* DateTime.now;
      const addSecret = (id: string, ordinal: number, status: "waiting" | "completed") =>
        projectionStore.apply({
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(id),
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status,
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "secret_request",
            label: "Test credential",
            reason: "Test pending input",
            secretStatus: status === "waiting" ? "pending" : "saved",
          },
        });
      yield* addSecret(`${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}a`, 2, "waiting");
      yield* addSecret(`${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}b`, 3, "waiting");
      yield* addSecret(`${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}c`, 4, "completed");

      for (const status of [
        "preparing",
        "starting",
        "running",
        "waiting",
        "completed",
        "rolled_back",
      ]) {
        yield* sql`
          UPDATE orchestration_v2_projection_runs
          SET status = ${status}, payload_json = json_set(payload_json, '$.status', ${status})
          WHERE run_id = ${runId}
        `;
        const shell = yield* projectionStore.getShellSnapshot({
          location: "active",
          omitIdleSubagents: "all",
        });
        const thread = shell.threads.find((candidate) => candidate.id === threadId);
        assert.isDefined(thread);
        assert.equal(
          thread?.pendingRuntimeRequest?.id ?? null,
          `${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}b`,
        );
      }
    }),
  );

  it.effect("builds shell snapshots without decoding full turn item payloads", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:projection-shell-stale-item");
      const projectId = ProjectId.make("project:projection-shell");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Projection shell",
          providerInstanceId,
          modelSelection: modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id,
          thread_id,
          run_id,
          node_id,
          provider_thread_id,
          provider_turn_id,
          parent_item_id,
          ordinal,
          type,
          status,
          updated_at,
          payload_json
        )
        VALUES (
          ${"turn-item:stale-user-message"},
          ${threadId},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${0},
          ${"user_message"},
          ${"completed"},
          ${nowIso},
          ${encodeUnknownJsonString({
            id: "turn-item:stale-user-message",
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:stale-user-message",
            text: "stale user message",
            attachments: [],
          })}
        )
      `;

      const shell = yield* projectionStore.getShellSnapshot();
      const fullProjectionExit = yield* Effect.exit(projectionStore.getThreadProjection(threadId));

      assert.deepEqual(
        shell.threads
          .filter((thread) => thread.id === threadId)
          .map((thread) => ({
            id: thread.id,
            itemCount: thread.itemCount,
            visibleItemCount: thread.visibleItemCount,
            status: thread.status,
          })),
        [
          {
            id: threadId,
            itemCount: 1,
            visibleItemCount: 1,
            status: "idle",
          },
        ],
      );
      assert.equal(fullProjectionExit._tag, "Failure");
    }),
  );

  it.effect("counts imported runless history inherited by fork shells", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-imported-fork-shell");
      const sourceThreadId = ThreadId.make("thread:projection-imported-fork-shell:source");
      const targetThreadId = ThreadId.make("thread:projection-imported-fork-shell:target");
      const sourceRunId = RunId.make("run:projection-imported-fork-shell:source");
      const rootNodeId = NodeId.make("node:projection-imported-fork-shell:source");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "system",
          creationSource: "server",
          id: sourceThreadId,
          projectId,
          title: "Imported fork source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          historyOrigin: "v1_import",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Imported fork target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRunId,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-run"),
        type: "run.created",
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRunId,
          threadId: sourceThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-imported-fork-shell:run"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const applyAssistantItem = (suffix: string, runId: RunId | null, ordinal: number) =>
        projectionStore.apply({
          id: EventId.make(`event:projection-imported-fork-shell:item:${suffix}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          ...(runId === null ? {} : { runId }),
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-imported-fork-shell:${suffix}`),
            threadId: sourceThreadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(`message:projection-imported-fork-shell:${suffix}`),
            text: suffix,
            streaming: false,
          },
        });

      yield* applyAssistantItem("imported-one", null, 1);
      yield* applyAssistantItem("imported-two", null, 2);
      yield* applyAssistantItem("native-run", sourceRunId, 3);

      const shell = yield* projectionStore.getShellSnapshot();
      const targetShell = shell.threads.find((thread) => thread.id === targetThreadId);
      const targetProjection = yield* projectionStore.getThreadProjection(targetThreadId);

      assert.isDefined(targetShell);
      assert.equal(targetShell.itemCount, 0);
      assert.equal(targetShell.visibleItemCount, 4);
      assert.equal(targetProjection.visibleTurnItems.length, 4);
      // Native threads count their own runless items, but forks inherit only
      // their run-bound prefix. They do not need a second runless count scan.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_remove(payload_json, '$.historyOrigin')
        WHERE thread_id = ${sourceThreadId}`;
      assert.equal((yield* projectionStore.getThreadShell(sourceThreadId))?.itemCount, 3);
      for (const nativeShell of [
        yield* projectionStore.getThreadShell(targetThreadId),
        (yield* projectionStore.getShellSnapshot()).threads.find(
          (thread) => thread.id === targetThreadId,
        ),
      ])
        assert.equal(nativeShell?.visibleItemCount, 2);
      assert.equal(
        (yield* projectionStore.getThreadProjection(targetThreadId)).visibleTurnItems.length,
        2,
      );
    }),
  );

  it.effect("removes rolled back runs from the active visible projection", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-rollback-prune");
      const projectId = ProjectId.make("project:projection-rollback-prune");
      const runId = RunId.make("run:projection-rollback-prune");
      const attemptId = RunAttemptId.make("attempt:projection-rollback-prune");
      const rootNodeId = NodeId.make("node:projection-rollback-prune:root");
      const assistantNodeId = NodeId.make("node:projection-rollback-prune:assistant");
      const providerThreadId = ProviderThreadId.make("provider-thread:projection-rollback-prune");
      const providerTurnId = ProviderTurnId.make("provider-turn:projection-rollback-prune");
      const userMessageId = MessageId.make("message:projection-rollback-prune:user");
      const assistantMessageId = MessageId.make("message:projection-rollback-prune:assistant");
      const userTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:user");
      const assistantTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:assistant");
      const backgroundTurnItemId = TurnItemId.make(
        "turn-item:projection-rollback-prune:background",
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Projection rollback prune",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-created"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:attempt-created"),
        type: "run-attempt.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantNodeId,
          threadId,
          runId,
          parentNodeId: rootNodeId,
          rootNodeId,
          kind: "assistant_message",
          status: "completed",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: rootNodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userMessageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: "rolled back user",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "provider",
          id: assistantMessageId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          role: "assistant",
          text: "rolled back assistant",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 100,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: userMessageId,
          inputIntent: "turn_start",
          text: "rolled back user",
          attachments: [],
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantTurnItemId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: assistantMessageId,
          text: "rolled back assistant",
          streaming: false,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:background-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: backgroundTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 300,
          status: "running",
          title: "rolled back background command",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: "sleep 60",
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-rolled-back"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-rolled-back"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "rolled_back",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["rolled_back"],
      );
      assert.deepEqual(
        projection.nodes.map((node) => [node.id, node.status]),
        [
          [assistantNodeId, "completed"],
          [rootNodeId, "rolled_back"],
        ],
      );
      assert.lengthOf(projection.providerTurns, 1);
      assert.lengthOf(projection.messages, 2);
      assert.lengthOf(projection.turnItems, 3);
      assert.lengthOf(projection.visibleTurnItems, 0);

      // A rolled-back run's background item is abandoned, not pending. The
      // shell must not report it as Waiting, or the sidebar shows Waiting for
      // work nothing will ever finish.
      const shell = yield* projectionStore.getShellSnapshot();
      const rolledBackShellThread = shell.threads.find((entry) => entry.id === threadId);
      assert.isDefined(rolledBackShellThread);
      assert.isNull(rolledBackShellThread.latestVisibleMessage);
      assert.deepEqual(rolledBackShellThread?.pendingBackgroundTasks ?? [], []);
    }),
  );

  it.effect("keeps fork visible items stable after a source run is rolled back", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-fork-source-rollback");
      const sourceThreadId = ThreadId.make("thread:projection-fork-source-rollback:source");
      const targetThreadId = ThreadId.make("thread:projection-fork-source-rollback:target");
      const sourceProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:source",
      );
      const targetProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:target",
      );
      const sourceRun1Id = RunId.make("run:projection-fork-source-rollback:source:1");
      const sourceRun2Id = RunId.make("run:projection-fork-source-rollback:source:2");
      const sourceRun3Id = RunId.make("run:projection-fork-source-rollback:source:3");
      const sourceRun1NodeId = NodeId.make("node:projection-fork-source-rollback:source:1");
      const sourceRun2NodeId = NodeId.make("node:projection-fork-source-rollback:source:2");
      const sourceRun3NodeId = NodeId.make("node:projection-fork-source-rollback:source:3");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: sourceThreadId,
          projectId,
          title: "Projection fork source rollback source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: sourceProviderThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Projection fork source rollback target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: targetProviderThreadId,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRun2Id,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      for (const [ordinal, runId, nodeId, promptText, responseText] of [
        [1, sourceRun1Id, sourceRun1NodeId, "source one", "one"],
        [2, sourceRun2Id, sourceRun2NodeId, "source two", "two"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:run-${ordinal}`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: sourceProviderThreadId,
            userMessageId: MessageId.make(
              `message:projection-fork-source-rollback:user:${ordinal}`,
            ),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:user-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:user:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: MessageId.make(`message:projection-fork-source-rollback:user:${ordinal}`),
            inputIntent: "turn_start",
            text: promptText,
            attachments: [],
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:assistant-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:assistant:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 + 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(
              `message:projection-fork-source-rollback:assistant:${ordinal}`,
            ),
            text: responseText,
            streaming: false,
          },
        });
      }

      const targetBeforeRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      assert.deepEqual(
        targetBeforeRollback.visibleTurnItems.map((row) => row.item.type),
        ["user_message", "assistant_message", "user_message", "assistant_message", "fork"],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-2-rolled-back"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun2Id,
        nodeId: sourceRun2NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun2Id,
          threadId: sourceThreadId,
          ordinal: 2,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:2"),
          rootNodeId: sourceRun2NodeId,
          activeAttemptId: null,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const sourceMessages = (yield* projectionStore.getThreadRecords(sourceThreadId, ["messages"]))
        .messages;
      assert.deepEqual(
        sourceMessages,
        (yield* projectionStore.getThreadProjection(sourceThreadId)).messages,
      );
      const targetAfterRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      // Both shell reads drop the rolled-back run from the source count, while
      // the fork keeps the prefix it inherited.
      const shellSnapshot = yield* projectionStore.getShellSnapshot();
      for (const shell of [
        yield* projectionStore.getThreadShell(sourceThreadId),
        shellSnapshot.threads.find((thread) => thread.id === sourceThreadId),
      ]) {
        assert.equal(shell?.itemCount, 2);
      }
      for (const shell of [
        yield* projectionStore.getThreadShell(targetThreadId),
        shellSnapshot.threads.find((thread) => thread.id === targetThreadId),
      ]) {
        assert.equal(shell?.visibleItemCount, targetAfterRollback.visibleTurnItems.length);
      }
      const forwardPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 2,
      });
      assert.deepEqual(forwardPage.items, targetAfterRollback.visibleTurnItems.slice(0, 2));
      assert.equal(forwardPage.totalItems, targetAfterRollback.visibleTurnItems.length);
      assert.isTrue(forwardPage.hasMore);
      const followingPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 10,
        afterPosition: 1,
      });
      assert.deepEqual(followingPage.items, targetAfterRollback.visibleTurnItems.slice(2));
      assert.isFalse(followingPage.hasMore);
      const tracedTimelinePage = (limit: number) =>
        Effect.gen(function* () {
          const { statements, tracer } = traceSqlStatements();
          const page = yield* projectionStore
            .getTimelinePage(targetThreadId, { view: "activity", limit })
            .pipe(Effect.withTracer(tracer));
          return { page, statements };
        });
      const singleItemPage = yield* tracedTimelinePage(1);
      const fullPage = yield* tracedTimelinePage(10);
      assert.deepEqual(fullPage.page.items, targetAfterRollback.visibleTurnItems);
      assert.lengthOf(fullPage.statements, singleItemPage.statements.length);

      assert.deepEqual(
        targetAfterRollback.visibleTurnItems.map((row) => [
          row.visibility,
          row.item.type,
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.title,
        ]),
        [
          ["inherited", "user_message", "source one"],
          ["inherited", "assistant_message", "one"],
          ["inherited", "user_message", "source two"],
          ["inherited", "assistant_message", "two"],
          ["synthetic", "fork", "Forked from conversation"],
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-3"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun3Id,
        nodeId: sourceRun3NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun3Id,
          threadId: sourceThreadId,
          ordinal: 4,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:3"),
          rootNodeId: sourceRun3NodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const nowIso = DateTime.formatIso(now);
      for (let index = 0; index < 300; index += 1) {
        const id = `turn-item:projection-fork-source-rollback:post-fork:${index}`;
        const ordinal = index < 10 ? 190 + index : 300 + index;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun3Id}, ${sourceRun3NodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'command_execution',
            'completed', ${nowIso}, ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun3Id,
              nodeId: sourceRun3NodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "post fork",
              input: "echo later",
              output: "later",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const { statements, tracer } = traceSqlStatements();
      const boundedFork = yield* projectionStore
        .getThreadSnapshotWindow(targetThreadId, { rowLimit: 2 })
        .pipe(Effect.withTracer(tracer));
      // Only the target's control state is hydrated. Fork ancestors contribute
      // timeline rows, runs and attempts, regardless of their own live work.
      assert.lengthOf(
        statements.filter((statement) => statement.includes("WITH RECURSIVE retained")),
        1,
      );
      assert.lengthOf(
        statements.filter((statement) => statement.includes("SELECT node.payload_json")),
        1,
      );
      assert.lengthOf(boundedFork.projection.turnItems, 0);
      assert.deepEqual(
        boundedFork.projection.visibleTurnItems.map((row) => [row.visibility, row.item.type]),
        [
          ["inherited", "user_message"],
          ["inherited", "assistant_message"],
          ["synthetic", "fork"],
        ],
      );
      const parentPage = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
        anchorItemId: TurnItemId.make("turn-item:projection-fork-source-rollback:assistant:1"),
      });
      assert.deepEqual(
        parentPage.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source one", "one", "fork"],
      );

      const emptyBoundaryRunId = RunId.make(
        "run:projection-fork-source-rollback:source:empty-boundary",
      );
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-boundary-run"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: emptyBoundaryRunId,
        nodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
        driver,
        occurredAt: now,
        payload: {
          id: emptyBoundaryRunId,
          threadId: sourceThreadId,
          ordinal: 3,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make(
            "message:projection-fork-source-rollback:user:empty-boundary",
          ),
          rootNodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
        WHERE thread_id = ${targetThreadId}
      `;
      const emptyBoundaryFork = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        emptyBoundaryFork.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source two", "two", "fork"],
      );
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${sourceRun2Id})
        WHERE thread_id = ${targetThreadId}
      `;

      const targetRunId = RunId.make("run:projection-fork-source-rollback:target:1");
      const targetNodeId = NodeId.make("node:projection-fork-source-rollback:target:1");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:target-run"),
        type: "run.updated",
        threadId: targetThreadId,
        runId: targetRunId,
        nodeId: targetNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: targetRunId,
          threadId: targetThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: targetProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:target:1"),
          rootNodeId: targetNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      for (let ordinal = 1; ordinal <= 102; ordinal += 1) {
        const id = `turn-item:projection-fork-source-rollback:target:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${targetThreadId}, ${targetRunId}, ${targetNodeId}, ${targetProviderThreadId},
            NULL, NULL, ${ordinal}, 'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: targetThreadId,
              runId: targetRunId,
              nodeId: targetNodeId,
              providerThreadId: targetProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `target ${ordinal}`,
              input: `echo target ${ordinal}`,
              output: "target",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      const nestedThreadId = ThreadId.make("thread:projection-fork-source-rollback:nested");
      for (const ordinal of [
        ...Array.from({ length: 99 }, (_, index) => index + 1),
        ...Array.from({ length: 99 }, (_, index) => index + 101),
      ]) {
        const runId = ordinal < 100 ? sourceRun1Id : sourceRun2Id;
        const id = `turn-item:projection-fork-source-rollback:lineage:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `lineage ${ordinal}`,
              input: "echo lineage",
              output: "lineage",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      const inheritedSupersededNodeId = NodeId.make(
        "node:projection-fork-source-rollback:inherited-superseded",
      );
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        ) VALUES (
          'attempt:projection-fork-source-rollback:inherited-superseded',
          ${sourceThreadId}, ${sourceRun2Id}, 2, ${inheritedSupersededNodeId}, 'codex',
          ${providerInstanceId}, ${sourceProviderThreadId}, NULL, 'superseded',
          ${encodeUnknownJsonString({
            id: "attempt:projection-fork-source-rollback:inherited-superseded",
            runId: sourceRun2Id,
            attemptOrdinal: 2,
            rootNodeId: inheritedSupersededNodeId,
            providerInstanceId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            reason: "retry",
            status: "superseded",
            startedAt: nowIso,
            completedAt: nowIso,
          })}
        )
      `;
      for (let ordinal = 201; ordinal <= 300; ordinal += 1) {
        const id = `turn-item:projection-fork-source-rollback:hidden-interrupt:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun2Id}, ${inheritedSupersededNodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'run_interrupt_result',
            'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun2Id,
              nodeId: inheritedSupersededNodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "Stopped",
              message: "Stopped",
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "run_interrupt_result",
            })}
          )
        `;
      }
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:nested-thread"),
        type: "thread.created",
        threadId: nestedThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: nestedThreadId,
          projectId,
          title: "Nested bounded fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: targetThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: targetThreadId, runId: targetRunId },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const boundedNested = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        boundedNested.projection.visibleTurnItems.map((row) => row.item.type),
        [
          "user_message",
          "assistant_message",
          "fork",
          "command_execution",
          "command_execution",
          "fork",
        ],
      );

      const nestedInitial = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: yield* projectionStore
          .getThreadSnapshotWindow(nestedThreadId, {
            rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
          })
          .pipe(Effect.map((snapshot) => snapshot.projection)),
        snapshotSequence: 1,
      });
      const expectedNestedIds = (yield* projectionStore.getThreadProjection(
        nestedThreadId,
      )).visibleTurnItems.map((row) => String(row.sourceItemId));
      const nestedIds = nestedInitial.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let nestedCursor = nestedInitial.historyCursor;
      let nestedPages = 1;
      while (nestedCursor !== null) {
        const decoded = decodeThreadHistoryCursor(nestedCursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
          anchorItemId: TurnItemId.make(decoded.si),
          anchorThreadId: ThreadId.make(decoded.st),
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: snapshot.projection.visibleTurnItems,
          cursor: nestedCursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        nestedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        nestedCursor = page.nextCursor;
        nestedPages += 1;
      }
      assert.isAtLeast(nestedPages, 3);
      assert.lengthOf(nestedIds, expectedNestedIds.length);
      assert.deepEqual(nestedIds, expectedNestedIds);

      const nestedTurnWindow = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 77,
        userTurnLimit: 10,
      });
      const nestedTurnPage = buildBoundedThreadProjection({
        projection: nestedTurnWindow.projection,
        snapshotSequence: 1,
      });
      const turnPagedIds = nestedTurnPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let turnCursor = nestedTurnPage.historyCursor;
      while (turnCursor !== null) {
        const anchor = decodeThreadHistoryCursor(turnCursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: 77,
          userTurnLimit: 20,
          anchorItemId: TurnItemId.make(anchor.si),
          anchorThreadId: ThreadId.make(anchor.st),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor: turnCursor,
          snapshotSequence: 1,
        });
        turnPagedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        turnCursor = page.nextCursor;
      }
      assert.deepEqual(turnPagedIds, expectedNestedIds);
      const fullNested = yield* projectionStore.getThreadProjection(nestedThreadId);
      const nestedForward = yield* projectionStore.getTimelinePage(nestedThreadId, {
        view: "activity",
        limit: expectedNestedIds.length + 1,
      });
      assert.deepEqual(nestedForward.items, fullNested.visibleTurnItems);
      const messagePage = yield* projectionStore.getTimelinePage(nestedThreadId, {
        view: "messages",
        limit: 2,
      });
      assert.deepEqual(
        messagePage.items,
        fullNested.visibleTurnItems
          .filter((row) =>
            ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type),
          )
          .slice(0, 2),
      );

      const emptyMiddleThreadId = ThreadId.make(
        "thread:projection-fork-source-rollback:empty-middle",
      );
      const emptyMiddleRunId = RunId.make("run:projection-fork-source-rollback:empty-middle");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-middle-thread"),
        type: "thread.created",
        threadId: emptyMiddleThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: emptyMiddleThreadId,
          projectId,
          title: "Empty middle fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: sourceThreadId, runId: sourceRun2Id },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-middle-run"),
        type: "run.updated",
        threadId: emptyMiddleThreadId,
        runId: emptyMiddleRunId,
        nodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
        driver,
        occurredAt: now,
        payload: {
          id: emptyMiddleRunId,
          threadId: emptyMiddleThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:empty-middle"),
          rootNodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const emptyLeafThreadId = ThreadId.make("thread:projection-fork-source-rollback:empty-leaf");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-leaf-thread"),
        type: "thread.created",
        threadId: emptyLeafThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: emptyLeafThreadId,
          projectId,
          title: "Leaf after empty fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: emptyMiddleThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: emptyMiddleThreadId,
            runId: emptyMiddleRunId,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const emptyMiddleSnapshot = yield* projectionStore.getThreadSnapshotWindow(
        emptyLeafThreadId,
        { rowLimit: 2 },
      );
      assert.deepEqual(
        emptyMiddleSnapshot.projection.visibleTurnItems.map((row) => [
          row.sourceThreadId,
          row.item.type,
        ]),
        [
          [sourceThreadId, "user_message"],
          [sourceThreadId, "assistant_message"],
          [sourceThreadId, "fork"],
          [emptyMiddleThreadId, "fork"],
        ],
      );

      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE run_id IN (${sourceRun1Id}, ${sourceRun2Id})
      `;
      const importedItemId = "turn-item:projection-fork-source-rollback:legacy-import";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${importedItemId}, ${sourceThreadId}, NULL, NULL, NULL, NULL, NULL, 50,
          'assistant_message', 'completed', ${nowIso}, ${encodeUnknownJsonString({
            id: importedItemId,
            threadId: sourceThreadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 50,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "assistant_message",
            messageId: MessageId.make("message:projection-fork-source-rollback:legacy-import"),
            text: "legacy import before empty fork",
            streaming: false,
            historyOrigin: "v1_import",
          })}
        )
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.historyOrigin', 'v1_import')
        WHERE thread_id = ${sourceThreadId}
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
        WHERE thread_id = ${targetThreadId}
      `;
      const importedEmptyBoundary = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        importedEmptyBoundary.projection.visibleTurnItems.map((row) => [
          row.visibility,
          row.sourceThreadId,
          row.item.type === "assistant_message" ? row.item.text : row.item.type,
        ]),
        [
          ["inherited", sourceThreadId, "legacy import before empty fork"],
          ["synthetic", sourceThreadId, "fork"],
          ["local", targetThreadId, "command_execution"],
          ["local", targetThreadId, "command_execution"],
        ],
      );
    }),
  );

  it.effect("a pull request watch keeps a finished thread working until it ends", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:watched-pull-request");
      const runId = RunId.make("run:watched-pull-request");
      const at = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:watched-pull-request"),
        title: "Babysit the PR",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:thread"),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: thread,
      });
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: at,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:watched-pull-request"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const link = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 7,
        url: "https://github.com/pingdotgg/t3code/pull/7",
        source: "agent" as const,
        linkedAt: DateTime.formatIso(at),
        snapshot: null,
        stack: null,
      };
      const syncPullRequests = (id: string, pullRequests: ReadonlyArray<ThreadPullRequestLink>) =>
        store.apply({
          id: EventId.make(`event:watched-pull-request:${id}`),
          type: "thread.pull-request-synced",
          threadId,
          occurredAt: at,
          payload: { ...thread, pullRequests },
        });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:watched-pull-request");
      const phase = Effect.gen(function* () {
        const shell = yield* store.getThreadShell(threadId);
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (candidate) => candidate.id === threadId,
        );
        assert.deepEqual(listed?.pendingBackgroundTasks, shell?.pendingBackgroundTasks);
        return shell && projectThreadAwarenessV2({ environmentId, project, thread: shell })?.phase;
      });

      yield* syncPullRequests("watched", [
        {
          ...link,
          watch: {
            startedAt: DateTime.formatIso(at),
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: DateTime.formatIso(at),
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        },
      ]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, [
        {
          taskId: "pull-request-watch:github.com/pingdotgg/t3code#7",
          description: "Watching pull request #7",
          kind: "monitor",
        },
      ]);
      assert.equal(yield* phase, "running");

      yield* syncPullRequests("unwatched", [link]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, []);
      assert.equal(yield* phase, "completed");
    }),
  );

  it.effect("dates a completion released by held background work at the release", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:held-completion");
      const runId = RunId.make("run:held-completion");
      const providerThreadId = ProviderThreadId.make("provider-thread:held-completion");
      const completedAt = DateTime.makeUnsafe("2026-09-28T12:00:00.000Z");
      const releasedAt = DateTime.makeUnsafe("2026-09-28T12:05:00.000Z");
      const providerThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [{ taskId: "watch", kind: "monitor" as const }],
        createdAt: completedAt,
        updatedAt: completedAt,
      };
      yield* store.apply({
        id: EventId.make("event:held-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: completedAt,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:held-completion"),
          title: "Watch the build",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: completedAt,
          updatedAt: completedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:held-completion:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: completedAt,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:held-completion"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: completedAt,
          startedAt: completedAt,
          completedAt,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-running"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: completedAt,
        payload: providerThread,
      });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:held-completion");
      const held = yield* store.getThreadShell(threadId);
      assert.equal(
        held && projectThreadAwarenessV2({ environmentId, project, thread: held })?.phase,
        "running",
      );

      // The monitor ends five minutes after the run: the push must not look stale.
      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-ended"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: releasedAt,
        payload: { ...providerThread, pendingBackgroundTasks: [], updatedAt: releasedAt },
      });
      const released = yield* store.getThreadShell(threadId);
      const state =
        released && projectThreadAwarenessV2({ environmentId, project, thread: released });
      assert.equal(state?.phase, "completed");
      assert.equal(state?.updatedAt, DateTime.formatIso(releasedAt));

      // A later provider must not hide this owner's roster from restart recovery.
      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-restarted"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: releasedAt,
        payload: { ...providerThread, updatedAt: releasedAt },
      });
      const newerRunId = RunId.make("run:held-completion:new-provider");
      yield* store.apply({
        id: EventId.make("event:held-completion:new-provider"),
        type: "run.created",
        threadId,
        runId: newerRunId,
        occurredAt: releasedAt,
        payload: {
          ...(yield* store.getThreadProjection(threadId)).runs[0]!,
          id: newerRunId,
          ordinal: 2,
          providerThreadId: ProviderThreadId.make("provider-thread:held-completion:new-provider"),
          requestedAt: releasedAt,
          startedAt: releasedAt,
          completedAt: releasedAt,
        },
      });
      assert.deepEqual(
        (yield* store.getRuntimeRecoveryProjection(threadId)).runs.map((run) => run.id),
        [runId, newerRunId],
      );
    }),
  );
});

it.layer(layerTest)("media history metadata", (it) => {
  it.effect("pages dense media without returning tool image bytes or inline data", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* addRolledBackRecoveryCandidate("media-page");
      const nowIso = "2026-01-01T00:00:00.000Z";
      const insert = (
        ordinal: number,
        type: "dynamic_tool" | "assistant_message",
        extra: object,
      ) => {
        const id = `media-page-${ordinal}`;
        const payload = {
          id,
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed",
          title: null,
          startedAt: nowIso,
          completedAt: nowIso,
          updatedAt: nowIso,
          type,
          ...extra,
        };
        return sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id, parent_item_id, ordinal, type, status, updated_at, payload_json) VALUES (${id}, ${threadId}, NULL, NULL, NULL, NULL, NULL, ${ordinal}, ${type}, 'completed', ${nowIso}, ${encodeUnknownJsonString(payload)})`;
      };
      yield* insert(2, "dynamic_tool", {
        toolName: "arbitrary",
        input: {},
        output: {
          content: [
            { type: "image", mimeType: "image/png", data: "PRIVATE_IMAGE_BYTES" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "OTHER_PRIVATE_BYTES" },
            },
          ],
        },
      });
      yield* insert(3, "assistant_message", {
        messageId: "media-message",
        text: `${Array.from({ length: 70 }, (_, index) => `![${index}](https://example.test/${index}.png)`).join("\n")}\n![inline](data:image/png;base64,SU5MSU5FX1BSSVZBVEVfQllURVM=)\n![bad](data:image/png;base64,PRIVATE_BYTES)`,
        streaming: false,
      });
      yield* insert(4, "assistant_message", {
        messageId: "media-anchor",
        text: "end",
        streaming: false,
      });
      const cursor = encodeThreadHistoryCursor({
        snapshotSequence: 0,
        sourceThreadId: threadId,
        sourceItemId: "media-page-4",
        position: 3,
      });
      const first = yield* store.getThreadMediaPage(threadId, cursor);
      assert.lengthOf(first.items, 64);
      assert.isTrue(first.hasMoreHistory);
      assert.isTrue(first.partial);
      assert.isNotNull(first.nextCursor);
      assert.notInclude(JSON.stringify(first), "PRIVATE_BYTES");
      const second = yield* store.getThreadMediaPage(threadId, first.nextCursor!);
      const all = [...second.items, ...first.items];
      assert.lengthOf(all, 73);
      assert.deepEqual(
        all.slice(0, 2).map((item) => (item.target.type === "asset" ? item.target.resource : null)),
        [
          {
            _tag: "tool-output-image",
            threadId,
            itemId: TurnItemId.make("media-page-2"),
            index: 0,
          },
          {
            _tag: "tool-output-image",
            threadId,
            itemId: TurnItemId.make("media-page-2"),
            index: 1,
          },
        ],
      );
      assert.deepEqual(all.at(-1)?.target, {
        type: "asset",
        resource: {
          _tag: "message-inline-image",
          threadId,
          itemId: TurnItemId.make("media-page-3"),
          index: 70,
        },
      });
      assert.notInclude(JSON.stringify(all), "SU5MSU5FX1BSSVZBVEVfQllURVM");
      assert.notInclude(JSON.stringify(all), "PRIVATE");
    }),
  );
});
it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s native sessions reuse only their current root binding", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("native-binding");
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make("native-binding-provider");
    const original = yield* store.getThreadRecords(threadId, []);
    const thread = { ...original.thread, activeProviderThreadId: providerThreadId };
    const provider: OrchestrationV2ProviderThread = {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: "terminal-session", strength: "strong" },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      createdAt: now,
      updatedAt: now,
    };
    yield* store.apply({
      id: EventId.make("native-binding:metadata"),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: now,
      payload: thread,
    });
    yield* store.apply({
      id: EventId.make("native-binding:provider"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: provider,
    });
    const wanted = [{ providerInstanceId, nativeId: "terminal-session" }];
    assert.deepEqual(yield* store.findNativeSessionThreads(wanted), [
      { providerInstanceId, nativeId: "terminal-session", threadId },
    ]);
    assert.deepEqual(
      yield* store.findNativeSessionThreads([
        { providerInstanceId: "other-account", nativeId: "terminal-session" },
      ]),
      [],
    );
    yield* store.apply({
      id: EventId.make("native-binding:child"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: { ...provider, ownerNodeId: NodeId.make("subagent-owner") },
    });
    assert.deepEqual(yield* store.findNativeSessionThreads(wanted), []);
    yield* store.apply({
      id: EventId.make("native-binding:root"),
      type: "provider-thread.updated",
      threadId,
      occurredAt: now,
      payload: provider,
    });
    yield* store.apply({
      id: EventId.make("native-binding:switched"),
      type: "thread.metadata-updated",
      threadId,
      occurredAt: now,
      payload: { ...thread, activeProviderThreadId: null },
    });
    assert.deepEqual(yield* store.findNativeSessionThreads(wanted), []);
    yield* store.apply({
      id: EventId.make("native-binding:deleted"),
      type: "thread.deleted",
      threadId,
      occurredAt: now,
      payload: { ...thread, deletedAt: now },
    });
    assert.deepEqual(yield* store.findNativeSessionThreads(wanted), []);
  }).pipe(Effect.provide(layer)),
);

const assertHeldDelegationShell = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const parentId = yield* addRolledBackRecoveryCandidate("held-parent");
  const childId = yield* addRolledBackRecoveryCandidate("held-child");
  const parent = yield* store.getThreadProjection(parentId);
  const child = yield* store.getThreadProjection(childId);
  const now = yield* DateTime.now;
  const command = "command:mcp:owner:thread-send:followup";
  const taskId = NodeId.make(`node:delegated-task:${encodeURIComponent(command)}`);
  const parentRun = parent.runs[0]!;
  const queued = {
    ...child.runs[0]!,
    status: "queued" as const,
    queueHeld: true,
    startedAt: null,
    completedAt: null,
    userMessageId: MessageId.make("message:mcp:owner:thread-send:followup"),
  };
  yield* store.apply({
    id: EventId.make("held:parent-completed"),
    type: "run.updated",
    threadId: parentId,
    occurredAt: now,
    payload: { ...parentRun, status: "completed" },
  });
  yield* store.apply({
    id: EventId.make("held:child-queued"),
    type: "run.updated",
    threadId: childId,
    occurredAt: now,
    payload: queued,
  });
  yield* store.apply({
    id: EventId.make("held:delegation"),
    type: "turn-item.updated",
    threadId: parentId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`turn-item:delegated-task:${encodeURIComponent(command)}`),
      threadId: parentId,
      runId: parentRun.id,
      nodeId: parentRun.rootNodeId!,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 2,
      status: "running",
      title: "Discord levels",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "subagent",
      origin: "app_owned",
      driver,
      providerInstanceId,
      subagentId: taskId,
      childThreadId: childId,
      prompt: "followup",
      result: null,
    },
  });
  const read = Effect.gen(function* () {
    const direct = yield* store.getThreadShell(parentId);
    const snapshot = (yield* store.getShellSnapshot({
      projectId: parent.thread.projectId,
    })).threads.find((row) => row.id === parentId);
    const memory = ProjectionStore.threadShellFromProjection(
      yield* store.getThreadProjection(parentId),
      new Map([[childId, yield* store.getThreadProjection(childId)]]),
    );
    for (const shell of [direct, snapshot, memory]) {
      const task = shell?.pendingBackgroundTasks?.find((task) => task.kind === "subagent");
      assert.isDefined(task);
      if (task?.kind === "subagent")
        assert.deepEqual(task.held, {
          runId: queued.id,
          since: DateTime.formatIso(queued.requestedAt),
        });
    }
  });
  yield* read;
  yield* store.apply({
    id: EventId.make("held:resumed"),
    type: "run.updated",
    threadId: childId,
    occurredAt: now,
    payload: { ...queued, queueHeld: false },
  });
  const resumed = yield* store.getThreadShell(parentId);
  const task = resumed?.pendingBackgroundTasks?.find((task) => task.kind === "subagent");
  if (task?.kind === "subagent") assert.isUndefined(task.held);
});
it.effect("SQL shells name held sends even when the child is outside the shell scope", () =>
  assertHeldDelegationShell.pipe(Effect.provide(layerTest)),
);
it.effect("memory shells name the same held send and clear it on resume", () =>
  assertHeldDelegationShell.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s provider roster updates preserve the admitted provider thread", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("provider-roster-selection");
    const original = (yield* store.getThreadRecords(threadId, ["runs"])).runs[0]!;
    const now = yield* DateTime.now;
    const firstId = ProviderThreadId.make("provider-roster:first");
    const secondId = ProviderThreadId.make("provider-roster:second");
    const provider = (id: ProviderThreadId): OrchestrationV2ProviderThread => ({
      id,
      appThreadId: threadId,
      driver,
      providerInstanceId,
      providerSessionId: null,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 2,
      lastRunOrdinal: 2,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    });
    const updateProvider = (id: ProviderThreadId, suffix: string) =>
      store.apply({
        id: EventId.make(`provider-roster:${suffix}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: provider(id),
      });
    const firstRun = {
      ...original,
      id: RunId.make("provider-roster:run-first"),
      ordinal: 2,
      providerThreadId: firstId,
      status: "starting" as const,
      completedAt: null,
    };
    const secondRun = {
      ...firstRun,
      id: RunId.make("provider-roster:run-second"),
      ordinal: 3,
      providerThreadId: secondId,
    };
    const assertSelected = Effect.fnUntraced(function* (expected: ProviderThreadId | null) {
      assert.equal((yield* store.getThread(threadId)).activeProviderThreadId, expected);
    });
    yield* updateProvider(firstId, "first-record");
    // An empty pointer takes the first real provider thread (native subagent
    // threads have no app runs); after that only admission or a switch moves it.
    yield* assertSelected(firstId);
    yield* store.apply({
      id: EventId.make("provider-roster:admit-first"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: firstRun,
    });
    yield* assertSelected(firstId);
    yield* store.apply({
      id: EventId.make("provider-roster:finish-first"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...firstRun, status: "completed", completedAt: now },
    });
    yield* updateProvider(secondId, "second-record");
    yield* store.apply({
      id: EventId.make("provider-roster:queue-second"),
      type: "run.created",
      threadId,
      occurredAt: now,
      payload: { ...secondRun, status: "queued" },
    });
    yield* assertSelected(firstId);
    yield* store.apply({
      id: EventId.make("provider-roster:admit-second"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: secondRun,
    });
    yield* assertSelected(secondId);
    yield* updateProvider(firstId, "late-background-update");
    yield* assertSelected(secondId);
    assert.lengthOf(
      (yield* store.getThreadRecords(threadId, ["providerThreads"])).providerThreads,
      2,
    );
    yield* store.apply({
      id: EventId.make("provider-roster:late-run-update"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: { ...firstRun, status: "running" },
    });
    yield* assertSelected(secondId);
    yield* store.apply({
      id: EventId.make("provider-roster:explicit-transition"),
      type: "thread.provider-switched",
      threadId,
      occurredAt: now,
      payload: { ...(yield* store.getThread(threadId)), activeProviderThreadId: firstId },
    });
    yield* assertSelected(firstId);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)(
  "%s usage bindings preserve historical sessions and separate account ownership",
  ([, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("usage-binding");
      const now = yield* DateTime.now;
      const provider: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("usage-binding:old"),
        driver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: "old-session", strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: now,
        updatedAt: now,
      };
      for (const [index, entry] of [
        provider,
        {
          ...provider,
          id: ProviderThreadId.make("usage-binding:new"),
          nativeThreadRef: { driver, nativeId: "new-session", strength: "strong" as const },
        },
      ].entries()) {
        yield* store.apply({
          id: EventId.make(`usage-binding:${index}`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: entry,
        });
      }
      yield* store.apply({
        id: EventId.make("usage-binding:sidechain"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...provider,
          id: ProviderThreadId.make("usage-binding:sidechain"),
          ownerNodeId: NodeId.make("usage-binding:owner"),
          nativeThreadRef: { driver, nativeId: "sidechain-session", strength: "strong" },
        },
      });
      const result = yield* store.getUsageBindings(threadId, [providerInstanceId]);
      assert.equal(result.bindings.length, 2);
      const appRuns = yield* store.getUsageSubagentRuns([threadId]);
      assert.equal(appRuns.runs.length, 1);
      assert.equal(appRuns.runs[0]?.model, modelSelection.model);
      assert.deepEqual(
        new Set(result.bindings.map((binding) => binding.sessionId)),
        new Set(["old-session", "new-session"]),
      );
      assert.equal(result.truncated, false);
      assert.deepEqual(yield* store.getUsageCompactions(threadId), { items: [], truncated: false });
      yield* Effect.gen(function* () {
        const service = yield* ThreadUsageService.ThreadUsageService;
        const input = { threadId, timeZone: "UTC" };
        const [first, concurrent] = yield* Effect.all([service.read(input), service.read(input)], {
          concurrency: 2,
        });
        assert.strictEqual(first, concurrent);
        assert.equal(first.allTime.tokens.uncachedInputTokens, 100);
        assert.equal(first.today.tokens.uncachedInputTokens, 100);
        assert.equal(first.allTime.unpricedTokens, 100);
      }).pipe(
        Effect.provide(
          ThreadUsageService.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
                Layer.mock(UsageLimitSources.UsageLimitSources)({ current: Effect.succeed([]) }),
                Layer.mock(UsageService.UsageService)({
                  readThreadRecords: Effect.succeed({
                    sources: [
                      {
                        instanceId: providerInstanceId,
                        files: [
                          {
                            path: "/usage-session",
                            records: [
                              {
                                provider: "codex" as const,
                                sessionId: "old-session",
                                model: "unknown",
                                timestampMs: DateTime.toEpochMillis(now),
                                totals: { ...EMPTY_TOTALS, uncachedInputTokens: 100 },
                                reportedCostUsd: null,
                                speed: "standard" as const,
                                dedupeKey: "usage-request",
                              },
                            ],
                          },
                        ],
                      },
                    ],
                    rates: new Map(),
                    priceOverrides: new Map(),
                    modelAliases: new Map(),
                    partial: false,
                  }),
                }),
              ),
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps compact autonomous-work counts live during a foreground run and clears them on completion",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("long-running-counts");
      const projection = yield* store.getThreadProjection(threadId);
      const now = yield* DateTime.now;
      yield* store.apply({
        id: EventId.make("long-running:active"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...projection.runs[0]!, status: "running", completedAt: null },
      });
      const provider: OrchestrationV2ProviderThread = {
        id: ProviderThreadId.make("long-running:provider"),
        driver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [
          { taskId: "watch", kind: "monitor" },
          { taskId: "child", kind: "subagent" },
          { taskId: "command", kind: "command" },
        ],
        createdAt: now,
        updatedAt: now,
      };
      yield* store.apply({
        id: EventId.make("long-running:provider"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: provider,
      });
      const check = (count: number) =>
        Effect.gen(function* () {
          const direct = yield* store.getThreadShell(threadId);
          const listed = (yield* store.getShellSnapshot()).threads.find(
            (thread) => thread.id === threadId,
          );
          const memory = ProjectionStore.threadShellFromProjection(
            yield* store.getThreadProjection(threadId),
          );
          for (const shell of [direct, listed, memory]) {
            assert.deepEqual(shell?.longRunningWork, {
              monitorCount: count,
              backgroundTaskCount: count,
              runningSubagentCount: count,
            });
            assert.deepEqual(shell?.pendingBackgroundTasks, []);
          }
        });
      yield* check(1);
      // The app's own monitors are counted by the monitor service, on every path.
      publishAppMonitors([threadId, threadId]);
      for (const shell of [
        yield* store.getThreadShell(threadId),
        (yield* store.getShellSnapshot()).threads.find((thread) => thread.id === threadId),
        ProjectionStore.threadShellFromProjection(yield* store.getThreadProjection(threadId)),
      ]) {
        assert.equal(shell?.longRunningWork?.monitorCount, 3);
        assert.equal(shell?.longRunningWork?.runningSubagentCount, 1);
      }
      publishAppMonitors([]);
      yield* store.apply({
        id: EventId.make("long-running:finished"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: { ...provider, pendingBackgroundTasks: [] },
      });
      yield* check(0);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "lists app-owned children that still run, whatever run started them and whatever their card says",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("live-children");
      const base = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const cutRun = {
        ...base,
        id: RunId.make("run:live-children:cut"),
        ordinal: 2,
        userMessageId: MessageId.make("message:live-children:cut"),
        status: "running" as const,
        completedAt: null,
      };
      const nowRun = {
        ...cutRun,
        id: RunId.make("run:live-children:now"),
        ordinal: 3,
        userMessageId: MessageId.make("message:live-children:now"),
      };
      const applyRun = (name: string, run: OrchestrationV2Run) =>
        store.apply({
          id: EventId.make(`live-children:${name}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: run,
        });
      const child = (
        key: string,
        run: OrchestrationV2Run,
        ordinal: number,
        startedAt: DateTime.Utc,
      ) => {
        const childThreadId = ThreadId.make(`thread:live-children:${key}`);
        const subagentId = NodeId.make(`node:live-children:${key}`);
        const card = {
          id: TurnItemId.make(`turn-item:live-children:${key}`),
          threadId,
          runId: run.id,
          nodeId: run.rootNodeId!,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "running" as const,
          title: `Agent ${key}`,
          startedAt,
          completedAt: null,
          updatedAt: now,
          type: "subagent" as const,
          origin: "app_owned" as const,
          driver,
          providerInstanceId,
          subagentId,
          childThreadId,
          prompt: `Brief ${key}`,
          result: null,
        };
        const row = {
          id: subagentId,
          threadId,
          runId: run.id,
          parentNodeId: run.rootNodeId!,
          origin: "app_owned" as const,
          createdBy: "agent" as const,
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: `Brief ${key}`,
          title: `Agent ${key}`,
          model: null,
          status: "running" as const,
          result: null,
          startedAt,
          completedAt: null,
          updatedAt: now,
        };
        return {
          childThreadId,
          startedAt: DateTime.formatIso(startedAt),
          setCard: (name: string, status: "running" | "interrupted") =>
            store.apply({
              id: EventId.make(`live-children:${key}:card:${name}`),
              type: "turn-item.updated",
              threadId,
              occurredAt: now,
              payload: { ...card, status },
            }),
          setRow: (name: string, status: "running" | "completed") =>
            store.apply({
              id: EventId.make(`live-children:${key}:row:${name}`),
              type: "subagent.updated",
              threadId,
              occurredAt: now,
              payload: { ...row, status },
            }),
        };
      };
      const shells = Effect.gen(function* () {
        return [
          yield* store.getThreadShell(threadId),
          (yield* store.getShellSnapshot()).threads.find((thread) => thread.id === threadId),
          ProjectionStore.threadShellFromProjection(yield* store.getThreadProjection(threadId)),
        ];
      });

      // Child A was started by a run that was later cut: its card is interrupted,
      // its own chat still runs. Child B belongs to the working run.
      yield* applyRun("cut:running", cutRun);
      const a = child("a", cutRun, 2, DateTime.subtract(now, { minutes: 2 }));
      yield* a.setCard("start", "running");
      yield* a.setRow("start", "running");
      yield* applyRun("cut:cancelled", { ...cutRun, status: "cancelled" });
      yield* a.setCard("cut", "interrupted");
      yield* applyRun("now:running", nowRun);
      const b = child("b", nowRun, 3, DateTime.subtract(now, { minutes: 1 }));
      yield* b.setCard("start", "running");
      yield* b.setRow("start", "running");
      for (const shell of yield* shells) {
        assert.equal(shell?.longRunningWork?.runningSubagentCount, 2);
      }

      // After the turn both are still waited on, each once.
      yield* applyRun("now:completed", { ...nowRun, status: "completed", completedAt: now });
      const listed = (tasks: OrchestrationV2ThreadShell["pendingBackgroundTasks"]) =>
        (tasks ?? []).flatMap((task) =>
          task.kind === "subagent"
            ? [{ childThreadId: task.childThreadId, startedAt: task.startedAt }]
            : [],
        );
      for (const shell of yield* shells) {
        assert.sameDeepMembers(listed(shell?.pendingBackgroundTasks), [
          { childThreadId: a.childThreadId, startedAt: a.startedAt },
          { childThreadId: b.childThreadId, startedAt: b.startedAt },
        ]);
        assert.equal(shell?.longRunningWork?.runningSubagentCount, 2);
      }

      // Once child A's chat finishes it drops out.
      yield* a.setRow("done", "completed");
      for (const shell of yield* shells) {
        assert.deepEqual(listed(shell?.pendingBackgroundTasks), [
          { childThreadId: b.childThreadId, startedAt: b.startedAt },
        ]);
      }
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "getThreadRecords indexes message-ordinal reads and reuses already-loaded turn items",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const earlier = DateTime.subtract(now, { seconds: 10 });
      const threadId = ThreadId.make("thread:indexed-message-ordinals");
      const projectId = ProjectId.make("project:indexed-message-ordinals");
      const run1 = RunId.make("run:indexed-message-ordinals:1");
      const run2 = RunId.make("run:indexed-message-ordinals:2");
      const user1 = MessageId.make("message:indexed-message-ordinals:user-1");
      const user2 = MessageId.make("message:indexed-message-ordinals:user-2");
      const assistant1 = MessageId.make("message:indexed-message-ordinals:assistant-1");
      const assistant2 = MessageId.make("message:indexed-message-ordinals:assistant-2");

      yield* store.apply({
        id: EventId.make("event:indexed-message-ordinals:thread"),
        type: "thread.created",
        threadId,
        occurredAt: earlier,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Indexed message ordinals",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: earlier,
          updatedAt: earlier,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      const addMessage = (
        id: MessageId,
        runId: RunId,
        role: "user" | "assistant",
        createdAt: DateTime.Utc,
        ordinal: number,
      ) =>
        Effect.gen(function* () {
          yield* store.apply({
            id: EventId.make(`event:msg:${id}`),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: createdAt,
            payload: {
              id,
              threadId,
              runId,
              nodeId: null,
              createdBy: role === "user" ? "user" : "agent",
              creationSource: "web",
              role,
              text: id,
              attachments: [],
              streaming: false,
              createdAt,
              updatedAt: createdAt,
            },
          });
          yield* store.apply({
            id: EventId.make(`event:item:${id}`),
            type: "turn-item.updated",
            threadId,
            runId,
            occurredAt: createdAt,
            payload:
              role === "user"
                ? {
                    id: TurnItemId.make(`turn-item:${id}`),
                    threadId,
                    runId,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal,
                    status: "completed",
                    title: null,
                    startedAt: createdAt,
                    completedAt: createdAt,
                    updatedAt: createdAt,
                    type: "user_message",
                    messageId: id,
                    createdBy: "user",
                    creationSource: "web",
                    inputIntent: "turn_start",
                    text: id,
                    attachments: [],
                  }
                : {
                    id: TurnItemId.make(`turn-item:${id}`),
                    threadId,
                    runId,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal,
                    status: "completed",
                    title: null,
                    startedAt: createdAt,
                    completedAt: createdAt,
                    updatedAt: createdAt,
                    type: "assistant_message",
                    messageId: id,
                    text: id,
                    streaming: false,
                  },
          });
        });

      // Created-at order intentionally opposes turn-item ordinal order.
      yield* addMessage(user1, run1, "user", now, 1);
      yield* addMessage(user2, run2, "user", earlier, 5);
      yield* addMessage(assistant1, run1, "assistant", now, 2);
      yield* addMessage(assistant2, run1, "assistant", earlier, 3);

      // 1. User-only message reads must hit the partial user_message index.
      const userTrace = traceSqlStatements();
      const userOnly = yield* store
        .getThreadRecords(threadId, ["messages"], { messageRoles: ["user"] })
        .pipe(Effect.withTracer(userTrace.tracer));
      assert.deepEqual(
        userOnly.messages.map((message) => message.id),
        [user1, user2],
      );
      const userOrdinalQuery = userTrace.statements.find((query) =>
        query.includes("MIN(ordinal) AS ordinal"),
      );
      assert.ok(userOrdinalQuery);
      const userPlan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${userOrdinalQuery}`,
      );
      assert.match(
        userPlan.map((row) => row.detail).join("\n"),
        /USING INDEX orchestration_v2_projection_turn_items_user_message_idx \(thread_id=\?\)/,
      );

      // 2. Run-bounded message reads must seek by (thread_id, run_id).
      const runTrace = traceSqlStatements();
      const byRun = yield* store
        .getThreadRecords(threadId, ["messages"], { messageRunIds: [run1] })
        .pipe(Effect.withTracer(runTrace.tracer));
      assert.deepEqual(
        byRun.messages.map((message) => message.id),
        [user1, assistant1, assistant2],
      );
      const runOrdinalQuery = runTrace.statements.find((query) =>
        query.includes("MIN(ordinal) AS ordinal"),
      );
      assert.ok(runOrdinalQuery);
      const runPlan = yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${runOrdinalQuery}`,
      );
      assert.match(
        runPlan.map((row) => row.detail).join("\n"),
        /USING INDEX orchestration_v2_projection_turn_items_thread_run_idx \(thread_id=\? AND run_id=\?\)/,
      );

      // 3. When turnItems already loaded the messages' run and type, skip the SQL lookup.
      const coveredTrace = traceSqlStatements();
      const covered = yield* store
        .getThreadRecords(threadId, ["messages", "turnItems"], {
          messageRoles: ["assistant"],
          messageRunIds: [run1],
          turnItemRunId: run1,
          turnItemTypes: ["assistant_message", "error"],
        })
        .pipe(Effect.withTracer(coveredTrace.tracer));
      assert.deepEqual(
        covered.messages.map((message) => message.id),
        [assistant1, assistant2],
      );
      assert.isFalse(
        coveredTrace.statements.some((query) => query.includes("MIN(ordinal) AS ordinal")),
      );
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "getRuntimeRecoveryProjection indexes pending turn-item lookup for provider threads",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:recovery-provider-thread-index");
      const projectId = ProjectId.make("project:recovery-provider-thread-index");
      const idleBgProviderThreadId = ProviderThreadId.make("provider-thread:recovery-index:bg");
      const idleRunlessProviderThreadId = ProviderThreadId.make(
        "provider-thread:recovery-index:runless",
      );
      const idleSettledProviderThreadId = ProviderThreadId.make(
        "provider-thread:recovery-index:settled",
      );
      const runlessNodeId = NodeId.make("node:recovery-index:runless");

      yield* store.apply({
        id: EventId.make("event:recovery-index:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Recovery provider thread index",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      for (const [idx, ptId] of [
        idleBgProviderThreadId,
        idleRunlessProviderThreadId,
        idleSettledProviderThreadId,
      ].entries()) {
        yield* store.apply({
          id: EventId.make(`event:recovery-index:pt:${idx}`),
          type: "provider-thread.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: ptId,
            driver: ProviderDriverKind.make("claudeAgent"),
            providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: idx + 1,
            lastRunOrdinal: idx + 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      // 1. Idle provider thread kept in recovery only by a pending background command.
      yield* store.apply({
        id: EventId.make("event:recovery-index:bg-item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:recovery-index:bg"),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: idleBgProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "running",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: "sleep 60",
        },
      });

      // 2. Idle provider thread kept in recovery only by a pending item on a live runless root_turn.
      yield* store.apply({
        id: EventId.make("event:recovery-index:runless-node"),
        type: "node.updated",
        threadId,
        nodeId: runlessNodeId,
        occurredAt: now,
        payload: {
          id: runlessNodeId,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: runlessNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: false,
          providerThreadId: idleRunlessProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:recovery-index:runless-item"),
        type: "turn-item.updated",
        threadId,
        nodeId: runlessNodeId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("turn-item:recovery-index:runless"),
          threadId,
          runId: null,
          nodeId: runlessNodeId,
          providerThreadId: idleRunlessProviderThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "running",
          title: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "reasoning",
          text: "",
          streaming: true,
        },
      });

      const trace = traceSqlStatements();
      const recovery = yield* store
        .getRuntimeRecoveryProjection(threadId)
        .pipe(Effect.withTracer(trace.tracer));

      assert.deepEqual(
        recovery.providerThreads.map((pt) => pt.id),
        [idleBgProviderThreadId, idleRunlessProviderThreadId],
      );

      const providerThreadQuery = trace.statements.find((query) =>
        query.includes("SELECT provider_thread.payload_json"),
      );
      assert.isDefined(providerThreadQuery);
      const plan = (yield* sql.unsafe<{ detail: string }>(
        `EXPLAIN QUERY PLAN ${providerThreadQuery}`,
      ))
        .map((row) => row.detail)
        .join("\n");
      assert.notMatch(
        plan,
        /orchestration_v2_projection_turn_items_thread_(?:run|ordinal)_idx \(thread_id=\?\)/,
        plan,
      );
      assert.match(plan, /orchestration_v2_projection_turn_items_recovery_idx \(thread_id=\?\)/);
    }).pipe(Effect.provide(layerTest)),
);

it.effect(
  "getTimelinePage matches SQLite UTF-8 BINARY tie order when same-ordinal IDs cross U+E000 / U+10000",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:unicode-tie");
      const visibleRunId = RunId.make("run:unicode-tie:visible");
      const rolledBackRunId = RunId.make("run:unicode-tie:hidden");
      const visibleNodeId = NodeId.make("node:unicode-tie:visible");
      const hiddenNodeId = NodeId.make("node:unicode-tie:hidden");
      // In UTF-8 (SQLite BINARY), U+E000 (EE 80 80) < U+10000 (F0 90 80 80).
      // In JS UTF-16, U+10000 starts with surrogate 0xD800 < 0xE000, reversing the order.
      const visibleId = TurnItemId.make("turn-item:unicode-tie:\uE000");
      const hiddenId = TurnItemId.make("turn-item:unicode-tie:\u{10000}");
      const laterVisibleId = TurnItemId.make("turn-item:unicode-tie:later");

      yield* store.apply({
        id: EventId.make("event:unicode-tie:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          id: threadId,
          projectId: ProjectId.make("project:unicode-tie"),
          title: "Unicode tie",
          branch: null,
          worktreePath: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdBy: "user",
          creationSource: "web",
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:unicode-tie:run-visible"),
        type: "run.created",
        threadId,
        runId: visibleRunId,
        occurredAt: now,
        payload: {
          id: visibleRunId,
          threadId,
          ordinal: 1,
          userMessageId: MessageId.make("msg:unicode-tie:1"),
          rootNodeId: visibleNodeId,
          activeAttemptId: null,
          providerThreadId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          queuePosition: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:unicode-tie:run-hidden"),
        type: "run.created",
        threadId,
        runId: rolledBackRunId,
        occurredAt: now,
        payload: {
          id: rolledBackRunId,
          threadId,
          ordinal: 2,
          userMessageId: MessageId.make("msg:unicode-tie:2"),
          rootNodeId: hiddenNodeId,
          activeAttemptId: null,
          providerThreadId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          queuePosition: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const writeItem = (
        eventSuffix: string,
        id: TurnItemId,
        runId: RunId,
        nodeId: NodeId,
        ordinal: number,
        text: string,
      ) =>
        store.apply({
          id: EventId.make(`event:unicode-tie:${eventSuffix}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          occurredAt: now,
          payload: {
            id,
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "reasoning",
            text,
            streaming: false,
          },
        });
      yield* writeItem("item-visible", visibleId, visibleRunId, visibleNodeId, 1, "visible-e000");
      yield* writeItem("item-hidden", hiddenId, rolledBackRunId, hiddenNodeId, 1, "hidden-10000");
      yield* writeItem("item-later", laterVisibleId, visibleRunId, visibleNodeId, 2, "later");

      const byId = yield* store.getTimelinePage(threadId, {
        view: "activity",
        itemId: visibleId,
        limit: 1,
      });
      assert.equal(byId.totalItems, 2);
      assert.lengthOf(byId.items, 1);
      assert.equal(byId.items[0]?.sourceItemId, visibleId);
      assert.equal(byId.items[0]?.position, 0);

      const forward = yield* store.getTimelinePage(threadId, {
        view: "activity",
        afterPosition: 0,
        limit: 10,
      });
      assert.deepEqual(
        forward.items.map((entry) => [entry.position, entry.sourceItemId]),
        [[1, laterVisibleId]],
      );

      const backward = yield* store.getTimelinePage(threadId, {
        view: "activity",
        beforePosition: 1,
        limit: 10,
      });
      assert.deepEqual(
        backward.items.map((entry) => [entry.position, entry.sourceItemId]),
        [[0, visibleId]],
      );
    }).pipe(Effect.provide(layerTest)),
);
