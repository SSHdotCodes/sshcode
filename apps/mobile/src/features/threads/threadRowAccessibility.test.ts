import type { MenuAction } from "@react-native-menu/menu";
import { describe, expect, it } from "vite-plus/test";

import {
  threadRowAccessibilityActions,
  threadRowAccessibilityLabel,
} from "./threadRowAccessibility";

describe("thread row accessibility actions", () => {
  const menu: MenuAction[] = [
    { id: "copy-thread-id", title: "Copy thread ID" },
    { id: "share", title: "Share" },
    { id: "settle", title: "Settle" },
    {
      id: "snooze",
      title: "Snooze",
      subactions: [
        { id: "snooze:hour", title: "In 1 hour", subtitle: "11:00 AM" },
        { id: "snooze:custom", title: "Custom…" },
      ],
    },
    { id: "pin", title: "Pin" },
    { id: "rename", title: "Rename" },
    { id: "archive", title: "Archive" },
    { id: "delete", title: "Delete", attributes: { destructive: true } },
  ];

  it("offers routine thread management without requiring a horizontal swipe", () => {
    expect(threadRowAccessibilityActions(menu, true)).toEqual([
      { name: "share", label: "Share" },
      { name: "settle", label: "Settle" },
      { name: "snooze:hour", label: "Snooze, In 1 hour, 11:00 AM" },
      { name: "snooze:custom", label: "Snooze, Custom…" },
      { name: "pin", label: "Pin" },
      { name: "rename", label: "Rename" },
      { name: "archive", label: "Archive" },
    ]);
  });

  it("offers the reverse actions for a snoozed, settled, or pinned thread", () => {
    expect(
      threadRowAccessibilityActions(
        [
          { id: "unsnooze", title: "Wake thread" },
          { id: "unsettle", title: "Un-settle" },
          { id: "unpin", title: "Unpin" },
        ],
        true,
      ).map((action) => action.name),
    ).toEqual(["unsnooze", "unsettle", "unpin"]);
  });

  it("does not expose mutations in a read-only environment", () => {
    expect(threadRowAccessibilityActions(menu, false)).toEqual([]);
  });

  it("includes read markers for permitted connections", () => {
    const readMenu = [
      { id: "mark-read", title: "Mark read" },
      { id: "mark-unread", title: "Mark unread" },
    ];
    expect(threadRowAccessibilityActions(readMenu, true)).toEqual([
      { name: "mark-read", label: "Mark read" },
      { name: "mark-unread", label: "Mark unread" },
    ]);
    expect(threadRowAccessibilityActions(readMenu, false)).toEqual([]);
  });

  it("omits hidden and disabled actions, including disabled submenu descendants", () => {
    expect(
      threadRowAccessibilityActions(
        [
          { id: "pin", title: "Pin", attributes: { disabled: true } },
          { id: "archive", title: "Archive", attributes: { hidden: true } },
          { id: "share", title: "Share", attributes: { disabled: true } },
          { ...menu[3]!, attributes: { disabled: true } },
          { id: "rename", title: "Rename" },
        ],
        true,
      ),
    ).toEqual([{ name: "rename", label: "Rename" }]);
  });
});

describe("spoken thread state", () => {
  const ready = {
    title: "Fix the toolbar",
    status: "ready" as const,
    goalActive: false,
    unread: false,
    queued: false,
    pinned: false,
    settled: false,
    snoozed: false,
  };

  it("includes state that otherwise exists only in row icons and shelves", () => {
    expect(
      threadRowAccessibilityLabel({
        ...ready,
        unread: true,
        queued: true,
        pinned: true,
        settled: true,
        snoozed: true,
        wakeLabel: "Tomorrow 9:00 AM",
        pullRequestLabel: "Pull request 42, open",
      }),
    ).toBe(
      "Fix the toolbar, Ready, Unread, Messages queued to send, Pinned, Settled, Snoozed, Tomorrow 9:00 AM, Pull request 42, open",
    );
  });

  it.each([
    ["approval", "Approval needed"],
    ["input", "Waiting for your input"],
    ["limited", "Usage limit reached"],
    ["failed", "Failed"],
    ["waiting", "Waiting"],
  ] as const)("explains %s without relying on a badge", (status, spoken) => {
    expect(threadRowAccessibilityLabel({ ...ready, status })).toBe(`Fix the toolbar, ${spoken}`);
  });

  it("speaks the waiting detail and gives connection state priority", () => {
    const waitingLabel = "Waiting on 3 monitors";
    expect(threadRowAccessibilityLabel({ ...ready, waitingLabel })).toBe(
      "Fix the toolbar, Waiting on 3 monitors",
    );
    expect(threadRowAccessibilityLabel({ ...ready, waitingLabel, status: "reconnecting" })).toBe(
      "Fix the toolbar, Reconnecting",
    );
  });

  it("distinguishes a running goal without announcing a completed goal as working", () => {
    expect(threadRowAccessibilityLabel({ ...ready, status: "working", goalActive: true })).toBe(
      "Fix the toolbar, Working toward goal",
    );
    expect(threadRowAccessibilityLabel({ ...ready, goalActive: true })).toBe(
      "Fix the toolbar, Ready",
    );
  });

  it("names a local ACP instance that shares the fallback glyph", () => {
    expect(threadRowAccessibilityLabel({ ...ready, providerName: "Local Agent" })).toBe(
      "Fix the toolbar, Local Agent, Ready",
    );
  });

  it("does not announce an outdated wake time for an awake thread", () => {
    expect(threadRowAccessibilityLabel({ ...ready, wakeLabel: "Yesterday" })).toBe(
      "Fix the toolbar, Ready",
    );
  });

  it.each([
    ["1m", "1 minute"],
    ["45m", "45 minutes"],
    ["1h", "1 hour"],
    ["3h", "3 hours"],
    ["1d", "1 day"],
    ["2d", "2 days"],
  ])("speaks the abbreviated wake time %s in full", (wakeLabel, spoken) => {
    expect(threadRowAccessibilityLabel({ ...ready, snoozed: true, wakeLabel })).toBe(
      `Fix the toolbar, Ready, Snoozed, wakes in ${spoken}`,
    );
  });
});
