// @effect-diagnostics nodeBuiltinImport:off - FileSystem lacks bounded directory iteration and no-follow opens.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as NodeStream from "@effect/platform-node/NodeStream";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

class MediaFileOpenError extends Schema.TaggedError<MediaFileOpenError>()("MediaFileOpenError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to open media file '${this.path}'.`;
  }
}

class MediaFileReadError extends Schema.TaggedError<MediaFileReadError>()("MediaFileReadError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read media file '${this.path}'.`;
  }
}

class MediaFileStatError extends Schema.TaggedError<MediaFileStatError>()("MediaFileStatError", {
  path: Schema.String,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Failed to read metadata for media file '${this.path}'.`;
  }
}

/** Holds the file identity and descriptor for one HTTP request, never a copy of its bytes. */
export interface OpenMediaFile {
  readonly handle: NodeFSP.FileHandle;
  readonly info: NodeFS.BigIntStats;
}

const realpathLikeFileSystem = (filePath: string) =>
  new Promise<string>((resolve, reject) => {
    NodeFS.realpath(filePath, (error, resolved) => (error ? reject(error) : resolve(resolved)));
  });

const MAX_IMAGE_SEARCH_DEPTH = 4;
const MAX_IMAGE_SEARCH_ENTRIES = 3_000;
const IGNORED_IMAGE_SEARCH_FOLDERS = new Set([
  "node_modules",
  "build",
  "dist",
  "out",
  "target",
  "coverage",
]);

/** Searches only real subfolders of the canonical workspace. */
export async function findUniqueNestedImage(
  workspaceRoot: string,
  relativePath: string,
  signal: AbortSignal,
): Promise<string | null> {
  const suffix = NodePath.sep + relativePath.split("/").join(NodePath.sep);
  const pending = [{ directory: workspaceRoot, depth: 0 }];
  let remaining = MAX_IMAGE_SEARCH_ENTRIES;
  let match = null;
  for (const { directory, depth } of pending) {
    signal.throwIfAborted();
    if ((await realpathLikeFileSystem(directory)) !== directory) return null;
    const entries = await NodeFSP.opendir(directory);
    try {
      for await (const entry of entries) {
        signal.throwIfAborted();
        if (remaining-- === 0) return null;
        const entryPath = NodePath.join(directory, entry.name);
        if (
          entry.isDirectory() &&
          depth < MAX_IMAGE_SEARCH_DEPTH &&
          !entry.name.startsWith(".") &&
          !IGNORED_IMAGE_SEARCH_FOLDERS.has(entry.name.toLowerCase())
        ) {
          pending.push({ directory: entryPath, depth: depth + 1 });
        } else if (
          depth > 0 &&
          entry.isFile() &&
          NodePath.relative(workspaceRoot, entryPath).endsWith(suffix)
        ) {
          if (match !== null) return null;
          match = entryPath;
        }
      }
    } finally {
      // The iterator closes on completion. Close explicitly if iteration could not start.
      await entries.close().catch(() => undefined);
    }
  }
  return match;
}

/** Opens a canonical media path once. Replacements cannot change the response's source. */
export const openMediaFile = Effect.fn("openMediaFile")(function* (
  filePath: string,
  identity?: { readonly device: string; readonly inode: string },
) {
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const before = await NodeFSP.lstat(filePath, { bigint: true });
        if (!before.isFile() || before.ino === 0n) return null;
        if (
          identity &&
          (before.dev.toString() !== identity.device || before.ino.toString() !== identity.inode)
        ) {
          return null;
        }

        // Windows lacks these flags; the descriptor/path identity checks still apply.
        const handle = await NodeFSP.open(
          filePath,
          NodeFS.constants.O_RDONLY |
            (NodeFS.constants.O_NOFOLLOW ?? 0) |
            (NodeFS.constants.O_NONBLOCK ?? 0),
        );
        let accepted = false;
        try {
          const info = await handle.stat({ bigint: true });
          if (!info.isFile() || info.dev !== before.dev || info.ino !== before.ino) return null;
          if (
            identity &&
            (info.dev.toString() !== identity.device || info.ino.toString() !== identity.inode)
          ) {
            return null;
          }
          // Callers canonicalise with Effect's FileSystem.realPath, which is
          // Node's JS realpath. fs/promises.realpath is the native binding and
          // on Windows also expands 8.3 short names, so a path that is already
          // canonical by the caller's rules would still look swapped here.
          if ((await realpathLikeFileSystem(filePath)) !== filePath) return null;
          const after = await NodeFSP.lstat(filePath, { bigint: true });
          if (!after.isFile() || info.dev !== after.dev || info.ino !== after.ino) return null;
          accepted = true;
          return { handle, info } satisfies OpenMediaFile;
        } finally {
          if (!accepted) await handle.close();
        }
      },
      catch: (cause) => new MediaFileOpenError({ path: filePath, cause }),
    }),
    (file) => (file ? Effect.promise(() => file.handle.close()) : Effect.void),
  );
});

/** Reads the leading bytes of an already-validated media file, never past the end. */
export const readMediaFileHeader = (filePath: string, file: OpenMediaFile, byteCount: number) =>
  Effect.tryPromise({
    try: async () => {
      const buffer = new Uint8Array(byteCount);
      const { bytesRead } = await file.handle.read(buffer, 0, byteCount, 0);
      return buffer.subarray(0, bytesRead);
    },
    catch: (cause) => new MediaFileReadError({ path: filePath, cause }),
  });

export const statMediaFile = Effect.fn("statMediaFile")(function* (
  filePath: string,
  file: OpenMediaFile,
) {
  return yield* Effect.tryPromise({
    try: () => file.handle.stat({ bigint: true }),
    catch: (cause) => new MediaFileStatError({ path: filePath, cause }),
  });
});

export const streamMediaFile = (file: OpenMediaFile, offset: bigint, bytesToRead: bigint) => {
  const start = Number(offset);
  const end = Number(offset + bytesToRead - 1n);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
    return null;
  }
  return NodeStream.fromReadable<Uint8Array>({
    evaluate: () =>
      file.handle.createReadStream({
        autoClose: false,
        start,
        end,
      }),
  });
};
