/**
 * Converts a DOM selection inside rendered chat markdown back into markdown
 * source so highlight-and-copy keeps formatting (links, emphasis, lists,
 * fences, tables) instead of flattening to plain text. The `text/plain`
 * clipboard flavor carries the markdown; `text/html` carries a sanitized
 * copy of the rendered fragment for rich-paste targets.
 */

const SKIPPED_TAGS = new Set(["BUTTON", "INPUT", "SCRIPT", "STYLE", "TEMPLATE"]);
const SKIPPED_CLASS_NAMES = ["select-none", "sr-only"];
const SANITIZED_HTML_SELECTOR = [
  "button",
  "input",
  "script",
  "style",
  "svg",
  '[aria-hidden="true"]',
  ...SKIPPED_CLASS_NAMES.map((className) => `.${className}`),
].join(", ");

export interface MarkdownClipboardPayload {
  text: string;
  html: string;
}

function isSkippedElement(element: Element): boolean {
  if (SKIPPED_TAGS.has(element.tagName) || element.localName === "svg") return true;
  if (element.getAttribute("aria-hidden") === "true") return true;
  return SKIPPED_CLASS_NAMES.some((className) => element.classList.contains(className));
}

/** Hoists surrounding whitespace outside the markers: "` bold `" → " **bold** ". */
function wrapInlineMarker(content: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(content);
  const core = match?.[2] ?? "";
  if (!core) return content;
  return `${match?.[1] ?? ""}${marker}${core}${marker}${match?.[3] ?? ""}`;
}

/**
 * A code element whose pre wrapper fell outside the copied range is still
 * block code, recognizable by its highlighter line spans or embedded
 * newlines. Wrapping it like inline code produces backtick-surrounded
 * shell commands on paste.
 */
function isBlockCodeElement(element: Element, content: string): boolean {
  if (content.includes("\n")) return true;
  for (const child of element.childNodes) {
    if (child.nodeType === Node.ELEMENT_NODE && (child as Element).classList.contains("line")) {
      return true;
    }
  }
  return false;
}

function wrapInlineCode(code: string): string {
  const longestRun = [...(code.match(/`+/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  const fence = "`".repeat(Math.max(1, longestRun + (longestRun > 0 ? 1 : 0)));
  // CommonMark strips one edge space from content that has both and isn't all spaces.
  const spaceEdges = code.startsWith(" ") && code.endsWith(" ") && /[^ ]/.test(code);
  const pad = spaceEdges || code.startsWith("`") || code.endsWith("`") ? " " : "";
  return `${fence}${pad}${code}${pad}${fence}`;
}

function codeFenceFor(code: string): string {
  const longestRun = [...(code.match(/`{3,}/g) ?? [])].reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  return "`".repeat(Math.max(3, longestRun + 1));
}

function resolveCodeBlockLanguage(pre: Element): string | null {
  const declared =
    pre.closest("[data-language]")?.getAttribute("data-language") ??
    /(?:^|\s)language-(\S+)/.exec(pre.querySelector("code")?.className ?? "")?.[1] ??
    null;
  return declared && declared !== "text" ? declared : null;
}

function serializeCodeBlock(pre: Element): string {
  const code = (pre.textContent ?? "").replace(/\n$/, "");
  const fence = codeFenceFor(code);
  return `${fence}${resolveCodeBlockLanguage(pre) ?? ""}\n${code}\n${fence}\n\n`;
}

function serializeTableCell(cell: Element): string {
  return serializeChildren(cell).replace(/\n+/g, " ").trim().replaceAll("|", "\\|");
}

function tableSeparatorFor(headerCells: Element[]): string {
  const markers = headerCells.map((cell) => {
    const align = (cell as HTMLElement).style?.textAlign ?? cell.getAttribute("align") ?? "";
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    return "---";
  });
  return `| ${markers.join(" | ")} |`;
}

function serializeTable(table: Element): string {
  const rows = [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")];
  if (rows.length === 0) return "";
  const lines: string[] = [];
  let emittedSeparator = false;
  for (const row of rows) {
    const cells = [...row.children].filter(
      (cell) => cell.tagName === "TH" || cell.tagName === "TD",
    );
    if (cells.length === 0) continue;
    lines.push(`| ${cells.map((cell) => serializeTableCell(cell)).join(" | ")} |`);
    if (!emittedSeparator) {
      lines.push(tableSeparatorFor(cells));
      emittedSeparator = true;
    }
  }
  return `${lines.join("\n")}\n\n`;
}

function serializeListItem(item: Element, ordered: boolean, index: number): string {
  const checkbox = item.querySelector(
    ':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]',
  );
  const task = checkbox ? `[${(checkbox as HTMLInputElement).checked ? "x" : " "}] ` : "";
  const marker = ordered ? `${index}. ${task}` : `- ${task}`;
  let content = serializeChildren(item)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // Tight list items (no paragraph children) keep nested lists on adjacent lines.
  if (!item.querySelector(":scope > p")) {
    content = content.replace(/\n{2,}/g, "\n");
  }
  const continuationIndent = " ".repeat(marker.length);
  const [first = "", ...rest] = content.split("\n");
  return [
    `${marker}${first}`,
    ...rest.map((line) => (line.length > 0 ? `${continuationIndent}${line}` : line)),
  ].join("\n");
}

/** A list's items with the numbers an ordered list shows: from `start`, reset by each `value`. */
function numberedListItems(list: Element): { item: Element; number: number }[] {
  const start = Number.parseInt(list.getAttribute("start") ?? "1", 10);
  let next = Number.isNaN(start) ? 1 : start;
  return [...list.children]
    .filter((child) => child.tagName === "LI")
    .map((item) => {
      const value = Number.parseInt(item.getAttribute("value") ?? "", 10);
      if (!Number.isNaN(value)) next = value;
      return { item, number: next++ };
    });
}

function serializeList(list: Element, ordered: boolean): string {
  const items = numberedListItems(list);
  if (items.length === 0) return "";
  return `${items.map(({ item, number }) => serializeListItem(item, ordered, number)).join("\n")}\n\n`;
}

function serializeBlockquote(quote: Element): string {
  const content = serializeChildren(quote)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!content) return "";
  const quoted = content
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${quoted}\n\n`;
}

function serializeDetails(details: Element): string {
  const summary =
    details.querySelector(":scope > [data-markdown-details-summary]")?.textContent?.trim() ??
    "Details";
  const contentNode = details.querySelector(":scope > * [data-markdown-details-content]");
  const content = contentNode ? serializeChildren(contentNode).trim() : "";
  const open = details.getAttribute("data-markdown-details-open") === "true" ? " open" : "";
  return `<details${open}>\n<summary>${summary}</summary>${content ? `\n\n${content}` : ""}\n</details>\n\n`;
}

function serializeAnchor(anchor: Element): string {
  const markdownCopy = anchor.getAttribute("data-markdown-copy");
  if (markdownCopy !== null) return markdownCopy;
  const content = serializeChildren(anchor);
  const href = anchor.getAttribute("href") ?? "";
  if (!/^https?:\/\//i.test(href)) return content;
  const label = content.trim();
  if (!label) return "";
  if (label === href) return href;
  return `[${label}](${href})`;
}

function serializeChildren(node: Node): string {
  let out = "";
  for (const child of node.childNodes) {
    out += serializeNode(child);
  }
  return out;
}

function serializeNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent ?? "";
    // Inter-block formatting whitespace from the renderer collapses to a
    // newline; real inline whitespace passes through untouched.
    if (text.includes("\n") && text.trim().length === 0) return "\n";
    return text;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (element.hasAttribute("data-markdown-details")) {
    return serializeDetails(element);
  }
  const markdownCopy = element.getAttribute("data-markdown-copy");
  if (markdownCopy !== null) return markdownCopy;
  if (isSkippedElement(element)) return "";

  const headingLevel = /^H([1-6])$/.exec(element.tagName)?.[1];
  if (headingLevel) {
    return `${"#".repeat(Number(headingLevel))} ${serializeChildren(element).trim()}\n\n`;
  }

  switch (element.tagName) {
    case "BR":
      return "\n";
    case "HR":
      return "---\n\n";
    case "P":
      return `${serializeChildren(element).trim()}\n\n`;
    case "PRE":
      return serializeCodeBlock(element);
    case "CODE": {
      const content = element.textContent ?? "";
      return isBlockCodeElement(element, content) ? content : wrapInlineCode(content);
    }
    case "STRONG":
    case "B":
      return wrapInlineMarker(serializeChildren(element), "**");
    case "EM":
    case "I":
      return wrapInlineMarker(serializeChildren(element), "*");
    case "DEL":
    case "S":
      return wrapInlineMarker(serializeChildren(element), "~~");
    case "A":
      return serializeAnchor(element);
    case "IMG": {
      const alt = element.getAttribute("alt") ?? "";
      const src = element.getAttribute("src") ?? "";
      return alt && src ? `![${alt}](${src})` : "";
    }
    case "UL":
      return serializeList(element, false);
    case "OL":
      return serializeList(element, true);
    case "BLOCKQUOTE":
      return serializeBlockquote(element);
    case "TABLE":
      return serializeTable(element);
    case "DIV":
    case "SECTION":
    case "ARTICLE": {
      const content = serializeChildren(element);
      return content && !content.endsWith("\n") ? `${content}\n` : content;
    }
    default:
      return serializeChildren(element);
  }
}

/**
 * Tracks whether a fragment carries exactly one code block and nothing else a
 * reader would see.
 */
interface SoleCodeBlockScan {
  pre: Element | null;
  other: boolean;
}

function scanForSoleCodeBlock(node: Node, scan: SoleCodeBlockScan): void {
  for (const child of node.childNodes) {
    if (scan.other) return;
    if (child.nodeType === Node.TEXT_NODE) {
      if ((child.textContent ?? "").trim().length > 0) scan.other = true;
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    // Mirrors serializeNode's order: an element carrying markdown of its own
    // still contributes it even when its tag is otherwise skipped, as a file
    // chip rendered as a button does.
    if (element.hasAttribute("data-markdown-details")) {
      scan.other = true;
      continue;
    }
    const markdownCopy = element.getAttribute("data-markdown-copy");
    if (markdownCopy !== null) {
      if (markdownCopy.trim().length > 0) scan.other = true;
      continue;
    }
    if (isSkippedElement(element)) continue;
    if (element.tagName === "PRE") {
      if (scan.pre) scan.other = true;
      else scan.pre = element;
      continue;
    }
    if (element.tagName === "IMG" || element.tagName === "HR") {
      scan.other = true;
      continue;
    }
    if (element.tagName === "LI") {
      // serializeListItem emits a marker ("- ", "1. ", "[x] ") for every item,
      // so an item that does not hold the block carries content of its own even
      // when it renders no text. An item that wraps the block is just the
      // structure around it, and a pre-only selection would drop the marker too.
      const preBeforeItem = scan.pre;
      scanForSoleCodeBlock(element, scan);
      if (!scan.other && scan.pre === preBeforeItem) scan.other = true;
      continue;
    }
    scanForSoleCodeBlock(element, scan);
  }
}

/**
 * A drag that ends on a block's final newline pulls the closing `pre` into the
 * range, so the fragment holds the whole block even though the user only
 * highlighted code. Re-fencing that pastes stray backticks, so a fragment whose
 * only visible content is one code block copies as plain code, matching a
 * selection that never left the `pre`.
 */
function soleCodeBlock(container: Node): Element | null {
  const scan: SoleCodeBlockScan = { pre: null, other: false };
  scanForSoleCodeBlock(container, scan);
  return scan.other ? null : scan.pre;
}

/** Collapses serializer spacing artifacts without touching fenced code content. */
function tidyMarkdown(markdown: string): string {
  return markdown
    .split(/(```[\s\S]*?(?:```|$))/)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/[ \t]+(?=\n)/g, "").replace(/\n{3,}/g, "\n\n"),
    )
    .join("")
    .trim();
}

export function serializeRenderedMarkdownFragment(container: Node): string {
  const codeBlock = soleCodeBlock(container);
  if (codeBlock) return (codeBlock.textContent ?? "").replace(/\n$/, "");
  return tidyMarkdown(serializeChildren(container));
}

export function serializeTableElementToMarkdown(table: Element): string {
  return serializeTable(table).trim();
}

function mathSourceElement(wrapper: Element): Element {
  const code = document.createElement("code");
  code.textContent = wrapper.getAttribute("data-markdown-copy") ?? "";
  return code;
}

function csvCellText(cell: Element): string {
  const copy = cell.cloneNode(true) as Element;
  for (const wrapper of copy.querySelectorAll("[data-markdown-math]")) {
    wrapper.replaceWith(mathSourceElement(wrapper));
  }
  return copy.textContent ?? "";
}

function csvCell(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return /[",\n]/.test(normalized) ? `"${normalized.replaceAll('"', '""')}"` : normalized;
}

export function serializeTableElementToCsv(table: Element): string {
  const rows = [...table.querySelectorAll(":scope > thead > tr, :scope > tbody > tr, :scope > tr")];
  const lines: string[] = [];
  for (const row of rows) {
    const cells = [...row.children].filter(
      (cell) => cell.tagName === "TH" || cell.tagName === "TD",
    );
    if (cells.length === 0) continue;
    lines.push(cells.map((cell) => csvCell(csvCellText(cell))).join(","));
  }
  return lines.join("\n");
}

const TABLE_SECTION_TAGS = new Set(["THEAD", "TBODY", "TFOOT"]);
// Elements that start a new line inside a copied cell.
const HTML_CELL_BLOCK_TAGS = new Set([
  "ARTICLE",
  "BLOCKQUOTE",
  "DETAILS",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TR",
  "UL",
]);

// Inline and theme-independent: mail clients and editors drop stylesheets, and a
// copy from the dark theme must still read on a white page. Header cells set their
// own text color so the light band stays readable in a dark paste target.
const HTML_TABLE_STYLE = "border-collapse:collapse";
const HTML_CELL_STYLE = "border:1px solid #d0d7de;padding:6px 12px;vertical-align:top";
const HTML_HEADER_CELL_STYLE = `${HTML_CELL_STYLE};background-color:#f6f8fa;color:#1f2328;font-weight:600`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Markers in collected cell text: a block edge is a soft line boundary, a break is a <br>.
const CELL_BLOCK_EDGE = "\u0001";
const CELL_LINE_BREAK = "\u0002";
const CELL_TEXT_BOUNDARY = new RegExp(`([${CELL_BLOCK_EDGE}${CELL_LINE_BREAK}])`);
// HTML's collapsible whitespace; a nonbreaking space is content.
const COLLAPSIBLE_WHITESPACE = /[ \t\n\r\f]+/g;

/** Preformatted text keeps its lines and spacing as breaks and nonbreaking spaces. */
function preformattedCellText(text: string): string {
  return text
    .replace(/\r\n?|\n/g, CELL_LINE_BREAK)
    .replaceAll("\t", "\u00a0".repeat(4))
    .replaceAll(" ", "\u00a0");
}

/** Collects a cell's text with block edges and breaks marked, and each formula as its TeX. */
function collectHtmlCellText(node: Node, parts: string[], preformatted: boolean): void {
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      parts.push(preformatted ? preformattedCellText(text) : text);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    if (isSkippedElement(element) && !element.hasAttribute("data-markdown-copy")) continue;
    if (element.hasAttribute("data-markdown-math")) {
      parts.push(element.getAttribute("data-markdown-copy")?.trim() ?? "");
      continue;
    }
    if (element.tagName === "BR") {
      parts.push(CELL_LINE_BREAK);
      continue;
    }
    if (element.tagName === "PRE") {
      const code: string[] = [];
      collectHtmlCellText(element, code, true);
      // A code block's closing newline ends the block, not a blank line.
      const text = code.join("");
      parts.push(
        CELL_BLOCK_EDGE,
        text.endsWith(CELL_LINE_BREAK) ? text.slice(0, -1) : text,
        CELL_BLOCK_EDGE,
      );
      continue;
    }
    // Cells of a nested table stay apart on their row's line.
    const separator = element.tagName === "TD" || element.tagName === "TH" ? " " : "";
    const boundary = HTML_CELL_BLOCK_TAGS.has(element.tagName) ? CELL_BLOCK_EDGE : separator;
    parts.push(boundary);
    collectHtmlCellText(element, parts, preformatted);
    parts.push(boundary);
  }
}

/**
 * Every explicit break stays a <br>, including repeated and edge ones. Block edges
 * become one break between content, and none where a break already ends the line.
 */
function htmlCellContent(cell: Element): string {
  const parts: string[] = [];
  collectHtmlCellText(cell, parts, false);
  const tokens = parts.join("").replace(COLLAPSIBLE_WHITESPACE, " ").split(CELL_TEXT_BOUNDARY);
  let html = "";
  let atLineStart = true;
  let pendingBlockEdge = false;
  for (const token of tokens) {
    if (token === CELL_LINE_BREAK) {
      html = `${html.replace(/ +$/, "")}<br>`;
      atLineStart = true;
      pendingBlockEdge = false;
    } else if (token === CELL_BLOCK_EDGE) {
      pendingBlockEdge = true;
    } else {
      const text = atLineStart || pendingBlockEdge ? token.replace(/^ +/, "") : token;
      if (!text) continue;
      if (pendingBlockEdge && !atLineStart) html = `${html.replace(/ +$/, "")}<br>`;
      html += escapeHtml(text).replaceAll("\u00a0", "&nbsp;");
      atLineStart = false;
      pendingBlockEdge = false;
    }
  }
  return html.replace(/ +$/, "");
}

/** Physical alignment for a paste target; logical values follow the table direction. */
function htmlCellAlignment(align: string, rtl: boolean): string {
  switch (align) {
    case "left":
    case "center":
    case "right":
    case "justify":
      return align;
    case "start":
      return rtl ? "right" : "left";
    case "end":
      return rtl ? "left" : "right";
    default:
      return "";
  }
}

/** HTML's non-negative integer parsing: leading digits count, anything invalid is 1. */
function parseTableSpan(value: string | null): number {
  const span = Number.parseInt(value ?? "", 10);
  return Number.isNaN(span) || span < 0 ? 1 : span;
}

function htmlSpanAttributes(cell: Element): string {
  // The DOM normalizes spans; the attribute fallback covers non-DOM callers.
  const { colSpan, rowSpan } = cell as Partial<HTMLTableCellElement>;
  const columns =
    typeof colSpan === "number" ? colSpan : parseTableSpan(cell.getAttribute("colspan"));
  const rows = typeof rowSpan === "number" ? rowSpan : parseTableSpan(cell.getAttribute("rowspan"));
  let attributes = columns > 1 ? ` colspan="${columns}"` : "";
  // rowspan="0" runs to the end of its section.
  if (rows !== 1) attributes += ` rowspan="${rows}"`;
  return attributes;
}

function htmlTableCell(cell: Element, rtl: boolean): string {
  const tag = cell.tagName === "TH" ? "th" : "td";
  // An absent inline style reads as "", so fall back to the align attribute on any falsy value.
  const align = (cell as HTMLElement).style?.textAlign || cell.getAttribute("align") || "";
  // Header cells default to the start side like the chat; paste targets would center them.
  const textAlign = htmlCellAlignment(align || (tag === "th" ? "start" : ""), rtl);
  const style = `${tag === "th" ? HTML_HEADER_CELL_STYLE : HTML_CELL_STYLE}${textAlign ? `;text-align:${textAlign}` : ""}`;
  // Bare text, no <p>: Word would drop its 8pt gap but switch to its web font.
  return `<${tag} style="${style}"${htmlSpanAttributes(cell)}>${htmlCellContent(cell)}</${tag}>`;
}

function htmlTableSection(tag: string, rows: ReadonlyArray<Element>, rtl: boolean): string[] {
  let hasCells = false;
  const lines = rows.map((row) => {
    const cells = [...row.children].filter(
      (cell) => cell.tagName === "TH" || cell.tagName === "TD",
    );
    const html = cells.map((cell) => htmlTableCell(cell, rtl)).join("");
    hasCells ||= cells.length > 0;
    return `    <tr>${html}</tr>`;
  });
  return hasCells ? [`  <${tag}>`, ...lines, `  </${tag}>`] : [];
}

/**
 * Inline-styled `<table>` markup without app chrome, so rich paste targets get a table.
 * Sections, header cells, spans, line breaks, direction, and alignment follow the source.
 * Cell content is text: inline formatting and link targets are not copied.
 */
export function serializeTableElementToHtml(table: Element): string {
  const direction = table.getAttribute("dir");
  const rtl =
    direction === "rtl" ||
    (direction !== "ltr" &&
      table.ownerDocument?.defaultView?.getComputedStyle(table).direction === "rtl");
  const lines: string[] = [];
  let looseRows: Element[] = [];
  const flushLooseRows = () => {
    lines.push(...htmlTableSection("tbody", looseRows, rtl));
    looseRows = [];
  };
  for (const child of table.children) {
    if (child.tagName === "TR") {
      looseRows.push(child);
      continue;
    }
    if (!TABLE_SECTION_TAGS.has(child.tagName)) continue;
    flushLooseRows();
    const rows = [...child.children].filter((row) => row.tagName === "TR");
    lines.push(...htmlTableSection(child.tagName.toLowerCase(), rows, rtl));
  }
  flushLooseRows();
  const open = `<table dir="${rtl ? "rtl" : "ltr"}" style="${HTML_TABLE_STYLE}">`;
  return lines.length > 0 ? [open, ...lines, "</table>"].join("\n") : "";
}

function sanitizedHtmlFrom(container: Element): string {
  for (const wrapper of container.querySelectorAll("[data-markdown-math]")) {
    wrapper.replaceWith(mathSourceElement(wrapper));
  }
  for (const node of container.querySelectorAll(SANITIZED_HTML_SELECTOR)) {
    if (node.hasAttribute("data-markdown-file-link") || node.closest("[data-markdown-file-link]")) {
      if (node.getAttribute("aria-hidden") === "true" || node.localName === "svg") {
        node.remove();
      }
      continue;
    }
    const markdownCopy = node.getAttribute("data-markdown-copy");
    if (markdownCopy !== null) node.replaceWith(markdownCopy);
    else node.remove();
  }
  return `<meta charset="utf-8">${container.innerHTML}`;
}

/** A list cloned from a later item would renumber from its start; restart it at the shown number. */
function keepStartListNumbers(range: Range, container: Element): void {
  // The start's ancestors below the common ancestor clone as the fragment's first-child chain.
  const chain: Node[] = [];
  for (
    let node: Node | null = range.startContainer;
    node && node !== range.commonAncestorContainer;
    node = node.parentNode
  ) {
    chain.unshift(node);
  }
  let clone: Node | null = container;
  for (const [depth, source] of chain.entries()) {
    clone = clone?.firstChild ?? null;
    if (!(clone instanceof Element) || !(source instanceof Element) || source.tagName !== "OL")
      continue;
    const firstCopied = chain[depth + 1] ?? source.childNodes[range.startOffset];
    if (!firstCopied) continue;
    const shown = numberedListItems(source).find(
      ({ item }) =>
        item === firstCopied ||
        firstCopied.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING,
    );
    const cloned = numberedListItems(clone)[0];
    if (shown && cloned && shown.number !== cloned.number) {
      clone.setAttribute("start", String(shown.number));
    }
  }
}

export function chatMarkdownClipboardPayload(
  selection: Selection,
): MarkdownClipboardPayload | null {
  const texts: string[] = [];
  const htmls: string[] = [];
  for (let index = 0; index < selection.rangeCount; index += 1) {
    const range = selection.getRangeAt(index);
    if (range.collapsed) continue;
    const expanded = range.cloneRange();
    const elementOf = (node: Node) =>
      node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
    const startMath = elementOf(range.startContainer)?.closest("[data-markdown-math]");
    const endMath = elementOf(range.endContainer)?.closest("[data-markdown-math]");
    if (startMath) expanded.setStartBefore(startMath);
    if (endMath) expanded.setEndAfter(endMath);
    const container = document.createElement("div");
    container.appendChild(expanded.cloneContents());
    keepStartListNumbers(expanded, container);
    const ancestor = range.commonAncestorContainer;
    const ancestorElement =
      ancestor.nodeType === Node.ELEMENT_NODE ? (ancestor as Element) : ancestor.parentElement;
    if (!startMath && !endMath && ancestorElement?.closest("pre")) {
      const text = range.toString();
      if (text) {
        texts.push(text);
        htmls.push(sanitizedHtmlFrom(container));
      }
      continue;
    }
    const text = serializeRenderedMarkdownFragment(container);
    if (!text) continue;
    texts.push(text);
    htmls.push(sanitizedHtmlFrom(container));
  }
  if (texts.length === 0) return null;
  return { text: texts.join("\n\n"), html: htmls.join("") };
}
