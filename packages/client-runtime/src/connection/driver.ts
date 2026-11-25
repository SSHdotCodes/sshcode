import {
  ConnectionTimings,
  INITIAL_SYNCHRONIZATION_MAX_MS,
  ROUTE_SYNCHRONIZATION_TIMEOUT,
} from "./timings.ts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as HttpClient from "effect/http/HttpClient";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import type {
  ConnectionAttemptError,
  ConnectionAttemptStage,
  ConnectionTarget,
  PreparedConnection,
} from "./model.ts";
import { ConnectionTransientError } from "./model.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "./errors.ts";
import * as ConnectionResolver from "./resolver.ts";
import { connectionRouteId, connectionRoutes, routeEntry, routeHttpBaseUrl } from "./routes.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcSession from "../rpc/session.ts";
import { RemoteEnvironmentAuthTimeoutError } from "../rpc/http.ts";
import {
  fetchRemoteEnvironmentDescriptor,
  RECENT_DESCRIPTOR_TTL_MS,
  RecentEnvironmentDescriptors,
} from "../environment/descriptor.ts";
import { NetworkTiming, RequestProgress, withReceiveIdleTimeout } from "./networkTiming.ts";

export type ConnectionDriverProgress =
  | {
      readonly stage: "preparing";
      readonly target?: ConnectionTarget;
    }
  | {
      readonly stage: "route-failed";
      readonly target: ConnectionTarget;
      readonly error: ConnectionAttemptError;
    }
  | {
      readonly stage: Exclude<ConnectionAttemptStage, "preparing">;
      readonly prepared: PreparedConnection;
      readonly session?: RpcSession.RpcSession;
    };

export interface EnvironmentConnectionLease {
  readonly prepared: PreparedConnection;
  readonly session: RpcSession.RpcSession;
}

/**
 * The result of an unauthenticated reachability check. T3 Connect and SSH
 * routes have no cheap check, so they are "unchecked".
 */
export type RouteCheck = "answered" | "silent" | "unchecked";

/** How long a direct route has to answer before it is deprioritized, not discarded. */
const ROUTE_CHECK_TIMEOUT_MS = 2_500;

/**
 * How long a route authorized ahead stands in for authorizing it again: the
 * address was checked when it started, the same freshness the recent
 * descriptor cache allows before a credential goes there.
 */
export const PREPARED_AHEAD_TTL_MS = RECENT_DESCRIPTOR_TTL_MS;

export class ConnectionDriver extends Context.Service<
  ConnectionDriver,
  {
    readonly connect: (
      entry: ConnectionCatalogEntry,
      reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
    ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, Scope.Scope>;
    /** Whether a direct route answers as the entry's environment, without credentials. */
    readonly checkRoute: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<RouteCheck>;
    /**
     * Whether a direct route answers and accepts this client's credential,
     * without opening a socket. Switching to a route that fails this would
     * drop a working connection for nothing.
     */
    readonly preflight: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<boolean>;
    /**
     * Starts authorizing a route in the background, for a reconnect that may
     * follow shortly. A connect over that route within
     * {@link PREPARED_AHEAD_TTL_MS} uses it instead of authorizing again.
     */
    readonly prepareAhead?: (
      entry: ConnectionCatalogEntry,
      route: ConnectionRoute,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/driver/ConnectionDriver") {}

/**
 * Connects over an answering route without waiting for an unreachable preferred
 * address. Checks run together; a lower-priority answer gives earlier routes
 * 200 ms to answer too, then proceeds. Already answered routes retain their
 * preference order. A silent route is skipped on the first pass. A route
 * that fails to connect moves on to the next: a signed-out T3 Connect must
 * not hide a working LAN. Silent routes are tried last, since a check is not
 * proof.
 *
 * The reported error is a transient one when any route failed transiently,
 * so the supervisor keeps retrying a route that may come back; a blocked
 * error is reported only when every attempted route was blocked.
 */
export const connectOverRoutes = Effect.fn("ConnectionDriver.connectOverRoutes")(function* <R>(
  entry: ConnectionCatalogEntry,
  checkRoute: (route: ConnectionRoute) => Effect.Effect<RouteCheck>,
  connectRoute: (
    route: ConnectionRoute,
  ) => Effect.Effect<EnvironmentConnectionLease, ConnectionAttemptError, R | Scope.Scope>,
  reportFailure: (
    route: ConnectionRoute,
    error: ConnectionAttemptError,
  ) => Effect.Effect<void> = () => Effect.void,
  hedgeAfterMs?: number,
  lastGoodRouteId?: string,
) {
  const routes = connectionRoutes(entry);
  const lastGoodIndex =
    lastGoodRouteId === undefined
      ? -1
      : routes.findIndex((route) => connectionRouteId(route.target) === lastGoodRouteId);
  type RouteEvent =
    | { readonly stage: "checked"; readonly index: number; readonly check: RouteCheck }
    | {
        readonly stage: "completed";
        readonly index: number;
        readonly result: Exit.Exit<EnvironmentConnectionLease, ConnectionAttemptError>;
      }
    | { readonly stage: "hedge"; readonly index: number }
    | { readonly stage: "preference-expired" };
  const completed = yield* Queue.unbounded<RouteEvent>();
  const attemptScope = yield* Scope.Scope;
  const clock = yield* Clock.Clock;
  const inheritedProgress = yield* RequestProgress;
  const activeRoutes = new Map<number, RouteCheck>();
  const workers: Fiber.Fiber<unknown, unknown>[] = [];
  const ready = new Map<number, RouteCheck>();
  const checked = new Set<number>();
  const routeScopes = new Map<number, Scope.Closeable>();
  let winningIndex: number | undefined;
  let remainingChecks = routes.length === 1 ? 0 : routes.length;
  if (routes.length === 1) ready.set(0, "unchecked");
  for (let index = 0; index < remainingChecks; index++) {
    const route = routes[index]!;
    workers.push(
      yield* checkRoute(route).pipe(
        Effect.flatMap((check) => Queue.offer(completed, { stage: "checked", index, check })),
        Effect.forkChild,
      ),
    );
  }
  let transient: ConnectionAttemptError | undefined;
  let blocked: ConnectionAttemptError | undefined;
  let active = 0;
  let mayStart = true;
  let preferenceGrace: "unused" | "waiting" | "finished" = "unused";
  const acceptCheck = (event: Extract<RouteEvent, { stage: "checked" }>) => {
    remainingChecks--;
    checked.add(event.index);
    ready.set(event.index, event.check);
  };
  const start = Effect.fnUntraced(function* (index: number) {
    const check = ready.get(index) ?? "unchecked";
    active++;
    activeRoutes.set(index, check);
    let receivedAt = clock.monotonicTimeNanosUnsafe();
    const progress = {
      received: () => {
        receivedAt = clock.monotonicTimeNanosUnsafe();
        inheritedProgress?.received();
      },
      lastReceived: () => receivedAt,
    };
    mayStart = false;
    ready.delete(index);
    const route = routes[index]!;
    const routeScope = yield* Scope.fork(attemptScope);
    routeScopes.set(index, routeScope);
    workers.push(
      yield* connectRoute(route).pipe(
        Scope.provide(routeScope),
        Effect.provideService(RequestProgress, progress),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : Scope.close(routeScope, exit),
        ),
        Effect.exit,
        Effect.flatMap((result) => Queue.offer(completed, { stage: "completed", index, result })),
        Effect.forkChild,
      ),
    );
    if (hedgeAfterMs !== undefined) {
      workers.push(
        yield* Effect.gen(function* () {
          for (;;) {
            const remaining =
              receivedAt + BigInt(hedgeAfterMs) * 1_000_000n - clock.monotonicTimeNanosUnsafe();
            if (remaining <= 0n) {
              yield* Queue.offer(completed, { stage: "hedge", index });
              return;
            }
            yield* Effect.sleep(Duration.nanos(remaining));
          }
        }).pipe(Effect.forkChild),
      );
    }
  });
  return yield* Effect.gen(function* () {
    for (;;) {
      const eligible = [...ready.keys()].sort((a, b) => a - b);
      const preferredReady =
        eligible.find((index) => ready.get(index) !== "silent") ??
        (remainingChecks === 0 ? eligible[0] : undefined);
      const lastGoodReady =
        lastGoodIndex !== -1 && ready.has(lastGoodIndex) && ready.get(lastGoodIndex) !== "silent"
          ? lastGoodIndex
          : undefined;
      // Prefer any higher-ranked route that already answered; otherwise start
      // the last known good route immediately without waiting on silent routes.
      const next =
        lastGoodReady !== undefined &&
        (preferredReady === undefined ||
          (preferredReady < lastGoodReady && ready.get(preferredReady) !== "answered"))
          ? lastGoodReady
          : preferredReady;
      if (mayStart && active < (hedgeAfterMs === undefined ? 1 : 2) && next !== undefined) {
        const awaitingPreferred =
          next !== lastGoodReady &&
          preferenceGrace !== "finished" &&
          routes.slice(0, next).some((_, index) => !checked.has(index));
        if (!awaitingPreferred) {
          preferenceGrace = "finished";
          yield* start(next);
        } else if (preferenceGrace === "unused") {
          preferenceGrace = "waiting";
          workers.push(
            yield* Effect.sleep("200 millis").pipe(
              Effect.andThen(Queue.offer(completed, { stage: "preference-expired" })),
              Effect.forkChild({ startImmediately: true }),
            ),
          );
        }
      }
      if (remainingChecks === 0 && ready.size === 0 && active === 0) {
        return yield* (
          transient ??
            blocked ??
            new ConnectionTransientError({
              reason: "endpoint-unavailable",
              detail: `${entry.target.label} did not answer on any saved route.`,
            })
        );
      }
      const event = yield* Queue.take(completed);
      if (event.stage === "hedge") {
        if (activeRoutes.has(event.index)) mayStart = true;
        continue;
      }
      if (event.stage === "preference-expired") {
        preferenceGrace = "finished";
        continue;
      }
      if (event.stage === "checked") {
        acceptCheck(event);
        // When an unchecked fallback (e.g. relay) already started, immediately
        // race a higher-priority direct route as soon as it answers.
        if (
          event.check === "answered" &&
          hedgeAfterMs !== undefined &&
          active < 2 &&
          [...activeRoutes.entries()].some(
            ([activeIndex, activeCheck]) =>
              activeCheck === "unchecked" && event.index < activeIndex,
          )
        ) {
          mayStart = true;
        }
        continue;
      }
      active--;
      activeRoutes.delete(event.index);
      if (Exit.isSuccess(event.result)) {
        winningIndex = event.index;
        return event.result.value;
      }
      const failure = event.result.cause.reasons.find(Cause.isFailReason);
      if (failure === undefined) return yield* Effect.failCause(event.result.cause);
      const error = failure.error;
      yield* reportFailure(routes[event.index]!, error);
      if (error.reason === "unsupported") return yield* error;
      if (error._tag === "ConnectionTransientError") transient ??= error;
      else blocked ??= error;
      mayStart = true;
    }
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        yield* Effect.forEach(workers, Fiber.interrupt, { discard: true });
        for (const [index, scope] of routeScopes) {
          if (index !== winningIndex) yield* Scope.close(scope, Exit.succeed(undefined));
        }
      }),
    ),
  );
});

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const timings = yield* ConnectionTimings;
  const resolver = yield* ConnectionResolver.ConnectionResolver;
  const sessions = yield* RpcSession.RpcSessionFactory;
  const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
  const httpClient = yield* HttpClient.HttpClient;
  const recentDescriptors = yield* Effect.serviceOption(RecentEnvironmentDescriptors);
  const networkTiming = yield* Effect.serviceOption(NetworkTiming);
  const cache = yield* Effect.serviceOption(Persistence.EnvironmentCacheStore);
  // Last working route id per environment (null when checked and empty/cleared).
  const lastGoodRoutes = new Map<string, string | null>();
  // Route authorizations started ahead of a likely reconnect, scoped to their environment.
  const preparedAhead = new Map<
    string,
    {
      readonly route: ConnectionRoute;
      readonly startedAt: number;
      readonly prepared: Fiber.Fiber<PreparedConnection, ConnectionAttemptError>;
    }
  >();
  const prepareAheadKey = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    JSON.stringify([entry.target.environmentId, connectionRouteId(route.target)]);

  const prepareAhead = Effect.fn("ConnectionDriver.prepareAhead")(function* (
    entry: ConnectionCatalogEntry,
    route: ConnectionRoute,
  ) {
    const routeId = prepareAheadKey(entry, route);
    const previous = preparedAhead.get(routeId);
    const startedAt = yield* Clock.currentTimeMillis;
    // Bounded by its own request timeouts; nothing waits on it unless a connect takes it.
    const prepared = yield* resolver.prepare(routeEntry(entry, route)).pipe(Effect.forkDetach);
    preparedAhead.set(routeId, { route, startedAt, prepared });
    if (previous !== undefined) yield* Fiber.interrupt(previous.prepared);
  });

  // The route's authorization started ahead, once, while it is fresh; otherwise a new one.
  const prepareRoute = Effect.fnUntraced(function* (
    entry: ConnectionCatalogEntry,
    route: ConnectionRoute,
  ) {
    const routeId = prepareAheadKey(entry, route);
    const ahead = preparedAhead.get(routeId);
    preparedAhead.delete(routeId);
    if (ahead !== undefined) {
      if (
        Equal.equals(ahead.route, route) &&
        (yield* Clock.currentTimeMillis) - ahead.startedAt <= PREPARED_AHEAD_TTL_MS
      ) {
        const exit = yield* Fiber.await(ahead.prepared);
        if (Exit.isSuccess(exit)) return exit.value;
      } else {
        yield* Fiber.interrupt(ahead.prepared);
      }
    }
    return yield* resolver.prepare(routeEntry(entry, route));
  });

  const loadLastGoodRouteId = (
    environmentId: ConnectionCatalogEntry["target"]["environmentId"],
  ) => {
    if (lastGoodRoutes.has(environmentId)) {
      return Effect.succeed(lastGoodRoutes.get(environmentId) ?? undefined);
    }
    if (Option.isNone(cache) || cache.value.loadLastRoute === undefined) {
      return Effect.succeed(undefined);
    }
    return cache.value.loadLastRoute(environmentId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.orElseSucceed(() => undefined),
      Effect.tap((routeId) =>
        Effect.sync(() => {
          if (!lastGoodRoutes.has(environmentId)) {
            lastGoodRoutes.set(environmentId, routeId ?? null);
          }
        }),
      ),
    );
  };

  const checkRoute = (
    entry: ConnectionCatalogEntry,
    route: ConnectionRoute,
    reportFailure: (error: ConnectionAttemptError) => Effect.Effect<void> = () => Effect.void,
  ) => {
    const httpBaseUrl = routeHttpBaseUrl(route);
    if (httpBaseUrl === null) return Effect.succeed<RouteCheck>("unchecked");
    const routeId = prepareAheadKey(entry, route);
    return Effect.gen(function* () {
      // A fresh, already-succeeded prepareAhead already verified this route's
      // descriptor and minted its ticket, so skip a duplicate descriptor RTT.
      const ahead = preparedAhead.get(routeId);
      if (
        ahead !== undefined &&
        Equal.equals(ahead.route, route) &&
        (yield* Clock.currentTimeMillis) - ahead.startedAt <= PREPARED_AHEAD_TTL_MS
      ) {
        const ready = ahead.prepared.pollUnsafe();
        if (
          ready !== undefined &&
          Exit.isSuccess(ready) &&
          ready.value.environmentId === entry.target.environmentId &&
          ready.value.httpBaseUrl === httpBaseUrl
        ) {
          return "answered" as RouteCheck;
        }
      }
      // The descriptor is public, so this sends no credential to whatever
      // answers at a saved LAN address on a different network.
      return yield* fetchRemoteEnvironmentDescriptor({
        httpBaseUrl,
        timeoutMs: ROUTE_CHECK_TIMEOUT_MS,
      }).pipe(
        Effect.timeoutOrElse({
          duration: ROUTE_CHECK_TIMEOUT_MS,
          orElse: () =>
            Effect.fail(new RemoteEnvironmentAuthTimeoutError(httpBaseUrl, ROUTE_CHECK_TIMEOUT_MS)),
        }),
        Effect.tap((descriptor) =>
          descriptor.environmentId === entry.target.environmentId &&
          Option.isSome(recentDescriptors)
            ? recentDescriptors.value.remember(httpBaseUrl, descriptor)
            : Effect.void,
        ),
        Effect.flatMap((descriptor) =>
          descriptor.environmentId === entry.target.environmentId
            ? Effect.succeed<RouteCheck>("answered")
            : reportFailure(
                environmentMismatchError({
                  expected: entry.target.environmentId,
                  actual: descriptor.environmentId,
                }),
              ).pipe(Effect.as<RouteCheck>("silent")),
        ),
        Effect.catch((error) =>
          reportFailure(mapRemoteEnvironmentError(error)).pipe(Effect.as<RouteCheck>("silent")),
        ),
      );
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.withSpan("ConnectionDriver.checkRoute", {
        attributes: { "connection.target.kind": route.target._tag },
      }),
    );
  };

  const connect = Effect.fn("ConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    const target = entry.target;
    const routes = connectionRoutes(entry);
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": target.environmentId,
      "connection.target.kind": target._tag,
      "connection.route.count": routes.length,
    });
    yield* reportProgress({ stage: "preparing" });
    const lastGoodRouteId =
      routes.length > 1 ? yield* loadLastGoodRouteId(target.environmentId) : undefined;
    const lease = yield* connectOverRoutes(
      entry,
      (route) =>
        checkRoute(entry, route, (error) =>
          reportProgress({ stage: "route-failed", target: route.target, error }),
        ),
      Effect.fnUntraced(function* (route) {
        const httpBaseUrl = routeHttpBaseUrl(route);
        const setupMs = Duration.toMillis(Duration.fromInputUnsafe(timings.establishmentTimeout));
        const setupBudget =
          httpBaseUrl !== null && Option.isSome(networkTiming)
            ? networkTiming.value.budget(httpBaseUrl, setupMs)
            : setupMs;
        yield* reportProgress({ stage: "preparing", target: route.target });
        const { prepared, session } = yield* Effect.gen(function* () {
          const prepared = yield* prepareRoute(entry, route);
          yield* reportProgress({ stage: "opening", prepared });
          const session = yield* sessions.connect(prepared);
          return { prepared, session };
        }).pipe((request) =>
          withReceiveIdleTimeout(httpBaseUrl ?? undefined, setupBudget, request, () =>
            Effect.fail(
              new ConnectionTransientError({
                reason: "timeout",
                detail: `${route.target.label} did not finish connection setup on this route.`,
              }),
            ),
          ),
        );
        yield* reportProgress({ stage: "synchronizing", prepared, session });
        const startedAt = yield* Clock.monotonicTimeNanos;
        const idleBudget = Duration.toNanosUnsafe(
          Duration.fromInputUnsafe(ROUTE_SYNCHRONIZATION_TIMEOUT),
        );
        yield* Effect.raceFirst(
          session.ready,
          Effect.gen(function* () {
            for (;;) {
              const receivedAt =
                session.rpcReceivedAt === undefined ? startedAt : yield* session.rpcReceivedAt;
              const idleDeadline = (receivedAt > startedAt ? receivedAt : startedAt) + idleBudget;
              const totalDeadline = startedAt + BigInt(INITIAL_SYNCHRONIZATION_MAX_MS) * 1_000_000n;
              const remaining =
                (idleDeadline < totalDeadline ? idleDeadline : totalDeadline) -
                (yield* Clock.monotonicTimeNanos);
              if (remaining <= 0n)
                return yield* new ConnectionTransientError({
                  reason: "timeout",
                  detail: `${route.target.label} did not deliver its initial configuration on this route.`,
                });
              yield* Effect.sleep(Duration.nanos(remaining));
            }
          }),
        );
        if (prepared.httpAuthorization?._tag === "Dpop") {
          yield* remote
            .renewDpopBeforeExpiry({
              expectedEnvironmentId: prepared.environmentId,
              expiresAtEpochMs: prepared.httpAuthorization.expiresAtEpochMs,
            })
            .pipe(
              Effect.catch((error) =>
                Effect.logWarning("Could not renew the connection's credential.", { error }),
              ),
              Effect.forkScoped({ startImmediately: true }),
            );
        }
        return { prepared, session } satisfies EnvironmentConnectionLease;
      }),
      (route, error) => {
        const failedRouteId = connectionRouteId(route.target);
        if (lastGoodRoutes.get(target.environmentId) === failedRouteId) {
          lastGoodRoutes.set(target.environmentId, null);
        }
        return reportProgress({ stage: "route-failed", target: route.target, error });
      },
      timings.routeFallbackDelayMs,
      lastGoodRouteId,
    );
    const winningRouteId = connectionRouteId(lease.prepared.target);
    const previousRouteId = lastGoodRoutes.get(target.environmentId);
    lastGoodRoutes.set(target.environmentId, winningRouteId);
    if (
      previousRouteId !== winningRouteId &&
      Option.isSome(cache) &&
      cache.value.saveLastRoute !== undefined
    ) {
      yield* cache.value
        .saveLastRoute(target.environmentId, winningRouteId)
        .pipe(Effect.ignore, Effect.forkScoped);
    }
    return lease;
  });

  const preflight = (entry: ConnectionCatalogEntry, route: ConnectionRoute) =>
    checkRoute(entry, route).pipe(
      Effect.flatMap((check) =>
        check === "answered"
          ? resolver.prepare(routeEntry(entry, route)).pipe(
              Effect.as(true),
              Effect.orElseSucceed(() => false),
            )
          : Effect.succeed(false),
      ),
      Effect.withSpan("ConnectionDriver.preflight"),
    );

  return ConnectionDriver.of({ connect, checkRoute, preflight, prepareAhead });
});

export const layer = Layer.effect(ConnectionDriver, make);
