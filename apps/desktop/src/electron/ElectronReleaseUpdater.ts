/**
 * The ElectronUpdater service backed by SSHCode's release updater (updates/ReleaseDmgUpdater.ts)
 * instead of electron-updater. Packaged Mac builds use it: their releases are ad hoc signed, which
 * Squirrel.Mac can't install. Settings electron-updater needs (channel, differential downloads)
 * have no meaning here and are accepted as no-ops.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  createReleaseDmgUpdater,
  ReleaseUpdateError,
  runCommand,
  spawnDetached,
} from "../updates/ReleaseDmgUpdater.ts";
import {
  ElectronUpdater,
  ElectronUpdaterCheckForUpdatesError,
  ElectronUpdaterDownloadUpdateError,
  ElectronUpdaterQuitAndInstallError,
} from "./ElectronUpdater.ts";

const reason = (cause: unknown) =>
  cause instanceof ReleaseUpdateError ? cause.message : undefined;

/** @public Built for tests with injected dependencies; the app uses `layer`. */
export const makeWith = (updater: ReturnType<typeof createReleaseDmgUpdater>) => {
  let allowDowngrade = false;
  return ElectronUpdater.of({
    setFeedURL: () => Effect.void,
    setAutoDownload: () => Effect.void,
    setAutoInstallOnAppQuit: () => Effect.void,
    setChannel: () => Effect.void,
    setAllowPrerelease: () => Effect.void,
    allowDowngrade: Effect.sync(() => allowDowngrade),
    setAllowDowngrade: (value) =>
      Effect.sync(() => {
        allowDowngrade = value;
      }),
    setFullChangelog: () => Effect.void,
    setDisableDifferentialDownload: () => Effect.void,
    checkForUpdates: Effect.tryPromise({
      try: () => updater.checkForUpdates(),
      catch: (cause) =>
        new ElectronUpdaterCheckForUpdatesError({ channel: null, cause, reason: reason(cause) }),
    }),
    downloadUpdate: Effect.tryPromise({
      try: () => updater.downloadUpdate(),
      catch: (cause) =>
        new ElectronUpdaterDownloadUpdateError({ channel: null, cause, reason: reason(cause) }),
    }),
    quitAndInstall: ({ isSilent, isForceRunAfter }) =>
      Effect.try({
        try: () => updater.quitAndInstall(),
        catch: (cause) =>
          new ElectronUpdaterQuitAndInstallError({
            channel: null,
            isSilent,
            isForceRunAfter,
            cause,
            reason: reason(cause),
          }),
      }),
    on: (eventName, listener) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          updater.on(eventName, listener as unknown as (...args: Array<unknown>) => void),
        ),
        (remove) => Effect.sync(remove),
      ).pipe(Effect.asVoid),
  });
};

export const layer = Layer.effect(
  ElectronUpdater,
  Effect.gen(function* () {
    const arch = yield* HostProcess.Architecture;
    const execPath = Electron.app.getPath("exe");
    // app.asar sits in Contents/Resources, beside electron-builder's app-update.yml.
    const resources = Electron.app.getAppPath().replace(/\/[^/]+$/, "");
    return makeWith(
      createReleaseDmgUpdater({
        fetch: globalThis.fetch,
        run: runCommand,
        spawnDetached,
        quit: () => Electron.app.quit(),
        currentVersion: () => Electron.app.getVersion(),
        arch,
        execPath,
        pid: process.pid,
        appUpdateYmlPath: `${resources}/app-update.yml`,
        updatesDir: () => `${Electron.app.getPath("userData")}/updates`,
      }),
    );
  }),
);
