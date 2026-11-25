// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { STATUS_CROSSFADE_EXIT_MS, StatusCrossfade } from "./StatusCrossfade";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("StatusCrossfade", () => {
  it("renders silently on first paint without outgoing ghost or entrance animation", async () => {
    await act(async () => {
      root.render(
        <StatusCrossfade scopeKey="thread-1" statusKey="working" snapshot="Working">
          Working
        </StatusCrossfade>,
      );
    });

    expect(container.querySelector("[data-status-crossfade-out]")).toBeNull();
    expect(container.querySelector("[data-status-crossfade-in]")).toBeNull();
    expect(container.textContent).toBe("Working");
  });

  it("crossfades live status changes and cleans up the outgoing ghost after the exit duration", async () => {
    vi.useFakeTimers();
    await act(async () => {
      root.render(
        <StatusCrossfade scopeKey="thread-1" statusKey="working" snapshot="Working">
          Working
        </StatusCrossfade>,
      );
    });

    await act(async () => {
      root.render(
        <StatusCrossfade scopeKey="thread-1" statusKey="input" snapshot="Needs you">
          Needs you
        </StatusCrossfade>,
      );
    });

    const outgoing = container.querySelector("[data-status-crossfade-out]");
    const incoming = container.querySelector("[data-status-crossfade-in]");
    expect(outgoing?.textContent).toBe("Working");
    expect(outgoing?.getAttribute("aria-hidden")).toBe("true");
    expect(incoming?.textContent).toBe("Needs you");

    await act(async () => {
      vi.advanceTimersByTime(STATUS_CROSSFADE_EXIT_MS);
    });
    expect(container.querySelector("[data-status-crossfade-out]")).toBeNull();
    expect(container.textContent).toBe("Needs you");
  });

  it("resets without crossfading when the owning entity changes", async () => {
    await act(async () => {
      root.render(
        <StatusCrossfade scopeKey="thread-1" statusKey="working" snapshot="Working">
          Working
        </StatusCrossfade>,
      );
    });

    await act(async () => {
      root.render(
        <StatusCrossfade scopeKey="thread-2" statusKey="idle" snapshot="2m">
          2m
        </StatusCrossfade>,
      );
    });

    expect(container.querySelector("[data-status-crossfade-out]")).toBeNull();
    expect(container.querySelector("[data-status-crossfade-in]")).toBeNull();
    expect(container.textContent).toBe("2m");
  });
});
