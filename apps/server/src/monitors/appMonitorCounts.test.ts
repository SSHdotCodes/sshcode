import { afterEach, expect, it } from "vite-plus/test";

import { subscribeBoxNamed } from "../sessionBoxes/boxNamerCache.ts";
import { appMonitorCount, appMonitorThreadIds, publishAppMonitors } from "./appMonitorCounts.ts";

afterEach(() => publishAppMonitors([]));

it("counts each chat's running monitors and re-sends only the chats that changed", () => {
  const announced: string[] = [];
  const unsubscribe = subscribeBoxNamed((threadId) => announced.push(threadId));
  try {
    publishAppMonitors(["a", "a", "b"]);
    expect([appMonitorCount("a"), appMonitorCount("b"), appMonitorCount("c")]).toEqual([2, 1, 0]);
    expect(announced.sort()).toEqual(["a", "b"]);
    // A client that reconnects with saved rows is sent these chats again.
    expect([...appMonitorThreadIds()].sort()).toEqual(["a", "b"]);

    announced.length = 0;
    // One of a's monitors ended; b is unchanged and is not sent again.
    publishAppMonitors(["a", "b"]);
    expect(appMonitorCount("a")).toBe(1);
    expect(announced).toEqual(["a"]);

    announced.length = 0;
    publishAppMonitors([]);
    expect(appMonitorCount("a")).toBe(0);
    expect(appMonitorThreadIds()).toEqual([]);
    expect(announced.sort()).toEqual(["a", "b"]);
  } finally {
    unsubscribe();
  }
});
