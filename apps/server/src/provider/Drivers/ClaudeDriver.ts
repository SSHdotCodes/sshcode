/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import { claudeUsageReader } from "./claudeUsage.ts";
import { makeClaudeScopedLimitNames } from "../claudeUsageLimits.ts";
import * as ClaudeResetCredits from "../claudeResetCredits.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkClaudeProviderStatus,
  makeClaudeVersionReader,
  makeClaudeWorkspaceSnapshots,
  makePendingClaudeProvider,
  probeClaudeCapabilitiesWithFallbackToken,
  probeClaudeCapabilitiesWithToken,
} from "../ClaudeProvider.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import { resolveClaudeModelCatalog } from "../ClaudeModelCatalog.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { limitsOnSavedToken, makeClaudeLoginFallback, splitClaudeToken } from "./ClaudeLogin.ts";
import { readClaudeLogin } from "../claudeLoginExpiry.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  claudeSignInCommand,
  makeClaudeCapabilitiesCacheKey,
  linkClaudeHomeToMain,
  makeClaudeContinuationGroupKey,
  makeClaudeEnvironment,
  resolveClaudeHomePath,
} from "./ClaudeHome.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const CLAUDE_NATIVE_LATEST_URL =
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/latest";

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
    // The channel `claude update` installs from, as Claude Code's install script reads it.
    latestVersionUrl: CLAUDE_NATIVE_LATEST_URL,
  },
});

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

/** Whether the instance sends Claude Code to an endpoint other than Anthropic's. */
function usesOtherAnthropicEndpoint(
  environment: ReadonlyArray<{ readonly name: string; readonly value: string }> | undefined,
): boolean {
  const base = environment
    ?.find((variable) => variable.name === "ANTHROPIC_BASE_URL")
    ?.value.trim();
  if (!base) return false;
  try {
    return new URL(base).hostname !== "api.anthropic.com";
  } catch {
    return false;
  }
}

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  usage: claudeUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Instance-level probes are not tied to a project, so they run in the
      // server's own state dir. The server cwd is $HOME in packaged desktop
      // builds, and `claude` wrappers that scope themselves to their cwd refuse
      // to run there. Workspace probes use the thread cwd via `snapshotForCwd`.
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const catalogService = yield* ModelCatalog.ModelCatalog;
      const modelCatalog = catalogService
        .current(DRIVER_KIND)
        .pipe(Effect.map(resolveClaudeModelCatalog));
      // The regular login comes first; a saved token waits as the fallback.
      const { environment: processEnv, token: fallbackToken } = splitClaudeToken(
        yield* mergeProviderInstanceEnvironment(environment),
      );
      // Claude Code names its stored login after CLAUDE_CONFIG_DIR, as its processes see it.
      const credentialsDir =
        (yield* makeClaudeEnvironment(config, processEnv)).CLAUDE_CONFIG_DIR?.trim() || undefined;
      const signInCommand = claudeSignInCommand(credentialsDir, yield* HostProcess.Platform);
      // "Always use the saved token": the instance runs on its token's account
      // from the first process and never goes back to this computer's login, so a
      // second subscription can share the first one's Claude folder and chats.
      const ownToken = config.alwaysUseToken ? fallbackToken : undefined;
      const login =
        fallbackToken === undefined
          ? undefined
          : yield* makeClaudeLoginFallback(
              fallbackToken,
              ownToken !== undefined
                ? Effect.succeed(undefined)
                : readClaudeLogin(credentialsDir).pipe(
                    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                    Effect.provideService(FileSystem.FileSystem, fileSystem),
                    Effect.provideService(Path.Path, path),
                  ),
            );
      const launchEnvironment = (base: NodeJS.ProcessEnv) =>
        login === undefined ? Effect.succeed(base) : login.environment(base);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      } satisfies ClaudeSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      // Before the key below: a linked folder continues the main folder's chats.
      yield* linkClaudeHomeToMain(effectiveConfig, processEnv).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(
        effectiveConfig,
        processEnv,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const configDir = yield* resolveClaudeHomePath(effectiveConfig, processEnv);
      const accountConfigPath = yield* ClaudeResetCredits.claudeAccountConfigPath(
        effectiveConfig.homePath.trim() || processEnv.CLAUDE_CONFIG_DIR?.trim()
          ? configDir
          : undefined,
      );
      const identity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey,
      });
      // An instance on another endpoint (another vendor's Anthropic route)
      // offers only the models that endpoint serves: Claude's would fail there.
      const ownModelsOnly = usesOtherAnthropicEndpoint(environment);
      const stampIdentity = (draft: Parameters<typeof identity>[0]) => {
        const provider = identity(draft);
        return ownModelsOnly
          ? {
              ...provider,
              models: provider.models
                .filter((model) => model.isCustom)
                .map((model) => ({ ...model, isCustom: false })),
            }
          : provider;
      };

      const scopedLimitNames = yield* makeClaudeScopedLimitNames;
      const orchestrationAdapter = yield* createClaudeAdapterV2(
        {
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        },
        {
          scopedLimitNames,
          onUsageLimits: (update) => snapshot.applyUsageLimits(update),
          launchEnvironment,
        },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Claude orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog,
        launchEnvironment,
      );
      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      const capabilitiesProbeCache = yield* Cache.make({
        capacity: 1,
        timeToLive: CAPABILITIES_PROBE_TTL,
        lookup: () =>
          (ownToken !== undefined
            ? probeClaudeCapabilitiesWithToken(effectiveConfig, processEnv, ownToken, stateDir)
            : Effect.all([
                probeClaudeCapabilitiesWithFallbackToken(
                  effectiveConfig,
                  processEnv,
                  fallbackToken,
                  stateDir,
                ),
                ClaudeResetCredits.readClaudeOrganizationId(accountConfigPath),
              ]).pipe(
                Effect.map(([capabilities, workspaceId]) =>
                  capabilities && workspaceId ? { ...capabilities, workspaceId } : capabilities,
                ),
              )
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
      });
      const readClaudeVersion = yield* makeClaudeVersionReader();
      const workspaceSnapshots = yield* makeClaudeWorkspaceSnapshots(
        effectiveConfig,
        processEnv,
      ).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
        effectiveConfig,
        stateDir,
        processEnv,
      );

      // Start the TTL-gated refresh without delaying provider readiness. The
      // next check observes a remote manifest after the background fetch lands.
      const checkProvider = catalogService.refreshInBackground.pipe(
        Effect.andThen(
          modelCatalog.pipe(
            Effect.flatMap((catalog) =>
              checkClaudeProviderStatus(
                effectiveConfig,
                () => Cache.get(capabilitiesProbeCache, capabilitiesCacheKey),
                processEnv,
                stateDir,
                catalog,
                scopedLimitNames,
                // Banked resets are read with the stored login: another account's here.
                ownToken !== undefined
                  ? undefined
                  : (version) =>
                      ClaudeResetCredits.readClaudeResetCredits(configDir, version).pipe(
                        Effect.provideService(HttpClient.HttpClient, httpClient),
                        Effect.provideService(FileSystem.FileSystem, fileSystem),
                        Effect.provideService(Path.Path, path),
                      ),
                readClaudeVersion,
              ),
            ),
            Effect.map(stampIdentity),
            // On the saved token the login's limits cannot be read: say why.
            Effect.flatMap((provider) =>
              login === undefined || ownToken !== undefined
                ? Effect.succeed(provider)
                : login.usingToken.pipe(
                    Effect.map((usingToken) => {
                      const usageLimits = usingToken
                        ? limitsOnSavedToken(provider.usageLimits, signInCommand)
                        : provider.usageLimits;
                      return usageLimits === provider.usageLimits
                        ? provider
                        : { ...provider, usageLimits };
                    }),
                  ),
            ),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          modelCatalog.pipe(
            Effect.flatMap((catalog) => makePendingClaudeProvider(settings.provider, catalog)),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // Same rules as Codex: serialised on the config directory that holds the
      // login, one request id kept until Claude answers (a cooldown or rate
      // limit is an answer), then a re-probe.
      const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
        Effect.gen(function* () {
          const current = yield* snapshot.getSnapshot;
          const grantId = current.usageLimits?.resetCredits?.nextCreditId;
          if (!grantId || !current.version) return "noCredit" as const;
          const version = current.version;
          return yield* resetCreditCoordinator.redeem(
            configDir,
            (requestId) =>
              ClaudeResetCredits.consumeClaudeResetCredit({
                configDir,
                accountConfigPath,
                version,
                grantId,
                requestId,
              }),
            ClaudeResetCredits.isSettledClaudeResetCreditFailure,
          );
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER_KIND,
                instanceId,
                detail:
                  cause._tag === "ClaudeResetCreditError"
                    ? cause.message
                    : "Claude could not redeem the reset.",
                cause,
              }),
          ),
          // Re-probe after any answer, but only a reset claims the limits
          // changed, so only a reset reports an unconfirmed refresh.
          Effect.tap((outcome) =>
            Effect.gen(function* () {
              const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
              yield* Cache.invalidateAll(capabilitiesProbeCache);
              const refreshed = yield* snapshot.refresh;
              const after = refreshed.usageLimits?.checkedAt;
              if (
                outcome === "reset" &&
                (after === undefined ||
                  after === before ||
                  refreshed.usageLimits?.unavailable?.reason === "probeFailed")
              ) {
                return yield* new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail:
                    "The reset was applied, but Claude could not confirm the new limits. Refresh to check.",
                });
              }
            }),
          ),
        );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        invalidateCaches: Cache.invalidateAll(capabilitiesProbeCache).pipe(
          Effect.andThen(workspaceSnapshots.invalidate),
        ),
        snapshotForCwd: (cwd: string) =>
          snapshot.getSnapshot.pipe(
            Effect.flatMap((machineSnapshot) => workspaceSnapshots.snapshot(machineSnapshot, cwd)),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        // An instance on its own token has no login to sign in again: its token is what fails.
        ...(ownToken !== undefined ? {} : { signInCommand }),
        // An instance on its own token has no login to fall back from or return to.
        ...(login === undefined || ownToken !== undefined
          ? {}
          : {
              loginFallback: {
                usingFallback: login.usingToken,
                useFallback: login.useToken,
                useLogin: login.useLogin,
                loginRenewed: login.loginRenewed,
              },
            }),
        orchestrationAdapter,
        textGeneration,
        consumeResetCredit,
      } satisfies ProviderInstance;
    }),
};
