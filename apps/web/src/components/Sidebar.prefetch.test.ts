import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createSidebarPrefetch } from "./Sidebar.prefetch";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("sidebar intent prefetch", () => {
  it("refreshes a completed reply instead of reusing the previous run's preview", async () => {
    let reply = "old reply";
    const load = vi.fn(async () => reply);
    const prefetch = createSidebarPrefetch({ load });
    prefetch.request("chat", "run:working");
    await vi.advanceTimersByTimeAsync(80);
    reply = "new reply";
    prefetch.request("chat", "run:completed");
    await vi.advanceTimersByTimeAsync(80);
    expect(prefetch.snapshot("chat")).toBe("new reply");
    expect(load).toHaveBeenCalledTimes(2);
    prefetch.request("chat", "run:completed");
    await vi.advanceTimersByTimeAsync(80);
    expect(load).toHaveBeenCalledTimes(2);
    prefetch.dispose();
  });
  it("can load after an effect cleanup and re-setup without reviving canceled work", async () => {
    const load = vi.fn(async (key: string) => key);
    const prefetch = createSidebarPrefetch({ load });
    prefetch.request("old");
    await vi.advanceTimersByTimeAsync(40);
    prefetch.cancel();
    prefetch.request("new");
    await vi.advanceTimersByTimeAsync(80);
    expect(load.mock.calls.map(([key]) => key)).toEqual(["new"]);
    prefetch.cancel();
    expect(prefetch.snapshot("new")).toBe("new");
    prefetch.request("new");
    await vi.advanceTimersByTimeAsync(80);
    expect(load).toHaveBeenCalledOnce();
    prefetch.dispose();
  });
  it("ignores a passing pointer and shares hover/focus intent for one chat", async () => {
    const load = vi.fn(async (key: string) => key);
    const prefetch = createSidebarPrefetch({ load });
    const leave = prefetch.request("passing");
    await vi.advanceTimersByTimeAsync(40);
    leave();
    const blur = prefetch.request("target");
    const unhover = prefetch.request("target");
    blur();
    await vi.advanceTimersByTimeAsync(80);
    expect(load.mock.calls).toEqual([["target", expect.any(AbortSignal)]]);
    expect(prefetch.snapshot("target")).toBe("target");
    unhover();
    prefetch.request("target");
    await vi.advanceTimersByTimeAsync(80);
    expect(load).toHaveBeenCalledOnce();
    prefetch.dispose();
  });

  it("caps in-flight loads, cancels on leave and removes queued work", async () => {
    const finishes = new Map<string, (value: string) => void>();
    const signals = new Map<string, AbortSignal>();
    const load = vi.fn(
      (key: string, signal: AbortSignal) =>
        new Promise<string>((resolve) => {
          finishes.set(key, resolve);
          signals.set(key, signal);
        }),
    );
    const prefetch = createSidebarPrefetch({ load });
    const leaveA = prefetch.request("a");
    prefetch.request("b");
    const leaveC = prefetch.request("c");
    prefetch.request("d");
    await vi.advanceTimersByTimeAsync(80);
    expect(load.mock.calls.map(([key]) => key)).toEqual(["a", "b"]);
    leaveC();
    leaveA();
    expect(signals.get("a")?.aborted).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
    finishes.get("a")!("late");
    await vi.advanceTimersByTimeAsync(0);
    expect(load.mock.calls.map(([key]) => key)).toEqual(["a", "b", "d"]);
    expect(prefetch.snapshot("a")).toBeUndefined();
    prefetch.dispose();
    expect(signals.get("b")?.aborted).toBe(true);
    expect(signals.get("d")?.aborted).toBe(true);
  });

  it("never lets an old completion replace a newer intent", async () => {
    const finishes: Array<(value: string) => void> = [];
    const prefetch = createSidebarPrefetch({
      load: () => new Promise<string>((resolve) => finishes.push(resolve)),
    });
    const leave = prefetch.request("chat");
    await vi.advanceTimersByTimeAsync(80);
    leave();
    prefetch.request("chat");
    await vi.advanceTimersByTimeAsync(80);
    finishes[1]!("new");
    await vi.advanceTimersByTimeAsync(0);
    finishes[0]!("old");
    await vi.advanceTimersByTimeAsync(0);
    expect(prefetch.snapshot("chat")).toBe("new");
    prefetch.dispose();
  });

  it("bounds cached previews and retries failures without unhandled rejections", async () => {
    const load = vi.fn(async (key: string) => {
      if (key === "failure") throw new Error("offline");
      return key;
    });
    const prefetch = createSidebarPrefetch({ load, cacheSize: 2, cacheMs: 100 });
    for (const key of ["a", "b", "c", "failure"]) {
      prefetch.request(key);
      await vi.advanceTimersByTimeAsync(80);
    }
    expect(prefetch.snapshot("a")).toBeUndefined();
    expect(prefetch.snapshot("c")).toBe("c");
    prefetch.request("c");
    await vi.advanceTimersByTimeAsync(80);
    expect(load.mock.calls.filter(([key]) => key === "c")).toHaveLength(1);
    prefetch.request("failure");
    await vi.advanceTimersByTimeAsync(80);
    expect(load.mock.calls.filter(([key]) => key === "failure")).toHaveLength(2);
    prefetch.dispose();
    prefetch.request("after-dispose");
    await vi.advanceTimersByTimeAsync(80);
    expect(load.mock.calls.some(([key]) => key === "after-dispose")).toBe(false);
  });

  it("keeps the preview bound when concurrent loads complete together", async () => {
    const prefetch = createSidebarPrefetch({ load: async (key: string) => key, cacheSize: 1 });
    prefetch.request("a");
    prefetch.request("b");
    await vi.advanceTimersByTimeAsync(80);
    expect(prefetch.snapshot("a")).toBeUndefined();
    expect(prefetch.snapshot("b")).toBe("b");
    prefetch.dispose();
  });

  it("starts immediately on pointerdown and promotes a pending hover intent without duplicating work", async () => {
    const load = vi.fn(async (key: string) => key);
    const prefetch = createSidebarPrefetch({ load, delayMs: 120, concurrency: 1 });

    // Immediate request without a prior hover runs before the hover delay elapses.
    const releaseDirect = prefetch.request("direct", "r1", { immediate: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenLastCalledWith("direct", expect.any(AbortSignal));
    releaseDirect();

    // Pending hover promoted to immediate starts right away and shares one load.
    const leaveHover = prefetch.request("promoted", "r1");
    await vi.advanceTimersByTimeAsync(40);
    expect(load).toHaveBeenCalledTimes(1);
    const releaseDown = prefetch.request("promoted", "r1", { immediate: true });
    // Leaving hover during click must not abort the pointerdown handoff.
    leaveHover();
    await vi.advanceTimersByTimeAsync(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenLastCalledWith("promoted", expect.any(AbortSignal));
    expect(prefetch.snapshot("promoted")).toBe("promoted");
    releaseDown();
    prefetch.dispose();
  });
});
