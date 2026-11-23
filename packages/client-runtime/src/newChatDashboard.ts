import { harnessIdentityTint } from "@t3tools/shared/harnessMascots";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import type { AccountSelection } from "@t3tools/shared/accountBalance";
import { accountsByRoom, accountStandings } from "./accountRoutes.ts";
import type { EnvironmentConnectionPhase } from "./connection/presentation.ts";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./state/models.ts";
import {
  compareSessionBoxes,
  presentSessionBoxCached,
  sessionBoxConnectionPresentation,
  type SessionBoxPresentation,
} from "./state/sessionBoxes.ts";
import { effectiveSnoozed } from "./state/threadSettled.ts";

const DAY = 86_400_000;
const easternDay = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const monthName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short" });
const resetDate = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

// Calendar arithmetic uses UTC day ordinals after assigning each instant to
// its Eastern date. DST then cannot create a missing or duplicated heatmap day.
function dayOrdinal(instant: number): number {
  const parts = easternDay.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((value) => value.type === type)?.value);
  return Date.UTC(part("year"), part("month") - 1, part("day")) / DAY;
}

type DashboardThread = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "deletedAt" | "visibleItemCount" | "lineage"
>;

/** A bounded, read-only summary of loaded chats on the selected machine. */
export function buildNewChatActivity(
  threads: readonly DashboardThread[],
  environmentId: string | null,
  now: number,
) {
  const today = dayOrdinal(now);
  const date = DateTime.toPartsUtc(DateTime.makeUnsafe(today * DAY));
  const monthStart = Date.UTC(date.year, date.month - 1, 1) / DAY;
  const previousMonthStart = Date.UTC(date.year, date.month - 2, 1) / DAY;
  const start = today - date.weekDay - 25 * 7;
  const counts = new Map<number, number>();
  const seen = new Set<string>();
  for (const thread of threads) {
    if (
      thread.environmentId !== environmentId ||
      thread.deletedAt !== null ||
      thread.visibleItemCount === 0 ||
      thread.lineage.relationshipToParent === "subagent"
    )
      continue;
    const key = `${thread.environmentId}:${thread.id}`;
    const instant = Date.parse(thread.createdAt);
    if (seen.has(key) || !Number.isFinite(instant)) continue;
    seen.add(key);
    const day = dayOrdinal(instant);
    if (day > today || day < Math.min(start, previousMonthStart)) continue;
    counts.set(day, (counts.get(day) ?? 0) + 1);
  }
  const level = activityLevels(
    [...counts].filter(([day]) => day >= start).map(([, count]) => count),
  );
  const days = Array.from({ length: 26 * 7 }, (_, index) => {
    const day = start + index;
    const count = counts.get(day) ?? 0;
    return {
      date: DateTime.formatIsoDateUtc(DateTime.makeUnsafe(day * DAY)),
      count,
      future: day > today,
      level: level(count),
    };
  });
  const month = { chats: 0, activeDays: 0 };
  const previousMonth = { chats: 0, activeDays: 0 };
  // Month to date against the same days of last month, so the 7th compares 7 days.
  const elapsed = today - monthStart;
  for (const [day, count] of counts) {
    const bucket =
      day >= monthStart
        ? month
        : day >= previousMonthStart && day - previousMonthStart <= elapsed
          ? previousMonth
          : null;
    if (bucket) {
      bucket.chats += count;
      bucket.activeDays += 1;
    }
  }
  // Running totals by day of the month: this month up to today, last month for as many
  // days as this month has, so the two lines show who is ahead on the same day.
  const daysInMonth = Date.UTC(date.year, date.month, 1) / DAY - monthStart;
  const runningTotals = (from: number, length: number) => {
    let sum = 0;
    return Array.from({ length }, (_, index) => (sum += counts.get(from + index) ?? 0));
  };
  return {
    days,
    total: days.reduce((sum, day) => sum + day.count, 0),
    activeDays: days.filter((day) => day.count > 0).length,
    month,
    delta: {
      chats: month.chats - previousMonth.chats,
      activeDays: month.activeDays - previousMonth.activeDays,
    },
    pace: {
      daysInMonth,
      current: runningTotals(monthStart, elapsed + 1),
      previous: runningTotals(
        previousMonthStart,
        Math.min(daysInMonth, monthStart - previousMonthStart),
      ),
      month: monthName.format(monthStart * DAY),
      previousMonth: monthName.format(previousMonthStart * DAY),
    },
  };
}

export type ChatPace = ReturnType<typeof buildNewChatActivity>["pace"];

/**
 * The pace chart's geometry for a `width` by `height` box: this month's running total as
 * a line with the area under it and a dot on today, last month's as a second line. Both
 * share one scale, so the gap between them on today is the delta the card states.
 */
export function chatPaceChart(pace: ChatPace, width: number, height: number) {
  // Room for the today dot and the stroke at the edges.
  const inset = 4;
  const lastDay = Math.max(pace.daysInMonth - 1, 1);
  const top = Math.max(pace.current.at(-1) ?? 0, pace.previous.at(-1) ?? 0, 1);
  const x = (index: number) => inset + (index / lastDay) * (width - inset * 2);
  const y = (total: number) => height - inset - (total / top) * (height - inset * 2);
  const point = (total: number, index: number) => `${x(index).toFixed(1)} ${y(total).toFixed(1)}`;
  const line = (totals: ReadonlyArray<number>) =>
    totals.map((total, index) => `${index === 0 ? "M" : "L"}${point(total, index)}`).join("");
  const today = pace.current.length - 1;
  const current = line(pace.current);
  const previousEnd = pace.previous.length - 1;
  const previousTotal = pace.previous[previousEnd] ?? 0;
  return {
    current,
    previous: line(pace.previous),
    area:
      today > 0
        ? `${current}L${x(today).toFixed(1)} ${height - inset}L${x(0).toFixed(1)} ${height - inset}Z`
        : "",
    today: { x: x(today), y: y(pace.current[today] ?? 0) },
    /**
     * Where last month's line ends and what it reached, for a label there. Null when it
     * reached nothing, or when today's dot is close enough for the two to collide.
     */
    previousEnd:
      previousTotal > 0 && x(previousEnd) - x(today) > width * 0.15
        ? { x: x(previousEnd), y: y(previousTotal), total: previousTotal }
        : null,
  };
}

export function formatChatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `\u2212${-delta}` : "0";
}

/**
 * Heatmap shades follow the user's own busy days (quartiles of active days), so a
 * steady seven-chats-a-day habit still shows light and heavy days.
 */
function activityLevels(activeCounts: ReadonlyArray<number>): (count: number) => 0 | 1 | 2 | 3 | 4 {
  // A copied sort, not toSorted(): this runs on the phone's Hermes, which lacks it.
  const sorted = activeCounts.filter((count) => count > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return () => 0;
  const at = (fraction: number) => sorted[Math.floor(fraction * (sorted.length - 1))]!;
  const [low, mid, high] = [at(0.25), at(0.5), at(0.75)];
  if (sorted[0] === sorted.at(-1)) return (count) => (count === 0 ? 0 : 3);
  return (count) => (count === 0 ? 0 : count <= low ? 1 : count <= mid ? 2 : count <= high ? 3 : 4);
}

/** Absolute reset times remain truthful without a timer or background polling. */
export function formatQuotaReset(resetsAt: string | undefined): string {
  const instant = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return Number.isFinite(instant) ? `${resetDate.format(instant)} ET` : "Not reported";
}

/** Reuses the account deduplication used by Usage, including pooled sources. */
export function newChatUsageWindows(
  config: Pick<ServerConfig, "providers" | "usageLimitSources"> | null,
  environmentId: EnvironmentId,
  driver: string | null,
  /**
   * The account the selected model runs on. A provider with several accounts (a second
   * subscription) shows only that account's limits; without one, or when the account has no
   * entry of its own, every account of the provider shows.
   */
  instanceId?: string | null,
) {
  const accounts = collectLimitAccounts(
    new Map([
      [environmentId, { entry: { target: { label: "This machine" } }, serverConfig: config }],
    ]),
  );
  const selected = instanceId
    ? accounts.filter((account) => account.key === `${environmentId}:${instanceId}`)
    : [];
  return (
    (
      selected.length > 0
        ? selected
        : accounts.filter((account) => driver === null || account.driver === driver)
    )
      .flatMap((account) =>
        account.limits.windows.map((window) => ({
          ...window,
          key: `${account.key}:${window.id}`,
          accountLabel:
            account.displayName ?? (account.driver === "claudeAgent" ? "Claude" : account.driver),
          checkedAt: account.limits.checkedAt,
        })),
      )
      // The window closest to its limit leads; ties go to the one resetting first.
      // `flatMap` returned a new array, so sorting it in place is safe on Hermes.
      .sort(
        (left, right) =>
          right.usedPercent - left.usedPercent ||
          resetOrder(left.resetsAt) - resetOrder(right.resetsAt),
      )
  );
}

/** One of the user's accounts of the selected model's provider, on the new-chat screen. */
export interface NewChatAccountRow {
  readonly instanceId: string;
  readonly name: string;
  /** The limit that decides for this model: its tightest weekly or monthly one, or what blocks it. */
  readonly limit: {
    readonly label: string;
    readonly usedPercent: number;
    readonly resetsAt?: string;
  } | null;
  /** The account this new chat is set to start on. */
  readonly current: boolean;
}

/**
 * The accounts a new chat of `selection.model` could start on, as equals: one row each, the
 * one with the most to spare first, in an order that holds still when the chat moves
 * between them. Null when
 * the model runs on a single account. `note` says where new chats start and why.
 */
export function newChatAccounts(
  config: Pick<ServerConfig, "providers"> | null,
  selection: AccountSelection | null,
  now: number,
  /** Leaves out accounts this chat could not start the model on. */
  accepts?: (provider: ServerConfig["providers"][number], model: string) => boolean,
): { readonly rows: ReadonlyArray<NewChatAccountRow>; readonly note: string | null } | null {
  if (!config || !selection) return null;
  const nameOf = (instanceId: string) =>
    config.providers.find((provider) => provider.instanceId === instanceId)?.displayName ??
    instanceId;
  const standings = accountStandings(
    config.providers,
    selection,
    now,
    nameOf,
    accepts ? (provider) => accepts(provider, selection.model) : undefined,
  );
  if (standings.byInstance.size === 0) return null;
  const rows: NewChatAccountRow[] = [];
  for (const provider of config.providers) {
    const standing = standings.byInstance.get(provider.instanceId);
    if (!standing) continue;
    const limit = standing.blockedBy ?? standing.limit;
    rows.push({
      instanceId: provider.instanceId,
      name: nameOf(provider.instanceId),
      limit: limit
        ? {
            label: limit.label,
            usedPercent: 100 - limit.remainingPercent,
            ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
          }
        : null,
      current: provider.instanceId === selection.instanceId,
    });
  }
  return {
    rows: accountsByRoom(rows, (row) => row.instanceId, standings.byInstance),
    note: standings.newChatNote,
  };
}

function resetOrder(resetsAt: string | undefined) {
  const instant = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  return Number.isFinite(instant) ? instant : Number.POSITIVE_INFINITY;
}

export function chatBackdropTint(driver: string | null | undefined, agentId?: string | null) {
  return harnessIdentityTint(driver, agentId);
}

function mixHex(color: string, target: number, amount: number) {
  return `#${[1, 3, 5]
    .map((index) =>
      Math.round(
        Number.parseInt(color.slice(index, index + 2), 16) * (1 - amount) + target * amount,
      )
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Colors for the two horizon masks. The glow is the identity hue; the thin rim runs hotter,
 * toward white on dark themes and deeper on light ones, so the arc reads as light. The new
 * chat's cloud has a warmer centre than the rim on dark themes: a broad area that white
 * washes out the cards over it.
 */
export function chatBackdropPalette(driver: string | null | undefined, agentId?: string | null) {
  const glow = chatBackdropTint(driver, agentId);
  return {
    glow,
    rimDark: mixHex(glow, 255, 0.55),
    rimLight: mixHex(glow, 0, 0.2),
    cloudCoreDark: mixHex(glow, 255, 0.3),
  };
}

const BACKDROP_MOODS = ["working", "waiting", "done", "failed"] as const;
export type ChatBackdropMood = "idle" | (typeof BACKDROP_MOODS)[number];

/**
 * How the arc behind a conversation follows its turn, from the mascot's state so the two
 * agree: the mascot's other moments (a greeting, an idea) leave the arc at rest.
 */
export function chatBackdropMood(mascotState: string): ChatBackdropMood {
  return BACKDROP_MOODS.find((mood) => mood === mascotState) ?? "idle";
}

export interface HappeningNowEntry {
  readonly thread: EnvironmentThreadShell;
  readonly box: SessionBoxPresentation;
  readonly updatedAt: string;
}

/**
 * The chats working or waiting on the user right now, most-needed first: the same status
 * text and ranking as the Board. Subagents ride on their parent chat, snoozed chats stay
 * away, and work cached from a machine that is not connected does not count as running.
 */
export function selectHappeningNow(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  options: {
    readonly now: number;
    readonly connectionPhase: (
      environmentId: EnvironmentId,
    ) => EnvironmentConnectionPhase | undefined;
    /** Machines whose server tracks snoozing; elsewhere `snoozedUntil` is not trusted. */
    readonly snoozes?: (environmentId: EnvironmentId) => boolean;
    /** Chats the caller's lists leave out; asked only about the few that are active. */
    readonly isHidden?: (thread: EnvironmentThreadShell) => boolean;
  },
) {
  const entries: HappeningNowEntry[] = [];
  let preciseNow: string | null = null;
  for (const thread of threads) {
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.lineage.relationshipToParent === "subagent" ||
      !(
        thread.hasPendingApprovals ||
        thread.hasPendingUserInput ||
        thread.pendingSubagentRequest != null ||
        thread.hasActionableProposedPlan ||
        threadRuntimeIsActive(thread.runtime)
      )
    )
      continue;
    if (options.isHidden?.(thread) === true) continue;
    if (thread.snoozedUntil != null && options.snoozes?.(thread.environmentId) !== false) {
      preciseNow ??= DateTime.formatIso(DateTime.makeUnsafe(options.now));
      if (effectiveSnoozed(thread, { now: preciseNow })) continue;
    }
    const box = sessionBoxConnectionPresentation(
      presentSessionBoxCached(thread, { now: options.now, unseen: false }),
      options.connectionPhase(thread.environmentId),
    );
    if (box.tone !== "asking" && box.tone !== "working") continue;
    entries.push({ thread, box, updatedAt: thread.updatedAt });
  }
  entries.sort(compareSessionBoxes);
  let needsYou = 0;
  for (const entry of entries) if (entry.box.tone === "asking") needsYou++;
  return { entries, needsYou, working: entries.length - needsYou };
}
