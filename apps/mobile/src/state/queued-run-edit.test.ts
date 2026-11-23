import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  ChatAttachmentId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  RunId,
  type ChatAttachment,
  type OrchestrationMessageContext,
} from "@t3tools/contracts";

import { composerDraftEnvironmentId } from "../lib/composerAttachmentUploadQueue";
import { isQueuedEditDraftKey, queuedEditDraftKey } from "./queued-edit-draft-key";
import {
  beginQueuedRunEdit,
  claimQueuedRunEditSave,
  endQueuedRunEdit,
  getQueuedRunEdit,
  removeQueuedRunEditAttachment,
  resolveQueuedEditPayload,
  type QueuedRunEdit,
} from "./queued-run-edit";

// The draft store reaches the pending-send outbox, whose ids come from expo-crypto.
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "0000" }));

import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./atom-registry";
import { threadComposerErrorsAtom } from "./thread-composer-error";
import type { ComposerDraft } from "./use-composer-drafts";
const drafts = vi.hoisted(() => ({ values: new Map<string, ComposerDraft>() }));
vi.mock("./use-composer-drafts", () => ({
  clearComposerDraft: (key: string) => drafts.values.delete(key),
  getComposerDraftSnapshot: (key: string) =>
    drafts.values.get(key) ?? { text: "", attachments: [] },
  setComposerDraftText: (key: string, text: string) =>
    drafts.values.set(key, { attachments: [], ...drafts.values.get(key), text }),
  setComposerDraftContext: (key: string, context: OrchestrationMessageContext | undefined) =>
    drafts.values.set(key, { text: "", attachments: [], ...drafts.values.get(key), context }),
  mergeComposerDraftContent: async (key: string, content: ComposerDraft) => {
    drafts.values.set(key, content);
  },
}));
const threadKey = "env-1:thread-9";
afterEach(() => {
  endQueuedRunEdit(threadKey);
  drafts.values.clear();
  appAtomRegistry.set(threadComposerErrorsAtom, {});
});
function startEdit() {
  const runs = Atom.make<ReadonlyArray<{ id: RunId; status: string }> | null>([
    { id: RunId.make("run-1"), status: "queued" },
  ]);
  beginQueuedRunEdit(threadKey, edit([image("kept")]), runs);
  return runs;
}
it("ends an untouched edit silently after its run starts, with no composer mounted", async () => {
  const runs = startEdit();
  appAtomRegistry.set(runs, [{ id: RunId.make("run-1"), status: "running" }]);
  await Promise.resolve();
  expect(getQueuedRunEdit(threadKey)).toBeNull();
  expect(drafts.values.has(threadKey)).toBe(false);
  expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]).toBeUndefined();
});
it.each([false, true])(
  "recovers a changed edit only into an empty draft (occupied: %s)",
  async (occupied) => {
    const runs = startEdit();
    drafts.values.set(queuedEditDraftKey(threadKey, "run-1"), { text: "changed", attachments: [] });
    if (occupied) drafts.values.set(threadKey, { text: "my own draft", attachments: [] });
    appAtomRegistry.set(runs, []);
    await Promise.resolve();
    expect(getQueuedRunEdit(threadKey)).toBeNull();
    expect(drafts.values.get(threadKey)?.text).toBe(occupied ? "my own draft" : "changed");
    expect(appAtomRegistry.get(threadComposerErrorsAtom)[threadKey]?.message).toContain(
      occupied ? "discarded" : "back in the composer",
    );
  },
);
it("counts attachment removal as a change and rechecks after a failed save releases its claim", async () => {
  const runs = startEdit();
  removeQueuedRunEditAttachment(threadKey, "kept");
  const release = claimQueuedRunEditSave(threadKey)!;
  expect(claimQueuedRunEditSave(threadKey)).toBeNull();
  appAtomRegistry.set(runs, []);
  await Promise.resolve();
  expect(getQueuedRunEdit(threadKey)).not.toBeNull();
  release();
  expect(getQueuedRunEdit(threadKey)).toBeNull();
  expect(drafts.values.get(threadKey)?.text).toBe("original");
});
it("does not recover an edit that saved successfully while its run started", async () => {
  const runs = startEdit();
  const release = claimQueuedRunEditSave(threadKey)!;
  appAtomRegistry.set(runs, []);
  await Promise.resolve();
  endQueuedRunEdit(threadKey);
  release();
  expect(drafts.values.has(threadKey)).toBe(false);
});

const image = (id: string): ChatAttachment => ({
  type: "image",
  id: ChatAttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: 10,
});

function edit(attachments: ReadonlyArray<ChatAttachment>): QueuedRunEdit {
  return {
    runId: RunId.make("run-1"),
    messageId: MessageId.make("message-1"),
    originalText: "original",
    existingAttachments: attachments,
  };
}

function context(attachmentIds: ReadonlyArray<string>): OrchestrationMessageContext {
  return {
    version: 1,
    records: attachmentIds.map((attachmentId, index) => ({
      version: 1,
      kind: "image",
      contextId: ComposerContextId.make(`ctx-${index}`),
      label: `${attachmentId}.png`,
      attachmentId,
      name: `${attachmentId}.png`,
      mimeType: "image/png",
      sizeBytes: 10,
    })),
  };
}

describe("queued edit draft key", () => {
  it("keeps the environment readable so attachment uploads still resolve it", () => {
    const key = queuedEditDraftKey("env-1:thread-9", "run-3");

    expect(isQueuedEditDraftKey(key)).toBe(true);
    expect(isQueuedEditDraftKey("env-1:thread-9")).toBe(false);
    expect(composerDraftEnvironmentId(key, [EnvironmentId.make("env-1")], [])).toBe("env-1");
  });
});

describe("resolveQueuedEditPayload", () => {
  it("resends the kept server attachments ahead of the newly uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([image("kept")]),
      draftContext: undefined,
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept", "uploaded"]);
  });

  it("rebinds context records from the draft's ids to the uploaded ones", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["draft-1"]),
      draftAttachments: [{ id: "draft-1" }],
      uploaded: [image("uploaded")],
    });

    expect(payload.context?.records).toEqual([
      expect.objectContaining({ attachmentId: "uploaded" }),
    ]);
  });

  it("drops the record of an attachment the user removed", () => {
    const payload = resolveQueuedEditPayload({
      // "gone" was on the message and has been removed from the kept list.
      edit: edit([image("kept")]),
      draftContext: context(["kept", "gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments.map((attachment) => attachment.id)).toEqual(["kept"]);
    expect(payload.context?.records).toEqual([expect.objectContaining({ attachmentId: "kept" })]);
  });

  it("returns no context when every record lost its attachment", () => {
    const payload = resolveQueuedEditPayload({
      edit: edit([]),
      draftContext: context(["gone"]),
      draftAttachments: [],
      uploaded: [],
    });

    expect(payload.attachments).toEqual([]);
    expect(payload.context).toBeUndefined();
  });
});
