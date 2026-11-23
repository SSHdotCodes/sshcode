import { SideChatError, SideChatId, ThreadId, type SideChatState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  sideChatIsBusy,
  sideChatErrorMessage,
  sideChatVisibleMessages,
  SIDE_CHAT_QUOTE_MAX_CHARS,
  sideChatPromptAbout,
  splitSideChatQuote,
} from "./sideChat.logic";

const state = (overrides: Partial<SideChatState> = {}): SideChatState => ({
  sideChatId: SideChatId.make("side-1"),
  threadId: ThreadId.make("thread-1"),
  kind: "btw",
  status: "running",
  messages: [],
  error: null,
  ...overrides,
});

describe("sideChatErrorMessage", () => {
  it("uses the side chat error's own copy", () => {
    expect(sideChatErrorMessage(new SideChatError({ reason: "no-provider-session" }))).toBe(
      "Send a message in this thread first, then open a side chat.",
    );
  });

  it("explains a server that does not know the side chat RPC", () => {
    expect(sideChatErrorMessage("Unknown request tag: sideChat.open")).toBe(
      "This server doesn't support side chats.",
    );
  });

  it("falls back to a generic message", () => {
    expect(sideChatErrorMessage(undefined)).toBe("The side chat failed.");
    expect(sideChatErrorMessage(new Error("socket closed"))).toBe("socket closed");
  });
});

describe("side chat display", () => {
  it("shows the question while the side chat starts", () => {
    const messages = sideChatVisibleMessages(null, "what changed?");
    expect(messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "what changed?"],
    ]);
    expect(sideChatIsBusy(null)).toBe(true);
  });

  it("keeps the header busy while an answer streams and clears it when the turn ends", () => {
    const answering = state({
      messages: [
        { id: "q", role: "user", text: "why?", status: "complete", activities: [] },
        { id: "a", role: "assistant", text: "Because", status: "streaming", activities: [] },
      ],
    });
    expect(sideChatIsBusy(answering)).toBe(true);

    const idle = state({ status: "idle", messages: answering.messages.slice(0, 1) });
    expect(sideChatIsBusy(idle)).toBe(false);
  });
});

describe("a side question about selected text", () => {
  it("quotes the selection above the question and splits it back for display", () => {
    const prompt = sideChatPromptAbout("first line\nsecond line", "what does this mean?");
    expect(prompt).toBe(
      "About this part of your answer:\n> first line\n> second line\n\nwhat does this mean?",
    );
    expect(splitSideChatQuote(prompt)).toEqual({
      quote: "first line\nsecond line",
      question: "what does this mean?",
    });
  });

  it("sends a plain question as is", () => {
    expect(sideChatPromptAbout(null, "why?")).toBe("why?");
    expect(sideChatPromptAbout("   ", "why?")).toBe("why?");
    expect(splitSideChatQuote("why?")).toEqual({ quote: null, question: "why?" });
    // A question that only looks like a quote is left alone.
    const lookalike = "About this part of your answer:\n> a\nno blank line";
    expect(splitSideChatQuote(lookalike)).toEqual({ quote: null, question: lookalike });
  });

  it("cuts a very long selection", () => {
    const prompt = sideChatPromptAbout("x".repeat(SIDE_CHAT_QUOTE_MAX_CHARS + 50), "why?");
    expect(splitSideChatQuote(prompt).quote).toBe(`${"x".repeat(SIDE_CHAT_QUOTE_MAX_CHARS)}…`);
  });
});
