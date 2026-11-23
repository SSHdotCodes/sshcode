import { imageMimeType } from "@t3tools/shared/image";
import type { FilePreviewItem } from "../components/FilePreviewModal.types";
import { isFileBackedComposerAttachment, type DraftComposerAttachment } from "./composerImages";

export function composerImageGallery(
  attachments: readonly DraftComposerAttachment[],
): FilePreviewItem[] {
  return attachments.flatMap((attachment): FilePreviewItem[] => {
    if (attachment.type !== "image" && imageMimeType(attachment) === null) return [];
    if (isFileBackedComposerAttachment(attachment)) {
      return [
        { kind: "image", draftAttachmentId: attachment.id, name: attachment.name, attachment },
      ];
    }
    return attachment.type === "image"
      ? [
          {
            kind: "image",
            draftAttachmentId: attachment.id,
            name: attachment.name,
            uri: attachment.dataUrl ?? attachment.previewUri,
            ...(attachment.original && attachment.originalFileUri
              ? {
                  actionsSource: {
                    name: attachment.name,
                    mimeType: attachment.mimeType,
                    original: { ...attachment.original, sentSize: attachment.sentSize },
                    attachment: {
                      ...attachment,
                      fileUri: attachment.originalFileUri,
                      name: attachment.original.name,
                      mimeType: attachment.original.mimeType,
                      sizeBytes: attachment.original.sizeBytes,
                    },
                  },
                }
              : {}),
          },
        ]
      : [];
  });
}
