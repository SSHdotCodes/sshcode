import type {
  ModelSelection,
  OrchestratorMcpDelegateTaskInput,
  WorkflowRun,
  WorkflowRunAgent,
  WorkflowNodeId,
} from "@t3tools/contracts";
import { compactWorkflowPlan, workflowChildren } from "@t3tools/shared/workflows";

/** Policy is scoped to the invoking parent instance, including counts and sibling sequencing. */
export function planWorkflowDelegation(
  run: WorkflowRun,
  parentThreadId: WorkflowRun["leadThreadId"],
  input: OrchestratorMcpDelegateTaskInput,
  inherited: ModelSelection,
  reserved: ReadonlyArray<WorkflowRunAgent> = [],
  nodeId?: WorkflowNodeId,
  replacement?: WorkflowRunAgent["threadId"],
) {
  const parent = run.agents.find((a) => a.threadId === parentThreadId);
  if (!parent) return { error: "Workflow parent is unavailable." };
  if (["cancelled", "interrupted", "failed"].includes(parent.status))
    return { error: "Workflow parent has stopped." };
  if (run.agents.some((a) => a.retryOf === parentThreadId))
    return { error: "Workflow agent was replaced." };
  const children = workflowChildren(run.snapshot, parent.nodeId);
  const allowed =
    children
      .map((n) => `${n.label} (${n.model?.model ?? "no model"})`)
      .join(", ")
      .slice(0, 800) || "none";
  const denied = (reason: string) => ({ error: `${reason} Allowed boxes: ${allowed}.` });
  if (["completed", "failed", "cancelled"].includes(run.status)) return denied("Run has ended.");
  const model = input.target?.model ?? inherited.model;
  const instance =
    input.target?.providerInstanceId ?? (input.target?.model ? undefined : inherited.instanceId);
  let candidates = children.filter((n) =>
    nodeId
      ? n.id === nodeId
      : n.model?.model === model && (instance === undefined || n.model.instanceId === instance),
  );
  const title = input.title?.trim().toLowerCase() ?? "";
  if (candidates.length > 1)
    // Longest name first, so "Sol 1" never claims a "Sol 10" title.
    candidates = candidates
      .filter((n) => n.label && title.startsWith(n.label.toLowerCase()))
      .toSorted((a, b) => b.label.length - a.label.length)
      .slice(0, 1);
  const node = candidates[0];
  if (!node || candidates.length !== 1 || !node.model)
    return denied("Choose a drawn model and start the title with its box label.");
  if (input.isolation !== undefined && input.isolation !== node.isolation)
    return denied(`Use isolation ${node.isolation} for ${node.label}.`);
  const all = [...run.agents, ...reserved];
  const replaced = new Set(all.flatMap((a) => (a.retryOf ? [a.retryOf] : [])));
  const agents = all.filter((a) => !replaced.has(a.threadId) && a.threadId !== replacement);
  const siblings = agents.filter((a) => a.parentThreadId === parentThreadId);
  const count = siblings.filter((a) => a.nodeId === node.id).length;
  if (count >= (node.count.kind === "exact" ? node.count.n : node.count.max))
    return denied(`${node.label} count is full.`);
  if (
    run.snapshot.edges.some(
      (e) => e.kind === "then" && e.from === node.id && siblings.some((a) => a.nodeId === e.to),
    )
  )
    return denied(`${node.label} already has a started successor.`);
  const results: string[] = [];
  for (const edge of run.snapshot.edges.filter((e) => e.kind === "then" && e.to === node.id)) {
    const previous = children.find((n) => n.id === edge.from)!;
    const instances = siblings.filter((a) => a.nodeId === previous.id);
    const minimum = previous.count.kind === "exact" ? previous.count.n : 1;
    if (instances.length < minimum || instances.some((a) => a.status !== "completed"))
      return denied(`Wait for ${previous.label} to complete.`);
    for (const a of instances)
      results.push(`Read ${previous.label}'s result in thread ${a.threadId} before starting.`);
  }
  const slots = new Set(agents.filter((a) => a.nodeId === node.id).map((a) => a.slot));
  let slot = 0;
  while (slots.has(slot)) slot++;
  return {
    node,
    slot,
    input: {
      ...input,
      title: (input.title?.trim().toLowerCase().startsWith(node.label.toLowerCase())
        ? input.title
        : `${node.label}: ${input.title ?? input.task.slice(0, 80)}`
      ).slice(0, 200),
      isolation: node.isolation,
      target: {
        providerInstanceId: node.model.instanceId,
        model: node.model.model,
        ...(node.model.options ? { options: node.model.options } : {}),
        userNamedModel: true,
      },
      task: [input.task, ...results, compactWorkflowPlan(run.snapshot, node.id)].join("\n\n"),
    } satisfies OrchestratorMcpDelegateTaskInput,
  };
}
