import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe } from "vite-plus/test";

import { readServerUsageLimits } from "./usageLimits.ts";

const budget = {
  id: "all",
  limit: 20,
  spent: 20,
  scope: "combined",
  per: "set",
  coverage: "all",
  models: [],
  shared: true,
  resetsAt: 1793491200000,
};
const body = {
  location: { directory: "/work" },
  data: {
    workspace: { id: "workspace", usageURL: "https://opencode.ai/console/workspace" },
    budgets: [budget],
  },
};
const read = (client: HttpClient.HttpClient) =>
  readServerUsageLimits("/work").pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.mapRequest(client, HttpClientRequest.prependUrl("https://server.invalid")),
    ),
  );

describe("bounded OpenCode server usage reader", () => {
  it.effect.each(["headers", "body", "providers"] as const)(
    "times out stalled %s without retrying",
    (stage) =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        let calls = 0;
        let interrupted = false;
        const hang = Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() =>
            Effect.sync(() => {
              interrupted = true;
            }),
          ),
        );
        const client = HttpClient.make((request) => {
          calls++;
          if (
            stage === "headers" ||
            (stage === "providers" && request.url.endsWith("/api/provider"))
          ) {
            return hang;
          }
          const response = HttpClientResponse.fromWeb(request, Response.json(body));
          if (stage === "body")
            Object.defineProperty(response, "stream", { value: Stream.fromEffect(hang) });
          return Effect.succeed(response);
        });
        const fiber = yield* read(client).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("5 seconds");
        const result = yield* Fiber.join(fiber);
        assert.strictEqual(result?.unavailable?.reason, "probeFailed");
        assert.isTrue(interrupted);
        assert.strictEqual(calls, stage === "providers" ? 2 : 1);
      }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect.each([false, true])("caps streamed bytes with declared size %s", (declared) =>
    Effect.gen(function* () {
      let pulled = 0;
      let closed = false;
      let signal: AbortSignal | undefined;
      const client = HttpClient.make((request, _url, requestSignal) => {
        signal = requestSignal;
        const response = HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            headers: declared ? { "content-length": String(1024 * 1024 + 1) } : {},
          }),
        );
        const chunk = new Uint8Array(256 * 1024);
        Object.defineProperty(response, "stream", {
          value: Stream.range(1, 100).pipe(
            Stream.rechunk(1),
            Stream.map(() => {
              pulled++;
              return chunk;
            }),
            Stream.ensuring(
              Effect.sync(() => {
                closed = true;
              }),
            ),
          ),
        });
        return Effect.succeed(response);
      });
      const result = yield* read(client);
      assert.strictEqual(result?.unavailable?.reason, "probeFailed");
      assert.strictEqual(pulled, declared ? 0 : 5);
      assert.strictEqual(closed, !declared);
      assert.isTrue(signal?.aborted);
    }),
  );

  it.effect("bounds the provider metadata response and keeps unknown coverage empty", () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = HttpClient.make((request) => {
        calls++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            request.url.endsWith("/api/provider")
              ? new Response(" ".repeat(1024 * 1024 + 1))
              : Response.json(body),
          ),
        );
      });
      const result = yield* read(client);
      assert.strictEqual(calls, 2);
      assert.deepStrictEqual(result?.windows[0]?.providerIds, []);
      assert.strictEqual(result?.windows[0]?.usedPercent, 100);
    }),
  );

  it.effect("projects only quota fields from provider metadata", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json(
              request.url.endsWith("/api/provider")
                ? {
                    data: [
                      {
                        id: "custom",
                        integrationID: "opencode",
                        settings: { apiKey: "fixture-only" },
                        headers: { authorization: "fixture-only" },
                      },
                    ],
                  }
                : body,
            ),
          ),
        ),
      );
      const result = yield* read(client);
      assert.deepStrictEqual(result?.windows[0], {
        id: "budget_all",
        kind: "other",
        label: "Console · Shared · All spend",
        providerIds: ["custom"],
        usedPercent: 100,
        resetsAt: "2026-11-01T00:00:00.000Z",
      });
    }),
  );
});
