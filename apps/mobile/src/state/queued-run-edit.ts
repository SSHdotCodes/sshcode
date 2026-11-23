/**
 * Editing a message that is already queued on the server.
 *
 * The composer is reused rather than duplicated, so the edit needs somewhere
 * to put its text that is not the user's own draft for the thread. It gets a
 * derived draft key: the thread's key plus a marker and the run id. That key
 * still ends in the thread id segment, so everything keyed off the draft key
 * (attachment uploads resolving an environment, per-draft persistence) keeps
 * working, while the user's draft is never touched and is waiting unchanged
 * when the edit is cancelled.
 *
 * The record below is in-memory only: an edit that does not survive a restart
 * is better than a composer that reopens pointed at a run the server may have
 * already started.
 */
import type {
  ChatAttachment,
  MessageId,
  OrchestrationMessageContext,
  RunId,
  UploadChatAttachment,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useAtomValue } from "@effect/atom-react";

import { uploadedComposerContext } from "../lib/composerContext";
import { appAtomRegistry } from "./atom-registry";
import { setThreadComposerError } from "./thread-composer-error";
import { queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  clearComposerDraft,
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  setComposerDraftContext,
  setComposerDraftText,
} from "./use-composer-drafts";

export interface QueuedRunEdit {
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  /** Server attachments still attached; removing one drops it from this list. */
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
  readonly removedExistingAttachment?: true;
}

export const queuedRunEditsAtom = Atom.make<Readonly<Record<string, QueuedRunEdit>>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-queued-run-edits"),
);

export { isQueuedEditDraftKey, queuedEditDraftKey } from "./queued-edit-draft-key";

export function getQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  if (threadKey === null) return null;
  return appAtomRegistry.get(queuedRunEditsAtom)[threadKey] ?? null;
}

export function useQueuedRunEdit(threadKey: string | null): QueuedRunEdit | null {
  const edits = useAtomValue(queuedRunEditsAtom);
  return threadKey === null ? null : (edits[threadKey] ?? null);
}

function setQueuedRunEdit(threadKey: string, edit: QueuedRunEdit | null): void {
  const current = appAtomRegistry.get(queuedRunEditsAtom);
  if (edit === null) {
    if (!current[threadKey]) return;
    const next = { ...current };
    delete next[threadKey];
    appAtomRegistry.set(queuedRunEditsAtom, next);
    return;
  }
  appAtomRegistry.set(queuedRunEditsAtom, { ...current, [threadKey]: edit });
}

const savingQueuedRunEditsAtom = Atom.make<Readonly<Record<string, true>>>({}).pipe(Atom.keepAlive);
export function useQueuedRunEditSaving(threadKey: string | null): boolean {
  const saving = useAtomValue(savingQueuedRunEditsAtom);
  return threadKey !== null && saving[threadKey] === true;
}
function publishSavingQueuedRunEdits(): void {
  appAtomRegistry.set(
    savingQueuedRunEditsAtom,
    Object.fromEntries([...editSaves.keys()].map((key) => [key, true as const])),
  );
}

type QueuedRunsAtom = Atom.Atom<ReadonlyArray<{
  readonly id: RunId;
  readonly status: string;
}> | null>;
interface EditWatch {
  readonly runs: QueuedRunsAtom;
  readonly runId: RunId;
  unsubscribe: () => void;
}
const editWatches = new Map<string, EditWatch>();
// A save owns its edit across navigation. A later session cannot release that claim.
const editSaves = new Map<string, symbol>();

function checkQueuedRunEdit(threadKey: string, watch: EditWatch): void {
  if (editWatches.get(threadKey) !== watch || editSaves.has(threadKey)) return;
  const runs = appAtomRegistry.get(watch.runs);
  if (runs === null || runs.some((run) => run.id === watch.runId && run.status === "queued"))
    return;
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null || edit.runId !== watch.runId) return;
  const draft = getComposerDraftSnapshot(queuedEditDraftKey(threadKey, edit.runId));
  const original = getComposerDraftSnapshot(threadKey);
  const changed =
    draft.text !== edit.originalText ||
    draft.attachments.length > 0 ||
    edit.removedExistingAttachment === true ||
    JSON.stringify(draft.context ?? null) !== JSON.stringify(edit.context ?? null);
  const keep =
    changed &&
    (draft.text.trim().length > 0 || draft.attachments.length > 0) &&
    original.text.trim().length === 0 &&
    original.attachments.length === 0;
  if (keep) {
    void mergeComposerDraftContent(threadKey, {
      text: draft.text,
      attachments: draft.attachments,
      ...(draft.context ? { context: draft.context } : {}),
    }).catch((error: unknown) => {
      console.warn("[queued-run-edit] could not persist the recovered edit", error);
    });
  }
  endQueuedRunEdit(threadKey, { deferAttachmentCleanup: keep });
  if (changed)
    setThreadComposerError(
      threadKey,
      keep
        ? "That message already started. Your edit is back in the composer."
        : "That message already started, so the edit was discarded.",
    );
}

/** Pause remote-start recovery while a save's result determines the edit's fate. */
export function claimQueuedRunEditSave(threadKey: string): (() => void) | null {
  if (getQueuedRunEdit(threadKey) === null || editSaves.has(threadKey)) return null;
  const claim = Symbol();
  editSaves.set(threadKey, claim);
  publishSavingQueuedRunEdits();
  return () => {
    if (editSaves.get(threadKey) !== claim) return;
    editSaves.delete(threadKey);
    publishSavingQueuedRunEdits();
    const watch = editWatches.get(threadKey);
    if (watch) checkQueuedRunEdit(threadKey, watch);
  };
}

/** Loads the queued message into its own draft and puts the composer in edit mode. */
export function beginQueuedRunEdit(
  threadKey: string,
  edit: QueuedRunEdit,
  runs: QueuedRunsAtom,
): void {
  if (editSaves.has(threadKey)) return;
  editWatches.get(threadKey)?.unsubscribe();
  const previous = getQueuedRunEdit(threadKey);
  if (previous !== null && previous.runId !== edit.runId) {
    clearComposerDraft(queuedEditDraftKey(threadKey, previous.runId));
  }
  const draftKey = queuedEditDraftKey(threadKey, edit.runId);
  clearComposerDraft(draftKey);
  setComposerDraftText(draftKey, edit.originalText);
  setComposerDraftContext(draftKey, edit.context);
  setQueuedRunEdit(threadKey, edit);
  const watch: EditWatch = { runs, runId: edit.runId, unsubscribe: () => {} };
  editWatches.set(threadKey, watch);
  watch.unsubscribe = appAtomRegistry.subscribe(runs, () => checkQueuedRunEdit(threadKey, watch));
  checkQueuedRunEdit(threadKey, watch);
}

export function removeQueuedRunEditAttachment(threadKey: string, attachmentId: string): void {
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  setQueuedRunEdit(threadKey, {
    ...edit,
    removedExistingAttachment: true,
    existingAttachments: edit.existingAttachments.filter(
      (attachment) => attachment.id !== attachmentId,
    ),
  });
}

export function endQueuedRunEdit(
  threadKey: string,
  options?: { readonly deferAttachmentCleanup?: boolean },
): void {
  editWatches.get(threadKey)?.unsubscribe();
  editWatches.delete(threadKey);
  const edit = getQueuedRunEdit(threadKey);
  if (edit === null) return;
  clearComposerDraft(queuedEditDraftKey(threadKey, edit.runId), options);
  setQueuedRunEdit(threadKey, null);
}

/**
 * The replacement payload for `queued-run.edit`. Attachments replace the
 * message's list wholesale, so kept server attachments are resent alongside
 * the newly uploaded ones, in composer order. Context records are rebound to
 * the uploaded ids and then pruned to what the final list still contains, so
 * removing an attachment cannot leave a record pointing at nothing.
 */
export function resolveQueuedEditPayload(input: {
  readonly edit: QueuedRunEdit;
  readonly draftContext: OrchestrationMessageContext | undefined;
  readonly draftAttachments: ReadonlyArray<{ readonly id: string }>;
  readonly uploaded: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
}): {
  readonly attachments: ReadonlyArray<ChatAttachment | UploadChatAttachment>;
  readonly context: OrchestrationMessageContext | undefined;
} {
  const attachments = [...input.edit.existingAttachments, ...input.uploaded];
  const rebound = uploadedComposerContext(
    input.draftContext,
    input.draftAttachments,
    input.uploaded,
  );
  if (rebound === undefined) return { attachments, context: undefined };
  const liveIds = new Set(
    attachments.flatMap((attachment) =>
      "id" in attachment && attachment.id ? [attachment.id] : [],
    ),
  );
  const records = rebound.records.filter(
    (record) => !("attachmentId" in record) || liveIds.has(record.attachmentId),
  );
  return {
    attachments,
    context: records.length > 0 ? { version: 1, records } : undefined,
  };
}
