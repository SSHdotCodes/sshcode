import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadShell,
  type ServerConfig,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import * as EnvironmentRegistry from "../connection/registry.ts";
import { connectionProjectionPhase } from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as ConnectionWakeups from "../connection/wakeups.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import * as Persistence from "../platform/persistence.ts";
import { runCachePersistence } from "./cachePersistence.ts";
import { subscribeDynamic, subscriptionRetryDelay } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
import type { DeferredShellSnapshot } from "./shellPullRequests.ts";
import {
  applyShellStreamEvents,
  type ShellStreamEvent,
  mergeShellSnapshotProjects,
  reuseUnchangedThreadShells,
  sameThreadPullRequests,
} from "./shellReducer.ts";
import { type EnvironmentCatalogState, enabledEnvironmentIds } from "./connections.ts";
import { followStreamInEnvironment } from "./runtime.ts";
import { markLoad } from "../loadMarks.ts";

export type { EnvironmentShellPreview } from "../platform/persistence.ts";

export type EnvironmentShellStatus = "empty" | "cached" | "synchronizing" | "live";

export interface EnvironmentShellState {
  readonly snapshot: Option.Option<OrchestrationV2ShellSnapshot>;
  readonly status: EnvironmentShellStatus;
  readonly error: Option.Option<string>;
  /**
   * Changes with each authoritative snapshot (not enrichment refreshes); 0 until the first one.
   * Thread families read for an older generation may miss changes from before the latest snapshot,
   * so they are read again.
   */
  readonly generation: number;
  /** Sequences of the thread removals applied since the latest authoritative snapshot. */
  readonly removedAt: ReadonlyMap<ThreadId, number>;
}

const EMPTY_REMOVALS: ReadonlyMap<ThreadId, number> = new Map();
// Shared by every shell state, so a rebuilt one never reuses a generation another already used.
let lastShellGeneration = 0;

export const EMPTY_SHELL_STATE: EnvironmentShellState = {
  snapshot: Option.none(),
  status: "empty",
  error: Option.none(),
  generation: 0,
  removedAt: EMPTY_REMOVALS,
};

function shellStatusForSnapshot(
  snapshot: Option.Option<OrchestrationV2ShellSnapshot>,
): EnvironmentShellStatus {
  return Option.isSome(snapshot) ? "cached" : "empty";
}

function withoutDeferredPullRequests(value: DeferredShellSnapshot): OrchestrationV2ShellSnapshot {
  if (value.loadPullRequests === undefined) return value;
  const { loadPullRequests: _deferred, ...snapshot } = value;
  return snapshot;
}

const SHELL_SYNCHRONIZATION_ERROR_MESSAGE = "Could not synchronize environment data.";

export const makeEnvironmentShellState = Effect.fn("EnvironmentShellState.make")(function* (
  retainedSnapshot?: OrchestrationV2ShellSnapshot,
) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const cache = yield* Persistence.EnvironmentCacheStore;
  const snapshotLoader = yield* ShellSnapshotLoader.ShellSnapshotLoader;
  const wakeups = yield* Effect.serviceOption(ConnectionWakeups.ConnectionWakeups);
  const environmentId = supervisor.target.environmentId;
  const cacheLoadStartedAt = performance.now();
  const cached =
    retainedSnapshot === undefined
      ? yield* cache.loadShell(environmentId).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not load cached environment shell.").pipe(
              Effect.annotateLogs({
                environmentId,
                ...safeErrorLogAttributes(error),
              }),
              Effect.as(Option.none<DeferredShellSnapshot>()),
            ),
          ),
        )
      : Option.some(retainedSnapshot);
  markLoad("shell.cached", {
    ms: Math.round(performance.now() - cacheLoadStartedAt),
    threads: Option.match(cached, { onNone: () => 0, onSome: (value) => value.threads.length }),
  });
  const cachedSnapshot = Option.map(cached, withoutDeferredPullRequests);
  const state = yield* SubscriptionRef.make<EnvironmentShellState>({
    ...EMPTY_SHELL_STATE,
    snapshot: cachedSnapshot,
    status: shellStatusForSnapshot(cachedSnapshot),
  });
  const awaitingCompletion = yield* Ref.make(false);
  // Whether the in-memory snapshot finished synchronizing with a server.
  const synchronizedSnapshot = yield* Ref.make(false);
  const lastAuthoritativeSession = yield* Ref.make<RpcSession | null>(null);
  const activeSubscriptionSession = yield* Ref.make<RpcSession | null>(null);
  const latestLiveSnapshot = yield* Ref.make<Option.Option<OrchestrationV2ShellSnapshot>>(
    Option.none(),
  );
  const persistence = yield* Queue.sliding<OrchestrationV2ShellSnapshot>(1);

  const persistenceLock = yield* Semaphore.make(1);
  let lastPersisted: OrchestrationV2ShellSnapshot | undefined;
  // Rows still waiting for their deferred pull request links, which must not be saved:
  // the cache would keep them without links until the next server refresh.
  let pendingLinkRows: ReadonlySet<OrchestrationV2ThreadShell> = new Set();
  const persistLatest = Effect.fn("EnvironmentShellState.persistLatest")(function* (
    flush: boolean,
  ) {
    while (true) {
      const latest = yield* Ref.get(latestLiveSnapshot);
      if (Option.isNone(latest) || latest.value === lastPersisted) return;
      if (latest.value.threads.some((thread) => pendingLinkRows.has(thread))) return;
      const snapshot = latest.value;
      const saved = yield* cache.saveShell(environmentId, snapshot).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist environment shell cache.").pipe(
            Effect.annotateLogs({ environmentId, ...safeErrorLogAttributes(error) }),
            Effect.as(false),
          ),
        ),
      );
      if (!saved) return;
      lastPersisted = snapshot;
      // Only lifecycle flushes chase updates that arrived during an in-flight save.
      // The regular worker leaves those updates for the next write window.
      if (!flush) return;
    }
  }, persistenceLock.withPermit);
  const persist = () => persistLatest(false);
  const flushLiveShellSnapshot = persistLatest(true);

  // Register before scoped worker fibers so reverse finalizer order interrupts
  // those fibers first and this flush sees a stable latestLiveSnapshot.
  yield* Effect.addFinalizer(() => flushLiveShellSnapshot);

  yield* runCachePersistence(persistence, persist).pipe(Effect.forkScoped);

  const setDisconnected = Ref.set(awaitingCompletion, false).pipe(
    Effect.andThen(
      SubscriptionRef.update(state, (current) => ({
        ...current,
        status: shellStatusForSnapshot(current.snapshot),
      })),
    ),
    Effect.andThen(flushLiveShellSnapshot.pipe(Effect.forkScoped)),
    Effect.asVoid,
  );
  const setSynchronizing = SubscriptionRef.update(state, (current) => ({
    ...current,
    status: "synchronizing" as const,
    error: Option.none(),
  }));
  const setReady = SubscriptionRef.update(state, (current) =>
    current.status === "live"
      ? current
      : {
          ...current,
          status: "synchronizing" as const,
          error: Option.none(),
        },
  );
  const setStreamError = (error: unknown) =>
    Ref.set(awaitingCompletion, false).pipe(
      Effect.andThen(Effect.logWarning("Could not synchronize the environment shell.")),
      Effect.annotateLogs({
        environmentId,
        ...safeErrorLogAttributes(error),
      }),
      Effect.andThen(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          status: shellStatusForSnapshot(current.snapshot),
          error: Option.some(SHELL_SYNCHRONIZATION_ERROR_MESSAGE),
        })),
      ),
    );

  // Server items and deferred link fills both read the snapshot and write it back; one at a
  // time, so neither can overwrite what the other wrote in between.
  const snapshotWriteLock = yield* Semaphore.make(1);

  // Apply each received batch with one state write. The RPC client's bounded
  // buffer can split a server chunk, so a bulk action can still need several
  // writes, but each write includes every event in that batch.
  const applyItems = Effect.fn("EnvironmentShellState.applyItems")(function* (
    items: ReadonlyArray<OrchestrationV2ShellStreamItem>,
    // Ids of rows whose links will fill later; they are held out of saves before one queues.
    pendingLinkIds?: ReadonlySet<ThreadId>,
  ) {
    const initial = yield* SubscriptionRef.get(state);
    let waiting = yield* Ref.get(awaitingCompletion);
    let next = initial;
    let receivedSnapshot = false;
    for (let index = 0; index < items.length; index++) {
      const item = items[index]!;
      if (item.kind === "synchronized") {
        waiting = false;
        if (Option.isSome(next.snapshot)) {
          markLoad("shell.live");
          yield* Ref.set(synchronizedSnapshot, true);
          next = {
            ...next,
            status: "live",
            error: Option.none(),
            generation: next.generation === 0 ? ++lastShellGeneration : next.generation,
          };
        }
        continue;
      }
      const authoritative =
        item.kind === "snapshot" && item.resolvedRepositoryIdentityRoots === undefined;
      let removedAt = next.removedAt;
      let nextSnapshot: OrchestrationV2ShellSnapshot;
      if (item.kind === "snapshot") {
        nextSnapshot = mergeShellSnapshotProjects(
          Option.getOrNull(next.snapshot),
          item.snapshot,
          item.resolvedRepositoryIdentityRoots === undefined
            ? undefined
            : {
                resolvedRepositoryIdentityRoots: item.resolvedRepositoryIdentityRoots,
              },
        );
      } else {
        const events: ShellStreamEvent[] = [item];
        while (index + 1 < items.length) {
          const following = items[index + 1]!;
          if (following.kind === "snapshot" || following.kind === "synchronized") break;
          events.push(following);
          index++;
        }
        if (Option.isNone(next.snapshot)) continue;
        const snapshot = next.snapshot.value;
        nextSnapshot = applyShellStreamEvents(snapshot, events);
        let sequence = snapshot.snapshotSequence;
        let removals: Map<ThreadId, number> | undefined;
        for (const event of events) {
          if (event.sequence <= sequence) continue;
          sequence = event.sequence;
          if (event.kind === "thread.removed") {
            (removals ??= new Map(removedAt)).set(event.threadId, event.sequence);
          }
        }
        removedAt = removals ?? removedAt;
      }
      receivedSnapshot ||= item.kind === "snapshot";
      next = {
        snapshot: Option.some(nextSnapshot),
        status: waiting ? "synchronizing" : "live",
        error: Option.none(),
        generation: authoritative ? ++lastShellGeneration : next.generation,
        removedAt: authoritative ? EMPTY_REMOVALS : removedAt,
      };
    }
    yield* Ref.set(awaitingCompletion, waiting);
    if (next === initial) return;
    if (pendingLinkIds !== undefined && Option.isSome(next.snapshot)) {
      pendingLinkRows = new Set(
        next.snapshot.value.threads.filter((thread) => pendingLinkIds.has(thread.id)),
      );
    }
    if (Option.isSome(next.snapshot)) {
      yield* Ref.set(latestLiveSnapshot, next.snapshot);
    }
    yield* SubscriptionRef.set(state, next);
    if (receivedSnapshot) {
      const session = yield* Ref.get(activeSubscriptionSession);
      if (session !== null) {
        yield* Ref.set(lastAuthoritativeSession, session);
      }
    }
    if (next.snapshot !== initial.snapshot && Option.isSome(next.snapshot)) {
      yield* Queue.offer(persistence, next.snapshot.value);
    }
  }, snapshotWriteLock.withPermit);

  // Rows can arrive before their pull request links (see DeferredShellSnapshot), so the list
  // paints first. The links then fill into the rows that still hold the object they arrived
  // with; a row the server has replaced since carries its own links.
  // Captured so fills started from the subscription callback still end with this state.
  const stateScope = yield* Effect.scope;
  // Each full snapshot supersedes the previous one's fill; links from an older snapshot must
  // not land on rows a newer snapshot reused. A cancelled fill's rows stay pending until the
  // next snapshot replaces the pending set.
  let activeFill: Fiber.Fiber<void> | undefined;
  const cancelActiveFill = Effect.suspend(() => {
    const fill = activeFill;
    activeFill = undefined;
    return fill === undefined ? Effect.void : Fiber.interrupt(fill);
  });
  const fillDeferredPullRequests = Effect.fnUntraced(function* (
    source: DeferredShellSnapshot,
    applied: OrchestrationV2ShellSnapshot,
  ) {
    yield* cancelActiveFill;
    if (source.loadPullRequests === undefined) return;
    const arrivedRows = new Set(applied.threads);
    const arrivedIds = new Set(source.threads.map((thread) => thread.id));
    pendingLinkRows = new Set(applied.threads.filter((thread) => arrivedIds.has(thread.id)));
    activeFill = yield* source.loadPullRequests.pipe(
      Effect.flatMap((linksByThreadId) =>
        writeFilledLinks(linksByThreadId, arrivedRows, arrivedIds),
      ),
      Effect.forkIn(stateScope),
    );
  });
  const writeFilledLinks = Effect.fnUntraced(
    function* (
      linksByThreadId: ReadonlyMap<ThreadId, ReadonlyArray<ThreadPullRequestLink>>,
      arrivedRows: ReadonlySet<OrchestrationV2ThreadShell>,
      arrivedIds: ReadonlySet<ThreadId>,
    ) {
      const filled = yield* SubscriptionRef.modify(
        state,
        (current): [Option.Option<OrchestrationV2ShellSnapshot>, EnvironmentShellState] => {
          if (Option.isNone(current.snapshot)) return [Option.none(), current];
          const snapshot = current.snapshot.value;
          let changed = false;
          const threads = snapshot.threads.map((thread) => {
            if (!arrivedRows.has(thread) || !arrivedIds.has(thread.id)) return thread;
            const links = linksByThreadId.get(thread.id);
            // A reused row may already hold these links from an earlier fill.
            if (sameThreadPullRequests(thread.pullRequests, links)) return thread;
            changed = true;
            if (links === undefined) {
              const { pullRequests: _previous, ...row } = thread;
              return row;
            }
            return { ...thread, pullRequests: links };
          });
          if (!changed) return [Option.none(), current];
          const next = { ...snapshot, threads };
          return [Option.some(next), { ...current, snapshot: Option.some(next) }];
        },
      );
      // Saves skipped while links were pending are queued again. Cached rows are never live:
      // until a server snapshot arrives there is nothing new to save.
      pendingLinkRows = new Set();
      const live = yield* Ref.get(latestLiveSnapshot);
      if (Option.isNone(live)) return;
      const latest = Option.isSome(filled) ? filled : live;
      yield* Ref.set(latestLiveSnapshot, latest);
      yield* Queue.offer(persistence, latest.value);
    },
    (effect) => snapshotWriteLock.withPermit(effect),
  );
  if (Option.isSome(cached) && Option.isSome(cachedSnapshot)) {
    yield* fillDeferredPullRequests(cached.value, cachedSnapshot.value);
  }

  const foregroundResubscriptions = Option.match(wakeups, {
    onNone: () => Stream.never,
    onSome: (service) =>
      service.changes.pipe(Stream.filter(ConnectionWakeups.shouldResubscribeAfterWakeup)),
  });

  yield* setSynchronizing;
  // A defect ends the whole subscription, whether it came over the socket or
  // while applying an update. Back off and subscribe again, or the thread
  // list stops updating until the app is reopened.
  let defectRetries = 0;
  const followShell = (): Effect.Effect<void, never, EnvironmentSupervisor.EnvironmentSupervisor> =>
    subscribeDynamic(
      ORCHESTRATION_V2_WS_METHODS.subscribeShell,
      Effect.fn("EnvironmentShellState.makeSubscribeInput")(function* (session) {
        yield* Ref.set(activeSubscriptionSession, session);
        const { supportsCompletionMarker, omitIdleSubagents, omitIdleAppOwnedSubagents } =
          yield* session.initialConfig.pipe(
            Effect.map((config) => ({
              supportsCompletionMarker: config.shellResumeCompletionMarker === true,
              omitIdleSubagents: config.shellThreadFamilies === true,
              omitIdleAppOwnedSubagents:
                config.shellThreadFamilies === true &&
                config.shellAppOwnedSubagentOmission === true,
            })),
            Effect.orElseSucceed(() => ({
              supportsCompletionMarker: false,
              omitIdleSubagents: false,
              omitIdleAppOwnedSubagents: false,
            })),
          );
        const omission = {
          ...(omitIdleSubagents ? { omitIdleSubagents: true as const } : {}),
          ...(omitIdleAppOwnedSubagents ? { omitIdleAppOwnedSubagents: true as const } : {}),
        };
        yield* Ref.set(awaitingCompletion, supportsCompletionMarker);
        yield* setSynchronizing;

        // Mobile can also resume its validated disk cache. The server bounds
        // replay and replaces stale/ahead cursors with a snapshot. Require its
        // completion marker so cached rows stay synchronizing until caught up.
        let current = yield* SubscriptionRef.get(state);
        const matchesSelection = (snapshot: OrchestrationV2ShellSnapshot) =>
          (snapshot.idleSubagentsOmitted === true) === omitIdleSubagents &&
          (snapshot.idleAppOwnedSubagentsOmitted === true) === omitIdleAppOwnedSubagents;
        const sameSelection = Option.exists(current.snapshot, matchesSelection);
        let canResume =
          sameSelection &&
          ((yield* Ref.get(lastAuthoritativeSession)) === session ||
            (supportsCompletionMarker &&
              ((yield* Ref.get(synchronizedSnapshot)) ||
                (snapshotLoader.resumeCachedSnapshot === true &&
                  Option.isSome(current.snapshot)))));
        if (!canResume || Option.isNone(current.snapshot)) {
          yield* Ref.set(synchronizedSnapshot, false);
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
          const httpStartedAt = performance.now();
          const httpSnapshot = yield* snapshotLoader.load(prepared, {
            omitIdleSubagents,
            ...omission,
          });
          markLoad("shell.http", {
            ms: Math.round(performance.now() - httpStartedAt),
            threads: Option.match(httpSnapshot, {
              onNone: () => 0,
              onSome: (value) => value.threads.length,
            }),
          });
          if (Option.isSome(httpSnapshot) && matchesSelection(httpSnapshot.value)) {
            yield* cancelActiveFill;
            const previous = yield* SubscriptionRef.get(state);
            const snapshot = reuseUnchangedThreadShells(
              Option.getOrNull(previous.snapshot),
              withoutDeferredPullRequests(httpSnapshot.value),
            );
            const pendingLinkIds = new Set(
              httpSnapshot.value.loadPullRequests === undefined
                ? []
                : httpSnapshot.value.threads.map((thread) => thread.id),
            );
            yield* applyItems([{ kind: "snapshot", snapshot }], pendingLinkIds);
            canResume = true;
            current = yield* SubscriptionRef.get(state);
            if (Option.isSome(current.snapshot)) {
              yield* fillDeferredPullRequests(httpSnapshot.value, current.snapshot.value);
            }
          }
        }

        // If the authoritative refresh failed, omit the cached cursor so the
        // socket fallback sends a complete snapshot for this new session.
        if (!canResume || Option.isNone(current.snapshot)) {
          return {
            ...omission,
            ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
          };
        }
        if (!supportsCompletionMarker) {
          // Without a completion marker there is no synchronized signal for a
          // resumed subscription, so report live immediately, like threads.
          yield* SubscriptionRef.update(state, (value) => ({
            ...value,
            status: "live" as const,
            error: Option.none(),
          }));
        }
        return {
          afterSequence: current.snapshot.value.snapshotSequence,
          ...omission,
          ...(supportsCompletionMarker ? { requestCompletionMarker: true as const } : {}),
        };
      }),
      {
        onExpectedFailure: (cause) => setStreamError(Cause.squash(cause)),
        retryExpectedFailureAfter: "250 millis",
        resubscribe: foregroundResubscriptions,
      },
    ).pipe(
      Stream.runForEachArray((items) =>
        applyItems(items).pipe(
          Effect.andThen(
            Effect.sync(() => {
              defectRetries = 0;
            }),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : Effect.logWarning("Shell subscription failed; resubscribing.", {
              cause: Cause.pretty(cause),
              environmentId,
            }).pipe(
              Effect.andThen(setStreamError(Cause.squash(cause))),
              Effect.andThen(Effect.sleep(subscriptionRetryDelay("250 millis", defectRetries++))),
              Effect.andThen(Effect.suspend(followShell)),
            ),
      ),
    );
  yield* Effect.forkScoped(followShell());
  yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.runForEach((connectionState) => {
      switch (connectionProjectionPhase(connectionState)) {
        case "synchronizing":
          return setSynchronizing;
        case "disconnected":
          return setDisconnected;
        case "ready":
          return setReady;
      }
    }),
    Effect.forkScoped,
  );

  return state;
});

export interface ShellHydrationSession {
  previewAttempted: boolean;
}

export function environmentShellStateChanges(
  publishPreview?: (preview: Option.Option<Persistence.EnvironmentShellPreview>) => void,
  hydration: ShellHydrationSession = { previewAttempted: false },
  retained?: EnvironmentShellState,
) {
  return Stream.unwrap(
    Effect.gen(function* () {
      const cache = yield* Persistence.EnvironmentCacheStore;
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const retainedSnapshot =
        retained === undefined ? undefined : Option.getOrUndefined(retained.snapshot);
      const hydrate = Stream.unwrap(
        makeEnvironmentShellState(retainedSnapshot).pipe(Effect.map(SubscriptionRef.changes)),
      );
      const full =
        retainedSnapshot === undefined || retained === undefined
          ? hydrate
          : Stream.concat(
              Stream.succeed({
                ...retained,
                status: "synchronizing" as const,
                error: Option.none<string>(),
              }),
              hydrate,
            );
      // Refreshes and reconnects retain complete rows. Never re-publish a disk
      // preview after one has been attempted during this registry's lifetime.
      if (retainedSnapshot !== undefined || hydration.previewAttempted) return full;
      hydration.previewAttempted = true;
      if (cache.loadShellPreview === undefined || publishPreview === undefined) return full;
      const startedAt = performance.now();
      const preview = yield* cache
        .loadShellPreview(supervisor.target.environmentId)
        .pipe(Effect.orElseSucceed(() => Option.none<Persistence.EnvironmentShellPreview>()));
      if (Option.isNone(preview)) return full;
      markLoad("shell.preview", {
        ms: Math.round(performance.now() - startedAt),
        threads: preview.value.threads.length,
      });
      // This value is display-only: the full cache must decode before the state
      // machine can choose a resume cursor or persist anything. A host timer lets
      // React Native paint the preview before the large decode starts.
      yield* Effect.sync(() => publishPreview(preview));
      return Stream.concat(
        Stream.fromEffect(cache.yieldAfterShellPreview ?? Effect.sleep("1 millis")).pipe(
          Stream.drain,
        ),
        full,
      );
    }),
  );
}

function shellStateChanges(
  environmentId: EnvironmentId,
  publishPreview: (preview: Option.Option<Persistence.EnvironmentShellPreview>) => void,
  hydration: ShellHydrationSession,
  retained?: EnvironmentShellState,
) {
  return followStreamInEnvironment(
    environmentId,
    environmentShellStateChanges(publishPreview, hydration, retained),
  );
}

export interface EnvironmentShellSummary {
  readonly hasSnapshot: boolean;
  readonly hasSynchronizingShell: boolean;
  readonly hasCachedShell: boolean;
  readonly hasLiveShell: boolean;
  readonly firstError: string | null;
}

const EMPTY_ENVIRONMENT_SHELL_SUMMARY: EnvironmentShellSummary = Object.freeze({
  hasSnapshot: false,
  hasSynchronizingShell: false,
  hasCachedShell: false,
  hasLiveShell: false,
  firstError: null,
});

const EMPTY_SERVER_CONFIGS: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();

function shellSummariesEqual(
  left: EnvironmentShellSummary,
  right: EnvironmentShellSummary,
): boolean {
  return (
    left.hasSnapshot === right.hasSnapshot &&
    left.hasSynchronizingShell === right.hasSynchronizingShell &&
    left.hasCachedShell === right.hasCachedShell &&
    left.hasLiveShell === right.hasLiveShell &&
    left.firstError === right.firstError
  );
}

function mapsEqual<K, V>(left: ReadonlyMap<K, V>, right: ReadonlyMap<K, V>): boolean {
  if (left.size !== right.size) {
    return false;
  }
  for (const [key, value] of left) {
    if (right.get(key) !== value) {
      return false;
    }
  }
  return true;
}

export function createEnvironmentShellSummaryAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly shellStateValueAtom: (environmentId: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
}) {
  let previousSummary = EMPTY_ENVIRONMENT_SHELL_SUMMARY;
  return Atom.make((get) => {
    let hasSnapshot = false;
    let hasSynchronizingShell = false;
    let hasCachedShell = false;
    let hasLiveShell = false;
    let firstError: string | null = null;

    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const state = get(input.shellStateValueAtom(environmentId));
      hasSynchronizingShell ||= state.status === "synchronizing";
      hasCachedShell ||= state.status === "cached";
      hasLiveShell ||= state.status === "live";
      if (firstError === null) {
        firstError = Option.getOrNull(state.error);
      }
      if (Option.isNone(state.snapshot)) {
        continue;
      }
      hasSnapshot = true;
    }

    const next: EnvironmentShellSummary = {
      hasSnapshot,
      hasSynchronizingShell,
      hasCachedShell,
      hasLiveShell,
      firstError,
    };
    if (shellSummariesEqual(previousSummary, next)) {
      return previousSummary;
    }
    previousSummary = next;
    return previousSummary;
  }).pipe(Atom.withLabel("environment-shell-summary"));
}

export function createEnvironmentServerConfigsAtom(input: {
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly serverConfigValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerConfig | null>;
}) {
  let previousServerConfigs = EMPTY_SERVER_CONFIGS;
  return Atom.make((get) => {
    const next = new Map<EnvironmentId, ServerConfig>();
    for (const environmentId of enabledEnvironmentIds(get(input.catalogValueAtom))) {
      const config = get(input.serverConfigValueAtom(environmentId));
      if (config !== null) {
        next.set(environmentId, config);
      }
    }
    if (mapsEqual(previousServerConfigs, next)) {
      return previousServerConfigs;
    }
    previousServerConfigs = next;
    return previousServerConfigs;
  }).pipe(Atom.withLabel("environment-server-configs"));
}

export function createEnvironmentShellAtoms<R, E>(
  runtime: Atom.AtomRuntime<
    | EnvironmentRegistry.EnvironmentRegistry
    | Persistence.EnvironmentCacheStore
    | ShellSnapshotLoader.ShellSnapshotLoader
    | R,
    E
  >,
) {
  // Keep only the once-per-launch marker across idle disposal, not private rows.
  const hydrationAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<ShellHydrationSession>({ previewAttempted: false }).pipe(Atom.keepAlive),
  );
  // Presentation-only. Command consumers must use stateAtom/stateValueAtom,
  // which never publish the partial snapshot.
  const previewAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(Option.none<Persistence.EnvironmentShellPreview>()).pipe(
      Atom.withLabel(`environment-shell-preview:${environmentId}`),
    ),
  );
  const stateAtom = Atom.family((environmentId: EnvironmentId) =>
    runtime.atom(
      (get) => {
        const preview = previewAtom(environmentId);
        get.mount(preview);
        const hydration = hydrationAtom(environmentId);
        get.mount(hydration);
        const retained = Option.getOrUndefined(
          Option.flatMap(
            get.self<AsyncResult.AsyncResult<EnvironmentShellState, unknown>>(),
            AsyncResult.value,
          ),
        );
        return shellStateChanges(
          environmentId,
          (value) => get.set(preview, value),
          get.once(hydration),
          retained,
        );
      },
      {
        initialValue: EMPTY_SHELL_STATE,
      },
    ),
  );

  const stateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      Option.getOrElse(AsyncResult.value(get(stateAtom(environmentId))), () => EMPTY_SHELL_STATE),
    ).pipe(Atom.withLabel(`environment-shell-state-value:${environmentId}`)),
  );

  return {
    stateAtom,
    stateValueAtom,
    previewAtom,
  };
}

export * from "./models.ts";
export * from "./shellCommands.ts";
export * from "./shellReducer.ts";
export * from "./shellPullRequests.ts";
export * as ShellSnapshotLoader from "./shellSnapshotHttp.ts";
export * from "./snapshots.ts";
