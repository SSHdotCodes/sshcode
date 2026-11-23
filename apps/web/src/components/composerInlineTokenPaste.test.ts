import { describe, expect, it } from "vite-plus/test";

import { importPastedComposerText } from "./composerInlineTokenPaste";

const clipboard = (data: Record<string, string>) => ({
  getData: (type: string) => data[type] ?? "",
});

describe("importPastedComposerText", () => {
  it("imports CRLF and CR clipboard text with LF line breaks", () => {
    expect(
      importPastedComposerText(clipboard({ "text/plain": "x\r\n\r\ny\rz" }), () => new Map()),
    ).toBe("x\n\ny\nz");
  });
});
