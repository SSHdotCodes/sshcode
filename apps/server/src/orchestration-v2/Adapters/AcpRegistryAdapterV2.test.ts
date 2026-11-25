import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ServerSettings from "../../serverSettings.ts";
import type {
  AcpRegistryAvailableCommands,
  AcpRegistryLiveConfiguration,
} from "@t3tools/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@t3tools/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import { ACP_SESSION_MODE_OPTION_ID } from "@t3tools/provider-acp/server/sessionConfig";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2 } from "../builtInProviderAdapterDrivers.ts";
import { AcpRegistryAdapterV2Driver } from "@t3tools/provider-acp-registry/server";
import {
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
  acpRegistryProbeResult,
} from "@t3tools/provider-acp-registry/testing";

const registryUrl = "https://registry.test/registry.json";
const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const layerHost = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

const layerRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              distribution: {
                binary: {
                  "darwin-aarch64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                  "linux-x86_64": {
                    archive: "https://registry.test/unused",
                    cmd: "fixture-agent",
                    args: [],
                  },
                },
              },
            },
          ],
        }),
      ),
    ),
  ),
);

// Adapters given an explicit runtime never resolve through the catalog.
const layerInjectedRuntimeCatalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
  resolve: () => Effect.die("the runtime is injected"),
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
  layerRegistry,
  ServerSettings.layerTest(),
);

const startDevinStopFixture = Effect.fnUntraced(function* (cwd: string, cancelFifo?: string) {
  const mockAgentPath = yield* (yield* Path.Path).fromFileUrl(
    new URL("../testkit/fixtures/devin_client_terminals/agent.mjs", import.meta.url),
  );
  const instanceId = ProviderInstanceId.make("acpRegistry_devin");
  const threadId = ThreadId.make("devin-stop");
  const adapter = yield* makeAcpRegistryAdapterV2({
    selfInvocation: yield* resolveSelfInvocation(),
    instanceId,
    settings: yield* decodeAcpRegistryAdapterSettings({ agentId: "devin" }),
    environment: {},
  }).pipe(
    Effect.provide(
      Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
        resolve: () =>
          Effect.succeed({
            distribution: "local" as const,
            spawn: {
              command: process.execPath,
              args: cancelFifo ? [mockAgentPath, cancelFifo] : [mockAgentPath],
            },
          }),
      }),
    ),
  );
  const modelSelection = { instanceId, model: "default" };
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd,
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("devin-stop"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({
    threadId,
    modelSelection,
    runtimePolicy,
  });
  yield* runtime.startTurn(
    makeTurnInput({
      threadId,
      providerThread,
      instanceId,
      runtimePolicy,
      now: yield* DateTime.now,
    }),
  );
  const turn = Option.getOrThrow(
    yield* runtime.events.pipe(
      Stream.filter((event) => event.type === "provider_turn.updated"),
      Stream.runHead,
    ),
  );
  return { runtime, providerThread, providerTurnId: turn.providerTurn.id };
});

describe("AcpRegistryAdapterV2", () => {
  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "Devin Stop reaps the foreground client terminal group and preserves a completed call's terminal",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped();
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        yield* spawner.exitCode(
          ChildProcess.make("mkfifo", ["foreground.fifo", "background.fifo"], { cwd }),
        );
        const { runtime, providerThread, providerTurnId } = yield* startDevinStopFixture(cwd);
        const readPids = (name: string) =>
          fs.readFileString(`${cwd}/${name}.fifo`).pipe(
            Effect.map((line) => {
              assert.match(line, /^\d+ \d+\n$/);
              return line.trim().split(" ").map(Number);
            }),
          );
        const background = yield* readPids("background");
        const foreground = yield* readPids("foreground");
        for (const pid of [-foreground[0]!, -background[0]!, ...foreground, ...background])
          process.kill(pid, 0);
        yield* runtime.interruptTurn({
          providerThread,
          providerTurnId,
          requestRuntimeRestart: true,
        });
        for (const pid of [-foreground[0]!, ...foreground]) {
          assert.throws(() => process.kill(pid, 0), /ESRCH/);
        }
        for (const pid of [-background[0]!, ...background]) process.kill(pid, 0);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "Stop retires a registry agent that ignores cancellation",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped();
        const cancelFifo = `${cwd}/cancel.fifo`;
        yield* (yield* ChildProcessSpawner.ChildProcessSpawner).exitCode(
          ChildProcess.make("mkfifo", [cancelFifo]),
        );
        const { runtime, providerThread, providerTurnId } = yield* startDevinStopFixture(
          cwd,
          cancelFifo,
        );
        const interrupt = yield* runtime
          .interruptTurn({
            providerThread,
            providerTurnId,
            requestRuntimeRestart: true,
          })
          .pipe(Effect.exit, Effect.forkScoped);
        const pid = Number(yield* fs.readFileString(cancelFifo));
        assert.isAbove(pid, 1);
        process.kill(pid, 0);
        yield* TestClock.adjust("20 seconds");
        assert.equal((yield* Fiber.join(interrupt))._tag, "Failure");
        assert.throws(() => process.kill(pid, 0), /ESRCH/);
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("the agent process env names the thread it serves", () =>
    Effect.gen(function* () {
      const selfInvocation = yield* resolveSelfInvocation();
      const mockAgentPath = yield* (yield* Path.Path).fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const endpoint = "http://127.0.0.1:43123/mcp";
      const instanceId = ProviderInstanceId.make("acp-registry-thread-env");
      const threadId = ThreadId.make("thread-acp-registry-thread-env");
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-acp-registry-thread-env"),
        threadId,
        providerSessionId: "mcp-session-acp-registry-thread-env",
        providerInstanceId: instanceId,
        endpoint,
        authorizationHeader: "Bearer thread-env-token",
        browserToolsAvailable: false,
      });
      // Several agents can run from one directory at once; the spawn env is how
      // a process the agent starts (an MCP server, a shell tool) finds its own
      // SSHCode thread, the same way Claude and Codex sessions do.
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const spawnEnvironments: Array<Record<string, unknown> | undefined> = [];
      const capturingSpawner = ChildProcessSpawner.make((command) =>
        Effect.sync(() => {
          if (command._tag === "StandardCommand") spawnEnvironments.push(command.options.env);
        }).pipe(Effect.andThen(spawner.spawn(command))),
      );
      const withCapturedSpawns = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, capturingSpawner),
        );
      const adapter = yield* withCapturedSpawns(
        makeAcpRegistryAdapterV2({
          selfInvocation,
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId: "claude-acp" }),
          environment: {},
        }).pipe(
          Effect.provide(
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: () =>
                Effect.succeed({
                  distribution: "local" as const,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                  },
                }),
            }),
          ),
        ),
      );
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const runtime = yield* withCapturedSpawns(
        adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-acp-registry-thread-env"),
          modelSelection,
          runtimePolicy,
        }),
      );
      yield* withCapturedSpawns(runtime.ensureThread({ threadId, modelSelection, runtimePolicy }));
      const agentEnvironment = spawnEnvironments.find(
        (environment) => environment?.T3_ACP_SESSION_LIFECYCLE === "1",
      );
      assert.isDefined(agentEnvironment, "the agent itself must have been spawned");
      assert.equal(agentEnvironment?.T3CODE_THREAD_ID, "thread-acp-registry-thread-env");
      assert.equal(agentEnvironment?.T3_ACP_MCP_ENDPOINT, endpoint);
      assert.equal(agentEnvironment?.T3_ACP_MCP_AUTHORIZATION, "Bearer thread-env-token");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it("preserves and sanitizes structured ACP errors without exposing arbitrary defects", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
    });
    assert.deepEqual(acpRegistryPromptFailure("mistral-vibe", limit), {
      class: "usage_limit",
      message: limit.errorMessage,
      code: "-31001",
      retryable: false,
    });
    assert.equal(acpRegistryPromptFailure("other-agent", limit).class, "usage_limit");
    assert.equal(
      acpRegistryPromptFailure("mistral-vibe", new Error("private defect")).message,
      "Provider turn failed.",
    );
    const rejected = acpRegistryPromptFailure(
      "any-agent",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Request rejected. api_key=private-key https://example.test/?token=secret",
      }),
    );
    assert.include(rejected.message, "Request rejected.");
    assert.notInclude(rejected.message, "private-key");
    assert.notInclude(rejected.message, "token=secret");
  });
  it("is registered as a generic provider driver with schema defaults", () => {
    assert.isTrue(BUILT_IN_PROVIDER_ADAPTER_DRIVER_KINDS_V2.has(ACP_REGISTRY_PROVIDER));
    assert.equal(AcpRegistryAdapterV2Driver.driverKind, ACP_REGISTRY_PROVIDER);
    assert.deepEqual(AcpRegistryAdapterV2Driver.defaultConfig(), {
      source: "registry",
      commandArgs: [],
      enabled: true,
      agentId: "",
      commandPath: "",
      authMethodId: "",
      distribution: "auto",
      customModels: [],
      hiddenModelPrefixes: [],
    });
  });

  it.effect("treats an unfinished ACP checklist update as a completed snapshot", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-todo-snapshot-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const outbound = (method: string, params: unknown = "<any>") => ({
        type: "expect_outbound",
        frame: { kind: "request", method, params },
      });
      const answer = (method: string, result: unknown) => ({
        type: "emit_inbound",
        frame: { kind: "response", method, result },
      });
      const notification = (method: string, params: unknown) => ({
        type: "emit_inbound",
        frame: { kind: "notification", method, params },
      });
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "unfinished-todo-snapshot",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session" }),
            outbound("session/prompt"),
            notification("session/update", {
              sessionId: "agent-session",
              update: {
                sessionUpdate: "plan",
                entries: [
                  { content: "Started step", priority: "medium", status: "in_progress" },
                  { content: "Later step", priority: "medium", status: "pending" },
                ],
              },
            }),
            answer("session/prompt", { stopReason: "end_turn" }),
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-todo-snapshot");
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "test",
        }),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
      const threadId = ThreadId.make("thread-acp-registry-todo-snapshot");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: replayDir,
      });
      const events = yield* Effect.gen(function* () {
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-todo-snapshot"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* runtime.startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
            ordinal: 1,
          }),
        );
        return Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
      }).pipe(Effect.scoped);
      const todoItem = events.find(
        (event) => event.type === "turn_item.updated" && event.turnItem.type === "todo_list",
      );
      assert.equal(
        todoItem?.type === "turn_item.updated" ? todoItem.turnItem.status : undefined,
        "completed",
      );
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  describe("the agent's own mode picker", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const permissionModeOption = (currentValue: string) => ({
      id: "permission-mode",
      name: "Permission mode",
      category: "mode",
      type: "select",
      currentValue,
      options: ["ask", "auto"].map((value) => ({ value, name: value })),
    });

    // A scripted ACP v1 agent: initialize, session/new answered with `setup`,
    // then the frames T3 must send (and the agent's answers) to apply the
    // user's stored pick from the agent's mode picker.
    const openWithStoredModePick = Effect.fn("openWithStoredModePick")(function* (input: {
      readonly setup: unknown;
      readonly modeFrames: ReadonlyArray<Frame>;
      readonly storedModePick: string;
      readonly storedOptions?: ReadonlyArray<{ readonly id: string; readonly value: string }>;
      readonly failsConfiguration?: boolean;
      readonly storedModel?: string;
      readonly rejectedMessage?: string;
    }) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-mode-pick-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-mode-pick",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.modeFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-mode-pick");
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "test",
        }),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
      yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-acp-registry-mode-pick"),
          providerSessionId: ProviderSessionId.make("provider-session-mode-pick"),
          modelSelection: {
            instanceId,
            model: input.storedModel ?? "default",
            options: input.storedOptions ?? [
              { id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick },
            ],
          },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "approval-required",
            interactionMode: "default",
            cwd: replayDir,
          }),
        })
        .pipe(
          Effect.match({
            onFailure: (error) => {
              assert.equal(input.failsConfiguration, true);
              if (input.rejectedMessage !== undefined)
                assert.equal(makeProviderFailure({ cause: error }).message, input.rejectedMessage);
            },
            onSuccess: () => assert.notEqual(input.failsConfiguration, true),
          }),
          Effect.scoped,
        );
      // Closing the session stops the agent, which writes its replay status in
      // the same tick as its last answer. The script must be consumed exactly.
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
    });

    const modelOptions = [
      { id: "fast", name: "Fast", category: "model", type: "boolean", currentValue: false },
      {
        id: " ",
        name: "Unnamed",
        category: "model",
        type: "select",
        currentValue: "unaddressable",
        options: [{ value: "unaddressable", name: "Unaddressable" }],
      },
      {
        id: "provider",
        name: "Provider",
        category: "model",
        type: "select",
        currentValue: "gateway",
        options: [
          {
            group: "hosted",
            name: "Hosted",
            options: [
              { value: "gateway", name: "Gateway" },
              { value: "codex", name: "Codex" },
            ],
          },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "later-model",
        options: [{ value: "later-model", name: "Later model" }],
      },
    ] as const;

    it.effect("discovers and writes the first usable model select, including grouped choices", () =>
      Effect.gen(function* () {
        const catalog = acpRegistryProbeResult(ProviderInstanceId.make("acp-registry-mode-pick"), {
          sessionId: "agent-session",
          initializeResult: { protocolVersion: 1 },
          sessionSetupResult: {
            sessionId: "agent-session",
            configOptions: modelOptions.map((option) =>
              option.id === "provider"
                ? {
                    ...option,
                    options: [{ ...option.options[0], groupId: option.options[0].group }],
                  }
                : option,
            ),
          },
          modelConfigId: "provider",
        });
        assert.deepEqual(
          catalog.models.map((model) => model.id),
          ["gateway", "codex"],
        );
        assert.equal(catalog.currentModelId, "gateway");
        yield* openWithStoredModePick({
          setup: { configOptions: modelOptions },
          storedModel: "codex",
          storedModePick: "unused",
          storedOptions: [],
          modeFrames: [
            outbound("session/set_config_option", {
              sessionId: "agent-session",
              configId: "provider",
              value: "codex",
            }),
            answer("session/set_config_option", {
              configOptions: modelOptions.map((option) =>
                option.id === "provider" ? { ...option, currentValue: "codex" } : option,
              ),
            }),
          ],
        });
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect.each(["config", "legacy"] as const)(
      "explains a refused model selection through %s model writes",
      (protocol) =>
        openWithStoredModePick({
          setup:
            protocol === "config"
              ? {
                  configOptions: [
                    {
                      id: "model",
                      name: "Model",
                      category: "model",
                      type: "select",
                      currentValue: "default",
                      options: ["default", "named"].map((value) => ({ value, name: value })),
                    },
                  ],
                }
              : {
                  models: {
                    currentModelId: "default",
                    availableModels: ["default", "named"].map((modelId) => ({
                      modelId,
                      name: modelId,
                    })),
                  },
                },
          storedModePick: "unused",
          storedOptions: [],
          storedModel: "named",
          failsConfiguration: true,
          rejectedMessage:
            'The agent did not accept the model "named". Choose another model for this provider, then retry.',
          modeFrames: [
            outbound(protocol === "config" ? "session/set_config_option" : "session/set_model"),
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: protocol === "config" ? "session/set_config_option" : "session/set_model",
                error: { code: -32602, message: "Invalid provider" },
              },
            },
          ],
        }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect.each([-32602, -32603])(
      "only tolerates a refused configuration value (code %s)",
      (code) =>
        openWithStoredModePick({
          setup: {
            configOptions: [
              {
                id: "thinking",
                name: "Thinking",
                type: "select",
                currentValue: "low",
                options: ["low", "high"].map((value) => ({ value, name: value })),
              },
            ],
          },
          storedModePick: "unused",
          storedOptions: [{ id: "thinking", value: "high" }],
          failsConfiguration: code !== -32602,
          modeFrames: [
            outbound("session/set_config_option", {
              sessionId: "agent-session",
              configId: "thinking",
              value: "high",
            }),
            {
              type: "emit_inbound",
              frame: {
                kind: "response",
                method: "session/set_config_option",
                error: { code, message: code === -32602 ? "Invalid value" : "Internal error" },
              },
            },
          ],
        }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("switches an agent that only advertises modes with session/set_mode", () =>
      openWithStoredModePick({
        setup: {
          modes: {
            currentModeId: "default",
            availableModes: ["default", "autoEdit"].map((id) => ({ id, name: id })),
          },
        },
        modeFrames: [
          outbound("session/set_mode", { sessionId: "agent-session", modeId: "autoEdit" }),
          answer("session/set_mode", {}),
        ],
        storedModePick: "autoEdit",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("switches a mode config option under its own id", () =>
      openWithStoredModePick({
        setup: { configOptions: [permissionModeOption("ask")] },
        modeFrames: [
          outbound("session/set_config_option", {
            sessionId: "agent-session",
            configId: "permission-mode",
            value: "auto",
          }),
          answer("session/set_config_option", { configOptions: [permissionModeOption("auto")] }),
        ],
        storedModePick: "auto",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
  });

  describe("the agent's own pickers", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const permissionModeOption = (currentValue: string) => ({
      id: "permission-mode",
      name: "Permission mode",
      category: "mode",
      type: "select",
      currentValue,
      options: ["ask", "auto"].map((value) => ({ value, name: value })),
    });

    const openWithStoredPicks = Effect.fn("openWithStoredPicks")(function* (input: {
      readonly setup: unknown;
      readonly pickFrames: ReadonlyArray<Frame>;
      readonly customModels?: ReadonlyArray<string>;
      readonly storedModel?: string;
      readonly storedModePick?: string;
      readonly turnModels?: ReadonlyArray<string>;
      readonly rejectedModel?: string;
    }) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-stored-picks-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-picks",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.pickFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-stored-picks");
      let published: AcpRegistryLiveConfiguration | undefined;
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "test",
          customModels: input.customModels ?? [],
        }),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          customModels: input.customModels,
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerInjectedRuntimeCatalog,
            Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
              withForegroundStartup: (_startupKey, effect) => effect,
              publishLiveConfiguration: (_instanceId, configuration) =>
                Effect.sync(() => {
                  published = configuration;
                }),
            }),
          ),
        ),
      );
      const threadId = ThreadId.make("thread-acp-registry-stored-picks");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: replayDir,
      });
      const stored: ModelSelection = {
        instanceId,
        model: input.storedModel ?? "default",
        ...(input.storedModePick === undefined
          ? {}
          : { options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick }] }),
      };
      const configurations: Array<AcpRegistryLiveConfiguration | undefined> = [];
      yield* Effect.gen(function* () {
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-stored-picks"),
          modelSelection: stored,
          runtimePolicy,
        });
        configurations.push(published);
        if (input.turnModels === undefined) return;
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: stored,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        let current = stored;
        for (const [index, model] of input.turnModels.entries()) {
          const target: ModelSelection = { instanceId, model };
          const plan = yield* adapter.planSelectionTransition({
            current,
            target,
            sessionCapabilities: runtime.providerSession.capabilities,
          });
          assert.equal(plan.type, "apply_on_next_turn");
          yield* runtime.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now,
              ordinal: index + 1,
              modelSelection: target,
            }),
          );
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "turn.terminal") {
                  assert.equal(event.status, "completed", event.failure?.message);
                }
              }),
            ),
          );
          configurations.push(published);
          current = target;
        }
      }).pipe(
        Effect.match({
          onFailure: (error) => {
            assert.isDefined(input.rejectedModel);
            assert.equal(
              makeProviderFailure({ cause: error }).message,
              `The agent did not accept the model "${input.rejectedModel}". Choose another model for this provider, then retry.`,
            );
          },
          onSuccess: () => assert.isUndefined(input.rejectedModel),
        }),
        Effect.scoped,
      );

      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
      return { configurations };
    });

    const modelOption = (id: string, currentValue: string, grouped = false) => ({
      id,
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: grouped
        ? [{ group: "models", name: "Models", options: [{ value: "default", name: "Default" }] }]
        : [{ value: "auto", name: "Auto" }],
    });
    const configOptionUpdate = (configOptions: ReadonlyArray<unknown>): Frame => ({
      type: "emit_inbound",
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: "agent-session",
          update: { sessionUpdate: "config_option_update", configOptions },
        },
      },
    });
    const prompt = (...updates: ReadonlyArray<Frame>): ReadonlyArray<Frame> => [
      outbound("session/prompt"),
      {
        type: "emit_inbound",
        frame: {
          kind: "notification",
          method: "session/update",
          params: {
            sessionId: "agent-session",
            update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok" } },
          },
        },
      },
      ...updates,
      answer("session/prompt", { stopReason: "end_turn" }),
    ];
    const setModel = (modelId: string): ReadonlyArray<Frame> => [
      outbound("session/set_model", { sessionId: "agent-session", modelId }),
      answer("session/set_model", {}),
    ];

    it.effect(
      "discovers session models and switches through live model configuration changes",
      () =>
        Effect.gen(function* () {
          const flatOption = (current: string) => modelOption("live-model", current);
          const groupedOption = (current: string) =>
            modelOption("replacement-model", current, true);
          const { configurations } = yield* openWithStoredPicks({
            setup: {
              models: {
                currentModelId: "hermes",
                availableModels: ["hermes", "auto", "default"].map((modelId) => ({
                  modelId,
                  name: modelId,
                })),
              },
            },
            customModels: ["custom-model"],
            storedModel: "default",
            turnModels: [
              "hermes",
              "custom-model",
              "auto",
              "default",
              "hermes",
              "custom-model",
              "auto",
              "custom-model",
              "default",
              "hermes",
            ],
            pickFrames: [
              ...setModel("default"),
              ...setModel("hermes"),
              ...prompt(),
              ...setModel("custom-model"),
              ...prompt(),
              ...setModel("auto"),
              ...prompt(),
              ...setModel("default"),
              ...prompt(),
              ...setModel("hermes"),
              ...prompt(configOptionUpdate([flatOption("hermes")])),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "live-model",
                value: "custom-model",
              }),
              answer("session/set_config_option", { configOptions: [flatOption("custom-model")] }),
              ...prompt(),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "live-model",
                value: "auto",
              }),
              answer("session/set_config_option", { configOptions: [flatOption("auto")] }),
              ...prompt(configOptionUpdate([groupedOption("auto")])),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "replacement-model",
                value: "custom-model",
              }),
              answer("session/set_config_option", {
                configOptions: [groupedOption("custom-model")],
              }),
              ...prompt(),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "replacement-model",
                value: "default",
              }),
              answer("session/set_config_option", { configOptions: [groupedOption("default")] }),
              ...prompt(configOptionUpdate([])),
              ...setModel("hermes"),
              ...prompt(),
            ],
          });
          assert.deepEqual(
            configurations.map((configuration) => ({
              models: configuration?.models.map((model) => model.id),
              current: configuration?.currentModelId,
            })),
            [
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["hermes", "auto", "default"], current: "hermes" },
              { models: ["hermes", "auto", "default"], current: null },
              { models: ["hermes", "auto", "default"], current: "auto" },
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["auto"], current: null },
              { models: ["auto"], current: null },
              { models: ["default"], current: null },
              { models: ["default"], current: null },
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["hermes", "auto", "default"], current: "hermes" },
            ],
          );
        }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect.each([
      "config",
      "legacy",
      "updated-config",
      "removed-config",
      "configuration-update",
      "unavailable-before-configuration",
    ] as const)(
      "rejects an unavailable explicit model in a %s catalog before inference",
      (catalog) => {
        const duringTurn = catalog === "updated-config" || catalog === "removed-config";
        const duringConfiguration = catalog === "configuration-update";
        const changesOptions =
          duringConfiguration || catalog === "unavailable-before-configuration";
        const model = duringTurn || duringConfiguration ? "hermes" : "missing";
        const restrictedOption = {
          ...modelOption("model", "other"),
          options: [{ value: "other", name: "Other" }],
        };
        return openWithStoredPicks({
          setup: {
            ...(catalog === "legacy" || catalog === "removed-config"
              ? {
                  models: {
                    currentModelId: "other",
                    availableModels: [{ modelId: "other", name: "Other" }],
                  },
                }
              : {}),
            configOptions:
              catalog === "legacy"
                ? []
                : [
                    {
                      ...modelOption("model", "hermes"),
                      options: [{ value: "hermes", name: "Hermes" }],
                    },
                    ...(changesOptions ? [permissionModeOption("ask")] : []),
                  ],
          },
          storedModel: model,
          ...(duringTurn ? { turnModels: [model, model] } : {}),
          ...(changesOptions ? { storedModePick: "auto" } : {}),
          rejectedModel: model,
          pickFrames: duringTurn
            ? prompt(configOptionUpdate(catalog === "removed-config" ? [] : [restrictedOption]))
            : duringConfiguration
              ? [
                  outbound("session/set_config_option", {
                    sessionId: "agent-session",
                    configId: "permission-mode",
                    value: "auto",
                  }),
                  answer("session/set_config_option", {
                    configOptions: [restrictedOption, permissionModeOption("auto")],
                  }),
                ]
              : [],
        }).pipe(Effect.provide(layerTest), Effect.scoped);
      },
    );

    it.effect("keeps unadvertised default and auto selections agent-controlled", () =>
      Effect.gen(function* () {
        const { configurations } = yield* openWithStoredPicks({
          setup: {
            models: {
              currentModelId: "hermes",
              availableModels: ["hermes", "other"].map((modelId) => ({ modelId, name: modelId })),
            },
          },
          storedModel: "default",
          turnModels: ["auto", "default", "other", "default", "auto", "default", "auto"],
          pickFrames: [
            ...prompt(),
            ...prompt(),
            ...setModel("other"),
            ...prompt(
              configOptionUpdate([
                {
                  ...modelOption("live-model", "other"),
                  options: [{ value: "other", name: "Other" }],
                },
              ]),
            ),
            ...prompt(),
            ...prompt(),
            ...prompt(
              configOptionUpdate([
                {
                  ...modelOption("replacement-model", "other", true),
                  options: [
                    {
                      group: "models",
                      name: "Models",
                      options: [{ value: "other", name: "Other" }],
                    },
                  ],
                },
              ]),
            ),
            ...prompt(),
          ],
        });
        assert.deepEqual(
          configurations.map((configuration) => configuration?.currentModelId),
          ["hermes", "hermes", "hermes", "other", "other", "other", "other", "other"],
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
  });

  it.effect("offers client terminals to Devin only and client fs to no registry agent", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const advertisedCapabilities = Effect.fn("advertisedCapabilities")(function* (
        agentId: string,
      ) {
        let clientCapabilities: unknown;
        const instanceId = ProviderInstanceId.make(`acp-registry-capabilities-${agentId}`);
        const adapter = yield* makeAcpRegistryAdapterV2({
          selfInvocation: yield* resolveSelfInvocation(),
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId, authMethodId: "test" }),
          environment: {},
          makeRuntime: (input) =>
            Effect.gen(function* () {
              clientCapabilities = input.clientCapabilities;
              const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
              const context = yield* Layer.build(
                AcpSessionRuntime.layer({
                  ...runtimeInput,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    cwd: input.cwd,
                    env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                  },
                  authMethodId: "test",
                }).pipe(
                  Layer.provide(
                    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                  ),
                ),
              );
              return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
                Effect.provide(context),
              );
            }),
        }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        yield* adapter.openSession({
          threadId: ThreadId.make(`thread-acp-registry-capabilities-${agentId}`),
          providerSessionId: ProviderSessionId.make(`provider-session-capabilities-${agentId}`),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy,
        });
        return clientCapabilities;
      });

      assert.deepInclude(yield* advertisedCapabilities("devin"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      });
      assert.deepInclude(yield* advertisedCapabilities("gemini"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("opens a real ACP child process resolved from registry configuration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: host.paths.providerStatusCacheDir,
        toolsDir: host.paths.baseDir + "/tools",
        registryUrl,
      });
      const settings = yield* decodeAcpRegistryAdapterSettings({
        agentId: "fixture-agent",
        commandPath: process.execPath,
        authMethodId: "test",
      });
      let startupActive = false;
      let startupCount = 0;
      const instanceId = ProviderInstanceId.make("acp-registry-fixture");
      const commandsPublished = yield* Deferred.make<{
        readonly instanceId: ProviderInstanceId;
        readonly commands: AcpRegistryAvailableCommands;
      }>();
      const configurationPublished = yield* Deferred.make<AcpRegistryLiveConfiguration>();
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings,
        environment: {
          T3_ACP_SESSION_LIFECYCLE: "1",
          T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "750",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
              withForegroundStartup: (agentId, effect) =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    assert.equal(agentId, "fixture-agent");
                    startupActive = true;
                    startupCount += 1;
                  }),
                  () => effect,
                  () =>
                    Effect.sync(() => {
                      startupActive = false;
                    }),
                ),
              runBackgroundProbe: (_agentId, effect) => effect.pipe(Effect.map(Option.some)),
              withSessionMutation: (effect) => effect,
              clearAvailableCommands: () => Effect.void,
              publishAvailableCommands: (publishedInstanceId, commands) =>
                Deferred.succeed(commandsPublished, {
                  instanceId: publishedInstanceId,
                  commands,
                }).pipe(Effect.asVoid),
              getAvailableCommands: () => Effect.succeed(Option.none()),
              watchAvailableCommands: () => Effect.never,
              clearLiveConfiguration: () => Effect.void,
              publishLiveConfiguration: (_publishedInstanceId, configuration) =>
                Deferred.succeed(configurationPublished, configuration).pipe(Effect.asVoid),
              getLiveConfiguration: () => Effect.succeed(Option.none()),
              watchLiveConfiguration: () => Effect.never,
              requestUrlAuthentication: () => Effect.succeed(false),
              acceptUrlAuthentication: () => Effect.succeed(false),
              getUrlAuthAction: () => Effect.succeed(Option.none()),
              watchUrlAuthAction: () => Effect.never,
            }),
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: (configuredSettings, cwd, environment) =>
                Effect.sync(() => assert.isTrue(startupActive)).pipe(
                  Effect.andThen(resolver.resolve(configuredSettings, cwd, environment)),
                  Effect.map((resolved) => ({
                    ...resolved,
                    spawn: {
                      ...resolved.spawn,
                      args: [mockAgentPath],
                    },
                  })),
                ),
            }),
          ),
        ),
      );
      const threadId = ThreadId.make("thread-acp-registry-fixture");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-fixture"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      assert.equal(runtime.providerSession.driver, "acpRegistry");
      assert.equal(startupCount, 1);
      assert.isFalse(startupActive);
      assert.equal(providerThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.equal(providerThread.nativeMetadata?.itemIdentityVersion, 2);
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.deepEqual(yield* Deferred.await(commandsPublished), {
        instanceId,
        commands: {
          slashCommands: [
            {
              name: "review",
              description: "Review the current changes",
              input: { hint: "focus" },
            },
          ],
          skills: [
            {
              name: "workspace-skill",
              description: "Run the workspace skill",
              path: "acp://skill/workspace-skill",
              scope: "agent",
              enabled: true,
            },
          ],
        },
      });
      const configuration = yield* Deferred.await(configurationPublished);
      assert.equal(configuration.currentModelId, "default");
      assert.deepInclude(configuration.models[0], {
        id: "default",
        name: "Auto",
        description: null,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
