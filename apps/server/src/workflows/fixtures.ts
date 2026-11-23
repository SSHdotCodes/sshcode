import {
  NodeId,
  ProviderInstanceId,
  ThreadId,
  WorkflowEdgeId,
  WorkflowId,
  WorkflowNodeId,
  WorkflowRunId,
  type WorkflowDefinition,
  type WorkflowRun,
} from "@t3tools/contracts";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";
import { ProviderDriverKind } from "@t3tools/contracts";

export const selection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-terra" };
export const workflowFixture = (): WorkflowDefinition => ({
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
    model: selection,
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
export const runFixture = (): WorkflowRun => ({
  id: WorkflowRunId.make("run"),
  workflowId: WorkflowId.make("test"),
  snapshot: workflowFixture(),
  task: "Test",
  origin: "workflows",
  leadThreadId: ThreadId.make("lead"),
  status: "running",
  agents: [
    {
      nodeId: WorkflowNodeId.make("lead"),
      slot: 0,
      threadId: ThreadId.make("lead"),
      parentThreadId: null,
      title: "lead",
      model: selection.model,
      status: "running",
      startedAt: null,
      completedAt: null,
    },
  ],
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
  completedAt: null,
});
export const catalog = [
  {
    ...buildServerProvider({
      presentation: { displayName: "Codex" },
      enabled: true,
      checkedAt: "2026-11-06T00:00:00.000Z",
      models: [
        { slug: selection.model, name: "GPT-6.1 Terra", isCustom: false, capabilities: null },
      ],
      probe: { installed: true, version: null, status: "ready", auth: { status: "authenticated" } },
    }),
    instanceId: selection.instanceId,
    driver: ProviderDriverKind.make("codex"),
  },
];

export const delegationResult = (
  threadId: ThreadId,
  status: "running" | "waiting" | "completed" = "running",
) => ({
  taskId: NodeId.make(`task-${threadId}`),
  childThreadId: threadId,
  childRunId: null,
  status,
  workState: "working" as const,
  hasPendingChildRuns: false,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  providerInstanceId: selection.instanceId,
  model: selection.model,
  summary: null,
  resultContextTransferId: null,
  hasPendingQuestion: false,
  waitTimedOut: false,
});
