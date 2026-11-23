import * as Option from "effect/Option";
import * as HttpServerRequest from "effect/http/HttpServerRequest";

const FORWARDING_HEADERS = [
  "cf-connecting-ip",
  "cf-ray",
  "x-forwarded-for",
  "x-real-ip",
  "forwarded",
  "x-forwarded-host",
  "x-forwarded-proto",
];

export function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(
    hostname
      .trim()
      .toLowerCase()
      .replace(/^\[(.*)\]$/, "$1"),
  );
}

/** Forwarded requests can arrive from loopback. Socket locality never overrides proxy evidence. */
export function requestProvenance(input: {
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly hostname: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly protocol?: string | undefined;
}) {
  const hostLocal = input.hostname !== undefined && isLoopbackHostname(input.hostname);
  return {
    socketLocal: ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(input.remoteAddress ?? ""),
    hostLocal,
    localhostHost: hostLocal || (input.hostname?.endsWith(".localhost") ?? false),
    proxied: FORWARDING_HEADERS.some((name) => input.headers[name] !== undefined),
    origin: input.headers.origin,
    protocol: input.protocol,
  };
}

export function httpRequestProvenance(request: HttpServerRequest.HttpServerRequest) {
  const url = Option.getOrUndefined(HttpServerRequest.toURL(request));
  return requestProvenance({
    headers: request.headers,
    hostname: request.headers.host === undefined ? undefined : url?.hostname,
    remoteAddress: Option.getOrUndefined(request.remoteAddress),
    protocol: url?.protocol,
  });
}

/** Host-only transport policy for cookies, including local development hostnames. */
export const hasDirectLocalHost = (request: ReturnType<typeof requestProvenance>) =>
  !request.proxied && request.localhostHost;

/** Local capabilities require both the original loopback host and a direct loopback socket. */
export const isDirectLocalRequest = (request: ReturnType<typeof requestProvenance>) =>
  !request.proxied && request.hostLocal && request.socketLocal;
