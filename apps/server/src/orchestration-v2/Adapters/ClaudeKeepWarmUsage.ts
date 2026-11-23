import type { ModelUsage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderSessionKeepWarmUsage } from "@t3tools/provider-core/server/ProviderAdapter";

/** Difference the CLI's cumulative counters, which include /btw but its response omits. */
export function claudeKeepWarmUsageDelta(
  before: Readonly<Record<string, ModelUsage>>,
  after: Readonly<Record<string, ModelUsage>>,
): ProviderSessionKeepWarmUsage | null {
  const changed: ProviderSessionKeepWarmUsage[] = [];
  for (const [model, usage] of Object.entries(after)) {
    const previous = before[model];
    const values = [
      "inputTokens",
      "cacheReadInputTokens",
      "cacheCreationInputTokens",
      "outputTokens",
    ] as const;
    const delta = values.map((key) => usage[key] - (previous?.[key] ?? 0));
    if (delta.some((value) => !Number.isFinite(value) || value < 0)) return null;
    if (delta.every((value) => value === 0)) continue;
    changed.push({
      model,
      inputTokens: delta[0]!,
      cacheReadTokens: delta[1]!,
      cacheWriteTokens: delta[2]!,
      outputTokens: delta[3]!,
    });
  }
  if (changed.length === 0) return null;
  if (changed.length === 1) return changed[0]!;
  return {
    model: "multiple",
    modelUsage: changed,
    inputTokens: changed.reduce((total, usage) => total + usage.inputTokens, 0),
    cacheReadTokens: changed.reduce((total, usage) => total + usage.cacheReadTokens, 0),
    cacheWriteTokens: changed.reduce((total, usage) => total + usage.cacheWriteTokens, 0),
    outputTokens: changed.reduce((total, usage) => total + usage.outputTokens, 0),
  };
}

/** Newer CLIs report each window's utilization here and omit the top-level field. */
type ClaudeRateLimitInfo = SDKRateLimitInfo & {
  readonly unifiedWindows?: Readonly<
    Record<string, { readonly utilization?: number | undefined } | undefined>
  >;
};

/**
 * Why a rate-limit event stops keep-warm pings. Disabled overage matters only once a limit
 * rejects requests: accounts without extra-usage credits report it on every allowed event.
 */
export function claudeKeepWarmRateLimitBlock(
  info: ClaudeRateLimitInfo,
): "out_of_credit" | "rate_limited" | "weekly_limit" | null {
  if (info.errorCode === "credits_required") return "out_of_credit";
  if (info.status === "rejected") {
    return info.overageDisabledReason === "out_of_credits" ? "out_of_credit" : "rate_limited";
  }
  const weekly = [
    ...(info.rateLimitType?.startsWith("seven_day") ? [info.utilization] : []),
    ...Object.entries(info.unifiedWindows ?? {}).flatMap(([id, window]) =>
      id.startsWith("seven_day") ? [window?.utilization] : [],
    ),
  ];
  return weekly.some((utilization) => (utilization ?? 0) >= 0.95) ? "weekly_limit" : null;
}
