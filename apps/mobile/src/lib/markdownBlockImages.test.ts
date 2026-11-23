import { describe, expect, it } from "vite-plus/test";
import { markdownWithBlockImages } from "./markdownDocument";

describe("images that share a line with text", () => {
  it("gives an image after text its own paragraph", () => {
    expect(markdownWithBlockImages("Here's the chart: ![chart](/tmp/chart.png)\n\n- A point")).toBe(
      "Here's the chart:\n\n![chart](/tmp/chart.png)\n\n- A point",
    );
  });

  it("splits text on both sides and between images", () => {
    expect(markdownWithBlockImages("Before ![a](a.png) and ![b](b.png) after.")).toBe(
      "Before\n\n![a](a.png)\n\nand\n\n![b](b.png)\n\nafter.",
    );
    expect(markdownWithBlockImages("![a](a.png) ![b](b.png)")).toBe("![a](a.png)\n\n![b](b.png)");
  });

  it("leaves an image that is alone in its paragraph", () => {
    const markdown = "Intro\n\n![chart](chart.png)\n\nMore";
    expect(markdownWithBlockImages(markdown)).toBe(markdown);
  });

  it("keeps linked badges and code inline", () => {
    const badge = "Build [![ci](https://img.shields.io/ci.svg)](https://ci.example) passing";
    expect(markdownWithBlockImages(badge)).toBe(badge);
    const code = "Write `![alt](src)` for an image\n\n```md\nsee ![a](a.png)\n```";
    expect(markdownWithBlockImages(code)).toBe(code);
  });

  it("keeps the split inside a blockquote or list item", () => {
    expect(markdownWithBlockImages("> Look: ![a](a.png)")).toBe("> Look:\n>\n> ![a](a.png)");
    expect(markdownWithBlockImages("- Look: ![a](a.png) done\n- Next")).toBe(
      "- Look:\n\n  ![a](a.png)\n\n  done\n- Next",
    );
  });

  it("splits an image on a later line of the paragraph", () => {
    expect(markdownWithBlockImages("> First line\n> ![a](a.png)")).toBe(
      "> First line\n>\n> ![a](a.png)",
    );
    expect(markdownWithBlockImages("Line one\r\n![a](a.png)")).toBe("Line one\r\n\r\n![a](a.png)");
  });

  it("leaves a placeholder image in its sentence", () => {
    const prose = 'as in "Here\'s the chart: ![chart](…)". That image';
    expect(markdownWithBlockImages(prose)).toBe(prose);
    expect(markdownWithBlockImages("Use ![alt](...) here")).toBe("Use ![alt](...) here");
  });

  it("handles reference images", () => {
    expect(markdownWithBlockImages("See ![chart][c]\n\n[c]: chart.png")).toBe(
      "See\n\n![chart][c]\n\n[c]: chart.png",
    );
  });
});
