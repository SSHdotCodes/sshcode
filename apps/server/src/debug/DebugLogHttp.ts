import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as DebugLog from "./DebugLog.ts";

const headers = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "Content-Type",
  "cache-control": "no-store",
};

export const layer = HttpRouter.add(
  "*",
  `${DebugLog.ROUTE_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method === "OPTIONS") return HttpServerResponse.empty({ status: 204, headers });
    if (request.method !== "POST")
      return HttpServerResponse.empty({
        status: 405,
        headers: { ...headers, allow: "POST, OPTIONS" },
      });
    const path = request.url.split("?")[0] ?? "";
    const [sessionId = "", token = "", ...extra] = path
      .slice(DebugLog.ROUTE_PREFIX.length + 1)
      .split("/");
    if (extra.length > 0) return HttpServerResponse.empty({ status: 404, headers });
    const log = yield* DebugLog.DebugLog;
    return yield* log.ingest(sessionId, token, request.stream).pipe(
      Effect.as(HttpServerResponse.empty({ status: 204, headers })),
      Effect.catchTags({
        DebugLogError: (error) =>
          Effect.succeed(HttpServerResponse.text(error.message, { status: error.status, headers })),
      }),
    );
  }),
).pipe(Layer.provide(HttpRouter.disableLogger));
