import { EnvironmentId, NodeId, ThreadId, type OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { firstSubagentAskTarget } from "./firstSubagentAsk.ts";

const environmentId = EnvironmentId.make("local");
const remote = EnvironmentId.make("studio");
const agent = {
  id: NodeId.make("task-1"),
  origin: "app_owned",
  childThreadId: ThreadId.make("child"),
  startedAt: DateTime.makeUnsafe("2026-11-09T07:00:00Z"),
  status: "running",
} satisfies Pick<
  OrchestrationV2Subagent,
  "id" | "origin" | "childThreadId" | "startedAt" | "status"
>;
const shell = { firstSubagentAsk: NodeId.make("task-1") };

describe("firstSubagentAskTarget", () => {
  it("stops the asked subagent's child thread, in its own environment", () => {
    expect(firstSubagentAskTarget(shell, agent, environmentId)).toEqual({
      environmentId,
      threadId: "child",
    });
    expect(
      firstSubagentAskTarget(shell, { ...agent, remote: { environmentId: remote } }, environmentId),
    ).toEqual({ environmentId: remote, threadId: "child" });
  });

  it("shows nothing without an open ask for this subagent", () => {
    expect(firstSubagentAskTarget(null, agent, environmentId)).toBeNull();
    expect(firstSubagentAskTarget({}, agent, environmentId)).toBeNull();
    expect(
      firstSubagentAskTarget({ firstSubagentAsk: NodeId.make("task-2") }, agent, environmentId),
    ).toBeNull();
  });

  it("hides the ask once the subagent stops, and until it has started", () => {
    for (const status of ["completed", "failed", "cancelled", "interrupted", "idle"] as const)
      expect(firstSubagentAskTarget(shell, { ...agent, status }, environmentId)).toBeNull();
    expect(firstSubagentAskTarget(shell, { ...agent, startedAt: null }, environmentId)).toBeNull();
    expect(
      firstSubagentAskTarget(shell, { ...agent, origin: "provider_native" }, environmentId),
    ).toBeNull();
  });
});
