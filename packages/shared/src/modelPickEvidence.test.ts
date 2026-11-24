// @effect-diagnostics globalDate:off -- Fixed instants keep the fixtures the same in every zone.
import type { ServerProvider, SubagentRankingsSnapshot } from "@t3tools/contracts";
import type { ModelBenchmarkTable } from "./modelBenchmarks.ts";
import { pickBestModels } from "./modelPicks.ts";
import type { ModelTotals } from "./usageMerge.ts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildModelPicks,
  dayAt,
  describePick,
  describePlan,
  effortOfSelection,
  gradesFromSnapshots,
  limitsFromProviders,
  pickBarShare,
  pickRouteIcon,
  picksBasis,
  pickValueText,
  planPriceRows,
  plansFromProviders,
  routesFromCatalog,
  routesFromGrades,
  routesFromUsage,
} from "./modelPickEvidence.ts";

const NOW = Date.UTC(2026, 10, 10, 12);

// Invented models throughout: nothing here may depend on a real model's name.
const benchmarks: ModelBenchmarkTable = {
  asOf: "2026-11-10",
  metrics: { index: { label: "Index", version: "2", publisher: "Lab" } },
  models: [
    {
      id: "apex-2",
      label: "Apex 2",
      scores: { index: 80 },
      outputTokensPerSecond: 50,
      price: { inputPerMTok: 8, outputPerMTok: 40 },
    },
    {
      id: "solid-1",
      label: "Solid 1",
      scores: { index: 74 },
      outputTokensPerSecond: 90,
      price: { inputPerMTok: 2, outputPerMTok: 10 },
    },
    { id: "home-flash", label: "Home Flash", scores: { index: 66 } },
  ],
};

const model = (
  name: string,
  costUsd: number,
  outputTokens: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "codex",
  instanceId: "codex",
  costUsd,
  totalTokens: outputTokens * 40,
  tokens: {
    uncachedInputTokens: outputTokens,
    cachedInputTokens: outputTokens * 38,
    cacheCreationTokens: 0,
    outputTokens,
    reasoningTokens: 0,
  },
  records: 400,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 0,
  tokenShare: 0,
  ...overrides,
});

const label = (kind: string) => ({ codex: "Codex", opencode: "OpenCode" })[kind] ?? kind;

const provider = (instanceId: string, overrides: Record<string, unknown> = {}) =>
  ({
    instanceId,
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    auth: { status: "unknown" },
    models: [{ slug: "apex-2", name: "Apex Two", isCustom: false, capabilities: null }],
    ...overrides,
  }) as unknown as ServerProvider;

describe("routes", () => {
  it("builds one route per used model with its catalog name and price standing", () => {
    const routes = routesFromUsage(
      [model("apex-2", 400, 4_000_000), model("mystery", 0, 1_000_000, { unpricedRecords: 400 })],
      [provider("codex", { displayName: "Codex" })],
      label,
    );
    expect(routes[0]).toMatchObject({
      model: "apex-2",
      modelLabel: "Apex Two",
      routeLabel: "Codex",
      provider: "usage:codex",
      local: false,
      costKnown: true,
      responses: 400,
    });
    expect(routes[1]!.costKnown).toBe(false);
    expect(pickRouteIcon(routes[0]!)).toEqual({ usage: "codex" });
  });

  it("prorates a partial day", () => {
    const [route] = routesFromUsage([model("apex-2", 100, 1_000_000)], [], label, 0.25);
    expect(route!.costUsd).toBe(25);
    expect(route!.tokens.outputTokens).toBe(250_000);
  });

  it("adds graded models the usage window missed, on instances that still run", () => {
    const usage = routesFromUsage([model("apex-2", 400, 4_000_000)], [], label);
    const grades = [
      { instanceId: "codex", model: "apex-2", runs: 5, rated: 5, average: 9, completed: 5 },
      { instanceId: "codex", model: "solid-1", runs: 3, rated: 3, average: 8, completed: 3 },
      { instanceId: "gone", model: "solid-1", runs: 3, rated: 3, average: 8, completed: 3 },
      { instanceId: "off", model: "solid-1", runs: 3, rated: 3, average: 8, completed: 3 },
    ];
    const routes = routesFromGrades(
      grades,
      [provider("codex", { displayName: "Codex" }), provider("off", { enabled: false })],
      usage,
    );
    expect(routes).toHaveLength(1);
    expect(routes[0]).toMatchObject({
      model: "solid-1",
      instanceId: "codex",
      routeLabel: "Codex",
      provider: "driver:codex",
      costKnown: false,
      responses: 0,
    });
    expect(pickRouteIcon(routes[0]!)).toEqual({ driver: "codex" });
  });
});

describe("providers that cannot run work", () => {
  const broken: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["off", { enabled: false }],
    ["missing", { installed: false }],
    ["unavailable", { availability: "unavailable" }],
    ["signed-out", { auth: { status: "unauthenticated" } }],
    ["failing", { status: "error" }],
    // Its own check passes, but its last run ended signed out or out of credit
    // and nothing has worked since, however long ago that was.
    [
      "signed-out-run",
      {
        recentFailure: {
          kind: "authentication_error",
          message: "Signed out. Sign in again.",
          occurredAt: "2026-11-01T10:00:00.000Z",
          resetAt: "2026-11-01T11:00:00.000Z",
        },
      },
    ],
    [
      "out-of-credit",
      {
        recentFailure: {
          kind: "billing_error",
          outOfCredit: true,
          message: "Budget exhausted.",
          occurredAt: "2026-11-01T10:00:00.000Z",
        },
      },
    ],
  ];
  const models = [{ slug: "solid-1", name: "Solid", isCustom: false, capabilities: null }];
  const providers = [
    provider("codex", { models }),
    // A warning alone (not checked yet, sign-in unverified) still takes work.
    provider("unsure", { models, status: "warning" }),
    // So does one at its usage limit or with a passing provider error: neither
    // says anything lasting about the account.
    provider("limited", {
      models,
      recentFailure: {
        kind: "usage_limit",
        message: "You've hit your limit.",
        occurredAt: "2026-11-01T10:00:00.000Z",
        resetAt: "2999-01-01T00:00:00.000Z",
      },
    }),
    ...broken.map(([instanceId, overrides]) => provider(instanceId, { models, ...overrides })),
  ];
  const everywhere = ["codex", "unsure", "limited", ...broken.map(([instanceId]) => instanceId)];

  it("are no pick from the catalog", () => {
    expect(routesFromCatalog(providers, [], benchmarks).map((route) => route.instanceId)).toEqual([
      "codex",
      "unsure",
      "limited",
    ]);
  });

  it("are no pick from past usage, though usage outside the app still counts", () => {
    // Read from the provider's own logs: no app instance to check.
    const outside = model("solid-1", 10, 1_000_000);
    delete (outside as { instanceId?: string }).instanceId;
    const used = [
      ...everywhere.map((instanceId) => model("solid-1", 10, 1_000_000, { instanceId })),
      outside,
    ];
    expect(routesFromUsage(used, providers, label).map((route) => route.instanceId)).toEqual([
      "codex",
      "unsure",
      "limited",
      undefined,
    ]);
  });

  it("are no pick from graded subagent runs", () => {
    const grades = everywhere.map((instanceId) => ({
      instanceId,
      model: "solid-1",
      runs: 3,
      rated: 3,
      average: 8,
      completed: 3,
    }));
    expect(routesFromGrades(grades, providers, []).map((route) => route.instanceId)).toEqual([
      "codex",
      "unsure",
      "limited",
    ]);
  });
});

describe("catalog", () => {
  it("adds benchmarked models from connected providers, most likely route first", () => {
    const models = (...slugs: string[]) =>
      slugs.map((slug) => ({
        slug,
        name: slug.toUpperCase(),
        isCustom: false,
        capabilities: null,
      }));
    const usage = routesFromUsage([model("apex-2", 400, 4_000_000)], [], label);
    const routes = routesFromCatalog(
      [
        provider("metered", { models: models("solid-1", "unknown-model") }),
        provider("codex", {
          models: [...models("apex-2", "solid-1"), { ...models("apex-2-old")[0], isLegacy: true }],
          usageLimits: {
            checkedAt: "x",
            windows: [{ id: "w", kind: "weekly", label: "W", usedPercent: 1 }],
          },
        }),
        provider("off", { enabled: false, models: models("solid-1") }),
        provider("missing", { installed: false, models: models("solid-1") }),
        // An aggregator lists everything; that is not the same as being able to run it.
        provider("aggregator", {
          models: Array.from({ length: 80 }, (_, index) => models(`solid-1-v${index}`)[0]),
        }),
      ],
      usage,
      benchmarks,
    );
    expect(routes.map((route) => [route.instanceId, route.model, route.local])).toEqual([
      ["codex", "solid-1", false],
      ["metered", "solid-1", false],
    ]);
    expect(routes[0]).toMatchObject({ modelLabel: "SOLID-1", provider: "driver:codex" });
    expect(routes[0]).not.toHaveProperty("order");
  });
});

describe("evidence", () => {
  it("reads grades only from snapshots that carry figures", () => {
    const snapshot = {
      models: [
        {
          instanceId: "codex",
          model: "apex-2",
          family: "apex",
          yourRuns: "",
          byKind: [],
          stats: { runs: 4, rated: 3, average: 8.5, completed: 4 },
        },
        { instanceId: "codex", model: "old-server", family: "x", yourRuns: "", byKind: [] },
        {
          instanceId: "codex",
          model: "ungraded",
          family: "x",
          yourRuns: "",
          byKind: [],
          stats: { runs: 2, rated: 0, completed: 2 },
        },
      ],
      thumbs: [],
    } as unknown as SubagentRankingsSnapshot;
    expect(gradesFromSnapshots([snapshot, null])).toEqual([
      { instanceId: "codex", model: "apex-2", runs: 4, rated: 3, average: 8.5, completed: 4 },
      { instanceId: "codex", model: "ungraded", runs: 2, rated: 0, completed: 2 },
    ]);
  });

  it("turns provider limit windows into instants and durations", () => {
    const limits = limitsFromProviders([
      provider("codex", {
        usageLimits: {
          checkedAt: "2026-11-10T12:00:00.000Z",
          windows: [
            {
              id: "primary",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 19,
              resetsAt: "2026-11-17T06:00:00.000Z",
              windowDurationMins: 10080,
            },
            {
              id: "other",
              kind: "weekly",
              label: "Other",
              usedPercent: 5,
              modelIds: ["opencode/a"],
              providerIds: ["opencode"],
              dailyRise: [{ day: "2026-11-09", percent: 12 }],
            },
          ],
        },
      }),
      provider("api", {
        usageLimits: { checkedAt: "x", windows: [], unavailable: { reason: "unsupported" } },
      }),
      provider("off", {
        enabled: false,
        usageLimits: {
          checkedAt: "x",
          windows: [{ id: "w", kind: "weekly", label: "W", usedPercent: 1 }],
        },
      }),
    ]);
    expect(limits).toEqual([
      {
        instanceId: "codex",
        id: "primary",
        label: "Weekly",
        kind: "weekly",
        usedPercent: 19,
        resetsAtMs: Date.UTC(2026, 10, 17, 6),
        durationMs: 7 * 24 * 60 * 60 * 1000,
      },
      {
        instanceId: "codex",
        id: "other",
        label: "Other",
        kind: "weekly",
        usedPercent: 5,
        modelIds: ["opencode/a"],
        providerIds: ["opencode"],
        dailyRise: [{ day: "2026-11-09", percent: 12 }],
      },
    ]);
  });

  it("finds the local day an instant falls on and how much of it is left", () => {
    // 7 AM Eastern on Nov 4 is noon UTC.
    const start = dayAt(Date.UTC(2026, 10, 4, 12), "America/New_York");
    expect(start.day).toBe("2026-11-04");
    expect(start.remainingShare).toBeCloseTo(17 / 24, 10);
    // The same instant is already the next day in Auckland.
    expect(dayAt(Date.UTC(2026, 10, 4, 12), "Pacific/Auckland").day).toBe("2026-11-05");
  });
});

describe("buildModelPicks", () => {
  const bucket = (day: string, name: string, costUsd: number, outputTokens: number) => ({
    day,
    provider: "codex" as const,
    model: name,
    totals: {
      uncachedInputTokens: outputTokens,
      cachedInputTokens: outputTokens * 38,
      cacheCreationTokens: 0,
      outputTokens,
      reasoningTokens: 0,
    },
    costUsd,
    cacheSavingsUsd: 0,
    costSource: "providerReported" as const,
    records: 400,
    unpricedRecords: 0,
    sessions: 1,
  });
  const environment = (buckets: ReadonlyArray<ReturnType<typeof bucket>>) =>
    ({
      environmentId: "env",
      label: "Mac",
      summary: {
        contractVersion: 6,
        readAt: "2026-11-10T12:00:00.000Z",
        timeZone: "UTC",
        sinceDay: "2026-10-12",
        untilDay: "2026-11-10",
        buckets,
        sources: [
          {
            fingerprint: {
              hostId: "mac",
              provider: "codex",
              resolvedHomePath: "/home/.codex",
              volumeId: "vol-mac",
            },
            status: "ok",
            scannedFiles: 1,
            skippedFiles: 0,
            distinctSessions: 1,
            instanceId: "codex",
            displayName: "Codex",
          },
        ],
        pricing: { status: "fresh", source: "test" },
      },
    }) as never;

  it("joins usage, catalog, grades and limits into the four picks", () => {
    // The week's limit opened at noon UTC on Nov 7; usage before that must not price it.
    const weekStart = Date.UTC(2026, 10, 7, 12);
    const picks = buildModelPicks({
      environments: [
        environment([
          bucket("2026-11-01", "apex-2", 300, 3_000_000),
          bucket("2026-11-08", "apex-2", 100, 1_000_000),
          bucket("2026-11-08", "solid-1", 20, 600_000),
        ]),
      ],
      contractVersion: 6,
      providers: [
        provider("codex", {
          displayName: "Codex",
          models: [
            { slug: "apex-2", name: "Apex Two", isCustom: false, capabilities: null },
            { slug: "solid-1", name: "Solid One", isCustom: false, capabilities: null },
          ],
          usageLimits: {
            checkedAt: "2026-11-10T12:00:00.000Z",
            windows: [
              {
                id: "primary",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 40,
                resetsAt: new Date(weekStart + 7 * 24 * 60 * 60 * 1000).toISOString(),
                windowDurationMins: 10080,
              },
            ],
          },
        }),
      ],
      snapshots: [],
      table: benchmarks,
      effort: undefined,
      providerLabel: label,
      timeZone: "UTC",
      now: NOW,
    });
    expect(picks.picks.quality.winner?.label).toBe("Apex 2");
    expect(picks.picks.frugal.winner?.label).toBe("Solid 1");
    const apex = picks.candidates.find((candidate) => candidate.key === "apex-2")!;
    expect(apex.costPerMOutput).toBeCloseTo(100, 5);
    // Since the window opened: $100 + $20 for 40%, so $3 a percent and $180 left.
    expect(apex.limit?.remainingUsd).toBeCloseTo(180, 5);
    expect(apex.limit?.percentPerMOutput).toBeCloseTo(100 / 3, 5);
    expect(apex.route).toMatchObject({ modelLabel: "Apex Two", routeLabel: "Codex" });
  });

  it("prices a limit by the days it was seen rising, not by when its window opened", () => {
    const picks = buildModelPicks({
      environments: [
        environment([
          bucket("2026-11-01", "apex-2", 300, 3_000_000),
          bucket("2026-11-08", "apex-2", 100, 1_000_000),
          bucket("2026-11-08", "solid-1", 20, 600_000),
        ]),
      ],
      contractVersion: 6,
      providers: [
        provider("codex", {
          displayName: "Codex",
          models: [{ slug: "apex-2", name: "Apex Two", isCustom: false, capabilities: null }],
          usageLimits: {
            checkedAt: "2026-11-10T12:00:00.000Z",
            windows: [
              {
                id: "primary",
                kind: "weekly",
                label: "Weekly",
                // Just reset: the window itself says almost nothing.
                usedPercent: 3,
                resetsAt: "2026-11-17T06:00:00.000Z",
                windowDurationMins: 10080,
                dailyRise: [
                  // Older than the usage on hand: left out, with no work to set against it.
                  { day: "2026-10-01", percent: 50 },
                  { day: "2026-11-08", percent: 40 },
                ],
              },
            ],
          },
        }),
      ],
      snapshots: [],
      table: benchmarks,
      effort: undefined,
      providerLabel: label,
      timeZone: "UTC",
      now: NOW,
    });
    const apex = picks.candidates.find((candidate) => candidate.key === "apex-2")!;
    // Nov 8 on: $100 + $20 for 40 points, so $3 a point and $291 for the 97% left.
    expect(apex.limit?.remainingUsd).toBeCloseTo(291, 5);
    expect(apex.limit?.percentPerMOutput).toBeCloseTo(100 / 3, 5);
  });

  it.each(["codex", "codex_work"])(
    "uses the freshest subscription reading across machines (local id %s)",
    (freshId) => {
      const login = (
        instanceId: string,
        environmentId: string,
        usedPercent: number,
        checkedAt: string,
      ) =>
        provider(instanceId, {
          environmentId,
          auth: { status: "authenticated", email: "same@example.test" },
          usageLimits: {
            checkedAt,
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent }],
          },
        });
      const stale = login("codex_work", "a", 100, "2026-11-10T10:00:00Z");
      const fresh = login(freshId, "b", 10, "2026-11-10T12:00:00Z");
      for (const providers of [
        [stale, fresh],
        [fresh, stale],
      ]) {
        const picks = buildModelPicks({
          environments: [],
          contractVersion: 6,
          providers,
          snapshots: [],
          table: benchmarks,
          effort: undefined,
          providerLabel: label,
          timeZone: "UTC",
          now: NOW,
        });
        expect(picks.candidates[0]?.limit?.remainingPercent).toBe(90);
        expect(picks.picks.frugal.winner).not.toBeNull();
      }
    },
  );

  it.each([true, false])(
    "keeps machine-local instance ids distinct (known identities: %s)",
    (identified) => {
      const login = (environmentId: string, slug: string, usedPercent: number) =>
        provider("codex", {
          environmentId,
          auth: {
            status: "authenticated",
            ...(identified ? { email: `${environmentId}@example.test` } : {}),
          },
          models: [{ slug, name: slug, isCustom: false, capabilities: null }],
          usageLimits: {
            checkedAt: "2026-11-10T12:00:00Z",
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent }],
          },
        });
      const providers = [login("a", "apex-2", 100), login("b", "solid-1", 10)];
      const picks = buildModelPicks({
        environments: [],
        contractVersion: 6,
        providers,
        snapshots: [],
        table: benchmarks,
        effort: undefined,
        providerLabel: label,
        timeZone: "UTC",
        now: NOW,
      });
      expect(
        picks.candidates.find((candidate) => candidate.key === "apex-2")?.limit?.remainingPercent,
      ).toBe(0);
      expect(
        picks.candidates.find((candidate) => candidate.key === "solid-1")?.limit?.remainingPercent,
      ).toBe(90);
      expect(picks.picks.frugal.winner?.key).toBe("solid-1");
    },
  );

  describe("a newer version of a model", () => {
    const week = 7 * 24 * 60 * 60 * 1000;
    const weekly = (usedPercent: number) => ({
      checkedAt: "2026-11-10T12:00:00.000Z",
      windows: [
        {
          id: "primary",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          resetsAt: new Date(Date.UTC(2026, 10, 7, 12) + week).toISOString(),
          windowDurationMins: 10080,
        },
      ],
    });
    // The catalog writes names its own way ("Apex-3"); the table has only the older one.
    const versions = [
      { slug: "apex-3", name: "Apex-3", isCustom: false, capabilities: null },
      { slug: "apex-2", name: "Apex-2", isCustom: false, capabilities: null },
    ];
    const account = (instanceId: string, name: string, plan: string, usedPercent: number) =>
      provider(instanceId, {
        displayName: name,
        auth: { status: "authenticated", label: plan },
        continuation: { groupKey: "codex:home:/home/.codex" },
        models: versions,
        usageLimits: weekly(usedPercent),
      });
    const build = (overrides: Partial<Parameters<typeof buildModelPicks>[0]> = {}) =>
      buildModelPicks({
        environments: [environment([bucket("2026-11-08", "apex-2", 400, 4_000_000)])],
        contractVersion: 6,
        providers: [
          account("codex", "Club 10x", "Club 10x", 40),
          account("codex_b", "Club 20x", "Club 20x", 2),
        ],
        snapshots: [],
        table: benchmarks,
        effort: undefined,
        balanceAccounts: () => true,
        planPrices: { codex: 100, codex_b: 200 },
        providerLabel: label,
        timeZone: "UTC",
        now: NOW,
        ...overrides,
      });

    it("takes over the older one's usage and, until it is measured, its figures", () => {
      const picks = build({ balanceAccounts: () => false });
      expect(picks.candidates.map((candidate) => candidate.key)).not.toContain("apex-2");
      const apex = picks.candidates.find((candidate) => candidate.key === "apex-3")!;
      expect(apex).toMatchObject({ label: "Apex 3", figuresFrom: "Apex 2", used: true });
      expect(apex.route).toMatchObject({
        model: "apex-3",
        modelLabel: "Apex-3",
        instanceId: "codex",
      });
      // Priced from the user's own runs of the version before it: $400 for 4M output tokens.
      expect(apex).toMatchObject({ costBasis: "yours" });
      expect(apex.costPerMOutput).toBeCloseTo(100, 5);
      expect(picks.picks.quality.winner?.label).toBe("Apex 3");
      expect(describePick(picks.picks.quality, picks)?.lines).toContain(
        "Scored as Apex 2 until its own figures are published",
      );
    });

    it("predicts a visible account even when the hidden account has more room or more history", () => {
      const first = account("codex", "10x", "ChatGPT Pro 10x Subscription", 40);
      const second = account("codex_b", "20x", "ChatGPT Pro 20x Subscription", 2);
      const hide = (entry: typeof first) => ({ ...entry, hiddenModels: ["apex-3"] });
      const route = (providers: Parameters<typeof buildModelPicks>[0]["providers"]) =>
        build({ providers }).candidates.find((candidate) => candidate.key === "apex-3")?.route
          .instanceId;
      expect(route([first, hide(second)])).toBe(first.instanceId);
      expect(route([hide(first), second])).toBe(second.instanceId);
      expect(route([hide(first), hide(second)])).toBeUndefined();
    });

    it("stands on the account a new chat starts on, judged by the one with a record", () => {
      const alone = build({ balanceAccounts: () => false }).candidates.find(
        (candidate) => candidate.key === "apex-3",
      )!;
      const apex = build().candidates.find((candidate) => candidate.key === "apex-3")!;
      // Club 20x has nearly all of twice the allowance left, so new chats go there.
      expect(apex.route).toMatchObject({ instanceId: "codex_b", routeLabel: "Club 20x" });
      expect(apex.limit?.remainingPercent).toBe(98);
      // 2% used is too little to price Club 20x. Club 10x's limits allow $1,000 a week;
      // twice that for twice the price is the same work per dollar.
      expect(alone.plan?.judgedFrom).toBeUndefined();
      expect(apex.plan).toMatchObject({
        label: "Club 20x",
        monthlyUsd: 200,
        judgedFrom: "Club 10x",
      });
      expect(apex.plan?.leverage).toBeCloseTo(alone.plan!.leverage!, 5);
      expect(apex.plan?.monthlyCapacityUsd).toBeCloseTo(alone.plan!.monthlyCapacityUsd! * 2, 5);
      // Its cost and speed are the model's, wherever it runs.
      expect(apex.costPerMOutput).toBeCloseTo(100, 5);
      expect(apex.paidPerMOutput).toBeCloseTo(alone.paidPerMOutput!, 5);
      const value = build();
      expect(describePick(value.picks.value, value)?.lines.join("\n")).toContain(
        "going by Club 10x, this plan makes it about",
      );
    });

    it("is not a pick through a gateway that lists only the older one", () => {
      const picks = build({
        environments: [],
        providers: [
          account("codex", "Club 10x", "Club 10x", 40),
          provider("relay", {
            driver: "opencode",
            displayName: "Relay",
            models: [{ slug: "lab/apex-2", name: "Apex-2", isCustom: false, capabilities: null }],
          }),
        ],
      });
      expect(picks.candidates.map((candidate) => candidate.route.model)).toEqual(["apex-3"]);
    });

    it("keeps its own row once the table has one", () => {
      const picks = build({
        table: {
          ...benchmarks,
          models: [...benchmarks.models, { id: "apex-3", label: "Apex 3", scores: { index: 90 } }],
        },
      });
      const apex = picks.candidates.find((candidate) => candidate.key === "apex-3")!;
      expect(apex.figuresFrom).toBeUndefined();
      expect(apex.headlineBenchmark?.value).toBe(90);
    });
  });

  it("leaves out providers the page has hidden", () => {
    const picks = buildModelPicks({
      environments: [environment([bucket("2026-11-08", "apex-2", 100, 1_000_000)])],
      contractVersion: 6,
      hiddenProviders: new Set(["codex"]),
      providers: [],
      snapshots: [],
      table: benchmarks,
      effort: undefined,
      providerLabel: label,
      timeZone: "UTC",
      now: NOW,
    });
    expect(picks.candidates).toEqual([]);
  });

  it("reads the effort from a saved model selection", () => {
    expect(effortOfSelection({ options: [{ id: "effort", value: "xhigh" }] })).toBe("xhigh");
    expect(effortOfSelection({ options: [{ id: "reasoningEffort", value: "high" }] })).toBe("high");
    expect(effortOfSelection({ options: [{ id: "thought_level", value: "high" }] })).toBe("high");
    expect(effortOfSelection({ options: [{ id: "thinking_level", value: "medium" }] })).toBe(
      "medium",
    );
    expect(effortOfSelection({ options: [{ id: "variant", value: "max" }] })).toBe("max");
    expect(effortOfSelection({ options: [{ id: "fastMode", value: true }] })).toBeUndefined();
    expect(effortOfSelection(null)).toBeUndefined();
  });
});

describe("plans", () => {
  const weekly = { id: "primary", kind: "weekly", label: "Weekly", usedPercent: 10 };
  const providers = [
    provider("codex", {
      displayName: "Codex",
      auth: { status: "authenticated", label: "ChatGPT Pro 10x Subscription" },
      usageLimits: { checkedAt: "2026-11-10T12:00:00.000Z", windows: [weekly] },
    }),
    provider("grok_build", {
      driver: "grok",
      displayName: "Grok Build",
      auth: { status: "authenticated", label: "Grok account" },
      usageLimits: { checkedAt: "2026-11-10T12:00:00.000Z", windows: [weekly] },
    }),
    provider("opencode", {
      driver: "opencode",
      displayName: "OpenCode",
      auth: { status: "authenticated" },
      usageLimits: {
        checkedAt: "2026-11-10T12:00:00.000Z",
        windows: [{ ...weekly, id: "go_weekly", label: "Go · Weekly" }],
      },
    }),
    provider("api", {
      driver: "claudeAgent",
      displayName: "Claude API",
      auth: { status: "authenticated", label: "Claude API Key" },
    }),
    provider("off", { enabled: false, displayName: "Off" }),
  ];

  it("lists each cloud instance with its plan and list price, priced ones first", () => {
    expect(planPriceRows(providers)).toEqual([
      {
        instanceId: "codex",
        label: "Codex",
        planLabel: "ChatGPT Pro 10x",
        listUsd: 100,
        allowance: 10,
        hasLimits: true,
      },
      {
        instanceId: "opencode",
        label: "OpenCode",
        planLabel: "OpenCode Go",
        listUsd: 10,
        includedMonthlyUsd: 60,
        hasLimits: true,
      },
      { instanceId: "grok_build", label: "Grok Build", planLabel: "Grok Build", hasLimits: true },
      { instanceId: "api", label: "Claude API", planLabel: "Claude API", hasLimits: false },
    ]);
  });

  it("names two accounts of one provider by their own names", () => {
    const account = (instanceId: string, displayName: string, label: string) =>
      provider(instanceId, {
        displayName,
        continuation: { groupKey: "codex:home:/synthetic/.codex" },
        auth: { status: "authenticated", label },
        usageLimits: { checkedAt: "2026-11-10T12:00:00.000Z", windows: [weekly] },
      });
    const rows = planPriceRows([
      account("codex", "Home", "ChatGPT Pro 10x Subscription"),
      account("codex_work", "Work", "ChatGPT Pro 20x Subscription"),
      // Alone in its group, an instance keeps its plan's name.
      provider("codex_other", {
        displayName: "Work",
        continuation: { groupKey: "codex:home:/elsewhere" },
        auth: { status: "authenticated", label: "ChatGPT Plus Subscription" },
      }),
    ]);
    expect(rows.map((row) => [row.instanceId, row.planLabel, row.listUsd])).toEqual([
      ["codex", "Home", 100],
      ["codex_work", "Work", 200],
      ["codex_other", "ChatGPT Plus", 20],
    ]);
  });

  it("keeps an account's own name when another machine lists it alone", () => {
    const account = (instanceId: string, displayName: string, label: string, home: string) =>
      provider(instanceId, {
        displayName,
        continuation: { groupKey: `codex:home:${home}` },
        auth: { status: "authenticated", label },
      });
    const rows = planPriceRows([
      // A second machine comes first in the list: the same login, alone, under the brand name.
      account("codex", "Codex", "ChatGPT Pro 10x Subscription", "/remote/.codex"),
      account("codex", "Home", "ChatGPT Pro 10x Subscription", "/synthetic/.codex"),
      account("codex_work", "Work", "ChatGPT Pro 20x Subscription", "/synthetic/.codex"),
    ]);
    expect(rows.map((row) => [row.instanceId, row.label, row.planLabel])).toEqual([
      ["codex", "Home", "Home"],
      ["codex_work", "Work", "Work"],
    ]);
  });

  it("lists a login another machine cannot name under the account its id names", () => {
    const account = (
      environmentId: string,
      instanceId: string,
      displayName: string,
      email: string | undefined,
    ) =>
      ({
        ...provider(instanceId, {
          displayName,
          continuation: { groupKey: "claude:home:/synthetic/.claude" },
          auth: {
            status: "authenticated",
            label: "Claude Ultra Subscription",
            ...(email === undefined ? {} : { email }),
          },
        }),
        environmentId,
      }) as never;
    const rows = planPriceRows([
      account("mac", "claudeAgent", "Max 1", "one@example.com"),
      account("mac", "claudeAgent_work", "Max 2", "two@example.com"),
      // A second machine signed in with a token: no email to match on.
      account("remote", "claudeAgent", "Max 1", undefined),
    ]);
    // Apart, the one plan would be listed, and paid, twice.
    expect(rows.map((row) => row.label)).toEqual(["Max 1", "Max 2"]);
  });

  it("lets the user's own price win, and price a plan the table does not know", () => {
    const plans = plansFromProviders(providers, { codex: 120, grok_build: 30 });
    expect(plans).toEqual([
      { instanceId: "codex", label: "ChatGPT Pro 10x", monthlyUsd: 120, allowance: 10 },
      { instanceId: "grok_build", label: "Grok Build", monthlyUsd: 30 },
      { instanceId: "opencode", label: "OpenCode Go", monthlyUsd: 10, includedMonthlyUsd: 60 },
    ]);
    // Without their price, a plan the table does not know has none.
    expect(plansFromProviders(providers).map((plan) => plan.instanceId)).toEqual([
      "codex",
      "opencode",
    ]);
  });
});

describe("wording", () => {
  const routes = routesFromUsage(
    [model("apex-2", 400, 4_000_000), model("solid-1", 90, 3_000_000, { instanceId: "two" })],
    [],
    label,
  );
  const picks = pickBestModels({
    routes,
    grades: [{ instanceId: "codex", model: "apex-2", runs: 6, rated: 6, average: 9, completed: 6 }],
    limits: [
      {
        instanceId: "two",
        id: "primary",
        label: "Weekly",
        kind: "weekly",
        usedPercent: 40,
        resetsAtMs: NOW + 3 * 24 * 60 * 60 * 1000,
        durationMs: 7 * 24 * 60 * 60 * 1000,
      },
    ],
    benchmarks,
    usageSince: () => routes,
    now: NOW,
  });

  it("describes the quality pick by its benchmark and the user's grades", () => {
    const description = describePick(picks.picks.quality, picks)!;
    expect(description.title).toBe("Quality");
    expect(description.headline).toMatchObject({ value: 80, text: "80", unit: "Index" });
    expect(description.lines).toEqual([
      "Your grades: 9.0/10 across 6 graded tasks",
      "Solid 1 follows at 93% of it",
    ]);
  });

  it("describes the value pick against the best model's cost", () => {
    const description = describePick(picks.picks.value, picks)!;
    expect(picks.picks.value.winner?.label).toBe("Solid 1");
    expect(description.headline.text).toBe("$30.00");
    // It has a limit but no known price, so it is still counted at the API price.
    expect(description.headline.unit).toBe(
      "per 1M output tokens with their context, at API prices",
    );
    expect(description.lines).toEqual([
      "93% of the best quality for 3.3× less than Apex 2",
      "Enter what this plan costs you to see its real price",
      "1M output tokens uses about 13% of your Weekly limit, 60% left",
    ]);
    expect(pickValueText("value", picks.picks.value.ranked[1]!)).toBe("$100/M");
  });

  it("words a plan's model by what the plan costs, beside the API price", () => {
    const onPlan = pickBestModels({
      routes,
      grades: [],
      limits: [
        {
          instanceId: "two",
          id: "primary",
          label: "Weekly",
          kind: "weekly",
          usedPercent: 40,
          resetsAtMs: NOW + 3 * 24 * 60 * 60 * 1000,
          durationMs: 7 * 24 * 60 * 60 * 1000,
        },
      ],
      plans: [{ instanceId: "two", label: "Two Pro", monthlyUsd: 20 }],
      benchmarks,
      usageSince: () => routes,
      now: NOW,
    });
    // $90 bought 40% of a week: $225 a week, about $978 a month, for $20.
    const description = describePick(onPlan.picks.value, onPlan)!;
    expect(onPlan.picks.value.winner?.label).toBe("Solid 1");
    expect(description.headline).toMatchObject({
      text: "$0.61",
      unit: "per 1M output tokens with their context, on your Two Pro plan",
    });
    expect(description.lines).toEqual([
      "93% of the best quality for 163× less than Apex 2",
      "API price $30.00, so the plan makes it 49× cheaper",
      "1M output tokens uses about 13% of your Weekly limit, 60% left",
    ]);
    expect(pickValueText("value", onPlan.picks.value.ranked[0]!)).toBe("$0.61/M");
    expect(pickValueText("value", onPlan.picks.value.ranked[1]!)).toBe("$100/M");
    const plan = onPlan.plans.find((entry) => entry.instanceId === "two")!;
    expect(describePlan(plan)).toMatchObject({
      instanceId: "two",
      label: "Two Pro",
      price: "$20/mo",
      used: "$90.00 of work at API prices in 30 days",
      usedTimes: "4.5× its price",
      capacity: "room for about $978 a month (49× its price)",
    });
    expect(describePlan(plan).usedShare).toBeCloseTo(90 / 978.35, 3);
  });

  it("counts a plan's work on models without an API price in tokens, never as $0", () => {
    expect(
      describePlan({
        instanceId: "devin",
        label: "Devin",
        monthlyUsd: 200,
        usedUsd: 0,
        unpricedTokens: 150_600_000,
        hasLimits: false,
      }),
    ).toMatchObject({
      used: "151M tokens in 30 days (its models have no API price)",
      usedTimes: null,
    });
    expect(
      describePlan({
        instanceId: "mixed",
        label: "Mixed",
        monthlyUsd: 20,
        usedUsd: 40,
        unpricedTokens: 2_500_000,
        hasLimits: false,
      }).used,
    ).toBe("$40.00 of work at API prices in 30 days, plus 2.50M tokens with no API price");
  });

  it("words a plan nobody has priced yet", () => {
    expect(describePlan(picks.plans.find((entry) => entry.instanceId === "two")!)).toMatchObject({
      price: null,
      usedTimes: null,
      capacity: "room for about $978 a month",
    });
  });

  it("words a plan that did more than its limits now add up to", () => {
    const description = describePlan({
      instanceId: "codex",
      label: "Big Plan",
      monthlyUsd: 100,
      usedUsd: 3234,
      monthlyCapacityUsd: 3234,
      capacityBasis: "used",
      limitMonthlyUsd: 1665,
      hasLimits: true,
    });
    expect(description).toMatchObject({
      used: "$3,234 of work at API prices in 30 days",
      usedTimes: "32× its price",
      capacity: "more than its limits now allow in a month (about $1,665)",
      usedShare: 1,
    });
  });

  it("words the runners-up of each pick against the winner", () => {
    const quality = picks.picks.quality;
    expect(pickValueText("quality", quality.ranked[1]!, quality)).toMatch(/^\d+%$/);
    expect(pickValueText("quality", quality.ranked[1]!)).toMatch(/^\d+$/);
  });

  it("words speed as how much sooner the same work is done", () => {
    const timed = pickBestModels({
      routes: routes.slice(0, 2),
      grades: [],
      limits: [],
      benchmarks: {
        ...benchmarks,
        models: benchmarks.models.map((row) =>
          row.id === "apex-2"
            ? { ...row, outputTokensPerTask: 100_000 }
            : row.id === "solid-1"
              ? { ...row, outputTokensPerTask: 45_000 }
              : row,
        ),
      },
      now: NOW,
    });
    // Apex: 100,000 tokens at 50 a second is 2,000 s. Solid: 45,000 at 90 is 500 s.
    const description = describePick(timed.picks.speed, timed)!;
    expect(timed.picks.speed.winner?.label).toBe("Solid 1");
    expect(description.headline).toMatchObject({
      text: "4.0×",
      unit: "sooner than Apex 2 on the same work",
    });
    expect(description.lines).toEqual([
      "90 tokens a second, a public figure: too few of your responses timed",
      "Spends 45% of the tokens Apex 2 does on the same benchmark tasks",
      "93% of the best quality",
    ]);
    expect(pickValueText("speed", timed.picks.speed.ranked[1]!, timed.picks.speed)).toBe(
      "4.0× as long",
    );
    expect(pickBarShare("speed", timed.picks.speed.ranked[1]!, timed.picks.speed)).toBeCloseTo(
      0.25,
      5,
    );
  });

  it("says when speed is a public figure", () => {
    const description = describePick(picks.picks.speed, picks)!;
    expect(description.headline).toMatchObject({ value: 90, unit: "output tokens per second" });
    expect(description.badge).toBeNull();
    expect(description.lines).toEqual([
      "Public figure: not enough of your responses timed yet",
      "1.8× Apex 2's speed, at 93% of the best quality",
    ]);
  });

  it("describes a subscription model by its cost and how fast it uses the limit", () => {
    const cloudOnly = pickBestModels({
      routes: routes.slice(0, 2),
      grades: [],
      limits: [
        {
          instanceId: "two",
          id: "primary",
          label: "Weekly",
          kind: "weekly",
          usedPercent: 40,
          resetsAtMs: NOW + 3 * 24 * 60 * 60 * 1000,
          durationMs: 7 * 24 * 60 * 60 * 1000,
        },
      ],
      benchmarks,
      usageSince: () => routes,
      now: NOW,
    });
    const pick = cloudOnly.picks.frugal;
    const description = describePick(pick, cloudOnly)!;
    expect(pick.winner?.label).toBe("Solid 1");
    expect(description.headline).toMatchObject({
      value: 30,
      text: "$30.00",
      unit: "per 1M output tokens with their context, at API prices",
    });
    // $90 bought 40% of the week: a percent is $2.25, so $30 of work is about 13%.
    expect(description.lines).toEqual([
      "93% of the best quality for 3.3× less than Apex 2",
      "1M output tokens uses about 13% of your Weekly limit, 60% left",
    ]);
    expect(pickBarShare("frugal", pick.ranked[1]!, pick)).toBeCloseTo(0.3, 5);
  });

  it("names the effort a benchmark score was measured at", () => {
    const atEffort = pickBestModels({
      routes: routes.slice(0, 1),
      grades: [],
      limits: [],
      benchmarks: {
        ...benchmarks,
        models: benchmarks.models.map((row) =>
          row.id === "apex-2"
            ? { ...row, scores: { index: 71 }, scoreEfforts: { index: "xhigh" } }
            : row,
        ),
      },
      now: NOW,
    });
    expect(describePick(atEffort.picks.quality, atEffort)!.headline).toMatchObject({
      text: "71",
      unit: "Index, xhigh effort",
    });
  });

  it("names what the picks rest on", () => {
    expect(picksBasis(picks, benchmarks)).toBe(
      "2 models you can run · your last 30 days of usage · 6 graded subagent tasks · public benchmarks from Nov 10",
    );
  });

  it("has nothing to say without a winner", () => {
    const empty = pickBestModels({ routes: [], grades: [], limits: [], benchmarks, now: NOW });
    expect(describePick(empty.picks.quality, empty)).toBeNull();
  });
});
