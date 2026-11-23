import type { ChatFileAttachment } from "@t3tools/contracts";
import type { Directory } from "expo-file-system";
import type { SharingOptions } from "expo-sharing";

import { beginForegroundHandoff } from "./foreground-handoff";
import { uuidv4 } from "./uuid";

const ATTACHMENT_DOWNLOAD_DIRECTORY = "t3-attachment-downloads";
const DOWNLOAD_RETENTION_MS = 24 * 60 * 60_000;
const DOWNLOAD_DIRECTORY_NAME = /^(\d+)-[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
const activeDirectories = new Set<string>();

/**
 * Extensions Photos and the share sheet recognize, by MIME type. A caption such as
 * "Earth sunrise, 4K" names the file without one, and iOS identifies video by extension.
 */
const MEDIA_EXTENSIONS: Readonly<Record<string, readonly string[]>> = {
  "video/mp4": ["mp4", "m4v"],
  "video/quicktime": ["mov", "qt"],
  "video/x-m4v": ["m4v", "mp4"],
  "video/webm": ["webm"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "image/heic": ["heic"],
  "image/heif": ["heif"],
};

/** Adds the MIME type's extension when the name lacks a matching one. */
function withMediaExtension(name: string, mimeType: string | undefined): string {
  const extensions = mimeType
    ? MEDIA_EXTENSIONS[mimeType.toLowerCase().split(";")[0]!.trim()]
    : undefined;
  if (!extensions) return name;
  const current = /\.([a-z0-9]{1,16})$/i.exec(name)?.[1]?.toLowerCase();
  return current && extensions.includes(current) ? name : `${name}.${extensions[0]}`;
}

export function downloadFileName(name: string, mimeType?: string): string {
  const basename = name.split(/[\\/]/).at(-1) ?? "";
  const sanitized = Array.from(basename, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 32 ||
      (codePoint >= 127 && codePoint <= 159) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? "_"
      : character;
  })
    .join("")
    .trim();
  const named = withMediaExtension(
    !sanitized || /^\.+$/.test(sanitized) ? "attachment" : sanitized,
    mimeType,
  );
  const encoder = new TextEncoder();
  if (encoder.encode(named).byteLength <= 255) {
    return named;
  }
  const extensionMatch = /\.[a-z0-9]{1,16}$/i.exec(named);
  const extension = extensionMatch && extensionMatch.index > 0 ? extensionMatch[0] : "";
  const stem = extension ? named.slice(0, -extension.length) : named;
  let remainingBytes = 255 - encoder.encode(extension).byteLength;
  let shortStem = "";
  for (const character of stem) {
    const bytes = encoder.encode(character).byteLength;
    if (bytes > remainingBytes) break;
    shortStem += character;
    remainingBytes -= bytes;
  }
  return `${shortStem || "attachment"}${extension}`;
}

function removeDownloadDirectory(directory: Directory): void {
  try {
    if (directory.exists) {
      directory.delete();
    }
  } catch (error) {
    console.warn("[attachment-downloads] could not remove a cached file", error);
  }
}

type AttachmentFileMetadata = Pick<ChatFileAttachment, "name" | "mimeType">;

export interface AttachmentPreviewFile {
  readonly uri: string;
  readonly share: (signal: AbortSignal, sourceIdentifier?: string) => Promise<void>;
  readonly dispose: () => void;
}

async function availableSharing(signal: AbortSignal) {
  if (signal.aborted) return null;
  const Sharing = await import("expo-sharing");
  const canShare = await Sharing.isAvailableAsync();
  if (signal.aborted) return null;
  if (!canShare) {
    throw new Error("Saving and sharing files is unavailable on this device.");
  }
  return Sharing;
}

async function createCachedAttachmentFile(attachment: AttachmentFileMetadata) {
  const { Directory, File, Paths } = await import("expo-file-system");
  const cache = new Directory(Paths.cache, ATTACHMENT_DOWNLOAD_DIRECTORY);
  cache.create({ idempotent: true, intermediates: true });
  const now = Date.now();
  try {
    for (const entry of cache.list()) {
      const match = DOWNLOAD_DIRECTORY_NAME.exec(entry.name);
      if (
        entry instanceof Directory &&
        match &&
        Number(match[1]) < now - DOWNLOAD_RETENTION_MS &&
        !activeDirectories.has(entry.uri)
      ) {
        removeDownloadDirectory(entry);
      }
    }
  } catch (error) {
    console.warn("[attachment-downloads] could not inspect cached files", error);
  }

  const directory = new Directory(cache, `${now}-${uuidv4()}`);
  directory.create();
  let file: InstanceType<typeof File>;
  try {
    file = new File(directory, downloadFileName(attachment.name, attachment.mimeType));
  } catch (error) {
    removeDownloadDirectory(directory);
    throw error;
  }
  activeDirectories.add(directory.uri);
  let disposed = false;
  let shared = false;
  let sharing = false;
  const release = () => {
    if (!disposed || sharing) return;
    activeDirectories.delete(directory.uri);
    // A receiver can still be reading after Android's chooser returns.
    if (!shared) removeDownloadDirectory(directory);
  };
  const preview: AttachmentPreviewFile = {
    uri: file.uri,
    dispose: () => {
      disposed = true;
      release();
    },
    share: async (signal, sourceIdentifier) => {
      if (disposed || sharing || signal.aborted) return;
      sharing = true;
      try {
        const Sharing = await availableSharing(signal);
        if (Sharing === null || disposed) return;
        const endHandoff = beginForegroundHandoff();
        try {
          const options: SharingOptions = {
            mimeType: attachment.mimeType.split(";", 1)[0]?.trim() || "application/octet-stream",
            dialogTitle: attachment.name,
          };
          if (sourceIdentifier) {
            const { shareFileFromSource } = await import("./shareFileFromSource");
            if (signal.aborted || disposed) return;
            await shareFileFromSource(file.uri, options, sourceIdentifier);
          } else {
            await Sharing.shareAsync(file.uri, options);
          }
          shared = true;
        } catch (cause) {
          if (!signal.aborted) {
            throw new Error("Could not open the share sheet. Try again.", { cause });
          }
        } finally {
          endHandoff();
        }
      } finally {
        sharing = false;
        release();
      }
    },
  };
  return {
    file,
    preview,
    retainAfterHandoff: () => {
      shared = true;
    },
  };
}

/** A readable reason for a viewer refusing a file; native rejections carry stack text. */
export function nativeViewerErrorMessage(cause: unknown): string {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /ActivityNotFound|cannot be previewed/i.test(text)
    ? "No app on this device can show this format. Save or share it to open it elsewhere."
    : "The file could not be opened. Check the connection and try again.";
}

/** Open an Android document in a viewer, retaining the cache while another app reads it. */
export async function openAttachmentInViewer(input: {
  readonly uri: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
}): Promise<void> {
  const { File } = await import("expo-file-system");
  const { requireNativeModule } = await import("expo");
  if (input.signal.aborted) return;
  const cached = await createCachedAttachmentFile(input.attachment);
  try {
    if (/^(file|content):/.test(input.uri)) {
      await new File(input.uri).copy(cached.file);
    } else {
      await File.downloadFileAsync(input.uri, cached.file, { signal: input.signal });
    }
    if (input.signal.aborted) return;
    const endHandoff = beginForegroundHandoff();
    try {
      await requireNativeModule<{ openFile(uri: string, mimeType: string): Promise<void> }>(
        "T3NativeControls",
      ).openFile(
        cached.file.uri,
        input.attachment.mimeType.split(";", 1)[0]?.trim() || "application/octet-stream",
      );
      cached.retainAfterHandoff();
    } finally {
      endHandoff();
    }
  } finally {
    cached.preview.dispose();
  }
}

/** The caller owns this cached file until disposal, unless it has been shared with another app. */
export async function downloadAttachmentForPreview(input: {
  readonly url: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
}): Promise<AttachmentPreviewFile | null> {
  if (input.signal.aborted) return null;
  const { File } = await import("expo-file-system");
  const cached = await createCachedAttachmentFile(input.attachment);
  try {
    if (input.signal.aborted) {
      cached.preview.dispose();
      return null;
    }
    await File.downloadFileAsync(input.url, cached.file, { signal: input.signal });
    if (input.signal.aborted) {
      cached.preview.dispose();
      return null;
    }
    return cached.preview;
  } catch (cause) {
    // Android may leave a partial file after a failed or interrupted request.
    cached.preview.dispose();
    if (input.signal.aborted) return null;
    throw new Error("Could not download the attachment. Check the connection and try again.", {
      cause,
    });
  }
}

/** Downloads original bytes for the native save/share sheet, including inline video responses. */
export async function downloadAndShareAttachment(input: {
  readonly url: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
  readonly sourceIdentifier?: string;
}): Promise<void> {
  if ((await availableSharing(input.signal)) === null) return;
  const file = await downloadAttachmentForPreview(input);
  if (file === null) return;
  try {
    await file.share(input.signal, input.sourceIdentifier);
  } finally {
    file.dispose();
  }
}

function dataUriBytes(uri: string): Uint8Array {
  const comma = uri.indexOf(",");
  if (comma < 0) throw new Error("The image data is malformed.");
  const payload = uri.slice(comma + 1);
  if (!/;base64$/i.test(uri.slice(0, comma))) {
    return new TextEncoder().encode(decodeURIComponent(payload));
  }
  return Uint8Array.from(atob(payload), (character) => character.charCodeAt(0));
}

/**
 * Runs `use` with a cache copy of the media (downloaded, copied, or decoded from a
 * data URI) and removes the copy afterwards. Null when the request was cancelled first.
 */
export async function withLocalMediaFile<T>(
  input: {
    readonly uri: string;
    readonly attachment: AttachmentFileMetadata;
    readonly signal: AbortSignal;
    /** Download progress from 0 to 1, when the server sends a length. */
    readonly onProgress?: (fraction: number) => void;
  },
  use: (fileUri: string) => Promise<T>,
): Promise<T | null> {
  if (input.signal.aborted) return null;
  const { File } = await import("expo-file-system");
  const cached = await createCachedAttachmentFile(input.attachment);
  try {
    try {
      if (/^(file|content):/i.test(input.uri)) {
        await new File(input.uri).copy(cached.file);
      } else if (/^data:/i.test(input.uri)) {
        cached.file.write(dataUriBytes(input.uri));
      } else {
        const report = input.onProgress;
        await File.downloadFileAsync(input.uri, cached.file, {
          signal: input.signal,
          ...(report
            ? {
                onProgress: ({ bytesWritten, totalBytes }) => {
                  if (totalBytes > 0) report(Math.min(1, bytesWritten / totalBytes));
                },
              }
            : {}),
        });
      }
    } catch (cause) {
      if (input.signal.aborted) return null;
      const kind = input.attachment.mimeType.toLowerCase().startsWith("video/") ? "video" : "image";
      throw new Error(`Could not load the ${kind}. Check the connection and try again.`, { cause });
    }
    if (input.signal.aborted) return null;
    return await use(cached.file.uri);
  } finally {
    cached.preview.dispose();
  }
}

/** Shares a cache copy so another app never relies on the lifetime of a composer draft. */
export async function shareLocalAttachment(input: {
  readonly uri: string;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
  readonly sourceIdentifier?: string;
}): Promise<void> {
  if ((await availableSharing(input.signal)) === null) return;
  const { File } = await import("expo-file-system");
  const cached = await createCachedAttachmentFile(input.attachment);
  try {
    if (input.signal.aborted) return;
    try {
      await new File(input.uri).copy(cached.file);
    } catch (cause) {
      if (input.signal.aborted) return;
      throw new Error("Could not prepare the attachment for sharing.", { cause });
    }
    if (!input.signal.aborted) {
      await cached.preview.share(input.signal, input.sourceIdentifier);
    }
  } finally {
    cached.preview.dispose();
  }
}

/**
 * Shares bytes made on this device (an MCP App's download) through the same
 * cache and share sheet. False when the share sheet could not be shown.
 */
export async function shareGeneratedAttachment(input: {
  readonly bytes: Uint8Array;
  readonly attachment: AttachmentFileMetadata;
  readonly signal: AbortSignal;
}): Promise<boolean> {
  // An unavailable share sheet is a refusal for the caller, not a failure.
  const sharing = await availableSharing(input.signal).catch(() => null);
  if (sharing === null) return false;
  const cached = await createCachedAttachmentFile(input.attachment);
  try {
    if (input.signal.aborted) return false;
    cached.file.write(input.bytes);
    await cached.preview.share(input.signal);
    return true;
  } finally {
    cached.preview.dispose();
  }
}
