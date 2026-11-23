import { describe, expect, it } from "vite-plus/test";

import {
  ALL_CHATS_TAB,
  buildChatTabs,
  chatTabShowsThread,
  resolveSelectedChatTab,
} from "./chatTabs.ts";

type Row = {
  environmentId: string;
  id: string;
  source: { chatTab?: { name: string; position: number; manual: boolean } | null };
  status?: "attention" | "working" | null;
};
const row = (
  id: string,
  tab: Row["source"]["chatTab"],
  status: Row["status"] = null,
  env = "mac",
) => ({ environmentId: env, id, source: { chatTab: tab }, status }) as Row;
const build = (rows: Row[]) =>
  buildChatTabs(rows as never[], {
    threadKey: (thread: Row) => `${thread.environmentId}:${thread.id}`,
    status: (thread: Row) => thread.status ?? null,
  });

describe("chat tabs", () => {
  it("shows tabs with two chats or a manual one, merged by name across machines", () => {
    const tabs = build([
      row("a", { name: "Black Hole", position: 1, manual: false }),
      row("b", { name: "black hole", position: 3, manual: false }, "attention", "studio"),
      row("c", { name: "Lonely", position: 0, manual: false }),
      row("d", { name: "Mine", position: 2, manual: true }, "working"),
      row("e", null),
    ]);
    expect(tabs.map((tab) => [tab.name, [...tab.threadKeys], tab.attention, tab.working])).toEqual([
      ["Black Hole", ["mac:a", "studio:b"], true, false],
      ["Mine", ["mac:d"], false, true],
    ]);
    expect(chatTabShowsThread("black hole", tabs, "studio:b")).toBe(true);
    expect(chatTabShowsThread("black hole", tabs, "mac:c")).toBe(false);
    expect(chatTabShowsThread(ALL_CHATS_TAB, tabs, "mac:c")).toBe(true);
    expect(resolveSelectedChatTab("lonely", tabs)).toBe(ALL_CHATS_TAB);
    expect(resolveSelectedChatTab("mine", tabs)).toBe("mine");
  });
});

it("keeps explicit empty servers in tab order and merges their metadata across machines", () => {
  const tabs = buildChatTabs([], {
    threadKey: () => "",
    status: () => null,
    catalog: [
      {
        environmentId: "mac",
        tab: { name: "Build", position: 2, keepEmpty: true, icon: { kind: "emoji", emoji: "🔧" } },
      },
      { environmentId: "studio", tab: { name: "build", position: 3, keepEmpty: true } },
      { environmentId: "mac", tab: { name: "Design", position: 0, keepEmpty: true } },
      { environmentId: "mac", tab: { name: "Unoccupied model tab", position: 1 } },
    ],
  });
  expect(tabs.map((tab) => tab.name)).toEqual(["Design", "Build"]);
  expect(tabs[1]?.icon).toEqual({ kind: "emoji", emoji: "🔧" });
  expect([...tabs[1]!.environmentIds!]).toEqual(["mac", "studio"]);
  expect(chatTabShowsThread(ALL_CHATS_TAB, tabs, "mac:any-chat")).toBe(true);
  expect(chatTabShowsThread("build", tabs, "mac:any-chat")).toBe(false);
});
