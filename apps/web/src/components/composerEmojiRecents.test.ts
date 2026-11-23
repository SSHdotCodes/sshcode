// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readEmojiRecents, rememberEmoji } from "./composerEmojiRecents";

describe("emoji recents", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  it("keeps most recently used first without duplicates", () => {
    rememberEmoji("heart");
    rememberEmoji("tada");
    rememberEmoji("heart");
    expect(readEmojiRecents()).toEqual(["heart", "tada"]);
  });
  it("bounds history and tolerates malformed storage", () => {
    for (let i = 0; i < 20; i++) rememberEmoji(`emoji_${i}`);
    expect(readEmojiRecents()).toHaveLength(16);
    localStorage.setItem("t3code:emoji-recents:v1", "oops");
    expect(readEmojiRecents()).toEqual([]);
    localStorage.setItem("t3code:emoji-recents:v1", '[1,"tada","tada",null,"<invalid>"]');
    expect(readEmojiRecents()).toEqual(["tada"]);
  });
  it("still inserts when device storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("disabled");
    });
    expect(rememberEmoji("tada")).toEqual(["tada"]);
  });
});
