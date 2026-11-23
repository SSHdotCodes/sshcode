import { describe, expect, it } from "vite-plus/test";

import { DitherCanvas, DOT, ditherThreshold, snapToDots } from "./dither";
import {
  HEATMAP_WEEKS,
  buildHomeInsights,
  busiestHour,
  formatChange,
  formatHour,
  localDayOrdinal,
} from "./homeInsightsData";

const NOW = new Date(2026, 10, 20, 15, 30).getTime();

function chat(
  id: string,
  created: Date,
  options: { harness?: string; subagent?: boolean; empty?: boolean; environment?: string } = {},
) {
  return {
    id,
    environmentId: options.environment ?? "mac",
    createdAt: created.toISOString(),
    deletedAt: null,
    visibleItemCount: options.empty ? 0 : 3,
    lineage: { relationshipToParent: options.subagent ? "subagent" : null },
    harness: options.harness ?? "claude",
  } as never;
}

const harnessOf = (thread: { harness?: string }) => thread.harness ?? "claude";

describe("buildHomeInsights", () => {
  it("counts today, the week, the month and the streak from top-level chats only", () => {
    const threads = [
      chat("a", new Date(2026, 10, 20, 9)),
      chat("b", new Date(2026, 10, 20, 22), { harness: "codex" }),
      chat("c", new Date(2026, 10, 19, 23)),
      chat("d", new Date(2026, 10, 18, 1)),
      // A gap on the 17th ends the streak.
      chat("e", new Date(2026, 10, 16, 12)),
      chat("f", new Date(2026, 10, 10, 12)),
      chat("g", new Date(2026, 9, 5, 12), { harness: "codex" }),
      chat("sub", new Date(2026, 10, 20, 10), { subagent: true }),
      chat("blank", new Date(2026, 10, 20, 11), { empty: true }),
      // The same chat seen twice counts once.
      chat("a", new Date(2026, 10, 20, 9)),
    ];
    const insights = buildHomeInsights(threads, harnessOf as never, NOW);
    expect(insights.today).toBe(2);
    expect(insights.week).toEqual({ chats: 5, previous: 1 });
    expect(insights.streak).toBe(3);
    expect(insights.month.chats).toBe(6);
    expect(insights.month.previous).toBe(1);
    expect(insights.pace.current).toHaveLength(20);
    expect(insights.pace.current.at(-1)).toBe(6);
    expect(insights.pace.month).toBe("Nov");
    expect(insights.pace.previousMonth).toBe("Oct");
    expect(insights.harnesses).toEqual([
      { key: "claude", count: 5 },
      { key: "codex", count: 1 },
    ]);
    expect(insights.hours[9]).toBe(1);
    expect(insights.hours[22]).toBe(1);
    // Two chats started at noon (the 10th and the 16th).
    expect(busiestHour(insights.hours)).toBe(12);
  });

  it("lays out whole weeks ending with this one, with each day's harness mix", () => {
    const insights = buildHomeInsights(
      [
        chat("a", new Date(2026, 10, 20, 9)),
        chat("b", new Date(2026, 10, 20, 10), { harness: "codex" }),
        chat("c", new Date(2026, 10, 20, 11), { harness: "codex" }),
      ],
      harnessOf as never,
      NOW,
    );
    expect(insights.days).toHaveLength(HEATMAP_WEEKS * 7);
    // Sunday first: the 20th of November 2026 is a Friday, so Saturday is still to come.
    const today = insights.days.find((day) => day.ordinal === localDayOrdinal(NOW))!;
    expect(insights.days.indexOf(today) % 7).toBe(5);
    expect(insights.days.at(-1)!.future).toBe(true);
    expect(today.mix).toEqual([
      { key: "codex", count: 2 },
      { key: "claude", count: 1 },
    ]);
    expect(today.level).toBe(1);
    expect(insights.total).toBe(3);
    expect(insights.activeDays).toBe(1);
  });

  it("keeps a streak alive through a today without chats yet", () => {
    const insights = buildHomeInsights(
      [chat("a", new Date(2026, 10, 19, 9)), chat("b", new Date(2026, 10, 18, 9))],
      harnessOf as never,
      NOW,
    );
    expect(insights.today).toBe(0);
    expect(insights.streak).toBe(2);
  });
});

describe("insight labels", () => {
  it("formats hours and changes", () => {
    expect(formatHour(0)).toBe("12 AM");
    expect(formatHour(13)).toBe("1 PM");
    expect(formatChange(5, 5, "week")).toBe("Same as last week");
    expect(formatChange(7, 4, "week")).toBe("+3 vs last week");
    expect(formatChange(1, 4, "month")).toBe("−3 vs last month");
    expect(busiestHour(Array.from({ length: 24 }, () => 0))).toBeNull();
  });
});

describe("DitherCanvas", () => {
  it("fills a box completely at full density, on the tile grid with hairlines", () => {
    const canvas = new DitherCanvas();
    canvas.solid(4, 8, 16, 8, "#fff");
    const [layer] = canvas.layers();
    expect(layer!.opacity).toBe(1);
    expect(layer!.d.match(/M/g)).toHaveLength((16 / DOT) * (8 / DOT));
    expect(layer!.d.startsWith("M4 8h3.5v3.5h-3.5z")).toBe(true);
  });

  it("splits a box between colours by share, spread over the box", () => {
    const canvas = new DitherCanvas();
    canvas.box(0, 0, 32, 32, 1, [
      { color: "a", share: 3 },
      { color: "b", share: 1 },
    ]);
    const count = (color: string) =>
      canvas
        .layers()
        .filter((layer) => layer.color === color)
        .reduce((sum, layer) => sum + (layer.d.match(/M/g)?.length ?? 0), 0);
    expect(count("a")).toBe(48);
    expect(count("b")).toBe(16);
  });

  it("frays thin light, shades mid light, and sorts tiles into reveal slices", () => {
    const thin = new DitherCanvas(4);
    thin.box(0, 0, 32, 32, 0.1, [{ color: "a", share: 1 }]);
    const thinLayers = thin.layers();
    const thinTiles = thinLayers.reduce(
      (sum, layer) => sum + (layer.d.match(/M/g)?.length ?? 0),
      0,
    );
    expect(thinTiles).toBeGreaterThan(0);
    expect(thinTiles).toBeLessThan(64);

    const mid = new DitherCanvas(4);
    mid.box(0, 0, 32, 32, 0.5, [{ color: "a", share: 1 }]);
    const midLayers = mid.layers();
    const midTiles = midLayers.reduce((sum, layer) => sum + (layer.d.match(/M/g)?.length ?? 0), 0);
    expect(midTiles).toBe(64);
    expect(midLayers.every((layer) => layer.opacity > 0 && layer.opacity < 1)).toBe(true);
    expect(new Set(midLayers.map((layer) => layer.slice))).toEqual(new Set([0, 1, 2, 3]));
  });

  it("snaps lengths to the grid and keeps thresholds in range", () => {
    expect(snapToDots(14.7)).toBe(12);
    expect(snapToDots(-3)).toBe(0);
    expect(ditherThreshold(0, 0)).toBeGreaterThan(0);
    expect(ditherThreshold(-1, -1)).toBeLessThan(1);
  });
});
