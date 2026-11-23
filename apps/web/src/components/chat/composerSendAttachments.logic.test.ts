import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { restoreFailedComposerSendDraft } from "../ChatView.logic";
import { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  DraftId,
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import {
  composerSendUploadBlockReason,
  prepareComposerSendAttachments,
} from "./composerSendAttachments.logic";

const uploads = vi.hoisted(() => ({
  refreshExpiredAttachmentUploads: vi.fn(),
  getUploadedAttachments: vi.fn(),
}));
vi.mock("../../lib/attachmentUploadQueue", () => uploads);

const environmentId = EnvironmentId.make("test-environment");
const target = DraftId.make("test-send");
const file: ComposerFileAttachment = {
  type: "file",
  id: "local-file",
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 5,
  file: new File(["notes"], "notes.txt", { type: "text/plain" }),
};
const image: ComposerImageAttachment = {
  type: "image",
  id: "local-image",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 5,
  file: new File(["image"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:screen",
};
const uploaded = (attachment: ComposerImageAttachment | ComposerFileAttachment) => ({
  type: attachment.type,
  id: `uploaded-${attachment.id}`,
  name: attachment.name,
  mimeType: attachment.mimeType,
  sizeBytes: attachment.sizeBytes,
});

function pendingUploads() {
  let resolve = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  uploads.refreshExpiredAttachmentUploads.mockReturnValue(promise);
  return { resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  useComposerDraftStore.setState({ draftsByThreadKey: {}, draftThreadsByThreadKey: {} });
  uploads.getUploadedAttachments.mockImplementation(({ images }) => images.map(uploaded));
});

describe("sending while attachments upload", () => {
  it("stages the message and clears the draft before uploads finish", async () => {
    const gate = pendingUploads();
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "send this");
    store.addImages(target, [image]);
    store.addFiles(target, [file]);
    const rows: Array<{ text: string; attachments: unknown[] }> = [];
    const prepared = prepareComposerSendAttachments({
      environmentId,
      attachments: [image, file],
      usesAttachmentUploads: true,
      stage: () => {
        const draft = store.getComposerDraft(target)!;
        rows.push({ text: draft.prompt, attachments: [...draft.images, ...draft.files] });
        store.clearComposerContent(target);
      },
      readImage: async () => "unused",
      readFileBlockReason: () => null,
    });
    expect(rows).toEqual([{ text: "send this", attachments: [image, file] }]);
    expect(store.getComposerDraft(target)?.prompt ?? "").toBe("");
    expect(uploads.getUploadedAttachments).not.toHaveBeenCalled();
    gate.resolve();
    const result = await prepared;
    expect(result._tag).toBe("Success");
    if (result._tag === "Success") expect(result.value).toEqual([uploaded(image), uploaded(file)]);
    expect(rows).toHaveLength(1);
  });

  it("settles an upload failure as a send failure, without sending partial attachments", async () => {
    const gate = pendingUploads();
    const prepared = prepareComposerSendAttachments({
      environmentId,
      attachments: [image, file],
      usesAttachmentUploads: true,
      readImage: async () => "unused",
      readFileBlockReason: () => null,
    });
    uploads.getUploadedAttachments.mockReturnValue(null);
    gate.resolve();
    const result = await prepared;
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(squashAtomCommandFailure(result)).toEqual(
        new Error("Attachment 'screen.png' failed to upload."),
      );
    }
  });

  it("rechecks file capabilities after the upload wait", async () => {
    const gate = pendingUploads();
    let reason: string | null = null;
    const prepared = prepareComposerSendAttachments({
      environmentId,
      attachments: [file],
      usesAttachmentUploads: true,
      readImage: async () => "unused",
      readFileBlockReason: () => reason,
    });
    reason = "This server does not support file attachments.";
    gate.resolve();
    const result = await prepared;
    expect(result._tag).toBe("Failure");
    expect(uploads.getUploadedAttachments).not.toHaveBeenCalled();
  });

  it("keeps the inline image fallback for older servers", async () => {
    const result = await prepareComposerSendAttachments({
      environmentId,
      attachments: [image],
      usesAttachmentUploads: false,
      readImage: async () => "data:image/png;base64,aW1hZ2U=",
      readFileBlockReason: () => null,
    });
    expect(uploads.refreshExpiredAttachmentUploads).not.toHaveBeenCalled();
    expect(result._tag).toBe("Success");
    if (result._tag === "Success")
      expect(result.value[0]).toMatchObject({
        id: image.id,
        dataUrl: "data:image/png;base64,aW1hZ2U=",
      });
  });
});

describe("sends that need uploads first", () => {
  it("keeps a question answer blocked through uploading and failure, then permits ready uploads", () => {
    const input = { environmentId, imageIds: [file.id], requiresUploadedAttachments: true };
    expect(composerSendUploadBlockReason({ ...input, uploadsByImageId: {} })).toBe(
      "Attachment still uploading",
    );
    expect(
      composerSendUploadBlockReason({
        ...input,
        uploadsByImageId: { [file.id]: { status: "uploading", environmentId, progress: 0.5 } },
      }),
    ).toBe("Attachment still uploading");
    expect(
      composerSendUploadBlockReason({
        ...input,
        uploadsByImageId: {
          [file.id]: { status: "failed", environmentId, reason: "Upload failed" },
        },
      }),
    ).toBe("Retry or remove the failed attachment");
    expect(
      composerSendUploadBlockReason({
        ...input,
        uploadsByImageId: {
          [file.id]: { status: "ready", environmentId, attachmentId: "uploaded-file" },
        },
      }),
    ).toBeNull();
  });

  it("accepts a plain send during upload", () => {
    expect(
      composerSendUploadBlockReason({
        environmentId,
        imageIds: [file.id],
        requiresUploadedAttachments: false,
        uploadsByImageId: {},
      }),
    ).toBeNull();
  });
});

describe("upload failure recovery", () => {
  const snapshot = {
    prompt: "send with attachments",
    images: [image],
    files: [file],
    terminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
  };

  it("restores text and the original file bytes after a staged upload fails", async () => {
    const gate = pendingUploads();
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, snapshot.prompt);
    store.addImages(target, snapshot.images);
    store.addFiles(target, snapshot.files);
    const prepared = prepareComposerSendAttachments({
      environmentId,
      attachments: [image, file],
      usesAttachmentUploads: true,
      stage: () => store.clearComposerContent(target),
      readImage: async () => "unused",
      readFileBlockReason: () => null,
    });
    uploads.getUploadedAttachments.mockReturnValue(null);
    gate.resolve();
    const result = await prepared;
    expect(result._tag).toBe("Failure");
    const restored = restoreFailedComposerSendDraft(target, snapshot);
    expect(restored?.prompt).toBe(snapshot.prompt);
    expect(restored?.images[0]?.file).toBe(image.file);
    expect(restored?.files[0]?.file).toBe(file.file);
    expect(restored?.images[0]?.id).toBe(image.id);
    expect(restored?.images[0]?.previewUrl).not.toBe(image.previewUrl);
    URL.revokeObjectURL(restored!.images[0]!.previewUrl);
  });

  it("keeps a newer draft and allows the retained snapshot to be restored after it is cleared", () => {
    const store = useComposerDraftStore.getState();
    store.setPrompt(target, "new draft");
    const newer = store.getComposerDraft(target);
    expect(restoreFailedComposerSendDraft(target, snapshot)).toBeNull();
    expect(store.getComposerDraft(target)).toBe(newer);
    store.clearComposerContent(target);
    const restored = restoreFailedComposerSendDraft(target, snapshot);
    expect(restored?.prompt).toBe(snapshot.prompt);
    expect(restored?.files).toEqual([file]);
    expect(restored?.images[0]?.file).toBe(image.file);
    URL.revokeObjectURL(restored!.images[0]!.previewUrl);
  });

  it("preserves an attachment-only newer draft", () => {
    const store = useComposerDraftStore.getState();
    const newerFile = { ...file, id: "newer-file", name: "newer.txt" };
    store.addFiles(target, [newerFile]);
    expect(restoreFailedComposerSendDraft(target, snapshot)).toBeNull();
    expect(store.getComposerDraft(target)?.prompt).toBe("");
    expect(store.getComposerDraft(target)?.files).toEqual([newerFile]);
  });

  it("restores the original draft without changing another chat", () => {
    const store = useComposerDraftStore.getState();
    const otherTarget = DraftId.make("other-chat");
    store.setPrompt(otherTarget, "other draft");
    const restored = restoreFailedComposerSendDraft(target, snapshot);
    expect(store.getComposerDraft(otherTarget)?.prompt).toBe("other draft");
    expect(store.getComposerDraft(target)?.prompt).toBe(snapshot.prompt);
    URL.revokeObjectURL(restored!.images[0]!.previewUrl);
  });
});
