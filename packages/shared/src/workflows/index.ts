import type {
  WorkflowAgentNode,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowIssue,
  WorkflowNodeId,
  WorkflowRun,
  WorkflowRunAgent,
  WorkflowRunStatus,
  WorkflowRunDiagnostic,
} from "@t3tools/contracts";

export const workflowAgents = (workflow: WorkflowDefinition) =>
  workflow.nodes.filter((node): node is WorkflowAgentNode => node.kind === "agent");

export const workflowChildren = (workflow: WorkflowDefinition, nodeId: WorkflowNodeId) => {
  const ids = new Set(
    workflow.edges.filter((e) => e.kind === "delegates" && e.from === nodeId).map((e) => e.to),
  );
  return workflowAgents(workflow).filter((node) => ids.has(node.id));
};

/**
 * Run snapshots name every agent box, because subagent titles start with the box
 * name: the label, else the first typed line, else "Agent". Repeated names get a
 * number in reading order ("gpt 6.1 sol 1", "gpt 6.1 sol 2").
 */
export function withRunLabels(workflow: WorkflowDefinition): WorkflowDefinition {
  const agents = workflowAgents(workflow);
  const base = new Map(
    agents.map((n) => {
      const typed = n.text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return [n.id, (n.label.trim() || typed || "Agent").slice(0, 72)] as const;
    }),
  );
  const totals = new Map<string, number>();
  for (const name of base.values()) totals.set(name, (totals.get(name) ?? 0) + 1);
  const seen = new Map<string, number>();
  const names = new Map<WorkflowNodeId, string>();
  // Hermes (the phone) lacks Array#toSorted.
  for (const n of [...agents].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const name = base.get(n.id)!;
    if ((totals.get(name) ?? 0) < 2) names.set(n.id, name);
    else {
      const index = (seen.get(name) ?? 0) + 1;
      seen.set(name, index);
      names.set(n.id, `${name} ${index}`);
    }
  }
  return {
    ...workflow,
    nodes: workflow.nodes.map((n) =>
      n.kind === "agent" ? { ...n, label: names.get(n.id) ?? n.label } : n,
    ),
  };
}

/** Drafts can be unresolved; runs require a complete, connected agent tree. */
export function validateWorkflow(workflow: WorkflowDefinition): WorkflowIssue[] {
  const issues: WorkflowIssue[] = [];
  const issue = (
    message: string,
    nodeId: WorkflowNodeId | null = null,
    edgeId: WorkflowEdge["id"] | null = null,
  ) => issues.push({ message, nodeId, edgeId });
  const nodes = new Map(workflow.nodes.map((node) => [node.id, node]));
  const agents = workflowAgents(workflow);
  if (workflow.nodes.length > 64) issue("Use at most 64 nodes.");
  if (nodes.size !== workflow.nodes.length) issue("Node ids must be unique.");
  if (new Set(workflow.edges.map((e) => e.id)).size !== workflow.edges.length)
    issue("Edge ids must be unique.");
  const parents = new Map<WorkflowNodeId, WorkflowNodeId>();
  for (const edge of workflow.edges) {
    const from = nodes.get(edge.from),
      to = nodes.get(edge.to);
    if (!from || !to || to.kind !== "agent" || (edge.kind === "then" && from.kind !== "agent")) {
      issue("Connect this arrow to agent boxes.", null, edge.id);
      continue;
    }
    if (edge.kind === "delegates" && from.kind === "agent") {
      if (parents.has(to.id)) issue("An agent can have only one parent.", to.id, edge.id);
      parents.set(to.id, from.id);
    }
  }
  const roots = agents.filter((node) => !parents.has(node.id));
  if (roots.length !== 1) issue("Use exactly one root agent.");
  if (roots.length === 1 && workflow.rootNodeId !== roots[0]!.id)
    issue("Select the root agent.", roots[0]!.id);
  for (const node of agents) {
    if (!node.model) issue("Choose a model.", node.id);
    const count = node.count.kind === "exact" ? node.count.n : node.count.max;
    if (!Number.isInteger(count) || count < 1 || count > 16)
      issue("Use a count from 1 to 16.", node.id);
    if (roots.includes(node) && (node.count.kind !== "exact" || node.count.n !== 1))
      issue("The lead must have count 1.", node.id);
    if (roots.includes(node) && node.isolation !== "shared")
      issue(
        "Workflow leads require shared placement. Worktree leads are not supported yet.",
        node.id,
      );
  }
  for (const note of workflow.nodes)
    if (note.kind === "note" && note.attachedTo && nodes.get(note.attachedTo)?.kind !== "agent")
      issue("Attach this note to an agent.", note.id);
  for (const edge of workflow.edges.filter((e) => e.kind === "then")) {
    if (!parents.has(edge.from) || parents.get(edge.from) !== parents.get(edge.to))
      issue("Then arrows must connect siblings.", null, edge.id);
  }
  for (const kind of ["delegates", "then"] as const) {
    const visiting = new Set<WorkflowNodeId>(),
      done = new Set<WorkflowNodeId>();
    const visit = (id: WorkflowNodeId): void => {
      if (done.has(id)) return;
      visiting.add(id);
      for (const edge of workflow.edges.filter(
        (e) => e.kind === kind && e.from === id && nodes.get(e.from)?.kind === "agent",
      )) {
        if (visiting.has(edge.to))
          issue(
            `${kind === "then" ? "Then" : "Delegation"} arrows cannot form a cycle.`,
            null,
            edge.id,
          );
        else visit(edge.to);
      }
      visiting.delete(id);
      done.add(id);
    };
    for (const node of agents) visit(node.id);
  }
  return issues;
}

/** Layered tree layout; optional ids let compile place only newly generated boxes. */
export function layoutWorkflow(
  workflow: WorkflowDefinition,
  onlyIds?: ReadonlySet<WorkflowNodeId>,
): WorkflowDefinition {
  const positions = new Map<WorkflowNodeId, { x: number; y: number }>();
  const measured = new Map<
    WorkflowNodeId,
    { width: number; children: WorkflowAgentNode[]; depth: number }
  >();
  const heights: number[] = [];
  const measure = (node: WorkflowAgentNode, depth: number): number => {
    if (measured.has(node.id)) return 0;
    const box = { width: node.width, children: [] as WorkflowAgentNode[], depth };
    measured.set(node.id, box);
    heights[depth] = Math.max(heights[depth] ?? 0, node.height);
    let width = 0;
    for (const child of workflowChildren(workflow, node.id)) {
      if (measured.has(child.id)) continue;
      box.children.push(child);
      width += measure(child, depth + 1) + 60;
    }
    box.width = Math.max(node.width, width - 60);
    return box.width;
  };
  const agents = workflowAgents(workflow);
  const roots = agents.filter(
    (n) =>
      !workflow.edges.some(
        (e) => e.kind === "delegates" && e.to === n.id && agents.some((a) => a.id === e.from),
      ),
  );
  const forest: WorkflowAgentNode[] = [];
  for (const node of [...roots, ...agents])
    if (!measured.has(node.id)) {
      forest.push(node);
      measure(node, 0);
    }
  const offsets = heights.map((_, i) =>
    heights.slice(0, i).reduce((sum, height) => sum + height + 80, 0),
  );
  const place = (node: WorkflowAgentNode, left: number) => {
    const box = measured.get(node.id)!;
    positions.set(node.id, { x: left + (box.width - node.width) / 2, y: offsets[box.depth]! });
    const childrenWidth =
      box.children.reduce((sum, child) => sum + measured.get(child.id)!.width, 0) +
      Math.max(0, box.children.length - 1) * 60;
    let childLeft = left + (box.width - childrenWidth) / 2;
    for (const child of box.children) {
      place(child, childLeft);
      childLeft += measured.get(child.id)!.width + 60;
    }
  };
  let left = 0;
  for (const root of forest) {
    place(root, left);
    left += measured.get(root.id)!.width + 60;
  }
  return {
    ...workflow,
    nodes: workflow.nodes.map((node) =>
      positions.has(node.id) && (!onlyIds || onlyIds.has(node.id))
        ? { ...node, ...positions.get(node.id)! }
        : node,
    ),
  };
}

export interface WorkflowUnboundArrow {
  readonly id: WorkflowEdge["id"];
  readonly from: { readonly x: number; readonly y: number };
  readonly to: { readonly x: number; readonly y: number };
  readonly kind: "delegates" | "then";
}

/** Distance to a box's border, not its center, makes large and small boxes snap alike. */
export function resolveWorkflowArrows(
  workflow: WorkflowDefinition,
  arrows: ReadonlyArray<WorkflowUnboundArrow>,
): WorkflowDefinition {
  const nearest = (point: { x: number; y: number }) =>
    [...workflow.nodes].sort((a, b) => {
      const distance = (n: typeof a) =>
        Math.hypot(
          Math.max(n.x - point.x, 0, point.x - n.x - n.width),
          Math.max(n.y - point.y, 0, point.y - n.y - n.height),
        );
      return distance(a) - distance(b) || a.id.localeCompare(b.id);
    })[0];
  const edges = [...workflow.edges];
  for (const arrow of arrows) {
    const from = nearest(arrow.from),
      to = nearest(arrow.to);
    if (from && to) edges.push({ id: arrow.id, from: from.id, to: to.id, kind: arrow.kind });
  }
  return { ...workflow, edges };
}

function attachedNotes(workflow: WorkflowDefinition, id: WorkflowNodeId) {
  return workflow.nodes
    .filter(
      (n) =>
        n.kind === "note" &&
        (n.attachedTo === id || workflow.edges.some((e) => e.from === n.id && e.to === id)),
    )
    .map((n) => n.text);
}

/** An agent receives its box and direct children only, never the scene or other branches. */
export function compactWorkflowPlan(workflow: WorkflowDefinition, nodeId: WorkflowNodeId): string {
  const own = workflowAgents(workflow).find((n) => n.id === nodeId);
  if (!own) return "";
  const children = workflowChildren(workflow, nodeId);
  const describe = (n: WorkflowAgentNode) =>
    `${n.label} | ${n.model?.instanceId}/${n.model?.model} | ${n.count.kind === "exact" ? `exact ${n.count.n}` : `up to ${n.count.max}`} | ${n.machine}, ${n.isolation}\n${[n.instructions, ...attachedNotes(workflow, n.id)].filter(Boolean).join("\n")}`;
  const lines = [`Workflow: ${describe(own)}`];
  if (nodeId === workflow.rootNodeId)
    for (const n of workflow.nodes)
      if (n.kind === "note" && !n.attachedTo && !workflow.edges.some((e) => e.from === n.id))
        lines.push(n.text);
  if (children.length) {
    lines.push(
      "Delegate only these boxes, using exactly their models, machine and isolation. Start each title with the box label. Exact counts are required; up-to counts are your choice.",
      ...children.map(describe),
    );
    const ids = new Set(children.map((n) => n.id));
    for (const e of workflow.edges)
      if (e.kind === "then" && ids.has(e.from) && ids.has(e.to))
        lines.push(
          `Then: ${children.find((n) => n.id === e.from)!.label} completes before ${children.find((n) => n.id === e.to)!.label}; pass its result.`,
        );
  } else lines.push("No child boxes. Do not delegate.");
  return lines.join("\n");
}

export function rollupWorkflowRun(
  agents: ReadonlyArray<WorkflowRunAgent>,
  leadThreadId: WorkflowRun["leadThreadId"],
): WorkflowRunStatus {
  const lead = agents.find((agent) => agent.threadId === leadThreadId);
  if (lead?.status === "failed") return "failed";
  if (lead?.status === "cancelled" || lead?.status === "interrupted") return "cancelled";
  if (lead?.status === "completed") return "completed";
  if (agents.some((a) => a.status === "running")) return "running";
  const live = agents.filter((a) => ["pending", "running", "waiting"].includes(a.status));
  if (live.length && live.every((a) => a.status === "waiting")) return "waiting";
  return "starting";
}

/** Existing-chat leads stay in the normal list; dedicated leads and all their run agents don't. */
export function workflowHiddenThreadIds(
  runs: ReadonlyArray<WorkflowRun>,
): ReadonlySet<WorkflowRun["leadThreadId"]> {
  return new Set(
    runs.flatMap((run) =>
      run.agents
        .filter((a) => run.origin === "workflows" || a.threadId !== run.leadThreadId)
        .map((a) => a.threadId),
    ),
  );
}

/** Execution evidence for the run's subtree, including remote policy handoffs. */
export function workflowRunDiagnostics(run: WorkflowRun): WorkflowRunDiagnostic[] {
  const diagnostics: WorkflowRunDiagnostic[] = [];
  const replaced = new Set(run.agents.flatMap((a) => (a.retryOf ? [a.retryOf] : [])));
  const agents = run.agents.filter((a) => !replaced.has(a.threadId));
  const settled = ["completed", "failed", "cancelled"].includes(run.status);
  const lead = agents.find((a) => a.threadId === run.leadThreadId);
  const add = (
    kind: WorkflowRunDiagnostic["kind"],
    nodeId: WorkflowNodeId,
    message: string,
    threadId: WorkflowRunAgent["threadId"] | null = null,
  ) => diagnostics.push({ kind, nodeId, threadId, message: message.slice(0, 300) });
  const visited = new Set<WorkflowNodeId>();
  const visit = (
    node: WorkflowAgentNode,
    parents: ReadonlyArray<WorkflowRunAgent> | null,
    parentCount: number,
  ) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    const instances =
      parents === null
        ? lead
          ? [lead]
          : []
        : agents.filter(
            (a) => a.nodeId === node.id && parents.some((p) => p.threadId === a.parentThreadId),
          );
    // Exact branches include missing parents; optional branches count only actual parents.
    const expected =
      parents === null ? 1 : parentCount * (node.count.kind === "exact" ? node.count.n : 0);
    if (settled && instances.length < expected)
      add(
        "missing",
        node.id,
        `${node.label}: ${expected - instances.length} required instance(s) not started.`,
      );
    const failed = instances.filter((a) => a.status === "failed");
    const skipped = instances.filter(
      (a) =>
        a.status === "cancelled" ||
        a.status === "interrupted" ||
        (settled && a.status === "planned"),
    );
    if (failed.length) add("failed", node.id, `${node.label}: ${failed.length} failed.`);
    if (skipped.length)
      add("skipped", node.id, `${node.label}: ${skipped.length} skipped or stopped.`);
    for (const agent of instances) {
      if (
        node.model &&
        ((agent.model !== null && agent.model !== node.model.model) ||
          (agent.instanceId !== undefined && agent.instanceId !== node.model.instanceId))
      )
        add(
          "model",
          node.id,
          `${node.label}: used ${agent.model ?? "an unknown model"}; expected ${node.model.model}.`,
          agent.threadId,
        );
      if (
        (agent.machine !== undefined && agent.machine !== node.machine) ||
        (agent.isolation !== undefined && agent.isolation !== node.isolation)
      )
        add(
          "placement",
          node.id,
          `${node.label}: used ${agent.machine ?? "unknown"}, ${agent.isolation ?? "unknown"}; expected ${node.machine}, ${node.isolation}.`,
          agent.threadId,
        );
      for (const edge of run.snapshot.edges.filter((e) => e.kind === "then" && e.to === node.id)) {
        const predecessor = workflowAgents(run.snapshot).find((n) => n.id === edge.from);
        const previous = agents.filter(
          (a) => a.nodeId === edge.from && a.parentThreadId === agent.parentThreadId,
        );
        const minimum = predecessor?.count.kind === "exact" ? predecessor.count.n : 1;
        if (
          previous.length < minimum ||
          previous.some(
            (a) =>
              a.status !== "completed" ||
              (agent.startedAt !== null &&
                a.completedAt !== null &&
                a.completedAt > agent.startedAt),
          )
        )
          add(
            "predecessor",
            node.id,
            `${node.label}: predecessor ${predecessor?.label ?? edge.from} was not complete.`,
            agent.threadId,
          );
      }
    }
    for (const child of workflowChildren(run.snapshot, node.id))
      visit(
        child,
        instances,
        node.count.kind === "exact" ? Math.max(expected, instances.length) : instances.length,
      );
  };
  const root = workflowAgents(run.snapshot).find(
    (n) => n.id === (lead?.nodeId ?? run.snapshot.rootNodeId),
  );
  if (root) visit(root, null, 1);
  return diagnostics;
}

export type AgentChatTarget =
  | { readonly kind: "app"; readonly environmentId: string; readonly threadId: string }
  | { readonly kind: "web"; readonly url: string };

/**
 * Where a run agent's chat opens. Remote agents carry a link to
 * `<app>/<environment>/<thread>`: open it in the app when this client is
 * connected to that environment, else as a web link.
 */
export function agentChatTarget(
  agent: { readonly threadId: string; readonly threadLink?: string | null },
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
