import { describe, expect, it } from "vite-plus/test";

import {
  areAllDiffFilesCollapsed,
  shouldDefaultCollapseDiffFiles,
  SMALL_DIFF_AUTO_EXPAND_MAX_FILES,
  SMALL_DIFF_AUTO_EXPAND_MAX_LINES,
  toggleAllDiffFiles,
} from "./diffCollapse";

const FILE_KEYS = ["src/app.ts", "src/index.ts"];
const FIRST_FILE_KEY = FILE_KEYS[0]!;

describe("diff collapse controls", () => {
  it("reports whether every rendered file is collapsed", () => {
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set(FILE_KEYS))).toBe(true);
    expect(areAllDiffFilesCollapsed(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toBe(false);
    expect(areAllDiffFilesCollapsed([], new Set())).toBe(false);
  });

  it("collapses all files when any rendered file is expanded", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, new Set([FIRST_FILE_KEY]))).toEqual(new Set(FILE_KEYS));
  });

  it("expands all files when every rendered file is collapsed", () => {
    expect(toggleAllDiffFiles(FILE_KEYS, new Set(FILE_KEYS))).toEqual(new Set());
  });

  it("expands small diffs by default even when diffFilesCollapsed is enabled", () => {
    expect(
      shouldDefaultCollapseDiffFiles({
        diffFilesCollapsed: true,
        fileCount: 2,
        changedLineCount: 11,
      }),
    ).toBe(false);
    expect(
      shouldDefaultCollapseDiffFiles({
        diffFilesCollapsed: true,
        fileCount: SMALL_DIFF_AUTO_EXPAND_MAX_FILES,
        changedLineCount: SMALL_DIFF_AUTO_EXPAND_MAX_LINES,
      }),
    ).toBe(false);
  });

  it("keeps larger or truncated diffs collapsed when diffFilesCollapsed is enabled", () => {
    expect(
      shouldDefaultCollapseDiffFiles({
        diffFilesCollapsed: true,
        fileCount: SMALL_DIFF_AUTO_EXPAND_MAX_FILES + 1,
        changedLineCount: 50,
      }),
    ).toBe(true);
    expect(
      shouldDefaultCollapseDiffFiles({
        diffFilesCollapsed: true,
        fileCount: 3,
        changedLineCount: SMALL_DIFF_AUTO_EXPAND_MAX_LINES + 1,
      }),
    ).toBe(true);
    expect(
      shouldDefaultCollapseDiffFiles({
        diffFilesCollapsed: true,
        fileCount: 2,
        changedLineCount: 20,
        truncated: true,
      }),
    ).toBe(true);
  });

  it("never collapses by default when diffFilesCollapsed is disabled", () => {
    expect(
      shouldDefaultCollapseDiffFiles({
        diffFilesCollapsed: false,
        fileCount: 50,
        changedLineCount: 5000,
        truncated: true,
      }),
    ).toBe(false);
  });
});
