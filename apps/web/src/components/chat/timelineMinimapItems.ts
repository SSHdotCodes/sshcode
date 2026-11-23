import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";
import type { Nodes } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export interface TimelineMinimapItem {
  readonly id: string;
  readonly rowIndex: number;
  readonly userText: string | null;
  readonly assistantText: string | null;
}

export interface TimelineMinimapBucket {
  readonly firstIndex: number;
  readonly lastIndex: number;
  readonly topPercent: number;
}

/** Keep ticks at least eight pixels apart, regardless of loaded history length. */
export function deriveTimelineMinimapBuckets(
  itemCount: number,
  railHeight: number,
): TimelineMinimapBucket[] {
  if (itemCount <= 0 || railHeight <= 0) return [];
  const bucketCount = Math.min(itemCount, Math.floor(railHeight / 8) + 1);
  return Array.from({ length: bucketCount }, (_, index) => ({
    firstIndex: Math.floor((index * itemCount) / bucketCount),
    lastIndex: Math.floor(((index + 1) * itemCount) / bucketCount) - 1,
    topPercent: bucketCount === 1 ? 0 : (index / (bucketCount - 1)) * 100,
  }));
}

/** Keep full source text untouched until a minimap preview is opened. */
export function deriveTimelineMinimapItems(
  rows: ReadonlyArray<MessagesTimelineRow>,
): TimelineMinimapItem[] {
  const items: TimelineMinimapItem[] = [];
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (
      row?.kind !== "message" ||
      row.message.role !== "user" ||
      row.message.senderThreadId !== undefined ||
      row.message.createdBy === "agent" ||
      row.message.questionAnswer !== undefined ||
      row.message.id.startsWith("async-answer:")
    ) {
      continue;
    }

    items.push({
      id: row.id,
      rowIndex: index,
      userText: row.message.text,
      assistantText: resolveFinalAssistantTextForTurn(rows, index),
    });
  }
  return items;
}

/** Navigate from the reading position, excluding a prompt already aligned at the top. */
export function resolveTimelinePromptJump(
  items: ReadonlyArray<TimelineMinimapItem>,
  positionAtIndex: (index: number) => number | undefined,
  anchorTop: number,
  direction: -1 | 1,
): TimelineMinimapItem | null {
  const candidates = direction === -1 ? items.toReversed() : items;
  for (const item of candidates) {
    const top = positionAtIndex(item.rowIndex);
    if (top === undefined || !Number.isFinite(top)) continue;
    if (direction === -1 ? top < anchorTop - 2 : top > anchorTop + 2) return item;
  }
  return null;
}

function resolveFinalAssistantTextForTurn(
  rows: ReadonlyArray<MessagesTimelineRow>,
  userRowIndex: number,
) {
  let finalAssistantText: string | null = null;
  for (let index = userRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row?.kind !== "message") {
      continue;
    }
    if (row.message.role === "user") {
      break;
    }
    if (row.message.role === "assistant") {
      finalAssistantText = row.message.text ?? null;
    }
  }
  return finalAssistantText;
}

const markdownPreviewParser = unified().use(remarkParse).use(remarkGfm).freeze();

const INLINE_PARENT_TYPES = new Set<Nodes["type"]>([
  "paragraph",
  "heading",
  "tableCell",
  "emphasis",
  "strong",
  "delete",
  "link",
  "linkReference",
]);

function markdownNodeText(node: Nodes): string {
  if (node.type === "html") {
    return node.value
      .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
      .replace(/<\/?([a-z][\w-]*)(?:[^"'<>]|"[^"]*"|'[^']*')*>/gi, (_, tag: string) =>
        /^(?:address|article|aside|blockquote|br|dd|details|div|dl|dt|figcaption|figure|footer|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|summary|table|tbody|td|th|thead|tr|ul)$/i.test(
          tag,
        )
          ? " "
          : "",
      );
  }
  if (node.type === "break") return " ";
  if ("value" in node) return node.value;
  if (node.type === "image" || node.type === "imageReference") return node.alt ?? "";
  if (!("children" in node)) return "";
  const separator = INLINE_PARENT_TYPES.has(node.type) ? "" : " ";
  const text = node.children.map(markdownNodeText).join(separator);
  // A thread autolink's only text is its URL.
  return node.type === "link" && parseThreadLinkHref(text) !== null ? "a thread" : text;
}

// The tooltip shows a few lines; bound parsing work for long messages and streaming responses.
function markdownMinimapPreview(markdown: string | null) {
  if (markdown === null) return null;
  const compact = markdownNodeText(markdownPreviewParser.parse(markdown.slice(0, 1_500)))
    .replace(/\s+/g, " ")
    .trim();
  return compact.length > 0 ? compact : null;
}

export function resolveTimelineMinimapPreview(
  item: TimelineMinimapItem | null,
): TimelineMinimapItem | null {
  return item === null
    ? null
    : {
        ...item,
        // Before markdown parsing, which would reduce a citation link to "Assistant quote".
        userText: markdownMinimapPreview(
          item.userText === null
            ? null
            : assistantCitationsToPlainText(
                replaceComposerContextReferences(item.userText, (reference) => reference.label),
              ),
        ),
        assistantText: markdownMinimapPreview(item.assistantText),
      };
}
