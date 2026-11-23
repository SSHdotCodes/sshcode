import { describe, expect, it } from "vite-plus/test";

import { messagePreviewLine } from "./messagePreview.ts";

describe("messagePreviewLine", () => {
  it("reads the opening as one plain line", () => {
    expect(messagePreviewLine("## Done\n\nThe **fix** is in `stream.ts`.\n\n- one\n- two")).toBe(
      "Done The fix is in stream.ts. one two",
    );
  });

  it("keeps link text and drops the address", () => {
    expect(messagePreviewLine("See [the report](https://example.com/a) and ![shot](x.png).")).toBe(
      "See the report and shot.",
    );
  });

  it("skips code blocks, rules and blank lines", () => {
    expect(messagePreviewLine("```ts\nconst a = 1;\n```\n---\n\nIt now passes.")).toBe(
      "It now passes.",
    );
    expect(messagePreviewLine("```\nonly code\n```")).toBeNull();
    expect(messagePreviewLine("  \n\n")).toBeNull();
  });

  it("keeps identifiers with single underscores and stars intact", () => {
    expect(messagePreviewLine("Renamed my_var and 2 * 3.")).toBe("Renamed my_var and 2 * 3.");
  });

  it("cuts a long opening with an ellipsis", () => {
    const line = messagePreviewLine("word ".repeat(200));
    expect(line?.length).toBe(120);
    expect(line?.endsWith("…")).toBe(true);
  });
});
