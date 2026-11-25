import {
  AuthStandardClientScopes,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  ORCHESTRATION_V2_WS_METHODS,
  type ServerConfig,
} from "@t3tools/contracts";
import { ServerConfigStreamWireEvent } from "@t3tools/contracts/serverConfigWire";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Cause from "effect/Cause";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { makeEnvironmentThreadState } from "../state/threads.ts";
import * as ThreadSnapshotLoader from "../state/threadSnapshotHttp.ts";
import { makeEnvironmentShellState, ShellSnapshotLoader } from "../state/shell.ts";
import { v2Projection, v2ShellSnapshot, v2ThreadId } from "../state/orchestrationV2TestFixtures.ts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { setLoadMarkSink, type LoadMarkDetail } from "../loadMarks.ts";
import * as Tracer from "effect/Tracer";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as TokenStore from "../authorization/tokenStore.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import * as Connectivity from "./connectivity.ts";
import * as ConnectionDriver from "./driver.ts";
import { BearerConnectionProfile } from "./catalog.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type ConnectionAttemptError,
  type ConnectionTarget,
  type NetworkStatus,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./model.ts";
import * as RpcSession from "../rpc/session.ts";
import { presentConnectionState } from "./presentation.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { ConnectionTimings, MOBILE_CONNECTION_TIMINGS } from "./timings.ts";
import * as ConnectionWakeups from "./wakeups.ts";
import { connectionRouteId, entryWithRoutes, isLearned, mergeLearnedRoutes } from "./routes.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import { NetworkTiming, makeNetworkTiming, RequestProgress } from "./networkTiming.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const RELAY_TARGET = new RelayConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
});

const TARGET_ENTRY: ConnectionCatalogEntry = {
  target: TARGET,
  profile: Option.none(),
  enabled: true,
};

const RELAY_ENTRY: ConnectionCatalogEntry = {
  target: RELAY_TARGET,
  profile: Option.none(),
  enabled: true,
};

const PREPARED_CONNECTION: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: "wss://environment.example.test/ws",
  httpAuthorization: null,
  target: TARGET,
};

const TEST_RPC_CLIENT = {} as WsRpcProtocolClient;

const LAN_TARGET = new BearerConnectionTarget({
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  connectionId: "bearer:lan",
});
const LAN_ROUTE: ConnectionRoute = {
  target: LAN_TARGET,
  profile: Option.some(
    new BearerConnectionProfile({
      connectionId: LAN_TARGET.connectionId,
      environmentId: TARGET.environmentId,
      label: TARGET.label,
      httpBaseUrl: "http://192.168.1.10:3773/",
      wsBaseUrl: "ws://192.168.1.10:3773/",
    }),
  ),
};
// LAN first, T3 Connect as the fallback.
const LAN_THEN_RELAY_ENTRY: ConnectionCatalogEntry = {
  target: LAN_ROUTE.target,
  profile: LAN_ROUTE.profile,
  alternateRoutes: [{ target: RELAY_TARGET, profile: Option.none() }],
  enabled: true,
};

function preparedFor(target: ConnectionTarget): PreparedConnection {
  return { ...PREPARED_CONNECTION, target };
}

function transient(message = "Connection failed.") {
  return new ConnectionTransientError({
    reason: "transport",
    detail: message,
  });
}

function blocked(message = "Authentication required.") {
  return new ConnectionBlockedError({
    reason: "authentication",
    detail: message,
  });
}

function awaitState(
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  return SubscriptionRef.changes(state).pipe(
    Stream.filter(predicate),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

const eventuallyState = Effect.fn("TestConnectionHarness.eventuallyState")(function* (
  state: SubscriptionRef.SubscriptionRef<SupervisorConnectionState>,
  predicate: (value: SupervisorConnectionState) => boolean,
) {
  let lastState = yield* SubscriptionRef.get(state);
  for (let iteration = 0; iteration < 100; iteration += 1) {
    lastState = yield* SubscriptionRef.get(state);
    if (predicate(lastState)) {
      return lastState;
    }
    yield* Effect.yieldNow;
  }
  return yield* Effect.die(
    new Error(
      `Expected supervisor state was not observed. Last state: phase=${lastState.phase}, stage=${lastState.stage ?? "none"}, attempt=${lastState.attempt}, generation=${lastState.generation}`,
    ),
  );
});

const makeHarness = Effect.fn("TestConnectionHarness.make")(function* (options?: {
  readonly client?: WsRpcProtocolClient;
  readonly networkStatus?: NetworkStatus;
  readonly prepare?: (
    attempt: number,
    target: ConnectionTarget,
  ) => Effect.Effect<PreparedConnection, ConnectionAttemptError>;
  readonly ready?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly release?: (attempt: number) => Effect.Effect<void>;
  readonly openDurationMs?: number | ((attempt: number) => number);
  readonly pingRoundTripMs?: number;
  readonly responseTimeoutMs?: (minimumMs: number) => number;
  readonly probe?: (attempt: number) => Effect.Effect<void, ConnectionAttemptError>;
  readonly receivedAt?: Effect.Effect<bigint>;
  readonly rpcReceivedAt?: Effect.Effect<bigint>;
  readonly configSnapshots?: Stream.Stream<ServerConfig>;
  readonly initialConfig?: (attempt: number) => Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly checkRoute?: (route: ConnectionRoute) => Effect.Effect<ConnectionDriver.RouteCheck>;
}) {
  const networkStatus = yield* SubscriptionRef.make<NetworkStatus>(
    options?.networkStatus ?? "online",
  );
  const prepareCount = yield* Ref.make(0);
  const preparedAhead = yield* Ref.make<ReadonlyArray<string>>([]);
  const sessionCount = yield* Ref.make(0);
  const releaseCount = yield* Ref.make(0);
  const wakeups = yield* SubscriptionRef.make<{
    readonly sequence: number;
    readonly reason: ConnectionWakeups.ConnectionWakeup;
  }>({
    sequence: 0,
    reason: "application-active",
  });
  const closedSessions = yield* Ref.make<
    ReadonlyArray<Deferred.Deferred<never, ConnectionTransientError>>
  >([]);

  const connectivity = Connectivity.Connectivity.of({
    status: SubscriptionRef.get(networkStatus),
    changes: SubscriptionRef.changes(networkStatus),
  });

  const prepare = Effect.fn("TestConnectionDriver.prepare")(function* (target: ConnectionTarget) {
    const attempt = yield* Ref.updateAndGet(prepareCount, (count) => count + 1);
    if (options?.prepare) {
      return yield* options.prepare(attempt, target);
    }
    return PREPARED_CONNECTION;
  });

  const checkRoute = (route: ConnectionRoute) =>
    options?.checkRoute?.(route) ?? Effect.succeed<ConnectionDriver.RouteCheck>("unchecked");

  const connectRoute = Effect.fn("TestConnectionDriver.connectRoute")(function* (
    target: ConnectionTarget,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing", target });
    const prepared = yield* prepare(target);
    yield* reportProgress({ stage: "opening", prepared });

    const attempt = yield* Ref.updateAndGet(sessionCount, (count) => count + 1);
    const closed = yield* Deferred.make<never, ConnectionTransientError>();
    yield* Ref.update(closedSessions, (sessions) => [...sessions, closed]);

    const session = yield* Effect.acquireRelease(
      Effect.succeed({
        client: options?.client ?? TEST_RPC_CLIENT,
        ...(options?.configSnapshots === undefined
          ? {}
          : { configSnapshots: options.configSnapshots }),
        initialConfig:
          options?.initialConfig?.(attempt) ??
          Effect.die(new Error("Initial config is not used by supervisor tests.")),
        subscribeServerConfig: (input) => TEST_RPC_CLIENT.subscribeServerConfig(input),
        ready: options?.ready?.(attempt) ?? Effect.void,
        ...(options?.openDurationMs === undefined
          ? {}
          : {
              openDurationMs: Effect.succeed(
                typeof options.openDurationMs === "function"
                  ? options.openDurationMs(attempt)
                  : options.openDurationMs,
              ),
            }),
        ...(options?.pingRoundTripMs === undefined
          ? {}
          : {
              pingRoundTrip: Clock.monotonicTimeNanos.pipe(
                Effect.map((measuredAt) => ({
                  milliseconds: options.pingRoundTripMs!,
                  measuredAt,
                })),
              ),
            }),
        ...(options?.responseTimeoutMs === undefined
          ? {}
          : {
              responseTimeoutMs: (minimumMs: number) =>
                Effect.succeed(options.responseTimeoutMs!(minimumMs)),
            }),
        probe: options?.probe?.(attempt) ?? Effect.void,
        ...(options?.receivedAt === undefined ? {} : { receivedAt: options.receivedAt }),
        ...(options?.rpcReceivedAt === undefined ? {} : { rpcReceivedAt: options.rpcReceivedAt }),
        closed: Deferred.await(closed),
      } satisfies RpcSession.RpcSession),
      () =>
        Ref.update(releaseCount, (count) => count + 1).pipe(
          Effect.andThen(options?.release?.(attempt) ?? Effect.void),
        ),
    );

    yield* reportProgress({ stage: "synchronizing", prepared, session });
    yield* session.ready;
    return { prepared, session } satisfies ConnectionDriver.EnvironmentConnectionLease;
  });

  const connect = Effect.fn("TestConnectionDriver.connect")(function* (
    entry: ConnectionCatalogEntry,
    reportProgress: (progress: ConnectionDriver.ConnectionDriverProgress) => Effect.Effect<void>,
  ) {
    yield* reportProgress({ stage: "preparing" });
    const timings = yield* ConnectionTimings;
    return yield* ConnectionDriver.connectOverRoutes(
      entry,
      checkRoute,
      (route) => connectRoute(route.target, reportProgress),
      (route, error) => reportProgress({ stage: "route-failed", target: route.target, error }),
      timings.routeFallbackDelayMs,
    );
  });

  const layerDependencies = Layer.mergeAll(
    // Jitter at its maximum, so each retry waits exactly its ceiling: 2s, 4s, 8s...
    Layer.succeed(Random.Random, {
      nextDoubleUnsafe: () => 1 - Number.EPSILON,
      nextIntUnsafe: () => 0,
    }),
    Layer.succeed(Connectivity.Connectivity, connectivity),
    Layer.succeed(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({
        changes: SubscriptionRef.changes(wakeups).pipe(
          Stream.drop(1),
          Stream.map((event) => event.reason),
        ),
      }),
    ),
    Layer.succeed(
      ConnectionDriver.ConnectionDriver,
      ConnectionDriver.ConnectionDriver.of({
        connect,
        checkRoute: (_entry, route) => checkRoute(route),
        preflight: (_entry, route) =>
          checkRoute(route).pipe(Effect.map((check) => check === "answered")),
        prepareAhead: (_entry, route) =>
          Ref.update(preparedAhead, (routes) => [...routes, connectionRouteId(route.target)]),
      }),
    ),
  );

  return {
    dependencies: layerDependencies,
    prepareCount,
    preparedAhead,
    sessionCount,
    releaseCount,
    setNetworkStatus: (status: NetworkStatus) => SubscriptionRef.set(networkStatus, status),
    wake: (reason: ConnectionWakeups.ConnectionWakeup) =>
      SubscriptionRef.update(wakeups, (event) => ({
        sequence: event.sequence + 1,
        reason,
      })),
    closeLatestSession: Effect.fn("TestConnectionHarness.closeLatestSession")(function* (
      exit: Exit.Exit<never, ConnectionTransientError> = Exit.fail(transient("Session closed.")),
    ) {
      const sessions = yield* Ref.get(closedSessions);
      const latest = sessions.at(-1);
      if (latest) {
        yield* Deferred.done(latest, exit);
      }
    }),
  };
});

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamWireEvent);

function recordLogs(logs: Array<unknown>, annotations?: Array<unknown>) {
  return Logger.layer(
    [
      Logger.make(({ message, fiber }) => {
        logs.push(message);
        annotations?.push(fiber.getRef(References.CurrentLogAnnotations));
      }),
    ],
    { mergeWithExisting: false },
  );
}

const mobileConfig: ServerConfig = {
  environment: {
    environmentId: TARGET.environmentId,
    label: TARGET.label,
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "test",
    capabilities: { repositoryIdentity: true, connectionProbe: true },
  },
  cwd: "/workspace",
  keybindingsConfigPath: "/workspace/keybindings.json",
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie", "bearer-access-token"],
    sessionCookieName: "test",
  },
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/workspace/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
  threadResumeCompletionMarker: true,
  shellResumeCompletionMarker: true,
};
const savedChat: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  messages: (["user", "assistant"] as const).map((role) => ({
    id: MessageId.make(role),
    role,
    threadId: v2ThreadId,
    runId: null,
    nodeId: null,
    text: role === "user" ? "How is the build?" : "The build passed.",
    streaming: false,
    createdAt: v2Projection.updatedAt,
    updatedAt: v2Projection.updatedAt,
    attachments: [],
    createdBy: "user",
    creationSource: "mobile",
  })),
};
const updatedThread = { ...savedChat.thread, title: "Build results" };
const freshSnapshot = { snapshotSequence: 8, projection: { ...savedChat, thread: updatedThread } };
const updatedShell = { ...v2ShellSnapshot.threads[0]!, title: updatedThread.title };
const freshShell = { ...v2ShellSnapshot, snapshotSequence: 8, threads: [updatedShell] };

// Virtual time at the same load marks the mobile client records. The local cache
// takes 8 ms; each fake transport response takes one RTT. The second ticket
// request loses its path and will only answer with the mobile HTTP timeout.
describe("mobile connection latency", () => {
  it.effect.each([40, 150, 600].flatMap((rtt) => [true, false].map((cached) => ({ rtt, cached }))))(
    "recovers the open chat at $rtt ms RTT with cached=$cached",
    ({ rtt, cached }) =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        const marks = new Map<string, number[]>();
        setLoadMarkSink((name) => {
          const times = marks.get(name) ?? [];
          times.push(clock.currentTimeMillisUnsafe());
          marks.set(name, times);
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => setLoadMarkSink(null)));
        const requests: string[] = [];
        const roundTrip = (name: string) =>
          Effect.sync(() => requests.push(name)).pipe(Effect.andThen(Effect.sleep(rtt)));
        const marker = { kind: "synchronized" as const };
        const resume = <A>(name: string, after: number | undefined, update: A) =>
          Stream.fromEffect(roundTrip(name)).pipe(
            Stream.flatMap(() => Stream.fromIterable(after === 7 ? [update, marker] : [marker])),
            Stream.concat(Stream.never),
          );
        const stalled = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          client: {
            [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: ({
              afterSequence,
            }: {
              afterSequence?: number;
            }) =>
              resume("thread", afterSequence, {
                kind: "event",
                sequence: 8,
                event: {
                  id: EventId.make("rename"),
                  type: "thread.metadata-updated",
                  threadId: v2ThreadId,
                  occurredAt: savedChat.updatedAt,
                  payload: updatedThread,
                },
              }),
            [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: ({
              afterSequence,
            }: {
              afterSequence?: number;
            }) =>
              resume("shell", afterSequence, {
                kind: "thread.updated",
                sequence: 8,
                location: "active",
                thread: updatedShell,
              }),
          } as unknown as WsRpcProtocolClient,
          prepare: (attempt) =>
            attempt === 2
              ? Deferred.succeed(stalled, undefined).pipe(
                  Effect.andThen(Effect.sleep(MOBILE_CONNECTION_TIMINGS.connectRequestTimeoutMs)),
                  Effect.andThen(Effect.fail(transient("Ticket request timed out"))),
                )
              : roundTrip("descriptor").pipe(
                  Effect.andThen(roundTrip("ticket")),
                  Effect.as(preparedFor(LAN_TARGET)),
                ),
          ready: () => roundTrip("open").pipe(Effect.andThen(roundTrip("config"))),
          initialConfig: () => Effect.succeed(mobileConfig),
          probe: () => roundTrip("probe"),
        });
        const supervisor = yield* EnvironmentSupervisor.make(
          { ...LAN_ROUTE, enabled: true },
          {
            initiallyDesired: true,
          },
        ).pipe(
          Effect.provide(harness.dependencies),
          Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
        );
        const advance = (ms: number) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(ms);
            for (let turn = 0; turn < 12; turn++) yield* Effect.yieldNow;
          });
        const snapshot = { snapshotSequence: 7, projection: savedChat };
        const snapshotSizes: number[] = [];
        const snapshotResponse = <T>(name: string, value: T) =>
          roundTrip(name).pipe(
            Effect.tap(() =>
              Effect.sync(() =>
                snapshotSizes.push(new TextEncoder().encode(JSON.stringify(value)).length),
              ),
            ),
            Effect.as(value),
          );
        const cache = Layer.mock(EnvironmentCacheStore)({
          loadShell: () =>
            Effect.sleep(8).pipe(
              Effect.as(
                cached ? Option.some({ ...v2ShellSnapshot, snapshotSequence: 7 }) : Option.none(),
              ),
            ),
          loadThread: () =>
            Effect.sleep(8).pipe(Effect.as(cached ? Option.some(snapshot) : Option.none())),
          saveShell: () => Effect.void,
          saveThread: () => Effect.void,
          retainThread: () => Effect.void,
        });
        const states = yield* Effect.all(
          [makeEnvironmentShellState(), makeEnvironmentThreadState(v2ThreadId)],
          {
            concurrency: "unbounded",
          },
        ).pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(ShellSnapshotLoader.ShellSnapshotLoader, {
            resumeCachedSnapshot: true,
            load: () => snapshotResponse("shell.http", freshShell).pipe(Effect.asSome),
          }),
          Effect.provideService(ThreadSnapshotLoader.ThreadSnapshotLoader, {
            load: () =>
              snapshotResponse("thread.http", freshSnapshot).pipe(
                Effect.map((value) => ({ _tag: "present" as const, snapshot: value })),
              ),
          }),
          Effect.provide(Layer.merge(cache, harness.dependencies)),
          Effect.forkScoped,
        );
        yield* advance(0);
        yield* advance(8);
        const [shell, thread] = yield* Fiber.join(states);
        if (cached) {
          expect(Option.getOrThrow((yield* SubscriptionRef.get(thread)).data).messages).toEqual(
            savedChat.messages,
          );
          expect(
            Option.getOrThrow((yield* SubscriptionRef.get(shell)).snapshot).threads[0]?.title,
          ).toBe(savedChat.thread.title);
        }
        yield* advance(rtt - 8);
        for (let turn = 0; turn < 5; turn++) yield* advance(rtt);
        expect(Option.getOrThrow((yield* SubscriptionRef.get(shell)).snapshot).threads).toEqual([
          updatedShell,
        ]);
        expect((yield* SubscriptionRef.get(shell)).status).toBe("live");
        expect((yield* SubscriptionRef.get(thread)).status).toBe("live");
        expect(requests.slice().sort()).toEqual([
          "config",
          "descriptor",
          "open",
          "shell",
          ...(cached ? [] : ["shell.http"]),
          "thread",
          ...(cached ? [] : ["thread.http"]),
          "ticket",
        ]);
        yield* advance(4_000);
        const wokeAt = yield* Clock.currentTimeMillis;
        yield* harness.wake("application-active-reconnect");
        yield* advance(0);
        yield* advance(rtt);
        expect(marks.get("thread.live")?.[1]).toBe(wokeAt + rtt);
        // Regaining focus without ever entering background needs only a liveness probe.
        yield* advance(4_000);
        const beforeFocus = requests.length;
        yield* harness.wake("application-focus");
        yield* advance(0);
        const focusStatus = (yield* SubscriptionRef.get(thread)).status;
        yield* advance(rtt);
        expect({ requests: requests.slice(beforeFocus).sort(), focusStatus }).toEqual({
          requests: ["probe"],
          focusStatus: "live",
        });
        const droppedAt = yield* Clock.currentTimeMillis;
        yield* harness.closeLatestSession();
        yield* advance(0);
        yield* advance(2_000);
        yield* Deferred.await(stalled);
        expect(Option.getOrNull((yield* SubscriptionRef.get(thread)).data)).toEqual(
          freshSnapshot.projection,
        );
        yield* harness.wake("network-changed");
        yield* advance(0);
        for (let turn = 0; turn < 5; turn++) yield* advance(rtt);
        yield* advance(20_000 - 5 * rtt);
        yield* advance(4_000);
        for (let turn = 0; turn < 5; turn++) yield* advance(rtt);
        const live = marks.get("thread.live")!;
        const recoverMs = live[2]! - droppedAt;
        const sample = {
          rtt,
          cachedMs: cached ? marks.get("thread.cached")?.[0] : null,
          freshMs: cached ? live[0] : marks.get("thread.http.applied")?.[0],
          liveMs: live[0],
          recoverMs,
          firstConfigBytes: new TextEncoder().encode(
            JSON.stringify(
              encodeConfigEvent({
                version: 1,
                type: "snapshot",
                config: mobileConfig,
              }),
            ),
          ).length,
          snapshotSizes,
          snapshotBytes: snapshotSizes.reduce((sum, size) => sum + size, 0),
        };
        yield* Console.log(JSON.stringify(sample)).pipe(
          Effect.provideService(Console.Console, Console.Console.defaultValue()),
        );
        expect(sample.cachedMs).toBe(cached ? 8 : null);
        expect(sample.freshMs).toBe(5 * rtt);
        expect(sample.snapshotBytes > 0).toBe(!cached);
        expect(live).toHaveLength(3);
        expect(live[0]).toBe((cached ? 5 : 6) * rtt);
        expect(recoverMs, JSON.stringify(sample)).toBe(2_000 + 5 * rtt);
      }).pipe(Effect.scoped),
  );
});

describe("retryDelayMs", () => {
  it("doubles from 2 seconds to a 5 minute cap, jittered within the upper half of each step", () => {
    const ceilings = [2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000];
    for (const [failureCount, ceiling] of [...ceilings, 300_000].entries()) {
      expect(EnvironmentSupervisor.retryDelayMs(failureCount, 0)).toBe(ceiling / 2);
      expect(EnvironmentSupervisor.retryDelayMs(failureCount, 0.5)).toBe((ceiling * 3) / 4);
      expect(EnvironmentSupervisor.retryDelayMs(failureCount, 1 - Number.EPSILON)).toBe(ceiling);
    }
  });

  it("sizes a resume probe to the round trip, within 1 second and the quick budget", () => {
    expect(EnvironmentSupervisor.resumeProbeBudgetMs(undefined, 8_000)).toBe(8_000);
    expect(EnvironmentSupervisor.resumeProbeBudgetMs(12, 8_000)).toBe(1_000);
    expect(EnvironmentSupervisor.resumeProbeBudgetMs(400, 8_000)).toBe(3_150);
    expect(EnvironmentSupervisor.resumeProbeBudgetMs(2_000, 8_000)).toBe(12_750);
  });

  it("stops doubling at a phone's 30 second cap", () => {
    const cap = MOBILE_CONNECTION_TIMINGS.retryMaxDelayMs;
    expect(EnvironmentSupervisor.retryDelayMs(3, 0, cap)).toBe(8_000);
    expect(EnvironmentSupervisor.retryDelayMs(4, 1 - Number.EPSILON, cap)).toBe(30_000);
    expect(EnvironmentSupervisor.retryDelayMs(12, 0, cap)).toBe(15_000);
  });
});

describe("EnvironmentSupervisor", () => {
  it.effect("exports each relay setup as a standalone linked trace that ends at readiness", () =>
    Effect.gen(function* () {
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            spans.push(span);
          };
          return span;
        },
      });
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(harness.dependencies),
        Effect.provideService(RelayClientTracer, Option.some(tracer)),
      );

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      const firstAttempt = spans.find((span) => span.name === "relay.connection.attempt");
      expect(firstAttempt).toBeDefined();

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      const attempts = spans.filter((span) => span.name === "relay.connection.attempt");
      expect(attempts).toHaveLength(2);
      expect(attempts[0]?.traceId).not.toBe(attempts[1]?.traceId);
      expect(attempts[1]?.links.map((link) => link.span.spanId)).toContain(attempts[0]?.spanId);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not attempt a connection until it is desired", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("available");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);
    }),
  );

  it.effect("does not let the initial connect signal cancel the first attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY).pipe(
        Effect.provide(harness.dependencies),
      );

      yield* supervisor.connect;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect("waits while offline and connects immediately when the network returns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkStatus: "offline" });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      expect(yield* Ref.get(harness.prepareCount)).toBe(0);

      yield* harness.setNetworkStatus("online");
      const ready = yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(ready).toMatchObject({
        desired: true,
        network: "online",
        phase: "connected",
        attempt: 1,
        generation: 1,
        lastFailure: null,
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("resets retries when activation arrives before the network returns", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* harness.setNetworkStatus("offline");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "offline" && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "offline" && state.attempt === 1,
      );
      yield* harness.setNetworkStatus("online");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );
    }),
  );

  it.effect("retries forever with exponential backoff capped at five minutes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.fail(transient()),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      const delays = [
        2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 256_000, 300_000, 300_000,
      ];
      for (const [index, delay] of delays.entries()) {
        yield* TestClock.adjust(delay - 1);
        expect(yield* Ref.get(harness.prepareCount)).toBe(index + 1);
        yield* TestClock.adjust(1);
        yield* eventuallyState(
          supervisor.state,
          (state) => state.phase === "backoff" && state.attempt === index + 2,
        );
      }

      expect(yield* Ref.get(harness.prepareCount)).toBe(delays.length + 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("explicit retry connects while the network still reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        networkStatus: "offline",
        prepare: () => Effect.sleep("1 second").pipe(Effect.as(PREPARED_CONNECTION)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "offline");
      // The loop wakes on the earlier signal and takes the retry's flag while
      // RetryRequested is still queued, so that signal must not cancel the attempt.
      yield* supervisor.connect;
      yield* supervisor.retryNow;
      yield* TestClock.adjust("1 second");
      const settled = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" || state.phase === "offline",
      );

      expect(settled.phase).toBe("connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect.each([
    { label: "cancels connection setup", retry: false, phase: "offline", sessions: 0 },
    { label: "does not cancel an explicit retry", retry: true, phase: "connected", sessions: 1 },
  ])("an offline report during setup $label", ({ retry, phase, sessions }) =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: () =>
          Deferred.succeed(firstAttemptStarted, undefined).pipe(
            Effect.andThen(Effect.sleep("1 second")),
            Effect.as(PREPARED_CONNECTION),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      if (retry) {
        yield* supervisor.retryNow;
      }
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("1 second");
      const settled = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" || state.phase === "offline",
      );

      expect(settled.phase).toBe(phase);
      expect(yield* Ref.get(harness.sessionCount)).toBe(sessions);
    }),
  );

  it.effect("connects to the primary environment while the device reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ networkStatus: "offline" });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const settled = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" || state.phase === "offline",
      );

      expect(settled).toMatchObject({
        phase: "connected",
        network: "unknown",
        attempt: 1,
        lastFailure: null,
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect(
    "keeps a primary attempt through an offline report and restarts it when the network returns",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            attempt === 1
              ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
              : Effect.succeed(PREPARED_CONNECTION),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* Deferred.await(started);
        yield* harness.setNetworkStatus("offline");
        yield* TestClock.adjust("1 second");
        expect(yield* Ref.get(harness.prepareCount)).toBe(1);

        yield* harness.setNetworkStatus("online");
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the latest failure visible throughout the next connection attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient("Relay connection timed out.")) : Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");

      const retrying = yield* awaitState(
        supervisor.state,
        (state) =>
          state.phase === "connecting" && state.stage === "preparing" && state.attempt === 2,
      );
      expect(retrying).toMatchObject({
        phase: "connecting",
        stage: "preparing",
        attempt: 2,
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Relay connection timed out.",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a working socket open while a slow server config snapshot arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ready: () => Effect.sleep("40 seconds"),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "synchronizing",
      );
      yield* TestClock.adjust("39 seconds");
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connecting");

      yield* TestClock.adjust("1 second");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retains a config transfer that keeps delivering beyond the setup budget", () =>
    Effect.gen(function* () {
      const receivedAt = yield* Ref.make(0n);
      const ready = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        ready: () => Deferred.await(ready),
        receivedAt: Ref.get(receivedAt),
        rpcReceivedAt: Ref.get(receivedAt),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.stage === "synchronizing");
      for (let part = 0; part < 3; part++) {
        yield* TestClock.adjust("40 seconds");
        yield* Ref.set(receivedAt, yield* Clock.monotonicTimeNanos);
      }
      yield* Deferred.succeed(ready, undefined);
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect.each(["pongs", "responses"] as const)(
    "bounds establishment with continuous %s during sync",
    (traffic) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          ready: () => Effect.never,
          receivedAt: Clock.monotonicTimeNanos,
          rpcReceivedAt: traffic === "responses" ? Clock.monotonicTimeNanos : Effect.succeed(0n),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* awaitState(supervisor.state, (state) => state.stage === "synchronizing");
        yield* TestClock.adjust(traffic === "pongs" ? "90 seconds" : "5 minutes");
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "backoff",
          lastFailure: { reason: "timeout" },
        });
        expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      }),
  );

  it.effect.each(["status", "wakeup"] as const)(
    "forgets old network latency on a network %s change",
    (signal) =>
      Effect.gen(function* () {
        const timing = makeNetworkTiming();
        const probed = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          probe: () => Deferred.succeed(probed, undefined).pipe(Effect.asVoid),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies), Effect.provideService(NetworkTiming, timing));
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        timing.observe(TARGET.httpBaseUrl, 100_000);
        expect(timing.budget(TARGET.httpBaseUrl, 3_000)).toBe(120_000);
        if (signal === "status") {
          yield* harness.setNetworkStatus("unknown");
          yield* harness.setNetworkStatus("online");
        } else {
          yield* harness.wake("network-changed");
        }
        yield* Deferred.await(probed);
        expect(timing.budget(TARGET.httpBaseUrl, 3_000)).toBe(3_000);
      }),
  );

  it.effect("retains credential setup while HTTP bytes keep arriving", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () =>
          Effect.gen(function* () {
            const progress = yield* RequestProgress;
            for (let part = 0; part < 6; part++) {
              yield* Effect.sleep("10 seconds");
              progress?.received();
            }
            return PREPARED_CONNECTION;
          }),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(harness.dependencies),
        Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
      );
      yield* awaitState(supervisor.state, (state) => state.stage === "preparing");
      yield* TestClock.adjust("60 seconds");
      yield* eventuallyState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("retries when a session never becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        ready: () => Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "synchronizing",
      );
      // 15 seconds of setup plus 75 for the snapshot; setup finished instantly.
      yield* TestClock.adjust("89 seconds");
      expect((yield* SubscriptionRef.get(supervisor.state)).stage).toBe("synchronizing");

      yield* TestClock.adjust("1 second");
      const retrying = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");

      expect(retrying).toMatchObject({
        phase: "backoff",
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("interrupts and releases a connection attempt when setup times out", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "preparing",
      );
      yield* TestClock.adjust("15 seconds");
      const retrying = yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(retrying).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "shows a network hint for a stalled relay connection and clears it after recovery",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            attempt === 1 ? Effect.never : Effect.succeed(PREPARED_CONNECTION),
        });
        const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(supervisor.state, (state) => state.phase === "connecting");
        yield* TestClock.adjust("15 seconds");
        const failed = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        expect(failed.lastFailure?.message).toBe(
          `Test environment did not respond during connection setup. ${NETWORK_BLOCKING_HINT}`,
        );

        yield* TestClock.adjust("3 seconds");
        const recovered = yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected",
        );
        expect(recovered.lastFailure).toBeNull();
        expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("converts unexpected driver defects into retryable failures", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.die(new Error("Native transport defect."))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(failed).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "transport",
          message: "Test environment connection failed unexpectedly.",
        },
      });

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    {
      label: "the attempt's network-status read dies",
      statusDefect: true,
      log: "Connection attempt failed with an unexpected defect.",
    },
    {
      label: "an attempt interrupts itself",
      statusDefect: false,
      log: "Connection attempt failed with an unexpected interruption.",
    },
  ])("retries after $label", ({ statusDefect, log }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 && !statusDefect ? Effect.interrupt : Effect.succeed(PREPARED_CONNECTION),
      });
      const statusReads = yield* Ref.make(0);
      const logs: unknown[] = [];
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provideService(
          Connectivity.Connectivity,
          Connectivity.Connectivity.of({
            // The supervisor reads once at startup; the second read belongs to the first attempt.
            status: Ref.updateAndGet(statusReads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                statusDefect && count === 2
                  ? Effect.die(new Error("Platform connectivity defect."))
                  : Effect.succeed("online" as const),
              ),
            ),
            changes: Stream.never,
          }),
        ),
        Effect.provide(Layer.merge(harness.dependencies, recordLogs(logs))),
      );

      const failed = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(failed).toMatchObject({
        generation: 0,
        lastFailure: { _tag: "ConnectionTransientError", reason: "transport" },
      });
      expect(logs).toEqual([[log]]);

      const prepared = yield* Ref.get(harness.prepareCount);
      yield* TestClock.adjust("1999 millis");
      expect(yield* Ref.get(harness.prepareCount)).toBe(prepared);
      yield* TestClock.adjust("1 second");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(prepared + 1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([
    {
      label: "is interrupted",
      closed: Exit.interrupt(),
      releaseDefect: false,
      log: "Connection attempt failed with an unexpected interruption.",
    },
    {
      label: "fails while interrupted",
      closed: Exit.failCause(
        Cause.combine(Cause.fail(transient("Session closed.")), Cause.interrupt()),
      ),
      releaseDefect: false,
      log: null,
    },
    {
      label: "closes while its release defects",
      closed: Exit.fail(transient("Session closed.")),
      releaseDefect: true,
      log: "Connection release failed with an unexpected defect.",
    },
  ])("reconnects after a stable session $label", ({ closed, releaseDefect, log }) =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        release: (session) =>
          releaseDefect && session === 1
            ? Effect.die(new Error("Session release defect."))
            : Effect.void,
      });
      const logs: unknown[] = [];
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(Layer.merge(harness.dependencies, recordLogs(logs))));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* TestClock.adjust("1 minute");
      yield* harness.closeLatestSession(closed);
      const lost = yield* awaitState(supervisor.state, (state) => state.phase !== "connected");
      expect(logs).toEqual(log === null ? [] : [[log]]);
      expect(lost).toMatchObject({ phase: "backoff", generation: 1 });

      yield* TestClock.adjust("2 seconds");
      const replaced = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(replaced.generation).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("picks a restarted server up within a quarter of its downtime", () =>
    Effect.gen(function* () {
      let serverUp = true;
      const harness = yield* makeHarness({
        prepare: () =>
          serverUp
            ? Effect.succeed(PREPARED_CONNECTION)
            : Effect.fail(transient("The server is restarting.")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* TestClock.adjust("1 minute");

      serverUp = false;
      yield* harness.closeLatestSession();
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      for (let step = 0; step < 100; step++) yield* TestClock.adjust("100 millis");
      serverUp = true;
      // The plain ladder (2 s, 4 s, 8 s) would next try at 14 s.
      for (let step = 0; step < 25; step++) yield* TestClock.adjust("100 millis");
      const state = yield* SubscriptionRef.get(supervisor.state);
      expect({ phase: state.phase, generation: state.generation }).toEqual({
        phase: "connected",
        generation: 2,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps the plain ladder after losing a session that just connected", () =>
    Effect.gen(function* () {
      let serverUp = true;
      const harness = yield* makeHarness({
        prepare: () =>
          serverUp ? Effect.succeed(PREPARED_CONNECTION) : Effect.fail(transient("Down.")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      serverUp = false;
      yield* harness.closeLatestSession();
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust("2 seconds");
      const second = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );
      // A session that dropped right after connecting may be flapping: 4 s, not 1 s.
      expect(second.retryAt! - (yield* Clock.currentTimeMillis)).toBe(4_000);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the loop after a defect outside an attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const logs: unknown[] = [];
      let randomReads = 0;
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provideService(Random.Random, {
          // The first backoff delay dies here, outside any attempt.
          nextDoubleUnsafe: () => {
            randomReads += 1;
            if (randomReads === 1) throw new Error("Random defect.");
            return 1 - Number.EPSILON;
          },
          nextIntUnsafe: () => 0,
        }),
        Effect.provide(Layer.merge(harness.dependencies, recordLogs(logs))),
      );

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.closeLatestSession();
      const restarted = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(logs).toEqual([["Connection loop failed with an unexpected defect."]]);
      expect(restarted).toMatchObject({
        attempt: 1,
        generation: 1,
        lastFailure: { _tag: "ConnectionTransientError", reason: "transport" },
        retryAt: (yield* Clock.currentTimeMillis) + 300_000,
      });

      yield* TestClock.adjust("299999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 millis");
      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected",
      );
      expect(reconnected.generation).toBe(2);

      // A signal cuts the restarted loop's wait short.
      yield* harness.closeLatestSession();
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* supervisor.retryNow;
      const retried = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(retried.generation).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each(["connecting", "connected"] as const)(
    "stops attempting when its scope closes while %s",
    (phase) =>
      Effect.gen(function* () {
        const preparing = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          prepare: () =>
            Deferred.succeed(preparing, undefined).pipe(
              Effect.andThen(
                phase === "connected" ? Effect.succeed(PREPARED_CONNECTION) : Effect.never,
              ),
            ),
        });
        const logs: unknown[] = [];
        const scope = yield* Scope.make();
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(
          Effect.provide(Layer.merge(harness.dependencies, recordLogs(logs))),
          Scope.provide(scope),
        );

        yield* Deferred.await(preparing);
        yield* awaitState(supervisor.state, (state) => state.phase === phase);
        yield* Scope.close(scope, Exit.void);
        yield* TestClock.adjust("10 minutes");
        expect(logs).toEqual([]);
        expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("explicit retry interrupts the current backoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect("explicit retry starts a fresh backoff sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.fail(transient()),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );

      yield* supervisor.retryNow;
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(3);

      yield* TestClock.adjust("1999 millis");
      expect(yield* Ref.get(harness.prepareCount)).toBe(3);
      yield* TestClock.adjust("1 milli");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );
      expect(yield* Ref.get(harness.prepareCount)).toBe(4);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps blocked failures idle until an external signal requests another attempt", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* TestClock.adjust("1 hour");
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* supervisor.retryNow;
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("resets retries when activation wakes a blocked connection", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Effect.fail(transient())
            : attempt === 2
              ? Effect.fail(blocked())
              : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "blocked" && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.attempt === 1,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a session that still answers when the network reports offline", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: () => Ref.update(probeCount, (count) => count + 1),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      // A loopback server, or a flap shorter than the probe, keeps working.
      yield* harness.setNetworkStatus("offline");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(probeCount)) > 0) break;
        yield* Effect.yieldNow;
      }
      yield* harness.setNetworkStatus("online");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(probeCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }),
  );

  it.effect(
    "replaces a session that misses a long resume probe while the network reports offline",
    () =>
      Effect.gen(function* () {
        const probeCount = yield* Ref.make(0);
        const harness = yield* makeHarness({
          // The first probe answers; the resume probe finds a dead socket.
          probe: (attempt) =>
            attempt === 1
              ? Ref.updateAndGet(probeCount, (count) => count + 1).pipe(
                  Effect.flatMap((count) => (count === 1 ? Effect.void : Effect.never)),
                )
              : Effect.void,
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 1,
        );
        // A wrong offline report: the probe answers, so the session stays.
        yield* harness.setNetworkStatus("offline");
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((yield* Ref.get(probeCount)) > 0) break;
          yield* Effect.yieldNow;
        }
        expect(yield* Ref.get(harness.sessionCount)).toBe(1);

        // The replacement connects although the network still reports offline.
        yield* harness.wake("application-active-reconnect");
        yield* TestClock.adjust("1 second");
        const replaced = yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );

        expect(replaced.attempt).toBe(1);
        expect(yield* Ref.get(probeCount)).toBe(2);
        expect(yield* Ref.get(harness.sessionCount)).toBe(2);
        expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "releases a session that stops answering while offline and reconnects when online",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        });
        const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 1,
        );
        yield* harness.setNetworkStatus("offline");
        yield* TestClock.adjust("3 seconds");
        yield* awaitState(supervisor.state, (state) => state.phase === "offline");

        expect(yield* Ref.get(harness.releaseCount)).toBe(1);
        expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);

        yield* harness.setNetworkStatus("online");
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );
        expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects a silent primary session even while the device reports offline", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.setNetworkStatus("offline");
      yield* TestClock.adjust("3 seconds");
      const replaced = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(replaced.network).toBe("unknown");
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("probes instead of replacing a healthy session on an explicit retry", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: () => Ref.update(probeCount, (count) => count + 1),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* supervisor.retryNow;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(probeCount)) > 0) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(probeCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect("keeps the backoff ladder after an explicit retry finds a healthy session", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: () => Ref.update(probeCount, (count) => count + 1),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("2 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      yield* supervisor.retryNow;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(probeCount)) > 0) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(probeCount)).toBe(1);

      // The flapping session keeps climbing the ladder: the answered retry does
      // not reset it after this unrelated close.
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );
      yield* TestClock.adjust("4 seconds");
      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3,
      );
      expect(reconnected.attempt).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("retries a blocked connection when platform credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1 ? Effect.fail(blocked()) : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "blocked");
      yield* harness.wake("credentials-changed");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
    }),
  );

  it.effect("does not let platform wakeups reset an in-flight attempt", () =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: () =>
          Deferred.succeed(firstAttemptStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      yield* Effect.all(
        [
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.prepareCount)).toBe(1);

      yield* TestClock.adjust("15 seconds");
      const retrying = yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(retrying).toMatchObject({
        lastFailure: {
          _tag: "ConnectionTransientError",
          reason: "timeout",
          message: "Test environment did not respond during connection setup.",
        },
      });
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(0);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("treats an involuntary session close as transient and reconnects", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(Option.isSome(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not report a session lost while suspended as a failed connection", () =>
    Effect.gen(function* () {
      const allowReconnect = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Deferred.await(allowReconnect).pipe(Effect.as(PREPARED_CONNECTION))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      // The OS killed the socket while the app was suspended; its close arrives
      // before the app reports it is active again.
      yield* harness.closeLatestSession();
      const waiting = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(presentConnectionState(waiting)).toEqual({
        phase: "reconnecting",
        error: null,
        traceId: null,
      });

      yield* harness.wake("application-active");
      const replacing = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.stage === "preparing",
      );
      expect(presentConnectionState(replacing).error).toBeNull();

      yield* Deferred.succeed(allowReconnect, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not show an earlier setup failure while replacing a short session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: () => Effect.fail(transient("The suspended socket closed.")),
        prepare: (attempt) =>
          attempt === 1
            ? Effect.fail(transient("Relay connection timed out."))
            : attempt === 3
              ? Effect.never
              : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      // A long resume replaces the session before it counts as stable.
      yield* harness.wake("application-active-reconnect");
      const replacing = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.generation === 2,
      );

      expect(presentConnectionState(replacing).error).toBeNull();
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps escalating backoff when a newly opened session flaps", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      yield* harness.closeLatestSession();
      const secondFailure = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );

      expect(secondFailure.retryAt).not.toBeNull();

      yield* TestClock.adjust("3 seconds");
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);

      yield* TestClock.adjust("1 second");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3,
      );
      expect(yield* Ref.get(harness.sessionCount)).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the retry ladder when mobile returns to the foreground", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3 && state.attempt === 1,
      );
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the retry ladder when a long resume replaces a connected session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) =>
          attempt === 2 ? Effect.fail(transient("The live session is stale.")) : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("2 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 3 && state.attempt === 1,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("restarts the retry ladder when a long resume interrupts connection setup", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) => (attempt === 2 ? Effect.never : Effect.succeed(PREPARED_CONNECTION)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.closeLatestSession();
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("3 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting" && state.attempt === 2,
      );

      yield* harness.wake("application-active-reconnect");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("probes the active session without reconnecting on application activation", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const probeCalled = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () =>
          Ref.update(probeCount, (count) => count + 1).pipe(
            Effect.andThen(Deferred.succeed(probeCalled, undefined)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeCalled);

      expect(yield* Ref.get(probeCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("keeps a mobile session that answers after a long background resume", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: () => Ref.update(probeCount, (count) => count + 1),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      // iOS usually keeps a suspended socket; reconnecting would re-download
      // every snapshot for nothing.
      yield* harness.wake("application-active-reconnect");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(probeCount)) > 0) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(probeCount)).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
    }),
  );

  it.effect.each([
    {
      changedTiming: true,
      scenario: "reseeds resume timing from a replacement session on a slower route",
    },
    {
      changedTiming: false,
      scenario:
        "widens resume timing after a failed probe even when replacement handshakes stay fast",
    },
  ])("$scenario", ({ changedTiming }) =>
    Effect.gen(function* () {
      const secondProbe = yield* Deferred.make<void>();
      const answered = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        openDurationMs: (attempt) => (changedTiming && attempt > 1 ? 600 : 10),
        probe: (attempt) =>
          attempt === 1
            ? Effect.never
            : Deferred.succeed(secondProbe, undefined).pipe(
                Effect.andThen(Effect.sleep("2 seconds")),
                Effect.andThen(Deferred.succeed(answered, undefined)),
                Effect.asVoid,
              ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(harness.dependencies),
        Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      if (changedTiming) {
        yield* harness.closeLatestSession();
        yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
        yield* supervisor.retryNow;
      } else {
        yield* harness.wake("application-active-probe");
        yield* TestClock.adjust("1 second");
      }
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      yield* harness.wake("application-active-probe");
      yield* Deferred.await(secondProbe);
      yield* TestClock.adjust("2 seconds");
      expect(yield* Deferred.isDone(answered)).toBe(true);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "keeps fast handshake-seeded resume probes across repeated long-background socket kills",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          openDurationMs: () => 20,
          probe: () => Effect.never,
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(
          Effect.provide(harness.dependencies),
          Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
        );
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");

        // First long-background resume: OS killed the socket, probe times out at ~1s.
        yield* harness.wake("application-active-reconnect");
        yield* TestClock.adjust("1 second");
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );

        // Second long-background resume: must still time out at ~1s (seeded from the
        // replacement socket's 20ms handshake) instead of widening to 8s quickProbeTimeout.
        yield* harness.wake("application-active-reconnect");
        yield* TestClock.adjust("1 second");
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 3,
        );
        expect(yield* Ref.get(harness.sessionCount)).toBe(3);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("sizes a long-resume probe to the socket's heartbeat, not its handshake", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        // A 150 ms link: the wss handshake took three round trips, and the
        // shared estimate also counts whole HTTP requests.
        openDurationMs: 450,
        pingRoundTripMs: 150,
        responseTimeoutMs: (minimumMs) => Math.max(minimumMs, 4_000),
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(harness.dependencies),
        Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      // The OS killed the socket in the background: 6 round trips + 750 ms, not 4 s.
      yield* harness.wake("application-active-reconnect");
      yield* TestClock.adjust("1649 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 milli");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a socket a network change killed within 3 s, not the 8 s budget", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        openDurationMs: 450,
        pingRoundTripMs: 150,
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(harness.dependencies),
        Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      // Wi-Fi to cellular: twice the old 150 ms round trip is under the 3 s floor.
      yield* harness.wake("network-changed");
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 milli");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it("sizes network-change probes to the old round trip within their bounds", () => {
    expect(EnvironmentSupervisor.networkChangeProbeBudgetMs(undefined, 8_000)).toBe(8_000);
    expect(EnvironmentSupervisor.networkChangeProbeBudgetMs(50, 8_000)).toBe(3_000);
    expect(EnvironmentSupervisor.networkChangeProbeBudgetMs(400, 8_000)).toBe(5_550);
    expect(EnvironmentSupervisor.networkChangeProbeBudgetMs(2_000, 8_000)).toBe(8_000);
    // The desktop's 3 s budget is unchanged.
    expect(EnvironmentSupervisor.networkChangeProbeBudgetMs(50, 3_000)).toBe(3_000);
  });

  it.effect("authorizes the live route ahead only while probing after a long time away", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ pingRoundTripMs: 50 });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(harness.dependencies),
        Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("100 millis");
      expect(yield* Ref.get(harness.preparedAhead)).toEqual([]);
      yield* harness.wake("application-active-reconnect");
      yield* TestClock.adjust("100 millis");
      expect(yield* Ref.get(harness.preparedAhead)).toEqual([
        connectionRouteId(TARGET_ENTRY.target),
      ]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps a receiving session when a resume probe waits behind a large transfer", () =>
    Effect.gen(function* () {
      const received = yield* Ref.make(0n);
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        openDurationMs: 10,
        receivedAt: Ref.get(received),
        probe: () => Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(harness.dependencies),
        Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-reconnect");
      yield* Deferred.await(probeStarted);
      yield* TestClock.adjust("500 millis");
      yield* Ref.set(received, yield* Clock.monotonicTimeNanos);
      yield* TestClock.adjust("1 second");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a mobile session that misses a resume probe sized to its round trip", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(harness.dependencies),
        Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
      );

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      // The session connected at once, so the probe gets the 1 second minimum,
      // not the phone's 8 second quick-probe budget.
      yield* harness.wake("application-active-reconnect");
      yield* TestClock.adjust("999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 milli");
      const replaced = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(replaced.attempt).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a mobile session when a long resume arrives during an unanswered probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.wake("application-active-probe");
      yield* Effect.yieldNow;
      yield* harness.wake("application-active-reconnect");
      yield* TestClock.adjust("1 second");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("excludes slow config loading from the first resume's dead-socket deadline", () =>
    Effect.gen(function* () {
      const configLoading = yield* Deferred.make<void>();
      const resumeProbe = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        openDurationMs: 25,
        ready: (attempt) =>
          attempt === 1
            ? Deferred.succeed(configLoading, undefined).pipe(
                Effect.andThen(Effect.sleep("4 seconds")),
              )
            : Effect.void,
        probe: (attempt) =>
          attempt === 1
            ? Deferred.succeed(resumeProbe, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provide(harness.dependencies),
        Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
      );
      yield* Deferred.await(configLoading);
      yield* TestClock.adjust("4 seconds");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-reconnect");
      yield* Deferred.await(resumeProbe);
      yield* TestClock.adjust("1 second");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects immediately when the session closes during a resume probe", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: (attempt) =>
          attempt === 1
            ? Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* Deferred.await(probeStarted);
      // The OS reports the suspended socket's close before the probe answers.
      yield* harness.closeLatestSession();

      // No TestClock advance: the unanswered probe skips the first backoff rung.
      const reconnected = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(reconnected.attempt).toBe(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("reconnects immediately when the foreground liveness probe fails", () =>
    Effect.gen(function* () {
      const allowReconnect = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2
            ? Deferred.await(allowReconnect).pipe(Effect.as(PREPARED_CONNECTION))
            : Effect.succeed(PREPARED_CONNECTION),
        probe: (attempt) =>
          attempt === 1 ? Effect.fail(transient("The live session is stale.")) : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      const reconnecting = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connecting",
      );
      expect(reconnecting.attempt).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);

      // No TestClock advance: a failed wake probe skips the first backoff rung.
      yield* Deferred.succeed(allowReconnect, undefined);
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps normal backoff when a reconnect after a failed wake probe also fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 2 ? Effect.fail(transient()) : Effect.succeed(PREPARED_CONNECTION),
        probe: (attempt) =>
          attempt === 1 ? Effect.fail(transient("The live session is stale.")) : Effect.void,
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      // The immediate follow-up attempt fails: only the first attempt after
      // the wake probe skips the ladder, so this failure backs off normally.
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 1,
      );
      yield* TestClock.adjust("1999 millis");
      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      yield* TestClock.adjust("1 milli");
      yield* eventuallyState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.prepareCount)).toBe(3);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("uses both tolerance windows for stalled desktop foreground probes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("14999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 milli");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("15 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "gives a phone's network-change probe its longer limit and retries within its cap",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          prepare: (attempt) =>
            attempt >= 2 && attempt <= 9
              ? Effect.fail(transient())
              : Effect.succeed(PREPARED_CONNECTION),
          probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(
          Effect.provide(harness.dependencies),
          Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
        );

        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        // A slow link answers late; 3 seconds would drop the socket.
        yield* harness.wake("network-changed");
        yield* TestClock.adjust("7999 millis");
        expect(yield* Ref.get(harness.sessionCount)).toBe(1);
        yield* TestClock.adjust("1 milli");

        // The reconnect keeps failing, and the waits stop growing at 30 seconds
        // instead of 5 minutes.
        const delays = [2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000];
        for (const [index, delay] of delays.entries()) {
          yield* eventuallyState(
            supervisor.state,
            (state) => state.phase === "backoff" && state.attempt === index + 1,
          );
          yield* TestClock.adjust(delay - 1);
          expect(yield* Ref.get(harness.prepareCount)).toBe(index + 2);
          yield* TestClock.adjust(1);
        }
        yield* eventuallyState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );
        expect(yield* Ref.get(harness.prepareCount)).toBe(10);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("an explicit retry shortens a stalled desktop foreground probe", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* TestClock.adjust("5 seconds");
      yield* supervisor.retryNow;
      // The retry's 3 second limit applies, not the 10 seconds left of the 15.
      yield* TestClock.adjust("2999 millis");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* TestClock.adjust("1 milli");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("quickly times out a stalled mobile foreground liveness probe", () =>
    Effect.gen(function* () {
      const marks: Array<{ name: string; detail: LoadMarkDetail | undefined }> = [];
      yield* Effect.acquireRelease(
        Effect.sync(() => setLoadMarkSink((name, _at, detail) => marks.push({ name, detail }))),
        () => Effect.sync(() => setLoadMarkSink(null)),
      );
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active-probe");
      yield* TestClock.adjust("3 seconds");
      // The timed-out wake probe reconnects immediately without a backoff
      // sleep: no further clock advance is needed.
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2 && state.attempt === 1,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(marks).toContainEqual({
        name: "connect.probe.started",
        detail: {
          environment: TARGET.environmentId.slice(0, 8),
          budgetMs: 1_000,
          reason: "application-active-probe",
        },
      });
      expect(marks).toContainEqual({
        name: "connect.probe.finished",
        detail: {
          environment: TARGET.environmentId.slice(0, 8),
          ms: 1_000,
          outcome: "interrupted",
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("honors an explicit disconnect while a foreground probe is stalled", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () => Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("application-active");
      yield* Deferred.await(probeStarted);
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect(
    "keeps a live session when the automatic follow-up to a slow foreground probe answers",
    () =>
      Effect.gen(function* () {
        const probeCount = yield* Ref.make(0);
        const probeStarted = yield* Queue.unbounded<number>();
        const harness = yield* makeHarness({
          probe: () =>
            Ref.updateAndGet(probeCount, (count) => count + 1).pipe(
              Effect.tap((call) => Queue.offer(probeStarted, call)),
              Effect.flatMap((call) => (call === 1 ? Effect.never : Effect.void)),
            ),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 1,
        );
        yield* harness.wake("application-active");
        expect(yield* Queue.take(probeStarted)).toBe(1);
        // A busy server misses the foreground probe deadline once while the
        // socket stays open; the supervisor asks again on its own.
        yield* TestClock.adjust("15 seconds");
        expect(yield* Ref.get(probeCount)).toBe(2);
        yield* TestClock.adjust("30 seconds");

        expect(yield* Ref.get(harness.releaseCount)).toBe(0);
        expect(yield* Ref.get(harness.sessionCount)).toBe(1);
        expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
          phase: "connected",
          generation: 1,
        });
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a session when the automatic follow-up probe also goes unanswered", () =>
    Effect.gen(function* () {
      const probeCount = yield* Ref.make(0);
      const harness = yield* makeHarness({
        probe: () =>
          Ref.update(probeCount, (count) => count + 1).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      // One foreground event and no other signal: the follow-up's miss alone
      // replaces the session.
      yield* harness.wake("application-active");
      yield* TestClock.adjust("15 seconds");
      yield* TestClock.adjust("15 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(probeCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a session when a retry lands late in a slow foreground probe", () =>
    Effect.gen(function* () {
      const probeStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        probe: () => Deferred.succeed(probeStarted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* harness.wake("application-active");
      yield* Deferred.await(probeStarted);
      yield* TestClock.adjust("13 seconds");
      // The retry's own deadline falls after the foreground one, but it still
      // asks for a definite answer, so the first miss is not forgiven.
      yield* supervisor.retryNow;
      yield* TestClock.adjust("5 seconds");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("does not churn a healthy session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }),
  );

  it.effect("releases and reconnects a relay session when credentials change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: () => Effect.succeed(preparedFor(RELAY_TARGET)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );

      expect(yield* Ref.get(harness.sessionCount)).toBe(2);
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("keeps a healthy relay session when its HTTP access token expires", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          Effect.succeed({
            ...PREPARED_CONNECTION,
            target: RELAY_TARGET,
            httpAuthorization: {
              _tag: "Dpop",
              accessToken: `access-token-${attempt}`,
              expiresAtEpochMs: 3_600_000 * attempt,
            },
          }),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));

      yield* TestClock.adjust("2 hours");

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("refreshes HTTP authorization without replacing the active relay session", () =>
    Effect.gen(function* () {
      const endpoint = {
        httpBaseUrl: TARGET.httpBaseUrl,
        wsBaseUrl: TARGET.wsBaseUrl,
        providerKind: "cloudflare_tunnel" as const,
      };
      const token = yield* Ref.make(
        Option.some(
          new TokenStore.RemoteDpopAccessToken({
            environmentId: TARGET.environmentId,
            accountId: "test-account",
            label: TARGET.label,
            endpoint,
            accessToken: "access-token-1",
            expiresAtEpochMs: 3_600_000,
            dpopThumbprint: "test-thumbprint",
          }),
        ),
      );
      const bootstrapFails = yield* Ref.make(false);
      const bootstrapCalls = yield* Ref.make(0);
      const httpPaths: Array<string> = [];
      const sessionAuthorizations: Array<string | null> = [];
      const fetchFn = ((input, init) => {
        const request = new Request(input, init);
        const pathname = new URL(request.url).pathname;
        httpPaths.push(pathname);
        switch (pathname) {
          case "/.well-known/t3/environment":
            return Promise.resolve(
              Response.json({
                environmentId: TARGET.environmentId,
                label: TARGET.label,
                platform: { os: "linux", arch: "x64" },
                serverVersion: "0.0.0-test",
                capabilities: { repositoryIdentity: true },
              }),
            );
          case "/oauth/token":
            return Promise.resolve(
              Response.json({
                access_token: "access-token-2",
                issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                token_type: "DPoP",
                expires_in: 3_600,
                scope: AuthStandardClientScopes.join(" "),
              }),
            );
          case "/api/auth/websocket-ticket/rpc":
            return Promise.resolve(
              Response.json({
                ticket: "ws-ticket",
                expiresAt: "2026-09-04T01:00:00.000Z",
              }),
            );
          case "/api/auth/session": {
            const authorization = request.headers.get("authorization");
            sessionAuthorizations.push(authorization);
            return Promise.resolve(
              Response.json({
                authenticated: authorization === "DPoP access-token-2",
                auth: {
                  policy: "loopback-browser",
                  bootstrapMethods: ["one-time-token"],
                  sessionMethods: ["dpop-access-token"],
                  sessionCookieName: "t3_session_test",
                },
                scopes: AuthStandardClientScopes,
              }),
            );
          }
          default:
            return Promise.reject(new Error(`Unexpected HTTP request to ${request.url}`));
        }
      }) satisfies typeof fetch;
      const signer = ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: () => Effect.succeed("test-proof"),
      });
      const unused = () => Effect.die("Unexpected relay operation.");
      const relay = ManagedRelay.ManagedRelayClient.of({
        relayUrl: "https://relay.example.test",
        listEnvironments: unused,
        listDevices: unused,
        createEnvironmentLinkChallenge: unused,
        linkEnvironment: unused,
        unlinkEnvironment: unused,
        getEnvironmentStatus: unused,
        connectEnvironment: Effect.fn("TestConnectionHttp.connectEnvironment")(function* () {
          yield* Ref.update(bootstrapCalls, (count) => count + 1);
          if (yield* Ref.get(bootstrapFails)) {
            return yield* new ManagedRelay.ManagedRelayRequestTimeoutError({
              activity: "Relay environment connection",
              timeoutMs: 6_000,
              traceId: null,
            });
          }
          return {
            environmentId: TARGET.environmentId,
            endpoint,
            credential: "relay-bootstrap",
            expiresAt: "2026-09-04T01:00:00.000Z",
          };
        }),
        registerDevice: unused,
        unregisterDevice: unused,
        registerLiveActivity: unused,
        getAgentActivitySnapshot: unused,
        resetTokenCache: Effect.void,
      });
      const layerHttp = RpcHttp.layerRemoteHttpClient(fetchFn);
      const remoteAuthorization = yield* RemoteEnvironmentAuthorization.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            layerHttp,
            Layer.succeed(ManagedRelay.ManagedRelayDpopSigner, signer),
            Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
            Layer.succeed(ClientCapabilities.CloudSession, {
              identity: Effect.succeedSome({ accountId: "test-account" }),
              clerkToken: Effect.succeed("clerk-token"),
            }),
            Layer.succeed(ClientCapabilities.RelayDeviceIdentity, {
              deviceId: Effect.succeedNone,
            }),
            TokenStore.layer({
              get: () => Ref.get(token),
              put: (value) => Ref.set(token, Option.some(value)),
              remove: () => Ref.set(token, Option.none()),
            }),
            Layer.succeed(ClientCapabilities.ClientPresentation, {
              metadata: { label: "Test client", deviceType: "desktop" },
            }),
          ),
        ),
      );
      const harness = yield* makeHarness({
        prepare: () =>
          remoteAuthorization
            .authorizeDpop({ expectedEnvironmentId: TARGET.environmentId })
            .pipe(Effect.map((prepared) => ({ ...prepared, target: RELAY_TARGET }))),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const session = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session));
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      const readSession = fetchEnvironmentSessionState({
        prepared,
        signer: Option.some(signer),
        remoteAuthorization: Option.some(remoteAuthorization),
      }).pipe(Effect.provide(layerHttp));

      yield* TestClock.adjust("2 hours");
      expect((yield* readSession).authenticated).toBe(true);
      expect(sessionAuthorizations).toEqual(["DPoP access-token-2"]);
      expect(yield* Ref.get(bootstrapCalls)).toBe(1);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });

      yield* TestClock.adjust("2 hours");
      yield* Ref.set(bootstrapFails, true);
      const failure = yield* readSession.pipe(Effect.flip);
      expect(failure._tag).toBe("RemoteEnvironmentAuthFetchError");
      expect(yield* Ref.get(bootstrapCalls)).toBe(2);
      expect(sessionAuthorizations).toEqual(["DPoP access-token-2"]);
      expect(httpPaths.filter((path) => path === "/api/auth/websocket-ticket/rpc")).toHaveLength(1);
      expect(httpPaths.filter((path) => path === "/oauth/token")).toHaveLength(1);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* Ref.get(harness.releaseCount)).toBe(0);
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.session))).toBe(session);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("interrupts relay setup when credentials change", () =>
    Effect.gen(function* () {
      const firstAttemptStarted = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        prepare: (attempt) =>
          attempt === 1
            ? Deferred.succeed(firstAttemptStarted, undefined).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(PREPARED_CONNECTION),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* Deferred.await(firstAttemptStarted);
      yield* harness.wake("credentials-changed");
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");

      expect(yield* Ref.get(harness.prepareCount)).toBe(2);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
    }),
  );

  it.effect("explicit disconnect releases the session and returns to available", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* supervisor.disconnect;
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.prepared))).toBe(true);
    }),
  );

  it.effect("does not lose an explicit disconnect among concurrent wakeup signals", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* Effect.all(
        [
          supervisor.disconnect,
          harness.wake("credentials-changed"),
          harness.wake("application-active"),
          harness.wake("credentials-changed"),
        ],
        { concurrency: "unbounded" },
      );
      yield* awaitState(supervisor.state, (state) => state.phase === "available");

      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      expect(Option.isNone(yield* SubscriptionRef.get(supervisor.session))).toBe(true);
    }),
  );
});

describe("EnvironmentSupervisor routes", () => {
  it.effect(
    "shows the winning route when the preferred route finishes after its hedge starts",
    () =>
      Effect.gen(function* () {
        const firstReady = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          checkRoute: () => Effect.succeed("answered"),
          prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
          ready: (attempt) => (attempt === 1 ? Deferred.await(firstReady) : Effect.never),
        });
        const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));
        yield* awaitState(supervisor.state, (state) => state.stage === "synchronizing");
        yield* TestClock.adjust("3 seconds");
        yield* awaitState(
          supervisor.state,
          (state) => state.stage === "synchronizing" && state.activeRouteId === "relay",
        );
        yield* Deferred.succeed(firstReady, undefined);
        const connected = yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected",
        );
        expect(connected.activeRouteId).toBe(connectionRouteId(LAN_TARGET));
        expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target).toBe(
          LAN_TARGET,
        );
        expect(yield* Ref.get(harness.sessionCount)).toBe(2);
        expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      }).pipe(
        Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
        Effect.provide(TestClock.layer()),
      ),
  );

  it.effect("keeps per-route failures through retries and clears them on recovery", () =>
    Effect.gen(function* () {
      const lanError = transient("LAN timed out.");
      const relayError = blocked("Sign in to T3 Connect.");
      let recovering = false;
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) => {
          if (recovering) return Effect.succeed(preparedFor(target));
          return Effect.fail(target._tag === "BearerConnectionTarget" ? lanError : relayError);
        },
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      const failed = yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      expect(failed.lastFailure).toBe(lanError);
      expect([...failed.routeFailures]).toEqual([
        ["bearer:lan", lanError],
        ["relay", relayError],
      ]);
      yield* TestClock.adjust("2 seconds");
      const retried = yield* awaitState(
        supervisor.state,
        (state) => state.phase === "backoff" && state.attempt === 2,
      );
      expect([...retried.routeFailures]).toEqual([...failed.routeFailures]);
      recovering = true;
      yield* supervisor.retryNow;
      const connected = yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(connected.routeFailures.size).toBe(0);
      expect(connected.activeRouteId).toBe(connectionRouteId(LAN_TARGET));
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("demotes a timed-out direct route on retry and during relay promotion checks", () =>
    Effect.gen(function* () {
      const attempted: string[] = [];
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          Effect.sync(() => attempted.push(connectionRouteId(target))).pipe(
            Effect.andThen(
              target._tag === "BearerConnectionTarget"
                ? Effect.fail(
                    new ConnectionTransientError({
                      reason: "timeout",
                      detail: "No initial config",
                    }),
                  )
                : Effect.succeed(preparedFor(target)),
            ),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(attempted).toEqual(["bearer:lan", "relay"]);
      yield* TestClock.adjust("60 seconds");
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      yield* harness.closeLatestSession();
      yield* awaitState(supervisor.state, (state) => state.phase === "backoff");
      yield* supervisor.retryNow;
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(attempted).toEqual(["bearer:lan", "relay", "relay"]);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("publishes a route failure while the next route is still preparing", () =>
    Effect.gen(function* () {
      const error = transient("LAN timed out.");
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget" ? Effect.fail(error) : Effect.never,
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));
      const preparing = yield* awaitState(
        supervisor.state,
        (state) => state.activeRouteId === "relay",
      );
      expect(preparing.phase).toBe("connecting");
      expect(preparing.routeFailures.get("bearer:lan")).toBe(error);
    }),
  );

  it.effect("skips a silent LAN route and connects over T3 Connect", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("RelayConnectionTarget");
      // The silent route never reached the resolver.
      expect(yield* Ref.get(harness.prepareCount)).toBe(1);
    }),
  );

  it.effect("moves to a blocked route's fallback instead of stopping", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget"
            ? Effect.fail(blocked("The environment credential is invalid."))
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("RelayConnectionTarget");
    }),
  );

  it.effect("tries every route when none answers the reachability check", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("silent"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const prepared = Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared));
      expect(prepared.target._tag).toBe("BearerConnectionTarget");
    }),
  );

  it.effect(
    "gives the next route its own snapshot budget after a route fails while synchronizing",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          checkRoute: () => Effect.succeed("answered"),
          prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
          // The LAN session fails 50 seconds into its snapshot; T3 Connect needs 40.
          ready: (attempt) =>
            attempt === 1
              ? Effect.sleep("50 seconds").pipe(Effect.andThen(Effect.fail(transient())))
              : Effect.sleep("40 seconds"),
        });
        const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connecting" && state.stage === "synchronizing",
        );
        yield* TestClock.adjust("50 seconds");
        yield* TestClock.adjust("40 seconds");
        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
          "RelayConnectionTarget",
        );
        expect(yield* Ref.get(harness.prepareCount)).toBe(2);
        expect(yield* Ref.get(harness.releaseCount)).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still tries a silent LAN route after the T3 Connect route fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          Effect.succeed(route.target._tag === "BearerConnectionTarget" ? "silent" : "unchecked"),
        // Signed out of T3 Connect; the LAN is up but its check timed out.
        prepare: (_attempt, target) =>
          target._tag === "RelayConnectionTarget"
            ? Effect.fail(blocked("Sign in to T3 Connect."))
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
    }),
  );

  it.effect("keeps retrying when one route is blocked and another failed transiently", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) =>
          target._tag === "RelayConnectionTarget"
            ? Effect.fail(blocked("Sign in to T3 Connect."))
            : Effect.fail(transient("LAN socket refused.")),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      // A blocked state would stop retrying; the LAN may come back.
      const state = yield* awaitState(supervisor.state, (value) => value.phase === "backoff");
      expect(state.lastFailure?._tag).toBe("ConnectionTransientError");
    }),
  );

  it.effect("moves back to the LAN route when the network changes and it answers again", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(false);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );

      // Back home: the LAN answers, and a network change asks for a better route.
      yield* Ref.set(lanReachable, true);
      yield* harness.setNetworkStatus("unknown");
      yield* harness.setNetworkStatus("online");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(harness.releaseCount)).toBe(1);
    }),
  );

  it.effect("checks for a better route periodically while on a fallback", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(false);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* Ref.set(lanReachable, true);
      yield* TestClock.adjust("60 seconds");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
    }),
  );

  it.effect("does not retry a better route that answered but failed to connect", () =>
    Effect.gen(function* () {
      const lanAnswers = yield* Ref.make(false);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanAnswers).pipe(Effect.map((answers) => (answers ? "answered" : "silent")))
            : Effect.succeed("unchecked"),
        // The LAN answers its check but the socket never opens.
        prepare: (_attempt, target) =>
          target._tag === "BearerConnectionTarget"
            ? Effect.fail(transient("Socket refused."))
            : Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* Ref.set(lanAnswers, true);
      yield* TestClock.adjust("60 seconds");
      // The switch lands back on T3 Connect.
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      const preparesAfterSwitch = yield* Ref.get(harness.prepareCount);

      // The failed LAN is cooling down, so the next periodic check leaves the
      // session alone.
      yield* TestClock.adjust("60 seconds");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(harness.prepareCount)).toBe(preparesAfterSwitch);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 2,
      });
    }),
  );

  it.effect("stays on the preferred route without checking other routes", () =>
    Effect.gen(function* () {
      const checks = yield* Ref.make(0);
      const harness = yield* makeHarness({
        checkRoute: () => Ref.update(checks, (count) => count + 1).pipe(Effect.as("answered")),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      const checksAtConnect = yield* Ref.get(checks);
      yield* harness.setNetworkStatus("unknown");
      yield* harness.setNetworkStatus("online");
      yield* TestClock.adjust("5 minutes");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(checks)).toBe(checksAtConnect);
      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
    }),
  );

  it.effect("moves off a dead LAN socket when the phone switches to cellular", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(true);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        // The LAN socket never answers once the phone has left the network.
        probe: () =>
          Ref.get(lanReachable).pipe(
            Effect.flatMap((reachable) => (reachable ? Effect.void : Effect.never)),
          ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );

      yield* Ref.set(lanReachable, false);
      yield* harness.wake("network-changed");
      yield* TestClock.adjust("3 seconds");

      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "RelayConnectionTarget",
      );
      expect(yield* Ref.get(harness.preparedAhead)).toEqual(["relay"]);
    }),
  );

  it.effect(
    "does not treat initial unknown-to-online discovery as a mid-session network change",
    () =>
      Effect.gen(function* () {
        const probeCount = yield* Ref.make(0);
        const allowProbe = yield* Ref.make(false);
        const harness = yield* makeHarness({
          networkStatus: "unknown",
          openDurationMs: 25,
          probe: () =>
            Ref.update(probeCount, (count) => count + 1).pipe(
              Effect.andThen(
                Ref.get(allowProbe).pipe(Effect.flatMap((ok) => (ok ? Effect.void : Effect.never))),
              ),
            ),
        });
        const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
          initiallyDesired: true,
        }).pipe(
          Effect.provide(harness.dependencies),
          Effect.provideService(ConnectionTimings, MOBILE_CONNECTION_TIMINGS),
        );

        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 1,
        );
        // iOS Connectivity starts "unknown" and resolves "online" shortly after launch.
        yield* harness.setNetworkStatus("online");
        yield* Effect.yieldNow;
        expect(yield* Ref.get(probeCount)).toBe(0);

        // Because handshakeRoundTripMs (25ms) was preserved, a subsequent long resume
        // on a dead socket fails over in 1,000ms instead of regressing to 8,000ms.
        yield* harness.wake("application-active-reconnect");
        yield* TestClock.adjust("1 second");
        yield* awaitState(
          supervisor.state,
          (state) => state.phase === "connected" && state.generation === 2,
        );
        expect(yield* Ref.get(probeCount)).toBe(1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect(
    "does not abort an in-flight LAN attempt when T3 Connect credentials hydrate on cold start",
    () =>
      Effect.gen(function* () {
        const lanPreparing = yield* Deferred.make<void>();
        const finishLan = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          checkRoute: (route) =>
            Effect.succeed(
              route.target._tag === "BearerConnectionTarget" ? "answered" : "unchecked",
            ),
          prepare: (_attempt, target) =>
            target._tag === "BearerConnectionTarget"
              ? Deferred.succeed(lanPreparing, undefined).pipe(
                  Effect.andThen(Deferred.await(finishLan)),
                  Effect.as(preparedFor(target)),
                )
              : Effect.succeed(preparedFor(target)),
        });
        const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
          initiallyDesired: true,
        }).pipe(Effect.provide(harness.dependencies));

        yield* Deferred.await(lanPreparing);
        // Clerk finishing hydration emits credentials-changed while LAN is connecting.
        yield* harness.wake("credentials-changed");
        yield* Effect.yieldNow;
        yield* Deferred.succeed(finishLan, undefined);

        yield* awaitState(supervisor.state, (state) => state.phase === "connected");
        expect(yield* Ref.get(harness.prepareCount)).toBe(1);
        expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
          "BearerConnectionTarget",
        );
      }),
  );

  it.effect("keeps a LAN session when the T3 Connect account changes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        checkRoute: () => Effect.succeed("answered"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(Effect.provide(harness.dependencies));

      yield* awaitState(supervisor.state, (state) => state.phase === "connected");
      yield* harness.wake("credentials-changed");
      yield* Effect.yieldNow;

      expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });
    }),
  );

  it.effect(
    "refreshes learned addresses from snapshots without replacing a working relay session",
    () =>
      Effect.gen(function* () {
        const configAt = (httpBaseUrl: string) => {
          const config: Pick<ServerConfig, "directEndpoints"> = {
            directEndpoints: [{ kind: "lan", httpBaseUrl }],
          };
          return config as ServerConfig;
        };
        const configs = yield* SubscriptionRef.make(configAt("http://192.168.1.10:3773"));
        const learned = yield* SubscriptionRef.make<ReadonlyArray<string>>([]);
        const harness = yield* makeHarness({
          configSnapshots: SubscriptionRef.changes(configs),
          initialConfig: () => SubscriptionRef.get(configs),
          prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        });
        const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
          initiallyDesired: true,
          learnRoutes: ({ reported }) =>
            SubscriptionRef.update(learned, (all) => [
              ...all,
              ...reported.map((endpoint) => endpoint.httpBaseUrl),
            ]).pipe(Effect.as(Option.none())),
        }).pipe(Effect.provide(harness.dependencies));
        yield* SubscriptionRef.changes(learned).pipe(
          Stream.filter((all) => all.length === 1),
          Stream.runHead,
        );
        yield* SubscriptionRef.set(configs, configAt("http://192.168.1.11:3773"));
        const addresses = yield* SubscriptionRef.changes(learned).pipe(
          Stream.filter((all) => all.length === 2),
          Stream.runHead,
        );
        expect(Option.getOrThrow(addresses)).toEqual([
          "http://192.168.1.10:3773",
          "http://192.168.1.11:3773",
        ]);
        expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
        expect(yield* Ref.get(harness.sessionCount)).toBe(1);
      }),
  );

  it.effect("learns the LAN address over T3 Connect and moves to it", () =>
    Effect.gen(function* () {
      const relayEntry: ConnectionCatalogEntry = {
        target: RELAY_TARGET,
        profile: Option.none(),
        enabled: true,
      };
      const lanAddress = yield* Ref.make("http://192.168.1.10:3773/");
      const learned = yield* Ref.make<ReadonlyArray<string>>([]);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Effect.succeed("answered")
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
        // Only the reported endpoints matter to the supervisor.
        initialConfig: () =>
          Ref.get(lanAddress).pipe(
            Effect.map((httpBaseUrl): Pick<ServerConfig, "directEndpoints"> => ({
              directEndpoints: [{ kind: "lan", httpBaseUrl }],
            })),
            Effect.map((config) => config as ServerConfig),
          ),
      });
      const current = yield* Ref.make(relayEntry);
      const supervisor = yield* EnvironmentSupervisor.make(relayEntry, {
        initiallyDesired: true,
        learnRoutes: ({ activeRoute, reported }) =>
          Effect.gen(function* () {
            const entry = yield* Ref.get(current);
            const routes = mergeLearnedRoutes({
              entry,
              activeRoute,
              reported,
              allowInsecure: true,
            });
            if (routes === null) return Option.none();
            const next = entryWithRoutes(entry, routes);
            yield* Ref.set(current, next);
            yield* Ref.update(learned, (all) => [
              ...all,
              ...routes.filter(isLearned).map((route) => connectionRouteId(route.target)),
            ]);
            return Option.some(next);
          }),
      }).pipe(Effect.provide(harness.dependencies));

      // Connected over T3 Connect, the server reports its LAN address; the
      // learned route ranks first, answers, and the session moves to it.
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 2,
      );
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
      expect(yield* Ref.get(learned)).toEqual([
        `learned:${TARGET.environmentId}:http://192.168.1.10:3773`,
      ]);
    }),
  );
});

describe("EnvironmentSupervisor background fibers", () => {
  it.effect("hears the network return after its connectivity stream died", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const status = yield* SubscriptionRef.make<NetworkStatus>("offline");
      const subscriptions = yield* Ref.make(0);
      const dying = Connectivity.Connectivity.of({
        status: SubscriptionRef.get(status),
        changes: Stream.unwrap(
          Ref.updateAndGet(subscriptions, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 1
                ? Stream.die(new Error("platform connectivity stream died"))
                : SubscriptionRef.changes(status),
            ),
          ),
        ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provideService(Connectivity.Connectivity, dying),
        Effect.provide(harness.dependencies),
      );
      yield* TestClock.adjust("10 minutes");
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("offline");

      yield* SubscriptionRef.set(status, "online");
      yield* TestClock.adjust("10 minutes");
      expect((yield* SubscriptionRef.get(supervisor.state)).phase).toBe("connected");
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("replaces a stalled session on return to the app after its wakeup stream died", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        probe: (attempt) => (attempt === 1 ? Effect.never : Effect.void),
      });
      const returns = yield* SubscriptionRef.make(0);
      const subscriptions = yield* Ref.make(0);
      const dying = ConnectionWakeups.ConnectionWakeups.of({
        changes: Stream.unwrap(
          Ref.updateAndGet(subscriptions, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 1
                ? Stream.die(new Error("platform wakeup stream died"))
                : SubscriptionRef.changes(returns).pipe(
                    Stream.drop(1),
                    Stream.map(() => "application-active" as const),
                  ),
            ),
          ),
        ),
      });
      const supervisor = yield* EnvironmentSupervisor.make(TARGET_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provideService(ConnectionWakeups.ConnectionWakeups, dying),
        Effect.provide(harness.dependencies),
      );
      yield* TestClock.adjust("10 minutes");
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 1,
      });

      // The user returns to the app; the session's probe never answers.
      yield* SubscriptionRef.update(returns, (count) => count + 1);
      for (let step = 0; step < 4; step += 1) yield* TestClock.adjust("15 seconds");
      yield* TestClock.adjust("10 minutes");
      expect(yield* SubscriptionRef.get(supervisor.state)).toMatchObject({
        phase: "connected",
        generation: 2,
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("still moves to a better route after one route check crashed", () =>
    Effect.gen(function* () {
      const lanReachable = yield* Ref.make(false);
      const preflights = yield* Ref.make(0);
      const harness = yield* makeHarness({
        checkRoute: (route) =>
          route.target._tag === "BearerConnectionTarget"
            ? Ref.get(lanReachable).pipe(
                Effect.map((reachable) => (reachable ? "answered" : "silent")),
              )
            : Effect.succeed("unchecked"),
        prepare: (_attempt, target) => Effect.succeed(preparedFor(target)),
      });
      const driver = yield* ConnectionDriver.ConnectionDriver.pipe(
        Effect.provide(harness.dependencies),
      );
      const supervisor = yield* EnvironmentSupervisor.make(LAN_THEN_RELAY_ENTRY, {
        initiallyDesired: true,
      }).pipe(
        Effect.provideService(ConnectionDriver.ConnectionDriver, {
          ...driver,
          preflight: (entry, route) =>
            Ref.updateAndGet(preflights, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.die(new Error("route check threw"))
                  : driver.preflight(entry, route),
              ),
            ),
        }),
        Effect.provide(harness.dependencies),
      );
      yield* awaitState(
        supervisor.state,
        (state) => state.phase === "connected" && state.generation === 1,
      );
      yield* TestClock.adjust("60 seconds");
      expect(yield* Ref.get(preflights)).toBe(1);

      yield* Ref.set(lanReachable, true);
      for (let minute = 0; minute < 5; minute += 1) {
        yield* TestClock.adjust("60 seconds");
      }
      expect(Option.getOrThrow(yield* SubscriptionRef.get(supervisor.prepared)).target._tag).toBe(
        "BearerConnectionTarget",
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
