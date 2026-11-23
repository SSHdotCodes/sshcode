import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createMemoryStorage } from "./lib/storage";
import {
  canShowSplit,
  clampSplitRatio,
  createSplitChatStore,
  restoreSplitChat,
  splitPaneIndex,
  SPLIT_CHAT_STORAGE_KEY,
} from "./splitChatStore";

const first = scopeThreadRef(EnvironmentId.make("one"), ThreadId.make("chat"));
const second = scopeThreadRef(EnvironmentId.make("two"), ThreadId.make("chat"));
const third = scopeThreadRef(EnvironmentId.make("one"), ThreadId.make("another"));
const fixture = { panes: [first, second], orientation: "horizontal", ratio: 0.5 } as const;

function setup() {
  const storage = createMemoryStorage();
  const store = createSplitChatStore(storage);
  store.getState().openBeside(first, second);
  return { storage, store };
}

describe("split chat layout", () => {
  it("clamps the divider to both pane minimums including its own width", () => {
    expect(clampSplitRatio(0, 1006)).toBe(0.36);
    expect(clampSplitRatio(1, 1006)).toBe(0.64);
    expect(clampSplitRatio(0, 806, 240)).toBe(0.3);
    expect(clampSplitRatio(1, 806, 240)).toBe(0.7);
    expect(clampSplitRatio(Number.NaN)).toBe(0.5);
    expect(clampSplitRatio(Infinity)).toBe(0.5);
    expect(clampSplitRatio(-3)).toBe(0.15);
    expect(clampSplitRatio(4)).toBe(0.85);
    expect(clampSplitRatio(0, 4006)).toBe(0.15);
    expect(clampSplitRatio(1, 4006)).toBe(0.85);
    for (const width of [0, 3, 6, 300, 726]) {
      expect(clampSplitRatio(0, width)).toBe(0.5);
      expect(clampSplitRatio(1, width)).toBe(0.5);
    }
  });

  it("falls back below the width or stacked height minimum without changing saved state", () => {
    const { store } = setup();
    expect(canShowSplit(726, 200, "horizontal")).toBe(true);
    expect(canShowSplit(725, 900, "horizontal")).toBe(false);
    expect(canShowSplit(360, 486, "vertical")).toBe(true);
    expect(canShowSplit(359, 900, "vertical")).toBe(false);
    expect(canShowSplit(800, 485, "vertical")).toBe(false);
    expect(store.getState().split).toEqual(fixture);
  });
});

describe("split chat state", () => {
  it("uses scoped route identity for focus, even when two environments share a chat id", () => {
    const { store } = setup();
    expect(splitPaneIndex(store.getState().split, first)).toBe(0);
    expect(splitPaneIndex(store.getState().split, second)).toBe(1);
    expect(splitPaneIndex(store.getState().split, third)).toBe(-1);
    expect(splitPaneIndex(store.getState().split, null)).toBe(-1);
    expect(splitPaneIndex(null, first)).toBe(-1);
  });

  it("does not duplicate a chat or replace the split when focusing its other pane", () => {
    const { store } = setup();
    const previous = store.getState().split;
    store.getState().openBeside(first, first);
    store.getState().openBeside(second, first);
    expect(store.getState().split).toBe(previous);
  });

  it("swaps positions while retaining the focused chat and its proportional size", () => {
    const { store } = setup();
    store.getState().setRatio(0.4);
    store.getState().swap();
    expect(store.getState().split?.panes).toEqual([second, first]);
    expect(splitPaneIndex(store.getState().split, first)).toBe(1);
    expect(store.getState().split?.ratio).toBe(0.6);
    store.getState().swap();
    expect(store.getState().split?.panes).toEqual([first, second]);
    expect(store.getState().split?.ratio).toBe(0.4);
  });

  it("places a dropped chat in the pane it landed on, trading places with its other pane", () => {
    const { store } = setup();
    store.getState().setRatio(0.4);
    const previous = store.getState().split;
    store.getState().placeInPane(0, first);
    expect(store.getState().split).toBe(previous);
    store.getState().placeInPane(1, third);
    expect(store.getState().split).toMatchObject({ panes: [first, third], ratio: 0.4 });
    store.getState().placeInPane(0, third);
    expect(store.getState().split?.panes).toEqual([third, first]);
  });

  it("persists scoped chats, orientation and ratio on this device", async () => {
    const { store, storage } = setup();
    store.getState().toggleOrientation();
    store.getState().setRatio(0.6);
    const restored = createSplitChatStore(storage);
    await restored.persist.rehydrate();
    expect(restored.getState().split).toEqual({ ...fixture, orientation: "vertical", ratio: 0.6 });
    restored.getState().toggleOrientation();
    expect(restored.getState().split?.orientation).toBe("horizontal");
    restored.getState().close();
    expect(createSplitChatStore(storage).getState().split).toBeNull();
    expect(createSplitChatStore(createMemoryStorage()).getState().split).toBeNull();
  });

  it("opens a new pair using the active route and remembered layout", () => {
    const { store } = setup();
    store.getState().setRatio(0.6);
    store.getState().toggleOrientation();
    store.getState().openBeside(second, third);
    expect(store.getState().split).toEqual({
      panes: [second, third],
      orientation: "vertical",
      ratio: 0.6,
    });
  });

  it("prunes archived/deleted chats, returns the survivor, and persists the collapse", () => {
    const { store, storage } = setup();
    expect(store.getState().prune((ref) => ref.environmentId !== first.environmentId)).toEqual(
      second,
    );
    expect(store.getState().split).toBeNull();
    expect(createSplitChatStore(storage).getState().split).toBeNull();
  });

  it("retains offline or not-yet-loaded panes until their availability is known", () => {
    const { store } = setup();
    const previous = store.getState().split;
    expect(store.getState().prune(() => null)).toBeNull();
    expect(store.getState().prune(() => true)).toBeNull();
    expect(store.getState().split).toBe(previous);
    expect(store.getState().prune(() => false)).toBeNull();
    expect(store.getState().split).toBeNull();
  });

  it.each([
    null,
    {},
    { panes: [] },
    { ...fixture, panes: [first, first] },
    { ...fixture, panes: [{}, second] },
    { ...fixture, orientation: "diagonal" },
    { ...fixture, ratio: "0.5" },
  ])("discards malformed saved split %j", async (split) => {
    const storage = createMemoryStorage();
    storage.setItem(SPLIT_CHAT_STORAGE_KEY, JSON.stringify({ state: { split }, version: 0 }));
    const store = createSplitChatStore(storage);
    await store.persist.rehydrate();
    expect(store.getState().split).toBeNull();
  });

  it("normalizes old or out-of-range persisted ratios", () => {
    expect(restoreSplitChat({ ...fixture, ratio: -4 })?.ratio).toBe(0.15);
    expect(restoreSplitChat({ ...fixture, ratio: 8 })?.ratio).toBe(0.85);
    expect(restoreSplitChat({ ...fixture, ratio: NaN })?.ratio).toBe(0.5);
  });
});
