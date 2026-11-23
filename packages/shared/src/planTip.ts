import type { ServerProvider } from "@t3tools/contracts";

import {
  type AccountSelection,
  accountPool,
  pickAccountForNewSession,
  usageWindowsForModel,
} from "./accountBalance.ts";
import { isUsageWindowLimited, remainingPercent } from "./usageLimits.ts";

export interface PlanTip {
  readonly fromInstanceId: string;
  readonly toInstanceId: string;
  readonly reason: "limit-reached" | "more-room";
  readonly windowLabel: string;
  readonly fromRemainingPercent: number;
  readonly toRemainingPercent: number;
}

/** How much of an account's tightest limit is left for a model; null when it reports none. */
export function planHeadroom(provider: ServerProvider, model: string) {
  let tightest: { remaining: number; label: string } | null = null;
  for (const window of usageWindowsForModel(provider, model)) {
    const remaining = isUsageWindowLimited(window) ? 0 : remainingPercent(window);
    if (tightest === null || remaining < tightest.remaining) {
      tightest = { remaining, label: window.label };
    }
  }
  return tightest;
}

/**
 * Suggest a roomier account that can continue this chat; never change its route.
 *
 * With `newSession` (a chat not sent yet) the tip has to agree with where new sessions
 * start: none while that is the chat's own account, and otherwise that account. An
 * account with little left can still be the right start when its unused share expires
 * within hours, and a tip to leave it would contradict the app's own choice.
 */
export function betterPlanTip(
  providers: ReadonlyArray<ServerProvider>,
  selection: AccountSelection,
  newSession?: { readonly now: number },
): PlanTip | null {
  const [from, ...others] = accountPool(providers, selection);
  if (from?.instanceId !== selection.instanceId) return null;
  const pick = newSession && pickAccountForNewSession(providers, selection, newSession);
  if (pick && pick.instanceId === selection.instanceId) return null;
  const siblings = pick
    ? others.filter((provider) => provider.instanceId === pick.instanceId)
    : others;
  const current = planHeadroom(from, selection.model);
  if (current === null || current.remaining > 20) return null;

  let best: { provider: ServerProvider; remaining: number } | null = null;
  for (const provider of siblings) {
    const candidate = planHeadroom(provider, selection.model);
    if (candidate !== null && (best === null || candidate.remaining > best.remaining)) {
      best = { provider, remaining: candidate.remaining };
    }
  }
  if (best === null) return null;
  const reason =
    current.remaining === 0 && best.remaining > 0
      ? "limit-reached"
      : best.remaining >= current.remaining + 30
        ? "more-room"
        : null;
  return reason === null
    ? null
    : {
        fromInstanceId: from.instanceId,
        toInstanceId: best.provider.instanceId,
        reason,
        windowLabel: current.label,
        fromRemainingPercent: current.remaining,
        toRemainingPercent: best.remaining,
      };
}
