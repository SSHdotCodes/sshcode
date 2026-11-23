import { CommandId, MessageId, type ThreadId } from "@t3tools/contracts";
import type { OrchestrationEffectRequestV2 } from "./EffectOutbox.ts";

/** A stable mailbox identity makes a replay after process loss deliver once. */
export function secretRequestAnswerCommand(
  threadId: ThreadId,
  request: Extract<OrchestrationEffectRequestV2, { type: "secret-request.answered" }>,
) {
  const identity = `secret-request-answer:${request.turnItemId}`;
  return {
    type: "message.dispatch" as const,
    commandId: CommandId.make(`server:${identity}`),
    messageId: MessageId.make(`message:${identity}`),
    threadId,
    text: request.text,
    notification: {
      source: { kind: "system" as const },
      outcome: "completed" as const,
      summary: request.summary ?? "Secret request answered.",
    },
    attachments: [],
    dispatchMode: { type: "queue_after_active" as const },
    createdBy: "agent" as const,
    creationSource: "server" as const,
  };
}
