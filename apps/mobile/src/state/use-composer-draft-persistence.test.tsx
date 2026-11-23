// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  listeners: new Set<(state: string) => void>(),
  flush: vi.fn(async () => {}),
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener(_event: string, listener: (state: string) => void) {
      harness.listeners.add(listener);
      return { remove: () => harness.listeners.delete(listener) };
    },
  },
}));
vi.mock("./use-composer-drafts", () => ({ flushComposerDrafts: harness.flush }));

import { useComposerDraftPersistence } from "./use-composer-draft-persistence";

let root: Root;
function Probe(props: { readonly draftKey: string | null }) {
  useComposerDraftPersistence(props.draftKey);
  return null;
}
function render(draftKey: string | null) {
  act(() => root.render(<Probe draftKey={draftKey} />));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.flush.mockClear();
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

describe("composer draft persistence lifecycle", () => {
  it("flushes the last keystroke on backgrounding before the debounce can run", () => {
    render("chat-a");
    for (const listener of harness.listeners) listener("active");
    expect(harness.flush).not.toHaveBeenCalled();
    for (const listener of harness.listeners) listener("inactive");
    expect(harness.flush).toHaveBeenCalledOnce();
    for (const listener of harness.listeners) listener("background");
    expect(harness.flush).toHaveBeenCalledTimes(2);
  });

  it("flushes on leaving a chat and removes its background listener", () => {
    render("chat-a");
    render(null);
    expect(harness.flush).toHaveBeenCalledOnce();
    expect(harness.listeners.size).toBe(0);
  });

  it("flushes the previous draft when switching chats and subscribes only once", () => {
    render("chat-a");
    render("chat-b");
    expect(harness.flush).toHaveBeenCalledOnce();
    expect(harness.listeners.size).toBe(1);
    render("chat-b");
    expect(harness.flush).toHaveBeenCalledOnce();
  });
});
