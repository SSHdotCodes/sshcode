/**
 * What the home screen's Insights section shows about the chats loaded on this phone:
 * when they started, on which harness, and how this month compares with the last.
 * Pure and bounded: one pass over the loaded chats.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ChatPace } from "@t3tools/client-runtime/new-chat-dashboard";

const DAY = 86_400_000;
export const HEATMAP_WEEKS = 26;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type InsightThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "deletedAt" | "visibleItemCount" | "lineage"
>;

/** The phone's calendar day of an instant as a UTC day number, so DST never drops or doubles a day. */
export function localDayOrdinal(instant: number): number {
  const date = new Date(instant);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
}

export interface HarnessCount {
  /** The pet that fronts the harness (or the model's maker). */
  readonly key: string;
  readonly count: number;
}

export interface InsightDay {
  readonly ordinal: number;
  readonly count: number;
  readonly level: 0 | 1 | 2 | 3 | 4;
  readonly future: boolean;
  /** This day's chats by harness, most first. */
  readonly mix: ReadonlyArray<HarnessCount>;
}

export interface HomeInsights {
  /** HEATMAP_WEEKS weeks of days, Sunday first, ending with this week. */
  readonly days: ReadonlyArray<InsightDay>;
  readonly total: number;
  readonly activeDays: number;
  readonly today: number;
  /** The last 7 days against the 7 before them. */
  readonly week: { readonly chats: number; readonly previous: number };
  /** This month so far against the same days of last month. */
  readonly month: { readonly chats: number; readonly previous: number };
  readonly pace: ChatPace;
  /** Days in a row with a chat started, counting today only once it has one. */
  readonly streak: number;
  /** The last 30 days' chats by harness, most first. */
  readonly harnesses: ReadonlyArray<HarnessCount>;
  /** The last 30 days' chats by the hour they started, midnight first. */
  readonly hours: ReadonlyArray<number>;
}

function byCount(left: HarnessCount, right: HarnessCount) {
  return right.count - left.count || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

function toCounts(map: ReadonlyMap<string, number>): HarnessCount[] {
  const counts: HarnessCount[] = [];
  for (const [key, count] of map) counts.push({ key, count });
  // A fresh array: sorting it in place is safe on Hermes.
  return counts.sort(byCount);
}

function bump(map: Map<string, number>, key: string, by = 1) {
  map.set(key, (map.get(key) ?? 0) + by);
}

/** Quartiles of the active days' counts: an ordinary day reads mid-tone, a big one full. */
function levels(counts: ReadonlyArray<number>) {
  const sorted = counts.filter((count) => count > 0).sort((left, right) => left - right);
  const at = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))] ?? 0;
  const cuts = [at(0.25), at(0.5), at(0.75)];
  return (count: number): InsightDay["level"] => {
    if (count <= 0) return 0;
    if (count <= cuts[0]!) return 1;
    if (count <= cuts[1]!) return 2;
    if (count <= cuts[2]!) return 3;
    return 4;
  };
}

export function buildHomeInsights(
  threads: ReadonlyArray<InsightThread>,
  harnessOf: (thread: InsightThread) => string,
  now: number,
): HomeInsights {
  const today = localDayOrdinal(now);
  const date = new Date(now);
  const weekDay = date.getDay();
  const start = today - weekDay - (HEATMAP_WEEKS - 1) * 7;
  const monthStart = Date.UTC(date.getFullYear(), date.getMonth(), 1) / DAY;
  const previousMonthStart = Date.UTC(date.getFullYear(), date.getMonth() - 1, 1) / DAY;
  const daysInMonth = Date.UTC(date.getFullYear(), date.getMonth() + 1, 1) / DAY - monthStart;
  const earliest = Math.min(start, previousMonthStart, today - 29);

  const counts = new Map<number, number>();
  const mixes = new Map<number, Map<string, number>>();
  const harnesses = new Map<string, number>();
  const hours = Array.from({ length: 24 }, () => 0);
  const seen = new Set<string>();
  for (const thread of threads) {
    if (
      thread.deletedAt !== null ||
      thread.visibleItemCount === 0 ||
      thread.lineage.relationshipToParent === "subagent"
    )
      continue;
    const key = `${thread.environmentId}:${thread.id}`;
    const instant = Date.parse(thread.createdAt);
    if (seen.has(key) || !Number.isFinite(instant)) continue;
    seen.add(key);
    const day = localDayOrdinal(instant);
    if (day > today || day < earliest) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
    const harness = harnessOf(thread);
    let mix = mixes.get(day);
    if (!mix) {
      mix = new Map();
      mixes.set(day, mix);
    }
    bump(mix, harness);
    if (day > today - 30) {
      bump(harnesses, harness);
      hours[new Date(instant).getHours()]! += 1;
    }
  }

  const heatmapCounts: number[] = [];
  for (const [day, count] of counts) if (day >= start) heatmapCounts.push(count);
  const level = levels(heatmapCounts);
  const days: InsightDay[] = Array.from({ length: HEATMAP_WEEKS * 7 }, (_, index) => {
    const ordinal = start + index;
    const count = counts.get(ordinal) ?? 0;
    const mix = mixes.get(ordinal);
    return {
      ordinal,
      count,
      level: level(count),
      future: ordinal > today,
      mix: mix ? toCounts(mix) : [],
    };
  });

  const sum = (from: number, to: number) => {
    let total = 0;
    for (let day = from; day <= to; day++) total += counts.get(day) ?? 0;
    return total;
  };
  const elapsed = today - monthStart;
  let streak = 0;
  for (let day = (counts.get(today) ?? 0) > 0 ? today : today - 1; day >= earliest; day--) {
    if ((counts.get(day) ?? 0) === 0) break;
    streak++;
  }
  const runningTotals = (from: number, length: number) => {
    let total = 0;
    return Array.from({ length }, (_, index) => (total += counts.get(from + index) ?? 0));
  };
  const previousDate = new Date(previousMonthStart * DAY);
  return {
    days,
    total: heatmapCounts.reduce((total, count) => total + count, 0),
    activeDays: heatmapCounts.length,
    today: counts.get(today) ?? 0,
    week: { chats: sum(today - 6, today), previous: sum(today - 13, today - 7) },
    month: {
      chats: sum(monthStart, today),
      previous: sum(previousMonthStart, Math.min(previousMonthStart + elapsed, monthStart - 1)),
    },
    pace: {
      daysInMonth,
      current: runningTotals(monthStart, elapsed + 1),
      previous: runningTotals(
        previousMonthStart,
        Math.min(daysInMonth, monthStart - previousMonthStart),
      ),
      month: MONTHS[date.getMonth()]!,
      previousMonth: MONTHS[previousDate.getUTCMonth()]!,
    },
    streak,
    harnesses: toCounts(harnesses),
    hours,
  };
}

/** `10 PM`, `12 AM`: the start of the busiest hour. */
export function formatHour(hour: number): string {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve} ${suffix}`;
}

/** The hour with the most chats started, or null with none. */
export function busiestHour(hours: ReadonlyArray<number>): number | null {
  let best: number | null = null;
  for (let hour = 0; hour < hours.length; hour++) {
    if ((hours[hour] ?? 0) > 0 && (best === null || hours[hour]! > hours[best]!)) best = hour;
  }
  return best;
}

/** `+3 vs last week`, `Same as last week`, `−2 vs last week`. */
export function formatChange(current: number, previous: number, period: string): string {
  const delta = current - previous;
  if (delta === 0) return `Same as last ${period}`;
  return `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString()} vs last ${period}`;
}
