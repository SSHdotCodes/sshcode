import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import type { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";

export function isFirstCreatedChatFailure(
  run: Pick<OrchestrationV2Run, "id" | "ordinal" | "status">,
  receipt: OrchestrationV2AppThread["createdChat"],
): boolean {
  return (
    receipt !== undefined &&
    run.ordinal === 1 &&
    run.status === "failed" &&
    !receipt.failureNoticeQueued &&
    receipt.startup !== "failed" &&
    (receipt.firstRunId === null || receipt.firstRunId === run.id)
  );
}

export function createdChatFailureCommand(
  childThreadId: ThreadId,
  request: Extract<OrchestrationEffectRequestV2, { type: "created-chat.failure" }>,
) {
  const identity = `created-chat-failure:${childThreadId}`;
  const text = `The chat you created, "${request.title}", failed: ${request.error}`;
  return {
    type: "message.dispatch" as const,
    commandId: CommandId.make(`server:${identity}`),
    messageId: MessageId.make(`message:${identity}`),
    threadId: request.creatorThreadId,
    text,
    notification: {
      source: { kind: "system" as const },
      outcome: "failed" as const,
      summary: text,
    },
    attachments: [],
    dispatchMode: { type: "queue_after_active" as const },
    createdBy: "agent" as const,
    creationSource: "server" as const,
  };
}
