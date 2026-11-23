import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as RpcSession from "../rpc/session.ts";
import { ASSET_URL_MAX_IN_FLIGHT, createAssetEnvironmentAtoms } from "./assets.ts";

/**
 * Environments whose `assets.createUrl` never answers until the test releases a call.
 * `started` receives the environment of each call as it begins, and `inFlight` counts
 * calls that have begun and not yet been released or interrupted.
 */
const makeAssetUrlHarness = Effect.fn("TestAssetUrl.makeHarness")(function* (
  environmentIds: ReadonlyArray<EnvironmentId>,
) {
  const started = yield* Queue.unbounded<EnvironmentId>();
  const inFlight = new Map<EnvironmentId, number>();
  const maxInFlight = new Map<EnvironmentId, number>();
  const releases = new Map<EnvironmentId, Queue.Queue<void>>();
  const supervisors = new Map<
    EnvironmentId,
    EnvironmentSupervisor.EnvironmentSupervisor["Service"]
  >();
  const sessions = new Map<
    EnvironmentId,
    SubscriptionRef.SubscriptionRef<Option.Option<RpcSession.RpcSession>>
  >();
  const makeSession = (environmentId: EnvironmentId) =>
    ({
      client: {
        [WS_METHODS.assetsCreateUrl]: () =>
          Effect.gen(function* () {
            const now = (inFlight.get(environmentId) ?? 0) + 1;
            inFlight.set(environmentId, now);
            maxInFlight.set(environmentId, Math.max(maxInFlight.get(environmentId) ?? 0, now));
            yield* Queue.offer(started, environmentId);
            yield* Queue.take(releases.get(environmentId)!);
            return { relativeUrl: "/api/assets/token/image.png", expiresAt: 4_000_000_000_000 };
          }).pipe(
            Effect.ensuring(
              Effect.sync(() =>
                inFlight.set(environmentId, (inFlight.get(environmentId) ?? 1) - 1),
              ),
            ),
          ),
      },
    }) as unknown as RpcSession.RpcSession;
  for (const environmentId of environmentIds) {
    releases.set(environmentId, yield* Queue.unbounded<void>());
    const session = yield* SubscriptionRef.make(Option.some(makeSession(environmentId)));
    sessions.set(environmentId, session);
    supervisors.set(
      environmentId,
      EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: new PrimaryConnectionTarget({
          environmentId,
          label: environmentId,
          httpBaseUrl: "https://assets.example.test",
          wsBaseUrl: "wss://assets.example.test",
        }),
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          desired: true,
          network: "online",
          phase: "connected",
          attempt: 1,
          generation: 1,
        }),
        session,
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]),
    );
  }
  const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (environmentId, effect) =>
    Effect.provideService(
      effect,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisors.get(environmentId)!,
    );
  const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
    environmentId,
    stream,
  ) =>
    Stream.provideService(
      stream,
      EnvironmentSupervisor.EnvironmentSupervisor,
      supervisors.get(environmentId)!,
    );
  const environmentRegistry = EnvironmentRegistry.EnvironmentRegistry.of({
    run,
    followStream,
  } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  const atoms = createAssetEnvironmentAtoms(
    Atom.runtime(Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environmentRegistry)),
  );
  return {
    started,
    inFlight: (environmentId: EnvironmentId) => inFlight.get(environmentId) ?? 0,
    maxInFlight: (environmentId: EnvironmentId) => maxInFlight.get(environmentId) ?? 0,
    release: (environmentId: EnvironmentId) => Queue.offer(releases.get(environmentId)!, undefined),
    replaceSession: (environmentId: EnvironmentId) =>
      SubscriptionRef.set(sessions.get(environmentId)!, Option.some(makeSession(environmentId))),
    mountImages: (environmentId: EnvironmentId, count: number) => {
      for (let index = 0; index < count; index += 1) {
        registry.mount(
          atoms.createUrl({
            environmentId,
            input: { resource: { _tag: "attachment", attachmentId: `image-${index}` } },
          }),
        );
      }
    },
  };
});

describe("asset URL requests", () => {
  const remote = EnvironmentId.make("asset-remote");
  const other = EnvironmentId.make("asset-other");

  it.effect("keeps a thread of images from flooding one environment with requests", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeAssetUrlHarness([remote]);
        const total = ASSET_URL_MAX_IN_FLIGHT * 3;
        harness.mountImages(remote, total);

        for (let call = 0; call < ASSET_URL_MAX_IN_FLIGHT; call += 1) {
          yield* Queue.take(harness.started);
        }
        expect(harness.inFlight(remote)).toBe(ASSET_URL_MAX_IN_FLIGHT);

        // Each answer admits the next waiting request.
        for (let call = 0; call < total; call += 1) {
          yield* harness.release(remote);
          if (call < total - ASSET_URL_MAX_IN_FLIGHT) yield* Queue.take(harness.started);
        }
        expect(harness.maxInFlight(remote)).toBe(ASSET_URL_MAX_IN_FLIGHT);
      }),
    ),
  );

  it.effect("limits each environment on its own", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeAssetUrlHarness([remote, other]);
        harness.mountImages(remote, ASSET_URL_MAX_IN_FLIGHT + 2);
        for (let call = 0; call < ASSET_URL_MAX_IN_FLIGHT; call += 1) {
          yield* Queue.take(harness.started);
        }
        harness.mountImages(other, 1);
        expect(yield* Queue.take(harness.started)).toBe(other);
        expect(harness.inFlight(remote)).toBe(ASSET_URL_MAX_IN_FLIGHT);
      }),
    ),
  );

  it.effect("frees the limit when the session behind the requests is replaced", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeAssetUrlHarness([remote]);
        harness.mountImages(remote, ASSET_URL_MAX_IN_FLIGHT * 2);
        for (let call = 0; call < ASSET_URL_MAX_IN_FLIGHT; call += 1) {
          yield* Queue.take(harness.started);
        }

        yield* harness.replaceSession(remote);
        for (let call = 0; call < ASSET_URL_MAX_IN_FLIGHT; call += 1) {
          yield* Queue.take(harness.started);
        }
        expect(harness.maxInFlight(remote)).toBe(ASSET_URL_MAX_IN_FLIGHT);
      }),
    ),
  );
});
