import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Agents mention another thread in Markdown as `[title](t3-thread://v1/<threadId>)`. The id is
 * the reference and resolves in the environment of the message that holds it. Titles change, so
 * clients show the thread's current title; the label only stands in for a thread they cannot see.
 */
export const THREAD_LINK_PROTOCOL = "t3-thread";
const THREAD_LINK_HREF_PREFIX = `${THREAD_LINK_PROTOCOL}://v1/`;
const LIST_MARKERS = String.raw`(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*`;
// CommonMark fences start on their own line (optional blockquotes, indentation, or list markers)
// and close on a line with at least as many of the same marker; backtick info strings hold no `.
// Quote markers are compared from the first `>`, so lines may indent them differently.
// Space after the markers is matched only after a `>`: two adjacent `[ \t]*` backtrack quadratically.
const AFTER_QUOTE = String.raw`(?:(?<=>)[ \t]*)?`;
const fencedCode = (char: "`" | "~", name: string) => {
  const bq = `${name}Bq`;
  const info = char === "`" ? "[^`\\r\\n]*" : "[^\\r\\n]*";
  const closer = String.raw`[ \t]*\k<${bq}>${AFTER_QUOTE}\k<${name}>${char}*(?!${char})[ \t]*\r?$`;
  return String.raw`^[ \t]*${LIST_MARKERS}(?<${bq}>(?:>(?:[ \t]*>)*)?)(?:(?<=>)[ \t]*${LIST_MARKERS})?(?<${name}>${char}{3,}(?!${char}))${info}(?=\r?$)(?:(?:\r\n?|\n)(?!${closer})[ \t]*\k<${bq}>[^\r\n]*)*(?:(?:\r\n?|\n)${closer})?`;
};
// A code span may wrap lines until its paragraph ends: a blank line, heading, list item, fence, or deeper blockquote.
const SPAN_BREAK_LINE =
  /[ \t>]*(?:\r?$|#{1,6}(?:[ \t]|\r?$)|(?:[-*+]|\d{1,9}[.)])[ \t]|`{3,}[^`\r\n]*\r?$|~{3,})/my;
const LINE_PREFIX = /([ \t]*)(>|(?:[-*+]|\d{1,9}[.)])[ \t]+)?/y;
// Earlier alternatives consume escaped delimiters and code so literal links keep their labels.
const THREAD_LINK_OUTSIDE_CODE = new RegExp(
  [
    String.raw`\\[\\\`]`,
    fencedCode("`", "backticks"),
    fencedCode("~", "tildes"),
    String.raw`(?<spanTicks>\`+)`,
    String.raw`\[[^\]\n]*\]\((?<href>t3-thread:\/\/v1\/[^\s)]+)\)`,
  ].join("|"),
  "gm",
);

function codeSpanLines(markdown: string) {
  const lines: Array<{ start: number; depth: number }> = [];
  const listIndents: number[] = [];
  let paragraphDepth: number | undefined;
  let start = 0;
  for (const line of markdown.split("\n")) {
    let offset = 0;
    let depth = 0;
    let hasList = false;
    let listOffset = 0;
    while (offset < line.length) {
      LINE_PREFIX.lastIndex = offset;
      const prefix = LINE_PREFIX.exec(line);
      if (prefix === null) break;
      const indent = prefix[1]!.replace(/\t/g, "    ").length;
      if (
        listOffset === 0 &&
        paragraphDepth === undefined &&
        indent < (listIndents[depth] ?? 0) &&
        line.trim()
      ) {
        listIndents.length = depth;
      }
      const containerIndent = listIndents[depth] ?? 0;
      const continuedIndent = indent >= containerIndent ? containerIndent : 0;
      if (prefix[2] === undefined || indent - continuedIndent > 3) break;
      offset = LINE_PREFIX.lastIndex;
      if (prefix[2] === ">") {
        depth++;
        listOffset = 0;
        if (line[offset] === " " || line[offset] === "\t") offset++;
      } else {
        listOffset += indent + prefix[2]!.replace(/\t/g, "    ").length;
        listIndents[depth] = listOffset;
        hasList = true;
      }
    }
    const content = line.slice(offset);
    const endsParagraph =
      /^(?:[ \t\r]*$|[ \t]*#{1,6}(?:[ \t]|$)|[ \t]*`{3,}[^`]*$|[ \t]*~{3,})/.test(content);
    const effectiveDepth = endsParagraph || hasList ? depth : Math.max(depth, paragraphDepth ?? 0);
    lines.push({ start, depth: effectiveDepth });
    paragraphDepth = endsParagraph ? undefined : effectiveDepth;
    start += line.length + 1;
  }
  return lines;
}

function findCodeSpanEnd(
  markdown: string,
  openIndex: number,
  tickCount: number,
  lines: ReturnType<typeof codeSpanLines>,
  lineIndex: number,
): number {
  const openDepth = lines[lineIndex]!.depth;
  for (let i = openIndex + tickCount; i < markdown.length; i++) {
    if (markdown[i] === "`") {
      let runEnd = i + 1;
      while (markdown[runEnd] === "`") runEnd++;
      if (runEnd - i === tickCount) return runEnd;
      i = runEnd - 1;
    } else if (markdown[i] === "\n") {
      lineIndex++;
      SPAN_BREAK_LINE.lastIndex = i + 1;
      if (SPAN_BREAK_LINE.test(markdown) || lines[lineIndex]!.depth > openDepth) return -1;
    }
  }
  return -1;
}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

/** The id as written. Thread ids can hold percent escapes of their own, so it is not decoded. */
export function parseThreadLinkHref(href: string): ThreadId | null {
  if (!href.startsWith(THREAD_LINK_HREF_PREFIX)) return null;
  return Option.getOrNull(decodeThreadId(href.slice(THREAD_LINK_HREF_PREFIX.length)));
}

/**
 * Agents often percent-encode the id anyway. When the id as written names no thread, clients try
 * this decoded form. Null when decoding changes nothing or fails.
 */
export function percentDecodedThreadLinkId(threadId: ThreadId): ThreadId | null {
  try {
    const decoded = decodeURIComponent(threadId);
    return decoded === threadId ? null : Option.getOrNull(decodeThreadId(decoded));
  } catch {
    return null;
  }
}

/** A thread link whose label survives Markdown: no brackets, backslashes, or line breaks. */
export function formatThreadLink(threadId: string, label: string): string {
  const cleaned = label
    .replace(/[[\]\\\r\n]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `[${cleaned || threadId}](${THREAD_LINK_HREF_PREFIX}${threadId})`;
}

export function hasThreadLinks(markdown: string): boolean {
  return markdown.includes(`](${THREAD_LINK_HREF_PREFIX}`);
}

/**
 * Relabels each thread link with `title(threadId)`, pointing it at the thread that title came from.
 * A link it returns nothing for keeps its label.
 */
export function relabelThreadLinks(
  markdown: string,
  title: (threadId: ThreadId) => string | undefined,
): string {
  if (!hasThreadLinks(markdown)) return markdown;
  const pattern = new RegExp(THREAD_LINK_OUTSIDE_CODE);
  let result = "";
  let cursor = 0;
  let lines: ReturnType<typeof codeSpanLines> | undefined;
  let lineIndex = 0;
  for (let match = pattern.exec(markdown); match !== null; match = pattern.exec(markdown)) {
    const spanTicks = match.groups?.spanTicks;
    if (spanTicks !== undefined) {
      lines ??= codeSpanLines(markdown);
      while (lineIndex + 1 < lines.length && lines[lineIndex + 1]!.start <= match.index)
        lineIndex++;
      const spanEnd = findCodeSpanEnd(markdown, match.index, spanTicks.length, lines, lineIndex);
      if (spanEnd !== -1) pattern.lastIndex = spanEnd;
      continue;
    }
    const href = match.groups?.href;
    if (href === undefined) continue;
    const written = parseThreadLinkHref(href);
    if (written === null) continue;
    // The decoded id only stands in when the id as written names no thread.
    const decoded = percentDecodedThreadLinkId(written);
    const threadId =
      title(written) === undefined && decoded !== null && title(decoded) !== undefined
        ? decoded
        : written;
    const label = title(threadId)?.trim();
    if (!label) continue;
    result += markdown.slice(cursor, match.index) + formatThreadLink(threadId, label);
    cursor = match.index + match[0].length;
  }
  return cursor === 0 ? markdown : result + markdown.slice(cursor);
}
