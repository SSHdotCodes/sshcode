import { currentWorkflowAgents } from "@t3tools/client-runtime/workflow-run";
import { layoutWorkflow } from "@t3tools/shared/workflows";
import { MARK_WEIGHTS } from "@t3tools/shared/workflowSketch";
import {
  WorkflowEdgeId,
  WorkflowId,
  WorkflowNodeId,
  type WorkflowAgentCount,
  type WorkflowAgentNode,
  type WorkflowAgentStatus,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowIssue,
  type WorkflowMark,
  type WorkflowMarkColor,
  type WorkflowNode,
  type WorkflowNoteNode,
  type WorkflowRun,
  type WorkflowRunAgent,
  type WorkflowRunStatus,
  type WorkflowStrokeMark,
  type WorkflowTextMark,
} from "@t3tools/contracts";

import { randomUUID } from "../../lib/utils";

export const AGENT_BOX = { width: 240, height: 132 } as const;
export const NOTE_BOX = { width: 200, height: 96 } as const;

const shortId = () => randomUUID().replaceAll("-", "").slice(0, 12);

export function newWorkflowDefinition(name: string, now: string): WorkflowDefinition {
  return {
    version: 1,
    id: WorkflowId.make(`wf_${shortId()}`),
    name,
    description: "",
    rootNodeId: null,
    nodes: [],
    edges: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function newAgentNode(position: { x: number; y: number }, text = ""): WorkflowAgentNode {
  return {
    kind: "agent",
    id: WorkflowNodeId.make(`n_${shortId()}`),
    x: Math.round(position.x),
    y: Math.round(position.y),
    ...AGENT_BOX,
    text,
    label: "",
    model: null,
    instructions: "",
    count: { kind: "exact", n: 1 },
    machine: "local",
    isolation: "shared",
  };
}

export function newNoteNode(position: { x: number; y: number }, text = ""): WorkflowNoteNode {
  return {
    kind: "note",
    id: WorkflowNodeId.make(`n_${shortId()}`),
    x: Math.round(position.x),
    y: Math.round(position.y),
    ...NOTE_BOX,
    text,
    attachedTo: null,
  };
}

export interface MarkStyle {
  readonly color: WorkflowMarkColor;
  readonly weight: WorkflowStrokeMark["weight"];
  readonly size: WorkflowTextMark["size"];
}

export const DEFAULT_MARK_STYLE: MarkStyle = { color: "ink", weight: "bold", size: "m" };

export function newTextMark(
  position: { x: number; y: number },
  style: MarkStyle,
): WorkflowTextMark {
  return {
    kind: "text",
    id: WorkflowNodeId.make(`m_${shortId()}`),
    x: Math.round(position.x),
    y: Math.round(position.y),
    text: "",
    color: style.color,
    size: style.size,
  };
}

/** Longest stroke kept, in points; longer ones are evenly thinned. */
const MAX_STROKE_POINTS = 1_500;

/**
 * Turns a freehand path (canvas coordinates) into a stroke mark: drops points
 * closer than `minGap` to the last kept one, thins very long paths, and stores
 * the rest relative to a padded top-left corner. Null for an empty path.
 */
export function strokeMarkFromPoints(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
  style: MarkStyle,
  minGap = 1.5,
): WorkflowStrokeMark | null {
  const first = points[0];
  if (!first) return null;
  let kept = [first];
  for (const point of points.slice(1)) {
    const last = kept[kept.length - 1]!;
    if (Math.hypot(point.x - last.x, point.y - last.y) >= minGap) kept.push(point);
  }
  const end = points[points.length - 1]!;
  if (points.length > 1 && kept[kept.length - 1] !== end) kept.push(end);
  if (kept.length > MAX_STROKE_POINTS) {
    const step = (kept.length - 1) / (MAX_STROKE_POINTS - 1);
    kept = Array.from({ length: MAX_STROKE_POINTS }, (_, i) => kept[Math.round(i * step)]!);
  }
  const half = MARK_WEIGHTS[style.weight] / 2;
  const left = Math.min(...kept.map((point) => point.x)) - half;
  const top = Math.min(...kept.map((point) => point.y)) - half;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    kind: "stroke",
    id: WorkflowNodeId.make(`m_${shortId()}`),
    x: round(left),
    y: round(top),
    points: kept.flatMap((point) => [round(point.x - left), round(point.y - top)]),
    color: style.color,
    weight: style.weight,
  };
}

/**
 * Copies of the given boxes and notes, moved by `dx`,`dy`, with the arrows
 * between them copied too. A copied note attached to a copied box points at
 * the copy; attached to a box left behind, it isn't attached.
 */
export function duplicateNodes(
  doc: Pick<WorkflowDefinition, "nodes" | "edges">,
  ids: ReadonlySet<string>,
  dx: number,
  dy: number,
): { nodes: WorkflowNode[]; edges: WorkflowEdge[] } {
  const fresh = new Map<string, WorkflowNodeId>();
  for (const node of doc.nodes) {
    if (ids.has(node.id)) fresh.set(node.id, WorkflowNodeId.make(`n_${shortId()}`));
  }
  const nodes = doc.nodes.flatMap((node): WorkflowNode[] => {
    const id = fresh.get(node.id);
    if (id === undefined) return [];
    const moved = { ...node, id, x: node.x + dx, y: node.y + dy };
    return [
      node.kind === "note"
        ? { ...(moved as WorkflowNoteNode), attachedTo: fresh.get(node.attachedTo ?? "") ?? null }
        : (moved as WorkflowAgentNode),
    ];
  });
  const edges = doc.edges.flatMap((edge) => {
    const from = fresh.get(edge.from);
    const to = fresh.get(edge.to);
    return from !== undefined && to !== undefined ? [newEdge(from, to, edge.kind)] : [];
  });
  return { nodes, edges };
}

/** A mark moved by `dx`,`dy` with a fresh id, for duplicating. */
export function copyMark(mark: WorkflowMark, dx: number, dy: number): WorkflowMark {
  return { ...mark, id: WorkflowNodeId.make(`m_${shortId()}`), x: mark.x + dx, y: mark.y + dy };
}

export function newEdge(
  from: WorkflowNodeId,
  to: WorkflowNodeId,
  kind: WorkflowEdge["kind"],
): WorkflowEdge {
  return { id: WorkflowEdgeId.make(`e_${shortId()}`), from, to, kind };
}

export function isAgent(node: WorkflowNode): node is WorkflowAgentNode {
  return node.kind === "agent";
}

/** "×3", "up to 8", or null for a single agent. */
export function countLabel(count: WorkflowAgentCount): string | null {
  if (count.kind === "upTo") return `up to ${count.max}`;
  return count.n > 1 ? `×${count.n}` : null;
}

/** How many agent slots a box can hold, the most a run will ever show for it. */
export function countCapacity(count: WorkflowAgentCount): number {
  return count.kind === "upTo" ? count.max : count.n;
}

export function firstLine(text: string): string {
  return (
    text
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? ""
  );
}

/** Title shown on a box: its label, else what was typed, else a placeholder. */
export function agentTitle(node: WorkflowAgentNode): string {
  return node.label.trim() || firstLine(node.text) || "Untitled agent";
}

/**
 * The lead: the only agent without a parent. Kept in sync with the edges so a
 * saved draft always names its root once one exists.
 */
export function deriveRootNodeId(
  nodes: ReadonlyArray<WorkflowNode>,
  edges: ReadonlyArray<WorkflowEdge>,
): WorkflowNodeId | null {
  const children = new Set(edges.filter((e) => e.kind === "delegates").map((e) => e.to));
  const roots = nodes.filter((node) => isAgent(node) && !children.has(node.id));
  return roots.length === 1 ? roots[0]!.id : null;
}

export function withDerivedRoot(definition: WorkflowDefinition): WorkflowDefinition {
  const rootNodeId = deriveRootNodeId(definition.nodes, definition.edges);
  return rootNodeId === definition.rootNodeId ? definition : { ...definition, rootNodeId };
}

export function childrenOf(
  definition: Pick<WorkflowDefinition, "nodes" | "edges">,
  nodeId: WorkflowNodeId,
): WorkflowAgentNode[] {
  const byId = new Map(definition.nodes.map((node) => [node.id, node]));
  return definition.edges
    .filter((edge) => edge.kind === "delegates" && edge.from === nodeId)
    .map((edge) => byId.get(edge.to))
    .filter((node): node is WorkflowAgentNode => node !== undefined && isAgent(node));
}

/**
 * Tidy up: the shared layered layout, moved so the lead stays where the user
 * left it, with attached notes kept beside their agent.
 */
export function tidyWorkflow(
  definition: WorkflowDefinition,
  only?: ReadonlySet<WorkflowNodeId>,
): WorkflowDefinition {
  const laid = layoutWorkflow(definition, only);
  const before = new Map(definition.nodes.map((node) => [node.id, node]));
  const lead = definition.nodes.find((node) => node.id === definition.rootNodeId);
  const leadAfter = laid.nodes.find((node) => node.id === lead?.id);
  const dx = lead && leadAfter && !only ? lead.x - leadAfter.x : 0;
  const dy = lead && leadAfter && !only ? lead.y - leadAfter.y : 0;
  const moved = new Map<WorkflowNodeId, WorkflowNode>();
  for (const node of laid.nodes) {
    const previous = before.get(node.id);
    if (node.kind !== "agent" || !previous || (previous.x === node.x && previous.y === node.y)) {
      continue;
    }
    moved.set(node.id, { ...node, x: Math.round(node.x + dx), y: Math.round(node.y + dy) });
  }
  if (moved.size === 0) return definition;
  return {
    ...laid,
    nodes: laid.nodes.map((node) => {
      const next = moved.get(node.id);
      if (next) return next;
      if (node.kind === "note" && node.attachedTo !== null) {
        const agent = moved.get(node.attachedTo);
        if (agent) return { ...node, x: agent.x + agent.width + 32, y: agent.y };
      }
      return node;
    }),
  };
}

/**
 * Issues that only matter once a run starts. While sketching, boxes without
 * models and loose boxes are normal, so these wait until Start.
 */
export const START_ONLY_ISSUES: ReadonlySet<string> = new Set([
  "Choose a model.",
  "Use exactly one root agent.",
  "Select the root agent.",
]);
/** Stable list key for an issue; validation reports each problem once. */
export function issueKey(issue: WorkflowIssue): string {
  return `${issue.nodeId ?? ""}:${issue.edgeId ?? ""}:${issue.message}`;
}

/**
 * What a compile proposal changes, so the canvas can highlight it. Positions
 * and sizes don't count: moving a box isn't a change worth reviewing.
 */
export function diffWorkflows(
  before: WorkflowDefinition,
  after: WorkflowDefinition,
): { added: Set<string>; changed: Set<string>; removed: Set<string> } {
  const added = new Set<string>();
  const changed = new Set<string>();
  const removed = new Set<string>();
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  for (const node of after.nodes) {
    const previous = beforeNodes.get(node.id);
    if (!previous) added.add(node.id);
    else if (contentKey(previous) !== contentKey(node)) changed.add(node.id);
  }
  for (const node of before.nodes) if (!afterNodes.has(node.id)) removed.add(node.id);
  const edgeKey = (edge: WorkflowEdge) => `${edge.from}>${edge.to}:${edge.kind}`;
  const beforeEdges = new Set(before.edges.map(edgeKey));
  const afterEdges = new Set(after.edges.map(edgeKey));
  for (const edge of after.edges) if (!beforeEdges.has(edgeKey(edge))) added.add(edge.id);
  for (const edge of before.edges) if (!afterEdges.has(edgeKey(edge))) removed.add(edge.id);
  return { added, changed, removed };
}

function contentKey(node: WorkflowNode): string {
  const { x: _x, y: _y, width: _w, height: _h, ...content } = node;
  return JSON.stringify(content);
}

// ---------------------------------------------------------------------------
// Runs

export const LIVE_AGENT_STATUSES: ReadonlySet<WorkflowAgentStatus> = new Set([
  "pending",
  "running",
  "waiting",
]);

export function isRunLive(status: WorkflowRunStatus): boolean {
  return status === "starting" || status === "running" || status === "waiting";
}

export interface RunBox {
  readonly node: WorkflowAgentNode;
  /** Agents filling this box, by slot. Empty while the box is still planned. */
  readonly agents: ReadonlyArray<WorkflowRunAgent>;
  readonly status: WorkflowAgentStatus;
}

const STATUS_WEIGHT: Record<WorkflowAgentStatus, number> = {
  running: 7,
  waiting: 6,
  pending: 5,
  failed: 4,
  interrupted: 3,
  cancelled: 2,
  completed: 1,
  planned: 0,
};

/**
 * What a box shows for its agents: work still going outranks a failure (the
 * fan shows which one failed), a failure outranks finished work, and done
 * means every agent that started is done.
 */
export function boxStatus(agents: ReadonlyArray<WorkflowRunAgent>): WorkflowAgentStatus {
  let status: WorkflowAgentStatus = "planned";
  for (const agent of agents) {
    if (STATUS_WEIGHT[agent.status] > STATUS_WEIGHT[status]) status = agent.status;
  }
  return status;
}

export function runBoxes(run: WorkflowRun): Map<WorkflowNodeId, RunBox> {
  const agentsByNode = new Map<WorkflowNodeId, WorkflowRunAgent[]>();
  for (const agent of currentWorkflowAgents(run.agents)) {
    agentsByNode.set(agent.nodeId, [...(agentsByNode.get(agent.nodeId) ?? []), agent]);
  }
  const boxes = new Map<WorkflowNodeId, RunBox>();
  for (const node of run.snapshot.nodes) {
    if (!isAgent(node)) continue;
    const agents = (agentsByNode.get(node.id) ?? []).toSorted((a, b) => a.slot - b.slot);
    boxes.set(node.id, { node, agents, status: boxStatus(agents) });
  }
  return boxes;
}

export type AgentChatTarget =
  | { readonly kind: "app"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "web"; readonly url: string };

/**
 * Where an agent's chat opens. Remote agents carry a link to
 * `<app>/<environment>/<thread>`: open it in the app when this client is
 * connected to that environment, else as a web link.
 */
export function agentChatTarget(
  agent: Pick<WorkflowRunAgent, "threadId" | "threadLink">,
  environmentId: string,
  isConnected: (environmentId: string) => boolean,
): AgentChatTarget {
  const local = { kind: "app", environmentId, threadId: agent.threadId } as const;
  if (!agent.threadLink) return local;
  let url: URL;
  try {
    url = new URL(agent.threadLink);
  } catch {
    return local;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return local;
  const [remoteEnvironment, remoteThread] = url.pathname.split("/").filter(Boolean).slice(-2);
  try {
    if (remoteEnvironment && remoteThread) {
      const target = decodeURIComponent(remoteEnvironment);
      if (isConnected(target)) {
        return { kind: "app", environmentId: target, threadId: decodeURIComponent(remoteThread) };
      }
    }
  } catch {
    // A malformed escape still has a usable web link.
  }
  return { kind: "web", url: url.href };
}

/** "42s", "3m 05s", "1h 02m". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function elapsedBetween(
  startedAt: string | null,
  completedAt: string | null,
  now: number,
): number | null {
  if (startedAt === null) return null;
  const end = completedAt === null ? now : Date.parse(completedAt);
  return end - Date.parse(startedAt);
}

export { WORKFLOW_AGENT_STATUS_LABEL as AGENT_STATUS_LABEL } from "@t3tools/client-runtime/workflow-run";

export const RUN_STATUS_LABEL: Record<WorkflowRunStatus, string> = {
  starting: "Starting",
  running: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};
