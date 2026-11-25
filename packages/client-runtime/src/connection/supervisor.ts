import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";

import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import {
  type ConnectionAttemptError,
  type ConnectionTarget,
  ConnectionTransientError,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import {
  ConnectionTimings,
  INITIAL_SYNCHRONIZATION_MAX_MS,
  DEFAULT_CONNECTION_TIMINGS,
  ROUTE_SYNCHRONIZATION_TIMEOUT,
} from "./timings.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import {
  connectionRouteId,
  connectionRoutes,
  entryWithRoutes,
  routeHttpBaseUrl,
  type ReportedEndpoint,
} from "./routes.ts";
import { markLoad } from "../loadMarks.ts";
import { NetworkTiming, RequestProgress } from "./networkTiming.ts";

const RETRY_BASE_DELAY_MS = 1_000;
// Each route has the timings' establishment budget to resolve credentials and
// create the session, which ends when the driver reports the synchronizing
// stage. Each route that gets that far adds its own budget for the socket to
// open (bounded by the RPC session) and the server to deliver the first config
// snapshot. A cold server with a large database can take longer than 15
// seconds to answer, and that is not a reason to drop a working connection.
const synchronizationTimeout = Duration.fromInputUnsafe(ROUTE_SYNCHRONIZATION_TIMEOUT);
const CONNECTION_PROBE_TIMEOUT = "15 seconds";
const BACKOFF_RESET_AFTER_MS = 30_000;
// After a stable direct session is lost, a retry waits at most this share of
// the outage so far, and at least the floor. A server that restarted is picked
// up within about a quarter of its downtime, and a long outage still backs off.
const OUTAGE_RETRY_SHARE = 0.25;
const OUTAGE_RETRY_MIN_CEILING_MS = 1_000;
// A resume probe waits this many round trips of the live session, plus a
// margin, before replacing it: on a LAN a dead socket costs about a second,
// while a slow link keeps the timings' full quick-probe budget.
const RESUME_PROBE_ROUND_TRIPS = 6;
const RESUME_PROBE_MARGIN_MS = 750;
const RESUME_PROBE_MIN_MS = 1_000;
// The shortest wait on a socket after the device changes networks; the
// desktop's whole quick-probe budget.
const NETWORK_CHANGE_PROBE_MIN_MS = 3_000;
// While connected over a fallback route, how often to look for a better one.
// Network changes and returning to the app also trigger a check.
const BETTER_ROUTE_CHECK_INTERVAL = "60 seconds";
// A route that times out, or fails after a successful promotion check, loses
// priority for this long so a flaky LAN cannot bounce the connection.
const BETTER_ROUTE_COOLDOWN_MS = 300_000;

interface SupervisorIntent {
  readonly desired: boolean;
  readonly network: NetworkStatus;
}

type SupervisorSignal =
  | { readonly _tag: "ConnectRequested" }
  | { readonly _tag: "DisconnectRequested" }
  | { readonly _tag: "RetryRequested" }
  | {
      readonly _tag: "NetworkChanged";
      readonly network: NetworkStatus;
      readonly initialDiscovery?: boolean;
    }
  | { readonly _tag: "Wakeup"; readonly reason: ConnectionWakeups.ConnectionWakeup }
  | { readonly _tag: "BetterRouteAvailable"; readonly routeId: string };

interface PendingRetryTrace {
  readonly previousAttempt: Tracer.Span;
  readonly failureCount: number;
  readonly delayMs: number;
  readonly reason: ConnectionAttemptError["reason"];
}

interface TracedAttemptFailure {
  readonly error: ConnectionAttemptError;
  readonly attemptSpan: Option.Option<Tracer.Span>;
}

type AttemptOutcome =
  | {
      readonly _tag: "Interrupted";
      readonly established: boolean;
      readonly stable: boolean;
      readonly resetRetry: boolean;
    }
  | {
      readonly _tag: "Failure";
      readonly established: boolean;
      readonly stable: boolean;
      readonly failure: TracedAttemptFailure;
    };

type EstablishmentEvent =
  | {
      readonly _tag: "Completed";
      readonly exit: Exit.Exit<
        {
          readonly attemptSpan: Option.Option<Tracer.Span>;
          readonly lease: ConnectionDriver.EnvironmentConnectionLease;
        },
        TracedAttemptFailure
      >;
    }
  | { readonly _tag: "Interrupted"; readonly resetRetry: boolean }
  | { readonly _tag: "TimedOut" };

export interface EnvironmentSupervisorOptions {
  readonly initiallyDesired?: boolean;
  /**
   * Saves direct addresses from the live session's config snapshots and
   * returns the entry with its updated routes, which later attempts use. The
   * live session is left alone: it already works.
   */
  readonly learnRoutes?: (input: {
    readonly activeRoute: ConnectionRoute;
    readonly reported: ReadonlyArray<ReportedEndpoint>;
  }) => Effect.Effect<Option.Option<ConnectionCatalogEntry>>;
}

/**
 * Delay before the next attempt after `failureCount` consecutive failures
 * (0 for the first retry). The ceiling doubles from 2s up to `maxDelayMs` (5
 * minutes by default, 30 seconds on a phone), and the delay is a random point
 * in its upper half: never quicker than half the ceiling, and spread out so
 * clients that lost the same server do not all reconnect in the same second.
 * `random` is in [0, 1).
 *
 * The long cap only applies to a connection that keeps failing. Returning to
 * the app, the network coming back, and an explicit retry all skip the wait.
 */
/**
 * How long a probe on returning to the app waits, given the session's smoothed
 * probe round trip (undefined before one was measured). The quick-probe budget
 * is the fallback until latency is known; a measured slow link can wait longer.
 */
export function resumeProbeBudgetMs(roundTripMs: number | undefined, quickProbeMs: number): number {
  if (roundTripMs === undefined) return quickProbeMs;
  const budget = RESUME_PROBE_ROUND_TRIPS * roundTripMs + RESUME_PROBE_MARGIN_MS;
  return Math.round(Math.min(120_000, Math.max(RESUME_PROBE_MIN_MS, budget)));
}

/**
 * The retry ceiling after a stable session over a direct route was lost
 * `outageMs` ago. T3 Connect sessions keep the plain ladder: when the relay
 * restarts, every client loses it at once and should not all return together.
 */
export function outageRetryMaxDelayMs(outageMs: number, maxDelayMs: number): number {
  return Math.min(maxDelayMs, Math.max(OUTAGE_RETRY_MIN_CEILING_MS, outageMs * OUTAGE_RETRY_SHARE));
}

/**
 * How long a probe after a network change waits, given the round trip the
 * socket answered in before the change. A relay or LAN socket bound to the old
 * network is usually dead, while a tailnet socket survives once the tunnel
 * re-handshakes on the new path. The new path may be slower, so this allows
 * twice the old round trip, within the floor and the quick-probe budget.
 */
export function networkChangeProbeBudgetMs(
  roundTripMs: number | undefined,
  quickProbeMs: number,
): number {
  if (roundTripMs === undefined) return quickProbeMs;
  return Math.min(
    quickProbeMs,
    Math.max(NETWORK_CHANGE_PROBE_MIN_MS, resumeProbeBudgetMs(2 * roundTripMs, quickProbeMs)),
  );
}

export function retryDelayMs(
  failureCount: number,
  random: number,
  maxDelayMs = DEFAULT_CONNECTION_TIMINGS.retryMaxDelayMs,
): number {
  const ceiling = Math.min(maxDelayMs, RETRY_BASE_DELAY_MS * 2 ** (failureCount + 1));
  return Math.round(ceiling / 2 + (ceiling / 2) * random);
}

function annotateTarget(target: ConnectionTarget) {
  return Effect.annotateCurrentSpan({
    "environment.id": target.environmentId,
    "environment.label": target.label,
    "environment.target.kind": target._tag,
  });
}

function availableState(intent: SupervisorIntent, generation: number): SupervisorConnectionState {
  return {
    desired: false,
    network: intent.network,
    phase: "available",
    stage: null,
    attempt: 0,
    generation,
    lastFailure: null,
    routeFailures: new Map(),
    activeRouteId: null,
    retryAt: null,
  };
}

function offlineState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "offline",
    stage: null,
    attempt,
    generation,
    lastFailure,
    routeFailures: new Map(),
    activeRouteId: null,
    retryAt: null,
  };
}

function connectingState(
  intent: SupervisorIntent,
  generation: number,
  attempt: number,
  lastFailure: ConnectionAttemptError | null,
  stage: SupervisorConnectionState["stage"] = "preparing",
): SupervisorConnectionState {
  return {
    desired: true,
    network: intent.network,
    phase: "connecting",
    stage,
    attempt,
    generation,
    lastFailure,
    routeFailures: new Map(),
    activeRouteId: null,
    retryAt: null,
  };
}

// Any cause that ends an attempt is a failure to retry, including an
// interruption from inside it: only closing the supervisor's scope stops the loop.
function failureFromCause(
  target: ConnectionTarget,
  cause: Cause.Cause<TracedAttemptFailure>,
  established: boolean,
  stable: boolean,
) {
  return {
    _tag: "Failure",
    established,
    stable,
    failure: cause.reasons.find(Cause.isFailReason)?.error ?? unexpectedFailure(target),
  } satisfies AttemptOutcome;
}

function unexpectedFailure(target: ConnectionTarget): TracedAttemptFailure {
  return {
    error: new ConnectionTransientError({
      reason: "transport",
      detail: `${target.label} connection failed unexpectedly.`,
    }),
    attemptSpan: Option.none(),
  };
}

export class EnvironmentSupervisor extends Context.Service<
  EnvironmentSupervisor,
  {
    readonly target: ConnectionTarget;
    readonly state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>;
    readonly session: SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>;
    readonly prepared: SubscriptionRef.SubscriptionRef<Option.Option<PreparedConnection>>;
    readonly connect: Effect.Effect<void>;
    readonly disconnect: Effect.Effect<void>;
    readonly retryNow: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/connection/supervisor/EnvironmentSupervisor") {}

export const make = Effect.fn("EnvironmentSupervisor.make")(function* (
  entry: ConnectionCatalogEntry,
  options?: EnvironmentSupervisorOptions,
): Effect.fn.Return<
  EnvironmentSupervisor["Service"],
  never,
  | Connectivity.Connectivity
  | ConnectionDriver.ConnectionDriver
  | Scope.Scope
  | ConnectionWakeups.ConnectionWakeups
> {
  const target = entry.target;
  // Relay-specific handling applies when any route is T3 Connect, since the
  // attempt or the live session may be using it.
  const usesRelay = connectionRoutes(entry).some(
    (route) => route.target._tag === "RelayConnectionTarget",
  );
  const setupTimeoutDetail = `${target.label} did not respond during connection setup.${
    usesRelay ? ` ${NETWORK_BLOCKING_HINT}` : ""
  }`;
  yield* annotateTarget(target);

  const connectivity = yield* Connectivity.Connectivity;
  const driver = yield* ConnectionDriver.ConnectionDriver;
  const wakeups = yield* ConnectionWakeups.ConnectionWakeups;
  const timings = yield* ConnectionTimings;
  const networkTiming = yield* Effect.serviceOption(NetworkTiming);
  const clock = yield* Clock.Clock;
  const establishmentTimeout = Duration.fromInputUnsafe(timings.establishmentTimeout);
  const quickProbeMs = Duration.toMillis(Duration.fromInputUnsafe(timings.quickProbeTimeout));
  // Smoothed round trip of answered probes for the current session. Until a
  // probe answers, the session's heartbeat round trip stands in, then the
  // socket handshake. A handshake spans several round trips (TCP, TLS, the
  // upgrade), so it overstates the link, and config loading would inflate it
  // further with server work and decoding.
  let probeRoundTripMs: number | undefined;
  let handshakeRoundTripMs: number | undefined;
  // Heartbeats measured before the device last changed networks describe the old path.
  let pathChangedAt = -1n;
  let probeBudgetWidened = false;
  let synchronizingSince: bigint | undefined;
  const synchronizingSessions = new Map<string, RpcSession.RpcSession>();
  const recordProbeRoundTrip = (sampleMs: number) => {
    probeRoundTripMs =
      probeRoundTripMs === undefined ? sampleMs : 0.7 * probeRoundTripMs + 0.3 * sampleMs;
  };
  // A round trip measured on this socket (an answered probe or a heartbeat),
  // or undefined when only the handshake or nothing is known.
  const measuredRoundTripMs = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    Effect.gen(function* () {
      if (probeRoundTripMs !== undefined) return probeRoundTripMs;
      const ping =
        lease.session.pingRoundTrip === undefined ? undefined : yield* lease.session.pingRoundTrip;
      return ping !== undefined && ping.measuredAt > pathChangedAt ? ping.milliseconds : undefined;
    });
  // The primary served this client or runs alongside it on loopback. Offline
  // reports are often wrong, so they probe its session without parking it.
  const targetNetwork = (network: NetworkStatus): NetworkStatus =>
    network === "offline" && target._tag === "PrimaryConnectionTarget" ? "unknown" : network;
  const initialIntent: SupervisorIntent = {
    desired: options?.initiallyDesired ?? false,
    network: targetNetwork(yield* connectivity.status),
  };
  let hasKnownNetwork = initialIntent.network !== "unknown";
  const intent = yield* Ref.make(initialIntent);
  const signals = yield* Queue.unbounded<SupervisorSignal>();
  const resetRetryState = yield* Ref.make(false);
  // Set while a probe of the live session is running, and kept when it fails
  // or times out: something asked whether the connection still works and it
  // closed or failed before answering, so the follow-up reconnect skips the
  // first backoff rung instead of sleeping.
  const probeUnanswered = yield* Ref.make(false);
  // Set with it when that probe was for a long resume: the replacement then
  // connects even while the network reports offline, as the report is often
  // wrong and the replaced session must not leave the client offline.
  const longResumeProbeUnanswered = yield* Ref.make(false);
  const state = yield* SubscriptionRef.make<SupervisorConnectionState>(
    !initialIntent.desired
      ? availableState(initialIntent, 0)
      : initialIntent.network === "offline"
        ? offlineState(initialIntent, 0, 0, null)
        : connectingState(initialIntent, 0, 1, null),
  );
  const session = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(Option.none());
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none());
  // Learned routes arrive while a session is live, so the route list is read
  // fresh by each attempt and check instead of being fixed at creation.
  const currentEntry = yield* Ref.make(entry);
  const currentRoutes = Ref.get(currentEntry).pipe(Effect.map(connectionRoutes));
  // Set when a better route answered while connected over a worse one; the
  // replacement attempt tries it first. Cleared once an attempt starts.
  const preferredRouteId = yield* Ref.make(Option.none<string>());
  // Monotonic cooldown per route that timed out or failed a promotion.
  const routeCooldowns = yield* Ref.make<ReadonlyMap<string, bigint>>(new Map());

  const attemptEntry = Effect.gen(function* () {
    const latest = yield* Ref.get(currentEntry);
    const routes = connectionRoutes(latest);
    const preferred = yield* Ref.getAndSet(preferredRouteId, Option.none());
    const now = yield* Clock.monotonicTimeNanos;
    const cooldowns = yield* Ref.get(routeCooldowns);
    const cooling = (route: ConnectionRoute) =>
      (cooldowns.get(connectionRouteId(route.target)) ?? 0n) > now;
    const ordered = [...routes.filter((route) => !cooling(route)), ...routes.filter(cooling)];
    if (Option.isNone(preferred)) return entryWithRoutes(latest, ordered);
    const route = ordered.find(
      (candidate) => connectionRouteId(candidate.target) === preferred.value,
    );
    return route === undefined
      ? latest
      : entryWithRoutes(latest, [route, ...ordered.filter((candidate) => candidate !== route)]);
  });

  const learnRoutesFrom = Effect.fnUntraced(function* (
    learn: NonNullable<EnvironmentSupervisorOptions["learnRoutes"]>,
    lease: ConnectionDriver.EnvironmentConnectionLease,
    reported: ReadonlyArray<ReportedEndpoint> | undefined,
  ) {
    if (reported === undefined) return;
    const activeId = connectionRouteId(lease.prepared.target);
    const activeRoute = (yield* currentRoutes).find(
      (route) => connectionRouteId(route.target) === activeId,
    );
    if (activeRoute === undefined) return;
    const updated = yield* learn({ activeRoute, reported });
    if (Option.isSome(updated)) {
      yield* Ref.set(currentEntry, updated.value);
      // A learned route may rank above the one in use.
      yield* requestBetterRouteCheck(lease);
    }
  });

  const routeIndex = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    currentRoutes.pipe(
      Effect.map((routes) =>
        routes.findIndex(
          (route) => connectionRouteId(route.target) === connectionRouteId(lease.prepared.target),
        ),
      ),
    );

  /**
   * Preflights the routes ranked above the one in use and signals the best
   * that would connect. Routes without a cheap check (T3 Connect, SSH) never
   * pass, so they are fallbacks, not destinations.
   */
  const checkBetterRoutes = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    const latest = yield* Ref.get(currentEntry);
    const current = yield* routeIndex(lease);
    if (current <= 0) return;
    const now = yield* Clock.monotonicTimeNanos;
    const cooldowns = yield* Ref.get(routeCooldowns);
    const better = connectionRoutes(latest)
      .slice(0, current)
      .filter((route) => (cooldowns.get(connectionRouteId(route.target)) ?? 0n) <= now);
    const passed = yield* Effect.forEach(
      better,
      (route: ConnectionRoute) => driver.preflight(latest, route),
      { concurrency: "unbounded" },
    );
    const index = passed.indexOf(true);
    if (index === -1) return;
    // The check may outlive the session it was asked about.
    const live = yield* SubscriptionRef.get(session);
    if (Option.isNone(live) || live.value !== lease.session) return;
    yield* signal({
      _tag: "BetterRouteAvailable",
      routeId: connectionRouteId(better[index]!.target),
    });
  });

  // One check at a time; a trigger during a check is dropped, not queued.
  const betterRouteChecks = yield* Queue.dropping<ConnectionDriver.EnvironmentConnectionLease>(1);
  const requestBetterRouteCheck = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    routeIndex(lease).pipe(
      Effect.flatMap((index) =>
        index > 0 ? Queue.offer(betterRouteChecks, lease).pipe(Effect.asVoid) : Effect.void,
      ),
    );

  const clearLease = Effect.all(
    [SubscriptionRef.set(session, Option.none()), SubscriptionRef.set(prepared, Option.none())],
    { discard: true },
  );

  let routeFailures: ReadonlyMap<string, ConnectionAttemptError> = new Map();
  let activeRouteId: string | null = null;
  let attemptStartedT3ConnectRoute = false;

  const routeUsesT3Connect = (route: ConnectionRoute) =>
    route.target._tag === "RelayConnectionTarget" ||
    (Option.isSome(route.profile) &&
      route.profile.value._tag === "BearerConnectionProfile" &&
      route.profile.value.authorization === "t3-connect");

  const markRouteIfT3Connect = Effect.fnUntraced(function* (routeTarget: ConnectionTarget) {
    if (routeTarget._tag === "RelayConnectionTarget") {
      attemptStartedT3ConnectRoute = true;
      return;
    }
    const routeId = connectionRouteId(routeTarget);
    const matched = (yield* currentRoutes).find(
      (candidate) => connectionRouteId(candidate.target) === routeId,
    );
    if (matched !== undefined && routeUsesT3Connect(matched)) {
      attemptStartedT3ConnectRoute = true;
    }
  });

  const recordRouteFailure = (routeId: string, error: ConnectionAttemptError) =>
    SubscriptionRef.update(state, (current) => {
      routeFailures = new Map(routeFailures).set(routeId, error);
      return { ...current, routeFailures };
    });

  const setState = Effect.fn("EnvironmentSupervisor.setState")(function* (
    next: Omit<SupervisorConnectionState, "routeFailures" | "activeRouteId">,
  ) {
    if (next.phase === "available" || next.phase === "connected") routeFailures = new Map();
    if (next.phase !== "connecting" && next.phase !== "connected") activeRouteId = null;
    yield* SubscriptionRef.set(state, { ...next, routeFailures, activeRouteId });
  });

  let networkPathVersion = 0;
  const signal = Effect.fn("EnvironmentSupervisor.signal")(function* (next: SupervisorSignal) {
    if (next._tag === "Wakeup" && next.reason === "network-changed") networkPathVersion++;
    if (
      Option.isSome(networkTiming) &&
      ((next._tag === "NetworkChanged" && next.initialDiscovery !== true) ||
        (next._tag === "Wakeup" && next.reason === "network-changed"))
    ) {
      for (const route of connectionRoutes(yield* Ref.get(currentEntry))) {
        const url = routeHttpBaseUrl(route);
        if (url !== null) networkTiming.value.reset(url);
      }
      const active = yield* SubscriptionRef.get(prepared);
      if (Option.isSome(active)) networkTiming.value.reset(active.value.httpBaseUrl);
    }
    yield* Queue.offer(signals, next);
  });

  const logManagedRelayAccountChange = Effect.logInfo(
    "Managed relay account changed; restarting the environment connection.",
  ).pipe(
    Effect.annotateLogs({
      "environment.id": target.environmentId,
      "environment.label": target.label,
    }),
  );

  const logUnexpectedFailure = (
    failed: "attempt" | "release" | "loop",
    cause: Cause.Cause<TracedAttemptFailure>,
  ) => {
    const died = cause.reasons.find(Cause.isDieReason);
    if (!died && cause.reasons.some(Cause.isFailReason)) return Effect.void;
    return Effect.logError(
      `Connection ${failed} failed with an unexpected ${died ? "defect" : "interruption"}.`,
    ).pipe(
      Effect.annotateLogs({
        "environment.id": target.environmentId,
        "environment.label": target.label,
        "cause.reason_count": cause.reasons.length,
        ...(died ? safeErrorLogAttributes(died.defect) : {}),
      }),
    );
  };

  const reportProgress = Effect.fn("EnvironmentSupervisor.reportProgress")(function* (
    attempt: number,
    nextGeneration: number,
    lastFailure: ConnectionAttemptError | null,
    progress: ConnectionDriver.ConnectionDriverProgress,
  ) {
    if (progress.stage === "route-failed") {
      const routeId = connectionRouteId(progress.target);
      synchronizingSessions.delete(routeId);
      yield* recordRouteFailure(routeId, progress.error);
      if (progress.error.reason === "timeout") {
        const until =
          (yield* Clock.monotonicTimeNanos) + BigInt(BETTER_ROUTE_COOLDOWN_MS) * 1_000_000n;
        yield* Ref.update(routeCooldowns, (current) => new Map(current).set(routeId, until));
      }
      return;
    }
    if (progress.stage === "preparing") {
      if (progress.target === undefined) {
        synchronizingSessions.clear();
        synchronizingSince = undefined;
      } else {
        activeRouteId = connectionRouteId(progress.target);
        synchronizingSessions.delete(activeRouteId);
        yield* markRouteIfT3Connect(progress.target);
      }
    }
    if ("prepared" in progress) {
      activeRouteId = connectionRouteId(progress.prepared.target);
      yield* markRouteIfT3Connect(progress.prepared.target);
      yield* SubscriptionRef.set(prepared, Option.some(progress.prepared));
    }
    markLoad(`connect.${progress.stage}`, {
      attempt,
      environment: target.environmentId.slice(0, 8),
    });
    if (progress.stage === "synchronizing") {
      synchronizingSince = yield* Clock.monotonicTimeNanos;
      if (progress.session !== undefined) {
        synchronizingSessions.set(connectionRouteId(progress.prepared.target), progress.session);
      }
    }
    yield* setState(
      connectingState(yield* Ref.get(intent), nextGeneration, attempt, lastFailure, progress.stage),
    );
  });

  const establishConnection = Effect.fnUntraced(function* (
    attempt: number,
    nextGeneration: number,
    lastFailure: ConnectionAttemptError | null,
    synchronizedRoutes: Ref.Ref<number>,
  ) {
    attemptStartedT3ConnectRoute = false;
    return yield* driver.connect(yield* attemptEntry, (progress) =>
      (progress.stage === "synchronizing"
        ? Ref.update(synchronizedRoutes, (count) => count + 1)
        : Effect.void
      ).pipe(Effect.andThen(reportProgress(attempt, nextGeneration, lastFailure, progress))),
    );
  });

  const traceRelayEstablishment = (
    effect: Effect.Effect<
      ConnectionDriver.EnvironmentConnectionLease,
      ConnectionAttemptError,
      Scope.Scope
    >,
    attempt: number,
    nextGeneration: number,
    pendingRetry: Option.Option<PendingRetryTrace>,
  ) => {
    const traced = Effect.gen(function* () {
      const attemptSpan = yield* Effect.currentSpan.pipe(Effect.orDie);
      yield* annotateTarget(target);
      yield* Effect.annotateCurrentSpan({
        "connection.attempt": attempt,
        "connection.generation": nextGeneration,
        "connection.retry.failure_count": Option.match(pendingRetry, {
          onNone: () => 0,
          onSome: (retry) => retry.failureCount,
        }),
      });
      const lease = yield* effect.pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: Option.some(attemptSpan),
        })),
      );
      return { attemptSpan: Option.some(attemptSpan), lease };
    }).pipe(Effect.withSpan("relay.connection.attempt", { root: true }));

    return Option.match(pendingRetry, {
      onNone: () => traced,
      onSome: (retry) =>
        traced.pipe(
          Effect.linkSpans(retry.previousAttempt, {
            "connection.retry.delay_ms": retry.delayMs,
            "connection.retry.reason": retry.reason,
          }),
        ),
    }).pipe(withRelayClientTracing);
  };

  const establishTracedConnection = Effect.fnUntraced(function* (
    attempt: number,
    nextGeneration: number,
    lastFailure: ConnectionAttemptError | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
    synchronizedRoutes: Ref.Ref<number>,
  ) {
    if (usesRelay) {
      return yield* traceRelayEstablishment(
        establishConnection(attempt, nextGeneration, lastFailure, synchronizedRoutes),
        attempt,
        nextGeneration,
        pendingRetry,
      );
    }
    return yield* establishConnection(
      attempt,
      nextGeneration,
      lastFailure,
      synchronizedRoutes,
    ).pipe(
      Effect.map((lease) => ({
        attemptSpan: Option.none<Tracer.Span>(),
        lease,
      })),
      Effect.mapError((error): TracedAttemptFailure => ({
        error,
        attemptSpan: Option.none(),
      })),
    );
  });

  const waitForEstablishmentInterrupt = Effect.fnUntraced(function* (
    ignoreOffline: boolean,
    startingPathVersion: number,
  ) {
    // A primary attempt survives an offline report. Restart it on recovery
    // in case its route changed while the device was away.
    let deviceOffline = (yield* connectivity.status) === "offline";
    for (;;) {
      const next = yield* Queue.take(signals);
      switch (next._tag) {
        case "DisconnectRequested":
          return false;
        case "RetryRequested":
          // Once the loop has taken this retry's flag, the running attempt is
          // the one the retry asked for.
          if (yield* Ref.get(resetRetryState)) {
            return false;
          }
          break;
        case "NetworkChanged":
          if (target._tag !== "PrimaryConnectionTarget") {
            if (next.network === "offline" && !ignoreOffline) return false;
          } else if (next.network === "offline") {
            deviceOffline = true;
          } else if (deviceOffline) {
            return true;
          }
          break;
        case "ConnectRequested":
        case "BetterRouteAvailable":
          break;
        case "Wakeup":
          // A request on the old interface can remain pending until its HTTP
          // or socket timeout. A wake already queued before this attempt is
          // harmless: the attempt selected its routes on the new path.
          if (next.reason === "network-changed" && startingPathVersion !== networkPathVersion) {
            return false;
          }
          if (next.reason === "application-active-reconnect") {
            return true;
          }
          if (next.reason === "credentials-changed" && usesRelay) {
            const routes = yield* currentRoutes;
            if (attemptStartedT3ConnectRoute || routes.every(routeUsesT3Connect)) {
              yield* logManagedRelayAccountChange;
              return false;
            }
          }
          break;
      }
    }
  });

  // Signals that end a connected lease whatever its health: "reset" ends it
  // and restarts the retry ladder, "end" ends it, undefined keeps it.
  const isRelayLease = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    lease.prepared.target._tag === "RelayConnectionTarget";

  const connectedLeaseEnd = Effect.fnUntraced(function* (
    next: SupervisorSignal,
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    if (next._tag === "DisconnectRequested") {
      return "end" as const;
    }
    if (next._tag === "BetterRouteAvailable") {
      // Replaced like a long resume: the new attempt prefers the better route
      // and its session takes over the durable subscriptions.
      yield* Ref.set(preferredRouteId, Option.some(next.routeId));
      return "reset" as const;
    }
    if (next._tag !== "Wakeup") {
      return undefined;
    }
    // Only a session over T3 Connect holds the old account's credential.
    if (next.reason === "credentials-changed" && isRelayLease(lease)) {
      yield* logManagedRelayAccountChange;
      return "end" as const;
    }
    return undefined;
  });

  // How long a signal waits for the live session to answer a probe, or
  // undefined when the signal does not question the connection. `roundTripMs`
  // is the round trip measured on the live socket, if any.
  const probeTimeoutFor = (
    next: SupervisorSignal,
    roundTripMs: number | undefined,
  ): Duration.Input | undefined => {
    if (next._tag === "NetworkChanged" && next.initialDiscovery === true) {
      return undefined;
    }
    const roundTripBeforeChange = roundTripMs;
    if (
      next._tag === "NetworkChanged" ||
      (next._tag === "Wakeup" && next.reason === "network-changed")
    ) {
      probeRoundTripMs = undefined;
      handshakeRoundTripMs = undefined;
      roundTripMs = undefined;
      pathChangedAt = clock.monotonicTimeNanosUnsafe();
    }
    switch (next._tag) {
      case "RetryRequested":
        return timings.quickProbeTimeout;
      case "NetworkChanged":
        return next.network === "unknown"
          ? undefined
          : Duration.millis(networkChangeProbeBudgetMs(roundTripBeforeChange, quickProbeMs));
      case "Wakeup":
        switch (next.reason) {
          case "application-active":
            return CONNECTION_PROBE_TIMEOUT;
          // Back in the app. A suspended socket usually still works, and
          // keeping it is much quicker than reconnecting and re-downloading
          // the snapshots. A socket the OS killed without a close event misses
          // a probe sized to the round trip it used to answer in.
          case "application-focus":
          case "application-active-probe":
          case "application-active-reconnect":
            return Duration.millis(
              resumeProbeBudgetMs(roundTripMs ?? handshakeRoundTripMs, quickProbeMs),
            );
          // A socket opened on the previous network may now be unroutable.
          case "network-changed":
            return Duration.millis(networkChangeProbeBudgetMs(roundTripBeforeChange, quickProbeMs));
          case "credentials-changed":
            return undefined;
        }
      case "ConnectRequested":
      case "DisconnectRequested":
      case "BetterRouteAvailable":
        return undefined;
    }
  };

  const isForegroundProbe = (next: SupervisorSignal) =>
    next._tag === "Wakeup" && next.reason === "application-active";

  const isLongResume = (next: SupervisorSignal) =>
    next._tag === "Wakeup" && next.reason === "application-active-reconnect";

  const isResume = (next: SupervisorSignal) =>
    next._tag === "Wakeup" &&
    (next.reason === "application-focus" ||
      next.reason === "application-active-probe" ||
      next.reason === "application-active-reconnect");

  const timedProbe = (lease: ConnectionDriver.EnvironmentConnectionLease) =>
    Effect.gen(function* () {
      const startedAt = yield* Clock.monotonicTimeNanos;
      yield* lease.session.probe.pipe(
        Effect.onExit((exit) =>
          Clock.monotonicTimeNanos.pipe(
            Effect.flatMap((finishedAt) =>
              Effect.sync(() => {
                markLoad("connect.probe.finished", {
                  environment: target.environmentId.slice(0, 8),
                  ms: Math.round(Number(finishedAt - startedAt) / 1_000_000),
                  outcome: Exit.isSuccess(exit)
                    ? "answered"
                    : Cause.hasInterruptsOnly(exit.cause)
                      ? "interrupted"
                      : "failed",
                });
              }),
            ),
          ),
        ),
      );
      recordProbeRoundTrip(Number((yield* Clock.monotonicTimeNanos) - startedAt) / 1_000_000);
      probeBudgetWidened = false;
    });

  // Holds a connected lease until it must end, and returns whether to restart
  // the retry ladder. Returning to the app, an explicit retry, and the network
  // reporting offline all probe the live session instead of replacing it, so a
  // healthy socket is not torn down (the offline report is often wrong, for
  // example for a loopback server). A failed probe fails this effect, and the
  // supervisor reconnects.
  const monitorConnectedLease = Effect.fnUntraced(function* (
    lease: ConnectionDriver.EnvironmentConnectionLease,
  ) {
    // A probe answers an explicit retry here, so the retry must not also reset
    // the backoff of a later, unrelated failure.
    const takeSignal = Queue.take(signals).pipe(
      Effect.tap((next) =>
        next._tag === "RetryRequested" ? Ref.set(resetRetryState, false) : Effect.void,
      ),
    );
    // Ticks always run: the check skips the preferred route itself, and the
    // route list can grow while connected (learned routes).
    yield* Stream.tick(BETTER_ROUTE_CHECK_INTERVAL).pipe(
      Stream.drop(1),
      Stream.runForEach(() => requestBetterRouteCheck(lease)),
      Effect.forkScoped,
    );
    for (;;) {
      const next = yield* takeSignal;
      const end = yield* connectedLeaseEnd(next, lease);
      if (end !== undefined) {
        return end === "reset";
      }
      // A new network or a return to the app may have brought a better route back.
      if (
        (next._tag === "NetworkChanged" &&
          next.network !== "offline" &&
          next.initialDiscovery !== true) ||
        (next._tag === "Wakeup" && ConnectionWakeups.resetsRetryBackoff(next.reason))
      ) {
        yield* requestBetterRouteCheck(lease);
      }
      const roundTripMs = yield* measuredRoundTripMs(lease);
      const baseProbeTimeout = probeTimeoutFor(next, roundTripMs);
      if (baseProbeTimeout === undefined) {
        continue;
      }
      // A resume sized to a round trip measured on this socket stands on its
      // own. The shared estimate also averages whole HTTP requests and socket
      // handshakes, which would hold a dead socket for seconds longer.
      const sizedToSocket = isResume(next) && roundTripMs !== undefined;
      const probeTimeout =
        lease.session.responseTimeoutMs === undefined || sizedToSocket
          ? baseProbeTimeout
          : Duration.millis(
              yield* lease.session.responseTimeoutMs(
                Duration.toMillis(Duration.fromInputUnsafe(baseProbeTimeout)),
              ),
            );
      yield* Ref.set(probeUnanswered, true);
      yield* Ref.set(longResumeProbeUnanswered, isLongResume(next));
      // After a long time away the OS has often killed the socket. Authorize
      // its route meanwhile, so a replacement skips straight to opening. When
      // the network changes while on a direct route, authorize a relay fallback
      // ahead so leaving Wi-Fi does not pay relay discovery after the probe.
      if (driver.prepareAhead !== undefined) {
        if (isLongResume(next)) {
          const routeId = connectionRouteId(lease.prepared.target);
          const route = (yield* currentRoutes).find(
            (candidate) => connectionRouteId(candidate.target) === routeId,
          );
          if (route !== undefined) yield* driver.prepareAhead(yield* Ref.get(currentEntry), route);
        } else if (
          next._tag === "Wakeup" &&
          next.reason === "network-changed" &&
          lease.prepared.target._tag !== "RelayConnectionTarget"
        ) {
          const relayFallback = (yield* currentRoutes).find(
            (candidate) => candidate.target._tag === "RelayConnectionTarget",
          );
          if (relayFallback !== undefined) {
            yield* driver.prepareAhead(yield* Ref.get(currentEntry), relayFallback);
          }
        }
      }
      markLoad("connect.probe.started", {
        environment: target.environmentId.slice(0, 8),
        budgetMs: Duration.toMillis(Duration.fromInputUnsafe(probeTimeout)),
        reason: next._tag === "Wakeup" ? next.reason : next._tag,
      });
      let probe = yield* Effect.forkChild(timedProbe(lease));
      // A busy host can miss one foreground probe on a live socket. Ask once
      // more before replacing it; explicit retries and mobile resume probes
      // still need a definite answer within their original budget.
      let toleratesMiss = isForegroundProbe(next);
      const probeStartedAt = yield* Clock.monotonicTimeNanos;
      // Monotonic nanoseconds, so a wall-clock correction cannot move the deadline.
      let deadline = (yield* Clock.monotonicTimeNanos) + Duration.toNanosUnsafe(probeTimeout);
      for (;;) {
        const remaining = deadline - (yield* Clock.monotonicTimeNanos);
        const probeEvent = yield* Effect.raceAllFirst([
          Fiber.await(probe).pipe(
            Effect.map((exit) => ({ _tag: "ProbeCompleted" as const, exit })),
          ),
          takeSignal.pipe(Effect.map((signal) => ({ _tag: "Signal" as const, signal }))),
          Effect.sleep(Duration.nanos(remaining > 0n ? remaining : 0n)).pipe(
            Effect.as({ _tag: "TimedOut" as const }),
          ),
        ]);
        if (probeEvent._tag === "TimedOut") {
          if (toleratesMiss) {
            toleratesMiss = false;
            yield* Fiber.interrupt(probe);
            probe = yield* Effect.forkChild(timedProbe(lease));
            deadline = (yield* Clock.monotonicTimeNanos) + Duration.toNanosUnsafe(probeTimeout);
            continue;
          }
          yield* Fiber.interrupt(probe);
          if (
            lease.session.receivedAt !== undefined &&
            (yield* lease.session.receivedAt) > probeStartedAt
          ) {
            // A probe can queue behind a snapshot. Receiving bytes already
            // proves the transport is alive; the heartbeat owns silence detection.
            yield* Ref.set(probeUnanswered, false);
            yield* Ref.set(longResumeProbeUnanswered, false);
            break;
          }
          return yield* new ConnectionTransientError({
            reason: "timeout",
            detail: `${target.label} did not respond to a connection health check.`,
          });
        }
        if (probeEvent._tag === "ProbeCompleted") {
          if (Exit.isSuccess(probeEvent.exit)) {
            yield* Ref.set(probeUnanswered, false);
            yield* Ref.set(longResumeProbeUnanswered, false);
          }
          yield* probeEvent.exit;
          break;
        }
        if (isLongResume(probeEvent.signal)) yield* Ref.set(longResumeProbeUnanswered, true);
        const endDuringProbe = yield* connectedLeaseEnd(probeEvent.signal, lease);
        if (endDuringProbe !== undefined) {
          yield* Fiber.interrupt(probe);
          return endDuringProbe === "reset";
        }
        // A retry or an offline report during a desktop foreground probe wants
        // its quicker answer, so it shortens the running probe.
        const signalTimeout = probeTimeoutFor(probeEvent.signal, roundTripMs);
        if (signalTimeout !== undefined) {
          if (!isForegroundProbe(probeEvent.signal)) toleratesMiss = false;
          const signalDeadline =
            (yield* Clock.monotonicTimeNanos) + Duration.toNanosUnsafe(signalTimeout);
          if (signalDeadline < deadline) deadline = signalDeadline;
        }
      }
    }
  });

  // Advanced as a session goes live and kept across loop restarts, so no two sessions share one.
  let generation = 0;
  // Whether the session that went live last runs over T3 Connect.
  let liveOverRelay = false;
  const runAttempt = Effect.fnUntraced(function* (
    attempt: number,
    nextGeneration: number,
    lastFailure: ConnectionAttemptError | null,
    pendingRetry: Option.Option<PendingRetryTrace>,
    ignoreOffline: boolean,
  ) {
    const switchingTo = yield* Ref.get(preferredRouteId);
    yield* SubscriptionRef.set(prepared, Option.none());
    const synchronizedRoutes = yield* Ref.make(0);
    let receivedAt = clock.monotonicTimeNanosUnsafe();
    const progress = {
      received: () => {
        receivedAt = clock.monotonicTimeNanosUnsafe();
      },
      lastReceived: () => receivedAt,
    };
    const establishment = yield* Effect.raceAllFirst([
      Effect.exit(
        establishTracedConnection(
          attempt,
          nextGeneration,
          lastFailure,
          pendingRetry,
          synchronizedRoutes,
        ).pipe(Effect.provideService(RequestProgress, progress)),
      ).pipe(
        Effect.map((exit): EstablishmentEvent => ({
          _tag: "Completed",
          exit,
        })),
      ),
      waitForEstablishmentInterrupt(ignoreOffline, networkPathVersion).pipe(
        Effect.map((resetRetry): EstablishmentEvent => ({
          _tag: "Interrupted",
          resetRetry,
        })),
      ),
      // Each route may use the full setup time before the next is tried, and
      // each route that reaches synchronizing adds its own snapshot budget, so
      // a route that fails late does not eat the next route's time.
      Effect.gen(function* () {
        const routes = connectionRoutes(yield* Ref.get(currentEntry));
        const startedAt = yield* Clock.monotonicTimeNanos;
        while (true) {
          const setupMs = Duration.toMillis(establishmentTimeout);
          const setup =
            BigInt(
              routes.reduce((sum, route) => {
                const url = routeHttpBaseUrl(route);
                return (
                  sum +
                  (url !== null && Option.isSome(networkTiming)
                    ? networkTiming.value.budget(url, setupMs)
                    : setupMs)
                );
              }, 0),
            ) * 1_000_000n;
          const synchronized = BigInt(yield* Ref.get(synchronizedRoutes));
          let deadline =
            startedAt + setup + synchronized * Duration.toNanosUnsafe(synchronizationTimeout);
          if (receivedAt + setup > deadline) deadline = receivedAt + setup;
          for (const synchronizingSession of synchronizingSessions.values()) {
            if (synchronizingSession.rpcReceivedAt === undefined) continue;
            const progressDeadline =
              (yield* synchronizingSession.rpcReceivedAt) +
              Duration.toNanosUnsafe(synchronizationTimeout);
            if (progressDeadline > deadline) deadline = progressDeadline;
          }
          const totalDeadline = startedAt + BigInt(INITIAL_SYNCHRONIZATION_MAX_MS) * 1_000_000n;
          if (deadline > totalDeadline) deadline = totalDeadline;
          const remaining = deadline - (yield* Clock.monotonicTimeNanos);
          if (remaining <= 0n) {
            return { _tag: "TimedOut" } as const satisfies EstablishmentEvent;
          }
          yield* Effect.sleep(Duration.nanos(remaining));
        }
      }),
    ]);

    if (establishment._tag === "Interrupted") {
      return {
        _tag: "Interrupted",
        established: false,
        stable: false,
        resetRetry: establishment.resetRetry,
      } satisfies AttemptOutcome;
    }
    if (establishment._tag === "TimedOut") {
      const error = new ConnectionTransientError({ reason: "timeout", detail: setupTimeoutDetail });
      if (activeRouteId !== null) yield* recordRouteFailure(activeRouteId, error);
      return {
        _tag: "Failure",
        established: false,
        stable: false,
        failure: {
          error,
          attemptSpan: Option.none(),
        },
      } satisfies AttemptOutcome;
    }
    if (Exit.isFailure(establishment.exit)) {
      yield* logUnexpectedFailure("attempt", establishment.exit.cause);
      return failureFromCause(target, establishment.exit.cause, false, false);
    }

    const active = establishment.exit.value;
    if (Option.isSome(switchingTo)) {
      const landed = connectionRouteId(active.lease.prepared.target);
      if (landed !== switchingTo.value) {
        const until =
          (yield* Clock.monotonicTimeNanos) + BigInt(BETTER_ROUTE_COOLDOWN_MS) * 1_000_000n;
        yield* Ref.update(routeCooldowns, (current) =>
          new Map(current).set(switchingTo.value, until),
        );
      }
    }
    const currentIntent = yield* Ref.get(intent);
    if (!currentIntent.desired || (currentIntent.network === "offline" && !ignoreOffline)) {
      return {
        _tag: "Interrupted",
        established: false,
        stable: false,
        resetRetry: false,
      } satisfies AttemptOutcome;
    }

    const connectedAt = yield* Clock.currentTimeMillis;
    // Each transport gets its own estimate. After a missed probe use the full
    // budget until a round trip is measured, since a fast handshake can hide a
    // slow link.
    probeRoundTripMs = undefined;
    handshakeRoundTripMs = undefined;
    if (!probeBudgetWidened) {
      if (active.lease.session.openDurationMs !== undefined) {
        handshakeRoundTripMs = yield* active.lease.session.openDurationMs;
      } else if (synchronizingSince !== undefined) {
        handshakeRoundTripMs =
          Number((yield* Clock.monotonicTimeNanos) - synchronizingSince) / 1_000_000;
      }
    }
    activeRouteId = connectionRouteId(active.lease.prepared.target);
    generation = nextGeneration;
    liveOverRelay = isRelayLease(active.lease);
    yield* SubscriptionRef.set(prepared, Option.some(active.lease.prepared));
    markLoad("session.ready", { environment: target.environmentId.slice(0, 8) });
    yield* SubscriptionRef.set(session, Option.some(active.lease.session));
    if (options?.learnRoutes !== undefined) {
      const learn = options.learnRoutes;
      const snapshots =
        active.lease.session.configSnapshots ??
        Stream.fromEffect(
          active.lease.session.initialConfig.pipe(Effect.orElseSucceed(() => undefined)),
        );
      yield* snapshots.pipe(
        Stream.map((config) => config?.directEndpoints),
        Stream.changesWith((previous, next) => JSON.stringify(previous) === JSON.stringify(next)),
        Stream.runForEach((reported) => learnRoutesFrom(learn, active.lease, reported)),
        Effect.forkScoped,
      );
    }
    yield* setState({
      desired: true,
      network: currentIntent.network,
      phase: "connected",
      stage: null,
      attempt,
      generation: nextGeneration,
      lastFailure: null,
      retryAt: null,
    });

    const connectedExit = yield* Effect.raceFirst(
      active.lease.session.closed.pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: active.attemptSpan,
        })),
      ),
      monitorConnectedLease(active.lease).pipe(
        Effect.mapError((error): TracedAttemptFailure => ({
          error,
          attemptSpan: active.attemptSpan,
        })),
      ),
    ).pipe(Effect.exit);
    const connectedForMs = (yield* Clock.currentTimeMillis) - connectedAt;
    if (Exit.isSuccess(connectedExit)) {
      return {
        _tag: "Interrupted",
        established: true,
        stable: connectedForMs >= BACKOFF_RESET_AFTER_MS,
        resetRetry: connectedExit.value,
      } satisfies AttemptOutcome;
    }
    yield* logUnexpectedFailure("attempt", connectedExit.cause);
    const outcome = failureFromCause(
      target,
      connectedExit.cause,
      true,
      connectedForMs >= BACKOFF_RESET_AFTER_MS,
    );
    yield* recordRouteFailure(
      connectionRouteId(active.lease.prepared.target),
      outcome.failure.error,
    );
    // A live session ending is otherwise invisible in the client trace, so
    // record why, and how long it lasted, as its own root span.
    yield* Effect.void.pipe(
      Effect.withSpan("EnvironmentSupervisor.connectionLost", {
        root: true,
        attributes: {
          "environment.id": target.environmentId,
          "environment.label": target.label,
          "environment.target.kind": target._tag,
          "connection.connected_ms": connectedForMs,
          "connection.failure.reason": outcome.failure.error.reason,
          "connection.failure.detail": outcome.failure.error.detail,
        },
      }),
    );
    return outcome;
  }, Effect.ensuring(clearLease));

  const waitForRetrySignal = Effect.fnUntraced(function* (delayMs: number) {
    // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - the sleep is the retry delay (false), not a timeout around the signal loop
    return yield* Effect.raceFirst(
      Effect.sleep(delayMs).pipe(Effect.as(false)),
      Effect.gen(function* () {
        for (;;) {
          const next = yield* Queue.take(signals);
          switch (next._tag) {
            case "Wakeup":
              return ConnectionWakeups.resetsRetryBackoff(next.reason);
            case "ConnectRequested":
            case "DisconnectRequested":
            case "RetryRequested":
            case "NetworkChanged":
              return false;
            case "BetterRouteAvailable":
              break;
          }
        }
      }),
    );
  });

  // A better route only matters to a live session, so idle states ignore it.
  const waitForSignal = Queue.take(signals).pipe(
    Effect.repeat({ while: (next) => next._tag === "BetterRouteAvailable" }),
    Effect.map(
      (next) => next._tag === "Wakeup" && ConnectionWakeups.resetsRetryBackoff(next.reason),
    ),
  );

  const run = Effect.fnUntraced(function* () {
    let failureCount = 0;
    let latestFailure: ConnectionAttemptError | null = null;
    let pendingRetry = Option.none<PendingRetryTrace>();
    const resetRetryLadder = () => {
      failureCount = 0;
      pendingRetry = Option.none();
    };
    // When a stable direct session was last lost, while retries follow the outage.
    let outageStartedAt: number | undefined;
    // Set after a long resume ends an attempt, or a session that missed its
    // probe. The fresh attempt
    // runs even while the network reports offline: the report is often wrong,
    // and the replaced session must not leave the client offline.
    let replacing = false;

    for (;;) {
      const retryRequested = yield* Ref.getAndSet(resetRetryState, false);
      if (retryRequested) {
        failureCount = 0;
        latestFailure = null;
        pendingRetry = Option.none();
      }
      const currentIntent = yield* Ref.get(intent);
      if (!currentIntent.desired) {
        resetRetryLadder();
        latestFailure = null;
        yield* clearLease;
        yield* setState(availableState(currentIntent, generation));
        yield* waitForSignal;
        continue;
      }
      // The platform's offline report can stay wrong after the network is back,
      // so an explicit retry still tries instead of waiting for it to change.
      const ignoreOffline = replacing || retryRequested;
      if (currentIntent.network === "offline" && !ignoreOffline) {
        yield* clearLease;
        yield* setState(offlineState(currentIntent, generation, failureCount + 1, latestFailure));
        const applicationActivated = yield* waitForSignal;
        if (applicationActivated) {
          resetRetryLadder();
        }
        continue;
      }

      const attempt = failureCount + 1;
      const nextGeneration = generation + 1;
      const outcome: AttemptOutcome = yield* Effect.acquireUseRelease(
        Scope.make(),
        (scope) =>
          runAttempt(attempt, nextGeneration, latestFailure, pendingRetry, ignoreOffline).pipe(
            Scope.provide(scope),
            Effect.catchCause((cause) =>
              logUnexpectedFailure("attempt", cause).pipe(
                Effect.as(failureFromCause(target, cause, generation === nextGeneration, false)),
              ),
            ),
          ),
        (scope, exit) =>
          Scope.close(scope, exit).pipe(
            Effect.catchCause((cause) => logUnexpectedFailure("release", cause)),
          ),
      );
      replacing = false;
      // Consumed on every iteration so a stale marker can never leak into a
      // later, unrelated failure.
      const failedProbe = yield* Ref.getAndSet(probeUnanswered, false);
      const failedLongResumeProbe = yield* Ref.getAndSet(longResumeProbeUnanswered, false);
      if (failedProbe) {
        // A socket idle in the background is usually killed by the OS rather
        // than running on a slow link; widening after a long resume would pin
        // every subsequent reopen to the full quick-probe ceiling (8 s on mobile).
        if (!failedLongResumeProbe) probeBudgetWidened = true;
        probeRoundTripMs = undefined;
        handshakeRoundTripMs = undefined;
      }
      if (outcome.established) {
        // A session came up, so earlier setup failures no longer describe it.
        // Losing this live socket is not a failed attempt at its replacement.
        latestFailure = null;
        if (outcome.stable) {
          resetRetryLadder();
        }
        // A session that keeps dropping right after connecting climbs the ladder.
        outageStartedAt =
          outcome.stable && !liveOverRelay ? yield* Clock.currentTimeMillis : undefined;
      }
      if (outcome._tag === "Interrupted") {
        if (outcome.resetRetry) {
          resetRetryLadder();
          replacing = true;
        }
        continue;
      }

      const attemptSpan: Option.Option<Tracer.Span> = outcome.failure.attemptSpan;
      const error: ConnectionAttemptError = outcome.failure.error;
      if (!outcome.established) {
        latestFailure = error;
      }
      if (error._tag === "ConnectionBlockedError") {
        const blockedIntent = yield* Ref.get(intent);
        yield* setState({
          desired: blockedIntent.desired,
          network: blockedIntent.network,
          phase: "blocked",
          stage: null,
          attempt,
          generation,
          lastFailure: error,
          retryAt: null,
        });
        const applicationActivated = yield* waitForSignal;
        if (applicationActivated) {
          resetRetryLadder();
        }
        continue;
      }

      if (failedProbe) {
        // A probe found a dead transport, or the transport closed while a probe
        // waited for an answer (the user returned to the app, asked to retry,
        // or the network changed), so reconnect immediately instead
        // of sleeping the first backoff rung. Only this first attempt skips the
        // ladder; if it fails too, normal backoff resumes.
        resetRetryLadder();
        replacing = failedLongResumeProbe;
        yield* setState(connectingState(yield* Ref.get(intent), generation, 1, latestFailure));
        continue;
      }

      failureCount += 1;
      const failedAt = yield* Clock.currentTimeMillis;
      const delayMs = retryDelayMs(
        failureCount - 1,
        yield* Random.next,
        outageStartedAt === undefined
          ? timings.retryMaxDelayMs
          : outageRetryMaxDelayMs(failedAt - outageStartedAt, timings.retryMaxDelayMs),
      );
      pendingRetry = Option.map(attemptSpan, (previousAttempt) => ({
        previousAttempt,
        failureCount,
        delayMs,
        reason: error.reason,
      }));
      const failedIntent = yield* Ref.get(intent);
      yield* setState({
        desired: failedIntent.desired,
        network: failedIntent.network,
        phase: "backoff",
        stage: null,
        attempt,
        generation,
        lastFailure: latestFailure,
        retryAt: failedAt + delayMs,
      });
      const applicationActivated = yield* waitForRetrySignal(delayMs);
      if (applicationActivated) {
        resetRetryLadder();
      }
    }
  });

  // Registered before the fibers below so closing the scope interrupts them first.
  // A loop still running when the queue shuts down would report that as a failure.
  yield* Effect.addFinalizer(() => Queue.shutdown(signals).pipe(Effect.andThen(clearLease)));
  // A defect in a background listener would otherwise end it for good, silently.
  // Untraced: a span here would stay open for the supervisor's whole lifetime.
  const keepRunning = Effect.fnUntraced(
    function* (task: string, effect: Effect.Effect<void>, onRestart?: Effect.Effect<void>) {
      let current = effect;
      while (true) {
        const exit = yield* Effect.exit(current);
        if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return yield* exit;
        yield* Effect.logError("Connection supervisor task failed; restarting it.").pipe(
          Effect.annotateLogs({
            "environment.id": target.environmentId,
            "environment.label": target.label,
            task,
            ...safeErrorLogAttributes(exit.cause.reasons.find(Cause.isDieReason)?.defect),
          }),
        );
        yield* Effect.sleep(RETRY_BASE_DELAY_MS);
        current = onRestart ? onRestart.pipe(Effect.andThen(effect)) : effect;
      }
    },
    (self) => Effect.forkScoped(self),
  );

  const applyNetwork = (network: NetworkStatus) =>
    Ref.modify(
      intent,
      (current): readonly ["unchanged" | "initial-discovery" | "changed", SupervisorIntent] => {
        const next = targetNetwork(network);
        if (current.network === next) {
          return ["unchanged", current];
        }
        const initialDiscovery =
          !hasKnownNetwork && current.network === "unknown" && next === "online";
        if (next !== "unknown") hasKnownNetwork = true;
        return [initialDiscovery ? "initial-discovery" : "changed", { ...current, network: next }];
      },
    ).pipe(
      Effect.flatMap((change) =>
        change === "unchanged"
          ? Effect.void
          : signal({
              _tag: "NetworkChanged",
              network,
              ...(change === "initial-discovery" ? { initialDiscovery: true } : {}),
            }),
      ),
    );
  // A restarted listener may have missed changes while it was down.
  yield* keepRunning(
    "network-listener",
    connectivity.changes.pipe(Stream.runForEach(applyNetwork)),
    connectivity.status.pipe(Effect.flatMap(applyNetwork)),
  );
  yield* keepRunning(
    "wakeup-listener",
    wakeups.changes.pipe(Stream.runForEach((reason) => signal({ _tag: "Wakeup", reason }))),
  );
  yield* keepRunning(
    "better-route-checker",
    Queue.take(betterRouteChecks).pipe(Effect.flatMap(checkBetterRoutes), Effect.forever),
  );
  // A restarted loop has forgotten its retry ladder, so it waits out the
  // ladder's ceiling unless a signal cuts the wait short.
  yield* run().pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        yield* logUnexpectedFailure("loop", cause);
        const currentIntent = yield* Ref.get(intent);
        const lastFailure = unexpectedFailure(target).error;
        yield* setState(
          !currentIntent.desired
            ? availableState(currentIntent, generation)
            : currentIntent.network === "offline"
              ? offlineState(currentIntent, generation, 1, lastFailure)
              : {
                  desired: true,
                  network: currentIntent.network,
                  phase: "backoff",
                  stage: null,
                  attempt: 1,
                  generation,
                  lastFailure,
                  retryAt: (yield* Clock.currentTimeMillis) + timings.retryMaxDelayMs,
                },
        );
        yield* waitForRetrySignal(timings.retryMaxDelayMs);
      }),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  const connect = Ref.update(intent, (current) => ({
    ...current,
    desired: true,
  })).pipe(
    Effect.andThen(signal({ _tag: "ConnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.connect"),
  );

  const disconnect = Ref.update(intent, (current) => ({
    ...current,
    desired: false,
  })).pipe(
    Effect.andThen(signal({ _tag: "DisconnectRequested" })),
    Effect.withSpan("EnvironmentSupervisor.disconnect"),
  );

  const retryNow = Ref.set(resetRetryState, true).pipe(
    Effect.andThen(signal({ _tag: "RetryRequested" })),
    Effect.withSpan("EnvironmentSupervisor.retryNow"),
  );

  return EnvironmentSupervisor.of({
    target,
    state,
    session,
    prepared,
    connect,
    disconnect,
    retryNow,
  });
});
