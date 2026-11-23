// @vitest-environment jsdom
import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { useDeadlineClock } from "./useDeadlineClock";

it("wakes an unchanged thread at its deadline and leaves no timer running", () => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const deadlines = [2_147_483_647 + 350];
  const shell = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    snoozedUntil: new Date(deadlines[0]!).toISOString(),
  };
  const node = document.createElement("div");
  const root = createRoot(node);
  function Status() {
    const now = new Date(useDeadlineClock(deadlines)).toISOString();
    return effectiveSnoozed(shell, { now }) ? "Snoozed" : threadWokeAt(shell, { now });
  }
  try {
    act(() => root.render(<Status />));
    expect(node.textContent).toBe("Snoozed");
    act(() => vi.advanceTimersByTime(deadlines[0]! - 1));
    expect(node.textContent).toBe("Snoozed");
    act(() => vi.advanceTimersByTime(1));
    expect(node.textContent).toBe(shell.snoozedUntil);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
