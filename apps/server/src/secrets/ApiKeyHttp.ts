import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { httpRequestProvenance, isDirectLocalRequest } from "../requestProvenance.ts";
import * as ApiKeyStore from "./ApiKeyStore.ts";

/** Separate from MCP results and environment RPCs: only a local, one-use CLI ticket can read it. */
export const layer = HttpRouter.add(
  "POST",
  "/mcp/api-key",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const provenance = httpRequestProvenance(request);
    if (provenance.origin !== undefined || !isDirectLocalRequest(provenance)) {
      return HttpServerResponse.empty({ status: 403 });
    }
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith("Bearer ") || authorization.length > 128)
      return HttpServerResponse.empty({ status: 401 });
    const keys = yield* ApiKeyStore.ApiKeyStore;
    return yield* keys.redeem(authorization.slice(7)).pipe(
      Effect.map(({ name, value }) =>
        HttpServerResponse.jsonUnsafe(
          { name, value: Redacted.value(value) },
          {
            headers: { "cache-control": "no-store", pragma: "no-cache" },
          },
        ),
      ),
      Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 403 }))),
    );
  }).pipe(Effect.provideService(References.TracerEnabled, false)),
);
