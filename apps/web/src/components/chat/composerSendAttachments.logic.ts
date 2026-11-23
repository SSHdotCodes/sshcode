import type { EnvironmentId } from "@t3tools/contracts";
import { settlePromise } from "@t3tools/client-runtime/state/runtime";
import type { ComposerFileAttachment, ComposerImageAttachment } from "../../composerDraftStore";
import {
  getUploadedAttachments,
  refreshExpiredAttachmentUploads,
} from "../../lib/attachmentUploadQueue";
import { attachmentUploadBlockReason } from "../../lib/attachmentUploadState";

/** Answers and approval redirects must have their uploads before accepting the send. */
export function composerSendUploadBlockReason(
  input: Parameters<typeof attachmentUploadBlockReason>[0] & {
    readonly requiresUploadedAttachments: boolean;
  },
): string | null {
  return input.requiresUploadedAttachments ? attachmentUploadBlockReason(input) : null;
}

/** Stage once before waiting, and settle failures immediately even if dispatch awaits other work. */
export function prepareComposerSendAttachments(input: {
  readonly environmentId: EnvironmentId;
  readonly attachments: ReadonlyArray<ComposerImageAttachment | ComposerFileAttachment>;
  readonly usesAttachmentUploads: boolean;
  readonly stage?: () => void;
  readonly readImage: (file: File) => Promise<string>;
  readonly readFileBlockReason: () => string | null;
}) {
  input.stage?.();
  return settlePromise(async () => {
    if (input.usesAttachmentUploads) {
      // A ready upload may have been swept by the server since it was attached. Staging has
      // already cleared the draft, so a re-upload is not stamped back onto it.
      await refreshExpiredAttachmentUploads({
        environmentId: input.environmentId,
        images: input.attachments,
      });
    }
    const blockReason = input.readFileBlockReason();
    if (blockReason !== null) throw new Error(blockReason);
    return Promise.all(
      input.attachments.map(async (attachment) => {
        if (input.usesAttachmentUploads) {
          const uploaded = getUploadedAttachments({
            environmentId: input.environmentId,
            images: [attachment],
          })?.[0];
          if (!uploaded) throw new Error(`Attachment '${attachment.name}' failed to upload.`);
          return uploaded;
        }
        if (attachment.type !== "image") {
          throw new Error("This server does not support file attachments.");
        }
        return {
          type: "image" as const,
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          dataUrl: await input.readImage(attachment.file),
          ...(attachment.source ? { source: attachment.source } : {}),
        };
      }),
    );
  });
}
