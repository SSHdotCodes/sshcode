import type { SessionBoxAttention } from "./taxonomy.ts";

/**
 * Ranks chats by how much they need the user now. A linear score over a handful of
 * features; the weights were fit to which chat the user actually turned to next (see
 * `./models.ts`), and default to hand-set ones.
 */
export interface NeedsYouInput {
  /** An approval, question or secret the agent is blocked on. */
  readonly pendingRequest: "approval" | "user_input" | "secret" | null;
  /** What the agent's last reply asks, when its run has ended. */
  readonly attention: SessionBoxAttention | null;
  readonly working: boolean;
  readonly failed: boolean;
  readonly limited: boolean;
  /** Finished since the user last opened it. */
  readonly unseen: boolean;
  readonly hasActionablePlan: boolean;
  readonly hasUnsentDraft: boolean;
  readonly pinned: boolean;
  /** Milliseconds since epoch, or null. */
  readonly completedAt: number | null;
  readonly lastUserMessageAt: number | null;
  readonly createdAt: number;
  readonly now: number;
}

export const NEEDS_YOU_FEATURES = [
  "bias",
  "pending_approval",
  "pending_input",
  "pending_secret",
  "attention_question",
  "attention_decision",
  "attention_blocked",
  "attention_review",
  "attention_done",
  "attention_progress",
  "unseen",
  "unseen_recent",
  "failed",
  "limited",
  "working",
  "plan",
  "draft",
  "pinned",
  "log_hours_since_done",
  "log_hours_since_user",
  "log_hours_since_created",
] as const;
export type NeedsYouFeature = (typeof NEEDS_YOU_FEATURES)[number];

const HOUR = 3_600_000;
const hoursSince = (time: number | null, now: number) =>
  time === null ? 24 * 30 : Math.max(0, (now - time) / HOUR);

export function needsYouFeatures(input: NeedsYouInput): Record<NeedsYouFeature, number> {
  const sinceDone = hoursSince(input.completedAt, input.now);
  const flag = (value: boolean) => (value ? 1 : 0);
  return {
    bias: 1,
    pending_approval: flag(input.pendingRequest === "approval"),
    pending_input: flag(input.pendingRequest === "user_input"),
    pending_secret: flag(input.pendingRequest === "secret"),
    attention_question: flag(input.attention === "question"),
    attention_decision: flag(input.attention === "decision"),
    attention_blocked: flag(input.attention === "blocked"),
    attention_review: flag(input.attention === "review"),
    attention_done: flag(input.attention === "done"),
    attention_progress: flag(input.attention === "progress"),
    unseen: flag(input.unseen),
    unseen_recent: input.unseen ? Math.exp(-sinceDone / 12) : 0,
    failed: flag(input.failed),
    limited: flag(input.limited),
    working: flag(input.working),
    plan: flag(input.hasActionablePlan),
    draft: flag(input.hasUnsentDraft),
    pinned: flag(input.pinned),
    log_hours_since_done: Math.log1p(sinceDone),
    log_hours_since_user: Math.log1p(hoursSince(input.lastUserMessageAt, input.now)),
    log_hours_since_created: Math.log1p(hoursSince(input.createdAt, input.now)),
  };
}

/** Hand-set weights: blocked on you first, then asks, failures, unseen results, the rest. */
export const DEFAULT_NEEDS_YOU_WEIGHTS: Record<NeedsYouFeature, number> = {
  bias: 0,
  pending_approval: 9,
  pending_input: 9,
  pending_secret: 8.5,
  attention_question: 4,
  attention_decision: 4.5,
  attention_blocked: 5,
  attention_review: 2,
  attention_done: 0.5,
  attention_progress: -0.5,
  unseen: 2,
  unseen_recent: 1.5,
  failed: 3,
  limited: 1,
  working: -1,
  plan: 3.5,
  draft: 1.5,
  pinned: 1,
  log_hours_since_done: -0.6,
  log_hours_since_user: -0.3,
  log_hours_since_created: -0.1,
};

export const needsYouModel: { weights: Record<NeedsYouFeature, number> } = {
  weights: DEFAULT_NEEDS_YOU_WEIGHTS,
};

export function needsYouScore(input: NeedsYouInput): number {
  const features = needsYouFeatures(input);
  let score = 0;
  for (const name of NEEDS_YOU_FEATURES) score += features[name] * needsYouModel.weights[name];
  return score;
}

/** Why a chat needs the user, for the box's label; null when it doesn't. */
export type NeedsYouReason =
  | "approval"
  | "question"
  | "secret"
  | "decision"
  | "blocked"
  | "plan"
  | "failed"
  | "results";

export function needsYouReason(input: NeedsYouInput): NeedsYouReason | null {
  if (input.pendingRequest === "approval") return "approval";
  if (input.pendingRequest === "user_input") return "question";
  if (input.pendingRequest === "secret") return "secret";
  if (input.working) return null;
  if (input.hasActionablePlan) return "plan";
  // What the last reply said only holds a chat while the user hasn't seen it: once they
  // have looked and moved on, they chose not to answer.
  if (!input.unseen) return null;
  if (input.failed) return "failed";
  // A reply's wording waits for a look, not for the user: questions they must answer come
  // as cards (pending requests above), and replies read as "blocked" or "asking" were
  // mostly reports and offers ("want me to also…?").
  if (input.attention !== null && input.attention !== "progress" && input.attention !== "done")
    return "results";
  return null;
}
