import { describe, expect, it } from "vite-plus/test";

import { isThreadErrorShownInTimeline } from "./ThreadErrorBanner";

const errorRow = (detail: string) => ({
  kind: "work",
  entry: { detail, sourceActivityKind: "runtime.error" },
});

describe("isThreadErrorShownInTimeline", () => {
  it("finds the run's own error row, so the banner need not repeat it", () => {
    const entries = [{ kind: "message" }, errorRow("QA provider error (requested).")];
    expect(isThreadErrorShownInTimeline(entries, "QA provider error (requested).")).toBe(true);
    expect(isThreadErrorShownInTimeline(entries, " QA provider error (requested).\n")).toBe(true);
  });

  it("keeps the banner for an error the transcript does not show", () => {
    const entries = [
      { kind: "message" },
      errorRow("An older failure."),
      {
        kind: "work",
        entry: { detail: "Could not start the provider.", sourceActivityKind: "tool" },
      },
    ];
    expect(isThreadErrorShownInTimeline(entries, "Could not start the provider.")).toBe(false);
    expect(isThreadErrorShownInTimeline([], "Could not start the provider.")).toBe(false);
    expect(isThreadErrorShownInTimeline(entries, null)).toBe(false);
    expect(isThreadErrorShownInTimeline(entries, "  ")).toBe(false);
  });

  it("reads only the latest stretch of a long transcript", () => {
    const entries = [
      errorRow("Failed long ago."),
      ...Array.from({ length: 60 }, () => ({ kind: "message" })),
    ];
    expect(isThreadErrorShownInTimeline(entries, "Failed long ago.")).toBe(false);
  });
});
