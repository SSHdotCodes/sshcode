/**
 * The folder a "No project" thread was started in, when the user picked one.
 * Threads started without a folder get their own managed folder directly
 * under the scratch root, which is an implementation detail, so those return
 * null.
 */
export function pickedScratchFolder(
  worktreePath: string | null | undefined,
  scratchWorkspaceRoot: string | null | undefined,
): string | null {
  if (!worktreePath) return null;
  if (!scratchWorkspaceRoot) return worktreePath;
  const normalize = (value: string) => value.replaceAll("\\", "/").replace(/\/+$/, "");
  const root = normalize(scratchWorkspaceRoot);
  const path = normalize(worktreePath);
  return path === root || path.startsWith(`${root}/`) ? null : worktreePath;
}
