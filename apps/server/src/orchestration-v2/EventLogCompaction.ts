/**
 * Keeps the event log from growing without bound. Each `turn-item.updated`
 * event carries the item's whole state, so a running tool stored one full copy
 * per update and the log grew by gigabytes a week. Per item, a compaction
 * window keeps its first copy (replay assigns positions on first write) and its
 * last (the state replay ends on), plus full subagent prompts that later
 * updates can reference, and deletes the rest. Retention then deletes whole
 * events once they are two days old (EventLogRetention.RETENTION_PERIOD), and
 * aging shrinks the tool outputs of turn items a week old (TurnItemAging).
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as EventLogRetention from "./EventLogRetention.ts";
import * as TurnItemAging from "./TurnItemAging.ts";

const COMPACTION_INTERVAL = Duration.minutes(10);
const DELETE_BATCH_SIZE = 500;
/** History left from before a start is read in small slices, after startup settles. */
const BACKLOG_DELAY = Duration.minutes(2);
const BACKLOG_PAUSE = Duration.seconds(5);
export const BACKLOG_CHUNK = 5_000;
/**
 * How far compaction got, so a restart neither skips nor rereads history, and
 * where complete history starts. Offline maintenance writes `retainedFrom` too.
 */
export const CURSOR_FILE = "event-log-compaction.json";

export interface EventLogCursorState {
  /** Compaction has read every event up to this sequence. */
  readonly through: number;
  /**
   * Events below this sequence may be gone; only each thread's creation, its
   * newest event, subagent prompt anchors and project events are sure to stay.
   * Every event from it on is stored, so only a replay after `retainedFrom - 1`
   * or later is complete.
   */
  readonly retainedFrom: number;
  /** Turn item rows up to this rowid had their tool outputs aged (TurnItemAging). */
  readonly agedThrough: number;
}

const encodeCursor = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      through: Schema.Number,
      retainedFrom: Schema.Number,
      agedThrough: Schema.Number,
    }),
  ),
);

const sequenceField = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

export const parseCursor = (text: string): EventLogCursorState => {
  const parsed = Option.getOrUndefined(decodeJson(text));
  return Predicate.isObject(parsed)
    ? {
        through: sequenceField(parsed.through),
        retainedFrom: sequenceField(parsed.retainedFrom),
        agedThrough: sequenceField(parsed.agedThrough),
      }
    : { through: 0, retainedFrom: 0, agedThrough: 0 };
};

/** The cursor file, read once at startup and kept in memory. */
export class EventLogCursor extends Context.Service<
  EventLogCursor,
  {
    readonly get: Effect.Effect<EventLogCursorState>;
    /**
     * Saves to memory, then to the file. `retainedFrom` only rises; raise it
     * before deleting below it, so no replay starts in a range being trimmed.
     */
    readonly save: (
      patch: Partial<EventLogCursorState>,
    ) => Effect.Effect<void, PlatformError.PlatformError>;
  }
>()("t3/orchestration-v2/EventLogCompaction/EventLogCursor") {}

/**
 * Whether every event after `afterSequence` is still stored. A client resuming
 * from an older cursor needs a snapshot: its replay would silently skip events.
 */
export const canReplayAfter = (afterSequence: number) =>
  EventLogCursor.use((cursor) => cursor.get).pipe(
    Effect.map(({ retainedFrom }) => afterSequence + 1 >= retainedFrom),
  );

const latestEventSequence = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly sequence: number | null }>`
    SELECT MAX(sequence) AS sequence FROM orchestration_events
  `;
  return rows[0]?.sequence ?? 0;
});

const latestTurnItemRowId = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly row_id: number | null }>`
    SELECT MAX(rowid) AS row_id FROM orchestration_v2_projection_turn_items
  `;
  return rows[0]?.row_id ?? 0;
});

export const layerCursor = Layer.effect(
  EventLogCursor,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const config = yield* ServerConfig.ServerConfig;
    const cursorPath = path.join(config.stateDir, CURSOR_FILE);
    const saved = yield* fs.readFileString(cursorPath).pipe(
      Effect.map(parseCursor),
      Effect.orElseSucceed(() => parseCursor("")),
    );
    const latest = yield* latestEventSequence.pipe(Effect.orDie);
    const latestTurnItem = yield* latestTurnItemRowId.pipe(Effect.orDie);
    // A cursor past the end belongs to another (restored or replaced) database.
    let state: EventLogCursorState = {
      through: saved.through > latest ? 0 : saved.through,
      retainedFrom: saved.retainedFrom > latest + 1 ? 0 : saved.retainedFrom,
      agedThrough: saved.agedThrough > latestTurnItem ? 0 : saved.agedThrough,
    };
    const writes = yield* Semaphore.make(1);
    const save = (patch: Partial<EventLogCursorState>) =>
      writes.withPermits(1)(
        Effect.gen(function* () {
          state = {
            through: patch.through ?? state.through,
            retainedFrom: Math.max(state.retainedFrom, patch.retainedFrom ?? 0),
            agedThrough: patch.agedThrough ?? state.agedThrough,
          };
          yield* fs.writeFileString(`${cursorPath}.tmp`, encodeCursor(state));
          yield* fs.rename(`${cursorPath}.tmp`, cursorPath);
        }),
      );
    return EventLogCursor.of({ get: Effect.sync(() => state), save });
  }),
);

/** A cursor that lives only in memory, for tests that resume replays. */
export const layerCursorMemory = (initial?: Partial<EventLogCursorState>) =>
  Layer.sync(EventLogCursor, () => {
    let state: EventLogCursorState = { through: 0, retainedFrom: 0, agedThrough: 0, ...initial };
    return EventLogCursor.of({
      get: Effect.sync(() => state),
      save: (patch) =>
        Effect.sync(() => {
          state = {
            through: patch.through ?? state.through,
            retainedFrom: Math.max(state.retainedFrom, patch.retainedFrom ?? 0),
            agedThrough: patch.agedThrough ?? state.agedThrough,
          };
        }),
    });
  });

/** Sequences to delete from one window: every copy of an item but its first and last. */
export const supersededTurnItemSequences = (
  rows: ReadonlyArray<{ readonly sequence: number; readonly item_id: string | null }>,
): number[] => {
  const byItem = new Map<string, number[]>();
  for (const row of rows) {
    if (row.item_id === null) continue;
    const sequences = byItem.get(row.item_id);
    if (sequences === undefined) byItem.set(row.item_id, [row.sequence]);
    else sequences.push(row.sequence);
  }
  const superseded: number[] = [];
  for (const sequences of byItem.values()) {
    sequences.sort((left, right) => left - right);
    superseded.push(...sequences.slice(1, -1));
  }
  return superseded.sort((left, right) => left - right);
};

export const compactTurnItemWindow = (input: {
  readonly afterSequence: number;
  readonly throughSequence: number;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if (input.throughSequence <= input.afterSequence) return 0;
    // Read on the reader worker; payloads can be megabytes each.
    const rows = yield* sql
      .withTransaction(
        sql<{
          readonly sequence: number;
          readonly item_id: string | null;
          readonly prompt_anchor: number | null;
        }>`
          SELECT sequence, json_extract(payload_json, '$.id') AS item_id,
            json_extract(payload_json, '$.type') = 'subagent'
              AND json_type(payload_json, '$.promptSequence') IS NULL AS prompt_anchor
          FROM orchestration_events
          WHERE sequence > ${input.afterSequence}
            AND sequence <= ${input.throughSequence}
            AND application_event_version = 2
            AND event_type = 'turn-item.updated'
        `,
      )
      .pipe(NodeSqliteClient.readOnly);
    // Keep every full prompt: references can live outside this window, and the
    // event store's cached prompt hint can reuse an anchor on a future append.
    const promptAnchors = new Set(
      rows.filter((row) => row.prompt_anchor === 1).map((row) => row.sequence),
    );
    const superseded = supersededTurnItemSequences(rows).filter(
      (sequence) => !promptAnchors.has(sequence),
    );
    for (let start = 0; start < superseded.length; start += DELETE_BATCH_SIZE) {
      const batch = superseded.slice(start, start + DELETE_BATCH_SIZE);
      yield* sql`DELETE FROM orchestration_events WHERE sequence IN ${sql.in(batch)}`;
      // Deletes run on the event loop's connection; let requests through between batches.
      yield* Effect.yieldNow;
    }
    return superseded.length;
  });

/**
 * Every ten minutes, compacts the events written before the previous pass, so
 * an item still streaming in the newest window is left alone until it settles.
 * History written before this start (an unfinished window, or older backlog)
 * is compacted once in small slices; the saved cursor keeps restarts from
 * rereading it.
 */
const layerCompaction = Layer.effectDiscard(
  Effect.gen(function* () {
    const cursor = yield* EventLogCursor;
    const saveCursor = (through: number) =>
      cursor.save({ through }).pipe(Effect.ignore({ log: true }));
    const saved = yield* cursor.get;
    const startedAt = yield* latestEventSequence;
    // Events below the floor are trimmed already; there is nothing left to compact.
    let compactedThrough = Math.min(startedAt, Math.max(saved.through, saved.retainedFrom - 1));
    let pendingThrough: number | undefined;

    // Slices keep each read and delete burst small; every slice is a window of its own.
    const compactUpTo = (target: number) =>
      Effect.gen(function* () {
        while (compactedThrough < target) {
          const through = Math.min(compactedThrough + BACKLOG_CHUNK, target);
          const deleted = yield* compactTurnItemWindow({
            afterSequence: compactedThrough,
            throughSequence: through,
          });
          if (deleted > 0) yield* Effect.logDebug("Compacted streamed turn items", { deleted });
          compactedThrough = through;
          yield* saveCursor(through);
          if (compactedThrough < target) yield* Effect.sleep(BACKLOG_PAUSE);
        }
      });

    const pass = Effect.gen(function* () {
      const latest = yield* latestEventSequence;
      if (pendingThrough !== undefined) yield* compactUpTo(pendingThrough);
      pendingThrough = latest;
    });

    const logSkip = Effect.catchCause((cause) =>
      Effect.logWarning("Event log compaction skipped", { cause }),
    );
    yield* forkParked(
      Effect.sleep(BACKLOG_DELAY).pipe(
        Effect.andThen(compactUpTo(startedAt).pipe(logSkip)),
        Effect.andThen(pass.pipe(logSkip, Effect.repeat(Schedule.spaced(COMPACTION_INTERVAL)))),
      ),
    );
  }),
);

/**
 * Every ten minutes, deletes thread events older than the retention period and raises the
 * floor past them (see EventLogRetention). The first pass after a start also
 * clears what is left below the floor.
 */
const layerRetention = Layer.effectDiscard(
  Effect.gen(function* () {
    const cursor = yield* EventLogCursor;
    let sweep = true;
    const pass = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const deleted = yield* EventLogRetention.retainRecentEvents({
        cutoffMillis: now - Duration.toMillis(EventLogRetention.RETENTION_PERIOD),
        floor: cursor.get.pipe(Effect.map((state) => state.retainedFrom)),
        raiseFloor: (retainedFrom) => cursor.save({ retainedFrom }),
        sweep,
      });
      sweep = false;
      if (deleted > 0) yield* Effect.logDebug("Deleted expired events", { deleted });
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Event log retention skipped", { cause })),
    );
    yield* forkParked(
      Effect.sleep(BACKLOG_DELAY).pipe(
        Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(COMPACTION_INTERVAL)))),
      ),
    );
  }),
);

const AGING_DELAY = Duration.minutes(5);
const AGING_INTERVAL = Duration.hours(3);

/** Every few hours, ages the tool outputs of turn items a week old (see TurnItemAging). */
const layerAging = Layer.effectDiscard(
  Effect.gen(function* () {
    const cursor = yield* EventLogCursor;
    const pass = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const rewritten = yield* TurnItemAging.ageTurnItems({
        cutoffIso: DateTime.formatIso(
          DateTime.makeUnsafe(now - Duration.toMillis(TurnItemAging.AGING_PERIOD)),
        ),
        afterRowId: (yield* cursor.get).agedThrough,
        saveAgedThrough: (agedThrough) => cursor.save({ agedThrough }),
      });
      if (rewritten > 0) yield* Effect.logDebug("Aged old tool outputs", { rewritten });
    }).pipe(Effect.catchCause((cause) => Effect.logWarning("Turn item aging skipped", { cause })));
    yield* forkParked(
      Effect.sleep(AGING_DELAY).pipe(
        Effect.andThen(pass.pipe(Effect.repeat(Schedule.spaced(AGING_INTERVAL)))),
      ),
    );
  }),
);

/** Background compaction, retention and aging, plus the cursor replay paths read the floor from. */
export const layer = Layer.mergeAll(layerCompaction, layerRetention, layerAging).pipe(
  Layer.provideMerge(layerCursor),
);
