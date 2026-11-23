import { XPostToolkit } from "./toolkits/xPost/tools.ts";
import { setWorkflowsBetaEnabled } from "../workflows/workflowsBeta.ts";
import { WorkflowToolkit } from "./toolkits/workflows/tools.ts";
import { DebugToolkit } from "./toolkits/debug/tools.ts";
import { QaSandbox } from "../preview/QaSandbox.ts";
import { ModelPreferencesToolkit } from "./toolkits/modelPreferences/tools.ts";
import { ComputerToolkit } from "./toolkits/computer/tools.ts";
import { expect, it } from "@effect/vitest";
import {
  AuthMcpClientAccess,
  EnvironmentId,
  DEFAULT_AGENT_TOOL_POLICY,
  isAgentToolEnabled,
  ProviderInstanceId,
  ThreadId,
  ServerSettingsError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as ChatControls from "../sessionBoxes/chatControls.ts";
let chatControls = ChatControls.make().store;
const resetChatControlsForTests = () => {
  chatControls = ChatControls.make().store;
};
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentToolPolicy from "./AgentToolPolicy.ts";
import {
  agentToolCatalog,
  agentToolkits,
  agentToolListVisible as listVisible,
  callerReadsGeminiSchemas,
  deviceAgentToolNames,
  previewAgentToolNames,
  rewriteToolsListBody,
  withGeminiSafeEnums,
  withoutGrades,
  toolsListRequestIds,
} from "./AgentToolCatalog.ts";
import { advertisedJsonSchema } from "./advertisedJsonSchema.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ProjectListToolkit } from "./toolkits/project/tools.ts";
import { PendingRequestToolkit } from "./toolkits/thread/tools.ts";

const namesIn = (toolkit: { readonly tools: Record<string, unknown> }) =>
  Object.keys(toolkit.tools).toSorted();

const environmentId = EnvironmentId.make("environment-mcp-test");
const threadId = ThreadId.make("thread-mcp-test");
const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "provider-session-mcp-test",
  thread: {
    threadId,
    providerSessionId: "provider-session-mcp-test",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const previewLayer = (tools: Readonly<Record<string, boolean>> = {}) =>
  McpHttpServer.layerPreviewToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
    Layer.provideMerge(PreviewAutomationBroker.layer),
    Layer.provide(Layer.mock(QaSandbox)({ touch: () => Effect.void })),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-tool-policy-" })),
    Layer.provideMerge(
      ServerSettings.layerTest({
        agentToolPolicy: { enabled: true, tools, providers: {} },
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const agentToolListVisible = (
  ...args: Parameters<typeof listVisible> extends [...infer A, unknown] ? A : never
) => listVisible(...args, chatControls);

it("derives the agent catalog from the registered toolkits", () => {
  const names = agentToolCatalog.map((tool) => tool.name);
  expect(names).toEqual([
    ...namesIn(OrchestratorToolkit),
    ...namesIn(WorkflowToolkit),
    ...namesIn(ModelPreferencesToolkit),
    ...namesIn(XPostToolkit),
    ...namesIn(DebugToolkit),
    ...namesIn(PendingRequestToolkit),
    ...namesIn(ProjectListToolkit),
    ...namesIn(DeviceToolkit),
    ...namesIn(PreviewToolkit),
    ...namesIn(ComputerToolkit),
  ]);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toContain("delegate_task");
  expect(names).not.toContain("cloud_session_move");
  expect(names).toContain("t3_pending_request_list");
  expect(names).toContain("computer_open");
  expect(names).toContain("computer_screenshot");
  expect(names).not.toContain("computer_resume");
  expect(names).not.toContain("computer_setup");
  expect(names).not.toContain("t3_worktree_handoff");
  expect(names).not.toContain("html_preview");
  expect(names.some((name) => name.includes("agent_tool_policy"))).toBe(false);

  const screenshot = agentToolCatalog.find((tool) => tool.name === "device_screenshot");
  expect(screenshot).toMatchObject({
    group: "device",
    title: "Screenshot device",
    readonly: true,
  });
  expect(deviceAgentToolNames.has("device_screenshot")).toBe(true);
  const snapshot = agentToolCatalog.find((tool) => tool.name === "preview_snapshot");
  expect(snapshot).toMatchObject({ group: "browser", title: "Inspect browser page" });
  expect(previewAgentToolNames.has("preview_snapshot")).toBe(true);
});

it("applies provider, tool, then global precedence", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claudeAgent");
  const policy = {
    enabled: false,
    tools: { device_screenshot: true, delegate_task: false },
    providers: {
      [codex]: { enabled: false, tools: { device_screenshot: false } },
      [claude]: { enabled: true, tools: {} },
    },
  };
  expect(isAgentToolEnabled(policy, "device_screenshot", "codex")).toBe(false);
  expect(isAgentToolEnabled(policy, "delegate_task", "codex")).toBe(false);
  expect(isAgentToolEnabled(policy, "monitor_list", "claudeAgent")).toBe(true);
  expect(isAgentToolEnabled(policy, "device_screenshot", "future_provider")).toBe(true);
  expect(isAgentToolEnabled(policy, "delegate_task")).toBe(false);
  expect(isAgentToolEnabled(policy, "monitor_list")).toBe(false);
  expect(isAgentToolEnabled(policy, "future_tool", "future_provider")).toBe(false);
});

it("hides device and browser tools unless the credential grants them", () => {
  const policy = { enabled: true, tools: {}, providers: {} };
  const thread = invocation(["device"]);
  expect(agentToolListVisible(policy, "delegate_task", thread)).toBe(true);
  expect(agentToolListVisible(policy, "device_screenshot", thread)).toBe(true);
  expect(agentToolListVisible(policy, "preview_snapshot", thread)).toBe(false);
  expect(agentToolListVisible(policy, "preview_snapshot", invocation(["preview"]))).toBe(true);
  expect(agentToolListVisible(policy, "device_list", { ...thread, thread: undefined })).toBe(false);
  expect(agentToolListVisible(policy, "computer_open", invocation(["orchestration"]))).toBe(true);
  expect(agentToolListVisible(policy, "computer_open", { ...thread, thread: undefined })).toBe(
    false,
  );
  expect(agentToolListVisible(policy, "computer_open", invocation(["preview"]))).toBe(false);
  expect(
    agentToolListVisible(
      { enabled: true, tools: { delegate_task: false }, providers: {} },
      "delegate_task",
      thread,
    ),
  ).toBe(false);
});

it.effect("hides delegation tools for a chat with subagents off", () =>
  Effect.gen(function* () {
    resetChatControlsForTests();
    setWorkflowsBetaEnabled(true);
    try {
      const policy = { enabled: true, tools: {}, providers: {} };
      const thread = invocation(["orchestration"]);
      expect(agentToolListVisible(policy, "delegate_task", thread)).toBe(true);
      expect(agentToolListVisible(policy, "workflow", thread)).toBe(true);
      yield* chatControls.command({ action: "subagents", threadId, enabled: false });
      for (const name of ["delegate_task", "council", "task_status", "task_cancel", "workflow"]) {
        expect(agentToolListVisible(policy, name, thread)).toBe(false);
      }
      expect(agentToolListVisible(policy, "create_threads", thread)).toBe(true);
      expect(agentToolListVisible(policy, "ask_user", thread)).toBe(true);
      expect(agentToolListVisible(policy, "delegate_task", { ...thread, thread: undefined })).toBe(
        true,
      );
    } finally {
      resetChatControlsForTests();
      setWorkflowsBetaEnabled(false);
    }
  }),
);

it.effect.each(["delegate_task", "workflow"])(
  "refuses a cached %s call when subagents are off",
  (tool) =>
    Effect.gen(function* () {
      const chatControls = ChatControls.make().store;
      yield* chatControls.command({ action: "subagents", threadId, enabled: false });
      const denied = yield* AgentToolPolicy.refuseUnavailableAgentTool(tool).pipe(
        Effect.provideService(ChatControls.ChatControls, chatControls),
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(["orchestration"]),
        ),
      );
      expect(denied?.isError).toBe(true);
      expect(denied?.content).toEqual([{ type: "text", text: "Subagents are off for this chat." }]);
      const kept = yield* AgentToolPolicy.refuseUnavailableAgentTool("create_threads").pipe(
        Effect.provideService(ChatControls.ChatControls, chatControls),
        Effect.provideService(
          McpInvocationContext.McpInvocationContext,
          invocation(["orchestration"]),
        ),
      );
      expect(kept).toBeUndefined();
    }),
);

it("rewrites tools/list JSON, ndjson, and SSE without touching other methods", () => {
  const ids = toolsListRequestIds('{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}\n');
  expect(ids).toEqual(new Set(["2"]));
  expect(toolsListRequestIds('{"jsonrpc":"2.0","id":1,"method":"initialize"}')).toBeUndefined();

  const visible = (name: string) => name !== "device_screenshot";
  const json = rewriteToolsListBody(
    ' \n{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"delegate_task"},{"name":"device_screenshot"}]}}\n',
    new Set(["2"]),
    visible,
  );
  expect(json.startsWith(" \n")).toBe(true);
  expect(JSON.parse(json).result.tools).toEqual([{ name: "delegate_task" }]);

  const ndjson = rewriteToolsListBody(
    [
      '{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"device_screenshot"}]}}',
      '{"jsonrpc":"2.0","id":9,"result":{"tools":[{"name":"device_screenshot"}]}}',
    ].join("\n"),
    new Set(["2"]),
    visible,
  );
  const [first, second] = ndjson.split("\n").map((line) => JSON.parse(line));
  expect(first.result.tools).toEqual([]);
  expect(second.result.tools).toEqual([{ name: "device_screenshot" }]);

  const sse = rewriteToolsListBody(
    'data: {"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"delegate_task"},{"name":"device_screenshot"}]}}\n\n',
    new Set(["2"]),
    visible,
  );
  expect(sse.startsWith("data: ")).toBe(true);
  expect(JSON.parse(sse.slice("data: ".length)).result.tools).toEqual([{ name: "delegate_task" }]);

  const call =
    '{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"data: keep"}]}}';
  expect(rewriteToolsListBody(call, new Set(["2"]), visible)).toBe(call);
});

it("drops the grades input from subagent tools when grading is off", () => {
  const schema = (extra: object) => ({
    type: "object",
    properties: { taskId: { type: "string" }, ...extra },
    required: ["taskId"],
  });
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    result: {
      tools: [
        { name: "task_status", inputSchema: schema({ grades: { type: "array" } }) },
        { name: "monitor_start", inputSchema: schema({ grades: { type: "array" } }) },
        { name: "task_cancel", inputSchema: schema({}) },
      ],
    },
  });
  const tools = JSON.parse(rewriteToolsListBody(body, new Set(["3"]), () => true, withoutGrades))
    .result.tools;
  expect(tools[0].inputSchema).toEqual(schema({}));
  // Only the subagent tools carry grades; other tools keep their schemas untouched.
  expect(tools[1].inputSchema.properties.grades).toEqual({ type: "array" });
  expect(rewriteToolsListBody(body, new Set(["3"]), () => true)).toBe(body);
});

it("gives Antigravity chats tool schemas Gemini accepts", () => {
  // Gemini refuses a whole request when any enum lists null or "" (11-18: every
  // Antigravity turn failed with INVALID_ARGUMENT before the model ran).
  const badChoices = (value: unknown): number =>
    Array.isArray(value)
      ? value.reduce((sum: number, item) => sum + badChoices(item), 0)
      : typeof value === "object" && value !== null
        ? Object.entries(value).reduce(
            (sum: number, [key, child]) =>
              sum +
              (key === "enum" && Array.isArray(child)
                ? child.filter((choice) => choice === null || choice === "").length
                : badChoices(child)),
            0,
          )
        : 0;
  const tools = agentToolkits.flatMap((toolkit) =>
    Object.values(toolkit.tools).map((tool) => ({
      name: tool.name,
      inputSchema: advertisedJsonSchema(tool) as unknown,
    })),
  );
  expect(badChoices(tools.map((tool) => tool.inputSchema))).toBeGreaterThan(0);
  const safe = tools.map((tool) => withGeminiSafeEnums(tool));
  expect(badChoices(safe.map((tool) => tool.inputSchema))).toBe(0);
  // A nullable choice can still be cleared: null stays in its type.
  const create = safe.find((tool) => tool.name === "create_threads")?.inputSchema as {
    properties: { threads: { items: { properties: { runtimeMode: unknown } } } };
  };
  expect(create.properties.threads.items.properties.runtimeMode).toMatchObject({
    type: ["string", "null"],
    enum: expect.not.arrayContaining([null]),
  });

  // Only chats on a Gemini driver get the rewrite; a built-in instance may be missing from settings.
  expect(callerReadsGeminiSchemas({}, "antigravity")).toBe(true);
  expect(callerReadsGeminiSchemas({ work: { driver: "antigravity" } }, "work")).toBe(true);
  expect(callerReadsGeminiSchemas({ codex_work: { driver: "codex" } }, "codex_work")).toBe(false);
  expect(callerReadsGeminiSchemas({}, undefined)).toBe(false);
});

it.effect("serves the stored policy with the derived catalog", () =>
  Effect.gen(function* () {
    const service = yield* AgentToolPolicy.AgentToolPolicy;
    const state = yield* service.state;
    expect(state.policy).toEqual({
      enabled: false,
      tools: { future_tool: false },
      providers: {},
    });
    expect(state.tools.map((tool) => tool.name)).toEqual(agentToolCatalog.map((tool) => tool.name));
    expect(state.tools.some((tool) => tool.name === "future_tool")).toBe(false);
  }).pipe(
    Effect.provide(
      AgentToolPolicy.layer.pipe(
        Layer.provide(
          ServerSettings.layerTest({
            agentToolPolicy: { enabled: false, tools: { future_tool: false }, providers: {} },
          }),
        ),
      ),
    ),
  ),
);

it.effect("allows every tool when settings are not registered", () =>
  Effect.gen(function* () {
    expect((yield* AgentToolPolicy.currentAgentToolPolicy).enabled).toBe(true);
  }),
);

it.effect("keeps tools unavailable when a settings read fails after loading a saved policy", () =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const failed = yield* Ref.make(false);
    const guarded = {
      ...settings,
      getSettings: Ref.get(failed).pipe(
        Effect.flatMap((fail) =>
          fail
            ? Effect.fail(
                new ServerSettingsError({
                  settingsPath: "/test/settings.json",
                  operation: "read-secret",
                }),
              )
            : settings.getSettings,
        ),
      ),
    };
    yield* Effect.gen(function* () {
      expect(
        isAgentToolEnabled(yield* AgentToolPolicy.currentAgentToolPolicy, "delegate_task"),
      ).toBe(false);
      yield* Ref.set(failed, true);
      const policy = yield* AgentToolPolicy.currentAgentToolPolicy;
      expect(isAgentToolEnabled(policy, "delegate_task")).toBe(false);
      expect(isAgentToolEnabled(policy, "preview_snapshot", "codex")).toBe(false);
      const denied = yield* AgentToolPolicy.refuseDisabledAgentTool("delegate_task");
      expect(denied?.isError).toBe(true);
      expect(denied?.content).toEqual([
        {
          type: "text",
          text: "SSHCode tool settings are temporarily unavailable. Retry after the environment recovers.",
        },
      ]);
    }).pipe(Effect.provideService(ServerSettings.ServerSettingsService, guarded));
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({
        agentToolPolicy: {
          enabled: false,
          tools: {},
          providers: { [ProviderInstanceId.make("codex")]: { enabled: true, tools: {} } },
        },
      }),
    ),
  ),
);

const callSnapshot = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({ name: "preview_snapshot", arguments: {} })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.effect("refuses a disabled screenshot tool before the browser broker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
      const requests = yield* Ref.make(0);
      const events = yield* broker.connect({ clientId: "policy-client", environmentId });
      yield* Stream.runForEach(events, (event) => {
        if (event.type === "connected") return Effect.void;
        return Ref.update(requests, (count) => count + 1).pipe(
          Effect.andThen(
            broker.respond({
              clientId: "policy-client",
              connectionId: event.connectionId,
              requestId: event.request.requestId,
              ok: false,
              error: { _tag: "PreviewAutomationExecutionError", message: "broker should not run" },
            }),
          ),
        );
      }).pipe(Effect.forkScoped);

      const result = yield* callSnapshot(["preview"]);
      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        { type: "text", text: AgentToolPolicy.disabledAgentToolMessage("preview_snapshot") },
      ]);
      expect(yield* Ref.get(requests)).toBe(0);
    }),
  ).pipe(Effect.provide(previewLayer({ preview_snapshot: false }))),
);

it.effect("keeps the browser credential gate when the tool policy allows the snapshot", () =>
  Effect.gen(function* () {
    const result = yield* callSnapshot(["orchestration"]);
    expect(result.isError).toBe(true);
    const text = result.content
      .map((entry) => (entry.type === "text" ? entry.text : ""))
      .join("\n");
    expect(text).toContain('turn on "Agent browser access"');
    expect(text).not.toContain("SSHCode Tools settings");
  }).pipe(Effect.provide(previewLayer())),
);

it("lists the workflow tool only for agent threads while the Workflows beta is on", () => {
  const policy = { enabled: true, tools: {}, providers: {} };
  const scope = {
    thread: { threadId: "thread-1", providerInstanceId: "codex" },
    capabilities: new Set(["orchestration"]),
  } as unknown as Parameters<typeof agentToolListVisible>[2];
  setWorkflowsBetaEnabled(false);
  expect(agentToolListVisible(policy, "workflow", scope)).toBe(false);
  setWorkflowsBetaEnabled(true);
  expect(agentToolListVisible(policy, "workflow", scope)).toBe(true);
  expect(agentToolListVisible(policy, "workflow", undefined)).toBe(false);
  setWorkflowsBetaEnabled(false);
});

it("offers X reading to callers without a thread, including read-only clients", () => {
  expect(agentToolCatalog.find((tool) => tool.name === "read_x_post")).toMatchObject({
    group: "web",
    title: "Read X post",
    readonly: true,
  });
  expect(
    listVisible(DEFAULT_AGENT_TOOL_POLICY, "read_x_post", undefined, {
      subagentsEnabled: () => false,
    }),
  ).toBe(true);
});

it("includes read-only project listing in the agent catalog for outside clients at every access level", () => {
  expect(agentToolCatalog.find((tool) => tool.name === "t3_project_list")).toMatchObject({
    group: "projects",
    title: "List projects",
    readonly: true,
  });
  for (const access of AuthMcpClientAccess.literals) {
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId,
      requestNamespace: `client:${access}`,
      thread: undefined,
      client: { sessionId: `session-${access}`, label: "Outside", access },
      capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
      issuedAt: 1,
    };
    expect(agentToolListVisible(DEFAULT_AGENT_TOOL_POLICY, "t3_project_list", scope)).toBe(true);
  }
});
