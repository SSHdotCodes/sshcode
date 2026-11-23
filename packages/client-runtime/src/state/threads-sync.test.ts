import {
  EnvironmentId,
  EventId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS,
  RunId,
  ThreadId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  StoredOrchestrationThreadSnapshot,
  decodeOrDiscardOrchestrationCache,
} from "../platform/orchestrationCache.ts";
import * as RpcSession from "../rpc/session.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  makeEnvironmentThreadState,
  recheckMissingThread,
  type EnvironmentThreadState,
  type ThreadSnapshotLoadResult,
} from "./threads.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";
import { setLoadMarkSink, type LoadMarkDetail } from "../loadMarks.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const THREAD_ID = v2ThreadId;
const CACHED_SNAPSHOT_SEQUENCE = 7;
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const BASE_PROJECTION: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  thread: { ...v2Projection.thread, title: "Cached thread" },
};

const TEST_DEFECT = { defect: "Malformed snapshot" } as const;
type TestThreadInput = OrchestrationV2ThreadStreamItem | Error | typeof TEST_DEFECT;

function testSession(
  client: WsRpcProtocolClient,
  config?: { readonly completionMarker?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(
      config?.completionMarker === true
        ? ({ threadResumeCompletionMarker: true } as never)
        : ({} as never),
    ),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const settle = Effect.gen(function* () {
  for (let step = 0; step < 20; step += 1) yield* Effect.yieldNow;
});

// The loader's not-found recheck schedule (500 ms, 1 s, 2 s, 4 s).
const MISS_RECHECKS = 4;
const waitOutMissRechecks = Effect.gen(function* () {
  for (const delay of ["500 millis", "1 second", "2 seconds", "4 seconds"] as const) {
    yield* settle;
    yield* TestClock.adjust(delay);
  }
  yield* settle;
});

const PRESENT_SNAPSHOT: ThreadSnapshotLoadResult = {
  _tag: "present",
  snapshot: { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, projection: BASE_PROJECTION },
};

const makeHarness = Effect.fn("TestEnvironmentThreads.makeHarness")(function* (options?: {
  readonly cached?: OrchestrationV2ThreadProjection;
  readonly cachedHistory?: {
    readonly historyCursor: string | null;
    readonly hasMoreHistory: boolean;
    readonly latestLocalTurnOrdinal?: number | null;
  };
  readonly httpSnapshot?: ThreadSnapshotLoadResult;
  /** Answers in order; the last one repeats. Overrides httpSnapshot. */
  readonly httpSnapshots?: ReadonlyArray<ThreadSnapshotLoadResult>;
  readonly completionMarker?: boolean;
  readonly resumeCache?: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]>;
  readonly loadCached?: ReturnType<Persistence.EnvironmentCacheStore["Service"]["loadThread"]>;
  readonly saveThread?: Persistence.EnvironmentCacheStore["Service"]["saveThread"];
  readonly retainThread?: Persistence.EnvironmentCacheStore["Service"]["retainThread"];
  readonly historyPaging?: "enabled" | "no-http" | "no-controller";
  readonly historyHttpClient?: HttpClient.HttpClient;
  readonly snapshotUserTurnLimit?: number;
  readonly initialConfig?: RpcSession.RpcSession["initialConfig"];
  readonly onSnapshotLoad?: Effect.Effect<void>;
}) {
  const inputs = yield* Queue.unbounded<TestThreadInput>();
  const observed = yield* Queue.unbounded<EnvironmentThreadState>();
  const latest = yield* Ref.make<EnvironmentThreadState>(EMPTY_ENVIRONMENT_THREAD_STATE);
  const retryCount = yield* Ref.make(0);
  const subscriptionCount = yield* Ref.make(0);
  const loaderCalls = yield* Ref.make(0);
  const lastSubscribeAfterSequence = yield* Ref.make<number | undefined>(undefined);
  const lastRequestCompletionMarker = yield* Ref.make(false);
  const lastAcceptBoundedSnapshot = yield* Ref.make<true | undefined>(undefined);
  const lastAcceptCompactTurnItems = yield* Ref.make<true | undefined>(undefined);
  const lastSnapshotUserTurnLimit = yield* Ref.make<number | undefined>(undefined);
  const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
  const savedThreads = yield* Ref.make<ReadonlyArray<OrchestrationV2ThreadDetailSnapshot>>([]);
  const removedThreads = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>(
    AVAILABLE_CONNECTION_STATE,
  );
  const streamFrom = (queue: Queue.Queue<TestThreadInput>) =>
    Stream.fromQueue(queue).pipe(
      Stream.mapEffect((input) =>
        input === TEST_DEFECT
          ? Effect.die(input)
          : input instanceof Error
            ? Effect.fail(input)
            : Effect.succeed(input),
      ),
    );
  const client = {
    [ORCHESTRATION_V2_WS_METHODS.subscribeThread]: (input: {
      readonly afterSequence?: number;
      readonly requestCompletionMarker?: true;
      readonly acceptBoundedSnapshot?: true;
      readonly acceptCompactTurnItems?: true;
      readonly snapshotUserTurnLimit?: number;
    }) =>
      Stream.unwrap(
        Ref.updateAndGet(subscriptionCount, (count) => count + 1).pipe(
          Effect.andThen(Ref.set(lastSubscribeAfterSequence, input.afterSequence)),
          Effect.andThen(
            Ref.set(lastRequestCompletionMarker, input.requestCompletionMarker === true),
          ),
          Effect.andThen(Ref.set(lastAcceptBoundedSnapshot, input.acceptBoundedSnapshot)),
          Effect.andThen(Ref.set(lastAcceptCompactTurnItems, input.acceptCompactTurnItems)),
          Effect.andThen(Ref.set(lastSnapshotUserTurnLimit, input.snapshotUserTurnLimit)),
          Effect.as(streamFrom(inputs)),
        ),
      ),
  } as unknown as WsRpcProtocolClient;
  const supervisorSession = yield* SubscriptionRef.make<Option.Option<RpcSession.RpcSession>>(
    Option.some({
      ...testSession(client, options),
      ...(options?.initialConfig ? { initialConfig: options.initialConfig } : {}),
    }),
  );
  const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
    Option.some(PREPARED),
  );
  const snapshotLoader = ThreadSnapshotLoader.ThreadSnapshotLoader.of({
    ...(options?.snapshotUserTurnLimit === undefined
      ? {}
      : { snapshotUserTurnLimit: options.snapshotUserTurnLimit }),
    load: (_prepared, threadId) =>
      Ref.getAndUpdate(loaderCalls, (count) => count + 1).pipe(
        Effect.tap(() => options?.onSnapshotLoad ?? Effect.void),
        Effect.map((call) => {
          const unavailable = { _tag: "unavailable" } satisfies ThreadSnapshotLoadResult;
          if (threadId !== THREAD_ID) return unavailable;
          const answers = options?.httpSnapshots;
          if (answers !== undefined && answers.length > 0) {
            return answers[Math.min(call, answers.length - 1)]!;
          }
          return options?.httpSnapshot ?? unavailable;
        }),
      ),
  });
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared,
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Ref.update(retryCount, (count) => count + 1),
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    ...(options?.retainThread ? { retainThread: options.retainThread } : {}),
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: (_environmentId, threadId) =>
      options?.loadCached ??
      Effect.succeed(
        threadId === THREAD_ID && options?.cached !== undefined
          ? Option.some({
              snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
              projection: options.cached,
              ...(options.cachedHistory === undefined
                ? {}
                : {
                    historyCursor: options.cachedHistory.historyCursor,
                    hasMoreHistory: options.cachedHistory.hasMoreHistory,
                    ...(options.cachedHistory.latestLocalTurnOrdinal === undefined
                      ? {}
                      : {
                          latestLocalTurnOrdinal: options.cachedHistory.latestLocalTurnOrdinal,
                        }),
                  }),
            })
          : Option.none(),
      ),
    saveThread: (environmentId, thread) =>
      Ref.update(savedThreads, (current) => [...current, thread]).pipe(
        Effect.andThen(options?.saveThread?.(environmentId, thread) ?? Effect.void),
      ),
    removeThread: (_environmentId, threadId) =>
      Ref.update(removedThreads, (current) => [...current, threadId]),
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  let makeThreadState = makeEnvironmentThreadState(THREAD_ID, options?.resumeCache).pipe(
    Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    Effect.provideService(Persistence.EnvironmentCacheStore, cache),
    Effect.provideService(ThreadSnapshotLoader.ThreadSnapshotLoader, snapshotLoader),
    Effect.provideService(
      ConnectionWakeups.ConnectionWakeups,
      ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.fromQueue(wakeups) }),
    ),
  );
  if (options?.historyPaging !== "no-http") {
    makeThreadState = makeThreadState.pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        options?.historyHttpClient ??
          HttpClient.make(() => Effect.die("Unexpected history HTTP request")),
      ),
    );
  }
  const historyController = yield* ThreadHistoryController.ThreadHistoryController.pipe(
    Effect.provide(ThreadHistoryController.layer),
  );
  if (options?.historyPaging !== "no-controller") {
    makeThreadState = makeThreadState.pipe(
      Effect.provideService(ThreadHistoryController.ThreadHistoryController, historyController),
    );
  }
  const threadState = yield* makeThreadState;
  yield* SubscriptionRef.changes(threadState).pipe(
    Stream.runForEach((state) =>
      Ref.set(latest, state).pipe(Effect.andThen(Queue.offer(observed, state))),
    ),
    Effect.forkScoped,
  );

  return {
    threadState,
    loadEarlier: (throughEntryId?: string) =>
      historyController.loadEarlier(TARGET.environmentId, THREAD_ID, throughEntryId),
    inputs,
    observed,
    latest,
    retryCount,
    subscriptionCount,
    loaderCalls,
    lastSubscribeAfterSequence,
    lastRequestCompletionMarker,
    lastAcceptBoundedSnapshot,
    lastAcceptCompactTurnItems,
    lastSnapshotUserTurnLimit,
    supervisorState,
    supervisorSession,
    savedThreads,
    removedThreads,
    wakeups,
    replaceSession: SubscriptionRef.set(
      supervisorSession,
      Option.some(testSession(client, options)),
    ),
  };
});

const snapshot = (
  projection: OrchestrationV2ThreadProjection,
  snapshotSequence = 1,
): Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "snapshot" }> => ({
  kind: "snapshot",
  snapshotSequence,
  projection,
});

const synchronized = (): OrchestrationV2ThreadStreamItem => ({ kind: "synchronized" });

const titleUpdated = (title: string, sequence = 2): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-title"),
      type: "thread.metadata-updated",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, title, updatedAt: occurredAt },
    },
  };
};

const deleted = (sequence = 3): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T02:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-deleted"),
      type: "thread.deleted",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, updatedAt: occurredAt, deletedAt: occurredAt },
    },
  };
};

describe("EnvironmentThreads", () => {
  it.effect(
    "pins the offline snapshot before loading and releases it when the thread scope closes",
    () =>
      Effect.gen(function* () {
        let pinned = false;
        yield* makeHarness({
          retainThread: (environmentId, threadId) =>
            Effect.acquireRelease(
              Effect.sync(() => {
                expect(environmentId).toBe(TARGET.environmentId);
                expect(threadId).toBe(THREAD_ID);
                pinned = true;
              }),
              () =>
                Effect.sync(() => {
                  pinned = false;
                }),
            ),
          loadCached: Effect.sync(() => {
            expect(pinned).toBe(true);
            return Option.none();
          }),
        }).pipe(Effect.scoped);
        expect(pinned).toBe(false);
      }),
  );

  it.effect("discards an oversized version-4 cache and requests a fresh bounded snapshot", () =>
    Effect.gen(function* () {
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make("old-unbounded-cache-item"),
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: BASE_PROJECTION.updatedAt,
        completedAt: BASE_PROJECTION.updatedAt,
        updatedAt: BASE_PROJECTION.updatedAt,
        type: "system_notice",
        message: "x".repeat(1_100_000),
      };
      const schema = Schema.fromJsonString(StoredOrchestrationThreadSnapshot);
      const encoded = yield* Schema.encodeEffect(schema)({
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        environmentId: TARGET.environmentId,
        threadId: THREAD_ID,
        snapshot: {
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          projection: { ...BASE_PROJECTION, turnItems: [item] },
        },
      });
      const stale = encoded.replace(
        `"schemaVersion":${ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION}`,
        '"schemaVersion":4',
      );
      let discarded = false;
      const h = yield* makeHarness({
        loadCached: decodeOrDiscardOrchestrationCache(
          Schema.decodeUnknownEffect(schema)(stale).pipe(
            Effect.map((stored) => Option.some(stored.snapshot)),
          ),
          Effect.sync(() => {
            discarded = true;
          }),
        ),
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE, projection: BASE_PROJECTION },
          history: { historyCursor: "fresh-bounded-cursor", hasMoreHistory: true },
        },
      });
      const state = yield* awaitThreadState(h.observed, (value) => value.status === "live");
      expect(discarded).toBe(true);
      expect(yield* Ref.get(h.loaderCalls)).toBe(1);
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(state.history.historyCursor).toBe("fresh-bounded-cursor");
      expect(state.history.hasMoreHistory).toBe(true);
    }),
  );

  it.effect(
    "retries a text append with the applied cursor before showing or saving any suffix",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({ cached: BASE_PROJECTION });
        yield* awaitThreadState(h.observed, (state) => state.status === "live");
        const messageId = MessageId.make("append-recovery");
        const at = BASE_PROJECTION.updatedAt;
        const message = (
          sequence: number,
          text: string,
          textAppendFrom?: number,
        ): OrchestrationV2ThreadStreamItem => ({
          kind: "event",
          sequence,
          ...(textAppendFrom === undefined ? {} : { textAppendFrom }),
          event: {
            id: EventId.make(`append-${sequence}`),
            threadId: THREAD_ID,
            type: "message.updated",
            occurredAt: at,
            payload: {
              id: messageId,
              threadId: THREAD_ID,
              runId: null,
              nodeId: null,
              role: "assistant",
              text,
              attachments: [],
              streaming: true,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: at,
              updatedAt: at,
            },
          },
        });
        const opening = "a".repeat(512);
        yield* Queue.offer(h.inputs, message(8, opening));
        yield* awaitThreadState(
          h.observed,
          (state) => Option.getOrNull(state.data)?.messages[0]?.text === opening,
        );
        yield* Queue.offer(h.inputs, message(9, "unsafe suffix", 513));
        const failed = yield* awaitThreadState(h.observed, (state) => Option.isSome(state.error));
        expect(Option.getOrThrow(failed.data).messages[0]?.text).toBe(opening);
        yield* TestClock.adjust("250 millis");
        yield* Queue.offer(h.inputs, message(9, opening + " recovered"));
        const recovered = yield* awaitThreadState(
          h.observed,
          (state) => Option.getOrNull(state.data)?.messages[0]?.text === opening + " recovered",
        );
        expect(recovered.error).toEqual(Option.none());
        expect(yield* Ref.get(h.subscriptionCount)).toBe(2);
        expect(yield* Ref.get(h.lastSubscribeAfterSequence)).toBe(8);
      }),
  );

  it.effect("loads the server thread when its local cache read fails", () =>
    Effect.gen(function* () {
      const marks: Array<{ name: string; detail: LoadMarkDetail | undefined }> = [];
      yield* Effect.acquireRelease(
        Effect.sync(() => setLoadMarkSink((name, _at, detail) => marks.push({ name, detail }))),
        () => Effect.sync(() => setLoadMarkSink(null)),
      );
      const h = yield* makeHarness({
        loadCached: Effect.fail(
          new Persistence.ConnectionPersistenceError({
            operation: "load-thread",
            message: "The database connection is closing.",
          }),
        ),
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
        },
      });

      const state = yield* awaitThreadState(h.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(h.loaderCalls)).toBe(1);
      expect(yield* Ref.get(h.subscriptionCount)).toBe(1);
      expect(marks).toContainEqual({
        name: "thread.http",
        detail: {
          thread: THREAD_ID.slice(0, 8),
          environment: TARGET.environmentId.slice(0, 8),
          load: expect.any(Number),
          attempt: 1,
          ms: expect.any(Number),
          outcome: "present",
        },
      });
    }),
  );

  it.effect("keeps an HTTP snapshot synchronizing until the completion marker", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({
        completionMarker: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
        },
      });
      const cached = yield* awaitThreadState(h.observed, (state) => Option.isSome(state.data));
      expect(cached.status).toBe("synchronizing");
      yield* Queue.offer(h.inputs, synchronized());
      yield* awaitThreadState(h.observed, (state) => state.status === "live");
    }),
  );

  it.effect("marks each cold-load wait and the first replay frame with one attempt id", () =>
    Effect.gen(function* () {
      const marks: Array<{ name: string; detail: LoadMarkDetail | undefined }> = [];
      const live = Promise.withResolvers<void>();
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          setLoadMarkSink((name, _at, detail) => {
            marks.push({ name, detail });
            if (name === "thread.live") live.resolve();
          }),
        ),
        () => Effect.sync(() => setLoadMarkSink(null)),
      );
      const h = yield* makeHarness({
        completionMarker: true,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
        },
      });
      yield* Queue.offer(h.inputs, synchronized());
      yield* Effect.promise(() => live.promise);
      const names = marks.map((mark) => mark.name);
      for (const name of [
        "thread.start",
        "thread.cached",
        "thread.session.wait",
        "thread.session.available",
        "thread.config.wait",
        "thread.config.ready",
        "thread.prepared.wait",
        "thread.prepared.ready",
        "thread.http.start",
        "thread.http",
        "thread.http.applied",
        "thread.subscribe",
        "thread.stream.start",
        "thread.first",
        "thread.live",
      ]) {
        expect(names).toContain(name);
      }
      const load = marks.find((mark) => mark.name === "thread.start")!.detail?.load;
      for (const mark of marks.filter((entry) => entry.name.startsWith("thread."))) {
        expect(mark.detail?.load).toBe(load);
      }
      expect(names.indexOf("thread.subscribe")).toBeLessThan(names.indexOf("thread.stream.start"));
      expect(names.indexOf("thread.stream.start")).toBeLessThan(names.indexOf("thread.first"));
      expect(names.indexOf("thread.first")).toBeLessThan(names.indexOf("thread.live"));
    }),
  );

  it.effect.each(["disk", "HTTP"] as const)(
    "does not rewrite an unchanged %s snapshot on navigation or warm return",
    (source) =>
      Effect.gen(function* () {
        const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
          snapshot: undefined,
          owner: undefined,
        };
        const firstSaved = yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* makeHarness({
              resumeCache,
              ...(source === "disk"
                ? { cached: BASE_PROJECTION }
                : {
                    httpSnapshot: {
                      _tag: "present",
                      snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
                    },
                  }),
            });
            yield* awaitThreadState(h.observed, (value) => value.status === "live");
            if (source === "HTTP") yield* TestClock.adjust("500 millis");
            return h.savedThreads;
          }),
        );
        expect(yield* Ref.get(firstSaved)).toHaveLength(source === "disk" ? 0 : 1);
        const nextSaved = yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* makeHarness({ resumeCache });
            yield* awaitThreadState(h.observed, (value) => value.status === "live");
            return h.savedThreads;
          }),
        );
        expect(yield* Ref.get(nextSaved)).toEqual([]);
      }),
  );

  it.effect("persists a complete bounded HTTP window only once", () =>
    Effect.gen(function* () {
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness({
            httpSnapshot: {
              _tag: "present",
              snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
              history: {
                historyCursor: null,
                hasMoreHistory: false,
                latestLocalTurnOrdinal: 12,
              },
            },
          });
          yield* awaitThreadState(h.observed, (value) => value.status === "live");
          yield* TestClock.adjust("500 millis");
          return h.savedThreads;
        }),
      );
      expect(yield* Ref.get(saved)).toEqual([
        {
          snapshotSequence: 7,
          projection: BASE_PROJECTION,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: 12,
        },
      ]);
    }),
  );

  it.effect("retries a failed background cache write when the scope closes", () =>
    Effect.gen(function* () {
      let attempts = 0;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness({
            httpSnapshot: {
              _tag: "present",
              snapshot: { snapshotSequence: 7, projection: BASE_PROJECTION },
            },
            saveThread: () =>
              Effect.suspend(() => {
                attempts += 1;
                return attempts === 1
                  ? Effect.fail(
                      new Persistence.ConnectionPersistenceError({
                        operation: "save-thread",
                        message: "Test storage failure",
                      }),
                    )
                  : Effect.void;
              }),
          });
          yield* awaitThreadState(h.observed, (value) => value.status === "live");
          yield* TestClock.adjust("500 millis");
          expect(attempts).toBe(1);
        }),
      );
      expect(attempts).toBe(2);
    }),
  );

  it.effect("flushes newer data after an older background write completes", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const written = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const saved = yield* Effect.scoped(
        Effect.gen(function* () {
          const h = yield* makeHarness({
            cached: BASE_PROJECTION,
            saveThread: (_environmentId, snapshot) =>
              snapshot.snapshotSequence === 8
                ? Deferred.succeed(writing, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(Deferred.succeed(written, undefined)),
                  )
                : Effect.void,
          });
          yield* Queue.offer(h.inputs, titleUpdated("First update", 8));
          yield* awaitThreadState(
            h.observed,
            (value) => Option.getOrNull(value.data)?.thread.title === "First update",
          );
          yield* TestClock.adjust("500 millis");
          yield* Deferred.await(writing);
          yield* Queue.offer(h.inputs, titleUpdated("Newer update", 9));
          yield* awaitThreadState(
            h.observed,
            (value) => Option.getOrNull(value.data)?.thread.title === "Newer update",
          );
          yield* Deferred.succeed(release, undefined);
          yield* Deferred.await(written);
          return h.savedThreads;
        }),
      );
      expect(
        (yield* Ref.get(saved)).map((snapshot) => [
          snapshot.snapshotSequence,
          snapshot.projection.thread.title,
        ]),
      ).toEqual([
        [8, "First update"],
        [9, "Newer update"],
      ]);
    }),
  );

  it.effect("does not resume past a canceled event whose data was not applied", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const scope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const first = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            projection: BASE_PROJECTION,
            snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          },
        },
        resumeCache,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      yield* awaitThreadState(first.observed, (value) => value.status === "live");
      const applying = yield* Deferred.make<void>();
      const update = titleUpdated("Not applied", 8);
      if (update.kind !== "event") return yield* Effect.die("Expected an event");
      let sequenceReads = 0;
      Object.defineProperty(update, "sequence", {
        get: () => {
          if (++sequenceReads === 2) Deferred.doneUnsafe(applying, Exit.void);
          return 8;
        },
      });
      // Hold the projection write while the event advances its cursor. Closing
      // the scope must resume from the last fully applied projection.
      yield* first.threadState.semaphore.take(1);
      yield* Queue.offer(first.inputs, update);
      yield* Deferred.await(applying);
      yield* Scope.close(scope, Exit.void);
      yield* first.threadState.semaphore.release(1);

      const resumed = yield* makeHarness({ resumeCache });
      const state = yield* awaitThreadState(resumed.observed, (value) => value.status === "live");
      expect(Option.getOrThrow(state.data).thread.title).toBe(BASE_PROJECTION.thread.title);
      expect(yield* Ref.get(resumed.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(first.savedThreads)).toEqual([
        {
          projection: BASE_PROJECTION,
          snapshotSequence: CACHED_SNAPSHOT_SEQUENCE,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: null,
        },
      ]);
    }),
  );

  it.effect("prevents an old scope from replacing its successor's cached data", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const oldScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
        Scope.close(scope, Exit.void),
      );
      const old = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache }).pipe(
        Effect.provideService(Scope.Scope, oldScope),
      );
      yield* awaitThreadState(old.observed, (value) => value.status === "live");
      const successor = yield* makeHarness({ resumeCache });
      yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 9));
      yield* awaitThreadState(
        successor.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Successor title",
      );
      yield* Queue.offer(old.inputs, titleUpdated("Old scope title", 8));
      yield* awaitThreadState(
        old.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Old scope title",
      );
      yield* Scope.close(oldScope, Exit.void);

      expect(resumeCache.snapshot?.sequence).toBe(9);
      expect(Option.getOrThrow(resumeCache.snapshot!.state.data).thread.title).toBe(
        "Successor title",
      );
      expect(yield* Ref.get(old.savedThreads)).toEqual([]);
    }),
  );

  it.effect("does not let a delayed cache read replace an initialized successor", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const loading = yield* Deferred.make<void>();
      const response = yield* Deferred.make<Option.Option<OrchestrationV2ThreadDetailSnapshot>>();
      const oldFiber = yield* makeHarness({
        resumeCache,
        loadCached: Deferred.succeed(loading, undefined).pipe(
          Effect.andThen(Deferred.await(response)),
        ),
      }).pipe(Effect.forkScoped);
      yield* Deferred.await(loading);
      const successor = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
      yield* awaitThreadState(successor.observed, (value) => value.status === "live");
      yield* Deferred.succeed(
        response,
        Option.some({
          snapshotSequence: 3,
          projection: {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Old disk data" },
          },
        }),
      );
      const old = yield* Fiber.join(oldFiber);
      yield* awaitThreadState(old.observed, (value) => value.status === "live");

      expect(resumeCache.snapshot?.sequence).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(Option.getOrThrow(resumeCache.snapshot!.state.data).thread.title).toBe(
        BASE_PROJECTION.thread.title,
      );
    }),
  );

  it.effect("does not let an old deletion remove its successor's persisted cache", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      const old = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
      yield* awaitThreadState(old.observed, (value) => value.status === "live");
      const successor = yield* makeHarness({ resumeCache });
      yield* Queue.offer(successor.inputs, titleUpdated("Successor title", 9));
      yield* awaitThreadState(
        successor.observed,
        (value) => Option.getOrNull(value.data)?.thread.title === "Successor title",
      );
      const update = deleted();
      if (update.kind !== "event") return yield* Effect.die("Expected an event");
      yield* Queue.offer(old.inputs, { ...update, sequence: 8 });
      yield* awaitThreadState(old.observed, (value) => value.status === "deleted");

      expect(resumeCache.snapshot?.sequence).toBe(9);
      expect(yield* Ref.get(old.removedThreads)).toEqual([]);
    }),
  );

  it.effect("retains a deletion instead of restoring the old disk snapshot", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
          const update = deleted();
          if (update.kind !== "event") return yield* Effect.die("Expected an event");
          yield* Queue.offer(first.inputs, { ...update, sequence: 8 });
          yield* awaitThreadState(first.observed, (value) => value.status === "deleted");
        }),
      );
      const resumed = yield* makeHarness({ cached: BASE_PROJECTION, resumeCache });
      const state = yield* awaitThreadState(
        resumed.observed,
        (value) => value.status === "deleted",
      );
      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(resumed.loaderCalls)).toBe(0);
    }),
  );

  it.effect("publishes cached data immediately from a warm cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(Option.isNone(state.error)).toBe(true);
    }),
  );

  it.effect("resumes a warm cache via afterSequence without an HTTP fetch", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });

      // The warm cache reaches live from the cached data, and a live event
      // applies on top of it.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", CACHED_SNAPSHOT_SEQUENCE + 1));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      // The subscription resumed from the cached sequence and never fetched the
      // full snapshot over HTTP.
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect("coalesces streaming cache writes and flushes the latest thread on teardown", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* awaitThreadState(harness.observed, (state) => state.status === "live");
      yield* TestClock.adjust("500 millis");
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(1);

      for (let sequence = 2; sequence <= 10; sequence++) {
        yield* Queue.offer(harness.inputs, titleUpdated(`Title ${sequence}`, sequence));
        yield* awaitThreadState(
          harness.observed,
          (state) =>
            Option.isSome(state.data) && state.data.value.thread.title === `Title ${sequence}`,
        );
        yield* TestClock.adjust("1 second");
      }
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      expect((yield* Ref.get(harness.savedThreads)).map((saved) => saved.snapshotSequence)).toEqual(
        [1, 10],
      );

      yield* Queue.offer(harness.inputs, titleUpdated("Final title", 11));
      yield* awaitThreadState(
        harness.observed,
        (state) => Option.isSome(state.data) && state.data.value.thread.title === "Final title",
      );
      yield* Scope.close(scope, Exit.void);
      expect((yield* Ref.get(harness.savedThreads)).map((saved) => saved.snapshotSequence)).toEqual(
        [1, 10, 11],
      );
    }),
  );

  it.effect("reduces live events and persists the latest thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title"));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.projection.thread.title).toBe(
        "Live title",
      );
      expect((yield* Ref.get(harness.savedThreads)).at(-1)?.snapshotSequence).toBe(2);
    }),
  );

  it.effect("keeps progressive history metadata from a bounded socket fallback", () =>
    Effect.gen(function* () {
      const olderItem = {
        id: "item:older",
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: "2026-06-20T00:00:00.000Z",
        completedAt: "2026-06-20T00:00:00.000Z",
        updatedAt: "2026-06-20T00:00:00.000Z",
        type: "command_execution",
        input: "pwd",
        output: "older history",
        exitCode: 0,
      };
      const harness = yield* makeHarness({
        historyHttpClient: HttpClient.make((request, url) => {
          expect(url.searchParams.get("cursor")).toBe("socket-history-cursor");
          expect(url.searchParams.get("throughEntryId")).toBe(olderItem.id);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                snapshotSequence: 14,
                items: [
                  {
                    position: 0,
                    visibility: "local",
                    sourceThreadId: THREAD_ID,
                    sourceItemId: olderItem.id,
                    item: olderItem,
                  },
                ],
                nextCursor: null,
                hasMoreHistory: false,
              }),
            ),
          );
        }),
      });
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshotSequence: 14,
        projection: BASE_PROJECTION,
        historyCursor: "socket-history-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 47,
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" && value.history.historyCursor === "socket-history-cursor",
      );
      expect(state.history).toMatchObject({
        historyCursor: "socket-history-cursor",
        hasMoreHistory: true,
        loading: false,
        error: null,
        expanded: false,
        latestLocalTurnOrdinal: 47,
      });
      // A transient cold HTTP failure still requests a bounded socket snapshot.
      // Its cursor remains available for a later history request.
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBeUndefined();
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      expect((yield* Ref.get(harness.savedThreads)).at(-1)).toMatchObject({
        snapshotSequence: 14,
        historyCursor: "socket-history-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 47,
      });
      expect(yield* harness.loadEarlier(olderItem.id)).toEqual({ _tag: "loaded" });
      const expanded = yield* SubscriptionRef.get(harness.threadState);
      expect(
        Option.getOrThrow(expanded.data).turnItems.some((item) => item.id === olderItem.id),
      ).toBe(true);
      expect(expanded.history.hasMoreHistory).toBe(false);
    }),
  );

  it.effect.each(["complete", "replacement snapshot", "retry"] as const)(
    "progressively reveals conversation history before activity, then handles %s",
    (mode) =>
      Effect.gen(function* () {
        const common = {
          threadId: THREAD_ID,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          status: "completed",
          title: null,
          startedAt: "2026-06-20T00:00:00.000Z",
          completedAt: "2026-06-20T00:00:00.000Z",
          updatedAt: "2026-06-20T00:00:00.000Z",
        };
        const message = {
          ...common,
          id: "item:older-message",
          ordinal: 1,
          type: "assistant_message",
          messageId: "message:older",
          text: "COD4 result",
          streaming: false,
        };
        const activity = {
          ...common,
          id: "item:older-command",
          ordinal: 2,
          type: "command_execution",
          input: "pwd",
          output: "",
          exitCode: 0,
        };
        const projected = (item: typeof message | typeof activity, position: number) => ({
          position,
          visibility: "local",
          sourceThreadId: THREAD_ID,
          sourceItemId: item.id,
          item,
        });
        const activityStarted = yield* Deferred.make<void>();
        const releaseActivity = yield* Deferred.make<void>();
        let activityRequests = 0;
        const harness = yield* makeHarness({
          historyHttpClient: HttpClient.make((request, url) =>
            Effect.gen(function* () {
              expect(url.searchParams.get("cursor")).toBe("progressive-cursor");
              const conversationOnly = url.searchParams.get("view") === "conversation";
              if (!conversationOnly && activityRequests++ === 0) {
                yield* Deferred.succeed(activityStarted, undefined);
                yield* Deferred.await(releaseActivity);
                if (mode === "retry")
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response("Activity unavailable", { status: 503 }),
                  );
              }
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  snapshotSequence: 14,
                  items: conversationOnly
                    ? [projected(message, 0)]
                    : [projected(message, 0), projected(activity, 1)],
                  nextCursor: "next-cursor",
                  hasMoreHistory: true,
                }),
              );
            }),
          ),
        });
        yield* Queue.offer(harness.inputs, {
          ...snapshot(BASE_PROJECTION, 14),
          historyCursor: "progressive-cursor",
          hasMoreHistory: true,
          latestLocalTurnOrdinal: 47,
        });
        yield* awaitThreadState(
          harness.observed,
          (state) => state.history.historyCursor === "progressive-cursor",
        );
        const loading = yield* harness.loadEarlier(message.messageId).pipe(Effect.forkScoped);
        yield* Deferred.await(activityStarted);
        const preview = yield* SubscriptionRef.get(harness.threadState);
        expect(preview.history).toMatchObject({
          loading: true,
          historyCursor: "progressive-cursor",
          expanded: true,
        });
        expect(
          Option.getOrThrow(preview.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual([message.id]);
        if (mode === "replacement snapshot") {
          yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION, 15));
          yield* awaitThreadState(
            harness.observed,
            (state) => state.history.historyCursor === null,
          );
        }
        yield* Deferred.succeed(releaseActivity, undefined);
        const result = yield* Fiber.join(loading);
        if (mode === "replacement snapshot") {
          expect(result).toEqual({ _tag: "noop" });
          const state = yield* SubscriptionRef.get(harness.threadState);
          expect(Option.getOrThrow(state.data).visibleTurnItems).toEqual(
            BASE_PROJECTION.visibleTurnItems,
          );
          expect(state.history.historyCursor).toBeNull();
          return;
        }
        if (mode === "retry") {
          expect(result._tag).toBe("error");
          // The ordinary load-earlier button must also finish a failed search load.
          expect(yield* harness.loadEarlier()).toEqual({ _tag: "loaded" });
        } else expect(result).toEqual({ _tag: "loaded" });
        const complete = yield* SubscriptionRef.get(harness.threadState);
        expect(complete.history).toMatchObject({
          loading: false,
          historyCursor: "next-cursor",
          error: null,
          latestLocalTurnOrdinal: 47,
        });
        expect(
          Option.getOrThrow(complete.data).visibleTurnItems.map((row) => row.sourceItemId),
        ).toEqual([message.id, activity.id]);
        expect(Option.getOrThrow(complete.data).turnItems).toHaveLength(2);
      }),
  );

  it.effect("restores compact socket snapshot turnItems before reducing and caching", () =>
    Effect.gen(function* () {
      const at = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
      const command = (id: string, ordinal: number, threadId = THREAD_ID) =>
        ({
          id: TurnItemId.make(id),
          threadId,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal,
          status: "completed" as const,
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "command_execution" as const,
          input: id,
          output: id,
          exitCode: 0,
        }) satisfies OrchestrationV2TurnItem;
      const parentThread = ThreadId.make("thread:compact-parent");
      const inherited = command("parent-item", 1, parentThread);
      const local = [command("local-1", 1), command("local-2", 2)];
      const retainedRequest = {
        ...command("retained-request", 0),
        type: "run_interrupt_request" as const,
        message: "Stop",
      } as unknown as OrchestrationV2TurnItem;
      const visibleTurnItems = [
        {
          position: 0,
          visibility: "inherited" as const,
          sourceThreadId: parentThread,
          sourceItemId: inherited.id,
          item: inherited,
        },
        ...local.map((item, index) => ({
          position: index + 1,
          visibility: "local" as const,
          sourceThreadId: THREAD_ID,
          sourceItemId: item.id,
          item,
        })),
      ];
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, {
        kind: "snapshot",
        snapshotSequence: 5,
        // Only the dependency that is not a visible local row is on the wire.
        projection: { ...BASE_PROJECTION, turnItems: [retainedRequest], visibleTurnItems },
        historyCursor: "compact-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 2,
        turnItemsOmitLocalVisible: true,
      });

      const seeded = yield* awaitThreadState(
        harness.observed,
        (value) => value.history.historyCursor === "compact-cursor",
      );
      expect(Option.getOrThrow(seeded.data).turnItems).toEqual([...local, retainedRequest]);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);
      expect(yield* Ref.get(harness.lastAcceptCompactTurnItems)).toBe(true);

      // Live updates reduce against the restored list, not the compact one.
      const updated = { ...local[1]!, output: "updated", ordinal: 2 };
      yield* Queue.offer(harness.inputs, {
        kind: "event",
        sequence: 6,
        event: {
          id: EventId.make("event-compact-update"),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          occurredAt: at,
          payload: updated,
        },
      });
      const live = yield* awaitThreadState(harness.observed, (value) =>
        Option.exists(value.data, (data) =>
          data.turnItems.some(
            (item) => item.type === "command_execution" && item.output === "updated",
          ),
        ),
      );
      expect(Option.getOrThrow(live.data).turnItems.map((item) => String(item.id))).toEqual([
        "local-1",
        "local-2",
        "retained-request",
      ]);

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.projection.turnItems.map((item) => String(item.id))).toEqual([
        "local-1",
        "local-2",
        "retained-request",
      ]);
      expect(saved && "turnItemsOmitLocalVisible" in saved).toBe(false);
    }),
  );

  it.effect("loads a cold snapshot while initial config is still pending", () =>
    Effect.gen(function* () {
      const config = yield* Deferred.make<never>();
      const loaded = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        initialConfig: Deferred.await(config),
        onSnapshotLoad: Deferred.succeed(loaded, undefined).pipe(Effect.asVoid),
      });
      yield* Deferred.await(loaded);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);
    }),
  );

  it.effect("reloads a warm cache that holds a pending question without its item", () =>
    Effect.gen(function* () {
      const requestId = RuntimeRequestId.make("hidden-question");
      const questionItem = {
        id: TurnItemId.make("hidden-question-item"),
        threadId: BASE_PROJECTION.thread.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "waiting",
        title: null,
        startedAt: BASE_PROJECTION.updatedAt,
        completedAt: null,
        updatedAt: BASE_PROJECTION.updatedAt,
        type: "user_input_request",
        requestId,
        questions: [{ id: "q1", header: "Post", question: "Post it?", options: [] }],
      } as unknown as OrchestrationV2ThreadProjection["turnItems"][number];
      const cached: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        runtimeRequests: [
          {
            id: requestId,
            nodeId: null,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: BASE_PROJECTION.updatedAt,
            resolvedAt: null,
          },
        ] as unknown as OrchestrationV2ThreadProjection["runtimeRequests"],
      };
      const fresh = { ...cached, turnItems: [questionItem] };
      const harness = yield* makeHarness({
        cached,
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: CACHED_SNAPSHOT_SEQUENCE + 5, projection: fresh },
        },
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.turnItems.some((item) => item.id === questionItem.id),
      );

      expect(Option.getOrThrow(state.data).turnItems).toContainEqual(questionItem);
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      yield* awaitThreadState(harness.observed, (value) => value.status === "live").pipe(
        Effect.timeoutOption("1 second"),
      );
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 5);
    }),
  );

  it.effect("seeds the thread from the HTTP snapshot and resumes live events", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "HTTP title" },
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 1, projection: httpProjection },
        },
      });
      // No socket snapshot is pushed; only a live event arrives over the socket.
      // It can only be applied if the HTTP snapshot already seeded the thread.
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
      // Cold cache: the full snapshot was loaded over HTTP and the socket
      // resumed from that snapshot's sequence.
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(1);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);
    }),
  );

  it.effect("installs bounded snapshot history meta and resumes via afterSequence", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Bounded title" },
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 11, projection: httpProjection },
          history: {
            historyCursor: "opaque-cursor",
            hasMoreHistory: true,
          },
        },
      });
      yield* Queue.offer(harness.inputs, titleUpdated("Live after bounded", 12));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live after bounded" &&
          value.history.hasMoreHistory,
      );

      expect(state.appliedSequence).toBe(12);
      expect(state.history).toMatchObject({
        historyCursor: "opaque-cursor",
        hasMoreHistory: true,
        loading: false,
        error: null,
        expanded: false,
      });
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(11);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);
      // Bounded HTTP success must not require a socket snapshot frame.
      expect(Option.getOrThrow(state.data).thread.title).toBe("Live after bounded");
    }),
  );

  it.effect("persists progressive history meta with a settled bounded snapshot", () =>
    Effect.gen(function* () {
      const httpProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Bounded cache title" },
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: { snapshotSequence: 4, projection: httpProjection },
          history: {
            historyCursor: "cursor-oldest",
            hasMoreHistory: true,
          },
        },
      });
      // Bounded install alone (settled) must enqueue progressive meta with the
      // projection. Never persist the partial window as a complete full snapshot.
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Bounded cache title" &&
          value.history.historyCursor === "cursor-oldest",
      );
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;

      const savedAll = yield* Ref.get(harness.savedThreads);
      expect(savedAll.length).toBeGreaterThanOrEqual(1);
      const first = savedAll[0];
      expect(first?.snapshotSequence).toBe(4);
      expect(first?.projection.thread.title).toBe("Bounded cache title");
      expect(first?.historyCursor).toBe("cursor-oldest");
      expect(first?.hasMoreHistory).toBe(true);
      // No earlier complete-looking entry without progressive meta.
      expect(
        savedAll.some(
          (entry) =>
            entry.projection.thread.title === "Bounded cache title" &&
            entry.historyCursor === undefined &&
            entry.hasMoreHistory === undefined,
        ),
      ).toBe(false);

      // A later live update still carries the progressive cursor.
      yield* Queue.offer(harness.inputs, titleUpdated("Settled bounded", 5));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Settled bounded",
      );
      yield* TestClock.adjust("10 seconds");
      yield* Effect.yieldNow;

      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.snapshotSequence).toBe(5);
      expect(saved?.projection.thread.title).toBe("Settled bounded");
      expect(saved?.historyCursor).toBe("cursor-oldest");
      expect(saved?.hasMoreHistory).toBe(true);
    }),
  );

  it.effect.each([1, 3])(
    "requests the configured %s-turn mobile window and persists it as partial history",
    (limit) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ snapshotUserTurnLimit: limit });
        yield* Queue.offer(harness.inputs, {
          ...snapshot(BASE_PROJECTION, 4),
          historyCursor: "older-turns-cursor",
          hasMoreHistory: true,
          latestLocalTurnOrdinal: 3,
        });
        yield* awaitThreadState(
          harness.observed,
          (value) => value.history.historyCursor === "older-turns-cursor",
        );
        expect(yield* Ref.get(harness.lastSnapshotUserTurnLimit)).toBe(limit);
        yield* TestClock.adjust("500 millis");
        yield* Effect.yieldNow;
        expect((yield* Ref.get(harness.savedThreads)).at(-1)).toMatchObject({
          snapshotSequence: 4,
          historyCursor: "older-turns-cursor",
          hasMoreHistory: true,
        });
      }),
  );

  it.effect("warm resume restores progressive history meta and skips HTTP", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Cached bounded" },
        },
        cachedHistory: {
          historyCursor: "warm-cursor",
          hasMoreHistory: true,
        },
      });

      // Apply a live event so the subscription is known to have resumed from cache.
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Cached bounded live", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Cached bounded live" &&
          value.history.hasMoreHistory,
      );

      expect(state.history).toMatchObject({
        historyCursor: "warm-cursor",
        hasMoreHistory: true,
        expanded: false,
      });
      // Warm progressive cache must not re-download; resume via afterSequence.
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBe(true);
    }),
  );

  it.effect("legacy warm cache without history meta stays complete (no false load-earlier)", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));
      expect(state.history).toMatchObject({
        historyCursor: null,
        hasMoreHistory: false,
        expanded: false,
      });
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBeUndefined();
    }),
  );

  it.effect.each(["disk", "retained"] as const)(
    "retains paging support through a complete bounded %s cache",
    (cacheKind) =>
      Effect.gen(function* () {
        const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
          snapshot: undefined,
          owner: undefined,
        };
        const cold = yield* Effect.scoped(
          Effect.gen(function* () {
            const harness = yield* makeHarness({
              resumeCache,
              httpSnapshot: {
                _tag: "present",
                snapshot: { snapshotSequence: 4, projection: BASE_PROJECTION },
                history: {
                  historyCursor: null,
                  hasMoreHistory: false,
                  latestLocalTurnOrdinal: null,
                },
              },
            });
            yield* Queue.offer(harness.inputs, titleUpdated("Complete bounded", 5));
            yield* awaitThreadState(
              harness.observed,
              (value) =>
                value.status === "live" &&
                Option.isSome(value.data) &&
                value.data.value.thread.title === "Complete bounded",
            );
            return harness;
          }),
        );
        const saved = (yield* Ref.get(cold.savedThreads)).at(-1);
        expect(saved).toMatchObject({
          snapshotSequence: 5,
          historyCursor: null,
          hasMoreHistory: false,
          latestLocalTurnOrdinal: null,
        });

        const warm = yield* makeHarness(
          cacheKind === "retained"
            ? { resumeCache }
            : { loadCached: Effect.succeed(Option.some(saved!)) },
        );
        // The thread may have grown past the replay budget while closed. Its
        // warm subscription must still allow the server to bound that fallback.
        yield* Queue.offer(warm.inputs, titleUpdated("Grown while closed", 200));
        yield* awaitThreadState(
          warm.observed,
          (value) =>
            value.status === "live" &&
            Option.isSome(value.data) &&
            value.data.value.thread.title === "Grown while closed",
        );
        expect(yield* Ref.get(warm.loaderCalls)).toBe(0);
        expect(yield* Ref.get(warm.lastSubscribeAfterSequence)).toBe(5);
        expect(yield* Ref.get(warm.lastAcceptBoundedSnapshot)).toBe(true);
      }),
  );

  it.effect.each(["no-http", "no-controller"] as const)(
    "does not negotiate bounded fallbacks with %s",
    (historyPaging) =>
      Effect.gen(function* () {
        for (const source of ["cache", "http"] as const) {
          const history = {
            historyCursor: "known-paging-cursor",
            hasMoreHistory: true,
          };
          const harness = yield* makeHarness({
            historyPaging,
            ...(source === "cache"
              ? { cached: BASE_PROJECTION, cachedHistory: history }
              : {
                  httpSnapshot: {
                    _tag: "present" as const,
                    snapshot: { snapshotSequence: 4, projection: BASE_PROJECTION },
                    history,
                  },
                }),
          });
          yield* Queue.offer(harness.inputs, titleUpdated("Paging unavailable", 10));
          yield* awaitThreadState(
            harness.observed,
            (value) =>
              value.status === "live" &&
              Option.isSome(value.data) &&
              value.data.value.thread.title === "Paging unavailable",
          );
          expect(yield* Ref.get(harness.lastAcceptBoundedSnapshot)).toBeUndefined();
        }
      }),
  );

  it.effect("socket snapshot clears progressive history meta left from a bounded window", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Warm progressive" },
        },
        cachedHistory: {
          historyCursor: "stale-cursor",
          hasMoreHistory: true,
        },
      });

      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Full socket snapshot" },
          },
          CACHED_SNAPSHOT_SEQUENCE + 1,
        ),
      );

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Full socket snapshot" &&
          value.history.historyCursor === null &&
          value.history.hasMoreHistory === false,
      );

      expect(state.history).toMatchObject({
        historyCursor: null,
        hasMoreHistory: false,
        expanded: false,
        loading: false,
        error: null,
      });

      // Settled full snapshot persistence must not keep the stale cursor.
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const saved = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(saved?.projection.thread.title).toBe("Full socket snapshot");
      expect(saved?.historyCursor).toBeNull();
      expect(saved?.hasMoreHistory).toBe(false);
    }),
  );

  it.effect("bounded socket fallback replaces progressive history meta during resume", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Warm progressive" },
        },
        cachedHistory: {
          historyCursor: "stale-cursor",
          hasMoreHistory: true,
          latestLocalTurnOrdinal: 3,
        },
      });

      yield* Queue.offer(harness.inputs, {
        ...snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "Bounded resume fallback" },
          },
          CACHED_SNAPSHOT_SEQUENCE + 1,
        ),
        historyCursor: "replacement-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 9,
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.getOrNull(value.data)?.thread.title === "Bounded resume fallback" &&
          value.history.historyCursor === "replacement-cursor",
      );

      expect(state.history).toMatchObject({
        historyCursor: "replacement-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 9,
        expanded: false,
        loading: false,
        error: null,
      });
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE);
    }),
  );

  it.effect("live events preserve progressive history meta under atomic setThread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 8,
            projection: {
              ...BASE_PROJECTION,
              thread: { ...BASE_PROJECTION.thread, title: "Bounded seed" },
            },
          },
          history: {
            historyCursor: "keep-me",
            hasMoreHistory: true,
          },
        },
      });

      yield* Queue.offer(harness.inputs, titleUpdated("Live preserves meta", 9));
      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live preserves meta",
      );

      expect(state.history).toMatchObject({
        historyCursor: "keep-me",
        hasMoreHistory: true,
        expanded: false,
      });
    }),
  );

  it.effect("bounded HTTP install sets projection and progressive meta atomically", () =>
    Effect.gen(function* () {
      // One setThread with explicit history (not applyItem reset + later meta).
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 2,
            projection: {
              ...BASE_PROJECTION,
              thread: { ...BASE_PROJECTION.thread, title: "Bounded atomic install" },
            },
          },
          history: {
            historyCursor: "post-install-cursor",
            hasMoreHistory: true,
          },
        },
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Bounded atomic install" &&
          value.history.historyCursor === "post-install-cursor" &&
          value.history.hasMoreHistory === true,
      );

      expect(state.history).toMatchObject({
        historyCursor: "post-install-cursor",
        hasMoreHistory: true,
        loading: false,
        error: null,
        expanded: false,
      });
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(2);
    }),
  );

  it.effect("dropped partial-timeline turn item is a true applyItem no-op", () =>
    Effect.gen(function* () {
      const recent = {
        id: TurnItemId.make("item-window"),
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 10,
        status: "completed" as const,
        title: null,
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        type: "command_execution" as const,
        input: "pwd",
        output: "ok",
        exitCode: 0,
      } satisfies OrchestrationV2TurnItem;
      const recentRow = {
        position: 0,
        visibility: "local" as const,
        sourceThreadId: THREAD_ID,
        sourceItemId: recent.id,
        item: recent,
      };
      const boundedProjection: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        thread: { ...BASE_PROJECTION.thread, title: "Partial noop" },
        turnItems: [recent],
        visibleTurnItems: [recentRow],
      };
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 5,
            projection: boundedProjection,
            latestLocalTurnOrdinal: 10,
          },
          history: {
            historyCursor: "partial-cursor",
            hasMoreHistory: true,
            latestLocalTurnOrdinal: 10,
          },
        },
      });

      const seeded = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Partial noop" &&
          value.history.historyCursor === "partial-cursor",
      );
      const seededProjection = Option.getOrThrow(seeded.data);
      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const savedBefore = (yield* Ref.get(harness.savedThreads)).length;

      const older = {
        ...recent,
        id: TurnItemId.make("item-old-outside"),
        ordinal: 3,
        output: "must-not-append",
      } satisfies OrchestrationV2TurnItem;
      yield* Queue.offer(harness.inputs, {
        kind: "event",
        sequence: 6,
        event: {
          id: EventId.make("event-old-partial"),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          occurredAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
          payload: older,
        },
      });

      // Allow the event to be processed without requiring a state transition.
      for (let attempt = 0; attempt < 30; attempt += 1) {
        yield* Effect.yieldNow;
      }
      // Drive a later unrelated title update so we know the stream continued.
      yield* Queue.offer(harness.inputs, titleUpdated("After dropped event", 7));
      const after = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "After dropped event",
      );

      // The dropped event must not have appended the old item.
      expect(Option.getOrThrow(after.data).turnItems.map((item) => String(item.id))).toEqual([
        String(recent.id),
      ]);
      // Watermark unchanged (only advanced on successful newer turn-item applies).
      expect(after.history.latestLocalTurnOrdinal).toBe(10);
      // No persistence enqueue from the dropped event itself.
      const savedAfterDrop = (yield* Ref.get(harness.savedThreads)).length;
      expect(savedAfterDrop).toBe(savedBefore);
      // Seeded projection reference path: event path kept partial meta intact.
      expect(after.history.historyCursor).toBe("partial-cursor");
      expect(after.history.hasMoreHistory).toBe(true);
      // Title event applied; drop itself did not clear progressive meta.
      expect(seededProjection.turnItems.map((item) => String(item.id))).toEqual([
        String(recent.id),
      ]);
    }),
  );

  it.effect("installs and advances latestLocalTurnOrdinal for partial progressive windows", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: {
          _tag: "present",
          snapshot: {
            snapshotSequence: 3,
            projection: {
              ...BASE_PROJECTION,
              thread: { ...BASE_PROJECTION.thread, title: "Watermark seed" },
            },
            latestLocalTurnOrdinal: 15,
          },
          history: {
            historyCursor: "wm-cursor",
            hasMoreHistory: true,
            latestLocalTurnOrdinal: 15,
          },
        },
      });

      const seeded = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Watermark seed" &&
          value.history.latestLocalTurnOrdinal === 15,
      );
      expect(seeded.history.latestLocalTurnOrdinal).toBe(15);

      yield* TestClock.adjust("500 millis");
      yield* Effect.yieldNow;
      const savedSeed = (yield* Ref.get(harness.savedThreads)).at(-1);
      expect(savedSeed?.latestLocalTurnOrdinal).toBe(15);

      const newer = {
        id: TurnItemId.make("item-newer-live"),
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 22,
        status: "completed" as const,
        title: null,
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        type: "command_execution" as const,
        input: "echo newer",
        output: "newer",
        exitCode: 0,
      } satisfies OrchestrationV2TurnItem;

      yield* Queue.offer(harness.inputs, {
        kind: "event",
        sequence: 4,
        event: {
          id: EventId.make("event-newer-item"),
          type: "turn-item.updated",
          threadId: THREAD_ID,
          occurredAt: DateTime.makeUnsafe("2026-06-20T01:00:00.000Z"),
          payload: newer,
        },
      });

      const advanced = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.history.latestLocalTurnOrdinal === 22 &&
          value.data.value.turnItems.some((item) => String(item.id) === String(newer.id)),
      );
      expect(advanced.history.latestLocalTurnOrdinal).toBe(22);
      expect(advanced.history.historyCursor).toBe("wm-cursor");
    }),
  );

  it.effect("warm resume restores latestLocalTurnOrdinal from progressive cache", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        cached: {
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Warm watermark" },
        },
        cachedHistory: {
          historyCursor: "warm-wm-cursor",
          hasMoreHistory: true,
          latestLocalTurnOrdinal: 33,
        },
      });

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Warm watermark" &&
          value.history.latestLocalTurnOrdinal === 33,
      );
      expect(state.history).toMatchObject({
        historyCursor: "warm-wm-cursor",
        hasMoreHistory: true,
        latestLocalTurnOrdinal: 33,
        expanded: false,
      });
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect("shows a thread deleted only after every not-found recheck, then parks", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: { _tag: "missing" },
      });

      yield* settle;
      // The first answer alone is not a deletion: a new thread may not exist yet.
      expect((yield* Ref.get(harness.latest)).status).not.toBe("deleted");
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1);

      yield* waitOutMissRechecks;
      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );

      expect(Option.isNone(state.data)).toBe(true);
      expect(Option.isNone(state.error)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1 + MISS_RECHECKS);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);

      // Parked: no retries on its own, one plain check per new session.
      yield* TestClock.adjust("1 minute");
      yield* settle;
      expect(yield* Ref.get(harness.loaderCalls)).toBe(1 + MISS_RECHECKS);
      yield* harness.replaceSession;
      yield* settle;
      expect(yield* Ref.get(harness.loaderCalls)).toBe(2 + MISS_RECHECKS);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(0);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
      expect((yield* Ref.get(harness.latest)).status).toBe("deleted");
    }),
  );

  it.effect("loads a thread the server creates after its first not-found answer", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshots: [{ _tag: "missing" }, { _tag: "missing" }, PRESENT_SNAPSHOT],
      });

      yield* waitOutMissRechecks;
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(3);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([]);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
    }),
  );

  it.effect("recovers a not-found thread on the next session once the server has it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshots: [
          ...Array.from({ length: 1 + MISS_RECHECKS }, () => ({ _tag: "missing" as const })),
          PRESENT_SNAPSHOT,
        ],
      });
      yield* waitOutMissRechecks;
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");

      yield* harness.replaceSession;
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(state.status).not.toBe("deleted");
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
    }),
  );

  it.effect("checks a not-found thread again when its creation is delivered", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshots: [
          ...Array.from({ length: 1 + MISS_RECHECKS }, () => ({ _tag: "missing" as const })),
          PRESENT_SNAPSHOT,
        ],
      });
      yield* waitOutMissRechecks;
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");

      recheckMissingThread(TARGET.environmentId, THREAD_ID);
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(2 + MISS_RECHECKS);
    }),
  );

  it.effect("shows a delivered thread loading, not deleted, while it is fetched again", () =>
    Effect.gen(function* () {
      const fetching = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const loads = yield* Ref.make(0);
      const harness = yield* makeHarness({
        httpSnapshots: [
          ...Array.from({ length: 1 + MISS_RECHECKS }, () => ({ _tag: "missing" as const })),
          PRESENT_SNAPSHOT,
        ],
        onSnapshotLoad: Ref.updateAndGet(loads, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 2 + MISS_RECHECKS
              ? Deferred.succeed(fetching, undefined).pipe(Effect.andThen(Deferred.await(release)))
              : Effect.void,
          ),
        ),
      });
      yield* waitOutMissRechecks;
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");

      recheckMissingThread(TARGET.environmentId, THREAD_ID);
      yield* Deferred.await(fetching);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");

      yield* Deferred.succeed(release, undefined);
      const state = yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.data));
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
    }),
  );

  it.effect("never shows deleted when the creation lands during the last recheck", () =>
    Effect.gen(function* () {
      const seen: Array<string> = [];
      const harness = yield* makeHarness({
        httpSnapshots: [
          ...Array.from({ length: 1 + MISS_RECHECKS }, () => ({ _tag: "missing" as const })),
          PRESENT_SNAPSHOT,
        ],
      });
      // Every recheck but the last, then the creation's signal before the last answer.
      for (const delay of ["500 millis", "1 second", "2 seconds"] as const) {
        yield* settle;
        yield* TestClock.adjust(delay);
      }
      yield* settle;
      recheckMissingThread(TARGET.environmentId, THREAD_ID);
      yield* TestClock.adjust("4 seconds");
      yield* settle;

      const state = yield* Queue.take(harness.observed).pipe(
        Effect.tap((value) => Effect.sync(() => seen.push(value.status))),
        Effect.repeat({ until: (value) => Option.isSome(value.data) }),
      );
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(seen).not.toContain("deleted");
      expect(yield* Ref.get(harness.removedThreads)).toEqual([]);
    }),
  );

  it.effect("ignores a recheck request for a thread a delete event removed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      const update = deleted();
      if (update.kind !== "event") return yield* Effect.die("Expected an event");
      yield* Queue.offer(harness.inputs, { ...update, sequence: 8 });
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");
      const subscriptions = yield* Ref.get(harness.subscriptionCount);

      yield* TestClock.adjust("5 seconds");
      recheckMissingThread(TARGET.environmentId, THREAD_ID);
      yield* settle;

      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(subscriptions);
    }),
  );

  it.effect("checks a not-found thread again when it is opened again", () =>
    Effect.gen(function* () {
      const resumeCache: NonNullable<Parameters<typeof makeEnvironmentThreadState>[1]> = {
        snapshot: undefined,
        owner: undefined,
      };
      yield* Effect.scoped(
        Effect.gen(function* () {
          const first = yield* makeHarness({ httpSnapshot: { _tag: "missing" }, resumeCache });
          yield* waitOutMissRechecks;
          yield* awaitThreadState(first.observed, (value) => value.status === "deleted");
        }),
      );
      expect(resumeCache.snapshot?.deletedByMiss).toBe(true);

      const reopened = yield* makeHarness({ httpSnapshot: PRESENT_SNAPSHOT, resumeCache });
      const firstState = yield* Queue.take(reopened.observed);
      expect(firstState.status).not.toBe("deleted");
      const state = yield* awaitThreadState(reopened.observed, (value) =>
        Option.isSome(value.data),
      );
      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(yield* Ref.get(reopened.loaderCalls)).toBe(1);
    }),
  );

  it.effect("keeps a delete event final across new sessions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      const update = deleted();
      if (update.kind !== "event") return yield* Effect.die("Expected an event");
      yield* Queue.offer(harness.inputs, { ...update, sequence: 8 });
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");
      const subscriptions = yield* Ref.get(harness.subscriptionCount);

      yield* harness.replaceSession;
      yield* settle;

      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(subscriptions);
      expect((yield* Ref.get(harness.latest)).status).toBe("deleted");
    }),
  );

  it.effect("falls back to the socket when the HTTP snapshot is only unavailable", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        httpSnapshot: { _tag: "unavailable" },
      });

      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Socket title" },
        }),
      );

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Socket title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Socket title");
      expect(yield* Ref.get(harness.loaderCalls)).toBeGreaterThanOrEqual(1);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([]);
    }),
  );

  it.effect("ignores replayed thread events at or below the snapshot sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, titleUpdated("Replayed title", 1));
      yield* Queue.offer(harness.inputs, titleUpdated("Live title", 2));

      const state = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Live title",
      );

      expect(Option.getOrThrow(state.data).thread.title).toBe("Live title");
    }),
  );

  it.effect("does not recreate a deleted cache from a queued save or finalizer", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      yield* TestClock.adjust("500 millis");
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(1);

      yield* Queue.offer(harness.inputs, titleUpdated("Queued before deletion"));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) && value.data.value.thread.title === "Queued before deletion",
      );
      yield* Queue.offer(harness.inputs, deleted());
      const state = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "deleted",
      );
      expect(Option.isNone(state.data)).toBe(true);
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);

      yield* TestClock.adjust("10 seconds");
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(1);
      yield* Scope.close(scope, Exit.void);
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(1);
    }),
  );

  it.effect("takes back a cache copy whose save was running when the thread was deleted", () =>
    Effect.gen(function* () {
      const writing = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const harness = yield* makeHarness({
        saveThread: () =>
          Deferred.succeed(writing, undefined).pipe(Effect.andThen(Deferred.await(release))),
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");
      yield* TestClock.adjust("500 millis");
      yield* Deferred.await(writing);

      yield* Queue.offer(harness.inputs, deleted());
      yield* awaitThreadState(harness.observed, (value) => value.status === "deleted");
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID]);

      yield* Deferred.succeed(release, undefined);
      yield* settle;
      expect(yield* Ref.get(harness.removedThreads)).toEqual([THREAD_ID, THREAD_ID]);
    }),
  );

  it.effect("leaves Working when the server resends the thread after the client fell behind", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const run = {
        id: RunId.make("run-burst"),
        threadId: THREAD_ID,
        ordinal: 1,
        providerInstanceId: BASE_PROJECTION.thread.providerInstanceId,
        modelSelection: BASE_PROJECTION.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message-burst"),
        rootNodeId: null,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: v2Now,
        startedAt: v2Now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };
      yield* Queue.offer(harness.inputs, snapshot({ ...BASE_PROJECTION, runs: [run] }, 4));
      yield* Queue.offer(harness.inputs, titleUpdated("Mid burst", 5));
      yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.thread.title === "Mid burst",
      );

      // The server dropped the tail it could not deliver (the run's completion among it)
      // and resent the thread on the same subscription, then kept streaming.
      yield* Queue.offer(
        harness.inputs,
        snapshot(
          {
            ...BASE_PROJECTION,
            thread: { ...BASE_PROJECTION.thread, title: "After burst" },
            runs: [{ ...run, status: "completed", completedAt: v2Now }],
          },
          1_500,
        ),
      );
      yield* Queue.offer(harness.inputs, titleUpdated("Live again", 1_501));
      const caughtUp = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.thread.title === "Live again",
      );

      expect(caughtUp.status).toBe("live");
      expect(Option.isNone(caughtUp.error)).toBe(true);
      expect(Option.getOrThrow(caughtUp.data).runs.map((entry) => entry.status)).toEqual([
        "completed",
      ]);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);
    }),
  );

  it.effect("caches a running thread once when its view closes, not on each update", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      const harness = yield* makeHarness().pipe(Effect.provideService(Scope.Scope, scope));
      const running: OrchestrationV2ThreadProjection = {
        ...BASE_PROJECTION,
        runs: [
          {
            id: RunId.make("run-running"),
            threadId: THREAD_ID,
            ordinal: 1,
            providerInstanceId: BASE_PROJECTION.thread.providerInstanceId,
            modelSelection: BASE_PROJECTION.thread.modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message-running"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "running",
            requestedAt: v2Now,
            startedAt: v2Now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        ],
      };
      yield* Queue.offer(harness.inputs, snapshot(running, 4));
      yield* Queue.offer(harness.inputs, titleUpdated("Streaming update", 5));
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          Option.isSome(value.data) && value.data.value.thread.title === "Streaming update",
      );
      yield* TestClock.adjust("10 seconds");
      expect(yield* Ref.get(harness.savedThreads)).toHaveLength(0);

      yield* Scope.close(scope, Exit.void);
      const saved = yield* Ref.get(harness.savedThreads);
      expect(saved).toHaveLength(1);
      expect(saved[0]?.snapshotSequence).toBe(5);
      expect(saved[0]?.projection.thread.title).toBe("Streaming update");
      expect(saved[0]?.projection.runs[0]?.status).toBe("running");
    }),
  );

  it.effect("preserves data after a domain failure and resumes on a replacement session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* Queue.offer(harness.inputs, new Error("stream failed"));

      const state = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );

      expect(Option.getOrThrow(state.data)).toEqual(BASE_PROJECTION);
      expect(Option.getOrThrow(state.error)).toBe("stream failed");
      expect(yield* Ref.get(harness.retryCount)).toBe(0);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Recovered thread" },
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Recovered thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );

  it.effect("recovers from a transient domain failure without replacing the session", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* Queue.offer(harness.inputs, new Error("thread not found yet"));

      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("thread not found yet");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("250 millis");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) {
          break;
        }
        yield* Effect.yieldNow;
      }
      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Materialized thread" },
        }),
      );

      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Materialized thread",
      );

      expect(Option.isNone(recovered.error)).toBe(true);
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.retryCount)).toBe(0);
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        routeFailures: new Map(),
        activeRouteId: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_PROJECTION));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        routeFailures: new Map(),
        activeRouteId: null,
        retryAt: null,
      });
      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );

  it.effect("resubscribes after a stream defect instead of staying blank", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ httpSnapshot: { _tag: "unavailable" } });
      yield* Queue.offer(harness.inputs, TEST_DEFECT);
      const failed = yield* awaitThreadState(harness.observed, (value) =>
        Option.isSome(value.error),
      );
      expect(Option.getOrThrow(failed.error)).toBe("Could not synchronize the thread.");

      // The backoff starts after the error is shown, so step the clock until it resubscribes.
      const resubscribed = yield* TestClock.adjust("250 millis").pipe(
        Effect.andThen(Ref.get(harness.subscriptionCount)),
        Effect.repeat({ until: (count) => count >= 2, times: 20 }),
      );
      expect(resubscribed).toBe(2);

      yield* Queue.offer(
        harness.inputs,
        snapshot({
          ...BASE_PROJECTION,
          thread: { ...BASE_PROJECTION.thread, title: "Recovered thread" },
        }),
      );
      const recovered = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Recovered thread",
      );
      expect(Option.isNone(recovered.error)).toBe(true);

      // A defect right after a snapshot that applied waits longer, not 250 ms again.
      yield* Queue.offer(harness.inputs, TEST_DEFECT);
      yield* awaitThreadState(harness.observed, (value) => Option.isSome(value.error));
      yield* TestClock.adjust("250 millis");
      yield* Effect.yieldNow;
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      const again = yield* TestClock.adjust("250 millis").pipe(
        Effect.andThen(Ref.get(harness.subscriptionCount)),
        Effect.repeat({ until: (count) => count >= 3, times: 20 }),
      );
      expect(again).toBe(3);
    }),
  );

  it.effect("keeps replayed updates synchronizing until the completion marker arrives", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);

      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Caught-up title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      const catchingUp = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "synchronizing" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Caught-up title",
      );
      expect(catchingUp.status).toBe("synchronizing");

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("Caught-up title");
    }),
  );

  it.effect("skips an unknown event type and resumes after it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      const unknown = (sequence: number): OrchestrationV2ThreadStreamItem => ({
        kind: "unknown-event",
        sequence,
        eventType: "run.from-a-future-server",
      });
      const occurredAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
      yield* Queue.offerAll(harness.inputs, [
        {
          kind: "event",
          sequence: CACHED_SNAPSHOT_SEQUENCE + 1,
          event: {
            id: EventId.make("event-message"),
            type: "message.updated",
            threadId: THREAD_ID,
            occurredAt,
            payload: {
              id: MessageId.make("message-before"),
              threadId: THREAD_ID,
              runId: null,
              nodeId: null,
              role: "assistant",
              text: "Before",
              streaming: false,
              attachments: [],
              createdBy: "agent",
              creationSource: "provider",
              createdAt: occurredAt,
              updatedAt: occurredAt,
            },
          },
        },
        unknown(CACHED_SNAPSHOT_SEQUENCE + 2),
        titleUpdated("After", CACHED_SNAPSHOT_SEQUENCE + 3),
        // A trailing unknown event must still advance the resume cursor.
        unknown(CACHED_SNAPSHOT_SEQUENCE + 4),
        synchronized(),
      ]);
      const live = yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "After",
      );
      expect(Option.isNone(live.error)).toBe(true);
      expect(Option.getOrThrow(live.data).messages.map((message) => message.text)).toEqual([
        "Before",
      ]);

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 4);
    }),
  );

  it.effect("resumes replacement sessions from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Latest title",
      );

      yield* harness.replaceSession;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect((yield* Ref.get(harness.latest)).status).toBe("synchronizing");
    }),
  );

  it.effect("resubscribes on app foreground from the latest applied sequence", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* Queue.offer(
        harness.inputs,
        titleUpdated("Latest title", CACHED_SNAPSHOT_SEQUENCE + 1),
      );
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(
        harness.observed,
        (value) =>
          value.status === "live" &&
          Option.isSome(value.data) &&
          value.data.value.thread.title === "Latest title",
      );

      // Past the settle window after the subscription started.
      yield* TestClock.adjust("3 seconds");
      yield* Queue.offer(harness.wakeups, "application-active");
      const synchronizing = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "synchronizing" && Option.isSome(value.data),
      );
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(synchronizing.status).toBe("synchronizing");
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(yield* Ref.get(harness.lastRequestCompletionMarker)).toBe(true);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);

      yield* Queue.offer(harness.inputs, synchronized());
      const live = yield* awaitThreadState(
        harness.observed,
        (value) => value.status === "live" && Option.isSome(value.data),
      );
      expect(Option.getOrThrow(live.data).thread.title).toBe("Latest title");

      yield* TestClock.adjust("3 seconds");
      yield* Queue.offer(harness.wakeups, "application-active-probe");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 3) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(3);

      // A long resume keeps a session that answers its probe, so the thread
      // catches up on it from its cursor too.
      yield* TestClock.adjust("3 seconds");
      yield* Queue.offer(harness.wakeups, "application-active-reconnect");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 4) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(4);
      yield* TestClock.adjust("3 seconds");
      yield* Queue.offer(harness.wakeups, "network-changed");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 5) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(5);
      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 1);
      expect(yield* Ref.get(harness.loaderCalls)).toBe(0);
    }),
  );

  it.effect("ignores a foreground signal right after the subscription started", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_PROJECTION, completionMarker: true });
      yield* Queue.offer(harness.inputs, synchronized());
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      // iOS reports the app active just after a cold launch connected: the
      // fresh subscription has nothing to catch up on, so it keeps running.
      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) yield* Effect.yieldNow;
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(1);

      yield* TestClock.adjust("3 seconds");
      yield* Queue.offer(harness.wakeups, "application-active");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }
      expect(yield* Ref.get(harness.subscriptionCount)).toBe(2);
    }),
  );
});
