import type { ComposerDraft } from "../../state/use-composer-drafts";

/**
 * Flush pending native editor input (trailing autocorrect/typing) before reading
 * the draft snapshot for send or schedule. Returns false when a flush is already
 * in flight so rapid double-taps cannot dispatch twice.
 */
export async function flushComposerEditorInput(
  editor: { readonly flushPendingInput: () => Promise<void> } | null | undefined,
  inFlightRef: { current: boolean },
): Promise<boolean> {
  if (inFlightRef.current) return false;
  inFlightRef.current = true;
  try {
    await editor?.flushPendingInput();
    return true;
  } finally {
    inFlightRef.current = false;
  }
}

type ScheduledComposerDraft = Pick<ComposerDraft, "text" | "attachments" | "context">;

type PendingComposerWork = {
  readonly pastedTextAttachments: number;
  readonly importingContext: boolean;
};

/** Scheduling shares Send's wait for work that has not reached the draft yet. */
export function scheduledComposerMessageReason(
  draft: ScheduledComposerDraft,
  pending: PendingComposerWork,
): string | null {
  if (pending.pastedTextAttachments > 0)
    return "Wait for pasted text to finish attaching before scheduling.";
  if (pending.importingContext) return "Wait for context to finish importing before scheduling.";
  if (!draft.text.trim()) return "Write a message first.";
  if (draft.attachments.length > 0 || draft.context?.records.length) {
    return "Scheduled messages support text only. Remove attachments and context first.";
  }
  return null;
}

/** Recheck after target creation, before a durable text-only schedule can commit. */
export async function persistScheduledComposerMessage<Result>(options: {
  readonly draft: ScheduledComposerDraft;
  readonly readDraft: () => ScheduledComposerDraft;
  readonly readPendingWork: () => PendingComposerWork;
  readonly prepare?: () => Promise<void>;
  readonly persist: () => Promise<Result>;
}): Promise<Result> {
  const requireReady = () => {
    const current = options.readDraft();
    const reason = scheduledComposerMessageReason(current, options.readPendingWork());
    if (reason) throw new Error(reason);
    if (current.text !== options.draft.text)
      throw new Error("Your draft changed. Review it before scheduling.");
  };
  requireReady();
  if (options.prepare) await options.prepare();
  requireReady();
  return options.persist();
}
