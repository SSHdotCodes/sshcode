import {
  SideChatError,
  type SideChatKind,
  type SideChatMessage,
  type SideChatState,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const isSideChatError = Schema.is(SideChatError);

// A server that predates side chats answers the RPC with this defect.
const UNKNOWN_RPC_PATTERN = /unknown request tag/i;

/** What to tell the user when opening, sending to, or following a side chat fails. */
export function sideChatErrorMessage(error: unknown): string {
  if (isSideChatError(error)) return error.message;
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  if (UNKNOWN_RPC_PATTERN.test(text)) return "This server doesn't support side chats.";
  return text.trim().length > 0 ? text : "The side chat failed.";
}

/** The panel is named after the harness command: Claude's `/btw`, Codex's side chat. */
export function sideChatTitle(kind: SideChatKind): string {
  return kind === "btw" ? "/btw" : "Side chat";
}

/** The harness is still producing the latest answer. */
export function sideChatIsBusy(state: SideChatState | null): boolean {
  return state === null || state.status === "starting" || state.status === "running";
}

/**
 * The messages to show: the server's once it has answered, otherwise the
 * question the user just asked, so the panel never opens empty.
 */
export function sideChatVisibleMessages(
  state: SideChatState | null,
  question: string,
): ReadonlyArray<SideChatMessage> {
  if (state !== null && state.messages.length > 0) return state.messages;
  return [{ id: "question", role: "user", text: question, status: "complete", activities: [] }];
}

// Shared with the phone, which asks about selected reply text the same way.
export {
  SIDE_CHAT_QUOTE_MAX_CHARS,
  sideChatPromptAbout,
  splitSideChatQuote,
} from "@t3tools/shared/sideChatQuote";
