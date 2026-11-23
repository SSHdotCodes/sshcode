import * as Effect from "effect/Effect";

/** Give the preview a frame to commit and paint before decoding the full cache. */
export const afterFirstPaint = Effect.callback<void>((resume) => {
  let first: number | undefined;
  let second: number | undefined;
  const cleanup = () => {
    clearTimeout(timeout);
    if (first !== undefined) cancelAnimationFrame(first);
    if (second !== undefined) cancelAnimationFrame(second);
  };
  const done = () => {
    cleanup();
    resume(Effect.void);
  };
  // Background launches may not receive animation frames; never stall their sync.
  // @effect-diagnostics-next-line globalTimersInEffect:off
  const timeout = setTimeout(done, 50);
  if (typeof requestAnimationFrame === "function") {
    first = requestAnimationFrame(() => {
      second = requestAnimationFrame(done);
    });
  }
  return Effect.sync(cleanup);
});
