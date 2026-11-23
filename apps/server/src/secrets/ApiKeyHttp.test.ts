import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import { ApiKeyError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { HttpClient, HttpRouter } from "effect/http";
import * as ApiKeyStore from "./ApiKeyStore.ts";
import * as ApiKeyHttp from "./ApiKeyHttp.ts";

it.effect(
  "the CLI transport rejects browser/missing/invalid tickets and never caches credentials",
  () =>
    Effect.gen(function* () {
      const redeemed: string[] = [];
      const services = yield* Layer.build(
        HttpRouter.serve(ApiKeyHttp.layer, { disableListenLog: true }).pipe(
          Layer.provide(
            Layer.mock(ApiKeyStore.ApiKeyStore)({
              redeem: (ticket) => {
                redeemed.push(ticket);
                return ticket === "fake-valid-ticket"
                  ? Effect.succeed({
                      name: "FAKE_API_KEY",
                      value: Redacted.make("obviously-fake-secret-value"),
                    })
                  : Effect.fail(new ApiKeyError({ reason: "invalid_ticket" }));
              },
            }),
          ),
          Layer.provideMerge(NodeHttpServer.layerTest),
        ),
      );
      const client = Context.get(services, HttpClient.HttpClient);
      expect((yield* client.post("/mcp/api-key")).status).toBe(401);
      expect(
        (yield* client.post("/mcp/api-key", {
          headers: { origin: "https://example.invalid", authorization: "Bearer fake-valid-ticket" },
        })).status,
      ).toBe(403);
      // The T3 Connect relay also connects from loopback; its forwarding headers give it away.
      for (const forwarded of [
        { "cf-connecting-ip": "203.0.113.9" },
        { "x-forwarded-for": "203.0.113.9" },
        { "cf-ray": "fake-relay" },
        { "x-real-ip": "203.0.113.9" },
        { forwarded: "for=203.0.113.9" },
        { "x-forwarded-host": "remote.invalid" },
        { "x-forwarded-proto": "https" },
      ]) {
        expect(
          (yield* client.post("/mcp/api-key", {
            headers: { ...forwarded, authorization: "Bearer fake-valid-ticket" },
          })).status,
        ).toBe(403);
      }
      expect(redeemed).toEqual([]);
      const bad = yield* client.post("/mcp/api-key", {
        headers: { authorization: "Bearer fake-invalid-ticket" },
      });
      expect(bad.status).toBe(403);
      expect(yield* bad.text).not.toContain("obviously-fake-secret-value");
      const good = yield* client.post("/mcp/api-key", {
        headers: { authorization: "Bearer fake-valid-ticket" },
      });
      expect(good.status).toBe(200);
      expect(good.headers["cache-control"]).toBe("no-store");
      expect(yield* good.text).toBe(
        '{"name":"FAKE_API_KEY","value":"obviously-fake-secret-value"}',
      );
    }).pipe(Effect.scoped),
);
