import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { Atom, AtomRegistry } from "effect/reactivity";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createEnvironmentShellAtoms, type EnvironmentShellState } from "./shell.ts";
import { ShellSnapshotLoader } from "./shellSnapshotHttp.ts";
import { v2ShellSnapshot } from "./orchestrationV2TestFixtures.ts";

it.effect.each([false, true])(
  "retains complete rows and reads the preview once across refreshes with app-owned omission %s",
  (omitChildren) =>
    Effect.gen(function* () {
      const id = EnvironmentId.make("refresh");
      const events = yield* Queue.unbounded<OrchestrationV2ShellStreamItem>();
      const inputs = yield* Queue.unbounded<{ afterSequence?: number }>();
      let previews = 0;
      let reads = 0;
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.subscribeShell]: (input: { afterSequence?: number }) =>
          Stream.fromEffect(Queue.offer(inputs, input)).pipe(
            Stream.drain,
            Stream.concat(Stream.fromQueue(events)),
          ),
      } as unknown as WsRpcProtocolClient;
      const selection = omitChildren
        ? { idleSubagentsOmitted: true as const, idleAppOwnedSubagentsOmitted: true as const }
        : {};
      const session: RpcSession = {
        client,
        initialConfig: Effect.succeed({
          shellResumeCompletionMarker: true,
          shellThreadFamilies: omitChildren,
          shellAppOwnedSubagentOmission: omitChildren,
        } as never),
        subscribeServerConfig: (input) => client.subscribeServerConfig(input),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const target = new PrimaryConnectionTarget({
        environmentId: id,
        label: "Refresh",
        httpBaseUrl: "https://refresh.test",
        wsBaseUrl: "wss://refresh.test/ws",
      });
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
          Option.some({
            target,
            environmentId: id,
            label: target.label,
            httpBaseUrl: target.httpBaseUrl,
            socketUrl: target.wsBaseUrl,
            httpAuthorization: null,
          }),
        ),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShellPreview: () =>
          Effect.sync(() => {
            previews++;
            return Option.some({ ...v2ShellSnapshot, snapshotSequence: 77, threads: [] });
          }),
        yieldAfterShellPreview: Effect.void,
        loadShell: () =>
          Effect.sync(() => {
            reads++;
            return Option.some({ ...v2ShellSnapshot, ...selection, snapshotSequence: 5 });
          }),
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
      const runtime = Atom.runtime(
        Layer.mergeAll(
          Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, {
            followStream: (
              _id: EnvironmentId,
              stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor.EnvironmentSupervisor>,
            ) =>
              Stream.provideService(
                stream,
                EnvironmentSupervisor.EnvironmentSupervisor,
                supervisor,
              ),
          } as never),
          Layer.succeed(Persistence.EnvironmentCacheStore, cache),
          Layer.succeed(ShellSnapshotLoader, {
            resumeCachedSnapshot: true,
            load: () => Effect.die("Warm refresh should resume complete rows"),
          }),
        ),
      );
      const atoms = createEnvironmentShellAtoms(runtime);
      const registry = yield* Effect.acquireRelease(
        Effect.sync(() => AtomRegistry.make()),
        (registry) => Effect.sync(() => registry.dispose()),
      );
      const value = atoms.stateValueAtom(id);
      const wait = (predicate: (state: EnvironmentShellState) => boolean) =>
        Effect.gen(function* () {
          const done = yield* Deferred.make<EnvironmentShellState>();
          const observe = (state: EnvironmentShellState) => {
            if (predicate(state)) Deferred.doneUnsafe(done, Effect.succeed(state));
          };
          const unsubscribe = registry.subscribe(value, observe);
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
          observe(registry.get(value));
          return yield* Deferred.await(done);
        });
      const release = registry.mount(value);
      yield* Effect.addFinalizer(() => Effect.sync(release));
      expect((yield* Queue.take(inputs)).afterSequence).toBe(5);
      yield* Queue.offer(events, { kind: "synchronized" });
      yield* wait((state) => state.status === "live");
      yield* Queue.offer(events, {
        kind: "thread.updated",
        sequence: 6,
        location: "active",
        thread: { ...v2ShellSnapshot.threads[0]!, title: "Latest live title" },
      });
      yield* wait((state) =>
        Option.exists(state.snapshot, (snapshot) => snapshot.snapshotSequence === 6),
      );
      const retained = Option.getOrThrow(registry.get(value).snapshot).threads;
      for (let round = 0; round < 2; round++) {
        const seen: EnvironmentShellState[] = [];
        const unsubscribe = registry.subscribe(value, (state) => seen.push(state));
        registry.refresh(atoms.stateAtom(id));
        expect((yield* Queue.take(inputs)).afterSequence).toBe(6);
        expect(previews).toBe(1);
        expect(reads).toBe(1);
        expect(
          seen.every((state) =>
            Option.exists(
              state.snapshot,
              (snapshot) => snapshot.threads[0]?.title === "Latest live title",
            ),
          ),
        ).toBe(true);
        yield* Queue.offer(events, { kind: "synchronized" });
        yield* wait((state) => state.status === "live");
        expect(Option.getOrThrow(registry.get(value).snapshot).threads).toBe(retained);
        unsubscribe();
      }
    }).pipe(Effect.scoped),
);
