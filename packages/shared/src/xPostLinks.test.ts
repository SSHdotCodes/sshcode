import { describe, expect, it } from "vite-plus/test";

import { xPostLinks } from "./xPostLinks.ts";

describe("xPostLinks", () => {
  it("finds post links on either address, once each, in order", () => {
    expect(
      xPostLinks(
        "see https://x.com/OfficialLoganK/status/2120372550354280848?s=46 and " +
          "https://twitter.com/someone/status/123/photo/1, again https://www.x.com/OfficialLoganK/status/2120372550354280848",
      ),
    ).toEqual([
      { id: "2120372550354280848", url: "https://x.com/OfficialLoganK/status/2120372550354280848" },
      { id: "123", url: "https://x.com/someone/status/123" },
    ]);
  });

  it("reads the handle-free form", () => {
    expect(xPostLinks("https://x.com/i/web/status/42")).toEqual([
      { id: "42", url: "https://x.com/i/status/42" },
    ]);
  });

  it("ignores profiles, other sites, code and look-alike hosts", () => {
    expect(
      xPostLinks(
        "https://x.com/someone https://example.com/a/status/5 `https://x.com/a/status/6`\n" +
          "```\nhttps://x.com/a/status/7\n```\nhttps://notx.com/a/status/8 https://x.com.evil.io/a/status/9 https://x.com/a/status/10abc",
      ),
    ).toEqual([]);
  });

  it("stops at the limit", () => {
    const text = [1, 2, 3, 4, 5].map((id) => `https://x.com/a/status/${id}`).join(" ");
    expect(xPostLinks(text).map((link) => link.id)).toEqual(["1", "2", "3"]);
    expect(xPostLinks(text, 0)).toEqual([]);
  });
});
