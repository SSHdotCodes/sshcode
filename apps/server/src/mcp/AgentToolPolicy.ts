import {
  type AgentToolsState,
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
import { agentToolCatalog } from "./AgentToolCatalog.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

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
      providerInstances: {},
    };
  return yield* settings.value.getSettings.pipe(
    Effect.match({
      onSuccess: (value) => ({
        available: true,
        policy: value.agentToolPolicy ?? DEFAULT_AGENT_TOOL_POLICY,
        /** Settings' grading switch; off hides the `grades` input. */
        grading: value.subagentGrading,
        /** Which driver a calling chat runs on, for schemas its model's API accepts. */
        providerInstances: value.providerInstances,
      }),
      onFailure: () => ({
        available: false,
        policy: unavailablePolicy,
        grading: true,
        providerInstances: {},
      }),
    }),
  );
});

/** Missing settings preserve legacy defaults; failed settings reads never grant access. */
export const currentAgentToolPolicy = currentAgentToolPolicyState.pipe(
  Effect.map((value) => value.policy),
);

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
    if (!isSubagentOrchestrationTool(name)) return undefined;
    const scope = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
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
