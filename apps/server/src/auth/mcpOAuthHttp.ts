import {
  AuthMcpApprovalError,
  type AuthMcpAuthorizationRequest,
  AuthMcpClientAccess,
  AuthMcpClientRegistration,
  AuthMcpRegistrationError,
  AuthMcpTokenError,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerConfig from "../config.ts";
import { appBrowserOrigins, isAppBrowserRequest } from "../httpCors.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as McpOAuth from "./McpOAuth.ts";
import * as OutsideAgents from "./OutsideAgents.ts";
import { renderErrorPage } from "./mcpOAuthHtml.ts";

const OFF_DESCRIPTION =
  "Outside agents are off in SSHCode. Turn them on in Settings → Connections → Outside agents, then sign in again.";

/** Where the approval page lives in the web app. */
const APPROVAL_PAGE_PATH = "/connect-agent";

const PAGE_HEADERS = {
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

/** OAuth responses carry codes, tokens and client ids, none of which may be cached. */
const noStore = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(
    HttpServerResponse.setHeaders(response, { "cache-control": "no-store", pragma: "no-cache" }),
  ),
);

/** Issuer and resource for the origin this request reached. */
const requestUrls = Effect.map(HttpServerRequest.HttpServerRequest, McpOAuth.requestUrls);
// Decoded by the handler so malformed metadata gets the RFC 7591 error, not HttpApi's empty 400.
const decodeClientRegistration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(AuthMcpClientRegistration),
);

/**
 * Validates the request the approval page forwards. An unverified client or
 * redirect is reported, never redirected; any other problem goes back to the
 * agent through its (verified) redirect URI.
 */
const forwardedAuthorization = (
  oauth: McpOAuth.McpOAuth["Service"],
  request: AuthMcpAuthorizationRequest,
) =>
  Effect.gen(function* () {
    const urls = yield* requestUrls;
    return yield* oauth.validateAuthorization({ urls, request }).pipe(
      Effect.catchTags({
        McpOAuthPageError: (error) =>
          Effect.fail(new AuthMcpApprovalError({ message: error.description })),
        McpOAuthRedirectError: (error) =>
          Effect.succeed({ redirectTo: McpOAuth.redirectForError(error, urls.issuer) }),
      }),
    );
  });

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "mcpOAuth",
  Effect.fnUntraced(function* (handlers) {
    const oauth = yield* McpOAuth.McpOAuth;
    const outsideAgents = yield* OutsideAgents.OutsideAgents;
    const appOrigins = appBrowserOrigins(yield* ServerConfig.ServerConfig);
    /**
     * The approval page's calls come from the page this server serves, or the
     * desktop app. Another site could otherwise put a sign-in prompt in the app
     * and read the code it shows.
     */
    const requireAppPage = (request: HttpServerRequest.HttpServerRequest) =>
      isAppBrowserRequest(request, appOrigins)
        ? Effect.void
        : Effect.fail(
            new AuthMcpApprovalError({
              message: "Open this sign-in from the link the agent gave you.",
            }),
          );
    /** The approval page's calls answer in its own words while outside agents are off. */
    const requireOn = Effect.flatMap(outsideAgents.enabled, (on) =>
      on
        ? Effect.void
        : Effect.fail(
            new AuthMcpApprovalError({
              message:
                "Outside agents are off in SSHCode. Turn them on in Settings → Connections → Outside agents, then start the sign-in again from the agent.",
            }),
          ),
    );
    /** Every handler checks the setting itself; the path gate below only covers discovery. */
    const refuseWhileOff = <E>(error: E) =>
      Effect.flatMap(outsideAgents.enabled, (on) => (on ? Effect.void : Effect.fail(error)));
    const protectedResource = () =>
      requestUrls.pipe(Effect.map(McpOAuth.protectedResourceMetadata));

    return (
      handlers
        .handle("protectedResource", protectedResource)
        .handle("mcpProtectedResource", protectedResource)
        .handle("authorizationServer", () =>
          requestUrls.pipe(Effect.map(McpOAuth.authorizationServerMetadata)),
        )
        .handleRaw("register", ({ request }) =>
          refuseWhileOff(
            new AuthMcpRegistrationError({
              error: "invalid_client_metadata",
              error_description: OFF_DESCRIPTION,
            }),
          ).pipe(
            Effect.andThen(request.text.pipe(Effect.orDie)),
            Effect.flatMap((text) =>
              decodeClientRegistration(text).pipe(
                Effect.mapError(
                  (cause) =>
                    new AuthMcpRegistrationError({
                      error: "invalid_client_metadata",
                      error_description: `Invalid client metadata: ${cause.message}`,
                    }),
                ),
              ),
            ),
            Effect.flatMap(oauth.register),
            Effect.map((client) => ({
              client_id: client.clientId,
              client_name: client.name,
              redirect_uris: client.redirectUris,
              grant_types: ["authorization_code" as const],
              response_types: ["code" as const],
              token_endpoint_auth_method: "none" as const,
            })),
            Effect.tap(() => noStore),
          ),
        )
        // The browser lands here from the agent. A valid request is handed to the
        // web app's approval page with its query intact.
        .handleRaw("authorize", ({ request }) =>
          Effect.gen(function* () {
            if (!(yield* outsideAgents.enabled)) {
              return HttpServerResponse.text(renderErrorPage(OFF_DESCRIPTION), {
                status: 403,
                contentType: "text/html; charset=utf-8",
                headers: PAGE_HEADERS,
              });
            }
            const urls = yield* requestUrls;
            const url = new URL(request.url, urls.issuer);
            const authorization = yield* oauth
              .validateAuthorization({ urls, request: Object.fromEntries(url.searchParams) })
              .pipe(Effect.result);
            const headers = { "cache-control": "no-store", "referrer-policy": "no-referrer" };
            if (Result.isSuccess(authorization)) {
              return HttpServerResponse.redirect(`${APPROVAL_PAGE_PATH}${url.search}`, { headers });
            }
            const error = authorization.failure;
            return error._tag === "McpOAuthPageError"
              ? HttpServerResponse.text(renderErrorPage(error.description), {
                  status: 400,
                  contentType: "text/html; charset=utf-8",
                  headers: PAGE_HEADERS,
                })
              : HttpServerResponse.redirect(McpOAuth.redirectForError(error, urls.issuer), {
                  headers,
                });
          }),
        )
        // What the approval page shows, and whether one click may approve.
        .handle("approval", ({ payload, request }) =>
          Effect.gen(function* () {
            yield* requireAppPage(request);
            yield* requireOn;
            const resolved = yield* forwardedAuthorization(oauth, payload);
            if ("redirectTo" in resolved) return resolved;
            const urls = yield* requestUrls;
            const session = yield* oauth.approvingBrowserSession(request, resolved);
            // A browser that cannot approve hands the sign-in to the SSHCode app.
            const inApp =
              session === undefined
                ? yield* Effect.result(outsideAgents.request(resolved))
                : undefined;
            yield* noStore;
            return {
              clientName: resolved.client.name,
              redirectHost: new URL(resolved.redirectUri).host,
              environmentHost: new URL(urls.issuer).host,
              ...(inApp === undefined
                ? {}
                : Result.isSuccess(inApp)
                  ? { pendingApproval: inApp.success }
                  : { inAppUnavailable: inApp.failure.message }),
              ...(session === undefined
                ? {}
                : {
                    csrfToken: session.csrfToken,
                    oneClickAccess: AuthMcpClientAccess.literals.filter((access) =>
                      EnvironmentAuth.mcpClientScopes(access).every((scope) =>
                        session.scopes.includes(scope),
                      ),
                    ),
                  }),
            };
          }),
        )
        .handle("approvalStatus", ({ payload, request }) =>
          Effect.gen(function* () {
            yield* requireAppPage(request);
            yield* requireOn;
            const resolved = yield* forwardedAuthorization(oauth, payload.authorization);
            if ("redirectTo" in resolved) return resolved;
            yield* noStore;
            const answer = yield* outsideAgents
              .status({ id: payload.id, pollSecret: payload.pollSecret, authorization: resolved })
              .pipe(
                Effect.mapError((error) => new AuthMcpApprovalError({ message: error.message })),
              );
            return answer === undefined ? { pending: true as const } : { redirectTo: answer };
          }),
        )
        .handle("decision", ({ payload, request }) =>
          Effect.gen(function* () {
            yield* requireAppPage(request);
            yield* requireOn;
            const resolved = yield* forwardedAuthorization(oauth, payload.authorization);
            if ("redirectTo" in resolved) return resolved;
            yield* noStore;
            const { decision } = payload;
            if (decision._tag === "deny") return { redirectTo: oauth.deny(resolved) };
            return yield* oauth.approve({ request, authorization: resolved, decision }).pipe(
              Effect.map((redirectTo) => ({ redirectTo })),
              Effect.mapError((error) => new AuthMcpApprovalError({ message: error.message })),
            );
          }),
        )
        .handle("token", ({ payload, request }) =>
          Effect.gen(function* () {
            yield* refuseWhileOff(
              new AuthMcpTokenError({ error: "invalid_grant", error_description: OFF_DESCRIPTION }),
            );
            yield* noStore;
            return yield* oauth.exchangeCode({ request, urls: yield* requestUrls, token: payload });
          }),
        )
    );
  }),
);

/**
 * The path as the router matches it: case, percent-encoding, repeated or
 * trailing slashes and `;` parameters do not change the route, so none of
 * them may slip past the gate.
 */
export const routedPath = (url: string) => {
  // Not `new URL(url, base)`: that reads a leading `//oauth/...` as a host name.
  let path = /^https?:\/\//i.test(url) ? new URL(url).pathname : url.replace(/[?#].*$/s, "");
  try {
    path = decodeURIComponent(path);
  } catch {
    // An undecodable path matches no route either.
  }
  const normalized = path
    .toLowerCase()
    .replace(/;[^/]*/g, "")
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "");
  return normalized === "" ? "/" : normalized;
};

/** Discovery answers "no sign-in here"; the rest refuse in OAuth's own terms. */
const GATED_PATHS = new Map<string, "missing" | "refused" | "page">([
  ["/.well-known/oauth-protected-resource", "missing"],
  ["/.well-known/oauth-protected-resource/mcp", "missing"],
  ["/.well-known/oauth-authorization-server", "missing"],
  ["/oauth/mcp/register", "refused"],
  ["/oauth/mcp/token", "refused"],
  ["/oauth/mcp/authorize", "page"],
]);

/**
 * While outside agents are off, an agent finds no way to sign in. The
 * approval page's own calls stay open and explain the setting instead.
 */
export const layerOutsideAgentsGate = Layer.unwrap(
  Effect.map(OutsideAgents.OutsideAgents, (outsideAgents) =>
    HttpRouter.middleware(
      (httpEffect) =>
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const gate = GATED_PATHS.get(routedPath(request.url));
          if (gate === undefined || (yield* outsideAgents.enabled)) return yield* httpEffect;
          if (gate === "page") {
            return HttpServerResponse.text(renderErrorPage(OFF_DESCRIPTION), {
              status: 403,
              contentType: "text/html; charset=utf-8",
              headers: PAGE_HEADERS,
            });
          }
          return HttpServerResponse.jsonUnsafe(
            gate === "missing"
              ? { error: "not_found", error_description: OFF_DESCRIPTION }
              : { error: "access_denied", error_description: OFF_DESCRIPTION },
            { status: gate === "missing" ? 404 : 403, headers: { "cache-control": "no-store" } },
          );
        }),
      { global: true },
    ),
  ),
);
