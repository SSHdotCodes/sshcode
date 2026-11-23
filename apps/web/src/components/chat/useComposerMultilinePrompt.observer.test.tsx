// @vitest-environment jsdom
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { useComposerMultilinePrompt } from "./useComposerMultilinePrompt";

const observers = vi.hoisted(() => ({ resize: () => {}, mutate: () => {} }));
vi.mock("../../lib/observeResize", () => ({
  observeResize: (_: unknown, callback: () => void) => {
    observers.resize = callback;
    return () => {};
  },
}));
afterEach(() => vi.unstubAllGlobals());
it("coalesces prompt mutations and resize observations into one layout read per frame", async () => {
  let nextId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextId, callback);
    return nextId;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        observers.mutate = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  const bounds = vi.fn(() => new DOMRect(0, 0, 100, 20));
  vi.stubGlobal("getComputedStyle", () => ({
    paddingLeft: "0",
    paddingRight: "0",
    lineHeight: "20",
  }));
  const range = document.createRange();
  range.getBoundingClientRect = bounds;
  vi.spyOn(document, "createRange").mockReturnValue(range);
  const body = document.createElement("div");
  const editor = document.createElement("div");
  editor.dataset.testid = "composer-editor";
  body.append(editor);
  Object.defineProperty(body, "clientWidth", { value: 200 });
  Object.defineProperty(editor, "clientWidth", { value: 200 });
  function Probe() {
    return <output>{String(useComposerMultilinePrompt(body))}</output>;
  }
  let view: ReactTestRenderer;
  await act(() => {
    view = create(<Probe />);
  });
  try {
    observers.resize();
    observers.mutate();
    observers.mutate();
    expect(bounds).not.toHaveBeenCalled();
    expect(frames.size).toBe(1);
    await act(() => {
      const callbacks = [...frames.values()];
      frames.clear();
      callbacks.forEach((callback) => callback(0));
    });
    expect(bounds).toHaveBeenCalledTimes(1);
    observers.mutate();
    expect(frames.size).toBe(1);
  } finally {
    await act(() => view.unmount());
    expect(frames.size).toBe(0);
    vi.restoreAllMocks();
  }
});
