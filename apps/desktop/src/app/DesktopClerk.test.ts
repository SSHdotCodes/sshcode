// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off - Hosted handoff test uses a real localhost listener without an OpenAI account.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePathLayer from "@effect/platform-node/NodePath";
import { codexAuthHandoffUrl, readCodexAuthDelivery } from "@t3tools/shared/codexAuthHandoff";
import { promptLinkDeepLink } from "@t3tools/shared/promptLinks";
import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeEach, vi } from "vite-plus/test";

const clerkStateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-clerk-"));
afterAll(() => {
  NodeFS.rmSync(clerkStateDir, { recursive: true, force: true });
});

const { createClerkBridgeMock, storageAdapter, storageMock } = vi.hoisted(() => ({
  createClerkBridgeMock: vi.fn(),
  storageAdapter: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
  },
  storageMock: vi.fn(),
}));

vi.mock("@clerk/electron", () => ({
  createClerkBridge: createClerkBridgeMock,
}));

vi.mock("@clerk/electron/storage", () => ({
  storage: storageMock,
}));

import * as Option from "effect/Option";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronShell from "../electron/ElectronShell.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopClerk from "./DesktopClerk.ts";
import * as DesktopWebLinks from "./DesktopWebLinks.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopPreReadyFileSystem from "./DesktopPreReadyFileSystem.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

/** Clerk forwards web links; tests that are not about links ignore them. */
const ignoreWebLinks = DesktopWebLinks.DesktopWebLinks.of({
  receive: () => Effect.void,
  setRendererReady: () => Effect.void,
});

const ignoreDesktopWindow = DesktopWindow.DesktopWindow.of({
  activate: Effect.void,
} as unknown as DesktopWindow.DesktopWindow["Service"]);

const layerDesktopClerk = (
  isDevelopment = true,
  events: string[] = [],
  platform: NodeJS.Platform = "darwin",
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = FileSystem.layerNoop({
    exists: () => Effect.succeed(false),
  }),
  shell: ElectronShell.ElectronShell["Service"] = {
    openExternal: () => Effect.succeed(true),
    openSystemSettings: () => Effect.succeed(false),
    copyText: () => Effect.void,
  },
  /** Whether no other instance holds the single-instance lock. */
  lockAvailable = true,
) => {
  const environment = DesktopEnvironment.DesktopEnvironment.of({
    stateDir: clerkStateDir,
    isDevelopment,
    appDataDirectory: "/tmp/app-data",
    platform,
  } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

  const electronApp = {
    setPath: (name: string, value: string) =>
      Effect.sync(() => {
        events.push(`setPath:${name}:${value}`);
      }),
    requestSingleInstanceLock: Effect.sync(() => {
      events.push("requestSingleInstanceLock");
      return lockAvailable;
    }),
  } as unknown as ElectronApp.ElectronApp["Service"];

  return DesktopClerk.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodePathLayer.layerPosix,
        Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
        Layer.succeed(ElectronApp.ElectronApp, electronApp),
        Layer.succeed(ElectronShell.ElectronShell, shell),
        fileSystemLayer,
      ),
    ),
  );
};

describe("DesktopClerk", () => {
  beforeEach(() => {
    createClerkBridgeMock.mockReset();
    storageMock.mockReset();
  });

  it.effect("acquires and releases the SDK bridge with the layer", () => {
    const cleanup = vi.fn();
    const events: string[] = [];
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementation(() => {
      events.push("createClerkBridge");
      return { cleanup, isPrimaryInstance: true };
    });

    return Effect.gen(function* () {
      yield* Effect.scoped(Layer.build(layerDesktopClerk(true, events)));

      assert.lengthOf(createClerkBridgeMock.mock.calls, 1);
      // Storage is the owner-only wrapper around the adapter, checked below. The shareable build
      // never passes `renderer` (which would call `setAsDefaultProtocolClient("t3code")` on every
      // launch) and leaves native passkeys off (ad-hoc signing cannot hold passkey entitlements).
      const { storage: _storage, ...options } = createClerkBridgeMock.mock.calls[0]?.[0] ?? {};
      assert.deepEqual(options, { passkeys: false });
      assert.isUndefined(options.renderer);
      assert.equal(cleanup.mock.calls.length, 1);
      // The bridge acquires Electron's single-instance lock at creation, and
      // the lock both lives in and creates the userData directory — so the
      // real path must be set before the bridge exists.
      assert.deepEqual(events, ["setPath:userData:/tmp/app-data/t3code-dev", "createClerkBridge"]);
      storageMock.mockClear();
      createClerkBridgeMock.mockClear();
    });
  });

  it("derives the Clerk Frontend API hostname for CSP without enabling the OAuth renderer scheme", () => {
    // pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA== encodes "clerk.example.test$".
    assert.strictEqual(
      DesktopClerk.resolveDesktopClerkFrontendApiHostname("pk_test_Y2xlcmsuZXhhbXBsZS50ZXN0JA=="),
      "clerk.example.test",
    );
    assert.isUndefined(DesktopClerk.resolveDesktopClerkFrontendApiHostname(""));
    assert.isUndefined(DesktopClerk.resolveDesktopClerkFrontendApiHostname(undefined));
  });

  it.effect("never calls setAsDefaultProtocolClient when initializing the Clerk bridge", () => {
    const setAsDefaultProtocolClient = vi.fn((_protocol: string) => true);
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });

    const environment = DesktopEnvironment.DesktopEnvironment.of({
      stateDir: clerkStateDir,
      isDevelopment: false,
      appDataDirectory: "/tmp/app-data",
      platform: "darwin",
    } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]);

    const electronApp = {
      whenReady: Effect.void,
      setPath: () => Effect.void,
      requestSingleInstanceLock: Effect.succeed(true),
      setAsDefaultProtocolClient: (protocol: string) =>
        Effect.sync(() => setAsDefaultProtocolClient(protocol)),
      on: () => Effect.void,
      quit: Effect.void,
    } as unknown as ElectronApp.ElectronApp["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;

      assert.lengthOf(createClerkBridgeMock.mock.calls, 1);
      assert.isUndefined(createClerkBridgeMock.mock.calls[0]?.[0]?.renderer);
      assert.strictEqual(createClerkBridgeMock.mock.calls[0]?.[0]?.passkeys, false);
      assert.equal(setAsDefaultProtocolClient.mock.calls.length, 0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        DesktopClerk.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodePathLayer.layerPosix,
              Layer.succeed(DesktopEnvironment.DesktopEnvironment, environment),
              Layer.succeed(ElectronApp.ElectronApp, electronApp),
              Layer.succeed(ElectronShell.ElectronShell, {
                openExternal: () => Effect.succeed(true),
                openSystemSettings: () => Effect.succeed(false),
                copyText: () => Effect.void,
              }),
              FileSystem.layerNoop({ exists: () => Effect.succeed(false) }),
            ),
          ),
        ),
      ),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(DesktopWindow.DesktopWindow, ignoreDesktopWindow),
      Effect.provide(DesktopState.layer),
      Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
    );
  });

  it.each([
    {
      name: "packaged SSHCode on macOS",
      isDevelopment: false,
      platform: "darwin" as const,
      userData: "/tmp/app-data/sshcode-shared",
    },
    {
      name: "packaged Windows",
      isDevelopment: false,
      platform: "win32" as const,
      userData: "/tmp/app-data/sshcode-shared",
    },
    {
      name: "development",
      isDevelopment: true,
      platform: "win32" as const,
      userData: "/tmp/app-data/t3code-dev",
    },
  ])(
    "creates the bridge before startup can yield to the event loop ($name)",
    ({ isDevelopment, platform, userData }) => {
      const events: string[] = [];
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockImplementation(() => {
        events.push("createClerkBridge");
        return { cleanup: vi.fn(), isPrimaryInstance: true };
      });
      // runSync throws if the layer ever suspends, which would let Electron emit
      // ready before the bridge exists. main.ts provides the same FileSystem.
      // oxlint-disable-next-line t3code/no-manual-effect-runtime-in-tests -- The assertion IS that the layer builds synchronously; it.effect would mask a regression to async.
      Effect.runSync(
        Effect.scoped(
          Layer.build(
            layerDesktopClerk(isDevelopment, events, platform, DesktopPreReadyFileSystem.layer),
          ),
        ),
      );

      // Without Clerk's transport the app takes the single-instance lock itself on Windows.
      assert.deepEqual(events, [
        `setPath:userData:${userData}`,
        "createClerkBridge",
        ...(platform === "darwin" ? [] : ["requestSingleInstanceLock"]),
      ]);
      assert.deepEqual(storageMock.mock.calls, [
        [{ path: NodePath.join(NodePath.resolve(clerkStateDir), "clerk") }],
      ]);
      assert.notStrictEqual(createClerkBridgeMock.mock.calls[0]?.[0]?.storage, storageAdapter);
    },
  );

  it.effect("preserves bridge initialization failures", () => {
    const cause = new Error("bridge initialization failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockImplementationOnce(() => {
      throw cause;
    });

    return Effect.gen(function* () {
      const error = yield* Effect.scoped(Layer.build(layerDesktopClerk())).pipe(Effect.flip);

      assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeInitializationError);
      assert.equal(error.stateDir, clerkStateDir);
      assert.equal(error.isDevelopment, true);
      assert.strictEqual(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to initialize the desktop Clerk bridge for state directory "${clerkStateDir}" (development: true).`,
      );
    });
  });

  it.effect("preserves bridge cleanup failures", () => {
    const cause = new Error("bridge cleanup failed");
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({
      cleanup: () => {
        throw cause;
      },
    });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(Effect.scoped(Layer.build(layerDesktopClerk(false))));

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, DesktopClerk.DesktopClerkBridgeCleanupError);
        assert.equal(error.stateDir, clerkStateDir);
        assert.equal(error.isDevelopment, false);
        assert.strictEqual(error.cause, cause);
        assert.equal(
          error.message,
          `Failed to clean up the desktop Clerk bridge for state directory "${clerkStateDir}" (development: false).`,
        );
      }
    });
  });

  it.effect("registers the second-instance handler in the primary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      whenReady: Effect.void,
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(quit.mock.calls.length, 0);
      assert.deepEqual(registeredEvents, ["open-url", "open-file", "second-instance"]);
    }).pipe(
      Effect.provide(layerDesktopClerk()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, ignoreDesktopWindow),
      Effect.provide(DesktopState.layer),
      Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
    );
  });

  it.effect("quits a second Windows launch when another instance holds the lock", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      whenReady: Effect.void,
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
    }).pipe(
      Effect.provide(layerDesktopClerk(false, [], "win32", undefined, undefined, false)),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(DesktopWindow.DesktopWindow, ignoreDesktopWindow),
      Effect.provide(DesktopState.layer),
      Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
    );
  });

  it.effect("quits and interrupts startup in a secondary instance", () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: false });
    const quit = vi.fn();
    const registeredEvents: string[] = [];
    const electronApp = {
      whenReady: Effect.void,
      quit: Effect.sync(quit),
      on: (eventName: string) =>
        Effect.sync(() => {
          registeredEvents.push(eventName);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {} as ElectronWindow.ElectronWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      const exit = yield* Effect.exit(Effect.scoped(clerk.configure));

      assert.isTrue(Exit.hasInterrupts(exit));
      assert.equal(quit.mock.calls.length, 1);
      assert.deepEqual(registeredEvents, []);
    }).pipe(
      Effect.provide(layerDesktopClerk()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, ignoreDesktopWindow),
      Effect.provide(DesktopState.layer),
      Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
    );
  });
});

it.effect(
  "provider auth deep links navigate and reveal the running desktop without handling Clerk URLs",
  () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const revealed = Promise.withResolvers<void>();
    const loadURL = vi.fn(async (_url: string) => undefined);
    const window = { loadURL };
    const electronApp = {
      whenReady: Effect.void,
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      currentMainOrFirst: Effect.succeed(Option.some(window)),
      reveal: () => Effect.sync(() => revealed.resolve()),
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const event = { preventDefault: vi.fn() };
      listeners.get("open-url")!(event, "sshcode-dev://app/auth/callback?code=clerk-code");
      listeners.get("open-url")!(event, "sshcode://app/welcome");
      // The renderer's own scheme belongs to SSHCode and the personal SSHCode.
      listeners.get("open-url")!(event, "t3code-dev://app/welcome#agents:machine-id");
      assert.equal(loadURL.mock.calls.length, 0);
      assert.equal(event.preventDefault.mock.calls.length, 0);
      listeners.get("second-instance")!({}, [
        "t3",
        "sshcode-dev://app/settings/providers?instanceId=work&code=never-forward",
      ]);
      yield* Effect.promise(() => revealed.promise);
      // The return link opens the same page from the renderer's origin.
      assert.deepEqual(loadURL.mock.calls, [
        ["t3code-dev://app/settings/providers?instanceId=work"],
      ]);
      listeners.get("open-url")!(event, "sshcode-dev://app/welcome#agents:machine-id");
      assert.equal(event.preventDefault.mock.calls.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopClerk()),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, ignoreDesktopWindow),
      Effect.provide(DesktopState.layer),
      Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
    );
  },
);

it.effect.each(["startup", "open-url"] as const)(
  "receives hosted web sign-in through the desktop %s handler",
  (entry) =>
    Effect.gen(function* () {
      storageMock.mockReturnValue(storageAdapter);
      createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
      const port = yield* Effect.promise(async () => {
        const server = NodeHttp.createServer();
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("address");
        await new Promise<void>((resolve) => server.close(() => resolve()));
        return address.port;
      });
      const authorize = new URL("https://auth.openai.com/api/accounts/authorize");
      authorize.search = new URLSearchParams({
        client_id: "dynamic_agent_client",
        response_type: "code",
        redirect_uri: `http://127.0.0.1:${port}/auth/callback`,
        state: "a".repeat(43),
        code_challenge_method: "S256",
        code_challenge: "b".repeat(43),
      }).toString();
      const request = {
        authorizationUrl: authorize.toString(),
        returnUrl: "https://app.t3.codes/welcome#agents:remote-one",
        environmentId: EnvironmentId.make("remote-one"),
        instanceId: ProviderInstanceId.make("work"),
        flowId: "flow-one",
      };
      const link = codexAuthHandoffUrl(request, true);
      const delivered = Promise.withResolvers<string>();
      const shell = ElectronShell.ElectronShell.of({
        openExternal: (value) =>
          Effect.promise(async () => {
            const url = new URL(String(value));
            const callback = new URL(url.searchParams.get("redirect_uri")!);
            callback.search = new URLSearchParams({
              state: url.searchParams.get("state")!,
              code: "test-code",
              client_id: "oaiapp_test",
            }).toString();
            const response = await fetch(callback, { redirect: "manual" });
            delivered.resolve(response.headers.get("location")!);
            return true;
          }),
        openSystemSettings: () => Effect.succeed(false),
        copyText: () => Effect.void,
      });
      const listeners = new Map<string, (...args: unknown[]) => void>();
      const electronApp = {
        whenReady: Effect.void,
        on: (name: string, listener: (...args: unknown[]) => void) =>
          Effect.sync(() => {
            listeners.set(name, listener);
          }),
      } as unknown as ElectronApp.ElectronApp["Service"];
      yield* Effect.gen(function* () {
        const clerk = yield* DesktopClerk.DesktopClerk;
        yield* clerk.configure;
        if (entry === "open-url") {
          const event = { preventDefault: vi.fn() };
          // SSHCode's handoff link is not this app's to take.
          listeners.get("open-url")!(event, link.replace(/^sshcode-dev:/, "t3code-dev:"));
          assert.strictEqual(event.preventDefault.mock.calls.length, 0);
          listeners.get("open-url")!(event, link);
          assert.strictEqual(event.preventDefault.mock.calls.length, 1);
        }
        const delivery = readCodexAuthDelivery(yield* Effect.promise(() => delivered.promise));
        assert.strictEqual(delivery?.environmentId, request.environmentId);
        assert.strictEqual(delivery?.instanceId, request.instanceId);
        assert.strictEqual(delivery?.flowId, request.flowId);
        assert.strictEqual(delivery?.returnUrl, request.returnUrl);
      }).pipe(
        Effect.provide(layerDesktopClerk(true, [], "darwin", undefined, shell)),
        Effect.provideService(HostProcess.Arguments, entry === "startup" ? ["t3", link] : ["t3"]),
        Effect.provideService(ElectronApp.ElectronApp, electronApp),
        Effect.provideService(
          ElectronWindow.ElectronWindow,
          {} as ElectronWindow.ElectronWindow["Service"],
        ),
        Effect.provideService(DesktopWindow.DesktopWindow, ignoreDesktopWindow),
        Effect.provide(DesktopState.layer),
        Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
      );
    }).pipe(Effect.scoped),
);

it.effect("hands web and app links to the renderer and leaves other links alone", () =>
  Effect.gen(function* () {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const electronApp = {
      whenReady: Effect.void,
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const received: Array<string> = [];
    yield* Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      const open = (url: string) => {
        const event = { preventDefault: vi.fn() };
        listeners.get("open-url")!(event, url);
        return event.preventDefault.mock.calls.length;
      };
      // macOS hands the default browser every web link.
      assert.strictEqual(open("https://example.com/page"), 1);
      assert.strictEqual(open("http://localhost:3000/"), 1);
      // Prompt and thread links ride the same queue; the renderer routes them in the app.
      assert.strictEqual(open(promptLinkDeepLink("/new?prompt=hi")), 1);
      assert.strictEqual(open("sshcode://threads/env-1/thread-1"), 1);
      // Anything else is not a web page; Electron keeps its own handling.
      assert.strictEqual(open("mailto:hello@example.com"), 0);
      assert.strictEqual(open("sshcode://somewhere-else"), 0);
      assert.strictEqual(open("t3code://new?prompt=hi"), 0);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(received, [
        "https://example.com/page",
        "http://localhost:3000/",
        "sshcode://new?prompt=hi",
        "sshcode://threads/env-1/thread-1",
      ]);
    }).pipe(
      Effect.provide(layerDesktopClerk(true, [], "darwin")),
      Effect.provideService(HostProcess.Arguments, ["t3"]),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(DesktopWindow.DesktopWindow, ignoreDesktopWindow),
      Effect.provide(DesktopState.layer),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url) => Effect.sync(() => void received.push(url)),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect(
  "reopens the main window for provider auth returns and plain second-instance launches when all windows are closed",
  () => {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const authRevealed = Promise.withResolvers<void>();
    const loadURL = vi.fn(async (_url: string) => undefined);
    const window = { loadURL } as unknown as Electron.BrowserWindow;
    let currentWindow: Option.Option<Electron.BrowserWindow> = Option.none();
    let activateCalls = 0;
    let revealCalls = 0;

    const electronApp = {
      whenReady: Effect.void,
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const electronWindow = {
      currentMainOrFirst: Effect.sync(() => currentWindow),
      reveal: () =>
        Effect.sync(() => {
          revealCalls += 1;
          authRevealed.resolve();
        }),
    } as unknown as ElectronWindow.ElectronWindow["Service"];
    const desktopWindow = {
      activate: Effect.sync(() => {
        activateCalls += 1;
        currentWindow = Option.some(window);
      }),
    } as unknown as DesktopWindow.DesktopWindow["Service"];

    return Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;

      listeners.get("open-url")!(
        { preventDefault: vi.fn() },
        "sshcode-dev://app/settings/providers?instanceId=work",
      );
      yield* Effect.yieldNow;
      assert.strictEqual(activateCalls, 1);
      yield* Effect.promise(() => authRevealed.promise);
      assert.deepEqual(loadURL.mock.calls, [
        ["t3code-dev://app/settings/providers?instanceId=work"],
      ]);
      assert.strictEqual(revealCalls, 1);

      currentWindow = Option.none();
      listeners.get("second-instance")!({}, ["t3"]);
      yield* Effect.yieldNow;
      assert.strictEqual(activateCalls, 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(layerDesktopClerk(true, [], "darwin")),
      Effect.provideService(HostProcess.Arguments, ["t3"]),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(ElectronWindow.ElectronWindow, electronWindow),
      Effect.provideService(DesktopWindow.DesktopWindow, desktopWindow),
      Effect.provide(DesktopState.layer),
      Effect.provideService(DesktopWebLinks.DesktopWebLinks, ignoreWebLinks),
    );
  },
);

it.effect("defers window activation for links received before Electron is ready", () =>
  Effect.gen(function* () {
    storageMock.mockReturnValue(storageAdapter);
    createClerkBridgeMock.mockReturnValue({ cleanup: vi.fn(), isPrimaryInstance: true });
    const ready = yield* Deferred.make<void>();
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const electronApp = {
      whenReady: Deferred.await(ready),
      on: (name: string, listener: (...args: unknown[]) => void) =>
        Effect.sync(() => {
          listeners.set(name, listener);
        }),
    } as unknown as ElectronApp.ElectronApp["Service"];
    const coldLink = promptLinkDeepLink("/new?prompt=cold");
    const warmLink = promptLinkDeepLink("/new?prompt=warm");
    const received: Array<{ url: string; activate: boolean | undefined }> = [];

    yield* Effect.gen(function* () {
      const clerk = yield* DesktopClerk.DesktopClerk;
      yield* clerk.configure;
      listeners.get("open-url")!({ preventDefault: vi.fn() }, coldLink);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(ready, undefined);
      yield* Effect.yieldNow;
      listeners.get("open-url")!({ preventDefault: vi.fn() }, warmLink);
      yield* Effect.yieldNow;

      assert.deepStrictEqual(received, [
        { url: coldLink, activate: false },
        { url: warmLink, activate: true },
      ]);
    }).pipe(
      Effect.provide(layerDesktopClerk(true, [], "darwin")),
      Effect.provideService(HostProcess.Arguments, ["t3"]),
      Effect.provideService(ElectronApp.ElectronApp, electronApp),
      Effect.provideService(
        ElectronWindow.ElectronWindow,
        {} as ElectronWindow.ElectronWindow["Service"],
      ),
      Effect.provideService(DesktopWindow.DesktopWindow, ignoreDesktopWindow),
      Effect.provide(DesktopState.layer),
      Effect.provideService(
        DesktopWebLinks.DesktopWebLinks,
        DesktopWebLinks.DesktopWebLinks.of({
          receive: (url, options?: { readonly activate?: boolean }) =>
            Effect.sync(() => void received.push({ url, activate: options?.activate })),
          setRendererReady: () => Effect.void,
        }),
      ),
    );
  }).pipe(Effect.scoped),
);
