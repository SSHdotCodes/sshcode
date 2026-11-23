import {
  AuthStandardClientScopes,
  EnvironmentId,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopBridge,
  type DesktopSshEnvironmentTarget,
} from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Fiber from "effect/Fiber";
import * as Deferred from "effect/Deferred";
import * as TestClock from "effect/testing/TestClock";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import { PlatformConnectionSource } from "@t3tools/client-runtime/platform";
import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";
import * as Effect from "effect/Effect";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
} from "@t3tools/client-runtime/connection";

import {
  layerPlatformConnectionSource,
  canRetainCachedPlatformRegistrationAfterRefreshFailure,
  canReuseCachedPlatformRegistration,
  isRejectedBootstrapCredentialError,
  isRejectedSecondaryBootstrap,
  nextRejectedSecondaryBootstrap,
  primaryRegistrationToRetainAfterTopologyRead,
  provisionDesktopSshEnvironment,
  readPrimaryEnvironmentTargetResult,
  secondaryRegistrationsToRetainAfterTopologyRead,
  secondaryBearerExpiresAtEpochMs,
  secondaryBearerRefreshAtEpochMs,
} from "./platform.ts";

const TARGET: DesktopSshEnvironmentTarget = {
  alias: "devbox",
  hostname: "devbox.example.test",
  username: "developer",
  port: 22,
};

function makeBridge(
  calls: string[],
  options?: { readonly failDescriptor?: boolean },
): DesktopBridge {
  return {
    ensureSshEnvironment: async (target: DesktopSshEnvironmentTarget) => {
      calls.push("ensure");
      return {
        target,
        httpBaseUrl: "http://127.0.0.1:3201/",
        wsBaseUrl: "ws://127.0.0.1:3201/",
        pairingToken: "pairing-token",
      };
    },
    fetchSshEnvironmentDescriptor: async () => {
      calls.push("descriptor");
      if (options?.failDescriptor === true) {
        throw new Error("descriptor unavailable");
      }
      return {
        environmentId: EnvironmentId.make("environment-ssh"),
        label: "SSH environment",
        platform: {
          os: "linux",
          arch: "x64",
        },
        serverVersion: "0.0.0-test",
        capabilities: {
          repositoryIdentity: true,
        },
      };
    },
    bootstrapSshBearerSession: async () => {
      calls.push("token");
      return {
        access_token: "bearer-token",
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: 3_600,
        scope: AuthStandardClientScopes.join(" "),
      };
    },
  } as unknown as DesktopBridge;
}

describe("desktop SSH pairing", () => {
  it.effect("fetches the descriptor before consuming the one-time credential", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const provisioned = yield* provisionDesktopSshEnvironment(makeBridge(calls), TARGET);

      expect(provisioned.environmentId).toBe(EnvironmentId.make("environment-ssh"));
      expect(calls).toEqual(["ensure", "descriptor", "token"]);
    }),
  );

  it.effect("does not consume the credential when adding a route to a different machine", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      const error = yield* provisionDesktopSshEnvironment(
        makeBridge(calls),
        TARGET,
        EnvironmentId.make("some-other-machine"),
      ).pipe(Effect.flip);

      expect(error).toMatchObject({ reason: "configuration" });
      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );

  it.effect("does not consume the credential when descriptor discovery fails", () =>
    Effect.gen(function* () {
      const calls: string[] = [];

      yield* provisionDesktopSshEnvironment(
        makeBridge(calls, { failDescriptor: true }),
        TARGET,
      ).pipe(Effect.flip);

      expect(calls).toEqual(["ensure", "descriptor"]);
    }),
  );
});

describe("desktop-local bearer cache", () => {
  const registration = {} as never;

  it("refreshes a secondary bearer before it expires", () => {
    const issuedAtEpochMs = 10_000;
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(issuedAtEpochMs, 60);
    const expiresAtEpochMs = secondaryBearerExpiresAtEpochMs(issuedAtEpochMs, 60);
    const cached = {
      expiresAtEpochMs,
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(65_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 64_999)).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 65_000)).toBe(false);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 69_999),
    ).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, cached.signature, 70_000),
    ).toBe(false);
  });

  it("does not cache credentials whose lifetime is shorter than the refresh skew", () => {
    const refreshAtEpochMs = secondaryBearerRefreshAtEpochMs(10_000, 3);
    const cached = {
      expiresAtEpochMs: secondaryBearerExpiresAtEpochMs(10_000, 3),
      signature: "secondary-signature",
      registration,
      refreshAtEpochMs,
    };

    expect(refreshAtEpochMs).toBe(10_000);
    expect(canReuseCachedPlatformRegistration(cached, cached.signature, 10_000)).toBe(false);
  });

  it("retains only unexpired secondaries after a topology read failure", () => {
    const valid = {
      expiresAtEpochMs: 20_000,
      signature: "valid-secondary",
      registration,
      refreshAtEpochMs: 15_000,
    };
    const previous = new Map([
      ["valid-secondary", valid],
      [
        "expired-secondary",
        {
          expiresAtEpochMs: 10_000,
          signature: "expired-secondary",
          registration,
          refreshAtEpochMs: 5_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Failure", cause: new Error("IPC unavailable") },
        10_000,
      ),
    ).toEqual(new Map([["valid-secondary", valid]]));
  });

  it("treats a successful empty topology as authoritative removal", () => {
    const previous = new Map([
      [
        "secondary",
        {
          expiresAtEpochMs: 20_000,
          signature: "secondary",
          registration,
          refreshAtEpochMs: 15_000,
        },
      ],
    ]);

    expect(
      secondaryRegistrationsToRetainAfterTopologyRead(
        previous,
        { _tag: "Success", bootstraps: [] },
        10_000,
      ),
    ).toEqual(new Map());
  });
});

describe("rejected desktop-local bootstrap tokens", () => {
  it("backs off on a rejected signature and retries it on a growing, capped delay", () => {
    const signature = "http://a|ws://a|old-token";
    const first = nextRejectedSecondaryBootstrap(undefined, signature, 0);

    expect(isRejectedSecondaryBootstrap(first, signature, 59_999)).toBe(true);
    // A backend restarted on the same port accepts the same token again, so it is retried.
    expect(isRejectedSecondaryBootstrap(first, signature, 60_000)).toBe(false);

    const second = nextRejectedSecondaryBootstrap(first, signature, 60_000);
    expect(second.retryAtEpochMs).toBe(180_000);

    let backoff = second;
    for (let attempt = 0; attempt < 10; attempt += 1) {
      backoff = nextRejectedSecondaryBootstrap(backoff, signature, 0);
    }
    expect(backoff.delayMs).toBe(30 * 60_000);
  });

  it("retries at once when the token or endpoint changes", () => {
    const rejected = nextRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 0);

    expect(isRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(rejected, "http://b|ws://b|old-token", 1)).toBe(false);
    expect(isRejectedSecondaryBootstrap(undefined, "http://a|ws://a|old-token", 1)).toBe(false);
    expect(nextRejectedSecondaryBootstrap(rejected, "http://a|ws://a|new-token", 1).delayMs).toBe(
      60_000,
    );
  });

  it("treats only authentication rejections as a dead credential", () => {
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionBlockedError({ reason: "authentication", detail: "invalid" }),
      ),
    ).toBe(true);
    expect(
      isRejectedBootstrapCredentialError(
        new ConnectionTransientError({ reason: "endpoint-unavailable", detail: "booting" }),
      ),
    ).toBe(false);
  });
});

describe("desktop-local bearer cache across token changes", () => {
  it("keeps a live bearer when only the bootstrap token rotates", () => {
    // Cached by endpoint: a rotated token reuses the bearer instead of
    // dropping the environment (and its drafts) when the new token is rejected.
    const cached = {
      signature: "http://a|ws://a",
      registration: {} as never,
      expiresAtEpochMs: 20_000,
      refreshAtEpochMs: 15_000,
    };

    expect(canReuseCachedPlatformRegistration(cached, "http://a|ws://a", 10_000)).toBe(true);
    expect(
      canRetainCachedPlatformRegistrationAfterRefreshFailure(cached, "http://a|ws://a", 16_000),
    ).toBe(true);
    expect(canReuseCachedPlatformRegistration(cached, "http://b|ws://b", 10_000)).toBe(false);
  });
});

describe("primary topology cache", () => {
  const registration = {} as never;
  const cached = {
    signature: "primary|http://127.0.0.1:3773/|ws://127.0.0.1:3773/",
    registration,
  };
  const previous = new Map([[PRIMARY_LOCAL_ENVIRONMENT_ID, cached]]);

  it("captures synchronous primary target read failures", () => {
    const cause = new Error("invalid primary target");

    expect(
      readPrimaryEnvironmentTargetResult(() => {
        throw cause;
      }),
    ).toEqual({ _tag: "Failure", cause });
  });

  it("retains the cached primary after a transient topology read failure", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Failure",
        cause: new Error("IPC unavailable"),
      }),
    ).toBe(cached);
  });

  it("treats a successful primary absence as authoritative removal", () => {
    expect(
      primaryRegistrationToRetainAfterTopologyRead(previous, {
        _tag: "Success",
        target: null,
      }),
    ).toBeUndefined();
  });
});

describe("platform startup isolation", { concurrent: false }, () => {
  afterEach(() => {
    __resetDesktopPrimaryAuthForTests();
    vi.unstubAllGlobals();
  });

  it.effect("discovers the public primary without waiting for desktop sign-in", () => {
    const signIn = vi.fn(() => new Promise<string>(() => {}));
    vi.stubGlobal("window", {
      location: { href: "http://127.0.0.1:42123/", origin: "http://127.0.0.1:42123" },
      desktopBridge: {
        getLocalEnvironmentBootstraps: () => [
          {
            id: PRIMARY_LOCAL_ENVIRONMENT_ID,
            label: "This Mac",
            httpBaseUrl: "http://127.0.0.1:42123/",
            wsBaseUrl: "ws://127.0.0.1:42123/",
          },
        ],
        getLocalEnvironmentBearerToken: signIn,
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          environmentId: "local-test",
          label: "This Mac",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        }),
      ),
    );
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource.PlatformConnectionSource;
      const pending = yield* source.registrations.pipe(
        Stream.filter((entries) => entries.length > 0),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* TestClock.adjust("10 seconds");
      expect(pending.pollUnsafe()).toBeDefined();
      const first = yield* Fiber.join(pending);
      expect(Option.getOrThrow(first).map((entry) => entry.target.environmentId)).toEqual([
        "local-test",
      ]);
      expect(signIn).not.toHaveBeenCalled();
    }).pipe(
      Effect.provide(layerPlatformConnectionSource),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    );
  });
  it.effect("keeps polling the primary while a desktop secondary accepts but never answers", () => {
    let primaryPort = 42123;
    const bootstrapReads = vi.fn(() => [
      {
        id: PRIMARY_LOCAL_ENVIRONMENT_ID,
        label: "This Mac",
        httpBaseUrl: `http://127.0.0.1:${primaryPort}/`,
        wsBaseUrl: `ws://127.0.0.1:${primaryPort}/`,
      },
      {
        id: "wsl:test",
        label: "Stalled secondary",
        httpBaseUrl: "http://127.0.0.1:42124/",
        wsBaseUrl: "ws://127.0.0.1:42124/",
        bootstrapToken: "fake-bootstrap",
      },
    ]);
    vi.stubGlobal("window", {
      location: { href: "http://127.0.0.1:42123/", origin: "http://127.0.0.1:42123" },
      desktopBridge: {
        getLocalEnvironmentBootstraps: bootstrapReads,
        getLocalEnvironmentBearerToken: async () => "fake-primary-bearer",
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request, init?: RequestInit) => {
        const address = new URL(String(url));
        if (address.port === "42124")
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
              once: true,
            });
          });
        return Promise.resolve(
          Response.json({
            environmentId: `local-${address.port}`,
            label: "This Mac",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        );
      }),
    );
    return Effect.gen(function* () {
      const source = yield* PlatformConnectionSource.PlatformConnectionSource;
      const snapshots: string[][] = [];
      const firstPrimary = yield* Deferred.make<void>();
      const changedPrimary = yield* Deferred.make<void>();
      yield* source.registrations.pipe(
        Stream.runForEach((entries) =>
          Effect.gen(function* () {
            const ids = entries.map((entry) => String(entry.target.environmentId));
            snapshots.push(ids);
            if (ids.includes("local-42123")) yield* Deferred.succeed(firstPrimary, undefined);
            if (ids.includes("local-42125")) yield* Deferred.succeed(changedPrimary, undefined);
          }),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(firstPrimary);
      expect(snapshots.some((ids) => ids.includes("local-42123"))).toBe(true);
      primaryPort = 42125;
      yield* Effect.yieldNow;
      yield* TestClock.adjust("3 seconds");
      yield* Deferred.await(changedPrimary);
      expect(snapshots.some((ids) => ids.includes("local-42125"))).toBe(true);
      expect(bootstrapReads.mock.calls.length).toBeGreaterThanOrEqual(3);
    }).pipe(
      Effect.provide(layerPlatformConnectionSource),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    );
  });

  it.effect(
    "retries primary discovery after the local server initially refuses connections",
    () => {
      vi.stubGlobal("window", {
        location: { href: "http://127.0.0.1:42123/", origin: "http://127.0.0.1:42123" },
      });
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("connection refused"))
        .mockImplementation(async () =>
          Response.json({
            environmentId: "local-recovered",
            label: "This Mac",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "0.0.0-test",
            capabilities: { repositoryIdentity: true },
          }),
        );
      vi.stubGlobal("fetch", fetchMock);
      return Effect.gen(function* () {
        const source = yield* PlatformConnectionSource.PlatformConnectionSource;
        const refused = yield* Deferred.make<void>();
        const pending = yield* source.registrations.pipe(
          Stream.tap((entries) =>
            entries.length === 0 && fetchMock.mock.calls.length > 0
              ? Deferred.succeed(refused, undefined)
              : Effect.void,
          ),
          Stream.filter((entries) =>
            entries.some((entry) => entry.target.environmentId === "local-recovered"),
          ),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* Deferred.await(refused);
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        expect(Option.getOrThrow(yield* Fiber.join(pending))[0]?.target.environmentId).toBe(
          "local-recovered",
        );
        expect(fetchMock).toHaveBeenCalledTimes(2);
      }).pipe(
        Effect.provide(layerPlatformConnectionSource),
        Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
      );
    },
  );
});
