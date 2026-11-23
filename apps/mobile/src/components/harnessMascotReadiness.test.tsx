// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const deferred = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<{ sprites: Record<string, number> }>((done) => {
    resolve = () => done({ sprites: {} });
  });
  let resolveCodex!: () => void;
  const codex = new Promise<{ sprites: Record<string, number> }>((done) => {
    resolveCodex = () => done({ sprites: {} });
  });
  return {
    promise,
    resolve: () => resolve(),
    codex,
    resolveCodex: () => resolveCodex(),
    mounts: 0,
  };
});
vi.mock("react-native", () => ({ View: () => createElement("div") }));
vi.mock("./harnessMascotAssets", () => ({
  loadHarnessMascotAssets: (id: string) => (id === "codex" ? deferred.codex : deferred.promise),
}));
vi.mock("./HarnessMascotSprite", () => ({
  MascotSprite: () => {
    const [mount] = useState(() => ++deferred.mounts);
    return createElement("div", { "data-loaded-pet": true, "data-mount": mount });
  },
}));

it("reports readiness only after the pet's resources resolve and renders without a blank fallback", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const { HarnessMascot, preloadHarnessMascot, useHarnessMascotReady } =
    await import("./HarnessMascot");
  function Result() {
    const ready = useHarnessMascotReady("grok");
    return ready
      ? createElement(HarnessMascot, { driver: "grok" })
      : createElement("span", null, "Loading");
  }
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(createElement(Result)));
    expect(host.textContent).toBe("Loading");
    expect(host.querySelector("[data-loaded-pet]")).toBeNull();
    await act(async () => {
      deferred.resolve();
      await preloadHarnessMascot("grok");
    });
    expect(host.textContent).toBe("");
    expect(host.querySelector("[data-loaded-pet]")).not.toBeNull();
    await act(async () =>
      root.render(createElement(HarnessMascot, { driver: "codex", state: "working" })),
    );
    expect(host.querySelector("[data-loaded-pet]")).toBeNull();
    await act(async () => {
      deferred.resolveCodex();
      await preloadHarnessMascot("codex");
    });
    const mount = host.querySelector("[data-loaded-pet]")?.getAttribute("data-mount");
    expect(mount).toBeDefined();
    act(() => root.render(createElement(HarnessMascot, { driver: "codex", state: "done" })));
    expect(host.querySelector("[data-loaded-pet]")?.getAttribute("data-mount")).toBe(mount);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
