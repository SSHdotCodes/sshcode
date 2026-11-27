/**
 * The picker's side of account balancing: which of the user's accounts of one
 * provider a model's row opens on, and which picks are worth remembering.
 *
 * @module accountRoutes
 */
import type { ServerProvider } from "@t3tools/contracts";
import {
  type AccountSelection,
  type AccountStanding,
  accountPickSummary,
  accountStandingForModel,
  accountPool,
  byRoomForNewSessions,
  pickAccountForNewSession,
} from "@t3tools/shared/accountBalance";

import {
  modelRouteHasSlug,
  type ModelRoute,
  type ModelRouteRef,
  type ModelRouteSource,
} from "./modelMakers.ts";

/** The chat a route is being chosen for. */
export interface AccountRouteSession {
  readonly now: number;
  /** Selected options only belong to this model and its own account pool. */
  readonly selection?: AccountSelection | null | undefined;
  /**
   * The account the chat stays on: the one a running chat is on, or the one the user put a
   * new chat on by hand (its account pin). Null or absent for a new chat nobody chose an
   * account for, which starts on the account with the most to spare. A running chat keeps
   * its account when its model changes, since another account would re-read the chat
   * without its cache. A model that account cannot run is chosen as for a new chat.
   */
  readonly instanceId?: string | null | undefined;
  /** False where the user picks accounts by hand: nothing moves to the account with room. */
  readonly balance?: boolean | undefined;
}

/**
 * Whether a chat's account is still one the user picked by hand, after a pick. An account
 * is picked where accounts are listed by name (Runs in, the Usage card). A model picked
 * afterwards keeps the pin while it stays on that account; a model picked alone never sets
 * it, so the chat follows the balance until it is sent.
 */
export function accountPinAfterPick(input: {
  readonly pinned: boolean;
  readonly previousInstanceId: string | null | undefined;
  readonly nextInstanceId: string;
  /** The pick named the account, not only the model. */
  readonly accountPick: boolean;
}): boolean {
  return input.accountPick || (input.pinned && input.previousInstanceId === input.nextInstanceId);
}

/** The `account` step for `defaultModelRoute`. */
export function accountRouteStep<T extends ModelRouteSource>(
  providers: ReadonlyArray<ServerProvider>,
  session: AccountRouteSession,
): (route: ModelRoute<T>, candidates: ReadonlyArray<ModelRoute<T>>) => ModelRoute<T> | null {
  return (route, candidates) => {
    const selection = { instanceId: route.source.instanceId, model: route.source.slug };
    const onAccount = (instanceId: string) =>
      candidates.find(
        (candidate) =>
          candidate.source.instanceId === instanceId &&
          candidate.sources.some((source) => source.slug === selection.model),
      ) ?? null;
    const current = session.instanceId;
    if (current !== null && current !== undefined) {
      if (current === selection.instanceId) return null;
      const kept = accountPool(providers, selection).some(
        (provider) => provider.instanceId === current,
      )
        ? onAccount(current)
        : null;
      if (kept !== null) return kept;
    }
    if (session.balance === false) return null;
    const active = session.selection;
    const selected =
      active?.options?.length &&
      active.model === selection.model &&
      onAccount(active.instanceId) &&
      accountPool(providers, selection).some(
        (provider) => provider.instanceId === active.instanceId,
      )
        ? active
        : selection;
    const pick = pickAccountForNewSession(providers, selected, {
      now: session.now,
      accepts: (provider) => onAccount(provider.instanceId) !== null,
    });
    const instanceId = pick?.instanceId ?? selected.instanceId;
    return instanceId !== selection.instanceId ? onAccount(instanceId) : null;
  };
}

/** Whether two routes are the user's accounts of one provider, for `rememberChosenModelRoute`. */
export function sameAccountPool(
  providers: ReadonlyArray<ServerProvider>,
): (left: ModelRouteRef, right: ModelRouteRef) => boolean {
  return (left, right) =>
    left.instanceId !== right.instanceId &&
    accountPool(providers, { instanceId: left.instanceId, model: left.slug }).some(
      (provider) => provider.instanceId === right.instanceId,
    );
}

/**
 * Where each of the user's accounts stands for a model, for the rows that let
 * them pick one: empty when the model runs on a single account.
 */
export function accountStandings(
  providers: ReadonlyArray<ServerProvider>,
  selection: AccountSelection,
  now: number,
  nameOf: (instanceId: string) => string = (instanceId) => instanceId,
  /** Leaves out accounts a new chat could not start the model on. */
  accepts?: (provider: ServerProvider) => boolean,
): {
  readonly pickedInstanceId: string | null;
  readonly byInstance: ReadonlyMap<string, AccountStanding>;
  /** For under the account rows of a new chat: "New chats start on Personal: it has …." */
  readonly newChatNote: string | null;
} {
  const pick = pickAccountForNewSession(providers, selection, { now, accepts });
  // The named rows remain available for an intentional change of account and options.
  const rows = selection.options?.length
    ? pickAccountForNewSession(
        providers,
        { instanceId: selection.instanceId, model: selection.model },
        { now, accepts },
      )
    : pick;
  const why = pick === null ? null : accountPickSummary(pick, nameOf);
  return {
    pickedInstanceId: pick?.instanceId ?? null,
    byInstance: new Map((rows?.standings ?? []).map((standing) => [standing.instanceId, standing])),
    newChatNote:
      pick === null || why === null
        ? null
        : `New chats start on ${nameOf(pick.instanceId)}: ${why}.`,
  };
}

/**
 * `items` with the user's accounts of one provider listed the way new sessions prefer them,
 * the one with the most to spare first. Anything that is not one of those accounts keeps
 * its place. The order does not follow the account a chat is on, so rows hold still when
 * the chat moves between them.
 */
export function accountsByRoom<T>(
  items: ReadonlyArray<T>,
  instanceIdOf: (item: T) => string,
  byInstance: ReadonlyMap<string, AccountStanding> | null | undefined,
): ReadonlyArray<T> {
  if (!byInstance || byInstance.size < 2) return items;
  const slots: number[] = [];
  items.forEach((item, index) => {
    if (byInstance.has(instanceIdOf(item))) slots.push(index);
  });
  if (slots.length < 2) return items;
  const ordered = slots
    .map((slot) => items[slot]!)
    .sort((left, right) =>
      byRoomForNewSessions(
        byInstance.get(instanceIdOf(left))!,
        byInstance.get(instanceIdOf(right))!,
      ),
    );
  const result = items.slice();
  slots.forEach((slot, index) => {
    result[slot] = ordered[index]!;
  });
  return result;
}

/** Sort each provider's accounts within their existing route slots. */
export function rankAccountRoutes<T extends ModelRouteSource>(
  routes: ReadonlyArray<ModelRoute<T>>,
  providers: ReadonlyArray<ServerProvider>,
  selection: AccountSelection | null,
  now: number,
  available: (route: ModelRoute<T>) => boolean,
) {
  const active =
    selection &&
    routes.find((route) =>
      modelRouteHasSlug(route, {
        instanceId: selection.instanceId,
        slug: selection.model,
      }),
    );
  const byRoute = new Map<string, AccountStanding>();
  let ordered = routes;
  let newChatNote: string | null = null;
  for (const route of active ? [active, ...routes] : routes) {
    if (byRoute.has(route.key)) continue;
    const asked =
      route === active && selection
        ? selection
        : {
            instanceId: route.source.instanceId,
            model: route.source.slug,
          };
    const matching = routes.filter(
      (candidate) =>
        candidate.sources.some((source) => source.slug === asked.model) && available(candidate),
    );
    const allowed = new Set(matching.map((candidate) => candidate.source.instanceId));
    const pool = accountStandings(
      providers,
      asked,
      now,
      (id) => matching.find((candidate) => candidate.source.instanceId === id)?.label ?? id,
      (provider) => allowed.has(provider.instanceId),
    );
    if (!pool.byInstance.size) continue;
    if (byRoute.size === 0) newChatNote = pool.newChatNote;
    const group = new Map<string, AccountStanding>();
    for (const candidate of matching) {
      const standing = pool.byInstance.get(candidate.source.instanceId);
      if (standing && !byRoute.has(candidate.key)) {
        group.set(candidate.key, standing);
        byRoute.set(candidate.key, standing);
      }
    }
    ordered = accountsByRoom(ordered, (candidate) => candidate.key, group);
  }
  return { routes: ordered, byRoute, newChatNote };
}

// Made on first use, so reset times follow the viewer's time zone at that moment.
let resetFormats:
  | {
      readonly time: Intl.DateTimeFormat;
      readonly weekday: Intl.DateTimeFormat;
      readonly day: Intl.DateTimeFormat;
    }
  | undefined;
const resetFormat = () =>
  (resetFormats ??= {
    time: new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
    weekday: new Intl.DateTimeFormat("en-US", { weekday: "short" }),
    day: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }),
  });
const HOUR = 3_600_000;

/** On the viewer's clock: "Fri", "7 AM" within the day, "Nov 23" past the week; null
    without a reset still to come. */
export function accountResetLabel(resetsAt: string | undefined, now: number): string | null {
  const at = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt);
  if (!Number.isFinite(at) || at <= now) return null;
  const format = resetFormat();
  if (at - now < 18 * HOUR) return format.time.format(at).replace(":00", "");
  return at - now < 6.5 * 24 * HOUR ? format.weekday.format(at) : format.day.format(at);
}

/**
 * A route's own standing when it is not one of the user's pooled accounts, so its row can
 * still say what it has left. Undefined when the provider is not listed.
 */
export function routeStanding(
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string,
  model: string,
  now: number,
): AccountStanding | undefined {
  const provider = providers.find((entry) => entry.instanceId === instanceId);
  return provider === undefined ? undefined : accountStandingForModel(provider, model, now);
}

/**
 * "93% left" for an account's row, with `now` "93% left · resets Fri": the reset is half of
 * why new chats start where they do. Null when the account reports no limits.
 */
export function accountRoomLabel(
  standing: AccountStanding | undefined,
  now?: number,
): string | null {
  if (standing === undefined) return null;
  // Trouble with the account is not a limit: no reading describes it and no reset ends it.
  if (standing.refusal === "sign-in") return "Signed out";
  if (standing.refusal === "billing") return "Billing problem";
  if (standing.refusal === "plan") return "Plan turned down";
  const limit = standing.blockedBy ?? standing.limit;
  const reset = now === undefined ? null : accountResetLabel(limit?.resetsAt, now);
  const withReset = (room: string) => (reset === null ? room : `${room} · resets ${reset}`);
  if (standing.state === "out") return withReset("At limit");
  if (limit === null) return null;
  const percent = limit.remainingPercent;
  return withReset(`${percent > 0 && percent < 1 ? "<1" : percent}% left`);
}
