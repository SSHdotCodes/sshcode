import * as Effect from "effect/Effect";
import * as References from "effect/References";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { httpRequestProvenance, isDirectLocalRequest } from "../requestProvenance.ts";
import { countWorkingThreads } from "./WorkingThreads.ts";

/**
 * `{"working": n}` for programs on this machine, without a session: the
 * SSHCode restart job and the desktop app ask it before an update restart.
 * Browsers (any Origin) and anything forwarded (Tailscale Serve, the T3
 * Connect relay) are refused, so it never answers off the machine.
 */
export const layer = HttpRouter.add(
  "GET",
  "/api/local/activity",
  Effect.gen(function* () {
    const provenance = httpRequestProvenance(yield* HttpServerRequest.HttpServerRequest);
    if (provenance.origin !== undefined || !isDirectLocalRequest(provenance)) {
      return HttpServerResponse.empty({ status: 403 });
    }
    return yield* countWorkingThreads.pipe(
      Effect.map((working) =>
        HttpServerResponse.jsonUnsafe({ working }, { headers: { "cache-control": "no-store" } }),
      ),
      Effect.catch(() => Effect.succeed(HttpServerResponse.empty({ status: 500 }))),
    );
    // Callers poll every few seconds; keep those requests out of traces.
  }).pipe(Effect.provideService(References.TracerEnabled, false)),
);
