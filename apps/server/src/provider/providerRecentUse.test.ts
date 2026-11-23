import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { recentUseByInstance, recentUseMoved } from "./providerRecentUse.ts";

const now = Date.parse("2026-11-21T05:00:00.000Z");
const hoursAgo = (hours: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(now - hours * 3_600_000));

describe("recentUseByInstance", () => {
  it("adds up hours run, each counting half as much a day after it ended", () => {
    const use = recentUseByInstance(
      [
        // Two hours that ended just now count in full.
        { instanceId: "claudeAgent", requestedAt: hoursAgo(2), completedAt: hoursAgo(0) },
        // Two hours that ended a day ago count as one.
        { instanceId: "claudeAgent", requestedAt: hoursAgo(26), completedAt: hoursAgo(24) },
        // A run still going counts up to now.
        { instanceId: "codex", requestedAt: hoursAgo(1), completedAt: null },
      ],
      now,
    );
    expect(Object.fromEntries(use)).toEqual({ claudeAgent: 3, codex: 1 });
  });

  it("caps a run left open and drops runs older than a week", () => {
    const use = recentUseByInstance(
      [
        { instanceId: "grok", requestedAt: hoursAgo(30), completedAt: null },
        {
          instanceId: "opencode",
          requestedAt: hoursAgo(8 * 24),
          completedAt: hoursAgo(8 * 24 - 1),
        },
        { instanceId: "pi", requestedAt: "not a date", completedAt: null },
      ],
      now,
    );
    expect(Object.fromEntries(use)).toEqual({ grok: 6 });
  });
});

describe("recentUseMoved", () => {
  it("ignores the drift decay causes and catches moves that can reorder plans", () => {
    expect(recentUseMoved(122, 121.4)).toBe(false);
    expect(recentUseMoved(122, 109)).toBe(true);
    expect(recentUseMoved(1, 1.2)).toBe(false);
    expect(recentUseMoved(1, 1.3)).toBe(true);
  });
});
