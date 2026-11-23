// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as AuthHttp from "./http.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

class AuthOnlyTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const makeDpopKey = () => {
  const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicJwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
  let proofCount = 0;
  return {
    thumbprint: computeDpopJwkThumbprint(publicJwk),
    sign: (input: {
      readonly method: string;
      readonly url: string;
      readonly token?: string;
      readonly iat: number;
    }) => {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk });
      const payload = encode({
        htm: input.method,
        htu: input.url,
        jti: `sec-proof-${++proofCount}`,
        iat: input.iat,
        ...(input.token ? { ath: computeDpopAccessTokenHash(input.token) } : {}),
      });
      const signature = NodeCrypto.sign("sha256", Buffer.from(`${header}.${payload}`), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      return `${header}.${payload}.${signature}`;
    },
  };
};

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-ws-ticket-sec-" });
const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(layerConfig),
);

it.live(
  "keeps DPoP proof-of-possession binding on tickets minted via POST /api/auth/websocket-ticket",
  () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const context = Context.make(Crypto.Crypto, crypto);
      let serverAuth: EnvironmentAuth.EnvironmentAuth["Service"] | undefined;

      const layerRoutes = Layer.mergeAll(
        Layer.effectDiscard(
          EnvironmentAuth.EnvironmentAuth.pipe(
            Effect.tap((auth) =>
              Effect.sync(() => {
                serverAuth = auth;
              }),
            ),
          ),
        ),
        HttpApiBuilder.layer(AuthOnlyTestApi).pipe(
          Layer.provide(AuthHttp.layer),
          Layer.provide(AuthHttp.layerAuthenticatedAuth),
        ),
      ).pipe(
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

      yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
        (web) =>
          Effect.gen(function* () {
            const handle = (request: Request) =>
              Effect.promise(() => web.handler(request, context));
            // Warm the router so serverAuth is captured.
            yield* handle(new Request("http://127.0.0.1/api/auth/session"));

            const dpopKey = makeDpopKey();
            const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1_000);
            const pairing = yield* serverAuth!.issuePairingCredential({
              scopes: ["orchestration:read", "orchestration:operate"],
            });

            // Exchange pairing token for a DPoP-bound access token via POST /oauth/token.
            const tokenRes = yield* handle(
              new Request("http://127.0.0.1/oauth/token", {
                method: "POST",
                headers: {
                  host: "127.0.0.1",
                  "content-type": "application/x-www-form-urlencoded",
                  dpop: dpopKey.sign({
                    method: "POST",
                    url: "http://127.0.0.1/oauth/token",
                    iat: now,
                  }),
                },
                body: new URLSearchParams({
                  grant_type: AuthTokenExchangeGrantType,
                  subject_token: pairing.credential,
                  subject_token_type: AuthEnvironmentBootstrapTokenType,
                  requested_token_type: AuthAccessTokenType,
                }).toString(),
              }),
            );
            expect(tokenRes.status).toBe(200);
            const { access_token: accessToken } = yield* Effect.promise(
              () => tokenRes.json() as Promise<{ access_token: string }>,
            );

            // Call the legacy bare POST /api/auth/websocket-ticket endpoint with DPoP auth.
            const ticketRes = yield* handle(
              new Request("http://127.0.0.1/api/auth/websocket-ticket", {
                method: "POST",
                headers: {
                  host: "127.0.0.1",
                  authorization: `DPoP ${accessToken}`,
                  dpop: dpopKey.sign({
                    method: "POST",
                    url: "http://127.0.0.1/api/auth/websocket-ticket",
                    token: accessToken,
                    iat: now,
                  }),
                },
              }),
            );
            expect(ticketRes.status).toBe(200);
            const { ticket } = yield* Effect.promise(
              () => ticketRes.json() as Promise<{ ticket: string }>,
            );

            // Presenting that ticket on /ws WITHOUT any DPoP proof must be rejected.
            const unprovedUpgradeRequest = HttpServerRequest.fromWeb(
              new Request(
                `http://127.0.0.1/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(ticket)}`,
                {
                  method: "GET",
                  headers: { host: "127.0.0.1" },
                },
              ),
            );
            const upgradeError = yield* Effect.flip(
              serverAuth!.authenticateWebSocketUpgrade(unprovedUpgradeRequest, "rpc"),
            );
            expect(upgradeError._tag).toBe("ServerAuthInvalidCredentialError");
          }),
        (web) => Effect.promise(() => web.dispose()),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
