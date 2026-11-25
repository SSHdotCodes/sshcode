import {
  defaultInstanceIdForDriver,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  WorkflowEdgeId,
  WorkflowId,
  WorkflowNodeId,
  type ServerProvider,
  type WorkflowAgentNode,
  type WorkflowDefinition,
  type WorkflowEdge,
  type WorkflowNode,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { layoutWorkflow, validateWorkflow } from "@t3tools/shared/workflows";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import {
  workflowsAgentAccess,
  workflowsBetaEnabled,
  workflowsDelegate,
} from "../../../workflows/workflowsBeta.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { WorkflowToolInput, WorkflowToolkit, type WorkflowBox } from "./tools.ts";

const AGENT = { width: 240, height: 132 } as const;
const NOTE = { width: 200, height: 96 } as const;

const fail = (message: string, code: "invalid_request" | "capability_denied" = "invalid_request") =>
  new OrchestratorMcpFailure({ code, message });

/** "instance/model" or a bare slug (including slugs with "/"); bare slugs prefer the default instance. */
export function resolveWorkflowModel(
  spec: string,
  providers: ReadonlyArray<ServerProvider>,
): { readonly instanceId: ProviderInstanceId; readonly model: string } | null {
  const pick = (matches: ReadonlyArray<ServerProvider>, model: string) => {
    const chosen =
      matches.find((p) => p.instanceId === defaultInstanceIdForDriver(p.driver)) ?? matches[0];
    return chosen ? { instanceId: ProviderInstanceId.make(chosen.instanceId), model } : null;
  };
  const slash = spec.indexOf("/");
  if (slash > 0) {
    const instance = spec.slice(0, slash);
    const slug = spec.slice(slash + 1);
    const explicit = providers.filter(
      (p) =>
        p.instanceId === instance && p.enabled !== false && p.models.some((m) => m.slug === slug),
    );
    if (explicit.length > 0) return pick(explicit, slug);
  }
  const bare = providers.filter(
    (p) => p.enabled !== false && p.models.some((m) => m.slug === spec),
  );
  return pick(bare, spec);
}

/** Build a workflow from an agent's boxes, keeping positions of boxes it already had. */
export function workflowFromBoxes(input: {
  readonly id: WorkflowId;
  readonly name: string;
  readonly boxes: ReadonlyArray<typeof WorkflowBox.Type>;
  readonly notes: ReadonlyArray<string> | undefined;
  readonly existing: WorkflowDefinition | undefined;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly now: string;
}): WorkflowDefinition | string {
  const ids = new Set<string>();
  for (const box of input.boxes) {
    if (!box.id.trim()) return "Every box needs an id.";
    if (ids.has(box.id)) return `Box id ${box.id} is used twice.`;
    ids.add(box.id);
  }
  const old = new Map((input.existing?.nodes ?? []).map((node) => [node.id as string, node]));
  const fresh = new Set<WorkflowNodeId>();
  const agents: WorkflowAgentNode[] = [];
  for (const box of input.boxes) {
    const model = resolveWorkflowModel(box.model, input.providers);
    if (!model) return `Unknown model ${box.model}. Use one from orchestrator_capabilities.`;
    for (const ref of [box.parent, box.after])
      if (ref !== undefined && !ids.has(ref)) return `Box ${box.id} points at missing box ${ref}.`;
    const id = WorkflowNodeId.make(box.id);
    const previous = old.get(box.id);
    if (!previous) fresh.add(id);
    agents.push({
      kind: "agent",
      id,
      x: previous?.x ?? 0,
      y: previous?.y ?? 0,
      width: previous?.width ?? AGENT.width,
      height: previous?.height ?? AGENT.height,
      text: previous?.kind === "agent" ? previous.text : "",
      label: box.label.trim(),
      model,
      instructions: box.brief?.trim() ?? "",
      count: box.upTo
        ? { kind: "upTo", max: box.count ?? 8 }
        : { kind: "exact", n: box.count ?? 1 },
      machine: "local",
      isolation: box.worktree ? "worktree" : "shared",
    });
  }
  const keptNotes =
    input.notes === undefined
      ? (input.existing?.nodes.filter((node) => node.kind === "note") ?? [])
      : [];
  const notes: WorkflowNode[] = (input.notes ?? []).map((text, index) => {
    const id = WorkflowNodeId.make(`note-${index + 1}`);
    fresh.add(id);
    return { kind: "note", id, x: 0, y: 0, ...NOTE, text: text.trim(), attachedTo: null };
  });
  const edges: WorkflowEdge[] = input.boxes.flatMap((box) => [
    ...(box.parent
      ? [
          {
            id: WorkflowEdgeId.make(`e-${box.parent}-${box.id}`),
            from: WorkflowNodeId.make(box.parent),
            to: WorkflowNodeId.make(box.id),
            kind: "delegates" as const,
          },
        ]
      : []),
    ...(box.after
      ? [
          {
            id: WorkflowEdgeId.make(`t-${box.after}-${box.id}`),
            from: WorkflowNodeId.make(box.after),
            to: WorkflowNodeId.make(box.id),
            kind: "then" as const,
          },
        ]
      : []),
  ]);
  const roots = input.boxes.filter((box) => box.parent === undefined);
  const workflow: WorkflowDefinition = {
    version: 1,
    id: input.id,
    name: input.name,
    description: input.existing?.description ?? "",
    rootNodeId: roots.length === 1 ? WorkflowNodeId.make(roots[0]!.id) : null,
    nodes: [...agents, ...keptNotes, ...notes],
    edges,
    // The user's text and marker drawings stay; agents never edit them.
    ...(input.existing?.marks ? { marks: input.existing.marks } : {}),
    createdAt: input.existing?.createdAt ?? input.now,
    updatedAt: input.now,
  };
  return fresh.size > 0 ? layoutWorkflow(workflow, fresh) : workflow;
}

const describeBoxes = (workflow: WorkflowDefinition) =>
  workflow.nodes
    .flatMap((node) =>
      node.kind === "agent"
        ? [
            `${node.label || node.text.split("\n")[0] || node.id}: ${node.model?.model ?? "no model"}${
              node.count.kind === "upTo"
                ? ` up to ${node.count.max}`
                : node.count.n > 1
                  ? ` x${node.count.n}`
                  : ""
            }`,
          ]
        : [],
    )
    .join("; ")
    .slice(0, 400);

const handle = Effect.fnUntraced(function* (input: typeof WorkflowToolInput.Type) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined || !scope.capabilities.has("orchestration"))
    return yield* fail("Workflows need an agent thread.", "capability_denied");
  if (!workflowsBetaEnabled())
    return yield* fail("Workflows are off. Ask the user to turn on Settings > Beta > Workflows.");
  const access = workflowsAgentAccess();
  if (!access) return yield* fail("Workflows are unavailable on this server.");
  const service = access.service;
  const state = Option.getOrNull(
    yield* Stream.runHead(service.subscribe()).pipe(
      Effect.mapError((error) => fail(error.message)),
    ),
  );
  const workflows = state?.workflows ?? [];
  const find = (id: string | undefined) =>
    id === undefined
      ? undefined
      : (workflows.find((w) => w.id === id) ??
        workflows.find((w) => w.name.toLowerCase() === id.toLowerCase()));
  const toFailure = Effect.mapError((error: { readonly message: string }) => fail(error.message));

  if (input.action === "status") {
    const run = state?.runs.find((run) => run.id === input.id);
    if (!run) return yield* fail("Run not found.");
    return { runId: run.id, status: run.status, diagnostics: run.diagnostics ?? [] };
  }

  if (input.action === "list")
    return {
      workflows: workflows
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 30)
        .map((w) => ({ id: w.id, name: w.name, boxes: describeBoxes(w) })),
    };

  if (input.action === "start") {
    const workflow = find(input.id);
    if (!workflow) return yield* fail("Pass the id of a workflow from list.");
    if (!input.task?.trim()) return yield* fail("Pass the task for this run.");
    const delegate = workflowsDelegate();
    if (!delegate) return yield* fail("Subagents are unavailable on this server.");
    if (!input.clientRequestId?.trim())
      return yield* fail("Pass clientRequestId; reuse it to retry.");
    const prepared = delegate(scope, `workflow:${input.clientRequestId.trim()}`);
    const started = yield* service
      .startChild(
        {
          workflowId: workflow.id,
          task: input.task.trim(),
          key: prepared.key,
          leadThreadId: prepared.threadId,
          ...(scope.thread ? { parentThreadId: scope.thread.threadId } : {}),
        },
        prepared.spawn,
      )
      .pipe(
        Effect.mapError((error) => (error._tag === "WorkflowsError" ? fail(error.message) : error)),
      );
    return { runId: started.runId, taskId: started.taskId, leadThreadId: started.childThreadId };
  }

  if (!input.boxes?.length) return yield* fail("Pass boxes to save.");
  const existing = find(input.id);
  if (input.id !== undefined && !existing) return yield* fail(`No workflow ${input.id}.`);
  const name = input.name?.trim() || existing?.name;
  if (!name) return yield* fail("Pass a name.");
  const providers = yield* access.providers;
  const built = workflowFromBoxes({
    id:
      existing?.id ??
      WorkflowId.make(`wf_${(yield* randomUuidV4).replaceAll("-", "").slice(0, 12)}`),
    name,
    boxes: input.boxes,
    notes: input.notes,
    existing,
    providers,
    now: DateTime.formatIso(yield* DateTime.now),
  });
  if (typeof built === "string") return yield* fail(built);
  yield* service.mutate({ type: "save", workflow: built }).pipe(toFailure);
  yield* service.agentSaved(built.id, existing?.name);
  return { id: built.id, issues: validateWorkflow(built).map((issue) => issue.message) };
});

export const layer = McpToolAccess.toLayer(WorkflowToolkit, {
  workflow: McpToolAccess.either(
    (input) => input.action === "list" || input.action === "status",
    McpToolAccess.readsAsCaller(handle),
    McpToolAccess.actsAsCaller(handle),
  ),
});
