import { botToolVisible, MANAGE_CHAT_TOOLS } from "../bots/botsRuntime.ts";
import {
  agentBehaviorLevels,
  type AgentToolsState,
  DEFAULT_AGENT_BEHAVIOR,
  DEFAULT_AGENT_TOOL_POLICY,
  isAgentToolEnabled,
  type ServerSettingsError,
} from "@t3tools/contracts";
import { isSubagentOrchestrationTool } from "@t3tools/shared/chatControls";
import { McpSchema } from "effect/ai";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as ChatControls from "../sessionBoxes/chatControls.ts";
import {
  agentToolCatalog,
  agentToolDiscoveryCatalog,
  agentToolListVisible,
} from "./AgentToolCatalog.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import { ToolDiscoveryCatalog } from "./McpSessionRegistry.ts";
import * as TeamBoard from "../teamBoard/TeamBoard.ts";

/**
 * Settings read of the agent tool catalog. MCP enforcement does not require
 * this service: registration and context-budget layers look the policy up
 * per request and allow every tool when settings are absent.
 */
export class AgentToolPolicy extends Context.Service<
  AgentToolPolicy,
  {
    readonly state: Effect.Effect<AgentToolsState, ServerSettingsError>;
  }
>()("t3/mcp/AgentToolPolicy") {}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const state = settings.getSettings.pipe(
    Effect.map((value): AgentToolsState => ({
      policy: value.agentToolPolicy ?? DEFAULT_AGENT_TOOL_POLICY,
      tools: agentToolCatalog.slice(),
    })),
  );
  return AgentToolPolicy.of({ state });
});

export const layer = Layer.effect(AgentToolPolicy, make);

const unavailablePolicy = { enabled: false, tools: {}, providers: {} };

export const currentAgentToolPolicyState = Effect.gen(function* () {
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  if (Option.isNone(settings))
    return {
      available: true,
      policy: DEFAULT_AGENT_TOOL_POLICY,
      grading: true,
      agentBehavior: DEFAULT_AGENT_BEHAVIOR,
      providerInstances: {},
    };
  return yield* settings.value.getSettings.pipe(
    Effect.match({
      onSuccess: (value) => ({
        available: true,
        policy: value.agentToolPolicy ?? DEFAULT_AGENT_TOOL_POLICY,
        /** Settings' grading switch; off hides the `grades` input. */
        grading: value.subagentGrading,
        /** Settings > Agents behavior levels (low tokens defers MCP tools). */
        agentBehavior: agentBehaviorLevels(value.agentBehavior),
        /** Which driver a calling chat runs on, for schemas its model's API accepts. */
        providerInstances: value.providerInstances,
      }),
      onFailure: () => ({
        available: false,
        policy: unavailablePolicy,
        grading: true,
        agentBehavior: DEFAULT_AGENT_BEHAVIOR,
        providerInstances: {},
      }),
    }),
  );
});

/** Missing settings preserve legacy defaults; failed settings reads never grant access. */
export const currentAgentToolPolicy = currentAgentToolPolicyState.pipe(
  Effect.map((value) => value.policy),
);

export const layerDiscovery = Layer.effect(
  ToolDiscoveryCatalog,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const board = yield* Effect.serviceOption(TeamBoard.TeamBoard);
    const chatControls = Option.getOrElse(
      yield* Effect.serviceOption(ChatControls.ChatControls),
      () => ({ subagentsEnabled: () => true }),
    );
    const policyState = currentAgentToolPolicyState.pipe(
      Effect.provideService(ServerSettings.ServerSettingsService, settings),
    );
    return (scope) =>
      policyState.pipe(
        Effect.map(({ policy, agentBehavior }) =>
          // In Low token mode `t3_tool` already carries the 1-line index in `tools/list`.
          agentBehavior.tokens === "low"
            ? ""
            : agentToolDiscoveryCatalog((name) =>
                agentToolListVisible(
                  policy,
                  name,
                  scope,
                  chatControls,
                  agentBehavior,
                  Option.getOrUndefined(board)?.toolListed,
                ),
              ),
        ),
      );
  }),
);

const botToolOffMessage = (name: string) =>
  MANAGE_CHAT_TOOLS.has(name)
    ? "Managing chats is off for this bot in Settings > Bots."
    : `\`${name}\` is only for Settings > Bots, and it isn't available in this chat.`;

export const disabledAgentToolMessage = (name: string) =>
  `SSHCode Tools settings turn off \`${name}\`. Ask the user to enable it in Settings.`;

export const disabledAgentToolResult = (name: string) =>
  new McpSchema.CallToolResult({
    isError: true,
    content: [{ type: "text", text: disabledAgentToolMessage(name) }],
  });

/**
 * Refuse a call the current policy turns off. The provider is the authenticated
 * thread's `providerInstanceId`, never a tool argument. No thread means the
 * global policy. A missing settings service allows the call so existing
 * capability checks still run.
 */
export const refuseDisabledAgentTool = (name: string) =>
  Effect.gen(function* () {
    const { policy, available } = yield* currentAgentToolPolicyState;
    if (!available)
      return new McpSchema.CallToolResult({
        isError: true,
        content: [
          {
            type: "text",
            text: "SSHCode tool settings are temporarily unavailable. Retry after the environment recovers.",
          },
        ],
      });
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    const provider = Option.match(scope, {
      onNone: () => undefined,
      onSome: (invocation) => invocation.thread?.providerInstanceId,
    });
    if (isAgentToolEnabled(policy, name, provider)) return undefined;
    return disabledAgentToolResult(name);
  });

const subagentsOffResult = new McpSchema.CallToolResult({
  isError: true,
  content: [{ type: "text", text: "Subagents are off for this chat." }],
});

/**
 * Settings still win. When this chat has subagents off, orchestration
 * tools refuse even if a session cached them from an earlier tools/list.
 */
export const refuseUnavailableAgentTool = (name: string) =>
  Effect.gen(function* () {
    const disabled = yield* refuseDisabledAgentTool(name);
    if (disabled !== undefined) return disabled;
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
    // Bots decide their own tools: a cached list can't call them once Bots are off.
    if (botToolVisible(name, Option.getOrUndefined(scope)) === false)
      return new McpSchema.CallToolResult({
        isError: true,
        content: [{ type: "text", text: botToolOffMessage(name) }],
      });
    if (name === "report_progress") {
      const { agentBehavior } = yield* currentAgentToolPolicyState;
      if (agentBehavior.tokens !== "high")
        return new McpSchema.CallToolResult({
          isError: true,
          content: [
            {
              type: "text",
              text: "Live progress is only enabled when Settings > Agents Token use is High.",
            },
          ],
        });
    }
    if (!isSubagentOrchestrationTool(name)) return undefined;
    const threadId = Option.match(scope, {
      onNone: () => undefined,
      onSome: (invocation) => invocation.thread?.threadId,
    });
    const chatControls = yield* Effect.serviceOption(ChatControls.ChatControls);
    if (
      threadId === undefined ||
      Option.isNone(chatControls) ||
      chatControls.value.subagentsEnabled(threadId)
    )
      return undefined;
    return subagentsOffResult;
  });
