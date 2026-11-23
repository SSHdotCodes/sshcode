// @vitest-environment jsdom
import { act, createElement, type CSSProperties, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  appearance: "light",
  focused: true,
  appChanged: (_state: string) => {},
  motionChanged: (_reduced: boolean) => {},
}));
vi.mock("@react-navigation/native", () => ({ useIsFocused: () => native.focused }));
vi.mock("react-native", () => ({
  // The appearance setting drives the system scheme, which is all the sprite reads.
  useColorScheme: () => native.appearance,
  View: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  PixelRatio: { get: () => 3 },
  AccessibilityInfo: {
    isReduceMotionEnabled: () => Promise.resolve(false),
    addEventListener: (_event: string, listener: (value: boolean) => void) => {
      native.motionChanged = listener;
      return { remove() {} };
    },
  },
  AppState: {
    currentState: "active",
    addEventListener: (_event: string, listener: (value: string) => void) => {
      native.appChanged = listener;
      return { remove() {} };
    },
  },
}));
vi.mock("react-native-svg", () => ({
  default: ({ children }: { children: ReactNode }) => createElement("svg", null, children),
  Path: ({ fill, d }: { fill: string; d: string }) => createElement("path", { fill, d }),
}));
vi.mock("expo-image", () => ({
  Image: ({ source, style }: { source: string; style: CSSProperties }) =>
    createElement("div", { "data-sheet": source, style }),
}));
vi.mock("./harnessMascotAssets", () => ({
  loadHarnessMascotAssets: async (id: string) => ({
    sprites: new Proxy({}, { get: (_target, file) => file }),
    ...(id === "claude"
      ? { pixels: (await import("../../assets/mascots/clawd-pixels.json")).default }
      : {}),
  }),
}));
vi.mock("../native/v5-workspace-context", async () => {
  const { createContext } = await import("react");
  return { NativeWorkspaceTabActivityContext: createContext(null) };
});

import {
  HarnessMascot,
  HarnessMascotAgentId,
  HarnessMascotDriver,
  preloadHarnessMascot,
} from "./HarnessMascot";

beforeAll(() =>
  Promise.all(
    [
      "claude",
      "codex",
      "grok",
      "muse",
      "cursor",
      "opencode",
      "pi",
      "gemini",
      "kimi",
      "mistral",
      "acp",
      "devin",
      "qwen",
    ].map((id) => preloadHarnessMascot(id as Parameters<typeof preloadHarnessMascot>[0])),
  ),
);

let root: Root;
let host: HTMLDivElement;
const sheet = () => host.querySelector("[data-sheet]")!.getAttribute("data-sheet");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Math, "random").mockReturnValue(0);
  native.focused = true;
  native.appearance = "light";
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("pauses drift when backgrounded, unfocused or explicitly hidden", async () => {
  await act(async () => root.render(<HarnessMascot driver="grok" />));
  const first = sheet();
  act(() => vi.advanceTimersByTime(10_000));
  act(() => native.appChanged("background"));
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(90_000));
  act(() => native.appChanged("active"));
  expect(sheet()).toBe(first);
  act(() => vi.advanceTimersByTime(10_001));
  expect(sheet()).not.toBe(first);
  act(() => {
    native.focused = false;
    root.render(<HarnessMascot driver="grok" />);
  });
  expect(vi.getTimerCount()).toBe(0);
  act(() => {
    native.focused = true;
    root.render(<HarnessMascot driver="grok" visible={false} />);
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("shows a flat pet in light ink on a dark theme, and other pets as they are", async () => {
  native.appearance = "dark";
  await act(async () => root.render(<HarnessMascot driver="grok" state="idea" still />));
  expect(sheet()).toBe("grok-dark-idea.webp");
  act(() =>
    root.render(<HarnessMascot driver="acpRegistry" agentId="qwen-code" state="idea" still />),
  );
  expect(sheet()).toBe("qwen-idea.webp");
});

it("keeps event history across states and uses still poses for reduced motion", async () => {
  await act(async () => root.render(<HarnessMascot driver="grok" state="done" />));
  const first = sheet();
  act(() => root.render(<HarnessMascot driver="grok" state="working" />));
  act(() => root.render(<HarnessMascot driver="grok" state="done" />));
  expect(sheet()).not.toBe(first);
  act(() => native.motionChanged(true));
  expect(vi.getTimerCount()).toBe(0);
  expect(sheet()).toBe("grok-done.webp");
  act(() => root.render(<HarnessMascot driver="grok" state="idea" still />));
  expect(sheet()).toBe("grok-idea.webp");
});

it("animates Clawd's source pixels and stops updating them under reduced motion", async () => {
  await act(async () => root.render(<HarnessMascot driver="claudeAgent" state="greet" />));
  expect(host.querySelector("path")).not.toBeNull();
  const first = host.innerHTML;
  act(() => vi.advanceTimersByTime(500));
  expect(host.innerHTML).not.toBe(first);
  act(() => native.motionChanged(true));
  const poster = host.innerHTML;
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(60_000));
  expect(host.innerHTML).toBe(poster);
});

it.each([
  ["cursor", null, "cursor"],
  ["opencode", null, "opencode"],
  ["pi", null, "pi"],
  ["antigravity", null, "gemini"],
  ["acpRegistry", "kimi", "kimi"],
  ["acpRegistry", "devin", "devin"],
  ["acpRegistry", "mistral-vibe", "mistral"],
  ["acpRegistry", "future-agent", "acp"],
])("animates %s/%s and pauses its celebration when hidden", async (driver, agentId, id) => {
  await act(async () =>
    root.render(<HarnessMascot driver={driver} agentId={agentId} state="done" />),
  );
  expect(sheet()).toBe(`${id}-done.webp`);
  const sprite = () => host.querySelector<HTMLDivElement>("[data-sheet]")!;
  const initial = sprite().style.left;
  act(() => vi.advanceTimersByTime(151));
  expect(sprite().style.left).not.toBe(initial);
  act(() =>
    root.render(<HarnessMascot driver={driver} agentId={agentId} state="done" visible={false} />),
  );
  const paused = sprite().style.left;
  act(() => vi.advanceTimersByTime(4000));
  expect(sprite().style.left).toBe(paused);
  expect(vi.getTimerCount()).toBe(0);
  act(() => root.render(<HarnessMascot driver={driver} agentId={agentId} state="done" />));
  act(() => vi.advanceTimersByTime(4000));
  expect(sheet()).toBe(`${id}-idle.webp`);
});

it("inherits ACP identity and starts the next agent's player from its own clock", async () => {
  const render = (agentId: string, explicit = false) => (
    <HarnessMascotDriver value="acpRegistry">
      <HarnessMascotAgentId value={agentId}>
        <HarnessMascot driver={explicit ? "acpRegistry" : undefined} state="working" />
      </HarnessMascotAgentId>
    </HarnessMascotDriver>
  );
  await act(async () => root.render(render("kimi")));
  expect(sheet()).toBe("kimi-working.webp");
  act(() => vi.advanceTimersByTime(500));
  await act(async () => root.render(render("mistral-vibe")));
  expect(sheet()).toBe("mistral-working.webp");
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.render(render("kimi", true)));
  expect(sheet()).toBe("acp-working.webp");
  act(() => root.render(<HarnessMascot driver={null} />));
  expect(host.innerHTML).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});
