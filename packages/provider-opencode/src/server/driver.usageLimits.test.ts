import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Model } from "@opencode/schema/model";
import { Provider } from "@opencode/schema/provider";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { expect } from "vite-plus/test";

import { OpenCodeDriver } from "./driver.ts";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

// No binary or real server is used, including for the instance with no serverUrl.
const runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode v2.0.28\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: (
    input: Parameters<OpenCodeRuntime.OpenCodeRuntime["Service"]["startOpenCodeServerProcess"]>[0],
  ) =>
    Effect.gen(function* () {
      if (input.verify) yield* input.verify("http://local.invalid");
      return {
        url: "http://local.invalid",
        version: "2.0.28",
        isRunning: Effect.succeed(true),
        exitCode: Effect.never,
      };
    }),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];
const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer({ cwd: "/work", runBackgroundWork: false }),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, runtime),
).pipe(Layer.provideMerge(NodeServices.layer));

const go = (percent: number) => ({
  workspace: { id: "workspace", usageURL: "https://opencode.ai/console/workspace" },
  go: {
    rolling: { percent, limited: false, resetsAt: 1793491200000 },
    weekly: { percent, limited: false, resetsAt: 1793491200000 },
    monthly: { percent, limited: false, resetsAt: 1793491200000 },
  },
  budgets: [],
});

/** The real client decodes this synthetic catalog; only the HTTP transport is stubbed. */
const respond = (request: HttpClientRequest.HttpClientRequest, response: Response) =>
  Effect.succeed(HttpClientResponse.fromWeb(request, response));
const catalog = (request: HttpClientRequest.HttpClientRequest) => {
  const path = new URL(request.url).pathname;
  if (path.endsWith("/api/info"))
    return respond(
      request,
      Response.json({ version: "2.0.28", pid: 1, urls: [], paths: { tmp: "/tmp" } }),
    );
  if (path.endsWith("/api/model"))
    return respond(
      request,
      Response.json({
        location: { directory: "/work" },
        data: [Model.Info.default(Provider.ID.opencode, Model.ID.make("fixture"))],
      }),
    );
  if (path.endsWith("/api/provider"))
    return respond(request, Response.json({ location: { directory: "/work" }, data: [] }));
  if (new URL(request.url).hostname === "registry.npmjs.org")
    return respond(request, new Response(null, { status: 404 }));
  return Effect.die("Unexpected request in the fake OpenCode transport");
};

const create = (
  id: string,
  serverUrl: string,
  http: HttpClient.HttpClient,
  dataDirectory = "/unused",
) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make(id),
    displayName: undefined,
    enabled: true,
    environment: [
      { name: "OPENCODE_DB", value: `${dataDirectory}/opencode.db`, sensitive: false },
      { name: "XDG_DATA_HOME", value: dataDirectory, sensitive: false },
      {
        name: "OPENCODE_AUTH_CONTENT",
        value: '{"opencode-go":{"type":"api","key":"fixture-only"}}',
        sensitive: true,
      },
    ],
    config: {
      ...OpenCodeDriver.defaultConfig(),
      binaryPath: "/fixture/opencode",
      serverUrl,
      serverPassword: "fixture-only",
    },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));
const limits = (instance: Effect.Success<ReturnType<typeof create>>) =>
  instance.snapshot.streamChanges.pipe(
    Stream.filter((s) => s.usageLimits !== undefined),
    Stream.take(1),
    Stream.runCollect,
    Effect.map(([snapshot]) => snapshot?.usageLimits),
  );

it.layer(layer)("OpenCode driver workspace usage", (it) => {
  it.effect("keeps missing-endpoint support separate for two servers on the same version", () =>
    Effect.gen(function* () {
      const reads: Record<string, number> = {};
      const refreshed = yield* Deferred.make<void>();
      const http = HttpClient.make((request) => {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/api/experimental/usage/limits")) {
          reads[url.hostname] = (reads[url.hostname] ?? 0) + 1;
          return respond(
            request,
            url.hostname === "old.invalid"
              ? new Response(null, { status: 404 })
              : Response.json({ location: { directory: "/work" }, data: go(37) }),
          ).pipe(
            Effect.tap(() =>
              url.hostname === "current.invalid" && reads[url.hostname] === 2
                ? Deferred.succeed(refreshed, undefined)
                : Effect.void,
            ),
          );
        }
        return catalog(request);
      });
      const [old, current] = yield* Effect.all(
        [
          Effect.gen(function* () {
            const i = yield* create("old", "https://old.invalid/prefix", http);
            return { instance: i, limits: yield* limits(i) };
          }),
          Effect.gen(function* () {
            const i = yield* create("current", "https://current.invalid/tunnel", http);
            return { instance: i, limits: yield* limits(i) };
          }),
        ],
        { concurrency: "unbounded" },
      );
      assert.strictEqual(old.limits?.unavailable?.reason, "unsupported");
      assert.strictEqual(current.limits?.windows[0]?.usedPercent, 37);
      yield* old.instance.snapshot.refresh;
      yield* current.instance.snapshot.refresh;
      // Ready status is published first; wait for the new usage read to complete.
      yield* Deferred.await(refreshed);
      assert.strictEqual(reads["old.invalid"], 1);
      assert.strictEqual(reads["current.invalid"], 2);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { name: "signed out", data: null, localGoPercent: null, expected: undefined },
    // A Go plan known only from local credentials must not vanish from the limits.
    { name: "signed out with a local Go plan", data: null, localGoPercent: 30, expected: 30 },
    { name: "signed in", data: go(42), localGoPercent: 30, expected: 42 },
    // Seen live: a signed-in workspace that has no plan of its own answers with no windows.
    {
      name: "signed in to a workspace without a plan",
      data: { ...go(42), go: undefined },
      localGoPercent: 30,
      expected: 30,
    },
  ])("uses the server's workspace data: $name", ({ data, localGoPercent, expected }) =>
    Effect.gen(function* () {
      const http = HttpClient.make((request) => {
        if (request.url.endsWith("/api/experimental/usage/limits"))
          return respond(request, Response.json({ location: { directory: "/work" }, data }));
        if (request.url === "https://opencode.ai/zen/go/v1/usage") {
          if (localGoPercent === null) return respond(request, new Response(null, { status: 401 }));
          const meter = { percent: localGoPercent, resetsAt: "2026-11-01T00:00:00.000Z" };
          return respond(
            request,
            Response.json({ usage: { rolling: meter, weekly: meter, monthly: meter } }),
          );
        }
        return catalog(request);
      });
      const instance = yield* create("local-authoritative", "", http);
      const result = yield* limits(instance);
      expect(result?.windows[0]?.usedPercent).toBe(expected);
      if (expected === undefined) expect(result?.unavailable).toBeDefined();
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the local-file fallback for an older locally owned server", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-usage-fallback-" });
      let endpointReads = 0;
      let legacyReads = 0;
      const http = HttpClient.make((request) => {
        if (request.url.endsWith("/api/experimental/usage/limits")) {
          endpointReads++;
          return respond(request, new Response(null, { status: 405 }));
        }
        if (request.url === "https://opencode.ai/zen/go/v1/usage") {
          legacyReads++;
          const meter = { percent: legacyReads * 10, resetsAt: "2026-11-01T00:00:00.000Z" };
          return respond(
            request,
            Response.json({ usage: { rolling: meter, weekly: meter, monthly: meter } }),
          );
        }
        return catalog(request);
      });
      const instance = yield* create("local-old", "", http, directory);
      assert.strictEqual((yield* limits(instance))?.windows[0]?.usedPercent, 10);
      const refreshed = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((s) => s.usageLimits?.windows[0]?.usedPercent === 20),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* instance.snapshot.refresh;
      yield* Fiber.join(refreshed);
      assert.strictEqual(endpointReads, 1);
      assert.strictEqual(legacyReads, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("reports ready status while a quota request hangs and cancels it at the bound", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let interrupted = false;
      const http = HttpClient.make((request) =>
        request.url.endsWith("/api/experimental/usage/limits")
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  interrupted = true;
                }),
              ),
            )
          : catalog(request),
      );
      const instance = yield* create("slow", "https://slow.invalid", http);
      const quota = yield* limits(instance).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      assert.strictEqual((yield* instance.snapshot.getSnapshot).status, "ready");
      yield* TestClock.adjust("5 seconds");
      assert.strictEqual((yield* Fiber.join(quota))?.unavailable?.reason, "probeFailed");
      assert.isTrue(interrupted);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});
