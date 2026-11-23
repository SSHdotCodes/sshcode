// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const evaluated = vi.hoisted(() => new Set<string>());
vi.mock("react-native", () => ({
  View: () => createElement("div"),
}));
vi.mock("./HarnessMascotSprite", () => {
  evaluated.add("renderer");
  return { MascotSprite: () => createElement("div", { "data-loaded-pet": true }) };
});
vi.mock("./harnessMascotAssets/codex", () => {
  evaluated.add("codex");
  return { sprites: { "codex-idle.webp": 1 } };
});
vi.mock("./harnessMascotAssets/claude", () => {
  evaluated.add("claude");
  return { sprites: {}, pixels: {} };
});
vi.mock("./harnessMascotAssets/kimi", () => {
  evaluated.add("kimi");
  return { sprites: {} };
});
vi.mock("../../assets/mascots/clawd-pixels.json", () => {
  throw new Error("Clawd pixels must not load for another mascot.");
});

it("loads only the shown pet and leaves Clawd pixels and hidden pets uninitialized", async () => {
  const { loadHarnessMascotAssets } = await import("./harnessMascotAssets");
  expect(evaluated.size).toBe(0);
  const assets = await loadHarnessMascotAssets("codex");
  expect(assets.sprites["codex-idle.webp"]).toBe(1);
  expect([...evaluated]).toEqual(["codex"]);

  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  evaluated.clear();
  const { HarnessMascot, preloadHarnessMascot } = await import("./HarnessMascot");
  expect(evaluated.size).toBe(0);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        createElement(HarnessMascot, { driver: "acpRegistry", agentId: "kimi", visible: false }),
      ),
    );
    expect(evaluated.size).toBe(0);
    await act(async () => {
      root.render(createElement(HarnessMascot, { driver: "acpRegistry", agentId: "kimi" }));
      await preloadHarnessMascot("kimi");
    });
    expect([...evaluated].sort()).toEqual(["kimi", "renderer"]);
    expect(host.querySelector("[data-loaded-pet]")).not.toBeNull();
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
