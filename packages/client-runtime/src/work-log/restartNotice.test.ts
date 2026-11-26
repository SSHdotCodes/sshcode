import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import { resumedRestartNoticeIds } from "./restartNotice.ts";

const notice = (runId: string) => ({
  item: {
    type: "system_notice",
    id: `turn-item:run:${runId}:signal:server-restart`,
    runId,
    message: "The server shut down before this turn finished.",
  },
});
// As stored: the resume is a notification row whose id encodes its message id.
const resumed = (runId: string) => ({
  item: {
    type: "notification",
    id: `turn-item:message:${encodeURIComponent(`message:restart-continuation:${runId}`)}`,
    runId: "next",
  },
});

describe("resumedRestartNoticeIds", () => {
  it("hides the shutdown notice of a turn SSHCode resumed and keeps one left cut", () => {
    const items = [
      notice("run:thread:t:ordinal:1"),
      resumed("run:thread:t:ordinal:1"),
      notice("run-b"),
    ] as never;
    expect([...resumedRestartNoticeIds(items)]).toEqual([
      "turn-item:run:run:thread:t:ordinal:1:signal:server-restart",
    ]);
  });

  it("hides a notice when a queued wake carried the chat on right after the restart", () => {
    const at = (second: number) =>
      DateTime.makeUnsafe(Date.UTC(2026, 10, 25, 18, 26) + second * 1000);
    const cut = (ordinal: number, second: number) => ({
      item: { ...notice("run-1").item, ordinal, updatedAt: at(second), startedAt: at(second) },
    });
    const wake = (runId: string, ordinal: number, second: number) => ({
      item: {
        type: "notification",
        id: `turn-item:message:${encodeURIComponent("message:secret-request-answer:x")}`,
        runId,
        ordinal,
        startedAt: at(second),
        updatedAt: at(second),
      },
    });
    const userMessage = (ordinal: number, second: number) => ({
      item: {
        type: "user_message",
        id: "m",
        messageId: "m",
        runId: "run-2",
        ordinal,
        startedAt: at(second),
      },
    });
    const id = "turn-item:run:run-1:signal:server-restart";
    expect([
      ...resumedRestartNoticeIds([cut(1_000_033, 0), wake("run-2", 2_000_001, 15)] as never),
    ]).toEqual([id]);
    // A later message of yours, or a wake hours later, leaves the cut turn's notice.
    expect([
      ...resumedRestartNoticeIds([cut(1_000_033, 0), userMessage(2_000_001, 15)] as never),
    ]).toEqual([]);
    expect([
      ...resumedRestartNoticeIds([cut(1_000_033, 0), wake("run-2", 2_000_001, 3_600)] as never),
    ]).toEqual([]);
  });
});
