/**
 * Measured token cost of each Settings > Agents token level against the same task in the
 * harness's own app or CLI (no SSHCode tools or instructions). Filled from measurements;
 * a level or harness without a measured entry shows no number rather than a guess.
 */
import type { AgentBehaviorLevels } from "@t3tools/contracts";

export type AgentTokenLevel = AgentBehaviorLevels["tokens"];

/** Harnesses the estimates name, as the owner knows them. */
export type AgentTokenHarness =
  | "claudeCode"
  | "codex"
  | "antigravity"
  | "grok"
  | "devin"
  | "opencode";

export interface AgentTokenEstimate {
  /** Extra tokens (input + cache reads + output) vs the native harness, in percent. */
  readonly tokensPct: number;
  /** Extra plan usage, weighting tokens the way plans bill them, in percent. */
  readonly usagePct: number;
  /** When it was measured (ISO date) and on how many task runs. */
  readonly measuredAt: string;
  readonly runs: number;
}

/**
 * Measured on subscription plans across three 5–15 min multi-stage coding tasks
 * (ledger-engine, task-scheduler, query-engine; n=6 balanced runs/arm per harness:
 * Claude Code claude-sonnet-5-5, Codex gpt-6.2-sol medium, Antigravity Neon),
 * compared against each harness running alone without SSHCode instructions or MCP tools.
 * Real-chat cross-check (read-only statev2.sqlite, last 30d long chats >=5m or >=3 turns):
 * SSHCode's added bytes are a smaller static share of long multi-turn request sizes —
 * Claude median 292K tok (0.6% prompt / 5.1% full budget), Codex 186K tok (1.4% prompt+disc /
 * 8.6% full), Antigravity 338K tok (3.1% full; ~5.2% at measured +17.7K prefix), with 97–99%
 * cache re-reads — so single-prompt task means reflect both smaller early-turn context and
 * run-to-run trajectory variance (SE ~3–14pp).
 * Plan usage weights: input 1.0, cache write 1.25, cache read 0.10, output 5.0.
 * Unmeasured harnesses (grok, devin, opencode) are omitted rather than guessed.
 */
export const AGENT_TOKEN_ESTIMATES: Partial<
  Record<AgentTokenLevel, Partial<Record<AgentTokenHarness, AgentTokenEstimate>>>
> = {
  low: {
    claudeCode: { tokensPct: -3, usagePct: -1, measuredAt: "2026-11-27", runs: 6 },
    codex: { tokensPct: -17, usagePct: -8, measuredAt: "2026-11-27", runs: 6 },
    antigravity: { tokensPct: 8, usagePct: 7, measuredAt: "2026-11-27", runs: 6 },
  },
  default: {
    claudeCode: { tokensPct: 21, usagePct: 11, measuredAt: "2026-11-27", runs: 6 },
    codex: { tokensPct: 21, usagePct: 13, measuredAt: "2026-11-27", runs: 6 },
    antigravity: { tokensPct: 27, usagePct: 11, measuredAt: "2026-11-27", runs: 6 },
  },
  high: {
    claudeCode: { tokensPct: 17, usagePct: 14, measuredAt: "2026-11-27", runs: 6 },
    codex: { tokensPct: 6, usagePct: 0, measuredAt: "2026-11-27", runs: 6 },
    antigravity: { tokensPct: 39, usagePct: 16, measuredAt: "2026-11-27", runs: 6 },
  },
};

/**
 * Whether Settings shows the cost line. Off until the table is re-measured on realistic-length
 * work: these rows come from 20–40 s tasks, where SSHCode's fixed prefix dominates and the
 * percentages overstate normal use (real chats measured ~1% SSHCode text on 11-18).
 */
export const AGENT_TOKEN_ESTIMATES_SHOWN = false;

export function agentTokenEstimate(
  level: AgentTokenLevel,
  harness: AgentTokenHarness,
): AgentTokenEstimate | null {
  return AGENT_TOKEN_ESTIMATES[level]?.[harness] ?? null;
}
