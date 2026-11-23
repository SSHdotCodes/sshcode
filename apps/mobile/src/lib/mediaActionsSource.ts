import type { MediaReference } from "@t3tools/client-runtime/media-reference";
import type {
  AssetResource,
  ChatImageOriginal,
  EnvironmentId,
  ImageAttachmentDimensions,
  ThreadId,
} from "@t3tools/contracts";
import type { FileBackedComposerAttachment } from "./composerImages";

/** Authored source metadata is kept separate from temporary preview/download URLs. */
export type MediaActionsSource = {
  readonly reference?: MediaReference;
  readonly name: string;
  readonly mimeType: string;
  readonly original?: ChatImageOriginal & { readonly sentSize?: ImageAttachmentDimensions };
  /** Anchors the iOS share sheet to the view that opened the menu. */
  readonly sourceIdentifier?: string;
} & (
  | { readonly uri: string }
  | { readonly attachment: FileBackedComposerAttachment }
  | {
      readonly environmentId: EnvironmentId;
      readonly threadId?: ThreadId;
      readonly resource: AssetResource;
    }
);

export function mediaActionByteSource(
  source: MediaActionsSource | undefined,
): MediaActionsSource | undefined {
  if (!source?.original) return source;
  const original = source.original;
  if (
    "attachment" in source &&
    "originalFileUri" in source.attachment &&
    source.attachment.originalFileUri
  ) {
    return {
      ...source,
      name: original.name,
      mimeType: original.mimeType,
      attachment: {
        ...source.attachment,
        fileUri: source.attachment.originalFileUri,
        name: original.name,
        mimeType: original.mimeType,
        sizeBytes: original.sizeBytes,
      },
    };
  }
  if ("resource" in source && source.resource._tag === "attachment") {
    return {
      ...source,
      name: original.name,
      mimeType: original.mimeType,
      resource: {
        ...source.resource,
        fileName: original.name,
        mimeType: original.mimeType,
        original: true,
      },
    };
  }
  return source;
}
