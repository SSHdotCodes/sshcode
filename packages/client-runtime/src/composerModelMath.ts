import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMath from "remark-math";

const mathParser = unified().use(remarkParse).use(remarkMath).freeze();

/** Formula source stays text in editors, including references inside TeX text commands. */
export function composerModelMathRanges(text: string) {
  const ranges: Array<{ start: number; end: number }> = [];
  if (
    !text.includes("$") &&
    !text.includes("\\(") &&
    !text.includes("\\[") &&
    !text.includes("math")
  )
    return ranges;
  const visit = (node: {
    type: string;
    position?:
      | { start: { offset?: number | undefined }; end: { offset?: number | undefined } }
      | undefined;
    children?: ReadonlyArray<typeof node> | undefined;
    lang?: string | null | undefined;
  }) => {
    if (
      node.type === "math" ||
      node.type === "inlineMath" ||
      (node.type === "code" && node.lang === "math")
    ) {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
    } else node.children?.forEach(visit);
  };
  visit(mathParser.parse(text));
  return ranges;
}
