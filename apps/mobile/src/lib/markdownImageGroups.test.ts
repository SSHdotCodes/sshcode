import { describe, expect, it } from "vite-plus/test";

import { splitMarkdownImageGroups } from "./markdownImageGroups";

function shape(markdown: string) {
  return splitMarkdownImageGroups(markdown).map((segment) =>
    segment.kind === "markdown" ? segment.markdown : segment.images.map((image) => image.href),
  );
}

describe("splitMarkdownImageGroups", () => {
  it("leaves text without images and lone image paragraphs to native rendering", () => {
    expect(shape("Plain **text**")).toEqual(["Plain **text**"]);
    const lone = "Intro\n\n![chart](/tmp/chart.png)\n\nOutro";
    expect(shape(lone)).toEqual([lone]);
  });

  it("lifts images that share a paragraph into one group", () => {
    expect(shape("Before\n\n![a](/tmp/a.png) ![b](/tmp/b.png)\n\nAfter")).toEqual([
      "Before\n\n",
      ["/tmp/a.png", "/tmp/b.png"],
      "\nAfter",
    ]);
    expect(shape("![a](/tmp/a.png)\n![b](/tmp/b.png)\\\n![c](/tmp/c.png)")).toEqual([
      ["/tmp/a.png", "/tmp/b.png", "/tmp/c.png"],
    ]);
  });

  it("splits image lines from the text lines of the same paragraph", () => {
    expect(shape("Here are the charts:\n![a](/tmp/a.png)\n![b](/tmp/b.png)\n  and a note")).toEqual(
      ["Here are the charts:\n", ["/tmp/a.png", "/tmp/b.png"], "and a note"],
    );
    expect(shape("The result:\n![a](/tmp/a.png)")).toEqual(["The result:\n", ["/tmp/a.png"]]);
  });

  it("keeps alt text and titles for the renderer", () => {
    const [group] = splitMarkdownImageGroups('![First](/a.png "One") ![](/b.png)');
    expect(group).toEqual({
      kind: "images",
      sourceOffset: 0,
      images: [
        { href: "/a.png", alt: "First", title: "One" },
        { href: "/b.png", alt: null, title: null },
      ],
    });
  });

  it("keeps images inline with words, in lists, and in code", () => {
    for (const markdown of [
      "Status ![badge](/b.png) passing ![badge](/c.png)",
      "- ![a](/a.png) ![b](/b.png)",
      "```md\n![a](/a.png) ![b](/b.png)\n```",
      "> ![a](/a.png) ![b](/b.png)",
    ]) {
      expect(shape(markdown)).toEqual([markdown]);
    }
  });

  it("keeps an indented code block at the start of the message", () => {
    expect(shape("    code\n\n![a](/a.png) ![b](/b.png)")).toEqual([
      "    code\n\n",
      ["/a.png", "/b.png"],
    ]);
  });
});
