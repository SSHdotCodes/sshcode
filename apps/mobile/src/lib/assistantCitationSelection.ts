import { matchesTimelineJump } from "@t3tools/client-runtime/state/thread-search";
import {
  TurnItemId,
  type MessageId,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import {
  createAssistantTextSelector,
  type AssistantTextSelector,
} from "@t3tools/shared/assistantCitations";
import {
  renderCodexInlineDirectivesAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from "@t3tools/shared/codexMarkdownDirectives";
import { compactGithubMarkdownLinks } from "@t3tools/shared/githubLinks";
import { expandAbbreviatedInlineCodePaths } from "@t3tools/shared/markdownLinks";
import { parseMarkdownDocument, type MarkdownNode } from "./markdownDocument";
import { splitMarkdownImageGroups, type MarkdownImageGroupSegment } from "./markdownImageGroups";

export type AssistantMarkdownRow = { readonly key: string } & (
  | MarkdownImageGroupSegment
  | Extract<
      ReturnType<typeof splitCodexArtifactTemplateMarkdown>[number],
      { readonly kind: "artifact-template" }
    >
);

/**
 * The rows the feed draws for one assistant message: artifact cards, lifted image strips and
 * markdown text. A markdown row's key names it when the user cites text selected inside it.
 */
export function splitAssistantMarkdown(markdown: string): ReadonlyArray<AssistantMarkdownRow> {
  return splitCodexArtifactTemplateMarkdown(markdown).flatMap((segment): AssistantMarkdownRow[] =>
    segment.kind === "artifact-template"
      ? [{ ...segment, key: `artifact-template:${segment.sourceOffset}` }]
      : splitMarkdownImageGroups(renderCodexInlineDirectivesAsMarkdown(segment.markdown)).map(
          (part) => ({ ...part, key: `${part.kind}:${segment.sourceOffset}.${part.sourceOffset}` }),
        ),
  );
}

const INLINE_PARENTS = new Set([
  "paragraph",
  "heading",
  "link",
  "linkReference",
  "emphasis",
  "strong",
  "delete",
  "tableCell",
]);

/** Displayed text, with a line break between blocks the way the Mac reads its rendered DOM. */
function renderedText(node: MarkdownNode): string {
  if (
    node.type === "definition" ||
    node.type === "footnoteDefinition" ||
    node.type === "image" ||
    node.type === "imageReference" ||
    node.type === "html" ||
    (node.type === "code" && node.lang === "mermaid")
  ) {
    return "";
  }
  if ("value" in node) return node.value;
  if ("children" in node) {
    return node.children
      .map(renderedText)
      .filter((text) => text.length > 0)
      .join(INLINE_PARENTS.has(node.type) ? "" : "\n");
  }
  return node.type === "break" ? "\n" : "";
}

// The text-changing rewrites the native view applies before it draws (EnrichedMarkdownText).
function displayedMarkdown(markdown: string): string {
  return compactGithubMarkdownLinks(expandAbbreviatedInlineCodePaths(markdown));
}

function assistantCitationText(markdown: string): string {
  return renderedText(parseMarkdownDocument(displayedMarkdown(markdown)));
}

function occurrences(text: string, quote: string): number[] {
  const result: number[] = [];
  for (let index = text.indexOf(quote); index !== -1; index = text.indexOf(quote, index + 1)) {
    result.push(index);
  }
  return result;
}

const normalize = (value: string) => value.replace(/\s+/g, " ");

/** Beyond this many copies in one row, a short selection says too little to cite. */
const MAX_ROW_OCCURRENCES = 20;

export interface AssistantCitationChoice {
  readonly selector: AssistantTextSelector;
  /** Which copy of the quote in the whole message, counted from 0. */
  readonly index: number;
  readonly count: number;
}

/**
 * Every place in one markdown row that the selected text could have come from, with offsets
 * and context in the message's normalized rendered text. Several choices mean the passage
 * repeats inside the row; none means the selection cannot be mapped back to its source.
 */
export function collectAssistantTextChoices(
  markdown: string,
  rowKey: string,
  text: string,
): ReadonlyArray<AssistantCitationChoice> {
  if (!text.trim()) return [];
  const quote = normalize(text);
  const rows = splitAssistantMarkdown(markdown).flatMap((row) =>
    row.kind === "markdown" ? [{ key: row.key, text: assistantCitationText(row.markdown) }] : [],
  );
  const segments = rows.filter((row) => row.text.trim().length > 0);
  const rowIndex = segments.findIndex((row) => row.key === rowKey);
  const row = segments[rowIndex];
  if (!row) return [];
  const fullText = normalize(segments.map((entry) => entry.text).join("\n"));
  const throughRow = segments
    .slice(0, rowIndex + 1)
    .map((entry) => entry.text)
    .join("\n");
  const offset = normalize(throughRow).length - normalize(row.text).length;
  const matches = occurrences(fullText, quote);
  const localMatches = occurrences(normalize(row.text), quote);
  if (localMatches.length > MAX_ROW_OCCURRENCES) return [];
  return localMatches.flatMap((localStart) => {
    const start = offset + localStart;
    const index = matches.indexOf(start);
    if (index === -1) return [];
    const selector = createAssistantTextSelector(fullText, start, start + quote.length);
    return selector ? [{ selector: { ...selector, text }, index, count: matches.length }] : [];
  });
}

/* Native position matching -------------------------------------------------------------- */

/** A native selection: the text with link pills spelled out, and its offsets in one text view. */
export interface NativeTextSelection {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export interface NativeLinkRecognition {
  /** Links the view draws as one-character pills, by URL. */
  readonly isPill: (url: string) => boolean;
  /** Text the view turns into links itself (skills, models); the match is the URL. */
  readonly text?: RegExp | null | undefined;
  /** Whole inline-code spans the view turns into links; the span is the URL. */
  readonly inlineCode?: RegExp | undefined;
}

/** Characters as the selection reports them, each with its offset in the view's storage. */
type NativeView = { text: string; storage: number[]; next: number };

const BLOCK_VIEW_TYPES = new Set(["code", "table", "blockquote", "math"]);
const OBJECT = "￼";

function nativeViews(root: MarkdownNode, links: NativeLinkRecognition): NativeView[] {
  const views: NativeView[] = [];
  let current: NativeView | null = null;
  const view = (): NativeView => ({ text: "", storage: [], next: 0 });
  const push = (target: NativeView, text: string, storageLength = text.length) => {
    const at = target.next;
    for (let index = 0; index < text.length; index++) {
      target.storage.push(storageLength === text.length ? at + index : at);
    }
    target.text += text;
    target.next += storageLength;
  };
  const newline = (target: NativeView) => {
    if (target.text.length > 0 && !target.text.endsWith("\n")) push(target, "\n");
  };
  const plainText = (node: MarkdownNode): string =>
    "value" in node
      ? node.value
      : "children" in node
        ? node.children.map(plainText).join("")
        : node.type === "break"
          ? "\n"
          : "";
  const inline = (target: NativeView, node: MarkdownNode): void => {
    switch (node.type) {
      case "text": {
        const pattern = links.text ? new RegExp(links.text.source, "gu") : null;
        let cursor = 0;
        for (const match of pattern ? node.value.matchAll(pattern) : []) {
          if (!links.isPill(match[0])) continue;
          push(target, node.value.slice(cursor, match.index));
          push(target, match[0], 1);
          cursor = match.index + match[0].length;
        }
        push(target, node.value.slice(cursor));
        return;
      }
      case "inlineCode":
        push(
          target,
          node.value,
          links.inlineCode?.test(node.value) && links.isPill(node.value) ? 1 : node.value.length,
        );
        return;
      case "link":
        if (links.isPill(node.url)) {
          push(target, plainText(node), 1);
          return;
        }
        break;
      case "image":
      case "imageReference":
        push(target, OBJECT);
        return;
      case "break":
        push(target, "\n");
        return;
      case "html":
      case "definition":
      case "footnoteDefinition":
        return;
    }
    if ("children" in node) for (const child of node.children) inline(target, child);
  };
  const block = (target: NativeView, node: MarkdownNode): void => {
    if (node.type === "list") {
      for (const item of node.children) block(target, item);
      return;
    }
    if (node.type === "listItem") {
      for (const child of node.children) block(target, child);
      return;
    }
    if (node.type === "thematicBreak") {
      newline(target);
      push(target, `${OBJECT}\n`);
      return;
    }
    newline(target);
    // A heading opening a view gets a spacer line for its top margin.
    if (node.type === "heading" && target.text.length === 0) push(target, "\n");
    inline(target, node);
  };
  if (!("children" in root)) return views;
  for (const node of root.children) {
    if (BLOCK_VIEW_TYPES.has(node.type)) {
      if (current) views.push(current);
      current = null;
      if (node.type === "blockquote") {
        views.push(...nativeViews(node, links));
      } else if (node.type === "table") {
        for (const row of node.children)
          for (const cell of row.children) {
            const cellView = view();
            inline(cellView, cell);
            views.push(cellView);
          }
      } else if ("value" in node) {
        const codeView = view();
        push(codeView, node.value);
        views.push(codeView);
      }
      continue;
    }
    current ??= view();
    block(current, node);
  }
  if (current) views.push(current);
  return views;
}

/** How far a native offset may sit from the modelled one: spacer lines, list and quote markers. */
const MAX_NATIVE_DRIFT = 4;
/** The runner-up must be this much farther away before the nearest copy is trusted. */
const MIN_NATIVE_LEAD = 8;

/**
 * Which copy of the selected text, in document order, a native selection sits on. The view
 * reports offsets inside one of its text views, and those offsets drift a little from any
 * model (spacer lines, list markers), so the nearest copy only counts when it clearly wins.
 * Null means the position cannot tell the copies apart.
 */
export function nativeSelectionOccurrence(
  markdown: string,
  selection: NativeTextSelection,
  links: NativeLinkRecognition,
): { readonly index: number; readonly count: number } | null {
  const quote = normalize(selection.text);
  if (!quote.trim()) return null;
  const candidates: number[] = [];
  for (const view of nativeViews(parseMarkdownDocument(markdown), links)) {
    // Normalize while remembering where each normalized character came from.
    let normalized = "";
    const source: number[] = [];
    for (let index = 0; index < view.text.length; index++) {
      const space = /\s/.test(view.text[index]!);
      if (space && index > 0 && /\s/.test(view.text[index - 1]!)) continue;
      normalized += space ? " " : view.text[index];
      source.push(index);
    }
    for (const start of occurrences(normalized, quote)) {
      candidates.push(view.storage[source[start]!]!);
    }
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return { index: 0, count: 1 };
  const distances = candidates.map((offset) => Math.abs(offset - selection.start));
  const nearest = distances.indexOf(Math.min(...distances));
  const runnerUp = Math.min(...distances.filter((_, index) => index !== nearest));
  return distances[nearest]! <= MAX_NATIVE_DRIFT &&
    runnerUp - distances[nearest]! >= MIN_NATIVE_LEAD
    ? { index: nearest, count: candidates.length }
    : null;
}

/**
 * Picks the cited copy: the only one, or the one the native selection sits on when both
 * models count the same copies. Null asks the user to choose.
 */
export function resolveAssistantTextChoice(
  choices: ReadonlyArray<AssistantCitationChoice>,
  occurrence: { readonly index: number; readonly count: number } | null,
): AssistantCitationChoice | null {
  if (choices.length === 1) return choices[0]!;
  if (occurrence === null || occurrence.count !== choices.length) return null;
  return choices[occurrence.index] ?? null;
}

/**
 * The cited reply is no longer in a chat whose whole history is loaded, so there is nothing to
 * show in chat (it was rewound, or edited and resent). Unknown while history is still partial.
 */
export function citedMessageMissing(
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem> | null,
  hasMoreHistory: boolean,
  messageId: MessageId,
): boolean {
  if (items === null || hasMoreHistory) return false;
  const target = { sourceItemId: TurnItemId.make(messageId), messageId };
  return !items.some((row) => matchesTimelineJump(row, target));
}
