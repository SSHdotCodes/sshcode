import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import { MODEL_BENCHMARKS } from "@t3tools/shared/modelBenchmarks";
import { type ModelPicks } from "@t3tools/shared/modelPicks";
import {
  autoModelCandidates,
  autoModelCanEvaluate,
  autoModelOutcome,
  EMPTY_AUTO_MODEL_DRAFT,
  mergeAutoModelEvaluation,
} from "./autoModel.logic";

const instanceId = ProviderInstanceId.make("codex");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  installed: true,
  enabled: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-12T12:00:00Z",
  models: [],
  skills: [],
  slashCommands: [],
};
const model = { slug: "test-model", name: "Test", isCustom: false, capabilities: null };
const picks: ModelPicks = {
  picks: {
    quality: { kind: "quality", winner: null, ranked: [] },
    speed: { kind: "speed", winner: null, ranked: [] },
    frugal: { kind: "frugal", winner: null, ranked: [] },
    value: { kind: "value", winner: null, ranked: [] },
  },
  candidates: [
    {
      key: model.slug,
      label: model.name,
      quality: 80,
      route: {
        model: model.slug,
        routeLabel: "Codex",
        local: false,
        costUsd: 0,
        costKnown: false,
        tokens: {
          uncachedInputTokens: 0,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 0,
          reasoningTokens: 0,
        },
        responses: 0,
      },
      used: false,
      billing: "metered",
    },
  ],
  plans: [],
  bestQuality: 100,
  gradedRuns: 0,
};
const now = Date.parse("2026-11-12T12:00:00Z");
const input = {
  providers: [{ ...provider, models: [model] }],
  models: new Map([[instanceId, [model]]]),
  picks,
  table: MODEL_BENCHMARKS,
  now,
};

describe("Auto model draft policy", () => {
  const eligible = {
    enabled: true,
    hasMessages: false,
    busy: false,
    state: EMPTY_AUTO_MODEL_DRAFT,
  };
  it("only evaluates an untouched, unsent draft while enabled", () => {
    expect(autoModelCanEvaluate(eligible)).toBe(true);
    for (const patch of [{ enabled: false }, { hasMessages: true }, { busy: true }])
      expect(autoModelCanEvaluate({ ...eligible, ...patch })).toBe(false);
    for (const patch of [{ accepted: true }, { dismissed: true }, { sent: true }])
      expect(
        autoModelCanEvaluate({ ...eligible, state: { ...EMPTY_AUTO_MODEL_DRAFT, ...patch } }),
      ).toBe(false);
  });
  it("emits an explicit unshown outcome when nothing was classified", () => {
    expect(autoModelOutcome(undefined)).toEqual({
      suggestedTier: null,
      confidence: null,
      suggestedModel: null,
      shown: false,
      accepted: false,
    });
  });
});

describe("Auto model catalog evidence", () => {
  it("uses the cached quality and the tightest applicable live limit", () => {
    const limited = {
      ...input,
      providers: [
        {
          ...provider,
          models: [model],
          usageLimits: {
            checkedAt: provider.checkedAt,
            windows: [
              { id: "session", label: "Session", kind: "session" as const, usedPercent: 92 },
              {
                id: "weekly",
                label: "Weekly",
                kind: "weekly" as const,
                usedPercent: 100,
                modelIds: ["other-model"],
              },
              {
                id: "monthly",
                label: "Expired",
                kind: "monthly" as const,
                usedPercent: 100,
                resetsAt: "2026-11-11T12:00:00Z",
              },
            ],
          },
        },
      ],
    };
    expect(autoModelCandidates(limited)[0]).toMatchObject({
      quality: 80,
      remainingPercent: 8,
      available: true,
    });
  });
  it("excludes unmeasured models and preserves unavailable and legacy flags for the recommender", () => {
    expect(autoModelCandidates({ ...input, picks: { ...picks, candidates: [] } })).toEqual([]);
    expect(
      autoModelCandidates({
        ...input,
        providers: [{ ...provider, enabled: false }],
        models: new Map([[instanceId, [{ ...model, isLegacy: true, isUnavailable: true }]]]),
      })[0],
    ).toMatchObject({ available: false, legacy: true });
  });
});

describe("Auto model evaluation merge", () => {
  const suggestion = (model: string, tier: "fast" | "big" = "fast") => ({
    tier,
    confidence: 0.9,
    selection: { instanceId: "provider", model },
    label: model,
  });
  const shown = {
    ...EMPTY_AUTO_MODEL_DRAFT,
    difficulty: { tier: "fast" as const, confidence: 0.9 },
    recommendation: suggestion("small"),
    shown: true,
  };

  it("returns the same draft when an evaluation changes nothing", () => {
    expect(
      mergeAutoModelEvaluation(shown, { tier: "fast", confidence: 0.9 }, suggestion("small")),
    ).toBe(shown);
    expect(mergeAutoModelEvaluation(EMPTY_AUTO_MODEL_DRAFT, null, null)).toBe(
      EMPTY_AUTO_MODEL_DRAFT,
    );
  });

  it("keeps the shown suggestion and its object while only the confidence moves", () => {
    const next = mergeAutoModelEvaluation(
      shown,
      { tier: "fast", confidence: 0.8 },
      suggestion("small"),
    );
    expect(next.recommendation).toBe(shown.recommendation);
    expect(next.shown).toBe(true);
    expect(next.difficulty?.confidence).toBe(0.8);
  });

  it("starts over as not shown when the suggestion changes or goes away", () => {
    const other = mergeAutoModelEvaluation(
      shown,
      { tier: "big", confidence: 0.9 },
      suggestion("large", "big"),
    );
    expect(other.recommendation?.selection.model).toBe("large");
    expect(other.shown).toBe(false);
    expect(mergeAutoModelEvaluation(shown, null, null)).toMatchObject({
      recommendation: null,
      shown: false,
    });
  });
});
