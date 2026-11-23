import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  KEPT_CHAT_VIEWS,
  keepChatViews,
  keptChatViewCapacity,
  type KeptChatView,
} from "./keptChatViews";

function view(id: string, key = `env:${id}`) {
  return {
    key,
    threadKey: `env:${id}`,
    target: {
      kind: "server" as const,
      threadRef: scopeThreadRef("env" as EnvironmentId, id as ThreadId),
    },
  };
}

function visit(kept: ReadonlyArray<KeptChatView>, ...ids: string[]) {
  return keepChatViews(
    kept,
    ids.map((id) => view(id)),
    2,
  );
}

describe("keepChatViews", () => {
  it("keeps the most recently shown chats, the shown ones first", () => {
    let kept = visit([], "a");
    kept = visit(kept, "b");
    kept = visit(kept, "c");
    kept = visit(kept, "d");
    expect(kept.map((entry) => entry.threadKey)).toEqual(["env:d", "env:c", "env:b"]);

    kept = visit(kept, "b");
    expect(kept.map((entry) => entry.threadKey)).toEqual(["env:b", "env:d", "env:c"]);
  });

  it("reuses a kept chat's entry, so its view keeps its key, target and mount order", () => {
    const first = visit([], "a");
    const promoted = keepChatViews(first, [view("b", "draft-b")], 2);
    const back = visit(visit(promoted, "c"), "b");
    const b = back.find((entry) => entry.threadKey === "env:b");
    expect(b).toBe(promoted[0]);
    expect(b?.key).toBe("draft-b");
    expect(back.map((entry) => entry.order).toSorted()).toEqual([1, 2, 3]);
  });

  it("returns the same list while the shown chats stay in front", () => {
    const kept = visit(visit([], "a"), "b");
    expect(visit(kept, "b")).toBe(kept);
    expect(keepChatViews(kept, [], 2)).toBe(kept);
  });

  it("keeps both chats of a split in front", () => {
    const kept = visit(visit(visit([], "a"), "b"), "c");
    const split = visit(kept, "a", "c");
    expect(split.slice(0, 2).map((entry) => entry.threadKey)).toEqual(["env:a", "env:c"]);
    expect(visit(split, "c", "a")).toBe(split);
  });
});

describe("keptChatViewCapacity", () => {
  it("keeps one hidden view once the heap passes a quarter of its limit", () => {
    const limit = 4 * 1024 ** 3;
    expect(keptChatViewCapacity({ usedJSHeapSize: 200 * 1024 ** 2, jsHeapSizeLimit: limit })).toBe(
      KEPT_CHAT_VIEWS,
    );
    expect(keptChatViewCapacity({ usedJSHeapSize: 1.5 * 1024 ** 3, jsHeapSizeLimit: limit })).toBe(
      1,
    );
    expect(keptChatViewCapacity(undefined)).toBe(KEPT_CHAT_VIEWS);
  });
});
