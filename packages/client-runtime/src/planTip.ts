import type { ServerProvider } from "@t3tools/contracts";
import { accountSwitchTip } from "@t3tools/shared/accountBalance";
import { betterPlanTip, type PlanTip } from "@t3tools/shared/planTip";

import { groupModelsByMaker } from "./modelMakers.ts";

const PLAN_TIP_DURATION_MS = 12_000;

export interface PlanTipDisplay {
  readonly key: string;
  readonly expiresAt: number;
}

export function planTipKey(
  chatKey: string,
  tip: Pick<PlanTip, "fromInstanceId" | "toInstanceId">,
): string {
  return JSON.stringify([chatKey, tip.fromInstanceId, tip.toInstanceId]);
}

/** A blocked or closed tip stays closed; new chats and directional pairs are independent. */
export function nextPlanTipDisplay(
  key: string | null,
  active: PlanTipDisplay | null,
  blocked: boolean,
  seen: ReadonlySet<string>,
  now: number,
): PlanTipDisplay | null {
  if (key === null || blocked) return null;
  if (active?.key === key) return now < active.expiresAt ? active : null;
  return seen.has(key) ? null : { key, expiresAt: now + PLAN_TIP_DURATION_MS };
}

/** Each account by the name the model picker gives it for `model`. */
function planLabels(providers: ReadonlyArray<ServerProvider>, model: string) {
  const sources = providers.flatMap((provider) =>
    provider.models
      .filter((entry) => entry.slug === model)
      .map((entry) => ({
        ...entry,
        instanceId: provider.instanceId,
        driver: provider.driver,
        instanceName: provider.displayName ?? provider.instanceId,
      })),
  );
  const routes = groupModelsByMaker(sources).flatMap((group) =>
    group.models.flatMap((entry) => entry.routes),
  );
  return (instanceId: string) =>
    routes.find((route) => route.source.instanceId === instanceId)?.label ??
    providers.find((provider) => provider.instanceId === instanceId)?.displayName ??
    instanceId;
}

/** Use the picker's plan naming, including its own-account name beside a numbered plan. */
export function planTipCopy(providers: ReadonlyArray<ServerProvider>, model: string, tip: PlanTip) {
  const label = planLabels(providers, model);
  const from = label(tip.fromInstanceId);
  const to = label(tip.toInstanceId);
  const message =
    tip.reason === "limit-reached"
      ? `${from} is at its ${tip.windowLabel} limit. ${to} has ${tip.toRemainingPercent}% left.`
      : `${to} has more room for this model: ${tip.toRemainingPercent}% left, ${tip.fromRemainingPercent}% here.`;
  return { from, to, message };
}

/**
 * The chat's own model on the user's other plan, when this plan is at or near
 * its limit for that model and the other has room. Both plans keep the same
 * chats, so it is the closest way for a stopped chat to carry on.
 */
export function continueOnOtherPlan(
  balanceAccounts: boolean,
  providers: ReadonlyArray<ServerProvider>,
  selection: { readonly instanceId: string; readonly model: string },
  now?: number,
): { readonly instanceId: string; readonly label: string } | null {
  if (!balanceAccounts) return null;
  const tip = betterPlanTip(
    providers,
    selection,
    now === undefined ? undefined : { now, newSession: false },
  );
  if (tip === null) return null;
  return { instanceId: tip.toInstanceId, label: planTipCopy(providers, selection.model, tip).to };
}

/**
 * The tip for a chat that already runs: its account is nearly out for the chat's model and
 * another of the user's accounts has room. Offered, never done, and closed for good per chat.
 */
export function runningChatAccountTip(
  providers: ReadonlyArray<ServerProvider>,
  selection: { readonly instanceId: string; readonly model: string },
  now: number,
  accepts?: (provider: ServerProvider) => boolean,
): { readonly toInstanceId: string; readonly to: string; readonly message: string } | null {
  const nameOf = planLabels(providers, selection.model);
  const tip = accountSwitchTip(providers, selection, { now, nameOf, accepts });
  return tip === null
    ? null
    : { toInstanceId: tip.toInstanceId, to: nameOf(tip.toInstanceId), message: `${tip.reason}.` };
}
