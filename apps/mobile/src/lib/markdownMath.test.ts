import { describe, expect, it } from "vite-plus/test";
import { findMathBlocks } from "./markdownMath";
import { mayRenderMath } from "./mathDetection";
import {
  ENRICHED_INLINE_FILE_LINK_REGEX,
  enrichedSkillLinkRegex,
} from "./enrichedLinkPresentation";
import { markdownWithTypesetMath } from "./mathTypeset";

function render(source: string) {
  return markdownWithTypesetMath(source, findMathBlocks(source));
}

describe("mobile markdown math", () => {
  it("uses the web tokenizer for all four delimiters and keeps authored source", () => {
    const source = "Inline $x^2$ and \\(y\\).\n\n$$\\frac{1}{2}$$\n\n\\[z+1\\]";
    const blocks = findMathBlocks(source);
    expect(blocks.map((block) => block.source)).toEqual([
      "Inline $x^2$ and \\(y\\).",
      "$$\\frac{1}{2}$$",
      "\\[z+1\\]",
    ]);
    const result = render(source);
    expect([...result.diagrams.values()][0]?.source).toBe(source);
    expect([...result.diagrams.values()].every((block) => block.html.includes("<math"))).toBe(true);
    expect(result.diagrams.get("t3-math:0")?.html).toContain('data-math-source="$x^2$"');
    expect(result.diagrams.get("t3-math:0")?.html).toContain('data-math-source="\\(y\\)"');
  });

  it.each([
    "It costs $5 and $10.",
    "Budget $5-$10 or $20,000-$30,000.",
    "Set $HOME then $PATH before running $deploy.",
    "`$x$` and a code fence:\n\n```sh\necho $HOME\n```",
    "unfinished $x",
    "unfinished $$\\frac{1}",
    "unfinished \\(x",
    "unfinished \\[x",
  ])("keeps prices, shell text, code and streaming partials: %s", (source) => {
    expect(findMathBlocks(source)).toEqual([]);
    expect(render(source).markdown).toBe(source);
  });

  it("keeps complete formulas as source while the message is streaming", () => {
    expect(mayRenderMath("Complete $x$ and still writing", true)).toBe(false);
    expect(mayRenderMath("Complete $x$ and still writing", false)).toBe(true);
    expect(mayRenderMath("ordinary text", false)).toBe(false);
  });

  it("keeps invalid formulas as source without losing neighboring blocks", () => {
    const source = "Bad $\\unknowncommand$.\n\nGood $x^2$.";
    const result = render(source);
    expect(result.markdown).toContain("Bad $\\unknowncommand$.");
    expect(result.diagrams.size).toBe(1);
    expect([...result.diagrams.values()][0]?.source).toBe("Good $x^2$.");
  });

  it("leaves blocks with unsupported native content untouched", () => {
    const source = "See [a link](https://example.com) and $x$.\n\n- [ ] $y$";
    expect(render(source).markdown).toBe(source);
  });

  it("escapes untrusted tex when generating the local document", () => {
    const result = render("$\\text{</script><img src=x>}$");
    const html = [...result.diagrams.values()][0]?.html;
    expect(html).toBeDefined();
    expect(html).not.toContain("</script>");
    expect(html).not.toContain("<img");
  });

  it("preserves native skill and file interactions in mixed blocks", () => {
    const source = "Use $review and `src/file.ts` with $x$.";
    const blocks = findMathBlocks(source, true, {
      text: enrichedSkillLinkRegex([{ name: "review" }]),
      inlineCode: ENRICHED_INLINE_FILE_LINK_REGEX,
    });
    expect(blocks).toEqual([]);
    expect(markdownWithTypesetMath(source, blocks).markdown).toBe(source);
  });

  it("typesets math in lists, quotes, headings, and tables", () => {
    const source = "## $x$\n\n- result $y$\n\n> $z$\n\n| value |\n| --- |\n| $q$ |";
    const result = render(source);
    expect(result.diagrams.size).toBe(1);
    const html = [...result.diagrams.values()].map((block) => block.html).join("");
    expect(html).toContain("<h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<table>");
  });

  it("escapes authored text and preserves placeholder uniqueness", () => {
    const source = "t3-math:0 &amp; &lt;word&gt; $x$";
    const result = render(source);
    expect([...result.diagrams.keys()]).toEqual(["t3-t3-math:0"]);
    expect([...result.diagrams.values()][0]?.html).toContain("&amp; &lt;word&gt;");
  });
});
