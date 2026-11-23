import { describe, expect, it } from "vite-plus/test";

import { type EnvironmentRunChats, nextRunChats } from "./WorkflowRunChatsTracker";

const chats = (...hidden: string[]): EnvironmentRunChats => ({
  hidden: new Set(hidden),
  runs: new Map(),
});

describe("nextRunChats", () => {
  it("keeps a disconnected environment's chats until it leaves the catalog", () => {
    const connected = nextRunChats(
      nextRunChats(new Map(), { environmentId: "mac", chats: chats("a") }),
      { environmentId: "studio", chats: chats("b") },
    );
    // Both machines are still in the catalog, so nothing is dropped.
    const reconnecting = nextRunChats(connected, { keep: new Set(["mac", "studio"]) });
    expect(reconnecting).toBe(connected);

    const removed = nextRunChats(connected, { keep: new Set(["mac"]) });
    expect([...removed.keys()]).toEqual(["mac"]);
    expect(nextRunChats(removed, { keep: new Set() }).size).toBe(0);
  });

  it("replaces an environment's chats with its latest state", () => {
    const first = nextRunChats(new Map(), { environmentId: "mac", chats: chats("a") });
    const next = nextRunChats(first, { environmentId: "mac", chats: chats("b") });
    expect([...(next.get("mac")?.hidden ?? [])]).toEqual(["b"]);
  });
});
