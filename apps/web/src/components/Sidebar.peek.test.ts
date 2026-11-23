import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createSidebarPeekController,
  SIDEBAR_PEEK_CLOSE_DELAY_MS,
  SIDEBAR_PEEK_OPEN_DELAY_MS,
} from "./Sidebar.peek";

function setup() {
  const state = { peeking: false, held: false, changes: 0 };
  const controller = createSidebarPeekController({
    onChange: (peeking) => {
      state.peeking = peeking;
      state.changes += 1;
    },
    isHeld: () => state.held,
  });
  const open = () => {
    controller.edgeEnter();
    vi.advanceTimersByTime(SIDEBAR_PEEK_OPEN_DELAY_MS);
  };
  return { state, controller, open };
}

describe("sidebar peek", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens only after the pointer rests on the edge", () => {
    const { state, controller } = setup();
    controller.edgeEnter();
    vi.advanceTimersByTime(SIDEBAR_PEEK_OPEN_DELAY_MS - 1);
    expect(state.peeking).toBe(false);
    vi.advanceTimersByTime(1);
    expect(state.peeking).toBe(true);
  });

  it("stays shut when the pointer only crosses the edge on its way out of the window", () => {
    const { state, controller } = setup();
    controller.edgeEnter();
    vi.advanceTimersByTime(SIDEBAR_PEEK_OPEN_DELAY_MS - 1);
    controller.edgeLeave();
    vi.advanceTimersByTime(1000);
    expect(state.peeking).toBe(false);
    expect(state.changes).toBe(0);
  });

  it("closes shortly after the pointer leaves the sidebar", () => {
    const { state, controller, open } = setup();
    open();
    controller.edgeLeave();
    controller.sidebarEnter();
    vi.advanceTimersByTime(5000);
    expect(state.peeking).toBe(true);
    controller.sidebarLeave(false);
    vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS - 1);
    expect(state.peeking).toBe(true);
    vi.advanceTimersByTime(1);
    expect(state.peeking).toBe(false);
  });

  it("closes when the pointer leaves the window from the edge without touching the sidebar", () => {
    const { state, controller, open } = setup();
    open();
    controller.edgeLeave();
    vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS);
    expect(state.peeking).toBe(false);
  });

  it("returning to the sidebar cancels the close", () => {
    const { state, controller, open } = setup();
    open();
    controller.sidebarLeave(false);
    vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS - 1);
    controller.sidebarEnter();
    vi.advanceTimersByTime(5000);
    expect(state.peeking).toBe(true);
  });

  it("stays out while a menu from the sidebar holds it, then closes", () => {
    const { state, controller, open } = setup();
    open();
    state.held = true;
    controller.sidebarLeave(false);
    vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS * 10);
    expect(state.peeking).toBe(true);
    state.held = false;
    vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS);
    expect(state.peeking).toBe(false);
  });

  it("stays out while a row is dragged away, until the drop", () => {
    const { state, controller, open } = setup();
    open();
    controller.sidebarLeave(true);
    vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS * 10);
    expect(state.peeking).toBe(true);
    controller.pointerReleased();
    vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS);
    expect(state.peeking).toBe(false);
  });

  it("dispose closes the peek and stops pending timers", () => {
    const { state, controller, open } = setup();
    open();
    controller.dispose();
    expect(state.peeking).toBe(false);
    controller.edgeEnter();
    controller.dispose();
    vi.advanceTimersByTime(1000);
    expect(state.peeking).toBe(false);
    expect(state.changes).toBe(2);
  });
});
