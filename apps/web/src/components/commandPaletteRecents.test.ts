import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { CommandPaletteActionItem } from "./CommandPalette.logic";
import { buildRootGroups, filterCommandPaletteGroups } from "./CommandPalette.logic";
import {
  parseRecentPaletteActions,
  readRecentPaletteActions,
  recentPaletteActionItems,
  rememberPaletteAction,
} from "./commandPaletteRecents";

afterEach(() => vi.unstubAllGlobals());

const action = (value: string, run = async () => {}): CommandPaletteActionItem => ({
  kind: "action",
  value,
  title: value,
  searchTerms: [value],
  icon: null,
  run,
});

describe("recent palette actions", () => {
  it("ignores corrupt storage and bounds unique IDs", () => {
    expect(parseRecentPaletteActions("not json")).toEqual([]);
    expect(parseRecentPaletteActions('{"action:theme": true}')).toEqual([]);
    expect(parseRecentPaletteActions('["a",null,12,"a","b",""]')).toEqual(["a", "b"]);
    expect(
      parseRecentPaletteActions(
        JSON.stringify(Array.from({ length: 30 }, (_, index) => `action:${index}`)),
      ),
    ).toHaveLength(12);
  });

  it("moves a repeated action to the front and stores only IDs", () => {
    let raw: string | null = null;
    const setItem = vi.fn((_key: string, value: string) => {
      raw = value;
    });
    vi.stubGlobal("window", { localStorage: { getItem: () => raw, setItem } });
    rememberPaletteAction("action:one");
    rememberPaletteAction("action:two");
    rememberPaletteAction("action:one");
    expect(readRecentPaletteActions()).toEqual(["action:one", "action:two"]);
    expect(raw).toBe('["action:one","action:two"]');
  });

  it("still works when browser storage is unavailable", () => {
    vi.stubGlobal("window", {
      get localStorage() {
        throw new Error("Storage unavailable");
      },
    });
    expect(readRecentPaletteActions()).toEqual([]);
    expect(rememberPaletteAction("action:two", ["action:one"])).toEqual([
      "action:two",
      "action:one",
    ]);
  });

  it("uses current callbacks and omits unavailable or disabled actions", async () => {
    const run = vi.fn(async () => {});
    const recent = recentPaletteActionItems(
      [action("action:toggle", run), { ...action("action:disabled"), disabled: true }],
      ["action:gone", "action:disabled", "action:toggle"],
    );
    expect(recent.map((item) => item.value)).toEqual(["action:toggle"]);
    await recent[0]?.run();
    expect(run).toHaveBeenCalledOnce();
  });

  it("deduplicates resting actions and keeps action-only search complete", () => {
    const first = action("action:one");
    const second = action("action:two");
    const activeGroups = buildRootGroups({
      actionItems: [first, second],
      recentThreadItems: [],
      recentActionItems: [second],
    });
    const filter = (query: string) =>
      filterCommandPaletteGroups({
        activeGroups,
        query,
        isInSubmenu: false,
        projectSearchItems: [],
        threadSearchItems: [],
      });
    expect(filter("").map((group) => [group.value, group.items.map((item) => item.value)])).toEqual(
      [
        ["recent-actions", ["action:two"]],
        ["actions", ["action:one"]],
      ],
    );
    expect(filter(">")[0]?.items).toEqual([first, second]);
    expect(filter("two").flatMap((group) => group.items)).toEqual([second]);
  });
});
