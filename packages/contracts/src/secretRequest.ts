import * as Schema from "effect/Schema";
import { ApiKeyScope, ApiKeyExpiry } from "./apiKey.ts";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";

/**
 * Every secret card's turn item id starts with this. The chat list finds pending cards by
 * it on the primary key, because no index holds a turn item's type.
 */
export const SECRET_REQUEST_TURN_ITEM_ID_PREFIX = "turn-item:secret-request:";

/**
 * The user's answer to an agent's request for a secret. A saved value is kept
 * by the server under a one-use SecretRef; the thread learns only status and handles.
 */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("save"),
      secret: TrimmedNonEmptyString,
      scope: Schema.optional(ApiKeyScope),
      expiresAt: Schema.optional(ApiKeyExpiry),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  thread_unavailable: "This chat is archived or removed. Reopen it before answering.",
  settings_write_required: "Saving an environment-wide key requires settings:write permission.",
  store_failed: "Could not store the secret.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable:
    "That secretRef was already used or does not exist. Ask the user again with request_secret.",
  ref_expired: "That secretRef expired. Ask the user again with request_secret.",
  consume_failed: "Could not use that secretRef. Try again.",
  not_a_file_request:
    'The user did not save this secret for shell use. Ask again with request_secret and delivery: "file".',
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

/** Answering a request or using its ref failed; the message is shown to users and agents. */
export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
