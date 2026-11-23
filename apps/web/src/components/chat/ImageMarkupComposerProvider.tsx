import { useMemo, type ReactNode } from "react";
import {
  useComposerDraftStore,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import {
  compressedImageOriginalFields,
  prepareImageForAttachment,
} from "../../lib/imageCompression";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";
import { randomUUID } from "../../lib/utils";
import type { ExpandedImageItem } from "./ExpandedImagePreview";
import { ImageMarkupContext } from "./ImageMarkupContext";

export function ImageMarkupComposerProvider(props: {
  target: ComposerThreadTarget;
  children: ReactNode;
}) {
  const target = props.target;
  const value = useMemo(
    () => ({
      isDraft: (item: ExpandedImageItem) =>
        !!useComposerDraftStore
          .getState()
          .getComposerDraft(item.draftTarget ?? target)
          ?.images.some((image) => image.previewUrl === item.src),
      attach: async (file: File, item: ExpandedImageItem, replace: boolean) => {
        const destination = item.draftTarget ?? target;
        const store = useComposerDraftStore.getState();
        const original = store
          .getComposerDraft(destination)
          ?.images.find((image) => image.previewUrl === item.src);
        const prepared = await prepareImageForAttachment(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
        if (!prepared.ok)
          throw new Error("This image could not be prepared for chat. Save it instead.");
        const attachmentFile = prepared.file;
        const image: ComposerImageAttachment = {
          type: "image",
          id: randomUUID(),
          name: attachmentFile.name,
          mimeType: attachmentFile.type,
          sizeBytes: attachmentFile.size,
          previewUrl: URL.createObjectURL(attachmentFile),
          file: attachmentFile,
          ...compressedImageOriginalFields(prepared),
        };
        if (replace) {
          if (
            !original ||
            !store.getComposerDraft(destination)?.images.includes(original) ||
            !store.replaceImage(destination, original.id, image)
          ) {
            URL.revokeObjectURL(image.previewUrl);
            throw new Error("This draft changed. Reopen the image and try again.");
          }
          releaseDraftAttachments([original]);
        } else if (
          !store.addImages(destination, [image], { allowDuplicates: true }).includes(image.id)
        ) {
          throw new Error("The attachment limit has been reached.");
        }
      },
    }),
    [target],
  );
  return <ImageMarkupContext value={value}>{props.children}</ImageMarkupContext>;
}
