import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  type ServerProviderUsageLimits,
  ServerSettingsError,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as ProviderHost from "./ProviderHost.ts";
import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";
import type { ManagedServerProvider } from "./snapshot.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
}

/**
 * A periodic check that finds nothing new doubles the wait for the next one,
 * up to this many intervals. Every check starts the provider's CLI, and a
 * provider that is not in use keeps giving the same answer.
 */
export const MAX_UNCHANGED_REFRESH_INTERVALS = 6;

/**
 * A check that failed says nothing about the provider, and nobody may be
 * looking at provider status to ask again, so an installed provider left in
 * `error` is checked again after these waits, whether or not anyone is
 * looking. After the last one the plain rules apply.
 */
export const ERROR_RECHECK_WAITS_MS: ReadonlyArray<number> = [30_000, 120_000, 600_000];

const inError = (snapshot: ServerProvider) => snapshot.installed && snapshot.status === "error";

/** What a check found, without the times it was read at. */
const snapshotFindings = (snapshot: ServerProvider): string =>
  JSON.stringify(snapshot, (key, value: unknown) => (key === "checkedAt" ? undefined : value));

function withUsageLimits(
  snapshot: ServerProvider,
  usageLimits: ServerProvider["usageLimits"],
): ServerProvider {
  if (snapshot.usageLimits === usageLimits) {
    return snapshot;
  }
  const { usageLimits: _previous, ...rest } = snapshot;
  return usageLimits ? { ...rest, usageLimits } : rest;
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly resolveMaintenance: ManagedServerProvider["resolveMaintenance"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  /** Runs after status publication, on the same refresh cadence and with the same cancellation. */
  readonly checkUsageLimits?: Effect.Effect<ServerProviderUsageLimits>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
  readonly refreshOnInterval?: boolean | ((snapshot: ServerProvider) => boolean);
  readonly checkProviderOnSettingsChange?: (previous: Settings, next: Settings) => boolean;
}): Effect.fn.Return<
  ManagedServerProvider,
  ServerSettingsError,
  Scope.Scope | ProviderHost.ProviderHost
> {
  const host = yield* ProviderHost.ProviderHost;
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation) {
        return [null, state] as const;
      }
      // Enrichment derives from the snapshot it was handed; a runtime usage
      // update that landed since must not be reverted by it.
      const merged = withUsageLimits(nextSnapshot, state.snapshot.usageLimits);
      if (Equal.equals(state.snapshot, merged)) {
        return [null, state] as const;
      }
      return [merged, { ...state, snapshot: merged }] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    // Enrichment resolves binaries and package-manager state, which a disabled
    // provider has no use for.
    if ((!input.enrichSnapshot && !input.checkUsageLimits) || !snapshot.enabled) {
      return;
    }

    const usageLimits = input.checkUsageLimits?.pipe(
      Effect.flatMap((probed) =>
        Effect.gen(function* () {
          const next = yield* Ref.modify(snapshotStateRef, (state) => {
            if (state.enrichmentGeneration !== generation) return [null, state] as const;
            const limits = resolveUsageLimitsAfterProbe({
              published: state.snapshot.usageLimits,
              probed,
            });
            const nextSnapshot = withUsageLimits(state.snapshot, limits);
            return nextSnapshot === state.snapshot
              ? ([null, state] as const)
              : ([nextSnapshot, { ...state, snapshot: nextSnapshot }] as const);
          });
          if (next !== null) yield* PubSub.publish(changesPubSub, next);
        }),
      ),
    );
    const fiber = yield* Effect.all(
      [
        usageLimits?.pipe(Effect.ignoreCause({ log: true })) ?? Effect.void,
        input
          .enrichSnapshot?.({
            settings,
            snapshot,
            getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
            publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
          })
          .pipe(Effect.ignoreCause({ log: true })) ?? Effect.void,
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    if (
      !forceRefresh &&
      input.checkProviderOnSettingsChange?.(previousSettings, nextSettings) === false
    ) {
      const state = yield* Ref.get(snapshotStateRef);
      const nextGeneration = state.enrichmentGeneration + 1;
      yield* Ref.set(snapshotStateRef, {
        ...state,
        enrichmentGeneration: nextGeneration,
      });
      yield* Ref.set(settingsRef, nextSettings);
      yield* restartSnapshotEnrichment(nextSettings, state.snapshot, nextGeneration);
      return state.snapshot;
    }

    const probedSnapshot = yield* input.checkProvider;
    const { snapshot: nextSnapshot, generation: nextGeneration } = yield* Ref.modify(
      snapshotStateRef,
      (state) => {
        const generation =
          input.enrichSnapshot || input.checkUsageLimits
            ? state.enrichmentGeneration + 1
            : state.enrichmentGeneration;
        // A failed read keeps the last good limits only for the same account,
        // and they keep the workspace they were read for.
        const previous = state.snapshot.auth;
        const differs = (a: string | undefined, b: string | undefined) =>
          a !== undefined && b !== undefined && a !== b;
        // Limits read without a workspace cannot be attributed to a new one.
        const switchedAccount =
          differs(probedSnapshot.auth.email?.toLowerCase(), previous.email?.toLowerCase()) ||
          (probedSnapshot.auth.workspaceId !== undefined &&
            probedSnapshot.auth.workspaceId !== previous.workspaceId);
        const usageLimits = switchedAccount
          ? probedSnapshot.usageLimits
          : resolveUsageLimitsAfterProbe({
              published: state.snapshot.usageLimits,
              probed:
                input.checkUsageLimits && probedSnapshot.usageLimits === undefined
                  ? state.snapshot.usageLimits
                  : probedSnapshot.usageLimits,
            });
        const workspaceId =
          usageLimits === probedSnapshot.usageLimits ? undefined : state.snapshot.auth.workspaceId;
        const snapshot = withUsageLimits(
          workspaceId && !probedSnapshot.auth.workspaceId
            ? { ...probedSnapshot, auth: { ...probedSnapshot.auth, workspaceId } }
            : probedSnapshot,
          usageLimits,
        );
        return [
          { snapshot, generation },
          { snapshot, enrichmentGeneration: generation },
        ] as const;
      },
    );
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, nextSnapshot);
    yield* restartSnapshotEnrichment(nextSettings, nextSnapshot, nextGeneration);
    return nextSnapshot;
  });
  // Periodic checks in a row that found nothing new.
  const unchangedChecks = yield* Ref.make(0);
  // Checks made on their own because the provider was left in `error`.
  const errorRechecks = yield* Ref.make(0);
  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const before = (yield* Ref.get(snapshotStateRef)).snapshot;
        const next = yield* applySnapshotBase(nextSettings, options);
        if (!inError(next)) {
          yield* Ref.set(errorRechecks, 0);
        } else if (!inError(before)) {
          // The check loop may be in a long wait: a new failure starts its own.
          yield* Queue.offer(refreshIntervalChanges, undefined);
        }
        return next;
      }),
    );
  // The provider is in use or was asked about: check at the plain interval
  // again. Only the first sign after a quiet spell restarts the wait, so steady
  // use cannot keep postponing the next check.
  const resumePlainInterval = Ref.getAndSet(unchangedChecks, 0).pipe(
    Effect.flatMap((unchanged) =>
      unchanged > 0 ? Queue.offer(refreshIntervalChanges, undefined) : Effect.void,
    ),
    Effect.asVoid,
  );

  /**
   * Runtime usage updates arrive between probes. They patch only
   * `usageLimits` on whatever snapshot is published and leave the enrichment
   * generation alone, so an in-flight enrichment still lands.
   */
  const applyUsageLimits: ManagedServerProvider["applyUsageLimits"] = (update) =>
    Effect.gen(function* () {
      const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
        const usageLimits = applyUsageLimitsUpdate({
          previous: state.snapshot.usageLimits,
          update,
          checkedAt: update.checkedAt,
        });
        // `applyUsageLimitsUpdate` hands back the same object when nothing
        // moved, which is the common case for Codex's per-tick notification.
        if (usageLimits === state.snapshot.usageLimits) {
          return [null, state] as const;
        }
        const snapshot = withUsageLimits(state.snapshot, usageLimits);
        return [snapshot, { ...state, snapshot }] as const;
      });
      if (snapshotToPublish !== null) {
        yield* PubSub.publish(changesPubSub, snapshotToPublish);
        yield* resumePlainInterval;
      }
    });

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  const periodicRefresh = Effect.gen(function* () {
    const before = snapshotFindings((yield* Ref.get(snapshotStateRef)).snapshot);
    const next = yield* refreshSnapshot();
    yield* Ref.update(unchangedChecks, (unchanged) =>
      snapshotFindings(next) === before ? unchanged + 1 : 0,
    );
  });

  const mayCheckOnTimer = (snapshot: ServerProvider) =>
    snapshot.enabled &&
    input.refreshOnInterval !== false &&
    (typeof input.refreshOnInterval !== "function" || input.refreshOnInterval(snapshot));

  const hasProviderStatusDemand = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    if (!mayCheckOnTimer(state.snapshot)) return false;
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      host.shouldRunBackgroundWork({ type: "provider-status" }),
      host.shouldRunBackgroundWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : host.settings.get.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* host.settings.subscribe;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    applySnapshot(nextSettings).pipe(Effect.andThen(resumePlainInterval)),
  ).pipe(Effect.forkScoped);

  yield* Effect.forever(
    Effect.all([
      getRefreshInterval,
      Ref.get(unchangedChecks),
      Ref.get(snapshotStateRef),
      Ref.get(errorRechecks),
    ]).pipe(
      Effect.flatMap(([refreshInterval, unchanged, state, rechecks]) => {
        const intervalMs = Duration.toMillis(Duration.fromInputUnsafe(refreshInterval));
        const plainWaitMs =
          intervalMs <= 0
            ? 60_000
            : intervalMs * Math.min(2 ** unchanged, MAX_UNCHANGED_REFRESH_INTERVALS);
        const errorWaitMs =
          intervalMs > 0 && inError(state.snapshot) && mayCheckOnTimer(state.snapshot)
            ? ERROR_RECHECK_WAITS_MS[rechecks]
            : undefined;
        const recheckError = errorWaitMs !== undefined && errorWaitMs <= plainWaitMs;
        const waitMs = recheckError ? errorWaitMs : plainWaitMs;
        // Races the wait against a settings change or a sign of use, not a timeout.
        return Effect.raceFirst(
          Effect.sleep(Duration.millis(waitMs)).pipe(Effect.as(true)),
          Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
        ).pipe(
          Effect.flatMap((intervalElapsed) =>
            !intervalElapsed
              ? Ref.set(unchangedChecks, 0)
              : recheckError
                ? Ref.update(errorRechecks, (count) => count + 1).pipe(
                    Effect.andThen(periodicRefresh),
                  )
                : intervalMs > 0
                  ? hasProviderStatusDemand.pipe(
                      Effect.flatMap((shouldRefresh) =>
                        shouldRefresh ? periodicRefresh : Effect.void,
                      ),
                    )
                  : Effect.void,
          ),
        );
      }),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
    Effect.ignoreCause({ log: true }),
    Effect.forkScoped,
  );

  return {
    resolveMaintenance: input.resolveMaintenance,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot().pipe(
      Effect.tap(() => resumePlainInterval),
      Effect.tapError(Effect.logError),
      Effect.orDie,
    ),
    applyUsageLimits,
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ManagedServerProvider;
});
