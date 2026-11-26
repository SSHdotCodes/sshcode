import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./state/models.ts";

const HOUR = 3_600_000;
const HOURS = 24;

type DayThread = Pick<
  EnvironmentThreadShell,
  | "createdAt"
  | "environmentId"
  | "latestRun"
  | "latestUserMessageAt"
  | "lineage"
  | "providerInstanceId"
  | "runtime"
>;

export interface DayActivity {
  /** How busy each of the 24 hours was, 0 (quiet) to 4, relative to the busiest. */
  readonly levels: ReadonlyArray<0 | 1 | 2 | 3 | 4>;
  /** The hour `now` falls in, counted from the start; later hours have not happened. */
  readonly currentHour: number;
  /** Chats that were started, written to or ran in these hours. */
  readonly chats: number;
  /** Subagents that ran in these hours. */
  readonly subagents: number;
  /** Chats and subagents running right now. */
  readonly working: number;
  /** The `environment:instance` behind the most of these hours, for the card's colour. */
  readonly leadSource: string | null;
}

/**
 * Twenty-four hours from `start` (epoch milliseconds, on an hour), by the hour, from the
 * chats and subagents the client already holds: each one lights the hours its latest run
 * spanned, plus the hours it was started and last written to. Start at local midnight for
 * today, or 23 hours before the current hour for the day up to now.
 */
export function buildDayActivity(
  threads: ReadonlyArray<DayThread>,
  now: number,
  start: number,
): DayActivity {
  const currentHour = Math.max(0, Math.min(HOURS - 1, Math.floor((now - start) / HOUR)));
  const counts = Array.from({ length: HOURS }, () => 0);
  let chats = 0;
  let subagents = 0;
  let working = 0;
  const hoursBySource = new Map<string, number>();
  const hourOf = (instant: number) =>
    instant >= start && instant <= now
      ? Math.min(currentHour, Math.floor((instant - start) / HOUR))
      : null;
  for (const thread of threads) {
    const subagent = thread.lineage.relationshipToParent === "subagent";
    const active = threadRuntimeIsActive(thread.runtime);
    const hours = new Set<number>();
    const run = thread.latestRun;
    const runStart = Date.parse(run?.startedAt ?? run?.requestedAt ?? "");
    const runEnd = active ? now : Date.parse(run?.completedAt ?? "");
    if (Number.isFinite(runStart)) {
      const end = Number.isFinite(runEnd) ? runEnd : runStart;
      const from = hourOf(Math.max(runStart, start));
      const to = hourOf(Math.min(end, now));
      if (from !== null && to !== null && end >= start) {
        for (let hour = from; hour <= to; hour++) hours.add(hour);
      }
    } else if (active) {
      hours.add(currentHour);
    }
    // A subagent's start and its lead's messages are the lead's doing, not a run of its own.
    if (!subagent) {
      for (const moment of [thread.createdAt, thread.latestUserMessageAt]) {
        const hour = hourOf(Date.parse(moment ?? ""));
        if (hour !== null) hours.add(hour);
      }
    }
    if (active) working++;
    if (hours.size === 0) continue;
    if (subagent) subagents++;
    else chats++;
    for (const hour of hours) counts[hour] = (counts[hour] ?? 0) + 1;
    const instanceId =
      active && thread.runtime ? thread.runtime.providerInstanceId : thread.providerInstanceId;
    const source = `${thread.environmentId}:${instanceId}`;
    hoursBySource.set(source, (hoursBySource.get(source) ?? 0) + hours.size);
  }
  const peak = Math.max(...counts);
  let leadSource: string | null = null;
  for (const [source, hours] of hoursBySource) {
    if (leadSource === null || hours > (hoursBySource.get(leadSource) ?? 0)) leadSource = source;
  }
  return {
    levels: counts.map((count) =>
      count === 0 ? 0 : (Math.max(1, Math.ceil((count / peak) * 4)) as 1 | 2 | 3 | 4),
    ),
    currentHour,
    chats,
    subagents,
    working,
    leadSource,
  };
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The card's one line: `6 chats · 14 subagents`, or what a quiet day says instead. */
export function dayActivitySummary(activity: Pick<DayActivity, "chats" | "subagents">) {
  if (activity.chats === 0 && activity.subagents === 0) return "Nothing yet";
  return [
    ...(activity.chats > 0 ? [plural(activity.chats, "chat")] : []),
    ...(activity.subagents > 0 ? [plural(activity.subagents, "subagent")] : []),
  ].join(" · ");
}
