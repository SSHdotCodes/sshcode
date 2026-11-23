import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  resolveThreadWaitingStartedAt,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { failureNeedsYou } from "@t3tools/client-runtime/state/thread-inbox";

import {
  resolveThreadListV2ActivityAt,
  resolveThreadListV2DisplayStatus,
  resolveThreadListV2Status,
} from "../threads/threadListV2";
import { isWorkflowThread } from "../workflows/workflowVisibility";

// The bedside screen: a black clock over Home while the phone charges, listing
// the chats that need the user, are working, or just finished.

export const BEDSIDE_IDLE_MS = 60_000;
export const BEDSIDE_UNPLUG_GRACE_MS = 3_000;
export const BEDSIDE_MAX_ROWS = 5;
const FINISHED_WINDOW_MS = 60 * 60_000;

export type BedsideState = "needsYou" | "failed" | "working" | "finished";

export interface BedsideRow {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly state: BedsideState;
  readonly label: string;
}

export interface BedsideSnapshot {
  readonly rows: ReadonlyArray<BedsideRow>;
  /** Qualifying chats beyond the rows shown. */
  readonly more: number;
  readonly needsYou: number;
  readonly working: number;
}

const STATE_RANK: Record<BedsideState, number> = {
  needsYou: 0,
  failed: 1,
  working: 2,
  finished: 3,
};

function timestamp(value: string | null | undefined): number | null {
  if (value == null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** "<1m", "12m", "1h", "1h 5m". */
export function formatBedsideElapsed(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
}

/** Where a chat lands on the bedside screen, using the same status as its Home row. */
function classify(
  thread: EnvironmentThreadShell,
  now: number,
  phase: EnvironmentConnectionPhase | undefined,
): { readonly state: BedsideState; readonly label: string; readonly sortAt: number } | null {
  const status = resolveThreadListV2Status(thread);
  const activityAt = timestamp(resolveThreadListV2ActivityAt(thread)) ?? 0;
  if (status === "approval" || status === "input") {
    return { state: "needsYou", label: "Needs you", sortAt: activityAt };
  }
  if (status === "failed" || status === "limited") {
    // A failure the user has already opened is history, not news.
    if (!failureNeedsYou(thread, now)) return null;
    return {
      state: "failed",
      label: "Failed",
      sortAt: timestamp(thread.latestRun?.completedAt) ?? activityAt,
    };
  }
  if (status === "working" || status === "waiting") {
    // Cached work in a disconnected environment is not live.
    if (resolveThreadListV2DisplayStatus(status, phase) !== status) return null;
    const startedAt = timestamp(
      status === "waiting"
        ? resolveThreadWaitingStartedAt(thread)
        : resolveThreadWorkingStartedAt(thread),
    );
    return {
      state: "working",
      label: startedAt === null ? "" : formatBedsideElapsed(now - startedAt),
      sortAt: activityAt,
    };
  }
  const completedAt = timestamp(thread.latestRun?.completedAt);
  if (completedAt === null || now - completedAt >= FINISHED_WINDOW_MS) return null;
  const ago = now - completedAt;
  return {
    state: "finished",
    label: ago < 60_000 ? "Done now" : `Done ${formatBedsideElapsed(ago)}`,
    sortAt: completedAt,
  };
}

/**
 * Chats that need the user first, then failed, working and recently finished
 * ones, each newest first. Pass the same thread shells Home lists.
 */
export function buildBedsideSnapshot(input: {
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly now: number;
  readonly connectionPhases: ReadonlyMap<string, EnvironmentConnectionPhase>;
}): BedsideSnapshot {
  const entries: Array<BedsideRow & { readonly sortAt: number }> = [];
  for (const thread of input.threads) {
    if (thread.archivedAt !== null) continue;
    if (thread.lineage.relationshipToParent === "subagent" || isWorkflowThread(thread)) continue;
    const entry = classify(thread, input.now, input.connectionPhases.get(thread.environmentId));
    if (entry === null) continue;
    entries.push({ key: `${thread.environmentId}:${thread.id}`, thread, ...entry });
  }
  entries.sort(
    (left, right) =>
      STATE_RANK[left.state] - STATE_RANK[right.state] ||
      right.sortAt - left.sortAt ||
      left.key.localeCompare(right.key),
  );
  return {
    rows: entries
      .slice(0, BEDSIDE_MAX_ROWS)
      .map(({ key, thread, state, label }) => ({ key, thread, state, label })),
    more: Math.max(0, entries.length - BEDSIDE_MAX_ROWS),
    needsYou: entries.filter((entry) => entry.state === "needsYou").length,
    working: entries.filter((entry) => entry.state === "working").length,
  };
}

/** Parts of "2 need you · 3 working"; empty means "All quiet". */
export function bedsideSummaryParts(counts: {
  readonly needsYou: number;
  readonly working: number;
}): ReadonlyArray<{ readonly tone: "attention" | "working"; readonly text: string }> {
  const parts: Array<{ readonly tone: "attention" | "working"; readonly text: string }> = [];
  if (counts.needsYou > 0) {
    parts.push({
      tone: "attention",
      text: `${counts.needsYou} ${counts.needsYou === 1 ? "needs" : "need"} you`,
    });
  }
  if (counts.working > 0) parts.push({ tone: "working", text: `${counts.working} working` });
  return parts;
}

/** Whether the device locale writes 13:00 as "13". */
export function localeUses24Hour(locale?: string): boolean {
  return new Intl.DateTimeFormat(locale, { hour: "numeric" })
    .format(new Date(2000, 0, 1, 13))
    .includes("13");
}

export function formatBedsideClock(
  date: Date,
  uses24Hour: boolean,
): { readonly time: string; readonly period: "AM" | "PM" | null } {
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const hours = date.getHours();
  if (uses24Hour) return { time: `${String(hours).padStart(2, "0")}:${minutes}`, period: null };
  return { time: `${hours % 12 || 12}:${minutes}`, period: hours < 12 ? "AM" : "PM" };
}

/** "Saturday, November 14" in the device locale. */
export function formatBedsideDate(date: Date, locale?: string): string {
  return date.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" });
}

export function msUntilNextMinute(now: number): number {
  return 60_000 - (now % 60_000);
}

// Small drifts within ±10 pt so no pixel holds the same glyph all night.
const OFFSETS = [
  [0, 0],
  [7, -5],
  [-6, 6],
  [10, 3],
  [-9, -7],
  [3, 10],
  [-10, 1],
  [6, -10],
] as const;

export function bedsideOffset(step: number): { readonly x: number; readonly y: number } {
  const [x, y] = OFFSETS[((step % OFFSETS.length) + OFFSETS.length) % OFFSETS.length]!;
  return { x, y };
}

export interface BedsideConditions {
  readonly enabled: boolean;
  readonly charging: boolean;
  readonly appActive: boolean;
  /** Home's chat list is the visible screen: focused, no sheet, tab active. */
  readonly homeVisible: boolean;
  readonly keyboardVisible: boolean;
}

/** Whether a minute without touches may bring the screen up. */
export function bedsideCanIdle(conditions: BedsideConditions): boolean {
  return (
    conditions.enabled &&
    conditions.charging &&
    conditions.appActive &&
    conditions.homeVisible &&
    !conditions.keyboardVisible
  );
}

/**
 * Why a shown bedside screen should leave, or null to stay. A preview ignores
 * charging and Home; both leave when the app goes to the background. Callers
 * wait `BEDSIDE_UNPLUG_GRACE_MS` before acting on "unplugged".
 */
export function bedsideLeaveReason(
  mode: "idle" | "preview",
  conditions: Omit<BedsideConditions, "keyboardVisible">,
): "background" | "hidden" | "unplugged" | null {
  if (!conditions.appActive) return "background";
  if (mode === "preview") return null;
  if (!conditions.enabled || !conditions.homeVisible) return "hidden";
  return conditions.charging ? null : "unplugged";
}
