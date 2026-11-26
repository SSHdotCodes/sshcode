import { describe, expect, it, vi } from "@effect/vitest";

import {
  areAllDirectoriesExpanded,
  coalesceReentrantCalls,
  onlyChildren,
  readExpandedDirectories,
  setAllDirectoriesExpanded,
  writeExpandedDirectories,
} from "./fileTreeExpansion";

type FakeDirectoryItem = {
  isDirectory: () => true;
  isExpanded: () => boolean;
  expand: () => void;
  collapse: () => void;
};

function makeModel(expanded: Record<string, boolean>) {
  const items = new Map<string, FakeDirectoryItem>();
  return {
    getItem: (path: string) => {
      const existing = items.get(path);
      if (existing !== undefined) return existing;
      const item: FakeDirectoryItem = {
        isDirectory: () => true,
        isExpanded: () => expanded[path] ?? false,
        expand: () => {
          expanded[path] = true;
        },
        collapse: () => {
          expanded[path] = false;
        },
      };
      items.set(path, item);
      return item;
    },
  };
}

describe("file tree expansion", () => {
  it("identifies a chain of only children and stops at a branch", () => {
    const [root, child, source, first, second] = [
      { path: "src", kind: "directory" },
      { path: "src/core", kind: "directory" },
      { path: "src/core/files", kind: "directory" },
      { path: "src/core/files/a.ts", kind: "file" },
      { path: "src/core/files/b.ts", kind: "file" },
    ] as const;
    const children = onlyChildren([root, child, source, first, second]);
    expect([...children]).toEqual([
      ["", root],
      ["src", child],
      ["src/core", source],
      ["src/core/files", null],
    ]);
  });

  it("requires at least one directory and detects whether all are expanded", () => {
    const model = makeModel({ "src/": true, "test/": true });
    expect(areAllDirectoriesExpanded(model, [])).toBe(false);
    expect(areAllDirectoriesExpanded(model, ["src/", "test/"])).toBe(true);
    expect(
      areAllDirectoriesExpanded(makeModel({ "src/": true, "test/": false }), ["src/", "test/"]),
    ).toBe(false);
  });

  it("expands and collapses every directory", () => {
    const expanded = { "src/": true, "test/": false };
    const model = makeModel(expanded);
    setAllDirectoriesExpanded(model, ["src/", "test/"], true);
    expect(expanded).toEqual({ "src/": true, "test/": true });
    setAllDirectoriesExpanded(model, ["src/", "test/"], false);
    expect(expanded).toEqual({ "src/": false, "test/": false });
  });

  it("skips directories already at the requested state", () => {
    const model = makeModel({ "src/": true });
    const item = model.getItem("src/");
    const collapse = vi.spyOn(item, "collapse");
    setAllDirectoriesExpanded(model, ["src/"], true);
    expect(collapse).not.toHaveBeenCalled();
  });
});

describe("remembered expanded directories", () => {
  it("keeps each root's folders apart and forgets a root left with none open", () => {
    writeExpandedDirectories("env:/repo-a", ["src/", "src/lib/"]);
    writeExpandedDirectories("env:/repo-b", ["docs/"]);
    expect(readExpandedDirectories("env:/repo-a")).toEqual(["src/", "src/lib/"]);
    expect(readExpandedDirectories("env:/repo-b")).toEqual(["docs/"]);

    writeExpandedDirectories("env:/repo-a", []);
    expect(readExpandedDirectories("env:/repo-a")).toEqual([]);
    expect(readExpandedDirectories("env:/repo-b")).toEqual(["docs/"]);
  });

  it("keeps only the most recently used roots", () => {
    for (let index = 0; index < 25; index += 1) {
      writeExpandedDirectories(`env:/worktree-${index}`, ["src/"]);
    }
    expect(readExpandedDirectories("env:/worktree-24")).toEqual(["src/"]);
    expect(readExpandedDirectories("env:/worktree-4")).toEqual([]);
  });
});

describe("coalesceReentrantCalls", () => {
  it("reruns once after a call made from inside instead of nesting", () => {
    // Expanding a folder notifies the tree's subscribers synchronously, which
    // calls the same handler again while it is still running.
    const depths: number[] = [];
    let depth = 0;
    let runs = 0;
    const handler = coalesceReentrantCalls(() => {
      depth += 1;
      depths.push(depth);
      runs += 1;
      if (runs === 1) {
        handler();
        handler();
      }
      depth -= 1;
    });
    handler();
    expect(depths).toEqual([1, 1]);
  });
});

it("keeps the 100 expanded folders nearest the root, so a remount does not list hundreds", () => {
  const deep = Array.from({ length: 150 }, (_, index) => `pkg/mod/d${index}/`);
  writeExpandedDirectories("env:/repo", [...deep, "pkg/mod/", "pkg/"]);
  const restored = readExpandedDirectories("env:/repo");
  expect(restored).toEqual(["pkg/", "pkg/mod/", ...deep.slice(0, 98)]);
});
