import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  serializeRenderedMarkdownFragment,
  serializeTableElementToCsv,
  serializeTableElementToHtml,
} from "./markdown-clipboard";
import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import {
  collectAssistantCitations,
  serializeAssistantCitation,
} from "@t3tools/shared/assistantCitations";

const TEXT_NODE = 3;
const ELEMENT_NODE = 1;

class FakeText {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: ReadonlyArray<never> = [];

  constructor(readonly textContent: string) {}
}

class FakeElement {
  readonly nodeType = ELEMENT_NODE;
  checked = false;
  readonly childNodes: Array<FakeElement | FakeText> = [];
  readonly classList = {
    contains: (name: string) => this.classNames.includes(name),
  };

  constructor(
    readonly tagName: string,
    private readonly classNames: ReadonlyArray<string> = [],
    private readonly attributes: Readonly<Record<string, string>> = {},
  ) {}

  get localName(): string {
    return this.tagName.toLowerCase();
  }

  get textContent(): string {
    return this.childNodes.map((child) => child.textContent).join("");
  }

  get children(): ReadonlyArray<FakeElement> {
    return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
  }

  append(...children: Array<FakeElement | FakeText>): this {
    this.childNodes.push(...children);
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return Object.hasOwn(this.attributes, name);
  }

  closest(): FakeElement | null {
    return null;
  }

  /** Supports the `:scope > a > b` child paths the table serializer queries. */
  querySelectorAll(selector: string): FakeElement[] {
    return selector.split(", ").flatMap((part) =>
      part
        .replace(/^:scope > /, "")
        .split(" > ")
        .reduce<FakeElement[]>(
          (level, tag) =>
            level.flatMap((element) =>
              element.children.filter((child) => child.tagName === tag.toUpperCase()),
            ),
          [this],
        ),
    );
  }

  /** Supports only the selectors markdown-clipboard actually asks for. */
  querySelector(selector: string): FakeElement | null {
    if (selector.includes(", ")) {
      for (const part of selector.split(", ")) {
        const match = this.querySelector(part);
        if (match) return match;
      }
      return null;
    }
    const childOnly = selector.startsWith(":scope > ");
    const [target, ...rest] = (childOnly ? selector.slice(":scope > ".length) : selector).split(
      " > ",
    );
    const matches = (element: FakeElement): boolean => {
      if (target === 'input[type="checkbox"]') {
        return element.tagName === "INPUT" && element.getAttribute("type") === "checkbox";
      }
      return element.tagName === target?.toUpperCase();
    };
    const search = (parent: FakeElement): FakeElement | null => {
      for (const child of parent.childNodes) {
        if (!(child instanceof FakeElement)) continue;
        if (matches(child)) {
          if (rest.length === 0) return child;
          const nested = child.querySelector(`:scope > ${rest.join(" > ")}`);
          if (nested) return nested;
        }
        if (!childOnly) {
          const nested = search(child);
          if (nested) return nested;
        }
      }
      return null;
    };
    return search(this);
  }
}

function asNode(element: FakeElement): Node {
  return element as unknown as Node;
}

function shikiCodeLine(text: string): FakeElement {
  const token = new FakeElement("SPAN").append(new FakeText(text));
  return new FakeElement("SPAN", ["line"]).append(token);
}

/** Mirrors a rendered code block: select-none header chrome plus a shiki pre. */
function renderedCodeBlock(lines: ReadonlyArray<string>): FakeElement {
  const code = new FakeElement("CODE");
  lines.forEach((line, index) => {
    if (index > 0) code.append(new FakeText("\n"));
    code.append(shikiCodeLine(line));
  });
  return new FakeElement("DIV", ["chat-markdown-codeblock"]).append(
    new FakeElement("DIV", ["chat-markdown-codeblock-header", "select-none"]).append(
      new FakeText("sh"),
    ),
    new FakeElement("DIV", ["chat-markdown-shiki"]).append(new FakeElement("PRE").append(code)),
  );
}

describe("serializeRenderedMarkdownFragment", () => {
  it("copies a popover context reference once, without its details or nested label", () => {
    const reference = "[Review comment](t3-context://v1/review-comment/review-1)";
    const container = new FakeElement("DIV").append(
      new FakeText("Fix "),
      new FakeElement("BUTTON", [], { "data-markdown-copy": reference }).append(
        new FakeElement("SPAN", [], { "data-markdown-copy": reference }).append(
          new FakeText("Review comment"),
        ),
      ),
      new FakeText(" please"),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(`Fix ${reference} please`);
  });

  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("wraps inline code in backticks", () => {
    const paragraph = new FakeElement("P").append(
      new FakeText("run "),
      new FakeElement("CODE").append(new FakeText("git status")),
      new FakeText(" first"),
    );
    const container = new FakeElement("DIV").append(paragraph);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("run `git status` first");
  });

  describe.each([
    { parentLayout: "tight", childLayout: "tight" },
    { parentLayout: "tight", childLayout: "loose" },
    { parentLayout: "loose", childLayout: "tight" },
    { parentLayout: "loose", childLayout: "loose" },
  ])("$parentLayout parent with $childLayout child", ({ parentLayout, childLayout }) => {
    it.each([
      { parentChecked: null, childChecked: true, parent: "- Parent", child: "  - [x] Child" },
      {
        parentChecked: false,
        childChecked: true,
        parent: "- [ ] Parent",
        child: "      - [x] Child",
      },
      {
        parentChecked: true,
        childChecked: false,
        parent: "- [x] Parent",
        child: "      - [ ] Child",
      },
    ])("copies $parent with $child", ({ parentChecked, childChecked, parent, child }) => {
      const parentContent = parentLayout === "loose" ? new FakeElement("P") : new FakeElement("LI");
      if (parentChecked !== null) {
        const checkbox = new FakeElement("INPUT", [], { type: "checkbox" });
        checkbox.checked = parentChecked;
        parentContent.append(checkbox, new FakeText(" "));
      }
      parentContent.append(new FakeText("Parent"));
      const parentItem =
        parentLayout === "loose" ? new FakeElement("LI").append(parentContent) : parentContent;
      const checkbox = new FakeElement("INPUT", [], { type: "checkbox" });
      checkbox.checked = childChecked;
      const childContent = new FakeElement(childLayout === "loose" ? "P" : "LI").append(
        checkbox,
        new FakeText(" Child"),
      );
      const childItem =
        childLayout === "loose" ? new FakeElement("LI").append(childContent) : childContent;
      parentItem.append(new FakeText("\n"), new FakeElement("UL").append(childItem));
      const container = new FakeElement("DIV").append(
        new FakeElement("P").append(new FakeText("Before")),
        new FakeElement("UL").append(parentItem),
        new FakeElement("P").append(new FakeText("After")),
      );

      expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
        `Before\n\n${parent}${parentLayout === "loose" ? "\n\n" : "\n"}${child}\n\nAfter`,
      );
    });
  });

  it("copies the complete quote, source, and comment instead of the comment-only chip label", () => {
    const citation = {
      version: 1 as const,
      environmentId: EnvironmentId.make("environment-one"),
      threadId: ThreadId.make("thread-one"),
      messageId: MessageId.make("assistant-one"),
      text: "A complete quote, including the part hidden by the chip preview.",
      comment: "What does this mean?\nPlease expand on the hidden part.",
      start: 0,
      end: 66,
      prefix: "",
      suffix: "",
    };
    const anchor = new FakeElement("A", [], {
      "data-markdown-copy": serializeAssistantCitation(citation),
      href: "/environment-one/thread-one#citation",
    }).append(new FakeText("What does this mean?…"));
    const chip = new FakeElement("SPAN", [], {
      "data-markdown-copy": serializeAssistantCitation(citation),
    }).append(anchor, new FakeElement("BUTTON").append(new FakeText("Edit comment")));
    const container = new FakeElement("DIV").append(new FakeText("Explain "), chip);
    const copied = serializeRenderedMarkdownFragment(asNode(container));
    expect(copied).toBe(`Explain ${serializeAssistantCitation(citation)}`);
    expect(collectAssistantCitations(copied).map((entry) => entry.citation)).toEqual([citation]);
  });

  it("keeps a highlighted block code selection plain when its pre wrapper is outside the range", () => {
    const code = new FakeElement("CODE").append(
      shikiCodeLine("git show-ref --verify refs/remotes/origin/opt/deploy/dev"),
    );
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "git show-ref --verify refs/remotes/origin/opt/deploy/dev",
    );
  });

  it("keeps a multi-line code selection plain instead of inline-wrapping it", () => {
    const code = new FakeElement("CODE").append(new FakeText("first line\nsecond line"));
    const container = new FakeElement("DIV").append(code);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("first line\nsecond line");
  });

  it.each([
    ["backtick edges", "`value`", "Use `` `value` `` here."],
    ["space edges", "  value  ", "Use `   value   ` here."],
    ["only spaces", "   ", "Use `   ` here."],
  ])("copies inline code that parses back unchanged: %s", (_, value, expected) => {
    const container = new FakeElement("DIV").append(
      new FakeElement("P").append(
        new FakeText("Use "),
        new FakeElement("CODE").append(new FakeText(value)),
        new FakeText(" here."),
      ),
    );
    // CommonMark strips one space from each edge only when both are padded
    // and the content is not all spaces, so these spellings parse back to
    // the original values.
    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(expected);
  });

  it("copies an ordered list with the numbers it shows", () => {
    const list = new FakeElement("OL", [], { start: "10" }).append(
      new FakeElement("LI").append(new FakeText("First")),
      new FakeElement("LI", [], { value: "7" }).append(new FakeText("Second")),
      new FakeElement("LI").append(new FakeText("Third")),
    );
    const container = new FakeElement("DIV").append(list);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "10. First\n7. Second\n8. Third",
    );
  });

  it("keeps fences when a bare list item sits alongside the code block", () => {
    // serializeListItem emits "- " for an item with no text, so the item is
    // content the plain-code path would drop.
    const container = new FakeElement("DIV").append(
      new FakeElement("UL").append(new FakeElement("LI")),
      renderedCodeBlock(["pnpm test"]),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("-\n\n```\npnpm test\n```");
  });

  it("keeps fences when a checkbox-only task item sits alongside the code block", () => {
    // The checkbox is a skipped tag, so the item renders no text of its own, but
    // it still carries the task state.
    const container = new FakeElement("DIV").append(
      new FakeElement("UL").append(
        new FakeElement("LI").append(new FakeElement("INPUT", [], { type: "checkbox" })),
      ),
      renderedCodeBlock(["pnpm test"]),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "- [ ]\n\n```\npnpm test\n```",
    );
  });

  it("still drops fences for a code block that is the whole list item", () => {
    // The item only wraps the block, so a selection that never left the pre
    // would drop the marker too.
    const container = new FakeElement("DIV").append(
      new FakeElement("UL").append(new FakeElement("LI").append(renderedCodeBlock(["pnpm test"]))),
      new FakeText("\n"),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe("pnpm test");
  });

  it("keeps fences when a file chip sits alongside the code block", () => {
    // The chip renders as a button, a skipped tag, but its data-markdown-copy
    // still contributes markdown, so the block is not the only visible content.
    const container = new FakeElement("DIV").append(
      renderedCodeBlock(["pnpm test"]),
      new FakeText("\n"),
      new FakeElement("BUTTON", [], { "data-markdown-copy": "`src/foo.ts`" }),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "```\npnpm test\n```\n\n`src/foo.ts`",
    );
  });

  it("omits fences when a selection past the last line drags in the whole code block", () => {
    // Dragging over the final newline ends the range after the pre, so the
    // fragment carries the block plus the empty head of the next paragraph.
    const container = new FakeElement("DIV").append(
      renderedCodeBlock(["printf '%s' 'TOKEN' | gh secret set CLOUDFLARE_API_TOKEN"]),
      new FakeText("\n"),
      new FakeElement("P").append(new FakeText("")),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "printf '%s' 'TOKEN' | gh secret set CLOUDFLARE_API_TOKEN",
    );
  });

  it("still fences a code block copied alongside prose", () => {
    const container = new FakeElement("DIV").append(
      new FakeElement("P").append(new FakeText("Run this:")),
      renderedCodeBlock(["gh workflow run Deploy --ref main"]),
    );

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "Run this:\n\n```\ngh workflow run Deploy --ref main\n```",
    );
  });

  it("uses a rendered card's explicit Markdown copy representation", () => {
    const card = new FakeElement("DIV", [], {
      "data-markdown-copy": "Hello World (Document template)\n\n",
    }).append(
      new FakeElement("SPAN").append(new FakeText("Hello World")),
      new FakeElement("SPAN").append(new FakeText("Document template")),
      new FakeElement("BUTTON").append(new FakeText("Use template")),
    );
    const container = new FakeElement("DIV").append(card);

    expect(serializeRenderedMarkdownFragment(asNode(container))).toBe(
      "Hello World (Document template)",
    );
  });
});

describe("copying a table as HTML", () => {
  const cell = (
    tag: "TH" | "TD",
    text: string,
    attributes: Record<string, string> = {},
    style?: { textAlign: string },
  ) => {
    const element = new FakeElement(tag, [], attributes).append(new FakeText(text));
    return style ? Object.assign(element, { style }) : element;
  };
  const row = (...cells: FakeElement[]) => new FakeElement("TR").append(...cells);
  const html = (table: FakeElement) => serializeTableElementToHtml(table as unknown as Element);

  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Structure only: every style attribute is reduced to its text alignment. */
  const structure = (table: FakeElement) =>
    html(table).replace(/ style="([^"]*)"/g, (_, style: string) => {
      const align = /text-align:(\w+)/.exec(style)?.[1];
      return align ? ` align="${align}"` : "";
    });

  it("escapes text and keeps column alignment from the style or the align attribute", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(cell("TH", "Name"), cell("TH", "Amount", {}, { textAlign: "right" })),
      ),
      new FakeElement("TBODY").append(
        row(cell("TD", 'A & B <"Ltd">'), cell("TD", "1,200", {}, { textAlign: "right" })),
        // An absent inline style reads as "": the align attribute still applies.
        row(cell("TD", "  Bob\n  Smith "), cell("TD", "3", { align: "center" }, { textAlign: "" })),
        row(cell("TD", "text", { align: "justify" }), cell("TD", "4", {}, { textAlign: "end" })),
      ),
    );

    expect(structure(table)).toBe(
      [
        '<table dir="ltr">',
        "  <thead>",
        '    <tr><th align="left">Name</th><th align="right">Amount</th></tr>',
        "  </thead>",
        "  <tbody>",
        '    <tr><td>A &amp; B &lt;&quot;Ltd&quot;&gt;</td><td align="right">1,200</td></tr>',
        '    <tr><td>Bob Smith</td><td align="center">3</td></tr>',
        '    <tr><td align="justify">text</td><td align="right">4</td></tr>',
        "  </tbody>",
        "</table>",
      ].join("\n"),
    );
  });

  it("keeps every header row, body header cells, footers, and merged cells", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(cell("TH", "Region", { rowspan: "2" }), cell("TH", "Sales", { colspan: "2" })),
        row(cell("TH", "Q1"), cell("TH", "Q2", { colspan: "1" })),
      ),
      new FakeElement("TBODY").append(
        row(
          cell("TH", "EU"),
          cell("TD", "1", { rowspan: "0" }),
          cell("TD", "2", { rowspan: "-1" }),
        ),
        row(),
      ),
      new FakeElement("TFOOT").append(
        row(cell("TD", "Total"), cell("TD", "3", { colspan: "2garbage" })),
      ),
    );

    expect(structure(table)).toBe(
      [
        '<table dir="ltr">',
        "  <thead>",
        '    <tr><th align="left" rowspan="2">Region</th><th align="left" colspan="2">Sales</th></tr>',
        '    <tr><th align="left">Q1</th><th align="left">Q2</th></tr>',
        "  </thead>",
        "  <tbody>",
        // rowspan="0" runs to the end of its section; a negative span is invalid.
        '    <tr><th align="left">EU</th><td rowspan="0">1</td><td>2</td></tr>',
        "    <tr></tr>",
        "  </tbody>",
        "  <tfoot>",
        // HTML reads a span's leading digits, as the DOM does.
        '    <tr><td>Total</td><td colspan="2">3</td></tr>',
        "  </tfoot>",
        "</table>",
      ].join("\n"),
    );
  });

  it("keeps line breaks, block edges, nested cells, and formulas as TeX", () => {
    const nested = new FakeElement("TABLE").append(
      new FakeElement("TBODY").append(row(cell("TD", "a"), cell("TD", "b"))),
    );
    const table = new FakeElement("TABLE").append(
      new FakeElement("TBODY").append(
        row(
          new FakeElement("TD").append(
            new FakeText("first"),
            new FakeElement("BR"),
            new FakeElement("STRONG").append(new FakeText("second")),
          ),
          new FakeElement("TD").append(
            new FakeElement("P").append(new FakeText("one")),
            new FakeElement("P").append(new FakeText("two")),
          ),
        ),
        row(
          new FakeElement("TD").append(nested),
          new FakeElement("TD").append(
            new FakeText("area "),
            new FakeElement("SPAN", [], {
              "data-markdown-math": "",
              "data-markdown-copy": "\\(\\pi r^2\\)",
            }).append(new FakeText("typeset math")),
          ),
        ),
      ),
    );

    expect(structure(table)).toBe(
      [
        '<table dir="ltr">',
        "  <tbody>",
        "    <tr><td>first<br>second</td><td>one<br>two</td></tr>",
        "    <tr><td>a b</td><td>area \\(\\pi r^2\\)</td></tr>",
        "  </tbody>",
        "</table>",
      ].join("\n"),
    );
  });

  it("keeps every explicit break, preformatted spacing, and nonbreaking spaces", () => {
    const br = () => new FakeElement("BR");
    const content = (...children: Array<FakeElement | FakeText>) =>
      structure(
        new FakeElement("TABLE").append(
          new FakeElement("TBODY").append(row(new FakeElement("TD").append(...children))),
        ),
      ).split("\n")[2];
    const td = (html: string) => `    <tr><td>${html}</td></tr>`;

    expect(content(new FakeText("a"), br(), br(), new FakeText("b"))).toBe(td("a<br><br>b"));
    expect(content(br(), new FakeText(" lead "), br())).toBe(td("<br>lead<br>"));
    // A break that ends a paragraph already ends the line.
    expect(
      content(
        new FakeElement("P").append(new FakeText("a "), br()),
        new FakeElement("P").append(new FakeText("b")),
      ),
    ).toBe(td("a<br>b"));
    expect(
      content(
        new FakeText("run:"),
        new FakeElement("DIV", ["select-none"]).append(new FakeText("madeup")),
        new FakeElement("PRE").append(
          new FakeElement("CODE").append(new FakeText("if x:\n\ty  =  1\n\nend\n")),
        ),
      ),
    ).toBe(
      td("run:<br>if&nbsp;x:<br>&nbsp;&nbsp;&nbsp;&nbsp;y&nbsp;&nbsp;=&nbsp;&nbsp;1<br><br>end"),
    );
    expect(content(new FakeText("1\u00a0000   EUR"))).toBe(td("1&nbsp;000 EUR"));
    expect(
      content(
        new FakeElement("BUTTON", [], {
          "data-markdown-copy": "[source](https://example.com)",
        }).append(new FakeText("source")),
      ),
    ).toBe(td("source"));
  });

  it("keeps a right-to-left table's direction and puts headers on its start side", () => {
    const table = new FakeElement("TABLE", [], { dir: "rtl" }).append(
      new FakeElement("THEAD").append(
        row(cell("TH", "Name"), cell("TH", "End", {}, { textAlign: "end" })),
      ),
    );

    expect(structure(table)).toBe(
      [
        '<table dir="rtl">',
        "  <thead>",
        '    <tr><th align="right">Name</th><th align="left">End</th></tr>',
        "  </thead>",
        "</table>",
      ].join("\n"),
    );
  });

  it("wraps rows outside any section in a body", () => {
    const table = new FakeElement("TABLE").append(row(cell("TD", "only"), cell("TD", "cells")));

    expect(structure(table)).toBe(
      '<table dir="ltr">\n  <tbody>\n    <tr><td>only</td><td>cells</td></tr>\n  </tbody>\n</table>',
    );
  });

  it("returns an empty string for a table without cells", () => {
    expect(html(new FakeElement("TABLE").append(new FakeElement("TBODY").append(row())))).toBe("");
  });
});

describe("copying a table as CSV", () => {
  const row = (...cells: FakeElement[]) => new FakeElement("TR").append(...cells);
  const td = (...children: Array<FakeElement | FakeText>) =>
    new FakeElement("TD").append(...children);

  beforeEach(() => {
    vi.stubGlobal("Node", { TEXT_NODE, ELEMENT_NODE });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("separates line breaks and block edges, and leaves out hidden elements", () => {
    const table = new FakeElement("TABLE").append(
      new FakeElement("THEAD").append(
        row(
          new FakeElement("TH").append(new FakeText("Col A")),
          new FakeElement("TH").append(new FakeText("Col B")),
        ),
      ),
      new FakeElement("TBODY").append(
        row(
          td(new FakeText("line 1"), new FakeElement("BR"), new FakeText("line 2")),
          td(
            new FakeElement("P").append(new FakeText("para 1")),
            new FakeElement("P").append(new FakeText("para 2")),
          ),
        ),
        row(
          td(
            new FakeElement("SPAN", ["sr-only"]).append(new FakeText("hidden")),
            new FakeText("visible"),
          ),
          td(
            new FakeElement("SPAN", [], { "aria-hidden": "true" }).append(new FakeText("icon")),
            new FakeText("a, b"),
          ),
        ),
      ),
    );

    expect(serializeTableElementToCsv(table as unknown as Element)).toBe(
      'Col A,Col B\nline 1 line 2,para 1 para 2\nvisible,"a, b"',
    );
  });
});
