/**
 * Live progress for Settings > Agents token use High: time left, stage estimates and the
 * card both clients draw, from what the agent reported (`report_progress`) or its own todo
 * list. Everything is computed against a caller's clock, so "time left" keeps counting
 * between reports instead of freezing at the last one.
 *
 * Estimates follow one rule set. Remaining time is the pending stages' minutes plus the active
 * stage's minutes minus its elapsed time (at least one minute), each times the model's learned
 * pace. Without minutes it extrapolates a reported percent from elapsed time. Without either
 * there is no estimate: the bar is indeterminate and no number is shown.
 *
 * @module liveProgress
 */
import type {
  OrchestrationV2LiveProgress,
  OrchestrationV2LiveProgressStage,
} from "@t3tools/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A model whose estimates ran short or long moves the estimate at most this far. */
export const LIVE_PROGRESS_PACE_MIN = 0.5;
export const LIVE_PROGRESS_PACE_MAX = 3;
/** Estimated minutes the calibration pretends were exact, so a few samples move it gently. */
export const LIVE_PROGRESS_PACE_PRIOR_MINUTES = 15;
/** An active stage past its estimate still has at least this much left. */
export const LIVE_PROGRESS_ACTIVE_FLOOR_MS = MINUTE;
/** Longer estimates are not believable; past this there is no number. */
export const LIVE_PROGRESS_MAX_REMAINING_MS = 12 * HOUR;
/** A percent below this says too little to extrapolate from. */
const MIN_EXTRAPOLATION_PERCENT = 5;
const MIN_EXTRAPOLATION_ELAPSED_MS = MINUTE;

export interface LiveProgressPaceSample {
  /** The agent's estimate for a stage, in minutes. */
  readonly estimatedMinutes: number;
  /** How long the stage really took, in minutes. */
  readonly actualMinutes: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/**
 * The factor a model's minute estimates are multiplied by: actual over estimated time across its
 * past stages, pulled toward 1 by a prior so one odd stage cannot swing it. A stage that ran far
 * past its estimate (the agent waited on the user, say) counts as at most four times it.
 */
export function liveProgressPace(samples: ReadonlyArray<LiveProgressPaceSample>): number {
  let estimated = LIVE_PROGRESS_PACE_PRIOR_MINUTES;
  let actual = LIVE_PROGRESS_PACE_PRIOR_MINUTES;
  for (const sample of samples) {
    if (
      !Number.isFinite(sample.estimatedMinutes) ||
      !Number.isFinite(sample.actualMinutes) ||
      !(sample.estimatedMinutes > 0) ||
      !(sample.actualMinutes >= 0)
    )
      continue;
    estimated += sample.estimatedMinutes;
    actual += Math.min(sample.actualMinutes, sample.estimatedMinutes * 4 + 5);
  }
  return clamp(actual / estimated, LIVE_PROGRESS_PACE_MIN, LIVE_PROGRESS_PACE_MAX);
}

export interface LiveProgressStageEstimate {
  readonly title: string;
  readonly status: OrchestrationV2LiveProgressStage["status"];
  /** Done stages whose start the app saw. */
  readonly durationMs: number | null;
  /** Active stages: time in the stage so far. */
  readonly elapsedMs: number | null;
  /** Active and pending stages with an estimate: what is left of it (all of it when pending). */
  readonly remainingMs: number | null;
  /** Active and pending stages with an estimate: when it should finish. */
  readonly finishAt: number | null;
  /** Active stages with an estimate: how far into it, 0–1. */
  readonly fraction: number | null;
}

export interface LiveProgressEstimate {
  /** Null when there is no estimate: never a made-up number. */
  readonly remainingMs: number | null;
  readonly finishAt: number | null;
  /** Overall progress 0–1; null draws an indeterminate bar. */
  readonly fraction: number | null;
  /** The active stage ran well past its estimate with no new report, so the number was dropped. */
  readonly overdue: boolean;
  readonly stages: ReadonlyArray<LiveProgressStageEstimate>;
  /** The first active stage, or the first pending one when none is active; -1 when all are done. */
  readonly currentIndex: number;
}

const stageMs = (minutes: number | undefined, pace: number) =>
  minutes !== undefined && Number.isFinite(minutes) && minutes > 0 ? minutes * pace * MINUTE : null;

/** Time left, the bar and per-stage times at `nowMs`. */
export function estimateLiveProgress(
  progress: OrchestrationV2LiveProgress,
  nowMs: number,
): LiveProgressEstimate {
  const pace =
    progress.pace !== undefined && Number.isFinite(progress.pace)
      ? clamp(progress.pace, LIVE_PROGRESS_PACE_MIN, LIVE_PROGRESS_PACE_MAX)
      : 1;
  const elapsedTotal = Math.max(0, nowMs - progress.startedAt);
  const stages = progress.stages;
  const currentIndex = (() => {
    const active = stages.findIndex((stage) => stage.status === "active");
    return active !== -1 ? active : stages.findIndex((stage) => stage.status === "pending");
  })();
  const unfinished = stages.filter((stage) => stage.status !== "done");
  const minutesKnown =
    unfinished.length > 0 && unfinished.every((stage) => stageMs(stage.minutes, pace) !== null);

  // Active stages run side by side; pending ones follow them in order.
  let activeRemaining = 0;
  let overdue = false;
  const activeTimes = new Map<OrchestrationV2LiveProgressStage, number>();
  for (const stage of stages) {
    if (stage.status !== "active") continue;
    const elapsed = Math.max(0, nowMs - (stage.startedAt ?? progress.reportedAt));
    activeTimes.set(stage, elapsed);
    const expected = stageMs(stage.minutes, pace);
    if (expected === null) continue;
    // Well past its estimate and silent since: the old number no longer means anything.
    if (elapsed > expected * 2 + 5 * MINUTE && nowMs - progress.reportedAt > 5 * MINUTE)
      overdue = true;
    activeRemaining = Math.max(
      activeRemaining,
      Math.max(expected - elapsed, LIVE_PROGRESS_ACTIVE_FLOOR_MS),
    );
  }

  let cursor = nowMs + activeRemaining;
  const stageEstimates = stages.map((stage): LiveProgressStageEstimate => {
    const expected = stageMs(stage.minutes, pace);
    if (stage.status === "done") {
      return {
        title: stage.title,
        status: stage.status,
        durationMs: stage.durationMs ?? null,
        elapsedMs: null,
        remainingMs: null,
        finishAt: null,
        fraction: null,
      };
    }
    if (stage.status === "active") {
      const elapsed = activeTimes.get(stage) ?? 0;
      const remaining =
        expected === null ? null : Math.max(expected - elapsed, LIVE_PROGRESS_ACTIVE_FLOOR_MS);
      return {
        title: stage.title,
        status: stage.status,
        durationMs: null,
        elapsedMs: elapsed,
        remainingMs: minutesKnown && !overdue ? remaining : null,
        finishAt: minutesKnown && !overdue && remaining !== null ? nowMs + remaining : null,
        fraction:
          expected === null || overdue
            ? null
            : clamp(elapsed / (elapsed + (remaining ?? 0)), 0, 0.97),
      };
    }
    if (expected !== null) cursor += expected;
    return {
      title: stage.title,
      status: stage.status,
      durationMs: null,
      elapsedMs: null,
      remainingMs: minutesKnown && !overdue ? expected : null,
      finishAt: minutesKnown && !overdue ? cursor : null,
      fraction: null,
    };
  });

  const base = { stages: stageEstimates, currentIndex };
  if (stages.length > 0 && unfinished.length === 0)
    return { ...base, remainingMs: 0, finishAt: nowMs, fraction: 1, overdue: false };
  if (minutesKnown) {
    const remaining = cursor - nowMs;
    if (overdue || remaining > LIVE_PROGRESS_MAX_REMAINING_MS)
      return { ...base, remainingMs: null, finishAt: null, fraction: null, overdue };
    return {
      ...base,
      remainingMs: remaining,
      finishAt: cursor,
      fraction: clamp(elapsedTotal / (elapsedTotal + remaining), 0, 0.99),
      overdue: false,
    };
  }
  const percent =
    progress.percent !== undefined && Number.isFinite(progress.percent)
      ? progress.percent
      : undefined;
  if (percent !== undefined && percent >= 100)
    return { ...base, remainingMs: 0, finishAt: nowMs, fraction: 1, overdue: false };
  const elapsedAtReport = progress.reportedAt - progress.startedAt;
  if (
    percent !== undefined &&
    percent >= MIN_EXTRAPOLATION_PERCENT &&
    elapsedAtReport >= MIN_EXTRAPOLATION_ELAPSED_MS
  ) {
    const remainingAtReport = (elapsedAtReport * (100 - percent)) / percent;
    const projected = progress.reportedAt + remainingAtReport;
    // Silent long past the projection: the percent is stale, so it says nothing about now.
    const stale = nowMs > progress.reportedAt + remainingAtReport * 2 + 5 * MINUTE;
    const finishAt = Math.max(projected, nowMs + LIVE_PROGRESS_ACTIVE_FLOOR_MS);
    if (stale || finishAt - nowMs > LIVE_PROGRESS_MAX_REMAINING_MS)
      return { ...base, remainingMs: null, finishAt: null, fraction: null, overdue: stale };
    return {
      ...base,
      remainingMs: finishAt - nowMs,
      finishAt,
      fraction: clamp(percent / 100, 0, 0.99),
      overdue: false,
    };
  }
  return { ...base, remainingMs: null, finishAt: null, fraction: null, overdue: false };
}

function minutesText(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 5) * 5;
  if (rest === 0 || rest === 60) return `${rest === 60 ? hours + 1 : hours} hr`;
  return `${hours} hr ${rest} min`;
}

/**
 * Time left in the card's voice: "about 12 min left" on the card, "~8 min left" in compact rows,
 * "8 min left" on the phone's working pill. A minute or less is "almost done".
 */
export function formatTimeLeft(
  remainingMs: number,
  style: "card" | "compact" | "pill" = "card",
): string {
  if (remainingMs <= MINUTE) return "almost done";
  const text = minutesText(remainingMs);
  return style === "card"
    ? `about ${text} left`
    : style === "compact"
      ? `~${text} left`
      : `${text} left`;
}

/** A stage's estimate: "~5 min". */
export function formatStageEstimate(remainingMs: number): string {
  return `~${minutesText(remainingMs)}`;
}

/** How long a done stage took: "45s", "4m", "1h 5m". */
export function formatStageDuration(durationMs: number): string {
  if (durationMs < MINUTE) return `${Math.max(1, Math.round(durationMs / 1_000))}s`;
  const minutes = Math.round(durationMs / MINUTE);
  if (minutes < 60) return `${minutes}m`;
  const rest = minutes % 60;
  return rest === 0 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 60)}h ${rest}m`;
}

/** An update's age: "just now", "2m ago", "3h ago". */
export function formatUpdateAge(atMs: number, nowMs: number): string {
  const age = Math.max(0, nowMs - atMs);
  if (age < MINUTE) return "just now";
  if (age < HOUR) return `${Math.floor(age / MINUTE)}m ago`;
  return `${Math.floor(age / HOUR)}h ago`;
}

// Made on first use, so it follows the viewer's time zone at that moment.
let localClock: Intl.DateTimeFormat | undefined;

/**
 * A finish time on the viewer's local 12-hour clock, "6:45 PM". Far-off finishes round to five
 * minutes, since they are estimates.
 */
export function formatFinishClock(finishAt: number, nowMs: number): string {
  const step = finishAt - nowMs > 15 * MINUTE ? 5 * MINUTE : MINUTE;
  localClock ??= new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" });
  // Newer ICU puts a narrow no-break space before AM/PM.
  return localClock.format(Math.round(finishAt / step) * step).replace(/\s/gu, " ");
}

export interface LiveProgressCardStage {
  readonly title: string;
  readonly status: OrchestrationV2LiveProgressStage["status"];
  /** "4m" for a done stage, "~5 min" for an active or pending one; null when unknown. */
  readonly label: string | null;
  /** "done around 6:45 PM" for active and pending stages with an estimate. */
  readonly finishLabel: string | null;
  /** Active stages with an estimate: the mini bar, 0–1. */
  readonly fraction: number | null;
}

export interface LiveProgressCard {
  /** The current stage's title; null when the agent sent no stages. */
  readonly title: string | null;
  /** "about 12 min left", "almost done", "longer than estimated", or null. */
  readonly timeLeft: string | null;
  /** "~12 min left" for compact rows. */
  readonly compactTimeLeft: string | null;
  /** "12 min left" for the phone's working pill. */
  readonly pillTimeLeft: string | null;
  /** "done around 6:45 PM"; null without an estimate. */
  readonly finishLabel: string | null;
  /** Null draws the indeterminate shimmer. */
  readonly fraction: number | null;
  readonly stages: ReadonlyArray<LiveProgressCardStage>;
  /** The current stage, or -1 when every stage is done. */
  readonly currentIndex: number;
  /** Indexes shown while the list is collapsed: the current stage and one on either side. */
  readonly collapsedRange: readonly [start: number, end: number];
  /** Newest first, at most three. */
  readonly updates: ReadonlyArray<{
    readonly text: string;
    readonly age: string;
    readonly at: number;
  }>;
  readonly latestUpdate: string | null;
}

/** Everything the progress card and its compact rows show, at `nowMs`. */
export function liveProgressCard(
  progress: OrchestrationV2LiveProgress,
  nowMs: number,
): LiveProgressCard {
  const estimate = estimateLiveProgress(progress, nowMs);
  const stages = estimate.stages.map((stage): LiveProgressCardStage => ({
    title: stage.title,
    status: stage.status,
    label:
      stage.status === "done"
        ? stage.durationMs === null
          ? null
          : formatStageDuration(stage.durationMs)
        : stage.remainingMs === null
          ? null
          : formatStageEstimate(stage.remainingMs),
    finishLabel:
      stage.finishAt === null ? null : `done around ${formatFinishClock(stage.finishAt, nowMs)}`,
    fraction: stage.fraction,
  }));
  const current = estimate.currentIndex;
  const anchor = current === -1 ? stages.length - 1 : current;
  const collapsedRange: readonly [number, number] = [
    Math.max(0, anchor - 1),
    Math.min(stages.length, anchor + 2),
  ];
  const remaining = estimate.remainingMs;
  return {
    title:
      current !== -1
        ? (stages[current]?.title ?? null)
        : (stages[stages.length - 1]?.title ?? null),
    timeLeft:
      remaining !== null
        ? formatTimeLeft(remaining, "card")
        : estimate.overdue
          ? "longer than estimated"
          : null,
    compactTimeLeft: remaining !== null ? formatTimeLeft(remaining, "compact") : null,
    pillTimeLeft: remaining !== null ? formatTimeLeft(remaining, "pill") : null,
    finishLabel:
      estimate.finishAt !== null && remaining !== null && remaining > MINUTE
        ? `done around ${formatFinishClock(estimate.finishAt, nowMs)}`
        : null,
    fraction: estimate.fraction,
    stages,
    currentIndex: current,
    collapsedRange,
    updates: progress.updates.slice(0, 3).map((update) => ({
      text: update.text,
      age: formatUpdateAge(update.at, nowMs),
      at: update.at,
    })),
    latestUpdate: progress.updates[0]?.text ?? null,
  };
}
