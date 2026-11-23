import { SideChatError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { sideChatErrorMessage } from "./sideChatPresentation";

describe("sideChatErrorMessage", () => {
  it("uses the server's own words for side chat errors", () => {
    expect(sideChatErrorMessage(new SideChatError({ reason: "no-provider-session" }))).toBe(
      "Send a message in this thread first, then open a side chat.",
    );
    expect(sideChatErrorMessage({ _tag: "SideChatError", reason: "busy" })).toBe(
      "Wait for the side chat to answer before sending another message.",
    );
  });

  it("asks for an update when the server does not know the method", () => {
    expect(sideChatErrorMessage(new Error("Unknown request tag: sideChat.open"))).toMatch(
      /doesn't support side chats yet/u,
    );
  });

  it("keeps other failures readable", () => {
    expect(sideChatErrorMessage(new Error("socket closed"))).toBe(
      "Couldn't reach the side chat: socket closed",
    );
    expect(sideChatErrorMessage(undefined)).toBe(
      "Couldn't reach the side chat. Check the connection and try again.",
    );
  });
});
