import { afterEach, vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterFirstPaint } from "./after-first-paint";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("first-screen paint yield", () => {
  it.live(
    "allows a frame to paint between publishing the preview and starting full hydration",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers();
        const frames: FrameRequestCallback[] = [];
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
          frames.push(callback),
        );
        vi.stubGlobal("cancelAnimationFrame", vi.fn());
        let done = false;
        const pending = yield* afterFirstPaint.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              done = true;
            }),
          ),
          Effect.forkChild({ startImmediately: true }),
        );
        expect(frames).toHaveLength(1);
        frames[0]!(0);
        expect(done).toBe(false);
        expect(frames).toHaveLength(2);
        frames[1]!(16);
        yield* Fiber.join(pending);
        expect(done).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      }),
  );

  it.live("also releases background launches that receive no frames", () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      vi.stubGlobal("requestAnimationFrame", undefined);
      const pending = yield* afterFirstPaint.pipe(Effect.forkChild({ startImmediately: true }));
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(50));
      yield* Fiber.join(pending);
      expect(vi.getTimerCount()).toBe(0);
    }),
  );
});
