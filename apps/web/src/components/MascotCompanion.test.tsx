// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vite-plus/test";
import { HarnessMascot, HarnessMascotDriver, preloadHarnessMascot } from "./HarnessMascot";
import { MascotCompanion } from "./MascotCompanion";
import { DesktopMascot } from "./chat/DesktopMascot";

beforeAll(() =>
  Promise.all([
    preloadHarnessMascot("grok"),
    preloadHarnessMascot("codex"),
    preloadHarnessMascot("kimi"),
  ]),
);

let host: HTMLDivElement;
let root: Root;
let hidden = false;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  localStorage.clear();
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each([
  ["grok", null, "grok"],
  ["codex", null, "codex"],
  ["acpRegistry", "kimi", "kimi"],
])(
  "acknowledges pets for %s/%s under reduced motion and clears interaction timers",
  async (driver, agentId, id) => {
    await act(async () =>
      root.render(
        <MascotCompanion size={96}>
          {(state) => <HarnessMascot driver={driver} agentId={agentId} state={state} size={96} />}
        </MascotCompanion>,
      ),
    );
    expect(host.querySelector("[data-harness-mascot]")?.getAttribute("data-harness-mascot")).toBe(
      id,
    );
    const button = host.querySelector("button")!;
    expect(button.getAttribute("aria-label")).toBe("Pet your companion");
    act(() => button.click());
    expect(host.textContent).toBe("♥");
    act(() => vi.advanceTimersByTime(500));
    act(() => button.click());
    expect(host.textContent).toBe("♥♥");
    expect(host.querySelector("[data-mascot-state]")?.getAttribute("data-mascot-state")).toBe(
      "idea",
    );
    const poster = host.querySelector("[data-mascot-state]")?.innerHTML;
    act(() => vi.advanceTimersByTime(500));
    expect(host.querySelector("[data-mascot-state]")?.innerHTML).toBe(poster);
    act(() => button.click());
    expect(host.textContent).toBe("♥♥♥");
    act(() => vi.advanceTimersByTime(1600));
    expect(host.textContent).toBe("");
    act(() => button.click());
    expect(host.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  },
);

it("drops a pet on backgrounding and never paints through the hide preference", async () => {
  const render = () =>
    root.render(
      <HarnessMascotDriver value="grok">
        <DesktopMascot state="waiting" moment={{ kind: "waiting", text: "Your turn 👋" }} />
      </HarnessMascotDriver>,
    );
  await act(async () => render());
  act(() => host.querySelector("button")!.click());
  expect(host.textContent).toContain("♥");
  expect(host.querySelector("[data-mascot-state]")?.getAttribute("data-mascot-state")).toBe(
    "waiting",
  );
  act(() => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
  });
  expect(host.textContent).not.toContain("♥");
  expect(vi.getTimerCount()).toBe(0);
  act(() => {
    localStorage.setItem("sshcode.desktop-mascot", "false");
    window.dispatchEvent(new Event("sshcode:desktop-mascot"));
  });
  expect(host.innerHTML).toBe("");
});
