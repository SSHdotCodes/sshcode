// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { appHasAttention, installAppAttentionMotionPause } from "./appAttention";

function fakeAnimation(iterations: number) {
  const animation = {
    playState: "running" as AnimationPlayState,
    effect: { getTiming: () => ({ iterations }) },
    pause: vi.fn(() => {
      animation.playState = "paused";
    }),
    play: vi.fn(() => {
      animation.playState = "running";
    }),
  };
  return animation;
}

function stubAnimations(animations: ReadonlyArray<ReturnType<typeof fakeAnimation>>) {
  Object.defineProperty(document, "getAnimations", {
    configurable: true,
    value: () => animations,
  });
}

describe("app attention", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    Reflect.deleteProperty(document, "getAnimations");
  });

  it("holds endless animations while another app is in front and resumes them on focus", () => {
    const shimmer = fakeAnimation(Infinity);
    const fadeIn = fakeAnimation(1);
    stubAnimations([shimmer, fadeIn]);
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const dispose = installAppAttentionMotionPause();
    expect(shimmer.pause).not.toHaveBeenCalled();

    focused.mockReturnValue(false);
    window.dispatchEvent(new Event("blur"));
    expect(shimmer.playState).toBe("paused");
    // A block fading in behind another app still reaches full opacity.
    expect(fadeIn.pause).not.toHaveBeenCalled();

    focused.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    expect(shimmer.playState).toBe("running");
    dispose();
  });

  it("leaves an animation that ended while held ended", () => {
    const shimmer = fakeAnimation(Infinity);
    stubAnimations([shimmer]);
    const focused = vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const dispose = installAppAttentionMotionPause();
    expect(shimmer.playState).toBe("paused");

    // Its row stopped working: the style went away and cancelled the animation.
    shimmer.playState = "idle";
    focused.mockReturnValue(true);
    window.dispatchEvent(new Event("focus"));
    expect(shimmer.play).not.toHaveBeenCalled();
    dispose();
  });

  it("counts a hidden window as unattended even when it holds focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    expect(appHasAttention()).toBe(false);
  });

  it("stays attended while the in-app browser has focus", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const webview = document.createElement("webview");
    webview.tabIndex = 0;
    document.body.append(webview);
    webview.focus();
    expect(appHasAttention()).toBe(true);
    webview.remove();
  });
});
