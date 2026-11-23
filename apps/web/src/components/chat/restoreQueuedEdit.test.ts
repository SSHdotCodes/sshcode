import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, MessageId, RunId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { terminalContextRecord } from "../../lib/composerContextRecords";
import { restoreQueuedEdit } from "./restoreQueuedEdit";
import type { RecoveredQueuedEdit } from "./recoveredQueuedEdits";

const environmentId = EnvironmentId.make("env");
const threadId = ThreadId.make("thread");
const destination = scopeThreadRef(environmentId, threadId);
const draftId = DraftId.make("queued-edit:recovery");
const terminal = {
  id: "terminal-one",
  threadId,
  terminalId: "main",
  terminalLabel: "Terminal",
  lineStart: 1,
  lineEnd: 2,
  text: "original context",
  createdAt: "2026-01-01T00:00:00Z",
};
const entry: RecoveredQueuedEdit = {
  draftId,
  threadKey: scopedThreadKey(destination),
  threadId,
  runId: RunId.make("run"),
  messageId: MessageId.make("message"),
  originalText: "original",
  existingAttachments: [
    {
      type: "image",
      id: "saved-image" as never,
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    },
  ],
  context: { version: 1, records: [terminalContextRecord(terminal)] },
};
const originalFile = new File(["png"], "screen.png", { type: "image/png" });

beforeEach(() => {
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn(() => "blob:restored"),
    revokeObjectURL: vi.fn(),
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("restoring queued edits", () => {
  it("keeps the ordinary draft and the saved edit when it is occupied", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(destination, "separate draft");
    store.setPrompt(draftId, "changed edit");
    expect(() => restoreQueuedEdit({ entry, destination, files: [originalFile] })).toThrow(
      "Clear or stash",
    );
    expect(store.getComposerDraft(destination)?.prompt).toBe("separate draft");
    expect(store.getComposerDraft(draftId)?.prompt).toBe("changed edit");
  });
  it("restores original attachments and context together with added attachments and context", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "changed edit");
    const file = new File(["report"], "report.txt", { type: "text/plain" });
    store.addFiles(draftId, [
      {
        type: "file",
        id: "new-file",
        name: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        file,
      },
    ]);
    store.addTerminalContexts(draftId, [
      { ...terminal, id: "added", terminalId: "other", text: "added context" },
    ]);
    restoreQueuedEdit({ entry, destination, files: [originalFile] });
    const restored = store.getComposerDraft(destination)!;
    expect(restored.prompt).toContain("changed edit");
    expect(restored.images.map((image) => image.name)).toEqual(["screen.png"]);
    expect(restored.files.map((attachment) => attachment.name)).toEqual(["report.txt"]);
    expect(restored.terminalContexts.map((context) => context.text)).toEqual([
      "original context",
      "added context",
    ]);
    expect(store.getComposerDraft(draftId)?.files).toHaveLength(1);
  });
  it("restores a context-only edit with review, preview, and thread context", () => {
    const store = useComposerDraftStore.getState();
    const review = {
      id: "review",
      sectionId: "file:a.ts",
      sectionTitle: "File",
      filePath: "a.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "review text",
      diff: "x",
    };
    const preview = {
      id: "preview",
      pageUrl: "https://example.test",
      pageTitle: "Page",
      comment: "preview text",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const thread = {
      version: 1 as const,
      kind: "thread" as const,
      contextId: "thread_related" as never,
      label: "Related",
      environmentId,
      threadId: ThreadId.make("related"),
      title: "Related",
    };
    store.addReviewComment(draftId, review);
    store.addPreviewAnnotation(draftId, preview);
    store.addThreadContexts(draftId, [thread]);
    restoreQueuedEdit({
      entry: { ...entry, existingAttachments: [], context: undefined },
      destination,
      files: [],
    });
    const draft = store.getComposerDraft(destination)!;
    expect(draft.reviewComments).toEqual([review]);
    expect(draft.previewAnnotations).toEqual([preview]);
    expect(draft.threadContexts).toEqual([thread]);
  });
  it("retains the saved edit when its context cannot be represented by this composer", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(draftId, "keep this");
    const unsupported = {
      ...entry,
      context: {
        version: 1 as const,
        records: [
          {
            version: 1 as const,
            kind: "skill" as const,
            contextId: "skill_example" as never,
            label: "skill",
            name: "example",
          },
        ],
      },
    };
    expect(() =>
      restoreQueuedEdit({ entry: unsupported, destination, files: [originalFile] }),
    ).toThrow("cannot restore");
    expect(store.getComposerDraft(draftId)?.prompt).toBe("keep this");
    expect(store.getComposerDraft(destination)).toBeNull();
  });
  it("preserves an attachment-only edit and retains it when a download fails", () => {
    expect(() => restoreQueuedEdit({ entry, destination, files: [] })).toThrow("every attachment");
    restoreQueuedEdit({ entry, destination, files: [originalFile] });
    expect(useComposerDraftStore.getState().getComposerDraft(destination)?.images).toHaveLength(1);
  });
  it("restores the saved edit after the draft store rehydrates", async () => {
    vi.useFakeTimers();
    try {
      const store = useComposerDraftStore;
      store.getState().setPrompt(draftId, "unsent changes");
      store
        .getState()
        .addTerminalContexts(draftId, [
          { ...terminal, id: "added", terminalId: "other", text: "added context" },
        ]);
      await vi.advanceTimersByTimeAsync(300);
      const { storage, name } = store.persist.getOptions();
      const snapshot = await storage!.getItem(name!);
      store.setState({ draftsByThreadKey: {} });
      await storage!.setItem(name!, snapshot!);
      await store.persist.rehydrate();
      restoreQueuedEdit({ entry, destination, files: [originalFile] });
      const restored = store.getState().getComposerDraft(destination)!;
      expect(restored.prompt).toContain("unsent changes");
      expect(restored.images.map((image) => image.name)).toEqual(["screen.png"]);
      expect(restored.terminalContexts.map((context) => context.text)).toEqual([
        "original context",
        "added context",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
