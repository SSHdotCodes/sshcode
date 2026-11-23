import type { ChatAttachment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { imageMimeType } from "@t3tools/shared/image";
import type { FilePreviewItem } from "../../components/FilePreviewModal.types";
import { composerImageGallery } from "../../lib/composerImageGallery";
import type { DraftComposerAttachment } from "../../lib/composerImages";
import { filePreviewKey } from "../../lib/filePreviewGallery";
import { markdownImageSources } from "../../lib/markdownImageSources";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { threadFeedRevision } from "../../lib/threadFeedProjection";

interface MessageImageGalleryContext {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null | undefined;
}

/** Images in the order a message shows them: user attachments sit above the text. */
export function messageImageGallery(
  message: {
    readonly role?: string;
    readonly text: string;
    readonly attachments?: readonly ChatAttachment[];
  },
  context: MessageImageGalleryContext,
): FilePreviewItem[] {
  const attachments: FilePreviewItem[] = [];
  for (const attachment of message.attachments ?? []) {
    if (attachment.type !== "image" && imageMimeType(attachment) === null) continue;
    const resource = {
      _tag: "attachment" as const,
      attachmentId: attachment.id,
      fileName: attachment.name,
      mimeType: attachment.mimeType,
    };
    attachments.push({
      kind: "image",
      name: attachment.name,
      environmentId: context.environmentId,
      resource,
      actionsSource: {
        environmentId: context.environmentId,
        resource,
        name: attachment.name,
        mimeType: imageMimeType(attachment) ?? "image/*",
        ...(attachment.type === "image" && "original" in attachment && attachment.original
          ? {
              original: {
                ...attachment.original,
                ...("sentSize" in attachment && attachment.sentSize
                  ? { sentSize: attachment.sentSize }
                  : {}),
              },
            }
          : {}),
      },
    });
  }
  const markdown: FilePreviewItem[] = [];
  for (const href of markdownImageSources(message.text)) {
    const preview = resolveMarkdownMediaPreview(href, { ...context, imageEmbed: true });
    if (preview?.kind === "image") markdown.push(preview.source);
  }
  return message.role === "user" ? [...attachments, ...markdown] : [...markdown, ...attachments];
}

interface ThreadGalleryEntry {
  readonly type: string;
  readonly message?: {
    readonly role?: string;
    readonly text: string;
    readonly attachments?: readonly ChatAttachment[];
  };
  readonly pendingMessage?: { readonly attachments: readonly DraftComposerAttachment[] };
}

const messageImagesCache = new WeakMap<
  object,
  { readonly context: MessageImageGalleryContext; readonly images: readonly FilePreviewItem[] }
>();

function cachedMessageImages(
  entry: ThreadGalleryEntry & { readonly message: NonNullable<ThreadGalleryEntry["message"]> },
  context: MessageImageGalleryContext,
): readonly FilePreviewItem[] {
  const cached = messageImagesCache.get(entry.message);
  if (
    cached &&
    cached.context.environmentId === context.environmentId &&
    cached.context.threadId === context.threadId &&
    cached.context.workspaceRoot === context.workspaceRoot
  ) {
    return cached.images;
  }
  const images = messageImageGallery(entry.message, context);
  messageImagesCache.set(entry.message, { context, images });
  return images;
}

const threadImagesCache = new WeakMap<
  object,
  { readonly context: MessageImageGalleryContext; readonly images: readonly FilePreviewItem[] }
>();

function sameGalleryContext(left: MessageImageGalleryContext, right: MessageImageGalleryContext) {
  return (
    left.environmentId === right.environmentId &&
    left.threadId === right.threadId &&
    left.workspaceRoot === right.workspaceRoot
  );
}

/**
 * Every image the feed's messages show, in feed order, so the viewer can page through
 * the whole conversation. Returns `previous` while the images are unchanged: streamed
 * text must not re-render every image that reads the gallery.
 */
export function threadImageGallery(
  entries: readonly ThreadGalleryEntry[],
  context: MessageImageGalleryContext,
  previous: readonly FilePreviewItem[] = [],
): readonly FilePreviewItem[] {
  const update = threadFeedRevision(entries);
  const cached = threadImagesCache.get(update.revision);
  if (cached && sameGalleryContext(cached.context, context)) return cached.images;
  const recentGallery = update.previousRevision
    ? threadImagesCache.get(update.previousRevision)
    : undefined;
  const hasRecentGallery = recentGallery && sameGalleryContext(recentGallery.context, context);
  const previousGallery = hasRecentGallery
    ? recentGallery
    : threadImagesCache.get(update.originRevision);
  const previousEntry = hasRecentGallery ? update.previousEntry : update.originEntry;
  const entry = update.index === null ? undefined : entries[update.index];
  if (
    previousGallery &&
    sameGalleryContext(previousGallery.context, context) &&
    previousEntry &&
    entry?.type === "message" &&
    entry.message &&
    sameFilePreviewItems(
      cachedMessageImages(previousEntry, context),
      cachedMessageImages({ ...entry, message: entry.message }, context),
    )
  ) {
    threadImagesCache.set(update.revision, previousGallery);
    return previousGallery.images;
  }
  const images = entries.flatMap((entry) => {
    if (entry.type !== "message" || !entry.message) return [];
    const pending = entry.pendingMessage
      ? composerImageGallery(entry.pendingMessage.attachments)
      : [];
    const sent = cachedMessageImages({ ...entry, message: entry.message }, context);
    return pending.length > 0 ? [...pending, ...sent] : sent;
  });
  const result = sameFilePreviewItems(images, previous) ? previous : images;
  threadImagesCache.set(update.revision, { context, images: result });
  return result;
}

/** Whether two galleries list the same images in the same order. */
export function sameFilePreviewItems(
  left: readonly FilePreviewItem[],
  right: readonly FilePreviewItem[],
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((image, index) => filePreviewKey(image) === filePreviewKey(right[index]!)))
  );
}
