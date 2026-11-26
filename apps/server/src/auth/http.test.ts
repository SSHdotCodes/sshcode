// @effect-diagnostics-next-line nodeBuiltinImport:off -- Signs a real DPoP proof for the HTTP regression.
import * as NodeCrypto from "node:crypto";
import * as PlatformError from "effect/PlatformError";
import * as Duration from "effect/Duration";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthSessionId,
  AuthTokenExchangeGrantType,
  AuthEnvironmentBootstrapTokenType,
  AuthAccessTokenType,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthInvalidError,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import { RelayClientTracer } from "@t3tools/shared/relayTracing";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { HttpServerRequest } from "effect/http";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpRouter from "effect/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";
import { layerTransportSecurity } from "../httpSecurity.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const layerConfig = Layer.effect(
  ServerConfig.ServerConfig,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return {
      ...config,
      mode: "web",
      devUrl: new URL("http://127.0.0.1:5173"),
      devAuthToken: Redacted.make(DEV_TOKEN),
    } satisfies ServerConfig.ServerConfig["Service"];
  }),
).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);
const layerRoutes = HttpApiBuilder.layer(AuthTestApi).pipe(
  Layer.provide(AuthHttp.layer),
  Layer.provide(layerTransportSecurity),
  Layer.provide(AuthHttp.layerAuthenticatedAuth),
  Layer.provideMerge(layerEnvironmentAuth),
  Layer.provide(layerConfig),
  Layer.provideMerge(
    HttpPlatform.layer.pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(Etag.layerWeak),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const postJson = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", host: "127.0.0.1", ...headers },
    body: encodeJson(body),
  });

it.effect("sets the selected browser session cookies through the HTTP route", () =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
      get: () => Effect.succeedNone,
      set: () => Effect.void,
      create: () => Effect.void,
      getOrCreateRandom: () => Effect.die("Not used by these routes."),
      remove: () => Effect.void,
    });
    const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          [
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
            HttpRouter.toWebHandler(layerRoutes, { disableLogger: true }),
          ] as const,
      ),
      ([environmentA, environmentB]) =>
        Effect.tryPromise(async () => {
          const devResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: DEV_TOKEN }),
            requestContext,
          );
          expect(devResponse.status).toBe(200);
          const retiredScopeResponse = await environmentA.handler(
            new Request("http://127.0.0.1/oauth/token", {
              method: "POST",
              body: new URLSearchParams({
                grant_type: AuthTokenExchangeGrantType,
                subject_token: DEV_TOKEN,
                subject_token_type: AuthEnvironmentBootstrapTokenType,
                requested_token_type: AuthAccessTokenType,
                scope: "review:write",
              }),
            }),
            requestContext,
          );
          expect(retiredScopeResponse.status).toBe(400);
          expect(await retiredScopeResponse.json()).toMatchObject({ reason: "invalid_scope" });

          const devCookies = devResponse.headers.getSetCookie();
          const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
          expect(devCookie).toContain("HttpOnly");
          expect(devCookie).toContain(`=${DEV_TOKEN};`);
          expect(devCookies).toContainEqual(
            expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
          );
          const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
          const environmentBSession = await environmentB.handler(
            new Request("http://127.0.0.1/api/auth/session", {
              headers: { cookie: devCookieHeader },
            }),
            requestContext,
          );
          expect(environmentBSession.status).toBe(200);
          expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

          const pairingResponse = await environmentA.handler(
            postJson(
              "/api/auth/pairing-token",
              { scopes: ["orchestration:read"] },
              { cookie: devCookieHeader },
            ),
            requestContext,
          );
          expect(pairingResponse.status).toBe(200);
          const pairing = (await pairingResponse.json()) as { credential: string };
          const restrictedResponse = await environmentA.handler(
            postJson("/api/auth/browser-session", { credential: pairing.credential }),
            requestContext,
          );
          expect(restrictedResponse.status).toBe(200);
          const restrictedCookies = restrictedResponse.headers.getSetCookie();
          expect(restrictedCookies).toHaveLength(1);
          expect(restrictedCookies[0]).toMatch(/^t3_session_/);
          expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
          expect(devCookie).not.toMatch(/; Secure(?:;|$)/);
          expect(devResponse.headers.get("strict-transport-security")).toBeNull();

          // Exercise the real auth route and serializer behind a TLS-terminating
          // tunnel, including the expired normal cookie and a fresh normal session.
          const remoteOrigin = "https://remote.example";
          const remoteDev = await environmentA.handler(
            new Request(`${remoteOrigin}/api/auth/browser-session`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                host: "remote.example",
                "x-forwarded-proto": "https",
              },
              body: encodeJson({ credential: DEV_TOKEN }),
            }),
            requestContext,
          );
          expect(remoteDev.status).toBe(200);
          expect(remoteDev.headers.getSetCookie()).toHaveLength(2);
          for (const cookie of remoteDev.headers.getSetCookie()) {
            expect(cookie).toMatch(/; Secure(?:;|$)/);
            expect(cookie).toContain("HttpOnly");
          }
          expect(remoteDev.headers.get("strict-transport-security")).toBe("max-age=31536000");
          const remotePairing = await environmentA.handler(
            new Request(`${remoteOrigin}/api/auth/pairing-token`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                cookie: devCookieHeader,
                host: "remote.example",
                "x-forwarded-proto": "https",
              },
              body: encodeJson({ scopes: ["orchestration:read"] }),
            }),
            requestContext,
          );
          expect(remotePairing.status).toBe(200);
          const remoteCredential = (await remotePairing.json()) as { credential: string };
          const remoteSession = await environmentA.handler(
            new Request(`${remoteOrigin}/api/auth/browser-session`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                host: "remote.example",
                "x-forwarded-proto": "https",
              },
              body: encodeJson({ credential: remoteCredential.credential }),
            }),
            requestContext,
          );
          expect(remoteSession.status).toBe(200);
          expect(remoteSession.headers.getSetCookie()).toHaveLength(1);
          expect(remoteSession.headers.getSetCookie()[0]).toMatch(/; Secure(?:;|$)/);
          const refresh = await environmentA.handler(
            new Request(`${remoteOrigin}/api/auth/session`, {
              headers: {
                host: "remote.example",
                "x-forwarded-proto": "https",
                cookie: remoteSession.headers.getSetCookie()[0]!.split(";", 1)[0]!,
              },
            }),
            requestContext,
          );
          expect(refresh.status).toBe(200);
          expect(await refresh.json()).toMatchObject({ authenticated: true });
          expect(refresh.headers.getSetCookie()).toHaveLength(1);
          expect(refresh.headers.getSetCookie()[0]).toMatch(/; Secure(?:;|$)/);
          expect(refresh.headers.get("cache-control")).toBe("no-store");
        }),
      ([environmentA, environmentB]) =>
        Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("exports only verified T3 Connect requests", () =>
  Effect.gen(function* () {
    const productSpans: Array<string> = [];
    const localSpans: Array<string> = [];
    const collect = (into: Array<string>) =>
      Tracer.make({
        span: (options) => {
          into.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      });
    // "DPoP connect" is a T3 Connect session; any other DPoP token is rejected.
    const environmentAuth = {
      authenticateHttpRequest: (request: HttpServerRequest.HttpServerRequest) =>
        (request.headers.authorization === "DPoP forged"
          ? Effect.fail(
              new EnvironmentAuth.ServerAuthInvalidCredentialError({ diagnostic: "forged" }),
            )
          : Effect.succeed({
              sessionId: AuthSessionId.make("session-1"),
              subject:
                request.headers.authorization === "DPoP connect"
                  ? "cloud-connect"
                  : "cli-issued-session",
              method: "bearer-access-token" as const,
              scopes: ["orchestration:read" as const],
            })
        ).pipe(Effect.withSpan("EnvironmentAuth.authenticateHttpRequest")),
    } as unknown as EnvironmentAuth.EnvironmentAuth["Service"];
    const middleware = yield* Layer.build(AuthHttp.layerAuthenticatedAuth).pipe(
      Effect.provideService(EnvironmentAuth.EnvironmentAuth, environmentAuth),
      Effect.map(Context.get(EnvironmentAuthenticatedAuth)),
    );
    const handle = (authorization: string) =>
      (
        middleware as unknown as (
          effect: Effect.Effect<void>,
        ) => Effect.Effect<void, Error, HttpServerRequest.HttpServerRequest>
      )(Effect.void.pipe(Effect.withSpan("environment.handler"))).pipe(
        Effect.ignore,
        Effect.provideService(
          HttpServerRequest.HttpServerRequest,
          HttpServerRequest.fromWeb(
            new Request("https://environment.example.test/api/orchestration/shell", {
              headers: {
                authorization,
                traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
              },
            }),
          ),
        ),
        Effect.provideService(RelayClientTracer, Option.some(collect(productSpans))),
        Effect.withTracer(collect(localSpans)),
      );

    yield* handle("DPoP connect");
    expect(productSpans).toEqual([
      "environment.relay.request",
      "EnvironmentAuth.authenticateHttpRequest",
      "environment.handler",
    ]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest"]);

    productSpans.length = 0;
    localSpans.length = 0;
    yield* handle("DPoP forged");
    expect(productSpans).toEqual([]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest"]);

    localSpans.length = 0;
    yield* handle("Bearer access-token");
    expect(productSpans).toEqual([]);
    expect(localSpans).toEqual(["EnvironmentAuth.authenticateHttpRequest", "environment.handler"]);
  }).pipe(Effect.scoped),
);

it.live("validates the bootstrap credential before persisting DPoP replay state", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const header = encode({
      typ: "dpop+jwt",
      alg: "ES256",
      jwk: publicKey.export({ format: "jwk" }),
    });
    const payload = encode({
      htm: "POST",
      htu: "http://127.0.0.1/oauth/token",
      jti: "credential-first",
      iat: Math.floor(now.epochMilliseconds / 1000),
    });
    const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
      key: privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    const dpop = `${header}.${payload}.${signature}`;
    const created: string[] = [];
    const markers = new Map<string, Uint8Array>();
    const context = Context.make(Crypto.Crypto, yield* Crypto.Crypto).pipe(
      Context.add(ServerSecretStore.ServerSecretStore, {
        get: (name) => Effect.succeed(Option.fromNullishOr(markers.get(name))),
        set: () => Effect.void,
        create: (name, value) =>
          Effect.suspend(() => {
            if (created.includes(name))
              return Effect.fail(
                new ServerSecretStore.SecretStorePersistError({
                  resource: name,
                  cause: PlatformError.systemError({
                    _tag: "AlreadyExists",
                    module: "FileSystem",
                    method: "open",
                  }),
                }),
              );
            created.push(name);
            markers.set(name, value);
            return Effect.void;
          }),
        getOrCreateRandom: () => Effect.die("unused"),
        remove: () => Effect.void,
      }),
    );
    const app = yield* Effect.acquireRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      ({ dispose }) => Effect.promise(dispose),
    );
    const request = (credential: string) =>
      new Request("http://127.0.0.1/oauth/token", {
        method: "POST",
        headers: { dpop, host: "127.0.0.1" },
        body: new URLSearchParams({
          grant_type: AuthTokenExchangeGrantType,
          subject_token: credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
        }),
      });
    const invalid = yield* Effect.promise(() => app.handler(request("invalid-bootstrap"), context));
    expect(invalid.status).toBe(401);
    expect(created).toEqual([]);
    const valid = yield* Effect.promise(() => app.handler(request(DEV_TOKEN), context));
    expect({ status: valid.status, body: yield* Effect.promise(() => valid.json()) }).toMatchObject(
      { status: 200 },
    );
    expect(created).toHaveLength(1);
    const replay = yield* Effect.promise(() => app.handler(request(DEV_TOKEN), context));
    expect(replay.status).toBe(401);
    expect(replay.headers.get("www-authenticate")).toContain("DPoP");
    expect(created).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "only reports renewable expiry for an unrevoked paired bearer on the ticket endpoint",
  () =>
    Effect.gen(function* () {
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const issue = (subject: string) => auth.issueSession({ subject, ttl: Duration.seconds(1) });
      const paired = yield* issue("one-time-token");
      const revoked = yield* issue("one-time-token");
      const guest = yield* issue("guest:test");
      const relay = yield* issue("cloud-connect");
      yield* auth.revokeClientSession(paired.sessionId, revoked.sessionId);
      yield* TestClock.adjust("2 seconds");
      const middleware = yield* Layer.build(AuthHttp.layerAuthenticatedAuth).pipe(
        Effect.map(Context.get(EnvironmentAuthenticatedAuth)),
      );
      const rejected = (token: string) =>
        (
          middleware as unknown as (
            effect: Effect.Effect<void>,
          ) => Effect.Effect<void, EnvironmentAuthInvalidError, HttpServerRequest.HttpServerRequest>
        )(Effect.void).pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              postJson("/api/auth/websocket-ticket/rpc", {}, { authorization: `Bearer ${token}` }),
            ),
          ),
          Effect.flip,
        );
      expect((yield* rejected(paired.token)).pairingExpired).toBe(true);
      for (const token of [revoked.token, guest.token, relay.token, "malformed"]) {
        expect((yield* rejected(token)).pairingExpired).toBeUndefined();
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(layerEnvironmentAuth.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
);
