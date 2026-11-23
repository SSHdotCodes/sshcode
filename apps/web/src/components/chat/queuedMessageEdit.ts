import type { ChatAttachment } from "@t3tools/contracts";
import { readFileAsDataUrl } from "../../lib/imageCompression";
import {
  useComposerDraftStore,
  type ComposerThreadTarget,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
} from "../../composerDraftStore";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";

/** Staged attachments upload as soon as they are added, so a dropped edit must release them. */
export function discardQueuedEditDraft(target: ComposerThreadTarget): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  if (draft) {
    releaseDraftAttachments([...draft.images, ...draft.files]);
    for (const image of draft.images) {
      if (image.previewUrl.startsWith("blob:")) URL.revokeObjectURL(image.previewUrl);
    }
  }
  store.clearComposerContent(target);
}

/** Generic files need upload references; images also support the inline transport. */
export async function prepareQueuedEditAttachments(input: {
  readonly existingAttachments: ReadonlyArray<ChatAttachment>;
  readonly images: ReadonlyArray<ComposerImageAttachment>;
  readonly files: ReadonlyArray<ComposerFileAttachment>;
  readonly uploadFiles: (
    files: ReadonlyArray<ComposerFileAttachment>,
  ) => Promise<ReadonlyArray<ChatAttachment>>;
  readonly readImage: (file: File) => Promise<string>;
}) {
  const files = input.files.length === 0 ? [] : await input.uploadFiles(input.files);
  if (files.length !== input.files.length)
    throw new Error("Retry or remove failed uploads before saving.");
  const images = await Promise.all(
    input.images.map(async (image) => ({
      type: "image" as const,
      id: image.id,
      name: image.name,
      mimeType: image.mimeType,
      sizeBytes: image.sizeBytes,
      dataUrl: await input.readImage(image.file),
      ...(image.source ? { source: image.source } : {}),
    })),
  );
  return [...input.existingAttachments, ...images, ...files];
}

/** Finish persisting image bytes even if the composer has switched to another draft. */
export async function persistQueuedEditImages(target: ComposerThreadTarget): Promise<void> {
  const store = useComposerDraftStore.getState();
  const images = store.getComposerDraft(target)?.images ?? [];
  const encoded = await Promise.all(
    images.map(async (image) => {
      try {
        return {
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          dataUrl: await readFileAsDataUrl(image.file),
          ...(image.source ? { source: image.source } : {}),
        };
      } catch {
        return null;
      }
    }),
  );
  const latest = useComposerDraftStore.getState().getComposerDraft(target);
  if (!latest) return;
  const liveIds = new Set(latest.images.map((image) => image.id));
  const existing = new Map(
    latest.persistedAttachments
      .filter((item) => liveIds.has(item.id))
      .map((item) => [item.id, item]),
  );
  for (const item of encoded) if (item && liveIds.has(item.id)) existing.set(item.id, item);
  await store.syncPersistedAttachments(target, [...existing.values()]);
}
