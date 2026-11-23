import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import * as Crypto from "expo-crypto";

import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { environmentProjects } from "./projects";
import { environmentThreadShells } from "./threads";
import { restoredNewTaskDraftKey } from "./new-task-draft-key";
import { confirmThreadOutboxMessageQueued, threadOutboxRevision } from "./thread-outbox";
import type { QueuedThreadMessage } from "./thread-outbox-model";
import { removeThreadOutboxMessage } from "./thread-outbox-removal";
import {
  getComposerDraftSnapshot,
  mergeComposerDraftContent,
  updateComposerDraftSettings,
  waitForComposerDraftsLoaded,
} from "./use-composer-drafts";
import {
  editingQueuedMessageIdsAtom,
  holdEditingQueuedMessage,
  releaseEditingQueuedMessage,
} from "./use-thread-outbox";

export type RecoveryDestination =
  | { readonly kind: "thread"; readonly environmentId: EnvironmentId; readonly threadId: ThreadId }
  | { readonly kind: "new"; readonly environmentId: EnvironmentId; readonly projectId: ProjectId };

/** Copy to a durable draft before releasing the outbox's attachment ownership. */
export async function recoverOutboxMessage(
  message: QueuedThreadMessage,
  destination: RecoveryDestination,
): Promise<string> {
  if (
    message.recoveryReason !== "missing-thread" ||
    destination.environmentId !== message.environmentId
  ) {
    throw new Error("Choose a chat in the same environment.");
  }
  if (appAtomRegistry.get(editingQueuedMessageIdsAtom)[message.messageId]) {
    throw new Error("This message is already being edited.");
  }
  const destinationExists = () =>
    destination.kind === "thread"
      ? appAtomRegistry
          .get(environmentThreadShells.threadShellsAtom)
          .some(
            (thread) =>
              thread.environmentId === destination.environmentId &&
              thread.id === destination.threadId &&
              thread.archivedAt === null,
          )
      : appAtomRegistry
          .get(environmentProjects.projectsAtom)
          .some(
            (project) =>
              project.environmentId === destination.environmentId &&
              project.id === destination.projectId,
          );
  if (!destinationExists()) throw new Error("That destination is no longer available.");
  holdEditingQueuedMessage(message.messageId);
  try {
    const revision = threadOutboxRevision(message.messageId);
    if (!(await confirmThreadOutboxMessageQueued(message)))
      throw new Error("This message has changed. Try again.");
    await waitForComposerDraftsLoaded();
    const draftKey =
      destination.kind === "thread"
        ? scopedThreadKey(destination.environmentId, destination.threadId)
        : restoredNewTaskDraftKey(message.messageId);
    const draft = getComposerDraftSnapshot(draftKey);
    const ids = new Set(draft.attachments.map((attachment) => attachment.id));
    const extra = message.attachments.filter((attachment) => !ids.has(attachment.id)).length;
    if (ids.size + extra > PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      throw new Error(
        "This draft has too many attachments. Choose another chat or remove some attachments first.",
      );
    }
    if (destination.kind === "new") {
      updateComposerDraftSettings(draftKey, {
        project: {
          environmentId: destination.environmentId,
          projectId: destination.projectId,
          createdAt: message.createdAt,
        },
        ...(message.modelSelection ? { modelSelection: message.modelSelection } : {}),
        ...(message.runtimeMode ? { runtimeMode: message.runtimeMode } : {}),
        ...(message.interactionMode ? { interactionMode: message.interactionMode } : {}),
      });
    }
    // The receipt must change when the queued payload changes, including across restarts.
    const digest = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      JSON.stringify([message.text, message.context, message.attachments]),
    );
    const merged = await mergeComposerDraftContent(draftKey, {
      text: message.text,
      context: message.context,
      attachments: message.attachments,
      sourceShareId: `outbox-recovery:${message.messageId}:${digest}`,
    });
    if (merged.skippedAttachmentCount > 0)
      throw new Error("Some attachments could not fit in that draft. Your message is still saved.");
    if (!(await removeThreadOutboxMessage(message, revision, destinationExists))) {
      throw new Error(
        "The message changed while it was being restored. It is still saved in the outbox.",
      );
    }
    return draftKey;
  } finally {
    releaseEditingQueuedMessage(message.messageId);
  }
}

/** Discard only the exact version the user chose. */
export async function discardRecoveredOutboxMessage(message: QueuedThreadMessage): Promise<void> {
  if (
    message.recoveryReason !== "missing-thread" ||
    appAtomRegistry.get(editingQueuedMessageIdsAtom)[message.messageId]
  ) {
    throw new Error("This message has changed. Try again.");
  }
  holdEditingQueuedMessage(message.messageId);
  try {
    const revision = threadOutboxRevision(message.messageId);
    if (
      !(await confirmThreadOutboxMessageQueued(message)) ||
      !(await removeThreadOutboxMessage(message, revision))
    ) {
      throw new Error("This message has changed. Try again.");
    }
  } finally {
    releaseEditingQueuedMessage(message.messageId);
  }
}
