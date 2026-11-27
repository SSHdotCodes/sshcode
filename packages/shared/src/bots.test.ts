import { describe, expect, it } from "vite-plus/test";

import { botSendText, botWakeSummary, botWakeText, parseBotSend, parseBotWake } from "./bots.ts";

describe("bot wake notes", () => {
  const items = [
    {
      kind: "event",
      threadId: "t-1",
      title: "Phone build",
      event: "finished",
      detail: "All checks passed.",
    },
    { kind: "event", threadId: "t-2", title: "Server tests", event: "failed", count: 3 },
    { kind: "event", threadId: "t-3", title: "Docs [draft]", event: "question" },
    { kind: "message", threadId: "t-4", title: "API chat", text: "Need a name\nfor the endpoint." },
    { kind: "routine", text: "Tell me what happened overnight" },
  ] as const;

  it("round-trips every item kind", () => {
    const text = botWakeText(items);
    expect(text.split("\n")).toHaveLength(6);
    expect(parseBotWake(text)).toEqual([
      items[0],
      items[1],
      { ...items[2], title: "Docs draft" },
      { ...items[3], text: "Need a name for the endpoint." },
      items[4],
    ]);
  });

  it("summarizes in one line", () => {
    expect(botWakeSummary(items.slice(0, 2))).toBe(
      "Updates: Phone build finished · Server tests failed (3)",
    );
  });

  it("ignores text that is not a note", () => {
    expect(parseBotWake("Updates: hello")).toBeNull();
    expect(parseBotSend("hello")).toBeNull();
  });

  it("reads a Send to bot message", () => {
    expect(
      parseBotSend(botSendText({ threadId: "t-9", title: "Release", note: "Watch it" })),
    ).toEqual({ threadId: "t-9", title: "Release", note: "Watch it" });
  });
});
