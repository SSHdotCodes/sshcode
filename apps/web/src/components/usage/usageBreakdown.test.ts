import type { ModelTotals } from "@t3tools/shared/usageMerge";
import { describe, expect, it } from "vite-plus/test";

import {
  cacheHitRate,
  costPerMillionTokens,
  modelShare,
  sortModelsByTokens,
  foldSmallUsageRows,
} from "./usageBreakdown";

const model = (
  name: string,
  totalTokens: number,
  costUsd: number,
  overrides: Partial<ModelTotals> = {},
): ModelTotals => ({
  model: name,
  provider: "codex",
  costUsd,
  totalTokens,
  tokens: {
    uncachedInputTokens: totalTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  },
  records: 1,
  unpricedRecords: 0,
  unpricedTokens: 0,
  costShare: 0,
  tokenShare: 0,
  ...overrides,
});

describe("sortModelsByTokens", () => {
  it("sorts by tokens, breaks ties by cost, and leaves the input alone", () => {
    const models = [
      model("lower-cost", 100, 1),
      model("more-tokens", 200, 2),
      model("higher-cost", 100, 3),
    ];

    expect(sortModelsByTokens(models).map((item) => item.model)).toEqual([
      "more-tokens",
      "higher-cost",
      "lower-cost",
    ]);
    expect(models.map((item) => item.model)).toEqual(["lower-cost", "more-tokens", "higher-cost"]);
  });
});

describe("modelShare", () => {
  it("follows the selected metric", () => {
    const priced = model("priced", 100, 9, { costShare: 0.9, tokenShare: 0.25 });

    expect(modelShare(priced, "cost")).toBe(0.9);
    expect(modelShare(priced, "tokens")).toBe(0.25);
  });

  it("has no cost share for an unknown cost but keeps its token share", () => {
    const unpriced = model("unpriced", 300, 0, {
      unpricedRecords: 1,
      unpricedTokens: 300,
      tokenShare: 0.75,
    });

    expect(modelShare(unpriced, "cost")).toBeNull();
    expect(modelShare(unpriced, "tokens")).toBe(0.75);
  });
});

describe("model rates", () => {
  it("counts cache writes as misses and leaves unpriced tokens out of $/1M", () => {
    const mixed = model("mixed", 4_000_000, 6, {
      tokens: {
        uncachedInputTokens: 1_000_000,
        cachedInputTokens: 1_000_000,
        cacheCreationTokens: 2_000_000,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      records: 4,
      unpricedRecords: 1,
      unpricedTokens: 1_000_000,
    });

    expect(cacheHitRate(mixed)).toBe(0.25);
    expect(costPerMillionTokens(mixed)).toBe(2);
    expect(costPerMillionTokens({ ...mixed, unpricedRecords: 4 })).toBeNull();
  });
});

describe("foldSmallUsageRows", () => {
  const rows = (shares: ReadonlyArray<number | null>) =>
    shares.map((share, index) => ({ index, share }));
  const share = (row: { readonly share: number | null }) => row.share;

  it("keeps a short list whole", () => {
    const list = rows([0.6, 0.39, 0.005, 0.005]);
    expect(foldSmallUsageRows(list, share)).toEqual({ shown: list, folded: [] });
  });

  it("folds providers under one percent once the list is long", () => {
    const list = rows([0.35, 0.57, 0.001, 0.0005, 0.023, 0.006, 0.0001, 0.014]);
    const { shown, folded } = foldSmallUsageRows(list, share);
    expect(shown.map((row) => row.index)).toEqual([0, 1, 4, 7]);
    expect(folded.map((row) => row.index)).toEqual([2, 3, 5, 6]);
  });

  it("does not fold for a single small row, or rows that must stay in view", () => {
    const one = rows([0.3, 0.3, 0.1, 0.1, 0.1, 0.09, 0.001]);
    expect(foldSmallUsageRows(one, share).folded).toEqual([]);
    const loading = rows([0.5, 0.2, 0.1, 0.1, 0.09, null, null, 0.001, 0.002]);
    expect(foldSmallUsageRows(loading, share).shown.map((row) => row.index)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
  });
});
