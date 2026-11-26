import { useSyncExternalStore } from "react";

let focusedPlan: string | null = null;
const listeners = new Set<() => void>();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function setFocusedPlan(plan: string | null) {
  if (focusedPlan === plan) return;
  focusedPlan = plan;
  for (const listener of listeners) listener();
}

/** Asks the Usage page to open on Limits with this plan (a limit pool's key) in view. */
export const focusUsageLimitsPlan = (plan: string) => setFocusedPlan(plan);

/** Once the plan is on screen, or the page that would show it is gone. */
export const clearUsageLimitsFocus = () => setFocusedPlan(null);

/** The plan Usage was asked to show, until it has. */
export function useUsageLimitsFocus(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => focusedPlan,
    () => null,
  );
}

/** The DOM id of a plan's section on the Limits tab. */
export const usageLimitsPlanId = (plan: string) =>
  `usage-limits-plan-${plan.replace(/[^a-zA-Z0-9]+/gu, "-")}`;
