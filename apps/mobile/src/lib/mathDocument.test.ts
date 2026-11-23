// @vitest-environment jsdom
import { describe, expect, it, vi } from "vite-plus/test";
import { mathDocument } from "./mathDocument";
import { findMathBlocks } from "./markdownMath";
import { markdownWithTypesetMath } from "./mathTypeset";

describe("math WebView document", () => {
  it("copies authored formula and link sources and routes links without loading them", () => {
    const source = "Before $x^2$ and [a link](https://example.test/a?x=1&y=2).";
    const block = [
      ...markdownWithTypesetMath(source, findMathBlocks(source, true)).diagrams.values(),
    ][0]!;
    const parsed = new DOMParser().parseFromString(
      mathDocument(block.html, "#ededed", 16, 22, "#07f", "System", true),
      "text/html",
    );
    const posted: string[] = [];
    vi.stubGlobal("ReactNativeWebView", { postMessage: (message: string) => posted.push(message) });
    document.body.innerHTML = parsed.body.innerHTML;
    try {
      window.eval(document.body.querySelector("script")!.textContent!);
      const copy = (element: Element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        let copied = "";
        const event = new Event("copy", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", {
          value: {
            setData: (_type: string, text: string) => {
              copied = text;
            },
          },
        });
        document.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        return copied;
      };
      expect(copy(document.querySelector("[data-math-source] mi")!)).toBe("$x^2$");
      const link = document.querySelector<HTMLAnchorElement>("[data-math-link]")!;
      expect(copy(link)).toBe("[a link](https://example.test/a?x=1&y=2)");
      link.click();
      expect(
        posted
          .map((message) => JSON.parse(message))
          .some((message) => message.link === "https://example.test/a?x=1&y=2"),
      ).toBe(true);
      expect(
        parsed.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute("content"),
      ).toContain("default-src 'none'");
      expect(parsed.querySelectorAll("script[src], link[href], img[src]")).toHaveLength(0);
      expect(parsed.querySelector("style")?.textContent).toContain("white-space:pre-wrap");
    } finally {
      window.getSelection()?.removeAllRanges();
      document.body.replaceChildren();
      vi.unstubAllGlobals();
    }
  });
});
