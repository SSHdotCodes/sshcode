import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as FileSystem from "effect/FileSystem";
import {
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { isAutoSettlementCandidate, resolveAutoSettlementAt } from "./ThreadSettlementService.ts";

const layerSql = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const now = DateTime.makeUnsafe("2026-09-04T12:00:00Z");
const old = DateTime.subtract(now, { days: 10 });
const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "test-model" };
const encodeNumbers = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.Number)));

const createThread = Effect.fn(function* (
  name: string,
  overrides: Partial<OrchestrationV2AppThread> = {},
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:settlement:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:settlement"),
    title: name,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: old,
    updatedAt: old,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
  yield* store.apply({
    id: EventId.make(`event:${threadId}`),
    type: "thread.created",
    threadId,
    occurredAt: old,
    payload: thread,
  });
  return threadId;
});

const createRun = Effect.fn(function* (
  threadId: ThreadId,
  status: OrchestrationV2Run["status"] = "completed",
  ordinal = 1,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const runId = RunId.make(`run:${threadId}:${ordinal}`);
  yield* store.apply({
    id: EventId.make(`event:${runId}`),
    type: "run.created",
    threadId,
    occurredAt: old,
    payload: {
      id: runId,
      threadId,
      ordinal,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${runId}`),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: old,
      startedAt: status === "queued" ? null : old,
      completedAt: ["completed", "rolled_back", "failed"].includes(status) ? old : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  return runId;
});

const createItem = Effect.fn(function* (
  threadId: ThreadId,
  runId: RunId,
  status: "idle" | "running" | "completed",
  persistent = false,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`event:item:${runId}`),
    type: "turn-item.updated",
    threadId,
    occurredAt: old,
    payload: {
      id: TurnItemId.make(`item:${runId}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "dynamic_tool",
      status,
      title: null,
      startedAt: old,
      completedAt: status === "completed" ? old : null,
      updatedAt: old,
      toolName: "background",
      input: persistent ? { persistent: true } : null,
      output: null,
    },
  });
});

it.effect.each([
  ["sql", layerSql],
  ["memory", ProjectionStore.layerMemory],
] as const)(
  "%s: discovers settlement work with the same activity and background semantics as the shell",
  ([, testLayer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const idle = yield* createThread("idle");
      const completed = yield* createThread("completed");
      yield* createRun(completed);
      for (const [name, overrides] of [
        ["archived", { archivedAt: old }],
        ["deleted", { deletedAt: old }],
        ["settled", { settledOverride: "settled" }],
        ["unsettled", { settledOverride: "active" }],
        ["pinned", { pinnedAt: old }],
        ["auto-settle-disabled", { autoSettleDisabledAt: old }],
      ] satisfies ReadonlyArray<readonly [string, Partial<OrchestrationV2AppThread>]>) {
        yield* createRun(yield* createThread(name, overrides));
      }
      for (const status of ["preparing", "starting", "running", "waiting"] as const) {
        yield* createRun(yield* createThread(status), status);
      }
      const queued = yield* createThread("queued");
      yield* createRun(queued, "queued");
      const blocked = yield* createThread("blocked");
      yield* store.apply({
        id: EventId.make("event:settlement:request"),
        type: "runtime-request.updated",
        threadId: blocked,
        occurredAt: old,
        payload: {
          id: RuntimeRequestId.make("request:settlement"),
          nodeId: NodeId.make("node:settlement"),
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "not_resumable", reason: "Process stopped" },
          createdAt: old,
          resolvedAt: null,
        },
      });
      const recent = yield* createThread("recent-message");
      yield* createRun(recent);
      yield* store.apply({
        id: EventId.make("event:settlement:message"),
        type: "message.updated",
        threadId: recent,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make("message:settlement:recent"),
          threadId: recent,
          runId: null,
          nodeId: null,
          role: "user",
          text: "Next turn",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* createRun(
        yield* createThread("snoozed", {
          snoozedUntil: DateTime.add(now, { days: 1 }),
          snoozedAt: now,
        }),
      );
      const woke = yield* createThread("woke", {
        snoozedUntil: DateTime.add(now, { days: 1 }),
        snoozedAt: DateTime.subtract(old, { days: 1 }),
      });
      yield* createRun(woke);
      const background = yield* createThread("idle-background");
      yield* createItem(background, yield* createRun(background), "idle");
      const persistent = yield* createThread("persistent-monitor");
      yield* createItem(persistent, yield* createRun(persistent), "running", true);
      const rolledBack = yield* createThread("rolled-back-background");
      yield* createItem(rolledBack, yield* createRun(rolledBack, "rolled_back"), "running");
      yield* createRun(rolledBack, "completed", 2);
      const roster = yield* createThread("provider-roster");
      yield* createRun(roster);
      yield* store.apply({
        id: EventId.make("event:settlement:roster"),
        type: "provider-thread.updated",
        threadId: roster,
        occurredAt: old,
        payload: {
          id: ProviderThreadId.make("provider-thread:settlement"),
          appThreadId: roster,
          ownerNodeId: null,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId,
          providerSessionId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: old,
          updatedAt: old,
          pendingBackgroundTasks: [{ taskId: "running-task", kind: "subagent" }],
        },
      });
      const candidates = yield* store.getSettlementCandidates();
      const shell = yield* store.getShellSnapshot({ location: "active" });
      const eligible = candidates.filter((thread) =>
        isAutoSettlementCandidate(thread, DateTime.toEpochMillis(now)),
      );
      assert.deepEqual(
        new Set(eligible.map((thread) => thread.id)),
        new Set([idle, completed, woke, background, persistent, rolledBack]),
      );
      // The candidate query also rejects the queue the settle command would
      // refuse, which the shell's pure filter cannot see on its own.
      assert.deepEqual(
        new Set(eligible.map((thread) => thread.id)),
        new Set(
          shell.threads
            .filter((thread) => isAutoSettlementCandidate(thread, DateTime.toEpochMillis(now)))
            .filter((thread) => thread.id !== queued)
            .map((thread) => thread.id),
        ),
      );
      for (const candidate of candidates) {
        const expected = shell.threads.find((thread) => thread.id === candidate.id)!;
        assert.deepEqual(candidate.pendingBackgroundTasks, expected.pendingBackgroundTasks);
        const settings = {
          pullRequest: null,
          nowMs: DateTime.toEpochMillis(now),
          autoSettleAfterDays: 7,
          autoSettleOnMerge: false,
        };
        assert.deepEqual(
          resolveAutoSettlementAt({ ...settings, thread: candidate }),
          resolveAutoSettlementAt({
            ...settings,
            thread: {
              ...expected,
              latestUserAuthoredMessageAt: candidate.latestUserAuthoredMessageAt,
            },
          }),
        );
      }
      assert.equal(
        DateTime.formatIso((yield* store.getThread(completed)).createdAt),
        DateTime.formatIso(old),
      );
      assert.equal(
        (yield* store.getThread(ThreadId.make("missing")).pipe(Effect.flip))._tag,
        "ProjectionStoreThreadNotFoundError",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  ["sql", layerSql],
  ["memory", ProjectionStore.layerMemory],
] as const)(
  "%s: skips settlement candidates a queued message blocks, keeping automatic queues",
  ([, testLayer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      // The settle command refuses a thread whose queue holds a regular
      // message (Orchestrator's "has a queued message" blocker), so a
      // candidate like this fails the sweep on every pass. It must not be
      // a candidate at all.
      const blocked = yield* createThread("queued-blocked");
      const blockedRun = yield* createRun(blocked, "queued");
      yield* store.apply({
        id: EventId.make("event:settlement:queued-blocked-message"),
        type: "message.updated",
        threadId: blocked,
        occurredAt: old,
        payload: {
          createdBy: "agent",
          creationSource: "mcp",
          id: MessageId.make(`message:${blockedRun}`),
          threadId: blocked,
          runId: null,
          nodeId: null,
          role: "user",
          text: "queued for the agent",
          attachments: [],
          streaming: false,
          createdAt: old,
          updatedAt: old,
        },
      });
      // A queued run whose message is a notification or a delegated
      // completion is automatic: the settle command cancels it instead of
      // refusing, so the thread stays a candidate.
      const notification = yield* createThread("queued-notification");
      const notificationRun = yield* createRun(notification, "queued");
      yield* store.apply({
        id: EventId.make("event:settlement:queued-notification-message"),
        type: "message.updated",
        threadId: notification,
        occurredAt: old,
        payload: {
          createdBy: "agent",
          creationSource: "provider",
          notification: {
            source: { kind: "background_task" },
            outcome: "completed",
            summary: "Background work finished",
          },
          id: MessageId.make(`message:${notificationRun}`),
          threadId: notification,
          runId: null,
          nodeId: null,
          role: "user",
          text: "background work finished",
          attachments: [],
          streaming: false,
          createdAt: old,
          updatedAt: old,
        },
      });
      const delegated = yield* createThread("queued-delegated");
      const delegatedRun = yield* createRun(delegated, "queued");
      yield* store.apply({
        id: EventId.make("event:settlement:queued-delegated-message"),
        type: "message.updated",
        threadId: delegated,
        occurredAt: old,
        payload: {
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: {
            parentRunId: delegatedRun,
            generation: 1,
            taskIds: [NodeId.make("node:settlement:delegated")],
          },
          id: MessageId.make(`message:${delegatedRun}`),
          threadId: delegated,
          runId: null,
          nodeId: null,
          role: "user",
          text: "delegated work finished",
          attachments: [],
          streaming: false,
          createdAt: old,
          updatedAt: old,
        },
      });
      const idle = yield* createThread("queued-control");
      const candidates = yield* store.getSettlementCandidates();
      const candidateIds = new Set(candidates.map((thread) => thread.id));
      assert.isFalse(candidateIds.has(blocked));
      assert.isTrue(candidateIds.has(notification));
      assert.isTrue(candidateIds.has(delegated));
      assert.isTrue(candidateIds.has(idle));
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  ["sql", layerSql],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s: the user-authored message time ignores agent notifications", ([, testLayer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* createThread("agent-woken");
    yield* createRun(threadId);
    const message = (
      id: string,
      createdBy: "user" | "agent",
      creationSource: "web" | "provider",
      at: DateTime.Utc,
    ) =>
      store.apply({
        id: EventId.make(`event:settlement:${id}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          createdBy,
          creationSource,
          id: MessageId.make(`message:settlement:${id}`),
          threadId,
          runId: null,
          nodeId: null,
          role: "user",
          text: id,
          attachments: [],
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      });
    const written = DateTime.subtract(now, { hours: 2 });
    yield* message("written", "user", "web", written);
    yield* message("notification", "agent", "provider", now);

    const [candidate] = yield* store.getSettlementCandidates(threadId);
    assert.isDefined(candidate);
    assert.equal(DateTime.formatIso(candidate.latestUserMessageAt!), DateTime.formatIso(now));
    assert.equal(
      DateTime.formatIso(candidate.latestUserAuthoredMessageAt!),
      DateTime.formatIso(written),
    );
    // The shell carries the same stamp, which orders the Working section.
    const shellThread = (yield* store.getShellSnapshot()).threads.find(
      (thread) => thread.id === threadId,
    );
    assert.equal(
      DateTime.formatIso(shellThread!.latestUserAuthoredMessageAt!),
      DateTime.formatIso(written),
    );
  }).pipe(Effect.provide(testLayer)),
);

const pullRequestLink = (number: number) => ({
  host: "github.com",
  repository: "owner/repository",
  number,
  url: `https://github.com/owner/repository/pull/${number}`,
  source: "manual" as const,
  linkedAt: DateTime.formatIso(old),
  snapshot: null,
  stack: null,
});

it.effect.each([
  ["sql", layerSql],
  ["memory", ProjectionStore.layerMemory],
] as const)(
  "%s: lists only active threads with pull request links, oldest first",
  ([, testLayer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* createThread("no-links");
      yield* createThread("empty-links", { pullRequests: [] });
      yield* createThread("archived-link", {
        archivedAt: old,
        pullRequests: [pullRequestLink(1)],
      });
      const settled = yield* createThread("settled-link", {
        settledOverride: "settled",
        settledAt: old,
        updatedAt: DateTime.subtract(now, { days: 12 }),
        pullRequests: [pullRequestLink(2)],
      });
      const open = yield* createThread("open-link", {
        pullRequests: [pullRequestLink(3), pullRequestLink(4)],
      });

      const threads = yield* store.getThreadsWithPullRequests();
      assert.deepEqual(
        threads.map((thread) => [thread.id, thread.settledOverride, thread.pullRequests?.length]),
        [
          [settled, "settled", 1],
          [open, null, 2],
        ],
      );
      assert.deepEqual(
        (yield* store.getThreadsWithPullRequests(open)).map((thread) => thread.id),
        [open],
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  ["sql", layerSql],
  ["memory", ProjectionStore.layerMemory],
] as const)("%s: an unsettled-only shell read skips settled threads", ([, testLayer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const open = yield* createThread("unsettled-open");
    const reopened = yield* createThread("unsettled-reopened", { settledOverride: "active" });
    yield* createThread("unsettled-manual", { settledOverride: "settled", settledAt: old });
    yield* createThread("unsettled-auto", { settledAt: old });
    yield* createThread("unsettled-archived", { archivedAt: old });

    const shell = yield* store.getShellSnapshot({ location: "active", unsettledOnly: true });
    assert.deepEqual(new Set(shell.threads.map((thread) => thread.id)), new Set([open, reopened]));
    assert.equal(shell.archivedThreads.length, 0);
    const all = yield* store.getShellSnapshot({ location: "active" });
    assert.equal(all.threads.length, 4);
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "reads settlement candidates and thread metadata without loading historical or archived payloads",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const source = yield* createThread("historical-source", { archivedAt: old });
      const sourceRun = yield* createRun(source);
      const threadId = yield* createThread("fork", {
        forkedFrom: { type: "run", threadId: source, runId: sourceRun },
      });
      const runId = yield* createRun(threadId);
      yield* createItem(threadId, runId, "completed");
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = '{broken' WHERE thread_id = ${threadId}`;
      yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = '{broken' WHERE thread_id = ${source}`;
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
      SELECT 'history:' || value, i.thread_id, i.run_id, i.node_id, i.provider_thread_id, i.provider_turn_id,
        i.parent_item_id, i.ordinal + value, i.type, i.status, i.updated_at, i.payload_json
      FROM orchestration_v2_projection_turn_items i, json_each(${encodeNumbers(Array.from({ length: 2000 }, (_, i) => i + 1))})
      WHERE i.thread_id = ${threadId}`;
      const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          queries.push(statement.compile());
          return statement;
        });
      const candidates = yield* store
        .getSettlementCandidates()
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      assert.deepEqual(
        candidates.map((thread) => thread.id),
        [threadId],
      );
      assert.isTrue(queries.every(([query]) => !query.includes("COUNT(")));
      const pendingQuery = queries.find(([query]) =>
        query.includes("FROM orchestration_v2_projection_turn_items"),
      );
      assert.isDefined(pendingQuery);
      const metadata = yield* store.getThread(threadId);
      assert.equal(metadata.id, threadId);
      assert.equal((yield* store.getThreadProjection(threadId).pipe(Effect.exit))._tag, "Failure");
      const plan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${pendingQuery![0]}`,
        pendingQuery![1],
      );
      assert.isTrue(plan.some((row) => row.detail.includes("turn_items_shell_pending_idx")));
      const countsPlan = yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
      SELECT thread_id, run_id, COUNT(*) FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId} AND run_id IS NOT NULL GROUP BY thread_id, run_id`;
      assert.isTrue(
        countsPlan.some((row) =>
          row.detail.includes(
            "COVERING INDEX orchestration_v2_projection_turn_items_thread_run_idx",
          ),
        ),
      );
      assert.isFalse(countsPlan.some((row) => row.detail.includes("TEMP B-TREE")));
      const messagePlan = yield* sql<{ readonly detail: string }>`EXPLAIN QUERY PLAN
      SELECT updated_at FROM orchestration_v2_projection_messages
      WHERE thread_id = ${threadId} AND role = 'user' ORDER BY updated_at DESC, message_id DESC LIMIT 1`;
      assert.isTrue(messagePlan.some((row) => row.detail.includes("messages_latest_user_idx")));
      assert.isFalse(messagePlan.some((row) => row.detail.includes("TEMP B-TREE")));
    }).pipe(Effect.provide(layerSql)),
);

it.effect("shell failure lookups stay on the thread's own turn items", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const failed = yield* createThread("failed-latest");
    yield* createRun(failed, "failed");
    const queries: Array<readonly [string, ReadonlyArray<unknown>]> = [];
    const record: Statement.Transformer = (statement) =>
      Effect.sync(() => {
        queries.push(statement.compile());
        return statement;
      });
    const shell = yield* store
      .getShellSnapshot()
      .pipe(Effect.provideService(Statement.CurrentTransformer, record));
    assert.deepEqual(
      shell.threads.map((thread) => thread.id),
      [failed],
    );
    const shellQuery = queries.find(([query]) =>
      query.includes("AS blocking_failure_payload_json"),
    );
    assert.isDefined(shellQuery);
    const plan = yield* sql.unsafe<{ readonly detail: string }>(
      `EXPLAIN QUERY PLAN ${shellQuery![0]}`,
      shellQuery![1],
    );
    // A failed run's root node is often null, and every runless item shares that
    // node_id, so a node_ordinal lookup walks the whole history once per thread.
    const itemLookups = plan.filter((row) => row.detail.startsWith("SEARCH item "));
    assert.lengthOf(itemLookups, 2);
    assert.isTrue(itemLookups.every((row) => row.detail.includes("turn_items_failed_error_idx")));
    // Pending secret cards are found once by their id prefix on the primary key, never by
    // reading a chat's history: no index holds a turn item's type.
    const secretRanges = plan.filter((row) =>
      row.detail.includes("turn_item_id>? AND turn_item_id<?"),
    );
    assert.lengthOf(secretRanges, 1);
    assert.include(
      secretRanges[0]!.detail,
      "sqlite_autoindex_orchestration_v2_projection_turn_items_1",
    );
    assert.isTrue(plan.some((row) => row.detail === "MATERIALIZE pending_secret"));
    // The winning card's payload is then one primary-key lookup per chat that has one.
    const secretLookups = plan.filter((row) => row.detail.startsWith("SEARCH secret "));
    assert.lengthOf(secretLookups, 1);
    assert.include(
      secretLookups[0]!.detail,
      "sqlite_autoindex_orchestration_v2_projection_turn_items_1 (turn_item_id=?)",
    );
  }).pipe(Effect.provide(layerSql)),
);

it.effect(
  "keeps dispatch witnesses correct across prefix growth, historical edits and rollback",
  () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* createThread("dispatch-witnesses");
      const ids: RunId[] = [];
      for (let n = 1; n <= 40; n++) ids.push(yield* createRun(threadId, "completed", n));
      const messageId = MessageId.make("legacy-id");
      const userItem = (n: number, text: string, id = messageId) =>
        store.apply({
          id: EventId.make(`event:item:${n}`),
          type: "turn-item.updated",
          threadId,
          occurredAt: old,
          payload: {
            id: TurnItemId.make(`legacy-item:${n}`),
            messageId: id,
            threadId,
            runId: ids[n - 1]!,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: n,
            type: "user_message",
            status: "completed",
            title: null,
            startedAt: old,
            completedAt: old,
            updatedAt: old,
            text,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            inputIntent: "turn_start",
          },
        });
      yield* userItem(1, "initial");
      yield* userItem(40, "\u00a0/COMPACT\u2029");
      const active = yield* createRun(threadId, "running", 41);
      const raw = (yield* store.getThreadRecords(threadId, ["runs"], { runIds: [active] }))
        .runs[0]!;
      const attempt = RunAttemptId.make("active-attempt");
      const root = NodeId.make("active-root");
      const providerThreadId = ProviderThreadId.make("provider-thread");
      yield* store.apply({
        id: EventId.make("activate"),
        type: "run.updated",
        threadId,
        occurredAt: old,
        payload: { ...raw, rootNodeId: root, activeAttemptId: attempt, providerThreadId },
      });
      const queries = new Map<string, readonly unknown[]>();
      const record: Statement.Transformer = (statement) =>
        Effect.sync(() => {
          const [query, params] = statement.compile();
          if (/^\s*SELECT/i.test(query)) queries.set(query, params);
          return statement;
        });
      const read = (id = MessageId.make("fresh")) =>
        store
          .getMessageDispatchProjection(threadId, {
            messageId: id,
            needsRunHistory: false,
            checkMaintenanceHistory: true,
          })
          .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      const cold = yield* read();
      assert.isBelow(cold.runs.length, 30);
      assert.isTrue(cold.turnItems.some((row) => row.id === "legacy-item:1"));
      const coldQueries = new Map(queries);
      queries.clear();
      const warm = yield* read();
      assert.deepEqual(warm, cold);
      assert.isFalse(
        [...queries.keys()].some(
          (q) =>
            q.includes(" AS preparation") ||
            q.includes("AS id FROM orchestration_v2_projection_turn_items") ||
            (q.includes("ORDER BY rowid") && q.includes("SELECT provider_turn_id, run_attempt_id")),
        ),
      );
      for (const [query, params] of coldQueries) queries.set(query, params);
      yield* userItem(8, "new winner in old run");
      assert.isTrue((yield* read()).turnItems.some((row) => row.id === "legacy-item:8"));
      yield* userItem(8, "/compact");
      assert.isTrue((yield* read()).turnItems.some((row) => row.id === "legacy-item:1"));
      const duplicate = yield* read(messageId);
      assert.equal(
        duplicate.turnItems.find(
          (item) => item.type === "user_message" && item.messageId === messageId,
        )?.id,
        "legacy-item:1",
      );
      for (let n = 42; n <= 60; n++) yield* createRun(threadId, "completed", n);
      assert.isTrue((yield* read()).turnItems.some((row) => row.id === "legacy-item:1"));
      const oldRun = (yield* store.getThreadRecords(threadId, ["runs"], { runIds: [ids[3]!] }))
        .runs[0]!;
      const rewrite = store.apply({
        id: EventId.make("historical-retry"),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...oldRun,
          automaticProviderRetry: {
            status: "scheduled",
            attempt: 1,
            scheduledAt: DateTime.formatIso(now),
          },
        },
      });
      yield* Effect.flip(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* rewrite;
            assert.isTrue(
              (yield* read()).runs.some(
                (run) => run.id === oldRun.id && run.automaticProviderRetry?.status === "scheduled",
              ),
            );
            return yield* Effect.fail("roll back");
          }),
        ),
      );
      assert.isFalse(
        (yield* read()).runs.some((run) => run.automaticProviderRetry?.status === "scheduled"),
      );
      yield* rewrite;
      assert.isTrue(
        (yield* read()).runs.some(
          (run) => run.id === oldRun.id && run.automaticProviderRetry?.status === "scheduled",
        ),
      );
      const turn = {
        id: ProviderTurnId.make("turn"),
        runAttemptId: attempt,
        nodeId: root,
        providerThreadId,
        ordinal: 1,
        nativeTurnRef: null,
        status: "running" as const,
        startedAt: old,
        completedAt: null,
      };
      yield* store.apply({
        id: EventId.make("new-turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: turn,
      });
      assert.deepEqual(
        (yield* read()).providerTurns.map((row) => row.id),
        [turn.id],
      );
      yield* store.apply({
        id: EventId.make("reassign-turn"),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: { ...turn, runAttemptId: RunAttemptId.make("other") },
      });
      assert.deepEqual((yield* read()).providerTurns, []);
      yield* store
        .getRunningTurnContext(threadId)
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      yield* store
        .hasMessages(threadId)
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      assert.isTrue(
        yield* store
          .hasStartedRunAfter(threadId, 0)
          .pipe(Effect.provideService(Statement.CurrentTransformer, record)),
      );
      const queued = yield* createRun(threadId, "queued", 61);
      for (const keys of [undefined, [queued]]) {
        yield* store
          .getThreadRecords(threadId, ["runs", "messages", "nodes", "attempts", "turnItems"], {
            queuedControls: true,
            ...(keys ? { runIds: keys } : {}),
            turnItemTypes: ["user_message"],
          })
          .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      }
      yield* store
        .getMessageDispatchProjection(threadId, { needsRunHistory: false, queuedStart: true })
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      yield* store
        .canStartQueuedRun(threadId)
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      const firstSeen = MessageId.make("first-seen-after-warmup");
      assert.isFalse(
        (yield* read(firstSeen)).turnItems.some(
          (item) => item.type === "user_message" && item.messageId === firstSeen,
        ),
      );
      yield* userItem(4, "/compact", firstSeen);
      assert.isTrue((yield* read(firstSeen)).turnItems.some((item) => item.id === "legacy-item:4"));
      yield* store
        .getThreadRecords(threadId, ["runs"], { activeRunsOnly: true })
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      yield* store
        .getMessageDispatchProjection(threadId, {
          needsRunHistory: false,
          followupTaskId: NodeId.make("original"),
        })
        .pipe(Effect.provideService(Statement.CurrentTransformer, record));
      for (let i = 0; i < 10; i++) {
        const id = MessageId.make(`maintenance:${i}`);
        yield* store.apply({
          type: "message.updated",
          id: EventId.make(id),
          threadId,
          occurredAt: now,
          payload: {
            id,
            threadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: i === 0 ? "prompt" : "/logout",
            attachments: [],
            streaming: false,
            createdBy: "user",
            creationSource: "web",
            createdAt: old,
            updatedAt: DateTime.add(old, { seconds: i }),
          },
        });
      }
      assert.isTrue((yield* read()).messages.some((m) => m.text === "prompt"));
      const plans: string[] = [];
      for (const [query, params] of queries) {
        const plan = (yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`, params))
          .map((row) => row.detail)
          .join("\n");
        plans.push(plan);
        assert.notMatch(
          plan,
          /SCAN (?:node|item|orchestration_v2_projection_(?:turn_items|messages|nodes|runs|run_attempts|provider_turns))\b/,
          query,
        );
        if (query.includes("wanted_run") || query.includes("item.run_id ="))
          assert.match(plan, /turn_items_thread_run_idx \(thread_id=\? AND run_id=\?\)/, query);
        if (query.includes("node.node_id IN")) assert.match(plan, /nodes_1 \(node_id=\?\)/, query);
        if (
          query.includes("WHERE provider_turn_id IN") ||
          query.includes("AND provider_turn_id IN")
        )
          assert.match(plan, /provider_turns_1 \(provider_turn_id=\?\)/, query);
        if (query.includes("AND message_id IN"))
          assert.match(plan, /messages_1 \(message_id=\?\)/, query);
        if (
          query.includes("run_id IN") &&
          query.includes("sqlite_autoindex_orchestration_v2_projection_runs_1")
        )
          assert.match(plan, /runs_1 \(run_id=\?\)/, query);
        if (query.includes("AND ordinal >"))
          assert.match(plan, /runs_thread_ordinal_idx \(thread_id=\? AND ordinal>/, query);
        if (
          query.includes("type = 'user_message'") &&
          query.includes("json_extract(payload_json, '$.messageId')") &&
          !query.includes("wanted_run")
        )
          assert.match(plan, /turn_items_user_message_idx/, query);
        if (query.includes("WHERE subagent_id ="))
          assert.match(plan, /subagents_1 \(subagent_id=\?\)/, query);
        if (query.includes("AND status IN ('queued','preparing'"))
          assert.match(plan, /runs_thread_status_idx \(thread_id=\? AND status=\?\)/, query);
        if (query.includes("AS item_id") || query.includes("item.run_id = candidate.run_id"))
          assert.match(plan, /turn_items_thread_run_idx/, query);
        if (query.includes("wanted CROSS JOIN")) {
          assert.match(plan, /provider_threads_1 \(provider_thread_id=\?\)/, query);
          assert.match(plan, /subagents_provider_thread_idx \(provider_thread_id=\?\)/, query);
        }
        if (query.includes("ORDER BY updated_at DESC, message_id DESC LIMIT 8"))
          assert.match(plan, /messages_latest_user_idx/, query);
        if (
          query.includes("FROM orchestration_v2_projection_run_attempts") &&
          query.includes("AND run_id IN")
        )
          assert.match(plan, /\(thread_id=\? AND run_id=\?\)|\(run_id=\?\)/, query);
        if (
          query.includes("ORDER BY rowid") &&
          query.includes("SELECT provider_turn_id, run_attempt_id")
        )
          assert.match(plan, /provider_turns_thread_idx/, query);
        if (query.includes("status = 'running' ORDER BY ordinal ASC LIMIT 1"))
          assert.match(plan, /runs_thread_status_idx/, query);
        if (query.includes("ready FROM"))
          assert.match(plan, /runs_thread_status_idx \(thread_id=\? AND status=\?\)/, query);
      }
      assert.match(plans.join("\n"), /checkpoint_scopes_1 \(scope_id=\?\)/);
    }).pipe(Effect.provide(layerSql)),
);

it.effect("rebuilds a historical dispatch witness after another SQLite connection commits", () =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const filename = dir + "/dispatch.sqlite";
    const database = SqlitePersistence.layerFromPath(filename);
    yield* Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* createThread("external-writer");
      const first = yield* createRun(threadId);
      for (let ordinal = 2; ordinal <= 40; ordinal++)
        yield* createRun(threadId, "completed", ordinal);
      const read = store.getMessageDispatchProjection(threadId, { needsRunHistory: false });
      assert.isFalse((yield* read).runs.some((run) => run.id === first));
      yield* Effect.gen(function* () {
        const external = yield* SqlClient.SqlClient;
        yield* external`UPDATE orchestration_v2_projection_runs SET status = 'queued',
          payload_json = json_set(payload_json, '$.status', 'queued') WHERE run_id = ${first}`;
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename })));
      assert.equal((yield* read).runs.find((run) => run.id === first)?.status, "queued");
    }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(database))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
