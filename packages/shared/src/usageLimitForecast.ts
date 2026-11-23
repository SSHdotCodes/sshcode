// @effect-diagnostics globalDate:off -- Forecasts are phrased in the viewer's zone, from wall-clock "now" via Date and Intl.
/**
 * Where a provider's limits are heading at the faster of recent and average spend, phrased the
 * way Claude's usage page puts it. Shared by web and mobile.
 *
 * @module usageLimitForecast
 */
import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  formatDuration,
  isUsageWindowAlmostOut,
  isUsageWindowLimited,
  type LimitPoolWindow,
} from "./usageLimits.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function resetMillis(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const at = Date.parse(window.resetsAt);
  return Number.isFinite(at) ? at : null;
}

/**
 * Where a window is heading at its faster measured pace: running
 * dry before its reset (`runsOut`), lasting to the reset (`lasts`), or
 * already spent (`out`). `at` is the projected empty time for `runsOut`.
 */
export type LimitForecast =
  | {
      readonly kind: "runsOut";
      readonly windowId: string;
      readonly label: string;
      readonly at: number;
      readonly resetsAt: number;
      readonly pace: "average" | "recent";
    }
  | {
      readonly kind: "lasts" | "out" | "almostOut";
      readonly windowId: string;
      readonly label: string;
      readonly resetsAt: number;
    };

const DEFAULT_WINDOW_MINS: Partial<Record<ServerProviderUsageWindow["kind"], number>> = {
  session: 5 * 60,
  weekly: 7 * 24 * 60,
};

/**
 * Window length: as reported, else the usual length for its kind. A monthly
 * window runs from the same date a calendar month before its reset.
 */
function windowLengthMs(window: ServerProviderUsageWindow, resetsAt: number): number | null {
  if (window.windowDurationMins !== undefined) {
    return window.windowDurationMins > 0 ? window.windowDurationMins * MINUTE : null;
  }
  const mins = DEFAULT_WINDOW_MINS[window.kind];
  if (mins !== undefined) return mins * MINUTE;
  if (window.kind !== "monthly") return null;
  const opened = new Date(resetsAt);
  opened.setMonth(opened.getMonth() - 1);
  return resetsAt - opened.getTime();
}

/**
 * Early in a window a few busy minutes would project a run-out that the rest
 * of the window never sees, so a pace needs a tenth of the window behind it.
 */
const MIN_FORECAST_ELAPSED_SHARE = 0.1;

/**
 * Projects a pool at each account's faster pace, refilling at its soonest reset.
 * Recent measurements have their own sampling guard and can speak before the
 * average has enough of its window behind it.
 */
export function limitForecast(
  window: Pick<ServerProviderUsageWindow, "id" | "label" | "usedPercent" | "limited"> & {
    readonly members: readonly { readonly window: ServerProviderUsageWindow }[];
  },
  now: number,
): LimitForecast | null {
  const timed = window.members.flatMap(({ window: member }) => {
    const resetsAt = resetMillis(member);
    if (resetsAt === null || resetsAt <= now) return [];
    const length = windowLengthMs(member, resetsAt);
    const elapsed = length === null ? null : Math.min(length, length - (resetsAt - now));
    const limited = isUsageWindowLimited(member);
    const used = limited ? 100 : Math.max(0, Math.min(100, member.usedPercent));
    const average =
      length !== null && elapsed !== null && elapsed >= length * MIN_FORECAST_ELAPSED_SHARE
        ? used / elapsed
        : null;
    const recent = validRecentPace(member);
    if (length === null && recent === null) return [];
    const usesRecent = recent !== null && (average === null || recent / HOUR > average);
    const rate = usesRecent ? recent / HOUR : average;
    return [{ used, limited, rate, usesRecent, resetsAt }];
  });
  if (timed.length === 0) return null;
  const resetsAt = Math.min(...timed.map((member) => member.resetsAt));
  const base = { windowId: window.id, label: window.label, resetsAt };
  if (window.members.every((member) => isUsageWindowLimited(member.window)))
    return { kind: "out", ...base };
  if (isUsageWindowAlmostOut(window)) return { kind: "almostOut", ...base };
  // Untimed members may still have quota, even when every timed member is spent.
  if (timed.every((member) => member.limited)) return null;
  const left = timed.reduce((sum, member) => sum + (100 - member.used), 0) / timed.length;
  if (timed.some((member) => member.rate === null)) return null;
  const rate = timed.reduce((sum, member) => sum + member.rate!, 0) / timed.length;
  if (rate <= 0) return { kind: "lasts", ...base };
  const at = now + left / rate;
  return at < resetsAt
    ? {
        kind: "runsOut",
        ...base,
        at,
        pace: timed.some((member) => member.usesRecent) ? "recent" : "average",
      }
    : { kind: "lasts", ...base };
}

/** The same forecast and sentence for an individual account's window. */
export function usageWindowForecast(
  window: ServerProviderUsageWindow,
  now: number,
): LimitForecast | null {
  return limitForecast({ ...window, members: [{ window }] }, now);
}

function validRecentPace(window: ServerProviderUsageWindow): number | null {
  const rate = window.recentPercentPerHour;
  return rate !== undefined && Number.isFinite(rate) && rate > 0 ? rate : null;
}

/** An active window's empty time at its measured recent pace, before its reset. */
export function recentUsageRunOut(window: ServerProviderUsageWindow, now: number): number | null {
  const rate = validRecentPace(window);
  const reset = resetMillis(window);
  if (
    rate === null ||
    reset === null ||
    reset <= now ||
    !Number.isFinite(now) ||
    !Number.isFinite(window.usedPercent) ||
    window.usedPercent >= 100 ||
    isUsageWindowLimited(window)
  )
    return null;
  const at = now + ((100 - Math.max(0, window.usedPercent)) / rate) * HOUR;
  return at < reset ? at : null;
}

/**
 * A limit worth interrupting for: at 70% or more and, at the last hour's
 * pace, empty within two hours and before its reset. `resetKey` names the
 * window's current period, so a client warns once per period.
 */
export function limitPaceWarning(
  window: ServerProviderUsageWindow,
  now: number,
): { readonly at: number; readonly resetKey: string } | null {
  if (!(window.usedPercent >= LIMIT_WARNING_MIN_USED_PERCENT)) return null;
  const at = recentUsageRunOut(window, now);
  const resetKey = limitPeriodKey(window);
  if (at === null || resetKey === null || at - now > 2 * HOUR) return null;
  return { at, resetKey };
}

/** Below this share of a window used, a pace warning is neither raised nor kept. */
export const LIMIT_WARNING_MIN_USED_PERCENT = 70;

/**
 * Names a window's current period: its id and the hour it resets. Reported resets wobble by
 * seconds between readings, so the hour is what tells one period from the next.
 */
export function limitPeriodKey(window: ServerProviderUsageWindow): string | null {
  const reset = resetMillis(window);
  return reset === null ? null : `${window.id}:${Math.round(reset / HOUR)}`;
}

/**
 * The forecast a provider's headline leads with: the window that runs dry
 * soonest, else the longest one that lasts, so "you'll make it" speaks for
 * the reset that matters most.
 */
export function poolForecast(
  windows: readonly LimitPoolWindow[],
  now: number,
): LimitForecast | null {
  const forecasts = windows.flatMap((window) => {
    // An older reading stopped counting when it was read; projecting it forward would guess.
    const members = window.members.filter((member) => member.account.asOf === undefined);
    const forecast = members.length === 0 ? null : limitForecast({ ...window, members }, now);
    return forecast === null ? [] : [forecast];
  });
  const emptyAt = (forecast: LimitForecast) =>
    forecast.kind === "runsOut"
      ? forecast.at
      : forecast.kind === "out" || forecast.kind === "almostOut"
        ? now
        : null;
  const short = forecasts
    .filter((forecast) => emptyAt(forecast) !== null)
    .sort(
      (left, right) =>
        emptyAt(left)! - emptyAt(right)! ||
        Number(right.kind === "out") - Number(left.kind === "out") ||
        left.resetsAt - right.resetsAt,
    );
  if (short[0]) return short[0];
  return [...forecasts].sort((left, right) => right.resetsAt - left.resetsAt)[0] ?? null;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function startOfDay(ms: number): number {
  const date = new Date(ms);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** Whole calendar days from `now` to `at`, in local time. */
function daysAhead(at: number, now: number): number {
  return Math.round((startOfDay(at) - startOfDay(now)) / DAY);
}

function defaultClock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function dayPart(ms: number): string | null {
  const hour = new Date(ms).getHours();
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 22) return "evening";
  return null;
}

function dateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Within this, a clock time reads better than "tomorrow" past midnight. */
const SOON = 12 * HOUR;

/** `in about 40m`, `around 4:30 PM`, `tomorrow morning`, `Monday evening`, `Oct 24`. */
function whenPhrase(at: number, now: number, clock: (ms: number) => string): string {
  if (at - now < HOUR) return `in about ${formatDuration(Math.max(at - now, MINUTE))}`;
  const days = daysAhead(at, now);
  const part = dayPart(at);
  if (days === 0 || at - now < SOON) return `around ${clock(at)}`;
  if (days === 1) return part ? `tomorrow ${part}` : `tomorrow around ${clock(at)}`;
  const weekday = WEEKDAYS[new Date(at).getDay()];
  if (days < 7) return part ? `${weekday} ${part}` : `${weekday} around ${clock(at)}`;
  return dateLabel(at);
}

/** `the 2:00 AM reset`, `tomorrow's reset`, `Wednesday's reset`, `the Oct 24 reset`. */
function resetPhrase(resetsAt: number, now: number, clock: (ms: number) => string): string {
  const days = daysAhead(resetsAt, now);
  if (days === 0 || resetsAt - now < SOON) return `the ${clock(resetsAt)} reset`;
  if (days === 1) return "tomorrow's reset";
  if (days < 7) return `${WEEKDAYS[new Date(resetsAt).getDay()]}'s reset`;
  return `the ${dateLabel(resetsAt)} reset`;
}

/**
 * The forecast as a sentence in local time, as Claude's usage page puts it:
 * "At this pace you'll run out Monday evening, before Wednesday's reset."
 * `warn` marks the sentences that call for attention.
 */
export function describeLimitForecast(
  forecast: LimitForecast,
  now: number,
  clock: (ms: number) => string = defaultClock,
): { readonly text: string; readonly warn: boolean } {
  const reset = resetPhrase(forecast.resetsAt, now, clock);
  switch (forecast.kind) {
    case "almostOut":
      return { text: `Almost out: under 1% left until ${reset}.`, warn: true };
    case "runsOut":
      return {
        text: `At ${forecast.pace === "recent" ? "the last hour's" : "this"} pace you'll run out ${whenPhrase(forecast.at, now, clock)}, before ${reset}.`,
        warn: true,
      };
    case "out":
      return { text: `Limit reached until ${reset}.`, warn: true };
    case "lasts":
      return { text: `On pace to make it to ${reset}.`, warn: false };
  }
}
