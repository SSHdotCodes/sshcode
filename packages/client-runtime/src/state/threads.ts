import { isModelManagerThreadId } from "@t3tools/contracts";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId as EnvironmentIdType,
  type OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { Atom } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { subscribeDynamicMapped, subscriptionRetryDelay } from "../rpc/client.ts";
import { restoreThreadTextAppends } from "./threadTextAppends.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { THREAD_SNAPSHOT_IDLE_TTL_MS } from "./threadRetention.ts";
import { hasPendingUserInputWithoutItem } from "./threadRequests.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import * as ThreadHistoryController from "./threadHistoryController.ts";
import { fetchEnvironmentThreadHistoryPage } from "./threadHistoryHttp.ts";
import {
  applyHistoryPageMeta,
  clearActiveHistoryLoading,
  EMPTY_THREAD_HISTORY_META,
  isActiveHistoryRequestCursor,
  mergeOlderHistoryIntoProjection,
  type ThreadHistoryMeta,
} from "./threadHistoryMerge.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";
import {
  EMPTY_ENVIRONMENT_THREAD_STATE,
  type EnvironmentThreadState,
  type EnvironmentThreadStatus,
} from "./threadState.ts";
import { loadMarksEnabled, markLoad } from "../loadMarks.ts";

function statusWithoutLiveData(
  data: Option.Option<OrchestrationV2ThreadProjection>,
): EnvironmentThreadStatus {
  return Option.isSome(data) ? "cached" : "empty";
}

function formatThreadError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "Could not synchronize the thread.";
}

function formatHistoryError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return "Could not load earlier activity.";
}

function historyMetaFromCachedSnapshot(
  snapshot: OrchestrationV2ThreadDetailSnapshot,
): ThreadHistoryMeta {
  const historyCursor = snapshot.historyCursor ?? null;
  const hasMoreHistory = snapshot.hasMoreHistory ?? false;
  return {
    historyCursor,
    hasMoreHistory,
    loading: false,
    error: null,
    // Cache never stores expanded progressive history (load-earlier growth).
    expanded: false,
    latestLocalTurnOrdinal: snapshot.latestLocalTurnOrdinal ?? null,
  };
}

function snapshotToPersist(
  snapshotSequence: number,
  projection: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
  acceptsBoundedSnapshots: boolean,
): OrchestrationV2ThreadDetailSnapshot {
  // A complete bounded snapshot still proves paging support. Retain that evidence
  // so a thread that grows while closed can resume with a bounded fallback.
  if (acceptsBoundedSnapshots || history.hasMoreHistory || history.historyCursor !== null) {
    return {
      snapshotSequence,
      projection,
      historyCursor: history.historyCursor,
      hasMoreHistory: history.hasMoreHistory,
      latestLocalTurnOrdinal: history.latestLocalTurnOrdinal,
    };
  }
  return { snapshotSequence, projection };
}

function shouldPersistThread(
  thread: OrchestrationV2ThreadProjection,
  history: ThreadHistoryMeta,
): boolean {
  // After the user loads older pages the in-memory timeline can grow large.
  // Keep those expanded projections out of the monolithic cache.
  if (history.expanded) {
    return false;
  }
  return !thread.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

interface ThreadResumeSnapshot {
  readonly state: EnvironmentThreadState;
  readonly sequence: number;
  readonly persisted: boolean;
  readonly acceptsBoundedSnapshots?: boolean;
  /** Deleted only because the server said "not found", not by a delete event. */
  readonly deletedByMiss?: boolean;
}

/** First backoff before resubscribing a failed thread subscription; doubles per retry. */
const THREAD_SUBSCRIPTION_RETRY_DELAY = "250 millis";
/** Defects this far apart are unrelated, so the backoff starts over. */
const THREAD_DEFECT_BACKOFF_RESET_MS = 60_000;

/**
 * A not-found answer is only what the server knew then: a thread this client
 * just created (its first message still uploading) does not exist there yet.
 * Check again on this schedule before showing the thread as deleted.
 */
const MISS_RECHECK_DELAYS_MS: ReadonlyArray<number> = [500, 1_000, 2_000, 4_000];

function isDeletedByMiss(snapshot: ThreadResumeSnapshot | undefined): boolean {
  return snapshot?.state.status === "deleted" && snapshot.deletedByMiss === true;
}

/** Open loads by thread key, so a creation can ask a not-found load to look again. */
const missRecheckListeners = new Map<string, Set<() => void>>();

/**
 * Asks every open load of this thread that shows it deleted only because the
 * server said "not found" to check again now. Call once this client's own
 * creation of the thread has reached the server: a slow first upload can
 * outlast the recheck schedule.
 */
export function recheckMissingThread(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
): void {
  for (const listener of missRecheckListeners.get(threadKey({ environmentId, threadId })) ?? []) {
    listener();
  }
}

interface ThreadResumeCache {
  snapshot: ThreadResumeSnapshot | undefined;
  owner: object | undefined;
}

function matchesThreadSnapshot(
  current: ThreadResumeSnapshot,
  projection: OrchestrationV2ThreadProjection | null,
  sequence: number,
  history: Pick<ThreadHistoryMeta, "historyCursor" | "hasMoreHistory" | "latestLocalTurnOrdinal">,
): boolean {
  if (current.sequence !== sequence || Option.getOrNull(current.state.data) !== projection)
    return false;
  const currentHistory = current.state.history;
  return (
    currentHistory.historyCursor === history.historyCursor &&
    currentHistory.hasMoreHistory === history.hasMoreHistory &&
    (!(history.hasMoreHistory || history.historyCursor !== null) ||
      currentHistory.latestLocalTurnOrdinal === history.latestLocalTurnOrdinal)
  );
}

// A retained "live" state stays live: the cursor resume that follows only
// replays what the thread missed, and on servers that send the completion
// marker the first replayed event moves the status to "synchronizing" on its
// own. Downgrading here would flash a sync label on every return to a
// recently viewed thread.
function cachedThreadState(value: EnvironmentThreadState): EnvironmentThreadState {
  return {
    ...value,
    status:
      value.status === "deleted" || (value.status === "live" && Option.isSome(value.data))
        ? value.status
        : statusWithoutLiveData(value.data),
    error: Option.none(),
    history: { ...value.history, loading: false, error: null },
  };
}

let nextThreadLoadId = 0;

export const makeEnvironmentThreadState = Effect.fn("EnvironmentThreadState.make")(function* (
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const snapshotLoader = yield* ThreadSnapshotLoader.ThreadSnapshotLoader;
  const historyController = yield* Effect.serviceOption(
    ThreadHistoryController.ThreadHistoryController,
  );
  const httpClient = yield* Effect.serviceOption(HttpClient.HttpClient);
  const dpopSigner = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
  );
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  if (cache.retainThread) yield* cache.retainThread(environmentId, threadId);
  // A delete event is final; a not-found answer is checked again by the next load.
  const resumed = resumeCache?.snapshot;
  const retained = isDeletedByMiss(resumed) ? undefined : resumed;
  const loadId = ++nextThreadLoadId;
  let attempt = 0;
  let firstFrameAttempt = 0;
  const firstTextSeen = new Set<string>();
  const markDetail = () => ({
    environment: environmentId.slice(0, 8),
    thread: threadId.slice(0, 8),
    load: loadId,
    attempt,
  });
  markLoad("thread.start", { ...markDetail(), retained: retained !== undefined });
  const cacheLoadStartedAt = performance.now();
  const owner = {};
  if (resumeCache) resumeCache.owner = owner;
  const cached =
    retained === undefined
      ? yield* cache.loadThread(environmentId, threadId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not load cached thread.").pipe(
              Effect.annotateLogs({
                environmentId,
                threadId,
                error: error.message,
              }),
              Effect.as(Option.none<OrchestrationV2ThreadDetailSnapshot>()),
            ),
          ),
        )
      : Option.none<OrchestrationV2ThreadDetailSnapshot>();
  if (retained === undefined) {
    markLoad("thread.cached", {
      ...markDetail(),
      ms: Math.round(performance.now() - cacheLoadStartedAt),
      found: Option.isSome(cached),
    });
  }
  const cachedThread = Option.map(cached, (snapshot) => snapshot.projection);
  const initialState: EnvironmentThreadState = retained
    ? cachedThreadState(retained.state)
    : {
        appliedSequence: Option.isSome(cached) ? cached.value.snapshotSequence : 0,
        data: cachedThread,
        status: statusWithoutLiveData(cachedThread),
        error: Option.none(),
        history: Option.match(cached, {
          onNone: () => EMPTY_THREAD_HISTORY_META,
          onSome: historyMetaFromCachedSnapshot,
        }),
      };
  const state = yield* SubscriptionRef.make(initialState);
  // Paging support belongs to the client, even when the initial HTTP request
  // fails. A bounded socket reset retains a cursor so history can be retried.
  const canLoadHistory = Option.isSome(httpClient) && Option.isSome(historyController);
  const acceptsBoundedSocketSnapshots = yield* Ref.make(canLoadHistory);
  // Seed the resume cursor from the cached snapshot so a warm cache can catch up
  // via `afterSequence` instead of re-downloading the full thread body.
  const initialSequence =
    retained?.sequence ??
    Option.match(cached, { onNone: () => 0, onSome: (snapshot) => snapshot.snapshotSequence });
  const lastSequence = yield* SubscriptionRef.make(initialSequence);
  let committed: ThreadResumeSnapshot = {
    state: initialState,
    sequence: initialSequence,
    persisted: retained?.persisted ?? Option.isSome(cached),
    acceptsBoundedSnapshots: canLoadHistory,
  };
  if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  const awaitingCompletion = yield* Ref.make(false);
  const applyLock = yield* Semaphore.make(1);
  // Set when the deletion came from a not-found answer rather than a delete event.
  let deletedByMiss = false;
  // Save only completed data/cursor updates. A canceled scope must not cache
  // a cursor whose event has not reached the data yet.
  const remember = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const sequence = yield* SubscriptionRef.get(lastSequence);
    committed = {
      state: current,
      sequence,
      acceptsBoundedSnapshots: yield* Ref.get(acceptsBoundedSocketSnapshots),
      persisted:
        committed.persisted &&
        matchesThreadSnapshot(committed, Option.getOrNull(current.data), sequence, current.history),
      ...(deletedByMiss && current.status === "deleted" ? { deletedByMiss: true } : {}),
    };
    if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
  });
  const persistence = yield* Queue.sliding<OrchestrationV2ThreadDetailSnapshot>(1);

  const persist = Effect.fn("EnvironmentThreadState.persist")(function* (
    snapshot: OrchestrationV2ThreadDetailSnapshot,
  ) {
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
    // A deletion can arrive while an older snapshot waits in the persistence queue.
    if (committed.state.status === "deleted") return;
    if (
      committed.persisted &&
      matchesThreadSnapshot(
        committed,
        snapshot.projection,
        snapshot.snapshotSequence,
        historyMetaFromCachedSnapshot(snapshot),
      )
    )
      return;
    yield* cache.saveThread(environmentId, snapshot).pipe(
      // A deletion that landed while this save ran wins: take the copy back out.
      Effect.andThen(
        Effect.suspend(() =>
          committed.state.status === "deleted"
            ? cache.removeThread(environmentId, threadId)
            : Effect.void,
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          if (
            !matchesThreadSnapshot(
              committed,
              snapshot.projection,
              snapshot.snapshotSequence,
              historyMetaFromCachedSnapshot(snapshot),
            )
          )
            return;
          committed = { ...committed, persisted: true };
          if (resumeCache?.owner === owner) resumeCache.snapshot = committed;
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not persist the thread cache.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  yield* Effect.addFinalizer(() =>
    Effect.suspend(() => {
      const { state: current, sequence: snapshotSequence } = committed;
      return Option.match(current.data, {
        onNone: () => Effect.void,
        onSome: (projection) =>
          !current.history.expanded
            ? persist(
                snapshotToPersist(
                  snapshotSequence,
                  projection,
                  current.history,
                  committed.acceptsBoundedSnapshots === true,
                ),
              )
            : Effect.void,
      });
    }),
  );

  yield* runCachePersistence(persistence, persist).pipe(Effect.forkScoped);

  const setConnecting = SubscriptionRef.update(state, (current) =>
    current.status === "deleted" || Option.isSome(current.error)
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live" || current.status === "deleted" || Option.isSome(current.error)
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setDisconnected = Effect.gen(function* () {
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.update(state, (current) => ({
      ...current,
      status: current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
    }));
  });
  const setStreamError = (message: string) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status:
            current.status === "deleted" ? current.status : statusWithoutLiveData(current.data),
          error: Option.some(message),
        })),
      ),
    );

  const setThread = Effect.fn("EnvironmentThreadState.setThread")(function* (
    thread: OrchestrationV2ThreadProjection,
    options?: {
      /** Socket/full snapshots: drop progressive meta with the new timeline. */
      readonly resetHistory?: boolean;
      /**
       * Explicit progressive meta installed atomically with the projection
       * (bounded HTTP). Wins over resetHistory when both are supplied.
       */
      readonly history?: ThreadHistoryMeta;
    },
  ) {
    const waiting = yield* Ref.get(awaitingCompletion);
    const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
    // Atomic with concurrent history meta updates: never get-then-set the whole
    // state when only the projection changes. Bounded installs pass history so
    // projection + cursor persist together in one enqueue.
    const next = yield* SubscriptionRef.updateAndGet(state, (previous) => {
      const history =
        options?.history !== undefined
          ? options.history
          : options?.resetHistory === true
            ? EMPTY_THREAD_HISTORY_META
            : previous.history;
      return {
        ...previous,
        appliedSequence: snapshotSequence,
        data: Option.some(thread),
        // Buffered values from a failed attempt can arrive after its error.
        status: Option.isSome(previous.error)
          ? ("cached" as const)
          : waiting
            ? ("synchronizing" as const)
            : ("live" as const),
        error: previous.error,
        history,
      };
    });
    // Active projections can update many times per second and retain large tool
    // payloads. Persist once the run settles so cache encoding stays off the
    // streaming path. Progressive meta rides along when the window is incomplete.
    if (shouldPersistThread(thread, next.history)) {
      yield* Queue.offer(
        persistence,
        snapshotToPersist(
          snapshotSequence,
          thread,
          next.history,
          yield* Ref.get(acceptsBoundedSocketSnapshots),
        ),
      );
    }
  });

  const patchHistoryMeta = (patch: (history: ThreadHistoryMeta) => ThreadHistoryMeta) =>
    SubscriptionRef.update(state, (current) => ({
      ...current,
      history: patch(current.history),
    }));

  const setDeleted = Effect.fn("EnvironmentThreadState.setDeleted")(function* (
    cause: "event" | "miss",
  ) {
    // A delete event outranks an earlier miss; a miss never undoes a delete event.
    deletedByMiss =
      cause === "miss" &&
      ((yield* SubscriptionRef.get(state)).status !== "deleted" || deletedByMiss);
    yield* Ref.set(awaitingCompletion, false);
    yield* SubscriptionRef.set(state, {
      data: Option.none(),
      status: "deleted",
      error: Option.none(),
      history: EMPTY_THREAD_HISTORY_META,
    });
    yield* remember;
    if (resumeCache !== undefined && resumeCache.owner !== owner) return;
    yield* cache.removeThread(environmentId, threadId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not remove the cached thread.").pipe(
          Effect.annotateLogs({
            environmentId,
            threadId,
            error: error.message,
          }),
        ),
      ),
    );
  });

  type EventItem = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;
  type SequencedItem = Extract<
    OrchestrationV2ThreadStreamItem,
    { kind: "event" | "unknown-event" }
  >;
  const applyEventsLocked = Effect.fn("EnvironmentThreadState.applyEventsLocked")(function* (
    items: ReadonlyArray<SequencedItem>,
  ) {
    const appliedSequence = yield* SubscriptionRef.get(lastSequence);
    let sequence = appliedSequence;
    const fresh: EventItem[] = [];
    for (const item of items) {
      if (item.sequence <= sequence) continue;
      // An event type from a newer server still moves the resume cursor past it.
      sequence = item.sequence;
      if (item.kind === "event") {
        fresh.push(item);
        continue;
      }
      yield* Effect.logDebug("Skipped a thread event type this client does not know.").pipe(
        Effect.annotateLogs({
          environmentId,
          threadId,
          // Bounded: the type comes from a newer server and is not validated here.
          eventType: item.eventType.slice(0, 64),
          sequence: item.sequence,
        }),
      );
    }
    if (sequence === appliedSequence) return;
    yield* SubscriptionRef.set(lastSequence, sequence);

    const waiting = yield* Ref.get(awaitingCompletion);
    // Apply against the latest projection/history in one update so a concurrent
    // loadEarlier merge (or history-meta patch) cannot be clobbered by a stale
    // get-then-set rebuild.
    type EventApplyResult =
      | { readonly _tag: "noop" }
      | { readonly _tag: "delete" }
      | {
          readonly _tag: "applied";
          readonly projection: OrchestrationV2ThreadProjection;
          readonly history: ThreadHistoryMeta;
        };

    const applyEvent = (
      current: EnvironmentThreadState,
      item: EventItem,
    ): readonly [EventApplyResult, EnvironmentThreadState] => {
      if (current.status === "deleted") {
        return [{ _tag: "noop" }, current];
      }
      if (Option.isNone(current.data)) {
        return [
          item.event.type === "thread.deleted" ? { _tag: "delete" } : { _tag: "noop" },
          current,
        ];
      }
      if (item.event.type === "thread.deleted") {
        return [{ _tag: "delete" }, current];
      }

      // Incomplete progressive windows only (hasMore or open cursor). Do not
      // use expanded: it remains true after the last page as a cache marker.
      // Full/web and fully-loaded timelines keep default append-on-miss.
      const partial =
        current.history.hasMoreHistory || current.history.historyCursor !== null
          ? {
              partialTimeline: true as const,
              latestLocalTurnOrdinal: current.history.latestLocalTurnOrdinal,
            }
          : undefined;
      const next = applyOrchestrationV2ProjectionEvent(current.data.value, item.event, partial);
      // True no-op when the reducer deliberately returns the current projection
      // reference (e.g. dropped old partial-timeline turn-item). Do not clear
      // stream error/status or enqueue persistence.
      if (next === null || next === current.data.value) {
        return [{ _tag: "noop" }, current];
      }
      if (loadMarksEnabled() && item.event.type === "message.updated") {
        const message = item.event.payload;
        if (
          message.role === "assistant" &&
          message.text.length > 0 &&
          !firstTextSeen.has(message.id)
        ) {
          firstTextSeen.add(message.id);
          if (firstTextSeen.size > 128) firstTextSeen.delete(firstTextSeen.values().next().value!);
          if (
            !current.data.value.messages.some(
              (previous) => previous.id === message.id && previous.text.length > 0,
            )
          ) {
            const run = next.runs.find((run) => run.id === message.runId);
            markLoad("send.first.text", {
              ...markDetail(),
              message: message.id.slice(-24),
              ...(run === undefined ? {} : { userMessage: run.userMessageId.slice(-24) }),
              replay: waiting,
            });
          }
        }
      }

      let history = current.history;
      if (partial !== undefined && item.event.type === "turn-item.updated") {
        const ordinal = item.event.payload.ordinal;
        const watermark = history.latestLocalTurnOrdinal;
        if (watermark === null || ordinal > watermark) {
          history = { ...history, latestLocalTurnOrdinal: ordinal };
        }
      }

      const updated: EnvironmentThreadState = {
        ...current,
        data: Option.some(next),
        status: waiting ? "synchronizing" : "live",
        error: Option.none(),
        history,
      };
      return [{ _tag: "applied", projection: next, history: updated.history }, updated];
    };

    const result = yield* SubscriptionRef.modify(
      state,
      (current): readonly [EventApplyResult, EnvironmentThreadState] => {
        let result: EventApplyResult = { _tag: "noop" };
        for (const item of fresh) {
          const [applied, next] = applyEvent(current, item);
          current = next;
          if (applied._tag !== "noop") result = applied;
          if (applied._tag === "delete") break;
        }
        return [
          result,
          Option.isSome(current.data) ? { ...current, appliedSequence: sequence } : current,
        ];
      },
    );

    if (result._tag === "delete") {
      yield* setDeleted("event");
      return;
    }
    if (result._tag === "applied" && shouldPersistThread(result.projection, result.history)) {
      const snapshotSequence = yield* SubscriptionRef.get(lastSequence);
      yield* Queue.offer(
        persistence,
        snapshotToPersist(
          snapshotSequence,
          result.projection,
          result.history,
          yield* Ref.get(acceptsBoundedSocketSnapshots),
        ),
      );
    }
  });

  const applyItemLocked = Effect.fn("EnvironmentThreadState.applyItemLocked")(function* (
    item: OrchestrationV2ThreadStreamItem,
  ) {
    if (item.kind === "synchronized") {
      markLoad("thread.live", markDetail());
      yield* Ref.set(awaitingCompletion, false);
      yield* SubscriptionRef.update(state, (current) =>
        Option.isSome(current.data) && current.status !== "deleted" && Option.isNone(current.error)
          ? { ...current, status: "live" as const, error: Option.none() }
          : current,
      );
      return;
    }

    if (item.kind === "snapshot") {
      yield* SubscriptionRef.set(lastSequence, item.snapshotSequence);
      const hasProgressiveHistory =
        item.historyCursor !== undefined ||
        item.hasMoreHistory !== undefined ||
        item.latestLocalTurnOrdinal !== undefined;
      // Bounded socket fallbacks carry their cursor. Legacy-compatible full
      // snapshots omit these fields and still replace progressive state.
      yield* setThread(
        boundedSnapshotProjection(item),
        hasProgressiveHistory
          ? {
              history: {
                historyCursor: item.historyCursor ?? null,
                hasMoreHistory: item.hasMoreHistory ?? false,
                loading: false,
                error: null,
                expanded: false,
                latestLocalTurnOrdinal: item.latestLocalTurnOrdinal ?? null,
              },
            }
          : { resetHistory: true },
      );
      return;
    }

    yield* applyEventsLocked([item]);
  });

  const applyItems = Effect.fn("EnvironmentThreadState.applyItems")(function* (
    items: ReadonlyArray<OrchestrationV2ThreadStreamItem>,
  ) {
    const startedAt = performance.now();
    if (items.length > 0 && firstFrameAttempt !== attempt) {
      firstFrameAttempt = attempt;
      markLoad("thread.first", { ...markDetail(), items: items.length, kind: items[0]!.kind });
    }
    yield* applyLock.withPermits(1)(
      Effect.gen(function* () {
        let events: SequencedItem[] = [];
        for (const item of items) {
          if (
            item.kind === "unknown-event" ||
            (item.kind === "event" && item.event.type !== "thread.deleted")
          ) {
            events.push(item);
            continue;
          }
          yield* applyEventsLocked(events);
          events = [];
          yield* applyItemLocked(item);
        }
        yield* applyEventsLocked(events);
        yield* remember;
      }),
    );
    if (items.length > 1 || items[0]?.kind === "snapshot") {
      markLoad("thread.applied", {
        ...markDetail(),
        items: items.length,
        snapshot: items.some((item) => item.kind === "snapshot"),
        ms: Math.round(performance.now() - startedAt),
      });
    }
  });

  const loadEarlier = Effect.fn("EnvironmentThreadState.loadEarlier")(function* (
    throughEntryId?: string,
  ) {
    const current = yield* SubscriptionRef.get(state);
    if (
      current.status === "deleted" ||
      Option.isNone(current.data) ||
      !current.history.hasMoreHistory ||
      current.history.historyCursor === null
    ) {
      return { _tag: "noop" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }
    if (current.history.loading) {
      return { _tag: "busy" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    }

    // Capture the cursor that initiated this request. Completions/failures must
    // no-op if a socket or new bounded snapshot replaced progressive meta mid-flight.
    const requestCursor = current.history.historyCursor;
    yield* patchHistoryMeta((history) =>
      isActiveHistoryRequestCursor(requestCursor, history)
        ? { ...history, loading: true, error: null }
        : history,
    );

    const failLoad = (message: string) =>
      SubscriptionRef.modify(
        state,
        (
          latest,
        ): readonly [
          ThreadHistoryController.ThreadHistoryLoadEarlierResult,
          EnvironmentThreadState,
        ] =>
          isActiveHistoryRequestCursor(requestCursor, latest.history)
            ? [
                { _tag: "error", message },
                {
                  ...latest,
                  history: { ...latest.history, loading: false, error: message },
                },
              ]
            : [{ _tag: "noop" }, latest],
      );

    const runLoad = Effect.gen(function* () {
      const preparedOption = yield* SubscriptionRef.get(supervisor.prepared);
      if (Option.isNone(preparedOption) || Option.isNone(httpClient))
        return yield* failLoad("Environment is not connected.");

      const views =
        throughEntryId === undefined ? [undefined] : ["conversation" as const, undefined];
      for (const view of views) {
        const pageResult = yield* fetchEnvironmentThreadHistoryPage({
          prepared: preparedOption.value,
          threadId,
          cursor: requestCursor,
          throughEntryId,
          view,
          signer: dpopSigner,
          remoteAuthorization,
        }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient.value), Effect.result);
        if (Result.isFailure(pageResult))
          return yield* failLoad(formatHistoryError(pageResult.failure));
        const page = pageResult.success;
        const complete = view === undefined;
        const waiting = yield* Ref.get(awaitingCompletion);
        // Both stages merge against live state under the same lock. Only the
        // complete page advances the cursor and releases the loading indicator.
        const result = yield* applyLock.withPermits(1)(
          SubscriptionRef.modify(
            state,
            (
              latest,
            ): readonly [
              ThreadHistoryController.ThreadHistoryLoadEarlierResult,
              EnvironmentThreadState,
            ] => {
              if (!isActiveHistoryRequestCursor(requestCursor, latest.history))
                return [{ _tag: "noop" }, latest];
              if (Option.isNone(latest.data) || latest.status === "deleted")
                return [{ _tag: "noop" }, { ...latest, history: EMPTY_THREAD_HISTORY_META }];
              return [
                { _tag: "loaded" },
                {
                  ...latest,
                  data: Option.some(mergeOlderHistoryIntoProjection(latest.data.value, page.items)),
                  status: complete && waiting ? "synchronizing" : latest.status,
                  history: complete
                    ? applyHistoryPageMeta(latest.history, page)
                    : { ...latest.history, expanded: true },
                },
              ];
            },
          ),
        );
        if (result._tag !== "loaded") return result;
        if (complete) yield* remember;
      }
      return { _tag: "loaded" } satisfies ThreadHistoryController.ThreadHistoryLoadEarlierResult;
    });

    // On Effect interruption only: clear loading when this request cursor is
    // still active. Never mutate stream status/error from the interrupt path.
    return yield* runLoad.pipe(
      Effect.onInterrupt(() =>
        SubscriptionRef.update(state, (latest) => ({
          ...latest,
          history: clearActiveHistoryLoading(requestCursor, latest.history),
        })),
      ),
    );
  });

  if (Option.isSome(historyController)) {
    const scope = yield* Scope.Scope;
    const registration = yield* historyController.value.register(environmentId, threadId, {
      loadEarlier: (throughEntryId) =>
        loadEarlier(throughEntryId).pipe(Effect.forkIn(scope), Effect.flatMap(Fiber.join)),
    });
    yield* Effect.addFinalizer(() => historyController.value.unregister(registration));
  }

  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setConnecting;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });
  // Requests to look again at a thread the server said it did not have.
  const missRecheckRequests = yield* Queue.sliding<void>(1);
  const listenerKey = threadKey({ environmentId, threadId });
  const requestMissRecheck = () => Queue.offerUnsafe(missRecheckRequests, undefined);
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const listeners = missRecheckListeners.get(listenerKey) ?? new Set<() => void>();
      listeners.add(requestMissRecheck);
      missRecheckListeners.set(listenerKey, listeners);
    }),
    () =>
      Effect.sync(() => {
        const listeners = missRecheckListeners.get(listenerKey);
        listeners?.delete(requestMissRecheck);
        if (listeners?.size === 0) missRecheckListeners.delete(listenerKey);
      }),
  );

  // Only the first subscription after a warm live resume keeps the retained
  // status. A replacement session or foreground resubscribe on the same scope
  // may have missed events, so those show sync progress until confirmed.
  const resumingLive = yield* Ref.make(initialState.status === "live");
  const markSynchronizing = Effect.gen(function* () {
    if (yield* Ref.get(resumingLive)) return;
    // Connection notifications do not establish that a terminated load restarted.
    // Clear its diagnostic only when this subscription actually tries again.
    yield* SubscriptionRef.update(state, (current) =>
      current.status === "deleted"
        ? current
        : { ...current, status: "synchronizing" as const, error: Option.none() },
    );
  });

  yield* markSynchronizing;
  markLoad("thread.session.wait", markDetail());
  // A defect ends the whole subscription, whether it came over the socket or
  // while applying an update. Back off and subscribe again for a fresh
  // snapshot, or the chat stays blank until the app is reopened.
  let defectRetries = 0;
  let lastDefectAt = 0;
  const followThread = (): Effect.Effect<
    void,
    never,
    EnvironmentSupervisor.EnvironmentSupervisor
  > =>
    subscribeDynamicMapped(
      ORCHESTRATION_V2_WS_METHODS.subscribeThread,
      Effect.fn("EnvironmentThreadState.makeSubscribeInput")(function* (session) {
        attempt += 1;
        const attemptDetail = markDetail();
        markLoad("thread.session.available", attemptDetail);
        let current = yield* SubscriptionRef.get(state);
        // A delete event already cleared this thread: park without opening the
        // socket. A not-found answer is asked again once per new session.
        const recheckingMiss = current.status === "deleted" && deletedByMiss;
        if (current.status === "deleted" && !recheckingMiss) {
          return yield* Effect.never;
        }

        // A cold HTTP result is provisional until config tells us whether the
        // socket will send a completion marker.
        if (Option.isNone(current.data)) yield* Ref.set(awaitingCompletion, true);
        // The snapshot and config are independent. Start both before waiting
        // so a cold open does not pay their latency in series.
        const configStartedAt = performance.now();
        markLoad("thread.config.wait", attemptDetail);
        const configFiber = yield* session.initialConfig.pipe(
          Effect.map((config) => config.threadResumeCompletionMarker === true),
          Effect.orElseSucceed(() => false),
          Effect.tap((supported) =>
            Effect.sync(() =>
              markLoad("thread.config.ready", {
                ...attemptDetail,
                ms: Math.round(performance.now() - configStartedAt),
                completionMarker: supported,
              }),
            ),
          ),
          Effect.forkChild,
        );
        yield* markSynchronizing;
        yield* Ref.set(resumingLive, false);

        // A saved copy missing a pending question's item would keep that card
        // hidden forever: resuming only replays newer events. Load it fresh.
        let refreshSavedCopy =
          Option.isSome(current.data) && hasPendingUserInputWithoutItem(current.data.value);
        if (refreshSavedCopy) markLoad("thread.cached.pending-card-missing", attemptDetail);
        if (Option.isNone(current.data) || refreshSavedCopy) {
          const preparedStartedAt = performance.now();
          markLoad("thread.prepared.wait", attemptDetail);
          const prepared = yield* SubscriptionRef.get(supervisor.prepared).pipe(
            Effect.flatMap(
              Option.match({
                onSome: Effect.succeed,
                onNone: () =>
                  SubscriptionRef.changes(supervisor.prepared).pipe(
                    Stream.filter(Option.isSome),
                    Stream.map((value) => value.value),
                    Stream.runHead,
                    Effect.map(Option.getOrThrow),
                  ),
              }),
            ),
          );
          markLoad("thread.prepared.ready", {
            ...attemptDetail,
            ms: Math.round(performance.now() - preparedStartedAt),
          });
          const httpStartedAt = performance.now();
          markLoad("thread.http.start", attemptDetail);
          let httpResult: ThreadSnapshotLoader.ThreadSnapshotLoadResult =
            yield* snapshotLoader.load(prepared, threadId, { load: loadId, attempt });
          // A thread shown as deleted already waited out the schedule once.
          for (const delay of recheckingMiss ? [] : MISS_RECHECK_DELAYS_MS) {
            if (httpResult._tag !== "missing") break;
            markLoad("thread.http.recheck", { ...attemptDetail, delay });
            yield* Effect.sleep(Duration.millis(delay));
            httpResult = yield* snapshotLoader.load(prepared, threadId, { load: loadId, attempt });
          }
          // Still not found: show it deleted (clearing any stale cache) and open
          // no socket subscription. Look again only when this client's creation
          // of the thread reaches the server, or on the next session.
          while (httpResult._tag === "missing") {
            // A creation delivered meanwhile skips straight to looking again.
            if (Option.isNone(yield* Queue.poll(missRecheckRequests))) {
              yield* setDeleted("miss");
              yield* Queue.take(missRecheckRequests);
            }
            // The server has the thread now: show it loading, not deleted.
            yield* SubscriptionRef.update(state, (value) => ({
              ...value,
              status: "synchronizing" as const,
              error: Option.none(),
            }));
            markLoad("thread.http.recheck", { ...attemptDetail, requested: true });
            httpResult = yield* snapshotLoader.load(prepared, threadId, { load: loadId, attempt });
          }
          markLoad("thread.http", {
            ...attemptDetail,
            ms: Math.round(performance.now() - httpStartedAt),
            outcome: httpResult._tag,
          });
          switch (httpResult._tag) {
            case "present": {
              if (canLoadHistory && httpResult.history !== undefined) {
                yield* Ref.set(acceptsBoundedSocketSnapshots, true);
              }
              // Atomic projection + progressive meta so a settled bounded window
              // never persists as a complete full-timeline cache entry. Socket
              // snapshots still go through applyItem (resetHistory).
              const httpApplyStartedAt = performance.now();
              yield* applyLock.withPermits(1)(
                Effect.gen(function* () {
                  yield* SubscriptionRef.set(lastSequence, httpResult.snapshot.snapshotSequence);
                  const history: ThreadHistoryMeta =
                    httpResult.history !== undefined
                      ? {
                          historyCursor: httpResult.history.historyCursor,
                          hasMoreHistory: httpResult.history.hasMoreHistory,
                          loading: false,
                          error: null,
                          expanded: false,
                          latestLocalTurnOrdinal: httpResult.history.latestLocalTurnOrdinal ?? null,
                        }
                      : EMPTY_THREAD_HISTORY_META;
                  yield* setThread(httpResult.snapshot.projection, { history });
                  yield* remember;
                }),
              );
              markLoad("thread.http.applied", {
                ...attemptDetail,
                ms: Math.round(performance.now() - httpApplyStartedAt),
              });
              current = yield* SubscriptionRef.get(state);
              refreshSavedCopy = false;
              break;
            }
            case "unavailable": {
              // Transient HTTP failure: fall through to the socket path.
              break;
            }
          }
        }

        const supportsCompletionMarker = yield* Fiber.join(configFiber);
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        const sequence = yield* SubscriptionRef.get(lastSequence);
        const canResume = Option.isSome(current.data) && !refreshSavedCopy;
        const acceptBoundedSnapshot = yield* Ref.get(acceptsBoundedSocketSnapshots);
        if (!supportsCompletionMarker && canResume) {
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: value.status === "deleted" ? value.status : ("live" as const),
            error: Option.none(),
          }));
        }

        markLoad("thread.subscribe", {
          ...attemptDetail,
          resume: canResume,
          sequence,
          completionMarker: supportsCompletionMarker,
        });
        return {
          threadId,
          ...(canResume ? { afterSequence: sequence } : {}),
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          ...(acceptBoundedSnapshot
            ? {
                acceptBoundedSnapshot: true as const,
                acceptCompactTurnItems: true as const,
                ...(isModelManagerThreadId(threadId)
                  ? { snapshotUserTurnLimit: 1 }
                  : snapshotLoader.snapshotUserTurnLimit === undefined
                    ? {}
                    : { snapshotUserTurnLimit: snapshotLoader.snapshotUserTurnLimit }),
                acceptCompactIds: true as const,
              }
            : {}),
          acceptDedupedBodies: true as const,
          acceptTextAppends: true as const,
        };
      }),
      (_session, stream) => restoreThreadTextAppends(stream),
      {
        onSubscribe: () => markLoad("thread.stream.start", markDetail()),
        onDefect: () => setStreamError("Could not synchronize the thread."),
        onExpectedFailure: (cause) => setStreamError(formatThreadError(cause)),
        retryExpectedFailureAfter: THREAD_SUBSCRIPTION_RETRY_DELAY,
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(
      Stream.runForEachArray(applyItems),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread subscription failed; resubscribing.", {
              cause: Cause.pretty(cause),
              environmentId,
              threadId,
            }).pipe(
              Effect.andThen(setStreamError("Could not synchronize the thread.")),
              Effect.andThen(Clock.currentTimeMillis),
              Effect.flatMap((now) => {
                // Only a quiet spell resets the backoff. A snapshot that applies and
                // then fails again would otherwise ask for a new one every 250 ms.
                if (now - lastDefectAt > THREAD_DEFECT_BACKOFF_RESET_MS) defectRetries = 0;
                lastDefectAt = now;
                return Effect.sleep(
                  subscriptionRetryDelay(THREAD_SUBSCRIPTION_RETRY_DELAY, defectRetries++),
                );
              }),
              Effect.andThen(Effect.suspend(followThread)),
            ),
      ),
    );
  yield* Effect.forkScoped(followThread());

  return state;
});

function threadStateChanges(
  environmentId: EnvironmentIdType,
  threadId: ThreadIdType,
  resumeCache?: ThreadResumeCache,
) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const live = Stream.unwrap(
          makeEnvironmentThreadState(threadId, resumeCache).pipe(
            Effect.map(SubscriptionRef.changes),
          ),
        );
        if (resumeCache?.snapshot !== undefined || cache.loadThreadFirstScreen === undefined)
          return live;
        const preview = yield* cache
          .loadThreadFirstScreen(environmentId, threadId)
          .pipe(Effect.catch(() => Effect.succeedNone));
        if (Option.isNone(preview) || preview.value.projection.thread.id !== threadId) return live;
        // Publish before the full cache starts decoding. Only the complete copy
        // may supply a resume cursor or accept history requests, even offline.
        const first: EnvironmentThreadState = {
          data: Option.some(preview.value.projection),
          status: "cached",
          error: Option.none(),
          history: { ...EMPTY_THREAD_HISTORY_META, loading: true },
        };
        return Stream.concat(
          Stream.succeed(first),
          Stream.unwrap((cache.yieldAfterThreadFirstScreen ?? Effect.void).pipe(Effect.as(live))),
        );
      }),
    ),
  );
}

export function createEnvironmentThreadStateAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | Persistence.EnvironmentCacheStore
    | ThreadSnapshotLoader.ThreadSnapshotLoader
    | R,
    E
  >,
) {
  // Cache definitions must outlive collectible live-atom definitions. The
  // registry retains these nodes without retaining environment or RPC scopes.
  const resumeFamily = Atom.family((key: string) =>
    Atom.make((): ThreadResumeCache => ({
      snapshot: undefined,
      owner: undefined,
    })).pipe(
      Atom.setIdleTTL(THREAD_SNAPSHOT_IDLE_TTL_MS),
      Atom.withLabel(`environment-thread-resume:${key}`),
    ),
  );
  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseThreadKey(key);
    const resumeAtom = resumeFamily(key);
    return runtime
      .atom(
        (get) => {
          get.mount(resumeAtom);
          const resume = get.once(resumeAtom);
          const live = threadStateChanges(environmentId, threadId, resume);
          // A deletion from a not-found answer is checked again, not replayed.
          return resume.snapshot === undefined || isDeletedByMiss(resume.snapshot)
            ? live
            : Stream.concat(Stream.succeed(cachedThreadState(resume.snapshot.state)), live);
        },
        {
          initialValue: EMPTY_ENVIRONMENT_THREAD_STATE,
        },
      )
      .pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state:${key}`));
  });

  return {
    stateAtom: (environmentId: EnvironmentIdType, threadId: ThreadIdType) =>
      family(threadKey({ environmentId, threadId })),
  };
}

export * from "./archivedThreads.ts";
export * from "./checkpointDiff.ts";
export * as BoundedThreadSnapshotLoader from "./boundedThreadSnapshotHttp.ts";
export * as ThreadHistoryController from "./threadHistoryController.ts";
export * as ThreadMediaHistory from "./threadHistoryHttp.ts";
// Flat so consumers' inferred types can name it.
export type { ThreadHistoryLoadEarlierResult } from "./threadHistoryController.ts";
export * from "./threadHistoryMerge.ts";
export * from "./threadSnapshotHttp.ts";
export * from "./composerPathSearch.ts";
export * from "./threadCommands.ts";
export * from "./threadFeedback.ts";
export * from "./threadDetail.ts";
export * from "./threadFamilies.ts";
export * from "./threadShell.ts";
export * from "./threadState.ts";

export { createCreatedChatShellAtoms } from "./createdChats.ts";
