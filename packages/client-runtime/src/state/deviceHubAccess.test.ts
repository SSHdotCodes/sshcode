import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { RelayConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import * as RpcHttp from "../rpc/http.ts";
import { resolveDeviceHubAccess } from "./deviceHubAccess.ts";

const TARGET = new RelayConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: "https://remote.example.test",
  socketUrl: "wss://remote.example.test/ws",
  httpAuthorization: { _tag: "Bearer", token: "bearer-token" },
  target: TARGET,
};
const TICKET = { ticket: "media-ticket", expiresAt: "2026-05-01T12:05:00.000Z" };

const recordedFetch = (...responses: ReadonlyArray<Response>) => {
  const urls: Array<string> = [];
  let index = 0;
  const fetchFn = ((input) => {
    urls.push(String(input instanceof Request ? input.url : input));
    const response = responses[index++];
    return response ? Promise.resolve(response) : Promise.reject(new Error("Unexpected fetch"));
  }) satisfies typeof fetch;
  return { fetchFn, urls };
};

describe("resolveDeviceHubAccess", () => {
  it.effect("mints a media ticket", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(Response.json(TICKET));
      const access = yield* resolveDeviceHubAccess({
        prepared: PREPARED,
        hubBasePath: "/api/device-hub",
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetch.fetchFn)));

      expect(fetch.urls).toEqual(["https://remote.example.test/api/auth/websocket-ticket/media"]);
      expect(access.query).toEqual({ wsTicket: "media-ticket" });
    }),
  );

  it.effect("falls back to the bare ticket path on a server without audiences", () =>
    Effect.gen(function* () {
      const fetch = recordedFetch(new Response(null, { status: 404 }), Response.json(TICKET));
      const access = yield* resolveDeviceHubAccess({
        prepared: PREPARED,
        hubBasePath: "/api/device-hub",
      }).pipe(Effect.provide(RpcHttp.layerRemoteHttpClient(fetch.fetchFn)));

      expect(fetch.urls).toEqual([
        "https://remote.example.test/api/auth/websocket-ticket/media",
        "https://remote.example.test/api/auth/websocket-ticket",
      ]);
      expect(access.query).toEqual({ wsTicket: "media-ticket" });
    }),
  );
});
