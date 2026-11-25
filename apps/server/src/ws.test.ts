import * as AcpRegistrySessions from "./provider/AcpRegistrySessions.ts";
import {
  v2Projection,
  v2ThreadShell,
} from "../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";
import {
  THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES,
  THREAD_RESUME_MAX_SOURCE_EVENTS,
} from "./orchestration-v2/ThreadStream.ts";
import { assert, expectTypeOf, it } from "@effect/vitest";
import {
  ORCHESTRATION_PROTOCOL_VERSION,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  WS_METHODS,
  WsRpcGroup,
  NativeSessionError,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationProjectShell,
  type ServerConfig,
  type ServerConfigStreamEvent,
} from "@t3tools/contracts";
import * as RpcTest from "effect/rpc/RpcTest";
import type * as Cause from "effect/Cause";
import { LIVE_STREAM_MAX_ITEMS } from "./orchestration-v2/LiveStreamBudget.ts";
import * as RpcAuthorization from "./auth/RpcAuthorization.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ProjectEnrichment from "./project/ProjectEnrichmentService.ts";
import type * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as EventLogCompaction from "./orchestration-v2/EventLogCompaction.ts";
import * as ChatTabs from "./sessionBoxes/chatTabs.ts";
import * as ScheduledTaskShells from "./scheduledTasks/ScheduledTaskShells.ts";
import {
  boxNamerCache,
  lookupBoxNaming,
  shellDecorationCursor,
} from "./sessionBoxes/boxNamerCache.ts";
import {
  layer,
  layerWsRpc,
  nativeSessionRpcHandlers,
  hasCompatibleOrchestrationProtocol,
  resolveAvailableEditorsForConfig,
  shouldUseBoundedThreadSnapshot,
  subscribeOrchestrationV2Shell,
  subscribeOrchestrationV2Thread,
  withLateEditorConfig,
} from "./ws.ts";

it("keeps websocket layer requirements checked", () => {
  type IsAny<T> = 0 extends 1 & T ? true : false;
  type Requirements = Layer.Services<ReturnType<typeof layerWsRpc>>;
  expectTypeOf<IsAny<Requirements>>().toEqualTypeOf<false>();
  expectTypeOf<IsAny<Layer.Services<typeof layer>>>().toEqualTypeOf<false>();
  expectTypeOf<
    ProjectEnrichment.ProjectEnrichmentService extends Requirements ? true : false
  >().toEqualTypeOf<true>();
  expectTypeOf<
    TraceDiagnostics.TraceDiagnostics extends Requirements ? true : false
  >().toEqualTypeOf<true>();
  expectTypeOf<FileSystem.FileSystem extends Requirements ? true : false>().toEqualTypeOf<true>();
});

it("accepts only the current orchestration protocol before websocket RPC setup", () => {
  assert.isTrue(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`),
    ),
  );
  assert.isFalse(hasCompatibleOrchestrationProtocol(new URL("https://host.test/ws")));
  assert.isFalse(
    hasCompatibleOrchestrationProtocol(
      new URL(`https://host.test/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION - 1}`),
    ),
  );
});

it("keeps full thread snapshot fallback unless the client opts into bounded history", () => {
  assert.isFalse(shouldUseBoundedThreadSnapshot({}));
  assert.isFalse(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: false }));
  assert.isTrue(shouldUseBoundedThreadSnapshot({ acceptBoundedSnapshot: true }));
});

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

// Only the fields the late-editor fold reads or rewrites.
const snapshotConfig = (fields: Partial<ServerConfig>) =>
  ({ availableEditors: [], settings: {}, ...fields }) as unknown as ServerConfig;

const settingsUpdated = (settings: object): ServerConfigStreamEvent => ({
  version: 1,
  type: "settingsUpdated",
  payload: { settings: settings as ServerConfig["settings"] },
});

it.effect("resends late editors without rolling back updates already sent", () =>
  Effect.gen(function* () {
    const settingsSent = yield* Deferred.make<void>();
    const events = yield* withLateEditorConfig(
      snapshotConfig({ settings: { enableProviderUpdateChecks: true } as never }),
      Stream.make(settingsUpdated({ enableProviderUpdateChecks: false })),
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        // Holds the late snapshot until the settings change has gone out.
        resolveFileManagerRevealKind: () =>
          Deferred.await(settingsSent).pipe(Effect.as("file-explorer" as const)),
      },
    ).pipe(
      Stream.tap((event) =>
        event.type === "settingsUpdated" ? Deferred.succeed(settingsSent, undefined) : Effect.void,
      ),
      Stream.runCollect,
    );

    const [first, second] = Array.from(events);
    assert.equal(events.length, 2);
    assert.equal(first?.type, "settingsUpdated");
    assert.equal(second?.type, "snapshot");
    if (second?.type === "snapshot") {
      assert.deepEqual(second.config.availableEditors, ["file-manager"]);
      assert.equal(second.config.shellRevealInFileManagerKind, "file-explorer");
      assert.deepEqual(second.config.settings, { enableProviderUpdateChecks: false } as never);
    }
  }),
);

it.effect("sends no late snapshot when the scan matches the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["vscode"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["vscode"]),
        resolveFileManagerRevealKind: () => Effect.succeed(undefined),
      },
    ).pipe(Stream.runCollect);

    assert.equal(events.length, 0);
  }),
);

it.effect("resends a file manager reveal kind that missed the snapshot", () =>
  Effect.gen(function* () {
    const events = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: () => Effect.succeed("file-explorer"),
      },
    ).pipe(Stream.runCollect);

    const [late] = Array.from(events);
    assert.equal(events.length, 1);
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }),
);

// The real launcher on Windows over a filesystem whose probes park until
// released, like a host too busy to finish discovery inside the snapshot timeout.
const makeParkedWindowsLauncher = Effect.gen(function* () {
  const parkedProbes = yield* Queue.unbounded<void>();
  const release = yield* Deferred.make<void>();
  const launcher = yield* ExternalLauncher.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        FileSystem.layerNoop({
          stat: () =>
            Queue.offer(parkedProbes, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ type: "File" } as FileSystem.File.Info),
            ),
        }),
        Path.layer,
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected spawn")),
        ),
      ),
    ),
  );
  const onWindows = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({
            env: { PATH: "C:\\t3-late-editors-test", PATHEXT: ".EXE" },
          }),
        ),
      ),
    );
  return {
    editors: {
      resolveAvailableEditors: () => onWindows(launcher.resolveAvailableEditors()),
      resolveFileManagerRevealKind: () => onWindows(launcher.resolveFileManagerRevealKind()),
    },
    probeParked: Queue.take(parkedProbes),
    releaseProbes: Deferred.succeed(release, undefined),
  };
});

it.effect("recovers editors after a real scan outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    const snapshotFiber = yield* resolveAvailableEditorsForConfig(
      editors.resolveAvailableEditors(),
    ).pipe(Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(5));
    const snapshotEditors = yield* Fiber.join(snapshotFiber);
    assert.deepEqual(snapshotEditors, []);

    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: snapshotEditors }),
      Stream.empty,
      editors,
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.availableEditors.includes("vscode"), true);
    }
  }).pipe(Effect.scoped),
);

it.effect("recovers a reveal kind whose real probe outlasts the config timeout", () =>
  Effect.gen(function* () {
    const { editors, probeParked, releaseProbes } = yield* makeParkedWindowsLauncher;

    // The snapshot's bounded probe timed out: file manager, but no reveal kind.
    const lateFiber = yield* withLateEditorConfig(
      snapshotConfig({ availableEditors: ["file-manager"] }),
      Stream.empty,
      {
        resolveAvailableEditors: () => Effect.succeed(["file-manager"]),
        resolveFileManagerRevealKind: editors.resolveFileManagerRevealKind,
      },
    ).pipe(Stream.runCollect, Effect.forkChild);
    yield* probeParked;
    yield* TestClock.adjust(Duration.seconds(6));
    yield* releaseProbes;

    const [late] = Array.from(yield* Fiber.join(lateFiber));
    assert.equal(late?.type, "snapshot");
    if (late?.type === "snapshot") {
      assert.equal(late.config.shellRevealInFileManagerKind, "file-explorer");
    }
  }).pipe(Effect.scoped),
);

const ReplayTestLayer = Layer.merge(
  OrchestrationEventStore.layer,
  EventLogCompaction.layerCursorMemory(),
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

it.live.each(["thread", "shell"] as const)(
  "%s resume skips unknown types, synchronizes, and receives the live tail",
  (scope) =>
    Effect.gen(function* () {
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:replay");
      const projectId = ProjectId.make("project:replay");
      const project = {
        id: projectId,
        title: "Replay",
        workspaceRoot: "/tmp/replay",
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationProjectShell;
      const insert = (version: number, unknown = false) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`replay:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${unknown ? "future.event" : scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:replay", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [before] = yield* insert(0);
      yield* insert(1, true);
      const [after] = yield* insert(2);
      const [highWater] = yield* insert(3, true);
      const updates = yield* PubSub.unbounded();
      let liveSequence = 0;
      // The RPC server sends each pulled array as one chunk and waits for its ack.
      let chunk = -1;
      const consume = <A extends { readonly kind: string; readonly sequence?: number }, E, R>(
        stream: Stream.Stream<A, E, R>,
      ) =>
        stream.pipe(
          Stream.chunks,
          Stream.flatMap((items) => {
            chunk++;
            return Stream.fromIterable(items.map((item) => ({ ...item, chunk })));
          }),
          Stream.tap((item) =>
            Effect.gen(function* () {
              if (item.kind !== "synchronized") return;
              const [live] = yield* insert(4);
              liveSequence = live!.sequence;
              const events = yield* store
                .readApplicationEvents({
                  afterSequence: highWater!.sequence,
                  throughSequence: liveSequence,
                })
                .pipe(Stream.runCollect);
              yield* store.publishCommitted(events);
            }),
          ),
          Stream.takeUntil((item) => item.sequence === liveSequence),
          Stream.map((item) => ({
            kind: item.kind as string,
            sequence: item.sequence,
            chunk: item.chunk,
          })),
          Stream.runCollect,
        );
      const subscription = Effect.gen(function* () {
        return scope === "thread"
          ? yield* subscribeOrchestrationV2Thread({
              threadId,
              afterSequence: before!.sequence,
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume))
          : yield* subscribeOrchestrationV2Shell({
              afterSequence: before!.sequence,
              decorationCursor: shellDecorationCursor(),
              requestCompletionMarker: true,
            }).pipe(Effect.flatMap(consume));
      });
      const items = yield* subscription.pipe(
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          ensureLegacyTranscript: () => Effect.void,
          streamStoredEventsFrom: (
            input: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["streamStoredEventsFrom"]
            >[0],
          ) => {
            assert.equal(input?.afterSequence, highWater!.sequence);
            return store
              .streamApplicationEvents({ afterSequence: input?.afterSequence ?? 0 })
              .pipe(
                Stream.filter((event): event is OrchestrationV2StoredEvent => "event" in event),
              );
          },
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedSome(project),
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
          subscribeChanges: PubSub.subscribe(updates),
        } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scope === "thread"
          ? ["event", "synchronized", "event"]
          : ["project.updated", "synchronized", "project.updated"],
      );
      assert.deepEqual(
        items.flatMap((item) => (item.sequence === undefined ? [] : [item.sequence])),
        [after!.sequence, liveSequence],
      );
      // The replay and its completion marker arrive in one chunk: one round trip.
      assert.deepEqual(
        items.slice(0, 2).map((item) => item.chunk),
        [0, 0],
      );
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.live.each(["thread", "shell"] as const)(
  "%s resume from a cursor below the retention floor gets a snapshot",
  (scope) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-01-05T00:00:00.000Z";
      const threadId = ThreadId.make("thread:retained");
      const projectId = ProjectId.make("project:retained");
      const insert = (version: number) => sql<{ sequence: number }>`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type,
          occurred_at, actor_kind, payload_json, metadata_json, application_event_version
        ) VALUES (
          ${`retained:${version}`}, ${scope === "thread" ? "thread" : "project"},
          ${scope === "thread" ? threadId : projectId}, ${version},
          ${scope === "thread" ? "provider-session.detached" : "project.meta-updated"},
          ${now}, 'server', ${JSON.stringify(
            scope === "thread"
              ? { providerSessionId: "session:retained", detachedAt: now }
              : { projectId, updatedAt: now },
          )}, '{}', 2
        ) RETURNING sequence
      `;
      const [old] = yield* insert(0);
      const [floor] = yield* insert(1);
      yield* insert(2);
      // Retention trimmed the history before `floor`.
      const cursor = yield* EventLogCompaction.EventLogCursor;
      yield* cursor.save({ retainedFrom: floor!.sequence });
      const kindOf = <A extends { readonly kind: string }, E, R>(stream: Stream.Stream<A, E, R>) =>
        stream.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.map(([item]) => item?.kind),
        );
      const firstItem = (afterSequence: number, decorationCursor = shellDecorationCursor()) =>
        Effect.gen(function* () {
          return scope === "thread"
            ? yield* subscribeOrchestrationV2Thread({ threadId, afterSequence }).pipe(
                Effect.flatMap(kindOf),
              )
            : yield* subscribeOrchestrationV2Shell({ afterSequence, decorationCursor }).pipe(
                Effect.flatMap(kindOf),
              );
        }).pipe(
          Effect.provideService(ThreadManagement.ThreadManagementService, {
            ensureLegacyTranscript: () => Effect.void,
            getThreadSnapshot: () =>
              Effect.succeed({
                snapshotSequence: floor!.sequence + 1,
                projection: { ...v2Projection, thread: { ...v2Projection.thread, id: threadId } },
              }),
            readShellSnapshot: () =>
              Effect.succeed(
                Effect.succeed({
                  schemaVersion: 1,
                  snapshotSequence: floor!.sequence + 1,
                  threads: [],
                  archivedThreads: [],
                }),
              ),
            streamStoredEventsFrom: () => Stream.empty,
          } as unknown as ThreadManagement.ThreadManagementService["Service"]),
          Effect.provideService(ProjectStore.ProjectStoreV2, {
            listShells: () => Effect.succeed([]),
          } as unknown as ProjectStore.ProjectStoreV2["Service"]),
          Effect.provideService(ProjectService.ProjectService, {
            getShell: () =>
              Effect.succeedSome({
                id: projectId,
                title: "Retained",
                workspaceRoot: "/tmp/retained",
                defaultModelSelection: null,
                scripts: [],
                createdAt: now,
                updatedAt: now,
              } satisfies OrchestrationProjectShell),
          } as unknown as ProjectService.ProjectService["Service"]),
          Effect.provideServiceEffect(
            ProjectEnrichment.ProjectEnrichmentService,
            PubSub.unbounded().pipe(
              Effect.map(
                (changes) =>
                  ({
                    subscribeChanges: PubSub.subscribe(changes),
                  }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
              ),
            ),
          ),
        );
      // Its events start at the floor, so this replay is complete.
      assert.equal(
        yield* firstItem(floor!.sequence - 1),
        scope === "thread" ? "event" : "project.updated",
      );
      if (scope === "shell") {
        assert.equal(
          yield* firstItem(floor!.sequence - 1, { epoch: "previous-server", revision: 0 }),
          "snapshot",
        );
      }
      // The replay stats would count only what is left; the floor tells.
      assert.equal(yield* firstItem(old!.sequence - 1), "snapshot");
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.live("shell resume refreshes quiet chat decorations after a busy gap", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const updates = yield* PubSub.unbounded();
    const schedules = yield* ScheduledTaskShells.ScheduledTaskShells;
    const tabs = ChatTabs.make().store;
    const quiet = ThreadId.make("quiet-decorated-chat");
    const namingBasis = { title: "Quiet chat", requestId: "quiet-request" };
    const decorationCursor = shellDecorationCursor();
    // The shell needs only the aggregate key. Give the events a body that would
    // fail decoding as a turn item to catch an accidental full event read.
    yield* sql`
      WITH RECURSIVE burst(n) AS (
        SELECT 1 UNION ALL SELECT n + 1 FROM burst WHERE n < 1243
      )
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      )
      SELECT 'shell-burst:' || n, 'thread', ${v2ThreadShell.id}, n,
        'turn-item.updated', '2026-01-05T00:00:00.000Z', 'provider', '{}', '{}', 2
      FROM burst
    `;
    const events = yield* OrchestrationEventStore.OrchestrationEventStore;
    const head = yield* events.latestApplicationSequence;
    yield* tabs.command(
      { action: "move", tab: "Filed while offline", threadIds: [quiet] },
      { titleOf: () => namingBasis.title, now: 0 },
    );
    const nextRunAt = "2026-01-05T01:00:00.000Z";
    yield* sql`
      INSERT INTO scheduled_tasks (
        task_id, title, prompt, enabled, schedule_json, project_id, thread_id,
        workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode,
        created_by, creation_source, created_at, updated_at, next_run_at, last_run_status, run_count
      ) VALUES (
        'quiet-schedule', 'Reminder', 'Check status', 1, '{"type":"interval","everyMs":60000}',
        ${v2ThreadShell.projectId}, ${quiet}, '{}', '{}', 'full-access', 'default',
        'user', 'web', ${nextRunAt}, ${nextRunAt}, ${nextRunAt}, 'never', 0
      )
    `;
    yield* schedules.refresh;
    yield* Effect.acquireRelease(
      Effect.sync(() => boxNamerCache.activate([], () => {})),
      () => Effect.sync(() => boxNamerCache.deactivate()),
    );
    boxNamerCache.put(quiet, { ...namingBasis, name: "Named while offline", now: null });
    assert.equal(yield* events.latestApplicationSequence, head);

    const reads: ThreadId[] = [];
    const stream = yield* subscribeOrchestrationV2Shell({
      afterSequence: 0,
      decorationCursor,
      requestCompletionMarker: true,
    }).pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        getThreadShell: (threadId: ThreadId) =>
          Effect.sync(() => {
            reads.push(threadId);
            return threadId === quiet
              ? {
                  ...v2ThreadShell,
                  id: quiet,
                  chatTab: tabs.get(quiet),
                  nextScheduledRunAt: schedules.nextRunAt(quiet),
                  boxName: lookupBoxNaming(quiet, namingBasis)?.name ?? null,
                }
              : v2ThreadShell;
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        listShells: () => Effect.succeed([]),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(
        ProjectService.ProjectService,
        {} as ProjectService.ProjectService["Service"],
      ),
      Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
        subscribeChanges: PubSub.subscribe(updates),
      } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
    );
    const items = yield* stream.pipe(
      Stream.takeUntil((item) => item.kind === "synchronized"),
      Stream.runCollect,
    );
    assert.deepEqual(reads, [v2ThreadShell.id, quiet]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["thread.updated", "snapshot", "synchronized"],
    );
    assert.equal(items[0]?.kind === "thread.updated" && items[0].sequence, head);
    const patch = items[1];
    assert.isTrue(patch?.kind === "snapshot");
    if (patch?.kind === "snapshot") {
      assert.deepEqual(patch.resolvedRepositoryIdentityRoots, []);
      assert.deepEqual(
        patch.snapshot.threads.map(({ id, chatTab, nextScheduledRunAt, boxName }) => ({
          id,
          chatTab,
          nextScheduledRunAt,
          boxName,
        })),
        [
          {
            id: quiet,
            chatTab: { name: "Filed while offline", position: 0, manual: true },
            nextScheduledRunAt: nextRunAt,
            boxName: "Named while offline",
          },
        ],
      );
    }
    const marker = items[2];
    assert.deepEqual(
      marker?.kind === "synchronized" && marker.decorationCursor,
      shellDecorationCursor(),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(ScheduledTaskShells.layer.pipe(Layer.provideMerge(ReplayTestLayer))),
  ),
);

it.live("refreshes a chat whose only monitor ended while the shell was disconnected", () =>
  Effect.gen(function* () {
    const updates = yield* PubSub.unbounded();
    const input = {
      afterSequence: 0,
      decorationCursor: shellDecorationCursor(),
      requestCompletionMarker: true,
      refreshMonitorThreadIds: [v2ThreadShell.id],
    };
    const stream = yield* subscribeOrchestrationV2Shell(input).pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        getThreadShell: (threadId: ThreadId) =>
          Effect.succeed(threadId === v2ThreadShell.id ? v2ThreadShell : null),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        listShells: () => Effect.succeed([]),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(
        ProjectService.ProjectService,
        {} as ProjectService.ProjectService["Service"],
      ),
      Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
        subscribeChanges: PubSub.subscribe(updates),
      } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
    );
    const items = yield* stream.pipe(
      Stream.takeUntil((item) => item.kind === "synchronized"),
      Stream.runCollect,
    );
    const refreshed = items.flatMap((item) =>
      item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots !== undefined
        ? item.snapshot.threads
        : [],
    );
    assert.deepEqual(refreshed, [v2ThreadShell]);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

// Pulls until `done` matches, then returns everything pulled. A stream failure fails the test.
const pullUntil = <A, E>(
  pull: Effect.Effect<ReadonlyArray<A>, E | Cause.Done>,
  done: (item: A) => boolean,
) =>
  Effect.gen(function* () {
    const items: Array<A> = [];
    while (!items.some(done)) items.push(...(yield* pull));
    return items;
  });

it.live("a thread subscriber that falls a full live buffer behind gets a fresh snapshot", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("thread:overflow");
    const titled = (sequence: number, title: string) =>
      ({
        sequence,
        event: {
          id: `event:overflow:${sequence}`,
          type: "thread.metadata-updated",
          threadId,
          occurredAt: v2Projection.thread.updatedAt,
          payload: { ...v2Projection.thread, id: threadId, title },
        },
      }) as unknown as OrchestrationV2StoredEvent;
    const burst = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    // The live budget drops the tail it can no longer hold and closes its source.
    const burstSourceClosed = yield* Deferred.make<void>();
    const BURST_END = LIVE_STREAM_MAX_ITEMS + 100;
    const liveFrom: Array<number> = [];
    let snapshotReads = 0;
    const management = {
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: () =>
        Effect.sync(() => {
          snapshotReads++;
          // The second read is the resync after the burst: it already holds the burst.
          return snapshotReads === 1
            ? {
                snapshotSequence: 1,
                projection: {
                  ...v2Projection,
                  thread: { ...v2Projection.thread, id: threadId, title: "Before" },
                },
              }
            : {
                snapshotSequence: BURST_END,
                projection: {
                  ...v2Projection,
                  thread: { ...v2Projection.thread, id: threadId, title: "After burst" },
                },
              };
        }),
      streamStoredEventsFrom: (input: { readonly afterSequence: number }) => {
        liveFrom.push(input.afterSequence);
        return liveFrom.length === 1
          ? Stream.fromQueue(burst).pipe(
              Stream.ensuring(Deferred.succeed(burstSourceClosed, undefined)),
            )
          : Stream.make(titled(BURST_END + 1, "Live again")).pipe(Stream.concat(Stream.never));
      },
    } as unknown as ThreadManagement.ThreadManagementService["Service"];

    const stream = yield* subscribeOrchestrationV2Thread({ threadId }).pipe(
      Effect.provideService(ThreadManagement.ThreadManagementService, management),
    );
    const pull = yield* Stream.toPull(stream);
    const [first] = yield* pull;
    assert.equal(first?.kind, "snapshot");
    // The live tail is running once its first event arrives.
    yield* Queue.offer(burst, titled(2, "Live"));
    yield* pullUntil(pull, (item) => item.kind === "event" && item.sequence === 2);
    // The client stops acknowledging (a busy or sleeping tab) while the run bursts.
    yield* Queue.offerAll(
      burst,
      Array.from({ length: BURST_END - 2 }, (_, index) => titled(index + 3, `Burst ${index + 3}`)),
    );
    yield* Deferred.await(burstSourceClosed);

    const items = yield* pullUntil(
      pull,
      (item) => item.kind === "event" && item.sequence === BURST_END + 1,
    );
    const resync = items.find((item) => item.kind === "snapshot");
    assert.equal(
      resync?.kind === "snapshot" ? resync.projection.thread.title : undefined,
      "After burst",
    );
    assert.deepEqual(liveFrom, [1, BURST_END]);
    assert.equal(snapshotReads, 2);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.live("a shell subscriber that falls a full live buffer behind gets a fresh snapshot", () =>
  Effect.gen(function* () {
    const store = yield* OrchestrationEventStore.OrchestrationEventStore;
    // The live budget drops the tail it can no longer hold and closes its source.
    const burstSourceClosed = yield* Deferred.make<void>();
    const streamProjectedApplicationEvents: typeof store.streamProjectedApplicationEvents = (
      input,
    ) =>
      store
        .streamProjectedApplicationEvents(input)
        .pipe(Stream.ensuring(Deferred.succeed(burstSourceClosed, undefined)));
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-01-05T00:00:00.000Z";
    const insertProjectEvent = (index: number) => sql<{ sequence: number }>`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES (
        ${`overflow:${index}`}, 'project', ${`project:overflow:${index}`}, 0,
        'project.meta-updated', ${now}, 'server',
        ${JSON.stringify({ projectId: `project:overflow:${index}`, updatedAt: now })}, '{}', 2
      ) RETURNING sequence
    `;
    const publishThrough = (afterSequence: number, throughSequence: number) =>
      store
        .readApplicationEvents({ afterSequence, throughSequence })
        .pipe(Stream.runCollect, Effect.flatMap(store.publishCommitted));
    let snapshotReads = 0;
    const BURST = LIVE_STREAM_MAX_ITEMS + 100;
    const updates = yield* PubSub.unbounded();
    const stream = yield* subscribeOrchestrationV2Shell({}).pipe(
      Effect.provideService(OrchestrationEventStore.OrchestrationEventStore, {
        ...store,
        streamProjectedApplicationEvents,
      }),
      Effect.provideService(ThreadManagement.ThreadManagementService, {
        readShellSnapshot: () =>
          Effect.sync(() => {
            snapshotReads++;
            return Effect.succeed({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            });
          }),
      } as unknown as ThreadManagement.ThreadManagementService["Service"]),
      Effect.provideService(ProjectStore.ProjectStoreV2, {
        listShells: () => Effect.succeed([]),
      } as unknown as ProjectStore.ProjectStoreV2["Service"]),
      Effect.provideService(ProjectService.ProjectService, {
        getShell: (projectId: ProjectId) =>
          Effect.succeedSome({
            id: projectId,
            title: projectId,
            workspaceRoot: `/tmp/${projectId}`,
            defaultModelSelection: null,
            scripts: [],
            createdAt: now,
            updatedAt: now,
          } satisfies OrchestrationProjectShell),
      } as unknown as ProjectService.ProjectService["Service"]),
      Effect.provideService(ProjectEnrichment.ProjectEnrichmentService, {
        subscribeChanges: PubSub.subscribe(updates),
      } as ProjectEnrichment.ProjectEnrichmentService["Service"]),
    );
    const pull = yield* Stream.toPull(stream);
    const initial = yield* pull;
    assert.equal(initial[0]?.kind, "snapshot");
    // The live tail is running once its first update arrives.
    const started = (yield* insertProjectEvent(-2))[0]!.sequence;
    yield* publishThrough(0, started);
    yield* pullUntil(pull, (item) => item.kind === "project.updated" && item.sequence === started);
    // Every project changes while the client is not acknowledging.
    let last = started;
    for (let index = 0; index < BURST; index++) {
      last = (yield* insertProjectEvent(index))[0]!.sequence;
    }
    yield* publishThrough(started, last);
    yield* Deferred.await(burstSourceClosed);

    const resync = (yield* pullUntil(pull, (item) => item.kind === "snapshot")).find(
      (item) => item.kind === "snapshot",
    );
    // The fresh snapshot already holds the whole burst.
    assert.equal(resync?.kind === "snapshot" ? resync.snapshot.snapshotSequence : undefined, last);
    assert.equal(snapshotReads, 2);
    // The resubscribed tail still delivers what comes next.
    const next = (yield* insertProjectEvent(-1))[0]!.sequence;
    yield* publishThrough(last, next);
    yield* pullUntil(pull, (item) => item.kind === "project.updated" && item.sequence === next);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.live.each(["compact", "larger-than-snapshot", "raw-budget", "source-budget"] as const)(
  "thread resume %s uses bounded preflight, compaction, and the requested fallback window",
  (scenario) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:compacted-resume");
      const now = "2026-10-01T00:00:00.000Z";
      const payload = {
        id: "node",
        threadId,
        runId: null,
        parentNodeId: null,
        rootNodeId: "root",
        kind: "tool_call",
        status: "running",
        countsForRun: true,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: null,
        completedAt: null,
        ...(scenario === "raw-budget"
          ? { padding: "x".repeat(THREAD_RESUME_MAX_RAW_PAYLOAD_BYTES + 1) }
          : {}),
      };
      const count =
        scenario === "source-budget"
          ? THREAD_RESUME_MAX_SOURCE_EVENTS + 1
          : scenario === "raw-budget"
            ? 1
            : 300;
      const [baseline] = yield* sql<{ sequence: number }>`
      INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
        event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      VALUES ('baseline', 'thread', ${threadId}, 0, 'provider-session.detached', ${now}, 'server',
        '{"providerSessionId":"session","detachedAt":"2026-10-01T00:00:00.000Z"}', '{}', 2)
      RETURNING sequence
    `;
      yield* sql`
      WITH RECURSIVE counter(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM counter WHERE n < ${count})
      INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version,
        event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
      SELECT 'resume:' || n, 'thread', ${threadId}, n, 'node.updated', ${now}, 'server',
        CASE WHEN ${scenario === "larger-than-snapshot" ? 1 : 0} THEN json_set(${JSON.stringify(payload)}, '$.id', 'node:' || n)
        ELSE ${JSON.stringify(payload)} END, '{}', 2 FROM counter
    `;
      const store = yield* OrchestrationEventStore.OrchestrationEventStore;
      const highWater = yield* store.latestAgentSequence(threadId);
      let snapshotReads = 0;
      const projection = {
        ...v2Projection,
        thread: { ...v2Projection.thread, id: threadId },
        nodes: Array.from({ length: 30 }, (_, index) => ({
          ...payload,
          id: `snapshot-node:${index}`,
        })),
      } as unknown as OrchestrationV2ThreadProjection;
      const management = {
        ensureLegacyTranscript: () => Effect.void,
        getThreadSnapshotWindow: (_threadId: ThreadId, options: { userTurnLimit: number }) => {
          assert.equal(options.userTurnLimit, 3);
          snapshotReads++;
          return Effect.succeed({ snapshotSequence: highWater, projection });
        },
        streamStoredEventsFrom: (input: { afterSequence: number }) => {
          assert.equal(input.afterSequence, highWater);
          return Stream.empty;
        },
      } as unknown as ThreadManagement.ThreadManagementService["Service"];
      const items = yield* subscribeOrchestrationV2Thread({
        threadId,
        afterSequence: baseline!.sequence,
        requestCompletionMarker: true,
        acceptBoundedSnapshot: true,
        snapshotUserTurnLimit: 3,
      }).pipe(
        Effect.flatMap((stream) => Stream.runCollect(stream)),
        Effect.provideService(ThreadManagement.ThreadManagementService, management),
      );
      assert.deepEqual(
        items.map((item) => item.kind),
        scenario === "compact" ? ["event", "event", "synchronized"] : ["snapshot", "synchronized"],
      );
      assert.equal(snapshotReads, 1);
      if (scenario === "compact") {
        const events = items.filter((item) => item.kind === "event");
        assert.deepEqual(
          events.map((item) => item.sequence),
          [baseline!.sequence + 1, highWater],
        );
      }
    }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect("shell snapshots leave idle subagent children out only for clients that ask", () =>
  Effect.gen(function* () {
    const shell = (
      id: string,
      parent: string | null,
      activityRunStatus: "running" | null,
      creationSource: "provider" | "mcp" = "provider",
    ) =>
      ({
        id: ThreadId.make(id),
        archivedAt: null,
        creationSource,
        createdBy: "agent",
        status: activityRunStatus ?? "completed",
        activityRunStatus,
        pendingRuntimeRequest: null,
        pendingBackgroundTasks: [],
        lineage: {
          parentThreadId: parent === null ? null : ThreadId.make(parent),
          relationshipToParent: parent === null ? null : "subagent",
          rootThreadId: ThreadId.make("parent"),
        },
      }) as unknown as OrchestrationV2ThreadShell;
    const threads = [
      shell("parent", null, null),
      shell("idle", "parent", null),
      shell("live", "parent", "running"),
      shell("delegated", "parent", null, "mcp"),
    ];
    const firstSnapshot = (input: Parameters<typeof subscribeOrchestrationV2Shell>[0]) =>
      subscribeOrchestrationV2Shell(input).pipe(
        Effect.flatMap((stream) => stream.pipe(Stream.take(1), Stream.runCollect)),
        Effect.map(([item]) => (item?.kind === "snapshot" ? item.snapshot : undefined)),
        Effect.provideService(ThreadManagement.ThreadManagementService, {
          readShellSnapshot: (
            options: Parameters<
              ThreadManagement.ThreadManagementService["Service"]["readShellSnapshot"]
            >[0],
          ) =>
            Effect.succeed(
              Effect.succeed({
                schemaVersion: 1,
                snapshotSequence: 0,
                threads:
                  options?.omitIdleSubagents === "all"
                    ? threads.filter(({ id }) => id === "parent" || id === "live")
                    : options?.omitIdleSubagents === "provider"
                      ? threads.filter(({ id }) => id !== "idle")
                      : threads,
                archivedThreads: [],
              }),
            ),
        } as unknown as ThreadManagement.ThreadManagementService["Service"]),
        Effect.provideService(ProjectStore.ProjectStoreV2, {
          listShells: () => Effect.succeed([]),
        } as unknown as ProjectStore.ProjectStoreV2["Service"]),
        Effect.provideService(ProjectService.ProjectService, {
          getShell: () => Effect.succeedNone,
        } as unknown as ProjectService.ProjectService["Service"]),
        Effect.provideServiceEffect(
          ProjectEnrichment.ProjectEnrichmentService,
          PubSub.unbounded().pipe(
            Effect.map(
              (changes) =>
                ({
                  subscribeChanges: PubSub.subscribe(changes),
                }) as unknown as ProjectEnrichment.ProjectEnrichmentService["Service"],
            ),
          ),
        ),
      );

    const full = yield* firstSnapshot({});
    assert.deepEqual(
      full?.threads.map(({ id }) => id),
      ["parent", "idle", "live", "delegated"],
    );
    assert.isUndefined(full?.idleSubagentsOmitted);
    const native = yield* firstSnapshot({ omitIdleSubagents: true });
    assert.deepEqual(
      native?.threads.map(({ id }) => id),
      ["parent", "live", "delegated"],
    );
    assert.isTrue(native?.idleSubagentsOmitted);
    assert.isUndefined(native?.idleAppOwnedSubagentsOmitted);
    const all = yield* firstSnapshot({ omitIdleSubagents: true, omitIdleAppOwnedSubagents: true });
    assert.deepEqual(
      all?.threads.map(({ id }) => id),
      ["parent", "live"],
    );
    assert.isTrue(all?.idleAppOwnedSubagentsOmitted);
  }).pipe(Effect.scoped, Effect.provide(ReplayTestLayer)),
);

it.effect(
  "native session RPCs route discovery, preview and confirmed import through authorization",
  () =>
    Effect.gen(function* () {
      const tested = [
        WS_METHODS.nativeSessionsDiscover,
        WS_METHODS.nativeSessionsPreview,
        WS_METHODS.nativeSessionsOpen,
      ] as const;
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
            (typeof tested)[number]
          > => !(tested as readonly string[]).includes(tag),
        ),
      );
      const calls: string[] = [];
      const session = {
        sessionKey: "opaque-selection",
        provider: "codex" as const,
        providerInstanceId: ProviderInstanceId.make("codex"),
        nativeId: "native-id",
        title: "Terminal task",
        cwd: "/fixture/workspace",
        host: "fixture-host",
        lastActiveAt: "2020-01-01T00:00:00Z",
        importedThreadId: null,
        mayBeActive: true,
      };
      const handlers = nativeSessionRpcHandlers({
        discoverNative: (input) =>
          Effect.sync(() => {
            calls.push(`discover:${input.query}`);
            return { sessions: [session], nextCursor: null, scanning: false };
          }),
        previewNative: (input) =>
          Effect.sync(() => {
            calls.push(`preview:${input.sessionKey}`);
            return { session, messages: [], truncated: false };
          }),
        openNative: (input) =>
          Effect.gen(function* () {
            calls.push(`open:${input.sessionKey}`);
            if (!input.confirmActive) return yield* new NativeSessionError({ reason: "active" });
            return { threadId: ThreadId.make("imported"), reused: true };
          }),
      });
      const reader = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayer(handlers),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      assert.equal(
        (yield* reader[WS_METHODS.nativeSessionsDiscover]({ query: "terminal" })).sessions[0]
          ?.nativeId,
        "native-id",
      );
      assert.equal(
        (yield* reader[WS_METHODS.nativeSessionsPreview]({ sessionKey: session.sessionKey }))
          .session.cwd,
        "/fixture/workspace",
      );
      assert.equal(
        (yield* reader[WS_METHODS.nativeSessionsOpen]({ sessionKey: session.sessionKey }).pipe(
          Effect.flip,
        ))._tag,
        "EnvironmentAuthorizationError",
      );
      assert.deepEqual(calls, ["discover:terminal", "preview:opaque-selection"]);
      const operator = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayer(handlers),
            RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
          ),
        ),
      );
      assert.equal(
        (yield* operator[WS_METHODS.nativeSessionsOpen]({ sessionKey: session.sessionKey }).pipe(
          Effect.flip,
        ))._tag,
        "NativeSessionError",
      );
      assert.deepEqual(
        yield* operator[WS_METHODS.nativeSessionsOpen]({
          sessionKey: session.sessionKey,
          confirmActive: true,
        }),
        { threadId: ThreadId.make("imported"), reused: true },
      );
    }),
);
