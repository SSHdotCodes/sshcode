import {
  CommandId,
  isTerminalRunStatus,
  MessageId,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import type { OrchestrationEffectRequestV2, PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import { clipCompletionWake } from "./NotificationMailbox.ts";
import { restartContinuationMessageId } from "./RestartBackgroundNote.ts";
import type { ThreadManagementService } from "./ThreadManagementService.ts";

/** Called after applying the entire terminal batch, including any queued message promoted to a steer. */
export const threadSendCompletionEffects = (sql: SqlClient.SqlClient, run: OrchestrationV2Run) =>
  Effect.gen(function* () {
    // Follow restart ancestry by primary key. Ordinary completions only read this run's messages.
    const assignedRuns =
      run.restartContinuationOfRunId === undefined
        ? sql`= ${run.id}`
        : sql`IN (
      WITH RECURSIVE chain(id) AS (
        SELECT ${run.id}
        UNION
        SELECT json_extract(r.payload_json, '$.restartContinuationOfRunId')
        FROM chain JOIN orchestration_v2_projection_runs r ON r.run_id = chain.id
        WHERE json_extract(r.payload_json, '$.restartContinuationOfRunId') IS NOT NULL
      ) SELECT id FROM chain
    )`;
    const sends = yield* sql<{ message_id: MessageId; run_id: RunId; sender_id: ThreadId }>`
      SELECT m.message_id, m.run_id, sender.thread_id AS sender_id
      FROM orchestration_v2_projection_messages m
      JOIN orchestration_v2_projection_threads sender
        ON sender.thread_id = json_extract(m.payload_json, '$.senderThreadId')
      WHERE m.run_id ${assignedRuns} AND m.role = 'user'
        AND json_extract(m.payload_json, '$.notifySenderOnCompletion') = 1
        AND sender.archived_at IS NULL AND sender.deleted_at IS NULL
    `;
    return sends.map(({ message_id, run_id, sender_id }): PendingOrchestrationEffectV2 => ({
      id: `effect:thread-send-completion:${run.id}:${message_id}`,
      commandId: CommandId.make(`command:thread-send-completion:${message_id}`),
      threadId: run.threadId,
      request: {
        type: "thread-send.complete",
        runId: run.id,
        assignedRunId: run_id,
        messageId: message_id,
        senderThreadId: sender_id,
      },
    }));
  });

export const deliverThreadSendCompletion = Effect.fn("ThreadSendCompletion.deliver")(function* (
  threads: ThreadManagementService["Service"],
  threadId: ThreadId,
  commandId: CommandId,
  request: Extract<OrchestrationEffectRequestV2, { type: "thread-send.complete" }>,
) {
  const sender = yield* threads.getThreadShell(request.senderThreadId);
  if (sender === null || sender.archivedAt !== null || sender.deletedAt !== null) return;
  const continuationId = restartContinuationMessageId(request.runId);
  const { messages, runs } = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
    messageIds: [request.messageId, continuationId],
    runIds: [request.runId],
  });
  // An earlier outbox effect on this thread may have moved a rejected steer to a follow-up
  // or started the restart continuation. The new run then owns the result.
  if (
    messages.some((message) => message.id === continuationId) ||
    !messages.some(
      (message) => message.id === request.messageId && message.runId === request.assignedRunId,
    )
  )
    return;
  const run = runs[0];
  if (!run || !isTerminalRunStatus(run.status)) return;
  const result = yield* threads.getThreadRecords(threadId, ["messages", "turnItems"], {
    messageRoles: ["assistant"],
    messageRunIds: [run.id],
    turnItemRunIds: [run.id],
    turnItemTypes: ["assistant_message", "error"],
  });
  const report = subagentResultForRun(result, run);
  const summary = `Thread ${threadId} run ${run.ordinal} ${run.status}`;
  const text = clipCompletionWake(
    report.messageId === null && report.turnItemId === null
      ? summary
      : `${summary}\n${report.text}`,
    () => "\n… Read the target thread for the rest.",
  );
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId,
    threadId: request.senderThreadId,
    messageId: MessageId.make(`message:thread-send-completion:${request.messageId}`),
    threadSendCompletion: true,
    text,
    attachments: [],
    createdBy: "agent",
    creationSource: "server",
    dispatchMode: { type: "queue_after_active" },
    notification: {
      source: { kind: "background_task" },
      outcome: run.status === "completed" || run.status === "failed" ? run.status : "cancelled",
      summary,
      detail: text,
    },
  });
});
