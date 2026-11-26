import type { Root, RootContent } from "mdast";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

// Like web chat, only `~~double~~` tildes strike through.
const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false });
export type MarkdownNode = Root | RootContent;

function decodeCodePoint(codePoint: number, entity: string): string {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return entity;
  }
  return String.fromCodePoint(codePoint);
}

function decodeHtmlEntities(value: string): string {
  return value.replace(
    /&(?:#(\d+)|#x([0-9a-f]+)|amp|apos|gt|lt|nbsp|quot);/gi,
    (entity, decimal: string | undefined, hexadecimal: string | undefined) => {
      if (decimal) {
        return decodeCodePoint(Number.parseInt(decimal, 10), entity);
      }
      if (hexadecimal) {
        return decodeCodePoint(Number.parseInt(hexadecimal, 16), entity);
      }
      switch (entity.toLowerCase()) {
        case "&amp;":
          return "&";
        case "&apos;":
          return "'";
        case "&gt;":
          return ">";
        case "&lt;":
          return "<";
        case "&nbsp;":
          return "\u00a0";
        case "&quot;":
          return '"';
        default:
          return entity;
      }
    },
  );
}

const HTML_TAG = /<!--[\s\S]*?-->|<\/?[a-z](?:[^>"']|"[^"]*"|'[^']*')*>/gi;

function attribute(tag: string, name: string): string | null {
  const attributes = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const match of tag.matchAll(attributes)) {
    if (match[1]?.toLowerCase() === name) {
      return decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return null;
}

/** Called only for parsed HTML nodes, so Markdown code examples keep their literal tags. */
export function markdownHtmlContent(content: string): string {
  // An HTML block such as <details> can also contain Markdown fences and code spans.
  const codeRanges: Array<{ start: number; end: number }> = [];
  const tags = [...content.matchAll(HTML_TAG)];
  let tagIndex = 0;
  const delimiters = [...content.matchAll(/`+|~{3,}/g)].filter((delimiter) => {
    while (tags[tagIndex] && tags[tagIndex]!.index + tags[tagIndex]![0].length <= delimiter.index)
      tagIndex += 1;
    const tag = tags[tagIndex];
    return !tag || delimiter.index < tag.index;
  });
  for (let index = 0; index < delimiters.length; index += 1) {
    const opening = delimiters[index]!;
    const lineStart = content.lastIndexOf("\n", opening.index - 1) + 1;
    const fenced =
      opening[0].length >= 3 && /^ {0,3}$/.test(content.slice(lineStart, opening.index));
    if (opening[0][0] === "~" && !fenced) continue;
    let closingIndex = -1;
    for (let candidate = index + 1; candidate < delimiters.length; candidate += 1) {
      const closing = delimiters[candidate]!;
      if (!fenced && closing[0] === opening[0]) {
        closingIndex = candidate;
        break;
      }
      if (!fenced || closing[0][0] !== opening[0][0] || closing[0].length < opening[0].length)
        continue;
      const start = content.lastIndexOf("\n", closing.index - 1) + 1;
      const nextLine = content.indexOf("\n", closing.index);
      const end = nextLine === -1 ? content.length : nextLine;
      if (
        /^ {0,3}$/.test(content.slice(start, closing.index)) &&
        /^\s*$/.test(content.slice(closing.index + closing[0].length, end))
      ) {
        closingIndex = candidate;
        break;
      }
    }
    if (closingIndex === -1) {
      if (fenced) codeRanges.push({ start: opening.index, end: content.length });
      continue;
    }
    const closing = delimiters[closingIndex]!;
    codeRanges.push({ start: opening.index, end: closing.index + closing[0].length });
    index = closingIndex;
  }
  return content.replace(HTML_TAG, (tag, offset: number) => {
    if (codeRanges.some((range) => offset >= range.start && offset < range.end)) return tag;
    if (tag.startsWith("<!--")) return "";
    if (/^<img\b/i.test(tag)) {
      const src = attribute(tag, "src");
      if (!src) return "";
      const alt = (attribute(tag, "alt") ?? "").replace(/[\\[\]&]/g, "\\$&");
      const href = src
        .replace(/&/g, "\\&")
        .replace(/</g, "%3C")
        .replace(/>/g, "%3E")
        .replace(/\n/g, "");
      return `![${alt}](<${href}>)`;
    }
    if (/^<summary\b/i.test(tag)) return "\n\n**";
    if (/^<\/summary\s*>/i.test(tag)) return "**\n\n";
    if (/^<br\b/i.test(tag)) return "  \n";
    if (/^<\/?(?:p|div|details)\b/i.test(tag)) return "\n\n";
    return "";
  });
}

const MAY_HAVE_HTML = /<(?:!--|\/?[a-z])/i;
// Closed top-level fences, matched in document order, and one-line single-backtick spans.
const CODE_FENCE =
  /^ {0,3}(?:(`{3,})[^`\n]*\n[\s\S]*?^ {0,3}\1`*|(~{3,})[^\n]*\n[\s\S]*?^ {0,3}\2~*)[ \t]*$/gm;
const CODE_SPAN = /(^|[^`])`[^`\n]+`(?!`)/g;

/**
 * Whether a tag-like run may sit outside code. Agent replies are full of `<View>` and
 * `Array<string>` in code, and the full parse below is a long frame on Hermes for each
 * row that mounts while a chat scrolls. Unusual code (escaped backticks, nested or
 * unclosed fences) keeps a tag visible here, so a wrong guess only costs the parse.
 */
function mayHaveHtmlOutsideCode(markdown: string): boolean {
  if (!MAY_HAVE_HTML.test(markdown)) return false;
  if (markdown.includes("\\`")) return true;
  return MAY_HAVE_HTML.test(markdown.replace(CODE_FENCE, "").replace(CODE_SPAN, "$1"));
}

/** Convert parsed HTML fragments only, preserving Markdown code and source around them. */
export function markdownWithHtml(markdown: string): string {
  if (!mayHaveHtmlOutsideCode(markdown)) return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "html") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined)
        edits.push({ start, end, content: markdownHtmlContent(node.value) });
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(parser.parse(markdown));
  for (const edit of edits.reverse())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return markdown;
}

// A delimiter row such as `|---|:--:|`, possibly inside a blockquote or list item.
function isTableDelimiterRow(line: string): boolean {
  if (!line.includes("-")) return false;
  const row = line.replace(/^[ \t>]+/, "").trim();
  return row
    .replace(/^\||\|$/g, "")
    .split("|")
    .every((cell) => /^:?-+:?$/.test(cell.trim()));
}

// Cheap pre-check for a delimiter row two lines below text, so most messages skip the parse.
function mayHaveTableUnderText(markdown: string): boolean {
  if (!markdown.includes("|")) return false;
  const lines = markdown.split(/\r\n|\r|\n/);
  for (let index = 2; index < lines.length; index += 1) {
    if (isTableDelimiterRow(lines[index]!) && /[^\s>]/.test(lines[index - 2]!)) return true;
  }
  return false;
}

/**
 * GFM lets a table interrupt a paragraph, but the native parser (md4c) only starts a table
 * on a paragraph's first line, so a table right under a line of text renders as one
 * run-on paragraph. Insert the blank line md4c needs before each such table.
 */
export function markdownWithTableBreaks(markdown: string): string {
  if (!mayHaveTableUnderText(markdown)) return markdown;
  const lineStarts: number[] = [];
  const visit = (node: MarkdownNode) => {
    if (!("children" in node)) return;
    node.children.forEach((child, index) => {
      const previous = node.children[index - 1];
      const start = child.position?.start;
      if (
        child.type === "table" &&
        previous?.type === "paragraph" &&
        start?.offset !== undefined &&
        previous.position?.end.line === start.line - 1
      )
        lineStarts.push(
          Math.max(
            markdown.lastIndexOf("\n", start.offset - 1),
            markdown.lastIndexOf("\r", start.offset - 1),
          ) + 1,
        );
      visit(child);
    });
  };
  visit(parser.parse(markdown));
  for (const lineStart of lineStarts.reverse()) {
    // The header row may be a lazy line without its container markers (`>` or list indent),
    // so copy the delimiter row's markers onto the blank line and the header row.
    const [, header = "", cells = "", ending = "\n", markers = ""] =
      /^([ \t>]*)([^\r\n]*)(\r\n|\r|\n)([ \t>]*)/.exec(markdown.slice(lineStart)) ?? [];
    markdown =
      markdown.slice(0, lineStart) +
      `${markers.trimEnd()}${ending}${markers}${cells}` +
      markdown.slice(lineStart + header.length + cells.length);
  }
  return markdown;
}

// A tilde with no tilde beside it that is not already escaped.
const LONE_TILDE = /(?<![~\\])~(?!~)/g;

/**
 * md4c, like GitHub, strikes through text between single tildes, so "~$10 to ~$25" or
 * "~/repo and ~/.config" renders struck out. Escape each lone tilde in prose so only
 * `~~double~~` strikes, as on web. Code and autolinked URLs keep their source.
 */
const LINE_ENDING = /\r\n|\r|\n/;

/** A path or URL, not a placeholder such as `…` written in prose. */
function looksLikeImageSource(url: string): boolean {
  return /\w/.test(url) && /[./:]/.test(url);
}

/**
 * The native renderer draws an image at text size when anything comes before
 * it on its line. Agents write "Here's the chart: ![chart](path)", so each image
 * that shares a paragraph gets a paragraph of its own and shows full width.
 * Images inside links (badges) and other inline markup stay where they are, and
 * so does an image whose source is only a placeholder, which can never load.
 */
export function markdownWithBlockImages(markdown: string): string {
  if (!markdown.includes("![")) return markdown;
  const edits: Array<{ start: number; end: number; content: string }> = [];
  const visit = (node: MarkdownNode) => {
    if (!("children" in node)) return;
    if (node.type !== "paragraph") {
      node.children.forEach(visit);
      return;
    }
    const parts = node.children.filter(
      (child) => child.type !== "break" && !(child.type === "text" && child.value.trim() === ""),
    );
    const isImage = (child: MarkdownNode) =>
      child.type === "imageReference" ||
      (child.type === "image" && looksLikeImageSource(child.url));
    const start = node.position?.start;
    const end = node.position?.end.offset;
    if (
      parts.length < 2 ||
      !parts.some(isImage) ||
      start?.offset === undefined ||
      end === undefined
    )
      return;
    const lineStart =
      Math.max(
        markdown.lastIndexOf("\n", start.offset - 1),
        markdown.lastIndexOf("\r", start.offset - 1),
      ) + 1;
    // Continuation lines keep the paragraph's container: quote markers stay, list markers indent.
    const prefix = markdown.slice(lineStart, start.offset).replace(/[^>\s]/g, " ");
    const ending = LINE_ENDING.exec(markdown)?.[0] ?? "\n";
    const separator = `${ending}${prefix.trimEnd()}${ending}${prefix}`;
    // A piece ends where its line's container markers begin; trim those with the spaces.
    const clean = (piece: string) =>
      piece
        .replace(/^[ \t]*(?:(?:\r\n|\r|\n)[ \t>]*)?/, "")
        .replace(/(?:\r\n|\r|\n)[ \t>]*$/, "")
        .trim();
    const pieces: string[] = [];
    let cursor = start.offset;
    for (const child of node.children) {
      const childStart = child.position?.start.offset;
      const childEnd = child.position?.end.offset;
      if (!isImage(child) || childStart === undefined || childEnd === undefined) continue;
      const before = clean(markdown.slice(cursor, childStart));
      if (before !== "") pieces.push(before);
      pieces.push(markdown.slice(childStart, childEnd));
      cursor = childEnd;
    }
    const after = clean(markdown.slice(cursor, end));
    if (after !== "") pieces.push(after);
    edits.push({ start: start.offset, end, content: pieces.join(separator) });
  };
  visit(parser.parse(markdown));
  for (const edit of edits.reverse())
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  return markdown;
}

export function markdownWithLiteralTildes(markdown: string): string {
  if (!markdown.includes("~")) return markdown;
  const offsets: number[] = [];
  const visit = (node: MarkdownNode) => {
    if (node.type === "text") {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) return;
      for (const match of markdown.slice(start, end).matchAll(LONE_TILDE))
        offsets.push(start + match.index);
    } else if (node.type === "link" && markdown[node.position?.start.offset ?? -1] !== "[") {
      // An autolink's text is its address, where a backslash would become part of the URL.
      return;
    } else if ("children" in node) node.children.forEach(visit);
  };
  visit(parser.parse(markdown));
  for (const offset of offsets.reverse())
    markdown = `${markdown.slice(0, offset)}\\${markdown.slice(offset)}`;
  return markdown;
}

const MERMAID_FENCE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*mermaid\b/m;
const CLOSING_FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/**
 * Swaps each closed top-level ```mermaid fence for a standalone image whose URL keys the
 * rendered diagram, so the native document reserves a media slot the app draws into.
 * Media slots only exist at the document root, and an unclosed fence is still streaming, so
 * those stay code blocks, as does any diagram `render` rejects.
 */
export function markdownWithMermaidDiagrams<Diagram>(
  markdown: string,
  render: (source: string, authored: string) => Diagram | null,
): { readonly markdown: string; readonly diagrams: ReadonlyMap<string, Diagram> } {
  const diagrams = new Map<string, Diagram>();
  if (!MERMAID_FENCE.test(markdown)) return { markdown, diagrams };
  const edits: Array<{ start: number; end: number; content: string }> = [];
  let prefix = "t3-mermaid:";
  while (markdown.includes(prefix)) prefix = `t3-${prefix}`;
  for (const node of parser.parse(markdown).children) {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (node.type !== "code" || node.lang !== "mermaid" || start === undefined || !end) continue;
    const lines = markdown.slice(start, end).split(/\r\n|\r|\n/);
    const opening = /^ *(`{3,}|~{3,})/.exec(lines[0]!)?.[1];
    const closing = lines.length > 1 ? CLOSING_FENCE.exec(lines.at(-1)!)?.[1] : undefined;
    if (!opening || !closing?.startsWith(opening)) continue;
    const diagram = node.value.trim() ? render(node.value, markdown.slice(start, end)) : null;
    if (diagram === null) continue;
    const url = `${prefix}${diagrams.size}`;
    diagrams.set(url, diagram);
    // The blank lines keep the image out of a neighbouring paragraph.
    edits.push({ start, end, content: `\n![Mermaid diagram](${url})\n` });
  }
  for (let index = edits.length - 1; index >= 0; index--) {
    const edit = edits[index]!;
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  }
  return { markdown, diagrams };
}

export function parseMarkdownDocument(markdown: string): Root {
  return parser.parse(markdownWithHtml(markdown));
}
