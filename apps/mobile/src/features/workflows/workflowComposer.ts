import {
  type OrchestrationMessageContext,
  type WorkflowContextRecord,
  type WorkflowDefinition,
} from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  replaceComposerContextReferences,
  sanitizeComposerContextLabel,
  toKindScopedComposerContextId,
} from "@t3tools/shared/composerContextReferences";

export function workflowComposerRecord(
  workflow: Pick<WorkflowDefinition, "id" | "name">,
): WorkflowContextRecord {
  return {
    version: 1,
    kind: "workflow",
    contextId: toKindScopedComposerContextId("workflow", workflow.id),
    label: sanitizeComposerContextLabel(workflow.name, "workflow"),
    workflowId: workflow.id,
  };
}

/** Removing the chip removes the intent, even before draft-context cleanup runs. */
export function selectedComposerWorkflow(text: string, context?: OrchestrationMessageContext) {
  const references = new Set(
    collectComposerContextReferences(text).map((reference) => reference.contextId),
  );
  return (
    context?.records.find(
      (record): record is WorkflowContextRecord =>
        record.kind === "workflow" && references.has(record.contextId),
    ) ?? null
  );
}

export function workflowComposerTask(text: string, record: WorkflowContextRecord) {
  return replaceComposerContextReferences(text, (reference) =>
    reference.contextId === record.contextId ? "" : reference.source,
  ).trim();
}
