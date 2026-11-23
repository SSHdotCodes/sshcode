import {
  WorkflowsError,
  WorkflowCompileResult,
  type WorkflowCompileRequest,
  type ServerProvider,
  type ModelSelection,
  type WorkflowIssue,
} from "@t3tools/contracts";
import {
  createModelSelection,
  isReasoningOptionId,
  isReasoningSelectDescriptor,
} from "@t3tools/shared/model";
import { layoutWorkflow, resolveWorkflowArrows, validateWorkflow } from "@t3tools/shared/workflows";
import { modelFamilySupersessions, modelRankingSelectionKey } from "@t3tools/shared/modelRankings";
import { readyProviderModelSelection } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** GPT-6.1 Terra when a provider offers it, else a ready provider's own default. */
export function workflowCompileModel(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | undefined {
  const superseded = modelFamilySupersessions(providers);
  for (const provider of providers) {
    if (!provider.enabled || provider.availability === "unavailable") continue;
    const model = provider.models.find(
      (m) =>
        !m.isLegacy &&
        !superseded.has(
          modelRankingSelectionKey({ instanceId: provider.instanceId, model: m.slug }),
        ) &&
        /gpt[- ]6[.]1[- ]terra/i.test(`${m.slug} ${m.name}`),
    );
    if (model) return { instanceId: provider.instanceId, model: model.slug };
  }
  return readyProviderModelSelection(providers, { textGeneration: true }) ?? undefined;
}

export function workflowCompilePrompt(
  input: WorkflowCompileRequest,
  providers: ReadonlyArray<ServerProvider>,
) {
  const workflow = resolveWorkflowArrows(input.workflow, input.unboundArrows ?? []);
  const boxes = workflow.nodes.map((node) =>
    node.kind === "agent"
      ? {
          id: node.id,
          text: node.text,
          label: node.label,
          model: node.model,
          instructions: node.instructions,
          count: node.count,
          machine: node.machine,
          isolation: node.isolation,
        }
      : { id: node.id, kind: "note", text: node.text, attachedTo: node.attachedTo },
  );
  return `Resolve this agent drawing. Return JSON only, as {workflow,issues,summary}.
workflow: version:1, id, name, description, rootNodeId, nodes, edges, createdAt, updatedAt. Preserve ids. Agent nodes: kind:"agent",id,text,label,model:{instanceId,model,options?:[{id,value}]},instructions,count:{kind:"exact",n} or {kind:"upTo",max},machine:"local",isolation:"shared"|"worktree",x:0,y:0,width:300,height:180. Notes: kind:"note",id,text,attachedTo,x:0,y:0,width:300,height:180. Edges: id,from,to,kind:"delegates"|"then". Issues: {nodeId:null|id,edgeId:null|id,message}. Summary: one line.
Use exactly one root, count 1. Tree, at most 64 nodes, counts 1..16. "Many" means upTo 8. Then edges connect siblings, without cycles. Pick only catalog models. Short briefs. Notes attach when indicated. Add boxes only when requested. canvasText is the user's loose writing on the canvas: hints only, never boxes.
When drawing or prompt names effort (max, xhigh, high, low, fast, etc.), set options using that model's catalog effort id and level. Unsupported effort: omit it and issue on that node. Otherwise preserve existing options; leave options out when unspecified.
${JSON.stringify({ workflow: { id: workflow.id, name: workflow.name, description: workflow.description, createdAt: workflow.createdAt, updatedAt: workflow.updatedAt }, boxes, arrows: workflow.edges, canvasText: (workflow.marks ?? []).flatMap((mark) => (mark.kind === "text" && mark.text.trim() ? [mark.text.trim()] : [])), prompt: input.prompt ?? "", models: providers.filter((p) => p.enabled && p.availability !== "unavailable").flatMap((p) => p.models.map((m) => ({ instanceId: p.instanceId, model: m.slug, name: m.name, effort: (m.capabilities?.optionDescriptors ?? []).filter(isReasoningSelectDescriptor).map((d) => ({ id: d.id, levels: d.options.map((o) => o.id) })) }))) })}`;
}

const decodeCompileResult = Schema.decodeUnknownEffect(
  Schema.fromJsonString(WorkflowCompileResult),
);

export const parseWorkflowCompile = (
  text: string,
  input: WorkflowCompileRequest,
  providers: ReadonlyArray<ServerProvider>,
) =>
  decodeCompileResult(
    text
      .trim()
      .replace(/^```(?:json)?\s*\n?/u, "")
      .replace(/\n?```$/u, ""),
  ).pipe(
    Effect.flatMap((result) => {
      const invalid = result.workflow.nodes.some(
        (n) =>
          n.kind === "agent" &&
          n.model !== null &&
          !providers.some(
            (p) =>
              p.instanceId === n.model!.instanceId &&
              p.models.some((m) => m.slug === n.model!.model),
          ),
      );
      if (invalid)
        return Effect.fail(
          new WorkflowsError({ reason: "compile", message: "Choose catalog models only." }),
        );
      const optionIssues: WorkflowIssue[] = [];
      const nodes = result.workflow.nodes.map((node) => {
        if (node.kind !== "agent" || !node.model?.options) return node;
        const selection = node.model;
        const model = providers
          .find((p) => p.instanceId === selection.instanceId)!
          .models.find((m) => m.slug === selection.model)!;
        const descriptors = model.capabilities?.optionDescriptors ?? [];
        const options = selection.options?.filter((option) => {
          const descriptor = descriptors.find((d) => d.id === option.id);
          if (
            descriptor?.type === "boolean"
              ? typeof option.value === "boolean"
              : descriptor?.type === "select" &&
                descriptor.options.some((o) => o.id === option.value)
          )
            return true;
          const values =
            descriptor?.type === "select"
              ? descriptor.options.map((o) => o.id)
              : descriptor?.type === "boolean"
                ? ["true", "false"]
                : [];
          const effort =
            isReasoningOptionId(option.id) ||
            (descriptor !== undefined && isReasoningSelectDescriptor(descriptor));
          const levels = effort
            ? descriptors
                .filter(isReasoningSelectDescriptor)
                .flatMap((d) => d.options.map((o) => o.id))
            : values;
          optionIssues.push({
            nodeId: node.id,
            edgeId: null,
            message:
              `Dropped unsupported ${effort ? "effort" : option.id} "${option.value}" for ${model.name}. Available ${effort ? "effort levels" : "values"}: ${levels.join(", ") || "none"}.`.slice(
                0,
                300,
              ),
          });
          return false;
        });
        return {
          ...node,
          model: createModelSelection(selection.instanceId, selection.model, options),
        };
      });
      const originals = new Map(input.workflow.nodes.map((n) => [n.id, n]));
      const workflow = layoutWorkflow(
        {
          ...result.workflow,
          id: input.workflow.id,
          createdAt: input.workflow.createdAt,
          // Text and marker drawings are the user's; the model never returns them.
          ...(input.workflow.marks ? { marks: input.workflow.marks } : {}),
          nodes: nodes.map((node) => {
            const old = originals.get(node.id);
            return old
              ? { ...node, x: old.x, y: old.y, width: old.width, height: old.height }
              : node;
          }),
        },
        new Set(result.workflow.nodes.filter((n) => !originals.has(n.id)).map((n) => n.id)),
      );
      return Effect.succeed({
        ...result,
        workflow,
        issues: [...result.issues, ...optionIssues, ...validateWorkflow(workflow)],
      });
    }),
  );
