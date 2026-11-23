import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

/** Origins of the Electron renderer, packaged and dev. */
export const DESKTOP_RENDERER_ORIGINS = ["t3code://app", "t3code-dev://app"] as const;

/** MCP refuses every browser Origin with 403, so the browser CORS layer must not answer for it. */
export const MCP_HTTP_PATH = "/mcp";

/** Browser pages MCP OAuth answers besides the server's own: none, so no other site reads them. */
export const MCP_OAUTH_PATH_PREFIX = "/oauth/mcp/";

/**
 * Pages the server or its dev setup serves itself, besides the server's own
 * origin. Other origins on the same site (another localhost port, a LAN IP's
 * other ports) are not among them.
 */
export const appBrowserOrigins = (config: {
  readonly devUrl?: URL | undefined;
  readonly devAllowedOrigins: ReadonlyArray<string>;
}): ReadonlySet<string> =>
  new Set([
    ...(config.devUrl ? [config.devUrl.origin] : []),
    ...DESKTOP_RENDERER_ORIGINS,
    ...config.devAllowedOrigins,
  ]);

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim().toLowerCase();
  return first && first.length > 0 ? first : undefined;
}

/**
 * Whether a browser request comes from a page of this app. Browsers send
 * `Origin` on WebSocket upgrades, cross-origin requests, and non-GET requests,
 * so an absent header means a same-origin read or a non-browser client.
 * Otherwise the request must be same-origin by the browser's own
 * `Sec-Fetch-Site` (which survives the dev proxy rewriting `Host`), come from
 * this server's own host (directly, through T3 Connect, or behind a proxy that
 * reports `X-Forwarded-Host`), or come from one of `appOrigins`.
 */
export function isAppBrowserRequest(
  request: HttpServerRequest.HttpServerRequest,
  appOrigins: ReadonlySet<string>,
): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  if (request.headers["sec-fetch-site"] === "same-origin") return true;
  if (appOrigins.has(origin)) return true;
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false;
  }
  if (originHost === "") return false;
  return (
    originHost === firstHeaderValue(request.headers.host) ||
    originHost === firstHeaderValue(request.headers["x-forwarded-host"])
  );
}
