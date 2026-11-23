// @vitest-environment jsdom
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  focused: true,
  appState: "active",
  focusListeners: new Set<() => void>(),
  appListeners: new Set<(state: string) => void>(),
  visit: vi.fn(),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => navigation,
  useIsFocused: () =>
    useSyncExternalStore(
      (listener) => {
        harness.focusListeners.add(listener);
        return () => harness.focusListeners.delete(listener);
      },
      () => harness.focused,
    ),
}));
const navigation = { isFocused: () => harness.focused };
vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return harness.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      harness.appListeners.add(listener);
      return { remove: () => harness.appListeners.delete(listener) };
    },
  },
}));
import { useThreadVisit } from "./use-thread-visit";

let root: Root;
let updatedAt: string;
const start = Date.UTC(2026, 10, 8, 12);
function Probe({ show = true, completedAt }: { show?: boolean; completedAt?: string }) {
  useThreadVisit({
    environmentId: EnvironmentId.make("mac"),
    threadId: ThreadId.make("thread"),
    threadKey: "mac:thread",
    updatedAt,
    completedAt,
    lastVisitedAt: null,
    showContent: show,
    visitThread: harness.visit,
  });
  return null;
}
function focus(value: boolean) {
  act(() => {
    harness.focused = value;
    harness.focusListeners.forEach((listener) => listener());
  });
}
function appState(value: string) {
  act(() => {
    harness.appState = value;
    harness.appListeners.forEach((listener) => listener(value));
  });
}
function render(completedAt?: string) {
  act(() => root.render(<Probe completedAt={completedAt} />));
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  vi.setSystemTime(start);
  harness.focused = true;
  harness.appState = "active";
  harness.visit.mockClear();
  updatedAt = new Date(start).toISOString();
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not mark completions read under another screen or in the background", () => {
  harness.focused = false;
  render(updatedAt);
  expect(harness.visit).not.toHaveBeenCalled();
  appState("background");
  focus(true);
  expect(harness.visit).not.toHaveBeenCalled();
  appState("active");
  expect(harness.visit).toHaveBeenCalledOnce();
});

it.each(["blur", "background"])(
  "cancels trailing visits on %s and catches up on return",
  (mode) => {
    render();
    expect(harness.visit).toHaveBeenCalledOnce();
    act(() => vi.advanceTimersByTime(1_000));
    updatedAt = new Date(start + 1_000).toISOString();
    render();
    expect(vi.getTimerCount()).toBe(1);
    if (mode === "blur") focus(false);
    else appState("background");
    expect(vi.getTimerCount()).toBe(0);
    act(() => vi.advanceTimersByTime(20_000));
    expect(harness.visit).toHaveBeenCalledOnce();
    if (mode === "blur") focus(true);
    else appState("active");
    expect(harness.visit).toHaveBeenCalledTimes(2);
    expect(harness.visit.mock.lastCall?.[0].input.visitedAt).toBe(updatedAt);
  },
);

it.each(["blur", "background"])(
  "rechecks native visibility if %s precedes effect cleanup",
  (mode) => {
    render();
    updatedAt = new Date(start + 1_000).toISOString();
    render();
    // Change the native value without notifying React, reproducing that small race.
    if (mode === "blur") harness.focused = false;
    else harness.appState = "background";
    act(() => vi.advanceTimersByTime(10_000));
    expect(harness.visit).toHaveBeenCalledOnce();
  },
);

it("does not visit a hidden pane even when its navigator is focused", () => {
  act(() => root.render(<Probe show={false} completedAt={updatedAt} />));
  expect(harness.visit).not.toHaveBeenCalled();
});
