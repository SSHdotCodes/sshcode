import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadShellFixture } from "../../test-fixtures";
import type { ThreadListV2ListItem } from "../threads/threadListV2";
import {
  buildSessionBoxListItems,
  homeListItemsAreEqual,
  matchExcerpt,
  resolveSessionBoxMenuActions,
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

  it("changes box-row signature when mascot provider/model, title, or connection status changes", () => {
    const now = Date.parse("2026-10-23T12:00:00.000Z");
    const rowFor = (
      overrides: Parameters<typeof makeThreadShellFixture>[0],
      options?: Pick<Parameters<typeof buildSessionBoxListItems>[0], "connectionPhases" | "search">,
    ) => {
      const items = buildSessionBoxListItems({
        columns: 2,
        now,
        items: [threadItem("chat-1", overrides)],
        ...options,
      });
      return items.find((item) => item.type === "box-row")!;
    };

    const baseline = rowFor({
      title: "Fix sidebar layout bug",
      modelSelection: {
        instanceId: "codex" as never,
        model: "gpt-5.4",
      },
    });
    const switchedModel = rowFor({
      title: "Fix sidebar layout bug",
      modelSelection: {
        instanceId: "claude" as never,
        model: "claude-opus-4-6",
      },
    });
    const renamedSameLabel = rowFor({
      title: "Fix sidebar layout bug!",
      modelSelection: {
        instanceId: "codex" as never,
        model: "gpt-5.4",
      },
    });
    const switchedRuntime = rowFor({
      title: "Fix sidebar layout bug",
      modelSelection: {
        instanceId: "codex" as never,
        model: "gpt-5.4",
      },
      runtime: {
        providerInstanceId: "claude" as never,
        sessionStatus: "ready",
        status: "idle",
      } as never,
    });
    const searchOnline = rowFor(
      {
        title: "Fix sidebar layout bug",
        runtime: {
          status: "running",
          sessionStatus: "running",
          providerInstanceId: "codex" as never,
        } as never,
        modelSelection: {
          instanceId: "codex" as never,
          model: "gpt-5.4",
        },
      },
      {
        search: { query: "sidebar", snippetFor: () => "sidebar layout details" },
      },
    );
    const searchOffline = rowFor(
      {
        title: "Fix sidebar layout bug",
        runtime: {
          status: "running",
          sessionStatus: "running",
          providerInstanceId: "codex" as never,
        } as never,
        modelSelection: {
          instanceId: "codex" as never,
          model: "gpt-5.4",
        },
      },
      {
        connectionPhases: new Map([[baseline.entries[0]!.thread.environmentId, "reconnecting"]]),
        search: { query: "sidebar", snippetFor: () => "sidebar layout details" },
      },
    );

    expect(homeListItemsAreEqual(baseline, switchedModel)).toBe(false);
    expect(homeListItemsAreEqual(baseline, switchedRuntime)).toBe(false);
    expect(homeListItemsAreEqual(baseline, renamedSameLabel)).toBe(false);
    expect(homeListItemsAreEqual(searchOnline, searchOffline)).toBe(false);
  });

  it("exposes Unsettle for settled boxes, Unsnooze for snoozed boxes, and respects capabilities", () => {
    const allSupported = {
      pinningSupported: true,
      settlementSupported: true,
      snoozeSupported: true,
    };
    expect(
      resolveSessionBoxMenuActions(
        { pinned: false, settled: false, snoozed: false },
        allSupported,
      ).map((action) => action.label),
    ).toEqual(["Open", "Pin", "Settle", "Rename", "Archive"]);

    expect(
      resolveSessionBoxMenuActions(
        { pinned: true, settled: true, snoozed: false },
        allSupported,
      ).map((action) => action.label),
    ).toEqual(["Open", "Unpin", "Unsettle", "Rename", "Archive"]);

    expect(
      resolveSessionBoxMenuActions(
        { pinned: false, settled: false, snoozed: true },
        allSupported,
      ).map((action) => action.label),
    ).toEqual(["Open", "Pin", "Unsnooze", "Rename", "Archive"]);

    expect(
      resolveSessionBoxMenuActions(
        { pinned: false, settled: false, snoozed: false },
        { pinningSupported: false, settlementSupported: false, snoozeSupported: false },
      ).map((action) => action.label),
    ).toEqual(["Open", "Rename", "Archive"]);
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
