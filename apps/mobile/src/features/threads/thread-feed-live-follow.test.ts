import { describe, expect, it, vi } from "vite-plus/test";

import {
  resolveThreadFeedLiveFollow,
  resolveThreadFeedSubmissionAnchor,
  resolveThreadWorkGroupInitialScroll,
  shouldFollowThreadWorkGroupAppend,
  shouldPinThreadFeedOpeningToEnd,
} from "./thread-feed-live-follow";

describe("tool-group scroll restoration", () => {
  const position = {
    rowId: "read-output",
    offsetWithinRow: 80,
    scrollOffset: 600,
    contentHeight: 1_000,
  };

  it("restores the visible row and its detail offset rather than stale absolute pixels", () => {
    const before = [{ id: "first" }, { id: "read-output" }, { id: "last" }];
    const after = [{ id: "older" }, ...before];
    expect(resolveThreadWorkGroupInitialScroll(before, position)).toEqual({
      index: 1,
      viewOffset: -80,
    });
    expect(resolveThreadWorkGroupInitialScroll(after, position)).toEqual({
      index: 2,
      viewOffset: -80,
    });
  });

  it("starts normally when the saved row no longer belongs to the group", () => {
    expect(resolveThreadWorkGroupInitialScroll([{ id: "other" }], position)).toBeUndefined();
    expect(resolveThreadWorkGroupInitialScroll([{ id: "read-output" }], undefined)).toBeUndefined();
  });
});

describe("tool-group append following", () => {
  const previousRows = Array.from({ length: 10 }, (_, index) => ({ id: `call-${index}` }));
  const appendedRows = [...previousRows, { id: "new-call" }];
  const atEnd = {
    previousRows,
    rows: appendedRows,
    previousContentHeight: 289,
    contentHeight: 318,
    viewportHeight: 256,
    scrollOffset: 33,
    detailsChanged: false,
    userScrolling: false,
  };

  it("follows a new call when the reader was at the end", () => {
    expect(shouldFollowThreadWorkGroupAppend(atEnd)).toBe(true);
  });

  it("follows the first overflowing append as a short group reaches its height cap", () => {
    expect(
      shouldFollowThreadWorkGroupAppend({
        ...atEnd,
        previousRows: previousRows.slice(0, 8),
        rows: previousRows.slice(0, 9),
        previousContentHeight: 231,
        contentHeight: 260,
        viewportHeight: 231,
        scrollOffset: 0,
      }),
    ).toBe(true);
  });

  it.each([
    { name: "reading earlier calls", changes: { scrollOffset: 20 } },
    { name: "dragging before leaving the edge", changes: { userScrolling: true } },
    { name: "opening detail during an append", changes: { detailsChanged: true } },
    { name: "streaming a result", changes: { rows: previousRows, contentHeight: 600 } },
    { name: "updating a lifecycle label", changes: { rows: previousRows, contentHeight: 289 } },
    { name: "prepending old calls", changes: { rows: [{ id: "older" }, ...previousRows] } },
    {
      name: "replacing a call while appending",
      changes: { rows: [{ id: "replacement" }, ...appendedRows.slice(1)] },
    },
  ])("does not steal the reader's position when $name", ({ changes }) => {
    expect(shouldFollowThreadWorkGroupAppend({ ...atEnd, ...changes })).toBe(false);
  });
});

describe("resolveThreadFeedSubmissionAnchor", () => {
  it("anchors the first user message in a thread", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: "first-message",
        hasStartedTurn: false,
        hasUserMessage: false,
        queuedMessageCount: 0,
      }),
    ).toBe("first-message");
  });

  it("preserves the first-message anchor when another message is queued", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: "first-message",
        submittedMessageId: "second-message",
        hasStartedTurn: false,
        hasUserMessage: false,
        queuedMessageCount: 1,
      }),
    ).toBe("first-message");
  });

  it("preserves the first-message anchor after its outbox entry drains", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: "first-message",
        submittedMessageId: "second-message",
        hasStartedTurn: false,
        hasUserMessage: false,
        queuedMessageCount: 0,
      }),
    ).toBe("first-message");
  });

  it("does not anchor a follow-up after a user message appears", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: "first-message",
        submittedMessageId: "second-message",
        hasStartedTurn: false,
        hasUserMessage: true,
        queuedMessageCount: 0,
      }),
    ).toBeNull();
  });

  it("does not anchor a thread that has already started a turn", () => {
    expect(
      resolveThreadFeedSubmissionAnchor({
        currentAnchorMessageId: null,
        submittedMessageId: "second-message",
        hasStartedTurn: true,
        hasUserMessage: false,
        queuedMessageCount: 0,
      }),
    ).toBeNull();
  });
});

describe("resolveThreadFeedLiveFollow", () => {
  it("pauses immediately when the user starts scrolling", () => {
    expect(resolveThreadFeedLiveFollow(true, { type: "user-scroll-begin" })).toBe(false);
  });

  it("keeps following programmatic layout compensation without reading the list", () => {
    const readIsAtEnd = vi.fn(() => false);
    expect(
      resolveThreadFeedLiveFollow(true, {
        type: "scroll",
        readIsAtEnd,
        userScrollSessionActive: false,
      }),
    ).toBe(true);
    expect(readIsAtEnd).not.toHaveBeenCalled();
  });

  it("keeps follow paused throughout a user gesture without reading the list", () => {
    const readIsAtEnd = vi.fn(() => true);
    expect(
      resolveThreadFeedLiveFollow(false, {
        type: "scroll",
        readIsAtEnd,
        userScrollSessionActive: true,
      }),
    ).toBe(false);
    expect(readIsAtEnd).not.toHaveBeenCalled();
  });

  it("queries the end only until a paused list catches up", () => {
    const readIsAtEnd = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const event = { type: "scroll", readIsAtEnd, userScrollSessionActive: false } as const;
    let following = resolveThreadFeedLiveFollow(false, event);
    expect(following).toBe(false);
    following = resolveThreadFeedLiveFollow(following, event);
    expect(following).toBe(true);
    expect(resolveThreadFeedLiveFollow(following, event)).toBe(true);
    expect(readIsAtEnd).toHaveBeenCalledTimes(2);
  });

  it.each([
    { isAtEnd: false, userScrollSessionActive: false, expected: false },
    { isAtEnd: true, userScrollSessionActive: false, expected: true },
    { isAtEnd: false, userScrollSessionActive: true, expected: false },
    { isAtEnd: true, userScrollSessionActive: true, expected: false },
  ])("reconciles follow after a disclosure settles: %j", ({ expected, ...state }) => {
    expect(resolveThreadFeedLiveFollow(!expected, { type: "disclosure-settled", ...state })).toBe(
      expected,
    );
  });

  it("re-arms at the actual end only after the user scroll session ends", () => {
    expect(
      resolveThreadFeedLiveFollow(false, {
        type: "user-scroll-end",
        isAtEnd: true,
        userScrollSessionActive: true,
      }),
    ).toBe(true);
    expect(
      resolveThreadFeedLiveFollow(false, {
        type: "user-scroll-end",
        isAtEnd: false,
        userScrollSessionActive: true,
      }),
    ).toBe(false);
  });

  it("ignores momentum-end events from programmatic scrolling", () => {
    expect(
      resolveThreadFeedLiveFollow(true, {
        type: "user-scroll-end",
        isAtEnd: false,
        userScrollSessionActive: false,
      }),
    ).toBe(true);
  });

  it("re-arms after an explicit reset", () => {
    expect(resolveThreadFeedLiveFollow(false, { type: "reset" })).toBe(true);
  });
});

describe("shouldPinThreadFeedOpeningToEnd", () => {
  const leftBehind = {
    followEnabled: true,
    userScrollSessionActive: false,
    isAtEnd: false,
    contentLength: 4_000,
    scrollLength: 800,
  };

  it("pulls an opening chat to messages that arrived after its first end scroll", () => {
    expect(shouldPinThreadFeedOpeningToEnd(leftBehind)).toBe(true);
  });

  it("leaves the list alone once it is at the end", () => {
    expect(shouldPinThreadFeedOpeningToEnd({ ...leftBehind, isAtEnd: true })).toBe(false);
  });

  it("reopens a retained chat at the latest after a previous visit scrolled up", () => {
    const paused = resolveThreadFeedLiveFollow(true, { type: "user-scroll-begin" });
    expect(shouldPinThreadFeedOpeningToEnd({ ...leftBehind, followEnabled: paused })).toBe(false);
    const reopened = resolveThreadFeedLiveFollow(paused, { type: "reset" });
    expect(shouldPinThreadFeedOpeningToEnd({ ...leftBehind, followEnabled: reopened })).toBe(true);
  });

  it("never fights the reader", () => {
    expect(shouldPinThreadFeedOpeningToEnd({ ...leftBehind, userScrollSessionActive: true })).toBe(
      false,
    );
    expect(shouldPinThreadFeedOpeningToEnd({ ...leftBehind, followEnabled: false })).toBe(false);
  });

  it("lets short threads rest at their aligned position", () => {
    expect(shouldPinThreadFeedOpeningToEnd({ ...leftBehind, contentLength: 800 })).toBe(false);
  });
});
