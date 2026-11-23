import type { OrchestrationV2ProjectedTurnItem, OrchestrationV2Run } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import type { QueuedThreadMessage } from "./thread-outbox-model";

// A command acknowledgment can precede its message in the subscribed timeline.
// Keep the visible row until that projection arrives, independently of outbox cleanup.
export const acknowledgedThreadMessagesAtom = Atom.make<ReadonlyArray<QueuedThreadMessage>>(
  [],
).pipe(Atom.keepAlive);

// Key by the exact queued payload. The composer also uses its identity to distinguish
// a receipt from an edit that reused the message id while cleanup was pending.
const receiptSequences = new WeakMap<QueuedThreadMessage, number>();
export const acknowledgedThreadMessageSequence = (message: QueuedThreadMessage) =>
  receiptSequences.get(message);

// Bound receipts for chats that are never reopened to observe their echoes.
export const MAX_ACKNOWLEDGED_THREAD_MESSAGES = 128;

export function retainAcknowledgedThreadMessage(
  message: QueuedThreadMessage,
  receiptSequence?: number,
) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  if (
    current.some(
      (entry) =>
        entry.messageId === message.messageId && entry.environmentId === message.environmentId,
    )
  )
    return;
  if (receiptSequence !== undefined && Number.isSafeInteger(receiptSequence) && receiptSequence > 0)
    receiptSequences.set(message, receiptSequence);
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, [...current, message]);
  if (current.length >= MAX_ACKNOWLEDGED_THREAD_MESSAGES) {
    forgetAcknowledgedThreadMessage(current[0]!);
  }
}

/** Retire rows before offering their pending uploads to the draft/outbox ownership sweep. */
export function retireAcknowledgedThreadMessages(
  matches: (message: QueuedThreadMessage) => boolean,
) {
  const current = appAtomRegistry.get(acknowledgedThreadMessagesAtom);
  const retired = current.filter(matches);
  if (!retired.length) return;
  const kept = current.filter((entry) => !matches(entry));
  appAtomRegistry.set(acknowledgedThreadMessagesAtom, kept);
  for (const message of retired) receiptSequences.delete(message);
  // When several rows share an upload, only its last owner schedules a sweep.
  const uploads = retired.flatMap((message) =>
    message.attachments.filter(
      (attachment) =>
        attachment.uploadedAttachmentId !== undefined &&
        !kept.some((other) =>
          other.attachments.some(
            (ref) =>
              ref.uploadedAttachmentId === attachment.uploadedAttachmentId &&
              ref.uploadEnvironmentId === attachment.uploadEnvironmentId,
          ),
        ),
    ),
  );
  if (uploads.length) {
    // The draft store reads this atom during its reference checks. Load its sweeper
    // only when a retired row actually owns uploads.
    void import("./use-composer-drafts")
      .then(({ releaseUnusedComposerAttachmentFiles }) =>
        releaseUnusedComposerAttachmentFiles(uploads, { uploadsOnly: true }),
      )
      .catch((error) =>
        console.warn("[thread-outbox] could not release acknowledged uploads", error),
      );
  }
}

export function forgetAcknowledgedThreadMessage(message: QueuedThreadMessage) {
  retireAcknowledgedThreadMessages(
    (entry) =>
      entry.messageId === message.messageId && entry.environmentId === message.environmentId,
  );
}

/**
 * Message ids the server already holds, so their optimistic rows can go.
 * Messages can echo before their turn items: keep a row until the visible
 * sequence the feed renders takes over. Queued inputs have no turn item yet and
 * belong to composer state once the server owns them. A run older than the
 * loaded window holds its message in history the phone has not paged in; the
 * row must go too, or it sits below newer replies (the phone loads one turn).
 * A reopened chat's snapshot lists only the runs it shows, so an older run is
 * often absent. Its applied event sequence tells us whether that window covers the receipt.
 */
export function echoedAcknowledgedMessageIds(
  visibleTurnItems: ReadonlyArray<Pick<OrchestrationV2ProjectedTurnItem, "item">>,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status" | "userMessageId">>,
  messages: ReadonlyArray<{ readonly id: string }>,
  acknowledged: ReadonlyArray<{
    readonly messageId: string;
    readonly receiptSequence?: number | undefined;
  }> = [],
  boundedWindowSequence?: number | null,
): Set<string> {
  const echoed = new Set<string>(
    visibleTurnItems.flatMap(({ item }) =>
      item.type === "user_message" ? [String(item.messageId)] : [],
    ),
  );
  const messageIds = new Set(messages.map((message) => message.id));
  for (const run of runs) {
    if (
      (run.status === "queued" && messageIds.has(run.userMessageId)) ||
      run.status === "cancelled" ||
      run.status === "rolled_back"
    ) {
      echoed.add(String(run.userMessageId));
    }
  }
  if (boundedWindowSequence != null) {
    const visibleRunIds = new Set(visibleTurnItems.map(({ item }) => item.runId));
    const firstVisibleOrdinal = runs.reduce(
      (first, run) => (visibleRunIds.has(run.id) ? Math.min(first, run.ordinal) : first),
      Infinity,
    );
    const outsideWindow = new Set(
      runs
        .filter((run) => Number.isFinite(firstVisibleOrdinal) && run.ordinal < firstVisibleOrdinal)
        .map((run) => String(run.userMessageId)),
    );
    for (const { messageId, receiptSequence } of acknowledged) {
      if (
        receiptSequence !== undefined &&
        receiptSequence > 0 &&
        boundedWindowSequence >= receiptSequence &&
        (!messageIds.has(messageId) || outsideWindow.has(messageId))
      )
        echoed.add(messageId);
    }
  }
  return echoed;
}
