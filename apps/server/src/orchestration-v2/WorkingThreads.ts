import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * How many chats have an agent working right now: the turns a server restart
 * would cut. Update restarts wait for this to reach zero (the SSHCode restart
 * job's `--when-idle`, the desktop app's "update when idle").
 *
 * A run counts while it prepares, starts, runs or captures its checkpoint
 * ("waiting"). A running run whose provider only keeps its prompt open for
 * background work (`waitingOnBackgroundWork`) does not: its reply ended, and a
 * restart already carries that work on, like queued runs, background tasks,
 * monitors, app-owned subagents and schedules.
 */
export const countWorkingThreads = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The repeated status list lets SQLite use the partial recovery index.
  const rows = yield* sql<{ readonly working: number }>`
    SELECT COUNT(DISTINCT run.thread_id) AS working
    FROM orchestration_v2_projection_runs AS run
      INDEXED BY orchestration_v2_projection_runs_recovery_idx
    LEFT JOIN orchestration_v2_projection_provider_threads AS provider_thread
      ON provider_thread.provider_thread_id = run.provider_thread_id
    WHERE run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      AND run.status <> 'queued'
      AND NOT (
        run.status = 'running'
        AND COALESCE(
          CASE WHEN json_valid(provider_thread.payload_json)
            THEN json_extract(provider_thread.payload_json, '$.waitingOnBackgroundWork')
          END,
          0
        ) = 1
      )
  `;
  return rows[0]?.working ?? 0;
});
