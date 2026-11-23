import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Per-origin estimates, shared by HTTP and the socket, without persisting network conditions. */
export function makeNetworkTiming() {
  const estimates = new Map<string, { mean: number; deviation: number; latest: number }>();
  const origin = (url: string) => new URL(url).host;
  return {
    observe: (url: string, milliseconds: number) => {
      if (!Number.isFinite(milliseconds) || milliseconds < 0) return;
      const key = origin(url);
      const previous = estimates.get(key);
      estimates.set(
        key,
        previous === undefined
          ? { mean: milliseconds, deviation: milliseconds / 2, latest: milliseconds }
          : {
              mean: previous.mean * 0.875 + milliseconds * 0.125,
              deviation: previous.deviation * 0.75 + Math.abs(previous.mean - milliseconds) * 0.25,
              latest: milliseconds,
            },
      );
      if (estimates.size > 128) estimates.delete(estimates.keys().next().value!);
    },
    reset: (url: string) => {
      estimates.delete(origin(url));
    },
    budget: (url: string, minimumMs: number) => {
      const estimate = estimates.get(origin(url));
      return estimate === undefined
        ? minimumMs
        : Math.max(
            minimumMs,
            Math.min(
              120_000,
              Math.ceil(
                Math.max(estimate.mean, estimate.latest) * 6 + estimate.deviation * 8 + 750,
              ),
            ),
          );
    },
  };
}

export class NetworkTiming extends Context.Service<
  NetworkTiming,
  ReturnType<typeof makeNetworkTiming>
>()("@t3tools/client-runtime/connection/networkTiming") {}

export class RequestProgress extends Context.Reference<
  | {
      readonly received: () => void;
      readonly lastReceived: () => bigint;
    }
  | undefined
>("@t3tools/client-runtime/connection/RequestProgress", { defaultValue: () => undefined }) {}

/** A transfer may remain active on slow links, but never occupy a request indefinitely. */
export const NETWORK_REQUEST_MAX_DURATION_MS = 5 * 60_000;

/** Shared receive-idle progress across nested requests, with a total backstop for each call. */
export const withReceiveIdleTimeout = <A, E, R, E2, R2>(
  requestUrl: string | undefined,
  timeoutMs: number,
  request: Effect.Effect<A, E, R>,
  onTimeout: (budgetMs: number) => Effect.Effect<never, E2, R2>,
): Effect.Effect<A, E | E2, R | R2> =>
  Effect.gen(function* () {
    const clock = yield* Clock.Clock;
    const timing = yield* Effect.serviceOption(NetworkTiming);
    const startedAt = clock.monotonicTimeNanosUnsafe();
    let lastReceived = startedAt;
    const inherited = yield* RequestProgress;
    const progress = inherited ?? {
      received: () => {
        lastReceived = clock.monotonicTimeNanosUnsafe();
      },
      lastReceived: () => lastReceived,
    };
    const watchdog = Effect.gen(function* () {
      for (;;) {
        const budget =
          requestUrl !== undefined && Option.isSome(timing)
            ? timing.value.budget(requestUrl, timeoutMs)
            : timeoutMs;
        const last = progress.lastReceived();
        const remaining =
          BigInt(budget) * 1_000_000n -
          (clock.monotonicTimeNanosUnsafe() - (last > startedAt ? last : startedAt));
        if (remaining <= 0n) return yield* onTimeout(budget);
        yield* Effect.sleep(Duration.nanos(remaining));
      }
    });
    return yield* Effect.raceFirst(request, watchdog).pipe(
      Effect.provideService(RequestProgress, progress),
      Effect.timeoutOrElse({
        duration: NETWORK_REQUEST_MAX_DURATION_MS,
        orElse: () => onTimeout(NETWORK_REQUEST_MAX_DURATION_MS),
      }),
    );
  });
