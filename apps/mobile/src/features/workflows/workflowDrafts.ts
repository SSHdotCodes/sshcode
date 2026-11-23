import { WorkflowDefinition } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { writeFileAtomically } from "../../lib/atomic-file";

const WORKFLOW_DRAFTS_DIRECTORY = "workflow-drafts";

const StoredWorkflowDraftSchema = Schema.Struct({
  base: WorkflowDefinition,
  draft: WorkflowDefinition,
});
export type StoredWorkflowDraft = typeof StoredWorkflowDraftSchema.Type;

const decodeStoredWorkflowDraft = Schema.decodeUnknownSync(StoredWorkflowDraftSchema);

export type WorkflowDraftRestore =
  | { readonly kind: "none" }
  | {
      readonly kind: "restore";
      readonly draft: WorkflowDefinition;
      readonly saved: WorkflowDefinition;
    };

/**
 * A draft that no longer differs from the server copy is dropped. When the
 * server moved on since the draft's base, the base stays the saved version so
 * the editor shows its changed-elsewhere banner instead of autosaving over the
 * newer copy.
 */
export function decideWorkflowDraftRestore(
  remote: WorkflowDefinition,
  stored: StoredWorkflowDraft,
): WorkflowDraftRestore {
  if (JSON.stringify(stored.draft) === JSON.stringify(remote)) return { kind: "none" };
  if (stored.base.updatedAt === remote.updatedAt)
    return { kind: "restore", draft: stored.draft, saved: remote };
  return { kind: "restore", draft: stored.draft, saved: stored.base };
}

async function draftFile(environmentId: string, workflowId: string) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const directory = new Directory(Paths.document, WORKFLOW_DRAFTS_DIRECTORY);
  directory.create({ idempotent: true, intermediates: true });
  return new File(
    directory,
    `${encodeURIComponent(environmentId)}--${encodeURIComponent(workflowId)}.json`,
  );
}

/** Best effort: a missing or corrupt draft falls back to the server copy. */
export async function loadWorkflowDraft(
  environmentId: string,
  workflowId: string,
): Promise<StoredWorkflowDraft | null> {
  try {
    const file = await draftFile(environmentId, workflowId);
    if (!file.exists) return null;
    return decodeStoredWorkflowDraft(JSON.parse(await file.text()));
  } catch {
    return null;
  }
}

export async function saveWorkflowDraft(
  environmentId: string,
  workflowId: string,
  stored: StoredWorkflowDraft,
): Promise<void> {
  await writeFileAtomically(await draftFile(environmentId, workflowId), JSON.stringify(stored));
}

export async function removeWorkflowDraft(
  environmentId: string,
  workflowId: string,
): Promise<void> {
  const file = await draftFile(environmentId, workflowId);
  if (file.exists) file.delete();
}
