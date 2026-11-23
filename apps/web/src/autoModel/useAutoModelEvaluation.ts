import { useEffect, useRef } from "react";
import {
  classifyTaskDifficulty,
  type TaskDifficulty,
} from "@t3tools/shared/autoModel/classifyTaskDifficulty";
import {
  recommendAutoModel,
  type AutoModelRecommendation,
  type RecommendAutoModelInput,
} from "@t3tools/shared/autoModel/recommendAutoModel";

const selectionKey = (selection: { instanceId: string; model: string } | null) =>
  selection ? `${selection.instanceId}\0${selection.model}` : "";

/** A decision model answers in about 0.3s; after this the local model's word is shown. */
const DECISION_WAIT_MS = 1500;
/** What the server sends on; longer drafts are judged by their start. */
const DECISION_TEXT_LIMIT = 2500;

/**
 * Classifies 400ms after the draft stops changing. Only the draft's own text, attachments and
 * model restart that wait, plus the evidence arriving: other chats updating or a provider
 * refresh hand this hook new arrays all the time, and restarting on those meant the wait never
 * ended while other chats were busy. Everything else is read when the timer fires.
 *
 * With `decide`, the server's decision model is asked first and its answer is combined with
 * the local model's. No answer in time, or none at all, and the local model decides alone;
 * an answer that arrives late still corrects the suggestion while the draft is unchanged.
 */
export function useAutoModelEvaluation(
  input: Omit<RecommendAutoModelInput, "difficulty" | "now" | "history"> & {
    enabled: boolean;
    /** Read when the evaluation runs, so the chat list is not a render dependency. */
    getHistory: () => RecommendAutoModelInput["history"];
    /** Resolves to the decision model's probability that a quick model is enough, or null. */
    decide?:
      | ((input: { text: string; attachmentCount: number }) => Promise<number | null>)
      | undefined;
    onEvaluation: (
      difficulty: TaskDifficulty | null,
      recommendation: AutoModelRecommendation | null,
    ) => void;
  },
) {
  const latest = useRef(input);
  useEffect(() => {
    latest.current = input;
  });
  const { enabled, text, attachmentCount } = input;
  const current = selectionKey(input.currentSelection);
  const evidence = [
    input.candidates.length,
    selectionKey(input.picks.quality),
    selectionKey(input.picks.speed),
    selectionKey(input.picks.frugal),
  ].join("|");
  useEffect(() => {
    if (!enabled) return;
    let stale = false;
    let waiting: number | undefined;
    const evaluate = (decisionQuick?: number) => {
      const now = latest.current;
      const difficulty = classifyTaskDifficulty({ text, attachmentCount, decisionQuick });
      now.onEvaluation(
        difficulty,
        recommendAutoModel({
          difficulty,
          text,
          attachmentCount,
          currentSelection: now.currentSelection,
          candidates: now.candidates,
          history: now.getHistory(),
          picks: now.picks,
          now: Date.now(),
        }),
      );
    };
    const timer = window.setTimeout(() => {
      if (text.trim().length < 12 && attachmentCount === 0) {
        latest.current.onEvaluation(null, null);
        return;
      }
      const decide = latest.current.decide;
      if (!decide) {
        evaluate();
        return;
      }
      let shown = false;
      waiting = window.setTimeout(() => {
        shown = true;
        evaluate();
      }, DECISION_WAIT_MS);
      void decide({ text: text.trim().slice(0, DECISION_TEXT_LIMIT), attachmentCount })
        .catch(() => null)
        .then((quick) => {
          if (stale) return;
          window.clearTimeout(waiting);
          if (quick !== null) evaluate(quick);
          else if (!shown) evaluate();
        });
    }, 400);
    return () => {
      stale = true;
      window.clearTimeout(timer);
      window.clearTimeout(waiting);
    };
  }, [enabled, text, attachmentCount, current, evidence]);
}
