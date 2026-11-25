// @effect-diagnostics nodeBuiltinImport:off - The live timing CLI uses native SQLite in an isolated process.
import * as NodeCrypto from "node:crypto";
import { MessageId, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Reactivity from "effect/reactivity/Reactivity";
import type { Connection } from "effect/sql/SqlConnection";
import * as EffectOutbox from "../../orchestration-v2/EffectOutbox.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { encodeThreadHistoryCursor } from "../../orchestration-v2/threadHistoryPaging.ts";
import { readSearchBackfillBatch } from "../../orchestration-v2/ThreadSearch.ts";
import { listDueTasks } from "../../scheduledTasks/ScheduledTaskService.ts";
import * as AuthSessions from "../AuthSessions.ts";
import * as OrchestrationEventStore from "../OrchestrationEventStore.ts";

export interface HotReadSample {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly itemId: TurnItemId;
  readonly messageId: MessageId;
  readonly cursor: string;
  readonly afterSequence: number;
  readonly throughSequence: number;
}

const readStatement = /^(?:\s*--[^\n]*\n|\s*\/\*[\s\S]*?\*\/)*\s*(?:SELECT|WITH|PRAGMA)\b/i;

const hotRead =
  <A, E, R>(run: (input: HotReadSample) => Effect.Effect<A, E, R>) =>
  (input: HotReadSample) =>
    Effect.asVoid(run(input));
const projectionRead = <A, E>(
  run: (
    store: ProjectionStore.ProjectionStoreV2["Service"],
    input: HotReadSample,
  ) => Effect.Effect<A, E>,
) =>
  hotRead((input) =>
    Effect.flatMap(ProjectionStore.ProjectionStoreV2, (store) => run(store, input)),
  );

// Keep the CLI and EXPLAIN checks on the production entry points, including
// their conditional SQL fragments. The dispatch guards exercise writes separately.
export const hotReads = {
  "snapshot.recent": projectionRead((store, { threadId }) =>
    store.getThreadSnapshotWindow(threadId, { rowLimit: 80, userTurnLimit: 6, forWire: true }),
  ),
  "history.older": projectionRead((store, { threadId, cursor }) =>
    store.getThreadHistoryPage(threadId, cursor),
  ),
  "history.conversation": projectionRead((store, { threadId, cursor }) =>
    store.getThreadHistoryPage(threadId, cursor, undefined, true),
  ),
  "history.media": projectionRead((store, { threadId, cursor }) =>
    store.getThreadMediaPage(threadId, cursor),
  ),
  "timeline.messages": projectionRead((store, { threadId }) =>
    store.getTimelinePage(threadId, { view: "messages", fromEnd: true, limit: 20 }),
  ),
  "timeline.activity": projectionRead((store, { threadId }) =>
    store.getTimelinePage(threadId, { view: "activity", fromEnd: true, limit: 20 }),
  ),
  "timeline.item": projectionRead((store, { threadId, itemId }) =>
    store.getTimelinePage(threadId, { view: "activity", itemId, limit: 1 }),
  ),
  "shell.active": projectionRead((store) =>
    store.getShellSnapshot({ location: "active", omitIdleSubagents: "all" }),
  ),
  "shell.archive": projectionRead((store) => store.getShellSnapshot({ location: "archive" })),
  "shell.family": projectionRead((store, { threadId }) =>
    store.getShellSnapshot({ location: "active", subagentFamilyOf: threadId }),
  ),
  "shell.thread": projectionRead((store, { threadId }) => store.getThreadShell(threadId)),
  "shell.visits": projectionRead((store) => store.getChatVisitSnapshot()),
  "pull-requests.active": projectionRead((store) =>
    store.getPullRequestSnapshot({ unsettledOnly: true }),
  ),
  "pull-requests.thread": projectionRead((store, { threadId }) =>
    store.getPullRequestSnapshot({ threadId }),
  ),
  "settlement.candidates": projectionRead((store) => store.getSettlementCandidates()),
  "recovery.runtime": projectionRead((store, { threadId }) =>
    store.getRuntimeRecoveryProjection(threadId),
  ),
  "recovery.boot.queued-runs": projectionRead((store) => store.getRecoveryThreadIds("queued-runs")),
  "recovery.boot.steer-when-live": projectionRead((store) =>
    store.getRecoveryThreadIds("steer-when-live"),
  ),
  "recovery.boot.runtime": projectionRead((store) => store.getRecoveryThreadIds("runtime")),
  "recovery.boot.subagent-activity": projectionRead((store) =>
    store.getRecoveryThreadIds("subagent-activity"),
  ),
  "recovery.boot.subagent-results": projectionRead((store) =>
    store.getRecoveryThreadIds("subagent-results"),
  ),
  "recovery.boot.delegated-completions": projectionRead((store) =>
    store.getRecoveryThreadIds("delegated-completions"),
  ),
  "recovery.limits": projectionRead((store) =>
    Effect.flatMap(DateTime.now, (now) =>
      store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: true }),
    ),
  ),
  "recovery.sign-in": projectionRead((store) =>
    Effect.flatMap(DateTime.now, (since) =>
      store.getSignedOutStops({
        since: DateTime.add(since, { days: -1 }),
        messageContains: "sign in",
      }),
    ),
  ),
  "recovery.live-models": projectionRead((store) => store.getLiveThreadModels()),
  "recovery.retry": projectionRead((store) =>
    Effect.flatMap(DateTime.now, store.getProviderRetryCandidates),
  ),
  "dispatch.message": projectionRead((store, { threadId, runId, messageId }) =>
    store.getMessageDispatchProjection(threadId, {
      messageId,
      targetRunId: runId,
      needsRunHistory: false,
      pendingHistoryEdits: true,
    }),
  ),
  "dispatch.queued": projectionRead((store, { threadId }) =>
    store.getMessageDispatchProjection(threadId, { queuedStart: true, needsRunHistory: false }),
  ),
  "dispatch.pending-input": projectionRead((store, { threadId }) =>
    store.getThreadRecords(threadId, ["runtimeRequests", "nodes", "turnItems"], {
      pendingRuntimeRequestControls: true,
      turnItemTypes: ["approval_request", "user_input_request"],
    }),
  ),
  "dispatch.turn-start": projectionRead((store, { threadId, runId }) =>
    store.getTurnStartContext(threadId, runId),
  ),
  "dispatch.turn-history": projectionRead((store, { threadId, runId }) =>
    store.getTurnStartHistory(threadId, [runId]),
  ),
  "dispatch.run-message": projectionRead((store, { threadId, runId }) =>
    store.getRunMessage(threadId, runId),
  ),
  "dispatch.run-nodes": projectionRead((store, { threadId, runId }) =>
    store.getThreadRecords(threadId, ["nodes"], { nodeRunIds: [runId] }),
  ),
  "dispatch.subagent-activity": projectionRead((store, { threadId }) =>
    store.getSubagentActivityState(threadId),
  ),
  "dispatch.subagent-records": projectionRead((store, { threadId }) =>
    store.getThreadRecords(threadId, ["subagents"]),
  ),
  "dispatch.transfers": projectionRead((store, { threadId }) =>
    store.getThreadRecords(threadId, ["contextTransfers"]),
  ),
  "auth.active-sessions": hotRead(() =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      yield* sessions.listActive({ now: yield* DateTime.now });
    }),
  ),
  "dispatch.running-turn": projectionRead((store, { threadId }) =>
    store.getRunningTurnContext(threadId),
  ),
  "dispatch.provider": projectionRead((store, { threadId }) =>
    store.getThreadProviderContext(threadId),
  ),
  "replay.watermarks": hotRead(({ threadId }) =>
    Effect.gen(function* () {
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      yield* events.latestApplicationSequence;
      yield* events.latestAgentSequence(threadId);
    }),
  ),
  "replay.thread": hotRead(({ threadId, afterSequence, throughSequence }) =>
    Effect.gen(function* () {
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      yield* events.getAgentReplayStats({
        threadId,
        afterSequence,
        throughSequence,
        maxEvents: 50,
      });
      yield* Stream.runDrain(
        events.readAgentEvents({
          threadId,
          afterSequence,
          throughSequence,
          limit: 50,
          skipUnknownEventTypes: true,
        }),
      );
    }),
  ),
  "replay.shell": hotRead(({ afterSequence, throughSequence }) =>
    Effect.gen(function* () {
      const events = yield* OrchestrationEventStore.OrchestrationEventStore;
      yield* events.getReplayStats({ afterSequence, throughSequence });
      yield* Stream.runDrain(
        events.readApplicationEvents({
          afterSequence,
          throughSequence,
          skipUnknownEventTypes: true,
        }),
      );
    }),
  ),
  "search.backfill": hotRead(() =>
    Effect.flatMap(SqlClient.SqlClient, (sql) => readSearchBackfillBatch(sql, 0)),
  ),
  "scheduler.due": hotRead(() => Effect.flatMap(DateTime.now, listDueTasks)),
  "outbox.next": hotRead(() =>
    Effect.flatMap(EffectOutbox.EffectOutboxV2, (outbox) => outbox.nextClaimableAt),
  ),
};

export const layerHotReads = Layer.mergeAll(
  ProjectionStore.layer,
  OrchestrationEventStore.layer,
  EffectOutbox.layer,
  AuthSessions.layer,
);

export const observeReads = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  observe: (query: string, params: ReadonlyArray<unknown>) => void,
) =>
  effect.pipe(
    Effect.provideService(Statement.CurrentTransformer, (statement) =>
      Effect.sync(() => {
        const [query, params] = statement.compile();
        if (readStatement.test(query)) observe(query, params);
        return statement;
      }),
    ),
  );

const selectSample = (ordinal: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Rank a bounded set of recent chats by their last indexed item. This
    // exercises busy histories without counting rows across the live database.
    const candidates = yield* sql<{ thread_id: string }>`
      WITH recent AS MATERIALIZED (
        SELECT thread_id FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND archived_at IS NULL
        ORDER BY rowid DESC LIMIT 64
      )
      SELECT recent.thread_id
      FROM recent
      ORDER BY (
        SELECT item.ordinal FROM orchestration_v2_projection_turn_items AS item
        WHERE item.thread_id = recent.thread_id ORDER BY item.ordinal DESC LIMIT 1
      ) DESC, recent.thread_id
      LIMIT 8
    `;
    const candidate = candidates[ordinal % candidates.length];
    if (candidate === undefined) return undefined;
    const threadId = ThreadId.make(candidate.thread_id);
    const [items, runs, events] = yield* Effect.all([
      sql<{ turn_item_id: string; ordinal: number }>`
        SELECT turn_item_id, ordinal FROM orchestration_v2_projection_turn_items
        WHERE thread_id = ${threadId}
        ORDER BY ordinal DESC, turn_item_id DESC LIMIT 1
      `,
      sql<{ run_id: string; message_id: string }>`
        SELECT run_id, json_extract(payload_json, '$.userMessageId') AS message_id
        FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} ORDER BY ordinal DESC LIMIT 1
      `,
      sql<{ sequence: number }>`
        SELECT sequence FROM orchestration_events INDEXED BY idx_orchestration_events_agent_stream_sequence
        WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${threadId}
        ORDER BY sequence DESC LIMIT 51
      `,
    ]);
    const item = items[0];
    const run = runs[0];
    if (item === undefined || run === undefined || !run.message_id) return undefined;
    const itemId = TurnItemId.make(item.turn_item_id);
    return {
      threadId,
      itemId,
      runId: RunId.make(run.run_id),
      messageId: MessageId.make(run.message_id),
      cursor: encodeThreadHistoryCursor({
        snapshotSequence: events[0]?.sequence ?? 0,
        sourceThreadId: threadId,
        sourceItemId: itemId,
        position: item.ordinal,
      }),
      throughSequence: events[0]?.sequence ?? 0,
      // Thread events can be sparse across the application log. Bound the
      // shell replay as well as the per-thread SELECT.
      afterSequence: Math.max((events[0]?.sequence ?? 0) - 50, events.at(-1)?.sequence ?? 0),
    } satisfies HotReadSample;
  });

export type TimingEvent =
  | { readonly type: "start"; readonly query: string }
  | { readonly type: "finish"; readonly query: string; readonly ms: number }
  | { readonly type: "no-sample" };

export const timeHotRead = (
  database: string,
  name: keyof typeof hotReads,
  samples: number,
  send: (event: TimingEvent) => void,
) => {
  let group = "sample";
  const layerTimedReads = Layer.effect(
    SqlClient.SqlClient,
    Effect.gen(function* () {
      const native = yield* SqlClient.SqlClient;
      const connection = yield* native.reserve;
      const clock = yield* Clock.Clock;
      const time = <A, E>(query: string, run: () => Effect.Effect<A, E>) =>
        Effect.suspend(() => {
          if (!readStatement.test(query)) return run();
          const table = /\bFROM\s+(\w+)/i
            .exec(query)?.[1]
            ?.replace(/^orchestration_v2_projection_/, "");
          const digest = NodeCrypto.createHash("sha256")
            .update(query.trim().replace(/\?(?:,\s*\?)+/g, "?"))
            .digest("hex")
            .slice(0, 8);
          const label = [group, table, digest].filter(Boolean).join("/");
          send({ type: "start", query: label });
          const started = clock.monotonicTimeNanosUnsafe();
          return run().pipe(
            Effect.ensuring(
              Effect.sync(() =>
                send({
                  type: "finish",
                  query: label,
                  ms: Number(clock.monotonicTimeNanosUnsafe() - started) / 1_000_000,
                }),
              ),
            ),
          );
        });
      const measured: Connection = {
        execute: (query, params, transform) =>
          time(query, () => connection.execute(query, params, transform)),
        executeRaw: (query, params) => time(query, () => connection.executeRaw(query, params)),
        executeStream: connection.executeStream,
        executeValues: (query, params) =>
          time(query, () => connection.executeValues(query, params)),
        executeValuesUnprepared: (query, params) =>
          time(query, () => connection.executeValuesUnprepared(query, params)),
        executeUnprepared: (query, params, transform) =>
          time(query, () => connection.executeUnprepared(query, params, transform)),
      };
      return yield* SqlClient.make({
        acquirer: Effect.succeed(measured),
        compiler: Statement.makeCompilerSqlite(),
        spanAttributes: [],
      });
    }),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        Reactivity.layer,
        NodeSqliteClient.layer({ filename: database, readonly: true }),
      ),
    ),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA busy_timeout = 100`;
      const journal = yield* sql<{ journal_mode: string }>`PRAGMA journal_mode`;
      if (journal[0]?.journal_mode !== "wal")
        return yield* Effect.die("WAL required for live reads");
      for (let index = 0; index < samples; index++) {
        group = "sample";
        const sample = yield* selectSample(index);
        if (sample === undefined) {
          send({ type: "no-sample" });
          continue;
        }
        group = name;
        yield* hotReads[name](sample);
      }
    }).pipe(Effect.provide(Layer.provideMerge(layerHotReads, layerTimedReads))),
  );
};
