import { describe, expect, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ThreadId,
  WorkflowEdgeId,
  WorkflowId,
  WorkflowNodeId,
  WorkflowRunId,
  type WorkflowRun,
  type WorkflowRunAgent,
  WorkflowDefinition,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  agentChatTarget,
  compactWorkflowPlan,
  layoutWorkflow,
  resolveWorkflowArrows,
  validateWorkflow,
  withRunLabels,
  workflowRunDiagnostics,
} from "./index.ts";

const decodeWorkflow = Schema.decodeUnknownSync(WorkflowDefinition);

const fixture = (): WorkflowDefinition => ({
  version: 1,
  id: WorkflowId.make("test"),
  name: "Test",
  description: "",
  rootNodeId: WorkflowNodeId.make("lead"),
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
  nodes: ["lead", "worker", "helper"].map((id, i) => ({
    kind: "agent",
    id: WorkflowNodeId.make(id),
    x: i * 400,
    y: i * 260,
    width: 300,
    height: 180,
    text: id,
    label: id,
    model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-terra" },
    instructions: `${id} brief`,
    count: { kind: "exact", n: 1 },
    machine: "local",
    isolation: "shared",
  })),
  edges: [
    {
      id: WorkflowEdgeId.make("a"),
      from: WorkflowNodeId.make("lead"),
      to: WorkflowNodeId.make("worker"),
      kind: "delegates",
    },
    {
      id: WorkflowEdgeId.make("b"),
      from: WorkflowNodeId.make("worker"),
      to: WorkflowNodeId.make("helper"),
      kind: "delegates",
    },
  ],
});

describe("workflows", () => {
  it("decodes saved nodes with or without model options without provider validation", () => {
    const original = fixture();
    expect(decodeWorkflow(original)).toEqual(original);
    const workflow = {
      ...original,
      nodes: original.nodes.map((node) =>
        node.kind === "agent"
          ? {
              ...node,
              model: {
                ...node.model!,
                options: [{ id: "reasoningEffort", value: "custom-effort" }],
              },
            }
          : node,
      ),
    };
    const decoded = decodeWorkflow(JSON.parse(JSON.stringify(workflow)));
    expect(decoded).toEqual(workflow);
    expect(validateWorkflow(decoded)).toEqual([]);
  });
  it("validates roots, models, counts, parentage, cycles and sibling order", () => {
    const workflow = fixture();
    expect(validateWorkflow(workflow)).toEqual([]);
    expect(
      validateWorkflow({
        ...workflow,
        edges: [
          ...workflow.edges,
          {
            id: WorkflowEdgeId.make("c"),
            from: WorkflowNodeId.make("helper"),
            to: WorkflowNodeId.make("lead"),
            kind: "delegates",
          },
        ],
      }).some((i) => i.message.includes("cycle")),
    ).toBe(true);
    expect(
      validateWorkflow({
        ...workflow,
        edges: [
          ...workflow.edges,
          {
            id: WorkflowEdgeId.make("c"),
            from: WorkflowNodeId.make("lead"),
            to: WorkflowNodeId.make("worker"),
            kind: "then",
          },
        ],
      }).some((i) => i.edgeId === "c"),
    ).toBe(true);
    expect(
      validateWorkflow({
        ...workflow,
        nodes: workflow.nodes.map((n) =>
          n.kind === "agent" && n.id === "worker"
            ? { ...n, model: null, count: { kind: "exact", n: 17 } }
            : n,
        ),
      }),
    ).toHaveLength(2);
  });
  it("lays out deterministically and preserves positions outside requested ids", () => {
    const workflow = fixture(),
      laid = layoutWorkflow(workflow);
    expect(laid.nodes.map((n) => n.y)).toEqual([0, 260, 520]);
    expect(layoutWorkflow(workflow, new Set([WorkflowNodeId.make("helper")])).nodes[1]).toEqual(
      workflow.nodes[1],
    );
    expect(layoutWorkflow(laid)).toEqual(laid);
  });
  it("keeps resized siblings and layers apart", () => {
    const original = fixture();
    const workflow = {
      ...original,
      nodes: original.nodes.map((n) => ({
        ...n,
        width: n.id === "worker" ? 900 : 400,
        height: n.id === "lead" ? 600 : 240,
      })),
      edges: original.edges.map((e) => ({ ...e, from: WorkflowNodeId.make("lead") })),
    };
    const laid = layoutWorkflow(workflow),
      [lead, worker, helper] = laid.nodes;
    expect(worker!.y).toBeGreaterThanOrEqual(lead!.y + lead!.height + 80);
    expect(helper!.x).toBeGreaterThanOrEqual(worker!.x + worker!.width + 60);
  });
  it("attaches notes to the intended boxes and gives loose guidance only to the lead", () => {
    const original = fixture(),
      workerId = WorkflowNodeId.make("worker");
    const workflow: WorkflowDefinition = {
      ...original,
      nodes: [
        ...original.nodes,
        {
          kind: "note",
          id: WorkflowNodeId.make("attached"),
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          text: "Worker note",
          attachedTo: workerId,
        },
        {
          kind: "note",
          id: WorkflowNodeId.make("loose"),
          x: 0,
          y: 0,
          width: 100,
          height: 100,
          text: "Whole run guidance",
          attachedTo: null,
        },
      ],
    };
    expect(compactWorkflowPlan(workflow, original.rootNodeId!)).toContain("Whole run guidance");
    const child = compactWorkflowPlan(workflow, workerId);
    expect(child).toContain("Worker note");
    expect(child).not.toContain("Whole run guidance");
  });
  it("sends own box and direct children, without grandchildren or coordinates", () => {
    const plan = compactWorkflowPlan(fixture(), WorkflowNodeId.make("lead"));
    expect(plan).toContain("worker brief");
    expect(plan).not.toContain("helper");
    expect(plan).not.toContain('"x"');
  });
  it("resolves free arrows by border geometry", () => {
    const workflow = fixture();
    const result = resolveWorkflowArrows({ ...workflow, edges: [] }, [
      {
        id: WorkflowEdgeId.make("free"),
        from: { x: 299, y: 100 },
        to: { x: 401, y: 300 },
        kind: "delegates",
      },
    ]);
    expect(result.edges[0]).toMatchObject({ from: "lead", to: "worker" });
    const self = resolveWorkflowArrows({ ...workflow, edges: [] }, [
      {
        id: WorkflowEdgeId.make("self"),
        from: { x: 10, y: 20 },
        to: { x: 20, y: 30 },
        kind: "delegates",
      },
    ]);
    expect(self.edges[0]).toMatchObject({ from: "lead", to: "lead" });
    expect(validateWorkflow(self).some((i) => i.message.includes("cycle"))).toBe(true);
  });
});

describe("withRunLabels", () => {
  it("names unlabeled boxes from their text and numbers repeats in reading order", () => {
    const base = fixture();
    const named = withRunLabels({
      ...base,
      nodes: base.nodes.map((n, index) =>
        n.kind === "agent"
          ? {
              ...n,
              label: index === 0 ? "Lead" : "",
              text: index === 0 ? "" : "  \ngpt 6.1 sol",
              x: index * 100,
            }
          : n,
      ),
    });
    expect(named.nodes.map((n) => (n.kind === "agent" ? n.label : null))).toEqual([
      "Lead",
      "gpt 6.1 sol 1",
      "gpt 6.1 sol 2",
    ]);
    const blank = withRunLabels({
      ...base,
      nodes: base.nodes.map((n) => (n.kind === "agent" ? { ...n, label: "", text: "" } : n)),
    });
    expect(new Set(blank.nodes.map((n) => (n.kind === "agent" ? n.label : null))).size).toBe(3);
  });
});

describe("workflowRunDiagnostics", () => {
  const agent = (
    id: string,
    nodeId: string,
    parent: string | null,
    status: WorkflowRunAgent["status"] = "completed",
  ): WorkflowRunAgent => ({
    nodeId: WorkflowNodeId.make(nodeId),
    slot: 0,
    threadId: ThreadId.make(id),
    parentThreadId: parent === null ? null : ThreadId.make(parent),
    title: nodeId,
    model: "gpt-6.1-terra",
    status,
    startedAt: "2026-11-06T00:00:00.000Z",
    completedAt: "2026-11-06T00:01:00.000Z",
  });
  const run = (agents: WorkflowRunAgent[], snapshot = fixture()): WorkflowRun => ({
    id: WorkflowRunId.make("run"),
    workflowId: snapshot.id,
    snapshot,
    task: "Build",
    origin: "workflows",
    leadThreadId: ThreadId.make("lead"),
    status: "completed",
    agents,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    completedAt: snapshot.updatedAt,
  });
  it("counts only the newest attempt when checking a retried branch", () => {
    const old = agent("old", "worker", "lead", "failed");
    const retry = { ...agent("retry", "worker", "lead"), retryOf: old.threadId };
    expect(
      workflowRunDiagnostics(
        run([agent("lead", "lead", null), old, retry, agent("nested", "helper", "retry")]),
      ),
    ).toEqual([]);
  });
  it("reports exact counts per parent, failures, skipped boxes and observed model and placement differences", () => {
    const snapshot = fixture();
    const agents = [
      agent("lead", "lead", null),
      agent("worker-a", "worker", "lead", "failed"),
      agent("worker-b", "worker", "lead", "interrupted"),
    ];
    const diagnostics = workflowRunDiagnostics(
      run([{ ...agents[0]!, model: "different", isolation: "worktree" }, ...agents.slice(1)], {
        ...snapshot,
        nodes: snapshot.nodes.map((n) =>
          n.kind === "agent" && n.id === "worker" ? { ...n, count: { kind: "exact", n: 3 } } : n,
        ),
      }),
    );
    expect(diagnostics.map((d) => d.kind)).toEqual(
      expect.arrayContaining(["missing", "failed", "skipped", "model", "placement"]),
    );
    expect(
      diagnostics.find((d) => d.nodeId === "worker" && d.kind === "missing")?.message,
    ).toContain("1 required");
    expect(
      diagnostics.find((d) => d.nodeId === "helper" && d.kind === "missing")?.message,
    ).toContain("3 required");
  });
  it("does not call an optional unstarted branch missing or diagnose unknown placement on old runs", () => {
    const snapshot = fixture();
    expect(
      workflowRunDiagnostics(
        run([agent("lead", "lead", null)], {
          ...snapshot,
          nodes: snapshot.nodes.map((n) =>
            n.kind === "agent" && n.id === "worker" ? { ...n, count: { kind: "upTo", max: 3 } } : n,
          ),
        }),
      ),
    ).toEqual([]);
  });
  it("reports unmet predecessor counts and defers missing counts until the run ends", () => {
    const snapshot = fixture();
    const graph = {
      ...snapshot,
      edges: [
        ...snapshot.edges.map((e) =>
          e.to === "helper" ? { ...e, from: WorkflowNodeId.make("lead") } : e,
        ),
        {
          id: WorkflowEdgeId.make("then"),
          kind: "then" as const,
          from: WorkflowNodeId.make("worker"),
          to: WorkflowNodeId.make("helper"),
        },
      ],
    };
    const data = run(
      [
        agent("lead", "lead", null),
        agent("worker", "worker", "lead"),
        agent("helper", "helper", "lead"),
      ],
      graph,
    );
    const diagnostics = workflowRunDiagnostics(data);
    expect(diagnostics.some((d) => d.kind === "predecessor")).toBe(true);
    expect(
      workflowRunDiagnostics({
        ...run([agent("lead", "lead", null, "running")]),
        status: "running",
      }),
    ).toEqual([]);
  });
});

describe("agentChatTarget", () => {
  const nova = (environmentId: string) => environmentId === "env-nova";
  const local = { threadId: ThreadId.make("t-1") };

  it("opens local agents in this environment", () => {
    expect(agentChatTarget(local, "env-mac", nova)).toEqual({
      kind: "app",
      environmentId: "env-mac",
      threadId: "t-1",
    });
  });

  it("opens a remote agent in the app when its environment is connected", () => {
    const agent = { ...local, threadLink: "https://nova.example/env-nova/t%3A2" };
    expect(agentChatTarget(agent, "env-mac", nova)).toEqual({
      kind: "app",
      environmentId: "env-nova",
      threadId: "t:2",
    });
  });

  it("falls back to the web link when the environment is not connected", () => {
    const remote = { ...local, threadLink: "https://nova.example/env-nova/t-2" };
    expect(agentChatTarget(remote, "env-mac", () => false)).toEqual({
      kind: "web",
      url: "https://nova.example/env-nova/t-2",
    });
    const other = { ...local, threadLink: "https://other.example/env-x/t-2" };
    expect(agentChatTarget(other, "env-mac", nova)).toEqual({
      kind: "web",
      url: "https://other.example/env-x/t-2",
    });
  });

  it("never routes to a non-web link and survives a malformed one", () => {
    const script = { ...local, threadLink: "javascript:alert(1)" };
    expect(agentChatTarget(script, "env-mac", nova).kind).toBe("app");
    const broken = { ...local, threadLink: "https://nova.example/%E0%A4%A/t-2" };
    expect(agentChatTarget(broken, "env-mac", nova)).toEqual({
      kind: "web",
      url: "https://nova.example/%E0%A4%A/t-2",
    });
  });
});
