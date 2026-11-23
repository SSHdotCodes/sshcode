import { ComposerContextId, type OrchestrationMessageContext } from "@t3tools/contracts";
import {
  collectComposerContextReferences,
  formatComposerContextReference,
} from "./composerContextReferences.ts";

export const DEBUG_COMMAND = {
  name: "debug",
  description: "Find runtime bugs with evidence",
} as const;

/** Keep the visible message compact; only the provider projection expands the workflow. */
export function expandDebugCommand(text: string, context?: OrchestrationMessageContext) {
  const match = /^\s*\/debug(?:\s+([\s\S]*))?$/u.exec(text);
  if (match === null) return { text, context };
  const description = (match[1] ?? "").trim();
  const existing = context?.records.find(
    (record) => record.kind === "debug" && !("payload" in record),
  );
  const usedIds = new Set(context?.records.map((record) => record.contextId));
  let id = "debug_workflow";
  for (let suffix = 1; usedIds.has(ComposerContextId.make(id)); suffix++)
    id = `debug_workflow_${suffix}`;
  const record = existing ?? {
    version: 1 as const,
    kind: "debug" as const,
    contextId: ComposerContextId.make(id),
    label: "Debug",
  };
  const referenced = collectComposerContextReferences(description).some(
    (reference) => reference.contextId === record.contextId,
  );
  return {
    text: referenced
      ? description
      : `${formatComposerContextReference(record)} ${description}`.trimEnd(),
    context: {
      version: 1 as const,
      records: existing ? context!.records : [...(context?.records ?? []), record],
    },
  };
}
