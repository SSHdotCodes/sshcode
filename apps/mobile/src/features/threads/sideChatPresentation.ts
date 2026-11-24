import { SideChatError, type SideChatKind, type SideChatState } from "@t3tools/contracts";

/** The sheet's name: Claude Code calls it btw, Codex a side chat. */
export function sideChatTitle(kind: SideChatKind): string {
  return kind === "btw" ? "btw" : "Side chat";
}

export function sideChatSubtitle(kind: SideChatKind): string {
  return kind === "btw"
    ? "A quick question on the side. The agent keeps working and nothing is added to the chat."
    : "A side conversation off this chat. The agent keeps working and the workspace is left alone.";
}

/** A side chat takes the next message only when it is not already answering. */
export function sideChatAcceptsInput(state: SideChatState | null): boolean {
  return state === null || state.status === "idle";
}

/** Whether the side chat is over and a new message has to start another one. */
export function sideChatEnded(state: SideChatState | null): boolean {
  return state !== null && (state.status === "failed" || state.status === "closed");
}

/**
 * A friendly line for a failed open, send, or subscription. Servers that
 * predate side chats reject the method itself, which reads as "update".
 */
export function sideChatErrorMessage(error: unknown): string {
  if (error instanceof SideChatError) return error.message;
  // A failure that crossed the wire without its class still carries the tag.
  const tagged = error as { readonly _tag?: unknown; readonly reason?: unknown; detail?: unknown };
  if (tagged?._tag === "SideChatError" && typeof tagged.reason === "string") {
    const rebuilt = new SideChatError({
      reason: tagged.reason as SideChatError["reason"],
      ...(typeof tagged.detail === "string" ? { detail: tagged.detail } : {}),
    }).message as string | undefined;
    return rebuilt ?? "The side chat failed.";
  }
  const message =
    error instanceof Error ? error.message.trim() : typeof error === "string" ? error.trim() : "";
  if (/unknown|not ?found|unsupported|no handler|not implemented/iu.test(message)) {
    return "SSHCode on this machine doesn't support side chats yet. Update it there, then try again.";
  }
  return message.length > 0
    ? `Couldn't reach the side chat: ${message}`
    : "Couldn't reach the side chat. Check the connection and try again.";
}

/**
 * Clear the composer after dispatching a side-chat command only if the draft
 * still holds the flushed text that was submitted (not a stale pre-flush prop
 * and not newer edits typed while enqueueing).
 */
export function clearDraftIfSubmittedTextMatches(input: {
  readonly currentText: string;
  readonly submittedText: string;
  readonly clear: () => void;
}): void {
  if (input.currentText === input.submittedText) {
    input.clear();
  }
}
