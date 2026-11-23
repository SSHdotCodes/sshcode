// @effect-diagnostics globalDate:off -- Fixed test instants.
import { describe, expect, it } from "vite-plus/test";
import { projectUsageWindow } from "./usageLimits.ts";

const reset = Date.parse("2026-11-16T12:00:00Z");
const duration = 7 * 24 * 60;
const window = {
  id: "weekly",
  label: "Weekly",
  kind: "weekly" as const,
  usedPercent: 75,
  resetsAt: new Date(reset).toISOString(),
  windowDurationMins: duration,
};

describe("projectUsageWindow", () => {
  it("projects exhaustion from unrounded use and elapsed time", () => {
    const now = reset - (duration * 60_000) / 2;
    expect(projectUsageWindow(window, now)).toEqual({
      kind: "runsOut",
      at: now + (duration * 60_000) / 2 / 3,
    });
  });
  it("lasts at an even pace or with no usage", () => {
    const now = reset - (duration * 60_000) / 2;
    expect(projectUsageWindow({ ...window, usedPercent: 50 }, now)).toEqual({ kind: "lasts" });
    expect(projectUsageWindow({ ...window, usedPercent: 0 }, now)).toEqual({ kind: "lasts" });
  });
  it("handles exhausted, expired, unknown, and not-yet-open windows honestly", () => {
    expect(projectUsageWindow({ ...window, limited: true }, reset - 1000)).toEqual({
      kind: "runsOut",
      at: reset - 1000,
    });
    expect(projectUsageWindow(window, reset)).toBeNull();
    expect(projectUsageWindow({ ...window, resetsAt: "bad" }, reset - 1000)).toBeNull();
    expect(projectUsageWindow(window, reset - duration * 60_000)).toBeNull();
    expect(projectUsageWindow({ ...window, windowDurationMins: 0 }, reset - 1000)).toBeNull();
  });
});

import { ThreadId, type ThreadUsage } from "@t3tools/contracts";
import { threadUsageRows } from "./usageFormat.ts";
const emptyTokens = {
  uncachedInputTokens: 0,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
};
const emptyUsage: ThreadUsage = {
  readAt: "2026-11-09T15:00:00Z",
  allTime: { tokens: emptyTokens, costUsd: 0, unpricedTokens: 0 },
  today: { tokens: emptyTokens, costUsd: 0, unpricedTokens: 0 },
  compactions: { count: 0, summarizedTokens: 0, unknownSizes: 0, last: null },
  subagentRuns: 0,
  subagents: [],
  weeklyShare: null,
  notes: [],
};
describe("chat usage rows", () => {
  it("omits empty rows and keeps unpriced cost honest", () => {
    expect(threadUsageRows(emptyUsage, ThreadId.make("chat"), () => "3:42 PM")).toEqual([]);
    const usage = {
      ...emptyUsage,
      allTime: {
        tokens: {
          ...emptyTokens,
          uncachedInputTokens: 100,
          cacheCreationTokens: 50,
          reasoningTokens: 20,
          outputTokens: 20,
        },
        costUsd: 0,
        unpricedTokens: 170,
      },
    };
    const rows = threadUsageRows(usage, ThreadId.make("chat"), () => "3:42 PM");
    expect(rows.map((row) => row.label)).toEqual(["Tokens", "Cost"]);
    expect(rows[0]?.details[0]).toBe("170 tokens");
    expect(rows[0]?.details[1]).toContain("Uncached input 150");
    expect(rows[1]?.value).toBe("Unpriced");
  });
  it("uses distinct subagent runs, preserves model detail, and shows unknown sizes", () => {
    const rows = threadUsageRows(
      {
        ...emptyUsage,
        compactions: {
          count: 1,
          summarizedTokens: 0,
          unknownSizes: 1,
          last: { beforeTokens: null, afterTokens: 25000, at: emptyUsage.readAt },
        },
        subagentRuns: 1,
        subagents: [
          { model: "a", runs: 1, tokens: 100 },
          { model: "b", runs: 1, tokens: 200 },
        ],
      },
      ThreadId.make("chat"),
      () => "3:42 PM",
    );
    expect(rows[0]?.details).toContain("Last: unknown → 25K, 3:42 PM");
    expect(rows[1]?.value).toBe("1 · 300");
  });
});

it("projects monthly limits from the previous calendar-month boundary when no duration is given", () => {
  const now = Date.parse("2026-11-16T00:00:00Z");
  const window = {
    id: "monthly",
    kind: "monthly" as const,
    label: "Monthly",
    resetsAt: "2026-12-01T00:00:00Z",
    usedPercent: 75,
  };
  expect(projectUsageWindow(window, now)).toEqual({ kind: "runsOut", at: now + 5 * 86400000 });
});
