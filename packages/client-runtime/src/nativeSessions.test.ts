import { describe, expect, it } from "vite-plus/test";
import { terminalHandoffSendBlock } from "./nativeSessions.ts";

describe("Terminal handoff composer state", () => {
  it("blocks sends during both handoff phases and clears the block on return", () => {
    expect(
      terminalHandoffSendBlock({ phase: "handing-off", startedAt: null, unavailableReason: null }),
    ).toBe("Handing this chat to Terminal…");
    expect(
      terminalHandoffSendBlock({
        phase: "in-terminal",
        startedAt: "2026-10-26T19:42:00Z",
        unavailableReason: "Available on the local Mac",
      }),
    ).toBe("This chat is open in Terminal. Bring it back to send here.");
    expect(
      terminalHandoffSendBlock({ phase: "here", startedAt: null, unavailableReason: null }),
    ).toBeNull();
    expect(terminalHandoffSendBlock(null)).toBeNull();
  });
});
