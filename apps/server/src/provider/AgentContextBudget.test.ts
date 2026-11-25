import * as DebugLog from "../debug/DebugLog.ts";
import { QaSandbox } from "../preview/QaSandbox.ts";
import { ComputerUseService } from "../computer/ComputerUseService.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { McpProviderSessions } from "@t3tools/provider-core/server/McpProviderSessions";
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
import { buildCodexTurnStartParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  t3AcpInstructionState,
  t3AcpPromptWithInstructions,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS_SUBAGENT,
  t3OrchestrationPromptForFirstRun,
  t3OrchestrationSystemPrompt,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { writeAgentQualityArtifact } from "../orchestration-v2/testkit/AgentQualityRecorder.ts";
import { auditToolSchemas } from "../../../../scripts/lib/agentQuality.ts";
import { OrchestratorToolkit } from "../mcp/toolkits/orchestrator/tools.ts";
import { PreviewSnapshotTool } from "../mcp/toolkits/preview/tools.ts";
import { Tool } from "effect/ai";
import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";
import { ProviderRegistry } from "./ProviderRegistry.ts";
import budget from "./agentContextBudget.json" with { type: "json" };

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

const codexTurn = () =>
  buildCodexTurnStartParams({
    nativeThreadId: "context-budget",
    codexInput: [{ type: "text", text: "Continue.", text_elements: [] }],
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    hasT3Mcp: true,
    browserToolsAvailable: true,
    deviceToolsAvailable: true,
  });

// Lower this budget when context shrinks; increases must be deliberate and eval-checked.
// Output schemas are counted apart: Codex code mode shows them as return types
// when it loads a tool, and Claude's API has no place for them.
const toolListBytes = (tools: typeof McpHttpServer.layerAllTools, part: "input" | "output") =>
  Effect.gen(function* () {
    const mcp = yield* McpServer.McpServer;
    return utf8Bytes(
      JSON.stringify(
        mcp.tools.map(({ tool }) =>
          part === "input"
            ? { name: tool.name, description: tool.description, inputSchema: tool.inputSchema }
            : (tool.outputSchema ?? null),
        ),
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
      descriptionBytes: utf8Bytes(tool.description ?? ""),
      inputSchemaBytes: utf8Bytes(JSON.stringify(tool.inputSchema)),
      outputSchemaBytes: utf8Bytes(JSON.stringify(tool.outputSchema ?? null)),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  return { tools, schemaAudit: auditToolSchemas(mcp.tools.map(({ tool }) => tool)) };
}).pipe(
  Effect.provide(
    McpHttpServer.layerAgentTools.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(toolHandlerServices),
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
    const codex = yield* codexTurn();
    const repeatedCodex = yield* codexTurn();
    const contextText = Object.values(codex.additionalContext ?? {})
      .map((entry) => entry.value)
      .join("");
    expect(contextText).not.toContain("SSHCode collaborative browser");
    expect(contextText).not.toContain("## SSHCode devices");
    const acpState = t3AcpInstructionState({ interactionMode: "default", hasT3Mcp: true });
    const prompt = "Continue.";
    const cursorPrompt = (runOrdinal: number) =>
      t3OrchestrationPromptForFirstRun({ prompt, runOrdinal, hasT3Mcp: true });
    const openCodeSystem = [
      t3OrchestrationSystemPrompt(true),
      buildRuntimeInstructions({ harness: "OpenCode" }),
    ]
      .filter(Boolean)
      .join("\n\n");
    const measured = {
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
      openCodeSystemBytes: utf8Bytes(openCodeSystem),
      mcpToolListJsonBytes: yield* toolListBytes(McpHttpServer.layerAllTools, "input"),
      agentMcpToolListJsonBytes: yield* toolListBytes(McpHttpServer.layerAgentTools, "input"),
      agentMcpToolOutputSchemaJsonBytes: yield* toolListBytes(
        McpHttpServer.layerAgentTools,
        "output",
      ),
    };
    const inventory = yield* toolInventory;
    yield* Effect.promise(() =>
      writeAgentQualityArtifact("context-budget", { measured, ...inventory }),
    );
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
    "Native subagents must support the chosen model",
    "Worktree isolation requires a Git commit",
    "original brief, findings, replies and open objections",
    "Ask with `ask_user`, not in your reply",
    "Before ending a turn while your own long work still runs",
  ])
    expect(T3_CODE_ORCHESTRATION_INSTRUCTIONS).toContain(policy);
});
