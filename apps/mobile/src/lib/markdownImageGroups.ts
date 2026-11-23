import type { Image, Paragraph } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export interface MarkdownImageReference {
  readonly href: string;
  readonly alt: string | null;
  readonly title: string | null;
}

export type MarkdownImageGroupSegment =
  | { readonly kind: "markdown"; readonly markdown: string; readonly sourceOffset: number }
  | {
      readonly kind: "images";
      readonly images: ReadonlyArray<MarkdownImageReference>;
      readonly sourceOffset: number;
    };

const parser = unified().use(remarkParse).use(remarkGfm, { singleTilde: false });

interface ImageLineRun {
  readonly start: number;
  readonly end: number;
  readonly images: MarkdownImageReference[];
}

/** Line ranges of a paragraph that hold only images, each run with its images in order. */
function imageLineRuns(markdown: string, paragraph: Paragraph): ImageLineRun[] {
  const start = paragraph.position?.start.offset;
  const end = paragraph.position?.end.offset;
  if (start === undefined || end === undefined) return [];
  const images = paragraph.children.filter((child): child is Image => child.type === "image");
  if (images.length === 0) return [];
  const runs: ImageLineRun[] = [];
  let lineStart = start;
  while (lineStart < end) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline < 0 || newline >= end ? end : newline;
    const lineImages = images.filter(
      (image) =>
        image.position !== undefined &&
        image.position.start.offset! >= lineStart &&
        image.position.end.offset! <= lineEnd,
    );
    // The line's text outside its images.
    let rest = "";
    let cursor = lineStart;
    for (const image of lineImages) {
      rest += markdown.slice(cursor, image.position!.start.offset!);
      cursor = image.position!.end.offset!;
    }
    rest += markdown.slice(cursor, lineEnd);
    // A trailing backslash is a hard break between image lines, not content.
    if (lineImages.length > 0 && /^[\s\\]*$/.test(rest)) {
      const references = lineImages.map((image) => ({
        href: image.url,
        alt: image.alt || null,
        title: image.title ?? null,
      }));
      const previous = runs.at(-1);
      if (previous && previous.end + 1 === lineStart) {
        runs[runs.length - 1] = {
          ...previous,
          end: lineEnd,
          images: [...previous.images, ...references],
        };
      } else {
        runs.push({ start: lineStart, end: lineEnd, images: references });
      }
    }
    lineStart = lineEnd + 1;
  }
  // A paragraph that is one image is already a native block image.
  const only = runs[0];
  if (runs.length === 1 && only!.images.length === 1 && only!.start === start && only!.end === end)
    return [];
  return runs;
}

/**
 * Native Markdown draws an image that shares its paragraph with other images or text
 * as a 20pt inline glyph. Lifts top-level lines holding only images out of the text
 * so the feed can show them as a block image or a thumbnail strip. Images inline with
 * words, and images inside lists, quotes, and tables, keep native rendering.
 */
export function splitMarkdownImageGroups(
  markdown: string,
): ReadonlyArray<MarkdownImageGroupSegment> {
  const whole = [{ kind: "markdown" as const, markdown, sourceOffset: 0 }];
  if (!markdown.includes("![")) return whole;
  const runs = parser
    .parse(markdown)
    .children.flatMap((node) => (node.type === "paragraph" ? imageLineRuns(markdown, node) : []));
  if (runs.length === 0) return whole;
  const segments: MarkdownImageGroupSegment[] = [];
  let cursor = 0;
  const pushMarkdown = (from: number, to: number) => {
    let text = markdown.slice(from, to);
    // Text resuming a paragraph after lifted images may be indented as a lazy
    // continuation; at the start of its own segment that indent would make it code.
    if (from > 0) text = text.replace(/^\n?[ \t]*/, "");
    if (text.trim().length > 0) {
      segments.push({ kind: "markdown", markdown: text, sourceOffset: from });
    }
  };
  for (const run of runs) {
    pushMarkdown(cursor, run.start);
    segments.push({ kind: "images", images: run.images, sourceOffset: run.start });
    cursor = run.end;
  }
  pushMarkdown(cursor, markdown.length);
  return segments;
}
