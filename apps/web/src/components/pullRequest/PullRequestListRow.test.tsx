// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { PullRequestRowLines } from "./PullRequestListRow";

it("updates the age of an unchanged pull request while the list stays open", () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.setSystemTime(new Date("2026-11-19T12:05:00Z"));
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        <PullRequestRowLines number="#42" title="Fix" updatedAt="2026-11-19T12:00:00Z" />,
      ),
    );
    expect(host.textContent).toContain("5m ago");
    act(() => vi.advanceTimersByTime(60_000));
    expect(host.textContent).toContain("6m ago");
  } finally {
    act(() => root.unmount());
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
