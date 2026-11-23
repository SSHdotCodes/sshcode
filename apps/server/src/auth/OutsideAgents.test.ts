import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as AuthHttp from "./http.ts";
import * as McpOAuth from "./McpOAuth.ts";
import * as McpOAuthHttp from "./mcpOAuthHttp.ts";
import * as OutsideAgents from "./OutsideAgents.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

class OAuthTestApi extends HttpApi.make("environment")
  .add(EnvironmentHttpApi.groups.auth)
  .add(EnvironmentHttpApi.groups.mcpOAuth) {}

const layerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "t3-outside-agents-test-" });

interface Services {
  readonly agents: OutsideAgents.OutsideAgents["Service"];
  readonly settings: ServerSettingsService["Service"];
  readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly mcpClients: McpHttpServer.McpClientAuthenticator["Service"];
}

const makeLayerRoutes = (
  on: boolean,
  capture: (services: Services) => void,
  crypto: Crypto.Crypto,
) =>
  Layer.mergeAll(
    Layer.effectDiscard(
      Effect.gen(function* () {
        capture({
          agents: yield* OutsideAgents.OutsideAgents,
          settings: yield* ServerSettingsService,
          auth: yield* EnvironmentAuth.EnvironmentAuth,
          mcpClients: yield* McpHttpServer.McpClientAuthenticator,
        });
      }),
    ),
    HttpApiBuilder.layer(OAuthTestApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(McpOAuthHttp.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    McpOAuthHttp.layerOutsideAgentsGate,
  ).pipe(
    Layer.provideMerge(
      McpOAuth.layerMcpClientAuthenticator.pipe(
        Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
      ),
    ),
    Layer.provideMerge(
      OutsideAgents.layer.pipe(
        Layer.provideMerge(McpOAuth.layer),
        Layer.provide(Layer.succeed(Crypto.Crypto, crypto)),
      ),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest({ outsideAgents: on })),
    Layer.provideMerge(
      EnvironmentAuth.layer.pipe(
        Layer.provide(Sqlite.layerMemory),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(ServerEnvironment.layerIdentity),
        Layer.provide(layerConfig),
      ),
    ),
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
const ORIGIN = "https://box.example.ts.net";
const REDIRECT = "https://agent.example/callback";
const verifier = "a".repeat(43) + "-verifier-for-tests";
/** base64url(SHA-256(verifier)), the S256 challenge for `verifier`. */
const challenge = "DeB41nTVkPwpbbYecrnqtVq7VXLezustdHAK4SWt13c";

/** Requests as they arrive through the relay: plain http with the public Host. */
const at = (path: string, init?: RequestInit) =>
  new Request(`http://127.0.0.1${path}`, {
    ...init,
    headers: { host: "box.example.ts.net", "x-forwarded-proto": "https", ...init?.headers },
  });
const postJson = (path: string, body: unknown) =>
  at(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeJson(body),
  });

type Handler = (request: Request) => Effect.Effect<Response>;

const withRoutes = <A, E>(
  on: boolean,
  use: (handler: Handler, services: Services) => Effect.Effect<A, E>,
  codeDraws?: number[],
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const cryptoService: Crypto.Crypto =
      codeDraws === undefined
        ? crypto
        : {
            ...crypto,
            randomBytes: (size) =>
              size === 2
                ? Effect.sync(() => {
                    const value = codeDraws.shift();
                    if (value === undefined) throw new Error("Code draws exhausted");
                    return new Uint8Array([value >>> 8, value & 255]);
                  })
                : crypto.randomBytes(size),
          };
    const context = Context.make(Crypto.Crypto, cryptoService);
    let services: Services | undefined;
    const layerRoutes = makeLayerRoutes(
      on,
      (captured) => {
        services = captured;
      },
      cryptoService,
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(layerRoutes, { disableLogger: true })),
      (web) =>
        Effect.gen(function* () {
          const handler: Handler = (request) => Effect.promise(() => web.handler(request, context));
          // The router builds its layer on first request.
          yield* handler(at("/oauth/mcp/approval-status", { method: "OPTIONS" }));
          return yield* use(handler, services!);
        }),
      (web) => Effect.promise(() => web.dispose()),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const json = <A>(response: Response) => Effect.promise(() => response.json() as Promise<A>);
const text = (response: Response) => Effect.promise(() => response.text());

const registeredClientId = (handler: Handler) =>
  handler(
    postJson("/oauth/mcp/register", { client_name: "Grok Bot", redirect_uris: [REDIRECT] }),
  ).pipe(
    Effect.flatMap((response) => json<{ client_id: string }>(response)),
    Effect.map((body) => body.client_id),
  );

const authorizeParams = (clientId: string, codeChallenge = challenge) => ({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: codeChallenge,
  code_challenge_method: "S256",
  state: "state-1",
  resource: `${ORIGIN}/mcp`,
});

const approvalPage = (handler: Handler, authorization: Record<string, string>) =>
  handler(postJson("/oauth/mcp/approval", authorization)).pipe(
    Effect.flatMap((response) =>
      json<{
        message?: string;
        clientName?: string;
        pendingApproval?: { id: string; pollSecret: string; code: string };
        inAppUnavailable?: string;
      }>(response).pipe(Effect.map((body) => ({ status: response.status, ...body }))),
    ),
  );

const poll = (
  handler: Handler,
  authorization: Record<string, string>,
  pending: { id: string; pollSecret: string },
) =>
  handler(postJson("/oauth/mcp/approval-status", { authorization, ...pending })).pipe(
    Effect.flatMap((response) =>
      json<{ pending?: true; redirectTo?: string; message?: string }>(response).pipe(
        Effect.map((body) => ({ status: response.status, ...body })),
      ),
    ),
  );

it.live("keeps every sign-in door shut while outside agents are off", () =>
  withRoutes(false, (handler) =>
    Effect.gen(function* () {
      for (const path of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
      ]) {
        expect((yield* handler(at(path))).status).toBe(404);
      }
      const registered = yield* handler(
        postJson("/oauth/mcp/register", { client_name: "Grok Bot", redirect_uris: [REDIRECT] }),
      );
      expect(registered.status).toBe(403);
      expect(yield* json<unknown>(registered)).toMatchObject({ error: "access_denied" });

      const authorize = yield* handler(at("/oauth/mcp/authorize?response_type=code"));
      expect(authorize.status).toBe(403);
      expect(yield* text(authorize)).toContain("Outside agents are off");

      const page = yield* approvalPage(handler, { client_id: "x" });
      expect(page.status).toBe(400);
      expect(page.message).toContain("Settings → Connections → Outside agents");
    }),
  ),
);

it.live("hands a sign-in to the app and gives the answer only to the page that asked", () =>
  withRoutes(true, (handler, { agents }) =>
    Effect.gen(function* () {
      yield* agents.command({ _tag: "accept-new" });
      const clientId = yield* registeredClientId(handler);
      const authorization = authorizeParams(clientId);
      const page = yield* approvalPage(handler, authorization);
      expect(page.status).toBe(200);
      expect(page.clientName).toBe("Grok Bot");
      const pending = page.pendingApproval!;
      expect(pending.pollSecret.length).toBeGreaterThanOrEqual(40);

      // Repeating the request's (public) parameters replaces it with new credentials:
      // the earlier ones stop working and no second prompt appears.
      const reloaded = (yield* approvalPage(handler, authorization)).pendingApproval!;
      expect(reloaded.pollSecret).not.toBe(pending.pollSecret);
      expect(reloaded.code).not.toBe(pending.code);
      expect((yield* poll(handler, authorization, pending)).status).toBe(400);
      Object.assign(pending, reloaded);
      const waiting = yield* agents.state;
      expect(waiting.pending).toHaveLength(1);
      expect(waiting.pending[0]).toMatchObject({
        id: pending.id,
        clientName: "Grok Bot",
        redirectHost: "agent.example",
      });

      expect(yield* poll(handler, authorization, pending)).toEqual({
        status: 200,
        pending: true,
      });
      const guessed = yield* poll(handler, authorization, {
        ...pending,
        pollSecret: "A".repeat(43),
      });
      expect(guessed.status).toBe(400);
      // Another request (here: another PKCE challenge) cannot read this one's answer.
      const other = authorizeParams(clientId, "B".repeat(43));
      expect((yield* poll(handler, other, pending)).status).toBe(400);

      const answered = yield* agents.command({
        _tag: "approve",
        id: pending.id,
        code: pending.code,
        access: "approval-required",
      });
      expect(answered.pending).toHaveLength(0);
      expect(
        (yield* Effect.flip(
          agents.command({
            _tag: "approve",
            id: pending.id,
            code: pending.code,
            access: "read-only",
          }),
        )).message,
      ).toContain("already answered");

      const done = yield* poll(handler, authorization, pending);
      expect(done.status).toBe(200);
      const callback = new URL(done.redirectTo!);
      expect(callback.origin + callback.pathname).toBe(REDIRECT);
      expect(callback.searchParams.get("state")).toBe("state-1");
      // The answer is handed out once.
      expect((yield* poll(handler, authorization, pending)).status).toBe(400);

      const token = yield* handler(
        at("/oauth/mcp/token", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            code: callback.searchParams.get("code")!,
            redirect_uri: REDIRECT,
            client_id: clientId,
            code_verifier: verifier,
            resource: `${ORIGIN}/mcp`,
          }).toString(),
        }),
      );
      expect(token.status).toBe(200);
      expect(yield* json<unknown>(token)).toMatchObject({
        token_type: "Bearer",
        scope: "orchestration:read orchestration:operate",
      });
    }),
  ),
);

it.live("sends a denial from the app back to the agent", () =>
  withRoutes(true, (handler, { agents }) =>
    Effect.gen(function* () {
      yield* agents.command({ _tag: "accept-new" });
      const authorization = authorizeParams(yield* registeredClientId(handler));
      const pending = (yield* approvalPage(handler, authorization)).pendingApproval!;
      yield* agents.command({ _tag: "deny", id: pending.id });
      const done = yield* poll(handler, authorization, pending);
      expect(new URL(done.redirectTo!).searchParams.get("error")).toBe("access_denied");
      const again = yield* Effect.flip(agents.command({ _tag: "deny", id: pending.id }));
      expect(again.message).toContain("expired or was already answered");
    }),
  ),
);

it.live("bounds how many sign-ins can wait", () =>
  withRoutes(true, (handler, { agents }) =>
    Effect.gen(function* () {
      yield* agents.command({ _tag: "accept-new" });
      const clientId = yield* registeredClientId(handler);
      for (let index = 0; index < 5; index += 1) {
        const page = yield* approvalPage(
          handler,
          authorizeParams(clientId, String(index).repeat(43)),
        );
        expect(page.pendingApproval).toBeDefined();
      }
      const sixth = yield* approvalPage(handler, authorizeParams(clientId, "9".repeat(43)));
      // The page falls back to a pairing code and says why.
      expect(sixth.status).toBe(200);
      expect(sixth.pendingApproval).toBeUndefined();
      expect(sixth.inAppUnavailable).toContain("Too many sign-ins are waiting");
    }),
  ),
);

it.live("turning outside agents off hides waiting sign-ins and refuses answers", () =>
  withRoutes(true, (handler, { agents, settings }) =>
    Effect.gen(function* () {
      yield* agents.command({ _tag: "accept-new" });
      const authorization = authorizeParams(yield* registeredClientId(handler));
      const pending = (yield* approvalPage(handler, authorization)).pendingApproval!;
      yield* settings.updateSettings({ outsideAgents: false });

      expect(yield* agents.state).toEqual({ enabled: false, acceptingUntil: null, pending: [] });
      const refused = yield* Effect.flip(
        agents.command({
          _tag: "approve",
          id: pending.id,
          code: pending.code,
          access: "full-access",
        }),
      );
      expect(refused.message).toContain("Outside agents are off");
      expect((yield* poll(handler, authorization, pending)).status).toBe(400);
      expect((yield* handler(at("/.well-known/oauth-authorization-server"))).status).toBe(404);
    }),
  ),
);

it.live("an agent's token stops working while outside agents are off", () =>
  withRoutes(true, (_handler, { auth, mcpClients, settings }) =>
    Effect.gen(function* () {
      const issued = yield* auth.issueMcpClientSession({
        label: "Grok Bot",
        access: "approval-required",
        client: { deviceType: "bot" },
      });
      const request = HttpServerRequest.fromWeb(
        new Request("http://127.0.0.1/mcp", {
          headers: { authorization: `Bearer ${issued.token}` },
        }),
      );
      expect(yield* mcpClients.authenticate(request)).toBeDefined();
      yield* settings.updateSettings({ outsideAgents: false });
      expect(yield* mcpClients.authenticate(request)).toBeUndefined();
      yield* settings.updateSettings({ outsideAgents: true });
      expect(yield* mcpClients.authenticate(request)).toBeDefined();
    }),
  ),
);

it.live("takes new sign-ins only while the owner asked for them", () =>
  withRoutes(true, (handler, { agents }) =>
    Effect.gen(function* () {
      const clientId = yield* registeredClientId(handler);
      const closed = yield* approvalPage(handler, authorizeParams(clientId));
      expect(closed.status).toBe(200);
      expect(closed.pendingApproval).toBeUndefined();
      expect(closed.inAppUnavailable).toContain("Connect an agent");
      expect((yield* agents.state).pending).toHaveLength(0);

      const opened = yield* agents.command({ _tag: "accept-new" });
      expect(opened.acceptingUntil).toBeGreaterThan(yield* Clock.currentTimeMillis);
      expect(
        (yield* approvalPage(handler, authorizeParams(clientId))).pendingApproval,
      ).toBeDefined();

      const stopped = yield* agents.command({ _tag: "stop-accepting" });
      expect(stopped.acceptingUntil).toBeNull();
      // Requests already waiting can still be answered; new ones fall back to a pairing code.
      expect(stopped.pending).toHaveLength(1);
      const later = yield* approvalPage(handler, authorizeParams(clientId, "C".repeat(43)));
      expect(later.inAppUnavailable).toContain("isn't taking new agents");
    }),
  ),
);

it.live("no path spelling gets past the switch while outside agents are off", () =>
  withRoutes(false, (handler) =>
    Effect.gen(function* () {
      const body = { client_name: "Grok Bot", redirect_uris: [REDIRECT] };
      for (const path of [
        "/oauth/mcp/register/",
        "/OAUTH/MCP/REGISTER",
        "/oauth//mcp/register",
        "//oauth/mcp/register",
        "/oauth/mcp/%72egister",
        "/oauth/mcp/register;x",
      ]) {
        const response = yield* handler(postJson(path, body));
        expect([400, 403, 404]).toContain(response.status);
        expect(yield* text(response)).not.toContain("client_id");
      }
      for (const path of ["/OAUTH/MCP/TOKEN", "/oauth/mcp/%74oken", "/oauth/mcp/token;x"]) {
        const response = yield* handler(
          at(path, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "grant_type=authorization_code&code=x&redirect_uri=x&client_id=x&code_verifier=x",
          }),
        );
        expect([400, 403, 404]).toContain(response.status);
        expect(yield* text(response)).not.toContain("access_token");
      }
      for (const path of [
        "//.well-known/oauth-authorization-server",
        "/.WELL-KNOWN/oauth-authorization-server",
        "/.well-known/oauth-authorization-server/",
        "/.well-known/oauth-protected-resource;x/mcp",
      ]) {
        expect(yield* text(yield* handler(at(path)))).not.toContain("authorization_endpoint");
      }
    }),
  ),
);

it("normalizes every spelling of a sign-in path the router would accept", () => {
  for (const url of [
    "/oauth/mcp/register",
    "//oauth/mcp/register",
    "/OAUTH/MCP/REGISTER/",
    "/oauth//mcp/%72egister?x=1",
    "/oauth/mcp/register;x#y",
    "http://example.test/oauth/mcp/register",
  ]) {
    expect(McpOAuthHttp.routedPath(url)).toBe("/oauth/mcp/register");
  }
  expect(McpOAuthHttp.routedPath("/")).toBe("/");
  expect(McpOAuthHttp.routedPath("//")).toBe("/");
});

it.live("requires the browser code before claiming, and approves only its matching request", () =>
  withRoutes(true, (handler, { agents }) =>
    Effect.gen(function* () {
      yield* agents.command({ _tag: "accept-new" });
      const clientId = yield* registeredClientId(handler);
      const firstAuth = authorizeParams(clientId);
      const secondAuth = authorizeParams(clientId, "B".repeat(43));
      const first = (yield* approvalPage(handler, firstAuth)).pendingApproval!;
      const second = (yield* approvalPage(handler, secondAuth)).pendingApproval!;
      expect(first.code).toMatch(/^[0-9]{4}$/);
      expect(first.code).not.toBe(second.code);
      const missing = yield* Effect.flip(
        agents.command({ _tag: "approve", id: first.id, access: "read-only" }),
      );
      expect(missing._tag).toBe("OutsideAgentsError");
      expect(missing.message).toContain("Update SSHCode");
      for (const code of [second.code, "bad", "", first.code + "0"]) {
        const wrong = yield* Effect.flip(
          agents.command({ _tag: "approve", id: first.id, code, access: "read-only" }),
        );
        expect(wrong._tag).toBe("OutsideAgentsError");
        expect(wrong.message).toContain("does not match");
        expect((yield* agents.state).pending.map((request) => request.id)).toEqual([
          first.id,
          second.id,
        ]);
        expect(yield* poll(handler, firstAuth, first)).toEqual({ status: 200, pending: true });
        expect(yield* poll(handler, secondAuth, second)).toEqual({ status: 200, pending: true });
      }
      const approved = yield* agents.command({
        _tag: "approve",
        id: second.id,
        code: second.code,
        access: "read-only",
      });
      expect(approved.pending.map((request) => request.id)).toEqual([first.id]);
      expect(yield* poll(handler, firstAuth, first)).toEqual({ status: 200, pending: true });
      expect((yield* poll(handler, secondAuth, second)).redirectTo).toBeDefined();
    }),
  ),
);

it.live("rejects biased draws and collisions, including a replaced request's code", () => {
  const draws = [65535, 60000, 0, 0, 1, 1, 0, 2, 9999, 59999, 3, 4];
  return withRoutes(
    true,
    (handler, { agents }) =>
      Effect.gen(function* () {
        yield* agents.command({ _tag: "accept-new" });
        const clientId = yield* registeredClientId(handler);
        const firstAuth = authorizeParams(clientId);
        const first = (yield* approvalPage(handler, firstAuth)).pendingApproval!;
        expect(first.code).toBe("0000");
        const second = (yield* approvalPage(handler, authorizeParams(clientId, "B".repeat(43))))
          .pendingApproval!;
        expect(second.code).toBe("0001");
        const replacement = (yield* approvalPage(handler, firstAuth)).pendingApproval!;
        expect(replacement.code).toBe("0002");
        expect((yield* poll(handler, firstAuth, first)).status).toBe(400);
        for (const challenge of ["C", "D", "E"]) {
          expect(
            (yield* approvalPage(handler, authorizeParams(clientId, challenge.repeat(43))))
              .pendingApproval,
          ).toBeDefined();
        }
        const codes = (yield* agents.state).pending.map((request) => request.code);
        expect(new Set(codes).size).toBe(5);
        expect(codes).toEqual(["0001", "0002", "9999", "0003", "0004"]);
        expect(draws).toEqual([]);
      }),
    draws,
  );
});

it.live("public routes reveal only the registering page's code", () =>
  withRoutes(true, (handler, { agents }) =>
    Effect.gen(function* () {
      yield* agents.command({ _tag: "accept-new" });
      const clientId = yield* registeredClientId(handler);
      const firstAuth = authorizeParams(clientId);
      const first = (yield* approvalPage(handler, firstAuth)).pendingApproval!;
      const otherAuth = authorizeParams(clientId, "B".repeat(43));
      const other = (yield* approvalPage(handler, otherAuth)).pendingApproval!;
      expect(Object.keys(other).sort()).toEqual(["code", "id", "pollSecret"]);
      expect(other.code).not.toBe(first.code);
      expect((yield* agents.state).pending.find((request) => request.id === first.id)?.code).toBe(
        first.code,
      );
      expect(yield* poll(handler, firstAuth, first)).toEqual({ status: 200, pending: true });
      const stolen = yield* poll(handler, firstAuth, {
        id: first.id,
        pollSecret: other.pollSecret,
      });
      expect(stolen.status).toBe(400);
      expect(Object.keys(stolen).sort()).toEqual(["_tag", "message", "status"]);
      for (const path of [
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-authorization-server",
      ]) {
        const body = yield* json<Record<string, unknown>>(yield* handler(at(path)));
        expect(body).not.toHaveProperty("pendingApproval");
        expect(body).not.toHaveProperty("code");
      }
      const authorize = yield* handler(
        at(`/oauth/mcp/authorize?${new URLSearchParams(firstAuth)}`),
      );
      expect(authorize.status).toBe(302);
      expect(authorize.headers.get("location")).toBe(
        `/connect-agent?${new URLSearchParams(firstAuth)}`,
      );
      const denied = yield* handler(
        postJson("/oauth/mcp/decision", { authorization: otherAuth, decision: { _tag: "deny" } }),
      );
      expect(Object.keys(yield* json<Record<string, unknown>>(denied))).toEqual(["redirectTo"]);
      // The public denial path does not approve or disclose the app's pending requests.
      expect((yield* agents.state).pending).toHaveLength(2);
    }),
  ),
);
