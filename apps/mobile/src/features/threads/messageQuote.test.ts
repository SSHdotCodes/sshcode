import { describe, expect, it } from "vite-plus/test";
import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@t3tools/contracts";

import { appendMessageQuote, messageQuoteText, prepareMessageQuote } from "./messageQuote";

describe("message quotes", () => {
  it("starts a reply with a Markdown quote and room to type below it", () => {
    expect(appendMessageQuote("", "Try the smaller change.")).toBe("> Try the smaller change.\n\n");
  });

  it.each(["My draft", "My draft\n", "My draft\n\n"])(
    "keeps the existing draft intact and separates its quote: %j",
    (draft) => {
      const next = appendMessageQuote(draft, "The answer");
      expect(next.startsWith(draft)).toBe(true);
      expect(next).toBe("My draft\n\n> The answer\n\n");
    },
  );

  it("keeps blank lines, nested quotes, and code indentation inside the quote", () => {
    expect(appendMessageQuote("", "\n    code\n\n> nested\n```ts\nconst n = 1;\n```\n")).toBe(
      ">     code\n>\n> > nested\n> ```ts\n> const n = 1;\n> ```\n\n",
    );
  });

  it("normalizes pasted line endings without adding stray carriage returns", () => {
    expect(appendMessageQuote("", "one\r\ntwo\rthree")).toBe("> one\n> two\n> three\n\n");
  });

  it("quotes context labels instead of creating context references without payloads", () => {
    const message =
      "Check [src/index.ts](t3-context://v1/file/ctx_file) and ![screen.png](t3-context://v1/image/ctx_image).";
    expect(messageQuoteText(message)).toBe("Check src/index.ts and screen.png.");
    expect(appendMessageQuote("", message)).toBe("> Check src/index.ts and screen.png.\n\n");
  });

  it("keeps regular links and Markdown formatting", () => {
    expect(appendMessageQuote("", "**Result:** [docs](https://example.com/docs)")).toBe(
      "> **Result:** [docs](https://example.com/docs)\n\n",
    );
  });

  it.each(["", "  ", "\r\n\t\n"])("ignores an empty message: %j", (message) => {
    expect(appendMessageQuote("Keep this  \n", message)).toBe("Keep this  \n");
  });

  it("accepts a quote exactly at the input limit, counting quote markers and spacing", () => {
    const quote = prepareMessageQuote("", "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 4));
    expect(quote.kind).toBe("ready");
    if (quote.kind === "ready") expect(quote.text).toHaveLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
  });

  it("refuses an oversized quote without returning replacement draft content", () => {
    const draft = "Keep my reply";
    const quote = prepareMessageQuote(draft, "x".repeat(PROVIDER_SEND_TURN_MAX_INPUT_CHARS - 4));
    expect(quote).toEqual({ kind: "too-long" });
  });

  it("counts the per-line Markdown prefixes for long multiline quotes", () => {
    const message = "x\n".repeat(Math.floor(PROVIDER_SEND_TURN_MAX_INPUT_CHARS / 3));
    expect(message.length).toBeLessThan(PROVIDER_SEND_TURN_MAX_INPUT_CHARS);
    expect(prepareMessageQuote("", message)).toEqual({ kind: "too-long" });
  });
});
