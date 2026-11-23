import {
  type DesktopBridge,
  EnvironmentId,
  type RelayClientInstallProgressEvent,
  type RelayClientStatus,
  WS_METHODS,
} from "@t3tools/contracts";
import { RelayWebClientId } from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { HttpClient } from "effect/http";
import { afterEach, beforeEach, vi } from "vite-plus/test";
import {
  AVAILABLE_CONNECTION_STATE,
  type PreparedConnection,
  PrimaryConnectionTarget,
  EnvironmentSupervisor,
} from "@t3tools/client-runtime/connection";
import { type RpcSession } from "@t3tools/client-runtime/rpc";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { layerRemoteHttpClient } from "@t3tools/client-runtime/rpc";
import { __resetDesktopPrimaryAuthForTests } from "../environments/primary/desktopAuth";

import {
  linkPrimaryEnvironmentToCloud,
  readPrimaryCloudLinkState,
  type CloudLinkTarget,
  unlinkPrimaryEnvironmentFromCloud,
  updatePrimaryCloudPreferences,
} from "./linkEnvironment";

const TARGET: CloudLinkTarget = {
  environmentId: "environment-1",
  label: "Desktop",
  httpBaseUrl: "http://127.0.0.1:3000",
  wsBaseUrl: "ws://127.0.0.1:3000",
};

const relayClientInstallDialog = vi.hoisted(() => ({
  requestConfirmation: vi.fn(),
  reportProgress: vi.fn(),
  finish: vi.fn(),
}));

vi.mock("./relayClientInstallDialog", () => ({
  requestRelayClientInstallConfirmation: relayClientInstallDialog.requestConfirmation,
  reportRelayClientInstallProgress: relayClientInstallDialog.reportProgress,
  finishRelayClientInstall: relayClientInstallDialog.finish,
}));

const createProof = vi.fn(() => Effect.succeed("dpop-proof"));
const layerDpopSigner = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.succeed("thumbprint"),
    createProof,
  }),
);

function layerRelay() {
  const layerHttp = layerRemoteHttpClient(globalThis.fetch);
  return Layer.mergeAll(
    layerHttp,
    ManagedRelay.layer({
      relayUrl: "https://relay.example.test",
      clientId: RelayWebClientId,
    }).pipe(Layer.provideMerge(layerDpopSigner), Layer.provide(layerHttp)),
  );
}

function layerRegistry(options?: {
  readonly status?:
    | Pick<Extract<RelayClientStatus, { status: "available" }>, "status" | "version">
    | Extract<RelayClientStatus, { status: "missing" }>;
  readonly installEvents?: ReadonlyArray<RelayClientInstallProgressEvent>;
}) {
  return Layer.effect(
    EnvironmentRegistry.EnvironmentRegistry,
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.cloudGetRelayClientStatus]: () =>
          Effect.succeed(options?.status ?? { status: "available", version: "2026.6.0" }),
        [WS_METHODS.cloudInstallRelayClient]: () =>
          Stream.fromIterable(options?.installEvents ?? []),
      } as unknown as RpcSession["client"];
      const session: RpcSession = {
        client,
        initialConfig: Effect.never,
        subscribeServerConfig: (input) => client.subscribeServerConfig(input),
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const target = new PrimaryConnectionTarget({
        environmentId: EnvironmentId.make(TARGET.environmentId),
        label: TARGET.label,
        httpBaseUrl: TARGET.httpBaseUrl,
        wsBaseUrl: TARGET.wsBaseUrl,
      });
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const registry = {
        run: <A, E, R>(_environmentId: EnvironmentId, effect: Effect.Effect<A, E, R>) =>
          Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        runStream: <A, E, R>(_environmentId: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
          Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
      } as unknown as EnvironmentRegistry.EnvironmentRegistry["Service"];
      return EnvironmentRegistry.EnvironmentRegistry.of(registry);
    }),
  );
}

function layerServices(options?: Parameters<typeof layerRegistry>[0]) {
  return Layer.mergeAll(layerRelay(), layerRegistry(options));
}

function withServices<A, E>(
  effect: Effect.Effect<
    A,
    E,
    | HttpClient.HttpClient
    | ManagedRelay.ManagedRelayClient
    | EnvironmentRegistry.EnvironmentRegistry
  >,
  options?: Parameters<typeof layerRegistry>[0],
) {
  return effect.pipe(Effect.provide(layerServices(options)));
}

function bodyText(body: BodyInit | null | undefined): string {
  return body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("VITE_T3CODE_RELAY_URL", "https://relay.example.test");
  relayClientInstallDialog.requestConfirmation.mockResolvedValue(true);
});

afterEach(() => {
  __resetDesktopPrimaryAuthForTests();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("web cloud link environment client", () => {
  it.effect("reads primary cloud link state from the explicit target", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: false,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const state = yield* withServices(readPrimaryCloudLinkState({ target: TARGET }));

      expect(Option.fromNullishOr(state)).toEqual(
        Option.some({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: false,
        }),
      );
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/link-state",
      );
    }),
  );

  it.effect("uses desktop bearer auth for primary cloud link state", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: false,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("window", {
        location: { origin: "t3code://app" },
        desktopBridge: {
          getLocalEnvironmentBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
        } as unknown as DesktopBridge,
      });

      yield* withServices(readPrimaryCloudLinkState({ target: TARGET }));

      const request = new Request(fetchMock.mock.calls[0]?.[0], fetchMock.mock.calls[0]?.[1]);
      expect(request.credentials).not.toBe("include");
      expect(request.headers.get("authorization")).toBe("Bearer desktop-bearer-token");
    }),
  );

  it.effect("updates agent activity publishing for the explicit primary target", () =>
    Effect.gen(function* () {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          linked: true,
          cloudUserId: "user-1",
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          managedTunnelActive: true,
          publishAgentActivity: true,
        }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const state = yield* withServices(
        updatePrimaryCloudPreferences({
          target: TARGET,
          publishAgentActivity: true,
        }),
      );

      expect(state.publishAgentActivity).toBe(true);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/preferences",
      );
      expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
      expect(JSON.parse(bodyText(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
        publishAgentActivity: true,
      });
    }),
  );

  it.effect("links an available primary environment without invoking installation", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            challenge: "challenge",
            expiresAt: "2026-06-06T00:05:00.000Z",
          }),
        )
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: "https://desktop.example.test",
              wsBaseUrl: "wss://desktop.example.test",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "configured" } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
      );

      const configCall = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/api/connect/relay-config"),
      );
      expect(JSON.parse(bodyText(configCall?.[1]?.body))).toMatchObject({
        endpointHttpBaseUrl: "https://desktop.example.test",
      });
      expect(relayClientInstallDialog.requestConfirmation).not.toHaveBeenCalled();
      expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/link-proof",
      );
      expect(JSON.parse(bodyText(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
        challenge: "challenge",
        endpoint: {
          httpBaseUrl: TARGET.httpBaseUrl,
          wsBaseUrl: TARGET.wsBaseUrl,
        },
      });
    }),
  );

  it.effect("stops a cancelled link after its challenge resolves", () =>
    Effect.gen(function* () {
      const challenge = deferred<Response>();
      const challengeStarted = deferred<void>();
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => {
          challengeStarted.resolve();
          return challenge.promise;
        })
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: "https://desktop.example.test",
              wsBaseUrl: "wss://desktop.example.test",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "configured" } }),
        );
      vi.stubGlobal("fetch", fetchMock);
      let current = true;

      const fiber = yield* Effect.forkChild(
        withServices(
          linkPrimaryEnvironmentToCloud({
            target: TARGET,
            clerkToken: "clerk-token",
            isCurrent: () => current,
          }),
        ),
      );
      yield* Effect.promise(() => challengeStarted.promise);
      current = false;
      challenge.resolve(
        Response.json({ challenge: "challenge", expiresAt: "2026-06-06T00:05:00.000Z" }),
      );
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit)).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("links another environment with its own login, not the desktop's", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ challenge: "challenge", expiresAt: "2026-06-06T00:05:00.000Z" }),
        )
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: "https://studio.example.test",
              wsBaseUrl: "wss://studio.example.test",
              providerKind: "cloudflare_tunnel",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "configured" } }),
        );
      vi.stubGlobal("fetch", fetchMock);
      vi.stubGlobal("window", {
        location: { origin: "t3code://app" },
        desktopBridge: {
          getLocalEnvironmentBearerToken: vi.fn().mockResolvedValue("desktop-bearer-token"),
        } as unknown as DesktopBridge,
      });

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: { ...TARGET, bearerToken: "studio-bearer-token" },
          clerkToken: "clerk-token",
        }),
      );

      for (const call of [fetchMock.mock.calls[1], fetchMock.mock.calls[3]]) {
        const request = new Request(call?.[0], call?.[1]);
        expect(request.headers.get("authorization")).toBe("Bearer studio-bearer-token");
      }
      expect(String(fetchMock.mock.calls[3]?.[0])).toBe(
        "http://127.0.0.1:3000/api/connect/relay-config",
      );
    }),
  );

  it.effect("links publish-only without a managed tunnel", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            challenge: "challenge",
            expiresAt: "2026-06-06T00:05:00.000Z",
          }),
        )
        .mockResolvedValueOnce(Response.json("signed-proof"))
        .mockResolvedValueOnce(
          Response.json({
            ok: true,
            environmentId: TARGET.environmentId,
            endpoint: {
              httpBaseUrl: TARGET.httpBaseUrl,
              wsBaseUrl: TARGET.wsBaseUrl,
              providerKind: "manual",
            },
            endpointRuntime: null,
            relayIssuer: "https://relay.example.test",
            cloudUserId: "user-1",
            environmentCredential: "environment-credential",
            cloudMintPublicKey: "public-key",
          }),
        )
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
        );
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
          mode: "publish_only",
        }),
      );

      expect(JSON.parse(bodyText(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
        managedTunnelsEnabled: false,
      });
      expect(JSON.parse(bodyText(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
        endpoint: { providerKind: "manual" },
      });
    }),
  );

  it.effect("installs a missing relay client before linking", () =>
    Effect.gen(function* () {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ malformed: true })));

      yield* withServices(
        linkPrimaryEnvironmentToCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
        {
          status: { status: "available", version: "2026.6.0" },
          installEvents: [],
        },
      ).pipe(Effect.flip);

      expect(relayClientInstallDialog.requestConfirmation).not.toHaveBeenCalled();
    }),
  );

  it.effect("unlinks locally before revoking the relay record", () =>
    Effect.gen(function* () {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } }),
        )
        .mockResolvedValueOnce(Response.json({ ok: true }));
      vi.stubGlobal("fetch", fetchMock);

      yield* withServices(
        unlinkPrimaryEnvironmentFromCloud({
          target: TARGET,
          clerkToken: "clerk-token",
        }),
      );

      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("http://127.0.0.1:3000/api/connect/unlink");
      expect(String(fetchMock.mock.calls[1]?.[0])).toContain(
        `/v1/client/environment-links/${TARGET.environmentId}`,
      );
    }),
  );
  it.effect(
    "keeps remote cloud reads, preference writes and unlink on that route's own credential",
    () =>
      Effect.gen(function* () {
        const fetchMock = vi.fn().mockImplementation((input) =>
          Promise.resolve(
            String(input).endsWith("/unlink")
              ? Response.json({ ok: true, endpointRuntimeStatus: { status: "disabled" } })
              : Response.json({
                  linked: true,
                  cloudUserId: "user-1",
                  relayUrl: "https://relay.example.test",
                  relayIssuer: "https://relay.example.test",
                  managedTunnelActive: true,
                  publishAgentActivity: false,
                }),
          ),
        );
        vi.stubGlobal("fetch", fetchMock);
        const remote = {
          ...TARGET,
          environmentId: "remote-environment",
          httpBaseUrl: "https://remote.example.test",
          bearerToken: "remote-test-token",
        };
        yield* withServices(readPrimaryCloudLinkState({ target: remote }));
        yield* withServices(
          updatePrimaryCloudPreferences({ target: remote, publishAgentActivity: false }),
        );
        yield* withServices(
          unlinkPrimaryEnvironmentFromCloud({ target: remote, clerkToken: null }),
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
        for (const [input, init] of fetchMock.mock.calls) {
          const request = new Request(input, init);
          expect(request.url).toMatch(/^https:\/\/remote\.example\.test\//);
          expect(request.headers.get("authorization")).toBe("Bearer remote-test-token");
          expect(request.credentials).not.toBe("include");
        }
      }),
  );

  it.effect(
    "the wizard's explicit Turn on action includes a missing relay client without another confirmation",
    () =>
      Effect.gen(function* () {
        const fetchMock = vi.fn().mockResolvedValue(Response.json({ malformed: true }));
        vi.stubGlobal("fetch", fetchMock);
        yield* withServices(
          linkPrimaryEnvironmentToCloud({
            target: TARGET,
            clerkToken: "clerk-token",
            installRelayClient: true,
          }),
          {
            status: { status: "missing", version: "test-version" },
            installEvents: [
              {
                type: "complete",
                status: {
                  status: "available",
                  version: "test-version",
                  executablePath: "/test/relay-client",
                  source: "managed",
                },
              },
            ],
          },
        ).pipe(Effect.flip);
        expect(relayClientInstallDialog.requestConfirmation).not.toHaveBeenCalled();
        expect(relayClientInstallDialog.finish).toHaveBeenCalledOnce();
        // Reaching the relay challenge proves installation finished; no real network is used.
        expect(fetchMock).toHaveBeenCalledOnce();
      }),
  );
});
