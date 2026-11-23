// @effect-diagnostics nodeBuiltinImport:off -- free space has no Effect FileSystem equivalent.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";

/** Bytes an ordinary process can still write under `directory`; null when it cannot be read. */
export const freeDiskBytes = (directory: string): Effect.Effect<number | null> =>
  Effect.tryPromise(() => NodeFSP.statfs(directory)).pipe(
    Effect.map((disk) => disk.bavail * disk.bsize),
    Effect.orElseSucceed(() => null),
  );
