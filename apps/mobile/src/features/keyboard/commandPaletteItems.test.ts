import { describe, expect, it } from "vite-plus/test";

import {
  filterCommandPaletteItems,
  nextPaletteIndex,
  type CommandPaletteItem,
} from "./commandPaletteItems";

function item(
  key: string,
  title: string,
  kind: CommandPaletteItem["kind"],
  searchTerms: string[] = [],
): CommandPaletteItem {
  return { key, title, kind, searchTerms, run: () => {} };
}

const items = [
  item("new", "New thread in…", "action", ["project", "create"]),
  item("settings", "Open settings", "action", ["preferences"]),
  item("project", "Mobile app", "project", ["/workspaces/mobile", "new thread"]),
  item("siva:one", "Keyboard shortcuts", "thread", ["Mobile app", "Siva"]),
  item("mac:one", "Mobile app", "thread", ["Mac"]),
];
const emptyMatches = new Map();

describe("filterCommandPaletteItems", () => {
  it("shows actions and recent threads in their original order when the query is empty", () => {
    expect(filterCommandPaletteItems(items, "", emptyMatches).map((item) => item.key)).toEqual([
      "new",
      "settings",
      "siva:one",
      "mac:one",
    ]);
  });

  it("matches query tokens across titles and metadata and ranks exact titles first", () => {
    expect(
      filterCommandPaletteItems(items, " MOBILE app ", emptyMatches).map((item) => item.key),
    ).toEqual(["project", "mac:one", "siva:one"]);
    expect(
      filterCommandPaletteItems(items, "siva keyboard", emptyMatches).map((item) => item.key),
    ).toEqual(["siva:one"]);
  });

  it("supports the desktop actions-only prefix and action aliases", () => {
    expect(filterCommandPaletteItems(items, ">", emptyMatches).map((item) => item.key)).toEqual([
      "new",
      "settings",
    ]);
    expect(
      filterCommandPaletteItems(items, "> preferences", emptyMatches).map((item) => item.key),
    ).toEqual(["settings"]);
    expect(
      filterCommandPaletteItems(items, "> new thread", emptyMatches).map((item) => item.key),
    ).toEqual(["new"]);
  });

  it("includes server content matches scoped to the correct environment, except in actions-only mode", () => {
    const matches = new Map([
      ["siva:one", {}],
      ["project", {}],
    ]);
    expect(
      filterCommandPaletteItems(items, "message content", matches).map((item) => item.key),
    ).toEqual(["siva:one"]);
    expect(filterCommandPaletteItems(items, "> message content", matches)).toEqual([]);
  });
});

describe("nextPaletteIndex", () => {
  it("wraps arrow navigation in both directions and handles empty results", () => {
    expect(nextPaletteIndex(0, -1, 3)).toBe(2);
    expect(nextPaletteIndex(2, 1, 3)).toBe(0);
    expect(nextPaletteIndex(0, 1, 3)).toBe(1);
    expect(nextPaletteIndex(0, -1, 0)).toBe(0);
    expect(nextPaletteIndex(0, 1, 0)).toBe(0);
  });
});

it("ranks chats about BetterWright first and uses activity inside both tiers", () => {
  const results = filterCommandPaletteItems(
    [
      {
        ...item("fifteen-minutes", "Earlier discussion", "thread"),
        activityAt: "2026-11-27T11:45:00.000Z",
      },
      {
        ...item("old-title", "Review and Fix BetterWright Issues", "thread"),
        activityAt: "2026-10-20T12:00:00.000Z",
      },
      {
        ...item("wanted", "Review Pi Prompt Parts Change", "thread"),
        activityAt: "2026-11-25T12:00:00.000Z",
      },
      item("nine-minutes", "Recent discussion", "thread"),
    ],
    "betterwright",
    new Map([
      ["wanted", { about: true }],
      ["fifteen-minutes", { about: false }],
      ["nine-minutes", { about: false, activityAt: "2026-11-27T11:51:00.000Z" }],
    ]),
  );
  expect(results.map((row) => row.key)).toEqual([
    "wanted",
    "old-title",
    "nine-minutes",
    "fifteen-minutes",
  ]);
});
