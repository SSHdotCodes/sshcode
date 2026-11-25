import {
  type EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerProvider,
  WsSubscribeServerConfigRpc,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/rpc/Rpc";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcClientError from "effect/rpc/RpcClientError";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import { inflatingJson, withMessageCompression } from "./messageCompression.ts";
import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import { ConnectionTimings } from "../connection/timings.ts";
import { NetworkTiming, RequestProgress, makeNetworkTiming } from "../connection/networkTiming.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
  withoutEnvironmentThemes,
} from "../state/serverConfigProjection.ts";
import { environmentMismatchError } from "../connection/errors.ts";
import { markLoad } from "../loadMarks.ts";
import * as Persistence from "../platform/persistence.ts";

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  /** Replays snapshots from the session's existing config stream. */
  readonly configSnapshots?: Stream.Stream<ServerConfig>;
  readonly subscribeServerConfig: (
    input: ServerConfigSubscriptionInput,
  ) => ServerConfigSubscription;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  /** Socket handshake duration, excluding the initial config's server and decode work. */
  readonly openDurationMs?: Effect.Effect<number>;
  /**
   * Smoothed heartbeat round trip on this socket, and when the latest pong
   * arrived (monotonic nanoseconds). Undefined until a pong answers.
   */
  readonly pingRoundTrip?: Effect.Effect<
    { readonly milliseconds: number; readonly measuredAt: bigint } | undefined
  >;
  /** Last received transport bytes, including an incomplete compressed message. */
  readonly receivedAt?: Effect.Effect<bigint>;
  /** RPC response progress, including compressed parts, excluding control frames. */
  readonly rpcReceivedAt?: Effect.Effect<bigint>;
  readonly responseTimeoutMs?: (minimumMs: number) => Effect.Effect<number>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
}

/**
 * Both config streams below run through applyServerConfigProjection, which
 * restores the provider catalogs a compact delta leaves out.
 */
function withCatalogReuse(input: ServerConfigSubscriptionInput): ServerConfigSubscriptionInput {
  return input.compactProviders === true
    ? { ...input, reuseProviderCatalogs: true, reuseWorkspaceCatalogs: true }
    : input;
}

export interface RpcSessionOptions {
  readonly environmentThemes?: boolean;
  readonly chatTabs?: boolean;
  readonly usageLimitSources?: boolean;
  /** This client answers /usage-limits itself, so the server may advertise it. */
  readonly usageLimitsCommand?: boolean;
  readonly compactProviders?: boolean;
  /**
   * With `compactProviders`, keep each environment's provider catalogs between
   * sessions (from the environment cache after a launch) and report them, so a
   * reconnect is not sent catalogs it already holds.
   */
  readonly heldCatalogs?: boolean;
  /**
   * Ask the server to deflate large messages itself, for a WebSocket that
   * cannot negotiate permessage-deflate (React Native's on iOS).
   */
  readonly messageCompression?: boolean;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@t3tools/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;
type ProbeError = Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverProbe]>>;
type ServerConfigSubscriptionError =
  | Rpc.ErrorExit<typeof WsSubscribeServerConfigRpc>
  | RpcClientError.RpcClientError;
type ServerConfigSubscription = Stream.Stream<
  ServerConfigStreamEvent,
  ServerConfigSubscriptionError
>;
type ServerConfigSubscriptionInput = Parameters<
  WsRpcProtocolClient[typeof WS_METHODS.subscribeServerConfig]
>[0];
type EnvironmentThemesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "environmentThemesUpdated" }
>;
type UsageLimitSourcesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "usageLimitSourcesUpdated" }
>;

interface ServerConfigReplayState {
  readonly projection: ServerConfigProjection;
  readonly revision: number;
  readonly themesEvent: EnvironmentThemesUpdatedEvent | undefined;
  readonly sourcesEvent: UsageLimitSourcesUpdatedEvent | undefined;
}

interface BufferedServerConfigEvent {
  readonly event: ServerConfigStreamEvent;
  readonly replay: ServerConfigReplayState;
  readonly revision: number;
}

function serverConfigReplayEvents(
  state: ServerConfigReplayState,
): ReadonlyArray<ServerConfigStreamEvent> {
  const snapshot = {
    version: 1 as const,
    type: "snapshot" as const,
    config: withoutEnvironmentThemes(state.projection.config),
  };
  return [
    snapshot,
    ...(state.themesEvent === undefined ? [] : [state.themesEvent]),
    ...(state.sourcesEvent === undefined ? [] : [state.sourcesEvent]),
  ];
}

const isSocketErrorReason = Schema.is(Socket.SocketErrorReason);

function mapSessionRpcError(
  error: InitialConfigError | ProbeError | ServerConfigSubscriptionError,
  networkHint: string,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: `${error.message}${isSocketErrorReason(error.reason) ? networkHint : ""}`,
      });
  }
}

// If a 5s watchdog sleep wakes this long after it started, the OS suspended the
// process (iOS backgrounding, macOS sleep). Give the resumed socket one grace
// interval to drain buffered frames and answer the supervisor's resume probe,
// and discard any Pong round-trip that spanned the suspension.
const WATCHDOG_SUSPENSION_THRESHOLD_MS = 10_000;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("RpcSessionFactory.make")(function* (
  options: RpcSessionOptions = {},
) {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const timings = yield* ConnectionTimings;
  const sharedTiming = yield* Effect.serviceOption(NetworkTiming);
  const serverConfigInput: ServerConfigSubscriptionInput = {
    ...(options.environmentThemes === true ? { environmentThemes: true } : {}),
    ...(options.chatTabs === true ? { chatTabs: true } : {}),
    ...(options.usageLimitSources === true ? { usageLimitSources: true } : {}),
    ...(options.usageLimitsCommand === true ? { usageLimitsCommand: true } : {}),
    ...(options.compactProviders === true ? { compactProviders: true } : {}),
  };
  // The providers each environment's last session received, catalogs included.
  const heldProviders = new Map<EnvironmentId, ReadonlyArray<ServerProvider>>();
  const cache = yield* Effect.serviceOption(Persistence.EnvironmentCacheStore);
  const loadHeldProviders = (environmentId: EnvironmentId) => {
    if (options.heldCatalogs !== true || options.compactProviders !== true) {
      return Effect.succeed(undefined);
    }
    const held = heldProviders.get(environmentId);
    if (held !== undefined || Option.isNone(cache)) return Effect.succeed(held ?? []);
    return cache.value.loadServerConfig(environmentId).pipe(
      Effect.map(Option.match({ onNone: () => [], onSome: (config) => config.providers })),
      Effect.orElseSucceed((): ReadonlyArray<ServerProvider> => []),
    );
  };

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    const networkHint =
      connection.target._tag === "RelayConnectionTarget" ? ` ${NETWORK_BLOCKING_HINT}` : "";
    const mapRpcError = (error: Parameters<typeof mapSessionRpcError>[0]) =>
      mapSessionRpcError(error, networkHint);
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const openingAt = yield* Clock.monotonicTimeNanos;
    const clock = yield* Clock.Clock;
    const network = Option.isSome(sharedTiming) ? sharedTiming.value : makeNetworkTiming();
    const progress = yield* RequestProgress;
    let receivedAt = openingAt;
    let rpcReceivedAt = openingAt;
    let watchdogTickAt = openingAt;
    let pingSentAt: bigint | undefined;
    let pingRoundTrip: { readonly milliseconds: number; readonly measuredAt: bigint } | undefined;
    const timeoutMs = (minimumMs: number) => network.budget(connection.httpBaseUrl, minimumMs);
    const serialization =
      options.messageCompression === true ? inflatingJson : RpcSerialization.json;
    const layerSerialization = Layer.succeed(RpcSerialization.RpcSerialization, {
      ...serialization,
      makeUnsafe: () => {
        const parser = serialization.makeUnsafe();
        return {
          decode: (data) => {
            if (data.length > 0) receivedAt = clock.monotonicTimeNanosUnsafe();
            const responses = parser.decode(data);
            if (
              data.length > 0 &&
              ((typeof data !== "string" && responses.length === 0) ||
                responses.some(
                  (value) =>
                    typeof value === "object" &&
                    value !== null &&
                    "_tag" in value &&
                    (value._tag === "Chunk" || value._tag === "Exit" || value._tag === "Defect"),
                ))
            ) {
              rpcReceivedAt = receivedAt;
              progress?.received();
            }
            // Only an actual pong supplies a round-trip sample. Incomplete
            // compressed messages still advance the receive timestamp above.
            if (
              typeof data === "string" &&
              pingSentAt !== undefined &&
              responses.some(
                (value) =>
                  typeof value === "object" &&
                  value !== null &&
                  "_tag" in value &&
                  value._tag === "Pong",
              )
            ) {
              const suspendedSinceTick =
                Number(receivedAt - watchdogTickAt) / 1_000_000 >= WATCHDOG_SUSPENSION_THRESHOLD_MS;
              if (!suspendedSinceTick) {
                const sampleMs = Number(receivedAt - pingSentAt) / 1_000_000;
                network.observe(connection.httpBaseUrl, sampleMs);
                pingRoundTrip = {
                  milliseconds:
                    pingRoundTrip === undefined
                      ? sampleMs
                      : 0.7 * pingRoundTrip.milliseconds + 0.3 * sampleMs,
                  measuredAt: receivedAt,
                };
              }
              pingSentAt = undefined;
            }
            return responses;
          },
          encode: (value) => {
            if (
              typeof value === "object" &&
              value !== null &&
              "_tag" in value &&
              value._tag === "Ping"
            ) {
              pingSentAt ??= clock.monotonicTimeNanosUnsafe();
            }
            return parser.encode(value);
          },
        };
      },
    });
    const connected = yield* Deferred.make<number>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    // Set when the socket closes because the server stopped answering, so the failure says so
    // instead of looking like the server closed the connection.
    const pingTimedOut = yield* Ref.make(false);
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Effect.gen(function* () {
        const openedAt = yield* Clock.monotonicTimeNanos;
        receivedAt = openedAt;
        watchdogTickAt = openedAt;
        progress?.received();
        network.observe(connection.httpBaseUrl, Number(openedAt - openingAt) / 1_000_000);
        markLoad("socket.open");
        yield* Deferred.succeed(connected, Number(openedAt - openingAt) / 1_000_000);
      }),
      onDisconnect: Effect.all([Deferred.isDone(connected), Ref.get(pingTimedOut)]).pipe(
        Effect.flatMap(([wasConnected, timedOut]) =>
          Deferred.fail(
            disconnected,
            new ConnectionTransientErrorClass({
              reason: "transport",
              detail: `${
                !wasConnected
                  ? `${connection.label} could not establish a WebSocket connection.`
                  : timedOut
                    ? `${connection.label} stopped responding.`
                    : `${connection.label} disconnected.`
              }${networkHint}`,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    });
    const socketUrl =
      options.messageCompression === true
        ? withMessageCompression(connection.socketUrl)
        : connection.socketUrl;
    const layerSocket = Socket.layerWebSocket(socketUrl, {
      openTimeout: timeoutMs(
        Duration.toMillis(Duration.fromInputUnsafe(timings.socketOpenTimeout)),
      ),
    }).pipe(Layer.provide(Layer.succeed(Socket.WebSocketConstructor, webSocketConstructor)));
    const layerProtocol = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        // Keep sending pings; the monotonic watchdog below owns the adaptive
        // receive deadline, including bytes that do not yet decode into an RPC.
        pingTimeout: Duration.infinity,
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          layerSocket,
          layerSerialization,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(layerProtocol).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const protocolClient = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    yield* Effect.gen(function* () {
      yield* Deferred.await(connected);
      let graceForReceivedAt: bigint | undefined;
      for (;;) {
        const sleptAt = clock.monotonicTimeNanosUnsafe();
        watchdogTickAt = sleptAt;
        yield* Effect.sleep("5 seconds");
        const now = clock.monotonicTimeNanosUnsafe();
        watchdogTickAt = now;
        const suspended = Number(now - sleptAt) / 1_000_000 >= WATCHDOG_SUSPENSION_THRESHOLD_MS;
        if (suspended) {
          pingSentAt = undefined;
        }
        const budget = timeoutMs(Duration.toMillis(Duration.fromInputUnsafe(timings.pingTimeout)));
        if (Number(now - receivedAt) / 1_000_000 > budget) {
          // Background timer throttling can delay every tick. Grant grace
          // once per receive timestamp, until the socket shows life again.
          if (suspended && graceForReceivedAt !== receivedAt) {
            graceForReceivedAt = receivedAt;
            continue;
          }
          yield* Ref.set(pingTimedOut, true);
          yield* Deferred.fail(
            disconnected,
            new ConnectionTransientErrorClass({
              reason: "transport",
              detail: `${connection.label} stopped responding.${networkHint}`,
            }),
          );
          return;
        }
      }
    }).pipe(Effect.forkScoped);
    const initialConfigDeferred = yield* Deferred.make<ServerConfig>();
    const serverConfigExit = yield* Deferred.make<void, ServerConfigSubscriptionError>();
    const configSubscriptionClosed = yield* Deferred.make<never, ConnectionAttemptError>();
    const serverConfigState = yield* Ref.make(Option.none<ServerConfigReplayState>());
    const serverConfigUpdates = yield* PubSub.sliding<BufferedServerConfigEvent>(64);
    const configSubscriptionEndedError = new ConnectionTransientErrorClass({
      reason: "remote-unavailable",
      detail: `${connection.label} config subscription ended.`,
    });
    const held = yield* loadHeldProviders(connection.environmentId);
    const serverConfigSource = protocolClient[WS_METHODS.subscribeServerConfig]({
      ...withCatalogReuse(serverConfigInput),
      ...(held === undefined
        ? {}
        : {
            heldCatalogs: held.flatMap(({ instanceId, catalogDigest }) =>
              catalogDigest === undefined ? [] : [{ instanceId, catalogDigest }],
            ),
          }),
    }).pipe(
      Stream.runForEach((wireEvent) =>
        Effect.gen(function* () {
          const buffered = yield* Ref.modify(serverConfigState, (current) => {
            const projection = applyServerConfigProjection(
              Option.map(current, (state) => state.projection),
              wireEvent,
              held,
            );
            if (Option.isNone(projection)) {
              return [Option.none<BufferedServerConfigEvent>(), current] as const;
            }

            const event = projection.value.latestEvent;
            const next = {
              projection: projection.value,
              revision: Option.match(current, {
                onNone: () => 1,
                onSome: (state) => state.revision + 1,
              }),
              themesEvent:
                event.type === "environmentThemesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.environmentThemes !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.themesEvent,
              sourcesEvent:
                event.type === "usageLimitSourcesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.usageLimitSources !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.sourcesEvent,
            } satisfies ServerConfigReplayState;
            return [
              Option.some({ event, replay: next, revision: next.revision }),
              Option.some(next),
            ] as const;
          });
          if (Option.isSome(buffered)) {
            const { config } = buffered.value.replay.projection;
            if (
              held !== undefined &&
              config.environment.environmentId === connection.environmentId
            ) {
              heldProviders.set(connection.environmentId, config.providers);
            }
            yield* PubSub.publish(serverConfigUpdates, buffered.value);
            if (buffered.value.event.type === "snapshot") {
              markLoad("config.snapshot", {
                providers: buffered.value.event.config.providers.length,
              });
              yield* Deferred.succeed(initialConfigDeferred, buffered.value.event.config);
            } else if (buffered.value.event.type === "providerStatuses") {
              markLoad("config.providerStatuses", {
                changed:
                  wireEvent.type === "providerStatuses" ? wireEvent.payload.providers.length : 0,
              });
            }
          }
        }),
      ),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) {
          return Effect.all([
            Deferred.succeed(serverConfigExit, undefined),
            Deferred.fail(configSubscriptionClosed, configSubscriptionEndedError),
          ]).pipe(Effect.asVoid);
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.void;
        }
        return Effect.all([
          Deferred.failCause(serverConfigExit, exit.cause),
          Deferred.failCause(configSubscriptionClosed, Cause.map(exit.cause, mapRpcError)),
        ]).pipe(Effect.asVoid);
      }),
    );
    yield* serverConfigSource.pipe(Effect.forkScoped);
    const initialConfig = Effect.raceFirst(
      Deferred.await(initialConfigDeferred),
      Deferred.await(serverConfigExit).pipe(
        Effect.mapError(mapRpcError),
        Effect.flatMap(() => Effect.fail(configSubscriptionEndedError)),
      ),
    ).pipe(
      Effect.filterOrElse(
        (config) => config.environment.environmentId === connection.environmentId,
        (config) =>
          environmentMismatchError({
            expected: connection.environmentId,
            actual: config.environment.environmentId,
          }),
      ),
      Effect.withSpan("environment.initialSync"),
    );
    const serverConfigEvents = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(serverConfigUpdates);
        const snapshot = yield* Ref.get(serverConfigState);
        if (Option.isNone(snapshot)) {
          return Stream.empty;
        }
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((buffered) => buffered.revision > snapshot.value.revision),
          Stream.mapAccum(
            () => snapshot.value.revision,
            (revision, buffered) => [
              buffered.revision,
              buffered.revision === revision + 1
                ? [buffered.event]
                : serverConfigReplayEvents(buffered.replay),
            ],
          ),
        );
        const terminal = Stream.fromEffect(Deferred.await(serverConfigExit)).pipe(Stream.drain);
        return Stream.concat(
          Stream.fromIterable(serverConfigReplayEvents(snapshot.value)),
          Stream.merge(updates, terminal, { haltStrategy: "either" }),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Stream.failCause(cause);
        }
        // The supervisor keeps the original cause. Shared durable consumers
        // need a transport-shaped failure so they wait for its replacement.
        return Stream.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: `${connection.label} config subscription failed.`,
              cause,
            }),
          }),
        );
      }),
    );
    const validatedInitialConfig = initialConfig.pipe(
      Effect.mapError(
        (cause) =>
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: `${connection.label} config subscription failed.`,
              cause,
            }),
          }),
      ),
    );
    const subscribeRawServerConfig = (input: ServerConfigSubscriptionInput) =>
      protocolClient[WS_METHODS.subscribeServerConfig](withCatalogReuse(input)).pipe(
        Stream.mapAccum(
          () => Option.none<ServerConfigProjection>(),
          (current, event) => {
            const projection = applyServerConfigProjection(current, event);
            return [projection, Option.isSome(projection) ? [projection.value.latestEvent] : []];
          },
        ),
      );
    const subscribeServerConfig = (input: ServerConfigSubscriptionInput) =>
      Stream.unwrap(
        validatedInitialConfig.pipe(
          Effect.as(
            Equal.equals(input, serverConfigInput)
              ? serverConfigEvents
              : subscribeRawServerConfig(input),
          ),
        ),
      );
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? protocolClient[WS_METHODS.serverProbe]({})
          : protocolClient[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client: { ...protocolClient, [WS_METHODS.subscribeServerConfig]: subscribeRawServerConfig },
      initialConfig,
      configSnapshots: serverConfigEvents.pipe(
        Stream.filter((event) => event.type === "snapshot"),
        Stream.map((event) => event.config),
        Stream.catch(() => Stream.empty),
      ),
      subscribeServerConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      openDurationMs: Deferred.await(connected),
      pingRoundTrip: Effect.sync(() => pingRoundTrip),
      receivedAt: Effect.sync(() => receivedAt),
      rpcReceivedAt: Effect.sync(() => rpcReceivedAt),
      responseTimeoutMs: (minimumMs) => Effect.sync(() => timeoutMs(minimumMs)),
      probe,
      closed: Effect.raceFirst(
        Deferred.await(disconnected),
        Deferred.await(configSubscriptionClosed),
      ),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = (options: RpcSessionOptions) => Layer.effect(RpcSessionFactory, make(options));
