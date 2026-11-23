import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ServerSettingsError,
  WS_METHODS,
  type AgentToolsState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import { createAgentToolsAtoms } from "./agentTools.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "./connection/model.ts";
import * as EnvironmentRegistry from "./connection/registry.ts";
import * as EnvironmentSupervisor from "./connection/supervisor.ts";
import type { WsRpcProtocolClient } from "./rpc/protocol.ts";
import type { RpcSession } from "./rpc/session.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("agent-tools-environment"),
  label: "Agent tools environment",
  httpBaseUrl: "https://agent-tools.example.test",
  wsBaseUrl: "wss://agent-tools.example.test",
});

const makeState = (enabled: boolean, toolName: string): AgentToolsState => ({
  policy: { enabled, tools: {}, providers: {} },
  tools: [
    {
      name: toolName,
      title: toolName,
      description: `${toolName} description.`,
      group: "Test",
      readonly: false,
    },
  ],
});

const ACKNOWLEDGED = makeState(false, "acknowledged");
const SUPERSEDED = makeState(false, "superseded");
const FRESH = makeState(true, "fresh");

const makeHarness = <E>(read: (request: number) => Effect.Effect<AgentToolsState, E>) =>
  Effect.gen(function* () {
    const starts = yield* Queue.unbounded<number>();
    let requests = 0;
    const client = {
      [WS_METHODS.serverGetAgentTools]: () =>
        Effect.gen(function* () {
          requests += 1;
          const request = requests;
          yield* Queue.offer(starts, request);
          return yield* read(request);
        }),
    } as unknown as WsRpcProtocolClient;
    const session = { client } as unknown as RpcSession;
    const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
      target: TARGET,
      state: yield* SubscriptionRef.make<SupervisorConnectionState>({
        ...AVAILABLE_CONNECTION_STATE,
        phase: "connected",
      }),
      session: yield* SubscriptionRef.make(Option.some(session)),
      prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
      connect: Effect.void,
      disconnect: Effect.void,
      retryNow: Effect.void,
    });
    const environments = EnvironmentRegistry.EnvironmentRegistry.of({
      run: (_environmentId, effect) =>
        Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      followStream: (_environmentId, stream) =>
        Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
    const runtime = Atom.runtime(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
    );
    const settingsValueAtom = Atom.make(null);
    const atoms = createAgentToolsAtoms(runtime, {
      settingsValueAtom: () => settingsValueAtom,
    });
    const registry = yield* Effect.acquireRelease(Effect.sync(AtomRegistry.make), (registry) =>
      Effect.sync(() => registry.dispose()),
    );
    const state = atoms.state({ environmentId: TARGET.environmentId, input: {} });
    const unmount = registry.mount(state);
    yield* Effect.addFinalizer(() => Effect.sync(unmount));

    return {
      atoms,
      registry,
      state,
      nextStart: Queue.take(starts),
      refresh: () =>
        atoms.refresh.run(registry, { environmentId: TARGET.environmentId, input: {} }),
    };
  });

describe("agent tools refresh command", () => {
  it.effect("waits for the new RPC result and ignores an older in-flight response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const finishSuperseded = yield* Deferred.make<void>();
        const finishFresh = yield* Deferred.make<void>();
        const harness = yield* makeHarness((request) => {
          switch (request) {
            case 1:
              return Effect.succeed(ACKNOWLEDGED);
            case 2:
              return Deferred.await(finishSuperseded).pipe(Effect.as(SUPERSEDED));
            case 3:
              return Deferred.await(finishFresh).pipe(Effect.as(FRESH));
            default:
              return Effect.die(new Error(`Unexpected agent tools request ${request}`));
          }
        });

        expect(yield* harness.nextStart).toBe(1);
        expect(
          yield* AtomRegistry.getResult(harness.registry, harness.state, {
            suspendOnWaiting: true,
          }),
        ).toEqual(ACKNOWLEDGED);

        harness.registry.refresh(harness.state);
        expect(yield* harness.nextStart).toBe(2);
        const refresh = yield* Effect.forkChild(Effect.promise(harness.refresh));
        expect(yield* harness.nextStart).toBe(3);

        yield* Deferred.succeed(finishFresh, undefined);
        expect(yield* Fiber.join(refresh)).toMatchObject({
          _tag: "Success",
          value: FRESH,
          waiting: false,
        });
        expect(harness.registry.get(harness.state)).toMatchObject({
          _tag: "Success",
          value: FRESH,
          waiting: false,
        });

        yield* Deferred.succeed(finishSuperseded, undefined);
        yield* Effect.yieldNow;
        expect(harness.registry.get(harness.state)).toMatchObject({
          _tag: "Success",
          value: FRESH,
          waiting: false,
        });
      }),
    ),
  );

  it.effect("reports a refresh failure while the query retains its previous success", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failure = new ServerSettingsError({
          settingsPath: "/settings.json",
          operation: "read-file",
        });
        const harness = yield* makeHarness((request) => {
          switch (request) {
            case 1:
              return Effect.succeed(ACKNOWLEDGED);
            case 2:
              return Effect.fail(failure);
            default:
              return Effect.die(new Error(`Unexpected agent tools request ${request}`));
          }
        });

        expect(yield* harness.nextStart).toBe(1);
        expect(
          yield* AtomRegistry.getResult(harness.registry, harness.state, {
            suspendOnWaiting: true,
          }),
        ).toEqual(ACKNOWLEDGED);

        const refreshed = yield* Effect.promise(harness.refresh);
        expect(refreshed._tag).toBe("Failure");
        if (refreshed._tag === "Failure") {
          expect(refreshed.waiting).toBe(false);
          expect(Cause.squash(refreshed.cause)).toBe(failure);
        }

        const current = harness.registry.get(harness.state);
        expect(AsyncResult.isFailure(current)).toBe(true);
        expect(current.waiting).toBe(false);
        expect(AsyncResult.value(current)).toEqual(Option.some(ACKNOWLEDGED));
        if (AsyncResult.isFailure(current)) {
          expect(Cause.squash(current.cause)).toBe(failure);
          expect(Option.map(current.previousSuccess, (previous) => previous.value)).toEqual(
            Option.some(ACKNOWLEDGED),
          );
        }
      }),
    ),
  );
});
