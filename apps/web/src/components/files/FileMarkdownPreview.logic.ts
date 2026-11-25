import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";

export function resolveFileMarkdownBaseDir(path: string, cwd: string): string {
  const lastSeparator = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  // Keep the separator so a folder ending in a number cannot become a line suffix.
  return lastSeparator < 0 ? cwd : resolvePathLinkTarget(path.slice(0, lastSeparator + 1), cwd);
}
