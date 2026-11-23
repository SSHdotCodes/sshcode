/**
 * One plain line that says how a message opens, for chat list rows. The server cuts it once
 * so every client shows the same words. Runs on Hermes too: no lookbehind, no newer helpers.
 */

/** Only the opening of a message is read; a preview never needs more. */
export const MESSAGE_PREVIEW_SCAN_CHARS = 400;
/** A phone row shows about 50 characters; the rest is room for wider lists. */
export const MESSAGE_PREVIEW_MAX_CHARS = 120;

/** One plain line from a message's opening: markdown marks, code blocks and extra space removed. */
export function messagePreviewLine(text: string): string | null {
  const parts: string[] = [];
  let length = 0;
  let fenced = false;
  for (const raw of text.slice(0, MESSAGE_PREVIEW_SCAN_CHARS).split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      fenced = !fenced;
      continue;
    }
    if (fenced || trimmed === "") continue;
    // Rules and table separator rows carry no words.
    if (/^[-|:\s*_=]+$/.test(trimmed)) continue;
    const plain = trimmed
      .replace(/^(#{1,6}|>+|[-*+]|\d+[.)])\s+/, "")
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|~~|`/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (plain === "") continue;
    parts.push(plain);
    length += plain.length + 1;
    if (length >= MESSAGE_PREVIEW_MAX_CHARS) break;
  }
  if (parts.length === 0) return null;
  const line = parts.join(" ");
  return line.length > MESSAGE_PREVIEW_MAX_CHARS
    ? `${line.slice(0, MESSAGE_PREVIEW_MAX_CHARS - 1)}…`
    : line;
}
