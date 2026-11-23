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

/** Longest selection a side question carries; a longer one is cut with an ellipsis. */
export const SIDE_CHAT_QUOTE_MAX_CHARS = 2_000;

const SIDE_CHAT_QUOTE_LEAD = "About this part of your answer:";

/** The prompt for a side question about a selected part of an answer. */
export function sideChatPromptAbout(quote: string | null, question: string): string {
  const excerpt = quote?.trim() ?? "";
  if (excerpt.length === 0) return question;
  const cut =
    excerpt.length > SIDE_CHAT_QUOTE_MAX_CHARS
      ? `${excerpt.slice(0, SIDE_CHAT_QUOTE_MAX_CHARS)}…`
      : excerpt;
  const quoted = cut
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `${SIDE_CHAT_QUOTE_LEAD}\n${quoted}\n\n${question}`;
}

/** Splits a question built by `sideChatPromptAbout` back into its quote and the question. */
export function splitSideChatQuote(text: string): {
  readonly quote: string | null;
  readonly question: string;
} {
  if (!text.startsWith(`${SIDE_CHAT_QUOTE_LEAD}\n> `)) return { quote: null, question: text };
  const lines = text.slice(SIDE_CHAT_QUOTE_LEAD.length + 1).split("\n");
  let end = 0;
  while (end < lines.length && lines[end]!.startsWith("> ")) end += 1;
  // The quote is followed by one blank line, then the question.
  if (end === 0 || lines[end] !== "") return { quote: null, question: text };
  return {
    quote: lines
      .slice(0, end)
      .map((line) => line.slice(2))
      .join("\n"),
    question: lines.slice(end + 1).join("\n"),
  };
}
