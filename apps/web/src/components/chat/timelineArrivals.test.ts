import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  TIMELINE_ARRIVAL_MS,
  noteTimelineRows,
  resetTimelineArrivalsForTest,
  timelineRowArrived,
} from "./timelineArrivals";

const rows = (...ids: string[]) => ids.map((id) => ({ id }));

describe("timeline arrivals", () => {
  beforeEach(resetTimelineArrivalsForTest);

  it("does not animate the rows a chat opens with", () => {
    noteTimelineRows("chat", rows("a", "b", "c"), 0);
    expect(["a", "b", "c"].some((id) => timelineRowArrived(id, 1))).toBe(false);
  });

  it("marks a row appended to an open chat, for a moment", () => {
    noteTimelineRows("chat", rows("a", "b"), 0);
    noteTimelineRows("chat", rows("a", "b", "c"), 100);
    expect(timelineRowArrived("c", 110)).toBe(true);
    expect(timelineRowArrived("b", 110)).toBe(false);
    expect(timelineRowArrived("c", 100 + TIMELINE_ARRIVAL_MS)).toBe(false);
  });

  it("marks a row that lands just above the working indicator", () => {
    noteTimelineRows("chat", rows("a", "working"), 0);
    noteTimelineRows("chat", rows("a", "tool", "working"), 50);
    expect(timelineRowArrived("tool", 60)).toBe(true);
  });

  it("treats older history paged in at the top as already there", () => {
    noteTimelineRows("chat", rows("m", "n", "o", "p", "q"), 0);
    noteTimelineRows("chat", rows("k", "l", "m", "n", "o", "p", "q"), 50);
    expect(timelineRowArrived("k", 60)).toBe(false);
    expect(timelineRowArrived("l", 60)).toBe(false);
  });

  it("treats many rows at once as a load", () => {
    noteTimelineRows("chat", rows(), 0);
    noteTimelineRows("chat", rows("a", "b", "c", "d", "e"), 50);
    expect(timelineRowArrived("e", 60)).toBe(false);
    // The first prompt of a new chat is an arrival.
    noteTimelineRows("new", rows(), 0);
    noteTimelineRows("new", rows("prompt", "working"), 50);
    expect(timelineRowArrived("prompt", 60)).toBe(true);
  });

  it("keeps chats apart and never replays a row", () => {
    noteTimelineRows("one", rows("a"), 0);
    noteTimelineRows("two", rows("x"), 0);
    noteTimelineRows("one", rows("a", "b"), 10);
    expect(timelineRowArrived("b", 20)).toBe(true);
    // Folded away and back later: known, so it stays still.
    noteTimelineRows("one", rows("a"), 1_000);
    noteTimelineRows("one", rows("a", "b"), 2_000);
    expect(timelineRowArrived("b", 2_010)).toBe(false);
    expect(timelineRowArrived("x", 20)).toBe(false);
  });

  it("ignores updates that only change text in existing rows", () => {
    noteTimelineRows("chat", rows("a", "b"), 0);
    for (let tick = 1; tick < 50; tick++) noteTimelineRows("chat", rows("a", "b"), tick);
    expect(timelineRowArrived("b", 50)).toBe(false);
  });
});
