// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({ appChanged: (_state: string) => {} }));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  Pressable: ({
    children,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    onPress: () => void;
    disabled: boolean;
  }) => createElement("button", { onClick: onPress, disabled }, children),
  AppState: {
    addEventListener: (_event: string, listener: (value: string) => void) => {
      native.appChanged = listener;
      return { remove() {} };
    },
  },
}));
vi.mock("./AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => createElement("span", null, children),
}));
vi.mock("react-native-reanimated", () => {
  const animation = { duration: () => ({ reduceMotion() {} }) };
  return {
    default: {
      View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
    },
    FadeIn: animation,
    FadeOut: animation,
    ReduceMotion: { System: "system" },
  };
});

import { MascotCompanion } from "./MascotCompanion";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("clears a tap reaction when the hero scrolls away or the app backgrounds", () => {
  const render = (visible: boolean) =>
    root.render(
      <MascotCompanion size={96} visible={visible}>
        {() => null}
      </MascotCompanion>,
    );
  act(() => render(true));
  act(() => host.querySelector("button")!.click());
  expect(host.textContent).toBe("♥");
  act(() => render(false));
  expect(host.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  act(() => host.querySelector("button")!.click());
  expect(host.textContent).toBe("");
  act(() => render(true));
  act(() => vi.advanceTimersByTime(3000));
  act(() => host.querySelector("button")!.click());
  expect(host.textContent).toBe("♥");
  act(() => native.appChanged("background"));
  expect(host.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});
