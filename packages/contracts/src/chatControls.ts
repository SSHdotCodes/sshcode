import * as Schema from "effect/Schema";

import { NodeId, ThreadId } from "./baseSchemas.ts";

/**
 * Per-chat long-running placement and the subagents switch. Both are stored
 * beside the projection, not in it, so older databases need no migration.
 */
export const ChatControlsCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("long-running"),
    threadId: ThreadId,
    // Null restores automatic membership when undoing a manual placement.
    placement: Schema.NullOr(Schema.Literals(["include", "exclude"])),
  }),
  Schema.Struct({
    action: Schema.Literal("subagents"),
    threadId: ThreadId,
    enabled: Schema.Boolean,
  }),
]);
export type ChatControlsCommand = typeof ChatControlsCommand.Type;

/**
 * The user's answer on a chat's first subagent. "solo" turns the chat's
 * Subagents switch off; the client stops the subagent itself. "fine" only
 * dismisses the ask. Either answer is saved as a label for tuning the rules.
 */
export const FirstSubagentVerdict = Schema.Literals(["solo", "fine"]);
export type FirstSubagentVerdict = typeof FirstSubagentVerdict.Type;

export const FirstSubagentVerdictInput = Schema.Struct({
  threadId: ThreadId,
  taskId: NodeId,
  verdict: FirstSubagentVerdict,
});
export type FirstSubagentVerdictInput = typeof FirstSubagentVerdictInput.Type;

export class ChatControlsError extends Schema.TaggedError<ChatControlsError>()(
  "ChatControlsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
