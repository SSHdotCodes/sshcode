import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  ProviderThreadId,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { delegatedTaskProgressForTask } from "./DelegatedTaskProgress.ts";

it("keeps later follow-ups independent while awaiting the task's own descendants and completion turns", () => {
  const now = DateTime.makeUnsafe("2026-10-04T10:00:00Z");
  const originalId = NodeId.make("original");
  const task = { id: NodeId.make("followup"), prompt: "Check", startedAt: now };
  const laterId = NodeId.make("later");
  const run = (ordinal: number, delegatedTaskId?: NodeId): OrchestrationV2Run =>
    ({
      id: RunId.make(`run:${ordinal}`),
      ordinal,
      delegatedTaskId,
      userMessageId: MessageId.make(`message:${ordinal}`),
      providerThreadId: ProviderThreadId.make(`provider:${ordinal}`),
      requestedAt: now,
      startedAt: now,
      completedAt: DateTime.add(now, { seconds: ordinal }),
      status: "completed",
    }) as OrchestrationV2Run;
  const own = run(2, task.id);
  const later = { ...run(3, laterId), status: "running" as const, completedAt: null };
  const child = {
    thread: { forkedFrom: { type: "node", nodeId: originalId } },
    runs: [run(1), own, later],
    messages: [],
    subagents: [{ status: "running", runId: later.id }],
    providerThreads: [
      {
        id: later.providerThreadId,
        pendingBackgroundTasks: [{ taskId: "later", kind: "background_task" }],
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  assert.equal(delegatedTaskProgressForTask(child, task).state, "result_available");
  const grandchild = { status: "running", runId: own.id } as OrchestrationV2Subagent;
  const waiting = { ...child, subagents: [...child.subagents, grandchild] };
  assert.equal(delegatedTaskProgressForTask(waiting, task).state, "waiting_for_children");
  const wake = run(4);
  const completion = {
    id: wake.userMessageId,
    runId: wake.id,
    delegatedCompletion: {
      parentRunId: own.id,
      generation: 1,
      taskIds: [NodeId.make("grandchild")],
    },
  } as unknown as OrchestrationV2ThreadProjection["messages"][number];
  const delivering = {
    ...child,
    runs: [...child.runs, { ...wake, status: "queued" as const, startedAt: null }],
    messages: [completion],
    subagents: [
      {
        ...grandchild,
        status: "completed" as const,
        completionDelivery: { state: "claimed" as const, observedByRunId: null },
      },
    ],
  };
  assert.equal(delegatedTaskProgressForTask(delivering, task).state, "working");
  const consumed = { ...delivering, runs: [...child.runs, wake], subagents: [] };
  const finished = delegatedTaskProgressForTask(consumed, task);
  assert.equal(finished.state, "result_available");
  assert.equal(finished.resultRun?.id, wake.id);
  assert.deepEqual(
    finished.runs.map((run) => run.id),
    [own.id, wake.id],
  );
  const continuation = {
    ...run(5),
    restartContinuationOfRunId: wake.id,
    status: "running" as const,
  };
  assert.equal(
    delegatedTaskProgressForTask({ ...consumed, runs: [...consumed.runs, continuation] }, task)
      .state,
    "working",
  );
});

it("settles a follow-up whose initial run failed before starting", () => {
  const task = { id: NodeId.make("failed-followup"), prompt: "Check", startedAt: null };
  const run = {
    id: RunId.make("failed-followup"),
    delegatedTaskId: task.id,
    ordinal: 2,
    status: "failed",
    startedAt: null,
  } as OrchestrationV2Run;
  const child = {
    thread: { forkedFrom: { type: "node", nodeId: NodeId.make("original") } },
    runs: [run],
    messages: [],
    subagents: [],
    providerThreads: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const progress = delegatedTaskProgressForTask(child, task);
  assert.equal(progress.state, "result_available");
  assert.equal(progress.resultRun?.id, run.id);
});

it("keeps a delegated task working through provider backoff and its continuation", () => {
  const now = DateTime.makeUnsafe("2026-10-28T12:00:00Z");
  const task = { id: NodeId.make("retrying-task"), prompt: "Check", startedAt: now };
  const source = {
    id: RunId.make("retrying-task"),
    delegatedTaskId: task.id,
    userMessageId: MessageId.make("retrying-task"),
    ordinal: 1,
    status: "failed",
    startedAt: now,
    completedAt: now,
    automaticProviderRetry: {
      attempt: 1,
      status: "scheduled",
      scheduledAt: "2026-10-28T12:00:05Z",
    },
  } as OrchestrationV2Run;
  const child = {
    thread: { forkedFrom: { type: "node", nodeId: task.id } },
    runs: [source],
    messages: [],
    subagents: [],
    providerThreads: [],
  } as unknown as OrchestrationV2ThreadProjection;
  assert.equal(delegatedTaskProgressForTask(child, task).state, "working");
  const continued = {
    ...source,
    id: RunId.make("retrying-task:retry"),
    delegatedTaskId: undefined,
    ordinal: 2,
    status: "running" as const,
    completedAt: null,
    providerRetryContinuationOfRunId: source.id,
    automaticProviderRetry: {
      ...source.automaticProviderRetry!,
      status: "started" as const,
      scheduledAt: null,
    },
  };
  assert.equal(
    delegatedTaskProgressForTask(
      {
        ...child,
        runs: [
          {
            ...source,
            automaticProviderRetry: { ...source.automaticProviderRetry!, status: "started" },
          },
          continued,
        ],
      },
      task,
    ).state,
    "working",
  );
  assert.equal(
    delegatedTaskProgressForTask(
      {
        ...child,
        runs: [
          {
            ...source,
            automaticProviderRetry: {
              ...source.automaticProviderRetry!,
              status: "cancelled",
              scheduledAt: null,
            },
          },
        ],
      },
      task,
    ).state,
    "result_available",
  );
});
