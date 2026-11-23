import { describe, expect, it } from "vite-plus/test";
import { markdownWithLiteralTildes } from "./markdownDocument";

describe("markdownWithLiteralTildes", () => {
  it("escapes lone tildes in prose so md4c does not strike through", () => {
    expect(markdownWithLiteralTildes("About ~$10/month, or ~$25 in ~/repo")).toBe(
      "About \\~$10/month, or \\~$25 in \\~/repo",
    );
    expect(markdownWithLiteralTildes("- **Boat:** ~$0.07/h\n- [~/a](https://x.dev) ~b")).toBe(
      "- **Boat:** \\~$0.07/h\n- [\\~/a](https://x.dev) \\~b",
    );
  });

  it("keeps double tildes, escapes, code and autolinks", () => {
    for (const markdown of [
      "Plan ~~cancelled~~ moved",
      "Already \\~escaped",
      "Run `cd ~/repo` then `ls ~`",
      "```sh\ncd ~/repo && ls ~\n```",
      "~~~\n~/fenced ~\n~~~",
      "See <https://example.com/~user> or https://example.com/~other",
    ])
      expect(markdownWithLiteralTildes(markdown)).toBe(markdown);
  });

  it("escapes only the prose around code and strikethrough", () => {
    expect(markdownWithLiteralTildes("~2 h `~/x` ~~old~~ ~3 h")).toBe(
      "\\~2 h `~/x` ~~old~~ \\~3 h",
    );
  });
});
