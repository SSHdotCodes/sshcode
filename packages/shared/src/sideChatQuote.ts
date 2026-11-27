/**
 * A side question about selected reply text carries the selection as a quote above the
 * question. Mac and iPhone build and read it the same way.
 */

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
