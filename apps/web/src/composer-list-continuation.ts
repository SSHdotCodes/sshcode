import { splitPromptIntoComposerSegments } from "./composer-editor-mentions";

/**
 * List continuation and indentation for the composer.
 *
 * Implemented once at the ChatComposer level (store replacement), so both
 * composer modes behave identically and serialize identically:
 * Shift+Enter on a list item continues it, Enter on an empty item exits the
 * list, and Tab indents the item. Plain Markdown markers only — no real list
 * nodes anywhere.
 */

export interface ComposerListEdit {
  /** Expanded (plain string) offsets into the prompt. */
  start: number;
  end: number;
  replacement: string;
  cursorAfter?: number;
}

type ListMarker =
  | { kind: "ordered"; indent: string; numberText: string; delimiter: "." | ")"; space: string }
  | { kind: "task"; indent: string; space: string }
  | { kind: "bullet"; indent: string; bullet: string; space: string };

function parseListMarker(line: string): { marker: ListMarker; markerEnd: number } | null {
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  const rest = line.slice(indent.length);
  const ordered = rest.match(/^(\d+)([.)])((?:[ \t]+)|\s*$)/);
  if (ordered && ordered[1] !== undefined && ordered[2] !== undefined) {
    return {
      marker: {
        kind: "ordered",
        indent,
        numberText: ordered[1],
        delimiter: ordered[2] === ")" ? ")" : ".",
        space: ordered[3] ?? "",
      },
      markerEnd: indent.length + ordered[0].length,
    };
  }
  const task = rest.match(/^-\s\[[ xX]\]((?:[ \t]+)|\s*$)/);
  if (task) {
    return {
      marker: { kind: "task", indent, space: task[1] ?? "" },
      markerEnd: indent.length + task[0].length,
    };
  }
  const bullet = rest.match(/^([-*+])((?:[ \t]+)|\s*$)/);
  if (bullet && bullet[1] !== undefined) {
    return {
      marker: { kind: "bullet", indent, bullet: bullet[1], space: bullet[2] ?? "" },
      markerEnd: indent.length + bullet[0].length,
    };
  }
  return null;
}

/**
 * The ordered marker that follows `3.` or `09)`: one higher, same delimiter,
 * zero padding kept, and a number too large to count left as typed. Shared
 * with the rich editor's native split so both modes count the same way.
 */
export function nextOrderedMarkerText(marker: string): string {
  const numberText = marker.slice(0, -1);
  const delimiter = marker.slice(-1);
  const number = Number.parseInt(numberText, 10);
  const next = Number.isSafeInteger(number)
    ? String(number + 1).padStart(numberText.length, "0")
    : numberText;
  return `${next}${delimiter}`;
}

function nextMarkerText(marker: ListMarker): string {
  if (marker.kind === "ordered") {
    return `${marker.indent}${nextOrderedMarkerText(`${marker.numberText}${marker.delimiter}`)} `;
  }
  if (marker.kind === "task") {
    return `${marker.indent}- [ ] `;
  }
  return `${marker.indent}${marker.bullet} `;
}

function segmentSource(
  segment: ReturnType<typeof splitPromptIntoComposerSegments>[number],
): string {
  if (segment.type === "text") return segment.text;
  return segment.source;
}

function inlineTokenRanges(value: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const segment of splitPromptIntoComposerSegments(value)) {
    const end = offset + segmentSource(segment).length;
    if (segment.type !== "text") ranges.push({ start: offset, end });
    offset = end;
  }
  return ranges;
}

/** True when splitting at the caret would cut an inline chip in two. */
function isInsideInlineToken(
  tokens: ReturnType<typeof inlineTokenRanges>,
  cursor: number,
): boolean {
  return tokens.some(({ start, end }) => cursor > start && cursor < end);
}

function currentLine(value: string, cursor: number): { start: number; end: number; text: string } {
  const start = value.lastIndexOf("\n", cursor - 1) + 1;
  const endIndex = value.indexOf("\n", cursor);
  const end = endIndex === -1 ? value.length : endIndex;
  return { start, end, text: value.slice(start, end) };
}

/**
 * Enter on a list item line: continue the list, or exit it when the item is
 * empty. Returns null for non-list lines, carets inside the marker, and
 * carets inside an inline chip — all fall through to a plain newline.
 */
export function listContinuationForEnter(value: string, cursor: number): ComposerListEdit | null {
  if (!Number.isInteger(cursor) || cursor < 0 || cursor > value.length) return null;
  const line = currentLine(value, cursor);
  const parsed = parseListMarker(line.text);
  if (!parsed) return null;
  const markerEnd = line.start + parsed.markerEnd;
  if (cursor < markerEnd) return null;
  if (isInsideInlineToken(inlineTokenRanges(value), cursor)) return null;
  if (value.slice(markerEnd, line.end).trim() === "") {
    // Empty item: Enter exits the list by removing the marker.
    return { start: line.start, end: Math.max(cursor, markerEnd), replacement: "" };
  }
  return {
    start: cursor,
    end: cursor,
    replacement: `\n${nextMarkerText(parsed.marker)}`,
  };
}

function indentWidth(indent: string, start = 0): number {
  let column = start;
  for (const character of indent) {
    if (character === " ") column += 1;
    else if (character === "\t") column += 4 - (column % 4);
    else break;
  }
  return column - start;
}

function* precedingListMarkers(
  value: string,
  start: number,
  tokens: ReturnType<typeof inlineTokenRanges>,
) {
  let tokenIndex = tokens.length - 1;
  while (start > 0) {
    const end = start - 1;
    start = value.lastIndexOf("\n", end - 1) + 1;
    for (let token = tokens[tokenIndex]; token; token = tokens[tokenIndex]) {
      if (token.start >= start) tokenIndex -= 1;
      else if (token.end > start) start = value.lastIndexOf("\n", token.start - 1) + 1;
      else break;
    }
    const parsed = parseListMarker(value.slice(start, end));
    if (parsed === null) return;
    yield parsed.marker;
  }
}

function renumberFollowingItems(
  value: string,
  lineEnd: number,
  marker: Extract<ListMarker, { kind: "ordered" }>,
  tokens: ReturnType<typeof inlineTokenRanges>,
) {
  const parts: string[] = [];
  const baseWidth = indentWidth(marker.indent);
  let expected = Number.parseInt(marker.numberText, 10);
  let position = lineEnd;
  let copiedUntil = lineEnd;
  let tokenIndex = 0;
  while (position < value.length && Number.isSafeInteger(expected)) {
    const lineStart = position + 1;
    const next = currentLine(value, lineStart);
    position = next.end;
    while (tokens[tokenIndex] && tokens[tokenIndex]!.end <= lineStart) tokenIndex += 1;
    if (tokens[tokenIndex] && tokens[tokenIndex]!.start < lineStart) continue;
    const width = indentWidth(next.text);
    if (next.text.trim() === "" || width < baseWidth) break;
    if (width > baseWidth) continue;
    const sibling = parseListMarker(next.text)?.marker;
    if (sibling?.kind !== "ordered" || sibling.delimiter !== marker.delimiter) break;
    const number = String(expected++);
    const replacement = sibling.numberText.startsWith("0")
      ? number.padStart(sibling.numberText.length, "0")
      : number;
    if (replacement === sibling.numberText) continue;
    const numberStart = lineStart + sibling.indent.length;
    parts.push(value.slice(copiedUntil, numberStart), replacement);
    copiedUntil = numberStart + sibling.numberText.length;
  }
  return parts.length === 0 ? null : { end: copiedUntil, text: parts.join("") };
}

/**
 * Tab nests an ordered item under its previous sibling and closes the numbering gap.
 * Other list items and items without a preceding sibling indent by two spaces.
 */
export function listIndentForTab(
  value: string,
  start: number,
  end: number,
): ComposerListEdit | null {
  if (!Number.isInteger(start) || start !== end || start < 0 || start > value.length) return null;
  const line = currentLine(value, start);
  const marker = parseListMarker(line.text)?.marker;
  if (!marker) return null;
  const tokens = inlineTokenRanges(value);
  if (isInsideInlineToken(tokens, start)) return null;
  if (marker.kind === "ordered") {
    const width = indentWidth(marker.indent);
    let previousChild: ListMarker | undefined;
    for (const above of precedingListMarkers(value, line.start, tokens)) {
      const aboveWidth = indentWidth(above.indent);
      if (aboveWidth > width) {
        if (!previousChild || aboveWidth < indentWidth(previousChild.indent)) {
          previousChild = above;
        }
        continue;
      }
      if (aboveWidth < width || above.kind !== "ordered" || above.delimiter !== marker.delimiter) {
        break;
      }
      const markerEnd = width + above.numberText.length + 1;
      const padding = indentWidth(above.space, markerEnd);
      const indent =
        previousChild?.indent ??
        above.indent + " ".repeat(markerEnd - width + (padding >= 1 && padding <= 4 ? padding : 1));
      const number =
        previousChild?.kind === "ordered" && previousChild.delimiter === marker.delimiter
          ? nextOrderedMarkerText(previousChild.numberText + marker.delimiter).slice(0, -1)
          : "1";
      const replacedEnd = line.start + marker.indent.length + marker.numberText.length;
      const replacement = indent + number;
      const cursorAfter =
        start < replacedEnd
          ? line.start + indent.length
          : start - replacedEnd + line.start + replacement.length;
      const renumbered = renumberFollowingItems(value, line.end, marker, tokens);
      return {
        start: line.start,
        end: renumbered?.end ?? replacedEnd,
        replacement:
          replacement +
          (renumbered === null ? "" : value.slice(replacedEnd, line.end) + renumbered.text),
        cursorAfter,
      };
    }
  }
  return { start: line.start, end: line.start, replacement: "  ", cursorAfter: start + 2 };
}
