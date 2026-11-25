import { describe, expect, it } from "vite-plus/test";

import {
  composerBuiltInSlashRecencyKey,
  composerPathWorkspaceKey,
  composerProviderSlashRecencyKey,
  composerRecentTieBreakerPrefix,
  composerSkillRecencyKey,
  orderByComposerRecentUse,
  parseComposerRecentPaths,
  parseComposerRecentUses,
  recordComposerRecentPath,
  recordComposerRecentUse,
} from "./composerCommandRecency.ts";

describe("composerCommandRecency", () => {
  it("records most-recently-used keys first, dedupes, and bounds size", () => {
    let recent: ReadonlyArray<string> = [];
    recent = recordComposerRecentUse(recent, composerBuiltInSlashRecencyKey("model"), 3);
    recent = recordComposerRecentUse(recent, composerSkillRecencyKey("browser"), 3);
    recent = recordComposerRecentUse(recent, composerProviderSlashRecencyKey("compact"), 3);
    expect(recent).toEqual(["provider-slash:compact", "skill:browser", "slash:model"]);

    // Re-using an existing key promotes it without duplicating.
    recent = recordComposerRecentUse(recent, "slash:model", 3);
    expect(recent).toEqual(["slash:model", "provider-slash:compact", "skill:browser"]);

    // Adding a 4th drops the oldest.
    recent = recordComposerRecentUse(recent, "skill:ui", 3);
    expect(recent).toEqual(["skill:ui", "slash:model", "provider-slash:compact"]);

    // Recording the current head is a no-op returning the same reference.
    expect(recordComposerRecentUse(recent, "skill:ui", 3)).toBe(recent);
  });

  it("parses stored JSON safely and drops invalid or duplicate entries", () => {
    expect(parseComposerRecentUses(null)).toEqual([]);
    expect(parseComposerRecentUses("not json")).toEqual([]);
    expect(parseComposerRecentUses("{}")).toEqual([]);
    expect(parseComposerRecentUses(JSON.stringify(["a", "", 42, "b", "a", "c"]), 2)).toEqual([
      "a",
      "b",
    ]);
  });

  it("orders empty-query items with recent uses first and unused items in default order", () => {
    const items = ["debug", "model", "plan", "default"];
    expect(orderByComposerRecentUse(items, ["plan", "model"], (item) => item)).toEqual([
      "plan",
      "model",
      "debug",
      "default",
    ]);
    expect(orderByComposerRecentUse(items, [], (item) => item)).toEqual(items);
  });

  it("produces tiebreaker prefixes where recent items sort ahead of unused ones", () => {
    expect(composerRecentTieBreakerPrefix(0) < composerRecentTieBreakerPrefix(1)).toBe(true);
    expect(composerRecentTieBreakerPrefix(9) < composerRecentTieBreakerPrefix(10)).toBe(true);
    expect(composerRecentTieBreakerPrefix(10) < composerRecentTieBreakerPrefix(undefined)).toBe(
      true,
    );
  });

  it("tracks recent paths per workspace and bounds both workspaces and paths", () => {
    let map = recordComposerRecentPath({}, "/repo-a", "src/a.ts", 2, 2);
    map = recordComposerRecentPath(map, "/repo-a", "src/b.ts", 2, 2);
    map = recordComposerRecentPath(map, "/repo-a", "src/c.ts", 2, 2);
    expect(map["/repo-a"]).toEqual(["src/c.ts", "src/b.ts"]);

    map = recordComposerRecentPath(map, "/repo-b", "README.md", 2, 2);
    map = recordComposerRecentPath(map, "/repo-c", "package.json", 2, 2);
    expect(Object.keys(map)).toEqual(["/repo-b", "/repo-c"]);
    expect(parseComposerRecentPaths(JSON.stringify(map), 2, 2)).toEqual(map);
  });

  it("scopes workspace path keys by both environmentId and cwd", () => {
    const macKey = composerPathWorkspaceKey("env-mac", "/Users/dev/app");
    const linuxKey = composerPathWorkspaceKey("env-linux", "/Users/dev/app");
    expect(macKey).toBe("env-mac\u0000/Users/dev/app");
    expect(linuxKey).toBe("env-linux\u0000/Users/dev/app");
    expect(macKey).not.toBe(linuxKey);
    expect(composerPathWorkspaceKey(null, "/Users/dev/app")).toBeNull();
    expect(composerPathWorkspaceKey("env-mac", null)).toBeNull();
    expect(composerPathWorkspaceKey("", "/Users/dev/app")).toBeNull();
  });
});
