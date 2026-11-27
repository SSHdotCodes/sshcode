import { describe, expect, it } from "@effect/vitest";
import {
  AGENT_TOKEN_ESTIMATES,
  agentTokenEstimate,
  type AgentTokenHarness,
  type AgentTokenLevel,
} from "@t3tools/shared/agentTokenEstimates";
import budget from "./agentContextBudget.json" with { type: "json" };

const MAX_DRIFT_RATIO = 0.05;

/**
 * Total SSHCode-added bytes from `agentContextBudget.json` for each (level, harness)
 * cell that has a live measurement in `AGENT_TOKEN_ESTIMATES`.
 *
 * When a prompt or tool-catalog change moves any cell more than 5% away from the
 * bytes it was measured at, this test fails so `AGENT_TOKEN_ESTIMATES` is re-measured
 * instead of silently going stale.
 */
const currentBudgetBytes = (level: AgentTokenLevel, harness: AgentTokenHarness): number | null => {
  const highDelta = budget.highTokenClaudeSystemAppendBytes - budget.claudeSystemAppendBytes;
  if (harness === "claudeCode") {
    if (level === "low") {
      return budget.lowTokenClaudeSystemAppendBytes + budget.lowTokenDeferredMcpCatalogJsonBytes;
    }
    if (level === "default") {
      return budget.claudeSystemAppendBytes + budget.agentMcpToolListJsonBytes;
    }
    return budget.highTokenClaudeSystemAppendBytes + budget.agentMcpToolListJsonBytes;
  }
  if (harness === "codex") {
    if (level === "low") {
      return (
        budget.lowTokenCodexAdditionalContextBytes + budget.lowTokenDeferredMcpCatalogJsonBytes
      );
    }
    if (level === "default") {
      return (
        budget.codexAdditionalContextBytes +
        budget.codexMcpDiscoveryCatalogBytes +
        budget.agentMcpToolListJsonBytes
      );
    }
    return (
      budget.highTokenCodexAdditionalContextBytes +
      budget.codexMcpDiscoveryCatalogBytes +
      budget.agentMcpToolListJsonBytes
    );
  }
  if (harness === "antigravity") {
    if (level === "low") {
      return budget.lowTokenAcpBootstrapAddedBytes + budget.lowTokenDeferredMcpCatalogJsonBytes;
    }
    if (level === "default") {
      return (
        budget.acpBootstrapAddedBytes +
        budget.antigravityMcpDiscoveryCatalogBytes +
        budget.eagerAgentGeminiMcpToolListJsonBytes
      );
    }
    return (
      budget.acpBootstrapAddedBytes +
      highDelta +
      budget.antigravityMcpDiscoveryCatalogBytes +
      budget.highTokensEagerAgentMcpToolListJsonBytes
    );
  }
  return null;
};

/**
 * Exact `agentContextBudget.json` byte totals when the 2026-11-27 realistic-length
 * measurements were run (n=6 per arm across 3 multi-stage tasks).
 */
const MEASURED_BUDGET_BYTES: Partial<
  Record<AgentTokenLevel, Partial<Record<AgentTokenHarness, number>>>
> = {
  low: {
    claudeCode: 3892,
    codex: 3892,
    antigravity: 4932,
  },
  default: {
    claudeCode: 59846,
    codex: 63901,
    antigravity: 41601,
  },
  high: {
    claudeCode: 60042,
    codex: 64097,
    antigravity: 44847,
  },
};

describe("AGENT_TOKEN_ESTIMATES budget drift", () => {
  it("stays within 5% of the agentContextBudget.json bytes each cell was measured at", () => {
    const levels: readonly AgentTokenLevel[] = ["low", "default", "high"];
    let checked = 0;

    for (const level of levels) {
      const harnesses = AGENT_TOKEN_ESTIMATES[level];
      if (!harnesses) continue;
      for (const [harnessKey, estimate] of Object.entries(harnesses)) {
        if (!estimate) continue;
        const harness = harnessKey as AgentTokenHarness;
        checked += 1;

        expect(agentTokenEstimate(level, harness)).toEqual(estimate);
        expect(Number.isFinite(estimate.tokensPct)).toBe(true);
        expect(Number.isFinite(estimate.usagePct)).toBe(true);
        expect(estimate.runs).toBeGreaterThanOrEqual(3);
        expect(estimate.measuredAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

        const baseline = MEASURED_BUDGET_BYTES[level]?.[harness];
        const current = currentBudgetBytes(level, harness);
        expect(
          baseline,
          `Missing MEASURED_BUDGET_BYTES baseline for (${level}, ${harness})`,
        ).toBeTypeOf("number");
        expect(
          current,
          `Missing currentBudgetBytes calculation for (${level}, ${harness})`,
        ).toBeTypeOf("number");

        const drift = Math.abs(current! - baseline!) / baseline!;
        expect(
          drift,
          `agentContextBudget.json drifted ${(drift * 100).toFixed(1)}% for (${level}, ${harness}): measured at ${baseline} B, now ${current} B. Re-measure AGENT_TOKEN_ESTIMATES and update MEASURED_BUDGET_BYTES.`,
        ).toBeLessThanOrEqual(MAX_DRIFT_RATIO);
      }
    }

    expect(checked).toBeGreaterThanOrEqual(6);
  });
});
