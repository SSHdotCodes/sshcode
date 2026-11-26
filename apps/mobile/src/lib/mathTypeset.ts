import katex from "katex";
import type { MathBlock, MathPart } from "./markdownMath";

export interface TypesetMathBlock {
  readonly source: string;
  readonly html: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const cache = new Map<string, string | null>();

function typeset(tex: string, display: boolean): string {
  if (tex.length > 20_000) throw new Error("Formula too large");
  const key = `${display ? "display" : "inline"}:${tex}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    if (cached === null) throw new Error("Invalid formula");
    return cached;
  }
  let result: string | null = null;
  try {
    result = katex.renderToString(tex, {
      displayMode: display,
      output: "mathml",
      throwOnError: true,
      trust: false,
      strict: "ignore",
      maxSize: 20,
      maxExpand: 1000,
    });
  } catch {
    /* Keep the authored block when KaTeX rejects it. */
  }
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  if (!result || result.length <= 100_000) cache.set(key, result);
  if (result === null) throw new Error("Invalid formula");
  return result;
}

function renderPart(part: MathPart): string {
  switch (part.type) {
    case "text":
      return escapeHtml(part.value);
    case "inlineCode":
      return `<code>${escapeHtml(part.value)}</code>`;
    case "plainValue":
      return `<span class="plain-value" data-copy-source="${escapeHtml(part.source)}">${escapeHtml(part.value)}</span>`;
    case "break":
      return "<br>";
    case "math": {
      const math = typeset(part.tex, part.display);
      return `<span data-math-source="${escapeHtml(part.source)}" data-copy-source="${escapeHtml(part.source)}"${part.display ? ' class="display"' : ""}>${math}</span>`;
    }
    case "link":
      return `<a href="#" data-math-link="${escapeHtml(part.url)}" data-copy-source="${escapeHtml(part.source)}">${part.children.map(renderPart).join("")}</a>`;
    case "container": {
      const start =
        part.tag === "ol" && Number.isSafeInteger(part.start) ? ` start="${part.start}"` : "";
      return `<${part.tag}${start}>${part.children.map(renderPart).join("")}</${part.tag}>`;
    }
  }
}

/** Replace only successfully typeset blocks; errors and partials remain source markdown. */
export function markdownWithTypesetMath(markdown: string, blocks: readonly MathBlock[]) {
  const diagrams = new Map<string, TypesetMathBlock>();
  let prefix = "t3-math:";
  while (markdown.includes(prefix)) prefix = `t3-${prefix}`;
  const rendered: Array<{ start: number; end: number; html: string }> = [];
  for (const block of blocks) {
    try {
      const html = `<div class="math-source-block">${block.parts.map(renderPart).join("")}</div>`;
      const previous = rendered.at(-1);
      if (
        previous &&
        !markdown.slice(previous.end, block.start).trim() &&
        block.end - previous.start < 10_000
      ) {
        previous.end = block.end;
        previous.html += html;
      } else {
        rendered.push({ start: block.start, end: block.end, html });
      }
    } catch {
      // KaTeX rejected this formula; keep the entire authored block.
    }
  }
  const edits: Array<{ start: number; end: number; content: string }> = [];
  for (const block of rendered) {
    const url = `${prefix}${diagrams.size}`;
    diagrams.set(url, { source: markdown.slice(block.start, block.end), html: block.html });
    edits.push({ start: block.start, end: block.end, content: `\n![Equation](${url})\n` });
  }
  for (let i = edits.length - 1; i >= 0; i--) {
    const edit = edits[i]!;
    markdown = markdown.slice(0, edit.start) + edit.content + markdown.slice(edit.end);
  }
  return { markdown, diagrams };
}
