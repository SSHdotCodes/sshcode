// Reads thread and run rows from the app's state database, read-only, in two queries.
import { DatabaseSync } from "node:sqlite";
import type { RunRow, ThreadRow } from "./report.ts";

export function readRows(path: string): { threads: ThreadRow[]; runs: RunRow[] } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const threads = db
      .prepare(
        "SELECT thread_id, title, created_at, payload_json FROM orchestration_v2_projection_threads",
      )
      .all() as unknown as ThreadRow[];
    const runs = db
      .prepare(
        "SELECT run_id, thread_id, status, requested_at, completed_at, payload_json FROM orchestration_v2_projection_runs",
      )
      .all() as unknown as RunRow[];
    return { threads, runs };
  } finally {
    db.close();
  }
}
