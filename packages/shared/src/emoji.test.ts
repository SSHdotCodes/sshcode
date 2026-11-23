import { describe, expect, it } from "vite-plus/test";
import { emojiData } from "./emojiData.ts";
import { emojiName, isEmojiOnlyMessage, loadEmojiData, searchEmoji } from "./emoji.ts";
import { markdownWithEmoji } from "./emojiMarkdown.ts";

const names = (query: string) => searchEmoji(emojiData, query).map(emojiName);

describe("emoji search", () => {
  it("ranks exact aliases above prefixes and keyword matches", () => {
    expect(names("tada")[0]).toBe("tada");
    expect(names("ta")[0]).toBe("tada");
    expect(names("heart")[0]).toBe("heart");
    expect(names("thumbsup")[0]).toBe("+1");
    expect(names("+1")[0]).toBe("+1");
    expect(names("-1")[0]).toBe("-1");
  });
  it("searches keywords and multiple words", () => {
    expect(names("party")).toContain("tada");
    expect(names("celebration")).toContain("partying_face");
    expect(names("popper")).toContain("tada");
    expect(names("happy")).toContain("grinning");
    expect(names("heart eyes")).toContain("heart_eyes");
  });
  it("normalizes shortcode input and preserves deterministic ranking", () => {
    expect(names(" :TADA: ")).toEqual(names("tada"));
    expect(names("heart-eyes")).toEqual(names("heart_eyes"));
    expect(names("not_an_emoji_zzzz")).toEqual([]);
    expect(searchEmoji(emojiData, "", 8)).toHaveLength(8);
    expect(new Set(searchEmoji(emojiData, "", 48).map(([glyph]) => glyph)).size).toBe(
      searchEmoji(emojiData, "", 48).length,
    );
  });
  it("loads the offline table once", async () => {
    expect(loadEmojiData()).toBe(loadEmojiData());
    expect(await loadEmojiData()).toBe(emojiData);
  });
});

describe("markdownWithEmoji", () => {
  it.each([
    ["nice :tada: :+1: :heart:", "nice 🎉 👍 ❤️"],
    ["<span>:tada:</span>", "<span>🎉</span>"],
    ["**:tada:** and _beautiful :sparkles:_", "**🎉** and _beautiful ✨_"],
    ["| mood |\n|---|\n| :smile: |", "| mood |\n|---|\n| 😄 |"],
    ["- :rocket:\n> :eyes:", "- 🚀\n> 👀"],
    ["[:tada:](https://example.com/:heart:)", "[🎉](https://example.com/:heart:)"],
    [":TADA: :unknown: :tada", "🎉 :unknown: :tada"],
    ["\\:tada: and :tada:", "\\:tada: and 🎉"],
    ["id run:thread:1, then :tada:", "id run:thread:1, then 🎉"],
    ["(:tada:) :heart:!", "(🎉) ❤️!"],
    ["\\\\:tada:", "\\\\🎉"],
    ["`:tada:` :tada:", "`:tada:` 🎉"],
    ["```:tada:``` :heart:", "```:tada:``` ❤️"],
    [
      "before :tada:\n```ts\nconst x = ':heart:';\n```\nafter :heart:",
      "before 🎉\n```ts\nconst x = ':heart:';\n```\nafter ❤️",
    ],
  ])("renders prose in %j", (source, result) => expect(markdownWithEmoji(source)).toBe(result));
  it.each([
    "```\n:tada:\n```",
    "~~~js\n:heart:\n~~~",
    "    :tada:",
    "`:tada:`",
    "``a ` :tada:``",
    "https://example.com/:tada:",
    "<https://example.com/:tada:>",
    "www.example.com/:tada:",
    "[go](https://example.com/:tada:)",
    "![alt :tada:](image.png)",
    "<code>:tada:</code>",
    "[x]: https://example.com/:tada:\n",
    "at 10:30 and :unknown:",
    "```\n:tada:",
    '"childRunId":"run:thread:abc"',
    "status:fire: and :fire:s",
  ])("preserves code and destinations in %j", (source) =>
    expect(markdownWithEmoji(source)).toBe(source),
  );
});

describe("emoji-only messages", () => {
  it.each(["🎉", "🎉 🚀 ✨", "👩🏽‍💻", "👨‍👩‍👧‍👦", "🇺🇸", "1️⃣", "❤️", "👍🏾", "©️", "™️"])(
    "enlarges %s",
    (value) => expect(isEmojiOnlyMessage(value)).toBe(true),
  );
  it.each([
    "",
    " ",
    "great 🎉",
    "1",
    "© 2026",
    "©",
    "®",
    "™",
    "🎉 ©",
    "🎉🎉🎉🎉",
    "**🎉**",
    "`🎉`",
    "🏻",
    "🇺",
  ])("keeps normal size for %j", (value) => expect(isEmojiOnlyMessage(value)).toBe(false));
});

describe("emoji remark rendering", () => {
  it("keeps source positions while respecting escaped colons and entities", async () => {
    const { unified } = await import("unified");
    const { default: remarkParse } = await import("remark-parse");
    const { remarkEmojiShortcodes } = await import("./emojiMarkdown.ts");
    const source = "\\:tada: &amp; :heart: &colon;tada: :tada:\n\n- [ ] ship";
    const processor = unified().use(remarkParse).use(remarkEmojiShortcodes);
    const original = processor.parse(source);
    const positions = JSON.stringify(original, (key, value) =>
      key === "value" ? undefined : value,
    );
    const tree = processor.runSync(original, { value: source });
    const paragraph = tree.children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type === "paragraph")
      expect(paragraph.children[0]).toMatchObject({ value: ":tada: & ❤️ :tada: 🎉" });
    expect(JSON.stringify(tree, (key, value) => (key === "value" ? undefined : value))).toBe(
      positions,
    );
  });
});

describe("URL-like emoji tokens", () => {
  it.each([
    "a.com/:tada:",
    "example.dev:tada:",
    "a.com?q=:tada:",
    "path/:tada:",
    ":tada:/path",
    "exämple.com/:tada:",
  ])("preserves %s on native and web while rendering later prose", async (url) => {
    const source = `${url} end :heart:`;
    expect(markdownWithEmoji(source)).toBe(`${url} end ❤️`);
    const { unified } = await import("unified");
    const { default: remarkParse } = await import("remark-parse");
    const { remarkEmojiShortcodes } = await import("./emojiMarkdown.ts");
    const processor = unified().use(remarkParse).use(remarkEmojiShortcodes);
    const tree = processor.runSync(processor.parse(source), { value: source });
    const paragraph = tree.children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type === "paragraph")
      expect(paragraph.children[0]).toMatchObject({ value: `${url} end ❤️` });
  });
});
