/**
 * Each working chat's live progress (Settings > Agents token use High), kept in memory. The
 * `report_progress` tool and the todo-list reactor write it; thread shells read it
 * synchronously while they assemble rows, and a change re-sends only that chat's shell.
 *
 * Nothing here is persisted: progress describes live work, and a restart interrupts that work.
 * Only the calibration learned from finished stages outlives a restart (LiveProgress.ts).
 */
import {
  LIVE_PROGRESS_STAGES_MAX,
  LIVE_PROGRESS_TITLE_MAX,
  LIVE_PROGRESS_UPDATE_MAX,
  LIVE_PROGRESS_UPDATES_KEPT,
  type OrchestrationV2LiveProgress,
  type OrchestrationV2LiveProgressStage,
  type OrchestrationV2PlanStep,
  type ReportProgressInput,
} from "@t3tools/contracts";
import { estimateLiveProgress, type LiveProgressPaceSample } from "@t3tools/shared/liveProgress";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import { announceBoxChange } from "../sessionBoxes/boxNamerCache.ts";

/** Chats remembered at once; the least recently changed is forgotten first. */
export const LIVE_PROGRESS_THREADS_MAX = 500;

interface ThreadProgress {
  /** The work these reports describe; a run that starts other work clears them. */
  readonly workStartedAt: number;
  report: OrchestrationV2LiveProgress | undefined;
  todo: OrchestrationV2LiveProgress | undefined;
}

const threads = new Map<string, ThreadProgress>();

const shown = (entry: ThreadProgress | undefined) => entry?.report ?? entry?.todo;

let enabled = false;

/** True while Settings > Agents token use is High; otherwise nothing is shown or sent. */
export const liveProgressEnabled = () => enabled;

/**
 * Set from server settings by the reactor (LiveProgress.ts), before it re-sends shells, so a
 * shell built for that announcement already sees the new level.
 */
export function setLiveProgressEnabled(next: boolean) {
  if (next === enabled) return;
  enabled = next;
  announceAllLiveProgress();
}

/** What the chat's shell carries now, or nothing when token use is not High. */
export function liveProgressFor(threadId: string): OrchestrationV2LiveProgress | undefined {
  return liveProgressEnabled() ? shown(threads.get(threadId)) : undefined;
}

/** Shell rows carry progress only while the chat works or waits on its own subagents. */
export function shellLiveProgress(
  threadId: string,
  working: boolean,
): { readonly liveProgress?: OrchestrationV2LiveProgress } {
  if (!working) return {};
  const progress = liveProgressFor(threadId);
  return progress === undefined ? {} : { liveProgress: progress };
}

function touch(threadId: string, entry: ThreadProgress) {
  threads.delete(threadId);
  threads.set(threadId, entry);
  while (threads.size > LIVE_PROGRESS_THREADS_MAX) {
    const oldest = threads.keys().next();
    if (oldest.done === true) break;
    threads.delete(oldest.value);
  }
  if (liveProgressEnabled()) announceBoxChange(threadId);
}

function entryFor(threadId: string, workStartedAt: number): ThreadProgress {
  const existing = threads.get(threadId);
  if (existing !== undefined && existing.workStartedAt === workStartedAt) return existing;
  return { workStartedAt, report: undefined, todo: undefined };
}

/** The start of the work the chat's progress describes, if it has any. */
export function liveProgressWorkStart(threadId: string): number | undefined {
  return threads.get(threadId)?.workStartedAt;
}

/** A run of other work began: earlier progress no longer describes the chat. */
export function beginLiveProgressWork(threadId: string, workStartedAt: number) {
  const existing = threads.get(threadId);
  if (existing === undefined || existing.workStartedAt === workStartedAt) return;
  threads.delete(threadId);
  if (shown(existing) !== undefined && liveProgressEnabled()) announceBoxChange(threadId);
}

export function forgetLiveProgress(threadId: string) {
  const existing = threads.get(threadId);
  if (existing === undefined) return;
  threads.delete(threadId);
  if (shown(existing) !== undefined && liveProgressEnabled()) announceBoxChange(threadId);
}

/** Re-sends every chat with progress, after token use moved to or from High. */
export function announceAllLiveProgress() {
  for (const [threadId, entry] of threads)
    if (shown(entry) !== undefined) announceBoxChange(threadId);
}

const normalTitle = (title: string) => title.trim().replace(/\s+/gu, " ").toLowerCase();
const clip = (text: string, max: number) => {
  const plain = text.trim().replace(/\s+/gu, " ");
  return plain.length <= max ? plain : `${plain.slice(0, max - 1).trimEnd()}…`;
};
const validMinutes = (minutes: number | undefined) =>
  minutes !== undefined && Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;

export interface AppliedReport {
  readonly progress: OrchestrationV2LiveProgress;
  /** Stages this report finished whose start and estimate the app saw: calibration data. */
  readonly samples: ReadonlyArray<LiveProgressPaceSample>;
}

/**
 * Merge one `report_progress` call into the chat's progress. Stages are matched by title, so a
 * stage keeps the moment the app first saw it active; a report without stages keeps the last
 * ones. Updates accumulate, newest first.
 */
export function applyLiveProgressReport(input: {
  readonly threadId: string;
  readonly workStartedAt: number;
  readonly nowMs: number;
  readonly report: ReportProgressInput;
  /** The calling model's learned pace; 1 or absent without history. */
  readonly pace?: number | undefined;
}): AppliedReport {
  const entry = entryFor(input.threadId, input.workStartedAt);
  const previous = entry.report;
  const previousByTitle = new Map(
    (previous?.stages ?? []).map((stage) => [normalTitle(stage.title), stage]),
  );
  const samples: LiveProgressPaceSample[] = [];
  const firstReport = previous === undefined;
  const reported = input.report.stages?.slice(0, LIVE_PROGRESS_STAGES_MAX);
  const anyDone = reported?.some((stage) => stage.status === "done") ?? false;
  const stages =
    reported === undefined
      ? (previous?.stages ?? [])
      : reported.flatMap((stage): OrchestrationV2LiveProgressStage[] => {
          const title = clip(stage.title, LIVE_PROGRESS_TITLE_MAX);
          if (title.length === 0) return [];
          const before = previousByTitle.get(normalTitle(title));
          const minutes = validMinutes(stage.minutes) ?? before?.minutes;
          const base = {
            title,
            status: stage.status,
            ...(minutes === undefined ? {} : { minutes }),
          };
          if (stage.status === "active") {
            // The first stage of a first report started with the work itself.
            const startedAt =
              before?.status === "active" && before.startedAt !== undefined
                ? before.startedAt
                : firstReport && !anyDone
                  ? input.workStartedAt
                  : input.nowMs;
            return [{ ...base, startedAt }];
          }
          if (stage.status === "done") {
            if (before?.status === "done")
              return [
                before.durationMs === undefined ? base : { ...base, durationMs: before.durationMs },
              ];
            if (before?.status === "active" && before.startedAt !== undefined) {
              const durationMs = Math.max(0, input.nowMs - before.startedAt);
              const estimated = before.minutes;
              if (estimated !== undefined)
                samples.push({ estimatedMinutes: estimated, actualMinutes: durationMs / 60_000 });
              return [{ ...base, durationMs }];
            }
            return [base];
          }
          return [base];
        });
  const update =
    input.report.update === undefined ? "" : clip(input.report.update, LIVE_PROGRESS_UPDATE_MAX);
  const updates =
    update.length === 0 || previous?.updates[0]?.text === update
      ? (previous?.updates ?? [])
      : [{ text: update, at: input.nowMs }, ...(previous?.updates ?? [])].slice(
          0,
          LIVE_PROGRESS_UPDATES_KEPT,
        );
  // New stages carry their own progress; an older percent would contradict them.
  const reportedPercent =
    input.report.percent !== undefined && Number.isFinite(input.report.percent)
      ? Math.min(100, Math.max(0, input.report.percent))
      : undefined;
  const percent = reportedPercent ?? (reported === undefined ? previous?.percent : undefined);
  const pace = input.pace !== undefined && input.pace !== 1 ? input.pace : undefined;
  const draft: OrchestrationV2LiveProgress = {
    source: "report",
    startedAt: input.workStartedAt,
    reportedAt: input.nowMs,
    stages,
    updates,
    ...(percent === undefined ? {} : { percent }),
    ...(pace === undefined ? {} : { pace }),
  };
  const finishAt = estimateLiveProgress(draft, input.nowMs).finishAt;
  const progress = finishAt === null ? draft : { ...draft, etaAt: finishAt };
  entry.report = progress;
  touch(input.threadId, entry);
  return { progress, samples };
}

const PLAN_STATUS: Record<
  OrchestrationV2PlanStep["status"],
  OrchestrationV2LiveProgressStage["status"]
> = {
  completed: "done",
  running: "active",
  pending: "pending",
};

/**
 * Stages from the agent's own todo or plan list (Claude TodoWrite, Codex update_plan and the
 * others' todo items), shown only while it has not called `report_progress`. Those lists carry
 * no minutes, so the estimate comes from how much of the list is done.
 */
export function applyLiveProgressTodo(input: {
  readonly threadId: string;
  readonly workStartedAt: number;
  readonly nowMs: number;
  readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
}) {
  const entry = entryFor(input.threadId, input.workStartedAt);
  const steps = input.steps.slice(0, LIVE_PROGRESS_STAGES_MAX);
  if (steps.length === 0) {
    if (entry.todo === undefined) return;
    entry.todo = undefined;
    touch(input.threadId, entry);
    return;
  }
  const stages = steps.map((step): OrchestrationV2LiveProgressStage => {
    const title = clip(step.text, LIVE_PROGRESS_TITLE_MAX);
    const status = PLAN_STATUS[step.status];
    if (status === "active") {
      const anchor =
        step.durationAnchorAt === undefined ? Option.none() : DateTime.make(step.durationAnchorAt);
      return {
        title,
        status,
        startedAt: Option.isSome(anchor) ? DateTime.toEpochMillis(anchor.value) : input.nowMs,
      };
    }
    if (status === "done" && step.durationMs !== undefined)
      return { title, status, durationMs: step.durationMs };
    return { title, status };
  });
  const done = stages.filter((stage) => stage.status === "done").length;
  const previous = entry.todo;
  const same =
    previous !== undefined &&
    previous.stages.length === stages.length &&
    previous.stages.every(
      (stage, index) =>
        stage.title === stages[index]?.title &&
        stage.status === stages[index]?.status &&
        stage.durationMs === stages[index]?.durationMs,
    );
  if (same) return;
  entry.todo = {
    source: "todo",
    startedAt: input.workStartedAt,
    reportedAt: input.nowMs,
    stages,
    updates: [],
    // Steps differ in size, so only a list with something done says how far along it is.
    ...(done > 0 ? { percent: Math.round((100 * done) / stages.length) } : {}),
  };
  touch(input.threadId, entry);
}

/** Tests start from an empty store. */
export function resetLiveProgressStoreForTest(options: { readonly enabled?: boolean } = {}) {
  threads.clear();
  enabled = options.enabled ?? false;
}
