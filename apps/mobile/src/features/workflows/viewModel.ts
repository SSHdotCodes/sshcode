import { currentWorkflowAgents } from "@t3tools/client-runtime/workflow-run";
import { layoutWorkflow, workflowAgents, workflowHiddenThreadIds } from "@t3tools/shared/workflows";
import {
  WorkflowEdgeId,
  WorkflowId,
  WorkflowNodeId,
  type ModelSelection,
  type WorkflowAgentNode,
  type WorkflowAgentStatus,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowRun,
} from "@t3tools/contracts";

export const CARD_WIDTH = 232;
export const CARD_HEIGHT = 148;
export const SLOT_OFFSET = 162;
export type WorkflowTransform = { scale: number; x: number; y: number };

export function zoomAt(
  transform: WorkflowTransform,
  factor: number,
  focal: { x: number; y: number },
) {
  "worklet";
  const scale = Math.min(2.5, Math.max(0.001, transform.scale * factor));
  const ratio = scale / transform.scale;
  return {
    scale,
    x: focal.x - (focal.x - transform.x) * ratio,
    y: focal.y - (focal.y - transform.y) * ratio,
  };
}

export function fitWorkflow(
  nodes: readonly Pick<WorkflowNode, "x" | "y" | "width" | "height">[],
  width: number,
  height: number,
): WorkflowTransform {
  if (nodes.length === 0 || width <= 0 || height <= 0) return { scale: 1, x: 24, y: 24 };
  const left = Math.min(...nodes.map((node) => node.x));
  const top = Math.min(...nodes.map((node) => node.y));
  const right = Math.max(...nodes.map((node) => node.x + node.width));
  const bottom = Math.max(...nodes.map((node) => node.y + node.height));
  const scale = Math.min(
    1,
    Math.max(0.001, Math.min((width - 48) / (right - left), (height - 48) / (bottom - top))),
  );
  return {
    scale,
    x: (width - (right - left) * scale) / 2 - left * scale,
    y: (height - (bottom - top) * scale) / 2 - top * scale,
  };
}

/** A resize keeps the world point at the old viewport's center at the new one. */
export function resizeWorkflow(
  transform: WorkflowTransform,
  from: { width: number; height: number },
  to: { width: number; height: number },
): WorkflowTransform {
  return {
    scale: transform.scale,
    x: transform.x + (to.width - from.width) / 2,
    y: transform.y + (to.height - from.height) / 2,
  };
}

export function newWorkflow(id: string, now: string): WorkflowDefinition {
  return {
    version: 1,
    id: WorkflowId.make(id),
    name: "Untitled workflow",
    description: "",
    rootNodeId: null,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function addWorkflowAgent(
  workflow: WorkflowDefinition,
  id: string,
  parentId: WorkflowNodeId | null,
  model: ModelSelection | null,
): WorkflowDefinition {
  if (workflow.nodes.length >= 64) return workflow;
  const parent = workflow.nodes.find((node) => node.id === parentId);
  const siblings = workflow.edges.filter(
    (edge) => edge.kind === "delegates" && edge.from === parentId,
  ).length;
  const node: WorkflowAgentNode = {
    kind: "agent",
    id: WorkflowNodeId.make(id),
    x: parent ? parent.x + siblings * 280 : 0,
    y: parent ? parent.y + 240 : 0,
    width: CARD_WIDTH,
    height: CARD_HEIGHT,
    text: "",
    label: parent ? "Worker" : "Lead",
    instructions: "",
    model,
    count: { kind: "exact", n: 1 },
    machine: "local",
    isolation: "shared",
  };
  return {
    ...workflow,
    rootNodeId: workflow.rootNodeId ?? node.id,
    nodes: [...workflow.nodes, node],
    edges: parent
      ? [
          ...workflow.edges,
          {
            id: WorkflowEdgeId.make(`edge-${id}`.slice(0, 64)),
            from: parent.id,
            to: node.id,
            kind: "delegates",
          },
        ]
      : workflow.edges,
  };
}

/** Deleting a box removes its branch and attached notes, keeping a single tree. */
export function deleteWorkflowBranch(
  workflow: WorkflowDefinition,
  id: WorkflowNodeId,
): WorkflowDefinition {
  const removed = new Set([id]);
  const agents = new Set(workflowAgents(workflow).map((node) => node.id));
  for (let i = 0; i < workflow.nodes.length; i++) {
    for (const edge of workflow.edges)
      if (edge.kind === "delegates" && agents.has(edge.from) && removed.has(edge.from))
        removed.add(edge.to);
    for (const node of workflow.nodes)
      if (node.kind === "note" && node.attachedTo && removed.has(node.attachedTo))
        removed.add(node.id);
  }
  return {
    ...workflow,
    nodes: workflow.nodes.filter((node) => !removed.has(node.id)),
    edges: workflow.edges.filter((edge) => !removed.has(edge.from) && !removed.has(edge.to)),
    rootNodeId:
      workflow.rootNodeId && removed.has(workflow.rootNodeId) ? null : workflow.rootNodeId,
  };
}

export function countLabel(node: WorkflowAgentNode) {
  return node.count.kind === "exact" ? `×${node.count.n}` : `up to ${node.count.max}`;
}

export function workflowElapsed(start: string | null, end: string | null, now: number) {
  if (!start) return "Not started";
  const seconds = Math.max(
    0,
    Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000),
  );
  if (!Number.isFinite(seconds)) return "—";
  return seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
      : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds / 60) % 60}m`;
}

export function workflowCards(
  workflows: readonly WorkflowDefinition[],
  runs: readonly WorkflowRun[],
) {
  return workflows.map((workflow) => ({
    workflow,
    models: [
      ...new Set(
        workflow.nodes.flatMap((node) =>
          node.kind === "agent" && node.model ? [node.model.model] : [],
        ),
      ),
    ],
    lastRun:
      runs
        .filter((run) => run.workflowId === workflow.id)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null,
  }));
}

export function runTree(run: WorkflowRun) {
  const tree = layoutWorkflow(run.snapshot);
  const agentsByBox = workflowAgents(tree);
  const levelHeights = new Map<number, number>();
  for (const node of agentsByBox) {
    const capacity = node.count.kind === "exact" ? node.count.n : node.count.max;
    levelHeights.set(node.y, Math.max(levelHeights.get(node.y) ?? 0, capacity * SLOT_OFFSET + 80));
  }
  const levels = [...levelHeights.keys()].sort((a, b) => a - b);
  const levelTops = new Map<number, number>();
  let top = 0;
  for (const level of levels) {
    levelTops.set(level, top);
    top += levelHeights.get(level) ?? 260;
  }
  return agentsByBox.flatMap((node) => {
    const agents = currentWorkflowAgents(run.agents)
      .filter((agent) => agent.nodeId === node.id)
      .sort((a, b) => a.slot - b.slot);
    const capacity = Math.max(
      node.count.kind === "exact" ? node.count.n : 1,
      ...agents.map((agent) => agent.slot + 1),
    );
    // Reserve all exact slots from the outset. New agents never move existing boxes.
    return Array.from({ length: Math.max(capacity, agents.length) }, (_, slot) => {
      const agent = agents.find((entry) => entry.slot === slot);
      const isLead = node.id === run.snapshot.rootNodeId && slot === 0;
      return {
        key: `${node.id}:${slot}`,
        node,
        slot,
        x: node.x,
        y: (levelTops.get(node.y) ?? node.y) + slot * SLOT_OFFSET,
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        threadId: agent?.threadId ?? (isLead ? run.leadThreadId : null),
        threadLink: agent?.threadLink ?? null,
        parentThreadId: agent?.parentThreadId ?? null,
        status:
          agent?.status ??
          ((isLead
            ? run.status === "starting"
              ? "pending"
              : run.status
            : "planned") as WorkflowAgentStatus),
        progress: agent?.progress ?? "",
        startedAt: agent?.startedAt ?? (isLead ? run.createdAt : null),
        completedAt: agent?.completedAt ?? (isLead ? run.completedAt : null),
      };
    });
  });
}

export { workflowCommand } from "./workflowCommand";

/** Keep normal-chat leads visible; standalone run leads and their lineage live in Workflows. */
export const hiddenWorkflowThreadIds = workflowHiddenThreadIds;

/** Match real parent chats first; ghosts connect to the drawn parent box. */
export function workflowTreeEdges(
  workflow: WorkflowDefinition,
  cards: readonly {
    key: string;
    node: WorkflowNode;
    x: number;
    y: number;
    threadId: string | null;
    parentThreadId: string | null;
    status: WorkflowAgentStatus;
  }[],
) {
  return cards.flatMap((card) => {
    const edge = workflow.edges.find(
      (entry) => entry.kind === "delegates" && entry.to === card.node.id,
    );
    if (!edge) return [];
    const parent =
      (card.parentThreadId
        ? cards.find((entry) => entry.threadId === card.parentThreadId)
        : null) ?? cards.find((entry) => entry.node.id === edge.from);
    if (!parent) return [];
    const sx = parent.x + CARD_WIDTH / 2,
      sy = parent.y + CARD_HEIGHT;
    const tx = card.x + CARD_WIDTH / 2,
      ty = card.y;
    return [
      {
        key: `${edge.id}:${card.key}`,
        edgeId: edge.id,
        fromKey: parent.key,
        toKey: card.key,
        d: `M ${sx} ${sy} C ${sx} ${(sy + ty) / 2}, ${tx} ${(sy + ty) / 2}, ${tx} ${ty} M ${tx - 5} ${ty - 8} L ${tx} ${ty} L ${tx + 5} ${ty - 8}`,
        status: card.status,
      },
    ];
  });
}

export function pinchWorkflow(
  start: WorkflowTransform,
  origin: { x: number; y: number },
  focal: { x: number; y: number },
  gestureScale: number,
): WorkflowTransform {
  "worklet";
  const zoomed = zoomAt(start, gestureScale, origin);
  return {
    scale: zoomed.scale,
    x: zoomed.x + focal.x - origin.x,
    y: zoomed.y + focal.y - origin.y,
  };
}

export function saveWorkflowNode(
  workflow: WorkflowDefinition,
  node: WorkflowNode,
  after: WorkflowNodeId | null | undefined,
): WorkflowDefinition {
  return {
    ...workflow,
    nodes: workflow.nodes.map((entry) => (entry.id === node.id ? node : entry)),
    edges:
      after === undefined
        ? workflow.edges
        : [
            ...workflow.edges.filter((edge) => !(edge.kind === "then" && edge.to === node.id)),
            ...(after
              ? [
                  {
                    id: WorkflowEdgeId.make(`then-${node.id}`.slice(0, 64)),
                    kind: "then" as const,
                    from: after,
                    to: node.id,
                  },
                ]
              : []),
          ],
  };
}
