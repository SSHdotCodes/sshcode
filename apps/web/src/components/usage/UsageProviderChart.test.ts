import { describe, expect, it } from "vite-plus/test";

import {
  axisTickLabels,
  buildChart,
  buildPeriodColumns,
  chartScale,
  niceScale,
  shownPeriodTotal,
} from "./UsageProviderChart";
import { providersWithUsage } from "./usageProviders";

describe("chartScale", () => {
  const column = (codex: number) => ({
    total: codex,
    bands: [{ provider: "codex" as const, value: codex }],
  });

  it("holds unlabeled placeholder gridlines while loading providers have nothing to show", () => {
    const scale = chartScale([column(0)], new Set(["codex" as const]));

    expect(scale.labeled).toBe(false);
    expect(scale.ticks.length).toBeGreaterThan(1);
  });

  it("scales to what is on screen, loading or not", () => {
    expect(chartScale([column(40)], new Set(["codex" as const]))).toMatchObject({
      max: 40,
      labeled: true,
    });
  });
});

describe("axisTickLabels", () => {
  const usd = (value: number) => `$${value.toFixed(2)}`;

  it("drops cents when every step is a whole dollar", () => {
    expect(axisTickLabels([0, 1, 2, 3], usd)).toEqual(["0", "$1", "$2", "$3"]);
  });

  it("keeps cents when a step needs them", () => {
    expect(axisTickLabels([0, 0.5, 1, 1.5], usd)).toEqual(["0", "$0.50", "$1.00", "$1.50"]);
  });

  it("leaves labels without cents alone", () => {
    expect(axisTickLabels([0, 1e6, 2e6], (value) => `${value / 1e6}M`)).toEqual(["0", "1M", "2M"]);
  });
});

describe("niceScale", () => {
  it("never puts the peak above the top of the scale", () => {
    // Regression: an earlier version stopped at the last step below the peak,
    // so the tallest day was drawn past the plot and clipped.
    for (const peak of [1122.71, 999, 1, 0.04, 1_400_000_000, 37.5, 5000, 100.001]) {
      const { max } = niceScale(peak, 4);
      expect(max, `peak ${peak}`).toBeGreaterThanOrEqual(peak);
    }
  });

  it("starts at zero and ends at the maximum", () => {
    const { max, ticks } = niceScale(1122.71, 4);

    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBeCloseTo(max, 6);
  });

  it("uses evenly spaced 1/2/5 steps", () => {
    const { ticks } = niceScale(1122.71, 4);
    const steps = ticks.slice(1).map((tick, index) => tick - (ticks[index] ?? 0));

    for (const step of steps) expect(step).toBeCloseTo(steps[0] ?? 0, 6);
    const [first = 0] = steps;
    const normalized = first / 10 ** Math.floor(Math.log10(first));
    expect([1, 2, 5, 10]).toContain(Math.round(normalized));
  });

  it("keeps the tick count near the requested resolution", () => {
    const { ticks } = niceScale(1122.71, 4);
    expect(ticks.length).toBeGreaterThanOrEqual(3);
    expect(ticks.length).toBeLessThanOrEqual(7);
  });

  it("degrades to a single zero tick with no data", () => {
    expect(niceScale(0, 4)).toEqual({ max: 0, ticks: [0] });
  });
});

describe("buildPeriodColumns", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 35,
        totalTokens: 350,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
          ["pi" as const, { costUsd: 5, totalTokens: 50 }],
        ]),
      },
    ],
    // 2026-08-02 is deliberately absent: a day with no activity.
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
      },
    ],
  ]);

  it("plots each day on its own", () => {
    expect(buildPeriodColumns(days, byDay, "cost").map((column) => column.total)).toEqual([
      35, 0, 5,
    ]);
  });

  it("reads the requested metric", () => {
    expect(buildPeriodColumns(days, byDay, "tokens").map((column) => column.total)).toEqual([
      350, 0, 50,
    ]);
  });

  it("keeps band values absolute rather than cumulative", () => {
    // Regression: the bands were once stack offsets, which drew Claude Code
    // permanently above Codex regardless of which provider spent more.
    const [first] = buildPeriodColumns(days, byDay, "cost");

    expect(first?.bands).toEqual([
      { provider: "codex", value: 10 },
      { provider: "claude", value: 20 },
      { provider: "grok", value: 0 },
      { provider: "cursor", value: 0 },
      { provider: "opencode", value: 0 },
      { provider: "antigravity", value: 0 },
      { provider: "pi", value: 5 },
      { provider: "muse", value: 0 },
      { provider: "vibe", value: 0 },
      { provider: "qwen-code", value: 0 },
      { provider: "kimi", value: 0 },
      { provider: "hermes", value: 0 },
      { provider: "devin", value: 0 },
    ]);
  });

  it("includes Qwen, Kimi, and Hermes in both cost and token totals", () => {
    const daily = new Map([
      [
        "2026-08-01",
        {
          day: "2026-08-01",
          costUsd: 6,
          totalTokens: 600,
          byProvider: new Map([
            ["qwen-code" as const, { costUsd: 1, totalTokens: 100 }],
            ["kimi" as const, { costUsd: 2, totalTokens: 200 }],
            ["hermes" as const, { costUsd: 3, totalTokens: 300 }],
          ]),
        },
      ],
    ]);

    const [cost] = buildPeriodColumns(days, daily, "cost");
    const [tokens] = buildPeriodColumns(days, daily, "tokens");
    expect(cost?.total).toBe(6);
    expect(tokens?.total).toBe(600);
    expect(cost?.bands.filter((band) => band.value > 0)).toEqual([
      { provider: "qwen-code", value: 1 },
      { provider: "kimi", value: 2 },
      { provider: "hermes", value: 3 },
    ]);
    expect(tokens?.bands.filter((band) => band.value > 0)).toEqual([
      { provider: "qwen-code", value: 100 },
      { provider: "kimi", value: 200 },
      { provider: "hermes", value: 300 },
    ]);
  });

  it("reports the total as the sum of its bands", () => {
    for (const column of buildPeriodColumns(days, byDay, "cost")) {
      const sum = column.bands.reduce((running, band) => running + band.value, 0);
      expect(column.total).toBeCloseTo(sum, 9);
    }
  });

  it("counts a provider with no entry as zero when summing the providers on screen", () => {
    const columns = buildPeriodColumns(days, byDay, "cost");
    const shown = ["codex", "claude", "pi"] as const;

    // Day two is missing entirely. Day three has only Claude, so Codex and Pi are zero.
    expect(columns.map((column) => shownPeriodTotal(column, shown))).toEqual([35, 0, 5]);
    expect(columns.map((column) => shownPeriodTotal(column, ["codex", "claude"]))).toEqual([
      30, 0, 5,
    ]);
  });
});

describe("providersWithUsage", () => {
  it("omits providers with no cost or tokens", () => {
    expect(
      providersWithUsage([
        { provider: "codex", costUsd: 0, totalTokens: 0 },
        { provider: "claude", costUsd: 0, totalTokens: 200 },
      ]),
    ).toEqual(["claude"]);
  });
});

describe("chart series", () => {
  const days = ["2026-08-01", "2026-08-02", "2026-08-03"];
  const byDay = new Map([
    [
      "2026-08-01",
      {
        day: "2026-08-01",
        costUsd: 35,
        totalTokens: 350,
        byProvider: new Map([
          ["codex" as const, { costUsd: 10, totalTokens: 100 }],
          ["claude" as const, { costUsd: 20, totalTokens: 200 }],
          ["pi" as const, { costUsd: 5, totalTokens: 50 }],
        ]),
      },
    ],
    [
      "2026-08-03",
      {
        day: "2026-08-03",
        costUsd: 5,
        totalTokens: 50,
        byProvider: new Map([["claude" as const, { costUsd: 5, totalTokens: 50 }]]),
      },
    ],
  ]);
  const shown = ["codex", "claude", "pi"] as const;

  it("draws one line per provider by default", () => {
    const chart = buildChart(days, byDay, "tokens", shown, new Set());

    expect(chart.paths.map((path) => path.key).sort()).toEqual(["claude", "codex", "pi"]);
    expect(chart.paths.every((path) => path.foreground === false)).toBe(true);
    expect(chart.scale.max).toBe(200);
  });

  it("draws one total line that sums the providers on screen", () => {
    const tokens = buildChart(days, byDay, "tokens", shown, new Set(), "total");
    const cost = buildChart(days, byDay, "cost", ["codex", "claude"], new Set(), "total");

    expect(tokens.paths).toHaveLength(1);
    expect(tokens.paths[0]).toMatchObject({
      key: "total",
      foreground: true,
      stroke: "currentColor",
      loading: false,
      values: [350, 0, 50],
    });
    expect(tokens.paths[0]?.line.startsWith("M")).toBe(true);
    expect(cost.paths[0]?.values).toEqual([30, 0, 5]);
    expect(tokens.scale.max).toBeGreaterThanOrEqual(350);
    expect(cost.scale.max).toBeGreaterThanOrEqual(30);
  });

  it("scales provider lines to the tallest series and the total to the summed peak", () => {
    const columns = buildPeriodColumns(days, byDay, "cost");

    expect(chartScale(columns, new Set()).max).toBe(20);
    expect(chartScale(columns, new Set(), "total", ["codex", "claude", "pi"]).max).toBe(40);
  });

  it("keeps placeholder gridlines while a total has nothing to show yet", () => {
    const columns = buildPeriodColumns(["2026-08-01"], new Map(), "tokens");

    expect(chartScale(columns, new Set(["codex" as const]), "total", ["codex"]).labeled).toBe(
      false,
    );
  });

  it("mutes the total only while a provider on screen is still loading", () => {
    expect(
      buildChart(days, byDay, "tokens", shown, new Set(["claude" as const]), "total").paths[0]
        ?.loading,
    ).toBe(true);
    expect(
      buildChart(days, byDay, "tokens", ["codex", "claude"], new Set(["pi" as const]), "total")
        .paths[0]?.loading,
    ).toBe(false);
  });
});

describe("hourly chart columns", () => {
  it("zero-fills inactive hours and preserves hourly provider values", () => {
    const byHour = new Map([
      [
        "2026-08-11T09:37:00.000Z",
        {
          day: "2026-08-11",
          hourStart: "2026-08-11T09:37:00.000Z",
          costUsd: 4,
          totalTokens: 40,
          byProvider: new Map([["codex" as const, { costUsd: 4, totalTokens: 40 }]]),
        },
      ],
    ]);

    expect(
      buildPeriodColumns(
        ["2026-08-11T08:37:00.000Z", "2026-08-11T09:37:00.000Z", "2026-08-11T10:37:00.000Z"],
        byHour,
        "cost",
      ).map((column) => column.total),
    ).toEqual([0, 4, 0]);
  });
});
