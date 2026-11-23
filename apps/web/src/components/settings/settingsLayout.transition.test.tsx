// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vite-plus/test";
import { scrollToSettingsTarget } from "./settingsLayout";

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("scrolls again after the opening transition only while the result keeps focus", async () => {
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  class Transition {
    transitionProperty = "height";
    finished: Promise<void>;
    constructor(finished: Promise<void>) {
      this.finished = finished;
    }
  }
  vi.stubGlobal("CSSTransition", Transition);
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  document.body.innerHTML =
    '<div data-slot="collapsible-panel" data-open><div id="target" tabindex="-1"></div><button id="other"></button></div>';
  const panel = document.querySelector<HTMLElement>('[data-slot="collapsible-panel"]')!;
  const target = document.getElementById("target")!;
  const scroll = vi.fn();
  target.scrollIntoView = scroll;
  panel.getAnimations = () => [new Transition(finished) as unknown as Animation];
  expect(scrollToSettingsTarget("target")).toBe(true);
  expect(scroll).toHaveBeenCalledTimes(1);
  finish();
  await finished;
  expect(scroll).toHaveBeenCalledTimes(2);

  let finishAgain!: () => void;
  const again = new Promise<void>((resolve) => {
    finishAgain = resolve;
  });
  panel.getAnimations = () => [new Transition(again) as unknown as Animation];
  scrollToSettingsTarget("target");
  document.getElementById("other")!.focus();
  finishAgain();
  await again;
  expect(scroll).toHaveBeenCalledTimes(3);
});
