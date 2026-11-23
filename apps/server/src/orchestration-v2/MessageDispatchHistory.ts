/**
 * Small in-memory summaries of a thread's run history, so accepting a message does
 * not reread a long chat.
 *
 * They stay fresh in two ways only: `ProjectionStore.apply` tells them about every
 * projection write it makes, and SQLite's `PRAGMA data_version` shows a commit made
 * by another connection. A commit by the writer connection itself never moves
 * `data_version`. So every write to the run, turn-item and provider-turn projection
 * tables must go through `apply`: a direct UPDATE or DELETE from server code leaves
 * these summaries stale without any error.
 *
 * `MessageDispatchHistory.differential.test.ts` compares these reads with the full
 * projection over randomized histories; extend it when a new decision reads from here.
 */
import {
  type MessageId,
  type ProviderTurnId,
  type RunAttemptId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Hash from "effect/Hash";
import * as SqlClient from "effect/sql/SqlClient";

// SQLite trim defaults to ASCII spaces; compact recognition uses JavaScript trim.
export const javascriptTrimWhitespace =
  " \t\n\r\v\f\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeAttempts = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
const CACHE_THREADS = 64;
const RECENT_RUNS = 16;

function remember(bits: Uint32Array, id: string) {
  const hash = Hash.string(id);
  bits[(hash >>> 5) & 2047]! |= 1 << (hash & 31);
}

function contains(bits: Uint32Array, id: string) {
  const hash = Hash.string(id);
  return (bits[(hash >>> 5) & 2047]! & (1 << (hash & 31))) !== 0;
}

function makeHistory(sql: SqlClient.SqlClient) {
  // External writers and other processes change data_version on this
  // connection. An enclosing transaction might roll back, so its callers
  // bypass both reading and populating process-local summaries.
  const dataVersion = sql<{ data_version: number }>`PRAGMA data_version`.pipe(
    Effect.map((rows) => rows[0]!.data_version),
  );
  type AttemptTurns = {
    version: number;
    seen: Uint32Array;
    recent: Map<RunAttemptId | null, Set<ProviderTurnId>>;
  };
  const turns = new Map<ThreadId, AttemptTurns>();
  const rememberTurn = (entry: AttemptTurns, attempt: RunAttemptId | null, id: ProviderTurnId) => {
    const ids = entry.recent.get(attempt);
    if (ids) {
      ids.add(id);
      if (ids.size > 32) entry.recent.delete(attempt);
    } else if (!contains(entry.seen, attempt ?? "")) {
      if (entry.recent.size >= 32) entry.recent.delete(entry.recent.keys().next().value!);
      entry.recent.set(attempt, new Set([id]));
    }
    remember(entry.seen, attempt ?? "");
  };
  const providerTurnIds = (
    threadId: ThreadId,
    attempts: readonly (RunAttemptId | null)[],
    version: number | undefined,
  ) =>
    Effect.gen(function* () {
      if (!attempts.length) return [];
      let entry = turns.get(threadId);
      if (version !== undefined && entry?.version !== version) {
        entry = { version, seen: new Uint32Array(2048), recent: new Map() };
        const rows = yield* sql<{
          provider_turn_id: ProviderTurnId;
          run_attempt_id: RunAttemptId | null;
        }>`
          SELECT provider_turn_id, run_attempt_id FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId} ORDER BY rowid`;
        for (const row of rows) rememberTurn(entry, row.run_attempt_id, row.provider_turn_id);
        if (!turns.has(threadId) && turns.size >= CACHE_THREADS)
          turns.delete(turns.keys().next().value!);
        turns.set(threadId, entry);
      }
      const ids = new Set<ProviderTurnId>();
      const missing = attempts.filter((attempt) => {
        if (!entry || version === undefined) return true;
        const known = entry.recent.get(attempt);
        if (!known) return contains(entry.seen, attempt ?? "");
        for (const id of known) ids.add(id);
        return false;
      });
      if (missing.length > 0) {
        const rows = yield* sql<{
          provider_turn_id: ProviderTurnId;
          run_attempt_id: RunAttemptId | null;
        }>`
          SELECT provider_turn_id, run_attempt_id FROM orchestration_v2_projection_provider_turns
          WHERE thread_id = ${threadId} AND (run_attempt_id IN (SELECT value FROM json_each(${encodeAttempts(missing)})) OR (${missing.includes(null) ? 1 : 0} AND run_attempt_id IS NULL))`;
        for (const row of rows) ids.add(row.provider_turn_id);
        if (entry && version !== undefined) {
          for (const attempt of missing) {
            const matches = rows
              .filter((row) => row.run_attempt_id === attempt)
              .map((row) => row.provider_turn_id);
            if (matches.length > 32) continue;
            if (entry.recent.size >= 32) entry.recent.delete(entry.recent.keys().next().value!);
            entry.recent.set(attempt, new Set(matches));
          }
        }
      }
      return [...ids];
    });
  // A negative membership test avoids searching every user message when a
  // fresh send queues. A collision, update or rolled-back insertion can only
  // cause an extra lookup. SQLite decides the actual legacy item and order.
  const messageBuckets = new Map<ThreadId, { bits: Uint32Array; version: number }>();
  const mayHaveUserItem = (threadId: ThreadId, messageId: MessageId, version: number | undefined) =>
    Effect.gen(function* () {
      if (version === undefined) return true;

      let entry = messageBuckets.get(threadId);
      if (entry?.version !== version) {
        const bits = new Uint32Array(2048);
        const rows = yield* sql<{ id: string }>`
        SELECT json_extract(payload_json, '$.messageId') AS id FROM orchestration_v2_projection_turn_items
        INDEXED BY orchestration_v2_projection_turn_items_user_message_idx
        WHERE thread_id = ${threadId} AND type = 'user_message'
      `;
        for (const row of rows) remember(bits, row.id);
        entry = { bits, version };
        if (!messageBuckets.has(threadId) && messageBuckets.size >= CACHE_THREADS)
          messageBuckets.delete(messageBuckets.keys().next().value!);
        messageBuckets.set(threadId, entry);
      }
      return contains(entry.bits, messageId);
    });
  // Keep only the run IDs that can still affect an ordinary send before
  // the recent ordinal range. Reads always fetch their current payloads.
  const dispatchPrefixes = new Map<
    ThreadId,
    {
      through: number;
      dataVersion: number;
      ids: ReadonlySet<RunId>;
      recent: Set<RunId>;
      visible?: { through: number; runId: RunId | null; itemId: string | null };
    }
  >();
  function observe(event: OrchestrationV2DomainEvent) {
    if (event.type === "thread.created") {
      dispatchPrefixes.delete(event.threadId);
      messageBuckets.delete(event.threadId);
      turns.delete(event.threadId);
    }
    if (event.type === "provider-turn.updated") {
      const cached = turns.get(event.threadId);
      // Final SQL checks the attempt again, so stale positive IDs are safe.
      // Include new turns even if this write is subsequently rolled back.
      if (cached) rememberTurn(cached, event.payload.runAttemptId, event.payload.id);
    }
    if (event.type === "turn-item.updated" && event.payload.type === "user_message") {
      const cached = messageBuckets.get(event.payload.threadId);
      if (cached) remember(cached.bits, event.payload.messageId);
    }
    if (event.type === "turn-item.updated") {
      // Losing the chosen row can expose any earlier run. A newly visible
      // row in the old range can also become the winner.
      for (const [threadId, prefix] of dispatchPrefixes) {
        if (!prefix.visible) continue;
        if (
          prefix.visible.itemId === event.payload.id ||
          (threadId === event.payload.threadId &&
            event.payload.runId !== null &&
            !prefix.recent.has(event.payload.runId) &&
            (event.payload.type === "user_message" || event.payload.type === "notification"))
        ) {
          delete prefix.visible;
        }
      }
    }
    if (event.type !== "run.created" && event.type !== "run.updated") return;
    // A rewrite can move a witness past the cutoff. Removing a nonwinner
    // cannot change an aggregate; removing a winner requires a fresh read.
    for (const [threadId, prefix] of dispatchPrefixes) {
      if (
        (threadId === event.payload.threadId && event.payload.ordinal <= prefix.through) ||
        prefix.ids.has(event.payload.id) ||
        prefix.visible?.runId === event.payload.id
      )
        dispatchPrefixes.delete(threadId);
    }
  }

  const runIds = (
    threadId: ThreadId,
    targetRunId: RunId | undefined,
    version: number | undefined,
  ) =>
    Effect.gen(function* () {
      const tail = yield* sql<{ ordinal: number }>`
          SELECT ordinal FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
          ORDER BY ordinal DESC LIMIT 1
        `;
      const end = tail[0]?.ordinal ?? 0;
      const ids = new Set<RunId>();
      if (targetRunId !== undefined) ids.add(targetRunId);
      let through = 0;
      if (end > 2 * RECENT_RUNS) {
        const prior = version !== undefined ? dispatchPrefixes.get(threadId) : undefined;
        const cached =
          prior && prior.dataVersion === version && end >= prior.through ? prior : undefined;
        if (cached && end - cached.through <= 2 * RECENT_RUNS) {
          through = cached.through;
          for (const id of cached.ids) ids.add(id);
        } else {
          through = end - RECENT_RUNS;
          // Cold start or an old run changed. Only read the scalar inputs to
          // the historical decisions; transcript and run bodies stay in SQLite.
          type HistoryRow = {
            run_id: string;
            ordinal: number;
            status: OrchestrationV2Run["status"];
            completed_at: string | null;
            started_at: string | null;
            retry: string | null;
            preparation: string | null;
          };
          const columns = sql`run_id, ordinal, status, completed_at, json_extract(payload_json, '$.startedAt') AS started_at,
                json_extract(payload_json, '$.automaticProviderRetry.status') AS retry,
                json_extract(payload_json, '$.workspacePreparation.type') AS preparation`;
          const rows = yield* sql<HistoryRow>`
              SELECT ${columns} FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId}
                AND ordinal > ${cached?.through ?? 0} AND ordinal <= ${through}
              ${
                cached
                  ? sql`UNION ALL SELECT ${columns} FROM orchestration_v2_projection_runs
                INDEXED BY sqlite_autoindex_orchestration_v2_projection_runs_1
                WHERE thread_id = ${threadId} AND run_id IN (SELECT value FROM json_each(${encodeIds([...cached.ids])}))`
                  : sql``
              }
              ORDER BY ordinal
            `;

          let executed: HistoryRow | undefined;
          let model: HistoryRow | undefined;
          let handoff: HistoryRow | undefined;
          let started: HistoryRow | undefined;
          let completed: HistoryRow | undefined;
          let worktreeFailure: HistoryRow | undefined;
          const prefixIds = new Set<RunId>();
          // Stored times are canonical UTC ISO. An unfinished run sorts last,
          // and iteration by ordinal supplies the same tie break as runRanAfter.
          const later = (row: HistoryRow, prior: HistoryRow | undefined) =>
            prior === undefined ||
            row.completed_at === null ||
            (prior.completed_at !== null && row.completed_at >= prior.completed_at);
          for (const row of rows) {
            if (
              ["queued", "preparing", "starting", "running", "waiting"].includes(row.status) ||
              row.retry === "scheduled"
            )
              prefixIds.add(RunId.make(row.run_id));
            if (["completed", "interrupted", "failed"].includes(row.status)) handoff = row;
            if (row.started_at && (!started?.started_at || row.started_at >= started.started_at))
              started = row;
            if (row.status === "completed") completed = row;
            if (
              (row.status === "failed" || row.status === "interrupted") &&
              row.preparation === "worktree"
            )
              worktreeFailure = row;
            if (row.status === "queued") continue;
            if (row.status !== "rolled_back" && later(row, model)) model = row;
            if (!(row.status === "cancelled" && row.started_at === null) && later(row, executed))
              executed = row;
          }
          for (const row of [
            executed,
            model,
            completed,
            handoff,
            started,
            worktreeFailure,
            rows.at(-1),
          ])
            if (row) prefixIds.add(RunId.make(row.run_id));
          for (const id of prefixIds) ids.add(id);
          if (version !== undefined) dispatchPrefixes.delete(threadId);
          if (version !== undefined && prefixIds.size <= 32) {
            if (dispatchPrefixes.size >= CACHE_THREADS)
              dispatchPrefixes.delete(dispatchPrefixes.keys().next().value!);
            dispatchPrefixes.set(threadId, {
              through,
              ids: prefixIds,
              dataVersion: version,
              recent: new Set(),
              ...(cached?.visible ? { visible: cached.visible } : {}),
            });
          }
        }
      }
      const recent = yield* sql<{ run_id: string }>`
          SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND ordinal > ${through}
          ORDER BY ordinal
        `;
      const prefix = version === undefined ? undefined : dispatchPrefixes.get(threadId);
      if (prefix && prefix.dataVersion === version)
        prefix.recent = new Set(recent.map((row) => RunId.make(row.run_id)));
      for (const row of recent) ids.add(RunId.make(row.run_id));
      return [...ids];
    });

  // Only hidden starts need the last timeline row. Extend the cached ordinal
  // prefix with newly aged runs, then compare its winner with the short tail.
  const latestShownRun = (
    threadId: ThreadId,
    ids: readonly RunId[] | undefined,
    version: number | undefined,
  ) =>
    Effect.gen(function* () {
      const prefix =
        version === undefined || ids === undefined ? undefined : dispatchPrefixes.get(threadId);
      const find = (
        candidates: readonly RunId[] | undefined,
        range?: { after: number; through: number },
      ) => {
        const columns = sql`run_id, ordinal, completed_at, json_type(payload_json, '$.contextHandoffId') = 'text' AS handoff`;
        const exact = (
          keys: readonly RunId[],
        ) => sql`SELECT ${columns} FROM orchestration_v2_projection_runs
          INDEXED BY sqlite_autoindex_orchestration_v2_projection_runs_1 WHERE thread_id = ${threadId}
          AND status NOT IN ('rolled_back','queued') AND run_id IN (SELECT value FROM json_each(${encodeIds(keys)}))`;
        const runs =
          range || candidates === undefined
            ? sql`SELECT ${columns} FROM orchestration_v2_projection_runs
        WHERE thread_id = ${threadId} AND status NOT IN ('rolled_back','queued')
        ${range ? sql`AND ordinal > ${range.after} AND ordinal <= ${range.through}` : sql``}
        ${candidates?.length ? sql`UNION ALL ${exact(candidates)}` : sql``}`
            : exact(candidates);
        return sql<{ run_id: RunId; item_id: string | null }>`
        SELECT candidate.run_id, CASE WHEN candidate.handoff THEN '' ELSE (
          SELECT item.turn_item_id FROM orchestration_v2_projection_turn_items AS item
            INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
          WHERE item.thread_id = ${threadId} AND item.run_id = candidate.run_id AND (
            item.type = 'notification' OR (item.type = 'user_message'
              AND NOT (json_extract(item.payload_json, '$.inputIntent') IS 'queued_turn' AND item.status = 'pending')
              AND NOT (lower(trim(json_extract(item.payload_json, '$.text'), ${javascriptTrimWhitespace})) = '/compact'
                AND json_array_length(item.payload_json, '$.attachments') = 0)))
          LIMIT 1) END AS item_id
        FROM (SELECT * FROM (${runs}) ORDER BY completed_at IS NULL DESC, completed_at DESC, ordinal DESC LIMIT -1 OFFSET 0) AS candidate
        WHERE item_id IS NOT NULL LIMIT 1`;
      };
      if (!prefix || prefix.dataVersion !== version) return (yield* find(undefined))[0]?.run_id;
      if (prefix.visible?.through !== prefix.through) {
        const prior = prefix.visible;
        const winner = (yield* find(prior?.runId ? [prior.runId] : [], {
          after: prior?.through ?? 0,
          through: prefix.through,
        }))[0];
        prefix.visible = {
          through: prefix.through,
          runId: winner?.run_id ?? null,
          itemId: winner?.item_id ?? null,
        };
      }
      const keys = prefix.visible.runId ? [...ids!, prefix.visible.runId] : ids!;
      return (yield* find(keys))[0]?.run_id;
    });
  return { dataVersion, runIds, observe, mayHaveUserItem, providerTurnIds, latestShownRun };
}

const histories = new WeakMap<SqlClient.SqlClient, ReturnType<typeof makeHistory>>();
export const makeMessageDispatchHistory = Effect.map(SqlClient.SqlClient, (sql) => {
  const existing = histories.get(sql);
  if (existing) return existing;
  const history = makeHistory(sql);
  histories.set(sql, history);
  return history;
});
