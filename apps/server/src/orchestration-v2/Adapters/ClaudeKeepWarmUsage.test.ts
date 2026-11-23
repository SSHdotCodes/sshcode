import { describe, expect, it } from "@effect/vitest";
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { claudeKeepWarmRateLimitBlock, claudeKeepWarmUsageDelta } from "./ClaudeKeepWarmUsage.ts";
const base: ModelUsage = {
  inputTokens: 10,
  outputTokens: 1,
  cacheReadInputTokens: 120000,
  cacheCreationInputTokens: 500,
  webSearchRequests: 0,
  costUSD: 0,
  contextWindow: 200000,
  maxOutputTokens: 64000,
};
describe("Claude keep-warm usage", () => {
  it("separates cache reads, writes and ordinary input from cumulative counters", () => {
    expect(
      claudeKeepWarmUsageDelta(
        { model: base },
        {
          model: {
            ...base,
            inputTokens: 12,
            outputTokens: 2,
            cacheReadInputTokens: 240000,
            cacheCreationInputTokens: 600,
          },
        },
      ),
    ).toEqual({
      model: "model",
      inputTokens: 2,
      outputTokens: 1,
      cacheReadTokens: 120000,
      cacheWriteTokens: 100,
    });
  });
  it("preserves a cold cache write rather than estimating a read", () => {
    expect(
      claudeKeepWarmUsageDelta(
        { model: base },
        { model: { ...base, cacheCreationInputTokens: 120500 } },
      )?.cacheWriteTokens,
    ).toBe(120000);
  });
  it("rejects unavailable counters and resets", () => {
    expect(
      claudeKeepWarmUsageDelta({ model: base }, { model: { ...base, cacheReadInputTokens: NaN } }),
    ).toBeNull();
    expect(
      claudeKeepWarmUsageDelta({ model: base }, { model: { ...base, inputTokens: 0 } }),
    ).toBeNull();
    expect(claudeKeepWarmUsageDelta({}, { first: base, second: base })).toMatchObject({
      model: "multiple",
      cacheReadTokens: 240000,
      cacheWriteTokens: 1000,
      modelUsage: [{ model: "first" }, { model: "second" }],
    });
    expect(claudeKeepWarmUsageDelta({ model: base }, { model: base })).toBeNull();
  });
});

describe("Claude keep-warm rate-limit block", () => {
  // Shape the CLI streams for an account without extra-usage credits.
  const allowed = {
    status: "allowed",
    rateLimitType: "seven_day",
    overageStatus: "rejected",
    overageDisabledReason: "out_of_credits",
    isUsingOverage: false,
    unifiedWindows: { seven_day: { utilization: 0.71, status: "allowed" } },
  } as const;

  it("keeps warming while requests are allowed without overage credits", () => {
    expect(claudeKeepWarmRateLimitBlock(allowed)).toBeNull();
  });

  it("stops near the weekly limit, read from the per-window utilization", () => {
    expect(
      claudeKeepWarmRateLimitBlock({
        ...allowed,
        unifiedWindows: { seven_day: { utilization: 0.96 } },
      }),
    ).toBe("weekly_limit");
    expect(
      claudeKeepWarmRateLimitBlock({
        status: "allowed",
        rateLimitType: "seven_day_opus",
        utilization: 0.95,
      }),
    ).toBe("weekly_limit");
    expect(
      claudeKeepWarmRateLimitBlock({
        ...allowed,
        unifiedWindows: { five_hour: { utilization: 0.99 } },
      }),
    ).toBeNull();
  });

  it("stops once a limit rejects requests", () => {
    expect(claudeKeepWarmRateLimitBlock({ ...allowed, status: "rejected" })).toBe("out_of_credit");
    expect(claudeKeepWarmRateLimitBlock({ status: "rejected", rateLimitType: "five_hour" })).toBe(
      "rate_limited",
    );
    expect(claudeKeepWarmRateLimitBlock({ status: "allowed", errorCode: "credits_required" })).toBe(
      "out_of_credit",
    );
  });
});
