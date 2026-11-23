import {
  ThreadId,
  cleanChatTabName as cleanTabName,
  type ChatTabsCommand,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodePath from "@effect/platform-node/NodePath";
import * as ServerConfig from "../config.ts";
import * as Effect from "effect/Effect";
import { beforeEach, describe, expect, it } from "@effect/vitest";

import * as Context from "effect/Context";
import * as ChatTabs from "./chatTabs.ts";

let chatTabs = ChatTabs.make().store;
const resetChatTabsForTest = () => {
  chatTabs = ChatTabs.make().store;
};
const chatTabsLayer = ChatTabs.layer;

const run = (command: ChatTabsCommand) =>
  chatTabs.command(command, { titleOf: () => null, now: 2 });
const tabOf = (threadId: string) => chatTabs.get(threadId)?.name ?? null;

describe("chat tabs", () => {
  beforeEach(resetChatTabsForTest);

  it("cleans tab names and refuses catch-all ones", () => {
    expect(cleanTabName('  "Black Hole  Benchmark." ')).toBe("Black Hole Benchmark");
    expect(cleanTabName("Misc")).toBe("");
    expect(cleanTabName("All")).toBe("");
    expect(cleanTabName("A very long tab name that keeps on going forever")).toBe(
      "A very long tab name that keeps",
    );
  });

  it("files a chat once, reusing a tab whatever its case", () => {
    chatTabs.fileByModel({ threadId: "a", tab: "Black Hole", title: "Build It", now: 1 });
    chatTabs.fileByModel({ threadId: "b", tab: "black hole", title: "Bench It", now: 1 });
    chatTabs.fileByModel({ threadId: "a", tab: "Studio", title: "Build It", now: 1 });
    expect(tabOf("a")).toBe("Black Hole");
    expect(tabOf("b")).toBe("Black Hole");
    expect(chatTabs.get("a")).toEqual({ name: "Black Hole", position: 0, manual: false });
    expect(chatTabs.promptTabs()).toEqual([
      { name: "Black Hole", chats: ["Build It", "Bench It"] },
    ]);
  });

  it.effect("keeps a chat where the user put it", () =>
    Effect.gen(function* () {
      yield* run({ action: "move", threadIds: [ThreadId.make("a")], tab: "Studio" });
      chatTabs.fileByModel({ threadId: "a", tab: "Black Hole", title: "x", now: 3 });
      expect(chatTabs.get("a")).toEqual({ name: "Studio", position: 0, manual: true });
      yield* run({ action: "move", threadIds: [ThreadId.make("a")], tab: null });
      expect(tabOf("a")).toBeNull();
      expect(chatTabs.isFiled("a")).toBe(true);
      // The emptied tab is gone.
      expect(chatTabs.promptTabs()).toEqual([]);
    }),
  );

  it.effect("renames, merges, reorders and deletes tabs", () =>
    Effect.gen(function* () {
      chatTabs.fileByModel({ threadId: "a", tab: "One", title: "a", now: 1 });
      chatTabs.fileByModel({ threadId: "b", tab: "Two", title: "b", now: 1 });
      chatTabs.fileByModel({ threadId: "c", tab: "Three", title: "c", now: 1 });
      yield* run({ action: "rename", tab: "One", to: "First" });
      expect(tabOf("a")).toBe("First");
      yield* run({ action: "reorder", tab: "Three", before: "First" });
      expect(chatTabs.promptTabs().map((tab) => tab.name)).toEqual(["Three", "First", "Two"]);
      yield* run({ action: "rename", tab: "Two", to: "first" });
      expect(tabOf("b")).toBe("First");
      expect(chatTabs.get("b")?.manual).toBe(true);
      yield* run({ action: "delete", tab: "First" });
      expect(tabOf("a")).toBeNull();
      expect(tabOf("b")).toBeNull();
      chatTabs.fileByModel({ threadId: "a", tab: "Again", title: "a", now: 4 });
      expect(tabOf("a")).toBeNull();
      expect(chatTabs.promptTabs().map((tab) => tab.name)).toEqual(["Three"]);
    }),
  );
});

it.effect("remembers comparisons in the existing tabs file, including across reloads", () =>
  Effect.gen(function* () {
    resetChatTabsForTest();
    let saved = '{"version":1,"existingSorted":false,"tabs":[],"chats":{}}';
    const written = yield* Deferred.make<void>();
    const storage = FileSystem.layerNoop({
      readFileString: () => Effect.sync(() => saved),
      writeFileString: (_path, content) =>
        Effect.sync(() => {
          saved = content;
        }),
      rename: () => Deferred.succeed(written, undefined).pipe(Effect.asVoid),
    });
    const dependencies = Layer.mergeAll(
      storage,
      NodePath.layer,
      Layer.succeed(ServerConfig.ServerConfig, {
        stateDir: "/isolated",
      } as ServerConfig.ServerConfig["Service"]),
    );
    const group = {
      id: "comparison",
      title: "Make a tool",
      threadIds: [ThreadId.make("a"), ThreadId.make("b")],
    };
    yield* Effect.scoped(
      Effect.gen(function* () {
        chatTabs = Context.get(
          yield* Layer.build(chatTabsLayer.pipe(Layer.provide(dependencies))),
          ChatTabs.ChatTabs,
        );
        yield* run({ action: "compare", comparison: group });
        yield* Deferred.await(written);
      }),
    );
    resetChatTabsForTest();
    expect(chatTabs.comparison("a")).toBeNull();
    yield* Effect.scoped(
      Effect.gen(function* () {
        chatTabs = Context.get(
          yield* Layer.build(chatTabsLayer.pipe(Layer.provide(dependencies))),
          ChatTabs.ChatTabs,
        );
        expect(chatTabs.comparison("a")).toEqual(group);
        expect(chatTabs.comparison("b")).toEqual(group);
        expect(chatTabs.get("a")).toBeNull();
        chatTabs.endComparison(group.id);
        expect(chatTabs.comparison("a")).toBeNull();
      }),
    );
    resetChatTabsForTest();
  }),
);

it.effect("rejects duplicate members, overlapping groups and out-of-range sizes", () =>
  Effect.gen(function* () {
    resetChatTabsForTest();
    const a = ThreadId.make("a");
    const b = ThreadId.make("b");
    for (const threadIds of [[a], [a, a], [a, b, a, b, a]]) {
      expect(
        (yield* Effect.result(
          run({ action: "compare", comparison: { id: "bad", title: "Tool", threadIds } }),
        ))._tag,
      ).toBe("Failure");
    }
    yield* run({ action: "compare", comparison: { id: "one", title: "Tool", threadIds: [a, b] } });
    // Retries are idempotent.
    yield* run({ action: "compare", comparison: { id: "one", title: "Tool", threadIds: [a, b] } });
    expect(
      (yield* Effect.result(
        run({
          action: "compare",
          comparison: { id: "two", title: "Tool", threadIds: [a, ThreadId.make("c")] },
        }),
      ))._tag,
    ).toBe("Failure");
    resetChatTabsForTest();
  }),
);

it.effect("creates empty servers, changes their icons, and deleting a server keeps its chats", () =>
  Effect.gen(function* () {
    resetChatTabsForTest();
    yield* run({ action: "create", tab: "Build" });
    expect(chatTabs.list()).toEqual([{ name: "Build", position: 0, keepEmpty: true }]);
    yield* run({ action: "set-icon", tab: "Build", icon: { kind: "emoji", emoji: "🔧" } });
    yield* run({ action: "move", tab: "Build", threadIds: [ThreadId.make("a")] });
    yield* run({ action: "move", tab: null, threadIds: [ThreadId.make("a")] });
    expect(chatTabs.list()[0]?.icon).toEqual({ kind: "emoji", emoji: "🔧" });
    yield* run({ action: "rename", tab: "Build", to: "Tools" });
    expect(chatTabs.list()[0]?.icon).toEqual({ kind: "emoji", emoji: "🔧" });
    yield* run({ action: "move", tab: "Tools", threadIds: [ThreadId.make("a")] });
    yield* run({ action: "delete", tab: "Tools" });
    expect(chatTabs.list()).toEqual([]);
    expect(chatTabs.isFiled("a")).toBe(true);
    expect(chatTabs.get("a")).toBeNull();
  }),
);

it.effect("re-encodes fixed pixels into a private bounded PNG and can reset the icon", () =>
  Effect.gen(function* () {
    resetChatTabsForTest();
    yield* run({ action: "create", tab: "Art" });
    yield* run({
      action: "set-icon",
      tab: "Art",
      icon: {
        kind: "image",
        pixels: Buffer.alloc(96 * 96 * 4, 200).toString("base64"),
      },
    });
    const icon = chatTabs.list()[0]?.icon;
    expect(icon?.kind).toBe("image");
    if (icon?.kind !== "image") throw new Error("Expected image");
    expect(icon.dataUrl.length).toBeLessThan(52_000);
    const png = Buffer.from(icon.dataUrl.split(",")[1]!, "base64");
    expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(png.readUInt32BE(16)).toBe(96);
    expect(png.readUInt32BE(20)).toBe(96);
    expect(png.subarray(12, 16).toString()).toBe("IHDR");
    yield* run({ action: "set-icon", tab: "Art", icon: null });
    expect(chatTabs.list()[0]?.icon).toBeUndefined();
    expect(
      (yield* Effect.result(
        run({ action: "set-icon", tab: "Art", icon: { kind: "image", pixels: "bad" } }),
      ))._tag,
    ).toBe("Failure");
  }),
);

it.effect("loads old tab files and persists explicit empty servers and optional icons", () =>
  Effect.gen(function* () {
    resetChatTabsForTest();
    let saved = JSON.stringify({
      version: 1,
      existingSorted: false,
      tabs: [{ name: "Old", position: 0 }],
      chats: { a: { tab: "Old", by: "user", title: "A chat", at: 1 } },
    });
    const written = yield* Deferred.make<void>();
    const storage = FileSystem.layerNoop({
      readFileString: () => Effect.sync(() => saved),
      writeFileString: (_path, content) =>
        Effect.sync(() => {
          saved = content;
        }),
      rename: () =>
        saved.includes("🚀")
          ? Deferred.succeed(written, undefined).pipe(Effect.asVoid)
          : Effect.void,
    });
    const dependencies = Layer.mergeAll(
      storage,
      NodePath.layer,
      Layer.succeed(ServerConfig.ServerConfig, {
        stateDir: "/isolated",
      } as ServerConfig.ServerConfig["Service"]),
    );
    yield* Effect.scoped(
      Effect.gen(function* () {
        chatTabs = Context.get(
          yield* Layer.build(chatTabsLayer.pipe(Layer.provide(dependencies))),
          ChatTabs.ChatTabs,
        );
        expect(tabOf("a")).toBe("Old");
        yield* run({ action: "create", tab: "Empty" });
        yield* run({ action: "set-icon", tab: "Empty", icon: { kind: "emoji", emoji: "🚀" } });
        yield* Deferred.await(written);
      }),
    );
    resetChatTabsForTest();
    yield* Effect.scoped(
      Effect.gen(function* () {
        chatTabs = Context.get(
          yield* Layer.build(chatTabsLayer.pipe(Layer.provide(dependencies))),
          ChatTabs.ChatTabs,
        );
        expect(tabOf("a")).toBe("Old");
        expect(chatTabs.list().find((tab) => tab.name === "Empty")).toEqual({
          name: "Empty",
          position: 1,
          keepEmpty: true,
          icon: { kind: "emoji", emoji: "🚀" },
        });
      }),
    );
    resetChatTabsForTest();
  }),
);

it.effect(
  "publishes catalog changes without resending icons when another chat joins an existing tab",
  () =>
    Effect.gen(function* () {
      resetChatTabsForTest();
      let updates = 0;
      const unsubscribe = chatTabs.subscribe(() => {
        updates++;
      });
      try {
        yield* run({ action: "create", tab: "Build" });
        expect(updates).toBe(1);
        yield* run({ action: "move", tab: "Build", threadIds: [ThreadId.make("a")] });
        expect(updates).toBe(1);
        yield* run({ action: "set-icon", tab: "Build", icon: { kind: "emoji", emoji: "🔧" } });
        expect(updates).toBe(2);
        yield* run({ action: "delete", tab: "Build" });
        expect(updates).toBe(3);
      } finally {
        unsubscribe();
      }
    }),
);

it.effect("writes a change made just before shutdown instead of dropping it", () =>
  Effect.gen(function* () {
    resetChatTabsForTest();
    let saved = '{"version":1,"existingSorted":false,"tabs":[],"chats":{}}';
    let renames = 0;
    const storage = FileSystem.layerNoop({
      readFileString: () => Effect.sync(() => saved),
      writeFileString: (_path, content) =>
        Effect.sync(() => {
          saved = content;
        }),
      rename: () =>
        Effect.sync(() => {
          renames++;
        }),
    });
    const dependencies = Layer.mergeAll(
      storage,
      NodePath.layer,
      Layer.succeed(ServerConfig.ServerConfig, {
        stateDir: "/isolated",
      } as ServerConfig.ServerConfig["Service"]),
    );
    const group = {
      id: "late",
      title: "Late change",
      threadIds: [ThreadId.make("a"), ThreadId.make("b")],
    };
    // Change and close at once: the background saver never gets a turn.
    yield* Effect.scoped(
      Effect.gen(function* () {
        chatTabs = Context.get(
          yield* Layer.build(chatTabsLayer.pipe(Layer.provide(dependencies))),
          ChatTabs.ChatTabs,
        );
        yield* run({ action: "compare", comparison: group });
      }),
    );
    expect(renames).toBeGreaterThan(0);
    expect(saved).toContain("Late change");
    resetChatTabsForTest();
  }),
);
