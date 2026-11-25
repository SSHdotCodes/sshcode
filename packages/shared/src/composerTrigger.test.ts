import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import {
  detectChatMentionTrigger,
  detectComposerEmojiTrigger,
  detectComposerTrigger,
  serializeComposerFileLink,
} from "./composerTrigger.ts";
import { resolveMarkdownFileLinkTarget } from "./markdownLinks.ts";

describe("detectComposerTrigger", () => {
  it.each(["Use ", "Use\t", "Use\n  "])("detects inline slash skills after %j", (prefix) => {
    const text = `${prefix}/skill:review later`;
    const cursor = `${prefix}/skill:review`.length;
    expect(detectComposerTrigger(text, cursor)).toEqual({
      kind: "slash-command",
      query: "skill:review",
      rangeStart: prefix.length,
      rangeEnd: cursor,
    });
  });

  it.each(["/Model opus", "/MODEL opus"])(
    "opens the model picker for capitalized %j the same as /model",
    (text) => {
      expect(detectComposerTrigger(text, text.length)).toMatchObject({
        kind: "slash-model",
        query: "opus",
      });
    },
  );

  it.each(["Use /", "Use /review"])("detects the inline slash token in %j", (text) => {
    expect(detectComposerTrigger(text, text.length)).toEqual({
      kind: "slash-command",
      query: text.slice(5),
      rangeStart: 4,
      rangeEnd: text.length,
    });
  });

  it.each(["Use/review", "https://example.com/review", "Use /review "])(
    "does not trigger for %j",
    (text) => expect(detectComposerTrigger(text, text.length)).toBeNull(),
  );

  it.each(["$", "€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "detects %s skill prefixes and their source range",
    (prefix) => {
      const text = `Use ${prefix}review`;
      expect(detectComposerTrigger(text, text.length)).toEqual({
        kind: "skill",
        query: "review",
        rangeStart: 4,
        rangeEnd: text.length,
      });
    },
  );
});

describe("serializeComposerFileLink", () => {
  it("keeps character references literal in the rendered file label and target", () => {
    const source = serializeComposerFileLink("docs/R&copy;.md");
    const paragraph = unified().use(remarkParse).parse(source).children[0];
    const link = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
    if (link?.type !== "link") throw new Error("Expected a Markdown link");
    expect(link.children).toMatchObject([{ type: "text", value: "R&copy;.md" }]);
    const target = resolveMarkdownFileLinkTarget(link.url, "/workspace");
    expect(target?.replace("/./", "/")).toBe("/workspace/docs/R&copy;.md");
  });

  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](./docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](./@scope/package.json)",
    );
  });
});

describe("detectComposerEmojiTrigger", () => {
  it.each(["", "nice ", "nice\n", "(", "[", "{", "\uFFFC"])("detects :ta after %j", (prefix) => {
    const text = `${prefix}:ta later`;
    expect(detectComposerEmojiTrigger(text, prefix.length + 3)).toEqual({
      kind: "emoji",
      query: "ta",
      rangeStart: prefix.length,
      rangeEnd: prefix.length + 3,
    });
  });
  it.each([":+1", ":100", ":thumbs_up", ":heart", ":t"])("supports %s", (text) => {
    expect(detectComposerEmojiTrigger(text, text.length)?.query).toBe(text.slice(1));
  });
  it.each([
    ":",
    ":tada:",
    ":ta ",
    "10:30",
    "at 10:30",
    "https://example.com/:ta",
    "https://:ta",
    "www.example.com/:ta",
    "word:ta",
    "\\:ta",
    "name::ta",
    "` :ta",
    "``code ` :ta",
    "```js\n:ta",
    "~~~\n:ta",
    "````\n```\n:ta",
    "    :ta",
    "\t:ta",
  ])("ignores %j", (text) => {
    expect(detectComposerEmojiTrigger(text, text.length)).toBeNull();
  });
  it.each([
    "`code` :ta",
    "``code ` ticks`` :ta",
    "```\ncode\n```\n:ta",
    "~~~\ncode\n~~~\n:ta",
    "\\` literal :ta",
  ])("resumes after code in %j", (text) => {
    expect(detectComposerEmojiTrigger(text, text.length)?.query).toBe("ta");
  });
  it("clamps non-finite and out-of-range cursor positions", () => {
    expect(detectComposerEmojiTrigger(":ta", Infinity)?.query).toBe("ta");
    expect(detectComposerEmojiTrigger(":ta", 100)?.query).toBe("ta");
    expect(detectComposerEmojiTrigger(":ta", -1)).toBeNull();
  });
});

describe("a chat described in brackets", () => {
  const at = (text: string) => detectComposerTrigger(text, text.length);

  it("holds spaces, and spans the bracket from its @", () => {
    expect(at("see @[chat with black hole muse wonder")).toEqual({
      kind: "chat",
      query: "chat with black hole muse wonder",
      rangeStart: 4,
      rangeEnd: 38,
    });
    // An opened bracket with nothing in it yet already lists chats.
    expect(at("@[")).toEqual({ kind: "chat", query: "", rangeStart: 0, rangeEnd: 2 });
  });

  it("stays active just past the closing bracket, and covers it", () => {
    const text = "@[black hole sim] ";
    expect(detectComposerTrigger(text, 17)).toEqual({
      kind: "chat",
      query: "black hole sim",
      rangeStart: 0,
      rangeEnd: 17,
    });
    // One character further the description is finished prose.
    expect(detectComposerTrigger(text, 18)).toBeNull();
  });

  it("takes the whole bracket when the caret is inside a closed one", () => {
    expect(detectComposerTrigger("ask @[black hole sim] now", 12)).toEqual({
      kind: "chat",
      query: "black hole sim",
      rangeStart: 4,
      rangeEnd: 21,
    });
    // Unclosed, only what is before the caret describes the chat.
    expect(detectComposerTrigger("ask @[black hole sim now", 16)?.query).toBe("black hole");
  });

  it("needs the @[ at the start of a word, on the caret's own line", () => {
    expect(at("mail@[x")).toBeNull();
    expect(at("@[first line\nsecond")).toBeNull();
    expect(at("@[one] and [two]")).toBeNull();
    expect(at(`@[${"long ".repeat(50)}`)).toBeNull();
    // A second bracket is its own description.
    expect(at("@[one] @[two words")?.query).toBe("two words");
  });

  it("leaves the plain @ picker and its paths alone", () => {
    expect(at("@src/file")?.kind).toBe("path");
    expect(at("@")?.kind).toBe("path");
    expect(detectChatMentionTrigger("@src/file", 9)).toBeNull();
  });

  it("honours the caller's token boundaries", () => {
    const chip = "\uFFFC";
    expect(detectComposerTrigger(`${chip}@[x y`, 6, (char) => char === chip)?.kind).toBe("chat");
    expect(detectComposerTrigger(`${chip}@[x y`, 6)).toBeNull();
  });
});
