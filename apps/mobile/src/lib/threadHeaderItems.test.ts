import { describe, expect, it } from "vite-plus/test";
import {
  filterThreadHeaderItems,
  resolveThreadHeaderItems,
  sanitizeThreadHeaderItems,
  type ThreadHeaderItem,
} from "./threadHeaderItems";

const availableItems: ReadonlyArray<readonly [ThreadHeaderItem, string | null]> = [
  ["files", "files-button"],
  ["git", "git-menu"],
  ["terminal", "terminal-menu"],
  ["sideChat", "side-chat-button"],
];

describe("thread header items", () => {
  it("defaults to side chat and git controls for existing and new devices", () => {
    expect(filterThreadHeaderItems(availableItems, resolveThreadHeaderItems(undefined))).toEqual([
      "git-menu",
      "side-chat-button",
    ]);
  });

  it("preserves platform ordering when files and terminal are enabled", () => {
    expect(
      filterThreadHeaderItems(availableItems, ["terminal", "files", "sideChat", "git"]),
    ).toEqual(["files-button", "git-menu", "terminal-menu", "side-chat-button"]);
  });

  it("returns no placeholders with only one or no shortcuts enabled", () => {
    expect(filterThreadHeaderItems(availableItems, ["terminal"])).toEqual(["terminal-menu"]);
    expect(filterThreadHeaderItems(availableItems, resolveThreadHeaderItems([]))).toEqual([]);
  });

  it("omits unavailable shortcuts even when enabled", () => {
    expect(
      filterThreadHeaderItems(
        [
          ["sideChat", null],
          ["terminal", undefined],
          ["git", "git-menu"],
        ],
        ["sideChat", "terminal", "git"],
      ),
    ).toEqual(["git-menu"]);
  });

  it("deduplicates stored shortcuts and ignores unknown or contextual actions", () => {
    expect(sanitizeThreadHeaderItems(["files", "git", "git", "mergeBack", null, 42])).toEqual([
      "files",
      "git",
    ]);
    expect(sanitizeThreadHeaderItems([])).toEqual([]);
    expect(sanitizeThreadHeaderItems({ files: true })).toBeUndefined();
  });
});
