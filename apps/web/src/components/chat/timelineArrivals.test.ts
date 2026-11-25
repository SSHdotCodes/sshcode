import { describe, expect, it } from "vite-plus/test";

import { createTimelineArrivalTracker, shouldAnimateTimelineRowArrival } from "./timelineArrivals";

const rows = (...ids: string[]) =>
  ids.map((id) => ({ id, kind: id === "working" ? "working" : "message" }));

describe("timeline arrivals", () => {
  it("does not animate the rows a chat opens with", () => {
    const observe = createTimelineArrivalTracker();
    expect(observe("chat", rows("a", "b", "c"))).toBeNull();
  });

  it("marks a row appended to an open chat", () => {
    const observe = createTimelineArrivalTracker();
    observe("chat", rows("a", "b"));
    expect(observe("chat", rows("a", "b", "c"))).toEqual(["c"]);
  });

  it("marks a row that lands just above the working indicator", () => {
    const observe = createTimelineArrivalTracker();
    observe("chat", rows("a", "working"));
    expect(observe("chat", rows("a", "tool", "working"))).toEqual(["tool"]);
  });

  it("treats older history paged in at the top as already there", () => {
    const observe = createTimelineArrivalTracker();
    observe("chat", rows("m", "n", "o", "p", "q"));
    expect(observe("chat", rows("k", "l", "m", "n", "o", "p", "q"))).toEqual([]);
  });

  it("keeps prepended history still even when the entire list is short", () => {
    const observe = createTimelineArrivalTracker();
    observe("chat", rows("m", "n"));
    expect(observe("chat", rows("k", "m", "n"))).toEqual([]);
  });

  it("marks only the appended row when older history and live content arrive together", () => {
    const observe = createTimelineArrivalTracker();
    observe("chat", rows("m", "n", "working"));
    expect(observe("chat", rows("k", "m", "n", "o", "working"))).toEqual(["o"]);
  });

  it("treats many rows at once as a load", () => {
    const observe = createTimelineArrivalTracker();
    observe("chat", rows());
    expect(observe("chat", rows("a", "b", "c", "d", "e"))).toEqual([]);
    // The first prompt of a new chat is an arrival.
    observe("new", rows());
    expect(observe("new", rows("prompt", "working"))).toEqual(["prompt"]);
  });

  it("keeps independent timeline trackers apart and never replays a row", () => {
    const observe = createTimelineArrivalTracker();
    const observeOther = createTimelineArrivalTracker();
    observe("chat", rows("a"));
    observeOther("chat", rows("a", "b"));
    expect(observe("chat", rows("a", "b"))).toEqual(["b"]);
    // Folded away and back later: previously seen, so it stays still.
    observe("chat", rows("a"));
    expect(observe("chat", rows("a", "b"))).toEqual([]);
  });

  it("ignores updates that only change text in existing rows", () => {
    const observe = createTimelineArrivalTracker();
    observe("chat", rows("a", "b"));
    expect(observe("chat", rows("a", "b"))).toEqual([]);
  });

  it("does not animate short history that hydrates after an empty loading frame", () => {
    const observe = createTimelineArrivalTracker();
    observe(null, rows());
    expect(observe("short", rows("user-1", "assistant-1"))).toBeNull();
    expect(observe("short", rows("user-1", "assistant-1", "user-2"))).toEqual(["user-2"]);
  });

  it("re-seeds silently when switching back into a chat that received messages while away", () => {
    const observe = createTimelineArrivalTracker();
    observe("one", rows("a"));
    expect(observe("one", rows("a", "b"))).toEqual(["b"]);
    observe("two", rows("x"));
    expect(observe("one", rows("a", "b", "c"))).toBeNull();
  });

  it("animates content arrivals only, skipping metadata, working chrome, and expanded folds", () => {
    expect(shouldAnimateTimelineRowArrival("message")).toBe(true);
    expect(shouldAnimateTimelineRowArrival("work", { isExpandedToolGroup: false })).toBe(true);
    expect(shouldAnimateTimelineRowArrival("work-live")).toBe(true);
    expect(shouldAnimateTimelineRowArrival("work-toggle")).toBe(true);
    expect(shouldAnimateTimelineRowArrival("work", { isExpandedToolGroup: true })).toBe(false);
    expect(shouldAnimateTimelineRowArrival("working")).toBe(false);
    expect(shouldAnimateTimelineRowArrival("assistant-meta")).toBe(false);
  });
});
