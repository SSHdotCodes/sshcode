import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { GrokSettings } from "../settings.ts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeGrokTextGeneration } from "./textGeneration.ts";
import { makeGrokXSearch } from "./xSearch.ts";
import { GrokAdapterV2Driver, type GrokAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  enrichGrokSnapshot,
} from "./status.ts";
import { grokUsageReader } from "./usage.ts";
import { readGrokAccount } from "./usageLimits.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { type ProviderDriver, type ProviderInstance } from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import {
  linkGrokHomeToMain,
  makeGrokContinuationGroupKey,
  makeGrokEnvironment,
  resolveGrokHomePath,
} from "./home.ts";
import { discoverGrokSkills } from "./skills.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const decodeGrokInstanceSettings = Schema.decodeUnknownEffect(GrokSettings);

const DRIVER_KIND = ProviderDriverKind.make("grok");
// npm's `latest` tracks Grok's stable channel, the one `grok update` installs
// by default, so the registry stays the source for "latest".
const GROK_NPM_PACKAGE = "@xai-official/grok";
// `grok update` finds the installer that owns the binary itself, so the
// resolved executable is its own updater. It installs under `GROK_HOME`, so it
// runs with the instance's environment. No executable means nothing to update,
// not "whatever is on PATH".
const packageMaintenance = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: GROK_NPM_PACKAGE,
  // Grok ranks the host npx user agent above its native installer marker.
  nativeUpdate: { args: ["update"], env: { npm_config_user_agent: undefined } },
});

const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("resolveGrokMaintenance")(function* (context) {
    const capabilities = yield* packageMaintenance.resolve(context);
    const update = capabilities.update;
    if (context === null || update?.lockKey !== "grok-native") return capabilities;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const name = path.basename(context.realCommandPath).toLowerCase();
    const installDir = path.dirname(context.realCommandPath);
    const installDirName = path.basename(installDir).toLowerCase();
    const home = path.dirname(installDir);
    // `grok update` installs under `$GROK_HOME`, so a script install keeps its own home even if the
    // instance sets another: `<home>/bin/grok` links into `<home>/downloads`, or on Windows is a copy
    // beside it. Only an install script creates `downloads`, so a bare `bin/grok` elsewhere is not one.
    const isScriptInstall =
      (installDirName === "downloads" && name.startsWith("grok-")) ||
      (installDirName === "bin" &&
        (/^grok-\d/.test(name) ||
          ((name === "grok" || name === "grok.exe") &&
            (yield* fileSystem
              .exists(path.join(home, "downloads"))
              .pipe(Effect.orElseSucceed(() => false))))));
    if (!isScriptInstall) return capabilities;
    return { ...capabilities, update: { ...update, env: { ...update.env, GROK_HOME: home } } };
  }),
};

export type GrokDriverEnv =
  | GrokAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const GrokDriver: ProviderDriver<
  GrokSettings,
  GrokDriverEnv,
  Path.Path | FileSystem.FileSystem
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Grok",
    supportsMultipleInstances: true,
  },
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => decodeGrokSettings({}),
  usage: grokUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const { cwd } = host.paths;
      const effectiveConfig = { ...config, enabled } satisfies GrokSettings;
      const baseEnv = yield* mergeProviderInstanceEnvironment(environment);
      yield* linkGrokHomeToMain(effectiveConfig, baseEnv);
      const processEnv = yield* makeGrokEnvironment(effectiveConfig, baseEnv);
      const settings = yield* host.settings.get.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to read Grok continuation settings.",
              cause,
            }),
        ),
      );
      const homes = yield* Effect.forEach(
        Object.entries(settings.providerInstances).filter(
          ([, entry]) => entry.driver === DRIVER_KIND,
        ),
        ([id, entry]) =>
          Effect.gen(function* () {
            if (id === instanceId) return [{ instanceId, homePath: processEnv.GROK_HOME }];
            const peerConfig = yield* decodeGrokInstanceSettings(entry.config ?? {}).pipe(
              Effect.orElseSucceed(() => undefined),
            );
            if (peerConfig === undefined) return [];
            const peerEnv = yield* mergeProviderInstanceEnvironment(entry.environment);
            return [
              {
                instanceId: ProviderInstanceId.make(id),
                homePath: yield* resolveGrokHomePath(peerConfig, peerEnv),
              },
            ];
          }),
      );
      const instanceHomes = homes.flat();
      if (!instanceHomes.some((home) => home.instanceId === instanceId)) {
        instanceHomes.push({ instanceId, homePath: processEnv.GROK_HOME });
      }
      const continuationIdentity = {
        driverKind: DRIVER_KIND,
        continuationKey: yield* makeGrokContinuationGroupKey({
          instanceId,
          homePath: processEnv.GROK_HOME,
          instances: instanceHomes,
        }),
      };
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
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
      const orchestrationAdapter = yield* GrokAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Grok orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeGrokTextGeneration(effectiveConfig, processEnv);
      const searchX = yield* makeGrokXSearch({
        grokSettings: effectiveConfig,
        environment: processEnv,
        cwd: path.join(host.paths.stateDir, "x-search"),
        homeDirectory:
          processEnv.HOME || processEnv.USERPROFILE || (yield* HostProcess.HomeDirectory),
      });

      const checkProvider = checkGrokProviderStatus(effectiveConfig, processEnv, cwd).pipe(
        Effect.flatMap((snapshot) =>
          effectiveConfig.enabled && snapshot.installed && snapshot.auth.status === "authenticated"
            ? readGrokAccount(processEnv).pipe(
                Effect.map(({ email, usageLimits }) => ({
                  ...snapshot,
                  auth: email ? { ...snapshot.auth, email } : snapshot.auth,
                  usageLimits,
                })),
              )
            : Effect.succeed(snapshot),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GrokSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialGrokProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichGrokSnapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Grok snapshot.",
              cause,
            }),
        ),
      );
      const snapshotForCwd = (workspaceCwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              discoverGrokSkills(effectiveConfig, processEnv, workspaceCwd).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
                Effect.mapError(
                  (cause) =>
                    new ProviderDriverError({
                      driver: DRIVER_KIND,
                      instanceId,
                      detail: `Failed to discover Grok skills for '${workspaceCwd}'`,
                      cause,
                    }),
                ),
              ),
            ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })));

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        orchestrationAdapter,
        textGeneration,
        ...(enabled
          ? {
              xSearch: (query: string) =>
                searchX(query).pipe(
                  Effect.mapError(
                    (error) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId,
                        detail: error.detail,
                        cause: error,
                      }),
                  ),
                ),
            }
          : {}),
      } satisfies ProviderInstance;
    }),
};
