import { convertPastedImagesToAttachments } from "../lib/composerImages";
import {
  appendComposerDraftAttachments,
  getComposerDraftSnapshot,
  replaceComposerDraftAttachment,
} from "./use-composer-drafts";

/** The parts of a resolved file preview that name a draft image. */
interface DraftImageSource {
  readonly uri: string;
  readonly draftAttachmentId?: string | undefined;
  readonly sourceIdentifier?: string | undefined;
}

export function markupDraftAttachment(draftKey: string, source: DraftImageSource) {
  const id = source.draftAttachmentId ?? source.sourceIdentifier?.replace(/^draft-image:/, "");
  return getComposerDraftSnapshot(draftKey).attachments.find(
    (attachment) =>
      attachment.id === id ||
      (attachment.type === "image" &&
        (attachment.previewUri === source.uri || attachment.dataUrl === source.uri)),
  );
}

/** Uses the same import, byte limits and downscaling as a pasted composer image. */
export async function attachMarkedImage(input: {
  draftKey: string;
  uri: string;
  name: string;
  replaceId?: string;
}) {
  const before = getComposerDraftSnapshot(input.draftKey);
  const original = before.attachments.find((attachment) => attachment.id === input.replaceId);
  if (input.replaceId && !original) throw new Error("This attachment is no longer in the draft.");
  const [image] = await convertPastedImagesToAttachments({
    uris: [input.uri],
    existingCount: original ? 0 : before.attachments.length,
  });
  if (!image)
    throw new Error("The marked image could not be attached. Check the attachment size and count.");
  const attachment = { ...image, name: input.name, previewUri: image.dataUrl ?? image.previewUri };
  const live = getComposerDraftSnapshot(input.draftKey);
  if (original) {
    if (!live.attachments.includes(original))
      throw new Error("This draft changed. Reopen the image and try again.");
    if (!replaceComposerDraftAttachment(input.draftKey, original.id, attachment)) {
      throw new Error("This attachment is no longer in the draft.");
    }
  } else if (
    appendComposerDraftAttachments(input.draftKey, [attachment], {
      appendReference: true,
    }) > 0
  ) {
    throw new Error("The attachment limit has been reached.");
  }
}
