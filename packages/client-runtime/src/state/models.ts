import {
  backgroundWorkHoldsCompletion,
  backgroundWorkTaskHoldsCompletion,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import { plainContextText } from "@t3tools/shared/composerContextReferences";
import type {
  ThreadLinkedPullRequest,
  EnvironmentId,
  MessageId,
  OrchestrationProjectShell,
  OrchestrationV2ProviderGoal,
  OrchestrationV2RunStatus,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatSubagentDisplayTitle } from "./subagentDisplay.ts";

export interface EnvironmentProject extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
  /** Derived from the environment's configured scratch root, never persisted. */
  readonly isScratch?: true;
}

/**
 * A pristine V2 thread projection paired with the environment that produced it.
 *
 * The projection stays nested so the server projection and all structurally
 * shared collections retain their identities. Rich consumers read V2 state
 * directly instead of a second presentation-shaped thread graph.
 */
export interface EnvironmentThread {
  readonly environmentId: EnvironmentId;
  readonly projection: OrchestrationV2ThreadProjection;
}

export interface ThreadRunSummary {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: MessageId | null;
  readonly sourcePlanRef?: {
    readonly threadId: ThreadId;
    readonly planId: PlanId;
  };
}

export interface ThreadRuntimeSummary {
  readonly status: OrchestrationV2RunStatus | "idle";
  readonly activeRunId: RunId | null;
  readonly activityStartedAt?: string | null | undefined;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerName: string | null;
  readonly lastError: string | null;
  readonly lastErrorClass?: OrchestrationV2ProviderFailureClass | null;
  /** The record `lastError` came from, with its change time so a repeated failure differs. */
  readonly lastErrorSource?: string | null;
  readonly usageLimitResetAt?: string | null;
  readonly updatedAt: string;
}

export function threadRuntimeIsActive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return runtime !== null && runtime !== undefined && threadRunStatusIsActive(runtime.status);
}

/** Archiving may discard queued work, but it must not detach a provider that
 * is preparing, starting, or running a turn. */
export function threadRuntimeCanArchive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  if (runtime?.status === "queued") return runtime.activeRunId === null;
  return (
    runtime?.status !== "preparing" &&
    runtime?.status !== "starting" &&
    runtime?.status !== "running"
  );
}

function threadRunStatusIsActive(status: ThreadRuntimeSummary["status"]): boolean {
  return (
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
}

export interface EnvironmentThreadShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: OrchestrationV2ThreadShell["modelSelection"];
  readonly runtimeMode: OrchestrationV2ThreadShell["runtimeMode"];
  readonly interactionMode: OrchestrationV2ThreadShell["interactionMode"];
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly lineage: OrchestrationV2ThreadShell["lineage"];
  readonly forkedFrom: OrchestrationV2ThreadShell["forkedFrom"];
  readonly activeProviderThreadId: OrchestrationV2ThreadShell["activeProviderThreadId"];
  readonly latestRun: ThreadRunSummary | null;
  readonly runtime: ThreadRuntimeSummary | null;
  readonly latestUserMessageAt: string | null;
  /** The last message the user wrote. `undefined` means the server predates it. */
  readonly latestUserAuthoredMessageAt?: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  /** What a live subagent below this thread waits on the user for. Subagent
      rows are hidden, so the threads above them carry it. */
  readonly pendingSubagentRequest?: PendingSubagentRequest | null;
  readonly hasActionableProposedPlan: boolean;
  readonly pendingBackgroundTasks: ReadonlyArray<
    NonNullable<OrchestrationV2ThreadShell["pendingBackgroundTasks"]>[number]
  >;
  /** Provider instances that have owned the root conversation, oldest first. */
  readonly providerInstanceHistory: ReadonlyArray<ProviderInstanceId>;
  /** Native `/goal` on the active provider thread. */
  readonly goal: OrchestrationV2ProviderGoal | null;
  readonly itemCount: number;
  readonly visibleItemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
  readonly unsettledAt: string | null;
  readonly snoozedUntil: string | null;
  readonly snoozedAt: string | null;
  readonly limitRecovery?: import("@t3tools/contracts").OrchestrationV2LimitRecovery | null;
  readonly pinnedAt: string | null;
  readonly autoSettleDisabledAt?: string | null;
  /** Slot in the user-arranged pinned order; null for keyless (legacy) pins. */
  readonly pinOrderKey: string | null;
  /** Slot in the user-arranged active order; null for keyless active threads. */
  readonly activeOrderKey: string | null;
  readonly pullRequests: ReadonlyArray<import("@t3tools/contracts").ThreadPullRequestLink>;
  /** Messages the user pinned, oldest pin first. Absent when there are none. */
  readonly pinnedMessages?: ReadonlyArray<{
    readonly messageId: import("@t3tools/contracts").MessageId;
    readonly pinnedAt: string;
    readonly preview?: string;
  }>;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null;
  /**
   * Server-tracked visited watermark. `undefined` means the environment's
   * server predates visited tracking and clients should fall back to any
   * local visited state they keep.
   */
  readonly lastVisitedAt?: string | null;
  /** Pending title regeneration marker; null when no request is in flight. */
  readonly titleRegeneration?: { readonly requestId: string; readonly startedAt: string } | null;
  /** Manual Long-running placement. Absent on older servers; null means the automatic rule. */
  readonly longRunningOverride?: "include" | "exclude" | null;
  /** Distinct America/New_York activity days. Absent means the server predates the index. */
  readonly activityDayCount?: number;
  /** Latest activity instant, ISO. */
  readonly activityLastAt?: string | null;
  readonly longRunningWork?: OrchestrationV2ThreadShell["longRunningWork"];
  readonly nextScheduledRunAt?: string | null;
  /** Per-chat subagents switch. Absent means on. */
  readonly subagentsEnabled?: boolean;
  readonly deletedAt: string | null;
  readonly source: OrchestrationV2ThreadShell;
}

function iso(value: DateTime.Utc): string {
  return DateTime.formatIso(value);
}

function nullableIso(value: DateTime.Utc | null): string | null {
  return value === null ? null : iso(value);
}

function terminalRunStatus(status: OrchestrationV2RunStatus): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rolled_back"
  );
}

// Park runtime at idle when the post-settlement background roster holds the
// run's completion, so #4415 waiting-presentation Waiting (session.idle) can
// consume CTM runtime. Only work that wakes the agent holds it: commands it
// left running, such as a dev server, present the run's own status (#14872).
// The server suppresses the roster while an interruptible activity run exists,
// so a remaining roster is stronger than checkpoint-oriented waiting.
// latestRun keeps the latest run's status for history presentation.
// A failed latest run outranks the roster, so the failure stays visible.
function shellRuntime(thread: OrchestrationV2ThreadShell): ThreadRuntimeSummary | null {
  const parkAtIdle =
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? []) &&
    thread.status !== "failed";
  // A pull request watch can hold a thread that never ran.
  if (thread.latestRunId === null && thread.activeProviderThreadId === null && !parkAtIdle) {
    return null;
  }
  const status = parkAtIdle ? "idle" : (thread.activityRunStatus ?? thread.status);
  return {
    status,
    activeRunId: thread.activeRunId,
    activityStartedAt: parkAtIdle
      ? null
      : thread.activityRunStartedAt === undefined
        ? undefined
        : nullableIso(thread.activityRunStartedAt),
    providerInstanceId: thread.providerInstanceId,
    providerName: null,
    lastError: thread.lastError ?? null,
    lastErrorClass: thread.lastErrorClass ?? null,
    usageLimitResetAt: thread.usageLimitResetAt ?? null,
    updatedAt: iso(thread.updatedAt),
  };
}

export function scopeProject(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentProject {
  return { ...project, environmentId };
}

export type PendingSubagentRequest = "approval" | "user_input";

/** A title seeded from a chip-only message reads as the chip's label; others stay as they are. */
function plainChipTitle(title: string): string {
  return typeof title === "string" && title.includes("](t3-context:")
    ? plainContextText(title) || title
    : title;
}

export function presentThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
  pendingSubagentRequest: PendingSubagentRequest | null = null,
): EnvironmentThreadShell {
  const updatedAt = iso(thread.updatedAt);
  const latestRun =
    thread.latestRunId === null
      ? null
      : ({
          runId: thread.latestRunId,
          status: thread.status === "idle" ? "completed" : thread.status,
          requestedAt: nullableIso(thread.latestRunRequestedAt ?? null),
          startedAt: nullableIso(thread.latestRunStartedAt ?? null),
          completedAt:
            thread.latestRunCompletedAt === undefined
              ? thread.status === "idle" || terminalRunStatus(thread.status)
                ? updatedAt
                : null
              : nullableIso(thread.latestRunCompletedAt),
          assistantMessageId: null,
        } satisfies ThreadRunSummary);
  return {
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title:
      thread.lineage.relationshipToParent === "subagent"
        ? formatSubagentDisplayTitle(thread.title)
        : plainChipTitle(thread.title),
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    pullRequests: threadPullRequestsOf(thread),
    ...((thread.pinnedMessages?.length ?? 0) === 0
      ? {}
      : {
          pinnedMessages: thread.pinnedMessages!.map((pin) => ({
            messageId: pin.messageId,
            pinnedAt: iso(pin.pinnedAt),
            ...(pin.preview === undefined ? {} : { preview: pin.preview }),
          })),
        }),
    linkedPullRequest: thread.linkedPullRequest ?? null,
    branchPullRequest: thread.branchPullRequest ?? null,
    lineage: thread.lineage,
    forkedFrom: thread.forkedFrom,
    activeProviderThreadId: thread.activeProviderThreadId,
    latestRun,
    runtime: shellRuntime(thread),
    latestUserMessageAt: nullableIso(thread.latestUserMessageAt),
    ...(thread.latestUserAuthoredMessageAt === undefined
      ? {}
      : { latestUserAuthoredMessageAt: nullableIso(thread.latestUserAuthoredMessageAt) }),
    hasPendingApprovals:
      thread.pendingRuntimeRequest !== null &&
      thread.pendingRuntimeRequest.kind !== "user_input" &&
      thread.pendingRuntimeRequest.kind !== "auth_refresh",
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
    pendingSubagentRequest,
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    pendingBackgroundTasks: thread.pendingBackgroundTasks ?? [],
    providerInstanceHistory: thread.providerInstanceHistory ?? [],
    goal: thread.goal ?? null,
    itemCount: thread.itemCount,
    visibleItemCount: thread.visibleItemCount,
    createdAt: iso(thread.createdAt),
    updatedAt,
    archivedAt: nullableIso(thread.archivedAt),
    settledOverride: thread.settledOverride,
    settledAt: nullableIso(thread.settledAt),
    unsettledAt: nullableIso(thread.unsettledAt ?? null),
    snoozedUntil: nullableIso(thread.snoozedUntil ?? null),
    snoozedAt: nullableIso(thread.snoozedAt ?? null),
    limitRecovery: thread.limitRecovery ?? null,
    pinnedAt: nullableIso(thread.pinnedAt ?? null),
    autoSettleDisabledAt: nullableIso(thread.autoSettleDisabledAt ?? null),
    pinOrderKey: thread.pinOrderKey ?? null,
    activeOrderKey: thread.activeOrderKey ?? null,
    ...(thread.lastVisitedAt === undefined
      ? {}
      : { lastVisitedAt: nullableIso(thread.lastVisitedAt) }),
    titleRegeneration:
      thread.titleRegeneration == null
        ? null
        : {
            requestId: thread.titleRegeneration.requestId,
            startedAt: iso(thread.titleRegeneration.startedAt),
          },
    longRunningOverride: thread.longRunningOverride ?? null,
    activityDayCount: thread.activityDayCount ?? 0,
    activityLastAt:
      thread.activityLastAt === undefined || thread.activityLastAt === null
        ? null
        : iso(thread.activityLastAt),
    longRunningWork: thread.longRunningWork,
    nextScheduledRunAt: thread.nextScheduledRunAt ?? null,
    subagentsEnabled: thread.subagentsEnabled !== false,
    deletedAt: nullableIso(thread.deletedAt),
    source: thread,
  };
}

export function scopeThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
): EnvironmentThreadShell {
  return presentThreadShell(environmentId, thread);
}

const THREAD_PROVIDER_STACK_LIMIT = 3;

/**
 * Provider instances to draw in a thread row's trailing stack, back to front:
 * the current one is always last, earlier owners precede it oldest first.
 * Newest history wins when the thread has been handed off more times than fit.
 */
export function resolveThreadProviderStack(
  thread: Pick<EnvironmentThreadShell, "providerInstanceHistory" | "modelSelection" | "runtime">,
): ReadonlyArray<ProviderInstanceId> {
  const current = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const previous = thread.providerInstanceHistory.filter((instanceId) => instanceId !== current);
  return [...previous.slice(-(THREAD_PROVIDER_STACK_LIMIT - 1)), current];
}

/**
 * When a chat last showed a sign of life: its newest event or the start of its current step,
 * whichever is later. Null when neither timestamp is usable.
 */
export function resolveThreadLastActivityAt(thread: {
  readonly updatedAt: string;
  readonly source: Pick<OrchestrationV2ThreadShell, "currentStep">;
}): string | null {
  const stepStartedAt = thread.source.currentStep?.startedAt;
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const candidate of [
    thread.updatedAt,
    stepStartedAt ? DateTime.formatIso(stepStartedAt) : null,
  ]) {
    if (!candidate) continue;
    const parsed = Date.parse(candidate);
    if (Number.isNaN(parsed) || parsed <= latestMs) continue;
    latest = candidate;
    latestMs = parsed;
  }
  return latest;
}

/**
 * Both shell and detail timers count from the activity-owning run's work
 * start, never last activity. A wake keeps the start of the work it continues.
 */
export function resolveThreadWorkingStartedAt(input: {
  readonly latestRun: Pick<
    ThreadRunSummary,
    "runId" | "startedAt" | "requestedAt" | "completedAt"
  > | null;
  readonly runtime: Pick<ThreadRuntimeSummary, "activeRunId" | "activityStartedAt"> | null;
}): string | null {
  const valid = (value: string | null | undefined) =>
    value != null && Number.isFinite(Date.parse(value)) ? value : null;
  if (input.runtime?.activityStartedAt !== undefined) return valid(input.runtime.activityStartedAt);
  // Older servers can supply a timestamp only if the newest run owns the work.
  const run = input.latestRun;
  if (run?.completedAt === null && run.runId === input.runtime?.activeRunId) {
    return valid(run.startedAt) ?? valid(run.requestedAt);
  }
  return null;
}

/** Use a later start only when every holding task has a known start after the turn. */
export function resolveThreadWaitingStartedAt(input: {
  readonly latestRun: Pick<ThreadRunSummary, "completedAt"> | null;
  readonly pendingBackgroundTasks: EnvironmentThreadShell["pendingBackgroundTasks"];
}): string | null {
  const completedAt = input.latestRun?.completedAt ?? null;
  if (completedAt === null) return null;

  let earliestStart: string | undefined;
  let earliestMs = Number.POSITIVE_INFINITY;
  for (const task of input.pendingBackgroundTasks) {
    if (!backgroundWorkTaskHoldsCompletion(task)) continue;
    const startedAt = task.kind === "subagent" ? task.startedAt : undefined;
    if (startedAt === undefined) return completedAt;
    const startedMs = Date.parse(startedAt);
    if (!Number.isFinite(startedMs)) return completedAt;
    if (startedMs < earliestMs) {
      earliestStart = startedAt;
      earliestMs = startedMs;
    }
  }
  return earliestStart !== undefined && earliestMs > Date.parse(completedAt)
    ? earliestStart
    : completedAt;
}
