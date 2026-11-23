import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { OpenCodeDriver } from "./driver.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer({ cwd: "/synthetic/project", runBackgroundWork: false }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
).pipe(Layer.provideMerge(NodeServices.layer));

const makeHarness = Effect.fnUntraced(function* (
  generation: "v1" | "v2",
  options: { readonly serverUrl?: string; readonly unknownVersion?: boolean } = {},
) {
  const version = generation === "v1" ? "1.18.32" : "2.2.5";
  const starts: Array<
    Parameters<OpenCodeRuntime.OpenCodeRuntime["Service"]["startOpenCodeServerProcess"]>[0]
  > = [];
  const connects: Array<
    Parameters<OpenCodeRuntime.OpenCodeRuntime["Service"]["connectToOpenCodeServer"]>[0]
  > = [];
  const requests: Array<{ method: string; url: string; authorization?: string; body: unknown }> =
    [];
  const state = { closes: 0, status: 200 };
  const http = HttpClient.make((request) => {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/api/info") && generation === "v1") {
      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("<html>")));
    }
    if (url.pathname.endsWith("/api/info") || url.pathname.endsWith("/global/health")) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            version,
            pid: 1234,
            healthy: true,
            urls: [],
            paths: { tmp: "/synthetic/tmp" },
          }),
        ),
      );
    }
    assert.equal(url.pathname, "/api/credential");
    const body =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : undefined;
    requests.push({
      method: request.method,
      url: request.url,
      ...(request.headers.authorization ? { authorization: request.headers.authorization } : {}),
      body,
    });
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        state.status === 200
          ? Response.json({
              data: { id: "cred_synthetic", label: "default", active: true, ...body },
            })
          : Response.json(
              { _tag: "UnauthorizedError", message: "synthetic-key-echo" },
              { status: state.status },
            ),
      ),
    );
  });
  const unused = () => Effect.die("Unexpected runtime operation");
  const runtime: OpenCodeRuntime.OpenCodeRuntime["Service"] = {
    runOpenCodeCommand: () =>
      Effect.succeed({
        stdout: options.unknownVersion ? "unknown build" : `opencode v${version}\n`,
        stderr: "",
        code: 0,
      }),
    startOpenCodeServerProcess: (input) =>
      Effect.gen(function* () {
        starts.push(input);
        const url = `http://127.0.0.1:${4100 + starts.length}`;
        if (input.verify) yield* input.verify(url);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            state.closes += 1;
          }),
        );
        return {
          url,
          version,
          ...(input.serverPassword ? { serverPassword: input.serverPassword } : {}),
          isRunning: Effect.succeed(true),
          exitCode: Effect.never,
        };
      }),
    connectToOpenCodeServer: (input) =>
      Effect.sync(() => {
        connects.push(input);
        return { url: input.serverUrl!, version, external: true, exitCode: null };
      }),
    createOpenCodeSdkClient: (input) =>
      createOpencodeClient({
        baseUrl: input.baseUrl,
        directory: input.directory,
        headers: input.serverPassword
          ? {
              Authorization: `Basic ${Buffer.from(`opencode:${input.serverPassword}`).toString("base64")}`,
            }
          : {},
        fetch: Object.assign(
          async (input: string | Request | URL) => {
            const request = input instanceof Request ? input : new Request(input.toString());
            requests.push({
              method: request.method,
              url: request.url,
              ...(request.headers.get("authorization")
                ? { authorization: request.headers.get("authorization")! }
                : {}),
              body: await request.json(),
            });
            return Response.json(true, { status: state.status });
          },
          { preconnect: () => undefined },
        ),
      }),
    loadOpenCodeInventory: unused,
    loadOpenCodeSkills: unused,
    loadInventoryFromCli: unused,
    loadSkillsFromCli: unused,
  };
  const instance = yield* OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-key-test"),
    displayName: undefined,
    environment: [
      { name: "HOME", value: "/synthetic/home", sensitive: false },
      { name: "XDG_DATA_HOME", value: "/synthetic/data", sensitive: false },
      { name: "OPENCODE_API_KEY", value: "synthetic-environment-key", sensitive: true },
      { name: "OPENCODE_AUTH_CONTENT", value: "", sensitive: true },
      { name: "OPENCODE_DB", value: "opencode.db", sensitive: false },
    ],
    enabled: true,
    config: {
      ...OpenCodeDriver.defaultConfig(),
      binaryPath: "/synthetic/bin/opencode",
      serverUrl: options.serverUrl ?? "",
      serverPassword: "synthetic-server-password",
    },
  }).pipe(
    Effect.provideService(OpenCodeRuntime.OpenCodeRuntime, runtime),
    Effect.provideService(HttpClient.HttpClient, http),
  );
  return { instance, requests, starts, connects, state };
});

it.layer(layer)("OpenCode API key replacement", (it) => {
  it.effect("activates a v2 credential on the configured server without listing secrets", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness("v2", { serverUrl: "http://opencode.test" });
      yield* test.instance.replaceApiKey!("opencode", "synthetic-new-key");
      assert.deepEqual(test.requests, [
        {
          method: "POST",
          url: "http://opencode.test/api/credential",
          authorization: `Basic ${Buffer.from("opencode:synthetic-server-password").toString("base64")}`,
          body: {
            integrationID: "opencode",
            value: { type: "key", key: "synthetic-new-key" },
            activate: true,
          },
        },
      ]);
      assert.equal(test.starts.length, 0);
      assert.equal(test.state.closes, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("uses the configured v1 connection and its own auth API", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness("v1", { serverUrl: "http://opencode.test/base" });
      yield* test.instance.replaceApiKey!("opencode-go", "synthetic-new-key");
      assert.equal(test.starts.length, 0);
      assert.equal(test.connects[0]?.binaryPath, "/synthetic/bin/opencode");
      assert.equal(test.connects[0]?.environment?.HOME, "/synthetic/home");
      assert.deepEqual(
        test.requests.map(({ method, url, body }) => ({ method, url, body })),
        [
          {
            method: "PUT",
            url: "http://opencode.test/base/auth/opencode-go",
            body: { type: "api", key: "synthetic-new-key" },
          },
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("retires a local v2 server after saving and retains the instance environment", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness("v2");
      yield* test.instance.replaceApiKey!("opencode", "synthetic-first-key");
      assert.equal(test.state.closes, 1);
      yield* test.instance.replaceApiKey!("opencode", "synthetic-second-key");
      assert.equal(test.starts.length, 2);
      assert.equal(test.starts[0]?.binaryPath, "/synthetic/bin/opencode");
      assert.equal(test.starts[0]?.environment?.XDG_DATA_HOME, "/synthetic/data");
      assert.equal(test.state.closes, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("retires the local v1 server after its auth API accepts the key", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness("v1");
      yield* test.instance.replaceApiKey!("opencode-go", "synthetic-first-key");
      assert.equal(test.state.closes, 1);
      yield* test.instance.replaceApiKey!("opencode-go", "synthetic-second-key");
      assert.equal(test.starts.length, 2);
      assert.equal(test.state.closes, 2);
      assert.equal(test.starts[0]?.environment?.HOME, "/synthetic/home");
    }).pipe(Effect.scoped),
  );

  it.effect("reports save failures without echoing keys and keeps the server for retry", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness("v2");
      test.state.status = 401;
      const error = yield* test.instance.replaceApiKey!("opencode", "synthetic-key-echo").pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "ProviderDriverError");
      assert.equal(error.detail, "Failed to replace the OpenCode API key.");
      assert.equal(test.state.closes, 0);
      test.state.status = 200;
      yield* test.instance.replaceApiKey!("opencode", "synthetic-new-key");
      assert.equal(test.starts.length, 1);
      assert.equal(test.state.closes, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a write when the binary version cannot be identified", () =>
    Effect.gen(function* () {
      const test = yield* makeHarness("v2", { unknownVersion: true });
      const error = yield* test.instance.replaceApiKey!("opencode", "synthetic-new-key").pipe(
        Effect.flip,
      );
      assert.equal(error._tag, "ProviderDriverError");
      assert.deepEqual(test.requests, []);
      assert.deepEqual(test.starts, []);
    }).pipe(Effect.scoped),
  );
});
