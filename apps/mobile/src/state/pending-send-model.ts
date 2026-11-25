import {
  CommandId,
  EnvironmentId,
  IsoDateTime,
  ProviderUserInputAnswers,
  RuntimeRequestId,
  ThreadId,
  UserInputAttachments,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const fields = {
  id: CommandId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  error: Schema.optional(Schema.String),
};

export const PendingSendSchema = Schema.Union([
  Schema.Struct({ ...fields, kind: Schema.Literal("side-question"), prompt: Schema.String }),
  Schema.Struct({
    ...fields,
    kind: Schema.Literal("user-input"),
    requestId: RuntimeRequestId,
    answers: ProviderUserInputAnswers,
    attachmentsByQuestionId: Schema.optional(UserInputAttachments),
  }),
]);
export type PendingSend = typeof PendingSendSchema.Type;

export function pendingSendKey(send: PendingSend): string {
  return `${send.environmentId}:${send.threadId}:${send.kind}:${send.kind === "user-input" ? send.requestId : ""}`;
}

/**
 * The server refused an answer because its card is no longer open: answered
 * here before a lost acknowledgment, answered on another device, or closed by
 * the agent. A resend can never succeed, so the saved answer is dropped
 * instead of showing the raw error with a Try again that cannot work.
 */
export function isClosedRuntimeRequestMessage(message: string): boolean {
  return /Runtime request \S+ (?:is (?!pending\b)[a-z_-]+|was not found|no longer exists on thread \S+)\.$/u.test(
    message.trim(),
  );
}

export function isClosedRuntimeRequestError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error._tag === "OrchestrationV2DispatchCommandError" ||
      error._tag === "OrchestrationDispatchCommandError") &&
    "message" in error &&
    typeof error.message === "string" &&
    isClosedRuntimeRequestMessage(error.message)
  );
}
