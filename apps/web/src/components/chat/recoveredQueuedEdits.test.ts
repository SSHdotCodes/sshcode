import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { DraftId } from "../../composerDraftStore";
import { useRecoveredQueuedEdits } from "./recoveredQueuedEdits";

describe("recovered queued edit metadata", () => {
  it("survives reload with original attachments and context", async () => {
    const id = DraftId.make("queued-edit:persist");
    const entry = {
      draftId: id,
      threadKey: "env:thread",
      threadId: ThreadId.make("thread"),
      runId: RunId.make("run"),
      messageId: MessageId.make("message"),
      originalText: "original",
      existingAttachments: [
        {
          type: "file" as const,
          id: "saved" as never,
          name: "file.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
        },
      ],
      context: {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            kind: "thread" as const,
            contextId: "thread_other" as never,
            label: "other",
            environmentId: EnvironmentId.make("env"),
            threadId: ThreadId.make("other"),
            title: "other",
          },
        ],
      },
    };
    const store = useRecoveredQueuedEdits;
    store.getState().put(entry);
    const { storage, name } = store.persist.getOptions();
    const snapshot = await storage!.getItem(name!);
    store.setState({ entries: {} });
    await storage!.setItem(name!, snapshot!);
    await store.persist.rehydrate();
    expect(store.getState().entries[id]).toEqual(entry);
    store.getState().remove(id);
  });
});
