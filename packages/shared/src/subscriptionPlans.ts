/**
 * What flat-price plans cost a month, for working out what a model really costs
 * someone who is on one. Public list prices gathered on `PLAN_PRICES_AS_OF`,
 * matched by the name the provider gives the plan. A price the user enters
 * always wins: only they know what they pay.
 *
 * Sources (read 2026-11-10):
 * - Claude Pro $20, Max 5x $100, Max 20x $200: support.claude.com/en/articles/11049744
 * - Claude Ultra $200 (the renamed Max 20x): support.claude.com/en/articles/17728952
 * - ChatGPT Go $8, Plus $20, Pro $100 and $200: OpenAI's April 2026 plan announcement
 * - OpenCode Go $10 with $60 of usage a month: opencode.ai/docs/go
 * - Mistral Vibe Pro $14.99: mistral.ai/pricing
 *
 * @module subscriptionPlans
 */
export const PLAN_PRICES_AS_OF = "2026-11-10";

export interface KnownPlan {
  readonly label: string;
  readonly monthlyUsd: number;
  /** A month of work at API rates the plan promises, where it says so. */
  readonly includedMonthlyUsd?: number;
}

export interface PlanClues {
  /** The provider driver, such as `codex`. */
  readonly driver: string;
  /** How the provider names the signed-in plan, such as `ChatGPT Pro 10x Subscription`. */
  readonly planLabel?: string;
  readonly displayName?: string;
  /** Ids of the usage limit windows the instance reports. */
  readonly windowIds: ReadonlyArray<string>;
}

interface Rule {
  readonly driver: string;
  readonly match: RegExp;
  readonly monthlyUsd: number;
}

// First match wins, so the more specific names come first.
const RULES: ReadonlyArray<Rule> = [
  { driver: "claudeAgent", match: /\bultra\b|\bmax 20x\b/, monthlyUsd: 200 },
  { driver: "claudeAgent", match: /\bmax\b/, monthlyUsd: 100 },
  { driver: "claudeAgent", match: /\bpro\b/, monthlyUsd: 20 },
  { driver: "codex", match: /\bpro 20x\b/, monthlyUsd: 200 },
  { driver: "codex", match: /\bpro (?:5x|10x)\b/, monthlyUsd: 100 },
  { driver: "codex", match: /\bplus\b/, monthlyUsd: 20 },
  { driver: "codex", match: /\bgo\b/, monthlyUsd: 8 },
];

/** A plan label without the word every provider ends it with. */
export function planName(planLabel: string | undefined): string | undefined {
  if (planLabel === undefined || !/\bsubscription$/i.test(planLabel.trim())) return undefined;
  const name = planLabel.trim().replace(/\s*subscription$/i, "");
  return name === "" ? undefined : name;
}

/** The plan an instance is on and its list price, when the clues name one this table knows. */
export function knownPlan(clues: PlanClues): KnownPlan | undefined {
  const name = planName(clues.planLabel);
  if (name !== undefined) {
    const lower = name.toLowerCase();
    const rule = RULES.find((entry) => entry.driver === clues.driver && entry.match.test(lower));
    if (rule) return { label: name, monthlyUsd: rule.monthlyUsd };
  }
  if (clues.driver === "opencode" && clues.windowIds.some((id) => id.startsWith("go_"))) {
    return { label: "OpenCode Go", monthlyUsd: 10, includedMonthlyUsd: 60 };
  }
  if (/\bmistral\b.*\bvibe\b/i.test(clues.displayName ?? "")) {
    return { label: "Mistral Vibe Pro", monthlyUsd: 14.99 };
  }
  return undefined;
}

/**
 * How much a plan allows next to its provider's smallest paid plan, where its
 * name says so: a "20x" plan allows twice a "10x" one and "Max 20x" four times
 * "Max 5x", whatever each costs. Undefined when the name does not say.
 */
export function planAllowance(clues: Pick<PlanClues, "driver" | "planLabel">): number | undefined {
  const name = planName(clues.planLabel)?.toLowerCase();
  if (name === undefined) return undefined;
  const times = /\b(\d{1,3})x\b/.exec(name);
  if (times) return Number(times[1]);
  if (clues.driver === "claudeAgent") {
    // Ultra is the renamed Max 20x; a bare Max is the 5x plan.
    if (/\bultra\b/.test(name)) return 20;
    if (/\bmax\b/.test(name)) return 5;
    if (/\bpro\b/.test(name)) return 1;
  }
  if (clues.driver === "codex" && /\bplus\b/.test(name)) return 1;
  return undefined;
}
