import { describe, expect, it } from "@effect/vitest";
import { ThreadId, WorkflowEdgeId, WorkflowNodeId } from "@t3tools/contracts";
import {
  rollupWorkflowRun,
  withRunLabels,
  workflowHiddenThreadIds,
} from "@t3tools/shared/workflows";
import { planWorkflowDelegation } from "./delegation.ts";
import { runFixture, selection } from "./fixtures.ts";

describe("workflow delegation policy", () => {
  it("matches unlabeled boxes that share a model by their run names", () => {
    const base = runFixture();
    const worker = base.snapshot.nodes.find((n) => n.id === "worker")!;
    if (worker.kind !== "agent") throw new Error("fixture");
    const sketch = (id: string, x: number) => ({
      ...worker,
      id: WorkflowNodeId.make(id),
      x,
      label: "",
      text: "gpt 6.1 sol",
    });
    const snapshot = withRunLabels({
      ...base.snapshot,
      nodes: [
        ...base.snapshot.nodes.filter((n) => n.id !== "worker"),
        sketch("left", 0),
        sketch("right", 600),
      ],
      edges: [
        ...base.snapshot.edges.filter((e) => e.to !== "worker"),
        {
          id: WorkflowEdgeId.make("e-left"),
          from: base.snapshot.rootNodeId!,
          to: WorkflowNodeId.make("left"),
          kind: "delegates" as const,
        },
        {
          id: WorkflowEdgeId.make("e-right"),
          from: base.snapshot.rootNodeId!,
          to: WorkflowNodeId.make("right"),
          kind: "delegates" as const,
        },
      ],
    });
    const run = { ...base, snapshot };
    const input = { task: "FizzBuzz", target: { model: selection.model } };
    const ambiguous = planWorkflowDelegation(run, run.leadThreadId, input, selection);
    expect(ambiguous).toMatchObject({
      error: expect.stringContaining("Allowed boxes: gpt 6.1 sol 1 ("),
    });
    expect(
      planWorkflowDelegation(
        run,
        run.leadThreadId,
        { ...input, title: "GPT 6.1 Sol 2: words" },
        selection,
      ),
    ).toMatchObject({ node: { id: "right" } });
    expect(
      planWorkflowDelegation(
        run,
        run.leadThreadId,
        { ...input, title: "gpt 6.1 sol 1: fizz" },
        selection,
      ),
    ).toMatchObject({ node: { id: "left" } });
  });

  it("enforces the drawn model, own children, count, machine and isolation", () => {
    const run = runFixture(),
      input = { task: "Work", target: { model: selection.model }, title: "worker" };
    expect(
      planWorkflowDelegation(
        run,
        run.leadThreadId,
        { ...input, target: { model: "wrong" } },
        selection,
      ),
    ).toMatchObject({ error: expect.stringContaining("Allowed boxes: worker") });
    const accepted = planWorkflowDelegation(run, run.leadThreadId, input, selection);
    expect(accepted).toMatchObject({
      node: { id: "worker" },
      slot: 0,
      input: { target: { model: selection.model, userNamedModel: true } },
    });
    if ("error" in accepted) throw new Error(accepted.error);
    const long = planWorkflowDelegation(
      run,
      run.leadThreadId,
      { ...input, title: `worker ${"x".repeat(500)}` },
      selection,
    );
    if ("error" in long) throw new Error(long.error);
    expect(long.input.title).toHaveLength(200);
    expect(accepted.input.task).toContain("helper brief");
    const full = {
      ...run,
      agents: [
        ...run.agents,
        {
          ...run.agents[0]!,
          nodeId: WorkflowNodeId.make("worker"),
          threadId: ThreadId.make("worker"),
          parentThreadId: run.leadThreadId,
        },
      ],
    };
    expect(planWorkflowDelegation(full, run.leadThreadId, input, selection)).toMatchObject({
      error: expect.stringContaining("count is full"),
    });
    expect(
      planWorkflowDelegation(run, run.leadThreadId, { ...input, isolation: "worktree" }, selection),
    ).toMatchObject({ error: expect.stringContaining("isolation shared") });
  });
  it("disambiguates identical models by label and blocks then successors until every predecessor completes", () => {
    const run = runFixture();
    const snapshot = {
      ...run.snapshot,
      edges: [
        { ...run.snapshot.edges[0]! },
        { ...run.snapshot.edges[1]!, from: WorkflowNodeId.make("lead") },
        {
          id: WorkflowEdgeId.make("then"),
          from: WorkflowNodeId.make("worker"),
          to: WorkflowNodeId.make("helper"),
          kind: "then" as const,
        },
      ],
    };
    const input = { task: "Work", target: { model: selection.model } };
    expect(
      planWorkflowDelegation({ ...run, snapshot }, run.leadThreadId, input, selection),
    ).toHaveProperty("error");
    expect(
      planWorkflowDelegation(
        { ...run, snapshot },
        run.leadThreadId,
        { ...input, title: "helper" },
        selection,
      ),
    ).toMatchObject({ error: expect.stringContaining("Wait for worker") });
    const previous = {
      ...run.agents[0]!,
      nodeId: WorkflowNodeId.make("worker"),
      threadId: ThreadId.make("worker"),
      parentThreadId: run.leadThreadId,
      status: "completed" as const,
    };
    const accepted = planWorkflowDelegation(
      { ...run, snapshot, agents: [...run.agents, previous] },
      run.leadThreadId,
      { ...input, title: "helper" },
      selection,
    );
    expect(accepted).toMatchObject({
      node: { id: "helper" },
      input: { task: expect.stringContaining("Read worker's result") },
    });
  });
  it("rolls status up and hides dedicated leads while preserving existing chats", () => {
    const run = runFixture(),
      lead = run.agents[0]!;
    expect(rollupWorkflowRun([{ ...lead, status: "waiting" }], lead.threadId)).toBe("waiting");
    expect(rollupWorkflowRun([{ ...lead, status: "completed" }], lead.threadId)).toBe("completed");
    expect(rollupWorkflowRun([{ ...lead, status: "failed" }], lead.threadId)).toBe("failed");
    expect(rollupWorkflowRun([{ ...lead, status: "interrupted" }], lead.threadId)).toBe(
      "cancelled",
    );
    expect(workflowHiddenThreadIds([run]).has(lead.threadId)).toBe(true);
    expect(workflowHiddenThreadIds([{ ...run, origin: "chat" }]).has(lead.threadId)).toBe(false);
  });
  it("counts the newest attempt and checks predecessor results and successors when replacing a slot", () => {
    const run = runFixture();
    const old = {
      ...run.agents[0]!,
      nodeId: WorkflowNodeId.make("worker"),
      threadId: ThreadId.make("old"),
      parentThreadId: run.leadThreadId,
      status: "failed" as const,
    };
    const retry = {
      ...old,
      threadId: ThreadId.make("retry"),
      retryOf: old.threadId,
      status: "completed" as const,
    };
    const snapshot = {
      ...run.snapshot,
      edges: [
        ...run.snapshot.edges.map((e) =>
          e.to === "helper" ? { ...e, from: WorkflowNodeId.make("lead") } : e,
        ),
        {
          id: WorkflowEdgeId.make("then"),
          kind: "then" as const,
          from: old.nodeId,
          to: WorkflowNodeId.make("helper"),
        },
      ],
    };
    const state = { ...run, snapshot, agents: [...run.agents, old, retry] };
    expect(
      planWorkflowDelegation(
        state,
        run.leadThreadId,
        { task: "Review", title: "helper" },
        selection,
      ),
    ).toMatchObject({ node: { id: "helper" } });
    expect(
      planWorkflowDelegation(
        state,
        run.leadThreadId,
        { task: "Retry", title: "worker" },
        selection,
        [],
        old.nodeId,
        retry.threadId,
      ),
    ).toMatchObject({ slot: 0, node: { id: "worker" } });
    const { retryOf: _retryOf, ...successor } = retry;
    expect(
      planWorkflowDelegation(
        {
          ...state,
          agents: [
            ...state.agents,
            {
              ...successor,
              nodeId: WorkflowNodeId.make("helper"),
              threadId: ThreadId.make("successor"),
            },
          ],
        },
        run.leadThreadId,
        { task: "Retry", title: "worker" },
        selection,
        [],
        old.nodeId,
        retry.threadId,
      ),
    ).toMatchObject({ error: expect.stringContaining("started successor") });
  });
});
