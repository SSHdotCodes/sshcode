import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "t3/serverActivation",
  { defaultValue: () => undefined },
) {}

/** Forks a long-running root before commit, returning it after it reaches the activation boundary. */
export const forkParkedFiber = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<Fiber.Fiber<A, E>, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      return yield* Effect.forkScoped(effect);
    }
    const parked = yield* Deferred.make<void>();
    const fiber = yield* Effect.forkScoped(
      Deferred.succeed(parked, undefined).pipe(Effect.andThen(activation), Effect.andThen(effect)),
    );
    yield* Deferred.await(parked);
    return fiber;
  });

/** Forks a long-running root before commit and proves it is parked at the activation boundary. */
export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> => forkParkedFiber(effect).pipe(Effect.asVoid);

/**
 * How long background chores wait after activation. The server sets a minute,
 * so cleanups stay out of the way of the first chat list and chat opens.
 */
export class BackgroundChoresDelay extends Context.Reference<Duration.Duration>(
  "t3/backgroundChoresDelay",
  { defaultValue: () => Duration.zero },
) {}

/** forkParked for a chore that can wait: it starts BackgroundChoresDelay after activation. */
export const forkParkedChore = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> =>
  Effect.gen(function* () {
    const delay = yield* BackgroundChoresDelay;
    yield* forkParked(Duration.isZero(delay) ? effect : Effect.delay(effect, delay));
  });
