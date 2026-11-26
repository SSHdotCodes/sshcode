import { describe, expect, it } from "vite-plus/test";

import {
  benchmarkFor,
  benchmarksAtEffort,
  limitWindowApplies,
  NEAR_FREE_PER_M_OUTPUT_USD,
  normalizeModelId,
  pickBestModels,
  realCostForSameWork,
  realCostPerMOutput,
  type ModelPicksInput,
  type PickBenchmarks,
  type PickRoute,
} from "./modelPicks.ts";

const NOW = Date.UTC(2026, 10, 10, 12);
const DAY = 24 * 60 * 60 * 1000;

// Invented models: the picks must never depend on a real model's name.
const benchmarks: PickBenchmarks = {
  asOf: "2026-11-10",
  metrics: { index: { label: "Index" }, agent: { label: "Agent" } },
  models: [
    {
      id: "apex-2",
      label: "Apex 2",
      scores: { index: 80, agent: 60 },
      outputTokensPerSecond: 50,
      fastOutputTokensPerSecond: 140,
      price: { inputPerMTok: 8, outputPerMTok: 40, cachedInputPerMTok: 0.2 },
    },
    {
      id: "solid-1.5",
      label: "Solid 1.5",
      aliases: ["solid-latest"],
      scores: { index: 74, agent: 57 },
      outputTokensPerSecond: 90,
      price: { inputPerMTok: 2, outputPerMTok: 10, cachedInputPerMTok: 0.1 },
    },
    {
      id: "swift-mini",
      label: "Swift Mini",
      scores: { index: 62 },
      outputTokensPerSecond: 260,
      price: { inputPerMTok: 0.2, outputPerMTok: 1 },
    },
    { id: "tiny", label: "Tiny", scores: { index: 30 }, outputTokensPerSecond: 900 },
    { id: "home-flash", label: "Home Flash", scores: { index: 66 } },
  ],
};

function route(model: string, patch: Partial<PickRoute> = {}): PickRoute {
  return {
    model,
    routeLabel: "Cloud",
    instanceId: "cloud",
    local: false,
    costUsd: 0,
    costKnown: true,
    tokens: {
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    responses: 0,
    ...patch,
  };
}

const used = (
  model: string,
  costUsd: number,
  outputTokens: number,
  patch: Partial<PickRoute> = {},
) =>
  route(model, {
    costUsd,
    responses: 500,
    tokens: {
      uncachedInputTokens: outputTokens,
      cachedInputTokens: outputTokens * 40,
      cacheCreationTokens: outputTokens * 2,
      outputTokens,
      reasoningTokens: 0,
    },
    ...patch,
  });

function input(patch: Partial<ModelPicksInput>): ModelPicksInput {
  return { routes: [], grades: [], limits: [], benchmarks, now: NOW, ...patch };
}

describe("model ids", () => {
  it("drops harness prefixes, account suffixes and punctuation variants", () => {
    expect(normalizeModelId("openrouter/vendor/Apex-2.5")).toBe("apex-2-5");
    expect(normalizeModelId("solid-latest(openai)")).toBe("solid-latest");
    expect(normalizeModelId("cloud/apex-2@default")).toBe("apex-2");
    expect(normalizeModelId('["home","home-flash-1017"]')).toBe("home-flash-1017");
    expect(normalizeModelId("custom:relay:vendor/swift.mini")).toBe("swift-mini");
  });

  it("matches the longest benchmark name at word boundaries", () => {
    const table: PickBenchmarks = {
      ...benchmarks,
      models: [
        { id: "k3", label: "K3", scores: {} },
        { id: "k3.1-pro", label: "K3.1 Pro", scores: {} },
        { id: "deep-v4.1-flash", label: "Deep Flash", scores: {} },
      ],
    };
    expect(benchmarkFor("vendor/k3-256k", table)?.label).toBe("K3");
    expect(benchmarkFor("go/kimi-k3.1-pro", table)?.label).toBe("K3.1 Pro");
    // A quantization tag that happens to spell another model must not win.
    expect(benchmarkFor("home/deep-v4.1-flash-1017-k3-high", table)?.label).toBe("Deep Flash");
    expect(benchmarkFor("vendor/mk3x", table)).toBeUndefined();
    expect(benchmarkFor("solid-latest(openai)", benchmarks)?.label).toBe("Solid 1.5");
  });
});

describe("limit windows", () => {
  it.each([
    ["opencode/a", { modelIds: ["opencode/a"] }, true],
    ["opencode/b", { modelIds: ["opencode/a"] }, false],
    ["opencode/a", { modelIds: [] }, false],
    ["console-custom/a", { providerIds: ["opencode", "console-custom"] }, true],
    ["opencode-go/a", { providerIds: ["opencode", "console-custom"] }, false],
    ["anthropic/a", { providerIds: ["opencode"] }, false],
    ["opencode/a", { providerIds: [] }, false],
    ["opencode/a", { modelIds: ["opencode/a"], providerIds: ["other"] }, false],
  ] as const)("matches explicit coverage for %s: %j", (model, coverage, applies) => {
    expect(limitWindowApplies("budget_opaque-id", model, coverage)).toBe(applies);
  });

  it("keeps exhausted Console budgets off unrelated model picks", () => {
    const { candidates } = pickBestModels(
      input({
        routes: [
          route("opencode/apex-2", { instanceId: "one" }),
          route("opencode/solid-1.5", { instanceId: "one" }),
          route("anthropic/swift-mini", { instanceId: "one" }),
        ],
        limits: [
          {
            instanceId: "one",
            id: "budget_opaque-id",
            label: "Console",
            kind: "other",
            usedPercent: 100,
            modelIds: ["opencode/apex-2"],
          },
        ],
      }),
    );
    expect(candidates.find((c) => c.label === "Apex 2")?.limit?.remainingPercent).toBe(0);
    expect(candidates.find((c) => c.label === "Solid 1.5")?.limit).toBeUndefined();
    expect(candidates.find((c) => c.label === "Swift Mini")?.limit).toBeUndefined();
  });

  it("applies a model-line window only to that line", () => {
    expect(limitWindowApplies("seven_day", "vendor-apex-2")).toBe(true);
    expect(limitWindowApplies("seven_day_apex", "vendor-apex-2")).toBe(true);
    expect(limitWindowApplies("seven_day_apex", "vendor-solid-1-5")).toBe(false);
    expect(limitWindowApplies("primary", "anything")).toBe(true);
    expect(limitWindowApplies("go_weekly", "cloud-go/solid-1.5")).toBe(true);
    expect(limitWindowApplies("go_weekly", "cloud/solid-1.5")).toBe(false);
  });
});

describe("pickBestModels", () => {
  it("ranks quality from benchmarks against the best model", () => {
    const { picks, candidates } = pickBestModels(
      input({ routes: [route("apex-2"), route("solid-1.5"), route("swift-mini")] }),
    );
    expect(picks.quality.winner?.label).toBe("Apex 2");
    expect(picks.quality.winner?.quality).toBe(100);
    // Between its two scores as shares of the best: 74/80 and 57/60.
    const solid = candidates.find((c) => c.key === "solid-1-5")!.quality!;
    expect(solid).toBeGreaterThan(92.5);
    expect(solid).toBeLessThan(95);
    expect(picks.quality.winner?.headlineBenchmark).toEqual({ label: "Index", value: 80 });
    expect(picks.quality.winner?.used).toBe(false);
  });

  it("gives a benchmark every model aces almost no say", () => {
    const table: PickBenchmarks = {
      asOf: "2026-11-10",
      metrics: { hard: { label: "Hard" }, easy: { label: "Easy" } },
      models: [
        { id: "strong", label: "Strong", scores: { hard: 80, easy: 96 } },
        { id: "middle", label: "Middle", scores: { hard: 60, easy: 97 } },
        { id: "weak", label: "Weak", scores: { hard: 30, easy: 98 } },
      ],
    };
    const { candidates } = pickBestModels(
      input({ benchmarks: table, routes: [route("strong"), route("middle"), route("weak")] }),
    );
    const quality = (key: string) => candidates.find((c) => c.key === key)!.quality!;
    expect(quality("strong")).toBe(100);
    // A plain average would put Weak at 69: the saturated benchmark must not lift it.
    expect(quality("weak")).toBeLessThan(45);
    expect(quality("middle")).toBeLessThan(80);
  });

  it("lets enough of the user's own grades overturn a close benchmark call", () => {
    const routes = [route("apex-2"), route("solid-1.5"), route("swift-mini")];
    const few = pickBestModels(
      input({
        routes,
        grades: [
          { instanceId: "cloud", model: "apex-2", runs: 2, rated: 2, average: 4, completed: 2 },
          {
            instanceId: "cloud",
            model: "solid-1.5",
            runs: 2,
            rated: 2,
            average: 9.5,
            completed: 2,
          },
        ],
      }),
    );
    // Two grades each are a hint, not a verdict.
    expect(few.picks.quality.winner?.label).toBe("Apex 2");

    const many = pickBestModels(
      input({
        routes,
        grades: [
          { instanceId: "cloud", model: "apex-2", runs: 40, rated: 40, average: 6, completed: 40 },
          {
            instanceId: "cloud",
            model: "solid-1.5",
            runs: 60,
            rated: 60,
            average: 9.4,
            completed: 60,
          },
          {
            instanceId: "cloud",
            model: "swift-mini",
            runs: 20,
            rated: 20,
            average: 7,
            completed: 20,
          },
        ],
      }),
    );
    expect(many.picks.quality.winner?.label).toBe("Solid 1.5");
    expect(many.gradedRuns).toBe(120);
    expect(many.picks.quality.winner?.grade).toEqual({ average: 9.4, rated: 60, runs: 60 });
  });

  it("scores a graded model that has no public benchmark", () => {
    const { candidates } = pickBestModels(
      input({
        routes: [
          route("apex-2"),
          route("solid-1.5"),
          route("preview-x", { modelLabel: "Preview X" }),
        ],
        grades: [
          {
            instanceId: "cloud",
            model: "solid-1.5",
            runs: 50,
            rated: 50,
            average: 8.5,
            completed: 50,
          },
          {
            instanceId: "cloud",
            model: "preview-x",
            runs: 20,
            rated: 20,
            average: 8.5,
            completed: 20,
          },
        ],
      }),
    );
    const preview = candidates.find((c) => c.key === "preview-x")!;
    const solid = candidates.find((c) => c.key === "solid-1-5")!;
    expect(preview.label).toBe("Preview X");
    // The same grade as a benchmarked model reads as that model's quality.
    expect(preview.quality).toBeCloseTo(solid.quality!, 5);
    expect(preview.benchmarkQuality).toBeUndefined();
  });

  it("picks value as quality per dollar among models near the best", () => {
    const { picks } = pickBestModels(
      input({
        routes: [
          used("apex-2", 400, 4_000_000),
          used("solid-1.5", 90, 3_000_000),
          route("swift-mini"),
          route("tiny"),
        ],
      }),
    );
    // Swift Mini is cheaper still but below 85% of the best.
    expect(picks.value.winner?.label).toBe("Solid 1.5");
    expect(picks.value.winner?.costPerMOutput).toBeCloseTo(30, 5);
    expect(picks.value.winner?.costBasis).toBe("yours");
    expect(picks.value.ranked.map((c) => c.label)).toEqual(["Solid 1.5", "Apex 2"]);
  });

  it("prices an unused model from list rates at the user's own token mix", () => {
    const { candidates } = pickBestModels(
      input({ routes: [used("apex-2", 400, 4_000_000), route("solid-1.5")] }),
    );
    const solid = candidates.find((c) => c.key === "solid-1-5")!;
    // Mix per output token: 1 input, 40 cached, 2 written (at the input rate), 1 output.
    expect(solid.costPerMOutput).toBeCloseTo(1 * 2 + 40 * 0.1 + 2 * 2 + 10, 5);
    expect(solid.costBasis).toBe("list");
  });

  it("prefers speed measured in the user's responses, fast mode included", () => {
    const { picks } = pickBestModels(
      input({
        routes: [
          used("apex-2", 400, 4_000_000, {
            timing: { outputTokens: 900_000, seconds: 20_000, responses: 900 },
            fastTiming: { outputTokens: 600_000, seconds: 3_000, responses: 400 },
          }),
          used("solid-1.5", 90, 3_000_000, {
            // Too few responses to trust: the public figure stands in.
            timing: { outputTokens: 5_000, seconds: 10, responses: 4 },
          }),
          route("tiny"),
        ],
      }),
    );
    expect(picks.speed.winner?.label).toBe("Apex 2");
    expect(picks.speed.winner?.speed).toEqual({
      tokensPerSecond: 200,
      basis: "yours",
      fast: true,
      responses: 400,
    });
    expect(picks.speed.ranked[1]?.speed).toEqual({
      tokensPerSecond: 90,
      basis: "public",
      fast: false,
    });
    // Tiny is far faster on paper but nowhere near good enough.
    expect(picks.speed.ranked.some((c) => c.label === "Tiny")).toBe(false);
  });

  it("does not transfer a measured speed to a different route", () => {
    const recorded = used("apex-2", 100, 1_000_000, {
      instanceId: "cloud",
      timing: { outputTokens: 100_000, seconds: 500, responses: 100 },
    });
    const local = route("apex-2", { instanceId: "local", local: true });
    const result = pickBestModels(input({ routes: [recorded, local], canStart: (r) => r.local }));
    expect(result.picks.quality.winner?.route).toBe(local);
    expect(result.picks.speed.winner).toBeNull();
  });

  it("ranks speed by how soon the same work is done, not by tokens per second", () => {
    const table: PickBenchmarks = {
      ...benchmarks,
      models: [
        // Writes fastest of the three, but spends six times the tokens on the same tasks.
        {
          id: "gusher",
          label: "Gusher",
          scores: { index: 70 },
          outputTokensPerSecond: 240,
          outputTokensPerTask: 240_000,
        },
        {
          id: "terse",
          label: "Terse",
          scores: { index: 72 },
          outputTokensPerSecond: 60,
          outputTokensPerTask: 30_000,
        },
        {
          id: "apex-2",
          label: "Apex 2",
          scores: { index: 80 },
          outputTokensPerSecond: 100,
          outputTokensPerTask: 160_000,
        },
        // Nobody published its token use: it cannot be placed, so it follows.
        { id: "mystery", label: "Mystery", scores: { index: 75 }, outputTokensPerSecond: 900 },
      ],
    };
    const { picks } = pickBestModels(
      input({
        benchmarks: table,
        routes: [route("gusher"), route("terse"), route("apex-2"), route("mystery")],
      }),
    );
    expect(picks.speed.ranked.map((c) => c.label)).toEqual([
      "Terse",
      "Gusher",
      "Apex 2",
      "Mystery",
    ]);
    expect(picks.speed.winner?.speed).toMatchObject({
      tokensPerSecond: 60,
      tokensPerTask: 30_000,
      secondsPerTask: 500,
    });
    expect(picks.speed.ranked[3]?.speed?.secondsPerTask).toBeUndefined();
  });

  it("uses the speed the user measured for the time a task takes", () => {
    const table: PickBenchmarks = {
      ...benchmarks,
      models: [
        {
          id: "apex-2",
          label: "Apex 2",
          scores: { index: 80 },
          outputTokensPerSecond: 50,
          outputTokensPerTask: 100_000,
        },
      ],
    };
    const timing = { outputTokens: 400_000, seconds: 2000, responses: 300 };
    const { picks } = pickBestModels(
      input({ benchmarks: table, routes: [route("apex-2", { timing })] }),
    );
    expect(picks.speed.winner?.speed).toMatchObject({
      tokensPerSecond: 200,
      basis: "yours",
      secondsPerTask: 500,
    });
  });

  it("judges value by what the same work costs, not the price per token", () => {
    const perTask = (apex: number, solid: number): PickBenchmarks => ({
      ...benchmarks,
      models: benchmarks.models.map((row) =>
        row.id === "apex-2"
          ? { ...row, outputTokensPerTask: apex }
          : row.id === "solid-1.5"
            ? { ...row, outputTokensPerTask: solid }
            : row,
      ),
    });
    const routes = [route("apex-2"), route("solid-1.5")];
    // Equal tokens for the same tasks: the cheaper tokens win.
    const even = pickBestModels(input({ benchmarks: perTask(100_000, 100_000), routes }));
    expect(even.picks.value.winner?.label).toBe("Solid 1.5");
    // Solid's tokens cost a quarter as much, but it spends five times as many.
    const wordy = pickBestModels(input({ benchmarks: perTask(100_000, 500_000), routes }));
    expect(wordy.picks.value.winner?.label).toBe("Apex 2");
    const apex = wordy.candidates.find((c) => c.label === "Apex 2")!;
    const solid = wordy.candidates.find((c) => c.label === "Solid 1.5")!;
    expect(solid.tokensForSameWork! / apex.tokensForSameWork!).toBeCloseTo(5, 5);
    expect(realCostPerMOutput(solid)!).toBeLessThan(realCostPerMOutput(apex)!);
    expect(realCostForSameWork(solid)!).toBeGreaterThan(realCostForSameWork(apex)!);
    // A model with no task figure counts as typical.
    const tiny = wordy.candidates.find((c) => c.label === "Tiny");
    expect(tiny?.tokensForSameWork).toBeUndefined();
  });

  it("picks the better model for low cost when both are close to free", () => {
    const table: PickBenchmarks = {
      ...benchmarks,
      models: [
        ...benchmarks.models,
        { id: "home-small", label: "Home Small", scores: { index: 20 }, outputTokensPerSecond: 40 },
      ],
    };
    const weekStart = NOW - 3 * DAY;
    const routes = [
      // The account paid $20 for 300M output tokens.
      used("swift-mini", 300, 300_000_000, { instanceId: "plan", routeLabel: "Plan" }),
      used("home-small", 0, 2_000_000, { local: true, instanceId: "home", routeLabel: "Home" }),
    ];
    const { picks } = pickBestModels(
      input({
        benchmarks: table,
        routes,
        limits: [
          {
            instanceId: "plan",
            id: "weekly",
            label: "Weekly",
            kind: "weekly",
            usedPercent: 5,
            resetsAtMs: weekStart + 7 * DAY,
            durationMs: 7 * DAY,
          },
        ],
        plans: [{ instanceId: "plan", label: "Plan", monthlyUsd: 20 }],
        usageSince: (since) => (since === weekStart ? routes : []),
      }),
    );
    const swift = picks.frugal.ranked.find((c) => c.label === "Swift Mini")!;
    expect(realCostPerMOutput(swift)).toBeGreaterThan(0);
    expect(realCostPerMOutput(swift)).toBeLessThanOrEqual(NEAR_FREE_PER_M_OUTPUT_USD);
    // Free but far weaker loses to a few cents for a much better model.
    expect(picks.frugal.ranked.map((c) => c.label)).toEqual(["Swift Mini", "Home Small"]);
  });

  it("applies the ten-cent budget to output price even when task sizes differ", () => {
    const result = pickBestModels(
      input({
        benchmarks: {
          ...benchmarks,
          models: [
            { id: "big", label: "Big", scores: { index: 80 }, outputTokensPerTask: 500_000 },
            { id: "small", label: "Small", scores: { index: 90 }, outputTokensPerTask: 5_000 },
            { id: "free", label: "Free", scores: { index: 70 }, outputTokensPerTask: 5_000 },
          ],
        },
        routes: [
          used("big", 0.09, 1_000_000),
          used("small", 0.11, 1_000_000),
          route("free", { local: true }),
        ],
      }),
    );
    expect(result.picks.frugal.ranked.map((c) => c.key)).toEqual(["big", "free", "small"]);
  });

  it("ranks genuinely free work ahead of inexpensive paid work without rounding away sub-cent differences", () => {
    const result = pickBestModels(
      input({
        routes: [
          used("apex-2", 0.005, 1_000_000),
          used("solid-1.5", 0, 1_000_000, { local: true }),
        ],
      }),
    );
    expect(result.picks.value.winner?.key).toBe("solid-1-5");
  });

  it("keeps a public throughput reading without borrowing a task length from a different effort", () => {
    const table = benchmarksAtEffort(
      {
        ...benchmarks,
        models: [
          {
            id: "test",
            label: "Test",
            scores: { index: 60 },
            efforts: {
              xhigh: { outputTokensPerSecond: 200 },
              max: { outputTokensPerSecond: 90, outputTokensPerTask: 30_000 },
            },
          },
        ],
      },
      "xhigh",
    );
    const result = pickBestModels(input({ routes: [route("test")], benchmarks: table }));
    expect(result.picks.speed.winner?.speed?.tokensPerSecond).toBe(200);
    expect(result.picks.speed.winner?.speed?.secondsPerTask).toBeUndefined();
  });

  it("puts the faster of two equally good free models first", () => {
    const table: PickBenchmarks = {
      ...benchmarks,
      models: [
        { id: "home-slow", label: "Home Slow", scores: { index: 40 } },
        { id: "home-quick", label: "Home Quick", scores: { index: 40 } },
      ],
    };
    // A local model's speed is the one timed on the user's own GPU.
    const timed = (seconds: number) => ({ responses: 100, outputTokens: 90_000, seconds });
    const { picks } = pickBestModels(
      input({
        benchmarks: table,
        routes: [
          used("home-slow", 0, 90_000, { local: true, instanceId: "home", timing: timed(2250) }),
          used("home-quick", 0, 90_000, { local: true, instanceId: "home", timing: timed(1000) }),
        ],
      }),
    );
    expect(picks.frugal.ranked.map((c) => c.label)).toEqual(["Home Quick", "Home Slow"]);
  });

  it("counts a model your own GPU serves as free even when a paid route is busier", () => {
    const { picks, candidates } = pickBestModels(
      input({
        routes: [
          used("solid-1.5", 90, 3_000_000),
          route("solid-1.5", { local: true, instanceId: "home", routeLabel: "Home" }),
          used("apex-2", 400, 4_000_000),
        ],
      }),
    );
    expect(picks.frugal.winner).toMatchObject({
      label: "Solid 1.5",
      billing: "local",
      costPerMOutput: 0,
    });
    expect(picks.frugal.winner?.route.routeLabel).toBe("Home");
    // Everywhere else it still stands on the route it is run on most.
    expect(candidates.find((c) => c.label === "Solid 1.5")?.billing).toBe("metered");
  });

  it("makes the cheapest model the low-cost pick when nothing is close to free", () => {
    const table: PickBenchmarks = {
      ...benchmarks,
      models: benchmarks.models.map((row) =>
        row.id === "tiny" ? { ...row, price: { inputPerMTok: 0.05, outputPerMTok: 0.2 } } : row,
      ),
    };
    const { picks } = pickBestModels(
      input({
        benchmarks: table,
        routes: [used("apex-2", 400, 4_000_000), used("solid-1.5", 90, 3_000_000), route("tiny")],
      }),
    );
    expect(picks.frugal.ranked.map((c) => c.label)).toEqual(["Tiny", "Solid 1.5", "Apex 2"]);
    // Cheap is not the same as good value: Tiny is nowhere near the best.
    expect(picks.value.ranked.some((c) => c.label === "Tiny")).toBe(false);
    expect(picks.frugal.winner?.quality).toBeLessThan(50);
  });

  it("lists a free local model first, and one without evidence after one with it", () => {
    const { picks } = pickBestModels(
      input({
        routes: [
          used("apex-2", 400, 4_000_000),
          used("home-new", 0, 500_000, { local: true, instanceId: "home", modelLabel: "Home New" }),
          route("home-flash", { local: true, instanceId: "home" }),
          // In the catalog but never run, and nothing known about it.
          route("home-idle", { local: true, instanceId: "home" }),
          // Not local and nothing known about it: no basis to recommend it.
          used("mystery", 1, 5_000_000),
        ],
      }),
    );
    expect(picks.frugal.ranked.map((c) => c.label)).toEqual(["Home Flash", "Home New", "Apex 2"]);
    expect(picks.frugal.ranked[1]?.quality).toBeUndefined();
  });

  it("puts a local model first for low cost", () => {
    const { picks } = pickBestModels(
      input({
        routes: [
          used("apex-2", 400, 4_000_000),
          route("home-flash", { local: true, instanceId: "home", routeLabel: "Home" }),
        ],
        limits: [
          { instanceId: "cloud", id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 20 },
        ],
      }),
    );
    expect(picks.frugal.winner?.label).toBe("Home Flash");
    expect(picks.frugal.winner?.billing).toBe("local");
    expect(picks.frugal.winner?.costPerMOutput).toBe(0);
    expect(picks.frugal.winner?.speed).toBeUndefined();
  });

  it("works out what a limit has left and how fast a model uses it", () => {
    const weekStart = NOW - 3 * DAY;
    const routes = [
      used("apex-2", 400, 4_000_000, { instanceId: "one", routeLabel: "One" }),
      used("solid-1.5", 90, 3_000_000, { instanceId: "two", routeLabel: "Two" }),
    ];
    const { picks } = pickBestModels(
      input({
        routes,
        limits: [
          {
            instanceId: "one",
            id: "seven_day",
            label: "Weekly",
            kind: "weekly",
            usedPercent: 20,
            resetsAtMs: weekStart + 7 * DAY,
            durationMs: 7 * DAY,
          },
          {
            instanceId: "one",
            id: "seven_day_apex",
            label: "Weekly · Apex",
            kind: "weekly",
            usedPercent: 80,
            resetsAtMs: weekStart + 7 * DAY,
            durationMs: 7 * DAY,
          },
          {
            instanceId: "two",
            id: "primary",
            label: "Weekly",
            kind: "weekly",
            usedPercent: 50,
            resetsAtMs: weekStart + 7 * DAY,
          },
        ],
        usageSince: (since) => (since === weekStart ? routes : []),
      }),
    );
    const apex = picks.frugal.ranked.find((c) => c.label === "Apex 2")!;
    const solid = picks.frugal.ranked.find((c) => c.label === "Solid 1.5")!;
    // The model-line window is the tight one: $400 bought 80%, so 20% is $100.
    expect(apex.limit).toMatchObject({ label: "Weekly · Apex", remainingPercent: 20 });
    expect(apex.limit?.remainingUsd).toBeCloseTo(100, 5);
    expect(apex.limit?.remainingMOutput).toBeCloseTo(1, 5);
    // $90 bought 50%, so $90 is left, at $30 per million output tokens.
    expect(solid.limit?.remainingUsd).toBeCloseTo(90, 5);
    expect(solid.limit?.remainingMOutput).toBeCloseTo(3, 5);
    // One percent of Apex's tight limit is $5, and a million output tokens cost $100.
    expect(apex.limit?.percentPerMOutput).toBeCloseTo(20, 5);
    expect(solid.limit?.percentPerMOutput).toBeCloseTo(30 / 1.8, 5);
    expect(picks.frugal.winner?.label).toBe("Solid 1.5");
    expect(picks.frugal.winner?.billing).toBe("subscription");
  });

  it("quotes consumption for the named limit when another window has fewer dollars left", () => {
    const routes = [used("apex-2", 800, 8_000_000)];
    const result = pickBestModels(
      input({
        routes,
        limits: [
          {
            instanceId: "cloud",
            id: "weekly",
            label: "Weekly",
            kind: "weekly",
            usedPercent: 80,
            dailyRise: [{ day: "week", percent: 80 }],
          },
          {
            instanceId: "cloud",
            id: "session",
            label: "Session",
            kind: "session",
            usedPercent: 50,
            dailyRise: [{ day: "today", percent: 50 }],
          },
        ],
        usageSinceDay: (day) => (day === "week" ? routes : [used("apex-2", 50, 500_000)]),
      }),
    );
    expect(result.picks.quality.winner?.limit).toMatchObject({
      label: "Weekly",
      remainingPercent: 20,
      remainingUsd: 50,
      percentPerMOutput: 10,
    });
  });

  it("allocates only the destination account's fee, including priced work outside the candidate list", () => {
    const one = used("apex-2", 400, 4_000_000, { instanceId: "one" });
    const two = used("apex-2", 50, 50_000, { instanceId: "two" });
    const result = pickBestModels(
      input({
        routes: [one, two],
        usage: [one, two, used("retired", 150, 750_000, { instanceId: "two" })],
        plans: [{ instanceId: "two", label: "Two", monthlyUsd: 100 }],
        startsOn: () => ({ instanceId: "two" }),
      }),
    );
    // One quarter of Two's $100 belongs to this model, for 50k actual output.
    expect(result.picks.value.winner).toMatchObject({
      route: { instanceId: "two" },
      plan: { usedUsd: 200 },
      paidPerMOutput: 500,
    });
  });

  it("allocates a gateway fee only to identifiable plan traffic, pooling priced work across machines", () => {
    const account = { instanceId: "gateway", accountKey: "one-plan" };
    const apex = used("go/apex-2", 40, 100_000, { ...account, environmentId: "one" });
    const elsewhere = used("api/solid-1.5", 500, 100_000, account);
    const ambiguous = used("swift-mini", 100, 100_000, account);
    const result = pickBestModels(
      input({
        routes: [apex, elsewhere, ambiguous],
        usage: [
          apex,
          elsewhere,
          ambiguous,
          used("go/apex-2", 20, 100_000, { ...account, environmentId: "two" }),
          used("go/old", 140, 100_000, { ...account, costKnown: false, unpricedTokens: 300 }),
        ],
        plans: [{ ...account, label: "Go", monthlyUsd: 10, providerIds: ["go"] }],
      }),
    );
    expect(result.plans[0]).toMatchObject({ usedUsd: 200, unpricedTokens: 300 });
    expect(result.candidates.find((c) => c.route === apex)?.paidPerMOutput).toBe(15);
    expect(result.candidates.find((c) => c.route === elsewhere)).toMatchObject({
      billing: "metered",
      paidPerMOutput: 5000,
    });
    expect(result.candidates.find((c) => c.route === ambiguous)?.paidPerMOutput).toBeUndefined();
  });

  it("skips a subscription that is nearly out", () => {
    const { picks } = pickBestModels(
      input({
        routes: [
          used("apex-2", 400, 4_000_000, { instanceId: "one" }),
          used("solid-1.5", 90, 3_000_000, { instanceId: "two" }),
          used("swift-mini", 3, 2_000_000, { instanceId: "three" }),
        ],
        limits: [
          { instanceId: "one", id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 95 },
          { instanceId: "two", id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 40 },
          {
            instanceId: "three",
            id: "weekly",
            label: "Weekly",
            kind: "weekly",
            usedPercent: 10,
            limited: true,
          },
        ],
      }),
    );
    expect(picks.frugal.ranked.map((c) => c.label)).toEqual(["Solid 1.5"]);
    expect(picks.frugal.winner?.limit?.remainingUsd).toBeUndefined();
  });

  it("ranks low cost by cost alone, across subscriptions and pay-per-token", () => {
    const { picks } = pickBestModels(
      input({
        routes: [
          used("apex-2", 400, 4_000_000, { instanceId: "metered-a" }),
          used("solid-1.5", 90, 3_000_000, { instanceId: "metered-b" }),
          used("swift-mini", 3, 2_000_000, { instanceId: "plan" }),
        ],
        limits: [
          { instanceId: "plan", id: "weekly", label: "Weekly", kind: "weekly", usedPercent: 60 },
        ],
      }),
    );
    expect(picks.frugal.ranked.map((c) => [c.label, c.billing])).toEqual([
      ["Swift Mini", "subscription"],
      ["Solid 1.5", "metered"],
      ["Apex 2", "metered"],
    ]);
  });

  describe("plans", () => {
    const MONTH = 30.4375 * DAY;
    const weekStart = NOW - 3 * DAY;
    const weekly = (instanceId: string, id: string, usedPercent: number) => ({
      instanceId,
      id,
      label: id === "seven_day" ? "Weekly" : "Weekly · Apex",
      kind: "weekly" as const,
      usedPercent,
      resetsAtMs: weekStart + 7 * DAY,
      durationMs: 7 * DAY,
    });

    describe("when the server counts how far a limit rose each day", () => {
      const counted = (
        usedPercent: number,
        dailyRise: ReadonlyArray<{ day: string; percent: number }>,
      ) => ({ ...weekly("plan", "seven_day", usedPercent), dailyRise });
      const month = [used("apex-2", 3000, 30_000_000, { instanceId: "plan", routeLabel: "Plan" })];
      // Of the month's work, $1,995 fell on the days the limit was seen rising.
      const sinceRise = [used("apex-2", 1995, 19_950_000, { instanceId: "plan" })];
      const planOf = (limit: ReturnType<typeof counted>) =>
        pickBestModels(
          input({
            routes: month,
            limits: [limit],
            // A guess from the window's start would see the whole month for the little used.
            usageSince: () => month,
            usageSinceDay: (day) => (day === "2026-11-08" ? sinceRise : []),
            plans: [{ instanceId: "plan", label: "Big Plan", monthlyUsd: 200 }],
          }),
        ).plans[0];

      it("prices a percent by those days' work, however often the counter was reset", () => {
        // The week reads 3% used, yet the counter rose 133 points over two days.
        const plan = planOf(
          counted(3, [
            { day: "2026-11-09", percent: 58 },
            { day: "2026-11-08", percent: 75 },
          ]),
        );
        // $1,995 for 133 points: $15 a point, $1,500 a week.
        expect(plan).toMatchObject({ capacityBasis: "limit" });
        expect(plan?.monthlyCapacityUsd).toBeCloseTo(1500 * (MONTH / (7 * DAY)), 5);
      });

      it("never guesses from the window's start instead", () => {
        // 20% used and a month of work would read as $150 a point.
        expect(planOf(counted(20, []))?.monthlyCapacityUsd).toBeUndefined();
      });

      it("waits until the rise is more than rounding", () => {
        expect(
          planOf(counted(4, [{ day: "2026-11-08", percent: 4 }]))?.monthlyCapacityUsd,
        ).toBeUndefined();
      });
    });

    it("prices a plan's models by what the plan costs, not the API price", () => {
      const routes = [
        used("apex-2", 400, 4_000_000, { instanceId: "plan", routeLabel: "Plan" }),
        used("solid-1.5", 90, 3_000_000, { instanceId: "metered" }),
      ];
      const base = {
        routes,
        limits: [weekly("plan", "seven_day", 20)],
        usageSince: (since: number) => (since === weekStart ? routes : []),
      };
      // At API prices the cheaper model is the better deal.
      expect(pickBestModels(input(base)).picks.value.winner?.label).toBe("Solid 1.5");

      const result = pickBestModels(
        input({ ...base, plans: [{ instanceId: "plan", label: "Big Plan", monthlyUsd: 200 }] }),
      );
      const apex = result.candidates.find((c) => c.label === "Apex 2")!;
      const solid = result.candidates.find((c) => c.label === "Solid 1.5")!;
      // $400 bought 20% of a week: $2,000 a week, so about $8,696 a month for $200.
      const capacity = 2000 * (MONTH / (7 * DAY));
      expect(apex.plan).toMatchObject({ label: "Big Plan", monthlyUsd: 200, usedUsd: 400 });
      expect(apex.costPerMOutput).toBeCloseTo(100, 5);
      expect(apex.paidPerMOutput).toBeCloseTo(50, 5);
      expect(solid.paidPerMOutput).toBeCloseTo(30, 5);
      expect(solid.plan).toBeUndefined();
      expect(result.picks.value.winner?.label).toBe("Solid 1.5");
      expect(result.picks.frugal.winner?.label).toBe("Solid 1.5");
      expect(result.plans).toHaveLength(1);
      expect(result.plans[0]).toMatchObject({
        instanceId: "plan",
        label: "Big Plan",
        monthlyUsd: 200,
        usedUsd: 400,
        capacityBasis: "limit",
        hasLimits: true,
      });
      expect(result.plans[0]?.monthlyCapacityUsd).toBeCloseTo(capacity, 5);
    });

    it("allocates the whole fee once across models with different quota windows", () => {
      const routes = [
        used("apex-2", 400, 4_000_000, { instanceId: "plan" }),
        used("solid-1.5", 90, 3_000_000, { instanceId: "plan" }),
      ];
      const result = pickBestModels(
        input({
          routes,
          limits: [weekly("plan", "seven_day", 20), weekly("plan", "seven_day_apex", 80)],
          plans: [{ instanceId: "plan", label: "Big Plan", monthlyUsd: 200 }],
          usageSince: (since) => (since === weekStart ? routes : []),
        }),
      );
      const apex = result.candidates.find((c) => c.label === "Apex 2")!;
      const solid = result.candidates.find((c) => c.label === "Solid 1.5")!;
      // Both models allocate one $200 fee across the same $490 of recorded work.
      expect(apex.paidPerMOutput).toBeCloseTo((100 * 200) / 490);
      expect(solid.paidPerMOutput).toBeCloseTo((30 * 200) / 490);
      expect(apex.paidPerMOutput! * 4 + solid.paidPerMOutput! * 3).toBeCloseTo(200);
      // The plan as a whole is worth what its all-model limit allows.
      expect(result.plans[0]?.monthlyCapacityUsd).toBeCloseTo(2450 * (MONTH / (7 * DAY)), 5);
    });

    it("never counts a plan for less than the work it really did", () => {
      // 30 days of work, but the limit window opened today and reads low.
      const routes = [used("apex-2", 3000, 30_000_000, { instanceId: "plan" })];
      const today = [used("apex-2", 80, 800_000, { instanceId: "plan" })];
      const result = pickBestModels(
        input({
          routes,
          limits: [weekly("plan", "seven_day", 20)],
          plans: [{ instanceId: "plan", label: "Big Plan", monthlyUsd: 100 }],
          usageSince: (since) => (since === weekStart ? today : []),
        }),
      );
      const apex = result.candidates.find((c) => c.label === "Apex 2")!;
      // $80 for 20% reads as $400 a week, about $1,739 a month: less than the $3,000 done.
      expect(apex.plan).toMatchObject({ usedUsd: 3000 });
      expect(apex.paidPerMOutput).toBeCloseTo(100 / 30, 5);
      expect(result.plans[0]).toMatchObject({
        usedUsd: 3000,
        monthlyCapacityUsd: 3000,
        capacityBasis: "used",
      });
      expect(result.plans[0]?.limitMonthlyUsd).toBeCloseTo(400 * (MONTH / (7 * DAY)), 5);
    });

    it("takes a plan's own promise when no limit has been used enough to measure", () => {
      const routes = [used("swift-mini", 3, 2_000_000, { instanceId: "plan" })];
      const result = pickBestModels(
        input({
          routes,
          limits: [weekly("plan", "seven_day", 1)],
          plans: [
            { instanceId: "plan", label: "Small Plan", monthlyUsd: 10, includedMonthlyUsd: 60 },
          ],
          usageSince: () => routes,
        }),
      );
      const swift = result.candidates.find((c) => c.label === "Swift Mini")!;
      expect(swift.plan).toMatchObject({ usedUsd: 3 });
      expect(swift.paidPerMOutput).toBeCloseTo(5, 5);
      expect(result.plans[0]).toMatchObject({ monthlyCapacityUsd: 60, capacityBasis: "stated" });
    });

    it("does not read a month's worth out of a session window", () => {
      const routes = [used("apex-2", 400, 4_000_000, { instanceId: "plan" })];
      const result = pickBestModels(
        input({
          routes,
          limits: [
            {
              instanceId: "plan",
              id: "five_hour",
              label: "Session",
              kind: "session",
              usedPercent: 50,
              resetsAtMs: NOW + 60 * 60 * 1000,
              durationMs: 5 * 60 * 60 * 1000,
            },
          ],
          plans: [{ instanceId: "plan", label: "Big Plan", monthlyUsd: 100 }],
          usageSince: () => routes,
        }),
      );
      const apex = result.candidates.find((c) => c.label === "Apex 2")!;
      // What was done on it is all there is to go on: $400 for $100.
      expect(apex.plan).toMatchObject({ usedUsd: 400 });
      expect(apex.limit?.remainingPercent).toBe(50);
    });

    it("leaves the real cost unknown without a price, and ranks by the API price", () => {
      const routes = [used("apex-2", 400, 4_000_000, { instanceId: "plan" })];
      const result = pickBestModels(
        input({
          routes,
          limits: [weekly("plan", "seven_day", 20)],
          usageSince: () => routes,
        }),
      );
      const apex = result.candidates[0]!;
      expect(apex.paidPerMOutput).toBeUndefined();
      expect(apex.plan).toBeUndefined();
      expect(realCostPerMOutput(apex)).toBeCloseTo(100, 5);
      expect(apex.billing).toBe("subscription");
      // It still shows as something the user has, with its price to fill in.
      expect(result.plans[0]).toMatchObject({ instanceId: "plan", label: "Cloud", usedUsd: 400 });
      expect(result.plans[0]?.monthlyUsd).toBeUndefined();
    });

    it("counts a plan without limits as covering what was done on it, never less", () => {
      const plan = { instanceId: "plan", label: "Quiet Plan", monthlyUsd: 15 };
      const busy = pickBestModels(
        input({
          routes: [used("solid-1.5", 90, 3_000_000, { instanceId: "plan" })],
          plans: [plan],
        }),
      ).candidates[0]!;
      expect(busy.billing).toBe("subscription");
      expect(busy.plan).toMatchObject({ usedUsd: 90 });
      expect(busy.paidPerMOutput).toBeCloseTo(5, 5);

      // $3 of work on a $15 plan says nothing about what the plan allows.
      const idle = pickBestModels(
        input({
          routes: [used("swift-mini", 3, 2_000_000, { instanceId: "plan" })],
          plans: [plan],
        }),
      ).candidates[0]!;
      expect(idle.plan?.usedUsd).toBe(3);
      expect(realCostPerMOutput(idle)).toBeCloseTo(7.5, 5);
    });

    it("treats a free plan as costing nothing", () => {
      const result = pickBestModels(
        input({
          routes: [
            used("apex-2", 400, 4_000_000, { instanceId: "free" }),
            used("solid-1.5", 90, 3_000_000, { instanceId: "metered" }),
          ],
          plans: [{ instanceId: "free", label: "Preview", monthlyUsd: 0 }],
        }),
      );
      expect(result.candidates.find((c) => c.label === "Apex 2")?.paidPerMOutput).toBe(0);
      expect(result.picks.value.winner?.label).toBe("Apex 2");
    });
  });

  it("joins one model's routes and reports the most used one", () => {
    const { candidates } = pickBestModels(
      input({
        routes: [
          used("vendor/apex-2", 10, 200_000, { instanceId: "relay", routeLabel: "Relay" }),
          used("apex-2", 400, 4_000_000, { instanceId: "direct", routeLabel: "Direct" }),
        ],
        grades: [
          {
            instanceId: "relay",
            model: "vendor/apex-2",
            runs: 3,
            rated: 3,
            average: 9,
            completed: 3,
          },
          { instanceId: "direct", model: "apex-2", runs: 1, rated: 1, average: 7, completed: 1 },
        ],
      }),
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.route.routeLabel).toBe("Direct");
    expect(candidates[0]!.grade).toEqual({ average: 8.5, rated: 4, runs: 4 });
    expect(candidates[0]!.used).toBe(true);
  });

  it("reads benchmarks at the effort the user runs", () => {
    const table = {
      asOf: "2026-11-10",
      metrics: { index: { label: "Index" }, agent: { label: "Agent" } },
      models: [
        {
          id: "apex-2",
          label: "Apex 2",
          scores: { index: 80, agent: 60 },
          outputTokensPerSecond: 40,
          efforts: {
            max: { scores: { index: 80, agent: 60 }, outputTokensPerSecond: 40 },
            xhigh: { scores: { index: 70 }, outputTokensPerSecond: 55 },
            low: { scores: { index: 50 } },
          },
        },
        {
          id: "solid-1.5",
          label: "Solid 1.5",
          scores: { index: 74 },
          efforts: { high: { scores: { index: 72 } }, max: { scores: { index: 74 } } },
        },
        { id: "plain", label: "Plain", scores: { index: 60 }, outputTokensPerSecond: 90 },
        {
          id: "single",
          label: "Single",
          scores: {},
          efforts: { default: { scores: { index: 55 } } },
        },
      ],
    };
    const row = (effort: string | undefined, id: string) =>
      benchmarksAtEffort(table, effort).models.find((model) => model.id === id)!;

    // The effort asked for where it is published; the nearest one otherwise, lower first.
    expect(row("xhigh", "apex-2")).toMatchObject({
      scores: { index: 70, agent: 60 },
      scoreEfforts: { index: "xhigh", agent: "max" },
      outputTokensPerSecond: 55,
    });
    expect(row("XHigh", "solid-1.5")).toMatchObject({
      scores: { index: 72 },
      scoreEfforts: { index: "high" },
    });
    // Medium is one step from low and three from max: too far for max to stand in.
    expect(row("medium", "apex-2")).toMatchObject({
      scores: { index: 50 },
      scoreEfforts: { index: "low" },
    });
    expect(row("medium", "apex-2").scores).not.toHaveProperty("agent");
    // Of two equally close efforts the lower one is used.
    expect(row("xhigh", "solid-1.5").outputTokensPerSecond).toBeUndefined();
    // A row with no effort levels, and no effort to ask for, keep the headline figures.
    expect(row("xhigh", "plain")).toEqual(table.models[2]);
    expect(row(undefined, "apex-2").scores).toEqual({ index: 80, agent: 60 });
    expect(row(undefined, "apex-2")).not.toHaveProperty("efforts");
    expect(row("xhigh", "single").scoreEfforts).toEqual({ index: "default" });

    // At xhigh the order flips: Solid 1.5's 72 now beats Apex 2's 70 on the shared benchmark.
    const picksAt = (effort: string | undefined) =>
      pickBestModels(
        input({
          benchmarks: benchmarksAtEffort(
            {
              ...table,
              models: table.models.map(({ scores, ...rest }) => ({
                ...rest,
                scores: { index: scores.index ?? 0 },
              })),
            },
            effort,
          ),
          routes: [route("apex-2"), route("solid-1.5")],
        }),
      ).picks.quality;
    expect(picksAt(undefined).winner?.label).toBe("Apex 2");
    expect(picksAt("xhigh").ranked[0]?.headlineBenchmark).toEqual({
      label: "Index",
      value: 72,
      effort: "high",
    });
  });

  it("reads the tokens a task takes at the effort the user runs", () => {
    const table = benchmarksAtEffort(
      {
        ...benchmarks,
        models: [
          {
            id: "apex-2",
            label: "Apex 2",
            scores: { index: 80 },
            outputTokensPerTask: 270_000,
            efforts: {
              max: { outputTokensPerTask: 270_000 },
              xhigh: { outputTokensPerTask: 160_000 },
              low: { outputTokensPerTask: 35_000 },
            },
          },
          // Published without efforts: the one figure stands.
          {
            id: "solid-1.5",
            label: "Solid 1.5",
            scores: { index: 74 },
            outputTokensPerTask: 40_000,
          },
          // Only a far lower effort is published: nothing usable at xhigh.
          {
            id: "swift-mini",
            label: "Swift Mini",
            scores: { index: 62 },
            outputTokensPerTask: 9_000,
            efforts: { low: { outputTokensPerTask: 9_000 } },
          },
        ],
      },
      "xhigh",
    );
    expect(table.models.map((row) => row.outputTokensPerTask)).toEqual([
      160_000,
      40_000,
      undefined,
    ]);
  });

  it("returns no winners without any evidence", () => {
    const { picks, bestQuality } = pickBestModels(
      input({ routes: [route("mystery", { costKnown: false })] }),
    );
    expect(bestQuality).toBeNull();
    for (const kind of ["quality", "value", "speed", "frugal"] as const) {
      expect(picks[kind].winner).toBeNull();
      expect(picks[kind].ranked).toEqual([]);
    }
  });
});
