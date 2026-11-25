export const SMALL_DIFF_AUTO_EXPAND_MAX_FILES = 12;
export const SMALL_DIFF_AUTO_EXPAND_MAX_LINES = 400;

export function shouldDefaultCollapseDiffFiles(input: {
  readonly diffFilesCollapsed: boolean;
  readonly fileCount: number;
  readonly changedLineCount: number;
  readonly truncated?: boolean;
}): boolean {
  if (!input.diffFilesCollapsed) return false;
  if (input.truncated) return true;
  return (
    input.fileCount > SMALL_DIFF_AUTO_EXPAND_MAX_FILES ||
    input.changedLineCount > SMALL_DIFF_AUTO_EXPAND_MAX_LINES
  );
}

export function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}

export function toggleAllDiffFiles(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  return areAllDiffFilesCollapsed(fileKeys, collapsedFileKeys) ? new Set() : new Set(fileKeys);
}
