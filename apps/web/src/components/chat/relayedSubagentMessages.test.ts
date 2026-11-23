import { relayedSubagentMessagesStorageKey } from "@t3tools/client-runtime/state/thread-execution";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readRelayedSubagentMessages,
  rememberRelayedSubagentMessage,
} from "./relayedSubagentMessages";

function stubStorage(entries: Record<string, string> = {}) {
  const store = new Map(Object.entries(entries));
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    },
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("relayed subagent messages on this device", () => {
  it("keeps what was sent and stores it for the next launch", () => {
    const store = stubStorage();
    rememberRelayedSubagentMessage("thread-sent", "Check the flaky test first");
    expect(readRelayedSubagentMessages("thread-sent").map((m) => m.text)).toEqual([
      "Check the flaky test first",
    ]);
    const stored = JSON.parse(store.get(relayedSubagentMessagesStorageKey("thread-sent")) ?? "[]");
    expect(stored).toEqual([expect.objectContaining({ text: "Check the flaky test first" })]);
  });

  it("reads earlier messages and drops ones older than a week", () => {
    const now = Date.now();
    stubStorage({
      [relayedSubagentMessagesStorageKey("thread-stored")]: JSON.stringify([
        { text: "old", sentAt: now - 8 * 24 * 60 * 60 * 1000 },
        { text: "recent", sentAt: now - 60_000 },
      ]),
    });
    expect(readRelayedSubagentMessages("thread-stored").map((m) => m.text)).toEqual(["recent"]);
  });

  it("still shows a message when storage is unavailable", () => {
    vi.stubGlobal("window", {
      get localStorage(): Storage {
        throw new Error("blocked");
      },
    });
    rememberRelayedSubagentMessage("thread-no-storage", "hello");
    expect(readRelayedSubagentMessages("thread-no-storage").map((m) => m.text)).toEqual(["hello"]);
  });
});
