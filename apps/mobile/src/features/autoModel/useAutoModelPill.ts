import type { AutoModelRecommendation } from "@t3tools/shared/autoModel/recommendAutoModel";
import { useCallback, useEffect, useState } from "react";

export const AUTO_MODEL_ACKNOWLEDGE_MS = 650;
export const AUTO_MODEL_FADE_MS = 180;
/** How long "Staying on <model>" reads before it fades. */
export const AUTO_MODEL_WITHDRAWN_NOTE_MS = 1800;

/**
 * Keeps the last label through its exit, including a tier change that removes the suggestion.
 * A suggestion on screen that the next evaluation takes back (the prompt grew into something
 * the current model suits, or one the classifier is unsure about) first says so: `withdrawn`.
 * Vanishing without a word read as Auto having stopped working. Dismissing, taking or sending
 * (`allowed` false) still just fades.
 */
export function useAutoModelPill(
  recommendation: AutoModelRecommendation | null,
  allowed: boolean,
  explainWithdrawal = false,
) {
  const [state, setState] = useState(() => ({
    input: recommendation,
    allowed,
    displayed: allowed ? recommendation : null,
    acknowledged: false,
    withdrawn: false,
    exiting: false,
  }));
  if (state.input !== recommendation || state.allowed !== allowed) {
    const change = state.acknowledged
      ? {}
      : allowed && recommendation
        ? { displayed: recommendation, withdrawn: false, exiting: false }
        : allowed && explainWithdrawal && state.displayed !== null && !state.exiting
          ? { withdrawn: true }
          : { withdrawn: state.withdrawn && state.exiting, exiting: true };
    setState({ ...state, input: recommendation, allowed, ...change });
  }
  useEffect(() => {
    if (!state.acknowledged) return;
    const timer = setTimeout(
      () => setState((previous) => ({ ...previous, exiting: true })),
      AUTO_MODEL_ACKNOWLEDGE_MS,
    );
    return () => clearTimeout(timer);
  }, [state.acknowledged]);
  useEffect(() => {
    if (!state.withdrawn || state.exiting) return;
    const timer = setTimeout(
      () => setState((previous) => ({ ...previous, exiting: true })),
      AUTO_MODEL_WITHDRAWN_NOTE_MS,
    );
    return () => clearTimeout(timer);
  }, [state.withdrawn, state.exiting]);
  useEffect(() => {
    if (!state.exiting) return;
    const timer = setTimeout(() => {
      setState((previous) => ({
        ...previous,
        displayed: null,
        acknowledged: false,
        withdrawn: false,
        exiting: false,
      }));
    }, AUTO_MODEL_FADE_MS);
    return () => clearTimeout(timer);
  }, [state.exiting]);
  const acknowledge = useCallback(
    () => setState((previous) => ({ ...previous, acknowledged: true })),
    [],
  );
  return {
    displayed: state.displayed,
    acknowledged: state.acknowledged,
    withdrawn: state.withdrawn,
    exiting: state.exiting,
    acknowledge,
  };
}
