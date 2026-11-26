import { assert, describe, it } from "vite-plus/test";

import { getProjectFilePickerMatches, groupMatchRanges } from "./ProjectFilePicker.logic";

function pathsForQuery(entries: Parameters<typeof getProjectFilePickerMatches>[0], query: string) {
  return getProjectFilePickerMatches(entries, query).map(({ name, path }) => ({ name, path }));
}

const entries = [
  { kind: "directory", path: "apps/web/src" },
  { kind: "file", path: "apps/web/src/index.ts" },
  { kind: "file", path: "packages/shared/src/index.ts" },
  { kind: "file", path: "README.md" },
  { kind: "file", path: ".gitignore" },
] as const;

describe("getProjectFilePickerMatches", () => {
  it("returns files only and preserves index order for an empty query", () => {
    assert.deepEqual(pathsForQuery(entries, ""), [
      { name: "index.ts", path: "apps/web/src/index.ts" },
      { name: "index.ts", path: "packages/shared/src/index.ts" },
      { name: "README.md", path: "README.md" },
      { name: ".gitignore", path: ".gitignore" },
    ]);
  });

  it("preserves the server result order", () => {
    assert.deepEqual(pathsForQuery(entries, "index"), [
      { name: "index.ts", path: "apps/web/src/index.ts" },
      { name: "index.ts", path: "packages/shared/src/index.ts" },
      { name: "README.md", path: "README.md" },
      { name: ".gitignore", path: ".gitignore" },
    ]);
  });

  it("supports space-separated path tokens and a result limit", () => {
    assert.deepEqual(
      getProjectFilePickerMatches(entries, "src index", 1).map(({ name, path }) => ({
        name,
        path,
      })),
      [{ name: "index.ts", path: "apps/web/src/index.ts" }],
    );
  });

  it("matches ordered characters while allowing skipped characters", () => {
    const fuzzyEntries = [
      { kind: "file", path: "src/TestFlags.tsx" },
      { kind: "file", path: "src/SubtestFlow.tsx" },
      { kind: "file", path: "src/useSubtestFlags.ts" },
      {
        kind: "file",
        path: "src/useSubtestFlags/useTabActivity.ts",
      },
    ] as const;

    assert.deepEqual(
      pathsForQuery(fuzzyEntries, "testf").map(({ name }) => name),
      ["TestFlags.tsx", "SubtestFlow.tsx", "useSubtestFlags.ts", "useTabActivity.ts"],
    );
    assert.deepEqual(getProjectFilePickerMatches(fuzzyEntries, "tsfl")[0], {
      name: "TestFlags.tsx",
      nameMatchIndices: [0, 2, 4, 5],
      path: "src/TestFlags.tsx",
      pathMatchIndices: [4, 6, 8, 9],
    });
  });

  it("uses the first ordered subsequence for highlighting", () => {
    assert.deepEqual(
      getProjectFilePickerMatches([{ kind: "file", path: "aabba" }], "aba")[0]?.nameMatchIndices,
      [0, 2, 4],
    );
  });

  it("normalizes path prefixes consistently with server search", () => {
    assert.deepEqual(
      getProjectFilePickerMatches([{ kind: "file", path: "src/index.ts" }], "@/src")[0]
        ?.pathMatchIndices,
      [0, 1, 2],
    );
  });

  it("maps highlights back to original characters when lowercasing expands them", () => {
    const entries = [{ kind: "file", path: "icons/İ-logo.svg" }] as const;
    const indices = (query: string) => {
      const match = getProjectFilePickerMatches(entries, query)[0];
      return [match?.nameMatchIndices, match?.pathMatchIndices];
    };

    assert.deepEqual(indices("logo"), [
      [2, 3, 4, 5],
      [8, 9, 10, 11],
    ]);
    assert.deepEqual(indices("İ"), [[0], [0, 6]]);
  });

  it("matches emoji by code point without splitting surrogate pairs", () => {
    const match = getProjectFilePickerMatches([{ kind: "file", path: "notes/📁-🔥.md" }], "🔥")[0];

    assert.deepEqual(match, {
      name: "📁-🔥.md",
      nameMatchIndices: [3, 4],
      path: "notes/📁-🔥.md",
      pathMatchIndices: [9, 10],
    });
  });

  it("maps emoji highlights accurately when lowercasing expands earlier characters", () => {
    const entries = [{ kind: "file", path: "notes/İ-📁-🔥.md" }] as const;

    assert.deepEqual(getProjectFilePickerMatches(entries, "🔥")[0], {
      name: "İ-📁-🔥.md",
      nameMatchIndices: [5, 6],
      path: "notes/İ-📁-🔥.md",
      pathMatchIndices: [11, 12],
    });
    assert.deepEqual(getProjectFilePickerMatches(entries, "İ🔥m")[0], {
      name: "İ-📁-🔥.md",
      nameMatchIndices: [0, 5, 6, 8],
      path: "notes/İ-📁-🔥.md",
      pathMatchIndices: [6, 11, 12, 14],
    });
  });
});

describe("groupMatchRanges", () => {
  it("groups contiguous indices into [start, end) ranges", () => {
    assert.deepEqual(groupMatchRanges([0, 1]), [[0, 2]]);
    assert.deepEqual(groupMatchRanges([0, 2, 4, 5]), [
      [0, 1],
      [2, 3],
      [4, 6],
    ]);
    assert.deepEqual(groupMatchRanges([]), []);
  });
});
