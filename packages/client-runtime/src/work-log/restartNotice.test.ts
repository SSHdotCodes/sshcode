import { describe, expect, it } from "vite-plus/test";
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
});
