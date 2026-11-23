import { describe, expect, it } from "vite-plus/test";

import { buildMenuBarStatus, MENU_BAR_MAX_CHATS, MENU_BAR_MAX_LIMITS } from "./menuBarStatus";

const chat = (index: number, needsYou: boolean, title = `Chat ${index}`) => ({
  environmentId: "env",
  threadId: `thread-${index}`,
  title,
  needsYou,
});

describe("buildMenuBarStatus", () => {
  it("splits chats by whether they need the user and keeps their order", () => {
    const status = buildMenuBarStatus({
      chats: [chat(1, false), chat(2, true), chat(3, false), chat(4, true)],
      limits: [],
      hideTitles: false,
    });
    expect(status.needsYou.map((entry) => entry.threadId)).toEqual(["thread-2", "thread-4"]);
    expect(status.working.map((entry) => entry.threadId)).toEqual(["thread-1", "thread-3"]);
    expect(status.needsYouCount).toBe(2);
    expect(status.workingCount).toBe(2);
  });

  it("caps the lists but reports the full counts", () => {
    const status = buildMenuBarStatus({
      chats: Array.from({ length: 30 }, (_, index) => chat(index, index % 2 === 0)),
      limits: Array.from({ length: 9 }, (_, index) => ({
        accountLabel: "Claude",
        label: `Window ${index}`,
        usedPercent: 10,
        resets: null,
      })),
      hideTitles: false,
    });
    expect(status.needsYou).toHaveLength(MENU_BAR_MAX_CHATS);
    expect(status.needsYouCount).toBe(15);
    expect(status.limits).toHaveLength(MENU_BAR_MAX_LIMITS);
  });

  it("keeps chat titles out while screen-recording privacy is on", () => {
    const status = buildMenuBarStatus({
      chats: [chat(1, true, "Secret launch plan")],
      limits: [],
      hideTitles: true,
    });
    expect(status.needsYou).toEqual([
      { environmentId: "env", threadId: "thread-1", title: "Chat" },
    ]);
  });

  it("writes one plain line per limit", () => {
    const status = buildMenuBarStatus({
      chats: [],
      limits: [
        { accountLabel: "Claude", label: "Weekly", usedPercent: 73.6, resets: "Wed 7:00 AM ET" },
        { accountLabel: "Codex", label: "Weekly", usedPercent: 68, resets: null },
      ],
      hideTitles: false,
    });
    expect(status.limits).toEqual([
      "Claude · Weekly: 74% used, resets Wed 7:00 AM ET",
      "Codex · Weekly: 68% used",
    ]);
  });
});
