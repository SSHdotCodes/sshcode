/**
 * What a chat has out (monitors, background tasks, subagents, a next run) for
 * its row's status line, the per-chat subagents switch, and the day index
 * the server keeps. The Long-running sidebar section was removed (11-19);
 * the server still stores old overrides, but nothing reads them for placement.
 */

export const SUBAGENT_ORCHESTRATION_TOOLS = [
  "delegate_task",
  "council",
  "task_status",
  "task_cancel",
  "workflow",
] as const;

export type LongRunningOverride = "include" | "exclude";

// Made on first use, so days follow this machine's time zone at that moment.
let localDayFormat: Intl.DateTimeFormat | undefined;

/** Calendar day in this machine's local time zone, `YYYY-MM-DD`. */
export function localCalendarDay(instantMs: number): string {
  return (localDayFormat ??= new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })).format(instantMs);
}

export function isSubagentOrchestrationTool(name: string): boolean {
  return (SUBAGENT_ORCHESTRATION_TOOLS as readonly string[]).includes(name);
}

export interface LongRunningFacts {
  readonly working: boolean;
  readonly workingStartedAtMs: number | null;
  readonly monitorCount: number;
  readonly backgroundTaskCount: number;
  readonly runningSubagentCount: number;
  readonly nextScheduledRunAtMs: number | null;
  readonly nowMs: number;
}

function formatElapsedLabel(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * A working turn reads as quiet once nothing has happened in it for this long. Longer than a
 * single tool call may run, so a slow command does not trip it.
 */
export const QUIET_TURN_AFTER_MS = 15 * 60_000;

/** How long until a turn last active at `lastActivityMs` reads as quiet; 0 once it does. */
export function msUntilQuietTurn(lastActivityMs: number, now: number): number {
  return Math.max(0, lastActivityMs + QUIET_TURN_AFTER_MS - now);
}

/**
 * "Quiet 22m" for a working turn that has shown nothing for that long, null while it is still
 * lively or its last activity is unknown. Grey, not a warning: quiet is a fact, stuck a guess.
 */
export function quietTurnLabel(lastActivityMs: number | null, nowMs: number): string | null {
  if (lastActivityMs === null || !Number.isFinite(lastActivityMs)) return null;
  if (msUntilQuietTurn(lastActivityMs, nowMs) > 0) return null;
  return `Quiet ${formatElapsedLabel(nowMs - lastActivityMs)}`;
}

export interface LongRunningStatusInput extends LongRunningFacts {
  readonly needsYou: boolean;
  readonly locale?: string;
  readonly timeZone?: string;
}

function nextRunLabel(input: LongRunningStatusInput): string | null {
  const next = input.nextScheduledRunAtMs;
  if (next === null || !Number.isFinite(next)) return null;
  const day = new Intl.DateTimeFormat(input.locale, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: input.timeZone,
  });
  const today = day.format(next) === day.format(input.nowMs);
  const time = new Intl.DateTimeFormat(input.locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: input.timeZone,
  }).format(next);
  const weekday = today
    ? ""
    : new Intl.DateTimeFormat(input.locale, {
        weekday: "short",
        timeZone: input.timeZone,
      }).format(next) + " ";
  return `Next run ${weekday}${time}`;
}

/** First matching fact replaces the ordinary time label. */
export function longRunningStatusLine(input: LongRunningStatusInput): string | null {
  if (input.needsYou) return "Needs you";
  if (input.working) {
    const elapsed = input.workingStartedAtMs === null ? 0 : input.nowMs - input.workingStartedAtMs;
    return `Working ${formatElapsedLabel(elapsed)}`;
  }
  if (input.runningSubagentCount > 0) {
    return `${input.runningSubagentCount} ${input.runningSubagentCount === 1 ? "subagent" : "subagents"} running`;
  }
  if (input.monitorCount > 0) {
    return `Waiting on ${input.monitorCount} ${input.monitorCount === 1 ? "monitor" : "monitors"}`;
  }
  if (input.backgroundTaskCount > 0) {
    return `Waiting on ${input.backgroundTaskCount} background ${input.backgroundTaskCount === 1 ? "task" : "tasks"}`;
  }
  return nextRunLabel(input);
}

/**
 * What a pinned or main-list chat has out while its own turn is idle:
 * subagents, monitors, background tasks or its next scheduled run. Without
 * this line a chat with monitors out looked finished. Working and "Needs you"
 * already show in any row's status.
 */
export function pinnedWaitingLine(input: LongRunningStatusInput): string | null {
  return input.needsYou || input.working ? null : longRunningStatusLine(input);
}

const WORKING_STATUSES = new Set(["running", "waiting", "preparing", "starting", "queued"]);

/** Normalize compact shell facts shared by phone and desktop lists. */
export function longRunningFactsForShell(input: {
  readonly hasPendingApprovals?: boolean;
  readonly hasPendingUserInput?: boolean;
  readonly pendingSubagentRequest?: "approval" | "user_input" | null;
  readonly runtimeStatus: string | null;
  readonly workingStartedAt: string | null;
  readonly pendingBackgroundTasks?: ReadonlyArray<{ readonly kind?: string }>;
  readonly longRunningWork?:
    | {
        readonly monitorCount: number;
        readonly backgroundTaskCount: number;
        readonly runningSubagentCount: number;
      }
    | undefined;
  readonly nextScheduledRunAt?: string | null | undefined;
  readonly nowMs: number;
}): LongRunningStatusInput {
  const instant = (value: string | null | undefined) => {
    const parsed = value == null ? NaN : Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const tasks = input.pendingBackgroundTasks ?? [];
  return {
    needsYou:
      input.hasPendingApprovals === true ||
      input.hasPendingUserInput === true ||
      input.pendingSubagentRequest === "approval" ||
      input.pendingSubagentRequest === "user_input",
    working: input.runtimeStatus !== null && WORKING_STATUSES.has(input.runtimeStatus),
    workingStartedAtMs: instant(input.workingStartedAt),
    monitorCount:
      input.longRunningWork?.monitorCount ?? tasks.filter((task) => task.kind === "monitor").length,
    backgroundTaskCount:
      input.longRunningWork?.backgroundTaskCount ??
      tasks.filter((task) => task.kind !== "monitor" && task.kind !== "subagent").length,
    runningSubagentCount:
      input.longRunningWork?.runningSubagentCount ??
      tasks.filter((task) => task.kind === "subagent").length,
    nextScheduledRunAtMs: instant(input.nextScheduledRunAt),
    nowMs: input.nowMs,
  };
}

export function longRunningStatusForShell(
  input: Parameters<typeof longRunningFactsForShell>[0],
): string | null {
  return longRunningStatusLine(longRunningFactsForShell(input));
}

/**
 * What a still-running subagent is waiting on once its own turn has ended:
 * the work it left running. Null while it is working or has nothing out, so
 * its card keeps the ordinary status.
 */
export function subagentBackgroundWaitLabel(input: {
  readonly runtimeStatus: string | null;
  readonly longRunningWork?:
    | {
        readonly monitorCount: number;
        readonly backgroundTaskCount: number;
        readonly runningSubagentCount: number;
      }
    | undefined;
}): string | null {
  if (input.runtimeStatus !== null && WORKING_STATUSES.has(input.runtimeStatus)) return null;
  const work = input.longRunningWork;
  if (!work) return null;
  const count = (n: number, one: string, many: string) => `Waiting on ${n} ${n === 1 ? one : many}`;
  if (work.runningSubagentCount > 0)
    return count(work.runningSubagentCount, "subagent", "subagents");
  if (work.monitorCount > 0) return count(work.monitorCount, "monitor", "monitors");
  if (work.backgroundTaskCount > 0)
    return count(work.backgroundTaskCount, "background task", "background tasks");
  return null;
}

export function subagentsToggleNeedsConfirm(nextEnabled: boolean): boolean {
  return nextEnabled === false;
}

export function subagentsOffConfirmation(modelLabel: string): {
  readonly question: string;
  readonly detail: string;
  readonly secondary: string;
} {
  const model = modelLabel.trim().length > 0 ? modelLabel.trim() : "This model";
  return {
    question: "Turn off subagents for this chat?",
    detail: `${model} will do all the work itself: no subagents on other models, no council, no SSHCode delegation.`,
    secondary:
      "Separate chats still open with create_threads. Claude Code's Agent tool, its page reader, and Codex's own agents stay.",
  };
}

export const SUBAGENTS_OFF_USER_LINE = "Subagents are off for this chat; do the work yourself.";

export const SUBAGENTS_ON_USER_LINE = "Subagents are back on for this chat.";
