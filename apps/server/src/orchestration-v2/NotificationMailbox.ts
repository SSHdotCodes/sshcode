import {
  latestProviderTurnForAttempt,
  type MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";

import { seenLineForLead } from "./SubagentSeen.ts";
import { taskReference } from "./taskReference.ts";

/** A queued turn can start before the terminal listener releases the preceding wake's claim. */
export function resultsForNextTurn(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents">,
) {
  const candidates = projection.subagents.filter(
    (task) => task.completionDelivery?.withNextTurn || task.completionDelivery?.state === "claimed",
  );
  if (!candidates.some((task) => task.completionDelivery?.state === "claimed")) return candidates;
  const failedInputs = new Set(
    projection.runs
      .filter((run) => run.status === "failed" || run.status === "interrupted")
      .map((run) => run.userMessageId),
  );
  const failedClaims = new Set(
    projection.runs.flatMap((run) => {
      const cohort = run.delegatedCompletion;
      return cohort?.disposition === "open" &&
        cohort.delivery &&
        failedInputs.has(cohort.delivery.messageId)
        ? cohort.delivery.taskIds
        : [];
    }),
  );
  return candidates.filter(
    (task) => task.completionDelivery?.withNextTurn || failedClaims.has(task.id),
  );
}

/** Keep the wake on the message when a queued input or declined steer moves to another run. */
export function threadSendFields(
  input: Pick<OrchestrationV2ConversationMessage, "senderThreadId" | "notifySenderOnCompletion">,
) {
  return {
    ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
    ...(input.notifySenderOnCompletion && { notifySenderOnCompletion: true }),
  };
}

const USER_TASK_PREVIEW_CHARS = 180;
const MAX_WAKE_BYTES = 6144;

/** Clips the entire provider-facing wake at a UTF-8 code point boundary, including its read hint. */
export function clipCompletionWake(text: string, suffix: (end: number) => string): string {
  if (text.length <= MAX_WAKE_BYTES && Buffer.byteLength(text) <= MAX_WAKE_BYTES) return text;
  const room = Math.max(0, MAX_WAKE_BYTES - Buffer.byteLength(suffix(MAX_WAKE_BYTES)));
  const { read } = new TextEncoder().encodeInto(text, new Uint8Array(room));
  return text.slice(0, read) + suffix(read);
}

/**
 * The lead did not write this brief, so the result names who did and what was asked.
 * Empty for the lead's own subagents: their result text is unchanged.
 */
function startedByUserNote(task: Pick<OrchestrationV2Subagent, "createdBy" | "prompt">): string {
  if (task.createdBy !== "user") return "";
  const asked = task.prompt.replace(/\s+/gu, " ").trim();
  const preview =
    asked.length > USER_TASK_PREVIEW_CHARS
      ? `${asked.slice(0, USER_TASK_PREVIEW_CHARS - 1)}…`
      : asked;
  return ` (started by the user, who asked: ${preview})`;
}

/** What a lead reads when delegated tasks finish: per task, a header, the app's facts, the report. */
export function delegatedCompletionWakeDetail(
  taskIds: ReadonlyArray<string>,
  tasks: ReadonlyArray<OrchestrationV2Subagent>,
): string {
  return taskIds
    .map((id) => {
      const task = tasks.find((candidate) => candidate.id === id);
      const reference = taskReference(id);
      // A chat can have subagents off, and task_status with them, while the user starts one
      // there: its own chat is readable either way.
      const childChat = task?.createdBy === "user" ? task.childThreadId : null;
      const taskRead = (offset?: number) =>
        `task_status({taskId:"${reference}"${offset === undefined ? "" : `,summaryOffset:${offset}`}})`;
      const read = childChat == null ? taskRead() : `t3_thread_read({threadId:"${childChat}"})`;
      if (task === undefined) return `Subagent ${reference}: finished. Read ${read}.`;
      const header = `Subagent ${reference}${startedByUserNote(task)}: ${task.status} (${task.providerInstanceId}/${task.model ?? "default"})${task.seen === undefined ? "" : `\n${seenLineForLead(task.seen)}`}\n`;
      const text = header + (task.result ?? `No result text. Read ${read}.`);
      return clipCompletionWake(
        text,
        (end) =>
          `\n… rest: ${childChat == null && task.result != null ? taskRead(Math.max(0, end - header.length)) : read}`,
      );
    })
    .join("\n\n");
}

/** A wake attaches to output held in provider memory, which Stop or process loss discards. */
export function isBufferedProviderNotification(
  message: OrchestrationV2ConversationMessage,
): boolean {
  return (
    message.createdBy === "agent" &&
    message.creationSource === "provider" &&
    message.notification !== undefined &&
    message.delegatedCompletion === undefined
  );
}

/**
 * A wake the server wrote for the agent itself: a monitor's report, a child's
 * result or another server notification. It is news for the agent, not a
 * message the user queued, so a restart must not leave it waiting on the user.
 */
export function isAutomaticWakeMessage(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "notification" | "delegatedCompletion"
  >,
): boolean {
  return (
    message.createdBy === "agent" &&
    message.creationSource === "server" &&
    (message.notification !== undefined || message.delegatedCompletion !== undefined)
  );
}

/**
 * A message another chat's agent sent through `t3_thread_send` or `delegate_task`, such as a
 * parent's follow-up to its child. The sender waits on it, so a restart must not hold it for the
 * user either: a held follow-up never runs and its parent shows the child as working forever.
 */
export function isAgentSentMessage(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "senderThreadId"
  >,
): boolean {
  return (
    message.createdBy === "agent" &&
    message.creationSource === "mcp" &&
    message.senderThreadId !== undefined
  );
}

/** Server-local generation in an app-owned monitor's message ID; no new persisted fields. */
export function appOwnedMonitorGeneration(
  message: Pick<
    OrchestrationV2ConversationMessage,
    "id" | "createdBy" | "creationSource" | "notification"
  >,
): number | undefined {
  if (
    message.createdBy !== "agent" ||
    message.creationSource !== "server" ||
    message.notification?.source.kind !== "monitor"
  )
    return undefined;
  const match = /^message:monitor:(\d+):/.exec(message.id);
  return match === null ? undefined : Number(match[1]);
}

/**
 * A persisted steer without an acceptance receipt can be retried as a continuation.
 * Delivery is at least once: provider acceptance and our receipt cannot commit
 * atomically. Reusing the message ID keeps recovery from duplicating timeline items.
 */
export function isUndeliveredMailboxSteer(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  messageId: MessageId,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  if (message?.delegatedCompletion === undefined) return false;
  const run = projection.runs.find((candidate) => candidate.id === message.runId);
  return (
    run !== undefined &&
    run.userMessageId !== message.id &&
    (["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status) ||
      latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.status ===
        "completed")
  );
}
