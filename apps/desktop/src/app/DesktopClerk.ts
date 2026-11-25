import { createClerkBridge } from "@clerk/electron";
import * as NodeURL from "node:url";
import { storage } from "@clerk/electron/storage";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import { codexAuthDeliveryUrl, readCodexAuthHandoff } from "@t3tools/shared/codexAuthHandoff";
import { desktopLinkScheme } from "@t3tools/shared/desktopLinkScheme";
import { receiveCodexAuthCallback, CodexAuthCallbackError } from "./CodexAuthCallback.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import { providerAuthReturnUrl } from "@t3tools/shared/providerAuthReturnUrl";
import { promptLinkAppPath } from "@t3tools/shared/promptLinks";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { clerkFrontendApiHostnameFromPublishableKey } from "@t3tools/shared/relayAuth";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronProtocol from "../electron/ElectronProtocol.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopUserData from "./DesktopUserData.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { openClerkTokenStorage } from "./ClerkTokenStore.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

declare const __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__: string | undefined;

export class DesktopClerkBridgeInitializationError extends Schema.TaggedError<DesktopClerkBridgeInitializationError>()(
  "DesktopClerkBridgeInitializationError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to initialize the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerkBridgeCleanupError extends Schema.TaggedError<DesktopClerkBridgeCleanupError>()(
  "DesktopClerkBridgeCleanupError",
  {
    stateDir: Schema.String,
    isDevelopment: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to clean up the desktop Clerk bridge for state directory "${this.stateDir}" (development: ${this.isDevelopment}).`;
  }
}

export class DesktopClerk extends Context.Service<
  DesktopClerk,
  {
    readonly configure: Effect.Effect<
      void,
      never,
      | ElectronApp.ElectronApp
      | ElectronWindow.ElectronWindow
      | DesktopWindow.DesktopWindow
      | DesktopState.DesktopState
      | DesktopWebLinks.DesktopWebLinks
      | Scope.Scope
    >;
  }
>()("@t3tools/desktop/app/DesktopClerk") {}

export function resolveDesktopClerkFrontendApiHostname(
  publishableKey: string | undefined,
): string | undefined {
  const normalizedKey = publishableKey?.trim();
  if (!normalizedKey) return undefined;

  try {
    return clerkFrontendApiHostnameFromPublishableKey(normalizedKey);
  } catch {
    return undefined;
  }
}

export const desktopClerkFrontendApiHostname = resolveDesktopClerkFrontendApiHostname(
  typeof __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__ === "undefined"
    ? undefined
    : __T3CODE_BUILD_CLERK_PUBLISHABLE_KEY__,
);

// Clerk's OAuth transport calls `app.setAsDefaultProtocolClient(renderer.scheme)` at every launch
// and expects its callback on `t3code://app/` (T3's Clerk dashboard rejects `sshcode://` and
// loopback redirect URLs). The shareable app must never claim `t3code` at the OS level, and
// ad-hoc signing cannot hold macOS passkey entitlements, so the bridge keeps only token storage
// for in-window sign-in (email + password / email code).
function createDesktopClerkBridge(stateDir: string, userDataPath: string) {
  return createClerkBridge({
    storage: openClerkTokenStorage(
      stateDir,
      (directory) => storage({ path: directory }),
      userDataPath,
    ),
    passkeys: false,
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronApp = yield* ElectronApp.ElectronApp;
  const shell = yield* ElectronShell.ElectronShell;

  // Must not yield before ready: userData must be set before the single-instance lock and
  // GPU cache cleanup run.
  const userDataPath = yield* DesktopUserData.resolveUserDataPath(environment);
  yield* electronApp.setPath("userData", userDataPath);
  // Chromium opens GPU caches at the first event-loop turn, before ready.
  yield* DesktopUserData.clearStaleGpuCaches({
    userDataPath,
    electronVersion: process.versions.electron,
  });

  const bridge = yield* Effect.acquireRelease(
    Effect.try({
      try: () => createDesktopClerkBridge(environment.stateDir, userDataPath),
      catch: (cause) =>
        new DesktopClerkBridgeInitializationError({
          stateDir: environment.stateDir,
          isDevelopment: environment.isDevelopment,
          cause,
        }),
    }),
    (bridge) =>
      Effect.try({
        try: () => bridge.cleanup(),
        catch: (cause) =>
          new DesktopClerkBridgeCleanupError({
            stateDir: environment.stateDir,
            isDevelopment: environment.isDevelopment,
            cause,
          }),
      }).pipe(Effect.orDie),
  );
  // Without Clerk's OAuth transport the app holds the single-instance lock itself, so on Windows
  // and Linux a second launch's links still reach this instance. macOS keeps one instance per app.
  const isPrimaryInstance =
    bridge.isPrimaryInstance &&
    (environment.platform === "darwin" || (yield* electronApp.requestSingleInstanceLock));

  return DesktopClerk.of({
    configure: Effect.gen(function* () {
      const electronApp = yield* ElectronApp.ElectronApp;
      const electronWindow = yield* ElectronWindow.ElectronWindow;
      const desktopWindow = yield* DesktopWindow.DesktopWindow;
      const desktopState = yield* DesktopState.DesktopState;
      const webLinks = yield* DesktopWebLinks.DesktopWebLinks;
      const context = yield* Effect.context<
        | ElectronApp.ElectronApp
        | ElectronWindow.ElectronWindow
        | DesktopWindow.DesktopWindow
        | DesktopState.DesktopState
      >();
      const runPromise = Effect.runPromiseWith(context);

      // The single-instance lock (taken at bridge creation) forwards deep links
      // on Windows/Linux to the running app. A secondary instance may already
      // have begun quitting; app.quit() is asynchronous, so stop bootstrap here
      // before whenReady can fire.
      if (!isPrimaryInstance) {
        yield* electronApp.quit;
        return yield* Effect.interrupt;
      }

      // Pre-ready open-url/open-file events arrive on cold launch before bootstrap
      // opens the initial window; defer window activation until Electron is ready.
      let appReady = false;
      yield* electronApp.whenReady.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            appReady = true;
          }),
        ),
        Effect.ignoreCause,
        Effect.forkScoped,
      );

      const startProviderAuthHandoff = (value: string | undefined) => {
        if (!value) return false;
        const request = readCodexAuthHandoff(value, environment.isDevelopment);
        if (!request) return false;
        void runPromise(
          Effect.gen(function* () {
            yield* electronApp.whenReady;
            yield* Effect.tryPromise({
              try: () =>
                receiveCodexAuthCallback(
                  request.authorizationUrl,
                  (url) => runPromise(shell.openExternal(url)),
                  (callbackUrl) => codexAuthDeliveryUrl(request, callbackUrl),
                ),
              catch: () =>
                new CodexAuthCallbackError({
                  detail:
                    "Could not receive hosted web ChatGPT sign-in. Retry or use the redirect URL in the web app.",
                }),
            });
          }).pipe(
            Effect.catch(() => Effect.logWarning("Could not complete ChatGPT desktop handoff.")),
          ),
        );
        return true;
      };
      // A browser comes back from provider sign-in on the link scheme (`sshcode://app/…`); the
      // window loads the same page from the renderer's own origin.
      const resumeProviderAuth = (value: string | undefined) => {
        const destination = providerAuthReturnUrl(value);
        const linkOrigin = `${desktopLinkScheme(environment.isDevelopment)}://${ElectronProtocol.DESKTOP_HOST}/`;
        if (!destination?.startsWith(linkOrigin)) return false;
        const page = `${ElectronProtocol.getDesktopUrl(environment.isDevelopment)}${destination.slice(linkOrigin.length)}`;
        void runPromise(
          Effect.gen(function* () {
            let mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isNone(mainWindow)) {
              if (yield* Ref.get(desktopState.quitting)) return;
              yield* electronApp.whenReady;
              yield* desktopWindow.activate;
              mainWindow = yield* electronWindow.currentMainOrFirst;
            }
            if (Option.isNone(mainWindow)) return;
            yield* Effect.promise(() => mainWindow.value.loadURL(page));
            yield* electronWindow.reveal(mainWindow.value);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not return to provider setup", cause),
            ),
          ),
        );
        return true;
      };
      // Prompt links and thread links (`sshcode://new?…`, `sshcode://threads/…`) reach the
      // renderer through the same queue as web links; it routes them in the app.
      const openAppLink = (value: string | undefined, activate: boolean) => {
        if (!value || promptLinkAppPath(value) === null) return false;
        void runPromise(webLinks.receive(value, { activate }));
        return true;
      };
      const args = yield* HostProcess.Arguments;
      args.some((value) => startProviderAuthHandoff(value) || openAppLink(value, false));
      // As the default browser, macOS hands SSHCode every web link through the same event.
      const openWebLink = (url: string, activate: boolean) => {
        if (!DesktopWebLinks.isWebLink(url)) return false;
        void runPromise(webLinks.receive(url, { activate }));
        return true;
      };
      yield* electronApp.on("open-url", (event: { preventDefault: () => void }, url: string) => {
        if (
          startProviderAuthHandoff(url) ||
          resumeProviderAuth(url) ||
          openWebLink(url, appReady) ||
          openAppLink(url, appReady)
        )
          event.preventDefault();
      });
      // A browser opens HTML files too, which macOS hands over by path.
      yield* electronApp.on("open-file", (event: { preventDefault: () => void }, path: string) => {
        if (!DesktopWebLinks.isWebPageFile(path)) return;
        event.preventDefault();
        void runPromise(webLinks.receive(NodeURL.pathToFileURL(path).href, { activate: appReady }));
      });
      yield* electronApp.on("second-instance", (_event: unknown, argv: readonly string[]) => {
        if (
          argv?.some(
            (value) =>
              startProviderAuthHandoff(value) ||
              resumeProviderAuth(value) ||
              openWebLink(value, true) ||
              openAppLink(value, true),
          )
        )
          return;
        void runPromise(
          Effect.gen(function* () {
            const mainWindow = yield* electronWindow.currentMainOrFirst;
            if (Option.isSome(mainWindow)) {
              yield* electronWindow.reveal(mainWindow.value);
              return;
            }
            if (yield* Ref.get(desktopState.quitting)) return;
            yield* electronApp.whenReady;
            yield* desktopWindow.activate;
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not reopen the desktop window on second launch", cause),
            ),
          ),
        );
      });
    }).pipe(Effect.withSpan("desktop.clerk.configure")),
  });
});

export const layer = Layer.effect(DesktopClerk, make);
