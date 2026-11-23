import type {
  ChatAttachment,
  MessageId,
  OrchestrationMessageContext,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { createMemoryStorage } from "../../lib/storage";
import type { DraftId } from "../../composerDraftStore";

export interface RecoveredQueuedEdit {
  readonly draftId: DraftId;
  readonly threadKey: string;
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly originalText: string;
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
}

/** Metadata accompanies the separately persisted draft while its queue entry exists or is recovered. */
export const useRecoveredQueuedEdits = create<{
  readonly entries: Readonly<Record<string, RecoveredQueuedEdit>>;
  readonly put: (entry: RecoveredQueuedEdit) => void;
  readonly remove: (draftId: DraftId) => void;
}>()(
  persist(
    (set) => ({
      entries: {},
      put: (entry) => set((state) => ({ entries: { ...state.entries, [entry.draftId]: entry } })),
      remove: (draftId) =>
        set((state) => {
          const entries = { ...state.entries };
          delete entries[draftId];
          return { entries };
        }),
    }),
    {
      name: "t3code:recovered-queued-edits:v1",
      storage: createJSONStorage(() =>
        typeof localStorage === "undefined" ? createMemoryStorage() : localStorage,
      ),
      partialize: (state) => ({ entries: state.entries }) as typeof state,
    },
  ),
);
