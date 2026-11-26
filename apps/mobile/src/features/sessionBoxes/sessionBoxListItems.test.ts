import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import type { ThreadListV2ListItem } from "../threads/threadListV2";
import {
  buildSessionBoxListItems,
  homeListItemsAreEqual,
  matchExcerpt,
} from "./sessionBoxListItems";

function threadItem(
  id: string,
  overrides: Parameters<typeof makeThreadShellFixture>[0] = {},
  pinned = false,
): ThreadListV2ListItem {
  const thread = makeThreadShellFixture({
    id: ThreadId.make(id),
    title: `Chat ${id}`,
    ...overrides,
  });
  return {
    type: "v2-thread",
    key: `v2-thread:${id}`,
    item: { thread, snoozed: false, pinned },
    snoozeWakeLabelText: undefined,
    timeLabel: "",
    showTrailingDivider: false,
    hasQueuedMessages: false,
    canMoveUp: false,
    canMoveDown: false,
    face: undefined,
  };
}

describe("buildSessionBoxListItems", () => {
  it("groups chats into pinned, needs you, working and recent rows", () => {
    const items = buildSessionBoxListItems({
      columns: 2,
      now: Date.parse("2026-10-23T12:00:00.000Z"),
      items: [
        threadItem("pinned", {}, true),
        threadItem("asking", { hasPendingUserInput: true }),
        threadItem("quiet-1"),
        threadItem("quiet-2"),
        threadItem("quiet-3"),
      ],
    });
    expect(items.map((item) => (item.type === "box-heading" ? item.label : item.type))).toEqual([
      "Pinned",
      "box-row",
      "Needs you",
      "box-row",
      "Recent",
      "box-row",
      "box-row",
    ]);
    const lastRow = items.at(-1);
    expect(lastRow?.type === "box-row" ? lastRow.entries.length : 0).toBe(1);
  });

  it("keeps shelf headers and puts their chats in rows below them", () => {
    const shelf: ThreadListV2ListItem = {
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      count: 1,
      expanded: true,
      disabled: false,
      searchExpanded: false,
    };
    const items = buildSessionBoxListItems({
      columns: 3,
      now: Date.parse("2026-10-23T12:00:00.000Z"),
      items: [threadItem("live"), shelf, threadItem("settled")],
    });
    expect(items.map((item) => item.type)).toEqual([
      "box-heading",
      "box-row",
      "v2-settled-shelf",
      "box-row",
    ]);
    expect(homeListItemsAreEqual(items[1]!, items[1]!)).toBe(true);
    expect(homeListItemsAreEqual(items[1]!, items[3]!)).toBe(false);
  });

  it("keeps matches as boxes in one group while searching, showing where they matched", () => {
    const items = buildSessionBoxListItems({
      columns: 3,
      now: Date.parse("2026-10-23T12:00:00.000Z"),
      items: [
        threadItem("pinned", {}, true),
        threadItem("asking", { hasPendingUserInput: true }),
        threadItem("quiet"),
      ],
      search: {
        query: "boxes",
        snippetFor: (thread) =>
          thread.id === "quiet" ? "the agent then rebuilt the session boxes grid" : null,
      },
    });
    expect(items.map((item) => (item.type === "box-heading" ? item.label : item.type))).toEqual([
      "Results",
      "box-row",
    ]);
    const row = items[1];
    expect(row?.type === "box-row" ? row.entries.map((entry) => entry.match) : []).toEqual([
      null,
      null,
      "…session boxes grid",
    ]);
  });
});

describe("matchExcerpt", () => {
  it("starts a long snippet just before the match", () => {
    expect(matchExcerpt("short boxes", "boxes")).toBe("short boxes");
    expect(matchExcerpt("a long run of words before the painted   boxes here", "BOXES")).toBe(
      "…painted boxes here",
    );
  });
});
