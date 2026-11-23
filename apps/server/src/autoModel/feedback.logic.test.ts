import { describe, expect, it } from "vite-plus/test";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { appendAutoModelRecord, canRecordAutoModelFeedback } from "./feedback.logic.ts";

describe("Auto model feedback policy", () => {
  it("accepts owner settings sessions and rejects guests, shares, agent tokens and lesser grants", () => {
    expect(
      canRecordAutoModelFeedback({ subject: "one-time-token", scopes: [AuthSettingsWriteScope] }),
    ).toBe(true);
    expect(canRecordAutoModelFeedback({ subject: "owner", scopes: [] })).toBe(false);
    for (const subject of ["guest:123", "share:123", "mcp-client", "outside-agent:123"]) {
      expect(canRecordAutoModelFeedback({ subject, scopes: [AuthSettingsWriteScope] })).toBe(false);
    }
  });
  it("appends up to 2,000 and trims older records, including an already oversized log", () => {
    expect(appendAutoModelRecord("", "new")).toEqual({ rewrite: false, contents: "new\n" });
    const lines = Array.from({ length: 2002 }, (_, i) => String(i));
    const full = appendAutoModelRecord(lines.join("\n") + "\n", "new");
    expect(full.rewrite).toBe(true);
    expect(full.contents.trim().split("\n")).toHaveLength(2000);
    expect(full.contents.startsWith("3\n")).toBe(true);
    expect(full.contents.endsWith("new\n")).toBe(true);
  });
});
