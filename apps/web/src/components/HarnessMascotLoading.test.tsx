// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const load = vi.hoisted(() => vi.fn<(id: string) => Promise<void>>());
vi.mock("@t3tools/shared/harnessMascots", async (original) => ({
  ...(await original<typeof import("@t3tools/shared/harnessMascots")>()),
  loadHarnessMascotAnimations: load,
}));
vi.mock("./HarnessMascotSprite", () => ({
  MascotSprite: () => createElement("span", { "data-loaded-mascot": true }),
}));

import { HarnessMascot, preloadHarnessMascot } from "./HarnessMascot";

it("keeps a rejected pet load inside its placeholder and retries on a later mount", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  load.mockImplementation(async () => {
    throw new Error("Temporary chunk fetch failure");
  });
  const host = document.createElement("div");
  const uncaught = vi.fn();
  const caught = vi.fn();
  const root = createRoot(host, { onUncaughtError: uncaught, onCaughtError: caught });
  const chat = (show: boolean) => (
    <main>
      <p>Conversation stays mounted</p>
      {show ? <HarnessMascot driver="codex" size={48} /> : null}
    </main>
  );
  try {
    await act(async () => root.render(chat(true)));
    expect(caught).toHaveBeenCalled();
    expect(uncaught).not.toHaveBeenCalled();
    expect(host.textContent).toBe("Conversation stays mounted");
    expect(host.querySelector("[data-loaded-mascot]")).toBeNull();
    const placeholder = host.querySelector<HTMLSpanElement>('span[aria-hidden="true"]');
    expect(placeholder?.style.width).toBe("48px");
    expect(placeholder?.style.height).toBe("48px");

    const attempts = load.mock.calls.length;
    act(() => root.render(chat(false)));
    load.mockResolvedValue(undefined);
    await act(async () => {
      root.render(chat(true));
      await preloadHarnessMascot("codex");
    });
    expect(load).toHaveBeenCalledTimes(attempts + 1);
    expect(host.querySelector("[data-loaded-mascot]")).not.toBeNull();
    expect(host.querySelector('span[aria-hidden="true"]')).toBeNull();
    expect(host.textContent).toBe("Conversation stays mounted");
    expect(uncaught).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
