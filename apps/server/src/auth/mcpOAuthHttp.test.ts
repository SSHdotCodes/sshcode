import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerHttp from "../http.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuth from "./McpOAuth.ts";
import * as McpOAuthHttp from "./mcpOAuthHttp.ts";
import * as OutsideAgents from "./OutsideAgents.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import * as AuthHttp from "./http.ts";

class McpOAuthCorsTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const LOCAL_HOST = "127.0.0.1:3773";
const UNTRUSTED_ORIGIN = "https://untrusted.example";
const CHALLENGE = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";
const REDIRECT_URI = "https://agent.example/callback";

// Production config: devUrl is undefined, matching packaged desktop, CLI, and T3 Connect hosts.
const layerProdConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-mcp-oauth-http-",
});

const layerEnvironmentAuth = EnvironmentAuth.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerEnvironment.layerIdentity),
  Layer.provide(layerProdConfig),
);

const makeLayerRoutes = (
  capture: (outsideAgents: OutsideAgents.OutsideAgents["Service"]) => void,
) =>
  Layer.mergeAll(
    Layer.effectDiscard(
      OutsideAgents.OutsideAgents.pipe(Effect.tap((svc) => Effect.sync(() => capture(svc)))),
    ),
    HttpApiBuilder.layer(McpOAuthCorsTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(McpOAuthHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
  ).pipe(
    Layer.provide(ServerHttp.layerBrowserApiCors),
    Layer.provide(
      OutsideAgents.layer.pipe(
        Layer.provideMerge(McpOAuth.layer),
        Layer.provide(ServerSettingsService.layerTest({ outsideAgents: true })),
      ),
    ),
    Layer.provideMerge(layerEnvironmentAuth),
    Layer.provide(layerProdConfig),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

type Send = (
  path: string,
  init?: { readonly headers?: Record<string, string>; readonly body?: unknown },
) => Effect.Effect<Response>;

/** Serves the MCP OAuth routes with outside agents taking sign-ins. */
const withServer = <A>(
  use: (send: Send, outsideAgents: OutsideAgents.OutsideAgents["Service"]) => Effect.Effect<A>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const context = Context.make(Crypto.Crypto, crypto);
    let outsideAgents: OutsideAgents.OutsideAgents["Service"] | undefined;
    const layerRoutes = makeLayerRoutes((svc) => {
      outsideAgents = svc;
    });
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (web) =>
        Effect.gen(function* () {
          const send: Send = (path, init) =>
            Effect.promise(() =>
              web.handler(
                new Request(`http://${init?.headers?.host ?? LOCAL_HOST}${path}`, {
                  ...(init?.body === undefined
                    ? {}
                    : { method: "POST", body: encodeJson(init.body) }),
                  headers: {
                    host: LOCAL_HOST,
                    ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
                    ...init?.headers,
                  },
                }),
                context,
              ),
            );
          // Builds the layer, so the service is captured.
          yield* send("/.well-known/oauth-authorization-server");
          yield* outsideAgents!.command({ _tag: "accept-new" });
          return yield* use(send, outsideAgents!);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const register = (send: Send, headers: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const response = yield* send("/oauth/mcp/register", {
      headers,
      body: { client_name: "Agent", redirect_uris: [REDIRECT_URI] },
    });
    expect(response.status).toBe(201);
    return yield* Effect.promise(() => response.json() as Promise<{ client_id: string }>);
  });

const authorization = (clientId: string, host = LOCAL_HOST, scheme = "http") => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT_URI,
  code_challenge: CHALLENGE,
  code_challenge_method: "S256",
  state: "state",
  resource: `${scheme}://${host}/mcp`,
});

interface ApprovalBody {
  readonly message?: string;
  readonly pendingApproval?: { readonly id: string; readonly pollSecret: string };
}

const readJson = (response: Response) =>
  Effect.promise(() => response.json() as Promise<ApprovalBody>);

const expectRefused = (response: Response) =>
  Effect.gen(function* () {
    expect(response.status).toBe(400);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    const body = yield* readJson(response);
    expect(body.message).toBe("Open this sign-in from the link the agent gave you.");
    return body;
  });

it.live("answers register from another site without letting the page read it", () =>
  withServer((send) =>
    Effect.gen(function* () {
      const response = yield* send("/oauth/mcp/register", {
        headers: { origin: UNTRUSTED_ORIGIN },
        body: { client_name: "Spoofed Agent", redirect_uris: [`${UNTRUSTED_ORIGIN}/callback`] },
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();

      const preflight = yield* send("/OAUTH/mcp//token", {
        headers: {
          origin: UNTRUSTED_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    }),
  ),
);

it.live("refuses the approval page's calls from another site", () =>
  withServer((send, outsideAgents) =>
    Effect.gen(function* () {
      const { client_id } = yield* register(send);
      const request = authorization(client_id);
      const foreign = { origin: UNTRUSTED_ORIGIN };

      const approval = yield* send("/oauth/mcp/approval", { headers: foreign, body: request });
      expect((yield* expectRefused(approval)).pendingApproval).toBeUndefined();
      // No prompt reached the app.
      expect((yield* outsideAgents.state).pending).toEqual([]);

      // The same browser from the server's own page gets a prompt to poll.
      const own = yield* send("/oauth/mcp/approval", {
        headers: { origin: `http://${LOCAL_HOST}` },
        body: request,
      });
      expect(own.status).toBe(200);
      const pending = (yield* readJson(own)).pendingApproval!;
      expect(pending.pollSecret).toBeTruthy();

      const status = yield* send("/oauth/mcp/approval-status", {
        headers: foreign,
        body: { authorization: request, id: pending.id, pollSecret: pending.pollSecret },
      });
      yield* expectRefused(status);

      const decision = yield* send("/oauth/mcp/decision", {
        headers: foreign,
        body: { authorization: request, decision: { _tag: "deny" } },
      });
      yield* expectRefused(decision);

      const ownStatus = yield* send("/oauth/mcp/approval-status", {
        headers: { "sec-fetch-site": "same-origin", origin: "http://localhost:5733" },
        body: { authorization: request, id: pending.id, pollSecret: pending.pollSecret },
      });
      expect(ownStatus.status).toBe(200);
    }),
  ),
);

it.live("serves the approval page over T3 Connect, the desktop app and outside apps", () =>
  withServer((send) =>
    Effect.gen(function* () {
      const relayHost = "devbox.connect.example";
      const relayed = {
        host: relayHost,
        origin: `https://${relayHost}`,
        "x-forwarded-proto": "https",
        "cf-connecting-ip": "203.0.113.7",
      };
      const { client_id } = yield* register(send, relayed);
      const overRelay = yield* send("/oauth/mcp/approval", {
        headers: relayed,
        body: authorization(client_id, relayHost, "https"),
      });
      expect(overRelay.status).toBe(200);
      expect((yield* readJson(overRelay)).pendingApproval).toBeDefined();

      const desktop = yield* send("/oauth/mcp/approval", {
        headers: { origin: "t3code://app" },
        body: authorization(client_id),
      });
      expect(desktop.status).toBe(200);
      expect(desktop.headers.get("access-control-allow-origin")).toBe("t3code://app");

      // An outside app's own process sends no Origin.
      const direct = yield* send("/oauth/mcp/approval", { body: authorization(client_id) });
      expect(direct.status).toBe(200);
    }),
  ),
);
