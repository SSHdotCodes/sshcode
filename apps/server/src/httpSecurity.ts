import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpEffect from "effect/http/HttpEffect";

import { hasDirectLocalHost, httpRequestProvenance } from "./requestProvenance.ts";

export function sessionCookieOptions(request: HttpServerRequest.HttpServerRequest) {
  const provenance = httpRequestProvenance(request);
  // Cookie transport policy does not authorize local capabilities.
  const localHttp = provenance.protocol === "http:" && hasDirectLocalHost(provenance);
  return { httpOnly: true, path: "/", sameSite: "lax", secure: !localHttp } as const;
}

export const layerTransportSecurity = HttpRouter.middleware(
  (httpEffect) =>
    HttpEffect.appendPreResponseHandler((request, response) => {
      const url = HttpServerRequest.toURL(request);
      // Scope HSTS to this host. Do not commit unrelated subdomains or localhost
      // development to HTTPS. Browsers ignore this header on plaintext responses.
      return Effect.succeed(
        Option.isSome(url) && !httpRequestProvenance(request).localhostHost
          ? HttpServerResponse.setHeader(response, "strict-transport-security", "max-age=31536000")
          : response,
      );
    }).pipe(Effect.andThen(httpEffect)),
  { global: true },
);
