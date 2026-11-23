import type {
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  RunId,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import { delegatedTaskProgress } from "@t3tools/provider-core/server/subagentProjection";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";

import * as DateTime from "effect/DateTime";

/**
 * The child run a follow-up task's own message went to. Runs recorded before
 * delegatedTaskId survived stale run updates can have lost a follow-up's
 * binding; the message, sent at the task's start with its prompt, still names
 * the run.
 */
export function followupRunsByMessage(
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
  task: Pick<OrchestrationV2Subagent, "prompt" | "startedAt">,
): ReadonlyArray<OrchestrationV2Run> {
  if (task.startedAt === null) return [];
  const startedAt = DateTime.toEpochMillis(task.startedAt);
  const message = child.messages.find(
    (candidate) =>
      candidate.role === "user" &&
      candidate.runId !== null &&
      candidate.text === task.prompt &&
      DateTime.toEpochMillis(candidate.createdAt) === startedAt,
  );
  const run = child.runs.find(
    (candidate) => candidate.id === message?.runId && candidate.delegatedTaskId === undefined,
  );
  return run === undefined ? [] : [run];
}

/** Runs a task owns, including automatic turns that finish its awaited work. */
export function delegatedTaskRuns(
  child: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
  task: Pick<OrchestrationV2Subagent, "id" | "prompt" | "startedAt">,
) {
  const original =
    child.thread.forkedFrom?.type !== "node" || child.thread.forkedFrom.nodeId === task.id;
  const bound = child.runs.filter((run) => run.delegatedTaskId === task.id);
  const roots =
    bound.length > 0
      ? bound
      : original
        ? child.runs.filter((run) => run.delegatedTaskId === undefined).slice(0, 1)
        : followupRunsByMessage(child, task);
  const firstOrdinal = Math.min(...roots.map((run) => run.ordinal));
  const nextOrdinal = Math.min(
    ...child.runs
      .filter(
        (run) =>
          run.ordinal > firstOrdinal &&
          run.delegatedTaskId !== undefined &&
          run.delegatedTaskId !== task.id,
      )
      .map((run) => run.ordinal),
  );
  const ids = new Set(roots.map((run) => run.id));
  const messages = new Map(child.messages.map((message) => [message.id, message]));
  const completionParents = new Map<RunId, Set<RunId>>();
  for (const message of child.messages) {
    if (message.runId === null || message.delegatedCompletion === undefined) continue;
    const parents = completionParents.get(message.runId) ?? new Set<RunId>();
    parents.add(message.delegatedCompletion.parentRunId);
    completionParents.set(message.runId, parents);
  }
  for (const run of child.runs) {
    const message = messages.get(run.userMessageId);
    if (
      run.delegatedTaskId === undefined &&
      run.ordinal >= firstOrdinal &&
      run.ordinal < nextOrdinal &&
      ((original && bound.length === 0) ||
        message?.notification !== undefined ||
        message?.delegatedCompletion !== undefined)
    )
      ids.add(run.id);
  }
  // A completion can arrive after another follow-up started. Its durable
  // parent-run link still belongs to the task that delegated that work.
  let changed = true;
  while (changed) {
    changed = false;
    for (const run of child.runs) {
      if (ids.has(run.id)) continue;
      if (
        (run.restartContinuationOfRunId !== undefined && ids.has(run.restartContinuationOfRunId)) ||
        (run.providerRetryContinuationOfRunId !== undefined &&
          ids.has(run.providerRetryContinuationOfRunId)) ||
        [...(completionParents.get(run.id) ?? [])].some((id) => ids.has(id))
      ) {
        ids.add(run.id);
        changed = true;
      }
    }
  }
  const runs = child.runs.filter((run) => ids.has(run.id));
  return runs;
}

export function delegatedTaskProgressForTask(
  child: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "subagents" | "providerThreads"
  >,
  task: Pick<OrchestrationV2Subagent, "id" | "prompt" | "startedAt">,
  hasOpenMonitors = false,
) {
  const runs = delegatedTaskRuns(child, task);
  const ids = new Set(runs.map((run) => run.id));
  const original =
    child.thread.forkedFrom?.type !== "node" || child.thread.forkedFrom.nodeId === task.id;
  const subagents = child.subagents.filter((task) =>
    task.runId != null ? ids.has(task.runId) : original,
  );
  const providerThreads = child.providerThreads.filter((thread) => {
    // Rosters describe the provider thread's latest executed turn, not a later
    // queued follow-up. Older tasks must not wait on unrelated later rosters.
    const owner =
      latestExecutedRun(child.runs.filter((run) => run.providerThreadId === thread.id)) ??
      latestExecutedRun(child.runs);
    return owner === null || ids.has(owner.id);
  });
  return {
    ...delegatedTaskProgress({
      runs,
      initialRunId: runs.toSorted((a, b) => a.ordinal - b.ordinal)[0]?.id,
      messages: child.messages,
      subagents,
      providerThreads,
      hasOpenMonitors,
    }),
    runs,
  };
}
