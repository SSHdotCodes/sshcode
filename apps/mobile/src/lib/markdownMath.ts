import { isMarkdownPlainValue } from "@t3tools/shared/markdownPlainValues";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

type MathNode = {
  type: string;
  value?: string;
  children?: MathNode[];
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  depth?: number;
  url?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  data?: { hProperties?: { className?: string[] } };
};

export type MathPart =
  | { type: "text" | "inlineCode"; value: string }
  | { type: "plainValue"; value: string; source: string }
  | { type: "break" }
  | { type: "container"; tag: string; start?: number; children: MathPart[] }
  | { type: "link"; url: string; source: string; children: MathPart[] }
  | { type: "math"; tex: string; source: string; display: boolean };

export interface MathBlock {
  start: number;
  end: number;
  source: string;
  parts: MathPart[];
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath).freeze();

/** Parse with the same patched tokenizer as web. Unsupported blocks remain native markdown. */
export function findMathBlocks(
  markdown: string,
  allowLinks = false,
  nativeLinks?: { text?: RegExp | null; inlineCode?: RegExp },
  plainValues = false,
): MathBlock[] {
  const blocks: MathBlock[] = [];
  try {
    const root = parser.parse(markdown) as MathNode;
    const convert = (node: MathNode): MathPart | null => {
      if (node.type === "text" || node.type === "inlineCode") {
        const value = node.value ?? "";
        if (plainValues && node.type === "inlineCode" && isMarkdownPlainValue(value)) {
          const start = node.position?.start.offset;
          const end = node.position?.end.offset;
          if (start !== undefined && end !== undefined)
            return { type: "plainValue", value, source: markdown.slice(start, end) };
        }
        const pattern = node.type === "text" ? nativeLinks?.text : nativeLinks?.inlineCode;
        if (pattern?.test(value)) return null;
        return { type: node.type, value };
      }
      if (node.type === "break") return { type: "break" };
      if (node.type === "inlineMath" || node.type === "math") {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        if (start === undefined || end === undefined) return null;
        return {
          type: "math",
          tex: node.value ?? "",
          source: markdown.slice(start, end),
          display:
            node.type === "math" || !!node.data?.hProperties?.className?.includes("math-display"),
        };
      }
      if (node.type === "link" && allowLinks && /^https?:\/\//i.test(node.url ?? "")) {
        const start = node.position?.start.offset;
        const end = node.position?.end.offset;
        const children = node.children?.map(convert) ?? [];
        if (start === undefined || end === undefined || children.some((child) => child === null))
          return null;
        return {
          type: "link",
          url: node.url!,
          source: markdown.slice(start, end),
          children: children as MathPart[],
        };
      }
      const tagByType: Record<string, string> = {
        paragraph: "p",
        emphasis: "em",
        strong: "strong",
        delete: "del",
        blockquote: "blockquote",
        listItem: "li",
        table: "table",
        tableRow: "tr",
        tableCell: "td",
      };
      if (node.type === "listItem" && node.checked != null) return null;
      const tag =
        node.type === "list"
          ? node.ordered
            ? "ol"
            : "ul"
          : node.type === "heading"
            ? `h${Math.max(1, Math.min(node.depth ?? 1, 6))}`
            : tagByType[node.type];
      if (tag) {
        const children = node.children?.map(convert) ?? [];
        if (children.some((child) => child === null)) return null;
        return {
          type: "container",
          tag,
          ...(tag === "ol" && node.start != null ? { start: node.start } : {}),
          children: children as MathPart[],
        };
      }
      return null;
    };
    const hasMath = (part: MathPart): boolean =>
      part.type === "math" || ("children" in part && part.children.some(hasMath));
    for (const node of root.children ?? []) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start === undefined || end === undefined) continue;
      const part = convert(node);
      if (part && hasMath(part))
        blocks.push({ start, end, source: markdown.slice(start, end), parts: [part] });
    }
  } catch {
    // Parsing failure leaves the original native markdown visible.
  }
  return blocks;
}
