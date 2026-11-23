/**
 * Whether anyone can be watching the window. Decorative motion (working shimmers, badge
 * dabs, mascot sprites) runs only while it is visible and focused: an endless animation
 * keeps Chromium drawing frames at the display's rate even with another app in front.
 */
export function appHasAttention(): boolean {
  if (document.hidden) return false;
  if (document.hasFocus()) return true;
  // The in-app browser's <webview> takes focus from this document; it is still our window.
  return document.activeElement?.tagName === "WEBVIEW";
}

export function subscribeAppAttention(listener: () => void): () => void {
  window.addEventListener("focus", listener);
  window.addEventListener("blur", listener);
  document.addEventListener("visibilitychange", listener);
  return () => {
    window.removeEventListener("focus", listener);
    window.removeEventListener("blur", listener);
    document.removeEventListener("visibilitychange", listener);
  };
}

function isEndless(animation: Animation): boolean {
  return animation.effect?.getTiming().iterations === Infinity;
}

/**
 * Holds endless animations (working shimmers, badge dabs, bolt glows) while nobody can be
 * watching and resumes them on focus. One-shot animations keep running: a block fading in
 * as a reply streams must still reach full opacity behind another app.
 */
export function installAppAttentionMotionPause(): () => void {
  if (typeof document.getAnimations !== "function") return () => {};
  const held = new Set<Animation>();
  const hold = (animation: Animation) => {
    if (animation.playState !== "running" || !isEndless(animation)) return;
    animation.pause();
    held.add(animation);
  };
  // Animations that start while unattended (a chat begins working) are held as they start.
  const holdStarted = (event: AnimationEvent) => {
    if (!(event.target instanceof Element)) return;
    for (const animation of event.target.getAnimations({ subtree: true })) {
      if ("animationName" in animation && animation.animationName === event.animationName) {
        hold(animation);
      }
    }
  };
  let attended = true;
  const sync = () => {
    const next = appHasAttention();
    if (next === attended) return;
    attended = next;
    if (!next) {
      for (const animation of document.getAnimations()) hold(animation);
      document.addEventListener("animationstart", holdStarted, true);
      return;
    }
    document.removeEventListener("animationstart", holdStarted, true);
    // An animation whose element left the page or lost its style is idle; leave it ended.
    for (const animation of held) if (animation.playState === "paused") animation.play();
    held.clear();
  };
  sync();
  const unsubscribe = subscribeAppAttention(sync);
  return () => {
    unsubscribe();
    document.removeEventListener("animationstart", holdStarted, true);
    for (const animation of held) if (animation.playState === "paused") animation.play();
    held.clear();
  };
}
