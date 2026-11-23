import { describe, expect, it } from "vite-plus/test";

import {
  applyBenchmarkFeed,
  benchmarkFeedRowsFor,
  benchmarkFeedSlugs,
  type BenchmarkFeedRowLike,
} from "./modelBenchmarkFeed.ts";
import { MODEL_BENCHMARKS, type ModelBenchmarkTable } from "./modelBenchmarks.ts";
import { benchmarkFor, benchmarksAtEffort } from "./modelPicks.ts";

const table: ModelBenchmarkTable = {
  asOf: "2026-11-10",
  metrics: { aaIntelligenceIndex: { label: "Intelligence Index" }, terminalBench: { label: "TB" } },
  models: [
    {
      id: "gpt-6.1-sol",
      label: "GPT-6.1 Sol",
      aaSlug: "gpt-6-1-sol",
      scores: { aaIntelligenceIndex: 55, terminalBench: 71 },
      outputTokensPerSecond: 55.6,
      outputTokensPerTask: 9000,
      price: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cachedInputPerMTok: 0.1,
        cacheWritePerMTok: 2.5,
      },
      efforts: {
        max: {
          aaSlug: "gpt-6-1-sol",
          scores: { aaIntelligenceIndex: 55 },
          outputTokensPerSecond: 55.6,
        },
        high: { aaSlug: "gpt-6-1-sol-high", scores: { aaIntelligenceIndex: 50 } },
      },
    },
    { id: "local-model", label: "Local", scores: { aaIntelligenceIndex: 12 } },
  ],
};

const row = (slug: string, patch: Partial<BenchmarkFeedRowLike> = {}): BenchmarkFeedRowLike => ({
  slug,
  name: slug,
  intelligenceIndex: null,
  outputTokensPerSecond: null,
  price: null,
  ...patch,
});
const feed = (rows: ReadonlyArray<BenchmarkFeedRowLike>) => ({
  source: "Artificial Analysis",
  fetchedAt: "2026-11-12T15:00:00.000Z",
  rows,
});

describe("applyBenchmarkFeed", () => {
  it("leaves the table alone without a feed", () => {
    expect(applyBenchmarkFeed(table, null)).toBe(table);
    expect(applyBenchmarkFeed(table, feed([]))).toBe(table);
  });

  it("replaces the figures the feed carries and keeps the rest", () => {
    const next = applyBenchmarkFeed(
      table,
      feed([
        row("gpt-6-1-sol", {
          intelligenceIndex: 57.4,
          outputTokensPerSecond: 61.26,
          price: {
            inputPerMTok: 1.5,
            outputPerMTok: 8,
            cachedInputPerMTok: null,
            cacheWritePerMTok: null,
          },
        }),
        row("gpt-6-1-sol-high", { intelligenceIndex: 51.6, outputTokensPerSecond: 58 }),
      ]),
    );
    expect(next.asOf).toBe("2026-11-12");
    expect(next.liveSource).toBe("Artificial Analysis");
    const sol = next.models[0]!;
    expect(sol.scores).toEqual({ aaIntelligenceIndex: 57, terminalBench: 71 });
    expect(sol.outputTokensPerSecond).toBe(61.3);
    expect(sol.outputTokensPerTask).toBe(9000);
    // The table's own price stands: it comes from the maker's list and knows about discounts.
    expect(sol.price).toEqual(table.models[0]!.price);
    expect(sol.efforts?.max).toMatchObject({ scores: { aaIntelligenceIndex: 57 } });
    expect(sol.efforts?.high).toEqual({
      aaSlug: "gpt-6-1-sol-high",
      scores: { aaIntelligenceIndex: 52 },
      outputTokensPerSecond: 58,
    });
    expect(next.models[1]).toEqual(table.models[1]);
    expect(table.models[0]!.scores.aaIntelligenceIndex).toBe(55);
  });

  it("fills in a price the table lacks", () => {
    const next = applyBenchmarkFeed(
      { ...table, models: [{ ...table.models[1]!, aaSlug: "local-model" }] },
      feed([
        row("local-model", {
          price: {
            inputPerMTok: 1.5,
            outputPerMTok: 7.5,
            cachedInputPerMTok: null,
            cacheWritePerMTok: null,
          },
        }),
      ]),
    );
    expect(next.models[0]!.price).toEqual({ inputPerMTok: 1.5, outputPerMTok: 7.5 });
  });

  it("ignores figures that cannot be right", () => {
    const next = applyBenchmarkFeed(
      table,
      feed([row("gpt-6-1-sol", { intelligenceIndex: 640, outputTokensPerSecond: 0 })]),
    );
    expect(next.models[0]!.scores.aaIntelligenceIndex).toBe(55);
    expect(next.models[0]!.outputTokensPerSecond).toBe(55.6);
  });

  it("finds a row the table lists without a publisher id by the model's own id", () => {
    // Nanbeige4.3-33B, 2026-11-11: gathered before the publisher scored it, so
    // the row had no id of theirs and stayed unscored while the feed carried 20.4.
    const unlisted = {
      ...table,
      models: [...table.models, { id: "nanbeige4.3-33b", label: "Nanbeige4.3-33B", scores: {} }],
    };
    expect(benchmarkFeedSlugs(unlisted).has("nanbeige4-3-33b")).toBe(true);
    const rows = [
      row("nanbeige4-3-33b", { name: "Nanbeige4.3-33B", intelligenceIndex: 20.4 }),
      row("unrelated-model", { intelligenceIndex: 40 }),
    ];
    expect(
      benchmarkFeedRowsFor(unlisted, ["nanbeige4.3-33b"], rows).map((entry) => entry.slug),
    ).toEqual(["nanbeige4-3-33b"]);
    const next = applyBenchmarkFeed(unlisted, feed(rows));
    const matches = next.models.filter((model) => /nanbeige/i.test(model.id));
    expect(matches).toHaveLength(1);
    expect(matches[0]!.scores).toEqual({ aaIntelligenceIndex: 20 });
  });

  it("adds a model the table has never heard of, with its efforts under it", () => {
    const next = applyBenchmarkFeed(
      table,
      feed([
        row("gpt-6-2-sol", {
          name: "GPT-6.2 Sol (Max)",
          intelligenceIndex: 61.2,
          outputTokensPerSecond: 70,
          price: {
            inputPerMTok: 2,
            outputPerMTok: 10,
            cachedInputPerMTok: 0.1,
            cacheWritePerMTok: null,
          },
        }),
        row("gpt-6-2-sol-low", { name: "GPT-6.2 Sol (low)", intelligenceIndex: 40.2 }),
        row("priced-only", {
          price: {
            inputPerMTok: 1,
            outputPerMTok: 2,
            cachedInputPerMTok: null,
            cacheWritePerMTok: null,
          },
        }),
        row("made-for-high", { name: "Made For High", intelligenceIndex: 30 }),
      ]),
    );
    const added = next.models.find((model) => model.id === "gpt-6-2-sol")!;
    expect(added).toMatchObject({
      label: "GPT-6.2 Sol",
      scores: { aaIntelligenceIndex: 61 },
      outputTokensPerSecond: 70,
      price: { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.1 },
    });
    expect(Object.keys(added.efforts ?? {}).sort()).toEqual(["low", "max"]);
    expect(added.efforts?.low?.scores).toEqual({ aaIntelligenceIndex: 40 });
    expect(next.models.some((model) => model.id === "priced-only")).toBe(false);
    // "-high" ends this model's own name: no plain id beside it, so it is no effort.
    expect(next.models.find((model) => model.id === "made-for-high")?.efforts).toHaveProperty(
      "default",
    );
    // The picks find the new row from the id a provider uses, at the effort someone runs.
    expect(benchmarkFor("codex/gpt-6.2-sol", benchmarksAtEffort(next, "low"))?.scores).toEqual({
      aaIntelligenceIndex: 40,
    });
  });
});

describe("benchmarkFeedRowsFor", () => {
  it("keeps the table's rows and unknown models the user can run", () => {
    const rows = [
      row("gpt-6-1-sol"),
      row("gpt-6-1-sol-high"),
      row("gpt-6-1-sol-low"),
      row("gpt-6-2-sol"),
      row("gpt-6-2-sol-xhigh"),
      row("someone-elses-model"),
    ];
    expect(
      benchmarkFeedRowsFor(table, ["gpt-6.1-sol", "codex/gpt-6.2-sol", "local-model"], rows).map(
        (entry) => entry.slug,
      ),
    ).toEqual(["gpt-6-1-sol", "gpt-6-1-sol-high", "gpt-6-2-sol", "gpt-6-2-sol-xhigh"]);
  });

  it("finds a first version the publisher lists without its number", () => {
    const rows = [
      row("muse-ember", { name: "Muse Ember (Max)", intelligenceIndex: 36 }),
      row("muse-ember-xhigh", { name: "Muse Ember (Xhigh)", intelligenceIndex: 34 }),
      row("muse-ember-2", { intelligenceIndex: 40 }),
    ];
    const sent = benchmarkFeedRowsFor(table, ["muse/muse-ember-1.0"], rows);
    expect(sent.map((entry) => entry.slug)).toEqual(["muse-ember", "muse-ember-xhigh"]);
    // And the row it adds is the one the model's own id then finds.
    const next = benchmarksAtEffort(applyBenchmarkFeed(table, feed(sent)), "max");
    expect(benchmarkFor("muse-ember-1.0", next)?.scores).toEqual({ aaIntelligenceIndex: 36 });
  });
});

describe("the built-in table", () => {
  it.each([
    ["sol", { max: 40360, xhigh: 24323, high: 20160, medium: 13651, low: 5980 }],
    ["astra", { max: 41029, xhigh: 22238, high: 17828, medium: 13165, low: 5216 }],
  ] as const)("pairs GPT-6.2 %s task sizes with the matching live speeds", (family, sizes) => {
    const model = `codex/gpt-6.2-${family}`;
    const slug = `gpt-6-2-${family}`;
    const rows = Object.keys(sizes).map((effort, index) =>
      row(effort === "max" ? slug : `${slug}-${effort}`, {
        name: `GPT-6.2 ${family} (${effort})`,
        intelligenceIndex: 55,
        outputTokensPerSecond: 50 + index,
      }),
    );
    const matched = benchmarkFeedRowsFor(MODEL_BENCHMARKS, [model], rows);
    const next = applyBenchmarkFeed(MODEL_BENCHMARKS, feed(matched));
    Object.entries(sizes).forEach(([effort, size], index) => {
      expect(benchmarkFor(model, benchmarksAtEffort(next, effort))).toMatchObject({
        outputTokensPerTask: size,
        outputTokensPerSecond: 50 + index,
      });
    });
  });

  it.each([
    ["gemini-3.8-flash", "gemini-3-8-flash", "high", 98940],
    ["gemini-4-argon", "gemini-4-argon", "high", 116368],
    ["gemini-4-hydrogen", "gemini-4-hydrogen", "xhigh", 154406],
    ["gemini-3-8-flash-medium", "gemini-3-8-flash-medium", "high", 82068],
    ["gemini-4-argon-medium", "gemini-4-argon-medium", "high", 100407],
    ["gemini-4-hydrogen-medium", "gemini-4-hydrogen-medium", "xhigh", 39353],
    ["claude-fable-5-1-medium", "claude-fable-5-1-medium", "high", 48545],
    ["deepseek-v4-pro-high", "deepseek-v4-pro-high", "xhigh", 70314],
    ["gemini-4-neon", "gemini-4-neon", "xhigh", 141631],
    ["gemini-4-neon-high", "gemini-4-neon-high", "high", 90188],
  ] as const)("pairs %s with its published task size and live speed", (id, slug, effort, size) => {
    const rows = benchmarkFeedRowsFor(
      MODEL_BENCHMARKS,
      [id],
      [row(slug, { outputTokensPerSecond: 70 })],
    );
    const table = benchmarksAtEffort(applyBenchmarkFeed(MODEL_BENCHMARKS, feed(rows)), effort);
    expect(benchmarkFor(id, table)).toMatchObject({
      outputTokensPerSecond: 70,
      outputTokensPerTask: size,
    });
  });

  it("keeps Qwen4 Max's task size when live speed figures arrive", () => {
    const next = applyBenchmarkFeed(
      MODEL_BENCHMARKS,
      feed([
        row("qwen4-max", {
          name: "Qwen4 Max",
          intelligenceIndex: 43,
          outputTokensPerSecond: 54.3,
        }),
      ]),
    );
    const model = benchmarkFor("qwen4-max", benchmarksAtEffort(next, "xhigh"));
    expect(model?.outputTokensPerSecond).toBe(54.3);
    expect(model?.outputTokensPerTask).toBe(104940);
  });

  it("keeps Qwen3.8 Max's task size when live speed figures arrive", () => {
    const next = applyBenchmarkFeed(
      MODEL_BENCHMARKS,
      feed([
        row("qwen3-8-max", {
          name: "Qwen3.8 Max (0902)",
          intelligenceIndex: 34,
          outputTokensPerSecond: 80,
        }),
      ]),
    );
    const model = benchmarkFor("qwen3.8-max", benchmarksAtEffort(next, "xhigh"));
    expect(model?.outputTokensPerSecond).toBe(80);
    expect(model?.outputTokensPerTask).toBe(170794);
  });

  it("knows where most of its rows' live figures come from", () => {
    const slugs = benchmarkFeedSlugs(MODEL_BENCHMARKS);
    expect(slugs.has("claude-fable-5-2")).toBe(true);
    expect(slugs.has("gpt-6-1-sol-high")).toBe(true);
    expect(slugs.has("kimi-k3-1-pro")).toBe(true);
    expect(
      MODEL_BENCHMARKS.models.filter((model) => model.aaSlug !== undefined).length,
    ).toBeGreaterThan(15);
  });
});
