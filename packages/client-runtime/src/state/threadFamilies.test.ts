import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  OrchestrationV2GetShellSnapshotError,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
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
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "./shell.ts";
import {
  createThreadFamilyAtoms,
  threadFamilyRead,
  threadFamilyRowsMissingFromShell,
} from "./threadFamilies.ts";

import { pendingSubagentRequestsByThread } from "./threadShell.ts";

const row = (id: string, title = id, parent?: string, root = "parent") =>
  ({
    id: ThreadId.make(id),
    title,
    createdBy: parent === undefined ? "user" : "agent",
    creationSource: parent === undefined ? "web" : "mcp",
    lineage: {
      parentThreadId: parent === undefined ? null : ThreadId.make(parent),
      relationshipToParent: parent === undefined ? null : "subagent",
      rootThreadId: ThreadId.make(root),
    },
    status: "completed",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
  }) as unknown as OrchestrationV2ThreadShell;

describe("threadFamilyRowsMissingFromShell", () => {
  it("adds only the rows the shell left out, once, with shell rows winning", () => {
    const missing = threadFamilyRowsMissingFromShell({
      shellThreads: [row("parent"), row("live", "live from shell")],
      families: [
        { snapshotSequence: 4, threads: [row("live", "stale family copy"), row("idle")] },
        { snapshotSequence: 6, threads: [row("idle", "newer family title"), row("other")] },
      ],
      removedAt: new Map(),
    });
    expect(missing.map((thread) => thread.id)).toEqual(["idle", "other"]);
    expect(missing[0]?.title).toBe("newer family title");
  });

  it("drops a family copy read before the shell removed that thread", () => {
    const missing = threadFamilyRowsMissingFromShell({
      shellThreads: [],
      families: [
        {
          snapshotSequence: 5,
          threads: [row("archived-after-read"), row("removed-before-read")],
        },
      ],
      removedAt: new Map([
        [ThreadId.make("archived-after-read"), 7],
        [ThreadId.make("removed-before-read"), 3],
      ]),
    });
    expect(missing.map((thread) => thread.id)).toEqual(["removed-before-read"]);
  });
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-family"),
  label: "Family environment",
  httpBaseUrl: "https://family.example.test",
  wsBaseUrl: "wss://family.example.test",
});

describe("createThreadFamilyAtoms", () => {
  it("only looks for missing ancestors when omitted rows or removals change", () => {
    let visits = 0;
    const parent = row("parent");
    const snapshot = {
      schemaVersion: 1 as const,
      snapshotSequence: 1,
      idleAppOwnedSubagentsOmitted: true as const,
      projects: [],
      archivedThreads: [],
      threads: [
        {
          ...parent,
          // The ancestor walk reads a row's status before anything else.
          get status() {
            visits++;
            return parent.status;
          },
        },
      ],
    };
    const state = { ...EMPTY_SHELL_STATE, snapshot: Option.some(snapshot) };
    const source = Atom.make<AsyncResult.AsyncResult<EnvironmentShellState>>(
      AsyncResult.success(state),
    );
    const families = createThreadFamilyAtoms(
      Atom.runtime(
        Layer.effect(EnvironmentRegistry.EnvironmentRegistry, Effect.die("unexpected read")),
      ),
      () => source,
    );
    const registry = AtomRegistry.make();
    const merged = families.snapshotAtom(TARGET.environmentId);
    registry.mount(merged);
    expect(registry.get(merged)?.snapshotSequence).toBe(1);
    expect(visits).toBeGreaterThan(0);
    visits = 0;
    registry.set(
      source,
      AsyncResult.success({
        ...state,
        snapshot: Option.some({ ...snapshot, snapshotSequence: 2 }),
      }),
    );
    expect(registry.get(merged)?.snapshotSequence).toBe(2);
    expect(visits).toBe(0);
    registry.set(source, AsyncResult.success({ ...state, removedAt: new Map([[parent.id, 3]]) }));
    registry.get(merged);
    expect(visits).toBeGreaterThan(0);
    registry.dispose();
  });

  it.effect.each([true, false])(
    "reads families only when the server advertises support: %s",
    (supported) =>
      Effect.scoped(
        Effect.gen(function* () {
          const replies =
            yield* Queue.unbounded<
              Effect.Effect<OrchestrationV2ThreadFamily, OrchestrationV2GetShellSnapshotError>
            >();
          const client = {
            [ORCHESTRATION_V2_WS_METHODS.getThreadFamily]: () =>
              Effect.flatten(Queue.take(replies)),
          } as unknown as WsRpcProtocolClient;
          const session = {
            client,
            initialConfig: Effect.succeed(
              (supported ? { shellThreadFamilies: true } : {}) as never,
            ),
            ready: Effect.void,
            probe: Effect.void,
            closed: Effect.never,
          } as unknown as RpcSession.RpcSession;
          const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
            target: TARGET,
            state: yield* SubscriptionRef.make<SupervisorConnectionState>({
              ...AVAILABLE_CONNECTION_STATE,
              desired: true,
              network: "online",
              phase: "connected",
              attempt: 1,
              generation: 1,
            }),
            session: yield* SubscriptionRef.make(Option.some(session)),
            prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
            connect: Effect.void,
            disconnect: Effect.void,
            retryNow: Effect.void,
          } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
          const run: EnvironmentRegistry.EnvironmentRegistry["Service"]["run"] = (
            _environmentId,
            effect,
          ) =>
            Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
          const followStream: EnvironmentRegistry.EnvironmentRegistry["Service"]["followStream"] = (
            _environmentId,
            stream,
          ) =>
            Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor);
          const runtime = Atom.runtime(
            Layer.succeed(
              EnvironmentRegistry.EnvironmentRegistry,
              EnvironmentRegistry.EnvironmentRegistry.of({
                run,
                followStream,
              } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"]),
            ),
          );
          const parent = row("parent");
          const child = row("idle-child", "Finished app-owned child", "parent");
          const shellSnapshot = {
            schemaVersion: 1,
            snapshotSequence: 3,
            projects: [],
            threads: [parent],
            archivedThreads: [],
          } as OrchestrationV2ShellSnapshot;
          const shellAt = (generation: number): EnvironmentShellState => ({
            ...EMPTY_SHELL_STATE,
            status: "live",
            snapshot: Option.some(shellSnapshot),
            generation,
          });
          const shellState = Atom.make<AsyncResult.AsyncResult<EnvironmentShellState>>(
            AsyncResult.success(shellAt(0)),
          );
          const families = createThreadFamilyAtoms(runtime, () => shellState);
          const registry = yield* Effect.acquireRelease(
            Effect.sync(AtomRegistry.make),
            (registry) => Effect.sync(() => registry.dispose()),
          );
          const family = families.familyAtom(TARGET.environmentId, parent.id);
          const mergedIds = () =>
            registry.get(families.snapshotAtom(TARGET.environmentId))?.threads.map(({ id }) => id);
          // Waits for the read to finish either way; the assertions read its outcome.
          const settle = AtomRegistry.getResult(registry, family, { suspendOnWaiting: true }).pipe(
            Effect.ignore,
            Effect.tap(() => Effect.yieldNow),
          );
          registry.mount(families.snapshotAtom(TARGET.environmentId));
          const release = families.mount(registry, TARGET.environmentId, parent.id);

          // A cached shell from before this session's first snapshot reads nothing.
          expect(threadFamilyRead(registry.get(family))).toBe("pending");
          expect(yield* Queue.size(replies)).toBe(0);

          registry.set(shellState, AsyncResult.success(shellAt(1)));
          if (!supported) {
            yield* settle;
            expect(threadFamilyRead(registry.get(family))).toBe("settled");
            expect(mergedIds()).toEqual(["parent"]);
            expect(yield* Queue.size(replies)).toBe(0);
            return;
          }

          yield* Queue.offer(replies, Effect.succeed({ snapshotSequence: 3, threads: [child] }));
          yield* settle;
          expect(threadFamilyRead(registry.get(family))).toBe("settled");
          expect(mergedIds()).toEqual(["parent", "idle-child"]);

          // A new authoritative snapshot never reuses the old read, even while the next one waits
          // or fails.
          registry.set(shellState, AsyncResult.success(shellAt(2)));
          expect(threadFamilyRead(registry.get(family))).toBe("pending");
          expect(mergedIds()).toEqual(["parent"]);
          yield* Queue.offer(
            replies,
            Effect.fail(new OrchestrationV2GetShellSnapshotError({ message: "read failed" })),
          );
          yield* settle;
          expect(threadFamilyRead(registry.get(family))).toBe("failed");
          expect(mergedIds()).toEqual(["parent"]);

          families.refresh(registry, TARGET.environmentId, parent.id);
          expect(threadFamilyRead(registry.get(family))).toBe("pending");
          yield* Queue.offer(replies, Effect.succeed({ snapshotSequence: 5, threads: [child] }));
          yield* settle;
          expect(threadFamilyRead(registry.get(family))).toBe("settled");
          expect(mergedIds()).toEqual(["parent", "idle-child"]);

          // At the next cold snapshot the whole idle branch is absent. A delta may wake the
          // grandchild without updating its intermediate parent.
          release();
          const grandchild = {
            ...row("woken", "Woken app-owned child", "idle-child"),
            status: "running" as const,
            activityRunStatus: "running" as const,
          };
          registry.set(
            shellState,
            AsyncResult.success({
              ...shellAt(3),
              snapshot: Option.some({
                ...shellSnapshot,
                snapshotSequence: 7,
                idleAppOwnedSubagentsOmitted: true,
                threads: [parent, grandchild],
              }),
            }),
          );
          expect(mergedIds()).toEqual(["parent", "woken"]);
          yield* Queue.offer(
            replies,
            Effect.succeed({ snapshotSequence: 7, threads: [child, grandchild] }),
          );
          yield* settle;
          expect(mergedIds()).toEqual(["parent", "woken", "idle-child"]);

          // An earlier delta restored the middle chat, but its idle parent is still omitted.
          const middle = row("middle", "Already in the shell", "idle-child");
          const waiting = {
            ...row("waiting", "Needs approval", "middle"),
            activityRunStatus: "waiting" as const,
            pendingRuntimeRequest: {
              id: RuntimeRequestId.make("request"),
              kind: "command" as const,
              createdAt: DateTime.makeUnsafe(0),
            },
          };
          registry.set(
            shellState,
            AsyncResult.success({
              ...shellAt(4),
              snapshot: Option.some({
                ...shellSnapshot,
                idleAppOwnedSubagentsOmitted: true,
                threads: [parent, middle, waiting],
              }),
            }),
          );
          yield* Queue.offer(
            replies,
            Effect.succeed({ snapshotSequence: 8, threads: [child, middle, waiting] }),
          );
          yield* settle;
          const rows = registry.get(families.snapshotAtom(TARGET.environmentId))!.threads;
          expect(pendingSubagentRequestsByThread(rows).get(parent.id)).toBe("approval");
        }),
      ),
  );
});
