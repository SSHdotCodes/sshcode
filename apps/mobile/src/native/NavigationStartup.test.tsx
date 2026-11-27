// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ hideSplash: vi.fn(), supportsGlass: true }));
vi.mock("expo-splash-screen", () => ({ hide: mocks.hideSplash }));
vi.mock("./native-glass", () => ({
  get NATIVE_LIQUID_GLASS_SUPPORTED() {
    return mocks.supportsGlass;
  },
}));

import { NavigationStartup } from "./NavigationStartup";

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.hideSplash.mockClear();
  mocks.supportsGlass = true;
});

afterEach(() => vi.unstubAllGlobals());

it("finishes applying the saved appearance before it mounts navigation under the splash", () => {
  const events: string[] = [];
  mocks.hideSplash.mockImplementation(() => events.push("splash hidden"));
  const container = document.createElement("div");
  const root = createRoot(container);
  function Navigation() {
    useLayoutEffect(() => {
      events.push("native navigation mounted");
    }, []);
    return <input defaultValue="draft" />;
  }
  function App({ ready }: { ready: boolean }) {
    useLayoutEffect(() => {
      if (ready) events.push("appearance applied");
    }, [ready]);
    return (
      <NavigationStartup appearanceReady={ready}>
        <Navigation />
      </NavigationStartup>
    );
  }

  try {
    act(() => root.render(<App ready={false} />));
    expect(events).toEqual([]);
    act(() => root.render(<App ready />));
    expect(events).toEqual(["appearance applied", "native navigation mounted", "splash hidden"]);
    const input = container.querySelector("input");
    act(() => root.render(<App ready={false} />));
    expect(container.querySelector("input")).toBe(input);
  } finally {
    act(() => root.unmount());
    mocks.hideSplash.mockReset();
  }
});

it("mounts navigation immediately on platforms without native glass", () => {
  mocks.supportsGlass = false;
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    act(() =>
      root.render(
        <NavigationStartup appearanceReady={false}>
          <p>Chats</p>
        </NavigationStartup>,
      ),
    );
    expect(container.textContent).toBe("Chats");
    expect(mocks.hideSplash).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});
