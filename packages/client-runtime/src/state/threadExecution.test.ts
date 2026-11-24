import {
  TurnItemId,
  NodeId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { usageLimitBlockedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  notificationSubagent,
  decodeRelayedSubagentMessages,
  providerSubagentRelayText,
  recentRelayedSubagentMessages,
  presentPendingBackgroundWork,
  formatPendingBackgroundWorkItem,
  presentProviderGoal,
  deriveReportedModelSelection,
  deriveLatestThreadRun,
  deriveProviderSubagentStatus,
  formatModelSelectionEffort,
  formatProviderSubagentStatus,
  formatRelayedSentAt,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  threadRuntimeHasInterruptibleRun,
} from "./threadExecution.ts";
import { threadRuntimeCanArchive, type ThreadRuntimeSummary } from "./models.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");

function run(id: string, ordinal: number, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(id),
    threadId: v2Projection.thread.id,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

describe("thread execution presentation", () => {
  it("derives the current root failure without inheriting errors from children or previous runs", () => {
    const failed = { ...run("limited", 1, "failed"), rootNodeId: NodeId.make("root") };
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed], turnItems: [item] };
    expect(deriveThreadRuntime(projection)).toMatchObject({
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, nodeId: NodeId.make("child") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({
        ...projection,
        runs: [{ ...failed, rootNodeId: NodeId.make("new-root") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, run("new", 2, "running")] }),
    ).toMatchObject({ status: "running", lastError: null, lastErrorClass: null });
  });

  it("counts a wake run's activity from the start of the work it continues", () => {
    const workStartedAt = DateTime.makeUnsafe("2026-07-28T09:20:00.000Z");
    const wake = { ...run("wake", 2, "running"), workStartedAt };
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "completed"), wake] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T09:20:00.000Z");
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "running")] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T10:00:00.000Z");
  });

  it("keeps a subscription limit visible while later messages stay queued", () => {
    const failed = {
      ...run("limited", 1, "failed"),
      rootNodeId: NodeId.make("root"),
      completedAt: now,
    };
    const queued = run("queued", 2, "queued");
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed, queued], turnItems: [item] };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "failed",
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
      lastErrorSource: "limit-error@2026-07-28T10:00:00.000Z",
    });
    // A retried run fails again through the same item, so only its failure time tells it apart.
    const later = DateTime.makeUnsafe("2026-07-28T10:05:00.000Z");
    const source = (input: Partial<Parameters<typeof deriveThreadRuntime>[0]>) =>
      deriveThreadRuntime({ ...projection, ...input })?.lastErrorSource;
    expect(source({ turnItems: [{ ...item, completedAt: later, updatedAt: later }] })).toBe(
      "limit-error@2026-07-28T10:05:00.000Z",
    );
    expect(source({ turnItems: [{ ...item, updatedAt: later }] })).toBe(
      "limit-error@2026-07-28T10:00:00.000Z",
    );
    const session = (lastError: string) => ({
      id: ProviderSessionId.make("failed-session"),
      driver: ProviderDriverKind.make("pi"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      status: "error" as const,
      cwd: "/repo",
      model: null,
      capabilities: {} as never,
      createdAt: now,
      updatedAt: later,
      lastError,
    });
    // A session that repeats the failure keeps its source, whatever the session's own updates.
    expect(source({ providerSessions: [session("Plan limit reached")] })).toBe(
      "limit-error@2026-07-28T10:00:00.000Z",
    );
    // Otherwise a session error belongs to the latest ended run, kept while a newer run starts.
    const starting = [failed, run("next", 2, "starting")];
    expect(source({ runs: [failed], providerSessions: [session("Session failed")] })).toBe(
      "limited@2026-07-28T10:00:00.000Z",
    );
    expect(source({ runs: starting, providerSessions: [session("Session failed")] })).toBe(
      "limited@2026-07-28T10:00:00.000Z",
    );
    expect(source({ runs: starting, providerSessions: [session("Plan limit reached")] })).toBe(
      "limit-error@2026-07-28T10:00:00.000Z",
    );
    const cancelledQueued = {
      ...run("cancelled-queued", 3, "cancelled"),
      startedAt: null,
      completedAt: now,
    };
    expect(
      usageLimitBlockedRun([failed, queued, cancelledQueued], projection.turnItems, null)?.id,
    ).toBe(failed.id);
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, queued, cancelledQueued] }),
    ).toMatchObject({ status: "failed", lastErrorClass: "usage_limit" });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, failure: { ...item.failure, class: "provider_error" as const } }],
      }),
    ).toMatchObject({ status: "queued", lastErrorClass: null });
  });

  it("keeps live activity attached to an executing run when a newer run is queued", () => {
    const runningRun = run("run-running", 1, "running");
    const queuedRun = run("run-queued", 2, "queued");
    const projection = { ...v2Projection, runs: [queuedRun, runningRun], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(queuedRun.id);
    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: runningRun.id,
      status: "running",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "running",
      activeRunId: runningRun.id,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("presents a held queue as the stopped run instead of queued work", () => {
    const interrupted = { ...run("run-interrupted", 1, "interrupted"), completedAt: now };
    const held = { ...run("run-held", 2, "queued"), queueHeld: true };
    const projection = { ...v2Projection, runs: [interrupted, held], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "interrupted",
      activeRunId: null,
    });

    // Resuming clears the hold, and the run reads as queued until it starts.
    const resumed = { ...projection, runs: [interrupted, { ...held, queueHeld: false }] };
    expect(deriveThreadRuntime(resumed)).toMatchObject({ status: "queued" });

    // Recovery can hold a first message before any run executed; it is not work.
    const onlyHeld = {
      ...projection,
      runs: [held],
      thread: { ...projection.thread, activeProviderThreadId: null },
    };
    expect(deriveLatestThreadRun(onlyHeld)).toBeNull();
    expect(deriveThreadRuntime(onlyHeld)).toBeNull();
  });

  it("does not expose a queued-only run as interruptible", () => {
    const queuedRun = run("run-queued", 1, "queued");
    const projection = { ...v2Projection, runs: [queuedRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: queuedRun.id,
      status: "queued",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "queued",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("keeps checkpoint-wait activity visible without exposing a non-functional interrupt", () => {
    const waitingRun = run("run-waiting", 1, "waiting");
    const projection = { ...v2Projection, runs: [waitingRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: waitingRun.id,
      status: "waiting",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "waiting",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it("does not expose a stale active run after the runtime parks at idle", () => {
    const runtime = {
      status: "idle" as const,
      activeRunId: RunId.make("run-stale"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });

  it.each(["preparing", "starting"] as const)("keeps an active %s run interruptible", (status) => {
    const runtime = {
      status,
      activeRunId: RunId.make(`run-${status}`),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: DateTime.formatIso(now),
    };

    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("parks runtime at idle with null activityStartedAt while an open-prompt provider thread waits on background work", () => {
    const running = run("run-open-wait", 1, "running");
    const providerThreadId = v2Projection.thread.activeProviderThreadId!;
    const projection = {
      ...v2Projection,
      runs: [running],
      providerThreads: [
        {
          id: providerThreadId,
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: v2Projection.thread.providerInstanceId,
          providerSessionId: null,
          appThreadId: v2Projection.thread.id,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          pendingBackgroundTasks: [
            {
              taskId: "bench-1",
              kind: "command" as const,
              wakesAgent: true as const,
              description: "Run benchmark",
            },
          ],
          waitingOnBackgroundWork: true as const,
          createdAt: now,
          updatedAt: now,
        },
      ],
    };

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "idle",
      activeRunId: running.id,
      activityStartedAt: null,
    });
  });
});

describe("deriveRunlessWorkStartedAt", () => {
  const later = DateTime.makeUnsafe("2026-07-28T10:05:00.000Z");
  const rootTurn = (
    status: OrchestrationV2ExecutionNode["status"],
    startedAt = now,
  ): OrchestrationV2ExecutionNode => ({
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn",
    status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt,
    completedAt: null,
  });

  const nativeChild = {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource: "provider" as const,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
  };

  it("times a provider-native subagent from its runless root turn while it works", () => {
    const projection = { ...nativeChild, nodes: [rootTurn("running", later)] };
    expect(deriveRunlessWorkStartedAt(projection)).toBe("2026-07-28T10:05:00.000Z");
    // The subagent has no run, so it stays unstoppable and unqueueable.
    expect(deriveThreadRuntime(projection)).toBeNull();
  });

  it.each(["completed", "cancelled", "failed", "interrupted", "idle"] as const)(
    "is idle once the subagent is %s",
    (status) => {
      expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [rootTurn(status)] })).toBe(null);
    },
  );

  it("ignores root turns that belong to a run, and threads the provider does not run", () => {
    const owned = { ...rootTurn("running"), runId: RunId.make("run-1") };
    expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [owned] })).toBeNull();
    expect(
      deriveRunlessWorkStartedAt({ ...v2Projection, nodes: [rootTurn("running")] }),
    ).toBeNull();
  });
});

describe("deriveProviderSubagentStatus", () => {
  const root = {
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn" as const,
    status: "completed" as const,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: now,
  };
  const child = (creationSource: "provider" | "mcp") => ({
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
    nodes: [root],
  });

  it("reports the provider's own subagent from its runless root turn", () => {
    expect(deriveProviderSubagentStatus(child("provider"))).toEqual({
      status: "completed",
      startedAt: "2026-07-28T10:00:00.000Z",
      completedAt: "2026-07-28T10:00:00.000Z",
    });
  });

  it("says how long the subagent has worked, or took", () => {
    const startedAt = "2026-07-28T10:00:00.000Z";
    const at = (iso: string) => Date.parse(iso);
    expect(
      formatProviderSubagentStatus(
        { status: "running", startedAt, completedAt: null },
        at("2026-07-28T10:01:05.400Z"),
      ),
    ).toBe("Working 1m 5s");
    expect(
      formatProviderSubagentStatus(
        { status: "completed", startedAt, completedAt: "2026-07-28T10:00:34.000Z" },
        at("2026-07-28T11:00:00.000Z"),
      ),
    ).toBe("Completed in 34s");
    expect(
      formatProviderSubagentStatus(
        { status: "cancelled", startedAt, completedAt: "2026-07-28T10:00:34.000Z" },
        0,
      ),
    ).toBe("Cancelled");
    expect(formatProviderSubagentStatus(null, 0)).toBe("Starting");
  });

  it("leaves T3 delegated tasks and ordinary threads alone", () => {
    expect(deriveProviderSubagentStatus(child("mcp"))).toBeNull();
    expect(deriveProviderSubagentStatus({ ...v2Projection, nodes: [root] })).toBeNull();
  });
});

describe("formatModelSelectionEffort", () => {
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const selection = (options?: ReadonlyArray<{ id: string; value: string }>) => ({
    instanceId,
    model: "claude-sonnet-5",
    ...(options === undefined ? {} : { options }),
  });
  const catalog = (descriptor: { currentValue?: string }) => [
    {
      slug: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Reasoning",
            type: "select" as const,
            options: [
              { id: "medium", label: "Medium" },
              { id: "high", label: "High", isDefault: true },
              { id: "xhigh", label: "Extra High" },
            ],
            ...descriptor,
          },
        ],
      },
    },
  ];

  it("names Antigravity thinking levels from its model's catalog", () => {
    const models = catalog({ currentValue: "medium" }).map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: model.capabilities.optionDescriptors.map((descriptor) => ({
          ...descriptor,
          id: "thinking_level",
        })),
      },
    }));
    expect(
      formatModelSelectionEffort(selection([{ id: "thinking_level", value: "xhigh" }]), models),
    ).toBe("Extra High");
  });

  it.each(["thought_level", "reasoning_effort", "thinking"] as const)(
    "names %s reasoning descriptors from the model catalog",
    (optionId) => {
      const models = catalog({ currentValue: "medium" }).map((model) => ({
        ...model,
        capabilities: {
          optionDescriptors: model.capabilities.optionDescriptors.map((descriptor) => ({
            ...descriptor,
            id: optionId,
          })),
        },
      }));
      expect(
        formatModelSelectionEffort(selection([{ id: optionId, value: "xhigh" }]), models),
      ).toBe("Extra High");
    },
  );

  it("names provider-defined reasoning descriptors marked by role", () => {
    const models = catalog({ currentValue: "medium" }).map((model) => ({
      ...model,
      capabilities: {
        optionDescriptors: model.capabilities.optionDescriptors.map((descriptor) => ({
          ...descriptor,
          id: "custom_depth",
          role: "reasoning" as const,
        })),
      },
    }));
    expect(
      formatModelSelectionEffort(selection([{ id: "custom_depth", value: "xhigh" }]), models),
    ).toBe("Extra High");
  });

  it("shows the model's default effort when the user never picked one", () => {
    expect(formatModelSelectionEffort(selection(), catalog({}))).toBe("High");
  });

  it("names a stored effort the way the catalog does", () => {
    expect(
      formatModelSelectionEffort(selection([{ id: "effort", value: "xhigh" }]), catalog({})),
    ).toBe("Extra High");
  });

  it("uses the descriptor's current value over the default", () => {
    expect(formatModelSelectionEffort(selection(), catalog({ currentValue: "medium" }))).toBe(
      "Medium",
    );
  });

  it("shows nothing for a model the catalog does not describe", () => {
    expect(formatModelSelectionEffort(selection([{ id: "effort", value: "high" }]))).toBeNull();
    expect(
      formatModelSelectionEffort(
        { ...selection(), model: "claude-haiku-4-5" },
        catalog({ currentValue: "medium" }),
      ),
    ).toBeNull();
  });
});

describe("threadRuntimeCanArchive", () => {
  const runtime = (
    status: ThreadRuntimeSummary["status"],
    activeRunId: ThreadRuntimeSummary["activeRunId"],
  ): ThreadRuntimeSummary => ({
    status,
    activeRunId,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    providerName: null,
    lastError: null,
    updatedAt: DateTime.formatIso(now),
  });

  it.each(["preparing", "starting", "running"] as const)(
    "blocks archive while a provider is %s",
    (status) => {
      expect(threadRuntimeCanArchive(runtime(status, RunId.make(`run-${status}`)))).toBe(false);
    },
  );

  it("only blocks a queued runtime when a provider run remains attached", () => {
    expect(threadRuntimeCanArchive(runtime("queued", RunId.make("run-queued")))).toBe(false);
    expect(threadRuntimeCanArchive(runtime("queued", null))).toBe(true);
  });

  it("allows waiting and idle threads", () => {
    expect(threadRuntimeCanArchive(runtime("waiting", RunId.make("run-finished")))).toBe(true);
    expect(threadRuntimeCanArchive(runtime("idle", null))).toBe(true);
  });
});

describe("presentPendingBackgroundWork", () => {
  it.each(["Subagent:", "Subagent:   "])(
    "falls back to the subagent noun when %s has no display name",
    (description) => {
      const presentation = presentPendingBackgroundWork([
        { taskId: "unnamed", kind: "subagent", description },
      ]);

      expect(presentation?.title).toBe("Waiting on a subagent");
      expect(presentation?.items[0]?.label).toBe("subagent");
    },
  );

  it.each([
    "/root/luna_window_properties",
    "Subagent: /root/luna_window_properties",
    "/root/parent/luna_window_properties",
  ])("uses the subagent display name for %s", (description) => {
    const childThreadId = ThreadId.make("thread:luna");
    const presentation = presentPendingBackgroundWork([
      { taskId: "luna", kind: "subagent", description, childThreadId },
    ]);

    expect(presentation).toEqual({
      title: "Waiting on subagent Luna Window Properties",
      items: [{ taskId: "luna", kind: "subagent", label: "Luna Window Properties", childThreadId }],
      waiting: true,
      running: true,
    });
  });

  it("formats subagent names in a mixed roster and preserves command descriptions", () => {
    const presentation = presentPendingBackgroundWork([
      { taskId: "cmd", kind: "command", description: "/root/run_tests" },
      { taskId: "luna", kind: "subagent", description: "/root/luna_window_properties" },
      { taskId: "review", kind: "subagent", description: "Review src/math.ts" },
    ]);

    expect(presentation?.title).toBe("Waiting on 2 subagents and 1 command");
    expect(presentation?.items.map((item) => item.label)).toEqual([
      "Luna Window Properties",
      "Review src/math.ts",
      "/root/run_tests",
    ]);
  });

  it("names a single piece of work by kind", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "a", kind: "subagent", description: "Review src/math.ts" },
      ])?.title,
    ).toBe("Waiting on subagent Review src/math.ts");
    expect(presentPendingBackgroundWork([{ taskId: "a", kind: "monitor" }])?.title).toBe(
      "Waiting on a monitor",
    );
    expect(presentPendingBackgroundWork([])).toBeNull();
  });

  // A command left running, such as a dev server, does not wake the agent.
  it("says only commands are running, not waited on", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "dev", kind: "command", description: "Start the shared dev server" },
      ]),
    ).toMatchObject({ title: "Running: Start the shared dev server", waiting: false });
    expect(presentPendingBackgroundWork([{ taskId: "a", kind: "command" }])).toMatchObject({
      title: "Running a command",
      waiting: false,
    });
    expect(
      presentPendingBackgroundWork([
        { taskId: "a", kind: "command", description: "vp run dev" },
        { taskId: "b", kind: "command", description: "tailscale serve" },
      ]),
    ).toMatchObject({ title: "Running 2 commands", waiting: false });
    expect(
      presentPendingBackgroundWork([
        { taskId: "a", kind: "command", description: "vp run dev" },
        { taskId: "b", kind: "monitor", description: "Watch PR checks" },
      ]),
    ).toMatchObject({ title: "Waiting on 1 command and 1 monitor", waiting: true });
  });

  it("shows a command that will wake the agent as waiting", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "bench", kind: "command", description: "Run benchmark", wakesAgent: true },
      ]),
    ).toMatchObject({
      title: "Waiting on 1 background command · Run benchmark",
      waiting: true,
    });
  });

  it("groups work by kind, subagents first, and keeps each name", () => {
    const presentation = presentPendingBackgroundWork([
      { taskId: "cmd", kind: "command", description: "npm test" },
      {
        taskId: "b",
        kind: "subagent",
        description: "Write tests",
        childThreadId: ThreadId.make("thread:b"),
      },
      { taskId: "a", kind: "subagent", description: "Review src/math.ts" },
    ]);
    expect(presentation?.title).toBe("Waiting on 2 subagents and 1 command");
    expect(presentation?.items.map((item) => [item.kind, item.label, item.childThreadId])).toEqual([
      ["subagent", "Write tests", "thread:b"],
      ["subagent", "Review src/math.ts", undefined],
      ["command", "npm test", undefined],
    ]);
  });

  // The lead is working, not waiting, while its subagents run.
  it("says work is running, not waited on, while the lead works", () => {
    const working = { leadWorking: true };
    expect(
      presentPendingBackgroundWork(
        [{ taskId: "a", kind: "subagent", description: "Review src/math.ts" }],
        working,
      )?.title,
    ).toBe("Subagent Review src/math.ts running");
    expect(presentPendingBackgroundWork([{ taskId: "a", kind: "subagent" }], working)?.title).toBe(
      "1 subagent running",
    );
    expect(
      presentPendingBackgroundWork(
        [
          { taskId: "a", kind: "subagent", description: "Review" },
          { taskId: "b", kind: "subagent", description: "Tests" },
          { taskId: "c", kind: "command", description: "vp run dev" },
        ],
        working,
      ),
    ).toMatchObject({ title: "2 subagents and 1 command running", waiting: true });
    // Commands and named monitors keep their forms.
    expect(
      presentPendingBackgroundWork(
        [{ taskId: "a", kind: "command", description: "vp run dev" }],
        working,
      )?.title,
    ).toBe("Running: vp run dev");
    expect(
      presentPendingBackgroundWork(
        [{ taskId: "a", kind: "monitor", description: "Watch CI" }],
        working,
      )?.title,
    ).toBe("Watch CI");
  });

  it("names generic work, including rosters from servers that predate kinds", () => {
    expect(
      presentPendingBackgroundWork([
        { taskId: "bash", kind: "command", description: "Background sleep" },
        { taskId: "watch", kind: "monitor" },
        { taskId: "other", kind: "background_task" },
      ])?.title,
    ).toBe("Waiting on 1 command, 1 monitor and 1 background task");
    expect(presentPendingBackgroundWork([{ taskId: "old", kind: "background_task" }])?.title).toBe(
      "Waiting on a background task",
    );
  });
});

describe("provider-reported model selection", () => {
  const selected = v2Projection.thread.modelSelection;
  const reported = { ...selected, options: [{ id: "reasoningEffort", value: "default" }] };
  const providerThread = {
    id: ProviderThreadId.make("active"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: selected.instanceId,
    providerSessionId: ProviderSessionId.make("session"),
    appThreadId: v2Projection.thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    nativeMetadata: { modelSelection: reported },
  };
  const projection = {
    ...v2Projection,
    thread: { ...v2Projection.thread, activeProviderThreadId: providerThread.id },
    providerThreads: [providerThread],
  };

  it("reads only the active provider thread's reported selection", () => {
    expect(deriveReportedModelSelection(projection)).toBe(reported);
    expect(
      deriveReportedModelSelection({
        ...projection,
        thread: { ...projection.thread, activeProviderThreadId: null },
      }),
    ).toBeNull();
    expect(
      deriveReportedModelSelection({
        ...projection,
        providerThreads: [
          { ...providerThread, providerInstanceId: ProviderInstanceId.make("other") },
        ],
      }),
    ).toBeNull();
  });

  it("shows the reported default in a subagent's effort label", () => {
    const models = [
      {
        slug: selected.model,
        name: selected.model,
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "variant",
              label: "Reasoning",
              type: "select" as const,
              options: [{ id: "high", label: "High" }],
            },
          ],
        },
      },
    ];
    const variantReport = { ...selected, options: [{ id: "variant", value: "default" }] };
    expect(formatModelSelectionEffort(selected, models, variantReport)).toBe("Default");
    expect(formatModelSelectionEffort(selected, models)).toBe("Unknown");
  });
});

describe("presentProviderGoal", () => {
  it("summarizes Codex accounting and offers resume once the goal stops short", () => {
    expect(
      presentProviderGoal(
        {
          objective: "Ship the feature",
          status: "paused",
          tokensUsed: 12_400,
          tokenBudget: 50_000,
          timeUsedSeconds: 245,
        },
        false,
      ),
    ).toEqual({
      title: "Goal paused",
      objective: "Ship the feature",
      usage: "12k / 50k tokens · 4m 5s",
      canResume: true,
    });
  });

  it("counts Claude evaluator checks and never offers resume", () => {
    expect(
      presentProviderGoal({ objective: "All tests pass", status: "active", checks: 1 }, true),
    ).toEqual({
      title: "Pursuing goal",
      objective: "All tests pass",
      usage: "1 check",
      canResume: false,
    });
    expect(
      presentProviderGoal({ objective: "All tests pass", status: "complete", checks: 0 }, false)
        .usage,
    ).toBeNull();
    expect(
      presentProviderGoal({ objective: "All tests pass", status: "active" }, false).title,
    ).toBe("Goal set");
  });
});

describe("providerSubagentRelayText", () => {
  it("names the subagent and asks the parent to pass the message on", () => {
    expect(providerSubagentRelayText(' Review "auth" flow ', "  Also check logout.\n")).toBe(
      [
        `Message for your subagent "Review 'auth' flow":`,
        "",
        "Also check logout.",
        "",
        "Pass this on to that subagent instead of acting on it yourself. If you can't reach it, say so.",
      ].join("\n"),
    );
  });

  it("falls back to a generic name for an untitled subagent", () => {
    expect(providerSubagentRelayText("  ", "Stop")).toMatch(
      /^Message for your subagent "your subagent":/,
    );
  });
});

describe("relayed subagent messages", () => {
  it("labels a message sent today by its time alone", () => {
    const sentAt = Date.UTC(2026, 9, 27, 19, 42);
    const today = formatRelayedSentAt(sentAt, sentAt + 60_000);
    const later = formatRelayedSentAt(sentAt, sentAt + 3 * 24 * 60 * 60 * 1000);
    expect(later).not.toBe(today);
    expect(later.endsWith(today)).toBe(true);
  });

  it("keeps the newest few from the last week, oldest first", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 30 * day;
    const messages = [
      { text: "old", sentAt: now - 8 * day },
      ...[1, 2, 3, 4, 5, 6].map((n) => ({ text: `m${n}`, sentAt: now - (7 - n) * 1000 })),
    ];
    expect(recentRelayedSubagentMessages(messages.toReversed(), now).map((m) => m.text)).toEqual([
      "m2",
      "m3",
      "m4",
      "m5",
      "m6",
    ]);
  });

  it("reads back only well-formed entries", () => {
    expect(
      decodeRelayedSubagentMessages(
        JSON.stringify([{ text: "hi", sentAt: 1 }, { text: 2 }, null, "x"]),
      ),
    ).toEqual([{ text: "hi", sentAt: 1 }]);
    expect(decodeRelayedSubagentMessages("not json")).toEqual([]);
    expect(decodeRelayedSubagentMessages(null)).toEqual([]);
  });
});

describe("held background presentation", () => {
  const held = {
    taskId: "held-send",
    kind: "subagent" as const,
    description: "Discord levels",
    childThreadId: ThreadId.make("child"),
    held: { runId: RunId.make("queued"), since: "2026-10-27T19:50:12.004Z" },
  };
  it("shows the held message and date without claiming work is running", () => {
    const presentation = presentPendingBackgroundWork([held])!;
    expect(presentation).toMatchObject({ waiting: false, running: false });
    expect(presentation.title).toMatch(/^Held: Discord levels · since .*2026/);
    expect(presentation.title).toBe(formatPendingBackgroundWorkItem(presentation.items[0]!));
    expect(presentation.items[0]?.held?.runId).toBe(held.held.runId);
  });
  it("does not count held messages among running subagents", () => {
    expect(presentPendingBackgroundWork([held, { ...held, taskId: "second" }])).toMatchObject({
      title: "Held: 2 messages",
      waiting: false,
      running: false,
    });
    expect(
      presentPendingBackgroundWork([held, { taskId: "watch", kind: "monitor" }]),
    ).toMatchObject({
      title: "Waiting on 1 monitor · 1 held",
      waiting: true,
      running: true,
    });
  });
});

it("resolves a follow-up notification by task id before child thread identity", () => {
  const childThreadId = ThreadId.make("shared-child");
  const agents = [
    { id: NodeId.make("original"), childThreadId, result: "old result" },
    { id: NodeId.make("followup"), childThreadId, result: "new result" },
  ];
  expect(
    notificationSubagent(agents, {
      kind: "delegated_task",
      childThreadId,
      taskIds: [agents[1]!.id],
    })?.result,
  ).toBe("new result");
  expect(
    notificationSubagent(agents, {
      kind: "delegated_task",
      childThreadId,
      taskIds: [NodeId.make("missing")],
    }),
  ).toBeUndefined();
  expect(notificationSubagent(agents, { kind: "subagent", childThreadId })?.result).toBe(
    "old result",
  );
});
