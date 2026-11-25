/**
 * Which of the user's accounts of one provider a new session starts on.
 *
 * Accounts that share their chats (two Claude plans, two ChatGPT plans) are
 * one provider with more room. A new session goes where quota would otherwise
 * expire unused: each account is scored by how fast it has to be spent to be
 * used up before its reset, weighted by the size of its plan. An account that
 * is out, nearly out, or close to its session limit is passed over while
 * another has room. Sessions that already run are never moved by this: the
 * other account would re-read the whole chat without its cache.
 *
 * @module accountBalance
 */
import {
  type ProjectId,
  type ProviderOptionSelection,
  type ServerProvider,
  type ServerProviderUsageWindow,
  type ServerSettings,
  activeProviderFailure,
  isProviderAvailable,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import { knownPlan, planAllowance } from "./subscriptionPlans.ts";
import { type LimitPresentations, isUsageWindowLimited } from "./usageLimits.ts";

const HOUR = 3_600_000;
const WEEK_MINUTES = 7 * 24 * 60;
/** Under this share of a weekly or monthly limit left, a new session is likely to hit it. */
const NEARLY_OUT_PERCENT = 5;
/** Under this share of a session limit left, a new session is likely to be cut short. */
const SESSION_BUSY_PERCENT = 15;
/** A session limit with less than this left starts to count against its account. */
const SESSION_COMFORT_PERCENT = 50;
/** A session limit can stop long work that an account without one would finish. */
const SESSION_LIMIT_HANDICAP = 0.85;
/** Scores this close are a tie, and the account that was asked for keeps the session. */
const TIE = 0.1;
/** A usage limit that names no reset is tried again after this long. */
const LIMIT_RECHECK_MS = 5 * 60_000;

export type AccountState = "open" | "unknown" | "tight" | "out";

export interface AccountLimit {
  readonly label: string;
  readonly remainingPercent: number;
  readonly resetsAt?: string;
}

/** Where one account stands for a model right now. */
export interface AccountStanding {
  readonly instanceId: string;
  /**
   * `open` has room; `unknown` reports no limits; `tight` is nearly out or
   * close to its session limit; `out` is at a limit or cannot run.
   */
  readonly state: AccountState;
  /** Plan share that must be spent per hour to use the plan up before its reset, by plan size. */
  readonly spare: number;
  /** Its weekly or monthly limit with the least left: the room the account has. */
  readonly limit: AccountLimit | null;
  /**
   * The limit that makes it `tight` or `out`: the one that crossed its threshold, which can
   * be its session limit while a longer limit has less left. Null for an account that is
   * `out` over a refusal no reading shows.
   */
  readonly blockedBy: AccountLimit | null;
  /**
   * Why it turns work away right now, when it does: a limit it ran into that its reading
   * does not show yet, or trouble with the account itself.
   */
  readonly refusal: "limit" | "sign-in" | "billing" | "plan" | null;
  /** What is left of its session limit; null when the account has none. */
  readonly sessionRemainingPercent: number | null;
  /**
   * The limit that sets `spare`: what is left of it by plan size, and the hours until it
   * resets. Tells an account picked for its sooner reset from one picked for having more.
   */
  readonly pace: { readonly left: number; readonly hours: number } | null;
}

export interface AccountPick {
  /** The account the new session starts on. */
  readonly instanceId: string;
  /** The account it would have started on. */
  readonly askedInstanceId: string;
  /** Standings for eligible accounts. */
  readonly standings: ReadonlyArray<AccountStanding>;
}

const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A selection can come from a saved chat or from a model-only catalog row. */
export interface AccountSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<ProviderOptionSelection> | undefined;
}

/** The limits that count against `model` on this account: its own and the ones for every model. */
export function usageWindowsForModel(
  provider: ServerProvider,
  model: string,
): ReadonlyArray<ServerProviderUsageWindow> {
  const limits = provider.usageLimits;
  if (!limits || limits.unavailable) return [];
  const slug = normalize(model);
  const name = normalize(provider.models.find((entry) => entry.slug === model)?.name ?? "");
  return limits.windows.filter((window) => {
    // The models a limit names come before anything its label suggests. An empty list on a
    // label without a scope is an account-wide limit that names nobody, and still counts.
    const scopeIndex = window.label.lastIndexOf(" · ");
    if (window.modelIds !== undefined && (window.modelIds.length > 0 || scopeIndex !== -1)) {
      return window.modelIds.includes(model);
    }
    if (window.providerIds !== undefined && window.providerIds.length > 0) {
      return window.providerIds.some((id) => model.startsWith(`${id}/`));
    }
    if (scopeIndex === -1) return true;
    const scope = normalize(window.label.slice(scopeIndex + 3));
    return scope.length > 0 && (slug.includes(scope) || name.includes(scope));
  });
}

/**
 * Models covered by a rejected usage window. Without an explicit window, only
 * infer a scope when the failed model's own window is full and global ones have room.
 * Unknown windows and account-wide limits remain account-wide.
 */
export function usageLimitModelIds(
  provider: ServerProvider,
  model: string | undefined,
  now: number,
  windowIds?: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined {
  if (!provider.usageLimits || provider.usageLimits.unavailable) return undefined;
  const windows = provider.usageLimits.windows;
  const isScoped = (window: ServerProviderUsageWindow) =>
    (window.modelIds?.length ?? 0) > 0 ||
    (window.providerIds?.length ?? 0) > 0 ||
    window.label.includes(" · ");
  const limited = (window: ServerProviderUsageWindow) =>
    isUsageWindowLimited(afterReset(window, now));
  let rejected: ReadonlyArray<ServerProviderUsageWindow>;
  if (windowIds !== undefined && windowIds.length > 0) {
    rejected = windows.filter((window) => windowIds.includes(window.id));
    if (windowIds.some((id) => !rejected.some((window) => window.id === id))) return undefined;
  } else {
    const global = windows.filter((window) => !isScoped(window));
    if (model === undefined || global.some(limited)) return undefined;
    rejected = usageWindowsForModel(provider, model).filter(limited);
  }
  if (rejected.length === 0 || rejected.some((window) => !isScoped(window))) return undefined;
  const models = new Set<string>();
  for (const window of rejected) {
    const covered =
      window.modelIds ??
      provider.models
        .filter((entry) =>
          usageWindowsForModel(provider, entry.slug).some((w) => w.id === window.id),
        )
        .map((entry) => entry.slug);
    if (covered.length === 0) return undefined;
    for (const id of covered) models.add(id);
  }
  return [...models];
}

const isSessionWindow = (window: ServerProviderUsageWindow) =>
  window.kind === "session" ||
  (window.windowDurationMins !== undefined && window.windowDurationMins <= 24 * 60);

const percentLeft = (window: ServerProviderUsageWindow) => {
  if (isUsageWindowLimited(window)) return 0;
  const left = 100 - Math.max(0, Math.min(100, window.usedPercent));
  // A window the provider still allows requests on is not out, whatever its rounded figure says.
  return left === 0 ? 0.5 : left;
};

/**
 * A reading from before the window's reset describes the last period: once
 * the reset time has passed the allowance is whole again, whatever the stale
 * figure says, and the next reset is one window further on.
 */
export function afterReset(
  window: ServerProviderUsageWindow,
  now: number,
): ServerProviderUsageWindow {
  const at = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  if (!Number.isFinite(at) || at > now) return window;
  const { resetsAt: _passed, limited: _stale, ...rest } = window;
  const length = (window.windowDurationMins ?? 0) * 60_000;
  // Several periods can pass on a machine that slept.
  const next = length > 0 ? at + (Math.floor((now - at) / length) + 1) * length : null;
  return {
    ...rest,
    usedPercent: 0,
    ...(next === null ? {} : { resetsAt: DateTime.formatIso(DateTime.makeUnsafe(next)) }),
  };
}

function hoursToReset(window: ServerProviderUsageWindow, now: number): number {
  const at = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
  if (Number.isFinite(at) && at > now) return Math.max(1, (at - now) / HOUR);
  // No reset to go by: take the window as half over.
  return Math.max(1, (window.windowDurationMins ?? WEEK_MINUTES) / 120);
}

/** Why the account cannot take work now: a limit it ran into, or trouble with the account itself. */
function refusalOf(
  provider: ServerProvider,
  model: string,
  now: number,
): AccountStanding["refusal"] {
  const failure = activeProviderFailure(provider, now, model);
  if (!failure) return null;
  if (failure.kind === "usage_limit") {
    return failure.resetAt !== undefined || Date.parse(failure.occurredAt) + LIMIT_RECHECK_MS > now
      ? "limit"
      : null;
  }
  if (failure.kind === "authentication_error") return "sign-in";
  if (failure.kind === "billing_error") return "billing";
  return failure.kind === "subscription_error" ? "plan" : null;
}

/**
 * Where one account stands for `model` on its own, outside any pool of the user's accounts:
 * a plan that also runs other makers' models (Google AI beside Claude Code) still shows what
 * it has left.
 */
export function accountStandingForModel(
  provider: ServerProvider,
  model: string,
  now: number,
): AccountStanding {
  return standingOf(provider, model, 1, now);
}

function standingOf(
  provider: ServerProvider,
  model: string,
  planSize: number,
  now: number,
): AccountStanding {
  const windows = usageWindowsForModel(provider, model).map((window) => afterReset(window, now));
  const sessions = windows.filter(isSessionWindow);
  const long = windows.filter((window) => !isSessionWindow(window));
  // An account with nothing but a session limit is paced by that one.
  const paced = long.length > 0 ? long : sessions;
  let tightest: ServerProviderUsageWindow | null = null;
  let shortSession: ServerProviderUsageWindow | null = null;
  for (const window of windows) {
    if (tightest === null || percentLeft(window) < percentLeft(tightest)) tightest = window;
    if (
      isSessionWindow(window) &&
      (shortSession === null || percentLeft(window) < percentLeft(shortSession))
    )
      shortSession = window;
  }
  const session = shortSession === null ? null : percentLeft(shortSession);
  let spare = paced.length === 0 ? 0 : Number.POSITIVE_INFINITY;
  let pace: AccountStanding["pace"] = null;
  let leastPaced: ServerProviderUsageWindow | null = null;
  for (const window of paced) {
    const left = percentLeft(window) * planSize;
    const hours = hoursToReset(window, now);
    if (left / hours < spare) {
      spare = left / hours;
      pace = { left, hours };
    }
    if (leastPaced === null || percentLeft(window) < percentLeft(leastPaced)) leastPaced = window;
  }
  // Beside a longer limit the session limit only holds the account back; alone it is the pace.
  if (session !== null && long.length > 0) {
    spare *= SESSION_LIMIT_HANDICAP * Math.min(1, session / SESSION_COMFORT_PERCENT);
  }

  const refusal = refusalOf(provider, model, now);
  const empty = tightest !== null && percentLeft(tightest) === 0;
  const nearlyOut = leastPaced !== null && percentLeft(leastPaced) < NEARLY_OUT_PERCENT;
  const state: AccountState =
    refusal !== null || empty
      ? "out"
      : leastPaced === null
        ? "unknown"
        : nearlyOut || (session !== null && session < SESSION_BUSY_PERCENT)
          ? "tight"
          : "open";
  // The limit that set the state, not the one with the least left: 12% of a session limit
  // holds an account back while 9% of its weekly limit would not.
  const blocking =
    state === "out"
      ? empty
        ? tightest
        : null
      : state === "tight"
        ? nearlyOut
          ? leastPaced
          : shortSession
        : null;
  return {
    instanceId: provider.instanceId,
    state,
    spare,
    limit: limitOf(leastPaced),
    blockedBy: limitOf(blocking),
    refusal,
    sessionRemainingPercent: session,
    pace,
  };
}

function limitOf(window: ServerProviderUsageWindow | null): AccountLimit | null {
  if (window === null) return null;
  const left = percentLeft(window);
  return {
    label: window.label,
    remainingPercent: left < 1 ? left : Math.round(left),
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  };
}

/**
 * The user's accounts of one provider that can run `model` in place of the
 * one asked for. The requested account leads when eligible. Empty without an eligible sibling.
 */
export function accountPool(
  providers: ReadonlyArray<ServerProvider>,
  selection: AccountSelection,
  accepts?: (provider: ServerProvider) => boolean,
): ReadonlyArray<ServerProvider> {
  const asked = providers.find((provider) => provider.instanceId === selection.instanceId);
  const group = asked?.continuation?.groupKey;
  if (!asked || group === undefined) return [];
  const askedDescriptors = asked.models.find((entry) => entry.slug === selection.model)
    ?.capabilities?.optionDescriptors;
  const canStart = (provider: ServerProvider) => {
    if (
      !provider.enabled ||
      !provider.installed ||
      !isProviderAvailable(provider) ||
      provider.status === "error" ||
      provider.status === "disabled" ||
      provider.auth.status === "unauthenticated" ||
      accepts?.(provider) === false
    )
      return false;
    const model = provider.models.find((entry) => entry.slug === selection.model);
    if (!model || model.unavailableReason !== undefined) return false;
    const descriptors = model.capabilities?.optionDescriptors;
    // Whether a catalog offers the choice; undefined when it does not describe the option.
    const offered = (
      catalog: typeof descriptors,
      option: ProviderOptionSelection,
    ): boolean | undefined => {
      const control = catalog?.find((entry) => entry.id === option.id);
      if (control === undefined) return undefined;
      return control.type === "boolean"
        ? typeof option.value === "boolean"
        : control.options.some((choice) => choice.id === option.value);
    };
    return (
      selection.options?.every(
        (option) =>
          // Only a choice an account is known not to offer rules it out. An option neither
          // account describes (an older harness, a setting left from another model) is passed
          // through as before: it must not switch balancing off.
          offered(descriptors, option) ?? offered(askedDescriptors, option) === undefined,
      ) ?? true
    );
  };
  const others = providers.filter(
    (provider) =>
      provider.instanceId !== asked.instanceId &&
      provider.driver === asked.driver &&
      provider.continuation?.groupKey === group &&
      canStart(provider),
  );
  if (others.length === 0) return [];
  return canStart(asked) ? [asked, ...others] : others;
}

const STATE_RANK: Record<AccountState, number> = { open: 3, unknown: 2, tight: 1, out: 0 };

/**
 * Each plan's size next to the smallest in the pool: by the allowance its
 * name states ("20x" against "5x"), else by list price, and all alike unless
 * every plan in the pool is known the same way.
 */
function planSizes(pool: ReadonlyArray<ServerProvider>): ReadonlyArray<number> {
  const clues = pool.map((provider) => ({
    driver: provider.driver,
    ...(provider.auth.label === undefined ? {} : { planLabel: provider.auth.label }),
    ...(provider.displayName === undefined ? {} : { displayName: provider.displayName }),
    windowIds: provider.usageLimits?.windows.map((window) => window.id) ?? [],
  }));
  for (const measure of [
    planAllowance,
    (plan: (typeof clues)[number]) => knownPlan(plan)?.monthlyUsd,
  ]) {
    const sizes = clues.map(measure);
    const smallest = Math.min(...sizes.map((size) => size ?? Number.NaN));
    if (Number.isFinite(smallest) && smallest > 0) return sizes.map((size) => size! / smallest);
  }
  return pool.map(() => 1);
}

/**
 * The account a new session for `selection.model` should start on, or null
 * when the account asked for has no other to share the work with.
 */
export function pickAccountForNewSession(
  providers: ReadonlyArray<ServerProvider>,
  selection: AccountSelection,
  options: {
    readonly now: number;
    /** Leaves out accounts the caller could not start on. */
    readonly accepts?: ((provider: ServerProvider) => boolean) | undefined;
  },
): AccountPick | null {
  const pool = accountPool(providers, selection, options.accepts);
  if (pool.length === 0) return null;
  const { now } = options;
  const sizes = planSizes(pool);
  const standings = pool.map((provider, index) =>
    standingOf(provider, selection.model, sizes[index]!, now),
  );
  let best = standings[0]!;
  for (const candidate of standings.slice(1)) {
    const rank = STATE_RANK[candidate.state] - STATE_RANK[best.state];
    if (rank > 0 || (rank === 0 && candidate.spare > best.spare)) best = candidate;
  }
  // Apply the tie margin once, against the requested account if it can take the work.
  const asked = standings.find((entry) => entry.instanceId === selection.instanceId);
  if (!asked && best.state === "out") return null;
  const keepAsked =
    best.state === "out" || (asked?.state === best.state && best.spare <= asked.spare * (1 + TIE));
  return {
    instanceId: keepAsked ? selection.instanceId : best.instanceId,
    askedInstanceId: selection.instanceId,
    standings,
  };
}

/**
 * Orders accounts the way new sessions prefer them: one that can take work before one that
 * is tight or out, then the most to spare. Unlike the pick itself it has no asked-for
 * account that keeps a tie, so a list in this order holds still whichever account a chat is on.
 */
export function byRoomForNewSessions(left: AccountStanding, right: AccountStanding): number {
  return STATE_RANK[right.state] - STATE_RANK[left.state] || right.spare - left.spare;
}

const percentText = (percent: number) => (percent > 0 && percent < 1 ? "<1%" : `${percent}%`);

/** Why `picked` takes a new session rather than `other`, without a closing period. */
function describePick(
  picked: AccountStanding,
  other: AccountStanding,
  nameOf: (instanceId: string) => string,
): string {
  const name = nameOf(other.instanceId);
  if (STATE_RANK[picked.state] > STATE_RANK[other.state]) {
    if (other.state === "out") {
      if (other.blockedBy !== null) return `${name} reached its ${other.blockedBy.label} limit`;
      // Trouble with the account is not a limit, and waiting for a reset does not end it.
      return other.refusal === "sign-in"
        ? `${name} is signed out`
        : other.refusal === "billing"
          ? `${name} has a billing problem`
          : other.refusal === "plan"
            ? `${name}'s plan was turned down by the provider`
            : `${name} reached its usage limit`;
    }
    if (other.state === "tight" && other.blockedBy) {
      return `${name} has ${percentText(other.blockedBy.remainingPercent)} of its ${other.blockedBy.label} limit left`;
    }
    return "it has room";
  }
  if (picked.spare <= other.spare * (1 + TIE)) return "the accounts have about the same left";
  // With no more left than the other, it is ahead only because its unused share expires first.
  return picked.pace !== null &&
    other.pace !== null &&
    picked.pace.hours < other.pace.hours &&
    picked.pace.left <= other.pace.left * (1 + TIE)
    ? "its limit resets sooner, so what is left on it is used first"
    : "it has the most left to use before its reset";
}

/**
 * Why a new session left the account that was asked for, without a closing
 * period; null when it stayed. `nameOf` gives each account the name the user
 * knows it by. Reads after the picked account's name: "Started on Personal: it
 * has the most left to use before its reset."
 */
export function accountPickReason(
  pick: AccountPick,
  nameOf: (instanceId: string) => string,
): string | null {
  if (pick.instanceId === pick.askedInstanceId) return null;
  const picked = pick.standings.find((entry) => entry.instanceId === pick.instanceId);
  const asked = pick.standings.find((entry) => entry.instanceId === pick.askedInstanceId);
  return picked && asked ? describePick(picked, asked, nameOf) : null;
}

/** A suggestion to move a chat that already runs to another of the user's accounts. */
export interface AccountSwitchTip {
  readonly fromInstanceId: string;
  readonly toInstanceId: string;
  /** Why, as a sentence without its period: "Work has 4% of its Weekly limit left". */
  readonly reason: string;
}

/** A running chat is offered its other account once this little of a long limit is left. */
const SWITCH_BELOW_PERCENT = 10;
/** And only for an account with this much more left: a move must be worth its re-read. */
const SWITCH_MARGIN_PERCENT = 30;

/**
 * For a chat that already runs on `selection`: its account is nearly out, or out, for the
 * model while another of the user's accounts has clearly more room and would take a new
 * session. The app never moves a running chat (the other account reads the whole chat
 * again), so this is only ever offered, and only when staying is about to stop the chat.
 */
export function accountSwitchTip(
  providers: ReadonlyArray<ServerProvider>,
  selection: AccountSelection,
  options: {
    readonly now: number;
    readonly nameOf: (instanceId: string) => string;
    readonly accepts?: ((provider: ServerProvider) => boolean) | undefined;
  },
): AccountSwitchTip | null {
  const pick = pickAccountForNewSession(providers, selection, options);
  if (pick === null || pick.instanceId === pick.askedInstanceId) return null;
  const current = pick.standings.find((entry) => entry.instanceId === pick.askedInstanceId);
  const best = pick.standings.find((entry) => entry.instanceId === pick.instanceId);
  if (!current || !best || best.state !== "open") return null;
  const stopping = current.state === "tight" || current.state === "out";
  if (!stopping && (current.limit?.remainingPercent ?? 100) > SWITCH_BELOW_PERCENT) return null;
  const short = current.blockedBy ?? current.limit;
  // An account that is out has nothing left for this chat, whatever its last reading says.
  const left = current.state === "out" ? 0 : (short?.remainingPercent ?? 0);
  if (best.limit !== null && best.limit.remainingPercent < left + SWITCH_MARGIN_PERCENT) {
    return null;
  }
  const name = options.nameOf(current.instanceId);
  return {
    fromInstanceId: current.instanceId,
    toInstanceId: best.instanceId,
    reason: stopping
      ? describePick(best, current, options.nameOf)
      : `${name} has ${percentText(short?.remainingPercent ?? 0)} of its ${short?.label ?? "usage"} limit left`,
  };
}

/**
 * Why new sessions start on the picked account, whichever one was asked for:
 * it is set against the best of the others. Reads the same way as
 * `accountPickReason`.
 */
export function accountPickSummary(
  pick: AccountPick,
  nameOf: (instanceId: string) => string,
): string | null {
  const picked = pick.standings.find((entry) => entry.instanceId === pick.instanceId);
  let other: AccountStanding | undefined;
  for (const candidate of pick.standings) {
    if (candidate.instanceId === pick.instanceId) continue;
    const rank = other === undefined ? 1 : STATE_RANK[candidate.state] - STATE_RANK[other.state];
    if (rank > 0 || (rank === 0 && candidate.spare > other!.spare)) other = candidate;
  }
  return picked && other ? describePick(picked, other, nameOf) : null;
}

/**
 * The accounts new sessions start on right now, as `environmentId:instanceId`
 * keys, for marking them where a provider's accounts are listed side by side.
 * Only providers with more than one account have one, judged by the
 * provider's default model, and only on machines where balancing is on.
 */
export function newSessionAccountKeys(
  presentations: LimitPresentations,
  now: number,
): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [environmentId, presentation] of presentations) {
    const config = presentation.serverConfig;
    if (!config || config.settings?.balanceAccounts !== true) continue;
    const providers = config.providers ?? [];
    const seen = new Set<string>();
    for (const provider of providers) {
      const group = provider.continuation?.groupKey;
      if (group === undefined || !provider.enabled) continue;
      const pool = `${provider.driver}\n${group}`;
      if (seen.has(pool)) continue;
      const model = (
        provider.models.find((entry) => entry.isDefault) ??
        provider.models.find((entry) => entry.isLegacy !== true) ??
        provider.models[0]
      )?.slug;
      if (model === undefined) continue;
      const pick = pickAccountForNewSession(
        providers,
        { instanceId: provider.instanceId, model },
        {
          now,
          accepts: (candidate) =>
            config.settings?.providerModelPreferences?.[
              candidate.instanceId
            ]?.hiddenModels?.includes(model) !== true,
        },
      );
      if (pick === null) continue;
      seen.add(pool);
      keys.add(`${environmentId}:${pick.instanceId}`);
    }
  }
  return keys;
}

/**
 * Whether a new chat in a project may start `model` on an account: the
 * account is enabled for that project and the user has not hidden the model
 * on it. Balancing must not send a chat where the composer would then refuse
 * the model or swap it for another.
 */
export function accountAcceptsModel(
  settings:
    | (Pick<ServerSettings, "providerInstances" | "projectSettingsOverrides"> & {
        readonly providerModelPreferences?:
          | Readonly<Record<string, { readonly hiddenModels?: ReadonlyArray<string> } | undefined>>
          | null
          | undefined;
      })
    | null
    | undefined,
  projectId: ProjectId | null,
): (provider: ServerProvider, model: string) => boolean {
  return (provider, model) =>
    settings === null ||
    settings === undefined ||
    (resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId) &&
      settings.providerModelPreferences?.[provider.instanceId]?.hiddenModels?.includes(model) !==
        true);
}
