import {
  deriveMessageRewindPlan,
  REWIND_STARTS_NEW_SESSION_NOTICE,
  type MessageRewindPlan,
} from "@t3tools/client-runtime/state/thread-checkpoints";
import { canForkProjectedAssistantItem } from "@t3tools/client-runtime/state/thread-workflows";
import type {
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2RunStatus,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { ComposerDraft } from "../../state/use-composer-drafts";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import type { ThreadFeedMessage } from "../../lib/threadActivity";

export function canForkMessage(input: {
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
  readonly capabilities: OrchestrationV2ProviderCapabilities | undefined;
  readonly runStatus: OrchestrationV2RunStatus | undefined;
  readonly canOperate: boolean;
}): boolean {
  return (
    input.canOperate &&
    input.runStatus === "completed" &&
    canForkProjectedAssistantItem({
      projectedItem: input.projectedItem,
      capabilities: input.capabilities,
    })
  );
}

export function editMessageTarget(input: {
  readonly message: ThreadFeedMessage;
  readonly projection: OrchestrationV2ThreadProjection | null;
  readonly threadId: ThreadId;
  readonly canOperate: boolean;
  readonly supportsRollback: boolean;
  readonly active: boolean;
}): MessageRewindPlan | null {
  const { message, projection } = input;
  if (
    !input.canOperate ||
    !input.supportsRollback ||
    input.active ||
    !projection ||
    message.role !== "user" ||
    message.visibility !== "local" ||
    message.sourceThreadId !== input.threadId ||
    (message.inputIntent !== "turn_start" && message.inputIntent !== "queued_turn") ||
    message.runId === null ||
    projection.runs.some((run) =>
      ["preparing", "starting", "running", "waiting"].includes(run.status),
    )
  )
    return null;
  return deriveMessageRewindPlan(projection, message.runId);
}

/** Body of the "Edit and resend?" alert for this rewind. */
export function editMessageConfirmationText(plan: MessageRewindPlan): string {
  const base = plan.canRestoreFiles
    ? "Remove this message and everything after it, and put it back in the composer to edit?"
    : "Remove this message and everything after it, and put it back in the composer to edit? Files are left as they are.";
  return plan.startsNewSession ? `${base} ${REWIND_STARTS_NEW_SESSION_NOTICE}` : base;
}

export function forkMessageInput(
  environmentId: EnvironmentId,
  sourceThreadId: ThreadId,
  targetThreadId: ThreadId,
  runId: RunId,
  title: string,
) {
  return {
    environmentId,
    input: {
      sourceThreadId,
      targetThreadId,
      runId,
      title: `${title} fork`,
      creationSource: "mobile" as const,
    },
  };
}

export function revertMessageInput(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  turnCount: number,
  commandId: import("@t3tools/contracts").CommandId,
  restoreFiles: boolean,
) {
  return { environmentId, input: { commandId, threadId, turnCount, restoreFiles } };
}

export function mergeRewoundPrompt(
  draft: ComposerDraft,
  message: ThreadFeedMessage,
  attachments: ReadonlyArray<DraftComposerAttachment>,
) {
  const records = new Map(draft.context?.records.map((record) => [record.contextId, record]));
  for (const record of message.context?.records ?? []) records.set(record.contextId, record);
  const existingIds = new Set(draft.attachments.map((attachment) => attachment.id));
  return {
    text: draft.text ? `${draft.text}\n\n${message.text}` : message.text,
    context: message.context ? { version: 1 as const, records: [...records.values()] } : undefined,
    attachments: attachments.filter((attachment) => !existingIds.has(attachment.id)),
    duplicates: attachments.filter((attachment) => existingIds.has(attachment.id)),
  };
}

export function rollbackSettled(
  projection: OrchestrationV2ThreadProjection,
  runId: RunId,
  turnCount: number,
  commandId: import("@t3tools/contracts").CommandId,
): "failed" | "complete" | "pending" {
  if (projection.thread.rollbackFailure?.requestId === commandId) return "failed";
  return projection.runs.some(
    (run) => run.id === runId && run.ordinal > turnCount && run.status === "rolled_back",
  )
    ? "complete"
    : "pending";
}
