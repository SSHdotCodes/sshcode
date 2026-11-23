// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
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
    ].map((id) => preloadHarnessMascot(id as Parameters<typeof preloadHarnessMascot>[0])),
  ),
);

let root: Root;
let host: HTMLDivElement;
let intersect: (visible: boolean) => void;
let reduced = false;
let motionChanged: () => void;
let hidden = false;
let focused = true;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(Math, "random").mockReturnValue(0);
  hidden = false;
  focused = true;
  reduced = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return reduced;
    },
    addEventListener: (_: string, listener: () => void) => {
      motionChanged = listener;
    },
    removeEventListener: vi.fn(),
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
        intersect = (visible) => callback([{ isIntersecting: visible }]);
      }
      observe() {
        intersect(true);
      }
      disconnect() {}
    },
  );
  host = document.createElement("div");
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const sheet = () => host.querySelector<HTMLSpanElement>("span > span")!.style.backgroundImage;

it("uses only visible time for idle drift and stops scheduling offscreen", async () => {
  await act(async () => root.render(<HarnessMascot driver="claudeAgent" />));
  const first = sheet();
  act(() => vi.advanceTimersByTime(10_000));
  act(() => intersect(false));
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(120_000));
  expect(sheet()).toBe(first);
  act(() => intersect(true));
  act(() => vi.advanceTimersByTime(9999));
  expect(sheet()).toBe(first);
  act(() => vi.advanceTimersByTime(2));
  expect(sheet()).not.toBe(first);
  act(() => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("stops drawing frames while another app is in front and resumes on focus", async () => {
  await act(async () => root.render(<HarnessMascot driver="claudeAgent" />));
  expect(vi.getTimerCount()).toBeGreaterThan(0);
  act(() => {
    focused = false;
    window.dispatchEvent(new Event("blur"));
  });
  expect(vi.getTimerCount()).toBe(0);
  act(() => {
    focused = true;
    window.dispatchEvent(new Event("focus"));
  });
  expect(vi.getTimerCount()).toBeGreaterThan(0);
});

it("retains variant history across turn transitions and freezes reduced motion", async () => {
  await act(async () => root.render(<HarnessMascot driver="grok" state="done" />));
  const first = sheet();
  act(() => root.render(<HarnessMascot driver="grok" state="working" />));
  act(() => root.render(<HarnessMascot driver="grok" state="done" />));
  expect(sheet()).not.toBe(first);
  act(() => {
    reduced = true;
    motionChanged();
  });
  const poster = sheet();
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(120_000));
  expect(sheet()).toBe(poster);
  act(() => root.render(<HarnessMascot driver="grok" state="idea" still />));
  expect(sheet()).toContain("grok-idea.webp");
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
])("animates %s/%s and settles its celebration into idle", async (driver, agentId, id) => {
  await act(async () =>
    root.render(<HarnessMascot driver={driver} agentId={agentId} state="done" />),
  );
  expect(sheet()).toContain(`${id}-done.webp`);
  const sprite = () => host.querySelector<HTMLSpanElement>("span > span")!;
  const initial = sprite().style.backgroundPosition;
  act(() => vi.advanceTimersByTime(151));
  expect(sprite().style.backgroundPosition).not.toBe(initial);
  act(() => vi.advanceTimersByTime(4000));
  expect(sheet()).toContain(`${id}-idle.webp`);
});

it("inherits ACP identity, remounts on agent changes and isolates explicit drivers", async () => {
  const render = (agentId: string, explicit = false) => (
    <HarnessMascotDriver value="acpRegistry">
      <HarnessMascotAgentId value={agentId}>
        <HarnessMascot driver={explicit ? "acpRegistry" : undefined} state="working" />
      </HarnessMascotAgentId>
    </HarnessMascotDriver>
  );
  await act(async () => root.render(render("kimi")));
  expect(sheet()).toContain("kimi-working.webp");
  act(() => vi.advanceTimersByTime(500));
  await act(async () => root.render(render("mistral-vibe")));
  expect(sheet()).toContain("mistral-working.webp");
  expect(vi.getTimerCount()).toBe(1);
  await act(async () => root.render(render("kimi", true)));
  expect(sheet()).toContain("acp-working.webp");
  act(() => root.render(<HarnessMascot driver={null} />));
  expect(host.innerHTML).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});
