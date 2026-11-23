// @effect-diagnostics nodeBuiltinImport:off -- browser downloads use Node filesystem identities.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

/** Download metadata is process-local, so a previous runtime cannot offer these files again. */
export async function sweepCrashDownloads(directory: string): Promise<void> {
  const root = await NodeFSP.lstat(directory).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (root === null || !root.isDirectory() || root.isSymbolicLink()) return;
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/u.test(entry.name)) continue;
    const target = NodePath.join(directory, entry.name);
    const previous = await NodeFSP.lstat(target);
    if (!previous.isDirectory() || previous.isSymbolicLink()) continue;
    const currentRoot = await NodeFSP.lstat(directory);
    const current = await NodeFSP.lstat(target);
    if (
      currentRoot.ino !== root.ino ||
      currentRoot.dev !== root.dev ||
      currentRoot.isSymbolicLink() ||
      current.ino !== previous.ino ||
      current.dev !== previous.dev ||
      current.isSymbolicLink()
    )
      continue;
    await NodeFSP.rm(target, { recursive: true, force: true });
  }
}
