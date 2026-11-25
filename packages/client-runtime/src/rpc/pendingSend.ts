import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { EnvironmentRpcUnavailableError, isRpcClientError } from "./client.ts";
import type { RpcSession } from "./session.ts";

const isUnavailable = Schema.is(EnvironmentRpcUnavailableError);

const unavailable = (message: string) =>
  Effect.flatMap(EnvironmentSupervisor, ({ target }) =>
    Effect.fail(
      new EnvironmentRpcUnavailableError({
        environmentId: target.environmentId,
        message: `${target.label} ${message}`,
      }),
    ),
  );

export const withSendTimeout = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => unavailable("did not confirm the message within 60 seconds."),
    }),
  );

/** Wait only for a validated session. A stopped environment releases the composer immediately. */
export const awaitSendSession = Effect.fn("EnvironmentRpc.awaitSendSession")(function* (
  previous?: RpcSession,
) {
  const supervisor = yield* EnvironmentSupervisor;
  const session = yield* SubscriptionRef.get(supervisor.session);
  if (Option.isSome(session) && session.value !== previous) return session.value;
  const state = yield* SubscriptionRef.get(supervisor.state);
  if (!state.desired || state.phase === "blocked") return yield* unavailable("is not connected.");
  if (state.phase === "backoff" && !previous) yield* supervisor.retryNow;
  const next = yield* Effect.raceFirst(
    SubscriptionRef.changes(supervisor.session).pipe(
      Stream.filter(Option.isSome),
      Stream.map((candidate) => candidate.value),
      Stream.filter((candidate) => candidate !== previous),
      Stream.runHead,
    ),
    SubscriptionRef.changes(supervisor.state).pipe(
      Stream.filter(
        (value) => !value.desired || value.phase === "blocked" || value.phase === "available",
      ),
      Stream.runHead,
      Effect.as(Option.none<RpcSession>()),
    ),
  ).pipe(
    Effect.timeoutOrElse({
      duration: "5 minutes",
      orElse: () => unavailable("did not reconnect within 5 minutes."),
    }),
  );
  return Option.isSome(next) ? next.value : yield* unavailable("is not connected.");
});

/** Call only with an exact payload bearing a server-replayable command or message ID. */
export const sendWithSocketRecovery = Effect.fn("EnvironmentRpc.sendWithSocketRecovery")(function* <
  A,
  E,
  R,
>(operation: Effect.Effect<A, E, R>) {
  const supervisor = yield* EnvironmentSupervisor;
  let session = yield* awaitSendSession();
  for (let resends = 0; ; resends++) {
    const exit = yield* Effect.exit(withSendTimeout(operation));
    if (Exit.isSuccess(exit)) return exit.value;
    const current = yield* SubscriptionRef.get(supervisor.session);
    const lost =
      Cause.hasInterruptsOnly(exit.cause) ||
      exit.cause.reasons.some(
        (reason) =>
          reason._tag === "Fail" &&
          (isRpcClientError(reason.error) ||
            (isUnavailable(reason.error) && Option.getOrUndefined(current) !== session)),
      );
    if (!lost || resends >= 2) return yield* exit;
    // A protocol error can leave this very socket live. A successful probe makes
    // the original error actionable immediately. A close proceeds to reconnect.
    if (Option.getOrUndefined(current) === session) {
      const healthy = yield* Effect.raceFirst(
        session.probe.pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        ),
        SubscriptionRef.changes(supervisor.session).pipe(
          Stream.filter((candidate) => Option.getOrUndefined(candidate) !== session),
          Stream.runHead,
          Effect.as(false),
        ),
      ).pipe(Effect.timeoutOrElse({ duration: "3 seconds", orElse: () => Effect.succeed(false) }));
      if (Option.getOrUndefined(yield* SubscriptionRef.get(supervisor.session)) === session) {
        if (healthy) return yield* exit;
        yield* supervisor.retryNow;
        // The supervisor can confirm this slow socket and keep it. Reuse the
        // exact identified payload on whichever session it currently publishes.
        session = yield* awaitSendSession();
        continue;
      }
    }
    // Preserve the request failure when the user elects to disconnect.
    const replacement = yield* awaitSendSession(session).pipe(Effect.option);
    if (Option.isNone(replacement)) return yield* exit;
    session = replacement.value;
  }
});
