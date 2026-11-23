import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("renderer quit persistence", () => {
  it("flushes a draft before its debounce expires so it can be rehydrated", async () => {
    vi.useFakeTimers();
    const window = new EventTarget();
    vi.stubGlobal("window", window);
    const { useComposerDraftStore } = await import("./composerDraftStore");
    const target = scopeThreadRef(EnvironmentId.make("quit-env"), ThreadId.make("quit-thread"));
    useComposerDraftStore.getState().setPrompt(target, "last unsent edit");
    window.dispatchEvent(new Event("t3code:flush-pending-storage"));
    useComposerDraftStore.setState({ draftsByThreadKey: {} });
    await useComposerDraftStore.persist.rehydrate();
    expect(useComposerDraftStore.getState().getComposerDraft(target)?.prompt).toBe(
      "last unsent edit",
    );
  });
});
