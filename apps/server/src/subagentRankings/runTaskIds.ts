import { NodeId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/**
 * The ranked run each task belongs to: a follow-up's (t3_thread_send) original task, which
 * forked the child thread, or the task itself. Tasks the projection does not know are absent.
 */
export const rankedRunTaskIds = (taskIds: ReadonlyArray<NodeId>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly subagent_id: string; readonly run_task_id: string | null }>`
      SELECT task.subagent_id,
        CASE WHEN json_extract(child.payload_json, '$.forkedFrom.type') = 'node'
          THEN json_extract(child.payload_json, '$.forkedFrom.nodeId')
          ELSE task.subagent_id END AS run_task_id
      FROM orchestration_v2_projection_subagents AS task
      LEFT JOIN orchestration_v2_projection_threads AS child
        ON child.thread_id = task.child_thread_id
      WHERE task.origin = 'app_owned'
        AND task.subagent_id IN (SELECT value FROM json_each(${encodeIds(taskIds)}))
    `;
    return new Map(
      rows.flatMap((row) =>
        row.run_task_id === null
          ? []
          : [[NodeId.make(row.subagent_id), NodeId.make(row.run_task_id)] as const],
      ),
    );
  });

/**
 * Follow-ups that completed since `sinceMs`, with the original run each continued. Only
 * completed ones score unflagged; the record hook adds the others as they end.
 */
export const completedFollowUpsSince = (sinceMs: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly subagent_id: string;
      readonly run_task_id: string;
      readonly finished_at: string;
    }>`
      SELECT task.subagent_id,
        json_extract(child.payload_json, '$.forkedFrom.nodeId') AS run_task_id,
        COALESCE(task.completed_at, task.updated_at) AS finished_at
      FROM orchestration_v2_projection_subagents AS task
      JOIN orchestration_v2_projection_threads AS child ON child.thread_id = task.child_thread_id
      WHERE task.origin = 'app_owned' AND task.status = 'completed'
        AND COALESCE(task.completed_at, task.updated_at) >= ${DateTime.formatIso(DateTime.makeUnsafe(sinceMs))}
        AND json_extract(child.payload_json, '$.forkedFrom.type') = 'node'
        AND json_extract(child.payload_json, '$.forkedFrom.nodeId') IS NOT task.subagent_id
    `;
    return rows.map((row) => ({
      taskId: NodeId.make(row.subagent_id),
      runTaskId: NodeId.make(row.run_task_id),
      outcome: "completed" as const,
      finishedAt: DateTime.toEpochMillis(DateTime.makeUnsafe(row.finished_at)),
    }));
  });
