import { botSendText, botWakeText } from "@t3tools/shared/bots";
import { describe, expect, it } from "vite-plus/test";

import { botInboundLines, botWakeMessageId } from "./botInboundNotes";

describe("bot chat inbound notes", () => {
  it("reads a wake note as one pill per update, with text where there is some", () => {
    const text = botWakeText([
      { kind: "event", threadId: "build", title: "Phone build", event: "finished" },
      { kind: "event", threadId: "tests", title: "Server tests", event: "failed", count: 3 },
      { kind: "message", threadId: "deploy", title: "Deploy", text: "Ready for you to check." },
      { kind: "routine", text: "Morning summary" },
    ]);
    expect(botInboundLines(text)).toEqual([
      { key: "0:build", pill: "Phone build finished", threadId: "build", text: null },
      { key: "1:tests", pill: "Server tests failed (3)", threadId: "tests", text: null },
      { key: "2:deploy", pill: "From Deploy", threadId: "deploy", text: "Ready for you to check." },
      { key: "3:routine", pill: "Missed routine", threadId: null, text: "Morning summary" },
    ]);
  });

  it("reads Send to <bot>… as a note from that chat", () => {
    expect(
      botInboundLines(botSendText({ threadId: "t1", title: "Login bug", note: "Fix it" })),
    ).toEqual([{ key: "0:t1", pill: "From Login bug", threadId: "t1", text: "Fix it" }]);
    expect(botInboundLines(botSendText({ threadId: "t2", title: "Docs" }))?.[0]?.text).toBe(
      "Take a look at this chat.",
    );
  });

  it("leaves ordinary messages alone", () => {
    expect(botInboundLines("What's running right now?")).toBeNull();
    expect(botInboundLines("From the top: please start over")).toBeNull();
  });
});

describe("bot wake notification rows", () => {
  it("finds the wake message a notification row was posted as", () => {
    const messageId = "message:bot:bot-1:24816f83";
    expect(botWakeMessageId(`turn-item:message:${encodeURIComponent(messageId)}`)).toBe(messageId);
    expect(
      botWakeMessageId(`turn-item:message:${encodeURIComponent("message:bot-send:bot-1:x")}`),
    ).toBeNull();
    expect(botWakeMessageId("turn-item:provider:monitor:1")).toBeNull();
  });
});
