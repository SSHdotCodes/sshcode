// @effect-diagnostics nodeBuiltinImport:off - FileSystem has no clone-on-copy, and callers run this off the Effect path.
/**
 * The server's own copies of the pictures a chat shows from a file path.
 *
 * A chat shows an image an agent read, or linked in its reply, from where the
 * file is. Agents often read a temporary file and delete it seconds later,
 * which left the chat with "Image unavailable". The server therefore copies
 * the file when the chat first names it, and serves that copy once the
 * original is gone.
 *
 * One copy is kept per chat and path, so a file rewritten in place and named
 * again replaces its copy. On APFS a copy is a clone and takes no space until
 * the original changes or is deleted.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";

/** A larger file is left alone: the copy would outlive a deleted original at full size. */
export const VIEWED_IMAGE_COPY_MAX_BYTES = 10 * 1024 * 1024;
/** All copies together, kept small on purpose; the oldest go first. */
export const VIEWED_IMAGE_COPIES_MAX_BYTES = 512 * 1024 * 1024;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

const key = (value: string): string =>
  NodeCrypto.createHash("sha256").update(value).digest("hex").slice(0, 32);

export const viewedImageCopiesDir = (stateDir: string): string =>
  NodePath.join(stateDir, "viewed-images");

/**
 * Where the copy of `filePath` is kept for a chat, or null for a path no copy
 * is made of. `filePath` is absolute; the copy keeps its file name, which is
 * the name the chat shows and saves it under.
 */
export function viewedImageCopyPath(
  stateDir: string,
  threadId: string,
  filePath: string,
): string | null {
  if (!NodePath.isAbsolute(filePath) || !isWorkspaceImagePreviewPath(filePath)) return null;
  const normalized = NodePath.normalize(filePath);
  return NodePath.join(
    viewedImageCopiesDir(stateDir),
    key(threadId),
    key(normalized),
    NodePath.basename(normalized),
  );
}

interface KeptCopy {
  readonly path: string;
  readonly size: number;
  readonly keptAt: number;
}

async function listCopies(root: string): Promise<Array<KeptCopy>> {
  const copies: Array<KeptCopy> = [];
  const entries = await NodeFS.promises
    .readdir(root, { recursive: true, withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = NodePath.join(entry.parentPath, entry.name);
    const info = await NodeFS.promises.stat(path).catch(() => null);
    if (info !== null) copies.push({ path, size: info.size, keptAt: info.mtimeMs });
  }
  return copies;
}

/** Deletes the oldest copies until the rest fit in `maxBytes`. */
export async function pruneViewedImageCopies(
  stateDir: string,
  maxBytes: number = VIEWED_IMAGE_COPIES_MAX_BYTES,
): Promise<void> {
  const copies = await listCopies(viewedImageCopiesDir(stateDir));
  let total = 0;
  for (const copy of copies) total += copy.size;
  if (total <= maxBytes) return;
  copies.sort((a, b) => a.keptAt - b.keptAt);
  for (const copy of copies) {
    if (total <= maxBytes) break;
    await NodeFS.promises.rm(copy.path, { force: true });
    total -= copy.size;
    // The folder holds this one copy; its parent goes too once it is empty.
    const folder = NodePath.dirname(copy.path);
    await NodeFS.promises.rmdir(folder).catch(() => undefined);
    await NodeFS.promises.rmdir(NodePath.dirname(folder)).catch(() => undefined);
  }
}

const lastPrunedAt = new Map<string, number>();
let copySequence = 0;

/**
 * Copies `filePath` for a chat. Resolves to whether a copy was made; a file
 * that is missing, not a regular file, too large or not an image is skipped.
 * Never rejects: a chat must not fail because a picture could not be kept.
 */
export async function keepViewedImageCopy(input: {
  readonly stateDir: string;
  readonly threadId: string;
  readonly filePath: string;
  readonly now: number;
}): Promise<boolean> {
  const target = viewedImageCopyPath(input.stateDir, input.threadId, input.filePath);
  if (target === null) return false;
  copySequence += 1;
  const partial = `${target}.${process.pid}.${copySequence}.partial`;
  try {
    const info = await NodeFS.promises.stat(input.filePath);
    if (!info.isFile() || info.size === 0 || info.size > VIEWED_IMAGE_COPY_MAX_BYTES) return false;
    await NodeFS.promises.mkdir(NodePath.dirname(target), { recursive: true });
    // A clone where the file system has them, a plain copy elsewhere.
    await NodeFS.promises.copyFile(input.filePath, partial, NodeFS.constants.COPYFILE_FICLONE);
    // The copy carries the original's dates; pruning goes by when it was kept.
    const keptAtSeconds = input.now / 1000;
    await NodeFS.promises.utimes(partial, keptAtSeconds, keptAtSeconds);
    await NodeFS.promises.chmod(partial, 0o600);
    await NodeFS.promises.rename(partial, target);
  } catch {
    await NodeFS.promises.rm(partial, { force: true }).catch(() => undefined);
    return false;
  }
  if (input.now - (lastPrunedAt.get(input.stateDir) ?? 0) >= PRUNE_INTERVAL_MS) {
    lastPrunedAt.set(input.stateDir, input.now);
    await pruneViewedImageCopies(input.stateDir).catch(() => undefined);
  }
  return true;
}

const MARKDOWN_TARGET = /\]\(\s*(?:<([^>\n]+)>|([^)\s]+))/g;

/**
 * The absolute image paths a reply links, as `![alt](/path.png)` or
 * `[text](/path.png)`. Web addresses, relative paths and other files are left out.
 */
export function linkedImagePaths(text: string, homeDirectory: string): ReadonlyArray<string> {
  const paths = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_TARGET)) {
    let target = (match[1] ?? match[2] ?? "").trim();
    if (target.startsWith("file://")) target = target.slice("file://".length);
    const fragment = target.indexOf("#");
    if (fragment >= 0) target = target.slice(0, fragment);
    if (target.startsWith("~/")) target = NodePath.join(homeDirectory, target.slice(2));
    if (!target.startsWith("/")) continue;
    if (target.includes("%")) {
      try {
        target = decodeURIComponent(target);
      } catch {
        // Not an encoded path; the literal one stands.
      }
    }
    if (isWorkspaceImagePreviewPath(target)) paths.add(target);
    if (paths.size >= 32) break;
  }
  return [...paths];
}
