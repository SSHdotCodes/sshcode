import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ThreadId,
  WorkflowRunId,
  WorkflowEdgeId,
  type WorkflowAgentNode,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunAgent,
} from "@t3tools/contracts";
import { layoutWorkflow } from "@t3tools/shared/workflows";
import {
  addWorkflowAgent,
  CARD_HEIGHT,
  CARD_WIDTH,
  deleteWorkflowBranch,
  fitWorkflow,
  hiddenWorkflowThreadIds,
  newWorkflow,
  resizeWorkflow,
  runTree,
  workflowCards,
  workflowCommand,
  workflowElapsed,
  workflowTreeEdges,
  saveWorkflowNode,
  zoomAt,
  pinchWorkflow,
} from "./viewModel";

const now = "2026-11-06T05:00:00.000Z";
const model = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
function fixture(): WorkflowDefinition {
  let workflow = addWorkflowAgent(newWorkflow("team", now), "lead", null, model);
  workflow = addWorkflowAgent(workflow, "worker", workflow.rootNodeId, model);
  const child = workflow.nodes[1]!;
  workflow = {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      node.id === child.id && node.kind === "agent"
        ? { ...node, count: { kind: "upTo", max: 8 } }
        : node,
    ),
  };
  return layoutWorkflow(workflow);
}
function runFixture(workflow = fixture()): WorkflowRun {
  return {
    id: WorkflowRunId.make("run-1"),
    workflowId: workflow.id,
    snapshot: workflow,
    task: "Build the feature",
    origin: "workflows",
    leadThreadId: ThreadId.make("lead-chat"),
    status: "running",
    agents: [],
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
}
function agent(
  node: WorkflowAgentNode,
  slot: number,
  status: WorkflowRunAgent["status"] = "running",
): WorkflowRunAgent {
  return {
    nodeId: node.id,
    slot,
    threadId: ThreadId.make(`chat-${node.id}-${slot}`),
    parentThreadId: ThreadId.make("lead-chat"),
    title: node.label,
    model: model.model,
    status,
    progress: `Working ${slot}`,
    startedAt: now,
    completedAt: null,
  };
}

describe("workflow viewport", () => {
  it("keeps the world point under the pinch focal point stationary", () => {
    const before = { scale: 0.5, x: -20, y: 40 };
    const focal = { x: 160, y: 300 };
    const after = zoomAt(before, 2, focal);
    expect((focal.x - after.x) / after.scale).toBe((focal.x - before.x) / before.scale);
    expect((focal.y - after.y) / after.scale).toBe((focal.y - before.y) / before.scale);
    expect(zoomAt(after, 100, focal).scale).toBe(2.5);
    expect(zoomAt(after, 0.00001, focal).scale).toBe(0.001);
  });
  it("combines a pinch and focal movement from the gesture's initial transform", () => {
    const start = { scale: 0.5, x: -20, y: 40 };
    const origin = { x: 100, y: 200 },
      focal = { x: 160, y: 240 };
    const result = pinchWorkflow(start, origin, focal, 2);
    expect((focal.x - result.x) / result.scale).toBe((origin.x - start.x) / start.scale);
    expect((focal.y - result.y) / result.scale).toBe((origin.y - start.y) / start.scale);
    expect(pinchWorkflow(start, origin, focal, 1)).toEqual({ scale: 0.5, x: 40, y: 80 });
  });

  it("keeps the viewport's center point and zoom across a resize", () => {
    const before = { scale: 1.4, x: -120, y: 60 };
    const from = { width: 390, height: 700 };
    const to = { width: 700, height: 390 };
    const after = resizeWorkflow(before, from, to);
    expect(after.scale).toBe(before.scale);
    expect((to.width / 2 - after.x) / after.scale).toBe((from.width / 2 - before.x) / before.scale);
    expect((to.height / 2 - after.y) / after.scale).toBe(
      (from.height / 2 - before.y) / before.scale,
    );
    expect(resizeWorkflow(before, from, from)).toEqual(before);
  });
  it("fits negative shared coordinates inside the viewport", () => {
    const boxes = [
      { x: -600, y: -200, width: CARD_WIDTH, height: CARD_HEIGHT },
      { x: 800, y: 400, width: CARD_WIDTH, height: CARD_HEIGHT },
    ];
    const view = fitWorkflow(boxes, 390, 600);
    for (const box of boxes) {
      expect(box.x * view.scale + view.x).toBeGreaterThanOrEqual(23.99);
      expect((box.x + box.width) * view.scale + view.x).toBeLessThanOrEqual(366.01);
      expect(box.y * view.scale + view.y).toBeGreaterThanOrEqual(23.99);
      expect((box.y + box.height) * view.scale + view.y).toBeLessThanOrEqual(576.01);
    }
    expect(fitWorkflow([], 0, 0)).toEqual({ scale: 1, x: 24, y: 24 });
  });
});

describe("run tree", () => {
  it("keeps the lead at the top and opens it before its agent mapping arrives", () => {
    const run = runFixture();
    const cards = runTree(run);
    const lead = cards.find((card) => card.node.id === run.snapshot.rootNodeId)!;
    expect(lead.threadId).toBe(run.leadThreadId);
    expect(lead.status).toBe("running");
    expect(lead.y).toBeLessThan(cards.find((card) => card.node.id !== lead.node.id)!.y);
  });
  it("fans out a many box by slot with real chat identity and stable coordinates", () => {
    const workflow = fixture();
    const worker = workflow.nodes[1] as WorkflowAgentNode;
    const nested = addWorkflowAgent(workflow, "helper", worker.id, model);
    const run = runFixture(nested);
    const planned = runTree(run);
    const started = runTree({ ...run, agents: [agent(worker, 1, "waiting"), agent(worker, 0)] });
    const before = planned.find((card) => card.node.id === worker.id)!;
    const after = started.filter((card) => card.node.id === worker.id);
    expect(after.map((card) => card.slot)).toEqual([0, 1]);
    expect(after[0]).toMatchObject({
      x: before.x,
      y: before.y,
      threadId: "chat-worker-0",
      status: "running",
    });
    expect(after[1]).toMatchObject({
      threadId: "chat-worker-1",
      status: "waiting",
      progress: "Working 1",
    });
    expect(after[1]!.y).toBeGreaterThan(after[0]!.y + CARD_HEIGHT);
    expect(started.find((card) => card.node.id === "helper")!.y).toBe(
      planned.find((card) => card.node.id === "helper")!.y,
    );
    expect(started.find((card) => card.node.id === "helper")!.y).toBeGreaterThan(
      after[1]!.y + CARD_HEIGHT,
    );
  });
  it("shows a retried slot's newest attempt", () => {
    const workflow = fixture(),
      worker = workflow.nodes[1] as WorkflowAgentNode;
    const failed = agent(worker, 0, "failed");
    const retry = {
      ...agent(worker, 0),
      threadId: ThreadId.make("chat-retry"),
      retryOf: failed.threadId,
    };
    const cards = runTree({ ...runFixture(workflow), agents: [failed, retry] });
    expect(cards.filter((card) => card.node.id === worker.id)).toMatchObject([
      { slot: 0, threadId: "chat-retry", status: "running" },
    ]);
  });
  it("carries the remote chat link so remote agents open in their own environment", () => {
    const workflow = fixture();
    const worker = workflow.nodes[1] as WorkflowAgentNode;
    const remote = { ...agent(worker, 0), threadLink: "https://studio.example/env-studio/chat-1" };
    const cards = runTree({ ...runFixture(workflow), agents: [remote] });
    expect(cards.find((card) => card.node.id === worker.id)).toMatchObject({
      threadId: remote.threadId,
      threadLink: remote.threadLink,
    });
    expect(cards.find((card) => card.node.id === workflow.rootNodeId)?.threadLink).toBeNull();
  });
  it("maps sparse slots and nested edges to the actual parent chat", () => {
    const workflow = fixture(),
      worker = workflow.nodes[1] as WorkflowAgentNode;
    const nested = addWorkflowAgent(workflow, "helper", worker.id, model);
    const helper = nested.nodes[2] as WorkflowAgentNode;
    const parent = agent(worker, 2);
    const child = { ...agent(helper, 0), parentThreadId: parent.threadId };
    const run = { ...runFixture(nested), agents: [parent, child] };
    const cards = runTree(run);
    expect(cards.find((card) => card.node.id === worker.id && card.slot === 2)?.threadId).toBe(
      parent.threadId,
    );
    expect(
      workflowTreeEdges(nested, cards).find((edge) => edge.toKey === "helper:0")?.fromKey,
    ).toBe("worker:2");
  });

  it("preserves normal chat leads while hiding dedicated leads and children", () => {
    const workflow = fixture(),
      worker = workflow.nodes[1] as WorkflowAgentNode;
    const run = runFixture(workflow);
    const lead: WorkflowRunAgent = {
      ...agent(workflow.nodes[0] as WorkflowAgentNode, 0),
      threadId: run.leadThreadId,
      parentThreadId: null,
    };
    const child = agent(worker, 0);
    expect([
      ...hiddenWorkflowThreadIds([{ ...run, origin: "chat", agents: [lead, child] }]),
    ]).toEqual([child.threadId]);
    expect(hiddenWorkflowThreadIds([{ ...run, agents: [lead, child] }]).has(run.leadThreadId)).toBe(
      true,
    );
  });
});

describe("workflow editing and cards", () => {
  it("adds a child beside its parent without moving shared canvas positions", () => {
    const original = fixture();
    const moved = {
      ...original,
      nodes: original.nodes.map((node) => ({ ...node, x: node.x + 1500, y: node.y - 200 })),
    };
    const next = addWorkflowAgent(moved, "helper", moved.nodes[1]!.id, model);
    expect(next.nodes.slice(0, moved.nodes.length)).toEqual(moved.nodes);
    expect(next.nodes.at(-1)!.x).toBe(moved.nodes[1]!.x);
    expect(next.nodes.at(-1)!.y).toBeGreaterThan(moved.nodes[1]!.y);
  });

  it("deletes a whole branch without orphaned edges", () => {
    let workflow = fixture();
    workflow = addWorkflowAgent(workflow, "helper", workflow.nodes[1]!.id, model);
    const deleted = deleteWorkflowBranch(workflow, workflow.nodes[1]!.id);
    expect(deleted.nodes.map((node) => node.id)).toEqual([workflow.rootNodeId]);
    expect(deleted.edges).toEqual([]);
    expect(deleteWorkflowBranch(workflow, workflow.rootNodeId!).rootNodeId).toBeNull();
  });
  it("preserves sequencing when editing a brief and removes it only on an explicit dependency edit", () => {
    let workflow = fixture();
    workflow = addWorkflowAgent(workflow, "reviewer", workflow.rootNodeId, model);
    const worker = workflow.nodes[1] as WorkflowAgentNode;
    const reviewer = workflow.nodes[2] as WorkflowAgentNode;
    workflow = {
      ...workflow,
      edges: [
        ...workflow.edges,
        { id: WorkflowEdgeId.make("sequence"), kind: "then", from: worker.id, to: reviewer.id },
      ],
    };
    expect(
      saveWorkflowNode(workflow, { ...reviewer, instructions: "Review carefully" }, undefined)
        .edges,
    ).toEqual(workflow.edges);
    expect(
      saveWorkflowNode(workflow, reviewer, null).edges.every((edge) => edge.kind !== "then"),
    ).toBe(true);
  });

  it("deduplicates model chips and selects the latest run by timestamp", () => {
    const workflow = fixture(),
      run = runFixture(workflow);
    const latest = {
      ...run,
      id: WorkflowRunId.make("new-run"),
      createdAt: "2026-11-06T06:00:00.000Z",
    };
    expect(workflowCards([workflow], [run, latest])[0]).toMatchObject({
      models: [model.model],
      lastRun: latest,
    });
  });
  it("formats elapsed time deterministically, including stopped and invalid clocks", () => {
    expect(workflowElapsed(now, null, Date.parse(now) + 125000)).toBe("2m 5s");
    expect(workflowElapsed(now, "2026-11-06T05:00:10.000Z", Date.parse(now) + 125000)).toBe("10s");
    expect(workflowElapsed(null, null, 0)).toBe("Not started");
    expect(workflowElapsed("invalid", null, 0)).toBe("—");
  });
});

describe("workflow composer command", () => {
  it("is entirely off behind the beta gate and only recognizes the whole leading command", () => {
    expect(workflowCommand("/workflow build this", false)).toBeNull();
    expect(workflowCommand("/workflow", true)).toBe("");
    expect(workflowCommand("/workflow\nBuild this", true)).toBe("Build this");
    expect(workflowCommand("/workflows", true)).toBeNull();
    expect(workflowCommand("explain /workflow", true)).toBeNull();
  });
});
