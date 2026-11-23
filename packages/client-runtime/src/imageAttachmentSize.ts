import type { ChatImageAttachment } from "@t3tools/contracts";

/**
 * Longest edge, in pixels, a PNG or JPEG attachment keeps. Anthropic rejects an image over
 * 2000px on a side once a request holds more than 20 images, and Claude Code forwards images
 * sent into a running turn unchanged, so one large paste breaks every later request in that
 * thread. Web and mobile scale attachments down to this edge when they are attached.
 */
export const IMAGE_ATTACHMENT_MAX_EDGE = 2000;

/** Formats a client re-encodes in place. GIF, WebP, and SVG are left as attached. */
export type DownscalableImageMimeType = "image/png" | "image/jpeg";

export function downscalableImageMimeType(mimeType: string): DownscalableImageMimeType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/png") return "image/png";
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "image/jpeg";
  return null;
}

export type OriginalImageMimeType = "image/png" | "image/jpeg" | "image/heic" | "image/heif";

/** Formats kept as a full-size original for save and share (the phone camera's HEIC included). */
export function originalImageMimeType(mimeType: string): OriginalImageMimeType | null {
  const normalized = mimeType.toLowerCase();
  if (normalized === "image/heic" || normalized === "image/heif") return normalized;
  return downscalableImageMimeType(normalized);
}

/**
 * The size an image should be scaled to so its long edge fits `IMAGE_ATTACHMENT_MAX_EDGE`,
 * keeping its aspect ratio. Returns null when it already fits.
 */
export function fitImageAttachmentSize(size: {
  readonly width: number;
  readonly height: number;
}): { width: number; height: number } | null {
  const longestEdge = Math.max(size.width, size.height);
  if (longestEdge <= IMAGE_ATTACHMENT_MAX_EDGE) return null;
  const scale = IMAGE_ATTACHMENT_MAX_EDGE / longestEdge;
  return {
    width: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.width * scale))),
    height: Math.max(1, Math.min(IMAGE_ATTACHMENT_MAX_EDGE, Math.round(size.height * scale))),
  };
}

export function imageAttachmentOriginalResource(
  attachment: Pick<ChatImageAttachment, "id" | "original">,
) {
  if (!attachment.original) return null;
  return {
    _tag: "attachment" as const,
    attachmentId: attachment.id,
    fileName: attachment.original.name,
    mimeType: attachment.original.mimeType,
    original: true,
  };
}

export function imageAttachmentOriginalCaption(image: {
  readonly original?: { readonly width: number; readonly height: number };
  readonly sentSize?: { readonly width: number; readonly height: number };
}): string | null {
  if (!image.original) return null;
  const sent = image.sentSize
    ? `at ${Math.max(image.sentSize.width, image.sentSize.height)} px`
    : "as a smaller copy";
  return `Sent to the model ${sent} · saving full size (${image.original.width} × ${image.original.height})`;
}
