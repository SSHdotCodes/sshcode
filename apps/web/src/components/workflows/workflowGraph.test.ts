import {
  ProviderInstanceId,
  ThreadId,
  WorkflowRunId,
  type WorkflowAgentStatus,
  type WorkflowDefinition,
  type WorkflowRun,
  type WorkflowRunAgent,
} from "@t3tools/contracts";
import { validateWorkflow } from "@t3tools/shared/workflows";
import { describe, expect, it } from "vite-plus/test";

import { exampleWorkflow } from "./workflowExamples";
import {
  START_ONLY_ISSUES,
  agentChatTarget,
  boxStatus,
  countLabel,
  deriveRootNodeId,
  diffWorkflows,
  duplicateNodes,
  formatElapsed,
  isAgent,
  newAgentNode,
  newEdge,
  newNoteNode,
  newWorkflowDefinition,
  runBoxes,
  strokeMarkFromPoints,
  tidyWorkflow,
  withDerivedRoot,
} from "./workflowGraph";

const NOW = "2026-11-06T00:00:00.000Z";
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };

function agent(status: WorkflowAgentStatus, slot = 0): WorkflowRunAgent {
  return {
    nodeId: "n" as WorkflowRunAgent["nodeId"],
    slot,
    threadId: ThreadId.make(`t-${slot}-${status}`),
    parentThreadId: null,
    title: "Agent",
    model: null,
    status,
    startedAt: NOW,
    completedAt: null,
  };
}

function chain(): WorkflowDefinition {
  const lead = { ...newAgentNode({ x: 500, y: 40 }, "opus"), model: MODEL };
  const child = { ...newAgentNode({ x: 0, y: 0 }, "sol"), model: MODEL };
  const note = { ...newNoteNode({ x: 0, y: 0 }, "be careful"), attachedTo: child.id };
  return withDerivedRoot({
    ...newWorkflowDefinition("Chain", NOW),
    nodes: [lead, child, note],
    edges: [newEdge(lead.id, child.id, "delegates")],
  });
}

describe("countLabel", () => {
  it("labels groups and hides a single agent", () => {
    expect(countLabel({ kind: "exact", n: 1 })).toBeNull();
    expect(countLabel({ kind: "exact", n: 3 })).toBe("×3");
    expect(countLabel({ kind: "upTo", max: 8 })).toBe("up to 8");
  });
});

describe("deriveRootNodeId", () => {
  it("names the only agent without a parent", () => {
    const workflow = chain();
    expect(workflow.rootNodeId).toBe(workflow.nodes[0]!.id);
  });

  it("is null while two boxes could lead", () => {
    const workflow = chain();
    const loose = newAgentNode({ x: 0, y: 0 }, "haiku");
    expect(deriveRootNodeId([...workflow.nodes, loose], workflow.edges)).toBeNull();
  });
});

describe("tidyWorkflow", () => {
  it("keeps the lead in place and brings attached notes along", () => {
    const workflow = chain();
    const [lead, child, note] = tidyWorkflow(workflow).nodes;
    expect(lead).toMatchObject({ x: 500, y: 40 });
    expect(child!.y).toBeGreaterThan(lead!.y);
    expect(note).toMatchObject({ x: child!.x + child!.width + 32, y: child!.y });
  });

  it("only moves the boxes it is asked to", () => {
    const workflow = chain();
    const lead = workflow.nodes[0]!;
    const child = workflow.nodes[1]!;
    const tidied = tidyWorkflow(workflow, new Set([child.id]));
    expect(tidied.nodes[0]).toMatchObject({ x: lead.x, y: lead.y });
  });
});

describe("diffWorkflows", () => {
  it("ignores moves and reports content, new boxes and removed arrows", () => {
    const before = chain();
    const [lead, child, note] = before.nodes;
    const worker = child!.kind === "agent" ? { ...child!, label: "Worker" } : child!;
    const extra = newAgentNode({ x: 0, y: 0 }, "haiku");
    const after: WorkflowDefinition = {
      ...before,
      nodes: [{ ...lead!, x: 9_000 }, worker, note!, extra],
      edges: [],
    };
    const diff = diffWorkflows(before, after);
    expect([...diff.changed]).toEqual([child!.id]);
    expect([...diff.added]).toEqual([extra.id]);
    expect([...diff.removed]).toEqual([before.edges[0]!.id]);
  });
});

describe("boxStatus", () => {
  it("shows work still going over a failed agent", () => {
    expect(boxStatus([agent("failed"), agent("running", 1)])).toBe("running");
  });

  it("shows a failure once nothing is working", () => {
    expect(boxStatus([agent("completed"), agent("failed", 1)])).toBe("failed");
  });

  it("is planned until an agent fills the box", () => {
    expect(boxStatus([])).toBe("planned");
  });
});

describe("runBoxes", () => {
  it("groups agents by box in slot order", () => {
    const snapshot = withDerivedRoot(exampleWorkflow(NOW, true));
    const many = snapshot.nodes.filter(isAgent).find((node) => node.count.kind === "upTo")!;
    const run: WorkflowRun = {
      id: WorkflowRunId.make("run"),
      workflowId: snapshot.id,
      snapshot,
      task: "Ship it",
      origin: "workflows",
      leadThreadId: ThreadId.make("lead"),
      status: "running",
      agents: [
        { ...agent("running", 1), nodeId: many.id },
        { ...agent("completed", 0), nodeId: many.id },
      ],
      createdAt: NOW,
      updatedAt: NOW,
      completedAt: null,
    };
    const boxes = runBoxes(run);
    expect(boxes.get(many.id)?.agents.map((entry) => entry.slot)).toEqual([0, 1]);
    expect(boxes.get(many.id)?.status).toBe("running");
    expect(boxes.get(snapshot.rootNodeId!)?.status).toBe("planned");
  });
});

describe("agentChatTarget", () => {
  const studio = (environmentId: string) => environmentId === "env-studio";
  const local = { threadId: ThreadId.make("t-1") };

  it("opens local agents in this environment", () => {
    expect(agentChatTarget(local, "env-mac", studio)).toEqual({
      kind: "app",
      environmentId: "env-mac",
      threadId: "t-1",
    });
  });

  it("opens a remote agent in the app when its environment is connected", () => {
    const agent = { ...local, threadLink: "https://studio.example/env-studio/t%3A2" };
    expect(agentChatTarget(agent, "env-mac", studio)).toEqual({
      kind: "app",
      environmentId: "env-studio",
      threadId: "t:2",
    });
  });

  it("falls back to the web link, and never to a non-web one", () => {
    const remote = { ...local, threadLink: "https://other.example/env-x/t-2" };
    expect(agentChatTarget(remote, "env-mac", studio)).toEqual({
      kind: "web",
      url: "https://other.example/env-x/t-2",
    });
    const script = { ...local, threadLink: "javascript:alert(1)" };
    expect(agentChatTarget(script, "env-mac", studio).kind).toBe("app");
  });
});

describe("formatElapsed", () => {
  it("reads like a stopwatch", () => {
    expect(formatElapsed(42_000)).toBe("42s");
    expect(formatElapsed(185_000)).toBe("3m 05s");
    expect(formatElapsed(3_720_000)).toBe("1h 02m");
  });
});

describe("START_ONLY_ISSUES", () => {
  it("matches what shared validation says about an unresolved sketch", () => {
    // The editor hides these while sketching; if shared wording changes, they'd show early.
    const sketch = exampleWorkflow(NOW, false);
    const loose = newAgentNode({ x: 0, y: 0 }, "another lead");
    const messages = validateWorkflow({ ...sketch, nodes: [...sketch.nodes, loose] }).map(
      (issue) => issue.message,
    );
    expect(messages.length).toBeGreaterThan(0);
    for (const message of messages) expect(START_ONLY_ISSUES.has(message)).toBe(true);
  });
});

describe("strokeMarkFromPoints", () => {
  const style = { color: "red", weight: "bold", size: "m" } as const;

  it("stores points relative to a corner padded by half the line width", () => {
    const mark = strokeMarkFromPoints(
      [
        { x: 100, y: 50 },
        { x: 110, y: 60 },
        { x: 130, y: 50 },
      ],
      style,
    )!;
    expect(mark).toMatchObject({ kind: "stroke", x: 97.5, y: 47.5, color: "red", weight: "bold" });
    expect(mark.points).toEqual([2.5, 2.5, 12.5, 12.5, 32.5, 2.5]);
  });

  it("drops jitter but keeps the last point, and thins very long paths", () => {
    const jitter = strokeMarkFromPoints(
      [
        { x: 0, y: 0 },
        { x: 0.5, y: 0 },
        { x: 0.8, y: 0.2 },
        { x: 1, y: 0 },
      ],
      style,
    )!;
    expect(jitter.points).toEqual([2.5, 2.5, 3.5, 2.5]);
    const long = Array.from({ length: 5_000 }, (_, i) => ({ x: i * 2, y: 0 }));
    const thinned = strokeMarkFromPoints(long, style)!;
    expect(thinned.points.length).toBe(3_000);
    expect(thinned.points.at(-2)).toBe(9_998 + 2.5);
    expect(strokeMarkFromPoints([], style)).toBeNull();
  });
});

describe("duplicateNodes", () => {
  it("copies the arrows inside the selection and re-points copied notes", () => {
    const lead = newAgentNode({ x: 0, y: 0 }, "opus");
    const worker = newAgentNode({ x: 0, y: 200 }, "sol");
    const outside = newAgentNode({ x: 400, y: 200 }, "haiku");
    const note = { ...newNoteNode({ x: 300, y: 0 }, "be brief"), attachedTo: lead.id };
    const stray = { ...newNoteNode({ x: 300, y: 100 }, "x"), attachedTo: outside.id };
    const doc = {
      nodes: [lead, worker, outside, note, stray],
      edges: [newEdge(lead.id, worker.id, "delegates"), newEdge(lead.id, outside.id, "delegates")],
    };
    const copy = duplicateNodes(doc, new Set([lead.id, worker.id, note.id, stray.id]), 32, 32);
    const [leadCopy, workerCopy, noteCopy, strayCopy] = copy.nodes;
    expect(copy.nodes.map((node) => node.id)).not.toContain(lead.id);
    expect(leadCopy).toMatchObject({ text: "opus", x: 32, y: 32 });
    expect(copy.edges).toEqual([
      expect.objectContaining({ from: leadCopy!.id, to: workerCopy!.id, kind: "delegates" }),
    ]);
    expect(noteCopy).toMatchObject({ attachedTo: leadCopy!.id });
    expect(strayCopy).toMatchObject({ attachedTo: null });
  });
});
