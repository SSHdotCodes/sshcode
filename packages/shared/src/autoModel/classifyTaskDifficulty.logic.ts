import { taskFastProbability } from "./taskDifficultyModel.ts";
import { taskDifficultyWeights } from "./weights/taskDifficulty.ts";

export type TaskDifficulty = { tier: "fast" | "big"; confidence: number };

/** Callers act on a tier only at or above this confidence. */
export const TASK_DIFFICULTY_CONFIDENT = 0.7;

/** With a decision model's answer: suggest "fast" at or above, "big" at or below. */
const DECIDED_FAST_AT = 0.8;
const DECIDED_BIG_AT = 0.25;

const logOdds = (probability: number) => {
  const bounded = Math.min(Math.max(probability, 1e-3), 1 - 1e-3);
  return Math.log(bounded / (1 - bounded));
};

/**
 * Whether the first message of a new chat is a simple task a fast model can do, or
 * needs the big model. A tiny local model trained on how much work the owner's past
 * requests took (scripts/auto-model). It only speaks up at the two ends: a probability
 * between the model's `bigAt` and `fastAt` answers "big" below the confident mark, so
 * nothing is suggested and the current model stays.
 *
 * `decisionQuick` is an outside decision model's probability that a quick model is
 * enough, when the server could ask one. The two are averaged as log-odds: the local
 * model knows the owner's habits, the decision model understands phrasing the local
 * one never saw. Measured on 133 of the owner's first messages (out-of-fold for the
 * local model): local alone 6 simple suggestions (6 right) and 67 hard (64 right);
 * together 32 simple (31 right) and 59 hard (59 right). The decision model alone
 * calling a task hard was never wrong there, so that call stands by itself.
 */
export function classifyTaskDifficulty(input: {
  text: string;
  attachmentCount: number;
  decisionQuick?: number | undefined;
}): TaskDifficulty {
  const { fastAt, bigAt } = taskDifficultyWeights;
  const fast = taskFastProbability(input.text, input.attachmentCount);
  const spread = 1 - TASK_DIFFICULTY_CONFIDENT;
  const decision = input.decisionQuick;
  if (decision !== undefined && Number.isFinite(decision)) {
    const both = 1 / (1 + Math.exp(-(logOdds(fast) + logOdds(decision)) / 2));
    const lowest = Math.min(both, decision);
    if (lowest <= DECIDED_BIG_AT) {
      return {
        tier: "big",
        confidence:
          TASK_DIFFICULTY_CONFIDENT + (spread * (DECIDED_BIG_AT - lowest)) / DECIDED_BIG_AT,
      };
    }
    if (both >= DECIDED_FAST_AT) {
      return {
        tier: "fast",
        confidence:
          TASK_DIFFICULTY_CONFIDENT + (spread * (both - DECIDED_FAST_AT)) / (1 - DECIDED_FAST_AT),
      };
    }
    return { tier: "big", confidence: 0.5 };
  }
  if (fast >= fastAt) {
    return {
      tier: "fast",
      confidence: TASK_DIFFICULTY_CONFIDENT + (spread * (fast - fastAt)) / (1 - fastAt),
    };
  }
  if (fast <= bigAt) {
    return {
      tier: "big",
      confidence: TASK_DIFFICULTY_CONFIDENT + (spread * (bigAt - fast)) / bigAt,
    };
  }
  return { tier: "big", confidence: 0.5 };
}
