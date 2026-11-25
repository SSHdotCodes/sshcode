import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  SECRET_REQUEST_TURN_ITEM_ID_PREFIX,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  hotReads,
  layerHotReads,
  observeReads,
  type HotReadSample,
} from "../persistence/testkit/HotReads.ts";
import { readSearchBackfillBatch } from "./ThreadSearch.ts";
import { encodeThreadHistoryCursor } from "./threadHistoryPaging.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.1-codex" };

const adapter = {
  instanceId: providerInstanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for query plan checks"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  layerHotReads.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "query-plan-guards" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

interface SeededFixture {
  readonly projectId: ProjectId;
  readonly busyThreadId: ThreadId;
  readonly settleThreadId: ThreadId;
  readonly archiveThreadId: ThreadId;
  readonly deleteThreadId: ThreadId;
  readonly preparedRunThreadId: ThreadId;
  readonly preparedRunId: RunId;
  readonly activeRunId: RunId;
  readonly sampleRunId: RunId;
  readonly pendingRequestId: RuntimeRequestId;
  readonly pendingRequestNodeId: NodeId;
  readonly secretItemId: TurnItemId;
  readonly targetItemId: TurnItemId;
  readonly totalSeededTurnItems: number;
  readonly now: DateTime.Utc;
}

interface QueryPlanGuard {
  readonly name: string;
  readonly capture: (
    ctx: SeededFixture & {
      readonly store: ProjectionStore.ProjectionStoreV2["Service"];
      readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
      readonly sql: SqlClient.SqlClient;
    },
  ) => Effect.Effect<
    unknown,
    SqlError.SqlError | ProjectionStore.ProjectionStoreV2Error | Orchestrator.OrchestratorV2Error
  >;
  /** Selects the captured SQL statement(s) to explain and validate. */
  readonly selectStatement: (query: string) => boolean;
  /** Patterns that must appear in the combined EXPLAIN QUERY PLAN output of matched statements. */
  readonly requiredPlans: ReadonlyArray<RegExp>;
  /** Additional plan patterns forbidden for this guard (on top of the global table-SCAN guard). */
  readonly forbiddenPlans?: ReadonlyArray<RegExp>;
}

/**
 * Global invariants: no hot read may ever fall back to a full-table SCAN (or
 * full non-partial index SCAN) of the three large per-thread history tables.
 */
const GLOBAL_FORBIDDEN_PLANS: ReadonlyArray<RegExp> = [
  /^SCAN (?:orchestration_v2_projection_turn_items|item)(?: USING (?:COVERING )?INDEX (?!orchestration_v2_projection_turn_items_(?:recovery|shell_pending)_idx\b)\S+)?$/m,
  /^SCAN (?:orchestration_v2_projection_nodes|node)(?: USING (?:COVERING )?INDEX (?!orchestration_v2_projection_nodes_live_idx\b)\S+)?$/m,
  /^SCAN (?:orchestration_v2_projection_messages|message)(?: USING (?:COVERING )?INDEX \S+)?$/m,
];

/**
 * Extensible table of hot-read query-plan guards.
 * Add one row here whenever a new hot SQL read or dispatch path is introduced.
 */
const HOT_READ_PLAN_GUARDS: ReadonlyArray<QueryPlanGuard> = [
  // --- Thread open / snapshot window ---
  {
    name: "thread open: getThreadSnapshotWindow turn-item window",
    capture: ({ store, busyThreadId }) =>
      store.getThreadSnapshotWindow(busyThreadId, {
        rowLimit: 80,
        userTurnLimit: 6,
        forWire: true,
      }),
    selectStatement: (q) => q.includes("WITH eligible AS NOT MATERIALIZED"),
    requiredPlans: [
      /SEARCH item USING INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx \(thread_id=\?/,
      /SEARCH orchestration_v2_projection_turn_items USING INDEX orchestration_v2_projection_turn_items_recovery_idx \(thread_id=\?\)/,
      /SEARCH item USING INDEX orchestration_v2_projection_turn_items_node_ordinal_idx \(node_id=\?\)/,
    ],
  },
  {
    name: "thread open: getThreadSnapshotWindow cohort nodes by PK",
    capture: ({ store, busyThreadId }) =>
      store.getThreadSnapshotWindow(busyThreadId, {
        rowLimit: 80,
        userTurnLimit: 6,
        forWire: true,
      }),
    selectStatement: (q) =>
      q.includes("FROM json_each(?) AS retained") &&
      q.includes("orchestration_v2_projection_nodes AS node"),
    requiredPlans: [
      /SEARCH node USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes_1 \(node_id=\?\)/,
    ],
  },
  {
    name: "thread open: getThreadSnapshotWindow retained node ancestry uses live_idx",
    capture: ({ store, busyThreadId }) =>
      store.getThreadSnapshotWindow(busyThreadId, {
        rowLimit: 80,
        userTurnLimit: 6,
        forWire: true,
      }),
    selectStatement: (q) => q.includes("WITH RECURSIVE retained(node_id) AS"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_nodes USING (?:COVERING )?INDEX orchestration_v2_projection_nodes_live_idx \(thread_id=\?\)/,
    ],
  },

  // --- Chat list / sidebar / shell reads ---
  {
    name: "chat list: getShellSnapshot active preselect",
    capture: ({ store }) =>
      store.getShellSnapshot({ location: "active", omitIdleSubagents: "all" }),
    selectStatement: (q) => q.includes("WITH RECURSIVE pending_secret AS MATERIALIZED"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_turn_items USING INDEX sqlite_autoindex_orchestration_v2_projection_turn_items_1 \(turn_item_id>\? AND turn_item_id<\?\)/,
      /SEARCH r USING INDEX orchestration_v2_projection_runs_thread_status_idx \(thread_id=\? AND status=\?\)/,
      /SEARCH i USING COVERING INDEX orchestration_v2_projection_turn_items_thread_run_idx \(thread_id=\?\)/,
      /SEARCH item USING INDEX orchestration_v2_projection_turn_items_failed_error_idx/,
    ],
  },
  {
    name: "chat visit log: getChatVisitSnapshot reads top-level shell rows on their indexes",
    capture: ({ store }) => store.getChatVisitSnapshot(),
    selectStatement: (q) =>
      q.includes("WITH RECURSIVE pending_secret AS MATERIALIZED") &&
      q.includes("AS latest_user_authored_message_at"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_turn_items USING INDEX sqlite_autoindex_orchestration_v2_projection_turn_items_1 \(turn_item_id>\? AND turn_item_id<\?\)/,
      /SEARCH r USING INDEX orchestration_v2_projection_runs_thread_status_idx \(thread_id=\? AND status=\?\)/,
      /SEARCH i USING COVERING INDEX orchestration_v2_projection_turn_items_thread_run_idx \(thread_id=\?\)/,
      /SEARCH item USING INDEX orchestration_v2_projection_turn_items_failed_error_idx/,
      /SEARCH message USING (?:COVERING )?INDEX orchestration_v2_projection_messages_latest_user_idx \(thread_id=\?\)/,
    ],
  },
  {
    name: "chat visit log: read marks touch only the threads table",
    capture: ({ store }) => store.getChatVisitSnapshot(),
    selectStatement: (q) => q.includes("AS last_visited_at"),
    requiredPlans: [/^SCAN t$/m],
    forbiddenPlans: [/SEARCH |CORRELATED|TEMP B-TREE|orchestration_v2_projection_(?!threads\b)/],
  },
  {
    name: "sidebar: getThreadShell single-thread read",
    capture: ({ store, busyThreadId }) => store.getThreadShell(busyThreadId),
    selectStatement: (q) => q.includes("WITH RECURSIVE pending_secret AS MATERIALIZED"),
    requiredPlans: [
      /SEARCH t USING INDEX sqlite_autoindex_orchestration_v2_projection_threads_1 \(thread_id=\?\)/,
      /SEARCH orchestration_v2_projection_turn_items USING INDEX sqlite_autoindex_orchestration_v2_projection_turn_items_1 \(turn_item_id>\? AND turn_item_id<\?\)/,
      /SEARCH r USING INDEX orchestration_v2_projection_runs_thread_status_idx \(thread_id=\? AND status=\?\)/,
    ],
  },
  {
    name: "settlement: getSettlementCandidates",
    capture: ({ store }) => store.getSettlementCandidates(),
    selectStatement: (q) => q.includes("AS latest_user_authored_message_at"),
    requiredPlans: [
      /SEARCH message USING (?:COVERING )?INDEX orchestration_v2_projection_messages_latest_user_idx \(thread_id=\?\)/,
    ],
  },

  // --- Timeline / MCP thread read ---
  {
    name: "timeline: getTimelinePage messages fromEnd avoids full payload_json scan",
    capture: ({ store, busyThreadId }) =>
      store.getTimelinePage(busyThreadId, { view: "messages", fromEnd: true, limit: 20 }),
    selectStatement: (q) => q.includes("orchestration_v2_projection_turn_items"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_turn_items USING COVERING INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx \(thread_id=\?\)/,
      /SEARCH item USING INDEX sqlite_autoindex_orchestration_v2_projection_turn_items_1 \(turn_item_id=\?\)/,
    ],
    forbiddenPlans: [/json_extract\(payload_json, '\$\.messageId'\)/],
  },
  {
    name: "timeline: getTimelinePage activity fromEnd uses covering index",
    capture: ({ store, busyThreadId }) =>
      store.getTimelinePage(busyThreadId, { view: "activity", fromEnd: true, limit: 20 }),
    selectStatement: (q) => q.includes("orchestration_v2_projection_turn_items"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_turn_items USING COVERING INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx \(thread_id=\?\)/,
      /SEARCH item USING INDEX sqlite_autoindex_orchestration_v2_projection_turn_items_1 \(turn_item_id=\?\)/,
    ],
  },
  {
    name: "timeline: getTimelinePage itemId uses PK seek",
    capture: ({ store, busyThreadId, targetItemId }) =>
      store.getTimelinePage(busyThreadId, { view: "activity", limit: 1, itemId: targetItemId }),
    selectStatement: (q) => q.includes("orchestration_v2_projection_turn_items"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_turn_items USING INDEX sqlite_autoindex_orchestration_v2_projection_turn_items_1 \(turn_item_id=\?\)/,
      /SEARCH orchestration_v2_projection_turn_items USING COVERING INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx \(thread_id=\?/,
    ],
  },

  // --- Main Orchestrator dispatch reads ---
  {
    name: "dispatch: message.dispatch uses indexed dispatch projection",
    capture: ({ orchestrator, busyThreadId }) =>
      orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("cmd:guard:dispatch-msg"),
        threadId: busyThreadId,
        messageId: MessageId.make("msg:guard:dispatch-msg"),
        text: "Next prompt",
        attachments: [],
        dispatchMode: { type: "defer_start" },
        createdBy: "user",
        creationSource: "web",
      }),
    selectStatement: (q) =>
      q.includes("orchestration_v2_projection_nodes") ||
      q.includes("orchestration_v2_projection_turn_items") ||
      q.includes("orchestration_v2_projection_messages"),
    requiredPlans: [
      /SEARCH node USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes_1 \(node_id=\?\)/,
    ],
    forbiddenPlans: [
      /SEARCH node USING INDEX orchestration_v2_projection_nodes_thread_run_idx \(thread_id=\?\)$/,
      /SEARCH orchestration_v2_projection_turn_items USING INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx \(thread_id=\?\)/,
    ],
  },
  {
    name: "dispatch: notification.delivery.accept bounds to messageId PK without nodes/turn_items",
    capture: ({ orchestrator, busyThreadId }) =>
      orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("cmd:guard:notif-accept"),
        threadId: busyThreadId,
        messageId: MessageId.make("msg:guard:missing"),
      }),
    selectStatement: (q) =>
      q.includes("orchestration_v2_projection_messages") ||
      q.includes("orchestration_v2_projection_nodes") ||
      q.includes("orchestration_v2_projection_turn_items"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_messages USING INDEX sqlite_autoindex_orchestration_v2_projection_messages_1 \(message_id=\?\)/,
    ],
    forbiddenPlans: [/orchestration_v2_projection_nodes/, /orchestration_v2_projection_turn_items/],
  },
  {
    name: "dispatch: prepared-run.progress bounds nodes and turn_items by run_id",
    capture: ({ orchestrator, preparedRunThreadId, preparedRunId }) =>
      orchestrator.dispatch({
        type: "prepared-run.progress",
        commandId: CommandId.make("cmd:guard:prep-progress"),
        threadId: preparedRunThreadId,
        runId: preparedRunId,
        phase: "worktree",
      }),
    selectStatement: (q) =>
      q.includes("orchestration_v2_projection_nodes") ||
      q.includes("orchestration_v2_projection_turn_items"),
    requiredPlans: [
      /SEARCH node USING INDEX orchestration_v2_projection_nodes_thread_run_idx \(thread_id=\? AND run_id=\?\)/,
      /SEARCH orchestration_v2_projection_turn_items USING INDEX orchestration_v2_projection_turn_items_thread_run_idx \(thread_id=\? AND run_id=\?\)/,
    ],
    forbiddenPlans: [
      /SEARCH node USING INDEX orchestration_v2_projection_nodes_thread_run_idx \(thread_id=\?\)$/,
    ],
  },
  {
    name: "dispatch: thread.settle bounds runtimeRequests and skips full message scan",
    capture: ({ orchestrator, settleThreadId }) =>
      orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("cmd:guard:settle"),
        threadId: settleThreadId,
      }),
    selectStatement: (q) =>
      q.includes("orchestration_v2_projection_runtime_requests") ||
      q.includes("orchestration_v2_projection_messages") ||
      q.includes("orchestration_v2_projection_nodes"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_runtime_requests USING INDEX orchestration_v2_projection_requests_recovery_idx \(thread_id=\?\)/,
    ],
    forbiddenPlans: [
      /SEARCH orchestration_v2_projection_messages USING INDEX orchestration_v2_projection_messages_thread_created_idx \(thread_id=\?\)/,
      /orchestration_v2_projection_nodes/,
    ],
  },
  {
    name: "dispatch: thread.archive uses nodes_live_idx without scanning settled nodes",
    capture: ({ orchestrator, archiveThreadId }) =>
      orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("cmd:guard:archive"),
        threadId: archiveThreadId,
      }),
    selectStatement: (q) =>
      q.includes("orchestration_v2_projection_nodes") ||
      q.includes("orchestration_v2_projection_messages") ||
      q.includes("orchestration_v2_projection_turn_items"),
    requiredPlans: [
      /SEARCH node USING INDEX orchestration_v2_projection_nodes_live_idx \(thread_id=\?\)/,
    ],
    forbiddenPlans: [
      /SEARCH node USING INDEX orchestration_v2_projection_nodes_thread_run_idx \(thread_id=\?\)$/,
      /orchestration_v2_projection_messages/,
    ],
  },
  {
    name: "dispatch: thread.delete uses nodes_live_idx and requests_recovery_idx",
    capture: ({ orchestrator, deleteThreadId }) =>
      orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("cmd:guard:delete"),
        threadId: deleteThreadId,
      }),
    selectStatement: (q) =>
      q.includes("orchestration_v2_projection_nodes") ||
      q.includes("orchestration_v2_projection_runtime_requests"),
    requiredPlans: [
      /SEARCH node USING INDEX orchestration_v2_projection_nodes_live_idx \(thread_id=\?\)/,
      /SEARCH orchestration_v2_projection_runtime_requests USING INDEX orchestration_v2_projection_requests_recovery_idx \(thread_id=\?\)/,
    ],
    forbiddenPlans: [
      /SEARCH node USING INDEX orchestration_v2_projection_nodes_thread_run_idx \(thread_id=\?\)$/,
    ],
  },
  {
    name: "dispatch: run.interrupt bounds background work, run nodes, and run messages",
    capture: ({ orchestrator, busyThreadId, activeRunId }) =>
      orchestrator
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("cmd:guard:interrupt"),
          threadId: busyThreadId,
          runId: activeRunId,
          reason: "stop",
        })
        .pipe(Effect.ignore),
    selectStatement: (q) =>
      q.includes("orchestration_v2_projection_nodes") ||
      q.includes("orchestration_v2_projection_turn_items") ||
      q.includes("orchestration_v2_projection_messages"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_turn_items USING INDEX orchestration_v2_projection_turn_items_recovery_idx \(thread_id=\?\)/,
      /SEARCH node USING INDEX orchestration_v2_projection_nodes_thread_run_idx \(thread_id=\? AND run_id=\?\)/,
      /SEARCH orchestration_v2_projection_messages USING INDEX orchestration_v2_projection_messages_run_idx \(run_id=\?\)/,
    ],
    forbiddenPlans: [
      /SEARCH node USING INDEX orchestration_v2_projection_nodes_thread_run_idx \(thread_id=\?\)$/,
      /SEARCH orchestration_v2_projection_messages USING INDEX orchestration_v2_projection_messages_thread_created_idx \(thread_id=\?\)/,
    ],
  },

  // --- Recovery reads ---
  {
    name: "recovery: getRecoveryThreadIds uses partial recovery indexes",
    capture: ({ store }) => store.getRecoveryThreadIds("runtime"),
    selectStatement: (q) => q.includes("WITH pending_provider_threads AS MATERIALIZED"),
    requiredPlans: [
      /orchestration_v2_projection_runs_(?:recovery|thread_status)_idx/,
      /orchestration_v2_projection_requests_recovery_idx/,
      /orchestration_v2_projection_turn_items_recovery_idx/,
      /orchestration_v2_projection_nodes_live_idx/,
    ],
  },
  {
    name: "recovery: getRuntimeRecoveryProjection uses live_idx and recovery_idx",
    capture: ({ store, busyThreadId }) => store.getRuntimeRecoveryProjection(busyThreadId),
    selectStatement: (q) =>
      q.includes("orchestration_v2_projection_nodes") ||
      q.includes("orchestration_v2_projection_turn_items") ||
      q.includes("orchestration_v2_projection_runtime_requests"),
    requiredPlans: [
      /SEARCH (?:orchestration_v2_projection_nodes|node) USING INDEX orchestration_v2_projection_nodes_live_idx \(thread_id=\?\)/,
      /SEARCH (?:orchestration_v2_projection_turn_items|item) USING INDEX orchestration_v2_projection_turn_items_recovery_idx \(thread_id=\?\)/,
      /SEARCH (?:orchestration_v2_projection_turn_items|item) USING INDEX orchestration_v2_projection_turn_items_node_ordinal_idx \(node_id=\?\)/,
    ],
  },
  {
    name: "recovery: getLimitRecoveryCandidates uses failed_error_idx",
    capture: ({ store, now }) =>
      store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: true }),
    selectStatement: (q) => q.includes("failure_payload_json"),
    requiredPlans: [
      /SEARCH error USING (?:COVERING )?INDEX orchestration_v2_projection_turn_items_failed_error_idx/,
      /SEARCH failed USING COVERING INDEX orchestration_v2_projection_runs_thread_status_idx/,
    ],
  },
  {
    name: "recovery: getSignedOutStops uses runs_thread_status_idx and failed_error_idx",
    capture: ({ store, now }) =>
      store.getSignedOutStops({
        since: DateTime.subtract(now, { hours: 1 }),
        messagePrefix: "err",
      }),
    selectStatement: (q) => q.includes("AS run_payload_json"),
    requiredPlans: [
      /SEARCH r USING (?:COVERING )?INDEX orchestration_v2_projection_runs_thread_status_idx \(thread_id=\? AND status=\?\)/,
      /SEARCH error USING (?:COVERING )?INDEX orchestration_v2_projection_turn_items_failed_error_idx/,
    ],
  },

  // --- Narrowed ProjectionStore control filters ---
  {
    name: "control filter: secret_request seeks primary-key prefix range",
    capture: ({ store, busyThreadId }) =>
      store.getThreadRecords(busyThreadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
      }),
    selectStatement: (q) => q.includes("FROM orchestration_v2_projection_turn_items"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_turn_items USING INDEX sqlite_autoindex_orchestration_v2_projection_turn_items_1 \(turn_item_id>\? AND turn_item_id<\?\)/,
    ],
  },
  {
    name: "control filter: turnItemNodeIds seeks node_ordinal_idx",
    capture: ({ store, busyThreadId, pendingRequestNodeId }) =>
      store.getThreadRecords(busyThreadId, ["turnItems"], {
        turnItemNodeIds: [pendingRequestNodeId],
        turnItemTypes: ["approval_request", "user_input_request"],
      }),
    selectStatement: (q) => q.includes("FROM orchestration_v2_projection_turn_items"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_turn_items USING INDEX orchestration_v2_projection_turn_items_node_ordinal_idx \(node_id=\?\)/,
    ],
  },
  {
    name: "control filter: messageRunIds seeks messages_run_idx",
    capture: ({ store, busyThreadId, sampleRunId }) =>
      store.getThreadRecords(busyThreadId, ["messages"], {
        messageRunIds: [sampleRunId],
        messageRoles: ["assistant"],
        unorderedMessages: true,
      }),
    selectStatement: (q) => q.includes("FROM orchestration_v2_projection_messages"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_messages USING INDEX orchestration_v2_projection_messages_run_idx \(run_id=\?\)/,
    ],
  },
  {
    name: "control filter: ordered messageIds user lookup seeks messages PK and turn_items_thread_run_idx",
    capture: ({ store, busyThreadId }) =>
      store.getThreadRecords(busyThreadId, ["messages"], {
        messageIds: [MessageId.make("msg:busy:1:user"), MessageId.make("msg:busy:2:user")],
        messageRoles: ["user"],
      }),
    selectStatement: (q) =>
      q.includes("FROM orchestration_v2_projection_messages") ||
      q.includes("orchestration_v2_projection_turn_items AS item"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_messages USING INDEX sqlite_autoindex_orchestration_v2_projection_messages_1 \(message_id=\?\)/,
      /SEARCH item USING INDEX orchestration_v2_projection_turn_items_thread_run_idx \(thread_id=\? AND run_id=\?\)/,
    ],
  },
  {
    name: "control filter: liveNodesOnly seeks nodes_live_idx",
    capture: ({ store, busyThreadId }) =>
      store.getThreadRecords(busyThreadId, ["nodes"], { liveNodesOnly: true }),
    selectStatement: (q) => q.includes("FROM orchestration_v2_projection_nodes"),
    requiredPlans: [
      /SEARCH node USING INDEX orchestration_v2_projection_nodes_live_idx \(thread_id=\?\)/,
    ],
  },
  {
    name: "control filter: pendingRuntimeRequestsOnly seeks requests_recovery_idx",
    capture: ({ store, busyThreadId }) =>
      store.getThreadRecords(busyThreadId, ["runtimeRequests"], {
        pendingRuntimeRequestsOnly: true,
      }),
    selectStatement: (q) => q.includes("FROM orchestration_v2_projection_runtime_requests"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_runtime_requests USING INDEX orchestration_v2_projection_requests_recovery_idx \(thread_id=\?\)/,
    ],
  },
  {
    name: "control filter: pendingRuntimeRequestControls resolves requests, nodes, and cards in one indexed snapshot",
    capture: ({ store, busyThreadId }) =>
      store.getThreadRecords(busyThreadId, ["runtimeRequests", "nodes", "turnItems"], {
        pendingRuntimeRequestControls: true,
        turnItemTypes: ["approval_request", "user_input_request"],
      }),
    selectStatement: (q) =>
      q.includes("FROM orchestration_v2_projection_runtime_requests") ||
      q.includes("FROM orchestration_v2_projection_nodes") ||
      q.includes("FROM orchestration_v2_projection_turn_items"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_runtime_requests USING INDEX orchestration_v2_projection_requests_recovery_idx \(thread_id=\?\)/,
      /SEARCH node USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes_1 \(node_id=\?\)/,
      /SEARCH orchestration_v2_projection_turn_items USING INDEX orchestration_v2_projection_turn_items_node_ordinal_idx \(node_id=\?\)/,
    ],
  },

  {
    name: "older history: seek covering item keys, then read metadata by rowid",
    capture: ({ store, busyThreadId, targetItemId }) =>
      store.getThreadHistoryPage(
        busyThreadId,
        encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: busyThreadId,
          sourceItemId: targetItemId,
          position: 1_000,
        }),
      ),
    // Pages seek from the cursor item through the ordinal index, then read rows by rowid.
    selectStatement: (q) => q.includes("WITH page AS MATERIALIZED"),
    requiredPlans: [
      /SEARCH orchestration_v2_projection_turn_items USING (COVERING )?INDEX orchestration_v2_projection_turn_items_thread_ordinal_idx \(thread_id=\?/,
      /SEARCH item USING INTEGER PRIMARY KEY \(rowid=\?\)/,
    ],
  },

  // --- Search backfill query ---
  {
    name: "search backfill: CROSS JOIN walks messages in rowid order without temp B-tree sort",
    capture: ({ sql }) => readSearchBackfillBatch(sql, 0),
    selectStatement: (q) => q.includes("FROM orchestration_v2_projection_messages m"),
    requiredPlans: [/SEARCH m USING INTEGER PRIMARY KEY \(rowid>\?\)/],
    forbiddenPlans: [/USE TEMP B-TREE FOR ORDER BY/],
  },
];

const captureSqlStatements = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const statements = new Map<string, ReadonlyArray<unknown>>();
    yield* observeReads(effect, (query, params) => statements.set(query, params));
    return statements;
  });

const largeTable =
  /^(?:orchestration_events|orchestration_v2_events|orchestration_v2_effect_outbox|orchestration_v2_turn_item_positions|orchestration_v2_projection_.+|projection_thread_.+|projection_threads|projection_turns|scheduled_tasks)$/;

// Each exception is a documented enumeration of a bounded slice or a list
// whose result inherently spans threads. Index scans are still scans.
const allowedScans = [
  {
    scenario: /^shell\.(?:active|archive|family|visits)$/,
    scan: "orchestration_v2_projection_threads",
    statement: /SELECT t\.thread_id FROM/,
    reason: "The list discovers chat IDs by archive, lineage and work flags.",
  },
  {
    scenario: /^shell\.visits$/,
    scan: "orchestration_v2_projection_threads",
    statement: /AS last_visited_at/,
    reason: "The visit log needs read marks for all active and unsettled chats.",
  },
  {
    scenario: /^pull-requests\.active$/,
    scan: "orchestration_v2_projection_threads",
    statement: /\$\.archivedAt/,
    reason: "PR synchronization enumerates all eligible chats, including chats without linked PRs.",
  },
  {
    scenario: /^settlement\.candidates$/,
    scan: "orchestration_v2_projection_threads",
    statement: /latest_user_authored_message_at/,
    reason: "A settlement sweep checks every eligible chat for inactivity.",
  },
  {
    scenario: /^recovery\.(?:limits|sign-in)$/,
    scan: "sqlite_autoindex_orchestration_v2_projection_threads_1",
    statement: /(?:AS failure_payload_json|r\.run_id, r\.completed_at)/,
    reason: "Recovery enumerates eligible chats and seeks only each latest run and root error.",
  },
  {
    scenario: /^recovery\.retry$/,
    scan: "orchestration_v2_projection_threads",
    statement: /SELECT r\.payload_json/,
    reason: "Retry eligibility depends on each chat's persisted settings.",
  },
  {
    scenario: /^recovery\.boot\.subagent-results$/,
    scan: "orchestration_v2_projection_threads",
    statement: /forkedFrom\.type/,
    reason: "Startup must find legacy subagent lineages without a surviving assignment row.",
  },
  {
    scenario: /^recovery\.boot\.delegated-completions$/,
    scan: "orchestration_v2_projection_runs_thread_ordinal_idx",
    statement: /delegatedCompletion\.delivery/,
    reason: "Open completion deliveries can be attached to runs of any status.",
  },
  {
    scenario: /^recovery\.boot\.(?:runtime|delegated-completions)$/,
    scan: "orchestration_v2_projection_subagents_thread_idx",
    statement: /(?:pending_provider_threads|delegatedCompletion\.delivery)/,
    reason: "Startup inspects persisted assignment state and completion policy across owners.",
  },
  {
    scenario: /^recovery\.boot\.runtime$/,
    scan: "orchestration_v2_projection_provider_threads",
    statement: /WITH pending_provider_threads/,
    reason: "Persisted pending provider work may belong to provider threads of any status.",
  },
  {
    scenario: /^recovery\.boot\.runtime$/,
    scan: "sqlite_autoindex_orchestration_v2_projection_provider_sessions_1",
    statement: /WITH pending_provider_threads/,
    reason: "Startup enumerates provider sessions whose status survived process exit.",
  },
  {
    scenario: /^recovery\.boot\.runtime$/,
    scan: "orchestration_v2_projection_requests_recovery_idx",
    statement: /WITH pending_provider_threads/,
    reason: "The partial index contains only pending runtime requests.",
  },
  {
    scenario: /^recovery\.boot\.(?:runtime|subagent-activity)$/,
    scan: "orchestration_v2_projection_turn_items_recovery_idx",
    statement: /status IN \('pending', 'running', 'waiting'\)/,
    reason: "The partial index contains only unfinished background-work items.",
  },
  {
    scenario: /^recovery\.runtime$/,
    scan: "orchestration_v2_projection_provider_threads_owner_idx",
    statement: /owner_node_id IS NOT NULL/,
    reason: "Sparse provider owners are checked by node ID without walking historical nodes.",
  },
];

const fullScans = (
  query: string,
  plans: ReadonlyArray<{ readonly detail: string }>,
  tablesByIndex: ReadonlyMap<string, string>,
) => {
  const tableByAlias = new Map<string, string>();
  // Planner output uses aliases when the query supplies one.
  for (const [, table, alias] of query.matchAll(
    /\b(?:FROM|JOIN)\s+([\w]+)(?:\s+(?:AS\s+)?([\w]+))?/gi,
  )) {
    if (table === undefined || !largeTable.test(table)) continue;
    tableByAlias.set(table, table);
    if (alias !== undefined) tableByAlias.set(alias, table);
  }
  return plans.flatMap(({ detail }) => {
    const scan = /^SCAN (\w+)(?: USING (?:COVERING )?INDEX (\w+))?/.exec(detail);
    if (!scan) return [];
    const [, alias, index] = scan;
    const table = (index && tablesByIndex.get(index)) ?? (alias && tableByAlias.get(alias));
    return table && largeTable.test(table) ? [index ?? table] : [];
  });
};

const explainRead = (sql: SqlClient.SqlClient, statement: string, params: ReadonlyArray<unknown>) =>
  sql.unsafe<{ readonly detail: string }>(`EXPLAIN QUERY PLAN ${statement}`, params);

const seedLargeFixture = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const now = yield* DateTime.now;
  const projectId = ProjectId.make("project:query-plan-guard");
  const busyThreadId = ThreadId.make("thread:query-plan-busy");
  const settleThreadId = ThreadId.make("thread:query-plan-settle");
  const archiveThreadId = ThreadId.make("thread:query-plan-archive");
  const deleteThreadId = ThreadId.make("thread:query-plan-delete");
  const preparedRunThreadId = ThreadId.make("thread:query-plan-prepared");
  const providerThreadId = ProviderThreadId.make("provider-thread:query-plan-busy");

  yield* sql`
    INSERT INTO projection_projects
      (project_id, title, workspace_root, default_model_selection_json, scripts_json, created_at, updated_at, deleted_at)
    VALUES
      (${projectId}, 'Query Plan Guard', '/repo', '{}', '[]', ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, NULL)
  `;

  const createThread = (threadId: ThreadId, title: string, activePt: ProviderThreadId | null) =>
    store.apply({
      id: EventId.make(`evt:thread:${threadId}`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId,
        title,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: activePt,
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

  // Seed inside a single transaction so thousands of real store.apply calls finish quickly.
  let ordinal = 1;
  let sampleRunId = RunId.make("run:busy:1");
  let targetItemId = TurnItemId.make("item:busy:target");
  const activeRunId = RunId.make("run:busy:active");
  const preparedRunId = RunId.make("run:prepared:1");
  const pendingRequestId = RuntimeRequestId.make("req:busy:pending");
  const pendingRequestNodeId = NodeId.make("node:busy:pending-req");
  const secretItemId = TurnItemId.make(`${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}guard-1`);

  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* createThread(busyThreadId, "Busy thread", providerThreadId);
      yield* createThread(settleThreadId, "Settle thread", null);
      yield* createThread(archiveThreadId, "Archive thread", null);
      yield* createThread(deleteThreadId, "Delete thread", null);
      yield* createThread(preparedRunThreadId, "Prepared run thread", null);

      yield* store.apply({
        id: EventId.make("evt:pt:busy"),
        type: "provider-thread.updated",
        threadId: busyThreadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: busyThreadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 100,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });

      // Seed 100 completed runs x 20 turn items & 20 nodes = 2,000 turn items, 2,000 nodes, 200 messages.
      const COMPLETED_RUNS = 100;
      const TOOLS_PER_RUN = 18;
      for (let r = 1; r <= COMPLETED_RUNS; r++) {
        const runId = RunId.make(`run:busy:${r}`);
        if (r === 50) sampleRunId = runId;
        const rootNodeId = NodeId.make(`node:busy:${r}:root`);
        const attemptId = RunAttemptId.make(`attempt:busy:${r}:1`);
        const userMessageId = MessageId.make(`msg:busy:${r}:user`);
        const asstMessageId = MessageId.make(`msg:busy:${r}:asst`);
        const asstNodeId = NodeId.make(`node:busy:${r}:asst`);
        const runTime = DateTime.add(now, { seconds: r });

        yield* store.apply({
          id: EventId.make(`evt:run:${r}`),
          type: "run.created",
          threadId: busyThreadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: runTime,
          payload: {
            id: runId,
            threadId: busyThreadId,
            ordinal: r,
            status: "completed",
            providerInstanceId,
            modelSelection,
            providerThreadId,
            userMessageId,
            rootNodeId,
            activeAttemptId: attemptId,
            requestedAt: runTime,
            startedAt: runTime,
            completedAt: runTime,
            queuePosition: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* store.apply({
          id: EventId.make(`evt:att:${r}`),
          type: "run-attempt.updated",
          threadId: busyThreadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: runTime,
          payload: {
            id: attemptId,
            runId,
            attemptOrdinal: 1,
            providerInstanceId,
            providerThreadId,
            providerTurnId: null,
            rootNodeId,
            reason: "initial",
            status: "completed",
            startedAt: runTime,
            completedAt: runTime,
          },
        });
        yield* store.apply({
          id: EventId.make(`evt:node:root:${r}`),
          type: "node.updated",
          threadId: busyThreadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: runTime,
          payload: {
            id: rootNodeId,
            threadId: busyThreadId,
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
            startedAt: runTime,
            completedAt: runTime,
          },
        });
        yield* store.apply({
          id: EventId.make(`evt:msg:user:${r}`),
          type: "message.updated",
          threadId: busyThreadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: runTime,
          payload: {
            id: userMessageId,
            threadId: busyThreadId,
            runId,
            nodeId: rootNodeId,
            role: "user",
            text: `Prompt ${r}`,
            attachments: [],
            streaming: false,
            createdBy: r % 2 === 0 ? "user" : "agent",
            creationSource: "web",
            createdAt: runTime,
            updatedAt: runTime,
          },
        });
        const userItemId = TurnItemId.make(`item:busy:${r}:user`);
        if (r === 50) targetItemId = userItemId;
        yield* store.apply({
          id: EventId.make(`evt:item:user:${r}`),
          type: "turn-item.updated",
          threadId: busyThreadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId,
          occurredAt: runTime,
          payload: {
            id: userItemId,
            threadId: busyThreadId,
            runId,
            nodeId: rootNodeId,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal++,
            type: "user_message",
            status: "completed",
            title: null,
            messageId: userMessageId,
            text: `Prompt ${r}`,
            attachments: [],
            inputIntent: "turn_start",
            createdBy: r % 2 === 0 ? "user" : "agent",
            creationSource: "web",
            startedAt: runTime,
            completedAt: runTime,
            updatedAt: runTime,
          },
        });

        for (let t = 1; t <= TOOLS_PER_RUN; t++) {
          const toolNodeId = NodeId.make(`node:busy:${r}:tool:${t}`);
          yield* store.apply({
            id: EventId.make(`evt:node:tool:${r}:${t}`),
            type: "node.updated",
            threadId: busyThreadId,
            runId,
            nodeId: toolNodeId,
            providerInstanceId,
            occurredAt: runTime,
            payload: {
              id: toolNodeId,
              threadId: busyThreadId,
              runId,
              parentNodeId: rootNodeId,
              rootNodeId,
              kind: "tool_call",
              status: "completed",
              countsForRun: true,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: runTime,
              completedAt: runTime,
            },
          });
          yield* store.apply({
            id: EventId.make(`evt:item:tool:${r}:${t}`),
            type: "turn-item.updated",
            threadId: busyThreadId,
            runId,
            nodeId: toolNodeId,
            providerInstanceId,
            occurredAt: runTime,
            payload: {
              id: TurnItemId.make(`item:busy:${r}:tool:${t}`),
              threadId: busyThreadId,
              runId,
              nodeId: toolNodeId,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: ordinal++,
              type: "command_execution",
              status: "completed",
              title: null,
              input: `echo ${r}-${t}`,
              output: "ok",
              exitCode: 0,
              startedAt: runTime,
              completedAt: runTime,
              updatedAt: runTime,
            },
          });
        }

        yield* store.apply({
          id: EventId.make(`evt:node:asst:${r}`),
          type: "node.updated",
          threadId: busyThreadId,
          runId,
          nodeId: asstNodeId,
          providerInstanceId,
          occurredAt: runTime,
          payload: {
            id: asstNodeId,
            threadId: busyThreadId,
            runId,
            parentNodeId: rootNodeId,
            rootNodeId,
            kind: "assistant_message",
            status: "completed",
            countsForRun: true,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: runTime,
            completedAt: runTime,
          },
        });
        yield* store.apply({
          id: EventId.make(`evt:msg:asst:${r}`),
          type: "message.updated",
          threadId: busyThreadId,
          runId,
          nodeId: asstNodeId,
          providerInstanceId,
          occurredAt: runTime,
          payload: {
            id: asstMessageId,
            threadId: busyThreadId,
            runId,
            nodeId: asstNodeId,
            role: "assistant",
            text: `Reply ${r}`,
            attachments: [],
            streaming: false,
            createdBy: "agent",
            creationSource: "provider",
            createdAt: runTime,
            updatedAt: runTime,
          },
        });
        yield* store.apply({
          id: EventId.make(`evt:item:asst:${r}`),
          type: "turn-item.updated",
          threadId: busyThreadId,
          runId,
          nodeId: asstNodeId,
          providerInstanceId,
          occurredAt: runTime,
          payload: {
            id: TurnItemId.make(`item:busy:${r}:asst`),
            threadId: busyThreadId,
            runId,
            nodeId: asstNodeId,
            providerThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal++,
            type: "assistant_message",
            status: "completed",
            title: null,
            messageId: asstMessageId,
            text: `Reply ${r}`,
            streaming: false,
            startedAt: runTime,
            completedAt: runTime,
            updatedAt: runTime,
          },
        });
      }

      // Add a rolled-back run, an unretained cancelled queued run, and an active run with a pending
      // runtime request + waiting secret_request + pending background work.
      const rolledBackRunId = RunId.make("run:busy:rolled-back");
      const rolledBackNodeId = NodeId.make("node:busy:rolled-back");
      yield* store.apply({
        id: EventId.make("evt:run:rb"),
        type: "run.created",
        threadId: busyThreadId,
        runId: rolledBackRunId,
        nodeId: rolledBackNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: rolledBackRunId,
          threadId: busyThreadId,
          ordinal: 101,
          status: "rolled_back",
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("msg:busy:rb"),
          rootNodeId: rolledBackNodeId,
          activeAttemptId: null,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          queuePosition: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:item:rb"),
        type: "turn-item.updated",
        threadId: busyThreadId,
        runId: rolledBackRunId,
        nodeId: rolledBackNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:busy:rb"),
          threadId: busyThreadId,
          runId: rolledBackRunId,
          nodeId: rolledBackNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal++,
          type: "user_message",
          status: "completed",
          title: null,
          messageId: MessageId.make("msg:busy:rb"),
          text: "Rolled back",
          attachments: [],
          inputIntent: "turn_start",
          createdBy: "user",
          creationSource: "web",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });

      const cancelledRunId = RunId.make("run:busy:cancelled-queued");
      const cancelledNodeId = NodeId.make("node:busy:cancelled-queued");
      yield* store.apply({
        id: EventId.make("evt:run:cq"),
        type: "run.created",
        threadId: busyThreadId,
        runId: cancelledRunId,
        nodeId: cancelledNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: cancelledRunId,
          threadId: busyThreadId,
          ordinal: 102,
          status: "cancelled",
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("msg:busy:cq"),
          rootNodeId: cancelledNodeId,
          activeAttemptId: null,
          requestedAt: now,
          startedAt: null,
          completedAt: now,
          queuePosition: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:item:cq"),
        type: "turn-item.updated",
        threadId: busyThreadId,
        runId: cancelledRunId,
        nodeId: cancelledNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:busy:cq"),
          threadId: busyThreadId,
          runId: cancelledRunId,
          nodeId: cancelledNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal++,
          type: "user_message",
          status: "cancelled",
          title: null,
          messageId: MessageId.make("msg:busy:cq"),
          text: "Cancelled queued",
          attachments: [],
          inputIntent: "queued_turn",
          createdBy: "user",
          creationSource: "web",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      });

      const activeRootNodeId = NodeId.make("node:busy:active:root");
      yield* store.apply({
        id: EventId.make("evt:run:active"),
        type: "run.created",
        threadId: busyThreadId,
        runId: activeRunId,
        nodeId: activeRootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: activeRunId,
          threadId: busyThreadId,
          ordinal: 103,
          status: "running",
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("msg:busy:active"),
          rootNodeId: activeRootNodeId,
          activeAttemptId: RunAttemptId.make("attempt:busy:active:1"),
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          queuePosition: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:node:active:root"),
        type: "node.updated",
        threadId: busyThreadId,
        runId: activeRunId,
        nodeId: activeRootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: activeRootNodeId,
          threadId: busyThreadId,
          runId: activeRunId,
          parentNodeId: null,
          rootNodeId: activeRootNodeId,
          kind: "root_turn",
          status: "running",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:req:pending"),
        type: "runtime-request.updated",
        threadId: busyThreadId,
        runId: activeRunId,
        nodeId: pendingRequestNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: pendingRequestId,
          nodeId: pendingRequestNodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:node:pending-req"),
        type: "node.updated",
        threadId: busyThreadId,
        runId: activeRunId,
        nodeId: pendingRequestNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: pendingRequestNodeId,
          threadId: busyThreadId,
          runId: activeRunId,
          parentNodeId: activeRootNodeId,
          rootNodeId: activeRootNodeId,
          kind: "user_input_request",
          status: "waiting",
          countsForRun: false,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: pendingRequestId,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:item:pending-req"),
        type: "turn-item.updated",
        threadId: busyThreadId,
        runId: activeRunId,
        nodeId: pendingRequestNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:busy:pending-req"),
          threadId: busyThreadId,
          runId: activeRunId,
          nodeId: pendingRequestNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal++,
          type: "user_input_request",
          status: "waiting",
          title: null,
          requestId: pendingRequestId,
          questions: [],
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:item:secret"),
        type: "turn-item.updated",
        threadId: busyThreadId,
        runId: activeRunId,
        nodeId: activeRootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: secretItemId,
          threadId: busyThreadId,
          runId: activeRunId,
          nodeId: activeRootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal++,
          type: "secret_request",
          status: "waiting",
          title: null,
          label: "API key",
          reason: "Test",
          secretStatus: "pending",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });

      // Seed a preparing run on preparedRunThreadId for prepared-run.progress guard.
      const prepPtId = ProviderThreadId.make("provider-thread:prepared");
      const prepNodeId = NodeId.make("node:prepared:root");
      const prepAttemptId = RunAttemptId.make("attempt:prepared:1");
      yield* store.apply({
        id: EventId.make("evt:pt:prep"),
        type: "provider-thread.updated",
        threadId: preparedRunThreadId,
        occurredAt: now,
        payload: {
          id: prepPtId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: preparedRunThreadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "not_loaded",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:run:prep"),
        type: "run.created",
        threadId: preparedRunThreadId,
        runId: preparedRunId,
        nodeId: prepNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: preparedRunId,
          threadId: preparedRunThreadId,
          ordinal: 1,
          status: "preparing",
          providerInstanceId,
          modelSelection,
          providerThreadId: prepPtId,
          userMessageId: MessageId.make("msg:prepared:1"),
          rootNodeId: prepNodeId,
          activeAttemptId: prepAttemptId,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          queuePosition: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:att:prep"),
        type: "run-attempt.updated",
        threadId: preparedRunThreadId,
        runId: preparedRunId,
        nodeId: prepNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: prepAttemptId,
          runId: preparedRunId,
          attemptOrdinal: 1,
          providerInstanceId,
          providerThreadId: prepPtId,
          providerTurnId: null,
          rootNodeId: prepNodeId,
          reason: "initial",
          status: "pending",
          startedAt: now,
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:node:prep"),
        type: "node.updated",
        threadId: preparedRunThreadId,
        runId: preparedRunId,
        nodeId: prepNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: prepNodeId,
          threadId: preparedRunThreadId,
          runId: preparedRunId,
          parentNodeId: null,
          rootNodeId: prepNodeId,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: prepPtId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("evt:item:prep"),
        type: "turn-item.updated",
        threadId: preparedRunThreadId,
        runId: preparedRunId,
        nodeId: prepNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("item:prepared:cmd"),
          threadId: preparedRunThreadId,
          runId: preparedRunId,
          nodeId: prepNodeId,
          providerThreadId: prepPtId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          type: "command_execution",
          status: "running",
          title: "Preparing workspace",
          input: "Preparing workspace",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
    }),
  );

  // Give SQLite realistic table/index statistics so the planner mirrors production choices.
  yield* sql`ANALYZE`;

  return {
    projectId,
    busyThreadId,
    settleThreadId,
    archiveThreadId,
    deleteThreadId,
    preparedRunThreadId,
    preparedRunId,
    activeRunId,
    sampleRunId,
    pendingRequestId,
    pendingRequestNodeId,
    secretItemId,
    targetItemId,
    totalSeededTurnItems: ordinal - 1,
    now,
  } satisfies SeededFixture;
});

it.effect(
  "guards every hot read against whole-thread scans of turn_items, nodes, and messages",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sql = yield* SqlClient.SqlClient;
      const fixture = yield* seedLargeFixture;
      assert.isAtLeast(fixture.totalSeededTurnItems, 2_000);

      for (const guard of HOT_READ_PLAN_GUARDS) {
        const statements = yield* captureSqlStatements(
          guard.capture({ ...fixture, store, orchestrator, sql }),
        );
        const matched = Array.from(statements).filter(([query]) => guard.selectStatement(query));
        assert.isAbove(
          matched.length,
          0,
          `[${guard.name}] expected at least one matching SQL statement; captured ${statements.size} statements`,
        );

        const allPlans: Array<string> = [];
        for (const [statement, params] of matched) {
          const planRows = yield* explainRead(sql, statement, params);
          const planText = planRows.map((row) => row.detail).join("\n");
          allPlans.push(planText);

          for (const forbidden of [...GLOBAL_FORBIDDEN_PLANS, ...(guard.forbiddenPlans ?? [])]) {
            assert.isFalse(
              forbidden.test(planText) || forbidden.test(statement),
              `[${guard.name}] forbidden pattern ${forbidden} matched.\nSQL: ${statement}\nPLAN:\n${planText}`,
            );
          }
        }
        const combinedPlan = allPlans.join("\n");
        for (const required of guard.requiredPlans) {
          assert.match(
            combinedPlan,
            required,
            `[${guard.name}] missing required plan ${required}.\nPLANS:\n${combinedPlan}`,
          );
        }
      }
    }).pipe(Effect.provide(layerTest)),
  { timeout: 30_000 },
);

it.effect(
  "explains live timing scenarios against a freshly migrated database",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const fixture = yield* seedLargeFixture;
      const sample: HotReadSample = {
        threadId: fixture.busyThreadId,
        runId: fixture.sampleRunId,
        itemId: fixture.targetItemId,
        messageId: MessageId.make("msg:busy:1:user"),
        afterSequence: 0,
        throughSequence: 50,
        cursor: encodeThreadHistoryCursor({
          snapshotSequence: 0,
          sourceThreadId: fixture.busyThreadId,
          sourceItemId: fixture.targetItemId,
          position: 1_000,
        }),
      };
      const indexes = yield* sql<{ readonly name: string; readonly tbl_name: string }>`
      SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index'
    `;
      const tablesByIndex = new Map(indexes.map((row) => [row.name, row.tbl_name]));
      const violations: string[] = [];
      for (const [name, run] of Object.entries(hotReads)) {
        const statements = yield* captureSqlStatements(
          Effect.gen(function* () {
            yield* run(sample);
          }),
        );
        assert.isAbove(statements.size, 0, `[${name}] expected production SQL`);
        for (const [statement, params] of statements) {
          const plans = yield* explainRead(sql, statement, params);
          const exceptions = allowedScans.filter(
            (entry) => entry.scenario.test(name) && entry.statement.test(statement),
          );
          for (const scan of fullScans(statement, plans, tablesByIndex)) {
            const exception = exceptions.findIndex((entry) => entry.scan === scan);
            if (exception < 0) {
              violations.push(
                `[${name}] ${scan}: ${statement.trim().replace(/\s+/g, " ").slice(0, 180)}`,
              );
            } else {
              exceptions.splice(exception, 1);
            }
          }
        }
      }
      assert.deepEqual(violations, []);
    }).pipe(Effect.provide(layerTest)),
  { timeout: 30_000 },
);

it.effect(
  "preserves exact timeline pagination and visibility across bounded getTimelinePage paths",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const fixture = yield* seedLargeFixture;

      // Full timeline has 100 runs * 20 items + 1 pending req + 1 secret = 2002 visible items
      // (the rolled_back item and unretained cancelled queued_turn item are hidden).
      const tailMessages = yield* store.getTimelinePage(fixture.busyThreadId, {
        view: "messages",
        fromEnd: true,
        limit: 5,
      });
      assert.equal(tailMessages.totalItems, 2_002);
      assert.isTrue(tailMessages.hasMore);
      assert.lengthOf(tailMessages.items, 5);
      // Positions must be strictly increasing and match the exact canonical indices of the last 5 messages.
      assert.deepEqual(
        tailMessages.items.map((row) => row.sourceItemId),
        [
          "item:busy:98:asst",
          "item:busy:99:user",
          "item:busy:99:asst",
          "item:busy:100:user",
          "item:busy:100:asst",
        ],
      );
      assert.deepEqual(
        tailMessages.items.map((row) => row.position),
        [1959, 1960, 1979, 1980, 1999],
      );

      // Page backwards before position 1959 -> should get the previous 3 messages cleanly.
      const prevMessages = yield* store.getTimelinePage(fixture.busyThreadId, {
        view: "messages",
        beforePosition: 1959,
        limit: 3,
      });
      assert.equal(prevMessages.totalItems, 2_002);
      assert.isTrue(prevMessages.hasMore);
      assert.deepEqual(
        prevMessages.items.map((row) => [row.position, row.sourceItemId]),
        [
          [1920, "item:busy:97:user"],
          [1939, "item:busy:97:asst"],
          [1940, "item:busy:98:user"],
        ],
      );

      // Forward messages from start.
      const headMessages = yield* store.getTimelinePage(fixture.busyThreadId, {
        view: "messages",
        fromEnd: false,
        afterPosition: -1,
        limit: 3,
      });
      assert.equal(headMessages.totalItems, 2_002);
      assert.isTrue(headMessages.hasMore);
      assert.deepEqual(
        headMessages.items.map((row) => [row.position, row.sourceItemId]),
        [
          [0, "item:busy:1:user"],
          [19, "item:busy:1:asst"],
          [20, "item:busy:2:user"],
        ],
      );

      // Activity view tail includes the waiting request & secret card at positions 2000 and 2001,
      // skipping the hidden rolled-back and cancelled-queued items cleanly.
      const tailActivity = yield* store.getTimelinePage(fixture.busyThreadId, {
        view: "activity",
        fromEnd: true,
        limit: 3,
      });
      assert.equal(tailActivity.totalItems, 2_002);
      assert.isTrue(tailActivity.hasMore);
      assert.deepEqual(
        tailActivity.items.map((row) => [row.position, row.sourceItemId]),
        [
          [1999, "item:busy:100:asst"],
          [2000, "item:busy:pending-req"],
          [2001, fixture.secretItemId],
        ],
      );

      // Direct itemId lookup computes exact canonical position.
      const single = yield* store.getTimelinePage(fixture.busyThreadId, {
        view: "activity",
        limit: 1,
        itemId: fixture.secretItemId,
      });
      assert.equal(single.totalItems, 2_002);
      assert.isFalse(single.hasMore);
      assert.deepEqual(
        single.items.map((row) => [row.position, row.sourceItemId]),
        [[2001, fixture.secretItemId]],
      );

      // Hidden items are invisible to itemId lookup.
      const hiddenLookup = yield* store.getTimelinePage(fixture.busyThreadId, {
        view: "activity",
        limit: 1,
        itemId: TurnItemId.make("item:busy:rb"),
      });
      assert.deepEqual(hiddenLookup.items, []);

      // Narrowed control filters return the exact matching rows.
      const secrets = yield* store.getThreadRecords(fixture.busyThreadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
      });
      assert.deepEqual(
        secrets.turnItems.map((item) => item.id),
        [fixture.secretItemId],
      );
      const reqItems = yield* store.getThreadRecords(fixture.busyThreadId, ["turnItems"], {
        turnItemNodeIds: [fixture.pendingRequestNodeId],
        turnItemTypes: ["approval_request", "user_input_request"],
      });
      assert.deepEqual(
        reqItems.turnItems.map((item) => item.id),
        ["item:busy:pending-req"],
      );
    }).pipe(Effect.provide(layerTest)),
  { timeout: 30_000 },
);
