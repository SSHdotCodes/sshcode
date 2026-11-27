import * as DebugLog from "../debug/DebugLog.ts";
import { QaSandbox } from "../preview/QaSandbox.ts";
import { ComputerUseService } from "../computer/ComputerUseService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_AGENT_BEHAVIOR,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { kimiMcpDiscoveryInstructions } from "@t3tools/provider-acp-registry/server";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv";
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation";
import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { ServerConfig } from "../config.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as MonitorService from "../monitors/MonitorService.ts";
import { DeviceService } from "../device/DeviceService.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { ProviderAdapterRegistryV2 } from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ThreadLaunchService } from "../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ThreadSearch } from "../orchestration-v2/ThreadSearch.ts";
import { PreviewManager } from "../preview/Manager.ts";
import { PreviewBrowser } from "../preview/PreviewBrowser.ts";
import { ManagedProjectFolders } from "../project/ManagedProjectFolders.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import { PullRequestReviewGuideService } from "../pullRequest/PullRequestReviewGuideService.ts";
import { ScheduledTaskService } from "../scheduledTasks/ScheduledTaskService.ts";
import { SecretRequests } from "../secrets/SecretRequests.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { SourceControlRepositoryService } from "../sourceControl/SourceControlRepositoryService.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import {
  buildCodexTurnStartParams,
  codexBackgroundCommandDetail,
} from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  orchestrationInstructionsFor,
  registerAgentBehavior,
  t3AcpInstructionState,
  t3AcpPromptWithInstructions,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { writeAgentQualityArtifact } from "../orchestration-v2/testkit/AgentQualityRecorder.ts";
import { BOARD_NOTICE_PREFIX } from "../teamBoard/TeamBoardMailbox.ts";
import { auditToolSchemas } from "../../../../scripts/lib/agentQuality.ts";
import { EMPTY_BOARD_STATE, TEAM_BOARD_CLAUSE, TEAM_BOARD_TOOL } from "../teamBoard/model.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import {
  agentToolDiscoveryCatalog,
  agentToolListVisible,
  rewriteToolsListBody,
  type ToolsListTransform,
  type ToolsCatalogTransform,
  withGeminiSafeEnums,
  withTeamBoardToolMeta,
} from "../mcp/AgentToolCatalog.ts";
import { withCompactAgentCatalog } from "../mcp/EagerAgentToolCatalog.ts";
import {
  deferMcpCatalog,
  deferMcpCatalogFor,
  deferMcpCatalogLow,
  deferredMcpHarness,
} from "../mcp/DeferredMcpCatalog.ts";
import { PreviewSnapshotTool } from "../mcp/toolkits/preview/tools.ts";
import { Tool } from "effect/ai";
import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";
import { antigravityMcpDiscoveryInstructions } from "./acp/AntigravityAcpSupport.ts";
import budget from "./agentContextBudget.json" with { type: "json" };
import { DEFAULT_AGENT_TOOL_POLICY, DEFAULT_BOT_PERMISSIONS } from "@t3tools/contracts";
import { botInstructions, memoryNotes } from "../bots/botInstructions.ts";
import { setBotThreads } from "../bots/botsRuntime.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

// Registration only stores tool definitions, so the handlers' services are never called.
const toolHandlerServices = Layer.mergeAll(
  NodeCrypto.layer,
  Layer.mock(DebugLog.DebugLog)({}),
  Layer.mock(ApiKeyStore.ApiKeyStore)({}),
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({}),
  Layer.mock(UsageLimitSources.UsageLimitSources)({}),
  Layer.mock(MonitorService.MonitorService)({
    canDeliver: () => true,
    ownsCwd: () => false,
    hasOpenWork: () => false,
  }),
  Layer.mock(DeviceService)({}),
  Layer.mock(ComputerUseService)({}),
  Layer.mock(GitVcsDriver)({}),
  Layer.mock(GitWorkflowService)({}),
  Layer.mock(ManagedProjectFolders)({ namedProjectsRoot: "" }),
  Layer.mock(McpProviderSessions)({}),
  Layer.mock(OrchestratorV2)({}),
  Layer.mock(PreviewAutomationBroker)({}),
  Layer.mock(QaSandbox)({ touch: () => Effect.void }),
  Layer.mock(PreviewBrowser)({}),
  Layer.mock(PreviewManager)({}),
  Layer.mock(ProjectService)({}),
  Layer.mock(ProjectSetupScriptRunner)({}),
  Layer.mock(ProviderAdapterRegistryV2)({}),
  Layer.mock(ProviderRegistry)({}),
  Layer.mock(PullRequestReviewGuideService)({}),
  Layer.mock(ScheduledTaskService)({}),
  Layer.mock(SecretRequests)({}),
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-context-budget-" }),
  Layer.mock(ServerEnvironment)({}),
  Layer.mock(ServerSecretStore)({}),
  Layer.mock(ServerSettingsService)({}),
  Layer.mock(SourceControlRepositoryService)({}),
  Layer.mock(ThreadLaunchService)({}),
  Layer.mock(ThreadManagementService)({}),
  Layer.mock(ThreadSearch)({}),
  Layer.mock(VcsStatusBroadcaster)({}),
).pipe(Layer.provideMerge(NodeServices.layer));

const utf8Bytes = (text: string) => Buffer.byteLength(text, "utf8");

const claudeSystemAppend = () => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: {
      instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER),
      model: "claude-opus-5-5",
    },
    nativeThreadId: "context-budget",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  return typeof systemPrompt === "object" && "append" in systemPrompt ? systemPrompt.append : "";
};

const codexTurn = (toolDiscoveryCatalog?: string) =>
  buildCodexTurnStartParams({
    nativeThreadId: "context-budget",
    codexInput: [{ type: "text", text: "Continue.", text_elements: [] }],
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    hasT3Mcp: true,
    browserToolsAvailable: true,
    deviceToolsAvailable: true,
    toolDiscoveryCatalog,
  });

const BOT_THREAD = "thread:bot:budget";
const CHAT_THREAD = "thread-chat";
// A chat with every capability, at Settings defaults, as the bot sees other chats' tools.
const chatScope = (threadId: string) =>
  ({
    thread: { threadId, providerInstanceId: "codex" },
    capabilities: new Set(["orchestration", "device", "preview"]),
  }) as unknown as McpInvocationScope;

/**
 * What each chat lists with and without Bots: the listed tools' JSON, full and compact. The
 * bot toolkit sits outside layerAgentTools, so the lists above never count it.
 */
const listedBytes = (withBots: boolean) =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const tools = mcp.tools.map(({ tool }) => ({ ...tool }) as Record<string, unknown>);
    const advertise = (names: (name: string) => boolean, transform?: ToolsListTransform) =>
      tools
        .filter((tool) => names(String(tool.name)))
        .map((tool) => {
          const advertised = transform ? transform({ ...tool }) : tool;
          return {
            name: advertised.name,
            description: advertised.description,
            inputSchema: advertised.inputSchema,
          };
        });
    const json = (names: (name: string) => boolean, transform?: ToolsListTransform) =>
      utf8Bytes(JSON.stringify(advertise(names, transform)));
    const deferred = (names: (name: string) => boolean, eagerCards: boolean) =>
      utf8Bytes(
        JSON.stringify(
          deferMcpCatalogFor({ low: false, eagerCards })(advertise(names, withCompactAgentCatalog)),
        ),
      );
    const visibleIn = (threadId: string) => (name: string) =>
      agentToolListVisible(DEFAULT_AGENT_TOOL_POLICY, name, chatScope(threadId), {
        subagentsEnabled: () => true,
      });
    // Like McpHttpServer: a compact list holds show_card back unless cards are eager, and a
    // bot's chat always has eager cards.
    const withoutCards = (names: (name: string) => boolean) => (name: string) =>
      name !== "show_card" && names(name);
    const lists = () => ({
      chat: json(visibleIn(CHAT_THREAD)),
      chatEager: json(withoutCards(visibleIn(CHAT_THREAD)), withCompactAgentCatalog),
      bot: json(visibleIn(BOT_THREAD)),
      botEager: json(visibleIn(BOT_THREAD), withCompactAgentCatalog),
      chatDeferred: deferred(visibleIn(CHAT_THREAD), false),
      botDeferred: deferred(visibleIn(BOT_THREAD), true),
    });
    try {
      setBotThreads({ active: false, threads: new Map() });
      const off = lists();
      setBotThreads({
        active: true,
        threads: new Map([[BOT_THREAD, { permissions: DEFAULT_BOT_PERMISSIONS }]]),
      });
      const on = lists();
      const only = (names: ReadonlyArray<string>, transform?: ToolsListTransform) =>
        json((name) => names.includes(name), transform);
      const botChatTools = ["bot_memory", "watch_chats", "unwatch_chats"];
      return {
        off,
        on,
        messageBot: only(["message_bot"]),
        messageBotEager: only(["message_bot"], withCompactAgentCatalog),
        botChatTools: only(botChatTools),
        botChatToolsEager: only(botChatTools, withCompactAgentCatalog),
      };
    } finally {
      setBotThreads({ active: false, threads: new Map() });
    }
  }).pipe(
    Effect.provide(
      (withBots
        ? Layer.merge(McpHttpServer.layerAgentTools, McpHttpServer.layerBotToolkit)
        : McpHttpServer.layerAgentTools
      ).pipe(Layer.provideMerge(McpServer.McpServer.layer), Layer.provide(toolHandlerServices)),
    ),
  );

const botInstructionBytes = (cards: boolean) =>
  utf8Bytes(
    botInstructions({ name: "Pip", permissions: DEFAULT_BOT_PERMISSIONS, memory: [], cards }),
  );

it.effect(
  "Bots add nothing to any chat while off, and only message_bot to other chats while on",
  () =>
    Effect.gen(function* () {
      const without = yield* listedBytes(false);
      const withBots = yield* listedBytes(true);
      // Off: every chat lists exactly what it lists without the bot toolkit.
      expect(withBots.off).toEqual(without.off);
      expect(without.on).toEqual(without.off);
      // On: other chats gain message_bot (plus the array comma); a bot's chat gains its own three.
      expect(withBots.on.chat - withBots.off.chat).toBe(withBots.messageBot - 2 + 1);
      expect(withBots.on.chatEager - withBots.off.chatEager).toBe(withBots.messageBotEager - 2 + 1);
      expect(withBots.on.bot - withBots.off.chat).toBe(withBots.botChatTools - 2 + 1);
      expect(withBots.messageBot).toBeLessThanOrEqual(350);
      // The caps every chat has at Settings defaults with every capability; a bot's chat lists
      // cards up front, so it has the eager-cards (High) caps. With every capability on, the
      // compact list is ~30.2 KB with Bots on: message_bot is the feature's cost (Bots are off by
      // default), so the 30 KB default cap stays strict and Bots-on chats may exceed it by that.
      expect(withBots.on.chatEager).toBeLessThan(30_000);
      expect(withBots.on.botEager).toBeLessThan(35_000);
      expect(withBots.on.chatDeferred).toBeLessThanOrEqual(10_000);
      expect(withBots.on.botDeferred).toBeLessThan(14_000);
      expect(botInstructionBytes(false)).toBeLessThanOrEqual(1_500);
      expect(botInstructionBytes(true)).toBeLessThanOrEqual(1_500);
      const fullMemory = Array.from({ length: 20 }, (_, index) => ({
        id: `m${index}`,
        at: "2026-11-26",
        text: "x".repeat(300),
      }));
      expect(utf8Bytes(memoryNotes(fullMemory).join("\n"))).toBeLessThanOrEqual(1_500);
    }),
);

const withCompactGeminiCatalog: ToolsListTransform = (tool) =>
  withGeminiSafeEnums(withCompactAgentCatalog(tool));

// Lower this budget when context shrinks; increases must be deliberate and eval-checked.
// Output schemas are counted apart: Codex code mode shows them as return types
// when it loads a tool, and Claude's API has no place for them.
const toolListBytes = (
  tools: typeof McpHttpServer.layerAllTools,
  part: "input" | "output",
  transform?: ToolsListTransform,
  includeTool: (name: string) => boolean = (name) => name !== TEAM_BOARD_TOOL,
) =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    return utf8Bytes(
      JSON.stringify(
        mcp.tools
          .filter(({ tool }) => includeTool(tool.name))
          .map(({ tool }) => {
            if (part === "output") return tool.outputSchema ?? null;
            const advertised = transform ? transform({ ...tool }) : tool;
            return {
              name: advertised.name,
              description: advertised.description,
              inputSchema: advertised.inputSchema,
              _meta: advertised._meta,
            };
          }),
      ),
    );
  }).pipe(
    Effect.provide(
      tools.pipe(Layer.provideMerge(McpServer.McpServer.layer), Layer.provide(toolHandlerServices)),
    ),
  );

const toolInventory = Effect.gen(function* () {
  const mcp = yield* McpServer.McpServer;
  const tools = mcp.tools
    .map(({ tool }) => ({
      name: tool.name,
      nameBytes: utf8Bytes(tool.name),
      descriptionBytes: utf8Bytes(tool.description ?? ""),
      inputSchemaBytes: utf8Bytes(JSON.stringify(tool.inputSchema)),
      eagerDescriptionBytes: utf8Bytes(String(withCompactAgentCatalog({ ...tool }).description)),
      eagerInputSchemaBytes: utf8Bytes(
        JSON.stringify(withCompactAgentCatalog({ ...tool }).inputSchema),
      ),
      outputSchemaBytes: utf8Bytes(JSON.stringify(tool.outputSchema ?? null)),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  return {
    tools,
    schemaAudit: auditToolSchemas(mcp.tools.map(({ tool }) => tool)),
    eagerTools: mcp.tools.map(({ tool }) => {
      const { name, description, inputSchema } = withCompactAgentCatalog({ ...tool });
      return { name, description, inputSchema };
    }),
  };
}).pipe(
  Effect.provide(
    McpHttpServer.layerAgentTools.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(toolHandlerServices),
    ),
  ),
);

it.effect("the eager catalog round-trips and compiles with the MCP SDK", () =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    const catalog = mcp.tools.map(({ tool }) => tool);
    const boardTool = catalog.find(({ name }) => name === TEAM_BOARD_TOOL)!;
    for (const advertised of [boardTool, withCompactAgentCatalog({ ...boardTool })]) {
      expect(advertised.description).toContain("your next SSHCode tool result");
      expect(advertised.description).toContain("Don't poll with read.");
      expect(advertised.description).toContain("Read for missing details.");
      expect(advertised.description).toContain("Writes include unread posts");
      expect(advertised.description).toContain("Done releases claims");
    }
    const expected = catalog.map(({ name }) => name);
    const representativeCalls = {
      team_board: [
        {},
        { post: { kind: "claim", text: "Fix the parser", files: ["src/parser.ts#parse"] } },
        { post: { kind: "done", text: "Parser fixed", commit: "abc1234" } },
      ],
      delegate_task: [
        { task: "Review this patch for regressions.", isolation: "worktree", mode: "async" },
        { task: "Read this screenshot.", attachmentPaths: ["screenshots/example.png"] },
      ],
      monitor_start: [
        {
          command: "sleep 60",
          description: "Wait for a background check",
          durable: true,
          wakeOn: false,
        },
      ],
      search_x: [{ query: "from:example changelog", deep: true }],
      show_card: [
        {
          title: "Deploy ready",
          tone: "good",
          blocks: [{ text: "All checks passed." }, { progress: { percent: 100, label: "Build" } }],
          actions: [{ label: "Ship", reply: "Ship it.", style: "primary" }],
        },
      ],
      schedule_task: [
        { prompt: "Check the build.", schedule: { type: "interval", everyMs: 3_600_000 } },
        {
          prompt: "Check the build.",
          schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] },
        },
        {
          prompt: "Check the build.",
          schedule: { type: "once", runAt: "2027-01-15T14:30:00.000Z" },
        },
        { prompt: "Check the build.", schedule: { type: "webhook" } },
      ],
    } as Readonly<Record<string, ReadonlyArray<object>>>;
    const validator = new AjvJsonSchemaValidator();
    // Muse uses HTTP and ACP forwards the same tools/list JSON over stdio or
    // MCP-over-ACP. Antigravity gets the Gemini enum adaptation on HTTP.
    for (const tools of [
      catalog,
      catalog.map((tool) => withCompactAgentCatalog({ ...tool })),
      catalog.map((tool) => withCompactGeminiCatalog({ ...tool })),
    ]) {
      const parsed = ListToolsResultSchema.parse(JSON.parse(JSON.stringify({ tools })));
      expect(parsed.tools.map(({ name }) => name)).toEqual(expected);
      for (const tool of parsed.tools) {
        const validate = validator.getValidator(tool.inputSchema as JsonSchemaType);
        expect(() => validate({}), tool.name).not.toThrow();
        for (const args of representativeCalls[tool.name] ?? []) {
          expect(validate(args).valid, tool.name).toBe(true);
        }
        if (tool.outputSchema) {
          expect(() =>
            validator.getValidator(tool.outputSchema as JsonSchemaType)({}),
          ).not.toThrow();
        }
      }
    }
  }).pipe(
    Effect.provide(
      McpHttpServer.layerAgentTools.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(toolHandlerServices),
      ),
    ),
  ),
);

it.effect("replays six Devin and Muse actions with every tool reachable", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = server.tools.map(({ tool }) => ({ ...tool }));
    const full = tools.map(withCompactAgentCatalog);
    const wire = rewriteToolsListBody(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }),
      new Set(["1"]),
      () => true,
      withCompactAgentCatalog,
      deferMcpCatalog,
    );
    const catalog = ListToolsResultSchema.parse(JSON.parse(wire).result).tools;
    const dispatcher = catalog.find(({ name }) => name === "t3_tool")!;
    const indexed = (dispatcher.description ?? "")
      .split("\n")
      .slice(1)
      .map((line) => line.split(": ", 1)[0]);
    expect(
      [
        ...catalog.filter(({ name }) => name !== "t3_tool").map(({ name }) => name),
        ...indexed,
      ].toSorted(),
    ).toEqual(full.map(({ name }) => name).toSorted());
    const validator = new AjvJsonSchemaValidator();
    const instances = { implementation: { driver: "acpRegistry", config: { agentId: "devin" } } };
    const script = [
      ["delegate_task", { task: "Review this patch." }, false],
      ["monitor_start", { command: "sleep 60", description: "Wait", wakeOn: false }, false],
      ["t3_thread_read", { threadId: "thread-1", view: "messages" }, false],
      ["search_x", { query: "from:example changelog" }, false],
      ["preview_open", {}, true],
      ["list_scheduled_tasks", {}, true],
    ] as const;
    for (const [instance, harness] of [
      ["implementation", "devin"],
      ["muse", "muse"],
    ] as const) {
      expect(deferredMcpHarness(instances, instance)).toBe(harness);
      for (const [name, input, deferred] of script) {
        const offered = catalog.find((entry) => entry.name === name);
        expect(offered === undefined, `${harness} ${name}`).toBe(deferred);
        if (deferred) {
          expect(indexed).toContain(name);
          const validateRequest = validator.getValidator(dispatcher.inputSchema as JsonSchemaType);
          expect(validateRequest({ name }).valid).toBe(true);
          expect(validateRequest({ name, input }).valid).toBe(true);
        }
        const targetSchema =
          offered?.inputSchema ?? full.find((entry) => entry.name === name)?.inputSchema;
        expect(validator.getValidator(targetSchema as JsonSchemaType)(input).valid, name).toBe(
          true,
        );
      }
    }
    expect(deferredMcpHarness(instances, "antigravity")).toBeUndefined();
    expect(deferredMcpHarness(instances, undefined)).toBeUndefined();

    // Low token mode defers every visible tool behind t3_tool without hiding any tool.
    const lowWire = rewriteToolsListBody(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }),
      new Set(["1"]),
      () => true,
      withCompactAgentCatalog,
      deferMcpCatalogLow,
    );
    const lowCatalog = ListToolsResultSchema.parse(JSON.parse(lowWire).result).tools;
    expect(lowCatalog.map(({ name }) => name)).toEqual(["t3_tool"]);
    const lowIndexed = (lowCatalog[0]!.description ?? "")
      .split("\n")
      .slice(1)
      .map((line) => line.split(": ", 1)[0]);
    expect(lowIndexed.toSorted()).toEqual(full.map(({ name }) => name).toSorted());
  }).pipe(
    Effect.provide(
      McpHttpServer.layerAgentTools.pipe(
        Layer.provideMerge(McpServer.McpServer.layer),
        Layer.provide(toolHandlerServices),
      ),
    ),
  ),
);

// Review stays a judgment call, so no description may reintroduce a
// mandatory-review trigger. Tools may still name what they delete.
it.effect("keeps forbidden guidance words out of every tool description", () => {
  const check = (tools: typeof McpHttpServer.layerAllTools) =>
    Effect.gen(function* () {
      const mcp = yield* McpServer.McpServer;
      expect(mcp.tools.length).toBeGreaterThan(0);
      for (const { tool } of mcp.tools) {
        const description = (tool.description ?? "").toLowerCase();
        for (const word of ["risky", "always review"]) {
          expect(description, `${tool.name} description`).not.toContain(word);
        }
      }
    }).pipe(
      Effect.provide(
        tools.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provide(toolHandlerServices),
        ),
      ),
    );
  return Effect.gen(function* () {
    yield* check(McpHttpServer.layerAllTools);
    yield* check(McpHttpServer.layerAgentTools);
  });
});

it.effect("agent context matches the committed budget", () =>
  Effect.gen(function* () {
    const discovery = agentToolDiscoveryCatalog((name) => name !== TEAM_BOARD_TOOL);
    const caller = {
      environmentId: EnvironmentId.make("board-budget"),
      requestNamespace: "board-budget",
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
      client: undefined,
      thread: {
        threadId: ThreadId.make("board-budget"),
        providerSessionId: "budget",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
    };
    const policy = { enabled: true, tools: {}, providers: {} };
    const boardVisible = (siblings: boolean) =>
      agentToolListVisible(
        policy,
        TEAM_BOARD_TOOL,
        caller,
        { subagentsEnabled: () => true },
        undefined,
        () => siblings,
      );
    expect(boardVisible(false)).toBe(false);
    expect(boardVisible(true)).toBe(true);
    const bots = yield* listedBytes(true);
    const codex = yield* codexTurn(discovery);
    const repeatedCodex = yield* codexTurn(discovery);
    const contextText = Object.values(codex.additionalContext ?? {})
      .filter((entry) => entry !== codex.additionalContext?.t3_code_tool_catalog)
      .map((entry) => entry.value)
      .join("");
    expect(contextText).not.toContain("SSHCode collaborative browser");
    expect(contextText).not.toContain("## SSHCode devices");
    const acpState = t3AcpInstructionState({ interactionMode: "default", hasT3Mcp: true });
    const prompt = "Continue.";
    const discoveryBytes = (toolDiscoveryInstructions: string) => {
      const state = t3AcpInstructionState({ ...acpState, toolDiscoveryInstructions });
      expect(t3AcpPromptWithInstructions({ prompt, state, previousState: state })).toBe(prompt);
      return (
        utf8Bytes(t3AcpPromptWithInstructions({ prompt, state })) -
        utf8Bytes(t3AcpPromptWithInstructions({ prompt, state: acpState }))
      );
    };
    const cursorPrompt = (runOrdinal: number) =>
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal, hasT3Mcp: true });
    const openCodeSystem = (isSubagent: boolean) =>
      [
        t3OrchestrationSystemPrompt(true, undefined, undefined, isSubagent),
        buildRuntimeInstructions({ harness: "OpenCode" }),
      ]
        .filter(Boolean)
        .join("\n\n");
    const excerpt = "That path needs a retry.";
    const citation = serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("assistant"),
      text: excerpt,
      start: 0,
      end: excerpt.length,
      prefix: "",
      suffix: "",
      comment: "Please add the retry here.",
    });
    const eagerCatalog = yield* toolListBytes(
      McpHttpServer.layerAgentTools,
      "input",
      withCompactAgentCatalog,
      (name) => name !== "show_card" && name !== TEAM_BOARD_TOOL,
    );
    const eagerGemini = yield* toolListBytes(
      McpHttpServer.layerAgentTools,
      "input",
      withCompactGeminiCatalog,
      (name) => name !== "show_card" && name !== TEAM_BOARD_TOOL,
    );
    const deferredBytes = (
      includeBoard: boolean,
      transform: ToolsCatalogTransform = deferMcpCatalog,
    ) =>
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const visible = server.tools.filter(
          ({ tool }) => includeBoard || tool.name !== TEAM_BOARD_TOOL,
        );
        return utf8Bytes(
          JSON.stringify(
            transform(visible.map(({ tool }) => withCompactAgentCatalog({ ...tool }))),
          ),
        );
      }).pipe(
        Effect.provide(
          McpHttpServer.layerAgentTools.pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(toolHandlerServices),
          ),
        ),
      );
    const ordinaryDeferredBytes = yield* deferredBytes(false);
    const highDeferred = deferMcpCatalogFor({ low: false, eagerCards: true });
    const ordinaryHighDeferredBytes = yield* deferredBytes(false, highDeferred);
    const ordinaryLowDeferredBytes = yield* deferredBytes(false, deferMcpCatalogLow);
    const liveLowDeferred = deferMcpCatalogFor({
      low: true,
      eagerCards: false,
      eagerTeamBoard: true,
    });
    const measured = {
      teamBoardWithoutSiblingsBytes:
        utf8Bytes(
          agentToolDiscoveryCatalog((name) => name !== TEAM_BOARD_TOOL || boardVisible(false)),
        ) - utf8Bytes(discovery),
      teamBoardDiscoveryAddedBytes:
        utf8Bytes(
          agentToolDiscoveryCatalog((name) => name !== TEAM_BOARD_TOOL || boardVisible(true)),
        ) - utf8Bytes(discovery),
      teamBoardDeferredCatalogAddedBytes: (yield* deferredBytes(true)) - ordinaryDeferredBytes,
      teamBoardHighDeferredCatalogAddedBytes:
        (yield* deferredBytes(true, highDeferred)) - ordinaryHighDeferredBytes,
      teamBoardLowDeferredCatalogAddedBytes:
        (yield* deferredBytes(true, liveLowDeferred)) - ordinaryLowDeferredBytes,
      teamBoardSubagentClauseAddedBytes: utf8Bytes(
        `${BOARD_NOTICE_PREFIX}${TEAM_BOARD_CLAUSE} ${EMPTY_BOARD_STATE}\n\n`,
      ),
      teamBoardToolAddedBytes:
        (yield* toolListBytes(
          McpHttpServer.layerAgentTools,
          "input",
          withCompactAgentCatalog,
          (name) => name !== "show_card",
        )) - eagerCatalog,
      teamBoardClaudeToolAddedBytes:
        (yield* toolListBytes(
          McpHttpServer.layerAgentTools,
          "input",
          withTeamBoardToolMeta,
          () => true,
        )) - (yield* toolListBytes(McpHttpServer.layerAgentTools, "input")),
      teamBoardGeminiToolAddedBytes:
        (yield* toolListBytes(
          McpHttpServer.layerAgentTools,
          "input",
          withCompactGeminiCatalog,
          (name) => name !== "show_card",
        )) - eagerGemini,
      assistantCitationPromptBytes: utf8Bytes(
        projectComposerContextForProvider({ text: `Use ${citation}`, records: [] }),
      ),
      subagentOrchestrationBytes: utf8Bytes(T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT),
      subagentAcpBootstrapAddedBytes:
        utf8Bytes(
          t3AcpPromptWithInstructions({
            prompt,
            state: t3AcpInstructionState({
              interactionMode: "default",
              hasT3Mcp: true,
              isSubagent: true,
            }),
          }),
        ) - utf8Bytes(prompt),
      claudeSystemAppendBytes: utf8Bytes(claudeSystemAppend()),
      codexAdditionalContextBytes: utf8Bytes(contextText),
      codexRepeatedTurnAddedBytes: Object.entries(repeatedCodex.additionalContext ?? {}).reduce(
        (total, [key, entry]) =>
          total +
          (codex.additionalContext?.[key]?.value === entry.value ? 0 : utf8Bytes(entry.value)),
        0,
      ),
      codexBackgroundWakeAsciiBytes: utf8Bytes(
        codexBackgroundCommandDetail({
          command: "a".repeat(201),
          aggregatedOutput: "z".repeat(1001),
        }),
      ),
      codexPlanFallbackBytes: utf8Bytes(buildCodexDeveloperInstructions("plan")),
      acpBootstrapAddedBytes:
        utf8Bytes(t3AcpPromptWithInstructions({ prompt, state: acpState })) - utf8Bytes(prompt),
      acpRepeatedTurnAddedBytes:
        utf8Bytes(
          t3AcpPromptWithInstructions({ prompt, state: acpState, previousState: acpState }),
        ) - utf8Bytes(prompt),
      acpModeChangeAddedBytes:
        utf8Bytes(
          t3AcpPromptWithInstructions({
            prompt,
            state: t3AcpInstructionState({ interactionMode: "plan", hasT3Mcp: true }),
            previousState: acpState,
          }),
        ) - utf8Bytes(prompt),
      cursorBootstrapAddedBytes:
        utf8Bytes(`${cursorPrompt(1)}\n\n${buildRuntimeInstructions({ harness: "Cursor" })}`) -
        utf8Bytes(prompt),
      cursorRepeatedTurnAddedBytes: utf8Bytes(cursorPrompt(2)) - utf8Bytes(prompt),
      openCodeSystemBytes: utf8Bytes(openCodeSystem(false)),
      deferredMcpCatalogJsonBytes: ordinaryDeferredBytes,
      deferredMcpCatalogHighTokensJsonBytes: ordinaryHighDeferredBytes,
      openCodeSubagentSystemBytes: utf8Bytes(openCodeSystem(true)),
      mcpToolListJsonBytes: yield* toolListBytes(McpHttpServer.layerAllTools, "input"),
      agentMcpToolListJsonBytes: yield* toolListBytes(McpHttpServer.layerAgentTools, "input"),
      agentGeminiMcpToolListJsonBytes: yield* toolListBytes(
        McpHttpServer.layerAgentTools,
        "input",
        withGeminiSafeEnums,
      ),
      eagerAgentMcpToolListJsonBytes: yield* toolListBytes(
        McpHttpServer.layerAgentTools,
        "input",
        withCompactAgentCatalog,
        (name) => name !== "show_card" && name !== TEAM_BOARD_TOOL,
      ),
      eagerAgentGeminiMcpToolListJsonBytes: yield* toolListBytes(
        McpHttpServer.layerAgentTools,
        "input",
        withCompactGeminiCatalog,
        (name) => name !== "show_card" && name !== TEAM_BOARD_TOOL,
      ),
      highTokensEagerAgentMcpToolListJsonBytes: yield* toolListBytes(
        McpHttpServer.layerAgentTools,
        "input",
        withCompactAgentCatalog,
      ),
      antigravityMcpDiscoveryCatalogBytes: discoveryBytes(
        antigravityMcpDiscoveryInstructions(discovery),
      ),
      kimiMcpDiscoveryCatalogBytes: discoveryBytes(kimiMcpDiscoveryInstructions(discovery)),
      codexMcpDiscoveryCatalogBytes: utf8Bytes(
        codex.additionalContext?.t3_code_tool_catalog?.value ?? "",
      ),
      agentMcpToolOutputSchemaJsonBytes: yield* toolListBytes(
        McpHttpServer.layerAgentTools,
        "output",
      ),
      // Settings > Bots, counted only while Bots are on with a bot.
      botInstructionsBytes: botInstructionBytes(false),
      botInstructionsWithCardsBytes: botInstructionBytes(true),
      messageBotToolJsonBytes: bots.messageBot,
      eagerMessageBotToolJsonBytes: bots.messageBotEager,
      botChatToolsJsonBytes: bots.botChatTools,
      eagerBotChatToolsJsonBytes: bots.botChatToolsEager,
      botsOnChatEagerToolListJsonBytes: bots.on.chatEager,
      botsOnBotChatEagerToolListJsonBytes: bots.on.botEager,
      ...(yield* Effect.gen(function* () {
        try {
          registerAgentBehavior(() => ({ ...DEFAULT_AGENT_BEHAVIOR, tokens: "low" }));
          const lowClaude = utf8Bytes(claudeSystemAppend());
          const lowCodexTurn = yield* codexTurn(discovery);
          expect(lowCodexTurn.additionalContext?.t3_code_tool_catalog).toBeUndefined();
          const lowCodex = utf8Bytes(
            Object.values(lowCodexTurn.additionalContext ?? {})
              .map((entry) => entry.value)
              .join(""),
          );
          const lowAcp =
            utf8Bytes(
              t3AcpPromptWithInstructions({
                prompt,
                state: t3AcpInstructionState({ interactionMode: "default", hasT3Mcp: true }),
              }),
            ) - utf8Bytes(prompt);
          const lowSubagent = utf8Bytes(orchestrationInstructionsFor(undefined, () => true, true));

          registerAgentBehavior(() => ({ ...DEFAULT_AGENT_BEHAVIOR, tokens: "high" }));
          const highClaude = utf8Bytes(claudeSystemAppend());
          const highCodexTurn = yield* codexTurn(discovery);
          const highCodex = utf8Bytes(
            Object.values(highCodexTurn.additionalContext ?? {})
              .filter((entry) => entry !== highCodexTurn.additionalContext?.t3_code_tool_catalog)
              .map((entry) => entry.value)
              .join(""),
          );
          const highSubagent = utf8Bytes(orchestrationInstructionsFor(undefined, () => true, true));

          return {
            lowTokenClaudeSystemAppendBytes: lowClaude,
            lowTokenCodexAdditionalContextBytes: lowCodex,
            lowTokenAcpBootstrapAddedBytes: lowAcp,
            lowTokenSubagentOrchestrationBytes: lowSubagent,
            lowTokenDeferredMcpCatalogJsonBytes: ordinaryLowDeferredBytes,
            highTokenClaudeSystemAppendBytes: highClaude,
            highTokenCodexAdditionalContextBytes: highCodex,
            highTokenSubagentOrchestrationBytes: highSubagent,
          };
        } finally {
          registerAgentBehavior(() => DEFAULT_AGENT_BEHAVIOR);
        }
      })),
    };
    const inventory = yield* toolInventory;
    const discoveryNames = discovery.split("\n").map((line) => line.split(" — ")[0]);
    expect(discoveryNames.toSorted()).toEqual(
      inventory.tools.map((tool) => tool.name).filter((name) => name !== TEAM_BOARD_TOOL),
    );
    yield* Effect.promise(() =>
      writeAgentQualityArtifact("context-budget", { measured, ...inventory }),
    );
    expect(measured.eagerAgentMcpToolListJsonBytes).toBeLessThan(30_000);
    expect(measured.eagerAgentGeminiMcpToolListJsonBytes).toBeLessThan(30_000);
    expect(measured.eagerAgentMcpToolListJsonBytes + measured.teamBoardToolAddedBytes).toBeLessThan(
      30_700,
    );
    expect(
      measured.eagerAgentGeminiMcpToolListJsonBytes + measured.teamBoardGeminiToolAddedBytes,
    ).toBeLessThan(30_700);
    expect(measured.deferredMcpCatalogJsonBytes).toBeLessThanOrEqual(10_000);
    expect(
      measured.deferredMcpCatalogJsonBytes + measured.teamBoardDeferredCatalogAddedBytes,
    ).toBeLessThan(10_700);
    expect(measured.highTokensEagerAgentMcpToolListJsonBytes).toBeLessThan(35_000);
    expect(measured.lowTokenDeferredMcpCatalogJsonBytes).toBeLessThanOrEqual(4_000);
    expect(
      measured.lowTokenDeferredMcpCatalogJsonBytes + measured.teamBoardLowDeferredCatalogAddedBytes,
    ).toBeLessThanOrEqual(4_000);
    expect(measured.deferredMcpCatalogHighTokensJsonBytes).toBeLessThan(14_000);
    expect(measured).toEqual(budget);
  }),
);

it("keeps removed prompt mechanics in their advertised tool descriptions", () => {
  const descriptions = Object.values(OrchestratorToolkit.tools)
    .map((tool) => Tool.getDescription(tool))
    .join("\n");
  for (const mechanism of [
    "no parent history",
    "self-contained task brief",
    "last local commit, without uncommitted edits",
    "absolute repositoryPath",
    "every thread tool and task_status/cancel",
    "new clientRequestId for each task or independent review round",
    "reuse only for retries",
    "never a message",
    "workspace was removed",
    "wakeOn",
    "entire process group",
    "schedule is an object",
    "Share checkouts or use fresh scratch folders",
  ])
    expect(descriptions).toContain(mechanism);
  expect(Tool.getDescription(PreviewSnapshotTool)).toContain("since=snapshotId");
  // Decision rules remain global even though the calls' mechanics live in tools.
  for (const policy of [
    "Native subagents share your quota and must support the chosen model",
    '`isolation:"worktree"` (needs a Git commit',
    "original brief, findings, replies and open objections",
    "Use `ask_user`, not prose",
    "Before ending a turn while your own long work still runs",
  ])
    expect(T3_CODE_ORCHESTRATION_INSTRUCTIONS).toContain(policy);
});
