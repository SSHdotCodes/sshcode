import type { DailyTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({}));

import { buildChartDays } from "./usageChartData";

describe("buildChartDays", () => {
  it("includes every harness in the phone charts and zero-fills empty days", () => {
    const daily: DailyTotals[] = [
      {
        day: "2026-08-01",
        costUsd: 15,
        totalTokens: 1500,
        byProvider: new Map([
          ["claude", { costUsd: 1, totalTokens: 100 }],
          ["codex", { costUsd: 2, totalTokens: 200 }],
          ["qwen-code", { costUsd: 3, totalTokens: 300 }],
          ["kimi", { costUsd: 4, totalTokens: 400 }],
          ["hermes", { costUsd: 5, totalTokens: 500 }],
        ]),
      },
    ];
    const days = ["2026-08-01", "2026-08-02"];
    const cost = buildChartDays(days, daily, "cost");
    const tokens = buildChartDays(days, daily, "tokens");

    expect(cost.map((day) => day.total)).toEqual([15, 0]);
    expect(tokens.map((day) => day.total)).toEqual([1500, 0]);
    expect(cost[0]?.values.filter((entry) => entry.value > 0)).toEqual([
      { provider: "codex", value: 2 },
      { provider: "claude", value: 1 },
      { provider: "qwen-code", value: 3 },
      { provider: "kimi", value: 4 },
      { provider: "hermes", value: 5 },
    ]);
    expect(tokens[0]?.values.filter((entry) => entry.value > 0)).toEqual([
      { provider: "codex", value: 200 },
      { provider: "claude", value: 100 },
      { provider: "qwen-code", value: 300 },
      { provider: "kimi", value: 400 },
      { provider: "hermes", value: 500 },
    ]);
  });
});
