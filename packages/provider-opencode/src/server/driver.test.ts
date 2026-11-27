// @effect-diagnostics nodeBuiltinImport:off -- Tests exercise the Node server with local fixtures.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import type { OpenCodeSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as UrlParams from "effect/http/UrlParams";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderMaintenance from "@t3tools/provider-core/server/maintenanceResolver";
import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";
import {
  OPENCODE_2_RESPONSES,
  OPENCODE_1_RESPONSES,
  OPENCODE_2_WORKSPACE_RESPONSES,
  replayOpenCodeServer,
} from "./probeResponses.fixture.ts";
import { OpenCodeDriver, openCodeUpdateFor } from "./driver.ts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { useTempDirs } from "@t3tools/shared/testing/tempDirs";

const makeTempDir = useTempDirs();

const serverStarts: Array<string> = [];
const reachedServer = (operation: string) =>
  Effect.sync(() => serverStarts.push(operation)).pipe(
    Effect.andThen(
      Effect.fail(
        new OpenCodeRuntime.OpenCodeRuntimeError({
          operation,
          detail: "reached a 1.x server path",
        }),
      ),
    ),
  );
// Reports OpenCode 2 from `--version`; any attempt to reach a server is recorded and refused.
const openCode2Runtime = {
  runOpenCodeCommand: () => Effect.succeed({ stdout: "opencode v2.0.18\n", stderr: "", code: 0 }),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];

const layer = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, openCode2Runtime),
).pipe(Layer.provideMerge(NodeServices.layer));

const create = (config: Partial<OpenCodeSettings>, http: HttpClient.HttpClient) =>
  OpenCodeDriver.create({
    instanceId: ProviderInstanceId.make("opencode-test"),
    displayName: undefined,
    environment: [],
    enabled: true,
    config: { ...OpenCodeDriver.defaultConfig(), ...config },
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

const noHttp = HttpClient.make(() => Effect.die("A local binary must not be probed over HTTP"));

const sideChatInput = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const instanceId = ProviderInstanceId.make("opencode-test");
  const threadId = ThreadId.make("thread:driver-btw");
  return {
    threadId,
    providerThread: {
      id: ProviderThreadId.make("provider-thread:driver-btw"),
      driver: OpenCodeDriver.driverKind,
      providerInstanceId: instanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: {
        driver: OpenCodeDriver.driverKind,
        nativeId: "ses_driver_btw",
        strength: "strong",
      },
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
    modelSelection: { instanceId, model: "opencode/big-pickle" },
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/work" },
  } satisfies ProviderAdapter.ProviderAdapterV2SideChatInput;
});

it.layer(layer)("OpenCodeDriver runtime selection", (it) => {
  it.effect("routes native side questions through the detected OpenCode 2 adapter", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const recorded = replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret", paths);
      const http = HttpClient.make((request) => {
        if (new URL(request.url).pathname !== "/api/session/ses_driver_btw/generate") {
          return recorded.execute(request);
        }
        paths.push("generate");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ data: { text: "native side answer" } }), {
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      });
      const instance = yield* create(
        { serverUrl: "http://127.0.0.1:4096", serverPassword: "secret" },
        http,
      );
      const side = yield* instance.orchestrationAdapter.openSideChat!(yield* sideChatInput);
      assert.equal(
        yield* side.ask({ prompt: "question", onUpdate: () => Effect.void }),
        "native side answer",
      );
      assert.deepEqual(
        paths.filter((path) => path === "generate" || path.startsWith("/api/session")),
        ["generate"],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("refuses side questions on OpenCode 1 without sending a prompt", () =>
    Effect.gen(function* () {
      const paths: string[] = [];
      const instance = yield* create(
        { serverUrl: "http://127.0.0.1:4096", serverPassword: "secret" },
        replayOpenCodeServer(OPENCODE_1_RESPONSES, "secret", paths),
      );
      const error = yield* instance.orchestrationAdapter.openSideChat!(yield* sideChatInput).pipe(
        Effect.flip,
      );
      assert.include(error.message, "no native session.generate");
      assert.deepEqual(paths, ["/api/info", "/global/health"]);
    }).pipe(Effect.scoped),
  );

  it.effect("never starts a 1.x server for an OpenCode 2 instance", () =>
    Effect.gen(function* () {
      serverStarts.length = 0;
      const instance = yield* create({}, noHttp);
      // Text generation goes to the instance's 2.x server, which this test refuses to start.
      yield* Effect.flip(
        instance.textGeneration.generateThreadTitle({
          cwd: process.cwd(),
          message: "hello",
          modelSelection: { instanceId: instance.instanceId, model: "opencode/big-pickle" },
        }),
      );
      assert.deepStrictEqual(serverStarts, ["start"]);
    }).pipe(Effect.scoped),
  );

  it.effect("lists models from an external server that lacks the host's directory", () =>
    Effect.gen(function* () {
      const replay = replayOpenCodeServer(OPENCODE_2_RESPONSES, "secret");
      const catalog = (directory: string | undefined) => ({
        location: { directory: directory ?? "/srv/remote" },
        data: [
          {
            id: "big-pickle",
            modelID: "big-pickle",
            providerID: "opencode",
            name: "Big Pickle",
            package: "@opencode/ai/providers/openai-compatible",
            settings: {},
            compatibility: {},
            capabilities: { tools: true, input: ["text"], output: ["text"] },
            variants: [],
            time: { released: 1789516800000 },
            cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
            status: "active",
            enabled: true,
            limit: { context: 1000000, output: 65536 },
          },
        ],
      });
      // Like a real remote OpenCode 2 server: a directory it does not have is a 404.
      const server = HttpClient.make((request) => {
        const url = new URL(request.url);
        if (
          url.pathname !== "/api/model" &&
          url.pathname !== "/api/provider" &&
          url.pathname !== "/api/experimental/usage/limits"
        ) {
          return replay.execute(request);
        }
        const directory = Option.getOrUndefined(
          UrlParams.getFirst(request.urlParams, "location[directory]"),
        );
        const known = directory === undefined || directory === "/srv/remote";
        if (url.pathname === "/api/experimental/usage/limits" && known) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                location: { directory: "/srv/remote" },
                data: {
                  workspace: { id: "remote", usageURL: "https://opencode.ai/console/remote" },
                  budgets: [
                    {
                      id: "budget",
                      limit: 20,
                      spent: 10,
                      scope: "combined",
                      per: "set",
                      coverage: "all",
                      models: [],
                      shared: true,
                      resetsAt: 1793491200000,
                    },
                  ],
                },
              }),
            ),
          );
        }
        const body = known
          ? url.pathname === "/api/model"
            ? catalog(directory)
            : {
                location: { directory: directory ?? "/srv/remote" },
                data: [
                  {
                    id: "opencode",
                    integrationID: "opencode",
                    name: "OpenCode Zen",
                    activation: "enabled",
                    package: "@opencode/ai/providers/openai-compatible",
                    settings: {},
                  },
                ],
              }
          : {
              _tag: "LocationNotFoundError",
              message: `Location not found: ${directory}`,
            };
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify(body), {
              status: known ? 200 : 404,
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      });
      const instance = yield* create(
        { serverUrl: "http://127.0.0.1:4096", serverPassword: "secret" },
        server,
      );
      const settled = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.installed &&
            (snapshot.status === "error" ||
              (snapshot.status === "ready" && snapshot.usageLimits !== undefined)),
        ),
        Stream.take(1),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;
      yield* TestClock.adjust("5 seconds");
      const [snapshot] = Array.from(yield* Fiber.join(settled));
      assert.deepStrictEqual(
        { status: snapshot?.status, message: snapshot?.message },
        { status: "ready", message: "OpenCode 2.0.18 lists 1 model." },
      );
      assert.deepStrictEqual(
        snapshot?.models.map((model) => [model.slug, model.subProvider]),
        [["opencode/big-pickle", "OpenCode Zen"]],
      );
      assert.deepEqual(
        snapshot?.usageLimits?.windows.map((window) => window.usedPercent),
        [50],
      );
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );

  it.effect("lists an OpenCode 2 workspace's own skills and commands from its server", () =>
    Effect.gen(function* () {
      serverStarts.length = 0;
      const requested: Array<string> = [];
      const server = replayOpenCodeServer(
        { ...OPENCODE_2_RESPONSES, ...OPENCODE_2_WORKSPACE_RESPONSES },
        "secret",
        requested,
      );
      const instance = yield* create(
        { serverUrl: "http://127.0.0.1:4096", serverPassword: "secret" },
        server,
      );

      const workspace = yield* instance.snapshotForCwd!("/work");
      assert.includeMembers(
        workspace.skills.map((skill) => skill.name),
        ["plum", "opencode"],
      );
      assert.deepStrictEqual(
        workspace.slashCommands.map((command) => command.name),
        ["compact", "init", "review", "bee"],
      );
      assert.include(requested, "/api/skill");
      assert.deepStrictEqual(serverStarts, []);
    }).pipe(Effect.scoped),
  );

  it.effect("answers capability reads without waiting on an unreachable server", () =>
    Effect.gen(function* () {
      const hang = HttpClient.make(() => Effect.never);
      const instance = yield* create({ serverUrl: "http://127.0.0.1:9" }, hang);

      // No probe has succeeded yet, and the server never answers: the 1.x default applies.
      const capabilities = yield* instance.orchestrationAdapter
        .getCapabilities()
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.isDefined(capabilities.pollUnsafe());
      yield* Fiber.join(capabilities);
    }).pipe(Effect.scoped, Effect.provide(TestClock.layer())),
  );
});

// npm links `<prefix>/bin/opencode` into the package that installed it:
// `opencode-ai` for 1.x and `@opencode/cli` (whose bin is `bin/opencode.exe`) for 2.x.
const npmGlobalInstall = (prefix: string, packagePath: ReadonlyArray<string>, bin: string) => {
  const target = NodePath.join(prefix, "lib", "node_modules", ...packagePath, "bin", bin);
  NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
  NodeFS.writeFileSync(target, "#!/bin/sh\n");
  NodeFS.chmodSync(target, 0o755);
  const link = NodePath.join(prefix, "bin", "opencode");
  NodeFS.mkdirSync(NodePath.dirname(link), { recursive: true });
  NodeFS.symlinkSync(target, link);
  return link;
};
const resolveUpdate = (generation: "v1" | "v2", binaryPath: string) =>
  ProviderMaintenance.resolveProviderMaintenanceCapabilitiesEffect(openCodeUpdateFor(generation), {
    binaryPath,
    env: { PATH: "" },
  }).pipe(
    Effect.provideService(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.make(() => Effect.die("resolving an update must not spawn")),
    ),
    Effect.provide(NodeServices.layer),
  );

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "updates an npm-global OpenCode 2 install as @opencode/cli and a 1.x one as opencode-ai",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.realpathSync(makeTempDir("t3-opencode-update-"));
      const v2Prefix = NodePath.join(root, "v2");
      const v1Prefix = NodePath.join(root, "v1");
      const v2 = yield* resolveUpdate(
        "v2",
        npmGlobalInstall(v2Prefix, ["@opencode", "cli"], "opencode.exe"),
      );
      assert.deepStrictEqual(v2.update?.args, [
        "install",
        "-g",
        "--prefix",
        v2Prefix,
        "--allow-scripts=@opencode/cli",
        "@opencode/cli@latest",
      ]);
      const v1 = yield* resolveUpdate(
        "v1",
        npmGlobalInstall(v1Prefix, ["opencode-ai"], "opencode"),
      );
      assert.strictEqual(v1.update?.args.at(-1), "opencode-ai@latest");
      // A 1.x install is never offered 2.x's package, or the reverse.
      assert.isNull(
        (yield* resolveUpdate("v2", NodePath.join(v1Prefix, "bin", "opencode"))).update,
      );
      assert.isNull(
        (yield* resolveUpdate("v1", NodePath.join(v2Prefix, "bin", "opencode"))).update,
      );
      const executable = (...segments: ReadonlyArray<string>) => {
        const path = NodePath.join(root, ...segments);
        NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
        NodeFS.writeFileSync(path, "#!/bin/sh\n");
        NodeFS.chmodSync(path, 0o755);
        return path;
      };
      const launcher = executable("launcher", "opencode");
      const native = executable(".opencode", "bin", "opencode");
      for (const generation of ["v1", "v2"] as const) {
        assert.isNull((yield* resolveUpdate(generation, launcher)).update);
        assert.deepStrictEqual((yield* resolveUpdate(generation, native)).update?.args, [
          "upgrade",
        ]);
      }
    }),
);

// The update the driver offers follows the version the binary reports now.
const versionOutput: { current: string | undefined } = { current: undefined };
const versionProbes: Array<string> = [];
const changingRuntime = {
  runOpenCodeCommand: ({ binaryPath }: { readonly binaryPath: string }) =>
    Effect.sync(() => versionProbes.push(binaryPath)).pipe(
      Effect.andThen(
        versionOutput.current === undefined
          ? Effect.fail(
              new OpenCodeRuntime.OpenCodeRuntimeError({
                operation: "version",
                detail: "no version",
              }),
            )
          : Effect.succeed({ stdout: versionOutput.current, stderr: "", code: 0 }),
      ),
    ),
  startOpenCodeServerProcess: () => reachedServer("start"),
  connectToOpenCodeServer: () => reachedServer("connect"),
} as unknown as OpenCodeRuntime.OpenCodeRuntime["Service"];
const layerUpdate = Layer.mergeAll(
  IdAllocator.layer,
  McpProviderSessions.layer,
  ProviderLatestVersions.layer,
  TestProviderHost.layer(),
  Layer.succeed(
    ProviderEventLoggers.ProviderEventLoggers,
    ProviderEventLoggers.NoOpProviderEventLoggers,
  ),
  Layer.succeed(OpenCodeRuntime.OpenCodeRuntime, changingRuntime),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layerUpdate)("OpenCodeDriver updates", (it) => {
  it.effect("never runs the binary for a disabled instance's update check", () =>
    Effect.gen(function* () {
      versionProbes.length = 0;
      versionOutput.current = "opencode v2.0.18\n";
      const instance = yield* OpenCodeDriver.create({
        instanceId: ProviderInstanceId.make("opencode-disabled"),
        displayName: undefined,
        environment: [],
        enabled: false,
        config: { ...OpenCodeDriver.defaultConfig(), binaryPath: "opencode" },
      }).pipe(Effect.provideService(HttpClient.HttpClient, noHttp));
      const maintenance = yield* instance.snapshot.resolveMaintenance();
      yield* instance.snapshot.resolveMaintenance({ fresh: true });
      assert.isNull(maintenance.update);
      assert.deepStrictEqual(versionProbes, []);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "offers no package update for an unknown version and follows a changed one on a fresh read",
    () =>
      Effect.gen(function* () {
        const root = NodeFS.realpathSync(makeTempDir("t3-opencode-driver-update-"));
        const binaryPath = npmGlobalInstall(NodePath.join(root, "v1"), ["opencode-ai"], "opencode");
        const instance = yield* OpenCodeDriver.create({
          instanceId: ProviderInstanceId.make("opencode-update"),
          displayName: undefined,
          environment: [],
          enabled: true,
          config: { ...OpenCodeDriver.defaultConfig(), binaryPath },
        }).pipe(Effect.provideService(HttpClient.HttpClient, noHttp));

        // The version could not be read: which package owns the binary is unknown.
        versionOutput.current = undefined;
        const unknown = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.isNull(unknown.update);
        assert.isNull(unknown.packageName);

        versionOutput.current = "1.18.32\n";
        const v1 = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(v1.packageName, "opencode-ai");

        // The same path now reports 2.x (reinstalled in place): a fresh read re-probes
        // and never offers 1.x's package for it.
        versionOutput.current = "opencode v2.0.18\n";
        const v2 = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.strictEqual(v2.packageName, "@opencode/cli");
        assert.isNull(v2.update);

        // A self-built binary (a patched OpenCode) is never updated or checked for updates.
        versionOutput.current = "opencode v2.0.28-localai.1\n";
        const custom = yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.isNull(custom.update);
        assert.isNull(custom.packageName);
      }).pipe(Effect.scoped),
  );
});
