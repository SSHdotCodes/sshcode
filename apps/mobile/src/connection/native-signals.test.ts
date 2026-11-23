import { Connectivity, Wakeups } from "@t3tools/client-runtime/connection";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { beforeEach, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  read: vi.fn<() => Promise<{ isConnected: boolean; type: string }>>(),
  network: vi.fn(),
  appState: vi.fn(),
  removeNetwork: vi.fn(),
  removeAppState: vi.fn(),
}));
vi.mock("expo-network", () => ({
  getNetworkStateAsync: native.read,
  addNetworkStateListener: native.network.mockReturnValue({ remove: native.removeNetwork }),
}));
vi.mock("react-native", () => ({
  AppState: {
    currentState: "active",
    addEventListener: native.appState.mockReturnValue({ remove: native.removeAppState }),
  },
}));

import * as NativeSignals from "./native-signals";

describe("shared native connection signals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.read.mockImplementation(() => new Promise(() => {}));
    native.network.mockReturnValue({ remove: native.removeNetwork });
  });

  it.effect.each([120, 5_000])(
    "lets a cached screen open during a %i ms native path read",
    (nativeMs) =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
        try {
          native.read.mockImplementation(
            () =>
              new Promise((resolve) =>
                setTimeout(() => resolve({ isConnected: true, type: "WIFI" }), nativeMs),
              ),
          );
          const start = Date.now();
          const ready = yield* Effect.gen(function* () {
            const context = yield* NativeSignals.make;
            const path = Context.get(context, Connectivity.Connectivity);
            // Registry construction reads the status once, then starts supervisors in parallel.
            yield* path.status;
            yield* path.changes.pipe(Stream.runDrain, Effect.forkScoped);
            yield* Effect.all([path.status, path.status, path.status, path.status], {
              concurrency: "unbounded",
            });
            // Simulated local first-screen cache.
            yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 8)));
            return Date.now() - start;
          }).pipe(Effect.scoped, Effect.forkChild({ startImmediately: true }));
          yield* Effect.promise(() => vi.advanceTimersByTimeAsync(2 * nativeMs + 8));
          expect(yield* Fiber.join(ready)).toBe(8);
          expect(native.read).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      }),
  );
  it.effect("shares listeners across supervisors and wakeup consumers and releases them once", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const listening = yield* Deferred.make<void>();
        native.network.mockImplementation(() => {
          Deferred.doneUnsafe(listening, Exit.void);
          return { remove: native.removeNetwork };
        });
        const context = yield* NativeSignals.make;
        const connectivity = Context.get(context, Connectivity.Connectivity);
        const wakeups = Context.get(context, Wakeups.ConnectionWakeups);
        const statuses = yield* Queue.unbounded<string>();
        const reasons = yield* Queue.unbounded<string>();
        const fibers = yield* Effect.forEach(
          [
            connectivity.changes.pipe(Stream.runForEach((status) => Queue.offer(statuses, status))),
            connectivity.changes.pipe(Stream.runForEach((status) => Queue.offer(statuses, status))),
            wakeups.changes.pipe(Stream.runForEach((reason) => Queue.offer(reasons, reason))),
            wakeups.changes.pipe(Stream.runForEach((reason) => Queue.offer(reasons, reason))),
          ],
          (effect) => Effect.forkChild(effect),
        );
        yield* Deferred.await(listening);
        yield* TestClock.adjust(0);
        expect(native.network).toHaveBeenCalledTimes(1);
        expect(native.appState).toHaveBeenCalledTimes(1);
        const record = native.network.mock.calls[0]![0];
        record({ isConnected: true, type: "WIFI" });
        expect(yield* Queue.take(statuses)).toBe("online");
        expect(yield* Queue.take(statuses)).toBe("online");
        expect(yield* connectivity.status).toBe("online");
        expect(yield* connectivity.changes.pipe(Stream.runHead)).toMatchObject({ value: "online" });
        record({ isConnected: true, type: "CELLULAR" });
        expect(yield* Queue.take(reasons)).toBe("network-changed");
        expect(yield* Queue.take(reasons)).toBe("network-changed");
        yield* Fiber.interrupt(fibers[0]!);
        expect(native.removeNetwork).not.toHaveBeenCalled();
        yield* Effect.forEach(fibers.slice(1), (fiber) => Fiber.interrupt(fiber));
        expect(native.removeNetwork).toHaveBeenCalledTimes(1);
        expect(native.removeAppState).toHaveBeenCalledTimes(1);
      }),
    ),
  );
  it.effect(
    "keeps the current cellular path when a foreground read returns an older offline result",
    () =>
      Effect.gen(function* () {
        const initial = Promise.withResolvers<{ isConnected: boolean; type: string }>();
        const foreground = Promise.withResolvers<{ isConnected: boolean; type: string }>();
        const listening = yield* Deferred.make<void>();
        native.read
          .mockImplementationOnce(() => {
            Deferred.doneUnsafe(listening, Exit.void);
            return initial.promise;
          })
          .mockReturnValueOnce(foreground.promise);
        const finished = yield* Deferred.make<void>();
        const context = yield* NativeSignals.make;
        const seen: string[] = [];
        yield* Context.get(context, Connectivity.Connectivity).changes.pipe(
          Stream.runForEach((status) =>
            Effect.sync(() => {
              seen.push(status);
              if (status === "unknown" && seen.includes("online"))
                Deferred.doneUnsafe(finished, Exit.void);
            }),
          ),
          Effect.forkScoped,
        );
        yield* Deferred.await(listening);
        const report = native.network.mock.calls[0]![0];
        initial.resolve({ isConnected: true, type: "WIFI" });
        yield* Effect.promise(() => initial.promise);
        yield* TestClock.adjust(0);
        native.appState.mock.calls[0]![1]("active");
        report({ isConnected: true, type: "CELLULAR" });
        foreground.resolve({ isConnected: false, type: "NONE" });
        yield* Effect.promise(() => foreground.promise);
        report({});
        yield* Deferred.await(finished);
        expect(seen).not.toContain("offline");
        expect(seen.at(-2)).toBe("online");
      }).pipe(Effect.scoped),
  );
});
