import {
  displayLimitWindows,
  formatDuration,
  type LimitPool,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";

import {
  threadRuntimeIsActive,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";

import type { LimitRingChoices } from "../../lib/statusAccessoryItems";

export type LimitTone = "ok" | "warn" | "critical";

/** How much headroom a window has left: fine, getting close, or nearly out. */
export function limitTone(usedPercent: number): LimitTone {
  if (usedPercent >= 90) return "critical";
  if (usedPercent >= 70) return "warn";
  return "ok";
}

/** System green, orange, and red, legible on glass and cards in both themes. */
export const LIMIT_TONE_COLOR: Record<LimitTone, string> = {
  ok: "#30d158",
  warn: "#ff9f0a",
  critical: "#ff453a",
};

/** The soonest reset among the window's accounts, in epoch milliseconds. */
export function nextResetAt(window: LimitPoolWindow): number | null {
  return window.resets[0]?.at ?? null;
}

const MINUTE = 60_000;

/** The next future reset, or a status when every reported reset time has passed. */
export function resetsInLabel(window: LimitPoolWindow, now: number): string | null {
  const short = resetsInShort(window, now);
  if (short !== null) return `Resets in ${short}`;
  return window.resets.length > 0 ? "Reset time passed" : null;
}

/** Just the countdown, for places too small for a sentence: `2h 14m`. The
    last minute reads `<1m`, not `0m`, as thread times do. */
export function resetsInShort(window: LimitPoolWindow, now: number): string | null {
  const at = window.resets.find((reset) => reset.at > now)?.at;
  if (at === undefined) return null;
  return at - now < MINUTE ? "<1m" : formatDuration(at - now);
}

export interface ProviderLimits {
  readonly driver: LimitPool["driver"];
  readonly pool: LimitPool;
  /** In the provider's own order: session before weekly, a model's windows
      together. */
  readonly windows: readonly LimitPoolWindow[];
  /** The window closest to running out. */
  readonly tightest: LimitPoolWindow;
}

function byTightness(left: LimitPoolWindow, right: LimitPoolWindow): number {
  return (
    right.usedPercent - left.usedPercent ||
    (nextResetAt(left) ?? Number.POSITIVE_INFINITY) -
      (nextResetAt(right) ?? Number.POSITIVE_INFINITY)
  );
}

/**
 * One entry per provider that reports limits, in the pools' order (most used
 * this past week first), each with its windows in the provider's own order
 * (session, then weekly) like the Claude and Codex apps. Spending a window
 * never moves its bar; colour and `tightest` carry what is about to run out.
 */
export function summarizeProviderLimits(pools: readonly LimitPool[]): ProviderLimits[] {
  return pools.flatMap((pool) => {
    const windows = displayLimitWindows(pool);
    const tightest = [...windows].sort(byTightness)[0];
    return tightest ? [{ driver: pool.driver, pool, windows, tightest }] : [];
  });
}

/**
 * Whether a provider's ring shows in the status row: this device's choice,
 * else on, unless every account behind it is set to stay out of compact rows.
 * The Limits page lists every account either way.
 */
export function isLimitRingShown(
  entry: Pick<ProviderLimits, "pool">,
  choices: LimitRingChoices | undefined,
): boolean {
  const chosen = choices?.[entry.pool.key];
  if (chosen !== undefined) return chosen;
  const { accounts } = entry.pool;
  return accounts.length === 0 || accounts.some((account) => account.hideRing !== true);
}

/** One ring in the status row: a plan, or a provider's plans combined. */
export interface StatusRing {
  readonly key: string;
  /** The plan's name where the provider has several; null takes the provider's. */
  readonly label: string | null;
  readonly limits: ProviderLimits;
  /** The `environment:instance` keys whose chats run on the ring's plans. */
  readonly sourceKeys: readonly string[];
}

function planSourceKeys(plans: readonly ProviderLimits[]): string[] {
  return [
    ...new Set(
      plans.flatMap((plan) => plan.pool.accounts.flatMap((account) => account.sourceKeys)),
    ),
  ];
}

/**
 * A provider's plans as one ring, for a user who asked for that: the average
 * of how far each plan is into the window closest to running out, so the ring
 * is full only when every plan is. It resets with whichever plan resets first.
 */
function combineProviderLimits(plans: readonly ProviderLimits[]): ProviderLimits {
  const first = plans[0]!;
  const used =
    plans.reduce(
      (sum, plan) => sum + (plan.tightest.limited === true ? 100 : plan.tightest.usedPercent),
      0,
    ) / plans.length;
  const resets = plans.flatMap((plan) => plan.tightest.resets);
  resets.sort((left, right) => left.at - right.at);
  const window: LimitPoolWindow = {
    id: "plans",
    kind: first.tightest.kind,
    label: `${plans.length} plans`,
    members: [],
    columns: [],
    usedPercent: used,
    remainingPercent: 100 - used,
    limited: plans.every((plan) => plan.tightest.limited === true),
    pace: null,
    resets,
  };
  return { driver: first.driver, pool: first.pool, windows: [window], tightest: window };
}

function planRing(entry: ProviderLimits): StatusRing {
  return {
    key: entry.pool.key,
    label: entry.pool.label,
    limits: entry,
    sourceKeys: planSourceKeys([entry]),
  };
}

/**
 * The rings the status row draws, in the providers' order: the ones switched
 * on, with a provider's plans drawn as one ring where the user combined them.
 */
export function statusRowRings(
  providers: readonly ProviderLimits[],
  choices: LimitRingChoices | undefined,
  combined: ReadonlyArray<string> | undefined,
): StatusRing[] {
  const shown = providers.filter((entry) => isLimitRingShown(entry, choices));
  const rings: StatusRing[] = [];
  const done = new Set<string>();
  for (const entry of shown) {
    const driver = String(entry.driver);
    if (!combined?.includes(driver)) {
      rings.push(planRing(entry));
      continue;
    }
    if (done.has(driver)) continue;
    done.add(driver);
    const plans = shown.filter((other) => String(other.driver) === driver);
    rings.push(
      plans.length === 1
        ? planRing(entry)
        : {
            key: driver,
            label: null,
            limits: combineProviderLimits(plans),
            sourceKeys: planSourceKeys(plans),
          },
    );
  }
  return rings;
}

/** How many rings the status row draws before it counts the rest. */
export const STATUS_RING_LIMIT = 6;

/** A chat's or subagent's latest run, as far as the rings care. */
export interface PlanRun {
  /** `environment:instance`, as a limit account's `sourceKeys` name it. */
  readonly sourceKey: string;
  /** When the run was asked for, in epoch milliseconds. */
  readonly at: number;
  readonly working: boolean;
}

/** The latest run of every chat and subagent that has one, on the plan it ran on. */
export function planRunsFromThreads(
  threads: ReadonlyArray<
    Pick<EnvironmentThreadShell, "environmentId" | "providerInstanceId" | "latestRun" | "runtime">
  >,
): PlanRun[] {
  const runs: PlanRun[] = [];
  for (const thread of threads) {
    const working = threadRuntimeIsActive(thread.runtime);
    const at = Date.parse(thread.latestRun?.requestedAt ?? thread.latestRun?.startedAt ?? "");
    if (!working && Number.isNaN(at)) continue;
    const instanceId =
      working && thread.runtime ? thread.runtime.providerInstanceId : thread.providerInstanceId;
    runs.push({
      sourceKey: `${thread.environmentId}:${instanceId}`,
      at: Number.isNaN(at) ? 0 : at,
      working,
    });
  }
  return runs;
}

const DAY = 24 * 60 * MINUTE;
/** A run counts half as much a day on, and not at all after a week. */
const USE_HORIZON = 7 * DAY;
/** A chat working right now counts like this many just started. */
const WORKING_WEIGHT = 3;

/** Puts a plan a chat is working on right now ahead of any number of hours. */
const WORKING_FIRST = 1_000_000;

/**
 * How much each plan is in use. With its server's `recentUse` (hours its chats
 * and subagents ran this past week), that, with plans working right now first.
 * Older servers fall back to each chat's and subagent's latest run, the newest
 * weighing most.
 */
export function planUse(
  runs: readonly PlanRun[],
  now: number,
  recentUse?: ReadonlyMap<string, number>,
): Map<string, number> {
  if (recentUse !== undefined && recentUse.size > 0) {
    const ranked = new Map(recentUse);
    for (const run of runs) {
      if (run.working) ranked.set(run.sourceKey, (ranked.get(run.sourceKey) ?? 0) + WORKING_FIRST);
    }
    return ranked;
  }
  const use = new Map<string, number>();
  for (const run of runs) {
    const age = Math.max(0, now - run.at);
    const weight = run.working ? WORKING_WEIGHT : age > USE_HORIZON ? 0 : 0.5 ** (age / DAY);
    if (weight > 0) use.set(run.sourceKey, (use.get(run.sourceKey) ?? 0) + weight);
  }
  return use;
}

function ringUse(ring: StatusRing, use: ReadonlyMap<string, number>): number {
  return ring.sourceKeys.reduce((sum, key) => sum + (use.get(key) ?? 0), 0);
}

/**
 * The rings the status row has room for: the plans in use most lately, then the ones
 * closest to running out, drawn in the providers' order (most used first), and how many
 * more there are. The Limits page shows every one.
 */
export function statusRowVisibleRings(
  rings: readonly StatusRing[],
  use: ReadonlyMap<string, number> = new Map(),
  limit = STATUS_RING_LIMIT,
): { readonly shown: StatusRing[]; readonly more: number } {
  if (rings.length <= limit) return { shown: [...rings], more: 0 };
  const ranked = rings.map((ring) => ({ ring, use: ringUse(ring, use) }));
  ranked.sort(
    (left, right) =>
      right.use - left.use || byTightness(left.ring.limits.tightest, right.ring.limits.tightest),
  );
  const keep = new Set(ranked.slice(0, limit).map((entry) => entry.ring.key));
  return {
    shown: rings.filter((ring) => keep.has(ring.key)),
    more: rings.length - keep.size,
  };
}

/** Providers with more than one plan, the only ones whose rings can combine. */
export function combinableRingDrivers(
  providers: readonly ProviderLimits[],
): ReadonlyArray<{ readonly driver: ProviderLimits["driver"]; readonly plans: number }> {
  const counts = new Map<ProviderLimits["driver"], number>();
  for (const entry of providers) counts.set(entry.driver, (counts.get(entry.driver) ?? 0) + 1);
  return [...counts].flatMap(([driver, plans]) => (plans > 1 ? [{ driver, plans }] : []));
}

/** The provider whose tightest window is closest to running out. */
export function tightestProviderLimits(
  providers: readonly ProviderLimits[],
): ProviderLimits | undefined {
  return [...providers].sort((left, right) => byTightness(left.tightest, right.tightest))[0];
}
