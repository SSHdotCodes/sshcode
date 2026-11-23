// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { segmentCasualMessage, parseCasualDecisions } from "@t3tools/shared/casualVoice";
import { CasualBurst } from "./CasualBurst";

let root: Root;
let host: HTMLDivElement;
const display = parseCasualDecisions(
  segmentCasualMessage("The answer is ready.\nHope this helps.", "final"),
  "1 say: the answer is ready\n+ say: here is the next bit\n+ say: and the last bit\n2 hide: filler",
)!;
const render = (text: string) => createElement("p", null, text);
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("reveals live bubbles in order with typing between them and expands hidden originals", async () => {
  await act(async () =>
    root.render(
      createElement(CasualBurst, {
        display,
        live: true,
        visible: true,
        reducedMotion: false,
        agent: "buddy",
        render,
      }),
    ),
  );
  expect(host.querySelectorAll("[data-casual-bubble]").length).toBe(1);
  expect(host.textContent).toContain("buddy is typing…");
  expect(host.textContent).not.toContain("Hope this helps.");
  await act(async () =>
    host.querySelector<HTMLButtonElement>("[data-casual-hidden] button")!.click(),
  );
  expect(host.textContent).toContain("Hope this helps.");
  await act(async () => vi.advanceTimersByTime(6000));
  expect(host.querySelectorAll("[data-casual-bubble]").length).toBe(3);
  expect(host.textContent).not.toContain("is typing");
});
it.each([
  { live: false, visible: true, reducedMotion: false },
  { live: true, visible: false, reducedMotion: false },
  { live: true, visible: true, reducedMotion: true },
])("does not delay history, hidden chats or reduced motion: %j", async (options) => {
  await act(async () =>
    root.render(createElement(CasualBurst, { display, ...options, agent: "buddy", render })),
  );
  expect(host.querySelectorAll("[data-casual-bubble]").length).toBe(3);
  expect(host.textContent).not.toContain("is typing");
});
it("finishes a burst when scrolled out and never replays it on return", async () => {
  const props = {
    display,
    live: true,
    visible: true,
    reducedMotion: false,
    agent: "buddy",
    render,
  };
  await act(async () => root.render(createElement(CasualBurst, props)));
  await act(async () => root.render(createElement(CasualBurst, { ...props, visible: false })));
  await act(async () => root.render(createElement(CasualBurst, props)));
  expect(host.querySelectorAll("[data-casual-bubble]").length).toBe(3);
  expect(host.textContent).not.toContain("is typing");
});
