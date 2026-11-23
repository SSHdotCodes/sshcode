import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import { describe } from "vite-plus/test";

import { loadOpenCode2Catalog } from "./openCode2Catalog.ts";
import * as OpenCode2Client from "./v2/OpenCode2Client.ts";

/**
 * `GET /api/model` from an `opencode serve` 2.0.26 with credentials for both
 * gateways, cut to the one model each of them lists. Step 5 Preview Free is
 * the whole point: both providers list it, with the same name.
 */
const MODELS_BODY = `{"location":{"directory":"/project"},"data":[{"id":"step-5-preview-free","modelID":"step-5-preview-free","providerID":"opencode-go","name":"Step 5 Preview Free","compatibility":{"reasoningField":"reasoning_content"},"package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"sk-demo-not-real","baseURL":"http://127.0.0.1:48990/v1","provider":"opencode-go"},"capabilities":{"tools":true,"input":["text","image","video"],"output":["text"]},"variants":[{"id":"low","settings":{"reasoningEffort":"low"}},{"id":"medium","settings":{"reasoningEffort":"medium"}},{"id":"high","settings":{"reasoningEffort":"high"}}],"time":{"released":1789516800000},"cost":[{"input":0,"output":0,"cache":{"read":0,"write":0}}],"status":"active","enabled":true,"limit":{"context":1000000,"input":1000000,"output":65536}},{"id":"step-5-preview-free","modelID":"step-5-preview-free","providerID":"opencode","name":"Step 5 Preview Free","compatibility":{"reasoningField":"reasoning_content"},"package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"public","baseURL":"https://opencode.ai/zen/v1","provider":"opencode"},"capabilities":{"tools":true,"input":["text","image","video"],"output":["text"]},"variants":[{"id":"low","settings":{"reasoningEffort":"low"}},{"id":"medium","settings":{"reasoningEffort":"medium"}},{"id":"high","settings":{"reasoningEffort":"high"}}],"time":{"released":1789516800000},"cost":[{"input":0,"output":0,"cache":{"read":0,"write":0}}],"status":"active","enabled":true,"limit":{"context":1000000,"input":1000000,"output":65536}}]}`;

/** `GET /api/provider` from the same server. */
const PROVIDERS_BODY = `{"location":{"directory":"/project"},"data":[{"id":"opencode-go","integrationID":"opencode-go","name":"OpenCode Go","activation":"enabled","package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"sk-demo-not-real","baseURL":"http://127.0.0.1:48990/v1","provider":"opencode-go"}},{"id":"opencode","integrationID":"opencode","name":"OpenCode Zen","activation":"enabled","package":"@opencode/ai/providers/openai-compatible","settings":{"apiKey":"public","baseURL":"https://opencode.ai/zen/v1"}}]}`;

const layerServerReplying = (
  bodies: Readonly<Record<string, string>>,
  hanging: ReadonlyArray<string> = [],
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.suspend(() => {
        const path = new URL(request.url).pathname;
        if (hanging.includes(path)) {
          return Effect.never;
        }
        const body = bodies[path];
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(body ?? '{"_tag":"NotFoundError","message":"not recorded"}', {
              status: body === undefined ? 404 : 200,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }),
    ),
  );

/**
 * Reads a catalog the way the driver does, through the client and a
 * connection. `hanging` names paths the server accepts but never answers.
 */
const readCatalog = (
  bodies: Readonly<Record<string, string>>,
  hanging: ReadonlyArray<string> = [],
) =>
  Effect.gen(function* () {
    const opencode = yield* OpenCode2Client.OpenCode2Client;
    const { client } = yield* opencode.connect({
      baseUrl: "http://127.0.0.1:4096",
      password: "secret",
    });
    return yield* loadOpenCode2Catalog(client, "/project");
  }).pipe(
    Effect.provide(OpenCode2Client.layer.pipe(Layer.provide(layerServerReplying(bodies, hanging)))),
  );

describe("loadOpenCode2Catalog", () => {
  it.effect("names the provider each listed model came from", () =>
    Effect.gen(function* () {
      const models = yield* readCatalog({
        "/api/model": MODELS_BODY,
        "/api/provider": PROVIDERS_BODY,
      });

      assert.deepStrictEqual(
        models.map((model) => [`${model.providerID}/${model.id}`, model.providerName]),
        [
          ["opencode-go/step-5-preview-free", "OpenCode Go"],
          ["opencode/step-5-preview-free", "OpenCode Zen"],
        ],
      );
    }),
  );

  it.effect("reports whether each model reads images", () =>
    Effect.gen(function* () {
      const textOnly = MODELS_BODY.replace('"input":["text","image","video"]', '"input":["text"]');
      const read = (body: string) =>
        readCatalog({ "/api/model": body, "/api/provider": PROVIDERS_BODY }).pipe(
          Effect.map((models) => models.map((model) => model.imageInput)),
        );
      assert.deepStrictEqual(yield* read(MODELS_BODY), [true, true]);
      assert.deepStrictEqual(yield* read(textOnly), [false, true]);
    }),
  );

  it.effect("keeps the variants a model advertised", () =>
    Effect.gen(function* () {
      const models = yield* readCatalog({
        "/api/model": MODELS_BODY,
        "/api/provider": PROVIDERS_BODY,
      });

      assert.deepStrictEqual(
        models.map((model) => model.variants),
        [
          [{ id: "low" }, { id: "medium" }, { id: "high" }],
          [{ id: "low" }, { id: "medium" }, { id: "high" }],
        ],
      );
    }),
  );

  // A server that cannot name its providers still lists its models, and the
  // status check labels those with the provider id instead.
  it.effect("leaves a model unnamed when the provider list fails", () =>
    Effect.gen(function* () {
      const models = yield* readCatalog({ "/api/model": MODELS_BODY });

      assert.deepStrictEqual(
        models.map((model) => [`${model.providerID}/${model.id}`, model.providerName]),
        [
          ["opencode-go/step-5-preview-free", undefined],
          ["opencode/step-5-preview-free", undefined],
        ],
      );
    }),
  );

  // Names are decoration: a provider read that never answers must not hold the
  // models back, because the models are what the snapshot needs.
  it.effect("keeps reading models while a provider list stays pending", () =>
    Effect.gen(function* () {
      const reading = yield* readCatalog({ "/api/model": MODELS_BODY }, ["/api/provider"]).pipe(
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      const models = yield* Fiber.join(reading);

      assert.deepStrictEqual(
        models.map((model) => [`${model.providerID}/${model.id}`, model.providerName]),
        [
          ["opencode-go/step-5-preview-free", undefined],
          ["opencode/step-5-preview-free", undefined],
        ],
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails the read when the model list fails", () =>
    Effect.gen(function* () {
      const error = yield* readCatalog({
        "/api/model": '{"_tag":"InternalServerError","message":"catalog unavailable"}',
        "/api/provider": PROVIDERS_BODY,
      }).pipe(Effect.flip);

      assert.strictEqual(error.operation, "model.list");
      assert.match(error.detail, /could not list its models/i);
    }),
  );

  it.effect("retries transient 503 responses while an OpenCode 2 server finishes booting", () =>
    Effect.gen(function* () {
      let modelAttempts = 0;
      let providerAttempts = 0;
      const clientLayer = OpenCode2Client.layer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                const path = new URL(request.url).pathname;
                if (path === "/api/model") {
                  modelAttempts += 1;
                  if (modelAttempts < 3) {
                    return HttpClientResponse.fromWeb(
                      request,
                      new Response("Service Unavailable", { status: 503 }),
                    );
                  }
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(MODELS_BODY, {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    }),
                  );
                }
                if (path === "/api/provider") {
                  providerAttempts += 1;
                  if (providerAttempts < 3) {
                    return HttpClientResponse.fromWeb(
                      request,
                      new Response("Service Unavailable", { status: 503 }),
                    );
                  }
                  return HttpClientResponse.fromWeb(
                    request,
                    new Response(PROVIDERS_BODY, {
                      status: 200,
                      headers: { "content-type": "application/json" },
                    }),
                  );
                }
                return HttpClientResponse.fromWeb(request, new Response("", { status: 404 }));
              }),
            ),
          ),
        ),
      );
      const reading = yield* Effect.gen(function* () {
        const opencode = yield* OpenCode2Client.OpenCode2Client;
        const { client } = yield* opencode.connect({
          baseUrl: "http://127.0.0.1:4096",
          password: "secret",
        });
        return yield* loadOpenCode2Catalog(client, "/project");
      }).pipe(Effect.provide(clientLayer), Effect.forkChild);

      yield* TestClock.adjust("5 seconds");
      const models = yield* Fiber.join(reading);

      assert.strictEqual(modelAttempts, 3);
      assert.strictEqual(providerAttempts, 3);
      assert.deepStrictEqual(
        models.map((model) => [`${model.providerID}/${model.id}`, model.providerName]),
        [
          ["opencode-go/step-5-preview-free", "OpenCode Go"],
          ["opencode/step-5-preview-free", "OpenCode Zen"],
        ],
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails after exhausting retries when the server keeps returning 503", () =>
    Effect.gen(function* () {
      let modelAttempts = 0;
      const clientLayer = OpenCode2Client.layer.pipe(
        Layer.provide(
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                if (new URL(request.url).pathname === "/api/model") {
                  modelAttempts += 1;
                }
                return HttpClientResponse.fromWeb(
                  request,
                  new Response("Service Unavailable", { status: 503 }),
                );
              }),
            ),
          ),
        ),
      );
      const reading = yield* Effect.gen(function* () {
        const opencode = yield* OpenCode2Client.OpenCode2Client;
        const { client } = yield* opencode.connect({
          baseUrl: "http://127.0.0.1:4096",
          password: "secret",
        });
        return yield* loadOpenCode2Catalog(client, "/project").pipe(Effect.flip);
      }).pipe(Effect.provide(clientLayer), Effect.forkChild);

      yield* TestClock.adjust("10 seconds");
      const error = yield* Fiber.join(reading);

      assert.strictEqual(modelAttempts, 4);
      assert.strictEqual(error.operation, "model.list");
      assert.match(error.detail, /could not list its models/i);
    }).pipe(Effect.provide(TestClock.layer())),
  );
});
