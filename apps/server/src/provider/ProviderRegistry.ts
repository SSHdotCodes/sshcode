/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and exposes the latest
 * provider state to transport layers.
 *
 * The live layer aggregates per-instance snapshot streams into a
 * single materialized list.
 *
 * Historically this Layer composed four per-kind Live Layers
 * (`CodexProviderLive`, `ClaudeProviderLive`, …) that each exposed a
 * `ManagedServerProvider`. Those Lives were deleted during the driver /
 * instance refactor — every driver now carries its `snapshot: ManagedServerProvider`
 * bundled onto the `ProviderInstance` the registry produces.
 *
 * Each configured instance (including multi-instance setups like
 * `codex_personal` + `codex_work`) contributes one `ProviderSnapshotSource`,
 * keyed by `instanceId`. Instances whose driver is unavailable or whose
 * config failed to decode are merged from `instanceRegistry.listUnavailable`
 * as shadow snapshots so the UI can render their exact unavailable reason.
 *
 * Cache paths on disk are now keyed by `instanceId`. Because
 * `defaultInstanceIdForDriver(kind) === kind` for built-in kinds, existing
 * `<kind>.json` files remain the on-disk location for that driver's default
 * instance. Identity-less legacy cache contents are ignored and replaced by
 * the first live refresh.
 *
 * @module ProviderRegistry
 */
import {
  activeProviderFailure,
  rememberedAccountFailure,
  defaultInstanceIdForDriver,
  isProviderWorkspaceSnapshotCurrent,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderRecentFailure,
  type ServerProviderUpdateState,
  type ServerProviderUsageLimits,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as HarnessDefaultsService from "../harnessDefaults/HarnessDefaultsService.ts";
import { applyHarnessDefaults } from "./harnessDefaults.ts";
import { markSupersededModelsLegacy } from "@t3tools/shared/modelRankings";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Schema from "effect/Schema";
import {
  forgetUnavailableModel,
  markUnavailableModels,
  MAX_UNAVAILABLE_MODELS_FILE_BYTES,
  rememberUnavailableModel,
  UNAVAILABLE_MODELS_FILE,
  UnavailableModelsFile,
  type UnavailableModel,
} from "./unavailableModels.ts";
import * as ModelManifest from "./ModelManifest.ts";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@t3tools/provider-core/server/driver";
import {
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import type { ProviderSnapshotSource } from "./builtInProviderCatalog.ts";
import { makeUsageLimitHistory } from "./usageLimitHistory.ts";
import { makeUsageLimitRecorder } from "./usageLimitRecorder.ts";
import {
  isUsageLimitReadingStale,
  usageReadingWhileRefreshing,
  withLastUsageReading,
} from "./usageLimitFreshness.ts";
import { signedOutReason } from "@t3tools/provider-core/server/failure";
import { makeModelFailureTracker, type ModelFailure } from "./modelFailures.ts";
import { recentUseMoved } from "./providerRecentUse.ts";

export type ProviderMaintenanceActionKind = "update";

export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  {
    /**
     * Read the latest provider snapshots for every configured instance.
     * Multiple snapshots may share the same `provider` kind (multiple
     * instances of the same driver) and disambiguate via `instanceId`.
     */
    readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

    /** Refresh stale quota readings in parallel, waiting at most three seconds for the batch. */
    readonly getProvidersForUsageLimits: (
      instances?: ProviderInstanceId | ReadonlyArray<ProviderInstanceId>,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Refresh all providers, or the default instance of the specified
     * kind when supplied.
     *
     * Retained for back-compat with legacy call sites (WS refresh RPC,
     * orchestration metrics). New code should prefer `refreshInstance`.
     *
     * @deprecated prefer `refreshInstance` for new call sites.
     */
    readonly refresh: (
      provider?: ProviderDriverKind,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Refresh the specific configured instance. Returns the updated snapshot
     * list. When the instance id is unknown the call resolves with the
     * currently cached list (no error) — matching the legacy `refresh` shim
     * behaviour so transport layers don't have to special-case unknowns.
     */
    readonly refreshInstance: (
      instanceId: ProviderInstanceId,
      options?: { readonly clearOutOfCredit?: boolean },
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Fill the skills and slash commands snapshot for one cwd. A cwd that
     * already has a snapshot is left alone unless `fresh` is set. A fresh scan
     * also refreshes the instance's machine snapshot and drops other
     * instances' snapshots for the cwd.
     */
    readonly refreshWorkspaceSnapshot: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly fresh?: boolean;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Resolve the maintenance capabilities owned by one live provider instance.
     * Falls back to manual-only capabilities when the instance is not live.
     * `fresh` re-derives ownership from the executable instead of the cache.
     */
    readonly getProviderMaintenanceCapabilitiesForInstance: (
      instanceId: ProviderInstanceId,
      provider: ProviderDriverKind,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ProviderMaintenanceCapabilities>;

    /**
     * Apply volatile maintenance-action state to one configured instance.
     * This state is never persisted to disk. Today only update actions are
     * projected onto `ServerProvider.updateState`; install/auth actions can
     * extend this action map without adding driver-scoped APIs.
     */
    readonly setProviderMaintenanceActionState: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: ProviderMaintenanceActionKind;
      readonly state: ServerProviderUpdateState | null;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Show (or, with `null`, clear) a failed run on the instance's snapshot as
     * `recentFailure`. Only account failures (out of credit, billing, signed out)
     * survive restart in the snapshot cache.
     */
    readonly setProviderRecentFailure: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly failure: ServerProviderRecentFailure | null;
      readonly preserveOutOfCredit?: boolean;
    }) => Effect.Effect<void>;

    /**
     * How much each instance ran lately, as `recentUse` on its snapshot. An
     * instance is republished only when its figure moved enough to reorder plans.
     */
    readonly setProviderRecentUse: (
      measured: ReadonlyMap<ProviderInstanceId, number>,
    ) => Effect.Effect<void>;

    /**
     * Remember (or, with `reason: null`, forget) that a run's provider said this
     * model is gone. Snapshots file it as legacy with the reason for a week, or
     * until a later run on it completes.
     */
    readonly setModelUnavailable: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly reason: string | null;
    }) => Effect.Effect<void>;

    /** In-memory failures of the exact model route; never persisted in snapshots. */
    readonly recordModelHealthEvent: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
    readonly getModelFailures: Effect.Effect<ReadonlyMap<string, ModelFailure>>;

    /**
     * Stream of provider snapshot updates — one emission per aggregated
     * change. The array contains the full current state.
     */
    readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
  }
>()("t3/provider/ProviderRegistry") {}

const loadProviders = (
  providerSources: ReadonlyArray<ProviderSnapshotSource>,
): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.forEach(
    providerSources,
    (providerSource) =>
      providerSource.getSnapshot.pipe(
        Effect.flatMap((snapshot) => correlateSnapshotWithSource(providerSource, snapshot)),
      ),
    {
      concurrency: "unbounded",
    },
  );

const makeManualProviderMaintenanceCapabilities = (provider: ProviderDriverKind) =>
  makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });

const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.optionDescriptors?.length ?? 0) > 0;

const MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER = 16;
const CACHED_READINESS_GRACE_MS = 2 * 60_000;

function dropProviderWorkspaceSnapshot(provider: ServerProvider, cwd: string): ServerProvider {
  return provider.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)
    ? {
        ...provider,
        workspaceSnapshots: provider.workspaceSnapshots.filter((snapshot) => snapshot.cwd !== cwd),
      }
    : provider;
}

export function upsertProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string,
  scopedSnapshot: ProviderWorkspaceSnapshot,
): ServerProvider {
  // Antigravity's workspace scan reads skills from disk. Before the first
  // authenticated session, its commands still come from the cached advertisement.
  const useAntigravityCache =
    provider.driver === "antigravity" &&
    scopedSnapshot.auth.status === "unknown" &&
    scopedSnapshot.slashCommands.length === 0;
  const workspaceSnapshot = {
    cwd,
    checkedAt: scopedSnapshot.checkedAt,
    slashCommands:
      scopedSnapshot.slashCommandsPending || useAntigravityCache
        ? (provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.slashCommands ??
          (useAntigravityCache ? provider.slashCommands : scopedSnapshot.slashCommands))
        : scopedSnapshot.slashCommands,
    ...(scopedSnapshot.slashCommandsPending ? { slashCommandsPending: true } : {}),
    skills: scopedSnapshot.skills,
  } satisfies NonNullable<ServerProvider["workspaceSnapshots"]>[number];
  return {
    ...provider,
    workspaceSnapshots: [
      ...(provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd !== cwd),
      workspaceSnapshot,
    ].slice(-MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER),
  };
}

/** Drivers whose ready check reports the account's complete model inventory. */
const DISCOVERING_DRIVERS: ReadonlySet<string> = new Set(["muse", "cursor", "grok"]);

const shouldRetainMissingProviderModels = (provider: ServerProvider): boolean => {
  if (provider.driver === ProviderDriverKind.make("pi")) {
    return !(
      provider.installed &&
      (provider.status === "ready" || provider.status === "warning") &&
      provider.auth.status !== "unknown"
    );
  }
  if (provider.driver === ProviderDriverKind.make("acpRegistry")) {
    // ACP Registry discovery probes return the agent's complete inventory, so
    // a completed probe replaces the model list —
    // otherwise agents that rename or collapse models leave stale entries
    // pinned forever through the snapshot cache. Readiness-only and failed
    // probe snapshots only know the "default" placeholder and stay partial.
    // Native session discovery signals completion even when auth is unknown.
    return !(
      provider.installed &&
      !provider.refreshing &&
      provider.status === "ready" &&
      provider.nativeSessions !== undefined
    );
  }

  // A ready check from these drivers that lists models listed the account's whole
  // inventory, so models it no longer lists are retired: an earlier sign-in's rows must
  // not stay selectable. An empty ready list is a partial update and keeps the last one;
  // a sign-in that lists nothing has no inventory to keep.
  if (DISCOVERING_DRIVERS.has(provider.driver)) {
    return !(
      (provider.installed &&
        provider.status === "ready" &&
        provider.models.some((model) => !model.isCustom)) ||
      provider.auth.status === "unauthenticated"
    );
  }

  const isAntigravity = provider.driver === ProviderDriverKind.make("antigravity");
  const isCodex = provider.driver === ProviderDriverKind.make("codex");
  if (!isAntigravity && !isCodex && provider.driver !== ProviderDriverKind.make("opencode")) {
    return true;
  }

  if (
    (isAntigravity || isCodex) &&
    (!provider.enabled || provider.auth.status === "unauthenticated")
  ) {
    return false;
  }

  // Successful discovery replaces these inventories so cached retired models disappear.
  // Antigravity's local health check does not authenticate or discover models.
  const isPendingAntigravityAuthentication =
    isAntigravity && provider.status === "warning" && provider.auth.status === "unknown";
  const isPendingInitialProbe =
    provider.enabled && !provider.installed && provider.status === "warning";
  const didInstalledProviderProbeFail =
    provider.installed &&
    (provider.status === "error" || (isCodex && provider.status === "warning"));
  return (
    isPendingAntigravityAuthentication || isPendingInitialProbe || didInstalledProviderProbeFail
  );
};

const shouldRetainMissingOpenCodeMetadata = (provider: ServerProvider): boolean =>
  provider.driver === ProviderDriverKind.make("opencode") &&
  shouldRetainMissingProviderModels(provider);

const mergeProviderModels = (
  provider: ServerProvider,
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  const shouldRetainMissingModels = shouldRetainMissingProviderModels(provider);
  // Custom rows are derived from settings and every snapshot carries the full
  // current list, so a custom model missing from `nextModels` was removed by
  // the user and must not be resurrected from the previous snapshot.
  // A model the installed CLI is too old to run was offered by the pending
  // snapshot, before the version was known; retaining it would make it
  // selectable again.
  const updateRequiredSlugs = new Set(provider.updateRequiredModels?.map((model) => model.slug));
  const retainablePreviousModels = previousModels.filter(
    (model) => !model.isCustom && !updateRequiredSlugs.has(model.slug),
  );

  if (shouldRetainMissingModels && nextModels.length === 0 && retainablePreviousModels.length > 0) {
    return retainablePreviousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const preserveDefault =
    nextModels.length > 0 && !nextModels.some((model) => model.isDefault === true);
  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);
    if (!previousModel) {
      return model;
    }
    const retainCapabilities = !hasModelCapabilities(model) && hasModelCapabilities(previousModel);
    const retainDefault = preserveDefault && previousModel.isDefault === true;
    if (!retainCapabilities && !retainDefault) {
      return model;
    }
    const aliases = retainDefault
      ? [...new Set([...(model.aliases ?? []), ...(previousModel.aliases ?? [])])]
      : undefined;
    return {
      ...model,
      ...(retainCapabilities ? { capabilities: previousModel.capabilities } : {}),
      ...(retainDefault
        ? {
            isDefault: true,
            ...(aliases && aliases.length > 0 ? { aliases } : {}),
          }
        : {}),
    };
  });
  const nextSlugs = new Set(nextModels.map((model) => model.slug));
  return shouldRetainMissingModels
    ? [...mergedModels, ...retainablePreviousModels.filter((model) => !nextSlugs.has(model.slug))]
    : mergedModels;
};

/**
 * Antigravity's health check only initializes the agent, so after a server
 * restart it reports the account as unchecked. The saved Google login still
 * works, and the previous snapshot proves it. Carry that account state until
 * a session, refresh, or sign-out reports something new. A confirmed missing
 * installation, sign-out, disabled instance, or a changed sign-in method is
 * never overridden.
 */
const carrySavedAntigravityAccount = (
  previousProvider: ServerProvider,
  nextProvider: ServerProvider,
): Pick<ServerProvider, "auth" | "status"> | undefined => {
  const antigravity = ProviderDriverKind.make("antigravity");
  if (
    nextProvider.driver !== antigravity ||
    previousProvider.driver !== antigravity ||
    !nextProvider.enabled ||
    nextProvider.auth.status !== "unknown" ||
    previousProvider.auth.status !== "authenticated" ||
    (nextProvider.auth.type !== undefined &&
      nextProvider.auth.type !== previousProvider.auth.type) ||
    (!nextProvider.installed && nextProvider.status !== "warning")
  ) {
    return undefined;
  }
  // The pending boot probe (`installed: false`, warning) and a failed probe
  // keep their own status; only a passed health check reads as ready.
  const status =
    nextProvider.installed && nextProvider.status === "warning" ? "ready" : nextProvider.status;
  return { auth: previousProvider.auth, status };
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
  keepCachedReadiness = true,
): ServerProvider => {
  if (!previousProvider) {
    return nextProvider;
  }
  if (
    keepCachedReadiness &&
    nextProvider.refreshing &&
    nextProvider.nativeSessions === undefined &&
    previousProvider.enabled &&
    previousProvider.installed &&
    previousProvider.status !== "error" &&
    previousProvider.auth.status !== "unauthenticated" &&
    isCachedProviderCorrelated({
      cachedProvider: previousProvider,
      fallbackProvider: nextProvider,
    }) &&
    canReuseCachedReadiness(previousProvider, nextProvider)
  ) {
    const { recentFailure: _cachedFailure, ...cached } = hydrateCachedProvider({
      cachedProvider: previousProvider,
      fallbackProvider: nextProvider,
    });
    return {
      ...cached,
      ...(nextProvider.recentFailure === undefined
        ? {}
        : { recentFailure: nextProvider.recentFailure }),
      ...(previousProvider.workspaceSnapshots === undefined
        ? {}
        : { workspaceSnapshots: previousProvider.workspaceSnapshots }),
    };
  }
  const savedAccount =
    keepCachedReadiness || !nextProvider.refreshing
      ? carrySavedAntigravityAccount(previousProvider, nextProvider)
      : undefined;
  // "Google account access is not checked yet" describes the probe, not the
  // account; it must not outlive the state it explained.
  const { message: _uncheckedMessage, ...nextWithoutMessage } = nextProvider;
  const previousWorkspaceSnapshots = previousProvider.workspaceSnapshots;
  const nextWorkspaceSnapshots = nextProvider.workspaceSnapshots;
  // A provider reports only folders its own sessions saw, so registry scans of other folders stay.
  const workspaceSnapshots =
    nextWorkspaceSnapshots === undefined ||
    !nextProvider.enabled ||
    nextProvider.auth.status === "unauthenticated" ||
    (!nextProvider.installed && nextProvider.status === "error")
      ? (nextWorkspaceSnapshots ?? previousWorkspaceSnapshots)
      : [
          ...(previousWorkspaceSnapshots ?? []).filter(
            ({ cwd }) => !nextWorkspaceSnapshots.some((snapshot) => snapshot.cwd === cwd),
          ),
          ...nextWorkspaceSnapshots,
        ].slice(-MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER);
  return {
    ...(savedAccount?.status === "ready" ? nextWithoutMessage : nextProvider),
    ...savedAccount,
    models: mergeProviderModels(nextProvider, previousProvider.models, nextProvider.models),
    // The launch-free Antigravity health check does not discover commands. Keep a
    // correlated account's last advertisement through startup on the same runtime.
    ...(savedAccount &&
    nextProvider.slashCommands.length === 0 &&
    (nextProvider.version === null || nextProvider.version === previousProvider.version)
      ? { slashCommands: previousProvider.slashCommands }
      : {}),
    ...(workspaceSnapshots === undefined ? {} : { workspaceSnapshots }),
    ...(shouldRetainMissingOpenCodeMetadata(nextProvider)
      ? {
          slashCommands:
            nextProvider.slashCommands.length === 0
              ? previousProvider.slashCommands
              : nextProvider.slashCommands,
          skills: nextProvider.skills.length === 0 ? previousProvider.skills : nextProvider.skills,
        }
      : {}),
  };
};

export const mergeProviderSnapshots = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> => {
  const mergedProviders = new Map(
    previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
  );

  for (const provider of nextProviders) {
    mergedProviders.set(
      snapshotInstanceKey(provider),
      mergeProviderSnapshot(mergedProviders.get(snapshotInstanceKey(provider)), provider),
    );
  }

  return orderProviderSnapshots([...mergedProviders.values()]);
};

export const selectProvidersByKind = (
  providers: ReadonlyArray<ServerProvider>,
  providerKinds: ReadonlySet<ProviderDriverKind>,
): ReadonlyArray<ServerProvider> =>
  providers.filter((provider) => providerKinds.has(provider.driver));

const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

type UsageReadingAccount = Pick<ServerProvider, "auth" | "usageLimits">;

const knownValuesDiffer = (left: string | undefined, right: string | undefined) =>
  left !== undefined && right !== undefined && left !== right;

// A pending check can lack account identity while cached readiness is provisional.
// A quota reading requires positive evidence that it belongs to the current account.
const canReuseCachedReadiness = (reading: UsageReadingAccount, current: UsageReadingAccount) =>
  current.auth.status !== "unauthenticated" &&
  !knownValuesDiffer(reading.auth.type, current.auth.type) &&
  !knownValuesDiffer(reading.auth.email?.toLowerCase(), current.auth.email?.toLowerCase()) &&
  !knownValuesDiffer(reading.auth.workspaceId, current.auth.workspaceId) &&
  !knownValuesDiffer(
    reading.usageLimits?.credentialFingerprint,
    current.usageLimits?.credentialFingerprint,
  );

const matchesUsageReadingAccount = (
  reading: UsageReadingAccount,
  current: UsageReadingAccount,
  configuredCredentialIdentifiesAccount: boolean,
): boolean => {
  if (reading.auth.status === "unauthenticated" || !canReuseCachedReadiness(reading, current)) {
    return false;
  }
  if (
    configuredCredentialIdentifiesAccount ||
    (reading.usageLimits?.credentialFingerprint !== undefined &&
      reading.usageLimits.credentialFingerprint === current.usageLimits?.credentialFingerprint)
  )
    return true;
  const email = reading.auth.email?.toLowerCase();
  return (
    email !== undefined &&
    email === current.auth.email?.toLowerCase() &&
    reading.auth.workspaceId === current.auth.workspaceId &&
    reading.auth.type === current.auth.type
  );
};

const correlateSnapshotWithSource = (
  source: ProviderSnapshotSource,
  snapshot: ServerProvider,
): Effect.Effect<ServerProvider> => {
  if (snapshot.instanceId !== source.instanceId) {
    return Effect.die(
      new Error(
        `Provider snapshot instance mismatch: source '${source.instanceId}' emitted '${snapshot.instanceId}'.`,
      ),
    );
  }
  if (snapshot.driver !== source.driverKind) {
    return Effect.die(
      new Error(
        `Provider snapshot driver mismatch for instance '${source.instanceId}': source '${source.driverKind}' emitted '${snapshot.driver}'.`,
      ),
    );
  }
  return Effect.succeed(snapshot);
};

/**
 * Key a snapshot for aggregation and persistence. Snapshot sources
 * must be correlated by instance id before reaching this map; missing
 * identities are defects, not runtime routing fallbacks.
 */
const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};

// Project a live `ProviderInstance` into the aggregator's consumption
// shape. Each call re-captures the instance's `snapshot` closures, so
// after `ProviderInstanceRegistry` rebuilds an instance (e.g. because
// its settings changed), a fresh source rides the new PubSub instead
// of a closed one.
const buildSnapshotSource = (instance: ProviderInstanceRegistry.ConfiguredProviderInstance) =>
  ({
    instance,
    instanceId: instance.instanceId,
    driverKind: instance.driverKind,
    getSnapshot: instance.snapshot.getSnapshot,
    refresh: instance.snapshot.refresh,
    streamChanges: instance.snapshot.streamChanges,
  }) satisfies ProviderSnapshotSource & { readonly instance: ProviderInstance };
type LiveProviderSnapshotSource = ReturnType<typeof buildSnapshotSource>;

export const layer = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const harnessDefaults = yield* HarnessDefaultsService.HarnessDefaultsService;
    const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const manifestService = yield* ModelManifest.ModelManifest;
    const serviceScope = yield* Effect.scope;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Aggregator PubSub — consumers (WS gateway, etc.) subscribe here for
    // coalesced updates across every instance.
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    // Boot-only: hydrate `providersRef` from the on-disk per-instance
    // cache so the UI has something to render during the first refresh.
    // Instances added post-boot skip this path; their first entry in
    // `providersRef` comes from the reactive `syncLiveSources` pass
    // below.
    const bootInstances = yield* instanceRegistry.listInstances;
    const bootSources = bootInstances.map(buildSnapshotSource);
    const fallbackProviders = yield* loadProviders(bootSources);
    const fallbackByInstance = new Map<ProviderInstanceId, ServerProvider>();
    for (let index = 0; index < fallbackProviders.length; index++) {
      const provider = fallbackProviders[index];
      const source = bootSources[index];
      if (provider === undefined || source === undefined) {
        continue;
      }
      fallbackByInstance.set(source.instanceId, provider);
    }

    // Keep the original reading for fallback if a probe fails after startup.
    const savedUsageLimits = new Map<
      ProviderInstanceId,
      { readonly usageLimits: ServerProviderUsageLimits; readonly auth: ServerProvider["auth"] }
    >();
    const bootedAt = yield* Clock.currentTimeMillis;
    const cachedProviders = yield* Effect.forEach(
      bootSources,
      (source) =>
        Effect.gen(function* () {
          // One cache file per configured instance. For the default
          // instance of a built-in kind the path equals `<kind>.json` —
          // identical to the legacy filename. We still require the cache
          // payload to carry matching instance id + driver kind; old
          // identity-less payloads are discarded and the awaited refresh
          // below repopulates the cache.
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: source.instanceId,
          }).pipe(Effect.provideService(Path.Path, path));
          const fallbackProvider = fallbackByInstance.get(source.instanceId);
          if (fallbackProvider === undefined) {
            return undefined;
          }
          return yield* readProviderStatusCache(filePath).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.flatMap((cachedProvider) => {
              if (cachedProvider === undefined) {
                return Effect.void.pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              const correlation = {
                cachedProvider,
                fallbackProvider,
              } as const;
              if (!isCachedProviderCorrelated(correlation)) {
                return Effect.logWarning("provider status cache identity mismatch, ignoring", {
                  path: filePath,
                  instanceId: source.instanceId,
                  cachedInstanceId: cachedProvider.instanceId ?? null,
                  driver: source.driverKind,
                  cachedDriver: cachedProvider.driver ?? null,
                }).pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              const credential = source.instance.credentialSettings;
              if (
                cachedProvider.configuredCredentialFingerprint !== credential?.fingerprint ||
                !canReuseCachedReadiness(cachedProvider, fallbackProvider)
              ) {
                return Effect.succeed(undefined);
              }
              // Pre-upgrade Google quota is obsolete even when the cached sign-in is still valid.
              const limits = cachedProvider.usageLimits;
              if (
                cachedProvider.driver !== "antigravity" &&
                limits?.windows.length &&
                cachedProvider.enabled &&
                fallbackProvider.enabled &&
                cachedProvider.auth.status !== "unauthenticated"
              ) {
                savedUsageLimits.set(source.instanceId, {
                  usageLimits: limits,
                  auth: cachedProvider.auth,
                });
              }
              const hydrated = hydrateCachedProvider(correlation);
              // A fast status probe can finish before its separate quota read.
              const usageLimits =
                fallbackProvider.usageLimits === undefined &&
                matchesUsageReadingAccount(
                  cachedProvider,
                  fallbackProvider,
                  credential?.identifiesAccount === true,
                )
                  ? usageReadingWhileRefreshing(
                      savedUsageLimits.get(source.instanceId)?.usageLimits,
                      bootedAt,
                    )
                  : undefined;
              return Effect.succeed(usageLimits ? { ...hydrated, usageLimits } : hydrated);
            }),
          );
        }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((providers) =>
        orderProviderSnapshots(
          providers.filter((provider): provider is ServerProvider => provider !== undefined),
        ),
      ),
      Effect.withSpan("provider.status.cache.hydrate"),
    );
    const initialManifest = yield* manifestService.current;
    const classifyCompatibility = (
      provider: ServerProvider,
      manifest: ModelManifest.ModelManifestData,
    ) =>
      applyProviderCompatibility(
        provider,
        manifest.compatibility,
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
      );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      cachedProviders.map((provider) => classifyCompatibility(provider, initialManifest)),
    );
    const refreshingSince = new Map(
      cachedProviders
        .filter((provider) => provider.refreshing)
        .map((provider) => [provider.instanceId, bootedAt] as const),
    );
    const usageLimitHistory = makeUsageLimitHistory();
    const usageLimitProbedAt = new Map<ProviderInstanceId, number>();
    const getUsageLimitRecorder = yield* Effect.cached(
      makeUsageLimitRecorder({
        filePath: path.join(config.providerStatusCacheDir, "usage-limit-readings.ndjson"),
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.tapError(() => Effect.logWarning("usage limit recording unavailable")),
        Effect.orElseSucceed(() => ({ append: () => Effect.void })),
      ),
    );
    yield* getUsageLimitRecorder.pipe(Effect.forkIn(serviceScope));
    const workspaceRefreshesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstance, ReadonlySet<string>>
    >(new Map());
    const maintenanceActionStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly update?: ServerProviderUpdateState | undefined }>
    >(new Map());
    const recentFailuresRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, ServerProviderRecentFailure>
    >(
      new Map(
        cachedProviders.flatMap((provider) =>
          rememberedAccountFailure(provider)
            ? [[provider.instanceId, provider.recentFailure!] as const]
            : [],
        ),
      ),
    );

    const recentUseRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, number>>(new Map());

    const unavailableModelsPath = path.join(config.providerStatusCacheDir, UNAVAILABLE_MODELS_FILE);
    const modelFailures = makeModelFailureTracker();
    const unavailableModelsJson = Schema.fromJsonString(UnavailableModelsFile);
    // A missing, oversized or unreadable file starts empty; the next record rewrites it.
    const unavailableModelsRef = yield* Ref.make<ReadonlyArray<UnavailableModel>>(
      yield* fileSystem.stat(unavailableModelsPath).pipe(
        Effect.flatMap((info) =>
          Number(info.size) > MAX_UNAVAILABLE_MODELS_FILE_BYTES
            ? Effect.succeed([])
            : fileSystem.readFileString(unavailableModelsPath).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(unavailableModelsJson)),
                Effect.map((file) => file.models),
              ),
        ),
        Effect.orElseSucceed((): ReadonlyArray<UnavailableModel> => []),
      ),
    );
    const unavailableModelsLock = yield* Semaphore.make(1);

    // Live-source registry — the dynamic counterpart to the boot-time
    // `bootSources`. Keyed by `instanceId`; the stored `ProviderInstance`
    // reference is used for identity equality so "no-op" reconciles
    // (settings unchanged) skip re-subscribing + re-probing.
    let liveInstances: ReadonlyMap<
      ProviderInstanceId,
      ProviderInstanceRegistry.ConfiguredProviderInstance
    > = new Map(bootInstances.map((instance) => [instance.instanceId, instance]));
    let liveSourcesSynced = false;
    // Serialize `syncLiveSources` so a rapid burst of reconciles doesn't
    // interleave two passes clobbering each other's fiber bookkeeping.
    const syncSemaphore = yield* Semaphore.make(1);

    const getLiveSources = Effect.sync(() =>
      Array.from(liveInstances.values(), buildSnapshotSource),
    );

    const cacheWriters = new Map<
      ProviderInstanceId,
      { lock: Semaphore.Semaphore; users: number }
    >();
    const withProviderCacheLock = <A, E>(key: ProviderInstanceId, use: Effect.Effect<A, E>) =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const writer = cacheWriters.get(key) ?? { lock: Semaphore.makeUnsafe(1), users: 0 };
          writer.users++;
          cacheWriters.set(key, writer);
          return writer;
        }),
        ({ lock }) => lock.withPermit(use),
        (writer) =>
          Effect.sync(() => {
            writer.users--;
            if (writer.users === 0) cacheWriters.delete(key);
          }),
      );
    const invalidateProviderCache = (
      instance: ProviderInstanceRegistry.ConfiguredProviderInstance,
    ) =>
      withProviderCacheLock(
        instance.instanceId,
        Effect.gen(function* () {
          const filePath = path.join(config.providerStatusCacheDir, `${instance.instanceId}.json`);
          const saved = yield* readProviderStatusCache(filePath).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
          );
          if (
            saved &&
            (saved.driver !== instance.driverKind ||
              saved.configuredCredentialFingerprint !== instance.credentialSettings?.fingerprint)
          ) {
            yield* fileSystem.remove(filePath, { force: true }).pipe(
              Effect.tapError(() => Effect.logWarning("Failed to remove outdated provider cache.")),
              Effect.ignore,
            );
          }
        }),
      );
    const persistProvider = (key: ProviderInstanceId, accountFailure = false) =>
      withProviderCacheLock(
        key,
        Effect.gen(function* () {
          const latest = (yield* Ref.get(providersRef)).find(
            (provider) => provider.instanceId === key,
          );
          if (!latest || (latest.refreshing && !accountFailure)) return;
          const credential = liveInstances.get(key)?.credentialSettings;
          // Persist every instance — the file name is the instance id, so
          // multi-instance setups (e.g. `codex_personal`, `codex_work`) each
          // get their own cache. We resolve the path fresh so snapshots
          // produced by newly-added instances post-boot still land on disk
          // without the aggregator holding a stale `cachePathByInstance`
          // entry.
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: key,
          }).pipe(Effect.provideService(Path.Path, path));
          const savedSnapshot = latest.refreshing
            ? yield* readProviderStatusCache(filePath).pipe(
                Effect.provideService(FileSystem.FileSystem, fileSystem),
              )
            : undefined;
          const lastComplete = latest.refreshing ? savedSnapshot : latest;
          if (
            !lastComplete ||
            (savedSnapshot &&
              savedSnapshot.configuredCredentialFingerprint !== credential?.fingerprint) ||
            !isCachedProviderCorrelated({
              cachedProvider: lastComplete,
              fallbackProvider: latest,
            })
          )
            return;
          const {
            workspaceSnapshots: _workspaceSnapshots,
            recentFailure: _recentFailure,
            recentUse: _recentUse,
            ...machineProvider
          } = lastComplete;
          // During the first probe a repeat restart should still find the original reading.
          const saved = savedUsageLimits.get(key);
          yield* writeProviderStatusCache({
            filePath,
            configuredCredentialFingerprint: credential?.fingerprint,
            provider: {
              ...machineProvider,
              ...((lastComplete.usageLimits === undefined || lastComplete.usageLimits.refreshing) &&
              saved &&
              matchesUsageReadingAccount(
                saved,
                lastComplete,
                credential?.identifiesAccount === true,
              )
                ? { usageLimits: saved.usageLimits }
                : {}),
              ...(rememberedAccountFailure(latest) ? { recentFailure: latest.recentFailure } : {}),
            },
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
            Effect.tapError(Effect.logError),
            Effect.ignore,
          );
        }),
      );

    /** Overlay run health and maintenance state on the driver-owned snapshot. */
    const applyProviderUpdateState = Effect.fn("applyProviderUpdateState")(function* (
      provider: ServerProvider,
    ) {
      const maintenanceActionStates = yield* Ref.get(maintenanceActionStatesRef);
      const updateState = maintenanceActionStates.get(provider.instanceId)?.update;
      let storedFailure = (yield* Ref.get(recentFailuresRef)).get(provider.instanceId);
      const limits = provider.usageLimits;
      if (
        storedFailure?.outOfCredit &&
        limits &&
        !limits.refreshing &&
        !limits.unavailable &&
        Date.parse(limits.checkedAt) > Date.parse(storedFailure.occurredAt) &&
        limits.windows.length > 0 &&
        limits.windows.every(
          (window) =>
            window.limited !== true &&
            window.usedPercent < 100 &&
            (!window.resetsAt || Date.parse(window.resetsAt) > Date.parse(limits.checkedAt)),
        )
      ) {
        yield* Ref.update(recentFailuresRef, (previous) => {
          const next = new Map(previous);
          if (next.get(provider.instanceId) === storedFailure) next.delete(provider.instanceId);
          return next;
        });
        storedFailure = undefined;
      }
      // A limits read after a sign-in failure settles it: one that works shows the login does,
      // and one that fails too confirms the account is signed out. Confirmed, it loses its
      // retry time: like running out of credit, it stands until a run works, a limits read
      // does, or the user clears it, so new work never tries the account again in between.
      if (
        storedFailure?.kind === "authentication_error" &&
        limits &&
        !limits.refreshing &&
        Date.parse(limits.checkedAt) > Date.parse(storedFailure.occurredAt)
      ) {
        const { resetAt: _retry, ...confirmed } = storedFailure;
        const settled: ServerProviderRecentFailure | undefined =
          !limits.unavailable && limits.windows.length > 0
            ? undefined
            : limits.unavailable?.reason === "probeFailed"
              ? confirmed
              : storedFailure;
        if (settled === undefined || settled.resetAt !== storedFailure.resetAt) {
          const stored = storedFailure;
          yield* Ref.update(recentFailuresRef, (previous) => {
            if (previous.get(provider.instanceId) !== stored) return previous;
            const next = new Map(previous);
            if (settled === undefined) next.delete(provider.instanceId);
            else next.set(provider.instanceId, settled);
            return next;
          });
          storedFailure = settled;
        }
      }
      // An account failure stays past its retry time: nothing has worked since.
      // Retain scoped failures too; their consumers choose the model to check.
      const recentFailure = storedFailure
        ? (rememberedAccountFailure({ recentFailure: storedFailure }) ??
          activeProviderFailure(
            { recentFailure: storedFailure },
            yield* Clock.currentTimeMillis,
            storedFailure.modelIds?.[0],
          ))
        : null;
      const recentUse = (yield* Ref.get(recentUseRef)).get(provider.instanceId);
      const {
        updateState: _updateState,
        recentFailure: _recentFailure,
        recentUse: _recentUse,
        ...probedProvider
      } = provider;
      return {
        ...probedProvider,
        ...(updateState ? { updateState } : {}),
        ...(recentFailure ? { recentFailure } : {}),
        ...(recentUse === undefined ? {} : { recentUse }),
      };
    });

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly persist?: boolean;
        readonly replace?: boolean;
        readonly source?: LiveProviderSnapshotSource;
      },
    ) {
      const manifest = yield* manifestService.current;
      const nextProvidersWithUpdateState = yield* Effect.forEach(
        nextProviders,
        applyProviderUpdateState,
        {
          concurrency: "unbounded",
        },
      );
      const now = yield* Clock.currentTimeMillis;
      const updatedProviders = yield* Ref.modify(providersRef, (previousProviders) => {
        const mergedProviders = new Map(
          previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
        );
        const updatedKeys = new Set<ProviderInstanceId>();

        for (const [index, provider] of nextProvidersWithUpdateState.entries()) {
          const key = snapshotInstanceKey(provider);
          const previous = mergedProviders.get(key);
          const source = options?.source;
          if (!source) {
            // An overlay can contain hydrated auth. Only a source can verify quota
            // ownership, and an overlay must not revive a superseded snapshot.
            if (options?.replace || previous === nextProviders[index]) {
              updatedKeys.add(key);
              mergedProviders.set(key, provider);
            }
            continue;
          }
          if (liveInstances.get(key) !== source.instance) continue;
          if (provider.enabled && provider.refreshing) {
            if (!refreshingSince.has(key)) refreshingSince.set(key, now);
          } else {
            refreshingSince.delete(key);
          }
          const keepCachedReadiness =
            now - (refreshingSince.get(key) ?? now) < CACHED_READINESS_GRACE_MS;
          const identifiesAccount =
            liveInstances.get(key)?.credentialSettings?.identifiesAccount === true;
          const saved = savedUsageLimits.get(key);
          const probedLimits = provider.usageLimits;
          if (
            !provider.enabled ||
            provider.auth.status === "unauthenticated" ||
            (probedLimits &&
              !probedLimits.refreshing &&
              probedLimits.unavailable?.reason !== "probeFailed") ||
            (saved && !canReuseCachedReadiness(saved, provider))
          )
            savedUsageLimits.delete(key);
          if (previous && !canReuseCachedReadiness(previous, provider))
            usageLimitHistory.clear(key);
          const canKeepReading = provider.enabled && (provider.installed || provider.refreshing);
          const previousReading =
            canKeepReading &&
            previous &&
            matchesUsageReadingAccount(previous, provider, identifiesAccount)
              ? previous.usageLimits
              : undefined;
          const savedReading =
            canKeepReading &&
            saved &&
            matchesUsageReadingAccount(saved, provider, identifiesAccount)
              ? saved.usageLimits
              : undefined;
          const limits = probedLimits
            ? withLastUsageReading(
                probedLimits,
                previousReading?.windows.length ? previousReading : savedReading,
                now,
              )
            : usageReadingWhileRefreshing(
                previousReading?.refreshing ? previousReading : savedReading,
                now,
              );
          const withPace = limits
            ? {
                ...provider,
                usageLimits: limits.refreshing
                  ? limits
                  : usageLimitHistory.record(key, limits, previousReading ?? savedReading),
              }
            : provider;
          updatedKeys.add(key);
          mergedProviders.set(key, mergeProviderSnapshot(previous, withPace, keepCachedReadiness));
        }

        const providers = orderProviderSnapshots(
          [...mergedProviders.values()].map((provider) =>
            classifyCompatibility(provider, manifest),
          ),
        );
        if (!haveProvidersChanged(previousProviders, providers)) {
          return [undefined, previousProviders];
        }
        const updated = providers.filter((provider) =>
          updatedKeys.has(snapshotInstanceKey(provider)),
        );
        return [updated, providers];
      });

      if (!updatedProviders) return yield* Ref.get(providersRef);
      if (options?.persist !== false) {
        yield* Effect.forEach(
          updatedProviders.filter((provider) => !provider.refreshing),
          (provider) => persistProvider(provider.instanceId),
          { concurrency: "unbounded", discard: true },
        );
      }
      // A concurrent provider may have finished during this instance's cache write.
      // Publish the current list, and keep the shared usage archive off this path.
      yield* Ref.get(providersRef).pipe(
        Effect.map((current) => PubSub.publishUnsafe(changesPubSub, current)),
      );
      if (
        updatedProviders.some(
          (provider) => provider.usageLimits && !provider.usageLimits.refreshing,
        )
      ) {
        const recorder = yield* getUsageLimitRecorder;
        yield* Effect.forEach(
          updatedProviders,
          (provider) =>
            provider.usageLimits && !provider.usageLimits.refreshing
              ? recorder.append(provider.instanceId, provider.driver, provider.usageLimits)
              : Effect.void,
          { discard: true },
        );
      }

      return yield* Ref.get(providersRef);
    });

    const compatibilityRefreshRunning = yield* Ref.make(false);
    const syncProvider = Effect.fn("syncProvider")(function* (
      source: LiveProviderSnapshotSource,
      provider: ServerProvider,
    ) {
      if ((yield* instanceRegistry.getInstance(source.instanceId)) !== source.instance) {
        return yield* Ref.get(providersRef);
      }
      const providers = yield* upsertProviders([provider], { source });
      // Reclassify the current read model after fetching. Never republish the
      // probe captured before the fetch: a newer health result may have landed.
      if (!(yield* Ref.getAndSet(compatibilityRefreshRunning, true))) {
        yield* manifestService.refresh.pipe(
          Effect.andThen(upsertProviders([], { persist: false })),
          Effect.ensuring(Ref.set(compatibilityRefreshRunning, false)),
          Effect.forkIn(serviceScope),
        );
      }
      return providers;
    });

    const setProviderMaintenanceActionState = Effect.fn("setProviderMaintenanceActionState")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly action: "update";
        readonly state: ServerProviderUpdateState | null;
      }) {
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const previousActions = previous.get(input.instanceId);
          const nextActions = { ...previousActions };
          if (input.state === null || input.state.status === "idle") {
            delete nextActions[input.action];
          } else {
            nextActions[input.action] = input.state;
          }

          const next = new Map(previous);
          if (Object.keys(nextActions).length === 0) {
            next.delete(input.instanceId);
          } else {
            next.set(input.instanceId, nextActions);
          }
          return next;
        });

        const existingProviders = yield* Ref.get(providersRef);
        const matchingProvider = existingProviders.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!matchingProvider) {
          return existingProviders;
        }

        return yield* upsertProviders([matchingProvider], {
          persist: false,
        });
      },
    );

    /**
     * A fresh limits read after a sign-in failure, from the instance's own
     * check rather than a cached one: `applyProviderUpdateState` weighs it.
     */
    const checkSignIn = (instanceId: ProviderInstanceId): Effect.Effect<void> =>
      instanceRegistry.getInstance(instanceId).pipe(
        Effect.flatMap((instance) => instance?.invalidateCaches ?? Effect.void),
        Effect.andThen(refreshInstance(instanceId)),
        Effect.catchCause(recoverRefreshFailure),
        Effect.forkIn(serviceScope),
        Effect.asVoid,
      );

    const setProviderRecentFailure = Effect.fn("setProviderRecentFailure")(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly failure: ServerProviderRecentFailure | null;
      readonly preserveOutOfCredit?: boolean;
    }) {
      const signingIn = input.failure?.kind === "authentication_error";
      // A sign-in failure names the command that signs this instance in again.
      const signInCommand = signingIn
        ? (yield* instanceRegistry.getInstance(input.instanceId))?.signInCommand
        : undefined;
      const failure =
        input.failure !== null && signInCommand !== undefined
          ? { ...input.failure, message: signedOutReason(signInCommand) }
          : input.failure;
      type Recorded = readonly [changed: boolean, checkSignIn: boolean];
      const [changed, check] = yield* Ref.modify(recentFailuresRef, (previous) => {
        if (failure === null && !previous.has(input.instanceId)) {
          return [[false, false] as Recorded, previous] as const;
        }
        const current = previous.get(input.instanceId);
        if (
          current?.outOfCredit &&
          (input.preserveOutOfCredit || (failure !== null && !failure.outOfCredit))
        )
          return [[false, false] as Recorded, previous] as const;
        // A confirmed sign-out stands as it is: more failed runs say nothing new.
        if (signingIn && current?.kind === "authentication_error" && current.resetAt === undefined)
          return [[false, false] as Recorded, previous] as const;
        const next = new Map(previous);
        if (failure === null) next.delete(input.instanceId);
        else next.set(input.instanceId, current?.outOfCredit ? current : failure);
        // Each new sign-in failure is checked until one is confirmed; a repeat of it is not.
        const fresh =
          current?.kind !== "authentication_error" || current.occurredAt !== failure?.occurredAt;
        return [[true, signingIn && fresh] as Recorded, next] as const;
      });
      if (!changed) return;
      const matchingProvider = (yield* Ref.get(providersRef)).find(
        (candidate) => candidate.instanceId === input.instanceId,
      );
      if (!matchingProvider) return;
      yield* upsertProviders([matchingProvider]);
      if (matchingProvider.refreshing) yield* persistProvider(input.instanceId, true);
      if (check) yield* checkSignIn(input.instanceId);
    });

    const setProviderRecentUse = Effect.fn("setProviderRecentUse")(function* (
      measured: ReadonlyMap<ProviderInstanceId, number>,
    ) {
      const changed = yield* Ref.modify(recentUseRef, (published) => {
        const next = new Map<ProviderInstanceId, number>();
        const moved = new Set<ProviderInstanceId>();
        for (const [instanceId, hours] of measured) {
          const before = published.get(instanceId);
          if (before !== undefined && !recentUseMoved(before, hours)) {
            next.set(instanceId, before);
            continue;
          }
          next.set(instanceId, hours);
          moved.add(instanceId);
        }
        for (const instanceId of published.keys()) {
          if (!next.has(instanceId)) moved.add(instanceId);
        }
        return [moved, moved.size === 0 ? published : next] as const;
      });
      if (changed.size === 0) return;
      const matching = (yield* Ref.get(providersRef)).filter((provider) =>
        changed.has(provider.instanceId),
      );
      if (matching.length > 0) yield* upsertProviders(matching, { persist: false });
    });

    const setModelUnavailable = Effect.fn("setModelUnavailable")(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly reason: string | null;
    }) {
      const now = yield* Clock.currentTimeMillis;
      const changed = yield* unavailableModelsLock.withPermits(1)(
        Effect.gen(function* () {
          const previous = yield* Ref.get(unavailableModelsRef);
          const next =
            input.reason === null
              ? forgetUnavailableModel(previous, input.instanceId, input.model)
              : rememberUnavailableModel(
                  previous,
                  {
                    instanceId: input.instanceId,
                    model: input.model,
                    reason: input.reason,
                    at: now,
                  },
                  now,
                );
          if (next === previous) return false;
          yield* Ref.set(unavailableModelsRef, next);
          const contents = yield* Schema.encodeEffect(unavailableModelsJson)({
            version: 1,
            models: next,
          });
          yield* writeFileStringAtomically({
            filePath: unavailableModelsPath,
            contents: `${contents}\n`,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
          return true;
        }).pipe(
          // The record is a hint for the next pick; losing it must not fail a run.
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not save unavailable models", { cause }).pipe(Effect.as(true)),
          ),
        ),
      );
      if (changed) yield* PubSub.publish(changesPubSub, yield* Ref.get(providersRef));
    });

    const refreshOneSource = Effect.fn("refreshOneSource")(function* (
      providerSource: LiveProviderSnapshotSource,
    ) {
      return yield* providerSource.refresh.pipe(
        Effect.flatMap((nextProvider) =>
          correlateSnapshotWithSource(providerSource, nextProvider).pipe(
            Effect.flatMap((provider) => syncProvider(providerSource, provider)),
          ),
        ),
      );
    });

    type RefreshAllCompletion = Deferred.Deferred<ReadonlyArray<ServerProvider>>;
    const refreshAllInFlightRef = yield* Ref.make<Option.Option<RefreshAllCompletion>>(
      Option.none(),
    );

    // Untargeted refreshes probe every live source, so any read-scoped client
    // can request them. Concurrent callers share one in-flight pass instead of
    // each starting their own set of provider processes.
    const refreshAll = Effect.fn("refreshAll")(function* () {
      const claimed = yield* Ref.modify(
        refreshAllInFlightRef,
        (
          inFlight,
        ): readonly [
          { readonly owner: boolean; readonly completion: RefreshAllCompletion },
          Option.Option<RefreshAllCompletion>,
        ] => {
          if (Option.isSome(inFlight)) {
            return [{ owner: false, completion: inFlight.value }, inFlight];
          }
          const completion = Deferred.makeUnsafe<ReadonlyArray<ServerProvider>>();
          return [{ owner: true, completion }, Option.some(completion)];
        },
      );
      if (claimed.owner) {
        // Detached so an interrupted first caller cannot cancel the pass that
        // other callers are already awaiting.
        yield* getLiveSources.pipe(
          Effect.flatMap((sources) =>
            Effect.forEach(sources, (source) => refreshOneSource(source), {
              concurrency: "unbounded",
              discard: true,
            }),
          ),
          Effect.andThen(Ref.get(providersRef)),
          Effect.onExit((exit) =>
            Ref.set(refreshAllInFlightRef, Option.none()).pipe(
              Effect.andThen(Deferred.done(claimed.completion, exit)),
            ),
          ),
          Effect.forkDetach,
        );
      }
      return yield* Deferred.await(claimed.completion);
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderDriverKind) {
      if (provider === undefined) {
        return yield* refreshAll();
      }
      // Kind-scoped refreshes target the default instance for that driver.
      const defaultInstanceId = defaultInstanceIdForDriver(provider);
      const sources = yield* getLiveSources;
      const providerSource = sources.find(
        (candidate) => candidate.instanceId === defaultInstanceId,
      );
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const refreshInstance = Effect.fn("refreshInstance")(function* (
      instanceId: ProviderInstanceId,
      options?: { readonly clearOutOfCredit?: boolean },
    ) {
      const stored = (yield* Ref.get(recentFailuresRef)).get(instanceId);
      if (
        options?.clearOutOfCredit &&
        stored &&
        rememberedAccountFailure({ recentFailure: stored })
      )
        yield* setProviderRecentFailure({ instanceId, failure: null });
      const sources = yield* getLiveSources;
      const providerSource = sources.find((candidate) => candidate.instanceId === instanceId);
      if (!providerSource) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(providerSource);
    });

    const getProviderMaintenanceCapabilitiesForInstance = Effect.fn(
      "getProviderMaintenanceCapabilitiesForInstance",
    )(function* (
      instanceId: ProviderInstanceId,
      provider: ProviderDriverKind,
      options?: { readonly fresh?: boolean },
    ) {
      // Read the instance registry, since the live source map trails
      // reconciliation, and an update must never run a retired instance's
      // command against a freshly configured executable.
      const instance = yield* instanceRegistry.getInstance(instanceId);
      if (!instance || instance.driverKind !== provider) {
        return makeManualProviderMaintenanceCapabilities(provider);
      }
      return yield* instance.snapshot.resolveMaintenance(options);
    });

    /**
     * Diff the aggregator's live-source set against the current
     * `ProviderInstanceRegistry` and:
     *   - subscribe to each newly-added or rebuilt instance's
     *     `streamChanges` (so periodic + enrichment refreshes land in
     *     `providersRef`);
     *   - read each newly-added/rebuilt instance's current snapshot after
     *     subscribing, closing the race with its independently-running
     *     background startup probe;
     *   - prune `providersRef` of instances that no longer exist.
     *
     * Provider refreshes are owned by each managed provider and never run
     * on this layer's construction path. Consumers see cached or pending
     * snapshots immediately, then receive live probe results through the
     * already-attached change stream.
     *
     * Per-instance subscription fibers are not tracked explicitly. When
     * a rebuilt instance's old child scope closes, its PubSub shuts
     * down and our `Stream.runForEach` fiber exits naturally.
     */
    const syncLiveSources = syncSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const instances = yield* instanceRegistry.listInstances;
        const unavailableProviders = yield* instanceRegistry.listUnavailable;
        const nextByInstance = new Map(
          instances.map((instance) => [instance.instanceId, instance] as const),
        );
        const knownInstanceIds = new Set<ProviderInstanceId>(nextByInstance.keys());
        for (const provider of unavailableProviders) {
          knownInstanceIds.add(snapshotInstanceKey(provider));
        }
        const previousSubs = liveInstances;
        const changedCredentials = new Map<
          ProviderInstanceId,
          ProviderInstanceRegistry.ConfiguredProviderInstance
        >();
        for (const [instanceId, previousInstance] of previousSubs) {
          const nextInstance = nextByInstance.get(instanceId);
          if (nextInstance !== previousInstance) {
            usageLimitHistory.clear(instanceId);
            savedUsageLimits.delete(instanceId);
            refreshingSince.delete(instanceId);
          }
          if (
            nextInstance &&
            (previousInstance.driverKind !== nextInstance.driverKind ||
              previousInstance.credentialSettings?.fingerprint !==
                nextInstance.credentialSettings?.fingerprint)
          ) {
            changedCredentials.set(instanceId, nextInstance);
          }
        }

        const newlyAdded = instances.filter(
          (instance) => !liveSourcesSynced || previousSubs.get(instance.instanceId) !== instance,
        );

        const rebuiltInstanceIds = new Set(
          newlyAdded
            .filter((instance) => {
              const previous = previousSubs.get(instance.instanceId);
              return previous !== undefined && previous !== instance;
            })
            .map((instance) => instance.instanceId),
        );
        if (changedCredentials.size > 0) {
          yield* Ref.update(recentFailuresRef, (previous) => {
            const next = new Map(previous);
            for (const instanceId of changedCredentials.keys()) next.delete(instanceId);
            return next;
          });
        }
        const [beforeRebuild, afterRebuild] = yield* Ref.modify(providersRef, (providers) => {
          // Change the source and its read model together. Late results from an old
          // credential cannot be stamped with the replacement's fingerprint.
          liveInstances = nextByInstance;
          liveSourcesSynced = true;
          const updated = providers.flatMap((provider) => {
            if (changedCredentials.has(provider.instanceId)) return [];
            if (!rebuiltInstanceIds.has(provider.instanceId)) return [provider];
            const { workspaceSnapshots: _workspaceSnapshots, ...machineSnapshot } = provider;
            return [machineSnapshot];
          });
          return [[providers, updated] as const, updated];
        });
        if (haveProvidersChanged(beforeRebuild, afterRebuild)) {
          yield* PubSub.publish(changesPubSub, afterRebuild);
        }
        yield* Effect.forEach(changedCredentials.values(), invalidateProviderCache, {
          concurrency: "unbounded",
          discard: true,
        });

        // Fork long-lived subscriptions to each new/rebuilt instance's
        // change stream before reading its current snapshot. If the
        // driver's own initial probe finishes during this sync, either
        // the current read or the active subscriber observes the result.
        for (const instance of newlyAdded) {
          const source = buildSnapshotSource(instance);
          yield* Stream.runForEach(source.streamChanges, (provider) =>
            correlateSnapshotWithSource(source, provider).pipe(
              Effect.flatMap((snapshot) => syncProvider(source, snapshot)),
            ),
          ).pipe(Effect.forkScoped);
        }
        yield* Effect.yieldNow;

        // Snapshot current state without starting a probe. Managed providers
        // launch their startup refresh independently, so this closes the
        // subscription race without putting external work on the registry
        // or HTTP server construction path.
        yield* Effect.forEach(
          newlyAdded,
          (instance) =>
            Effect.gen(function* () {
              const source = buildSnapshotSource(instance);
              const provider = yield* source.getSnapshot;
              yield* correlateSnapshotWithSource(source, provider).pipe(
                Effect.flatMap((snapshot) => syncProvider(source, snapshot)),
              );
            }).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: "unbounded", discard: true },
        );
        yield* upsertProviders(unavailableProviders, {
          persist: false,
          replace: true,
        });

        // Drop aggregator state for instances that have disappeared —
        // otherwise the UI would keep rendering ghosts.
        const [previousProviders, providers] = yield* Ref.modify(
          providersRef,
          (previousProviders) => {
            const providers = orderProviderSnapshots(
              previousProviders.filter((provider) =>
                knownInstanceIds.has(snapshotInstanceKey(provider)),
              ),
            );
            return [[previousProviders, providers] as const, providers];
          },
        );
        if (haveProvidersChanged(previousProviders, providers)) {
          yield* PubSub.publish(changesPubSub, providers);
        }
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const next = new Map(previous);
          for (const instanceId of previous.keys()) {
            if (!knownInstanceIds.has(instanceId)) {
              next.delete(instanceId);
            }
          }
          return next;
        });
      }),
    );
    const syncLiveSourcesAndContinue = syncLiveSources.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logError(
          "provider registry instance sync failed; keeping subscription alive",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );

    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the dequeue synchronously in this
    // fibre; the subscription is active the instant this `yield*`
    // returns. Forking the consumer loop later cannot lose a publish
    // because no publish can reach a not-yet-subscribed dequeue.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `Stream.fromPubSub` defers `PubSub.subscribe` to stream start,
    // and `forkScoped` only schedules the fibre — so a reconcile that
    // published between "fibre scheduled" and "fibre starts running"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the `PubSub.Subscription` synchronously
    // in this fibre; the subscription is registered with the PubSub the
    // instant this `yield*` returns, so any subsequent publish is
    // buffered in the subscription regardless of when the consumer
    // fibre below actually starts running.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `instanceRegistry.streamChanges` is `Stream.fromPubSub(changes)`,
    // which defers `PubSub.subscribe` to stream start. `forkScoped` only
    // schedules the consumer fibre — so a reconcile that published
    // between "fibre scheduled" and "fibre starts running + subscribes"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    const instanceChanges = yield* instanceRegistry.subscribeChanges;
    // Initial sync attaches subscriptions and snapshots current state for
    // every instance present at boot. Provider probes are already running in
    // their managed background fibers and never block this layer.
    yield* syncLiveSources;
    // React to registry mutations — instance added / removed / rebuilt.
    // `Stream.fromSubscription` builds a stream over the pre-acquired
    // subscription rather than subscribing on stream start, which is
    // what closes the race.
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => syncLiveSourcesAndContinue,
    ).pipe(Effect.forkScoped);

    const recoverRefreshFailure = Effect.fn("recoverRefreshFailure")(function* (
      cause: Cause.Cause<unknown>,
    ) {
      if (Cause.hasInterruptsOnly(cause)) {
        return yield* Effect.interrupt;
      }
      yield* Effect.logError("provider registry refresh failed; preserving cached providers", {
        cause: Cause.pretty(cause),
      });
      return yield* Ref.get(providersRef);
    });

    const updateProviders = (
      update: (providers: ReadonlyArray<ServerProvider>) => ReadonlyArray<ServerProvider>,
    ) =>
      Ref.modify(providersRef, (currentProviders) => {
        const nextProviders = update(currentProviders);
        return [[currentProviders, nextProviders] as const, nextProviders];
      }).pipe(
        Effect.tap(([previousProviders, nextProviders]) =>
          haveProvidersChanged(previousProviders, nextProviders)
            ? PubSub.publish(changesPubSub, nextProviders)
            : Effect.void,
        ),
        Effect.map(([, nextProviders]) => nextProviders),
      );

    const refreshWorkspaceSnapshot = Effect.fn("refreshWorkspaceSnapshot")(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly fresh?: boolean;
    }) {
      // Fresh scans drop other instances' snapshots for this cwd first, so a
      // composer on one of them scans again on next use, even when this
      // instance is gone or cannot be scanned.
      if (input.fresh) {
        yield* updateProviders((providers) =>
          providers.map((candidate) =>
            candidate.instanceId === input.instanceId
              ? candidate
              : dropProviderWorkspaceSnapshot(candidate, input.cwd),
          ),
        );
      }
      const providers = yield* Ref.get(providersRef);
      const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
      const workspaceSnapshotOf = (candidate: ServerProvider | undefined) =>
        candidate?.workspaceSnapshots?.find((s) => s.cwd === input.cwd);
      const scannedFrom = workspaceSnapshotOf(provider);
      const now = yield* DateTime.now;
      if (
        !provider ||
        !provider.enabled ||
        (!input.fresh &&
          scannedFrom &&
          !scannedFrom.slashCommandsPending &&
          isProviderWorkspaceSnapshotCurrent(scannedFrom, DateTime.toEpochMillis(now)))
      ) {
        return providers;
      }
      // Drivers spread their machine snapshot, whose `checkedAt` is the last
      // health check. The TTL needs the time this scan started reading files.
      const scannedAt = DateTime.formatIso(now);
      const instance = yield* instanceRegistry.getInstance(input.instanceId);
      if (!instance?.snapshotForCwd) return providers;
      const claimed = yield* Ref.modify(workspaceRefreshesRef, (refreshes) => {
        const current = refreshes.get(instance);
        if (current?.has(input.cwd)) return [false, refreshes] as const;
        const next = new Map(refreshes);
        next.set(instance, new Set(current).add(input.cwd));
        return [true, next] as const;
      });
      // A fresh scan never joins a running one, which may predate the change.
      if (!claimed && !input.fresh) return yield* Ref.get(providersRef);
      // Fresh scans also re-read the machine snapshot after invalidating caches.
      const refreshMachineSnapshot = input.fresh
        ? (instance.invalidateCaches ?? Effect.void).pipe(
            Effect.andThen(refreshInstance(input.instanceId)),
          )
        : Effect.void;
      return yield* refreshMachineSnapshot.pipe(
        Effect.andThen(instance.snapshotForCwd(input.cwd)),
        Effect.flatMap((scopedSnapshot) =>
          scopedSnapshot.status === "error" && scopedSnapshot.slashCommandsPending === undefined
            ? Ref.get(providersRef)
            : instanceRegistry.getInstance(input.instanceId).pipe(
                Effect.flatMap((currentInstance) => {
                  if (currentInstance !== instance) return Ref.get(providersRef);
                  // Write only if the cwd's snapshot did not change during the
                  // scan. A session event or another scan that landed first is newer.
                  return updateProviders((currentProviders) =>
                    currentProviders.map((candidate) =>
                      candidate.instanceId === input.instanceId &&
                      Equal.equals(workspaceSnapshotOf(candidate), scannedFrom)
                        ? upsertProviderWorkspaceSnapshot(candidate, input.cwd, {
                            ...scopedSnapshot,
                            checkedAt: scannedAt,
                          })
                        : candidate,
                    ),
                  );
                }),
              ),
        ),
        Effect.ensuring(
          claimed
            ? Ref.update(workspaceRefreshesRef, (refreshes) => {
                const next = new Map(refreshes);
                const current = new Set(next.get(instance));
                current.delete(input.cwd);
                if (current.size) next.set(instance, current);
                else next.delete(instance);
                return next;
              })
            : Effect.void,
        ),
      );
    });

    // What every client and agent sees: harness defaults, models the provider said are
    // gone, then replaced releases, both filed as legacy.
    const present = (
      providers: ReadonlyArray<ServerProvider>,
      defaults: Parameters<typeof applyHarnessDefaults>[1],
    ) =>
      Effect.gen(function* () {
        const unavailable = yield* Ref.get(unavailableModelsRef);
        const now = yield* Clock.currentTimeMillis;
        return markSupersededModelsLegacy(
          markUnavailableModels(applyHarnessDefaults(providers, defaults), unavailable, now),
        );
      });
    const projectDefaults = (providers: ReadonlyArray<ServerProvider>) =>
      harnessDefaults.get.pipe(Effect.flatMap((defaults) => present(providers, defaults)));
    return {
      getProviders: Ref.get(providersRef).pipe(Effect.flatMap(projectDefaults)),
      getProvidersForUsageLimits: (instances) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const providers = yield* Ref.get(providersRef);
          const stale = providers.filter(
            (provider) =>
              provider.enabled &&
              (instances === undefined ||
                (typeof instances === "string"
                  ? instances === provider.instanceId
                  : instances.includes(provider.instanceId))) &&
              provider.usageLimits !== undefined &&
              !provider.refreshing &&
              isUsageLimitReadingStale(provider.driver, provider.usageLimits, now) &&
              // A probe that keeps failing leaves the reading stale: do not start one per call.
              now - (usageLimitProbedAt.get(provider.instanceId) ?? Number.NEGATIVE_INFINITY) >=
                60_000,
          );
          for (const provider of stale) usageLimitProbedAt.set(provider.instanceId, now);
          // Probes belong to the registry's scope. Timing out the caller's wait must not
          // wait for an uninterruptible driver or discard a result that arrives just after it.
          const probes = yield* Effect.forEach(
            stale,
            (provider) =>
              refreshInstance(provider.instanceId).pipe(
                Effect.catchCause(recoverRefreshFailure),
                Effect.forkIn(serviceScope),
              ),
            { concurrency: "unbounded" },
          );
          if (probes.length > 0)
            yield* Effect.forEach(probes, Fiber.await, {
              concurrency: "unbounded",
              discard: true,
            }).pipe(Effect.timeoutOption("3 seconds"));
          return yield* Ref.get(providersRef).pipe(Effect.flatMap(projectDefaults));
        }),
      refresh: (provider?: ProviderDriverKind) =>
        refresh(provider).pipe(
          Effect.catchCause(recoverRefreshFailure),
          Effect.flatMap(projectDefaults),
        ),
      refreshInstance: (
        instanceId: ProviderInstanceId,
        options?: { readonly clearOutOfCredit?: boolean },
      ) =>
        refreshInstance(instanceId, options).pipe(
          Effect.catchCause(recoverRefreshFailure),
          Effect.flatMap(projectDefaults),
        ),
      refreshWorkspaceSnapshot: (input) =>
        refreshWorkspaceSnapshot(input).pipe(
          Effect.catchCause(recoverRefreshFailure),
          Effect.flatMap(projectDefaults),
        ),
      getProviderMaintenanceCapabilitiesForInstance,
      setProviderMaintenanceActionState: (input) =>
        setProviderMaintenanceActionState(input).pipe(Effect.flatMap(projectDefaults)),
      setProviderRecentFailure,
      setProviderRecentUse,
      setModelUnavailable,
      recordModelHealthEvent: (event) => Effect.sync(() => modelFailures.record(event)),
      getModelFailures: Clock.currentTimeMillis.pipe(
        Effect.map((now) => modelFailures.snapshot(now)),
      ),
      get streamChanges() {
        return Stream.merge(
          Stream.fromPubSub(changesPubSub).pipe(Stream.mapEffect(projectDefaults)),
          harnessDefaults.subscribe().pipe(
            Stream.drop(1),
            Stream.mapEffect((defaults) =>
              Ref.get(providersRef).pipe(
                Effect.flatMap((providers) => present(providers, defaults)),
              ),
            ),
          ),
        );
      },
    } satisfies ProviderRegistry["Service"];
  }),
).pipe(Layer.provide(HarnessDefaultsService.layer));
