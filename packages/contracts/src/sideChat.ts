import * as Schema from "effect/Schema";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { ProviderDriverKind } from "./providerInstance.ts";

/**
 * Side chats run on the harness's own side-conversation feature and never
 * enter the thread's transcript:
 * - `btw`: the `/btw` side question of Claude Code, Grok Build, OpenCode and
 *   Antigravity. Answered from the conversation so far, with no tools, while
 *   the main agent keeps working. `agy acp` has no `/btw`, so Antigravity's
 *   runs in a short-lived side session given the thread's transcript.
 * - `side`: Codex's `/side` conversation, an ephemeral fork of the thread that
 *   can read and run checks but is told to leave the workspace alone.
 */
export const SideChatKind = Schema.Literals(["btw", "side"]);
export type SideChatKind = typeof SideChatKind.Type;

/** The slash command each harness uses for its side chat. */
export const SIDE_CHAT_COMMAND_BY_KIND: Record<SideChatKind, string> = {
  btw: "btw",
  side: "side",
};

/** Which native side chat a driver offers, or null when it has none. */
export function sideChatKindForDriver(
  driver: ProviderDriverKind | string | null | undefined,
): SideChatKind | null {
  switch (driver) {
    case "antigravity":
    case "claudeAgent":
    case "grok":
    case "opencode":
      return "btw";
    case "codex":
      return "side";
    default:
      return null;
  }
}

/**
 * Splits `/btw question` or `/side question` off a composer message for a
 * thread whose harness has that command. Returns null for anything else, so
 * other text still goes to the agent as typed.
 */
export function parseSideChatCommand(
  text: string,
  kind: SideChatKind | null,
): { readonly kind: SideChatKind; readonly prompt: string } | null {
  if (kind === null) return null;
  const match = /^\s*\/([a-z]+)(?:\s+([\s\S]*))?$/u.exec(text);
  if (match === null || match[1] !== SIDE_CHAT_COMMAND_BY_KIND[kind]) return null;
  return { kind, prompt: (match[2] ?? "").trim() };
}

export const SideChatId = TrimmedNonEmptyString.pipe(Schema.brand("SideChatId"));
export type SideChatId = typeof SideChatId.Type;

export const SideChatActivity = Schema.Struct({
  id: Schema.String,
  /** Short line such as "Ran `git status`" or "Read src/app.ts". */
  label: Schema.String,
  status: Schema.Literals(["running", "completed", "failed"]),
});
export type SideChatActivity = typeof SideChatActivity.Type;

export const SideChatMessage = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  status: Schema.Literals(["streaming", "complete", "failed"]),
  activities: Schema.Array(SideChatActivity),
});
export type SideChatMessage = typeof SideChatMessage.Type;

export const SideChatStatus = Schema.Literals(["starting", "running", "idle", "failed", "closed"]);
export type SideChatStatus = typeof SideChatStatus.Type;

export const SideChatState = Schema.Struct({
  sideChatId: SideChatId,
  threadId: ThreadId,
  kind: SideChatKind,
  status: SideChatStatus,
  messages: Schema.Array(SideChatMessage),
  error: Schema.NullOr(Schema.String),
});
export type SideChatState = typeof SideChatState.Type;

/** Opt-in live append, based on the previous message's UTF-16 length. */
export const SideChatTextAppend = Schema.Struct({
  kind: Schema.Literal("text-append"),
  sideChatId: SideChatId,
  messageId: Schema.String,
  previousLength: Schema.Number,
  text: Schema.String,
});
export type SideChatTextAppend = typeof SideChatTextAppend.Type;
export const SideChatStreamValue = Schema.NullOr(Schema.Union([SideChatState, SideChatTextAppend]));
export type SideChatStreamValue = typeof SideChatStreamValue.Type;

export const SideChatOpenInput = Schema.Struct({
  threadId: ThreadId,
  /** The first question; side chats open with one, as `/btw …` and `/side …` do. */
  prompt: TrimmedNonEmptyString,
  /** Stable across a retry after a lost acknowledgement. */
  messageId: Schema.optional(TrimmedNonEmptyString),
});
export type SideChatOpenInput = typeof SideChatOpenInput.Type;

export const SideChatSendInput = Schema.Struct({
  sideChatId: SideChatId,
  prompt: TrimmedNonEmptyString,
  messageId: Schema.optional(TrimmedNonEmptyString),
});
export type SideChatSendInput = typeof SideChatSendInput.Type;

export const SideChatRefInput = Schema.Struct({
  sideChatId: SideChatId,
});
export type SideChatRefInput = typeof SideChatRefInput.Type;

/** Thread subscriptions recover the latest exchange even if the open reply was lost. */
export const SideChatSubscribeInput = Schema.Union([
  Schema.Struct({ sideChatId: SideChatId, acceptTextPatches: Schema.optional(Schema.Boolean) }),
  Schema.Struct({ threadId: ThreadId, acceptTextPatches: Schema.optional(Schema.Boolean) }),
]);
export type SideChatSubscribeInput = typeof SideChatSubscribeInput.Type;

export class SideChatError extends Schema.TaggedError<SideChatError>()("SideChatError", {
  reason: Schema.Literals([
    "unsupported-provider",
    "no-provider-session",
    "not-found",
    "busy",
    "failed",
  ]),
  detail: Schema.optional(Schema.String),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported-provider":
        return "This agent has no side chat.";
      case "no-provider-session":
        return "Send a message in this thread first, then open a side chat.";
      case "not-found":
        return "This side chat has closed.";
      case "busy":
        return "Wait for the side chat to answer before sending another message.";
      case "failed":
        return this.detail ?? "The side chat failed.";
    }
  }
}
