import { describe, expect, it } from "vite-plus/test";

import { liveSubagentThreadId, shouldOverlaySubagentStatus } from "./subagentLiveStatus";

describe("live subagent status", () => {
  it("follows the thread on screen when every card is local", () => {
    expect(
      liveSubagentThreadId([
        { visibility: "local", threadId: "thread-a" },
        { visibility: "local", threadId: "thread-a" },
      ]),
    ).toBe("thread-a");
  });

  it("does not subscribe to the source chat for an inherited card", () => {
    const members = [
      { visibility: "inherited" as const, threadId: "thread-source", subagentId: "agent-1" },
    ];
    expect(liveSubagentThreadId(members)).toBeNull();
    expect(shouldOverlaySubagentStatus(members[0]!, null)).toBe(false);
  });

  it("overlays a local card from this chat and leaves an inherited one on its snapshot", () => {
    const liveThreadId = liveSubagentThreadId([
      { visibility: "local", threadId: "thread-here" },
      { visibility: "inherited", threadId: "thread-source" },
    ]);

    expect(liveThreadId).toBe("thread-here");
    expect(
      shouldOverlaySubagentStatus({ visibility: "local", threadId: "thread-here" }, liveThreadId),
    ).toBe(true);
    expect(
      shouldOverlaySubagentStatus(
        { visibility: "inherited", threadId: "thread-source" },
        liveThreadId,
      ),
    ).toBe(false);
  });

  it("stays on the snapshot when one group mixes two local threads", () => {
    expect(
      liveSubagentThreadId([
        { visibility: "local", threadId: "thread-a" },
        { visibility: "local", threadId: "thread-b" },
      ]),
    ).toBeNull();
  });
});
