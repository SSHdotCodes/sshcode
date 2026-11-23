import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as Ref from "effect/Ref";
import type { PreparedConnection } from "./model.ts";
import * as TestClock from "effect/testing/TestClock";

import {
  BearerConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "./catalog.ts";
import * as ConnectionDriver from "./driver.ts";
import * as ConnectionResolver from "./resolver.ts";
import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import { RecentEnvironmentDescriptors } from "../environment/descriptor.ts";
import * as Persistence from "../platform/persistence.ts";
import * as RpcHttp from "../rpc/http.ts";
import { NetworkTiming, RequestProgress } from "./networkTiming.ts";
import * as RpcSession from "../rpc/session.ts";
import { connectOverRoutes, type EnvironmentConnectionLease, type RouteCheck } from "./driver.ts";
import {
  BearerConnectionTarget,
  ConnectionBlockedError,
  ConnectionTransientError,
  RelayConnectionTarget,
} from "./model.ts";

const routes = ["lan", "tailnet"].map((connectionId): ConnectionRoute => ({
  target: new BearerConnectionTarget({
    environmentId: EnvironmentId.make("desk"),
    label: "Desk",
    connectionId,
  }),
  profile: Option.none(),
}));
const entry: ConnectionCatalogEntry = {
  ...routes[0]!,
  enabled: true,
  alternateRoutes: [routes[1]!],
};
const lease = {} as EnvironmentConnectionLease;
const routeId = (route: ConnectionRoute) =>
  route.target._tag === "BearerConnectionTarget" ? route.target.connectionId : "other";

describe("connectOverRoutes", () => {
  it.effect("renews a ready DPoP connection only while its lease is open", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<{
        expectedEnvironmentId: EnvironmentId;
        expiresAtEpochMs: number;
      }>();
      const stopped = yield* Deferred.make<void>();
      const prepared = {
        target: entry.target,
        environmentId: entry.target.environmentId,
        httpAuthorization: { _tag: "Dpop", accessToken: "token", expiresAtEpochMs: 3_600_000 },
      } as PreparedConnection;
      yield* Effect.gen(function* () {
        const driver = yield* ConnectionDriver.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
                authorizeBearer: () => Effect.die("unused"),
                authorizeDpop: () => Effect.die("unused"),
                authorizeDpopHttp: () => Effect.die("unused"),
                renewDpopBeforeExpiry: (input) =>
                  Deferred.succeed(started, input).pipe(
                    Effect.andThen(Effect.never),
                    Effect.ensuring(Deferred.succeed(stopped, undefined)),
                  ),
              }),
              Layer.succeed(ConnectionResolver.ConnectionResolver, {
                prepare: () => Effect.succeed(prepared),
                prepareForUpdate: () => Effect.die("unused"),
              }),
              Layer.succeed(RpcSession.RpcSessionFactory, {
                connect: () =>
                  Effect.succeed({
                    client: {} as WsRpcProtocolClient,
                    initialConfig: Effect.never,
                    subscribeServerConfig: () => Stream.never,
                    probe: Effect.void,
                    closed: Effect.never,
                    ready: Effect.void,
                  }),
              }),
              RpcHttp.layerRemoteHttpClient(fetch),
            ),
          ),
        );
        yield* driver.connect({ ...entry, alternateRoutes: [] }, () => Effect.void);
        expect(yield* Deferred.isDone(started)).toBe(true);
        expect(yield* Deferred.await(started)).toEqual({
          expectedEnvironmentId: entry.target.environmentId,
          expiresAtEpochMs: 3_600_000,
        });
      }).pipe(Effect.scoped);
      expect(yield* Deferred.isDone(stopped)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { waitMs: 1_000, prepares: 1, scenario: "connects over a route authorized ahead once" },
    {
      waitMs: 10_001,
      prepares: 2,
      scenario: "authorizes again once a route prepared ahead is stale",
    },
  ])("$scenario", ({ waitMs, prepares }) =>
    Effect.gen(function* () {
      let prepareCount = 0;
      const single = { ...entry, alternateRoutes: [] };
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
              authorizeBearer: () => Effect.die("unused"),
              authorizeDpop: () => Effect.die("unused"),
              authorizeDpopHttp: () => Effect.die("unused"),
              renewDpopBeforeExpiry: () => Effect.die("unused"),
            }),
            Layer.succeed(ConnectionResolver.ConnectionResolver, {
              prepare: () =>
                Effect.sync(() => {
                  prepareCount++;
                  return {
                    target: entry.target,
                    environmentId: entry.target.environmentId,
                    httpAuthorization: null,
                  } as PreparedConnection;
                }),
              prepareForUpdate: () => Effect.die("unused"),
            }),
            Layer.succeed(RpcSession.RpcSessionFactory, {
              connect: () =>
                Effect.succeed({
                  client: {} as WsRpcProtocolClient,
                  initialConfig: Effect.never,
                  subscribeServerConfig: () => Stream.never,
                  probe: Effect.void,
                  closed: Effect.never,
                  ready: Effect.void,
                }),
            }),
            RpcHttp.layerRemoteHttpClient(fetch),
          ),
        ),
      );
      // A long resume starts the route's authorization while it probes the socket.
      yield* driver.prepareAhead!(single, routes[0]!);
      yield* TestClock.adjust(waitMs);
      yield* driver.connect(single, () => Effect.void);
      expect(prepareCount).toBe(prepares);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("retains only the winning lease when hedged routes finish together", () =>
    Effect.gen(function* () {
      const first = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const released: string[] = [];
      const connected = yield* connectOverRoutes(
        entry,
        () => Effect.succeed("answered"),
        (route) =>
          Effect.acquireRelease(Effect.succeed(lease), () =>
            Effect.sync(() => {
              released.push(routeId(route));
            }),
          ).pipe(
            Effect.tap(() => Deferred.succeed(first, undefined)),
            Effect.andThen(
              routeId(route) === "lan"
                ? Deferred.await(finish).pipe(Effect.as(lease))
                : Deferred.succeed(finish, undefined).pipe(Effect.as(lease)),
            ),
          ),
        () => Effect.void,
        3_000,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(first);
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(connected)).toBe(lease);
      expect(released).toHaveLength(1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "defers the hedge while the preferred route receives bytes, then hedges on silence",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<() => void>();
        const attempted: string[] = [];
        const connected = yield* connectOverRoutes(
          entry,
          () => Effect.succeed("answered"),
          (route) =>
            Effect.gen(function* () {
              attempted.push(routeId(route));
              if (routeId(route) !== "lan") return lease;
              const progress = yield* RequestProgress;
              yield* Deferred.succeed(started, () => progress?.received());
              return yield* Effect.never;
            }),
          () => Effect.void,
          3_000,
        ).pipe(Effect.forkChild);
        const receive = yield* Deferred.await(started);
        for (let part = 0; part < 5; part++) {
          yield* TestClock.adjust("2 seconds");
          receive();
        }
        expect(attempted).toEqual(["lan"]);
        yield* TestClock.adjust(2_999);
        expect(attempted).toEqual(["lan"]);
        yield* TestClock.adjust(1);
        expect(yield* Fiber.join(connected)).toBe(lease);
        expect(attempted).toEqual(["lan", "tailnet"]);
      }).pipe(Effect.scoped),
  );

  it.effect("hedges a stalled preferred route without discarding the route that connects", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const released = yield* Ref.make(false);
      const connected = yield* connectOverRoutes(
        entry,
        () => Effect.succeed("answered"),
        (route) =>
          routeId(route) === "lan"
            ? Effect.acquireRelease(Deferred.succeed(started, undefined), () =>
                Ref.set(released, true),
              ).pipe(Effect.andThen(Effect.never))
            : Effect.succeed(lease),
        () => Effect.void,
        3_000,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(connected)).toBe(lease);
      expect(yield* Ref.get(released)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect.each(["setup", "sync"] as const)(
    "falls back after a route stalls during %s and releases it",
    (stalledStage) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const released = yield* Ref.make(false);
        const failures: ConnectionDriver.ConnectionDriverProgress[] = [];
        const prepared = (target: typeof entry.target) => ({ target }) as PreparedConnection;
        const driver = yield* ConnectionDriver.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
                authorizeBearer: () => Effect.die("unused"),
                authorizeDpop: () => Effect.die("unused"),
                authorizeDpopHttp: () => Effect.die("unused"),
                renewDpopBeforeExpiry: () => Effect.die("unexpected renewal"),
              }),
              Layer.succeed(ConnectionResolver.ConnectionResolver, {
                prepare: (route) =>
                  routeId(route) === "lan" && stalledStage === "setup"
                    ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                    : Effect.succeed(prepared(route.target)),
                prepareForUpdate: () => Effect.die("unused"),
              }),
              Layer.succeed(RpcSession.RpcSessionFactory, {
                connect: (connection) =>
                  Effect.acquireRelease(
                    Effect.succeed({
                      client: {} as WsRpcProtocolClient,
                      initialConfig: Effect.never,
                      subscribeServerConfig: () => Stream.never,
                      probe: Effect.void,
                      closed: Effect.never,
                      ready:
                        routeId({ target: connection.target, profile: Option.none() }) === "lan"
                          ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
                          : Effect.void,
                    } satisfies RpcSession.RpcSession),
                    () => Ref.set(released, true),
                  ),
              }),
              RpcHttp.layerRemoteHttpClient(fetch),
            ),
          ),
        );
        const fiber = yield* driver
          .connect(entry, (progress) =>
            Effect.sync(() => {
              failures.push(progress);
            }),
          )
          .pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust(stalledStage === "setup" ? "15 seconds" : "75 seconds");
        const connected = yield* Fiber.join(fiber);
        expect(connected.prepared.target).toEqual(routes[1]!.target);
        expect(failures).toContainEqual(
          expect.objectContaining({
            stage: "route-failed",
            target: routes[0]!.target,
            error: expect.objectContaining({ reason: "timeout" }),
          }),
        );
        if (stalledStage === "sync") expect(yield* Ref.get(released)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect.each(["pongs", "responses"] as const)(
    "bounds initial sync with continuous %s",
    (traffic) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const driver = yield* ConnectionDriver.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
                authorizeBearer: () => Effect.die("unused"),
                authorizeDpop: () => Effect.die("unused"),
                authorizeDpopHttp: () => Effect.die("unused"),
                renewDpopBeforeExpiry: () => Effect.die("unexpected renewal"),
              }),
              Layer.succeed(ConnectionResolver.ConnectionResolver, {
                prepare: (route) => Effect.succeed({ target: route.target } as PreparedConnection),
                prepareForUpdate: () => Effect.die("unused"),
              }),
              Layer.succeed(RpcSession.RpcSessionFactory, {
                connect: () =>
                  Effect.succeed({
                    client: {} as WsRpcProtocolClient,
                    initialConfig: Effect.never,
                    subscribeServerConfig: () => Stream.never,
                    probe: Effect.void,
                    closed: Effect.never,
                    receivedAt: Clock.monotonicTimeNanos,
                    rpcReceivedAt:
                      traffic === "responses" ? Clock.monotonicTimeNanos : Effect.succeed(0n),
                    ready: Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
                  }),
              }),
              RpcHttp.layerRemoteHttpClient(fetch),
            ),
          ),
        );
        const connected = yield* driver
          .connect({ ...entry, alternateRoutes: [] }, () => Effect.void)
          .pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust(traffic === "pongs" ? "75 seconds" : "5 minutes");
        expect(connected.pollUnsafe()).toBeDefined();
        if (connected.pollUnsafe() !== undefined) {
          expect(yield* Fiber.join(connected)).toMatchObject({
            _tag: "Failure",
            failure: { reason: "timeout" },
          });
        }
      }).pipe(Effect.scoped),
  );

  it.effect("caps route triage at 2500 ms despite stale latency and trickling bytes", () =>
    Effect.gen(function* () {
      const url = "http://192.168.1.20:3773";
      const direct = {
        ...entry,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: "lan",
            environmentId: entry.target.environmentId,
            label: "Mac",
            httpBaseUrl: url,
            wsBaseUrl: "ws://192.168.1.20:3773",
          }),
        ),
      };
      const requested = yield* Deferred.make<void>();
      const body = yield* Stream.toReadableStreamEffect(
        Stream.fromEffect(Deferred.succeed(requested, undefined)).pipe(
          Stream.flatMap(() =>
            Stream.fromEffectRepeat(Effect.sleep(1_000).pipe(Effect.as(new Uint8Array([32])))),
          ),
        ),
      );
      const connected = yield* Effect.gen(function* () {
        const timing = yield* NetworkTiming;
        timing.observe(url, 100_000);
        const driver = yield* ConnectionDriver.make;
        return yield* driver.checkRoute(direct, direct);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
              authorizeBearer: () => Effect.die("unused"),
              authorizeDpop: () => Effect.die("unused"),
              authorizeDpopHttp: () => Effect.die("unused"),
              renewDpopBeforeExpiry: () => Effect.die("unexpected renewal"),
            }),
            Layer.succeed(ConnectionResolver.ConnectionResolver, {
              prepare: () => Effect.die("unused"),
              prepareForUpdate: () => Effect.die("unused"),
            }),
            Layer.succeed(RpcSession.RpcSessionFactory, { connect: () => Effect.die("unused") }),
            RpcHttp.layerRemoteHttpClient(
              async () => new Response(body, { headers: { "content-type": "application/json" } }),
            ),
          ),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(requested);
      yield* TestClock.adjust(2_500);
      expect(connected.pollUnsafe()).toBeDefined();
      if (connected.pollUnsafe() !== undefined) expect(yield* Fiber.join(connected)).toBe("silent");
    }).pipe(Effect.scoped),
  );

  it.effect("reports failed reachability checks while T3 Connect is still preparing", () =>
    Effect.gen(function* () {
      const reported = yield* Deferred.make<ConnectionDriver.ConnectionDriverProgress>();
      const direct = {
        ...entry,
        profile: Option.some(
          new BearerConnectionProfile({
            connectionId: "lan",
            environmentId: entry.target.environmentId,
            label: "Mac",
            httpBaseUrl: "http://192.168.1.20:3773",
            wsBaseUrl: "ws://192.168.1.20:3773",
          }),
        ),
        alternateRoutes: [
          {
            target: new RelayConnectionTarget({
              environmentId: entry.target.environmentId,
              label: "Mac",
            }),
            profile: Option.none(),
          },
        ],
      };
      const driver = yield* ConnectionDriver.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
              authorizeBearer: () => Effect.die("unused"),
              authorizeDpop: () => Effect.die("unused"),
              authorizeDpopHttp: () => Effect.die("unused"),
              renewDpopBeforeExpiry: () => Effect.die("unexpected renewal"),
            }),
            Layer.succeed(ConnectionResolver.ConnectionResolver, {
              prepare: () => Effect.never,
              prepareForUpdate: () => Effect.die("unused"),
            }),
            Layer.succeed(RpcSession.RpcSessionFactory, { connect: () => Effect.die("unused") }),
            RpcHttp.layerRemoteHttpClient((() =>
              Promise.reject(new TypeError("Network unavailable"))) satisfies typeof fetch),
          ),
        ),
      );
      const fiber = yield* driver
        .connect(direct, (progress) =>
          progress.stage === "route-failed"
            ? Deferred.succeed(reported, progress).pipe(Effect.asVoid)
            : Effect.void,
        )
        .pipe(Effect.forkChild);
      const progress = yield* Deferred.await(reported);
      expect(progress).toMatchObject({
        stage: "route-failed",
        target: entry.target,
        error: { _tag: "ConnectionTransientError", reason: "network" },
      });
      yield* Fiber.interrupt(fiber);
    }).pipe(Effect.scoped),
  );

  it.effect("reaches T3 Connect before a dead LAN check finishes on cellular", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const attempted: string[] = [];
      const relay = {
        target: new RelayConnectionTarget({
          environmentId: entry.target.environmentId,
          label: "Mac",
        }),
        profile: Option.none(),
      };
      const fiber = yield* connectOverRoutes(
        { ...entry, alternateRoutes: [relay] },
        (route) =>
          route === relay
            ? Effect.succeed<RouteCheck>("unchecked")
            : Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.sleep(2_500)),
                Effect.as<RouteCheck>("silent"),
              ),
        (route) =>
          Effect.sync(() => {
            attempted.push(route.target._tag);
            return lease;
          }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(200);
      expect(yield* Fiber.join(fiber)).toBe(lease);
      expect(attempted).toEqual(["RelayConnectionTarget"]);
    }).pipe(Effect.scoped),
  );

  it.effect("reports each failed route before trying its fallback", () =>
    Effect.gen(function* () {
      const lan = new ConnectionTransientError({ reason: "timeout", detail: "LAN timed out" });
      const tailnet = new ConnectionBlockedError({ reason: "authentication", detail: "Sign in" });
      const failures: Array<readonly [string, ConnectionTransientError | ConnectionBlockedError]> =
        [];
      const result = yield* connectOverRoutes(
        entry,
        () => Effect.succeed<RouteCheck>("answered"),
        (route) => {
          if (routeId(route) === "lan") return Effect.fail(lan);
          expect(failures).toEqual([["lan", lan]]);
          return Effect.fail(tailnet);
        },
        (route, error) =>
          Effect.sync(() => {
            failures.push([routeId(route), error]);
          }),
      ).pipe(Effect.result);
      expect(result._tag === "Failure" && result.failure).toBe(lan);
      expect(failures).toEqual([
        ["lan", lan],
        ["tailnet", tailnet],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("uses a fast second route after a short grace, cancelling the silent first check", () =>
    Effect.gen(function* () {
      const cancelled = yield* Ref.make(false);
      const started = yield* Deferred.make<void>();
      const attempted: string[] = [];
      const fiber = yield* connectOverRoutes(
        entry,
        (route) =>
          routeId(route) === "lan"
            ? Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.sleep(2_500)),
                Effect.as<RouteCheck>("silent"),
                Effect.onInterrupt(() => Ref.set(cancelled, true)),
              )
            : Effect.sleep(100).pipe(Effect.as<RouteCheck>("answered")),
        (route) =>
          Effect.sync(() => {
            attempted.push(routeId(route));
            return lease;
          }),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(300);
      expect(yield* Fiber.join(fiber)).toBe(lease);
      expect(attempted).toEqual(["tailnet"]);
      expect(yield* Ref.get(cancelled)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect.each([40, 150, 600])(
    "starts the best available route without an idle wait at %i ms RTT",
    (rtt) =>
      Effect.gen(function* () {
        const checked = yield* Deferred.make<void>();
        const attempts: Array<{ route: string; at: number }> = [];
        const clock = yield* Clock.Clock;
        const start = clock.currentTimeMillisUnsafe();
        const connected = yield* connectOverRoutes(
          entry,
          (route) =>
            routeId(route) === "lan"
              ? Effect.sleep(rtt).pipe(Effect.as<RouteCheck>("answered"))
              : Deferred.succeed(checked, undefined).pipe(Effect.as<RouteCheck>("unchecked")),
          (route) =>
            Effect.sync(() => {
              attempts.push({ route: routeId(route), at: clock.currentTimeMillisUnsafe() - start });
              return lease;
            }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(checked);
        yield* TestClock.adjust(Math.min(rtt, 200));
        yield* Fiber.join(connected);
        expect(attempts).toEqual([
          { route: rtt < 200 ? "lan" : "tailnet", at: Math.min(rtt, 200) },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps preference when the first route answers within the grace", () =>
    Effect.gen(function* () {
      const attempted: string[] = [];
      const fiber = yield* connectOverRoutes(
        entry,
        (route) =>
          Effect.sleep(routeId(route) === "lan" ? 150 : 100).pipe(
            Effect.as<RouteCheck>("answered"),
          ),
        (route) =>
          Effect.sync(() => {
            attempted.push(routeId(route));
            return lease;
          }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(300);
      expect(yield* Fiber.join(fiber)).toBe(lease);
      expect(attempted).toEqual(["lan"]);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "tries silent routes last and reports a transient failure before blocked failures",
    () =>
      Effect.gen(function* () {
        const attempted: string[] = [];
        const result = yield* connectOverRoutes(
          entry,
          (route) => Effect.succeed<RouteCheck>(routeId(route) === "lan" ? "silent" : "answered"),
          (route) => {
            attempted.push(routeId(route));
            return routeId(route) === "lan"
              ? Effect.fail(
                  new ConnectionTransientError({ reason: "transport", detail: "offline" }),
                )
              : Effect.fail(
                  new ConnectionBlockedError({ reason: "authentication", detail: "sign in" }),
                );
          },
        ).pipe(Effect.result);
        expect(attempted).toEqual(["tailnet", "lan"]);
        expect(result._tag === "Failure" && result.failure._tag).toBe("ConnectionTransientError");
      }).pipe(Effect.scoped),
  );

  it.effect("short-circuits unsupported instead of trying another address of the same server", () =>
    Effect.gen(function* () {
      const attempted: string[] = [];
      const result = yield* connectOverRoutes(
        entry,
        () => Effect.succeed<RouteCheck>("answered"),
        (route) => {
          attempted.push(routeId(route));
          return Effect.fail(
            new ConnectionBlockedError({ reason: "unsupported", detail: "update" }),
          );
        },
      ).pipe(Effect.result);
      expect(attempted).toEqual(["lan"]);
      expect(result._tag === "Failure" && result.failure.reason).toBe("unsupported");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "starts the remembered last-good direct route immediately without the 200 ms grace wait",
    () =>
      Effect.gen(function* () {
        const lanStarted = yield* Deferred.make<void>();
        const attempts: Array<{ route: string; at: number }> = [];
        const clock = yield* Clock.Clock;
        const start = clock.currentTimeMillisUnsafe();
        const fiber = yield* connectOverRoutes(
          entry,
          (route) =>
            routeId(route) === "lan"
              ? Deferred.succeed(lanStarted, undefined).pipe(
                  Effect.andThen(Effect.sleep(2_500)),
                  Effect.as<RouteCheck>("silent"),
                )
              : Effect.sleep(15).pipe(Effect.as<RouteCheck>("answered")),
          (route) =>
            Effect.sync(() => {
              attempts.push({ route: routeId(route), at: clock.currentTimeMillisUnsafe() - start });
              return lease;
            }),
          () => Effect.void,
          1_200,
          "tailnet",
        ).pipe(Effect.forkChild);
        yield* Deferred.await(lanStarted);
        yield* TestClock.adjust(15);
        expect(yield* Fiber.join(fiber)).toBe(lease);
        expect(attempts).toEqual([{ route: "tailnet", at: 15 }]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "still prefers a higher-ranked route when it answers ahead of the remembered route",
    () =>
      Effect.gen(function* () {
        const attempts: Array<{ route: string; at: number }> = [];
        const clock = yield* Clock.Clock;
        const start = clock.currentTimeMillisUnsafe();
        const fiber = yield* connectOverRoutes(
          entry,
          (route) =>
            Effect.sleep(routeId(route) === "lan" ? 5 : 25).pipe(Effect.as<RouteCheck>("answered")),
          (route) =>
            Effect.sync(() => {
              attempts.push({ route: routeId(route), at: clock.currentTimeMillisUnsafe() - start });
              return lease;
            }),
          () => Effect.void,
          1_200,
          "tailnet",
        ).pipe(Effect.forkChild);
        yield* TestClock.adjust(5);
        expect(yield* Fiber.join(fiber)).toBe(lease);
        expect(attempts).toEqual([{ route: "lan", at: 5 }]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "races an answering direct route immediately against an in-flight unchecked relay route",
    () =>
      Effect.gen(function* () {
        const relay = {
          target: new RelayConnectionTarget({
            environmentId: entry.target.environmentId,
            label: "Mac",
          }),
          profile: Option.none(),
        };
        const relayChecked = yield* Deferred.make<void>();
        const relayStarted = yield* Deferred.make<void>();
        const attempts: Array<{ route: string; at: number }> = [];
        const clock = yield* Clock.Clock;
        const start = clock.currentTimeMillisUnsafe();
        const fiber = yield* connectOverRoutes(
          { ...entry, alternateRoutes: [relay] },
          (route) =>
            route === relay
              ? Deferred.succeed(relayChecked, undefined).pipe(Effect.as<RouteCheck>("unchecked"))
              : Effect.sleep(250).pipe(Effect.as<RouteCheck>("answered")),
          (route) =>
            Effect.gen(function* () {
              attempts.push({
                route: route === relay ? "relay" : "lan",
                at: clock.currentTimeMillisUnsafe() - start,
              });
              if (route === relay) {
                yield* Deferred.succeed(relayStarted, undefined);
                return yield* Effect.never;
              }
              return lease;
            }),
          () => Effect.void,
          1_200,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(relayChecked);
        // At 200 ms the grace expires and relay starts.
        yield* TestClock.adjust(200);
        yield* Deferred.await(relayStarted);
        // At 250 ms the direct route answers and immediately races relay (well before 1,200 ms hedge).
        yield* TestClock.adjust(50);
        expect(yield* Fiber.join(fiber)).toBe(lease);
        expect(attempts).toEqual([
          { route: "relay", at: 200 },
          { route: "lan", at: 250 },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "starts a remembered relay route immediately while racing a direct route that answers",
    () =>
      Effect.gen(function* () {
        const relay = {
          target: new RelayConnectionTarget({
            environmentId: entry.target.environmentId,
            label: "Mac",
          }),
          profile: Option.none(),
        };
        const relayStarted = yield* Deferred.make<void>();
        const attempts: Array<{ route: string; at: number }> = [];
        const clock = yield* Clock.Clock;
        const start = clock.currentTimeMillisUnsafe();
        const fiber = yield* connectOverRoutes(
          { ...entry, alternateRoutes: [relay] },
          (route) =>
            route === relay
              ? Effect.succeed<RouteCheck>("unchecked")
              : Effect.sleep(20).pipe(Effect.as<RouteCheck>("answered")),
          (route) =>
            Effect.gen(function* () {
              attempts.push({
                route: route === relay ? "relay" : "lan",
                at: clock.currentTimeMillisUnsafe() - start,
              });
              if (route === relay) {
                yield* Deferred.succeed(relayStarted, undefined);
                return yield* Effect.never;
              }
              return lease;
            }),
          () => Effect.void,
          1_200,
          "relay",
        ).pipe(Effect.forkChild);
        yield* Deferred.await(relayStarted);
        expect(attempts).toEqual([{ route: "relay", at: 0 }]);
        yield* TestClock.adjust(20);
        expect(yield* Fiber.join(fiber)).toBe(lease);
        expect(attempts).toEqual([
          { route: "relay", at: 0 },
          { route: "lan", at: 20 },
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "remembers the winning route in ConnectionDriver across cold launch and reconnects",
    () =>
      Effect.gen(function* () {
        const saved = new Map<string, string>();
        const lanUrl = "http://192.168.1.20:3773";
        const tailnetUrl = "https://mac.tailnet.ts.net:3773";
        const multiRouteEntry: ConnectionCatalogEntry = {
          target: routes[0]!.target,
          profile: Option.some(
            new BearerConnectionProfile({
              connectionId: "lan",
              environmentId: entry.target.environmentId,
              label: "Desk",
              httpBaseUrl: lanUrl,
              wsBaseUrl: "ws://192.168.1.20:3773",
            }),
          ),
          enabled: true,
          alternateRoutes: [
            {
              target: routes[1]!.target,
              profile: Option.some(
                new BearerConnectionProfile({
                  connectionId: "tailnet",
                  environmentId: entry.target.environmentId,
                  label: "Desk",
                  httpBaseUrl: tailnetUrl,
                  wsBaseUrl: "wss://mac.tailnet.ts.net:3773",
                }),
              ),
            },
          ],
        };
        const cache = Persistence.EnvironmentCacheStore.of({
          loadShell: () => Effect.succeed(Option.none()),
          saveShell: () => Effect.void,
          loadThread: () => Effect.succeed(Option.none()),
          saveThread: () => Effect.void,
          removeThread: () => Effect.void,
          loadServerConfig: () => Effect.succeed(Option.none()),
          saveServerConfig: () => Effect.void,
          loadVcsRefs: () => Effect.succeed(Option.none()),
          saveVcsRefs: () => Effect.void,
          removeVcsRefs: () => Effect.void,
          clearVcsRefs: () => Effect.void,
          loadLastRoute: (environmentId) =>
            Effect.sync(() => Option.fromUndefinedOr(saved.get(environmentId))),
          saveLastRoute: (environmentId, id) =>
            Effect.sync(() => {
              saved.set(environmentId, id);
            }),
          clear: () => Effect.void,
        });
        const descriptorResponse = () =>
          new Response(
            JSON.stringify({
              environmentId: entry.target.environmentId,
              label: "Desk",
              platform: { os: "darwin", arch: "arm64" },
              serverVersion: "1.0.0",
              capabilities: {},
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        const tailnetChecked = yield* Deferred.make<void>();
        const savedRoute = yield* Deferred.make<string>();
        const makeDriver = () =>
          ConnectionDriver.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                Layer.succeed(Persistence.EnvironmentCacheStore, {
                  ...cache,
                  saveLastRoute: (environmentId, id) =>
                    Effect.sync(() => {
                      saved.set(environmentId, id);
                    }).pipe(Effect.andThen(Deferred.succeed(savedRoute, id)), Effect.asVoid),
                }),
                Layer.succeed(RecentEnvironmentDescriptors, {
                  remember: (url) =>
                    url === tailnetUrl
                      ? Deferred.succeed(tailnetChecked, undefined).pipe(Effect.asVoid)
                      : Effect.void,
                  recent: () => Effect.succeed(Option.none()),
                }),
                Layer.succeed(RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization, {
                  authorizeBearer: () => Effect.die("unused"),
                  authorizeDpop: () => Effect.die("unused"),
                  authorizeDpopHttp: () => Effect.die("unused"),
                  renewDpopBeforeExpiry: () => Effect.die("unused"),
                }),
                Layer.succeed(ConnectionResolver.ConnectionResolver, {
                  prepare: (route) =>
                    Effect.succeed({
                      target: route.target,
                      environmentId: route.target.environmentId,
                      label: route.target.label,
                      httpBaseUrl: routeId(route) === "lan" ? lanUrl : tailnetUrl,
                      socketUrl:
                        routeId(route) === "lan"
                          ? "ws://192.168.1.20:3773/ws"
                          : "wss://mac.tailnet.ts.net:3773/ws",
                      httpAuthorization: null,
                    } satisfies PreparedConnection),
                  prepareForUpdate: () => Effect.die("unused"),
                }),
                Layer.succeed(RpcSession.RpcSessionFactory, {
                  connect: () =>
                    Effect.succeed({
                      client: {} as WsRpcProtocolClient,
                      initialConfig: Effect.never,
                      subscribeServerConfig: () => Stream.never,
                      probe: Effect.void,
                      closed: Effect.never,
                      ready: Effect.void,
                    }),
                }),
                RpcHttp.layerRemoteHttpClient(async (input) => {
                  const url = typeof input === "string" ? input : input.toString();
                  if (url.startsWith(lanUrl)) {
                    // Never answers (dead LAN).
                    return await new Promise<Response>(() => {});
                  }
                  return descriptorResponse();
                }),
              ),
            ),
          );

        // First launch: tailnet answers, waits 200 ms grace for dead LAN, then persists "tailnet".
        const driver1 = yield* makeDriver();
        const first = yield* driver1
          .connect(multiRouteEntry, () => Effect.void)
          .pipe(Effect.forkChild);
        yield* Deferred.await(tailnetChecked);
        yield* TestClock.adjust(200);
        const lease1 = yield* Fiber.join(first);
        expect(routeId({ target: lease1.prepared.target, profile: Option.none() })).toBe("tailnet");
        expect(yield* Deferred.await(savedRoute)).toBe("tailnet");

        // Second launch (fresh driver reading persisted last route): starts tailnet with 0 ms grace.
        const driver2 = yield* makeDriver();
        const lease2 = yield* driver2.connect(multiRouteEntry, () => Effect.void);
        expect(routeId({ target: lease2.prepared.target, profile: Option.none() })).toBe("tailnet");
      }).pipe(Effect.scoped),
  );
});
