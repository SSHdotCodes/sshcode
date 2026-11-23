import { ThreadId, WorkflowNodeId, type WorkflowRunAgent } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  currentWorkflowAgents,
  findWorkflowAgent,
  selectedWorkflowAgent,
  workflowAgentActions,
  workflowAgentsNeedingYou,
  workflowNeedsLabel,
} from "./workflowRun.ts";

const lead = WorkflowNodeId.make("lead");
const workers = WorkflowNodeId.make("workers");

const agent = (
  id: string,
  nodeId: WorkflowNodeId,
  slot: number,
  extra: Partial<WorkflowRunAgent> = {},
): WorkflowRunAgent => ({
  nodeId,
  slot,
  threadId: ThreadId.make(id),
  parentThreadId: nodeId === lead ? null : ThreadId.make("t-lead"),
  title: id,
  model: "gpt-6.1-sol",
  status: "running",
  startedAt: "2026-11-06T00:00:00.000Z",
  completedAt: null,
  ...extra,
});

describe("selectedWorkflowAgent", () => {
  const agents = [
    agent("t-lead", lead, 0),
    agent("t-w1", workers, 0),
    agent("t-w2", workers, 1, { status: "failed" }),
  ];

  it("picks the only agent of a one-agent box", () => {
    expect(selectedWorkflowAgent(agents, { nodeId: lead, threadId: null })?.threadId).toBe(
      "t-lead",
    );
  });

  it("waits for a pick in a box with several agents", () => {
    expect(selectedWorkflowAgent(agents, { nodeId: workers, threadId: null })).toBeNull();
    expect(
      selectedWorkflowAgent(agents, { nodeId: workers, threadId: ThreadId.make("t-w2") })?.title,
    ).toBe("t-w2");
  });

  it("follows Retry to the newest attempt in the slot", () => {
    const retried = [
      ...agents,
      agent("t-w2b", workers, 1, { status: "pending", retryOf: ThreadId.make("t-w2") }),
      agent("t-w2c", workers, 1, { status: "running", retryOf: ThreadId.make("t-w2b") }),
    ];
    expect(
      selectedWorkflowAgent(retried, { nodeId: workers, threadId: ThreadId.make("t-w2") })
        ?.threadId,
    ).toBe("t-w2c");
    expect(currentWorkflowAgents(retried).map((entry) => entry.threadId)).toEqual([
      "t-lead",
      "t-w1",
      "t-w2c",
    ]);
    expect(findWorkflowAgent(retried, ThreadId.make("t-w2b"))?.threadId).toBe("t-w2c");
    expect(findWorkflowAgent(retried, ThreadId.make("gone"))).toBeNull();
  });

  it("drops a pick that left the box", () => {
    expect(
      selectedWorkflowAgent(agents, { nodeId: workers, threadId: ThreadId.make("gone") }),
    ).toBeNull();
  });
});

describe("workflowAgentsNeedingYou", () => {
  it("lists agents with an open card, skipping replaced attempts", () => {
    const agents = [
      agent("Planner", lead, 0, { needs: "approval" }),
      agent("Worker 1", workers, 0),
      agent("Worker 2", workers, 1, { needs: "input", status: "failed" }),
      agent("Worker 2b", workers, 1, { needs: "input", retryOf: ThreadId.make("Worker 2") }),
    ];
    const needing = workflowAgentsNeedingYou(agents);
    expect(needing.map(workflowNeedsLabel)).toEqual(["Planner · approval", "Worker 2b · input"]);
  });
});

describe("workflowAgentActions", () => {
  it("offers Stop while live, Retry once settled, Steer only mid-turn", () => {
    expect(workflowAgentActions({ status: "pending" })).toEqual({
      steer: false,
      stop: true,
      retry: false,
    });
    expect(workflowAgentActions({ status: "waiting" })).toEqual({
      steer: true,
      stop: true,
      retry: false,
    });
    expect(workflowAgentActions({ status: "interrupted" })).toEqual({
      steer: false,
      stop: false,
      retry: true,
    });
    expect(workflowAgentActions({ status: "planned" })).toEqual({
      steer: false,
      stop: false,
      retry: false,
    });
  });
});
