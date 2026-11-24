import { describe, expect, it } from "vite-plus/test";
import {
  filterThreadHeaderItems,
  resolveThreadHeaderItems,
  sanitizeThreadHeaderItems,
  type ThreadHeaderItem,
} from "./threadHeaderItems";

const availableItems: ReadonlyArray<readonly [ThreadHeaderItem, string | null]> = [
  ["files", "files-button"],
  ["terminal", "terminal-menu"],
  ["sideChat", "side-chat-button"],
];

describe("thread header items", () => {
  it("defaults to side chat alone for existing and new devices", () => {
    expect(filterThreadHeaderItems(availableItems, resolveThreadHeaderItems(undefined))).toEqual([
      "side-chat-button",
    ]);
  });

  it("preserves platform ordering when files and terminal are enabled", () => {
    expect(filterThreadHeaderItems(availableItems, ["terminal", "files", "sideChat"])).toEqual([
      "files-button",
      "terminal-menu",
      "side-chat-button",
    ]);
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
          ["files", "files-button"],
        ],
        ["sideChat", "terminal", "files"],
      ),
    ).toEqual(["files-button"]);
  });

  it("deduplicates stored shortcuts and ignores unknown, retired or contextual actions", () => {
    expect(
      sanitizeThreadHeaderItems(["files", "terminal", "terminal", "git", "mergeBack", null, 42]),
    ).toEqual(["files", "terminal"]);
    expect(sanitizeThreadHeaderItems([])).toEqual([]);
    expect(sanitizeThreadHeaderItems({ files: true })).toBeUndefined();
  });
});
