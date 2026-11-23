import { ScheduledTaskError, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { announceBoxChange } from "../sessionBoxes/boxNamerCache.ts";

/** Schedule writes refresh this map; assembling a thread shell never reads schedules. */
export class ScheduledTaskShells extends Context.Service<
  ScheduledTaskShells,
  {
    readonly nextRunAt: (threadId: ThreadId) => string | null;
    readonly refresh: Effect.Effect<void, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskShells") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const lock = yield* Semaphore.make(1);
  let nextByThread = new Map<string, string>();
  const refresh = Effect.gen(function* () {
    // One small schedule-table read on writes, never a transcript or per-chat lookup.
    const rows = yield* sql<{ thread_id: string; next_run_at: string }>`
      SELECT thread_id, MIN(next_run_at) AS next_run_at
      FROM scheduled_tasks
      WHERE enabled = 1 AND thread_id IS NOT NULL AND next_run_at IS NOT NULL
        AND CASE WHEN json_valid(schedule_json) THEN json_extract(schedule_json, '$.type') END
          IN ('interval', 'fixed_time')
      GROUP BY thread_id
    `.pipe(
      Effect.mapError(
        (cause) =>
          new ScheduledTaskError({
            message: "Could not read chat schedules.",
            cause,
          }),
      ),
    );
    const next = new Map(rows.map((row) => [row.thread_id, row.next_run_at]));
    const previous = nextByThread;
    nextByThread = next;
    for (const id of new Set([...previous.keys(), ...next.keys()])) {
      if (previous.get(id) !== next.get(id)) announceBoxChange(id);
    }
  }).pipe(lock.withPermits(1));
  yield* refresh;
  return ScheduledTaskShells.of({ nextRunAt: (id) => nextByThread.get(id) ?? null, refresh });
});

export const layer = Layer.effect(ScheduledTaskShells, make);
