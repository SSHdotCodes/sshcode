import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveThreadWaitingStartedAt } from "./models.ts";

describe("resolveThreadWaitingStartedAt", () => {
  const completedAt = "2026-06-20T01:00:00.000Z";
  const lateSubagent = {
    taskId: "user-subagent",
    kind: "subagent",
    startedAt: "2026-06-20T04:00:00.000Z",
  } as const;
  const resolve = (pendingBackgroundTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>) =>
    resolveThreadWaitingStartedAt({ latestRun: { completedAt }, pendingBackgroundTasks });

  it("starts at a user subagent launched three hours after the turn ended", () => {
    expect(resolve([{ taskId: "dev-server", kind: "command" }, lateSubagent])).toBe(
      lateSubagent.startedAt,
    );
  });

  it("keeps the turn completion when holding work started during the turn", () => {
    const duringTurn = {
      ...lateSubagent,
      taskId: "during-turn",
      startedAt: "2026-06-20T00:58:00.000Z",
    };
    expect(resolve([duringTurn, lateSubagent])).toBe(completedAt);
  });

  it("chooses the earliest start among post-turn holders", () => {
    const earlier = { ...lateSubagent, taskId: "earlier", startedAt: "2026-06-20T03:30:00.000Z" };
    expect(resolve([lateSubagent, earlier])).toBe(earlier.startedAt);
  });

  it.each([
    { taskId: "legacy-subagent", kind: "subagent" },
    { taskId: "invalid-start", kind: "subagent", startedAt: "unknown" },
    { taskId: "watch", kind: "monitor" },
    { taskId: "opaque-work", kind: "background_task" },
  ] as const)("keeps turn completion when $taskId has no usable start", (unknownStart) => {
    expect(resolve([lateSubagent, unknownStart])).toBe(completedAt);
  });

  it("keeps the completion-based fallback when there is no holding work or completed run", () => {
    expect(resolve([])).toBe(completedAt);
    expect(
      resolveThreadWaitingStartedAt({ latestRun: null, pendingBackgroundTasks: [lateSubagent] }),
    ).toBeNull();
  });
});
