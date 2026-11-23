import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { decodeString } from "micromark-util-decode-string";
import { emojiData } from "./emojiData.ts";
import { EMOJI_SHORTCODE } from "./emoji.ts";

const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false });
const byName = new Map(
  emojiData.flatMap(([emoji, names]) => names.split(" ").map((name) => [name, emoji] as const)),
);

type MarkdownNode = {
  type: string;
  value?: string | undefined;
  children?: MarkdownNode[] | undefined;
  position?:
    | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
    | undefined;
};
type EmojiEdit = { start: number; end: number; emoji: string };

function visitEmojiText(
  tree: MarkdownNode,
  markdown: string,
  editText: (node: MarkdownNode, source: string, offset: number, edits: EmojiEdit[]) => void,
) {
  let htmlCodeDepth = 0;
  const visit = (node: MarkdownNode) => {
    if (node.type === "html") {
      for (const tag of (node.value ?? "").matchAll(/<(\/?)(?:code|pre)\b[^>]*>/gi))
        htmlCodeDepth = Math.max(0, htmlCodeDepth + (tag[1] ? -1 : 1));
      return;
    }
    if (node.type === "text" && !htmlCodeDepth) {
      const offset = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (offset === undefined || end === undefined) return;
      const source = markdown.slice(offset, end);
      const edits: EmojiEdit[] = [];
      for (const match of source.matchAll(EMOJI_SHORTCODE)) {
        const emoji = byName.get(match[1]!.toLowerCase());
        if (!emoji) continue;
        const prefix = markdown.slice(0, offset + match.index);
        const slashes = /\\+$/.exec(prefix)?.[0].length ?? 0;
        const tokenPrefix = /\S*$/.exec(source.slice(0, match.index))?.[0] ?? "";
        const tokenSuffix = /^\S*/.exec(source.slice(match.index))?.[0] ?? "";
        const token = tokenPrefix + tokenSuffix;
        // A shortcode stands alone: `run:thread:1` is an id, not a spool of thread.
        const before = markdown[offset + match.index - 1] ?? "";
        const after = markdown[offset + match.index + match[0].length] ?? "";
        if (
          slashes % 2 ||
          token.includes("/") ||
          /[\p{L}\p{N}-]+\.[\p{L}]{2,}/u.test(token) ||
          /[\p{L}\p{N}]/u.test(before) ||
          /[\p{L}\p{N}]/u.test(after)
        )
          continue;
        edits.push({ start: match.index, end: match.index + match[0].length, emoji });
      }
      if (edits.length) editText(node, source, offset, edits);
    } else if (node.type !== "link" || markdown[node.position?.start.offset ?? -1] === "[") {
      node.children?.forEach(visit);
    }
  };
  visit(tree);
}

/** Native markdown needs source edits because its parser lives across the native bridge. */
export function markdownWithEmoji(markdown: string): string {
  const edits: EmojiEdit[] = [];
  visitEmojiText(parser.parse(markdown), markdown, (_node, _source, offset, replacements) => {
    edits.push(
      ...replacements.map((edit) => ({
        ...edit,
        start: offset + edit.start,
        end: offset + edit.end,
      })),
    );
  });
  for (let index = edits.length - 1; index >= 0; index--) {
    const { start, end, emoji } = edits[index]!;
    markdown = markdown.slice(0, start) + emoji + markdown.slice(end);
  }
  return markdown;
}

/** Keep original source positions for task toggles, citations, find, and streaming blocks. */
export function remarkEmojiShortcodes() {
  return (tree: ReturnType<typeof parser.parse>, file: { toString(): string }) => {
    visitEmojiText(tree, file.toString(), (node, source, _offset, edits) => {
      let value = node.value ?? "";
      for (let index = edits.length - 1; index >= 0; index--) {
        const edit = edits[index]!;
        const start = decodeString(source.slice(0, edit.start)).replaceAll(/\r\n?/g, "\n").length;
        value = value.slice(0, start) + edit.emoji + value.slice(start + edit.end - edit.start);
      }
      node.value = value;
    });
    return tree;
  };
}

/** For deciding whether an entire message consists of shortcodes; never used on markdown source. */
export function emojiText(text: string): string {
  return text.replace(
    EMOJI_SHORTCODE,
    (source, name: string) => byName.get(name.toLowerCase()) ?? source,
  );
}
