import type * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";

export const WARM_WORKTREES_DIRECTORY = ".warm-worktrees";
export const LEGACY_PARKED_WORKTREES_DIRECTORY = ".parked";
export const warmWorktreeRecordName = (worktreeName: string) => `${worktreeName}.pool.json`;

/** A recycled checkout keeps its original path so its installed launchers still resolve. */
export function recycledWorktreeRecordName(
  candidate: string,
  worktreesDir: string,
  path: Path.Path,
): string | null {
  const relative = path.relative(worktreesDir, candidate);
  if (
    !relative ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  )
    return null;
  const name = `recycled-${encodeURIComponent(relative)}.pool.json`;
  // Leave room for the sibling temporary name used by an atomic write.
  return name.length <= 230 ? name : null;
}

/** pnpm writes absolute paths into its launchers. A claimed worktree stays at the same path. */
export function isPrivateWorktree(
  candidate: string,
  path: Path.Path,
  fs: FileSystem.FileSystem,
  worktreesDir: string,
): Effect.Effect<boolean> {
  const directory = path.dirname(candidate);
  if (
    path.basename(candidate) === LEGACY_PARKED_WORKTREES_DIRECTORY ||
    path.basename(directory) === LEGACY_PARKED_WORKTREES_DIRECTORY
  )
    return Effect.succeed(true);
  const marker =
    path.basename(directory) === WARM_WORKTREES_DIRECTORY
      ? path.join(directory, warmWorktreeRecordName(path.basename(candidate)))
      : (() => {
          const name = recycledWorktreeRecordName(candidate, worktreesDir, path);
          return name === null ? null : path.join(worktreesDir, WARM_WORKTREES_DIRECTORY, name);
        })();
  return marker === null
    ? Effect.succeed(false)
    : fs.exists(marker).pipe(Effect.orElseSucceed(() => true));
}

/**
 * Directory new worktrees are created under: the `worktreesDirectory`
 * setting (`~` expands to `home`), or `defaultDir` (`<SSHCode home>/worktrees`)
 * when it is empty. Null when
 * the setting is not an absolute path on this machine, such as `D:\worktrees`
 * configured for a Windows server and synced to a Linux one, or when it is a
 * filesystem root, which would make every path on that drive look managed.
 */
export function resolveWorktreesDirectory(
  setting: string,
  defaultDir: string,
  path: Path.Path,
  home: string,
): string | null {
  if (setting === "") return defaultDir;
  const expanded = expandHomePath(setting, home);
  if (!path.isAbsolute(expanded)) return null;
  const resolved = path.resolve(expanded);
  return isFilesystemRoot(resolved, path) ? null : resolved;
}

/** Callers re-check after resolving symlinks: a link can point at a root. */
export function isFilesystemRoot(directory: string, path: Path.Path): boolean {
  return path.dirname(directory) === directory;
}

/** Every directory that holds T3-managed worktrees on this machine. */
export function managedWorktreesDirectories(
  settings: {
    readonly worktreesDirectory: string;
    readonly previousWorktreesDirectories: ReadonlyArray<string>;
  },
  defaultDir: string,
  path: Path.Path,
  home: string,
): ReadonlyArray<string> {
  const directories = new Set([defaultDir]);
  for (const setting of [settings.worktreesDirectory, ...settings.previousWorktreesDirectories]) {
    const directory = resolveWorktreesDirectory(setting, defaultDir, path, home);
    if (directory !== null) directories.add(directory);
  }
  return [...directories];
}
