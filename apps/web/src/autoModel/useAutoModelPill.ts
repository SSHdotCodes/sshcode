import { useEffect, useState } from "react";
import type { AutoModelRecommendation } from "@t3tools/shared/autoModel/recommendAutoModel";

/** How long "Staying on <model>" reads before it fades. */
export const WITHDRAWN_NOTE_MS = 1800;

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
    const timer = window.setTimeout(
      () => setState((previous) => ({ ...previous, exiting: true })),
      650,
    );
    return () => window.clearTimeout(timer);
  }, [state.acknowledged]);
  useEffect(() => {
    if (!state.withdrawn || state.exiting) return;
    const timer = window.setTimeout(
      () => setState((previous) => ({ ...previous, exiting: true })),
      WITHDRAWN_NOTE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [state.withdrawn, state.exiting]);
  useEffect(() => {
    if (!state.exiting) return;
    const timer = window.setTimeout(() => {
      setState((previous) => ({
        ...previous,
        displayed: null,
        acknowledged: false,
        withdrawn: false,
        exiting: false,
      }));
    }, 180);
    return () => window.clearTimeout(timer);
  }, [state.exiting]);
  return {
    displayed: state.displayed,
    acknowledged: state.acknowledged,
    withdrawn: state.withdrawn,
    exiting: state.exiting,
    acknowledge: () => setState((previous) => ({ ...previous, acknowledged: true })),
  };
}
