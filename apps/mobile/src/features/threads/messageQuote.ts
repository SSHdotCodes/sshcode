import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

export function messageQuoteText(message: string): string {
  // A quote is readable text, not a new attachment or a dangling context chip.
  return replaceComposerContextReferences(message, (reference) => reference.label);
}

export function appendMessageQuote(draft: string, message: string): string {
  const text = messageQuoteText(message)
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "");
  if (text.trim().length === 0) return draft;
  const quote = text
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  const separator =
    draft.length === 0 || draft.endsWith("\n\n") ? "" : draft.endsWith("\n") ? "\n" : "\n\n";
  return `${draft}${separator}${quote}\n\n`;
}

export function prepareMessageQuote(draft: string, message: string) {
  const text = appendMessageQuote(draft, message);
  return text.length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS
    ? { kind: "too-long" as const }
    : { kind: "ready" as const, text };
}
