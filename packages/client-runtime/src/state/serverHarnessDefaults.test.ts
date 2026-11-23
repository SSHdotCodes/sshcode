import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProviderInstanceId,
  WS_METHODS,
  type HarnessDefaultsState,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const state = (model: string): HarnessDefaultsState => ({
  harnesses: { [ProviderInstanceId.make("codex")]: { model } },
});
const cache = Persistence.EnvironmentCacheStore.of({
  loadShell: () => Effect.succeedNone,
  saveShell: () => Effect.void,
  loadThread: () => Effect.succeedNone,
  saveThread: () => Effect.void,
  removeThread: () => Effect.void,
  loadServerConfig: () => Effect.succeedNone,
  saveServerConfig: () => Effect.void,
  loadVcsRefs: () => Effect.succeedNone,
  saveVcsRefs: () => Effect.void,
  removeVcsRefs: () => Effect.void,
  clearVcsRefs: () => Effect.void,
  clear: () => Effect.void,
});

it.effect(
  "follows live harness defaults by environment and reads a fresh snapshot after reconnecting",
  () =>
    Effect.gen(function* () {
      const makeEnvironment = Effect.fn("HarnessDefaultsTest.makeEnvironment")(function* (
        name: string,
      ) {
        const environmentId = EnvironmentId.make(name);
        const remote = yield* SubscriptionRef.make(state(name));
        const closed = yield* Deferred.make<void>();
        const makeSession = (): RpcSession => ({
          client: {
            [WS_METHODS.harnessDefaultsSubscribe]: () =>
              SubscriptionRef.changes(remote).pipe(
                Stream.ensuring(Deferred.succeed(closed, undefined)),
              ),
          } as unknown as WsRpcProtocolClient,
          initialConfig: Effect.never,
          subscribeServerConfig: () => Stream.never,
          ready: Effect.void,
          probe: Effect.void,
          closed: Effect.never,
        });
        const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
          target: new PrimaryConnectionTarget({
            environmentId,
            label: name,
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          state: yield* SubscriptionRef.make<SupervisorConnectionState>({
            ...AVAILABLE_CONNECTION_STATE,
            phase: "connected" as const,
          }),
          session: yield* SubscriptionRef.make(Option.some(makeSession())),
          prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
          connect: Effect.void,
          disconnect: Effect.void,
          retryNow: Effect.void,
        });
        return { environmentId, supervisor, remote, closed, makeSession };
      });
      const mac = yield* makeEnvironment("Mac");
      const other = yield* makeEnvironment("Other server");
      const environments = new Map([
        [mac.environmentId, mac.supervisor],
        [other.environmentId, other.supervisor],
      ]);
      const registryService = EnvironmentRegistry.EnvironmentRegistry.of({
        run: (id, effect) =>
          Effect.provideService(
            effect,
            EnvironmentSupervisor.EnvironmentSupervisor,
            environments.get(id)!,
          ),
        followStream: (id, stream) =>
          Stream.provideService(
            stream,
            EnvironmentSupervisor.EnvironmentSupervisor,
            environments.get(id)!,
          ),
      } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, registryService),
          Layer.succeed(Persistence.EnvironmentCacheStore, cache),
        ),
      );
      const atoms = createServerEnvironmentAtoms(runtime, {
        initialConfigValueAtom: () => Atom.make<ServerConfig | null>(null),
      });
      const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
        Effect.sync(() => registry.dispose()),
      );
      const macAtom = atoms.harnessDefaultsState({ environmentId: mac.environmentId, input: {} });
      const otherAtom = atoms.harnessDefaultsState({
        environmentId: other.environmentId,
        input: {},
      });
      yield* AtomRegistry.mount(registry, macAtom);
      yield* AtomRegistry.mount(registry, otherAtom);
      const read = (atom: typeof macAtom, text: string) =>
        AtomRegistry.toStream(registry, atom).pipe(
          Stream.filter(
            (result) =>
              AsyncResult.isSuccess(result) &&
              result.value.harnesses[ProviderInstanceId.make("codex")]?.model === text,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
      expect(successfulState(yield* read(macAtom, "Mac"))).toEqual(state("Mac"));
      expect(successfulState(yield* read(otherAtom, "Other server"))).toEqual(
        state("Other server"),
      );
      yield* SubscriptionRef.set(mac.remote, state("Captured from the phone"));
      expect(successfulState(yield* read(macAtom, "Captured from the phone"))).toEqual(
        state("Captured from the phone"),
      );
      expect(successfulState(registry.get(otherAtom))).toEqual(state("Other server"));

      yield* SubscriptionRef.set(mac.supervisor.session, Option.none());
      yield* Deferred.await(mac.closed);
      yield* SubscriptionRef.set(mac.remote, state("Edited while disconnected"));
      yield* SubscriptionRef.set(mac.supervisor.session, Option.some(mac.makeSession()));
      expect(successfulState(yield* read(macAtom, "Edited while disconnected"))).toEqual(
        state("Edited while disconnected"),
      );
    }).pipe(Effect.scoped),
);

function successfulState<E>(result: AsyncResult.AsyncResult<HarnessDefaultsState, E>) {
  return Option.getOrThrow(AsyncResult.value(result));
}
