/**
 * Deletes thread events older than `RETENTION_PERIOD`. The projections already hold every
 * thread's current state, and a client resuming from an older cursor gets a
 * snapshot (EventLogCompaction.canReplayAfter), so old events only grew the
 * database and slowed its cold reads.
 *
 * Below the retention floor these rows stay, because later reads need them:
 * - each thread's `thread.created`: the legacy importer re-imports a thread
 *   without one, and projection checks list threads by it;
 * - each thread's newest event: the next `stream_version` and the thread's
 *   snapshot sequence are read from it;
 * - every full subagent prompt: later rows point at it by `promptSequence`, and
 *   finding those pointers would mean parsing every retained payload;
 * - every event of a thread whose legacy transcript import has not finished:
 *   the importer reads its own message events back to skip them;
 * - project events, and anything not written by the V2 event store.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

/** How long thread events stay. Resuming needs minutes; older cursors get a snapshot. */
export const RETENTION_PERIOD = Duration.days(2);
/** Events read per slice, for both the age scan and the deletable-row scan. */
export const RETENTION_SLICE = 5_000;
/** Between raising the floor and deleting below it, so a replay that passed the old floor finishes. */
const RETENTION_GRACE = Duration.seconds(5);
/** Deletes run on the event loop's connection, and freeing a payload reads its overflow pages. */
const DELETE_BATCH_ROWS = 200;
const DELETE_BATCH_BYTES = 2 * 1024 * 1024;

/**
 * Where expired history ends, scanning from `fromSequence`: the first event at
 * or after the cutoff, so nothing newer is ever below the returned floor. An
 * event dated later than the ones after it (a clock that jumped) holds the
 * floor until it expires. `done` is false when the slice ended first.
 */
export const expiredRange = (input: {
  readonly fromSequence: number;
  readonly cutoffMillis: number;
  readonly limit?: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const limit = input.limit ?? RETENTION_SLICE;
    // Only the row's leading columns are read; payloads stay on disk.
    const rows = yield* sql<{ readonly sequence: number; readonly occurred_at: string }>`
      SELECT sequence, occurred_at FROM orchestration_events
      WHERE sequence >= ${input.fromSequence}
      ORDER BY sequence
      LIMIT ${limit}
    `.pipe(NodeSqliteClient.readOnly);
    for (const row of rows) {
      // An unreadable date counts as old rather than holding retention back forever.
      if (Date.parse(row.occurred_at) >= input.cutoffMillis) {
        return { belowSequence: row.sequence, done: true };
      }
    }
    const last = rows.at(-1);
    return {
      belowSequence: last === undefined ? input.fromSequence : last.sequence + 1,
      done: rows.length < limit,
    };
  });

/** Deletes the events in `[fromSequence, belowSequence)` that no later read needs. */
export const trimExpiredEvents = (input: {
  readonly fromSequence: number;
  readonly belowSequence: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    let afterSequence = input.fromSequence - 1;
    let deleted = 0;
    while (afterSequence < input.belowSequence - 1) {
      // Read on the reader worker. Telling a subagent prompt from other turn
      // items parses the payload, so the slice stays small.
      const rows = yield* sql<{ readonly sequence: number; readonly bytes: number }>`
        SELECT event.sequence, octet_length(event.payload_json) AS bytes
        FROM orchestration_events AS event
          INDEXED BY idx_orchestration_events_application_sequence
        WHERE event.application_event_version = 2
          AND event.sequence > ${afterSequence}
          AND event.sequence < ${input.belowSequence}
          AND event.aggregate_kind = 'thread'
          AND event.event_type <> 'thread.created'
          AND EXISTS (
            SELECT 1 FROM orchestration_events AS newer
              INDEXED BY idx_orchestration_events_agent_stream_sequence
            WHERE newer.application_event_version = 2
              AND newer.aggregate_kind = 'thread'
              AND newer.stream_id = event.stream_id
              AND newer.sequence > event.sequence
          )
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_legacy_imports AS legacy
            WHERE legacy.thread_id = event.stream_id
              AND legacy.transcript_imported_at IS NULL
          )
          AND NOT (
            event.event_type IN ('subagent.updated', 'turn-item.updated')
            AND json_type(event.payload_json, '$.promptSequence') IS NULL
            AND (
              event.event_type = 'subagent.updated'
              OR json_extract(event.payload_json, '$.type') = 'subagent'
            )
          )
        ORDER BY event.sequence
        LIMIT ${RETENTION_SLICE}
      `.pipe(NodeSqliteClient.readOnly);
      let batch: number[] = [];
      let batchBytes = 0;
      const flush = Effect.gen(function* () {
        if (batch.length === 0) return;
        yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(batch)}`;
        deleted += batch.length;
        batch = [];
        batchBytes = 0;
        // Let requests through between batches.
        yield* Effect.yieldNow;
      });
      for (const row of rows) {
        if (
          batch.length >= DELETE_BATCH_ROWS ||
          (batch.length > 0 && batchBytes + row.bytes > DELETE_BATCH_BYTES)
        ) {
          yield* flush;
        }
        batch.push(row.sequence);
        batchBytes += row.bytes;
      }
      yield* flush;
      if (rows.length < RETENTION_SLICE) break;
      afterSequence = rows[rows.length - 1]?.sequence ?? input.belowSequence;
    }
    return deleted;
  });

/**
 * Moves the floor up to the first event newer than `cutoffMillis`, one slice
 * at a time: each slice raises the floor first, then deletes below it. With
 * `sweep`, first deletes what is left below the current floor: a slice an
 * interrupted pass did not finish, and newest events a later one replaced.
 */
export const retainRecentEvents = <E, R>(input: {
  readonly cutoffMillis: number;
  readonly floor: Effect.Effect<number>;
  readonly raiseFloor: (belowSequence: number) => Effect.Effect<void, E, R>;
  readonly sweep: boolean;
}) =>
  Effect.gen(function* () {
    let deleted = 0;
    if (input.sweep) {
      deleted += yield* trimExpiredEvents({ fromSequence: 0, belowSequence: yield* input.floor });
    }
    while (true) {
      const fromSequence = yield* input.floor;
      const { belowSequence, done } = yield* expiredRange({
        fromSequence,
        cutoffMillis: input.cutoffMillis,
      });
      if (belowSequence > fromSequence) {
        yield* input.raiseFloor(belowSequence);
        yield* Effect.sleep(RETENTION_GRACE);
        deleted += yield* trimExpiredEvents({ fromSequence, belowSequence });
      }
      if (done) return deleted;
    }
  });
