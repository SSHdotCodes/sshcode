import type {
  ThreadId,
  WorkflowAgentStatus,
  WorkflowNodeId,
  WorkflowRunAgent,
} from "@t3tools/contracts";

export const WORKFLOW_AGENT_STATUS_LABEL: Record<WorkflowAgentStatus, string> = {
  planned: "Planned",
  pending: "Starting",
  running: "Running",
  waiting: "Waiting",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

/**
 * The agents a run shows. Retry starts a new attempt in the same slot, so an
 * attempt that a later one replaced drops out.
 */
export function currentWorkflowAgents(
  agents: ReadonlyArray<WorkflowRunAgent>,
): ReadonlyArray<WorkflowRunAgent> {
  const replaced = new Set(agents.flatMap((agent) => (agent.retryOf ? [agent.retryOf] : [])));
  return replaced.size === 0 ? agents : agents.filter((agent) => !replaced.has(agent.threadId));
}

/** The newest attempt for a thread: follows Retry from attempt to attempt. */
export function latestWorkflowAttempt(
  agents: ReadonlyArray<WorkflowRunAgent>,
  threadId: ThreadId,
): ThreadId {
  let current = threadId;
  // Bounded so a malformed retry cycle can't spin.
  for (let hops = 0; hops < agents.length; hops++) {
    const next = agents.find((agent) => agent.retryOf === current);
    if (!next) break;
    current = next.threadId;
  }
  return current;
}

/** The agent for a thread, or the newest attempt that replaced it. */
export function findWorkflowAgent(
  agents: ReadonlyArray<WorkflowRunAgent>,
  threadId: ThreadId,
): WorkflowRunAgent | null {
  const latest = latestWorkflowAttempt(agents, threadId);
  return agents.find((agent) => agent.threadId === latest) ?? null;
}

/**
 * The agent a run view's selection points at. A picked thread follows Retry to
 * its newest attempt; with none picked, a box holding exactly one agent picks it.
 */
export function selectedWorkflowAgent(
  agents: ReadonlyArray<WorkflowRunAgent>,
  selection: { readonly nodeId: WorkflowNodeId; readonly threadId: ThreadId | null },
): WorkflowRunAgent | null {
  if (selection.threadId !== null) {
    const picked = findWorkflowAgent(agents, selection.threadId);
    if (picked?.nodeId === selection.nodeId) return picked;
  }
  const inBox = currentWorkflowAgents(agents).filter((agent) => agent.nodeId === selection.nodeId);
  return inBox.length === 1 ? inBox[0]! : null;
}

/** Agents with an open approval or question card, in run order. */
export function workflowAgentsNeedingYou(
  agents: ReadonlyArray<WorkflowRunAgent>,
): ReadonlyArray<WorkflowRunAgent & { readonly needs: "approval" | "input" }> {
  return currentWorkflowAgents(agents).filter(
    (agent): agent is WorkflowRunAgent & { readonly needs: "approval" | "input" } =>
      agent.needs !== undefined,
  );
}

/** "Planner · approval". */
export function workflowNeedsLabel(agent: Pick<WorkflowRunAgent, "title" | "needs">): string {
  return agent.needs ? `${agent.title} · ${agent.needs}` : agent.title;
}

export interface WorkflowAgentActions {
  /** A steer reaches a turn in flight. */
  readonly steer: boolean;
  readonly stop: boolean;
  readonly retry: boolean;
}

/** Which one-agent actions fit the agent's state. Connection and permission come on top. */
export function workflowAgentActions(
  agent: Pick<WorkflowRunAgent, "status">,
): WorkflowAgentActions {
  const { status } = agent;
  return {
    steer: status === "running" || status === "waiting",
    stop: status === "pending" || status === "running" || status === "waiting",
    retry:
      status === "completed" ||
      status === "failed" ||
      status === "cancelled" ||
      status === "interrupted",
  };
}
