import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  MessageId,
  ProviderThreadId,
  NodeId,
  RunId,
  ThreadId,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import {
  backgroundWorkHoldsCompletion,
  deriveBackgroundWorkDuringRun,
  derivePendingBackgroundWork,
  deriveBlockedOnThreadWait,
  longRunningWorkForShell,
  turnItemUpdateCanEndBackgroundWork,
} from "./orchestrationV2PendingBackgroundWork.ts";

describe("turnItemUpdateCanEndBackgroundWork", () => {
  it.each([
    ["a finished subagent", true, { type: "subagent", status: "completed" }],
    ["a failed background command", true, { type: "command_execution", status: "failed" }],
    ["an idle dynamic tool", true, { type: "dynamic_tool", status: "idle" }],
    ["a running command's output", false, { type: "command_execution", status: "running" }],
    ["a waiting subagent", false, { type: "subagent", status: "waiting" }],
    ["a finished assistant message", false, { type: "assistant_message", status: "completed" }],
  ] as const)("%s: %s", (_case, canEnd, item) => {
    expect(turnItemUpdateCanEndBackgroundWork(item)).toBe(canEnd);
  });
});

describe("backgroundWorkHoldsCompletion", () => {
  const task = (
    taskId: string,
    kind: OrchestrationV2PendingBackgroundTask["kind"],
  ): OrchestrationV2PendingBackgroundTask => ({ taskId, kind });

  it.each([
    ["nothing pending", false, []],
    ["a dev server", false, [task("dev", "command")]],
    ["two long-lived shells", false, [task("web", "command"), task("api", "command")]],
    ["a subagent", true, [task("review", "subagent")]],
    ["a monitor", true, [task("watch", "monitor")]],
    ["a command and a monitor", true, [task("dev", "command"), task("watch", "monitor")]],
    ["a command and a subagent", true, [task("dev", "command"), task("review", "subagent")]],
    // Also what an unknown or missing kind decodes to.
    ["work the provider cannot name", true, [task("opaque", "background_task")]],
  ] as const)("with %s pending, holds completion: %s", (_case, holds, tasks) => {
    expect(backgroundWorkHoldsCompletion(tasks)).toBe(holds);
  });
});

describe("derivePendingBackgroundWork", () => {
  it("returns empty while the latest run is not settled", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "running" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: null,
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("does not keep a settled parent waiting for an idle child", () => {
    expect(
      derivePendingBackgroundWork({
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        providerThreads: [],
        turnItems: [{ id: "idle-child", type: "subagent", status: "idle", title: "Review" }],
      }),
    ).toEqual([]);
  });

  it("returns pending work when the latest run is waiting (post-success, pre-checkpoint)", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "waiting" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([{ taskId: "cmd-1", description: "npm test", kind: "command" }]);
  });

  it("still returns empty when the latest run is running even with background items", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "running" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [
        {
          id: "item-1" as never,
          type: "subagent",
          status: "running",
          title: "review",
          nativeItemRef: { nativeId: "sub-1" },
          prompt: "review",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("excludes rolled_back items when the latest run is waiting", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "waiting" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
        { id: "run-2" as never, ordinal: 2, status: "waiting" },
      ],
      turnItems: [
        {
          id: "item-old" as never,
          type: "command_execution",
          status: "running",
          title: "from rolled-back run",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-old" },
          input: "sleep 99",
        },
        {
          id: "item-new" as never,
          type: "command_execution",
          status: "running",
          title: "still pending",
          runId: "run-2",
          nativeItemRef: { nativeId: "cmd-new" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-new",
        description: "still pending",
        kind: "command",
      },
    ]);
  });

  it("returns the provider-thread roster after settlement", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "bg-1", description: "Run Codex review", kind: "command" },
          ],
        },
      ],
      turnItems: [],
      activeProviderThreadId: "pt-1",
    });
    expect(tasks).toEqual([{ taskId: "bg-1", description: "Run Codex review", kind: "command" }]);
  });

  it("includes nonterminal turn items and excludes completed ones", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "npm test",
        },
        {
          id: "item-2" as never,
          type: "command_execution",
          status: "completed",
          title: "done",
          nativeItemRef: { nativeId: "cmd-2" },
          input: "echo done",
        },
      ],
    });
    expect(tasks).toEqual([{ taskId: "cmd-1", description: "npm test", kind: "command" }]);
  });

  it("trims normalized background-work descriptions", () => {
    const base = {
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" as const },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            {
              taskId: "native-task",
              description: "  native background work  ",
              kind: "background_task" as const,
            },
          ],
        },
      ],
    };
    expect(
      derivePendingBackgroundWork({
        ...base,
        turnItems: [
          {
            id: "item-command" as never,
            type: "command_execution",
            status: "running",
            title: "  npm test  ",
            nativeItemRef: null,
          },
          {
            id: "item-tool" as never,
            type: "dynamic_tool",
            status: "running",
            title: null,
            nativeItemRef: null,
            toolName: "  browser.search  ",
          } as never,
        ],
      }),
    ).toEqual([
      {
        taskId: "native-task",
        description: "native background work",
        kind: "background_task",
      },
      {
        taskId: "item-command",
        description: "npm test",
        kind: "command",
      },
      {
        taskId: "item-tool",
        description: "browser.search",
        kind: "background_task",
      },
    ]);
  });

  it("dedupes roster entries against turn items by native task id", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "task-9", description: "Agent review", kind: "background_task" },
          ],
        },
      ],
      turnItems: [
        {
          id: "item-sub" as never,
          type: "subagent",
          status: "running",
          title: "Agent review",
          nativeItemRef: { nativeId: "task-9" },
          prompt: "review the plan",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "task-9", description: "Agent review", kind: "background_task" },
    ]);
  });

  it("counts a resumed child once across the original and follow-up cards", () => {
    const turnItems = ["original", "follow-up"].map((id) => ({
      id,
      type: "subagent" as const,
      status: "running" as const,
      title: "Review",
      childThreadId: ThreadId.make("child"),
      nativeItemRef: null,
    }));
    const settled = derivePendingBackgroundWork({
      latestRun: { id: RunId.make("parent"), ordinal: 1, status: "completed" },
      providerThreads: [],
      turnItems,
    });
    expect(settled).toEqual([
      { taskId: "follow-up", kind: "subagent", description: "Review", childThreadId: "child" },
    ]);
    expect(
      deriveBackgroundWorkDuringRun({
        runs: [{ id: RunId.make("new-parent"), ordinal: 2, status: "running" }],
        providerThreads: [],
        turnItems,
      }),
    ).toEqual(settled);
    expect(
      derivePendingBackgroundWork({
        latestRun: { id: RunId.make("parent"), ordinal: 1, status: "completed" },
        providerThreads: [],
        turnItems: turnItems.map((item) => ({ ...item, status: "completed" })),
      }),
    ).toEqual([]);
  });

  it("excludes Grok persistent monitors", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "dynamic_tool",
          status: "running",
          title: "monitor logs",
          nativeItemRef: { nativeId: "mon-1" },
          input: { persistent: true, command: "tail -f" },
        },
        {
          id: "item-2" as never,
          type: "dynamic_tool",
          status: "running",
          title: "finite monitor",
          nativeItemRef: { nativeId: "mon-2" },
          input: { persistent: false, command: "sleep 5" },
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "mon-2", description: "finite monitor", kind: "background_task" },
    ]);
  });

  it("returns multiple tasks with stable ordering from insertion", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "bg-1", description: "first", kind: "command" },
            { taskId: "bg-2", description: "second", kind: "command" },
          ],
        },
      ],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "third",
          nativeItemRef: { nativeId: "cmd-3" },
          input: "third",
        },
      ],
    });
    expect(tasks.map((task) => task.taskId)).toEqual(["bg-1", "bg-2", "cmd-3"]);
  });

  it("excludes turn items owned by a rolled_back run", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [{ id: "run-1" as never, ordinal: 1, status: "rolled_back" }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "abandoned",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "sleep 99",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("returns empty when the latest run is rolled_back even with a nonempty roster", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "abandoned",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "sleep 99",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("excludes an older rolled_back nonterminal item when the latest run is completed", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
        { id: "run-2" as never, ordinal: 2, status: "completed" },
      ],
      turnItems: [
        {
          id: "item-old" as never,
          type: "command_execution",
          status: "running",
          title: "from rolled-back run",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-old" },
          input: "sleep 99",
        },
        {
          id: "item-new" as never,
          type: "command_execution",
          status: "running",
          title: "still pending",
          runId: "run-2",
          nativeItemRef: { nativeId: "cmd-new" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-new",
        description: "still pending",
        kind: "command",
      },
    ]);
  });

  it("does not reclassify an older active run as background work", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "cancelled" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "provider-task", kind: "background_task" }],
        },
      ],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "running" },
        { id: "run-2" as never, ordinal: 2, status: "cancelled" },
      ],
      turnItems: [
        {
          id: "item-active" as never,
          type: "command_execution",
          status: "running",
          title: "foreground work",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-active" },
          input: "vp check",
        },
      ],
    });

    expect(tasks).toEqual([]);
  });

  it("includes items with a null run id even when runs list has rolled_back rows", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [{ id: "run-1" as never, ordinal: 1, status: "rolled_back" }],
      turnItems: [
        {
          id: "item-null-run" as never,
          type: "command_execution",
          status: "running",
          title: "orphan item",
          runId: null,
          nativeItemRef: { nativeId: "cmd-null" },
          input: "echo orphan",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-null",
        description: "orphan item",
        kind: "command",
      },
    ]);
  });
});

describe("derivePendingBackgroundWork kinds", () => {
  it("keeps the roster's kinds and names turn items by their type", () => {
    const startedAt = "2026-10-05T03:00:00.000Z";
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "bash", kind: "command" },
            { taskId: "watch", kind: "monitor" },
            { taskId: "workflow", kind: "background_task" },
          ],
        },
      ],
      turnItems: [
        {
          id: "item-sub" as never,
          type: "subagent",
          status: "running",
          title: "Review src/math.ts",
          nativeItemRef: { nativeId: "sub" },
          childThreadId: "thread:child" as never,
          startedAt: DateTime.makeUnsafe(startedAt),
        },
        {
          id: "item-cmd" as never,
          type: "command_execution",
          status: "running",
          title: null,
          nativeItemRef: { nativeId: "cmd" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "bash", kind: "command" },
      { taskId: "watch", kind: "monitor" },
      { taskId: "workflow", kind: "background_task" },
      {
        taskId: "sub",
        description: "Review src/math.ts",
        kind: "subagent",
        childThreadId: "thread:child",
        startedAt,
      },
      { taskId: "cmd", description: "npm test", kind: "command" },
    ]);
  });

  describe("pull request watches", () => {
    const watch = {
      startedAt: "2026-10-05T00:00:00.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-10-05T00:00:00.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    };
    const link = (
      number: number,
      extra: { source?: "agent" | "stack-dismissed"; watched?: boolean },
    ) => ({
      host: "github.com",
      repository: "acme/app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      source: extra.source ?? "agent",
      ...(extra.watched === false ? {} : { watch }),
    });
    const pullRequests = [
      link(1, {}),
      link(2, { watched: false }),
      link(3, { source: "stack-dismissed" }),
    ];

    it("keeps a settled run waiting on each visible watch, as a monitor", () => {
      const tasks = derivePendingBackgroundWork({
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        providerThreads: [],
        turnItems: [],
        pullRequests,
      });
      expect(tasks).toEqual([
        {
          taskId: "pull-request-watch:github.com/acme/app#1",
          description: "Watching pull request #1",
          kind: "monitor",
        },
      ]);
      expect(backgroundWorkHoldsCompletion(tasks)).toBe(true);
    });

    it("keeps a thread that never ran waiting on its watch", () => {
      expect(
        derivePendingBackgroundWork({
          latestRun: null,
          providerThreads: [],
          turnItems: [],
          pullRequests,
        }).map((task) => task.taskId),
      ).toEqual(["pull-request-watch:github.com/acme/app#1"]);
    });

    it("lists no watch while a run is active", () => {
      expect(
        derivePendingBackgroundWork({
          latestRun: { id: "run-1" as never, ordinal: 1, status: "running" },
          providerThreads: [],
          turnItems: [],
          pullRequests,
        }),
      ).toEqual([]);
    });
  });
});

describe("deriveBackgroundWorkDuringRun", () => {
  const runs = [
    { id: "run-1" as never, ordinal: 1, status: "completed" as const },
    { id: "run-2" as never, ordinal: 2, status: "running" as const },
  ];

  it("keeps an earlier turn's subagents and the roster while a later turn works", () => {
    const tasks = deriveBackgroundWorkDuringRun({
      runs,
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "watch", description: "Spend watchdog", kind: "monitor" },
          ],
        },
      ],
      turnItems: [
        {
          id: "agent-item" as never,
          type: "subagent",
          status: "running",
          title: "Measure acceptance",
          runId: "run-1",
          nativeItemRef: { nativeId: "agent-1" },
          childThreadId: "child-1" as never,
        },
      ],
    });

    expect(tasks).toEqual([
      { taskId: "watch", description: "Spend watchdog", kind: "monitor" },
      {
        taskId: "agent-1",
        description: "Measure acceptance",
        kind: "subagent",
        childThreadId: "child-1",
      },
    ]);
  });

  it("leaves the working turn's own commands and agents to its work log", () => {
    const tasks = deriveBackgroundWorkDuringRun({
      runs,
      providerThreads: [],
      turnItems: [
        {
          id: "cmd" as never,
          type: "command_execution",
          status: "running",
          title: "vp test",
          runId: "run-2",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "vp test",
        },
        {
          id: "agent" as never,
          type: "subagent",
          status: "running",
          title: "Review",
          runId: "run-2",
          nativeItemRef: { nativeId: "agent-2" },
        },
      ],
    });

    expect(tasks).toEqual([]);
  });
});

describe("app-owned subagents with their own chat", () => {
  const childA = ThreadId.make("child-a");
  const childB = ThreadId.make("child-b");
  const runs = [
    // Cut by Stop or an app restart after it started child A.
    { id: RunId.make("run-cut"), ordinal: 1, status: "cancelled" as const },
    { id: RunId.make("run-now"), ordinal: 2, status: "running" as const },
  ];
  const card = (
    id: string,
    runId: string,
    childThreadId: ThreadId,
    status: "running" | "interrupted" | "completed",
  ) => ({
    id,
    type: "subagent" as const,
    status,
    title: `Agent ${id}`,
    runId,
    origin: "app_owned",
    childThreadId,
    subagentId: `node:${id}`,
  });
  const row = (
    id: string,
    runId: string,
    childThreadId: ThreadId,
    status: "running" | "completed",
  ) => ({
    id: NodeId.make(`node:${id}`),
    runId: RunId.make(runId),
    origin: "app_owned" as const,
    childThreadId,
    status,
    title: `Agent ${id}`,
    prompt: "",
  });
  const input = {
    runs,
    providerThreads: [],
    turnItems: [
      card("a", "run-cut", childA, "interrupted"),
      card("b", "run-now", childB, "running"),
      // Foreground work of the active run stays in its work log.
      {
        id: "cmd",
        type: "command_execution" as const,
        status: "running" as const,
        title: "vp test",
        runId: "run-now",
      },
      {
        id: "native",
        type: "subagent" as const,
        status: "running" as const,
        title: "Explore",
        runId: "run-now",
        origin: "provider_native",
        childThreadId: null,
      },
    ],
    subagents: [row("a", "run-cut", childA, "running"), row("b", "run-now", childB, "running")],
  };

  it("lists both children while the lead works, whatever their cards say", () => {
    expect(deriveBackgroundWorkDuringRun(input)).toEqual([
      { taskId: "a", description: "Agent a", kind: "subagent", childThreadId: childA },
      { taskId: "b", description: "Agent b", kind: "subagent", childThreadId: childB },
    ]);
    // The row count also counts the working run's native subagent, as before.
    expect(longRunningWorkForShell(input)).toEqual({
      monitorCount: 0,
      backgroundTaskCount: 0,
      runningSubagentCount: 3,
    });
    expect(
      longRunningWorkForShell({ ...input, turnItems: input.turnItems.slice(0, 1) }),
    ).toMatchObject({ runningSubagentCount: 2 });
  });

  it("lists a child whose card was interrupted after the turn", () => {
    const settled = {
      ...input,
      latestRun: runs[0],
      runs: [runs[0]!],
      turnItems: [card("a", "run-cut", childA, "interrupted")],
      subagents: [row("a", "run-cut", childA, "running")],
    };
    expect(derivePendingBackgroundWork(settled)).toEqual([
      { taskId: "a", description: "Agent a", kind: "subagent", childThreadId: childA },
    ]);
    // A finished child is not listed again.
    expect(
      derivePendingBackgroundWork({
        ...settled,
        subagents: [row("a", "run-cut", childA, "completed")],
      }),
    ).toEqual([]);
  });

  it("names a live child from its row when its card is not loaded, once per child", () => {
    // The shell reads only pending cards: A's interrupted card is not among them.
    const startedAt = "2026-10-05T00:00:00.000Z";
    const tasks = deriveBackgroundWorkDuringRun({
      ...input,
      turnItems: [card("b", "run-now", childB, "running")],
      subagents: [
        { ...row("a", "run-cut", childA, "running"), startedAt: DateTime.makeUnsafe(startedAt) },
        row("b", "run-now", childB, "running"),
      ],
    });
    expect(tasks).toEqual([
      { taskId: "b", description: "Agent b", kind: "subagent", childThreadId: childB },
      {
        taskId: "node:a",
        description: "Agent a",
        kind: "subagent",
        childThreadId: childA,
        startedAt,
      },
    ]);
  });

  it("counts a resumed child once, by its latest card", () => {
    const tasks = deriveBackgroundWorkDuringRun({
      ...input,
      turnItems: [
        card("a", "run-cut", childA, "interrupted"),
        card("a2", "run-now", childA, "running"),
      ],
      subagents: [row("a", "run-cut", childA, "running")],
    });
    expect(tasks).toEqual([
      { taskId: "a2", description: "Agent a2", kind: "subagent", childThreadId: childA },
    ]);
  });

  it("leaves rolled-back children out", () => {
    expect(
      deriveBackgroundWorkDuringRun({
        ...input,
        runs: [{ ...runs[0]!, status: "rolled_back" as const }, runs[1]!],
        turnItems: [card("a", "run-cut", childA, "interrupted")],
        subagents: [row("a", "run-cut", childA, "running")],
      }),
    ).toEqual([]);
  });
});

describe("held delegated messages", () => {
  const command = "command:mcp:sender:thread-send:followup";
  const taskId = NodeId.make(`node:delegated-task:${encodeURIComponent(command)}`);
  const childThreadId = ThreadId.make("child");
  const childRun = {
    id: RunId.make("queued-child"),
    threadId: childThreadId,
    status: "queued" as const,
    queueHeld: true,
    requestedAt: DateTime.makeUnsafe("2026-10-27T19:50:12.004Z"),
    userMessageId: MessageId.make("message:mcp:sender:thread-send:followup"),
    delegatedTaskId: taskId,
  };
  const input = {
    latestRun: { id: RunId.make("parent-run"), ordinal: 1, status: "completed" as const },
    providerThreads: [],
    turnItems: [
      {
        id: `turn-item:delegated-task:${encodeURIComponent(command)}`,
        type: "subagent" as const,
        status: "running" as const,
        title: "Discord levels",
        childThreadId,
        subagentId: taskId,
      },
    ],
  };
  it("names the held child run and original queued date", () => {
    expect(derivePendingBackgroundWork({ ...input, childRuns: [childRun] })[0]).toMatchObject({
      kind: "subagent",
      childThreadId,
      held: { runId: childRun.id, since: "2026-10-27T19:50:12.004Z" },
    });
  });
  it("recognizes a legacy send whose run lost its delegation binding", () => {
    expect(
      derivePendingBackgroundWork({
        ...input,
        childRuns: [{ ...childRun, delegatedTaskId: undefined }],
      })[0]?.kind,
    ).toBe("subagent");
    expect(
      derivePendingBackgroundWork({
        ...input,
        childRuns: [{ ...childRun, delegatedTaskId: undefined }],
      })[0],
    ).toHaveProperty("held.runId", childRun.id);
  });
  it.each([
    { ...childRun, queueHeld: false },
    { ...childRun, status: "running" as const },
    { ...childRun, threadId: ThreadId.make("sibling") },
    {
      ...childRun,
      delegatedTaskId: NodeId.make("other"),
      userMessageId: MessageId.make("other-sender"),
    },
  ])("does not mark unrelated or resumed work held", (run) => {
    expect(derivePendingBackgroundWork({ ...input, childRuns: [run] })[0]).not.toHaveProperty(
      "held",
    );
  });
});

describe("long-running shell counts", () => {
  it("counts independent work during a root run, deduplicates subagents, and ignores foreground commands", () => {
    const input = {
      runs: [{ id: RunId.make("active"), ordinal: 1, status: "running" as const }],
      providerThreads: [
        {
          id: ProviderThreadId.make("provider"),
          pendingBackgroundTasks: [
            { taskId: "child", kind: "subagent" as const },
            { taskId: "background", kind: "command" as const },
          ],
        },
      ],
      turnItems: [
        {
          id: "foreground",
          runId: "active",
          type: "command_execution" as const,
          status: "running" as const,
          title: "test",
        },
        {
          id: "watch",
          runId: "active",
          type: "command_execution" as const,
          status: "running" as const,
          title: "watch",
          monitor: true,
        },
        {
          id: "child",
          runId: "active",
          type: "subagent" as const,
          status: "running" as const,
          title: "review",
        },
      ],
    };
    expect(longRunningWorkForShell(input)).toEqual({
      monitorCount: 1,
      backgroundTaskCount: 1,
      runningSubagentCount: 1,
    });
    expect(longRunningWorkForShell({ runs: [], providerThreads: [], turnItems: [] })).toEqual({
      monitorCount: 0,
      backgroundTaskCount: 0,
      runningSubagentCount: 0,
    });
  });
});

describe("deriveBlockedOnThreadWait", () => {
  const id = RunId.make("run:waiting");
  const activeRun = { id, status: "running" as const };
  const wait = {
    runId: id,
    type: "dynamic_tool" as const,
    status: "running" as const,
    toolName: "mcp__t3-code__t3_thread_wait",
  };
  it("recognizes provider spellings and blocking delegation", () => {
    for (const toolName of [
      "t3_thread_wait",
      "t3-code.t3_thread_wait",
      "mcp__t3-code__t3_thread_wait",
    ]) {
      expect(deriveBlockedOnThreadWait({ activeRun, turnItems: [{ ...wait, toolName }] })).toBe(
        true,
      );
    }
    expect(
      deriveBlockedOnThreadWait({
        activeRun,
        turnItems: [{ ...wait, toolName: "delegate_task", input: { mode: "wait" } }],
      }),
    ).toBe(true);
    expect(
      deriveBlockedOnThreadWait({
        activeRun,
        turnItems: [{ ...wait, toolName: "delegate_task", input: { mode: "async" } }],
      }),
    ).toBe(false);
  });
  it("ignores text, app-owned child cards, old runs and finished tools", () => {
    expect(
      deriveBlockedOnThreadWait({
        activeRun,
        turnItems: [
          wait,
          { ...wait, type: "assistant_message", toolName: "" },
          { ...wait, type: "subagent", origin: "app_owned" },
          { ...wait, type: "command_execution", runId: RunId.make("old-run") },
          { ...wait, type: "dynamic_tool", status: "completed", toolName: "other" },
        ],
      }),
    ).toBe(true);
  });
  it.each(["command_execution", "dynamic_tool", "subagent"] as const)(
    "concurrent %s means the agent is working",
    (type) => {
      expect(
        deriveBlockedOnThreadWait({
          activeRun,
          turnItems: [wait, { ...wait, type, toolName: "other" }],
        }),
      ).toBe(false);
    },
  );
  // The chat list's index holds only commands, tools and subagents, so every reader ignores these.
  it.each(["file_change", "file_search", "web_search", "compaction"] as const)(
    "concurrent %s does not change the answer",
    (type) => {
      expect(
        deriveBlockedOnThreadWait({
          activeRun,
          turnItems: [wait, { ...wait, type, toolName: "other" }],
        }),
      ).toBe(true);
    },
  );
  it("clears when the wait or run ends and never infers a wait from an empty run", () => {
    expect(
      deriveBlockedOnThreadWait({ activeRun, turnItems: [{ ...wait, status: "completed" }] }),
    ).toBe(false);
    expect(
      deriveBlockedOnThreadWait({ activeRun: { id, status: "completed" }, turnItems: [wait] }),
    ).toBe(false);
    expect(deriveBlockedOnThreadWait({ activeRun: null, turnItems: [wait] })).toBe(false);
    expect(deriveBlockedOnThreadWait({ activeRun, turnItems: [] })).toBe(false);
  });
});
