import type { AssetResource, EnvironmentId } from "@t3tools/contracts";

import type { FileBackedComposerAttachment } from "../lib/composerImages";
import type { MediaActionsSource } from "../lib/mediaActionsSource";

interface FilePreviewMetadata {
  readonly draftAttachmentId?: string;
  readonly kind: "image" | "video" | "pdf" | "document";
  readonly occurrenceId?: string;
  readonly onShowInChat?: () => void;
  readonly mimeType?: string;
  readonly name?: string;
  readonly sourceIdentifier?: string;
  readonly srcFragment?: string;
  readonly actionsSource?: MediaActionsSource;
}

export type FilePreviewItem = FilePreviewMetadata &
  (
    | { readonly uri: string }
    | { readonly attachment: FileBackedComposerAttachment }
    | { readonly environmentId: EnvironmentId; readonly resource: AssetResource }
  );

export type FilePreviewSource = FilePreviewItem & {
  readonly gallery?: readonly FilePreviewItem[];
};

export interface ResolvedFilePreviewSource extends FilePreviewMetadata {
  readonly uri: string;
  /** Items still being resolved carry an empty `uri`; the viewer shows them as loading. */
  readonly gallery?: readonly (FilePreviewMetadata & {
    readonly uri: string;
    readonly unavailable?: boolean;
  })[];
  /** This item's position in `gallery`. */
  readonly galleryIndex?: number;
}
