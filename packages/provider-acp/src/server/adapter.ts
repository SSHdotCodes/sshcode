// @effect-diagnostics nodeBuiltinImport:off

import { acpAdvertisedSkillNames, dispatchAcpSkillMention } from "./skillDispatch.ts";
import { acpPromptFailure } from "./failure.ts";
import {
  type ChatAttachment,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRetry,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type OrchestrationV2WebSearchResult,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type ProviderDriverKind,
  type ProviderRequestKind,
  type ProviderThreadId,
  type ProviderTurnId,
  type ProviderUserInputAnswers,
  type RuntimeMode,
  type RuntimeRequestId,
  type ThreadTokenUsageSnapshot,
  type ThreadId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import { AgentScope, AgentScopeThreadId } from "@t3tools/shared/AgentScope";
import {
  abandonGenerationReply,
  endGenerationReply,
  generationSnapshot,
  makeGenerationMeter,
  markGenerationOutput,
  markGenerationRequest,
  type GenerationMeter,
} from "@t3tools/shared/generationRate";
import { HTML_RENDER_TOOL_NAME } from "@t3tools/shared/htmlRender";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { type SelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import {
  backgroundTimerWakeAt,
  backgroundWorkHoldsCompletion,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { truncate } from "@t3tools/shared/String";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import { compactDynamicToolOutput, htmlRenderFromToolItem } from "@t3tools/shared/toolOutput";
import { FILE_HEADERS_ONLY, formatPatch, structuredPatch } from "diff";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hash from "effect/Hash";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import { steerAcpTurn, supportsAcpSteering } from "./steering.ts";
import type * as EffectAcpProtocol from "effect-acp/protocol";
import type * as EffectAcpSchema from "effect-acp/compat";

import { formatReadToolLabel, formatSearchToolLabel } from "@t3tools/shared/toolActivity";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeAcpMcpOverAcpBridge, type AcpMcpOverAcpBridge } from "./mcpOverAcpBridge.ts";
import { mcpToolPresentation } from "@t3tools/provider-core/server/mcpToolPresentation";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import {
  applyAcpAgentTerminalUpdate,
  acpContentBlockDisplayText,
  acpViewedImage,
  MAX_AGENT_TERMINAL_OUTPUT_CHARS,
  boundToolCallOutputText,
  embeddedTerminalIdsFromSessionUpdate,
  acpMcpDispatch,
  extractMcpToolCallIdentity,
  findModelConfigOption,
  mergeToolCallState,
  parsePermissionRequest,
  parseSessionUpdateEvent,
  sessionUpdateIsReplay,
  withTrackedPermissionToolCall,
  toolCallVisibleOutputChanged,
  type AcpPlanUpdate,
  type AcpAgentTerminalState,
  type AcpSessionModeState,
  type AcpToolCallState,
} from "./runtimeModel.ts";
import {
  acpClientExecuteDisposition,
  acpMcpToolApprovalElicitationDisposition,
  acpPermissionDisposition,
  type AcpPermissionDisposition,
  makeAcpClientPolicyGrants,
  unknownRecord,
} from "./clientPolicy.ts";
import { parseElicitationForm } from "./elicitationForm.ts";
import {
  makeAcpClientTerminals,
  resolveEmbeddedTerminalContent,
  type AcpClientTerminals,
} from "./clientTerminals.ts";
import { makeRunningToolCalls } from "./runningToolCalls.ts";
import { findAcpApprovalModes } from "@t3tools/shared/acpComposer";
import {
  ACP_EMPTY_OPTION_VALUE,
  ACP_SESSION_MODE_OPTION_ID,
  acpProviderOptionDescriptors,
  flattenSelectChoices,
} from "./sessionConfig.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";
import {
  SubagentsEnabled,
  t3AcpPromptWithInstructions,
  t3AcpInstructionState,
  type T3AcpInstructionState,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import {
  type BackgroundWork,
  type BackgroundWorkReport,
  backgroundWorkNotification,
} from "@t3tools/provider-core/server/notification";
import {
  makeProviderFailure,
  makeProviderRetryTurnItem,
} from "@t3tools/provider-core/server/failure";
import { acpSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export const ACP_PROTOCOL = "acp.ndjson-jsonrpc" as const;

/**
 * Quiet window after a settled turn's last background rearm before it
 * finalizes, so a slightly late post-hydration assistant chunk stays in the
 * same turn. Grok commonly sends its final summary just over two seconds after
 * the hydrated tool frame; two seconds split that tail into a second synthetic
 * wake. Longer floors (4–20s) only prolonged Working. No per-model carveouts.
 */
const ACP_DEFERRED_FINALIZE_DEBOUNCE: Duration.Input = "3000 millis";
// A model can stay silent this long before the first token of a reply the agent started itself.
const ACP_OPEN_REPLY_QUIET_LIMIT: Duration.Input = "2 minutes";
const ACP_PROMPT_INACTIVITY_SLICE_MILLIS = 60_000;
const ACP_HOST_SLEEP_TOLERANCE_MILLIS = 10_000;
// Agents such as agy 1.5 emit available_commands_update asynchronously after session/new or session/resume.
const ACP_COMPACT_COMMANDS_WAIT_TIMEOUT: Duration.Input = "2 seconds";

/**
 * Coalescing window for streamed text. A text segment's first chunk and its
 * close emit at once; a later chunk schedules one full-text snapshot this long
 * after it, and the chunks inside the window share it instead of each emitting
 * the whole reply, which grew with the square of the reply length. The flush
 * is scheduled, not a hard deadline, so it can land later under host load.
 */
const ACP_TEXT_FLUSH_INTERVAL: Duration.Input = "50 millis";
// Subagent messages are stored as finished, so they skip the server's paragraph
// throttle and every snapshot is persisted. Match that throttle's 400 ms cadence.
const ACP_SUBAGENT_TEXT_FLUSH_INTERVAL: Duration.Input = "400 millis";

// Output of the running prompt. Session metadata and unknown updates do not reset its timeout.
const ACP_PROMPT_ACTIVITY_UPDATES: ReadonlySet<string> = new Set([
  "agent_message",
  "agent_message_chunk",
  "agent_thought",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "tool_call_content_chunk",
  "terminal_output_chunk",
  "terminal_update",
  "plan",
  "plan_update",
  "plan_removed",
  "compaction_update",
  "compaction_summary_chunk",
]);

export interface AcpAdapterV2RuntimeInput {
  readonly cwd: string;
  /**
   * Policy the session opened with. A runtime-mode change reopens the session,
   * so flavors that encode permissions in the launch command (Grok) read it here.
   */
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly mcpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly acpMcpServers?: ReadonlyArray<EffectAcpSchema.McpServer>;
  /** Scoped credentials for terminal fallback when an ACP agent drops `mcpServers`. */
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly resumeSessionId?: string;
  readonly interruptPromptOnCancel?: boolean;
  readonly clientCapabilities: EffectAcpSchema.InitializeRequest["clientCapabilities"];
  readonly clientInfo: AcpSessionRuntime.AcpSessionRuntimeOptions["clientInfo"];
  readonly requestLogger?: NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["requestLogger"]>;
  readonly protocolLogging: NonNullable<
    AcpSessionRuntime.AcpSessionRuntimeOptions["protocolLogging"]
  >;
  readonly onTermination: NonNullable<AcpSessionRuntime.AcpSessionRuntimeOptions["onTermination"]>;
  readonly onOutgoingResponseFailure?: AcpSessionRuntime.AcpSessionRuntimeOptions["onOutgoingResponseFailure"];
  readonly onOutgoingResponse?: AcpSessionRuntime.AcpSessionRuntimeOptions["onOutgoingResponse"];
  readonly onIncomingRequest?: AcpSessionRuntime.AcpSessionRuntimeOptions["onIncomingRequest"];
}

export type AcpAdapterV2NativeLogging = Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "requestLogger" | "protocolLogging"
>;

export interface AcpAdapterV2UserInputRequest {
  readonly nativeItemId: string;
  readonly nativeRequestId: string;
  readonly questions: ReadonlyArray<OrchestrationV2UserInputQuestion>;
}

export interface AcpAdapterV2ExtensionContext {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly reportProviderRetry: (input: {
    readonly sessionId: string;
    readonly failure: OrchestrationV2ProviderFailure;
  }) => Effect.Effect<void>;
  /**
   * A subagent's structured end on the root session (Grok `subagent_finished`),
   * keyed by its child session id. Finishes the subagent row, in the turn that
   * holds it or in the carryover of a settled one.
   */
  readonly finishSubagent: (notice: {
    readonly sessionId: string;
    readonly childSessionId: string;
    readonly status: "completed" | "failed" | "cancelled";
    readonly result: string | null;
  }) => Effect.Effect<void>;
  /**
   * Session-scoped background-task lifecycle reported via extension
   * notifications (e.g. Grok `x.ai/task_backgrounded`; older builds use the
   * underscore alias). Mutations for non-root sessions are ignored. A terminal
   * mutation also finishes the tool that registered the task in a settled turn
   * still held open for it, with `output` as its final text when given.
   */
  readonly applyBackgroundTaskMutation: (mutation: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly output?: string;
    /** What the task is, so a wake it causes can name it. */
    readonly report?: BackgroundWork;
  }) => Effect.Effect<void>;
  readonly requestUserInput: (
    input: AcpAdapterV2UserInputRequest,
    requestContext: EffectAcpProtocol.AcpRequestContext,
  ) => Effect.Effect<
    {
      readonly acknowledgeNativeResponse: Effect.Effect<void, EffectAcpErrors.AcpError>;
      readonly answers: ProviderUserInputAnswers | null;
    },
    EffectAcpErrors.AcpError
  >;
  /** Surfaces plan markdown as this turn's proposed-plan card (#8358). */
  readonly captureProposedPlan: (input: { readonly planMarkdown: string }) => Effect.Effect<void>;
  /** Last markdown captured for the active turn, as the exit-gate fallback. */
  readonly lastProposedPlanMarkdown: Effect.Effect<string | undefined>;
}

class AcpModelSelectionError extends Schema.TaggedError<AcpModelSelectionError>()(
  "AcpModelSelectionError",
  {
    model: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `The agent did not accept the model "${this.model}". Choose another model for this provider, then retry.`;
  }
}

/**
 * Maps one per-turn usage sample (flavors with reportsPerTurnPromptUsage)
 * directly onto TurnTokenUsage: the response's counters already cover exactly
 * this prompt.
 */
export function acpPerTurnPromptUsage(
  usage: EffectAcpSchema.Usage | null | undefined,
  hasSubagents: boolean,
  terminalStatus: OrchestrationV2ProviderTurn["status"],
): TurnTokenUsage {
  if (usage == null) {
    return { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents };
  }
  // TurnTokenUsage contract: input includes cache read + write and reasoning
  // is a subset of output, so clamp counters that exceed their parent and
  // drop the ones the agent left unset. Cache writes are capped at whatever
  // cache reads leave of input, so the pair cannot exceed it.
  const clampSubset = (value: number | null | undefined, parent: number) =>
    value == null ? undefined : Math.min(value, parent);
  const cachedInputTokens = clampSubset(usage.cachedReadTokens, usage.inputTokens);
  const cacheCreationTokens = clampSubset(
    usage.cachedWriteTokens,
    usage.inputTokens - (cachedInputTokens ?? 0),
  );
  const reasoningTokens = clampSubset(usage.thoughtTokens, usage.outputTokens);
  return {
    usageScope: "main_agent",
    usageStatus: terminalStatus === "completed" ? "complete" : "partial",
    hasSubagents,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheCreationTokens === undefined ? {} : { cacheCreationTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function acpProviderTurnTokenUsage(
  live: OrchestrationV2ProviderTurnTokenUsage | undefined,
  contextUsage: ThreadTokenUsageSnapshot | null,
  promptUsage: EffectAcpSchema.Usage | undefined,
  fallbackContextTokens: number | undefined,
  at: DateTime.Utc,
): OrchestrationV2ProviderTurnTokenUsage | undefined {
  if (promptUsage === undefined) return live;
  const usedTokens =
    live?.usedTokens ??
    (contextUsage !== null && contextUsage.usedTokens > 0 ? contextUsage.usedTokens : undefined) ??
    fallbackContextTokens;
  if (usedTokens === undefined) return live;
  const maxTokens = live?.maxTokens ?? contextUsage?.maxTokens;
  const cachedInputTokens =
    promptUsage.cachedReadTokens == null
      ? undefined
      : Math.min(promptUsage.cachedReadTokens, promptUsage.inputTokens);
  const reasoningOutputTokens =
    promptUsage.thoughtTokens == null
      ? undefined
      : Math.min(promptUsage.thoughtTokens, promptUsage.outputTokens);
  return {
    usedTokens: Math.max(0, Math.round(usedTokens)),
    ...(maxTokens == null ? {} : { maxTokens: Math.max(0, Math.round(maxTokens)) }),
    inputTokens: Math.max(0, Math.round(promptUsage.inputTokens)),
    ...(cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: Math.max(0, Math.round(cachedInputTokens)) }),
    outputTokens: Math.max(0, Math.round(promptUsage.outputTokens)),
    ...(reasoningOutputTokens === undefined
      ? {}
      : { reasoningOutputTokens: Math.max(0, Math.round(reasoningOutputTokens)) }),
    updatedAt: DateTime.formatIso(at),
  };
}

export interface AcpAdapterV2Flavor {
  readonly requiresSignIn?: (cause: unknown) => boolean;
  readonly mcpDiscoveryInstructions?: (catalog: string) => string;
  readonly supportsMcpDiscovery?: (
    agent: EffectAcpSchema.InitializeResponse,
    model: string,
  ) => boolean;
  readonly buildPrompt?: (input: {
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly promptCapabilities: EffectAcpSchema.AgentCapabilities["promptCapabilities"];
  }) => Effect.Effect<
    ReadonlyArray<EffectAcpSchema.ContentBlock>,
    EffectAcpErrors.AcpError,
    Scope.Scope
  >;

  /** Interprets provider-specific prompt errors before they cross into orchestration. */
  readonly promptFailure?: (cause: unknown) => OrchestrationV2ProviderFailure;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly clientCapabilitiesMeta?: NonNullable<
    EffectAcpSchema.InitializeRequest["clientCapabilities"]
  >["_meta"];
  readonly normalizeSessionUpdate?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => EffectAcpSchema.SessionNotification;
  /** Grok attaches its native context occupancy to ordinary notifications. */
  readonly extractContextUsage?: (
    source: Pick<EffectAcpSchema.SessionNotification, "_meta">,
    session: AcpSessionRuntime.AcpSessionRuntimeStartResult | null,
  ) => ThreadTokenUsageSnapshot | undefined;
  readonly onAvailableCommandsUpdate?: (
    commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
    meta?: unknown,
  ) => Effect.Effect<void>;
  readonly onSessionConfigurationUpdate?: (
    configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
    modeState: AcpSessionModeState | undefined,
    /** ACP's older session model state, for agents that list models there. */
    modelState: EffectAcpSchema.SessionModelState | undefined,
  ) => Effect.Effect<void>;
  readonly onUrlElicitation?: (input: {
    readonly elicitationId: string;
    readonly url: string;
    readonly message: string;
  }) => Effect.Effect<boolean>;
  /** Use a field's title as the question body when its description is absent. */
  readonly useElicitationFieldTitleAsQuestion?: boolean;
  readonly withRuntimeStartup?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly makeRuntime: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
  >;
  /**
   * Steers with another `session/prompt` while one runs: the agent answers the running prompt
   * `end_turn` and carries the turn on under the new one, leaving its tools and subagents alone.
   */
  readonly steersWithPrompt?: (initializeResult: EffectAcpSchema.InitializeResponse) => boolean;
  /** A provider extension that joins the running turn without cancelling it. */
  readonly steer?: (input: {
    readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
    readonly sessionId: string;
    readonly text: string;
    readonly providerTurnId: ProviderTurnId;
    readonly messageId: MessageId;
    readonly providerThreadId: ProviderThreadId;
    /** Ends once the agent can no longer take input for this turn (prompt returned or finalized). */
    readonly turnOver: {
      readonly await: Effect.Effect<void>;
      readonly isDone: Effect.Effect<boolean>;
    };
  }) => Effect.Effect<
    void,
    | ProviderAdapter.ProviderAdapterSteerRunUnsupportedError
    | ProviderAdapter.ProviderAdapterSteerRunError
  >;
  readonly customModels?: ReadonlyArray<string>;
  readonly resolveModelId?: (selection: ModelSelection) => string | undefined;
  /** Model option ids applied by the flavor rather than generic session configuration. */
  readonly ownedModelOptionIds?: ReadonlyArray<string>;
  /**
   * Replaces the default model application on session setup. Returns the model
   * the session now runs on. Antigravity resolves its provider-default alias
   * against the account's catalog instead of sending it to the agent.
   */
  readonly applyModelSelection?: (input: {
    readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
    readonly startResult: AcpSessionRuntime.AcpSessionRuntimeStartResult;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<string | undefined, EffectAcpErrors.AcpError>;
  /** Native session mode to select for a runtime policy (e.g. Antigravity `yolo`). */
  readonly sessionModeForPolicy?: (
    policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  ) => string | undefined;
  /**
   * The agent keeps `session/prompt` open across non-daemon background tasks and subagents until
   * that work finishes (e.g. `agy acp` 1.5.15+). While the prompt stays open after the agent's
   * reply ends, T3 surfaces those tasks as waiting rather than "Working" and does not defer
   * finalize once `session/prompt` returns.
   */
  readonly promptHoldsBackgroundWork?: (
    initializeResult: EffectAcpSchema.InitializeResponse,
  ) => boolean;
  /** Checklist entries report step progress. Each update is a finished snapshot. */
  readonly todoListUpdatesAreSnapshots?: boolean;
  /**
   * Opts the session into the ACP client `fs` capability. Agents read and write
   * files themselves under their own permission model unless a flavor sets
   * this. Requests pass the runtime policy guard, then these handlers, which
   * receive the cwd of the policy active when the request arrives (null when
   * the session has no workspace). Antigravity sets it and confines requests
   * to that workspace.
   */
  readonly clientFileSystem?: {
    readonly readTextFile: (
      request: EffectAcpSchema.ReadTextFileRequest,
      cwd: string | null,
    ) => Effect.Effect<EffectAcpSchema.ReadTextFileResponse, EffectAcpErrors.AcpError>;
    readonly writeTextFile?: (
      request: EffectAcpSchema.WriteTextFileRequest,
      cwd: string | null,
    ) => Effect.Effect<EffectAcpSchema.WriteTextFileResponse, EffectAcpErrors.AcpError>;
  };
  /**
   * Permission requests that are really questions (Antigravity `interaction_*`
   * tool calls). Returns the question and a response builder; undefined routes
   * the request through the normal approval card.
   */
  readonly extractPermissionQuestion?: (request: EffectAcpSchema.RequestPermissionRequest) =>
    | {
        readonly question: OrchestrationV2UserInputQuestion;
        readonly respond: (
          answers: ProviderUserInputAnswers,
        ) => EffectAcpSchema.RequestPermissionResponse | undefined;
      }
    | undefined;
  /**
   * Replaces T3's runtime-policy answer to a permission request. Grok's Auto
   * mode only asks about what its own classifier refused, so those must reach
   * the user instead of being approved by T3's policy.
   */
  readonly permissionDisposition?: (
    policy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
    request: EffectAcpSchema.RequestPermissionRequest,
  ) => AcpPermissionDisposition;
  /** Approval choices to advertise on the approval card for a permission request. */
  readonly approvalOptions?: (
    request: EffectAcpSchema.RequestPermissionRequest,
  ) => ReadonlyArray<ProviderApprovalOption>;
  /**
   * Activate saved sessions with `session/resume` before `session/load` when
   * the agent supports both. Antigravity's load replays history slowly.
   */
  readonly preferResumeSession?: boolean;
  readonly onSessionEvent?: (
    event: AcpSessionRuntime.AcpSessionRuntimeEvent,
    cwd: string,
  ) => Effect.Effect<void>;
  /** Batch launches without child completion signals become idle when the root turn ends. */
  readonly subagentsIdleOnTurnCompletion?: boolean;
  /** Child launches that the provider's session records still show as running. */
  readonly subagentsOutlivingPrompt?: (input: {
    readonly sessionId: string;
    readonly nativeTaskIds: ReadonlyArray<string>;
  }) => Effect.Effect<ReadonlyArray<string>>;
  /** Native child work recorded outside the ACP stream. */
  readonly readSubagentTranscript?: (input: {
    readonly sessionId: string;
    readonly nativeTaskId: string;
    readonly childSessionId: string | null;
  }) => Effect.Effect<ReadonlyArray<AcpSubagentTranscriptEntry>>;
  /** Pictures a typed child made (agy's image-generator), read once the child stops working. */
  readonly subagentImages?: (input: {
    readonly sessionId: string;
    readonly nativeTaskId: string;
    readonly nativeType: string;
  }) => Effect.Effect<ReadonlyArray<string>>;
  readonly supportsCompaction?: boolean;
  /** Sends /compact only to sessions that advertise the command. */
  readonly compactViaAdvertisedCommand?: boolean;
  readonly runtimeHarness?: string;
  readonly registerExtensions?: (
    context: AcpAdapterV2ExtensionContext,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  readonly extractSubagentUpdate?: (
    toolCall: AcpToolCallState,
  ) => AcpAdapterV2SubagentUpdate | undefined;
  /**
   * Optional Grok-style rewrite before tool projection (e.g. keep monitor start
   * ACKs in the running state until stream end).
   */
  readonly normalizeToolCall?: (toolCall: AcpToolCallState) => AcpToolCallState;
  /**
   * Makes one turn's matcher for tools the agent stopped itself (Antigravity kills its own
   * commands with a tool call and then reports them failed). Each normalized tool update goes
   * in with the clock time it arrived; out come the ids of tools to show as stopped rather than
   * failed, which may name tools updated earlier in the turn.
   */
  readonly trackAgentStoppedTools?: () => (
    toolCall: AcpToolCallState,
    nowMillis: number,
  ) => ReadonlyArray<string>;
  /**
   * Optional plan-file sniffing (#8358): providers that write their proposed
   * plan to a file mid-turn (Grok plan.md) return its markdown from a tool
   * call so T3 can show the proposed-plan card while plan mode is active.
   */
  readonly extractProposedPlanMarkdown?: (toolCall: AcpToolCallState) => string | undefined;
  /**
   * Optional mapping from a long-lived background tool start ACK to a task id
   * (e.g. monitor task uuid) so later synthetic text events can update it.
   */
  readonly extractBackgroundTaskId?: (toolCall: AcpToolCallState) => string | undefined;
  /**
   * Optional parse of root-session synthetic text (monitor-event lines, monitor
   * ended reminders). Returns every task mutation in the chunk so coalesced
   * progress / end notices are not dropped.
   */
  readonly extractBackgroundToolMutation?: (text: string) => ReadonlyArray<{
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly appendOutput: string;
  }>;
  /**
   * Optional parse of root-session synthetic text announcing a background
   * subagent's end ("Background subagent "<uuid>" ... completed successfully").
   * Older builds may never hydrate via get_command_or_subagent_output, so this
   * remains a terminal fallback. Current Grok additionally emits structured
   * `subagent_finished` session notifications.
   */
  readonly extractSubagentEndNotice?: (text: string) =>
    | {
        readonly childSessionId: string;
        readonly status: "completed" | "failed";
      }
    | undefined;
  /**
   * Optional hydration when a later tool (e.g. get_command TaskOutput) completes
   * previously registered background task id(s).
   */
  readonly extractBackgroundTaskCompletion?: (toolCall: AcpToolCallState) => ReadonlyArray<{
    readonly taskId: string;
    readonly status: "running" | "completed" | "failed";
    readonly appendOutput: string;
  }>;
  /**
   * Persistent monitors (e.g. Grok `persistent: true`) should not hold root-turn
   * deferred finalize open forever. Still tracked for post-settle wake.
   */
  readonly isPersistentBackgroundTool?: (toolCall: AcpToolCallState) => boolean;
  /**
   * A tool the agent goes on running after its prompt ends, and reports on by itself when the
   * tool ends. With `deferFinalizeForBackgroundWork`, the turn stays open until then.
   */
  readonly toolOutlivesPrompt?: (toolCall: AcpToolCallState) => boolean;
  /** A running command whose provider reports its result after the app turn settles. */
  readonly isBackgroundCommand?: (toolCall: AcpToolCallState) => boolean;
  /**
   * Whether a root-session frame belongs to a turn the agent started itself
   * after background work ended (Grok `task-completed-*`), not to T3's prompt.
   * Such frames never project into a root turn held open for that work; they
   * take the post-settle wake path once the held turn finalizes.
   */
  readonly isProviderWakeNotification?: (
    notification: EffectAcpSchema.SessionNotification,
  ) => boolean;
  /**
   * When true, keep the active turn open after session/prompt returns while
   * background tools/subagents are still running so later monitor/wake traffic
   * can project (Grok monitors finish after the root prompt settles).
   */
  readonly deferFinalizeForBackgroundWork?: boolean;
  /**
   * Every model reply ends with `usage_update`, also the ones the agent starts with no prompt
   * open. A turn that ends on the deferred finalize waits for it instead of the short debounce.
   */
  readonly replyEndsWithUsageUpdate?: boolean;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
  /** Interrupt the local prompt fiber before `session/cancel` (Grok wedged prompts). */
  readonly interruptPromptOnCancel?: boolean;
  /** One completed inference reported by a native usage update. */
  readonly extractStepUsage?: (
    update: Extract<EffectAcpSchema.SessionUpdate, { sessionUpdate: "usage_update" }>,
  ) => EffectAcpSchema.Usage | undefined;
  /** Enable only when this agent has verified per-turn PromptResponse.usage counters. */
  readonly reportsPerTurnPromptUsage?: boolean;
  /** Normalizes provider-specific PromptResponse.usage before summing into TurnTokenUsage. */
  readonly normalizePromptUsage?: (usage: EffectAcpSchema.Usage) => EffectAcpSchema.Usage;
  /**
   * Fails a dispatched prompt after this long with no update for its session while no
   * agent request, tool or subagent is open, and replaces the agent before the next turn.
   */
  readonly promptInactivityTimeout?: Duration.Input;
  /**
   * Reads how a prompt ended together with the reply it ended on, for an agent that explains
   * in that reply a stop ACP has no reason for (Antigravity's runtime ends a spent quota on
   * `refusal`). A failure returned here fails the turn in place of the generic stop handling.
   */
  readonly promptStopFailure?: (input: {
    readonly stopReason: EffectAcpSchema.StopReason;
    readonly error?: EffectAcpSchema.PromptResponse["error"];
    /** The assistant text still open when the prompt ended. */
    readonly replyText: string | undefined;
    /** The turn's model selection, which may be the flavor's default alias. */
    readonly model: string;
    readonly now: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ProviderFailure | undefined>;
  /** Reads provider-local failure evidence scoped to this prompt. */
  readonly watchPromptFailure?: (
    sessionId: string,
  ) => Effect.Effect<
    (
      result: EffectAcpSchema.PromptResponse,
    ) => Effect.Effect<OrchestrationV2ProviderFailure | undefined>
  >;
  /**
   * Kill and respawn the ACP child process before the next `session/prompt` after a
   * user interrupt. Grok can keep `task_already_running` state until the process exits.
   */
  readonly restartRuntimeAfterInterrupt?: boolean;
  /**
   * When true, every interrupt restarts the runtime, not just those carrying
   * `requestRuntimeRestart` (user Stop). Leave unset to keep non-Stop
   * interrupts (steering, restart_active) soft: `session/cancel` plus session
   * reuse in the same process.
   */
  readonly restartRuntimeOnEveryInterrupt?: boolean;
  readonly terminateRuntimeProcessGroupOnInterrupt?: boolean;
  /** A native request after prompt settlement starts a continuation before it is handled. */
  readonly wakeOnDetachedRequest?: boolean;
  /**
   * When true, an interrupt without `requestRuntimeRestart` (steering restart)
   * on a turn whose native prompt already settled skips the hard process-group
   * kill, the ACP cancel, and the runtime respawn entirely: the turn
   * terminalizes locally while background subagents keep running in the same
   * process and carry over into the replacement turn. Verified against the
   * real Grok CLI (tmp/grok-acp-experiments E1): a new session/prompt is
   * accepted concurrently while a fire-and-forget subagent is still running,
   * with no task_already_running. User Stop (`requestRuntimeRestart: true`)
   * keeps the hard teardown; mid-prompt non-Stop interrupts go soft
   * (`session/cancel` plus same-session re-prompt) unless
   * `restartRuntimeOnEveryInterrupt` is set.
   */
  readonly preserveRuntimeOnSettledInterrupt?: boolean;
  /**
   * When true (with continuationRequests), post-settle root session/update traffic
   * buffers and requests a provider continuation run instead of being dropped or
   * only appended to loaded history.
   */
  readonly enablePostSettleContinuation?: boolean;
  /**
   * When true, send image attachment content blocks even if the ACP agent
   * advertises `promptCapabilities.image: false`. Grok CLI currently accepts
   * and vision-processes image blocks while still reporting the capability as
   * false; without this override, screenshot turns fail before `session/prompt`.
   */
  readonly supportsImagePrompts?: boolean;
}

/** Whether image attachment blocks may be included in session/prompt. */
export function acpSupportsImagePrompts(input: {
  readonly flavorSupportsImagePrompts?: boolean | undefined;
  readonly negotiatedImage?: boolean | undefined;
}): boolean {
  return input.flavorSupportsImagePrompts === true || input.negotiatedImage === true;
}

/** Keeps provider-derived ids distinct when two configured ACP instances reuse native ids. */
export function acpScopedNativeId(instanceId: ProviderInstanceId, nativeId: string): string {
  return `provider-instance:${encodeURIComponent(instanceId)}:${nativeId}`;
}

/** Keeps pre-v2 persisted ids stable while scoping ids for newly created threads. */
export function acpProviderItemNativeId(input: {
  readonly instanceId: ProviderInstanceId;
  readonly itemIdentityVersion: 2 | undefined;
  readonly nativeId: string;
}): string {
  return input.itemIdentityVersion === 2
    ? acpScopedNativeId(input.instanceId, input.nativeId)
    : input.nativeId;
}

export interface AcpAdapterV2SubagentUpdate {
  readonly nativeTaskId: string;
  readonly prompt: string;
  readonly title: string | null;
  readonly model: string | null;
  /** The provider guarantees an unspecified worker model inherits the current session model. */
  readonly inheritParentModel?: boolean;
  /** The provider's own kind for this child, such as agy's "image-generator". */
  readonly nativeType?: string;
  readonly status:
    | "pending"
    | "running"
    | "idle"
    | "completed"
    | "failed"
    | "interrupted"
    | "cancelled";
  readonly childSessionId: string | null;
  readonly result: string | null;
  /**
   * When false, still project a normal tool turn item after the subagent update
   * (hydration tools like get_command_or_subagent_output). Defaults to true.
   */
  readonly suppressNormalTool?: boolean;
}

export type AcpSubagentTranscriptEntry = {
  readonly id: string;
  readonly createdAt?: DateTime.Utc;
} & (
  | { readonly kind: "assistant" | "error"; readonly text: string }
  | { readonly kind: "reasoning"; readonly text: string; readonly running: boolean }
  | {
      readonly kind: "tool";
      readonly name: string;
      readonly input: unknown;
      readonly output: string | null;
      readonly status: "running" | "failed" | "completed";
    }
);

export interface AcpAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly flavor: AcpAdapterV2Flavor;
  /** How agents spawn this install's `acp-mcp-bridge`; see `resolveSelfInvocation`. */
  readonly selfInvocation: SelfInvocation;
  /**
   * Opts the session into the ACP client `terminal` capability. Agents run
   * commands themselves unless an adapter sets this; with it, sessions
   * advertise `terminal: true` and run agent-created terminals through the
   * adapter's spawner with the provider instance's environment. Devin sets it.
   */
  readonly clientTerminals?: {
    readonly environment?: NodeJS.ProcessEnv;
    readonly shellCommands?: boolean;
  };
  readonly nativeLogging?: (threadId: ThreadId) => AcpAdapterV2NativeLogging;
  /**
   * Shared with ProviderContinuationService so post-settle wake traffic can start
   * a continuation run. Optional: adapters that omit it keep pre-continuation drop
   * / history-only behavior for null-activeTurn updates.
   */
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
  readonly testHooks?: {
    /**
     * A settled turn with no background work left armed its finish debounce
     * ({@link ACP_DEFERRED_FINALIZE_DEBOUNCE}); replay advances its test clock
     * by exactly that on this receipt.
     */
    readonly onDeferredFinalizeScheduled?: (debounce: Duration.Input) => Effect.Effect<void>;
    readonly afterPromptWireSettled?: () => Effect.Effect<void>;
    readonly afterPromptSettledWithBackgroundWork?: () => Effect.Effect<void>;
    readonly afterNativeResponseTransportClosed?: () => Effect.Effect<void>;
    readonly afterHardTeardownTransportDrained?: () => Effect.Effect<void>;
    readonly beforeNativeResponseAdmissionCheck?: (
      generation: number,
      requestId: string,
    ) => Effect.Effect<void>;
    readonly onNativeResponseLifecycle?: (event: {
      readonly generation?: number;
      readonly requestId?: string;
      readonly type:
        | "admission_rejected"
        | "failed"
        | "late_noop"
        | "registered"
        | "removed"
        | "timer_exited"
        | "timer_started"
        | "watcher_exited"
        | "watcher_started";
    }) => Effect.Effect<void>;
  };
}

export const AcpProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: true,
    // rollbackThread starts a fresh native session with no earlier conversation.
    rollbackStartsNewSession: true,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: true,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    // ACP defines no conversation truncation, so rollback resets the provider
    // conversation: T3 restores checkpointed state and the next turn starts a
    // fresh agent session without the rolled-back context.
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "weak",
    nativeRequestIds: "weak",
  },
  runtimePolicy: {
    // ACP agents run their own tools; T3 only answers their permission
    // requests by policy.
    enforcement: "client-boundary",
  },
} satisfies OrchestrationV2ProviderCapabilities;

/** A prompt-steered turn spans several prompts, each reporting its own usage. */
function addAcpUsage(
  total: EffectAcpSchema.Usage | undefined,
  usage: EffectAcpSchema.Usage | null | undefined,
): EffectAcpSchema.Usage | undefined {
  if (usage == null) return total;
  if (total === undefined) return usage;
  const optional = (left: number | null | undefined, right: number | null | undefined) =>
    left == null && right == null ? {} : { value: (left ?? 0) + (right ?? 0) };
  const thought = optional(total.thoughtTokens, usage.thoughtTokens);
  const cachedRead = optional(total.cachedReadTokens, usage.cachedReadTokens);
  const cachedWrite = optional(total.cachedWriteTokens, usage.cachedWriteTokens);
  return {
    totalTokens: total.totalTokens + usage.totalTokens,
    inputTokens: total.inputTokens + usage.inputTokens,
    outputTokens: total.outputTokens + usage.outputTokens,
    ...("value" in thought ? { thoughtTokens: thought.value } : {}),
    ...("value" in cachedRead ? { cachedReadTokens: cachedRead.value } : {}),
    ...("value" in cachedWrite ? { cachedWriteTokens: cachedWrite.value } : {}),
  };
}

function negotiatedCapabilities(
  base: OrchestrationV2ProviderCapabilities,
  started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
  flavor: AcpAdapterV2Flavor,
): OrchestrationV2ProviderCapabilities {
  const agent = started.initializeResult.agentCapabilities ?? {};
  const session = agent.sessionCapabilities;
  const setup = started.sessionSetupResult;
  const canSwitchModel =
    findModelConfigOption(setup.configOptions) !== undefined || setup.models != null;
  const canLoad = agent.loadSession === true;
  const canFork = session?.fork != null;
  return {
    ...base,
    turns: {
      ...base.turns,
      supportsActiveSteering:
        flavor.steersWithPrompt?.(started.initializeResult) === true ||
        (flavor.steer === undefined
          ? supportsAcpSteering(started.initializeResult)
          : base.turns.supportsActiveSteering),
    },
    sessions: {
      ...base.sessions,
      supportsModelSwitchInSession: canSwitchModel,
    },
    threads: {
      ...base.threads,
      canReadThreadSnapshot: canLoad,
      canForkThread: canFork,
      canForkFromTurn: false,
    },
    tools: {
      ...base.tools,
      // The stdio bridge (`sshcode acp-mcp-bridge`) makes the t3-code MCP toolkit
      // available regardless of the agent's optional http/sse MCP support.
      supportsMcpTools: true,
    },
    checkpointing: {
      ...base.checkpointing,
      providerCanReadConversationSnapshot: canLoad,
    },
  };
}

interface AcpMcpContext {
  readonly servers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly acpServers: ReadonlyArray<EffectAcpSchema.McpServer>;
  readonly processEnvironment?: NodeJS.ProcessEnv;
  readonly endpoint?: string;
  readonly authorization?: string;
  readonly toolDiscoveryCatalog?: Effect.Effect<string> | undefined;
}

/**
 * The MCP bridge credential a terminal gets when its session has no credential
 * scope of its own: none at all. Terminals otherwise inherit the environment
 * `options.clientTerminals.environment` and the process's own, and a server
 * that itself runs as an ACP child carries the bridge credential there, so the
 * unset keys remove it from the terminal's environment. A session's scoped
 * environment sets the real values.
 */
const BRIDGE_CREDENTIAL_STRIP_ENV: NodeJS.ProcessEnv = {
  T3_ACP_MCP_ENDPOINT: undefined,
  T3_ACP_MCP_AUTHORIZATION: undefined,
  T3_ACP_MCP_NODE: undefined,
  T3_ACP_MCP_ENTRYPOINT: undefined,
};

function acpMcpContext(
  session: McpProviderSession.McpProviderSessionConfig | undefined,
  self: SelfInvocation,
): AcpMcpContext {
  if (session === undefined) {
    return { servers: [], acpServers: [] };
  }
  // Stdio is ACP's required baseline MCP transport. Agents that advertise
  // optional http support still routinely fail to wire injected http servers
  // through to their backend (codex-acp 1.2.0 and pi-acp both drop them), so
  // every ACP session gets the `sshcode acp-mcp-bridge` stdio server, which
  // forwards JSON-RPC to T3's authenticated MCP endpoint. The credential
  // travels via environment variables, never the command line.
  return {
    servers: [
      {
        name: "t3-code",
        command: self.command,
        args: [...selfInvocationArgs(self, ["acp-mcp-bridge"])],
        env: [
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
          { name: "T3_ACP_MCP_ENDPOINT", value: session.endpoint },
          { name: "T3_ACP_MCP_AUTHORIZATION", value: session.authorizationHeader },
        ],
      },
    ],
    acpServers: [{ type: "acp", name: "t3-code", serverId: "t3-code" }],
    endpoint: session.endpoint,
    authorization: session.authorizationHeader,
    toolDiscoveryCatalog: session.toolDiscoveryCatalog,
    processEnvironment: {
      // The thread id every process the agent starts inherits, so a tool run
      // from its shell can find its SSHCode thread. Claude and Codex sessions set
      // the same variable (PortScanner.AGENT_THREAD_ENV; a string literal here
      // because this package cannot reach apps/server).
      T3CODE_THREAD_ID: session.threadId,
      T3_ACP_MCP_ENDPOINT: session.endpoint,
      T3_ACP_MCP_AUTHORIZATION: session.authorizationHeader,
      T3_ACP_MCP_NODE: self.command,
      ...(self.entrypoint === undefined ? {} : { T3_ACP_MCP_ENTRYPOINT: self.entrypoint }),
    },
  };
}

function acpMcpActivation(context: AcpMcpContext) {
  return { mcpServers: context.servers, acpMcpServers: context.acpServers };
}

function nativeThreadId(
  driver: ProviderDriverKind,
  thread: OrchestrationV2ProviderThread,
): Effect.Effect<string, ProviderAdapter.ProviderAdapterProtocolError> {
  const id = thread.nativeThreadRef?.nativeId;
  if (id === null || id === undefined || id.trim().length === 0) {
    return Effect.fail(
      new ProviderAdapter.ProviderAdapterProtocolError({
        driver,
        detail: `Provider thread ${thread.id} is missing its ACP session id`,
      }),
    );
  }
  return Effect.succeed(id);
}

/** Stop reasons where the agent ended without finishing. ACP asks clients to show refusals. */
export function acpUnfinishedStopMessage(
  stopReason: EffectAcpSchema.StopReason | null | undefined,
): string | undefined {
  switch (stopReason) {
    case "refusal":
      return "The agent refused this request. The agent's next turn won't include this message or its reply.";
    case "max_tokens":
      return "The agent stopped because its reply reached the output token limit.";
    case "max_turn_requests":
      return "The agent stopped because it reached its request limit for this turn.";
    default:
      return undefined;
  }
}

function makeProviderThread(input: {
  readonly driver: ProviderDriverKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly appThreadId: OrchestrationV2ProviderThread["appThreadId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly nativeThreadId: string;
  readonly ownerNodeId?: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
  readonly itemIdentityVersion?: 2;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: input.driver,
      providerInstanceId: input.providerInstanceId,
      nativeThreadId: input.nativeThreadId,
    }),
    driver: input.driver,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId ?? null,
    nativeThreadRef: {
      driver: input.driver,
      nativeId: input.nativeThreadId,
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    contextUsage: null,
    nativeMetadata:
      input.itemIdentityVersion === undefined
        ? null
        : { itemIdentityVersion: input.itemIdentityVersion },
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * Unwrap a codex-acp style MCP call result (`{ result, error }` around MCP
 * `content`/`structuredContent`) the same way the native Codex adapter does,
 * so recovered MCP items render identical output. Unknown shapes pass through.
 */
function acpMcpToolCallOutput(rawOutput: unknown): unknown {
  const record = unknownRecord(rawOutput);
  if (record === undefined) return rawOutput;
  if (!("result" in record) && !("error" in record)) return rawOutput;
  const result = unknownRecord(record.result);
  const resultOutput =
    result === undefined ? undefined : (result.structuredContent ?? result.content ?? undefined);
  const errorMessage = unknownRecord(record.error)?.message;
  if (typeof errorMessage !== "string") {
    return resultOutput ?? rawOutput;
  }
  return resultOutput === undefined
    ? { error: errorMessage }
    : { error: errorMessage, result: resultOutput };
}

function acpDynamicToolName(tool: AcpToolCallState) {
  return typeof tool.data.name === "string" && tool.data.name.trim()
    ? tool.data.name.trim()
    : (tool.title ?? tool.kind);
}

function nonEmptyText(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function decodeByteText(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((entry) => typeof entry === "number" && Number.isInteger(entry))) {
    return undefined;
  }
  try {
    // Preserve leading/trailing whitespace like the string path in textFromUnknown.
    const text = new TextDecoder().decode(Uint8Array.from(value as number[]));
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

function textFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  const fromBytes = decodeByteText(value);
  if (fromBytes !== undefined) {
    return fromBytes;
  }
  if (Array.isArray(value)) {
    const parts = value.flatMap((entry) => {
      const text = textFromUnknown(entry);
      return text === undefined || text.length === 0 ? [] : [text];
    });
    return parts.length === 0 ? undefined : parts.join("\n");
  }
  const record = unknownRecord(value);
  if (record === undefined) {
    return undefined;
  }
  // Prefer prompt-facing Grok fields before nested envelopes.
  // Antigravity reports shell output as combinedOutput.
  for (const key of [
    "output_for_prompt",
    "stdout",
    "stderr",
    "output",
    "combinedOutput",
    "combined_output",
    "content",
    "text",
    "message",
  ]) {
    const direct = record[key];
    if (typeof direct === "string" && direct.length > 0) {
      return direct;
    }
    const decoded = decodeByteText(direct);
    if (decoded !== undefined) {
      return decoded;
    }
    const text = textFromUnknown(direct);
    if (text !== undefined && text.length > 0) {
      return text;
    }
  }
  const result = unknownRecord(record.Result) ?? unknownRecord(record.result);
  if (result !== undefined) {
    return textFromUnknown(result);
  }
  return undefined;
}

function commandExitCode(value: unknown): number | undefined {
  const record = unknownRecord(value);
  for (const key of ["exitCode", "exit_code", "code"]) {
    const candidate = record?.[key];
    if (typeof candidate === "number" && Number.isInteger(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Project an exit code only when the tool has a terminal native status.
 * Mid-stream Grok Bash re-reports carry exit_code 0 while still in progress;
 * interrupted tools must not retain that stale success code.
 */
export function acpProjectedCommandExitCode(
  status: "pending" | "running" | "waiting" | "completed" | "failed" | "interrupted",
  rawOutput: unknown,
  metadata?: unknown,
): number | undefined {
  if (status !== "completed" && status !== "failed") {
    return undefined;
  }
  return commandExitCode(rawOutput) ?? commandExitCode(metadata);
}

function structuredFileChanges(toolCall: AcpToolCallState) {
  const content = toolCall.data.content;
  if (!Array.isArray(content)) return [];
  return content.flatMap((entry) => {
    const diff = unknownRecord(entry);
    if (diff?.type !== "diff") return [];
    if (Array.isArray(diff.changes)) {
      return diff.changes.flatMap((candidate) => {
        const change = unknownRecord(candidate);
        const operation = typeof change?.operation === "string" ? change.operation.trim() : "";
        const path = typeof change?.path === "string" ? change.path.trim() : "";
        if (operation.length === 0 || path.length === 0) return [];
        const oldPath = typeof change?.oldPath === "string" ? change.oldPath.trim() : "";
        const fileType = typeof change?.fileType === "string" ? change.fileType.trim() : "";
        const mimeType = typeof change?.mimeType === "string" ? change.mimeType.trim() : "";
        return [
          {
            operation,
            path,
            ...(oldPath.length === 0 ? {} : { oldPath }),
            ...(fileType.length === 0 ? {} : { fileType }),
            ...(mimeType.length === 0 ? {} : { mimeType }),
          },
        ];
      });
    }
    const path = typeof diff.path === "string" ? diff.path.trim() : "";
    if (path.length === 0 || typeof diff.newText !== "string") return [];
    const operation =
      toolCall.kind === "delete"
        ? "delete"
        : diff.oldText === undefined || diff.oldText === null
          ? "add"
          : "modify";
    return [{ operation, path }];
  });
}

// Past this edit distance an edit keeps no patch text, so projecting a large
// rewrite cannot stall the event loop in the diff search. A created or emptied
// file has one empty side and needs no search, so it is never capped.
const ACP_V1_DIFF_MAX_EDITS = 1_000;

/**
 * Patch text for a tool call's diff content. ACP v2 diffs carry it as
 * `patch.text`. ACP v1 diffs carry `oldText`/`newText` instead (`oldText`
 * null or absent for a new file), and agents that negotiate v1 still send
 * that shape, so the patch is built from the two sides.
 */
function appendToolContentText(content: unknown, text: string): unknown[] {
  const next: unknown[] = Array.isArray(content) ? [...content] : [];
  const last = unknownRecord(next.at(-1));
  const lastContent = unknownRecord(last?.content);
  if (
    last?.type === "content" &&
    lastContent?.type === "text" &&
    typeof lastContent.text === "string"
  ) {
    next[next.length - 1] = {
      ...last,
      content: { ...lastContent, text: `${lastContent.text}${text}` },
    };
  } else {
    next.push({ type: "content", content: { type: "text", text } });
  }
  return next;
}

export function acpToolCallDiffPatch(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const diffs = content.flatMap((entry) => {
    const diff = unknownRecord(entry);
    return diff?.type === "diff" ? [diff] : [];
  });
  const patches = diffs.flatMap((diff): ReadonlyArray<{ text: string; path?: string }> => {
    const patch = unknownRecord(diff.patch);
    if (typeof patch?.text === "string") {
      const change =
        Array.isArray(diff.changes) && diff.changes.length === 1
          ? unknownRecord(diff.changes[0])
          : undefined;
      if (
        patch.format === "git_patch" &&
        patch.text.trimStart().startsWith("@@ ") &&
        typeof change?.path === "string"
      ) {
        const oldPath = typeof change.oldPath === "string" ? change.oldPath : change.path;
        const before = change.operation === "add" ? "/dev/null" : JSON.stringify(`a/${oldPath}`);
        const after =
          change.operation === "delete" ? "/dev/null" : JSON.stringify(`b/${change.path}`);
        return [
          {
            text: `diff --git ${JSON.stringify(`a/${oldPath}`)} ${JSON.stringify(`b/${change.path}`)}\n--- ${before}\n+++ ${after}\n${patch.text.trimStart()}`,
          },
        ];
      }
      return [{ text: patch.text }];
    }
    if (typeof diff.path !== "string" || typeof diff.newText !== "string") return [];
    const oldText = typeof diff.oldText === "string" ? diff.oldText : undefined;
    const structured = structuredPatch(
      oldText === undefined ? "/dev/null" : diff.path,
      diff.path,
      oldText ?? "",
      diff.newText,
      undefined,
      undefined,
      {
        context: 3,
        maxEditLength: oldText && diff.newText ? ACP_V1_DIFF_MAX_EDITS : Number.POSITIVE_INFINITY,
      },
    );
    return structured === undefined || structured.hunks.length === 0
      ? []
      : [{ text: formatPatch(structured, FILE_HEADERS_ONLY), path: diff.path }];
  });
  // Diff parsers split at Git headers once one exists, so every section then needs its own.
  const hasGitHeader = patches.some(({ text }) => /^diff --git /m.test(text));
  return patches.length === 0
    ? undefined
    : patches
        .map(({ text, path }) =>
          hasGitHeader && path !== undefined
            ? `diff --git ${JSON.stringify(`a/${path}`)} ${JSON.stringify(`b/${path}`)}\n${text}`
            : text,
        )
        .join("\n");
}

function resolvedPathInfo(
  toolCall: AcpToolCallState,
): { readonly path: string; readonly fromQuery: boolean } | undefined {
  const locations = toolCall.data.locations;
  if (Array.isArray(locations)) {
    for (const location of locations) {
      const path = unknownRecord(location)?.path;
      if (typeof path === "string" && path.trim().length > 0) {
        return { path: path.trim(), fromQuery: false };
      }
    }
  }
  const rawInput = unknownRecord(toolCall.data.rawInput);
  for (const key of ["path", "Path", "filePath", "file_path", "url"]) {
    const candidate = rawInput?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return { path: candidate.trim(), fromQuery: false };
    }
  }
  for (const key of ["query", "pattern"]) {
    const candidate = rawInput?.[key];
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      return { path: candidate.trim(), fromQuery: true };
    }
  }
  return undefined;
}

function pathFromToolCall(toolCall: AcpToolCallState): string | undefined {
  return resolvedPathInfo(toolCall)?.path;
}

/** Grok reports structured searches and Antigravity identifies them by title. */
function acpBackendWebSearch(
  rawInput: Record<string, unknown> | undefined,
  rawOutput: unknown,
  title?: string | null,
):
  | { readonly query: string | undefined; readonly results: OrchestrationV2WebSearchResult[] }
  | undefined {
  const variant = typeof rawInput?.variant === "string" ? rawInput.variant.toLowerCase() : "";
  const rawOutputRecord = unknownRecord(rawOutput);
  const action = unknownRecord(rawOutputRecord?.action);
  const isWebSearchTitle =
    /^\s*(?:web search|search the web|(?:run(?:ning)?\s+)?(?:web_search|search_web)\s*$)/iu.test(
      title ?? "",
    );
  const isWebSearchVariant = [
    "xsearch",
    "websearch",
    "web_search",
    "search_web",
    "web-search",
  ].includes(variant);
  if (!isWebSearchVariant && action?.type !== "search" && !isWebSearchTitle) {
    return undefined;
  }
  let args: Record<string, unknown> | undefined;
  if (typeof rawOutputRecord?.input === "string") {
    try {
      args = unknownRecord(JSON.parse(rawOutputRecord.input));
    } catch {
      args = undefined;
    }
  }
  const argsText = Object.entries(args ?? {})
    .filter(([, value]) => typeof value === "string" || typeof value === "number")
    .map(([key, value]) => `${key}: ${value}`)
    .join(", ");
  const query = [
    action?.query,
    args?.query,
    rawInput?.query,
    rawInput?.search_query,
    rawInput?.q,
    argsText,
  ]
    .find((value): value is string => typeof value === "string" && value.trim().length > 0)
    ?.trim();
  const urls = new Set<string>();
  for (const source of Array.isArray(action?.sources) ? action.sources : []) {
    const url = unknownRecord(source)?.url;
    if (typeof url === "string" && url.trim().length > 0) urls.add(url.trim());
  }
  if (urls.size === 0) {
    for (const match of textFromUnknown(rawOutput)?.matchAll(/https?:\/\/[^\s<>"]+/gu) ?? []) {
      urls.add(trimCitationUrl(match[0]));
    }
  }
  return { query, results: [...urls].map((url) => ({ url })) };
}

// Prose citations end in punctuation or a closing bracket that is not part of the URL.
function trimCitationUrl(raw: string): string {
  let url = raw;
  for (;;) {
    const trimmed = url.replace(/[.,;:]+$/u, "");
    const close = trimmed.at(-1);
    const open = close === ")" ? "(" : close === "]" ? "[" : undefined;
    if (open && close && trimmed.split(open).length < trimmed.split(close).length) {
      url = trimmed.slice(0, -1);
    } else if (trimmed === url) {
      return url;
    } else {
      url = trimmed;
    }
  }
}

function providerRequestKind(kind: string | "unknown"): ProviderRequestKind {
  switch (kind) {
    case "execute":
      return "command";
    case "read":
    case "search":
    case "fetch":
      return "file-read";
    case "edit":
    case "delete":
    case "move":
      return "file-change";
    default:
      return "command";
  }
}

function toolStatus(
  status: AcpToolCallState["status"],
): "pending" | "running" | "waiting" | "completed" | "failed" {
  switch (status) {
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "pending":
      return "pending";
    case "requiresAction":
      return "waiting";
    default:
      return "running";
  }
}

type ProjectedToolStatus = ReturnType<typeof toolStatus> | "interrupted";

function nodeStatus(status: ProjectedToolStatus): OrchestrationV2ExecutionNode["status"] {
  return status === "pending" ? "running" : status;
}

function completedAtForStatus(status: ProjectedToolStatus, now: DateTime.Utc): DateTime.Utc | null {
  return status === "completed" || status === "failed" || status === "interrupted" ? now : null;
}

function selectPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const optionIdOfKind = (kind: EffectAcpSchema.PermissionOption["kind"]) =>
    request.options.find((option) => option.kind === kind)?.optionId;
  if (decision === "acceptForSession") {
    // Agents may offer only allow_once, and answering "cancelled" would stop the turn the user approved.
    return optionIdOfKind("allow_always") ?? optionIdOfKind("allow_once");
  }
  return optionIdOfKind(decision === "accept" ? "allow_once" : "reject_once");
}

/**
 * The runtime policy approves one request, so answer with the agent's
 * allow-once option. Its allow-always option can outlive the session (Grok
 * saves it for the whole project); use it only when no allow-once exists.
 */
function selectAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectPermissionOptionId(request, "accept") ??
    selectPermissionOptionId(request, "acceptForSession")
  );
}

interface ActiveTextSegment {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
  sourceMessageId: string | null;
  text: string;
  // The running node and first text have been emitted.
  emitted: boolean;
  // Text changed since the last emission; a delayed flush is scheduled.
  dirty: boolean;
}

interface ActiveTextStream {
  current: ActiveTextSegment | null;
  nextSegment: number;
  readonly closedNamedSegments: Map<string, ActiveTextSegment>;
}

/**
 * Some ACP agents swallow a model API error (Kimi Code on a 429 usage limit)
 * and end the prompt with end_turn, having streamed nothing at all.
 */
const EMPTY_TURN_FAILURE_MESSAGE =
  "The agent ended its turn without writing anything or using a tool. Its model API most likely rejected the request (a usage limit, billing problem or expired key); the provider's own CLI shows the reason.";

// A user or delegated prompt that ends with no item at all. Slash commands
// (`/compact`) and the adapter's own wake turns may legitimately say nothing.
const isCompactionMessage = (message: ProviderAdapter.ProviderAdapterV2TurnMessage) =>
  message.text.trim() === "/compact" && message.attachments.length === 0;

const turnProducedNothing = (context: ActiveAcpTurn) =>
  context.input.message.creationSource !== "provider" &&
  !context.input.message.text.trimStart().startsWith("/") &&
  context.itemOrdinals.size === 0 &&
  context.assistant.current === null &&
  context.assistant.nextSegment === 0 &&
  context.reasoning.current === null &&
  context.reasoning.nextSegment === 0 &&
  context.tools.size === 0 &&
  context.subagents.size === 0 &&
  context.plans.size === 0;

interface AcpNativeBuildConfiguration {
  readonly modeId?: string;
  readonly configOptions: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

interface ActiveAcpTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly startedAt: DateTime.Utc;
  readonly completed: Deferred.Deferred<void, never>;
  // Root item ordinals allocated in this turn. Subagent child items keep
  // theirs on the subagent, which carries over into later turns.
  readonly itemOrdinals: Map<string, number>;
  readonly outgoingPrompt?: ReadonlyArray<EffectAcpSchema.ContentBlock> | undefined;
  consumedPromptMessageId?: string;
  readonly user: ActiveTextStream;
  readonly assistant: ActiveTextStream;
  readonly reasoning: ActiveTextStream;
  providerRetry?:
    | {
        readonly failure: OrchestrationV2ProviderFailure;
        readonly retry: OrchestrationV2ProviderRetry;
        readonly startedAt: DateTime.Utc;
        readonly itemOrdinal: number;
      }
    | undefined;
  contextUsage: ThreadTokenUsageSnapshot | null;
  nativeMetadata: OrchestrationV2ProviderThreadNativeMetadata | null;
  readonly tools: Map<string, AcpToolCallState>;
  readonly terminalCalls?: ReturnType<typeof makeRunningToolCalls>;
  /** Streamed tool updates skipped since the last persisted one; see `shouldPersistToolUpdate`. */
  readonly toolUpdatesSkipped: Map<string, number>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly subagents: Map<string, ActiveAcpSubagent>;
  readonly subagentsBySessionId: Map<string, ActiveAcpSubagent>;
  readonly pendingSubagentNotifications: Map<string, Array<EffectAcpSchema.SessionNotification>>;
  /** Background monitor/task id → toolCallId for synthetic root text updates. */
  readonly toolCallIdsByBackgroundTaskId: Map<string, string>;
  /**
   * Persistent monitors registered this turn. Excluded from deferred-finalize
   * holds so the root turn can settle while they keep streaming post-settle.
   */
  readonly persistentBackgroundTaskIds: Set<string>;
  /**
   * Monitor end events often only say "use get_command…"; keep the turn open
   * until TaskOutput hydration arrives (or the safety timeout elapses).
   */
  readonly awaitingBackgroundHydration: Set<string>;
  /**
   * Structured task ends (Grok `task_completed`) that landed while the prompt
   * was still open. The agent usually reports them itself; any registered row
   * still running when the prompt settles is finished from here, because the
   * provider never repeats the end and the row would hold the run open.
   */
  readonly backgroundTaskEndsBeforeSettle: Map<
    string,
    { readonly status: "completed" | "failed"; readonly output?: string }
  >;
  /**
   * Background rows (by tool call id) whose task ended authoritatively. Later
   * re-reports (an empty Bash frame, start-ack text after a poll) normalize
   * back to running; the row keeps its end so deferred finalize can settle.
   */
  readonly endedBackgroundToolStatus: Map<string, "completed" | "failed">;
  /** `trackAgentStoppedTools` for this turn. */
  readonly agentStoppedTools:
    | ((toolCall: AcpToolCallState, nowMillis: number) => ReadonlyArray<string>)
    | undefined;
  /**
   * A monitor end notice landed after the prompt settled: the CLI runs an
   * injected turn whose report never gets a turn_completed marker, so the
   * report chunk races the deferred-finalize debounce (thread a8e8b0a9 run 5
   * dropped the listing this way). Hold finalize until the report streams or
   * the safety timeout elapses.
   */
  readonly pendingInjectedReport: Set<string>;
  /**
   * An injected assistant report can race ahead of its monitor end notice.
   * Remember that unmatched report so the later notice consumes, rather than
   * re-arming, the task's pre-settle completion marker.
   */
  earlyInjectedReportObserved: boolean;
  readonly plans: Map<
    string,
    {
      readonly id: OrchestrationV2PlanArtifact["id"];
      readonly startedAt: DateTime.Utc;
      /** The turn that first reported the plan; later turns update its rows. */
      readonly origin: {
        readonly runId: ActiveAcpTurn["input"]["runId"];
        readonly rootNodeId: ActiveAcpTurn["input"]["rootNodeId"];
        readonly providerThreadId: ActiveAcpTurn["input"]["providerThread"]["id"];
        readonly providerTurnId: ActiveAcpTurn["providerTurnId"];
        readonly nativeItemId: string;
        readonly ordinal: number;
      };
      latest: OrchestrationV2PlanArtifact | null;
    }
  >;
  interrupted: boolean;
  nativeSteerSent: boolean;
  finalized: boolean;
  finalizedStatus: "completed" | "interrupted" | "failed" | "cancelled" | null;
  /** session/prompt already returned; finalize deferred for background work. */
  promptSettled: boolean;
  promptSettledStatus: "completed" | "interrupted" | "failed" | "cancelled" | null;
  /**
   * Completed the moment `runtime.prompt` resolves on the wire, before the
   * completion callback requests `runtimeCallbackPermit`. Failure does not
   * complete this; settled-soft classification ORs it with `promptSettled`.
   */
  /** Settles with the turn's latest prompt; a prompt-steer replaces a settled one. */
  promptWireSettled: Deferred.Deferred<void, never>;
  /** Frees the runtime for a steer prompt while the agent still holds this one's response. */
  foregroundIdle: Deferred.Deferred<void>;
  /** Counts the turn's prompts; only the latest one settles the turn. */
  promptSequence: number;
  promptUsage: EffectAcpSchema.Usage | undefined;
  turnTokenUsage: OrchestrationV2ProviderTurnTokenUsage | undefined;
  readonly generation: GenerationMeter;
  /** Whether the prompt's aggregate usage may include output before the text stream. */
  generationRequiresEndToEnd: boolean;
  backgroundFinalizeGeneration: number;
  /** Settles once the prompt request is written, for `promptInactivityTimeout`. */
  readonly promptDispatched: Deferred.Deferred<void, never>;
  /** `replyEndsWithUsageUpdate`: output arrived and its closing `usage_update` has not. */
  replyOpen: boolean;
  /** `replyEndsWithUsageUpdate`: the reply's latest output was assistant text. */
  replyLastOutputWasText: boolean;
  /** Close the streamed wake reply before the newly submitted prompt's own reply. */
  wakeReplyBeforePrompt: boolean;
  /** Whether this runtime keeps `session/prompt` open for non-daemon background work (`agy >= 1.5.15`). */
  readonly promptHoldsBackgroundWork: boolean;
  /** Last serialized background-wait task roster published on `provider_thread.updated`. */
  publishedBackgroundWaitKey: string;
  /** Clock millis of the prompt's last progress, for `promptInactivityTimeout`. */
  lastProgressAt: number;
  inactivityWatchdog: Fiber.Fiber<void> | undefined;
}

type AcpRuntimeTeardownState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "InProgress";
      readonly completed: Deferred.Deferred<void, ProviderAdapter.ProviderAdapterProtocolError>;
    }
  | { readonly _tag: "Failed"; readonly error: ProviderAdapter.ProviderAdapterProtocolError };

/** True when a root session/update carries ingestible turn output, not keepalive noise. */
function acpRootSessionUpdateIngestsOutput(
  notification: EffectAcpSchema.SessionNotification,
): boolean {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return (acpContentBlockDisplayText(update.content)?.length ?? 0) > 0;
    case "agent_message":
    case "agent_thought":
      return (update.content ?? []).some(
        (content) => (acpContentBlockDisplayText(content)?.length ?? 0) > 0,
      );
    case "tool_call":
    case "tool_call_update":
    case "plan":
    case "plan_update":
    case "plan_removed":
    case "compaction_update":
    case "compaction_summary_chunk":
      return parseSessionUpdateEvent(notification).events.some(
        (event) => event._tag === "ToolCallUpdated" || event._tag === "PlanUpdated",
      );
    default:
      return false;
  }
}

/** Monitor wakes arrive as their own chunk led by a tagged `<monitor-event task_id=…>`; bare mentions are content. */
const acpIsMonitorChatter = (text: string) =>
  /^\s*(?:<monitor-event\s|Monitor\s+["']?[0-9a-f-]{8,}["']?\s+ended)/i.test(text);

/**
 * Post-settle traffic that should be *buffered* for a continuation attach.
 * Excludes monitor end/event chatter that must not become ghost history.
 * Broader than {@link acpPostSettleContinuationOfferEvidence}: incremental
 * tool progress may still need replay once a real completion offers a run.
 */
export function acpPostSettleWakeEvidence(
  notification: EffectAcpSchema.SessionNotification,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundToolMutation"> = {},
): boolean {
  if (!acpRootSessionUpdateIngestsOutput(notification)) return false;
  const update = notification.update;
  if (
    (update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_message_chunk") &&
    update.content.type === "text"
  ) {
    const text = update.content.text;
    if ((flavor.extractBackgroundToolMutation?.(text) ?? []).length > 0) return false;
    if (update.sessionUpdate === "agent_message_chunk" && text.trim().length === 0) return false;
    if (acpIsMonitorChatter(text)) return false;
  }
  return true;
}

/**
 * Whether buffered post-settle traffic should *offer* a continuation run now.
 * Still-running tool streams often land farther apart than the deferred-finalize
 * quiet window; treating every tool_call_update as offer evidence re-opens a
 * synthetic "Background task completed." run on each chunk. Only completion-like
 * frames (real agent text, or a terminal tool status) should open a new run.
 */
export function acpPostSettleContinuationOfferEvidence(
  notification: EffectAcpSchema.SessionNotification,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundToolMutation" | "normalizeToolCall"> = {},
): boolean {
  if (!acpPostSettleWakeEvidence(notification, flavor)) {
    return false;
  }
  const update = notification.update;
  // Assistant text only. Thought/reasoning bursts alone must not open synthetic
  // "Background task completed." runs (duplicate-run spam after monitors).
  if (update.sessionUpdate === "agent_message_chunk") {
    return (acpContentBlockDisplayText(update.content)?.trim().length ?? 0) > 0;
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return parseSessionUpdateEvent(notification).events.some((event) => {
      if (event._tag !== "ToolCallUpdated") return false;
      // Normalize first: a Grok monitor start ACK arrives with raw status
      // "completed" but is a still-running background task, not completion.
      const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
      return toolCall.status === "completed" || toolCall.status === "failed";
    });
  }
  return false;
}

export function acpPostSettleWakeShouldBuffer(
  notification: EffectAcpSchema.SessionNotification,
  backgroundWorkRunning: boolean,
): boolean {
  if (!backgroundWorkRunning) return true;
  const update = notification.update;
  return (
    update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk"
  );
}

/**
 * An app-owned wake (a delegated child finishing) is injected by the
 * orchestrator, not typed by the user. It reports on a sibling child and says
 * nothing about this session's own pending wake frames, so it must not discard
 * them the way a real user turn does. ClaudeAdapterV2 already leaves its buffer
 * alone on non-continuation turns; this keeps ACP consistent.
 */
export function acpIsAppOwnedWakeTurn(message: {
  readonly createdBy: string;
  readonly creationSource: string;
}): boolean {
  return message.createdBy === "agent" && message.creationSource === "server";
}

/** A continuation run attaches to wake traffic the agent produced on its own. */
function acpIsProviderContinuationMessage(message: {
  readonly createdBy: string;
  readonly creationSource: string;
}): boolean {
  return message.createdBy === "agent" && message.creationSource === "provider";
}

export function acpCarryoverTerminalShouldClearContinuation(input: {
  readonly continuationOffered: boolean;
  readonly wakeBufferLength: number;
}): boolean {
  return !input.continuationOffered && input.wakeBufferLength === 0;
}

export function acpTurnStartShouldPreserveContinuation(input: {
  readonly continuationRequested: boolean;
  readonly isContinuationTurn: boolean;
  readonly wakeBufferLength: number;
}): boolean {
  return !input.isContinuationTurn && input.continuationRequested && input.wakeBufferLength > 0;
}

export function acpPostSettleMonitorPromptShouldSuppress(
  mutation:
    | {
        readonly taskId: string;
        readonly status: "running" | "completed" | "failed";
      }
    | undefined,
): boolean {
  return mutation?.status === "running";
}

export function acpCompletedTurnShouldTerminalizeTool(
  tool: AcpToolCallState,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundTaskId" | "extractSubagentUpdate">,
): boolean {
  const status = toolStatus(tool.status);
  if (status !== "pending" && status !== "running") return false;
  if (flavor.extractBackgroundTaskId?.(tool) !== undefined) return false;
  return flavor.extractSubagentUpdate?.(tool) === undefined;
}

interface ActiveAcpSubagent {
  task: OrchestrationV2Subagent;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  /** Turn that spawned the subagent; carryover updates keep this lineage. */
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly parentProviderThreadId: ProviderThreadId;
  childSessionId: string | null;
  readonly transcript?: {
    readonly sessionId: string;
    readonly seen: Map<string, { fingerprint: number; startedAt: DateTime.Utc }>;
    readonly open: Map<string, AcpSubagentTranscriptEntry>;
    lastReply: string | undefined;
  };
  assistantText: string;
  readonly assistantMessages: Map<string, string>;
  // Messages whose latest text waits for a delayed flush.
  readonly pendingAssistantMessages: Set<string>;
  readonly childItemOrdinals: Map<string, number>;
  nextChildOrdinal: number;
  /**
   * Whether a terminal carryover status has been projected to events.
   * Completed roots project post-settle terminals immediately while their
   * subscriber remains observable. Non-completed roots retain terminals in
   * memory until the next attach. A later project:true path for the same entry
   * must still project once; this flag prevents double emission and pins
   * hasPendingBackgroundWork until projection lands.
   */
  terminalStatusProjected: boolean;
}

function acpSubagentStatusIsTerminal(status: OrchestrationV2Subagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled" ||
    status === "idle"
  );
}

export function acpSubagentStatusBlocksTurnSettlement(
  status: OrchestrationV2Subagent["status"],
): boolean {
  return status === "running" || status === "pending";
}

function acpSubagentHasPendingBackgroundWork(subagent: ActiveAcpSubagent): boolean {
  return (
    acpSubagentStatusBlocksTurnSettlement(subagent.task.status) || !subagent.terminalStatusProjected
  );
}

type AcpCarryoverSubagents = {
  readonly sessionId: string;
  readonly projectsLateTerminals: boolean;
  readonly subagents: ReadonlyArray<ActiveAcpSubagent>;
};

type PendingRuntimeRequest = {
  readonly generation: number;
  readonly nativeResponseAcknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>;
  readonly transportRequestId: string;
  readonly requestId: RuntimeRequestId;
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
} & (
  | {
      readonly type: "approval";
      readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
    }
  | {
      readonly type: "user_input";
      readonly answers: Deferred.Deferred<ProviderUserInputAnswers | null>;
    }
);

/** Writers update `order` and `messages` in place; readers copy them out. */
interface SnapshotMessageState {
  readonly order: Array<string>;
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  /** Snapshot assistant messages that came from the agent's reasoning stream. */
  readonly reasoningIds: ReadonlySet<OrchestrationV2ConversationMessage["id"]>;
  loadingRole: "user" | "assistant" | "thought" | null;
  loadingMessageId: string | null;
  loadingIndex: number;
}

const emptySnapshotState = (): SnapshotMessageState => ({
  order: [],
  messages: new Map(),
  reasoningIds: new Set(),
  loadingRole: null,
  loadingMessageId: null,
  loadingIndex: 0,
});

const TOOL_UPDATE_PERSIST_EVERY = 10;

/**
 * Some agents stream a tool's arguments (a file write's diff, `rawInput`) and
 * resend the whole call each time. Persist every 10th of those. Status, title,
 * and output the user watches live always persist, as does the agent's own
 * completed/failed when a flavor normalizes it to a non-terminal status.
 */
function shouldPersistToolUpdate(
  context: ActiveAcpTurn,
  key: string,
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
  reportedStatus: AcpToolCallState["status"],
): boolean {
  const skipped = context.toolUpdatesSkipped.get(key) ?? 0;
  const persist =
    reportedStatus === "completed" ||
    reportedStatus === "failed" ||
    previous === undefined ||
    previous.status !== next.status ||
    previous.title !== next.title ||
    toolCallVisibleOutputChanged(previous, next) ||
    skipped + 1 >= TOOL_UPDATE_PERSIST_EVERY;
  context.toolUpdatesSkipped.set(key, persist ? 0 : skipped + 1);
  return persist;
}

export const makeAcpAdapterV2 = Effect.fn("makeAcpAdapterV2")(function* (
  options: AcpAdapterV2Options,
) {
  const subagentsEnabledFor = yield* SubagentsEnabled;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const agentScope = yield* AgentScope;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const prepareChatEnvironment = yield* ProviderHost.chatEnvironment;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const { flavor, selfInvocation: self } = options;
  const readBaseMcpContext = (threadId: ThreadId | null) =>
    threadId === null
      ? Effect.succeed(acpMcpContext(undefined, self))
      : mcpSessions.read(threadId).pipe(Effect.map((session) => acpMcpContext(session, self)));
  const driver = flavor.driver;
  const continuationRequests = options.continuationRequests;
  const postSettleContinuationEnabled =
    flavor.enablePostSettleContinuation === true && continuationRequests !== undefined;
  const isBackgroundCommand = postSettleContinuationEnabled
    ? flavor.isBackgroundCommand
    : undefined;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(flavor.capabilities),
    planSelectionTransition: (input) => Effect.succeed(acpSelectionTransition(input)),
    openSession: Effect.fn("AcpAdapterV2.openSession")(
      function* (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) {
        const sessionScope = yield* Effect.scope;
        const tempEnvironment = yield* prepareChatEnvironment({
          instanceId: options.instanceId,
          driver,
          threadId: input.threadId,
          model: input.modelSelection.model,
          environment: {},
        });
        const readMcpContext = (threadId: ThreadId | null) =>
          readBaseMcpContext(threadId).pipe(
            Effect.map((context) => ({
              ...context,
              // The bridge credential unsets ride underneath, so a session
              // without a credential scope still removes the ambient one
              // (terminals and the provider CLI inherit the full process
              // environment otherwise), while a scoped session's real values
              // replace them.
              processEnvironment: {
                ...BRIDGE_CREDENTIAL_STRIP_ENV,
                ...context.processEnvironment,
                ...tempEnvironment,
              },
            })),
          );
        // Persisted ACP threads from before item identity v2 retain their old
        // deterministic ids. Fresh threads scope native ids by instance so
        // separately configured agents cannot collide.
        let itemIdentityVersion: 2 | undefined =
          input.initialProviderItemIdentityVersion ??
          (input.initialNativeThreadId === undefined ? 2 : undefined);
        const providerNativeId = (nativeId: string) =>
          acpProviderItemNativeId({
            instanceId: options.instanceId,
            itemIdentityVersion,
            nativeId,
          });
        const providerNodeId = (nativeItemId: string) =>
          idAllocator.derive.nodeFromProviderItem({
            driver,
            nativeItemId: providerNativeId(nativeItemId),
          });
        const providerMessageId = (nativeItemId: string) =>
          idAllocator.derive.messageFromProviderItem({
            driver,
            nativeItemId: providerNativeId(nativeItemId),
          });
        const providerTurnItemId = (nativeItemId: string) =>
          idAllocator.derive.turnItemFromProviderItem({
            driver,
            nativeItemId: providerNativeId(nativeItemId),
          });
        const deriveProviderTurnId = (nativeTurnId: string) =>
          idAllocator.derive.providerTurn({
            driver,
            nativeTurnId: providerNativeId(nativeTurnId),
          });
        const useProviderThreadIdentity = (thread: OrchestrationV2ProviderThread): void => {
          itemIdentityVersion = thread.nativeMetadata?.itemIdentityVersion;
        };
        const terminalEnvironmentBySessionId = new Map<string, NodeJS.ProcessEnv>();
        interface PendingTerminalEnvironment {
          readonly environment: NodeJS.ProcessEnv | undefined;
          readonly claimUnknownSession: boolean;
          readonly sessionId: string | null;
        }
        let pendingTerminalEnvironment: PendingTerminalEnvironment | null = {
          environment: (yield* readMcpContext(input.threadId)).processEnvironment,
          claimUnknownSession: input.initialNativeThreadId === undefined,
          sessionId: input.initialNativeThreadId ?? null,
        };
        const prepareTerminalEnvironment = (
          mcpContext: AcpMcpContext,
          sessionId?: string,
        ): void => {
          pendingTerminalEnvironment = {
            environment: mcpContext.processEnvironment,
            claimUnknownSession: false,
            sessionId: sessionId ?? null,
          };
        };
        const prepareClaimableTerminalEnvironment = (mcpContext: AcpMcpContext): void => {
          pendingTerminalEnvironment = {
            environment: mcpContext.processEnvironment,
            claimUnknownSession: true,
            sessionId: null,
          };
        };
        const rememberTerminalEnvironment = (
          sessionId: string,
          mcpContext: AcpMcpContext,
        ): void => {
          const environment = mcpContext.processEnvironment;
          pendingTerminalEnvironment = null;
          if (environment === undefined) {
            terminalEnvironmentBySessionId.delete(sessionId);
          } else {
            terminalEnvironmentBySessionId.set(sessionId, environment);
          }
        };
        let notifyClientTerminalOutput: (sessionId: string, terminalId: string) => void = () => {};
        const clientTerminals: AcpClientTerminals | undefined =
          options.clientTerminals === undefined
            ? undefined
            : yield* makeAcpClientTerminals({
                defaultCwd: input.runtimePolicy.cwd ?? process.cwd(),
                environment: options.clientTerminals.environment,
                shellCommands: options.clientTerminals.shellCommands,
                onOutput: (sessionId, terminalId) =>
                  notifyClientTerminalOutput(sessionId, terminalId),
                environmentForSession: (sessionId) => {
                  const remembered = terminalEnvironmentBySessionId.get(sessionId);
                  if (remembered !== undefined) return remembered;
                  if (pendingTerminalEnvironment === null) {
                    return BRIDGE_CREDENTIAL_STRIP_ENV;
                  }
                  if (
                    pendingTerminalEnvironment.sessionId === null &&
                    pendingTerminalEnvironment.claimUnknownSession
                  ) {
                    pendingTerminalEnvironment = {
                      ...pendingTerminalEnvironment,
                      sessionId,
                    };
                  }
                  return pendingTerminalEnvironment.sessionId === sessionId
                    ? (pendingTerminalEnvironment.environment ?? BRIDGE_CREDENTIAL_STRIP_ENV)
                    : BRIDGE_CREDENTIAL_STRIP_ENV;
                },
              }).pipe(
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              );
        if (clientTerminals !== undefined) {
          yield* Scope.addFinalizer(sessionScope, clientTerminals.disposeAll);
        }
        // Terminal ids embedded in raw tool_call updates, remembered before the
        // content rewrite so emitTool can recover MCP-fallback command lines.
        const sessionScopedId = (sessionId: string, nativeId: string): string =>
          JSON.stringify([sessionId, nativeId]);
        const clientTerminalGenerations = new Map<string, number>();
        const pendingClientTerminalOutputs = new Set<string>();
        const clientTerminalOutputs = yield* Queue.unbounded<{
          readonly sessionId: string;
          readonly terminalId: string;
          readonly generation: number;
          readonly key: string;
        }>();
        notifyClientTerminalOutput = (sessionId, terminalId) => {
          const key = sessionScopedId(sessionId, terminalId);
          const generation = clientTerminalGenerations.get(key);
          if (generation === undefined || pendingClientTerminalOutputs.has(key)) return;
          pendingClientTerminalOutputs.add(key);
          Queue.offerUnsafe(clientTerminalOutputs, { sessionId, terminalId, generation, key });
        };
        const embeddedTerminalsByToolCallId = new Map<
          string,
          {
            readonly sessionId: string;
            readonly terminalIds: ReadonlyArray<string>;
            readonly toolCallId: string;
          }
        >();
        const toolCallIdsByAgentTerminalId = new Map<string, Set<string>>();
        const agentTerminalsById = new Map<string, AcpAgentTerminalState>();
        const rememberEmbeddedTerminals = (input: {
          readonly sessionId: string;
          readonly toolCallId: string;
          readonly terminalIds: ReadonlyArray<string>;
        }): void => {
          const toolCallKey = sessionScopedId(input.sessionId, input.toolCallId);
          for (const terminalId of embeddedTerminalsByToolCallId.get(toolCallKey)?.terminalIds ??
            []) {
            const terminalKey = sessionScopedId(input.sessionId, terminalId);
            const toolCallIds = toolCallIdsByAgentTerminalId.get(terminalKey);
            toolCallIds?.delete(input.toolCallId);
            if (toolCallIds?.size === 0) toolCallIdsByAgentTerminalId.delete(terminalKey);
          }
          embeddedTerminalsByToolCallId.delete(toolCallKey);
          embeddedTerminalsByToolCallId.set(toolCallKey, {
            sessionId: input.sessionId,
            terminalIds: input.terminalIds,
            toolCallId: input.toolCallId,
          });
          for (const terminalId of input.terminalIds) {
            const terminalKey = sessionScopedId(input.sessionId, terminalId);
            const toolCallIds = toolCallIdsByAgentTerminalId.get(terminalKey) ?? new Set<string>();
            toolCallIds.add(input.toolCallId);
            toolCallIdsByAgentTerminalId.set(terminalKey, toolCallIds);
          }
          for (const oldest of embeddedTerminalsByToolCallId.keys()) {
            if (embeddedTerminalsByToolCallId.size <= 256) break;
            const remembered = embeddedTerminalsByToolCallId.get(oldest);
            if (remembered === undefined) continue;
            for (const terminalId of remembered.terminalIds) {
              const terminalKey = sessionScopedId(remembered.sessionId, terminalId);
              const toolCallIds = toolCallIdsByAgentTerminalId.get(terminalKey);
              toolCallIds?.delete(remembered.toolCallId);
              if (toolCallIds?.size === 0) toolCallIdsByAgentTerminalId.delete(terminalKey);
            }
            embeddedTerminalsByToolCallId.delete(oldest);
          }
        };
        // Command lines of the terminals embedded in a tool call, so MCP calls
        // made through the acp-mcp-call terminal fallback keep their identity.
        const embeddedTerminalCommands = (
          sessionId: string,
          toolCallId: string,
        ): ReadonlyArray<string> =>
          (
            embeddedTerminalsByToolCallId.get(sessionScopedId(sessionId, toolCallId))
              ?.terminalIds ?? []
          ).flatMap((terminalId) => {
            const command =
              clientTerminals?.readCommandLine(terminalId) ??
              agentTerminalsById.get(sessionScopedId(sessionId, terminalId))?.command;
            return command === undefined ? [] : [command];
          });
        // Client terminals (Devin) run with the SSHCode server's privileges, so they
        // are policy-checked against the active turn policy; a command the user
        // already approved satisfies an "ask" disposition.
        const clientPolicyGrants = makeAcpClientPolicyGrants();
        let latestRuntimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy =
          input.runtimePolicy;
        let configuredAcpMode: { value: string; runtimeMode: RuntimeMode } | null = null;
        const events = yield* Queue.unbounded<
          ProviderAdapter.ProviderAdapterV2Event,
          ProviderAdapter.ProviderAdapterEventStreamError
        >();
        const activeTurn = yield* Ref.make<ActiveAcpTurn | null>(null);
        // `wakeOnDetachedRequest`: agent requests still waiting for an answer.
        const heldAgentRequests = new Set<object>();
        // Settles true when a turn attaches, false when Stop cancels waiting requests.
        let turnAttached = yield* Deferred.make<boolean>();
        const activeSessionId = yield* Ref.make<string | null>(null);
        // session/load replays history before activeSessionId names the loaded session.
        const loadingSessionId = yield* Ref.make<string | null>(null);
        const contextUsageBySessionId = yield* Ref.make(
          new Map<string, ThreadTokenUsageSnapshot>(),
        );
        const nativeMetadataBySessionId = yield* Ref.make(
          new Map<string, OrchestrationV2ProviderThreadNativeMetadata>(),
        );
        const providerThreadByNativeSessionId = yield* Ref.make(
          new Map<string, OrchestrationV2ProviderThread>(),
        );
        // T3 only owns the temporary Plan override. Remember the agent's
        // effective native configuration on entry and restore it on Build.
        const nativeBuildConfigurationBySessionId = new Map<string, AcpNativeBuildConfiguration>();
        const plansBySessionId = new Map<string, ActiveAcpTurn["plans"]>();
        const initialSessionActivationFailure = yield* Ref.make<{
          readonly sessionId: string;
          readonly error: EffectAcpErrors.AcpError;
        } | null>(null);
        const activeSessionSetup =
          yield* Ref.make<AcpSessionRuntime.AcpSessionRuntimeStartResult | null>(null);
        const activeModelState = Ref.get(activeSessionSetup).pipe(
          Effect.map((setup) => setup?.sessionSetupResult.models ?? undefined),
        );
        const activeSelection = yield* Ref.make<ModelSelection | null>(null);
        const activeInteractionMode = yield* Ref.make<ProviderInteractionMode | null>(null);
        const promptInstructionStates = yield* Ref.make(new Map<string, T3AcpInstructionState>());
        const compactionMarkers = yield* Ref.make(new Map<string, symbol>());
        const advertisedCommandNames = yield* Ref.make(new Map<string, ReadonlySet<string>>());
        const advertisedCommandsReady = new Map<string, Deferred.Deferred<void>>();
        const commandsReadyDeferred = (sessionId: string): Deferred.Deferred<void> => {
          let ready = advertisedCommandsReady.get(sessionId);
          if (ready === undefined) {
            ready = Deferred.makeUnsafe<void>();
            advertisedCommandsReady.set(sessionId, ready);
          }
          return ready;
        };
        const compactsContext =
          flavor.supportsCompaction === true || flavor.compactViaAdvertisedCommand === true;
        // Skills the agent advertised per session; prompts move a mentioned one to the front.
        const sessionSkillNames = yield* Ref.make(new Map<string, ReadonlySet<string>>());
        const runtimeRestartRequired = yield* Ref.make(false);
        const runtimeTeardownState = yield* Ref.make<AcpRuntimeTeardownState>({ _tag: "Idle" });
        const runtimeCallbackGeneration = yield* Ref.make(0);
        const runtimeCallbackGenerationCounter = yield* Ref.make(0);
        const allocateRuntimeCallbackGeneration = Ref.updateAndGet(
          runtimeCallbackGenerationCounter,
          (generation) => generation + 1,
        );
        const advanceRuntimeCallbackGeneration = allocateRuntimeCallbackGeneration.pipe(
          Effect.tap((generation) => Ref.set(runtimeCallbackGeneration, generation)),
        );
        const runtimeCallbackPermit = yield* Semaphore.make(1);
        const runtimeTransitionPermit = yield* Semaphore.make(1);
        const nativeResponseAcknowledgements = yield* Ref.make(
          new Map<
            string,
            {
              readonly acknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>;
              readonly generation: number;
            }
          >(),
        );
        const pendingRuntimeRequests = yield* Ref.make(new Map<string, PendingRuntimeRequest>());
        const emitNativeResponseLifecycle =
          options.testHooks?.onNativeResponseLifecycle ?? (() => Effect.void);
        const nextElicitationOrdinal = yield* Ref.make(0);
        const snapshot = yield* Ref.make(emptySnapshotState());

        const awaitRuntimeTeardown = Effect.fnUntraced(function* () {
          const state = yield* Ref.get(runtimeTeardownState);
          if (state._tag === "InProgress") {
            yield* Deferred.await(state.completed);
          } else if (state._tag === "Failed") {
            return yield* state.error;
          }
        });
        const runRuntimeCallbackAtGeneration = <A, E, R>(
          generation: number,
          effect: Effect.Effect<A, E, R>,
        ) =>
          runtimeCallbackPermit.withPermit(
            Effect.gen(function* () {
              if ((yield* Ref.get(runtimeTeardownState))._tag !== "Idle") {
                return Option.none<A>();
              }
              if ((yield* Ref.get(runtimeCallbackGeneration)) !== generation) {
                return Option.none<A>();
              }
              return Option.some(yield* effect);
            }),
          );
        const registerNativeResponseAcknowledgement = (
          generation: number,
          transportRequestId: string,
          acknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>,
        ) =>
          Effect.gen(function* () {
            yield* Ref.update(nativeResponseAcknowledgements, (current) => {
              const updated = new Map(current);
              updated.set(transportRequestId, { acknowledgement, generation });
              return updated;
            });
            yield* emitNativeResponseLifecycle({
              type: "registered",
              generation,
              requestId: transportRequestId,
            });
            if (!(yield* Deferred.isDone(acknowledgement))) return;
            yield* Ref.update(nativeResponseAcknowledgements, (current) => {
              if (current.get(transportRequestId)?.acknowledgement !== acknowledgement) {
                return current;
              }
              const updated = new Map(current);
              updated.delete(transportRequestId);
              return updated;
            });
          });
        const acknowledgeNativeResponse = (generation: number, transportRequestId: string) =>
          (
            options.testHooks?.beforeNativeResponseAdmissionCheck?.(
              generation,
              transportRequestId,
            ) ?? Effect.void
          ).pipe(
            Effect.andThen(runRuntimeCallbackAtGeneration(generation, Effect.void)),
            Effect.flatMap((registered) =>
              Option.isSome(registered)
                ? Effect.void
                : emitNativeResponseLifecycle({
                    type: "admission_rejected",
                    generation,
                    requestId: transportRequestId,
                  }).pipe(
                    Effect.andThen(
                      new EffectAcpErrors.AcpTransportError({
                        detail: "The ACP runtime closed before its response could be admitted",
                        cause: "Native response registration rejected during teardown",
                      }),
                    ),
                  ),
            ),
          );
        const awaitNativeResponseAcknowledgements = Effect.fnUntraced(function* (
          acknowledgements: ReadonlyArray<
            readonly [string | undefined, Deferred.Deferred<void, EffectAcpErrors.AcpError>]
          >,
        ) {
          if (acknowledgements.length === 0) return true;
          const completed = yield* Deferred.make<"settled" | "timeout">();
          yield* emitNativeResponseLifecycle({ type: "watcher_started" });
          const acknowledgementFiber = yield* Effect.forEach(
            acknowledgements,
            ([, acknowledgement]) => Deferred.await(acknowledgement).pipe(Effect.exit),
            { concurrency: "unbounded", discard: true },
          ).pipe(
            Effect.andThen(Deferred.succeed(completed, "settled")),
            Effect.interruptible,
            Effect.ensuring(emitNativeResponseLifecycle({ type: "watcher_exited" })),
            Effect.forkDetach,
          );
          yield* emitNativeResponseLifecycle({ type: "timer_started" });
          const timerFiber = yield* Effect.sleep("2 seconds").pipe(
            Effect.andThen(Deferred.succeed(completed, "timeout")),
            Effect.interruptible,
            Effect.ensuring(emitNativeResponseLifecycle({ type: "timer_exited" })),
            Effect.forkDetach,
          );
          const outcome = yield* Deferred.await(completed);
          yield* Fiber.interrupt(acknowledgementFiber);
          yield* Fiber.interrupt(timerFiber);
          if (outcome === "settled") return true;

          yield* Ref.update(nativeResponseAcknowledgements, (current) => {
            const updated = new Map(current);
            for (const [requestId, acknowledgement] of acknowledgements) {
              if (
                requestId !== undefined &&
                updated.get(requestId)?.acknowledgement === acknowledgement
              ) {
                updated.delete(requestId);
              }
            }
            return updated;
          });
          yield* Effect.forEach(
            acknowledgements,
            ([requestId]) =>
              emitNativeResponseLifecycle({
                type: "removed",
                ...(requestId === undefined ? {} : { requestId }),
              }),
            { concurrency: "unbounded", discard: true },
          );
          const timeoutError = new EffectAcpErrors.AcpTransportError({
            detail: "Timed out waiting for an admitted ACP response to reach the transport queue",
            cause: "Native response acknowledgement timed out",
          });
          yield* Effect.forEach(
            acknowledgements,
            ([requestId, acknowledgement]) =>
              Deferred.fail(acknowledgement, timeoutError).pipe(
                Effect.andThen(
                  emitNativeResponseLifecycle({
                    type: "failed",
                    ...(requestId === undefined ? {} : { requestId }),
                  }),
                ),
              ),
            { concurrency: "unbounded", discard: true },
          );
          return false;
        });
        const awaitAdmittedNativeResponses = Ref.get(nativeResponseAcknowledgements).pipe(
          Effect.flatMap((current) =>
            awaitNativeResponseAcknowledgements(
              [...current.entries()].map(
                ([requestId, entry]) => [requestId, entry.acknowledgement] as const,
              ),
            ),
          ),
        );
        const quarantineNativeTransportAtGeneration = Effect.fnUntraced(function* (
          generation: number,
        ) {
          const quarantined = yield* Ref.modify(nativeResponseAcknowledgements, (current) => {
            const updated = new Map(current);
            const acknowledgements: Array<Deferred.Deferred<void, EffectAcpErrors.AcpError>> = [];
            for (const [requestId, entry] of updated) {
              if (entry.generation !== generation) continue;
              updated.delete(requestId);
              acknowledgements.push(entry.acknowledgement);
            }
            return [acknowledgements, updated] as const;
          });
          const error = new EffectAcpErrors.AcpTransportError({
            detail: "The ACP runtime was replaced before its response reached the transport queue",
            cause: "ACP runtime transport was quarantined during teardown",
          });
          yield* Effect.forEach(
            quarantined,
            (acknowledgement) => Deferred.fail(acknowledgement, error),
            { concurrency: "unbounded", discard: true },
          );
        });
        const closeNativeTransport = runtimeCallbackPermit.withPermit(
          Effect.gen(function* () {
            yield* advanceRuntimeCallbackGeneration;
            const acknowledgements = yield* Ref.getAndSet(
              nativeResponseAcknowledgements,
              new Map(),
            );
            const error = new EffectAcpErrors.AcpTransportError({
              detail: "The ACP session closed before its admitted response reached the transport",
              cause: "ACP session transport closed",
            });
            yield* Effect.forEach(
              acknowledgements,
              ([requestId, entry]) =>
                Deferred.fail(entry.acknowledgement, error).pipe(
                  Effect.andThen(
                    emitNativeResponseLifecycle({
                      type: "removed",
                      generation: entry.generation,
                      requestId,
                    }),
                  ),
                  Effect.andThen(
                    emitNativeResponseLifecycle({
                      type: "failed",
                      generation: entry.generation,
                      requestId,
                    }),
                  ),
                ),
              { concurrency: "unbounded", discard: true },
            );
            return acknowledgements.size > 0;
          }),
        );
        // Post-settle wake support (Grok async subagent/monitor follow-up). After
        // the root turn finalizes, later root session/update traffic buffers here
        // until a provider continuation run attaches and drains it.
        const lastTurnRoute = yield* Ref.make<{
          readonly threadId: ThreadId;
          readonly providerThreadId: ProviderThreadId;
        } | null>(null);
        const wakeBuffer = yield* Ref.make<Array<EffectAcpSchema.SessionNotification>>([]);
        // Background work that ended after the prompt settled, keyed by task or
        // child session id. The next continuation offer names it for the user;
        // `offered` holds the keys that offer named. Work that ends while the
        // offer waits for its turn is named by the offer after it.
        const noWakeReports = {
          reports: new Map<string, BackgroundWorkReport>(),
          offered: new Set<string>(),
        };
        const wakeReports = yield* Ref.make<{
          readonly reports: ReadonlyMap<string, BackgroundWorkReport>;
          readonly offered: ReadonlySet<string>;
        }>(noWakeReports);
        const recordWakeReport = Effect.fnUntraced(function* (
          key: string,
          report: BackgroundWorkReport,
        ) {
          const context = yield* Ref.get(activeTurn);
          // An open prompt reports the work itself; no continuation follows.
          if (context !== null && !context.promptSettled && !context.finalized) return;
          yield* Ref.update(wakeReports, ({ reports, offered }) => ({
            reports: new Map(reports).set(key, report),
            offered,
          }));
        });
        const continuationRequested = yield* Ref.make(false);
        const continuationGeneration = yield* Ref.make(0);
        const continuationPermit = yield* Semaphore.make(1);
        const continuationClosed = yield* Ref.make(false);
        // Direct Stop (requestRuntimeRestart) quarantines residual events from the
        // stopped run so they cannot wake or attach to a later prompt/run.
        const stoppedRunQuarantine = yield* Ref.make(false);
        // A steering restart (or any interrupt) can finalize a turn while its
        // spawned subagents are still running natively. Carry the live
        // lineages into the next turn on the same session so their terminal
        // signals can still flip the original turn items instead of leaving
        // them running forever.
        const carryoverSubagents = yield* Ref.make<AcpCarryoverSubagents | null>(null);
        /** Settled turns by the persistent background task (a native timer) they left pending. */
        const settledPersistentTasks = new Map<string, ActiveAcpTurn>();
        // Keep command projection independent of the wake buffer. A running command must
        // not delay another command's offer or make its own progress an offer.
        let lastBackgroundCommandTurn: ActiveAcpTurn | null = null;
        const backgroundCommands = new Map<
          string,
          { readonly turn: ActiveAcpTurn; readonly sessionScoped: boolean }
        >();
        const handledBackgroundTaskIdsInActiveTurn = yield* Ref.make<ReadonlySet<string>>(
          new Set(),
        );
        // Background tasks that reached a genuine terminal mutation while a root
        // turn was still streaming and were not yet marked handled in-turn. The
        // mid-turn offer is suppressed (active turn owns the work); on finalize
        // these ids re-arm a single continuation when the agent never hydrated
        // or reported them before settle (regression: mid-turn complete + no
        // get_command must still wake after finalize).
        const midTurnUnreportedCompletedTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
        // A monitor-event can arrive after its task and the user-facing provider
        // turn already completed. Grok starts another internal prompt for that
        // stale notification; suppress its agent output until a genuine terminal
        // mutation or the next app turn so it cannot create a redundant app
        // continuation. Tool frames continue through normal hydration.
        const suppressPostSettleMonitorPrompt = yield* Ref.make(false);
        // Background tasks (Grok monitors) known to still run at session level.
        // Turn contexts are too short-lived to carry this: a continuation run
        // finalizes between monitor events, and the next commentary burst must
        // not reopen a run while the monitor is still streaming.
        const runningBackgroundTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
        // Task ids with a GENUINE end signal (monitor-ended reminder or
        // TaskOutput completion). Normalized tool statuses are not genuine:
        // Grok Bash re-reports carry exit_code 0 mid-stream. A straggler
        // monitor-event can land after the real end (the CLI keeps streaming
        // while the agent already consumed the output via
        // get_command_or_subagent_output); without the tombstone it would
        // resurrect the running set and pin offers/idle-release forever.
        // A tool-level failed get_command tombstones too: failing open to a
        // single continuation beats failing closed to a dead thread.
        const endedBackgroundTaskIds = yield* Ref.make<ReadonlySet<string>>(new Set());
        const endedBackgroundTaskIdLimit = 128;

        const setBackgroundTaskRunning = (taskId: string, running: boolean) =>
          Effect.gen(function* () {
            if (running && (yield* Ref.get(endedBackgroundTaskIds)).has(taskId)) {
              return;
            }
            yield* Ref.update(runningBackgroundTaskIds, (current) => {
              if (current.has(taskId) === running) return current;
              const next = new Set(current);
              if (running) {
                next.add(taskId);
              } else {
                next.delete(taskId);
              }
              return next;
            });
          });

        const markBackgroundTaskEnded = (taskId: string) =>
          Ref.update(endedBackgroundTaskIds, (current) => {
            if (current.has(taskId)) return current;
            const next = new Set(current).add(taskId);
            for (const oldest of next) {
              if (next.size <= endedBackgroundTaskIdLimit) break;
              next.delete(oldest);
            }
            return next;
          }).pipe(Effect.andThen(setBackgroundTaskRunning(taskId, false)));

        const applyBackgroundTaskMutationRunning = (mutation: {
          readonly taskId: string;
          readonly status: "running" | "completed" | "failed";
        }) =>
          mutation.status === "running"
            ? setBackgroundTaskRunning(mutation.taskId, true)
            : markBackgroundTaskEnded(mutation.taskId);

        const trackRunningBackgroundTools = (
          notification: EffectAcpSchema.SessionNotification,
        ): Effect.Effect<void> =>
          Effect.gen(function* () {
            if (flavor.extractBackgroundTaskId === undefined) return;
            for (const event of parseSessionUpdateEvent(notification).events) {
              if (event._tag !== "ToolCallUpdated") continue;
              const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
              const taskId = flavor.extractBackgroundTaskId(toolCall);
              if (taskId === undefined) continue;
              const status = toolStatus(toolCall.status);
              yield* setBackgroundTaskRunning(taskId, status === "pending" || status === "running");
            }
          });

        const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        let scheduleDeferredFinalize: (context: ActiveAcpTurn) => Effect.Effect<void> = () =>
          Effect.void;

        const nativeLogging = options.nativeLogging?.(input.threadId);
        const promptInactivityTimeoutMillis =
          flavor.promptInactivityTimeout === undefined
            ? undefined
            : Duration.toMillis(flavor.promptInactivityTimeout);
        // Each runtime owns its unanswered agent requests, so a dead process's leftovers
        // and late callbacks never reach its replacement.
        let openAgentRequests = new Set<string>();
        const notePromptProgress =
          /* Provider events include streaming deltas; avoid a span for each update. */
          Effect.fnUntraced(function* (notification?: EffectAcpSchema.SessionNotification) {
            if (promptInactivityTimeoutMillis === undefined) return;
            if (
              notification !== undefined &&
              !ACP_PROMPT_ACTIVITY_UPDATES.has(notification.update.sessionUpdate)
            ) {
              return;
            }
            const context = yield* Ref.get(activeTurn);
            if (
              context === null ||
              (notification !== undefined &&
                notification.sessionId !== context.nativeThreadId &&
                !context.subagentsBySessionId.has(notification.sessionId))
            ) {
              return;
            }
            context.lastProgressAt = yield* Clock.currentTimeMillis;
          });
        const closeAgentRequest = (agentRequests: Set<string>, requestId: string) =>
          Effect.suspend(() =>
            agentRequests.delete(requestId) && agentRequests === openAgentRequests
              ? notePromptProgress()
              : Effect.void,
          );
        // Startup can terminate before the turn projection helpers are initialized.
        let settleRuntimeTermination: (
          error: EffectAcpErrors.AcpError,
        ) => Effect.Effect<void> = () => Effect.void;
        const handleRuntimeTerminationAtGeneration = (
          runtimeGeneration: number,
          error: EffectAcpErrors.AcpError,
        ) =>
          runRuntimeCallbackAtGeneration(
            runtimeGeneration,
            Ref.set(runtimeRestartRequired, true).pipe(
              Effect.andThen(Effect.suspend(() => settleRuntimeTermination(error))),
            ),
          ).pipe(Effect.asVoid);
        const makeRuntimeInput = (
          runtimeGeneration: number,
          agentRequests: Set<string>,
          mcpContext: AcpMcpContext,
          resumeSessionId?: string,
          onTermination: AcpAdapterV2RuntimeInput["onTermination"] = (error) =>
            handleRuntimeTerminationAtGeneration(runtimeGeneration, error),
        ): AcpAdapterV2RuntimeInput => {
          return {
            cwd: input.runtimePolicy.cwd ?? process.cwd(),
            runtimePolicy: input.runtimePolicy,
            mcpServers: mcpContext.servers,
            acpMcpServers: mcpContext.acpServers,
            ...(mcpContext.processEnvironment === undefined
              ? {}
              : { processEnvironment: mcpContext.processEnvironment }),
            ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
            interruptPromptOnCancel: flavor.interruptPromptOnCancel ?? false,
            clientCapabilities: {
              fs: {
                readTextFile: flavor.clientFileSystem !== undefined,
                writeTextFile: flavor.clientFileSystem?.writeTextFile !== undefined,
              },
              terminal: clientTerminals !== undefined,
              elicitation: { form: {}, ...(flavor.onUrlElicitation ? { url: {} } : {}) },
              ...(flavor.clientCapabilitiesMeta ? { _meta: flavor.clientCapabilitiesMeta } : {}),
            },
            clientInfo: { name: "t3-code", version: "0.0.0" },
            onTermination: (error) =>
              Effect.sync(() => agentRequests.clear()).pipe(Effect.andThen(onTermination(error))),
            ...(promptInactivityTimeoutMillis === undefined
              ? {}
              : {
                  onIncomingRequest: (requestId: string) =>
                    Effect.sync(() => {
                      agentRequests.add(requestId);
                    }),
                }),
            onOutgoingResponseFailure: (requestId, error) =>
              Ref.modify(nativeResponseAcknowledgements, (current) => {
                const entry = current.get(requestId);
                if (entry === undefined || entry.generation !== runtimeGeneration) {
                  return [
                    emitNativeResponseLifecycle({
                      type: "late_noop",
                      generation: runtimeGeneration,
                      requestId,
                    }),
                    current,
                  ] as const;
                }
                const updated = new Map(current);
                updated.delete(requestId);
                return [
                  Deferred.fail(entry.acknowledgement, error).pipe(
                    Effect.andThen(
                      emitNativeResponseLifecycle({
                        type: "removed",
                        generation: runtimeGeneration,
                        requestId,
                      }),
                    ),
                    Effect.asVoid,
                  ),
                  updated,
                ] as const;
              }).pipe(Effect.flatten, Effect.andThen(closeAgentRequest(agentRequests, requestId))),
            onOutgoingResponse: (requestId) =>
              Ref.modify(nativeResponseAcknowledgements, (current) => {
                const entry = current.get(requestId);
                if (entry === undefined || entry.generation !== runtimeGeneration) {
                  return [
                    emitNativeResponseLifecycle({
                      type: "late_noop",
                      generation: runtimeGeneration,
                      requestId,
                    }),
                    current,
                  ] as const;
                }
                const updated = new Map(current);
                updated.delete(requestId);
                return [
                  Deferred.succeed(entry.acknowledgement, undefined).pipe(
                    Effect.andThen(
                      emitNativeResponseLifecycle({
                        type: "removed",
                        generation: runtimeGeneration,
                        requestId,
                      }),
                    ),
                    Effect.asVoid,
                  ),
                  updated,
                ] as const;
              }).pipe(Effect.flatten, Effect.andThen(closeAgentRequest(agentRequests, requestId))),
            ...(nativeLogging?.requestLogger === undefined
              ? {}
              : { requestLogger: nativeLogging.requestLogger }),
            protocolLogging: nativeLogging?.protocolLogging ?? {
              logIncoming: false,
              logOutgoing: false,
              logger: () => Effect.void,
            },
          };
        };
        let runtimeScope: Scope.Closeable | undefined;
        let runtime!: AcpSessionRuntime.AcpSessionRuntime["Service"];
        let runtimeMcpBridge: AcpMcpOverAcpBridge | undefined;
        yield* Effect.addFinalizer(() =>
          runtimeScope === undefined
            ? Effect.void
            : Scope.close(runtimeScope, Exit.void).pipe(Effect.ignore),
        );

        const resolveItemOrdinal = (context: ActiveAcpTurn, nativeItemId: string) =>
          Effect.sync(() => {
            const existing = context.itemOrdinals.get(nativeItemId);
            if (existing !== undefined) return existing;
            const ordinal = context.input.providerTurnOrdinal * 100 + context.itemOrdinals.size + 1;
            context.itemOrdinals.set(nativeItemId, ordinal);
            return ordinal;
          });

        const resolveSubagentChildOrdinal = (subagent: ActiveAcpSubagent, nativeItemId: string) => {
          const existing = subagent.childItemOrdinals.get(nativeItemId);
          if (existing !== undefined) return existing;
          const ordinal = subagent.nextChildOrdinal++;
          subagent.childItemOrdinals.set(nativeItemId, ordinal);
          return ordinal;
        };

        const emitProviderRetry = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          status: "running" | "completed" | "interrupted" | "cancelled",
        ) {
          const state = context.providerRetry;
          if (state === undefined) return;
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: makeProviderRetryTurnItem({
              driver,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId: context.input.rootNodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              ...state,
              status,
              updatedAt: yield* DateTime.now,
            }),
          });
          if (status !== "running") context.providerRetry = undefined;
        });

        const reportProviderRetry = Effect.fnUntraced(function* (notice: {
          readonly sessionId: string;
          readonly failure: OrchestrationV2ProviderFailure;
        }) {
          const context = yield* Ref.get(activeTurn);
          if (
            context === null ||
            context.finalized ||
            context.interrupted ||
            context.nativeThreadId !== notice.sessionId ||
            (yield* Ref.get(stoppedRunQuarantine))
          )
            return;
          const previous = context.providerRetry;
          context.providerRetry = {
            failure: notice.failure,
            retry: {
              attempt: (previous?.retry.attempt ?? 0) + 1,
              maxAttempts: null,
              retryDelayMs: null,
            },
            startedAt: previous?.startedAt ?? (yield* DateTime.now),
            itemOrdinal:
              previous?.itemOrdinal ??
              (yield* resolveItemOrdinal(context, `terminal-failure:${context.providerTurnId}`)),
          };
          yield* emitProviderRetry(context, "running");
        });

        const lastCapturedProposedPlan = yield* Ref.make<{
          readonly nativeTurnId: string;
          readonly markdown: string;
          readonly planId: OrchestrationV2PlanArtifact["id"];
        } | null>(null);
        /**
         * Emits a completed proposed-plan artifact for the active turn. Same
         * plan id per turn so repeated captures (plan.md rewrites, the exit
         * gate) update one card; identical markdown within a turn is a no-op.
         */
        const captureProposedPlan = Effect.fnUntraced(function* (input: {
          readonly planMarkdown: string;
        }) {
          const context = yield* Ref.get(activeTurn);
          if (context === null) return;
          const markdown = input.planMarkdown.trim();
          if (markdown.length === 0) return;
          const previous = yield* Ref.get(lastCapturedProposedPlan);
          if (
            previous !== null &&
            previous.nativeTurnId === context.nativeTurnId &&
            previous.markdown === markdown
          ) {
            return;
          }
          const nativeItemId = `${context.nativeTurnId}:proposed-plan`;
          const planId =
            previous !== null && previous.nativeTurnId === context.nativeTurnId
              ? previous.planId
              : yield* idAllocator.allocate
                  .plan({
                    threadId: context.input.threadId,
                    runId: context.input.runId,
                    driver,
                  })
                  .pipe(Effect.orDie);
          yield* Ref.set(lastCapturedProposedPlan, {
            nativeTurnId: context.nativeTurnId,
            markdown,
            planId,
          });
          const now = yield* DateTime.now;
          const nodeId = idAllocator.derive.nodeFromProviderItem({ driver, nativeItemId });
          const turnItemId = idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId });
          const ordinal = yield* resolveItemOrdinal(context, nativeItemId);
          const nativeItemRef = { driver, nativeId: nativeItemId, strength: "weak" as const };
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "plan",
              status: "completed",
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: context.startedAt,
              completedAt: now,
            },
          });
          yield* emitProviderEvent({
            type: "plan.updated",
            driver,
            plan: {
              id: planId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              kind: "proposed_plan",
              status: "completed",
              markdown,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt: context.startedAt,
              completedAt: now,
              updatedAt: now,
              type: "proposed_plan",
              planId,
              markdown,
              streaming: false,
            },
          });
        });
        const lastProposedPlanMarkdown = Effect.gen(function* () {
          const context = yield* Ref.get(activeTurn);
          const previous = yield* Ref.get(lastCapturedProposedPlan);
          return context !== null && previous?.nativeTurnId === context.nativeTurnId
            ? previous.markdown
            : undefined;
        });

        const rememberSnapshotMessage = (message: OrchestrationV2ConversationMessage) =>
          Ref.update(snapshot, (current) => {
            const key = String(message.id);
            if (!current.messages.has(key)) current.order.push(key);
            current.messages.set(key, message);
            return current;
          });

        const textStreamFor = (
          context: ActiveAcpTurn,
          kind: "user" | "assistant" | "reasoning",
        ): ActiveTextStream =>
          kind === "user"
            ? context.user
            : kind === "assistant"
              ? context.assistant
              : context.reasoning;

        const textEmissionPermit = yield* Semaphore.make(1);
        /**
         * Emits the stream's current segment. A `flushOf` call is a delayed
         * flush: it emits only while that segment is still current and has
         * unsent text. The permit keeps a flush from landing after the
         * segment's completed snapshot.
         */
        const emitTextSegment = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          kind: "user" | "assistant" | "reasoning",
          completed: boolean,
          flushOf?: ActiveTextSegment,
        ) {
          const stream = textStreamFor(context, kind);
          const segment = stream.current;
          if (segment === null) return;
          if (flushOf !== undefined && (segment !== flushOf || !segment.dirty)) return;
          // The node carries no text, so it changes only when the segment
          // opens and when it completes.
          const emitsNode = completed || !segment.emitted;
          segment.emitted = true;
          segment.dirty = false;
          // Read the text in the same step that clears `dirty`. Chunks keep
          // appending while this emission yields; each one marks the segment
          // dirty again and reaches the next flush or the close.
          const text = segment.text;
          const now = yield* DateTime.now;
          const ordinal = yield* resolveItemOrdinal(context, segment.nativeItemId);
          const nodeId = providerNodeId(segment.nativeItemId);
          const turnItemId = providerTurnItemId(segment.nativeItemId);
          const nativeItemRef = {
            driver,
            nativeId: segment.nativeItemId,
            strength: "weak" as const,
          };
          if (kind !== "user" && emitsNode) {
            yield* emitProviderEvent({
              type: "node.updated",
              driver,
              node: {
                id: nodeId,
                threadId: context.input.threadId,
                runId: context.input.runId,
                parentNodeId: context.input.rootNodeId,
                rootNodeId: context.input.rootNodeId,
                kind: kind === "assistant" ? "assistant_message" : "reasoning",
                status: completed ? "completed" : "running",
                countsForRun: false,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: segment.startedAt,
                completedAt: completed ? now : null,
              },
            });
          }
          if (kind !== "reasoning") {
            const messageId = providerMessageId(segment.nativeItemId);
            const messageNodeId = kind === "user" ? context.input.rootNodeId : nodeId;
            const message: OrchestrationV2ConversationMessage = {
              createdBy: kind === "user" ? "user" : "agent",
              creationSource: "provider",
              id: messageId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId: messageNodeId,
              role: kind,
              text,
              attachments: [],
              streaming: !completed,
              createdAt: segment.startedAt,
              updatedAt: now,
            };
            yield* emitProviderEvent({ type: "message.updated", driver, message });
            yield* emitProviderEvent(
              kind === "user"
                ? {
                    type: "turn_item.updated",
                    driver,
                    turnItem: {
                      createdBy: "user",
                      creationSource: "provider",
                      id: turnItemId,
                      threadId: context.input.threadId,
                      runId: context.input.runId,
                      nodeId: messageNodeId,
                      providerThreadId: context.input.providerThread.id,
                      providerTurnId: context.providerTurnId,
                      nativeItemRef,
                      parentItemId: null,
                      ordinal,
                      status: completed ? "completed" : "running",
                      title: null,
                      startedAt: segment.startedAt,
                      completedAt: completed ? now : null,
                      updatedAt: now,
                      type: "user_message",
                      messageId,
                      inputIntent: "turn_start",
                      text,
                      attachments: [],
                    },
                  }
                : {
                    type: "turn_item.updated",
                    driver,
                    turnItem: {
                      id: turnItemId,
                      threadId: context.input.threadId,
                      runId: context.input.runId,
                      nodeId,
                      providerThreadId: context.input.providerThread.id,
                      providerTurnId: context.providerTurnId,
                      nativeItemRef,
                      parentItemId: null,
                      ordinal,
                      status: completed ? "completed" : "running",
                      title: null,
                      startedAt: segment.startedAt,
                      completedAt: completed ? now : null,
                      updatedAt: now,
                      type: "assistant_message",
                      messageId,
                      text,
                      streaming: !completed,
                    },
                  },
            );
            if (completed) yield* rememberSnapshotMessage(message);
            return;
          }
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt: segment.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              type: "reasoning",
              text,
              streaming: !completed,
            },
          });
        }, textEmissionPermit.withPermit);

        /**
         * Publishes a text change. A segment's first text emits at once so
         * live output starts immediately; later changes coalesce into one
         * snapshot per ACP_TEXT_FLUSH_INTERVAL. Closing the segment emits its
         * final text and makes a pending flush a no-op.
         */
        const publishTextSegment = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          kind: "user" | "assistant" | "reasoning",
        ) {
          const segment = textStreamFor(context, kind).current;
          if (segment === null) return;
          if (!segment.emitted) return yield* emitTextSegment(context, kind, false);
          if (segment.dirty) return;
          segment.dirty = true;
          yield* emitTextSegment(context, kind, false, segment).pipe(
            Effect.delay(ACP_TEXT_FLUSH_INTERVAL),
            Effect.forkIn(sessionScope),
          );
        });

        const closeTextStream = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          kind: "user" | "assistant" | "reasoning",
        ) {
          const stream = textStreamFor(context, kind);
          const segment = stream.current;
          if (segment === null) return;
          yield* emitTextSegment(context, kind, true);
          if (segment.sourceMessageId !== null) {
            stream.closedNamedSegments.set(segment.sourceMessageId, segment);
          }
          stream.current = null;
        });

        const closeTextStreams = Effect.fnUntraced(function* (context: ActiveAcpTurn) {
          yield* closeTextStream(context, "user");
          yield* closeTextStream(context, "reasoning");
          yield* closeTextStream(context, "assistant");
        });

        const openTextSegment = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          kind: "user" | "assistant" | "reasoning",
          sourceMessageId: string | null,
        ) {
          const stream = textStreamFor(context, kind);
          const closed =
            sourceMessageId === null ? undefined : stream.closedNamedSegments.get(sourceMessageId);
          // Preserve prior text and identity when a named message resumes after another stream.
          // A new object, so a flush scheduled before the close stays a no-op.
          const segment: ActiveTextSegment =
            closed === undefined
              ? {
                  nativeItemId:
                    sourceMessageId === null
                      ? `${context.nativeTurnId}:${kind}:${stream.nextSegment}`
                      : `${context.nativeTurnId}:${kind}:message:${sourceMessageId}`,
                  startedAt: yield* DateTime.now,
                  sourceMessageId,
                  text: "",
                  emitted: false,
                  dirty: false,
                }
              : { ...closed, emitted: false, dirty: false };
          if (closed === undefined) stream.nextSegment += 1;
          stream.current = segment;
          return segment;
        });

        const appendText = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          kind: "user" | "assistant" | "reasoning",
          text: string,
          messageId?: string | null,
        ) {
          if (text.length === 0) return;
          for (const other of ["user", "reasoning", "assistant"] as const) {
            if (other !== kind) yield* closeTextStream(context, other);
          }
          const stream = textStreamFor(context, kind);
          const sourceMessageId = messageId || null;
          if (
            stream.current !== null &&
            sourceMessageId !== null &&
            stream.current.sourceMessageId !== null &&
            stream.current.sourceMessageId !== sourceMessageId
          ) {
            yield* closeTextStream(context, kind);
          }
          let segment = stream.current;
          if (segment === null) {
            segment = yield* openTextSegment(context, kind, sourceMessageId);
          } else if (segment.sourceMessageId === null && sourceMessageId !== null) {
            // Keep the projected identity when an agent omits the first message id.
            segment.sourceMessageId = sourceMessageId;
          }
          segment.text += text;
          yield* publishTextSegment(context, kind);
        });

        const replaceText = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          kind: "user" | "assistant" | "reasoning",
          text: string,
          messageId: string,
        ) {
          for (const other of ["user", "reasoning", "assistant"] as const) {
            if (other !== kind) yield* closeTextStream(context, other);
          }
          let segment = textStreamFor(context, kind).current;
          if (segment?.sourceMessageId !== messageId) {
            yield* closeTextStream(context, kind);
            segment = yield* openTextSegment(context, kind, messageId);
          }
          segment.text = text;
          yield* publishTextSegment(context, kind);
        });

        const emitSubagentAssistant = Effect.fnUntraced(function* (
          subagent: ActiveAcpSubagent,
          text: string,
          mode: "append" | "replace" = "append",
          messageId?: string | null,
        ) {
          if (text.length === 0 && mode === "append") return;
          const nativeItemId = `${subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id}:message:${messageId ?? "result"}`;
          const previous = subagent.assistantMessages.get(nativeItemId);
          const messageText = mode === "replace" ? text : `${previous ?? ""}${text}`;
          subagent.assistantMessages.set(nativeItemId, messageText);
          subagent.assistantText = messageText;
          if (mode === "append" && previous !== undefined) {
            if (subagent.pendingAssistantMessages.has(nativeItemId)) return;
            subagent.pendingAssistantMessages.add(nativeItemId);
            yield* writeSubagentAssistant(subagent, nativeItemId, true).pipe(
              Effect.delay(ACP_SUBAGENT_TEXT_FLUSH_INTERVAL),
              Effect.forkIn(sessionScope),
            );
            return;
          }
          subagent.pendingAssistantMessages.delete(nativeItemId);
          yield* writeSubagentAssistant(subagent, nativeItemId, false);
        });

        // Reads the pending set under the permit, so it also waits for a write in progress.
        const flushPendingSubagentAssistant = (subagent: ActiveAcpSubagent) =>
          Effect.suspend(() =>
            Effect.forEach(
              [...subagent.pendingAssistantMessages],
              (nativeItemId) => writeSubagentAssistantUnlocked(subagent, nativeItemId, true),
              { discard: true },
            ),
          );

        const flushSubagentAssistant = (subagent: ActiveAcpSubagent) =>
          textEmissionPermit.withPermit(flushPendingSubagentAssistant(subagent));

        const writeSubagentAssistant = (
          subagent: ActiveAcpSubagent,
          nativeItemId: string,
          onlyIfPending: boolean,
        ) =>
          textEmissionPermit.withPermit(
            writeSubagentAssistantUnlocked(subagent, nativeItemId, onlyIfPending),
          );

        const writeSubagentAssistantUnlocked = Effect.fnUntraced(function* (
          subagent: ActiveAcpSubagent,
          nativeItemId: string,
          onlyIfPending: boolean,
        ) {
          if (onlyIfPending && !subagent.pendingAssistantMessages.delete(nativeItemId)) return;
          const text = subagent.assistantMessages.get(nativeItemId);
          if (text === undefined) return;
          const now = yield* DateTime.now;
          const ordinal = resolveSubagentChildOrdinal(subagent, nativeItemId);
          const artifacts = makeSubagentConversationArtifacts({
            messageId: providerMessageId(nativeItemId),
            turnItemId: providerTurnItemId(nativeItemId),
            threadId: subagent.childThreadId,
            rootNodeId: subagent.childRootNodeId,
            providerThreadId: subagent.task.providerThreadId,
            providerTurnId: null,
            nativeItemRef: { driver, nativeId: nativeItemId, strength: "weak" },
            role: "assistant",
            text,
            ordinal,
            now,
          });
          yield* emitProviderEvent({ type: "message.updated", driver, message: artifacts.message });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: artifacts.turnItem,
          });
        });

        const projectChildToolContentChunk = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          subagent: ActiveAcpSubagent,
          notification: EffectAcpSchema.SessionNotification,
        ) {
          const update = notification.update;
          if (update.sessionUpdate !== "tool_call_content_chunk") return;
          if (update.content.type !== "content") return;
          const text = acpContentBlockDisplayText(update.content.content);
          if (text === undefined || text.length === 0) return;
          const nativeTaskId = subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
          const key = `${nativeTaskId}:tool:${update.toolCallId}`;
          const previous = context.tools.get(key);
          const merged = mergeToolCallState(previous, {
            toolCallId: update.toolCallId,
            data: { content: appendToolContentText(previous?.data.content, text) },
          });
          context.tools.set(key, merged);
          if (!shouldPersistToolUpdate(context, key, previous, merged, merged.status)) return;
          const rootSessionId = yield* Ref.get(activeSessionId);
          const mcpIdentity = extractMcpToolCallIdentity(merged, {
            embeddedTerminalCommands: [
              ...embeddedTerminalCommands(notification.sessionId, update.toolCallId),
              ...(rootSessionId === null
                ? []
                : embeddedTerminalCommands(rootSessionId, update.toolCallId)),
            ],
          });
          const dispatched = mcpIdentity && acpMcpDispatch(mcpIdentity, merged.data.rawInput);
          const now = yield* DateTime.now;
          const status = toolStatus(merged.status);
          const startedAt = context.toolStartedAt.get(key) ?? now;
          context.toolStartedAt.set(key, startedAt);
          const ordinal = resolveSubagentChildOrdinal(subagent, key);
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: providerTurnItemId(key),
              threadId: subagent.childThreadId,
              runId: null,
              nodeId: subagent.childRootNodeId,
              providerThreadId: subagent.task.providerThreadId,
              providerTurnId: null,
              nativeItemRef: { driver, nativeId: key, strength: "strong" },
              parentItemId: null,
              ordinal,
              status,
              title: dispatched ? null : (merged.title ?? merged.kind ?? "Tool"),
              startedAt,
              completedAt: completedAtForStatus(status, now),
              updatedAt: now,
              type: "dynamic_tool",
              ...(mcpIdentity === undefined
                ? {}
                : mcpToolPresentation({
                    serverName: mcpIdentity.server,
                    toolName: dispatched?.tool ?? mcpIdentity.tool,
                    source: unknownRecord(
                      (
                        unknownRecord(unknownRecord(merged.data.rawOutput)?.result) ??
                        unknownRecord(merged.data.rawOutput)
                      )?._meta,
                    )?.source,
                  })),
              toolName:
                mcpIdentity === undefined
                  ? (acpDynamicToolName(merged) ?? "Tool")
                  : `${mcpIdentity.server}.${dispatched?.tool ?? mcpIdentity.tool}`,
              input: dispatched?.input ?? merged.data.rawInput ?? null,
              output: merged.data.rawOutput ?? merged.data.content ?? null,
            },
          });
        });

        const projectSubagentNotification = Effect.fnUntraced(function* (
          subagent: ActiveAcpSubagent,
          notification: EffectAcpSchema.SessionNotification,
        ) {
          const update = notification.update;
          if (update.sessionUpdate === "agent_message_chunk") {
            const text = acpContentBlockDisplayText(update.content);
            if (text !== undefined) {
              yield* emitSubagentAssistant(subagent, text, "append", update.messageId);
            }
          } else if (update.sessionUpdate === "agent_message") {
            if (update.content === undefined) return;
            const text = (update.content ?? [])
              .flatMap((content) => {
                const display = acpContentBlockDisplayText(content);
                return display === undefined ? [] : [display];
              })
              .join("\n");
            yield* emitSubagentAssistant(subagent, text, "replace", update.messageId);
          }
        });

        const projectSubagentTranscriptEntry = Effect.fnUntraced(function* (
          subagent: ActiveAcpSubagent,
          entry: AcpSubagentTranscriptEntry,
          finalize: boolean,
        ) {
          const transcript = subagent.transcript;
          if (transcript === undefined) return;
          const status =
            entry.kind === "tool"
              ? entry.status
              : entry.kind === "reasoning" && entry.running
                ? "running"
                : entry.kind === "error"
                  ? "failed"
                  : "completed";
          const projectedStatus: ProjectedToolStatus =
            finalize && status === "running"
              ? entry.kind === "reasoning"
                ? "completed"
                : "interrupted"
              : status;
          const fingerprint = Hash.hash([entry, projectedStatus]);
          const prior = transcript.seen.get(entry.id);
          if (
            prior?.fingerprint === fingerprint ||
            (prior === undefined && transcript.seen.size >= 4096)
          )
            return;
          const now = yield* DateTime.now;
          const startedAt = prior?.startedAt ?? entry.createdAt ?? now;
          transcript.seen.set(entry.id, { fingerprint, startedAt });
          if (projectedStatus === "running") transcript.open.set(entry.id, entry);
          else transcript.open.delete(entry.id);
          const nativeId = `${transcript.sessionId}:${subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id}:transcript:${entry.id}`;
          const ordinal = resolveSubagentChildOrdinal(subagent, nativeId);
          const nativeItemRef = { driver, nativeId, strength: "strong" as const };
          if (entry.kind === "assistant") {
            transcript.lastReply = entry.text;
            const { message, turnItem } = makeSubagentConversationArtifacts({
              messageId: providerMessageId(nativeId),
              turnItemId: providerTurnItemId(nativeId),
              threadId: subagent.childThreadId,
              rootNodeId: subagent.childRootNodeId,
              providerThreadId: subagent.task.providerThreadId,
              providerTurnId: null,
              nativeItemRef,
              role: "assistant",
              text: entry.text,
              ordinal,
              now: startedAt,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              driver,
              message: { ...message, updatedAt: now },
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver,
              turnItem: { ...turnItem, updatedAt: now },
            });
            return;
          }
          const base = {
            id: providerTurnItemId(nativeId),
            threadId: subagent.childThreadId,
            runId: null,
            nodeId: subagent.childRootNodeId,
            providerThreadId: subagent.task.providerThreadId,
            providerTurnId: null,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status: projectedStatus,
            title: null,
            startedAt,
            completedAt: completedAtForStatus(projectedStatus, now),
            updatedAt: now,
          };
          let turnItem: OrchestrationV2TurnItem;
          if (entry.kind === "reasoning") {
            turnItem = {
              ...base,
              type: "reasoning",
              text: entry.text,
              streaming: projectedStatus === "running",
            };
          } else if (entry.kind === "tool") {
            const args = unknownRecord(entry.input);
            const command = args?.CommandLine ?? args?.command;
            turnItem =
              (entry.name === "run_command" || entry.name === "bash" || entry.name === "shell") &&
              typeof command === "string"
                ? {
                    ...base,
                    type: "command_execution",
                    input: command,
                    ...(entry.output === null ? {} : { output: entry.output }),
                  }
                : {
                    ...base,
                    type: "dynamic_tool",
                    title: entry.name.trim() || "Tool",
                    toolName: entry.name.trim() || null,
                    input: entry.input,
                    output: entry.output,
                  };
          } else {
            turnItem = { ...base, type: "system_notice", message: entry.text };
          }
          yield* emitProviderEvent({ type: "turn_item.updated", driver, turnItem });
        });

        const readSubagentTranscript = Effect.fnUntraced(function* (
          subagent: ActiveAcpSubagent,
          finalize: boolean,
        ) {
          const transcript = subagent.transcript;
          if (transcript === undefined || flavor.readSubagentTranscript === undefined) return;
          const entries = yield* flavor.readSubagentTranscript({
            sessionId: transcript.sessionId,
            nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id,
            childSessionId: subagent.childSessionId,
          });
          for (const entry of entries)
            yield* projectSubagentTranscriptEntry(subagent, entry, finalize);
          if (finalize) {
            for (const entry of transcript.open.values()) {
              yield* projectSubagentTranscriptEntry(subagent, entry, true);
            }
          }
        });

        const followSubagentTranscript = Effect.fnUntraced(function* (subagent: ActiveAcpSubagent) {
          const generation = yield* Ref.get(runtimeCallbackGeneration);
          while (!acpSubagentStatusIsTerminal(subagent.task.status)) {
            yield* Effect.sleep("2 seconds");
            const result = yield* runRuntimeCallbackAtGeneration(
              generation,
              Effect.gen(function* () {
                if (acpSubagentStatusIsTerminal(subagent.task.status)) return;
                yield* readSubagentTranscript(subagent, false);
              }),
            );
            if (Option.isNone(result)) return;
          }
        });

        const emitSubagent = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          update: AcpAdapterV2SubagentUpdate,
        ) {
          // Hydration tools (get_command_or_subagent_output) use a new toolCallId
          // but reference the child via subagent_id / task id.
          const existing =
            context.subagents.get(update.nativeTaskId) ??
            (update.childSessionId !== null
              ? context.subagentsBySessionId.get(update.childSessionId)
              : undefined);
          const updateIsTerminal = acpSubagentStatusIsTerminal(update.status);
          if (
            existing !== undefined &&
            acpSubagentStatusIsTerminal(existing.task.status) &&
            !updateIsTerminal
          ) {
            return;
          }
          if (
            existing !== undefined &&
            existing.task.status === update.status &&
            updateIsTerminal &&
            existing.terminalStatusProjected
          ) {
            return;
          }
          // get_command_or_subagent_output may target monitors/bash tasks. Only
          // hydrate when we already have a matching subagent lineage. Spawn ACKs
          // (non-empty prompt) may create a new lineage; empty-prompt hydration
          // with suppressNormalTool must not invent a phantom subagent.
          if (existing === undefined) {
            const isHydrationOnly = update.prompt === "" && update.title === null;
            if (isHydrationOnly || update.suppressNormalTool === false) {
              return;
            }
          }
          const now = yield* DateTime.now;
          const nativeTaskId = existing?.task.nativeTaskRef?.nativeId ?? update.nativeTaskId;
          const nativeItemRef = {
            driver,
            nativeId: nativeTaskId,
            strength: "strong" as const,
          };
          const nodeId = existing?.task.id ?? providerNodeId(nativeTaskId);
          const childThreadId =
            existing?.childThreadId ??
            idAllocator.derive.threadFromProviderThread({
              driver,
              providerInstanceId: context.input.modelSelection.instanceId,
              nativeThreadId: `${context.nativeThreadId}:task:${nativeTaskId}`,
            });
          const childRootNodeId =
            existing?.childRootNodeId ?? providerNodeId(`${nativeTaskId}:child-root`);
          const turnItemId = existing?.turnItemId ?? providerTurnItemId(nativeTaskId);
          const turnItemOrdinal =
            existing?.turnItemOrdinal ?? (yield* resolveItemOrdinal(context, nativeTaskId));
          const taskStatus = update.status;
          let model = update.model?.trim() || existing?.task.model || null;
          if (model === null && update.inheritParentModel === true) {
            const config = findModelConfigOption(yield* runtime.getConfigOptions);
            model =
              config?.currentValue ||
              (yield* activeModelState)?.currentModelId ||
              context.input.modelSelection.model;
          }
          const nativeType = update.nativeType?.trim() || existing?.task.nativeType;
          let imagePaths = existing?.task.imagePaths;
          if (
            nativeType !== undefined &&
            flavor.subagentImages !== undefined &&
            taskStatus !== "pending" &&
            taskStatus !== "running"
          ) {
            const made = yield* flavor.subagentImages({
              sessionId: context.nativeThreadId,
              nativeTaskId,
              nativeType,
            });
            if (made.length > 0) imagePaths = made;
          }
          const task: OrchestrationV2Subagent = {
            ...(existing?.task ?? {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              origin: "provider_native" as const,
              createdBy: "agent" as const,
              driver,
              providerInstanceId: context.input.modelSelection.instanceId,
              providerThreadId: null,
              childThreadId,
              nativeTaskRef: nativeItemRef,
              prompt: update.prompt,
              title: update.title,
              result: null,
              startedAt: now,
            }),
            model,
            ...(nativeType === undefined ? {} : { nativeType }),
            ...(imagePaths === undefined ? {} : { imagePaths }),
            status: taskStatus,
            result: update.result ?? existing?.task.result ?? null,
            completedAt: acpSubagentStatusIsTerminal(taskStatus) ? now : null,
            updatedAt: now,
          };
          const subagent: ActiveAcpSubagent = existing ?? {
            task,
            childThreadId,
            childRootNodeId,
            turnItemId,
            turnItemOrdinal,
            providerTurnId: context.providerTurnId,
            parentProviderThreadId: context.input.providerThread.id,
            childSessionId: null,
            ...(flavor.readSubagentTranscript === undefined
              ? {}
              : {
                  transcript: {
                    sessionId: context.nativeThreadId,
                    seen: new Map(),
                    open: new Map(),
                    lastReply: undefined,
                  },
                }),
            assistantText: "",
            assistantMessages: new Map(),
            pendingAssistantMessages: new Set(),
            childItemOrdinals: new Map(),
            nextChildOrdinal: 101,
            terminalStatusProjected: false,
          };
          subagent.task = task;
          context.subagents.set(nativeTaskId, subagent);

          if (existing === undefined) {
            yield* emitProviderEvent({
              type: "app_thread.created",
              driver,
              appThread: makeSubagentChildThread({
                parentThread: context.input.appThread,
                childThreadId,
                parentNodeId: nodeId,
                activeProviderThreadId: null,
                providerInstanceId: context.input.modelSelection.instanceId,
                modelSelection: {
                  ...context.input.modelSelection,
                  model: task.model ?? context.input.modelSelection.model,
                },
                title: subagentThreadTitle({
                  parentTitle: context.input.appThread.title,
                  title: update.title,
                  prompt: update.prompt,
                  ordinal: context.subagents.size,
                }),
                now,
                createdBy: "agent",
                creationSource: "provider",
              }),
            });
            const promptNativeItemId = `${nativeTaskId}:prompt`;
            const promptArtifacts = makeSubagentConversationArtifacts({
              senderThreadId: context.input.threadId,
              messageId: providerMessageId(promptNativeItemId),
              turnItemId: providerTurnItemId(promptNativeItemId),
              threadId: childThreadId,
              rootNodeId: childRootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: { driver, nativeId: promptNativeItemId, strength: "weak" },
              role: "user",
              text: update.prompt,
              ordinal: 100,
              now,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              driver,
              message: promptArtifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver,
              turnItem: promptArtifacts.turnItem,
            });
          }

          const childSessionId = update.childSessionId;
          if (childSessionId !== null && subagent.childSessionId === null) {
            subagent.childSessionId = childSessionId;
            context.subagentsBySessionId.set(childSessionId, subagent);
            const providerThread = makeProviderThread({
              driver,
              providerInstanceId: context.input.modelSelection.instanceId,
              idAllocator,
              appThreadId: childThreadId,
              providerSessionId: input.providerSessionId,
              nativeThreadId: childSessionId,
              ...(itemIdentityVersion === undefined ? {} : { itemIdentityVersion }),
              forkedFrom: {
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
              },
              now,
            });
            subagent.task = { ...subagent.task, providerThreadId: providerThread.id };
            yield* Ref.update(providerThreadByNativeSessionId, (current) =>
              new Map(current).set(childSessionId, providerThread),
            );
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver,
              providerThread: { ...providerThread, status: "idle" },
            });
            const buffered = context.pendingSubagentNotifications.get(childSessionId) ?? [];
            context.pendingSubagentNotifications.delete(childSessionId);
            yield* Effect.forEach(
              buffered,
              (notification) =>
                notification.update.sessionUpdate === "tool_call_content_chunk"
                  ? projectChildToolContentChunk(context, subagent, notification)
                  : projectSubagentNotification(subagent, notification),
              { concurrency: 1, discard: true },
            );
          }

          if (subagent.transcript !== undefined) {
            if (existing === undefined || updateIsTerminal) {
              yield* readSubagentTranscript(subagent, updateIsTerminal);
            }
            if (existing === undefined && !updateIsTerminal) {
              yield* followSubagentTranscript(subagent).pipe(Effect.forkIn(sessionScope));
            }
          }
          yield* flushSubagentAssistant(subagent);
          if (
            taskStatus !== "running" &&
            subagent.assistantText.length === 0 &&
            subagent.transcript?.lastReply === undefined &&
            update.result !== null
          ) {
            yield* emitSubagentAssistant(subagent, update.result);
          }
          const result = update.result ?? subagent.task.result ?? (subagent.assistantText || null);
          subagent.task = {
            ...subagent.task,
            status: taskStatus,
            result,
            completedAt: acpSubagentStatusIsTerminal(taskStatus) ? now : null,
            updatedAt: now,
          };
          const providerThreadId = subagent.task.providerThreadId;
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: subagent.task.runId,
              parentNodeId: subagent.task.parentNodeId,
              rootNodeId: subagent.task.parentNodeId,
              kind: "subagent",
              status: taskStatus,
              countsForRun: false,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: subagent.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: subagent.task.startedAt,
              completedAt: subagent.task.completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: childRootNodeId,
              threadId: childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: childRootNodeId,
              kind: "root_turn",
              status: taskStatus,
              countsForRun: false,
              providerThreadId,
              providerTurnId: null,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: subagent.task.startedAt,
              completedAt: subagent.task.completedAt,
            },
          });
          yield* emitProviderEvent({ type: "subagent.updated", driver, subagent: subagent.task });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: subagent.task.runId,
              nodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: subagent.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: turnItemOrdinal,
              status: taskStatus,
              title: subagent.task.title,
              startedAt: subagent.task.startedAt,
              completedAt: subagent.task.completedAt,
              updatedAt: now,
              type: "subagent",
              subagentId: subagent.task.id,
              origin: "provider_native",
              driver,
              providerInstanceId: context.input.modelSelection.instanceId,
              childThreadId,
              prompt: subagent.task.prompt,
              result,
            },
          });
          if (acpSubagentStatusIsTerminal(taskStatus)) {
            subagent.terminalStatusProjected = true;
          }
          yield* syncOpenPromptBackgroundWait(context);
        });

        const toolOutputText = (toolCall: AcpToolCallState): string => {
          if (typeof toolCall.data.rawOutput === "string") {
            return toolCall.data.rawOutput;
          }
          if (
            typeof (toolCall.data.rawOutput as { text?: unknown } | undefined)?.text === "string"
          ) {
            return String((toolCall.data.rawOutput as { text: string }).text);
          }
          return textFromUnknown(toolCall.data.rawOutput) ?? "";
        };

        const setToolOutputText = (toolCall: AcpToolCallState, text: string): AcpToolCallState => ({
          ...toolCall,
          data: {
            ...toolCall.data,
            rawOutput: {
              type: "Text",
              text,
            },
          },
        });

        const appendToolOutputText = (
          toolCall: AcpToolCallState,
          appendOutput: string,
        ): AcpToolCallState => {
          if (appendOutput.length === 0) return toolCall;
          return setToolOutputText(toolCall, `${toolOutputText(toolCall)}${appendOutput}`);
        };

        const isMonitorEndNoticeText = (text: string): boolean =>
          /Monitor\s+["']?[0-9a-f-]{8,}/i.test(text) && /ended/i.test(text);

        const hasDeferredBackgroundWork = (context: ActiveAcpTurn): boolean => {
          if (flavor.wakeOnDetachedRequest && heldAgentRequests.size > 0) return true;
          if (!context.promptHoldsBackgroundWork && flavor.toolOutlivesPrompt !== undefined) {
            // A tool that never started has nothing to report later.
            for (const tool of context.tools.values()) {
              if (toolStatus(tool.status) === "running" && flavor.toolOutlivesPrompt(tool))
                return true;
            }
          }
          if (context.awaitingBackgroundHydration.size > 0) return true;
          if (context.pendingInjectedReport.size > 0) return true;
          for (const [taskId, toolCallId] of context.toolCallIdsByBackgroundTaskId) {
            // Persistent monitors stream after root settle; do not pin finalize.
            if (context.persistentBackgroundTaskIds.has(taskId)) continue;
            const tool = context.tools.get(toolCallId);
            if (tool === undefined) continue;
            const status = toolStatus(tool.status);
            if (status === "pending" || status === "running") return true;
          }
          // finalizeTurn idles these subagents, so waiting on them would never settle.
          if (
            flavor.subagentsIdleOnTurnCompletion === true &&
            (flavor.subagentsOutlivingPrompt === undefined || context.promptHoldsBackgroundWork)
          )
            return false;
          for (const subagent of context.subagents.values()) {
            if (acpSubagentStatusBlocksTurnSettlement(subagent.task.status)) {
              return true;
            }
          }
          return false;
        };

        const idleReportedSubagents = Effect.fnUntraced(function* (context: ActiveAcpTurn) {
          if (flavor.subagentsOutlivingPrompt === undefined || context.promptHoldsBackgroundWork)
            return;
          const nativeTaskId = (subagent: ActiveAcpSubagent) =>
            subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
          const running = [...context.subagents.values()].filter((subagent) =>
            acpSubagentStatusBlocksTurnSettlement(subagent.task.status),
          );
          if (running.length === 0) return;
          const atWork = yield* flavor.subagentsOutlivingPrompt({
            sessionId: context.nativeThreadId,
            nativeTaskIds: running.map(nativeTaskId),
          });
          if (context.finalized || context.interrupted) return;
          for (const subagent of running) {
            const id = nativeTaskId(subagent);
            if (
              atWork.includes(id) ||
              !acpSubagentStatusBlocksTurnSettlement(
                context.subagents.get(id)?.task.status ?? "idle",
              )
            )
              continue;
            yield* emitSubagent(context, {
              nativeTaskId: id,
              prompt: subagent.task.prompt,
              title: subagent.task.title,
              model: subagent.task.model,
              status: "idle",
              childSessionId: subagent.childSessionId,
              result: null,
            });
          }
        });

        const reportsBackgroundWait = flavor.promptHoldsBackgroundWork !== undefined;
        const isPromptBackgroundTool = (tool: AcpToolCallState) =>
          flavor.isPersistentBackgroundTool?.(tool) === true ||
          flavor.toolOutlivesPrompt?.(tool) === true;

        const openPromptBackgroundWaitTasks = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
        ): Effect.fn.Return<ReadonlyArray<OrchestrationV2PendingBackgroundTask>> {
          if (
            context.finalized ||
            context.interrupted ||
            context.replyOpen ||
            openAgentRequests.size > 0 ||
            (yield* Ref.get(pendingRuntimeRequests)).size > 0
          ) {
            return [];
          }
          const tasks: Array<OrchestrationV2PendingBackgroundTask> = [];
          for (const subagent of context.subagents.values()) {
            if (!acpSubagentStatusBlocksTurnSettlement(subagent.task.status)) continue;
            const description = (subagent.task.title ?? "").trim() || subagent.task.prompt.trim();
            tasks.push({
              taskId: subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id),
              kind: "subagent",
              ...(description.length > 0 ? { description } : {}),
              ...(subagent.task.startedAt === null
                ? {}
                : { startedAt: DateTime.formatIso(subagent.task.startedAt) }),
            });
          }
          for (const [id, tool] of context.tools) {
            if (id !== tool.toolCallId) continue;
            const status = toolStatus(tool.status);
            if (status !== "pending" && status !== "running" && status !== "waiting") continue;
            if (status === "running" && flavor.isBackgroundCommand?.(tool) === true) {
              const rawInput = unknownRecord(tool.data.rawInput);
              const summary =
                typeof rawInput?.toolSummary === "string" ? rawInput.toolSummary.trim() : "";
              const description =
                summary ||
                (tool.title && tool.title !== "Ran command" ? tool.title.trim() : "") ||
                (tool.command?.trim().split("\n", 1)[0] ?? "");
              tasks.push({
                taskId: tool.toolCallId,
                kind: "command",
                ...(flavor.toolOutlivesPrompt?.(tool) === true ? { wakesAgent: true } : {}),
                ...(description.length > 0 ? { description: truncate(description, 60) } : {}),
              });
              continue;
            }
            if (status === "running" && flavor.isPersistentBackgroundTool?.(tool) === true) {
              const startedAt = context.toolStartedAt.get(id);
              const wakeAt =
                startedAt === undefined
                  ? undefined
                  : backgroundTimerWakeAt(startedAt, tool.data.rawInput);
              tasks.push({
                taskId: id,
                kind: "background_task",
                ...(tool.title?.trim() ? { description: tool.title.trim() } : {}),
                ...(wakeAt === undefined ? {} : { wakeAt }),
              });
              continue;
            }
            // An active foreground tool means the lead agent is actively working.
            return [];
          }
          return backgroundWorkHoldsCompletion(tasks) &&
            (context.promptHoldsBackgroundWork ||
              context.promptSettled ||
              tasks.some((task) => task.kind === "background_task"))
            ? tasks
            : [];
        });

        const syncOpenPromptBackgroundWait = Effect.fnUntraced(function* (context: ActiveAcpTurn) {
          if (!reportsBackgroundWait || context.finalized) return;
          const nextTasks = yield* openPromptBackgroundWaitTasks(context);
          const nextKey = nextTasks
            .map((task) => {
              const detail =
                task.kind === "background_task"
                  ? task.wakeAt
                  : task.kind === "subagent"
                    ? task.startedAt
                    : task.kind === "command"
                      ? task.wakesAgent
                      : undefined;
              return [task.taskId, task.kind, task.description, detail].join("\0");
            })
            .join("\n");
          if (nextKey === context.publishedBackgroundWaitKey) return;
          context.publishedBackgroundWaitKey = nextKey;
          if (nextTasks.length > 0) {
            yield* closeTextStreams(context);
          }
          const knownProviderThread =
            (yield* Ref.get(providerThreadByNativeSessionId)).get(context.nativeThreadId) ??
            context.input.providerThread;
          const { waitingOnBackgroundWork, backgroundWaitStartedAt, ...baseThread } =
            knownProviderThread;
          const now = yield* DateTime.now;
          const updatedThread: OrchestrationV2ProviderThread = {
            ...baseThread,
            pendingBackgroundTasks: [...nextTasks],
            ...(nextTasks.length > 0
              ? {
                  waitingOnBackgroundWork: true as const,
                  backgroundWaitStartedAt:
                    (waitingOnBackgroundWork && backgroundWaitStartedAt) ?? DateTime.formatIso(now),
                }
              : {}),
            updatedAt: now,
          };
          yield* Ref.update(providerThreadByNativeSessionId, (current) =>
            new Map(current).set(context.nativeThreadId, updatedThread),
          );
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver,
            providerThread: updatedThread,
          });
        });

        const hasSurvivingBackgroundWork = (context: ActiveAcpTurn): boolean =>
          [...context.toolCallIdsByBackgroundTaskId.values()].some((toolCallId) => {
            const tool = context.tools.get(toolCallId);
            const status = tool === undefined ? undefined : toolStatus(tool.status);
            return status === "pending" || status === "running";
          }) ||
          [...context.subagents.values()].some((subagent) =>
            acpSubagentStatusBlocksTurnSettlement(subagent.task.status),
          );

        // scheduleDeferredFinalize is declared above openSession body start and
        // assigned after finalizeTurn so forked finalize Effect typing stays clean.
        const rearmDeferredFinalize = (context: ActiveAcpTurn) =>
          Effect.gen(function* () {
            if (!flavor.deferFinalizeForBackgroundWork) return;
            if (!context.promptSettled || context.finalized) return;
            if (hasDeferredBackgroundWork(context)) return;
            yield* scheduleDeferredFinalize(context);
          });

        // `let` breaks circular inference from monitor hydration re-entry.
        let emitTool: (
          context: ActiveAcpTurn,
          incoming: AcpToolCallState,
          projectedStatus?: ProjectedToolStatus,
          sessionScoped?: boolean,
        ) => Effect.Effect<void> = () => Effect.void;

        const markAwaitingBackgroundHydration = (context: ActiveAcpTurn, taskId: string) =>
          Effect.gen(function* () {
            if (context.awaitingBackgroundHydration.has(taskId)) return;
            context.awaitingBackgroundHydration.add(taskId);
            // Safety: do not hold the root turn forever if the agent never hydrates.
            yield* Effect.gen(function* () {
              yield* Effect.sleep("60000 millis");
              if (context.finalized || !context.awaitingBackgroundHydration.has(taskId)) return;
              context.awaitingBackgroundHydration.delete(taskId);
              // End notices keep the tool running until hydration; force-complete so
              // deferred finalize can proceed when get_command never arrives.
              const toolCallId = context.toolCallIdsByBackgroundTaskId.get(taskId);
              const tool = toolCallId !== undefined ? context.tools.get(toolCallId) : undefined;
              if (tool !== undefined) {
                const status = toolStatus(tool.status);
                if (status === "completed" || status === "failed") {
                  context.endedBackgroundToolStatus.set(tool.toolCallId, status);
                } else if (status === "pending" || status === "running") {
                  context.endedBackgroundToolStatus.set(tool.toolCallId, "completed");
                  yield* emitTool(context, { ...tool, status: "completed" });
                }
              }
              yield* rearmDeferredFinalize(context);
            }).pipe(Effect.forkIn(sessionScope), Effect.asVoid);
          });

        const markPendingInjectedReport = (context: ActiveAcpTurn, taskId: string) =>
          Effect.gen(function* () {
            // Only the settled-and-held window has the race; mid-turn reports
            // are protected by the prompt RPC still being open.
            if (!context.promptSettled) return;
            if (context.pendingInjectedReport.has(taskId)) return;
            context.pendingInjectedReport.add(taskId);
            // Safety: the injected turn may end without a report chunk.
            yield* Effect.gen(function* () {
              yield* Effect.sleep("25000 millis");
              if (context.finalized || !context.pendingInjectedReport.has(taskId)) return;
              context.pendingInjectedReport.delete(taskId);
              yield* rearmDeferredFinalize(context);
            }).pipe(Effect.forkIn(sessionScope), Effect.asVoid);
          });

        const clearMidTurnUnreportedTaskIds = (taskIds: ReadonlyArray<string>) =>
          Ref.update(midTurnUnreportedCompletedTaskIds, (current) => {
            let next: Set<string> | null = null;
            for (const taskId of taskIds) {
              if (!current.has(taskId)) continue;
              if (next === null) next = new Set(current);
              next.delete(taskId);
            }
            return next ?? current;
          });

        emitTool = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          incoming: AcpToolCallState,
          projectedStatus?: ProjectedToolStatus,
          sessionScoped = false,
        ) {
          // An identified message can stream concurrently with tool updates.
          // Keep its identity until the provider starts another message.
          if (context.assistant.current?.sourceMessageId == null)
            yield* closeTextStream(context, "assistant");
          if (context.reasoning.current?.sourceMessageId == null)
            yield* closeTextStream(context, "reasoning");
          yield* closeTextStream(context, "user");
          const background = backgroundCommands.get(incoming.toolCallId);
          const previous =
            context.tools.get(incoming.toolCallId) ??
            background?.turn.tools.get(incoming.toolCallId);
          const merged = mergeToolCallState(previous, incoming);
          const normalized = flavor.normalizeToolCall?.(merged) ?? merged;
          // agy flushes the command as failed and the timer as completed during session/cancel.
          // Keep their last output, then let the interrupted prompt settle the open cards.
          if (
            context.interrupted &&
            context.promptHoldsBackgroundWork &&
            projectedStatus === undefined &&
            previous !== undefined &&
            previous.status !== "failed" &&
            previous.status !== "completed" &&
            (previous.kind === "execute" || flavor.isPersistentBackgroundTool?.(previous))
          ) {
            context.tools.set(normalized.toolCallId, {
              ...normalized,
              status: previous.status ?? "inProgress",
            });
            return;
          }
          const endedStatus = context.endedBackgroundToolStatus.get(normalized.toolCallId);
          const reopens = (status: ProjectedToolStatus | undefined) =>
            endedStatus !== undefined && (status === "pending" || status === "running");
          const toolCall = reopens(toolStatus(normalized.status))
            ? { ...normalized, status: endedStatus! }
            : normalized;
          // A failure the agent's own stop call explains shows as stopped, also one reported
          // before that call.
          const agentStopped =
            projectedStatus === undefined && context.agentStoppedTools !== undefined
              ? context.agentStoppedTools(toolCall, yield* Clock.currentTimeMillis)
              : [];
          const effectiveProjectedStatus = agentStopped.includes(toolCall.toolCallId)
            ? "interrupted"
            : reopens(projectedStatus)
              ? endedStatus
              : projectedStatus;
          const status = effectiveProjectedStatus ?? toolStatus(toolCall.status);
          if (reportsBackgroundWait && status === "interrupted") {
            context.endedBackgroundToolStatus.set(toolCall.toolCallId, "failed");
          }
          context.tools.set(
            toolCall.toolCallId,
            reportsBackgroundWait && status === "interrupted"
              ? { ...toolCall, status: "failed" }
              : toolCall,
          );
          const startedTimer =
            reportsBackgroundWait &&
            status === "running" &&
            flavor.isPersistentBackgroundTool?.(toolCall) === true &&
            (previous?.status !== "inProgress" ||
              flavor.isPersistentBackgroundTool(previous) !== true);
          if (reportsBackgroundWait && !context.finalized && projectedStatus === undefined) {
            if (startedTimer) {
              // A newly armed timer is an explicit yield, even if ACP's last output was a tool.
              context.replyOpen = false;
              context.replyLastOutputWasText = false;
            } else if (
              context.promptHoldsBackgroundWork &&
              !isPromptBackgroundTool(toolCall) &&
              flavor.isBackgroundCommand?.(toolCall) !== true &&
              (previous === undefined || flavor.isBackgroundCommand?.(previous) !== true) &&
              (status === "pending" ||
                status === "running" ||
                status === "waiting" ||
                previous === undefined) &&
              flavor.extractSubagentUpdate?.(toolCall) === undefined
            ) {
              context.replyOpen = true;
              context.replyLastOutputWasText = false;
              yield* syncOpenPromptBackgroundWait(context);
            }
          }
          for (const toolCallId of agentStopped) {
            const stopped = context.tools.get(toolCallId);
            if (toolCallId !== toolCall.toolCallId && stopped !== undefined) {
              yield* emitTool(context, stopped, "interrupted");
            }
          }
          const backgroundTaskId = flavor.extractBackgroundTaskId?.(toolCall);
          if (backgroundTaskId !== undefined) {
            context.toolCallIdsByBackgroundTaskId.set(backgroundTaskId, toolCall.toolCallId);
            if (flavor.isPersistentBackgroundTool?.(toolCall) === true) {
              context.persistentBackgroundTaskIds.add(backgroundTaskId);
            }
            const backgroundStatus = effectiveProjectedStatus ?? toolStatus(toolCall.status);
            yield* setBackgroundTaskRunning(
              backgroundTaskId,
              backgroundStatus === "pending" || backgroundStatus === "running",
            );
            // Background tool that reaches a terminal status while the root
            // prompt is still open (completed, failed, or interrupted) was
            // consumed in-turn. Mark handled so late CLI re-reports and residual
            // agent chatter do not open synthetic "Background task completed."
            // runs. get_command TaskOutput still marks handled below.
            // Only before promptSettled: after STARTED the deferred-finalize
            // hold can let a monitor finish while the turn is still active;
            // marking then would suppress the legitimate post-settle TaskOutput
            // continuation (live: grok-post-settle-continuation-poll).
            // Terminal statuses only after normalizeToolCall (start ACKs stay
            // inProgress/running).
            //
            // Tradeoff: a pre-settle false "completed" normalization (Bash-
            // shaped re-report with exit_code 0, or the hydration safety
            // force-complete firing pre-settle) would permanently mark the task
            // handled and suppress its injected report chatter. The deleted
            // handled-id removal on late monitor-event mutations used to rescue
            // that case; likelihood is low because mid-turn monitor ends
            // normally arrive as reminder mutations that force inProgress, and
            // re-reports are documented post-settle traffic.
            if (
              !context.finalized &&
              !context.promptSettled &&
              backgroundStatus !== "pending" &&
              backgroundStatus !== "running"
            ) {
              yield* Ref.update(handledBackgroundTaskIdsInActiveTurn, (current) =>
                new Set(current).add(backgroundTaskId),
              );
              yield* Ref.update(midTurnUnreportedCompletedTaskIds, (current) => {
                if (!current.has(backgroundTaskId)) return current;
                const next = new Set(current);
                next.delete(backgroundTaskId);
                return next;
              });
            }
          }

          // get_command TaskOutput for registered monitor(s): hydrate those tools.
          const backgroundCompletions =
            projectedStatus === undefined
              ? (flavor.extractBackgroundTaskCompletion?.(toolCall) ?? [])
              : [];
          let hydratedRegisteredMonitor = false;
          for (const backgroundCompletion of backgroundCompletions) {
            // Genuine end signal when terminal: tombstone so straggler
            // monitor-event chatter cannot resurrect the running set after the
            // task truly ended. A still-running poll keeps the id running.
            yield* applyBackgroundTaskMutationRunning(backgroundCompletion);
            if (backgroundCompletion.status !== "running") {
              yield* Ref.update(handledBackgroundTaskIdsInActiveTurn, (current) =>
                new Set(current).add(backgroundCompletion.taskId),
              );
              yield* Ref.update(midTurnUnreportedCompletedTaskIds, (current) => {
                if (!current.has(backgroundCompletion.taskId)) return current;
                const next = new Set(current);
                next.delete(backgroundCompletion.taskId);
                return next;
              });
            }
            // A still-running fetch must keep the hydration hold (and its
            // safety timer) alive until output actually lands.
            if (backgroundCompletion.status !== "running") {
              context.awaitingBackgroundHydration.delete(backgroundCompletion.taskId);
            }
            const targetToolCallId = context.toolCallIdsByBackgroundTaskId.get(
              backgroundCompletion.taskId,
            );
            // Known background-task id (monitor registration) — never open a
            // phantom subagent for the same get_output poll.
            if (targetToolCallId !== undefined) {
              hydratedRegisteredMonitor = true;
            }
            const target =
              targetToolCallId !== undefined ? context.tools.get(targetToolCallId) : undefined;
            if (target !== undefined && target.toolCallId !== toolCall.toolCallId) {
              const nextStatus =
                backgroundCompletion.status === "running"
                  ? ("inProgress" as const)
                  : backgroundCompletion.status === "failed"
                    ? ("failed" as const)
                    : ("completed" as const);
              const hydrated =
                backgroundCompletion.appendOutput.length > 0
                  ? // TaskOutput is the real stdout; replace end-notice boilerplate
                    // so the timeline shows the listing, not only "Monitor ended…".
                    isMonitorEndNoticeText(toolOutputText(target)) ||
                    toolOutputText(target).trim().length === 0
                    ? setToolOutputText(
                        { ...target, status: nextStatus },
                        backgroundCompletion.appendOutput,
                      )
                    : appendToolOutputText(
                        { ...target, status: nextStatus },
                        backgroundCompletion.appendOutput,
                      )
                  : { ...target, status: nextStatus };
              // Only a poll or kill that itself succeeded is the task's end; a
              // failed poll call reads as failed but the task may still run.
              if (nextStatus !== "inProgress" && toolCall.status === "completed") {
                context.endedBackgroundToolStatus.set(target.toolCallId, nextStatus);
              }
              yield* emitTool(context, hydrated);
            }
          }

          // Monitor TaskOutput shares the get_command tool shape with subagent
          // hydration; do not spawn a phantom subagent for a registered monitor.
          const subagentUpdate = hydratedRegisteredMonitor
            ? undefined
            : flavor.extractSubagentUpdate?.(toolCall);
          if (subagentUpdate !== undefined) {
            yield* emitSubagent(context, subagentUpdate);
            if (subagentUpdate.suppressNormalTool !== false) {
              yield* rearmDeferredFinalize(context);
              yield* syncOpenPromptBackgroundWait(context);
              return;
            }
          }
          if (
            projectedStatus === undefined &&
            !shouldPersistToolUpdate(
              context,
              toolCall.toolCallId,
              previous,
              toolCall,
              merged.status,
            )
          ) {
            yield* rearmDeferredFinalize(context);
            yield* syncOpenPromptBackgroundWait(context);
            return;
          }
          // Replaying a running command can inform finalize without moving its
          // pending card to a second run. Its original owner gets the result.
          if (
            background !== undefined &&
            background.turn !== context &&
            (status === "pending" || status === "running")
          ) {
            yield* rearmDeferredFinalize(context);
            return;
          }
          const now = yield* DateTime.now;
          const nativeItemId = `${context.nativeThreadId}:tool:${toolCall.toolCallId}`;
          const ordinal = yield* resolveItemOrdinal(context, nativeItemId);
          const nodeId = providerNodeId(nativeItemId);
          const turnItemId = providerTurnItemId(nativeItemId);
          const nativeItemRef = {
            driver,
            nativeId: toolCall.toolCallId,
            strength: "strong" as const,
          };
          const startedAt = startedTimer
            ? now
            : (context.toolStartedAt.get(toolCall.toolCallId) ?? now);
          context.toolStartedAt.set(toolCall.toolCallId, startedAt);
          const completedAt = completedAtForStatus(status, now);
          const title = toolCall.title ?? null;
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            ...(sessionScoped ? { sessionScoped: true } : {}),
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: context.input.runId,
              parentNodeId: context.input.rootNodeId,
              rootNodeId: context.input.rootNodeId,
              kind: "tool_call",
              status: nodeStatus(status),
              countsForRun: true,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            },
          });

          const base = {
            id: turnItemId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            nodeId,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status,
            title,
            startedAt,
            completedAt,
            updatedAt: now,
          } as const;
          const rawInput = toolCall.data.rawInput;
          const rawOutput = toolCall.data.rawOutput ?? toolCall.data.content;
          const changes = structuredFileChanges(toolCall);
          const path = changes[0]?.path ?? pathFromToolCall(toolCall);
          const diffText =
            acpToolCallDiffPatch(toolCall.data.content) ?? textFromUnknown(rawOutput);
          const rawInputRecord = unknownRecord(rawInput);
          const inputVariant =
            typeof rawInputRecord?.variant === "string"
              ? rawInputRecord.variant.trim().toLowerCase()
              : "";
          const rawOutputRecord = unknownRecord(rawOutput);
          const outputCommand =
            typeof rawOutputRecord?.command === "string" &&
            rawOutputRecord.command.trim().length > 0
              ? rawOutputRecord.command.trim()
              : undefined;
          const monitorCommand =
            (typeof rawInputRecord?.command === "string" && rawInputRecord.command.trim().length > 0
              ? rawInputRecord.command.trim()
              : undefined) ?? outputCommand;
          const outputIsBashResult =
            typeof rawOutputRecord?.type === "string" &&
            rawOutputRecord.type.trim().toLowerCase() === "bash" &&
            commandExitCode(rawOutput) !== undefined;
          // Grok Monitor tools arrive as generic kind + variant; project like shell
          // so stdout is plain text in the timeline (not JSON {type:Text,text:...}).
          // Post-settle wake re-reports of a finished monitor carry no rawInput at
          // all, only a structured Bash result; project those as commands too.
          const projectAsCommandExecution = inputVariant === "monitor" || outputIsBashResult;
          // ACP has no typed MCP item, so recover MCP identity from the
          // agent-specific shape and project the same branded dynamic_tool
          // item native providers produce (e.g. the T3 orchestration tools).
          const mcpIdentity = extractMcpToolCallIdentity(toolCall, {
            embeddedTerminalCommands: embeddedTerminalCommands(
              context.nativeThreadId,
              toolCall.toolCallId,
            ),
          });
          let turnItem: OrchestrationV2TurnItem;
          if (toolCall.toolCallId.startsWith("acp-compaction:")) {
            const summary =
              (status === "failed" ? textFromUnknown(toolCall.data.compactionError) : undefined) ||
              textFromUnknown(rawOutput);
            turnItem = {
              ...base,
              type: "compaction",
              driver,
              ...(summary === undefined ? {} : { summary }),
              ...(context.contextUsage?.usedTokens === undefined
                ? {}
                : { beforeTokenCount: context.contextUsage.usedTokens }),
            };
            if (status === "completed") {
              context.contextUsage = null;
              yield* Ref.update(compactionMarkers, (current) =>
                new Map(current).set(context.nativeThreadId, Symbol()),
              );
              yield* Ref.update(contextUsageBySessionId, (current) => {
                const updated = new Map(current);
                updated.delete(context.nativeThreadId);
                return updated;
              });
            }
          } else if (mcpIdentity !== undefined) {
            const reportedName = `${mcpIdentity.server}.${mcpIdentity.tool}`;
            const reportedInput =
              mcpIdentity.input ?? unknownRecord(rawInputRecord?.arguments) ?? rawInputRecord ?? {};
            const dispatched = acpMcpDispatch(mcpIdentity, rawInput);
            const toolName = dispatched ? `t3-code.${dispatched.tool}` : reportedName;
            const input = dispatched?.input ?? reportedInput;
            let output = rawOutput === undefined ? undefined : acpMcpToolCallOutput(rawOutput);
            const t3ToolId = resolveT3McpToolId(toolName);
            const isHtmlRender = t3ToolId === HTML_RENDER_TOOL_NAME;
            if (
              t3ToolId !== null &&
              !isHtmlRender &&
              dispatched?.lookup !== true &&
              (status === "completed" || status === "failed")
            ) {
              if (dispatched) {
                const recorded =
                  previous?.data.dispatchedOutput ??
                  (yield* mcpSessions.takeToolResult(context.input.threadId, t3ToolId, input));
                if (recorded !== undefined) {
                  output = recorded;
                  context.tools.set(toolCall.toolCallId, {
                    ...toolCall,
                    data: { ...toolCall.data, dispatchedOutput: recorded },
                  });
                }
              } else if (output === undefined) {
                const previousOutput = acpMcpToolCallOutput(
                  previous?.data.rawOutput ?? previous?.data.content,
                );
                const hydrated =
                  previousOutput ??
                  (yield* mcpSessions.takeToolResult(context.input.threadId, t3ToolId, input));
                if (hydrated !== undefined) {
                  output = hydrated;
                  context.tools.set(toolCall.toolCallId, {
                    ...toolCall,
                    data: { ...toolCall.data, rawOutput: output },
                  });
                }
              } else if (previous?.status !== "completed" && previous?.status !== "failed") {
                yield* mcpSessions.takeToolResult(context.input.threadId, t3ToolId, input);
              }
            }
            const isError =
              compactDynamicToolOutput(output)?.isError === true ||
              compactDynamicToolOutput(rawOutputRecord?.result)?.isError === true;
            if (
              isHtmlRender &&
              (status === "failed" || (status === "completed" && isError)) &&
              previous?.status !== "failed" &&
              previous?.status !== "completed"
            ) {
              // A failed call may have published before the provider lost its result.
              yield* mcpSessions.takeHtmlRender(
                context.input.threadId,
                input,
                htmlRenderFromToolItem({ toolName, output }),
              );
            }
            if (status === "completed" && isHtmlRender && !isError) {
              const reportedPage = htmlRenderFromToolItem({ toolName, output });
              // Antigravity replaces MCP results with summaries, including on repeated completions.
              const previousPage = htmlRenderFromToolItem({
                toolName,
                output: acpMcpToolCallOutput(previous?.data.rawOutput ?? previous?.data.content),
              });
              const page = reportedPage
                ? yield* mcpSessions.takeHtmlRender(context.input.threadId, input, reportedPage)
                : (previousPage ??
                  (yield* mcpSessions.takeHtmlRender(context.input.threadId, input)));
              if (reportedPage === undefined && page !== undefined) {
                output = { htmlRender: page };
                context.tools.set(toolCall.toolCallId, {
                  ...toolCall,
                  data: { ...toolCall.data, rawOutput: output },
                });
              }
            }
            turnItem = {
              ...base,
              title: dispatched?.lookup ? `Look up ${dispatched.tool} schema` : null,
              ...mcpToolPresentation({
                serverName: mcpIdentity.server,
                toolName: dispatched?.tool ?? mcpIdentity.tool,
                source: unknownRecord(
                  (unknownRecord(rawOutputRecord?.result) ?? rawOutputRecord)?._meta,
                )?.source,
              }),
              type: "dynamic_tool",
              toolName,
              input,
              ...(output === undefined ? {} : { output }),
            };
            yield* emitProviderEvent({ type: "turn_item.updated", driver, turnItem });
            yield* syncOpenPromptBackgroundWait(context);
            yield* rearmDeferredFinalize(context);
            return;
          } else if (changes.length > 0) {
            turnItem = {
              ...base,
              type: "file_change",
              fileName: changes[0]!.path,
              changes,
              ...(diffText === undefined ? {} : { diffStr: diffText }),
            };
          } else {
            switch (toolCall.kind) {
              case "read":
                turnItem = {
                  ...base,
                  title: path ? formatReadToolLabel(path) : (title ?? "Read file"),
                  type: "dynamic_tool",
                  toolName: "Read",
                  ...(path !== undefined &&
                  path.length <= 4096 &&
                  !/[\r\n]/.test(path) &&
                  isWorkspaceImagePreviewPath(path)
                    ? { viewedImagePath: path }
                    : {}),
                  input:
                    path === undefined ||
                    ["path", "filePath", "file_path"].some((key) => rawInputRecord?.[key] === path)
                      ? (rawInputRecord ?? {})
                      : { ...rawInputRecord, path },
                  ...(rawOutput === undefined ? {} : { output: rawOutput }),
                };
                break;
              case "search": {
                const backendSearch = acpBackendWebSearch(
                  rawInputRecord,
                  rawOutput,
                  typeof toolCall.data.title === "string" ? toolCall.data.title : title,
                );
                if (backendSearch !== undefined) {
                  // Grok titles these "X search:" / "Web search:" awaiting the query; a raw
                  // tool name ("Running search_web") reads as a web search.
                  const wireTitle = nonEmptyText(toolCall.data.title, title ?? "Web search");
                  const label = (
                    /^\s*(?:run(?:ning)?\s+)?(?:web_search|search_web)\s*:?\s*$/iu.test(wireTitle)
                      ? "Web search"
                      : wireTitle
                  ).replace(/:\s*$/u, "");
                  turnItem = {
                    ...base,
                    title:
                      backendSearch.query === undefined
                        ? label
                        : `${label}: ${backendSearch.query}`,
                    type: "web_search",
                    ...(backendSearch.query === undefined
                      ? {}
                      : { patterns: [backendSearch.query] }),
                    ...(backendSearch.results.length === 0
                      ? {}
                      : { results: backendSearch.results }),
                  };
                  break;
                }
                const searchPreview = textFromUnknown(rawOutput);
                turnItem = {
                  ...base,
                  title:
                    formatSearchToolLabel({
                      rawInput: rawInputRecord,
                      input: rawInputRecord,
                      ...(path === undefined ? {} : { pattern: path }),
                    }) ?? title,
                  type: "file_search",
                  ...(path === undefined ? {} : { pattern: path }),
                  // A query or pattern is not a file: without output there is no result to name.
                  ...(path === undefined ||
                  (searchPreview === undefined && resolvedPathInfo(toolCall)?.fromQuery === true)
                    ? {}
                    : {
                        results: [
                          {
                            fileName: path,
                            ...(searchPreview === undefined ? {} : { preview: searchPreview }),
                          },
                        ],
                      }),
                };
                break;
              }
              case "execute": {
                const exitCode = acpProjectedCommandExitCode(status, rawOutput, toolCall.data);
                const commandTitle =
                  typeof rawInputRecord?.toolSummary === "string" &&
                  rawInputRecord.toolSummary.trim().length > 0
                    ? rawInputRecord.toolSummary.trim()
                    : title === "Ran command"
                      ? null
                      : title;
                turnItem = {
                  ...base,
                  title: commandTitle,
                  type: "command_execution",
                  input: toolCall.command ?? monitorCommand ?? "",
                  ...(status === "running" &&
                  isBackgroundCommand?.(toolCall) &&
                  (!context.promptHoldsBackgroundWork || flavor.toolOutlivesPrompt?.(toolCall))
                    ? { wakesAgent: true }
                    : {}),
                  ...(textFromUnknown(rawOutput) === undefined
                    ? {}
                    : { output: textFromUnknown(rawOutput) }),
                  ...(exitCode === undefined ? {} : { exitCode }),
                };
                break;
              }
              case "edit":
              case "delete":
              case "move":
                turnItem = {
                  ...base,
                  type: "file_change",
                  fileName: path ?? toolCall.title ?? "File change",
                  ...(diffText === undefined ? {} : { diffStr: diffText }),
                };
                break;
              case "fetch": {
                // Grok nests the page under rawOutput.Content, which textFromUnknown
                // cannot read; the (bounded) content blocks carry the same text.
                const snippet =
                  textFromUnknown(toolCall.data.content) ?? textFromUnknown(rawOutput);
                turnItem = {
                  ...base,
                  type: "web_search",
                  ...(path === undefined ? {} : { patterns: [path] }),
                  ...(path === undefined
                    ? {}
                    : {
                        results: [
                          {
                            url: path,
                            ...(snippet === undefined ? {} : { snippet }),
                          },
                        ],
                      }),
                };
                break;
              }
              default:
                if (projectAsCommandExecution) {
                  const exitCode = acpProjectedCommandExitCode(status, rawOutput, toolCall.data);
                  turnItem = {
                    ...base,
                    type: "command_execution",
                    input: toolCall.command ?? monitorCommand ?? "",
                    ...(textFromUnknown(rawOutput) === undefined
                      ? {}
                      : { output: textFromUnknown(rawOutput) }),
                    ...(exitCode === undefined ? {} : { exitCode }),
                    ...(inputVariant === "monitor" ? { monitor: true } : {}),
                  };
                } else {
                  const viewedImage = acpViewedImage(rawOutput);
                  const dataImagePath =
                    viewedImage === undefined &&
                    typeof toolCall.data.imagePath === "string" &&
                    toolCall.data.imagePath.length <= 4096 &&
                    !/[\r\n]/.test(toolCall.data.imagePath) &&
                    isWorkspaceImagePreviewPath(toolCall.data.imagePath)
                      ? toolCall.data.imagePath
                      : undefined;
                  turnItem = {
                    ...base,
                    type: "dynamic_tool",
                    toolName: acpDynamicToolName(toolCall) ?? null,
                    input: rawInput ?? {},
                    ...(viewedImage === undefined
                      ? {
                          ...(dataImagePath === undefined
                            ? {}
                            : { viewedImagePath: dataImagePath }),
                          ...(rawOutput === undefined ? {} : { output: rawOutput }),
                        }
                      : {
                          viewedImagePath: viewedImage.path,
                          ...(viewedImage.rest.length === 0 ? {} : { output: viewedImage.rest }),
                        }),
                  };
                }
            }
          }
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem,
            ...(sessionScoped ? { sessionScoped: true } : {}),
          });
          yield* syncOpenPromptBackgroundWait(context);
          yield* rearmDeferredFinalize(context);
        });

        const projectBackgroundCommand = Effect.fnUntraced(function* (
          notification: EffectAcpSchema.SessionNotification,
        ) {
          if (isBackgroundCommand === undefined) return;
          const { update, sessionId } = notification;
          if (update.sessionUpdate !== "tool_call" && update.sessionUpdate !== "tool_call_update")
            return;
          if (yield* Ref.get(stoppedRunQuarantine)) return;
          const active = yield* Ref.get(activeTurn);
          for (const event of parseSessionUpdateEvent(notification).events) {
            if (event._tag !== "ToolCallUpdated") continue;
            const id = event.toolCall.toolCallId;
            const background = backgroundCommands.get(id);
            const turn =
              background?.turn ??
              (active === null || active.finalized ? lastBackgroundCommandTurn : null);
            if (turn?.nativeThreadId !== sessionId) continue;
            const previous = turn.tools.get(id);
            if (
              background === undefined &&
              (previous?.status === "completed" || previous?.status === "failed")
            )
              continue;
            const merged = mergeToolCallState(previous, event.toolCall);
            const tool = flavor.normalizeToolCall?.(merged) ?? merged;
            if (background === undefined) {
              // ACP can announce the command and then send only its id and running status.
              if (tool.kind === "execute" && tool.status === "pending") turn.tools.set(id, tool);
              if (!isBackgroundCommand(tool)) continue;
              backgroundCommands.set(id, { turn, sessionScoped: true });
              yield* emitTool(turn, tool, undefined, true);
            } else if (tool.status === "completed" || tool.status === "failed") {
              backgroundCommands.delete(id);
              yield* emitTool(turn, tool, undefined, background.sessionScoped);
            }
          }
        });

        const endBackgroundCommands = Effect.fnUntraced(function* (
          status: "interrupted" | "failed",
        ) {
          lastBackgroundCommandTurn = null;
          for (const [id, { turn, sessionScoped }] of backgroundCommands) {
            const tool = turn.tools.get(id);
            if (tool !== undefined) yield* emitTool(turn, tool, status, sessionScoped);
          }
          backgroundCommands.clear();
        });

        /**
         * Notices have no id; each is its own item, numbered by the turn's item count.
         * A notice is not conversation content, so an open message keeps streaming across it.
         */
        const emitNotice = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          notice: { readonly title: string; readonly description?: string },
        ) {
          const nativeItemId = `${context.nativeTurnId}:notice:${context.itemOrdinals.size}`;
          const now = yield* DateTime.now;
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: providerTurnItemId(nativeItemId),
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId: context.input.rootNodeId,
              providerThreadId: context.input.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: { driver, nativeId: nativeItemId, strength: "weak" },
              parentItemId: null,
              ordinal: yield* resolveItemOrdinal(context, nativeItemId),
              type: "system_notice",
              status: "completed",
              title: notice.title,
              message:
                notice.description === undefined
                  ? notice.title
                  : `${notice.title}\n\n${notice.description}`,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          });
        });

        const emitPlan = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          update: AcpPlanUpdate,
          sessionScoped: boolean,
        ) {
          yield* closeTextStreams(context);
          let plans = sessionScoped ? plansBySessionId.get(context.nativeThreadId) : context.plans;
          if (plans === undefined) {
            plans = new Map();
            plansBySessionId.set(context.nativeThreadId, plans);
          }
          const existing = plans.get(update.nativePlanId);
          if (update.kind === "removed" && existing === undefined) return;
          const now = yield* DateTime.now;
          let planState = existing;
          if (planState === undefined) {
            const nativeItemId = `${context.nativeTurnId}:plan:${encodeURIComponent(update.nativePlanId)}`;
            planState = {
              id: yield* idAllocator.allocate.plan({
                threadId: context.input.threadId,
                runId: context.input.runId,
                driver,
              }),
              startedAt: now,
              origin: {
                runId: context.input.runId,
                rootNodeId: context.input.rootNodeId,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemId,
                ordinal: yield* resolveItemOrdinal(context, nativeItemId),
              },
              latest: null,
            };
          }
          const { origin } = planState;
          const nodeId = providerNodeId(origin.nativeItemId);
          const turnItemId = providerTurnItemId(origin.nativeItemId);
          const planId = planState.id;
          const nativeItemRef = {
            driver,
            nativeId: origin.nativeItemId,
            strength: "weak" as const,
          };
          const base = {
            id: planId,
            threadId: context.input.threadId,
            runId: origin.runId,
            nodeId,
          } as const;
          let plan: OrchestrationV2PlanArtifact;
          if (update.kind === "removed") {
            if (planState.latest === null) return;
            plan = { ...planState.latest, status: "superseded" };
          } else if (update.kind === "items") {
            const steps: ReadonlyArray<OrchestrationV2PlanStep> = update.plan.flatMap(
              (step, index) =>
                step.status === "cancelled"
                  ? []
                  : [
                      {
                        id: `acp-step-${index + 1}`,
                        text: nonEmptyText(step.step, `Step ${index + 1}`),
                        status:
                          step.status === "inProgress"
                            ? "running"
                            : step.status === "completed"
                              ? "completed"
                              : "pending",
                      },
                    ],
            );
            const completed =
              update.plan.length > 0 && steps.every((step) => step.status === "completed");
            plan = {
              ...base,
              status: completed ? "completed" : "active",
              kind: "todo_list",
              steps,
              ...(update.explanation == null ? {} : { explanation: update.explanation }),
            };
          } else {
            const markdown =
              update.kind === "markdown"
                ? update.markdown
                : update.kind === "file"
                  ? `Plan file: ${update.uri}`
                  : `[Unsupported ACP plan content: ${update.contentType}]`;
            plan = {
              ...base,
              status: "active",
              kind: "proposed_plan",
              markdown,
            };
          }
          planState.latest = plan;
          plans.set(update.nativePlanId, planState);
          const completed =
            plan.status === "completed" ||
            plan.status === "superseded" ||
            (plan.kind === "todo_list" && flavor.todoListUpdatesAreSnapshots === true);
          const nodeKind = plan.kind === "todo_list" ? "todo_list" : "plan";
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: nodeId,
              threadId: context.input.threadId,
              runId: origin.runId,
              parentNodeId: origin.rootNodeId,
              rootNodeId: origin.rootNodeId,
              kind: nodeKind,
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: origin.providerThreadId,
              providerTurnId: origin.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: planState.startedAt,
              completedAt: completed ? now : null,
            },
          });
          yield* emitProviderEvent({ type: "plan.updated", driver, plan });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: turnItemId,
              threadId: context.input.threadId,
              runId: origin.runId,
              nodeId,
              providerThreadId: origin.providerThreadId,
              providerTurnId: origin.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: origin.ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt: planState.startedAt,
              completedAt: completed ? now : null,
              updatedAt: now,
              ...(plan.kind === "todo_list"
                ? {
                    type: "todo_list" as const,
                    planId,
                    steps: plan.steps,
                    ...(plan.explanation === undefined ? {} : { explanation: plan.explanation }),
                  }
                : {
                    type: "proposed_plan" as const,
                    planId,
                    markdown: plan.markdown,
                    streaming: !completed,
                  }),
            },
          });
        });

        const appendLoadedHistory = (
          notification: EffectAcpSchema.SessionNotification,
          role: "user" | "assistant" | "thought",
          text: string,
          replace = false,
        ) =>
          Effect.gen(function* () {
            if (text.length === 0 && !replace) return;
            const now = yield* DateTime.now;
            yield* Ref.update(snapshot, (current) => {
              const update = notification.update;
              const sourceMessageId =
                (update.sessionUpdate === "user_message_chunk" ||
                  update.sessionUpdate === "agent_message_chunk" ||
                  update.sessionUpdate === "agent_thought_chunk" ||
                  update.sessionUpdate === "user_message" ||
                  update.sessionUpdate === "agent_message" ||
                  update.sessionUpdate === "agent_thought") &&
                update.messageId
                  ? update.messageId
                  : null;
              const startsNew =
                current.loadingRole !== role ||
                (sourceMessageId !== null && current.loadingMessageId !== sourceMessageId);
              const loadingIndex = startsNew ? current.loadingIndex + 1 : current.loadingIndex;
              const nativeItemId =
                sourceMessageId === null
                  ? `${notification.sessionId}:history:${role}:${loadingIndex}`
                  : `${notification.sessionId}:history:${role}:message:${sourceMessageId}`;
              const messageId = providerMessageId(nativeItemId);
              const key = String(messageId);
              const previous = current.messages.get(key);
              if (previous === undefined) current.order.push(key);
              current.messages.set(key, {
                createdBy: previous?.createdBy ?? (role === "user" ? "user" : "agent"),
                creationSource: previous?.creationSource ?? "provider",
                id: messageId,
                threadId: input.threadId,
                runId: null,
                nodeId: null,
                role: role === "user" ? "user" : "assistant",
                text: replace ? text : `${previous?.text ?? ""}${text}`,
                attachments: [],
                streaming: false,
                createdAt: previous?.createdAt ?? now,
                updatedAt: now,
              });
              return {
                ...current,
                reasoningIds:
                  role === "thought" && !current.reasoningIds.has(messageId)
                    ? new Set(current.reasoningIds).add(messageId)
                    : current.reasoningIds,
                loadingRole: role,
                loadingMessageId: sourceMessageId ?? (startsNew ? null : current.loadingMessageId),
                loadingIndex,
              };
            });
          });

        const offerContinuationRun = Effect.fnUntraced(function* (_sessionId: string) {
          if (continuationRequests === undefined) {
            return false;
          }
          const pending = yield* continuationPermit.withPermit(
            Effect.gen(function* () {
              if (yield* Ref.get(continuationClosed)) return Option.none();
              if (yield* Ref.get(stoppedRunQuarantine)) return Option.none();
              if (yield* Ref.get(continuationRequested)) return Option.none();
              const route = yield* Ref.get(lastTurnRoute);
              if (route === null) return Option.none();
              yield* Ref.set(continuationRequested, true);
              const generation = yield* Ref.updateAndGet(
                continuationGeneration,
                (value) => value + 1,
              );
              const reports = yield* Ref.modify(wakeReports, ({ reports }) => [
                reports,
                { reports, offered: new Set(reports.keys()) },
              ]);
              return Option.some({ route, generation, reports });
            }),
          );
          if (Option.isNone(pending)) return false;
          const { route, generation, reports } = pending.value;
          const notification = backgroundWorkNotification([...reports.values()]);
          yield* Effect.logInfo("orchestration-v2.acp-wake-turn-detected", {
            driver,
            providerSessionId: input.providerSessionId,
            threadId: route.threadId,
            providerThreadId: route.providerThreadId,
          });
          yield* continuationRequests.offer({
            threadId: route.threadId,
            providerThreadId: route.providerThreadId,
            driver,
            detail: null,
            ...(notification === null ? {} : { notification }),
            clearIfCurrent: () =>
              continuationPermit.withPermit(
                Effect.gen(function* () {
                  if ((yield* Ref.get(continuationGeneration)) === generation) {
                    yield* Ref.set(continuationRequested, false);
                  }
                }),
              ),
            dispatchIfCurrent: (effect) =>
              continuationPermit.withPermit(
                Effect.gen(function* () {
                  const clearIfOwner = Effect.gen(function* () {
                    if ((yield* Ref.get(continuationGeneration)) === generation) {
                      yield* Ref.set(continuationRequested, false);
                    }
                  });
                  if (yield* Ref.get(stoppedRunQuarantine)) {
                    yield* clearIfOwner;
                    return Option.none();
                  }
                  if ((yield* Ref.get(continuationGeneration)) !== generation) {
                    // Superseded by a newer offer; do not clear its flag.
                    return Option.none();
                  }
                  if (!(yield* Ref.get(continuationRequested))) return Option.none();
                  // A successful durable dispatch owns the sticky flag until its
                  // continuation turn starts. Clearing here opens a dispatch-to-
                  // start race where every late ACP frame can enqueue another
                  // synthetic continuation. Failures clear immediately because
                  // no turn will arrive to do so.
                  const exit = yield* Effect.exit(effect);
                  if (Exit.isFailure(exit)) {
                    yield* clearIfOwner;
                    return yield* Effect.failCause(exit.cause);
                  }
                  return Option.some(exit.value);
                }),
              ),
          });
          return true;
        });

        const applyLateBackgroundMutation = Effect.fnUntraced(function* (
          sessionId: string,
          mutation: {
            readonly taskId: string;
            readonly status: "running" | "completed" | "failed";
          },
        ) {
          const taskAlreadyEnded = (yield* Ref.get(endedBackgroundTaskIds)).has(mutation.taskId);
          yield* applyBackgroundTaskMutationRunning(mutation);
          if (mutation.status === "running") {
            // Straggler running notice after a genuine end: suppress residual
            // monitor-prompt agent chatter so it cannot open a synthetic wake.
            if (taskAlreadyEnded && acpPostSettleMonitorPromptShouldSuppress(mutation)) {
              yield* Ref.set(suppressPostSettleMonitorPrompt, true);
            }
            return;
          }
          // First genuine terminal: allow subsequent agent output. Re-delivery
          // of an already-ended terminal must not un-suppress residual ack
          // chatter from the injected monitor-event turn.
          if (!taskAlreadyEnded) {
            yield* Ref.set(suppressPostSettleMonitorPrompt, false);
          }
          // Keep handledBackgroundTaskIdsInActiveTurn intact. Erasing the mark
          // on a late monitor-event mutation defeated the in-turn chatter guard
          // and let injected-turn acks arm wakeBuffer for a later spurious
          // "Background task completed." run (multiturn live repro). Monitors
          // the agent settled without reporting never enter that set, so their
          // injected report still streams via pendingInjectedReport / hold.
          const activeContext = yield* Ref.get(activeTurn);
          // Completions that land while a root turn is still streaming are
          // owned by in-turn machinery (emitTool handled marks, deferred
          // finalize, injected-report hold). Do not open a synthetic wake mid-
          // turn; finalizeTurn re-checks wakeBuffer / midTurnUnreported once
          // the turn leaves the active slot so legitimate unhandled evidence
          // still offers after finalize.
          if (activeContext !== null && !activeContext.finalized) {
            const handled = yield* Ref.get(handledBackgroundTaskIdsInActiveTurn);
            // Only arm deferred wake when this turn registered the task (monitor
            // tool started in-turn) and the root prompt is still open. Completions
            // that land in the settled-held window (promptSettled, deferred
            // finalize holding for injected report) fall back to the pre-existing
            // post-finalize injected-turn path; arming here would spuriously
            // offer "Background task completed." after the report streams into
            // the held turn. Residual cancel-backgrounded completions from a
            // prior interrupt must not open a synthetic continuation.
            if (
              !activeContext.promptSettled &&
              !handled.has(mutation.taskId) &&
              activeContext.toolCallIdsByBackgroundTaskId.has(mutation.taskId)
            ) {
              yield* Ref.update(midTurnUnreportedCompletedTaskIds, (current) =>
                new Set(current).add(mutation.taskId),
              );
            }
            return;
          }
          if (
            postSettleContinuationEnabled &&
            (yield* Ref.get(activeSessionId)) === sessionId &&
            (yield* Ref.get(runningBackgroundTaskIds)).size === 0 &&
            ((yield* Ref.get(wakeBuffer)).length > 0 ||
              (yield* Ref.get(midTurnUnreportedCompletedTaskIds)).size > 0)
          ) {
            yield* offerContinuationRun(sessionId);
          }
        });

        // A structured task end (Grok `task_completed`) is authoritative for the
        // tool that registered the task: its own updates only ever say running.
        // Finish the row while deferred finalize holds a settled root turn open
        // for it, so the turn can settle. While the prompt is still open the
        // agent reports the end itself (TaskOutput hydration), and an unreported
        // end must keep its post-finalize continuation offer, so the end waits
        // for the prompt to settle (finishBackgroundToolsEndedBeforeSettle).
        const finishRegisteredBackgroundTool = Effect.fnUntraced(function* (mutation: {
          readonly taskId: string;
          readonly status: "completed" | "failed";
          readonly output?: string;
        }) {
          const context = yield* Ref.get(activeTurn);
          if (context === null || context.finalized) return;
          if (!context.promptSettled) {
            context.backgroundTaskEndsBeforeSettle.set(mutation.taskId, {
              status: mutation.status,
              ...(mutation.output === undefined ? {} : { output: mutation.output }),
            });
            return;
          }
          const toolCallId = context.toolCallIdsByBackgroundTaskId.get(mutation.taskId);
          const tool = toolCallId === undefined ? undefined : context.tools.get(toolCallId);
          if (tool === undefined) return;
          const status = toolStatus(tool.status);
          context.awaitingBackgroundHydration.delete(mutation.taskId);
          if (status === "completed" || status === "failed") {
            // Its own update already ended it; keep it ended, and recheck
            // finalize in case the hydration hold just cleared was the last.
            context.endedBackgroundToolStatus.set(tool.toolCallId, status);
            yield* rearmDeferredFinalize(context);
            return;
          }
          if (status !== "pending" && status !== "running") return;
          // Replace the start envelope even when the end carries no output:
          // normalizeToolCall keeps a row holding one running.
          const finished = setToolOutputText(
            { ...tool, status: mutation.status },
            mutation.output ?? toolOutputText(tool),
          );
          context.endedBackgroundToolStatus.set(tool.toolCallId, mutation.status);
          yield* emitTool(context, finished, mutation.status);
          yield* rearmDeferredFinalize(context);
        });

        // Rows the agent never reported on before the prompt settled. Run after
        // promptSettled is set: finishing them earlier would mark the tasks
        // handled in-turn and drop their wake offer.
        const finishBackgroundToolsEndedBeforeSettle = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
        ) {
          if ((yield* Ref.get(activeTurn)) !== context) return;
          const ends = [...context.backgroundTaskEndsBeforeSettle];
          context.backgroundTaskEndsBeforeSettle.clear();
          for (const [taskId, end] of ends) {
            yield* finishRegisteredBackgroundTool({ taskId, ...end });
          }
        });

        const bufferPostSettleWake = Effect.fnUntraced(function* (
          notification: EffectAcpSchema.SessionNotification,
          settledTimerEnded = false,
        ) {
          if (!postSettleContinuationEnabled || continuationRequests === undefined) {
            return {
              buffered: false,
              offerContinuation: false,
              stopProcessing: false,
            };
          }
          // Direct Stop quarantine: drop residual wake evidence instead of
          // buffering it for a later continuation or follow-up run.
          if (yield* Ref.get(stoppedRunQuarantine)) {
            return {
              buffered: false,
              offerContinuation: false,
              stopProcessing: true,
            };
          }
          const rootSessionId = yield* Ref.get(activeSessionId);
          if (rootSessionId === null || notification.sessionId !== rootSessionId) {
            return {
              buffered: false,
              offerContinuation: false,
              stopProcessing: false,
            };
          }
          if (!acpPostSettleWakeEvidence(notification, flavor)) {
            return {
              buffered: false,
              offerContinuation: false,
              stopProcessing: false,
            };
          }
          const update = notification.update;
          let alreadyHandledToolUpdate = false;
          if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            yield* trackRunningBackgroundTools(notification);
            // When the agent consumes the monitor output itself via
            // get_command_or_subagent_output (long timeout), the TaskOutput
            // completion is the ONLY end signal: no "Monitor ended" reminder
            // follows. Without applying it here the running set never clears,
            // every offer stays suppressed, and the wake buffer never drains
            // (observed live 2026-07-12, thread 8dbe607f). The completion
            // frame itself is offer evidence, so clearing the id before the
            // gate below lets it open the single continuation run.
            for (const event of parseSessionUpdateEvent(notification).events) {
              if (event._tag !== "ToolCallUpdated") continue;
              const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
              const proposedPlanMarkdown = flavor.extractProposedPlanMarkdown?.(toolCall);
              if (proposedPlanMarkdown !== undefined && proposedPlanMarkdown.length > 0) {
                yield* captureProposedPlan({ planMarkdown: proposedPlanMarkdown });
              }
              const toolTaskId = flavor.extractBackgroundTaskId?.(toolCall);
              if (
                toolTaskId !== undefined &&
                (yield* Ref.get(handledBackgroundTaskIdsInActiveTurn)).has(toolTaskId)
              ) {
                alreadyHandledToolUpdate = true;
              }
              if (flavor.extractBackgroundTaskCompletion !== undefined) {
                for (const completion of flavor.extractBackgroundTaskCompletion(toolCall)) {
                  alreadyHandledToolUpdate =
                    alreadyHandledToolUpdate ||
                    (yield* Ref.get(handledBackgroundTaskIdsInActiveTurn)).has(completion.taskId);
                  yield* applyBackgroundTaskMutationRunning(completion);
                }
              }
            }
          }
          const backgroundWorkRunning = (yield* Ref.get(runningBackgroundTaskIds)).size > 0;
          // Residual Grok agent/thought chatter after in-turn-handled background
          // work must not be retained as wake evidence. Tool-path alreadyHandled
          // covers re-reports with a task id; this covers agent_message_chunk /
          // agent_thought_chunk frames that carry no task id (live:
          // grok-in-turn-monitor-no-wake, multiturn stale-buffer arm). Check
          // before buffering so the frames cannot dirty wakeBuffer and later
          // arm a mid-turn offer when a second monitor completes.
          const handledInTurnCount = (yield* Ref.get(handledBackgroundTaskIdsInActiveTurn)).size;
          const isInTurnHandledAgentChatter =
            handledInTurnCount > 0 &&
            (update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "agent_thought_chunk");
          // Grok prompts itself for every monitor event after the root turn
          // settles. Its assistant/reasoning replies are progress chatter, not
          // separate wake results. Retaining them would replay the entire burst
          // into the single continuation once the monitor finishes. Keep tool
          // state so the final command card still hydrates, then begin retaining
          // agent output again after the genuine end signal clears the running
          // set. With multiple tasks, text remains best-effort until every task
          // ends; their retained tool cards are the authoritative results.
          //
          // Skip retaining frames for tasks already hydrated in the root turn
          // (`handledBackgroundTaskIdsInActiveTurn`). Those re-reports must not
          // pin `hasPendingBackgroundWork` via a wake buffer that never drains
          // (the already-handled gate below intentionally skips
          // `offerContinuationRun` to avoid synthetic "Background task
          // completed." spam).
          let buffered = false;
          if (
            !alreadyHandledToolUpdate &&
            !isInTurnHandledAgentChatter &&
            !settledTimerEnded &&
            acpPostSettleWakeShouldBuffer(notification, backgroundWorkRunning)
          ) {
            yield* Ref.update(wakeBuffer, (current) => [...current, notification]);
            buffered = true;
          }
          // Buffer progress without offering; only completion-like frames open a run.
          if (!acpPostSettleContinuationOfferEvidence(notification, flavor)) {
            return {
              buffered,
              offerContinuation: false,
              stopProcessing: true,
            };
          }
          // While a monitor is still streaming, tool re-reports buffer without
          // offering and per-event agent commentary is consumed without being
          // retained. Grok re-reports a running monitor as Bash frames that
          // already carry exit_code 0 mid-stream, so a "terminal" normalized
          // status is not evidence the task ended; each burst would otherwise
          // reopen a synthetic "Background task completed." run. Retained tool
          // frames drain into the single continuation offered once the monitor
          // actually ends (end-notice mutation below, or the first frame after
          // it).
          if (backgroundWorkRunning) {
            return {
              buffered,
              offerContinuation: false,
              stopProcessing: true,
            };
          }
          if (alreadyHandledToolUpdate) {
            // Drop leftover wake noise for in-turn-handled work so idle release
            // is not pinned forever. Leave the buffer alone when a continuation
            // is already outstanding: its startTurn will drain legitimate frames
            // from other tasks.
            if (!(yield* Ref.get(continuationRequested))) {
              yield* Ref.set(wakeBuffer, []);
            }
            return {
              buffered,
              offerContinuation: false,
              stopProcessing: true,
            };
          }
          // Same in-turn-handled agent chatter: do not open a synthetic wake.
          // Do not clear wakeBuffer here: frames for other still-tracked tasks
          // must remain drainable when a real (tool) completion later offers.
          if (isInTurnHandledAgentChatter) {
            return {
              buffered,
              offerContinuation: false,
              stopProcessing: true,
            };
          }
          return {
            buffered,
            offerContinuation: true,
            stopProcessing: true,
          };
        });

        let applyFinalizedActiveTurnSubagentTerminal: (
          context: ActiveAcpTurn,
          notification: EffectAcpSchema.SessionNotification,
        ) => Effect.Effect<boolean> = () => Effect.succeed(false);

        const projectAgentTerminalUpdate = Effect.fnUntraced(function* (
          notification: EffectAcpSchema.SessionNotification,
          context: ActiveAcpTurn | null,
        ) {
          const update = notification.update;
          if (
            update.sessionUpdate !== "terminal_update" &&
            update.sessionUpdate !== "terminal_output_chunk"
          ) {
            return false;
          }
          const terminalKey = sessionScopedId(notification.sessionId, update.terminalId);
          const next = applyAcpAgentTerminalUpdate(agentTerminalsById.get(terminalKey), update);
          agentTerminalsById.set(terminalKey, next);
          if (context === null || notification.sessionId !== context.nativeThreadId) return true;
          const status =
            next.exitStatus === undefined
              ? ("inProgress" as const)
              : next.exitStatus.exitCode === 0
                ? ("completed" as const)
                : ("failed" as const);
          const embeddedToolCallIds = toolCallIdsByAgentTerminalId.get(terminalKey);
          const linked = embeddedToolCallIds !== undefined && embeddedToolCallIds.size > 0;
          const projectedToolCallIds = linked
            ? [...embeddedToolCallIds]
            : [`acp-agent-terminal:${update.terminalId}`];
          const output = next.output.slice(-MAX_AGENT_TERMINAL_OUTPUT_CHARS);
          for (const toolCallId of projectedToolCallIds) {
            const existing = context.tools.get(toolCallId);
            const seeded: AcpToolCallState =
              existing ??
              ({
                toolCallId,
                kind: "execute",
                title: next.command ?? "Terminal",
                status,
                ...(next.command === undefined ? {} : { command: next.command }),
                data: { toolCallId },
              } satisfies AcpToolCallState);
            yield* emitTool(
              context,
              setToolOutputText(
                {
                  ...seeded,
                  // An agent-reported tool owns its status; terminal state only drives the synthetic one.
                  status: (linked ? existing?.status : undefined) ?? status,
                  ...(next.command === undefined ? {} : { command: next.command }),
                },
                output,
              ),
            );
          }
          return true;
        });

        const embeddedClientTerminalOutput = (sessionId: string, toolCallId: string) => {
          const terminals = embeddedTerminalsByToolCallId.get(
            sessionScopedId(sessionId, toolCallId),
          );
          const snapshots = (terminals?.terminalIds ?? []).flatMap((id) => {
            const snapshot = clientTerminals?.readOutputSnapshot(sessionId, id, 32_000);
            return snapshot === undefined
              ? []
              : [
                  snapshot.truncated
                    ? `[Earlier output truncated]\n\n${snapshot.output}`
                    : snapshot.output,
                ];
          });
          return snapshots.length === 0 ? undefined : boundToolCallOutputText(snapshots.join("\n"));
        };

        const projectClientTerminalOutput = Effect.fnUntraced(function* (
          sessionId: string,
          terminalId: string,
        ) {
          const context = yield* Ref.get(activeTurn);
          if (context === null || context.finalized || context.nativeThreadId !== sessionId) return;
          const toolCallIds = toolCallIdsByAgentTerminalId.get(
            sessionScopedId(sessionId, terminalId),
          );
          if (toolCallIds === undefined) return;
          for (const toolCallId of toolCallIds) {
            const toolCall = context.tools.get(toolCallId);
            if (
              toolCall === undefined ||
              toolCall.status === "completed" ||
              toolCall.status === "failed"
            )
              continue;
            const output = embeddedClientTerminalOutput(sessionId, toolCallId);
            if (output === undefined || toolOutputText(toolCall) === output) continue;
            yield* emitTool(context, setToolOutputText(toolCall, output));
          }
        });

        /**
         * `wakeOnDetachedRequest`: a request the agent sends after its prompt ended offers a
         * continuation run and waits for a turn to attach, so it is answered inside that turn.
         * Resolves false when the run is stopped instead.
         */
        const awaitRequestTurn = Effect.fnUntraced(function* (generation: number) {
          if (!(postSettleContinuationEnabled && flavor.wakeOnDetachedRequest)) return true;
          while (true) {
            const waiting = yield* runRuntimeCallbackAtGeneration(
              generation,
              Effect.gen(function* () {
                if (yield* Ref.get(stoppedRunQuarantine)) return false;
                if ((yield* Ref.get(activeTurn)) !== null) return null;
                const sessionId = yield* Ref.get(activeSessionId);
                if (sessionId !== null) yield* offerContinuationRun(sessionId);
                return turnAttached;
              }),
            );
            if (Option.isNone(waiting)) return yield* Effect.never;
            if (waiting.value === false) return false;
            if (waiting.value === null) return true;
            if (!(yield* Deferred.await(waiting.value))) return false;
          }
        });

        /** Holds the turn open while an agent request waits, and rearms its finalize after. */
        const holdingAgentRequest =
          (generation: number) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            !(postSettleContinuationEnabled && flavor.wakeOnDetachedRequest)
              ? effect
              : Effect.acquireUseRelease(
                  runRuntimeCallbackAtGeneration(
                    generation,
                    Effect.sync(() => {
                      const token = {};
                      heldAgentRequests.add(token);
                      return token;
                    }),
                  ),
                  (token) => (Option.isNone(token) ? Effect.never : effect),
                  (token) =>
                    runRuntimeCallbackAtGeneration(
                      generation,
                      Effect.gen(function* () {
                        if (Option.isSome(token)) heldAgentRequests.delete(token.value);
                        const context = yield* Ref.get(activeTurn);
                        if (context === null) return;
                        // The agent goes on with its reply once the request is answered.
                        if (flavor.replyEndsWithUsageUpdate === true) context.replyOpen = true;
                        yield* syncOpenPromptBackgroundWait(context);
                        yield* rearmDeferredFinalize(context);
                      }),
                    ).pipe(Effect.asVoid),
                );

        const publishSessionState = Effect.fnUntraced(function* (
          sessionId: string,
          context: ActiveAcpTurn | null,
          isUsage: boolean,
        ) {
          const knownProviderThread = (yield* Ref.get(providerThreadByNativeSessionId)).get(
            sessionId,
          );
          if (knownProviderThread !== undefined) {
            const now = yield* DateTime.now;
            const providerThread: OrchestrationV2ProviderThread = {
              ...knownProviderThread,
              contextUsage:
                (yield* Ref.get(contextUsageBySessionId)).get(sessionId) ??
                knownProviderThread.contextUsage ??
                null,
              nativeMetadata:
                (yield* Ref.get(nativeMetadataBySessionId)).get(sessionId) ??
                knownProviderThread.nativeMetadata ??
                null,
              updatedAt: now,
            };
            yield* Ref.update(providerThreadByNativeSessionId, (current) =>
              new Map(current).set(sessionId, providerThread),
            );
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver,
              providerThread,
              ...(isUsage && (context?.nativeThreadId !== sessionId || context.finalized)
                ? { sessionScoped: true as const }
                : {}),
            });
          }
        });

        const observeContextUsage = Effect.fnUntraced(function* (
          sessionId: string,
          source: Pick<EffectAcpSchema.SessionNotification, "_meta">,
          context: ActiveAcpTurn | null,
        ) {
          if (!flavor.extractContextUsage) return;
          const setup =
            sessionId === (yield* Ref.get(activeSessionId))
              ? yield* Ref.get(activeSessionSetup)
              : null;
          const reported = flavor.extractContextUsage(source, setup);
          if (reported !== undefined) {
            const previous = (yield* Ref.get(contextUsageBySessionId)).get(sessionId);
            const usage = { ...previous, ...reported };
            if (!Equal.equals(previous, usage)) {
              yield* Ref.update(contextUsageBySessionId, (current) =>
                new Map(current).set(sessionId, usage),
              );
              if (context?.nativeThreadId === sessionId) context.contextUsage = usage;
              if ((yield* Ref.get(loadingSessionId)) !== sessionId) {
                yield* publishSessionState(sessionId, context, true);
              }
            }
          }
        });

        const handleSessionUpdate = Effect.fnUntraced(function* (
          notification: EffectAcpSchema.SessionNotification,
        ) {
          const context = yield* Ref.get(activeTurn);
          const update = notification.update;
          if (flavor.extractContextUsage && update.sessionUpdate !== "usage_update") {
            yield* observeContextUsage(notification.sessionId, notification, context);
          }
          if (yield* projectAgentTerminalUpdate(notification, context)) return;
          let settledTimerEnded = false;
          if (
            reportsBackgroundWait &&
            (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
            (update.status === "completed" || update.status === "failed")
          ) {
            const owner = settledPersistentTasks.get(update.toolCallId);
            if (owner?.nativeThreadId === notification.sessionId) {
              const event = parseSessionUpdateEvent(notification).events.find(
                (candidate) => candidate._tag === "ToolCallUpdated",
              );
              if (event !== undefined) {
                settledPersistentTasks.delete(update.toolCallId);
                yield* emitTool(owner, event.toolCall, undefined, true);
                // An attached run already owns the wake's new output.
                if (context !== null && !context.finalized) return;
                settledTimerEnded = true;
              }
            }
          }
          if (
            flavor.reportsPerTurnPromptUsage === true &&
            context !== null &&
            !context.finalized &&
            context.nativeThreadId === notification.sessionId &&
            !sessionUpdateIsReplay(notification)
          ) {
            if (
              update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update" ||
              ((update.sessionUpdate === "agent_thought_chunk" ||
                update.sessionUpdate === "agent_thought") &&
                acpRootSessionUpdateIngestsOutput(notification))
            ) {
              context.generationRequiresEndToEnd = true;
            } else if (
              update.sessionUpdate === "agent_message_chunk" &&
              acpRootSessionUpdateIngestsOutput(notification)
            ) {
              markGenerationOutput(context.generation, yield* DateTime.now);
            }
          }
          if (flavor.replyEndsWithUsageUpdate === true) {
            if (context === null) {
              // A reply can end before its continuation run starts; replay its end with its output.
              if (
                update.sessionUpdate === "usage_update" &&
                (yield* Ref.get(wakeBuffer)).length > 0
              ) {
                yield* Ref.update(wakeBuffer, (current) => [...current, notification]);
              }
            } else if (context.nativeThreadId === notification.sessionId) {
              if (update.sessionUpdate === "usage_update") {
                // Usage follows every model step. A step of thinking and tool calls leads to the
                // next one; only a step that ended in assistant text ends the reply.
                if (context.replyLastOutputWasText) {
                  context.replyOpen = false;
                  if (context.promptSettled) yield* idleReportedSubagents(context);
                  if (context.wakeReplyBeforePrompt) {
                    context.wakeReplyBeforePrompt = false;
                    yield* closeTextStreams(context);
                  }
                }
                yield* rearmDeferredFinalize(context);
              } else if (
                (!context.promptHoldsBackgroundWork ||
                  (update.sessionUpdate !== "tool_call" &&
                    update.sessionUpdate !== "tool_call_update")) &&
                acpRootSessionUpdateIngestsOutput(notification)
              ) {
                context.replyOpen = true;
                context.replyLastOutputWasText =
                  update.sessionUpdate === "agent_message_chunk" ||
                  update.sessionUpdate === "agent_message";
                yield* syncOpenPromptBackgroundWait(context);
              }
            }
          }
          if (
            update.sessionUpdate === "usage_update" ||
            update.sessionUpdate === "session_info_update"
          ) {
            const stateEvent = parseSessionUpdateEvent(notification).events.find(
              (event) => event._tag === "UsageUpdated" || event._tag === "SessionInfoUpdated",
            );
            if (stateEvent === undefined) return;
            if (stateEvent._tag === "UsageUpdated") {
              yield* Ref.update(contextUsageBySessionId, (current) =>
                new Map(current).set(notification.sessionId, stateEvent.usage),
              );
              if (context?.nativeThreadId === notification.sessionId) {
                context.contextUsage = stateEvent.usage;
                if (!context.finalized && stateEvent.usage.usedTokens > 0) {
                  if (
                    update.sessionUpdate === "usage_update" &&
                    flavor.extractStepUsage &&
                    !sessionUpdateIsReplay(notification) &&
                    (yield* Ref.get(loadingSessionId)) !== notification.sessionId
                  ) {
                    context.promptUsage = addAcpUsage(
                      context.promptUsage,
                      flavor.extractStepUsage(update),
                    );
                  }
                  const usageAt = yield* DateTime.now;
                  context.turnTokenUsage = {
                    usedTokens: Math.max(0, Math.round(stateEvent.usage.usedTokens)),
                    ...(stateEvent.usage.maxTokens == null
                      ? {}
                      : { maxTokens: Math.max(0, Math.round(stateEvent.usage.maxTokens)) }),
                    updatedAt: DateTime.formatIso(usageAt),
                  };
                  const runningTurn = providerTurnPayload(context, "running", null);
                  yield* emitProviderEvent({
                    type: "provider_turn.updated",
                    driver,
                    threadId: context.input.threadId,
                    providerTurn: runningTurn,
                  });
                }
              }
            } else {
              const metadata = yield* Ref.modify(nativeMetadataBySessionId, (current) => {
                const merged = {
                  ...current.get(notification.sessionId),
                  ...stateEvent.metadata,
                };
                return [merged, new Map(current).set(notification.sessionId, merged)] as const;
              });
              if (context?.nativeThreadId === notification.sessionId) {
                context.nativeMetadata = metadata;
              }
            }
            yield* publishSessionState(
              notification.sessionId,
              context,
              stateEvent._tag === "UsageUpdated",
            );
            if (
              update.sessionUpdate === "usage_update" &&
              context?.nativeThreadId === notification.sessionId
            ) {
              yield* syncOpenPromptBackgroundWait(context);
            }
            return;
          }
          if (
            context?.finalized === true &&
            (yield* applyFinalizedActiveTurnSubagentTerminal(context, notification))
          ) {
            return;
          }
          // Only while a finalized turn is still the active context. When
          // activeTurn is null, post-settle agent frames must reach
          // bufferPostSettleWake so continuation can attach (context?.finalized
          // !== false incorrectly treated null as finalized and dropped them).
          if (
            context !== null &&
            context.finalized &&
            (yield* Ref.get(handledBackgroundTaskIdsInActiveTurn)).size > 0 &&
            (update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "agent_thought_chunk")
          ) {
            yield* Ref.set(suppressPostSettleMonitorPrompt, true);
            return;
          }
          if (
            context !== null &&
            (yield* Ref.get(suppressPostSettleMonitorPrompt)) &&
            (update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "agent_thought_chunk")
          ) {
            return;
          }
          if (
            context?.finalized === true &&
            update.sessionUpdate === "user_message_chunk" &&
            update.content.type === "text"
          ) {
            const mutations = flavor.extractBackgroundToolMutation?.(update.content.text) ?? [];
            for (const mutation of mutations) {
              yield* applyLateBackgroundMutation(notification.sessionId, mutation);
            }
            return;
          }
          if (context === null) {
            // Direct Stop: quarantine residual events from the stopped run so
            // they cannot become history, wake buffers, or a later run attach.
            if (yield* Ref.get(stoppedRunQuarantine)) {
              return;
            }
            const bufferOutcome = yield* bufferPostSettleWake(notification, settledTimerEnded);
            // Post-settle carryover sync: keep in-memory carryover accurate so
            // hasPendingBackgroundWork reasons correctly after root settle.
            // A completed root keeps its subscriber open while background items
            // remain, so project its terminals immediately even when the wake
            // frame is buffered for a continuation. Non-completed roots stay
            // memory-only: durable ingest requires a subscriber that owns the
            // original runId, which the interrupted path does not guarantee.
            const carryover = yield* Ref.get(carryoverSubagents);
            const rootTerminalCanStillProject =
              carryover !== null &&
              carryover.sessionId === (yield* Ref.get(activeSessionId)) &&
              carryover.projectsLateTerminals;
            const projectCarryover = rootTerminalCanStillProject;
            let carryoverTerminalized = false;
            if (
              flavor.extractSubagentUpdate !== undefined &&
              (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update")
            ) {
              for (const event of parseSessionUpdateEvent(notification).events) {
                if (event._tag !== "ToolCallUpdated") continue;
                const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
                const subagentUpdate = flavor.extractSubagentUpdate(toolCall);
                if (subagentUpdate === undefined) continue;
                if (!acpSubagentStatusIsTerminal(subagentUpdate.status)) {
                  continue;
                }
                if (
                  yield* updateCarryoverSubagentStatus(
                    subagentUpdate.nativeTaskId,
                    subagentUpdate.status,
                    subagentUpdate.result,
                    { project: projectCarryover },
                  )
                ) {
                  carryoverTerminalized = true;
                }
                if (
                  subagentUpdate.childSessionId !== null &&
                  (yield* updateCarryoverSubagentStatus(
                    subagentUpdate.childSessionId,
                    subagentUpdate.status,
                    subagentUpdate.result,
                    { project: projectCarryover },
                  ))
                ) {
                  carryoverTerminalized = true;
                }
              }
            }
            if (
              update.sessionUpdate === "user_message_chunk" &&
              update.content.type === "text" &&
              flavor.extractSubagentEndNotice !== undefined
            ) {
              const notice = flavor.extractSubagentEndNotice(update.content.text);
              if (
                notice !== undefined &&
                (yield* updateCarryoverSubagentStatus(
                  notice.childSessionId,
                  notice.status,
                  undefined,
                  {
                    project: projectCarryover,
                  },
                ))
              ) {
                carryoverTerminalized = true;
              }
            }
            // Synchronize carryover before an eager continuation can attach and
            // drain the frame.
            const continuationOffered = bufferOutcome.offerContinuation
              ? yield* offerContinuationRun(notification.sessionId)
              : false;
            const wakeOutcome = { ...bufferOutcome, continuationOffered };
            // Frames that will not buffer never reach the continuation drain for
            // this traffic. Once carryover is terminalized, skip history append /
            // residual handling (and avoid double-projecting on child re-entry).
            if (carryoverTerminalized && !wakeOutcome.buffered) {
              // Projected above. Never clear a non-empty wakeBuffer. A sticky
              // continuationRequested with an empty buffer is safe to drop so
              // idle release is not wed on a pin with nothing to deliver.
              if (
                acpCarryoverTerminalShouldClearContinuation({
                  continuationOffered: wakeOutcome.continuationOffered,
                  wakeBufferLength: (yield* Ref.get(wakeBuffer)).length,
                })
              ) {
                yield* Ref.set(continuationRequested, false);
              }
              return;
            }
            // Prefer continuation buffering over history append so the same
            // frames are not double-counted once a continuation run attaches.
            if (wakeOutcome.stopProcessing) {
              return;
            }
            if (
              notification.sessionId !==
              ((yield* Ref.get(loadingSessionId)) ?? (yield* Ref.get(activeSessionId)))
            )
              return;
            if (
              update.sessionUpdate === "user_message_chunk" ||
              update.sessionUpdate === "agent_message_chunk" ||
              update.sessionUpdate === "agent_thought_chunk"
            ) {
              // Late monitor end/event reminders must not become ghost user/assistant
              // history (or OS-facing chatter) after the root turn already finalized.
              const text = acpContentBlockDisplayText(update.content);
              if (text === undefined) return;
              const lateBackgroundMutations =
                update.content.type === "text"
                  ? (flavor.extractBackgroundToolMutation?.(text) ?? [])
                  : [];
              for (const lateBackgroundMutation of lateBackgroundMutations) {
                yield* applyLateBackgroundMutation(notification.sessionId, lateBackgroundMutation);
              }
              if (lateBackgroundMutations.length === 0 && !acpIsMonitorChatter(text)) {
                yield* appendLoadedHistory(
                  notification,
                  update.sessionUpdate === "user_message_chunk"
                    ? "user"
                    : update.sessionUpdate === "agent_thought_chunk"
                      ? "thought"
                      : "assistant",
                  text,
                );
              }
            } else if (
              update.sessionUpdate === "user_message" ||
              update.sessionUpdate === "agent_message" ||
              update.sessionUpdate === "agent_thought"
            ) {
              if (update.content === undefined) return;
              const text = (update.content ?? [])
                .flatMap((content) => {
                  const display = acpContentBlockDisplayText(content);
                  return display === undefined ? [] : [display];
                })
                .join("\n");
              yield* appendLoadedHistory(
                notification,
                update.sessionUpdate === "user_message"
                  ? "user"
                  : update.sessionUpdate === "agent_thought"
                    ? "thought"
                    : "assistant",
                text,
                true,
              );
            } else if (
              update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update" ||
              update.sessionUpdate === "plan" ||
              update.sessionUpdate === "plan_update" ||
              update.sessionUpdate === "plan_removed"
            ) {
              yield* Ref.update(snapshot, (current) => ({
                ...current,
                loadingRole: null,
                loadingMessageId: null,
              }));
            }
            return;
          }
          if (context.finalized) return;
          const rootSessionId = yield* Ref.get(activeSessionId);
          if (notification.sessionId !== rootSessionId) {
            // Finalize may have completed during the activeSessionId yield.
            if (context.finalized) return;
            if (flavor.extractSubagentUpdate === undefined) return;
            const subagent = context.subagentsBySessionId.get(notification.sessionId);
            if (update.sessionUpdate === "tool_call_content_chunk") {
              if (subagent === undefined) {
                const buffered =
                  context.pendingSubagentNotifications.get(notification.sessionId) ?? [];
                buffered.push(notification);
                context.pendingSubagentNotifications.set(notification.sessionId, buffered);
                return;
              }
              yield* projectChildToolContentChunk(context, subagent, notification);
              return;
            }
            if (
              update.sessionUpdate === "tool_call" ||
              update.sessionUpdate === "tool_call_update"
            ) {
              if (subagent === undefined) return;
              const nativeTaskId =
                subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
              for (const event of parseSessionUpdateEvent(notification).events) {
                if (event._tag !== "ToolCallUpdated") continue;
                const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
                const subagentUpdate = flavor.extractSubagentUpdate(toolCall);
                if (subagentUpdate !== undefined) {
                  if (
                    subagentUpdate.nativeTaskId === nativeTaskId ||
                    subagentUpdate.childSessionId === notification.sessionId
                  ) {
                    yield* emitSubagent(context, subagentUpdate);
                  }
                  continue;
                }
                const key = `${nativeTaskId}:tool:${toolCall.toolCallId}`;
                const previous = context.tools.get(key);
                const merged = mergeToolCallState(previous, toolCall);
                context.tools.set(key, merged);
                if (!shouldPersistToolUpdate(context, key, previous, merged, merged.status))
                  continue;
                // Terminals are remembered under the raw session id: the child's
                // own session, or the root one when the flavor routes child
                // updates out of it (Devin).
                const mcpIdentity = extractMcpToolCallIdentity(merged, {
                  embeddedTerminalCommands: [
                    ...embeddedTerminalCommands(notification.sessionId, toolCall.toolCallId),
                    ...(rootSessionId === null
                      ? []
                      : embeddedTerminalCommands(rootSessionId, toolCall.toolCallId)),
                  ],
                });
                const dispatched = mcpIdentity && acpMcpDispatch(mcpIdentity, merged.data.rawInput);
                const now = yield* DateTime.now;
                const status = toolStatus(merged.status);
                const startedAt = context.toolStartedAt.get(key) ?? now;
                context.toolStartedAt.set(key, startedAt);
                const ordinal = resolveSubagentChildOrdinal(subagent, key);
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    id: providerTurnItemId(key),
                    threadId: subagent.childThreadId,
                    runId: null,
                    nodeId: subagent.childRootNodeId,
                    providerThreadId: subagent.task.providerThreadId,
                    providerTurnId: null,
                    nativeItemRef: { driver, nativeId: key, strength: "strong" },
                    parentItemId: null,
                    ordinal,
                    status,
                    title: dispatched ? null : (merged.title ?? merged.kind ?? "Tool"),
                    startedAt,
                    completedAt: completedAtForStatus(status, now),
                    updatedAt: now,
                    type: "dynamic_tool",
                    ...(mcpIdentity === undefined
                      ? {}
                      : mcpToolPresentation({
                          serverName: mcpIdentity.server,
                          toolName: dispatched?.tool ?? mcpIdentity.tool,
                          source: unknownRecord(
                            (
                              unknownRecord(unknownRecord(merged.data.rawOutput)?.result) ??
                              unknownRecord(merged.data.rawOutput)
                            )?._meta,
                          )?.source,
                        })),
                    toolName:
                      mcpIdentity === undefined
                        ? (acpDynamicToolName(merged) ?? "Tool")
                        : `${mcpIdentity.server}.${dispatched?.tool ?? mcpIdentity.tool}`,
                    input: dispatched?.input ?? merged.data.rawInput ?? null,
                    output: merged.data.rawOutput ?? merged.data.content ?? null,
                  },
                });
              }
              return;
            }
            const isDisplayableAssistantUpdate =
              (update.sessionUpdate === "agent_message_chunk" &&
                acpContentBlockDisplayText(update.content) !== undefined) ||
              (update.sessionUpdate === "agent_message" && update.content !== undefined);
            if (!isDisplayableAssistantUpdate) {
              return;
            }
            if (subagent !== undefined) {
              yield* projectSubagentNotification(subagent, notification);
              return;
            }
            const buffered = context.pendingSubagentNotifications.get(notification.sessionId) ?? [];
            buffered.push(notification);
            context.pendingSubagentNotifications.set(notification.sessionId, buffered);
            return;
          }
          // Re-check after the activeSessionId yield: idle/prompt settle can
          // finalize the same context object while we waited.
          if (context.finalized) return;
          // The agent started its own turn about finished background work while
          // this settled root turn was still held for it. That turn is the
          // agent's reply, not more of the root: settle the root first so the
          // frame reaches the wake path and opens a continuation run.
          if (
            context.promptSettled &&
            !acpIsProviderContinuationMessage(context.input.message) &&
            flavor.isProviderWakeNotification?.(notification) === true
          ) {
            if (hasDeferredBackgroundWork(context)) {
              yield* Ref.update(wakeBuffer, (current) => [...current, notification]);
              return;
            }
            yield* finalizeTurn(context, context.promptSettledStatus ?? "completed");
            const wake = yield* bufferPostSettleWake(notification);
            if (wake.offerContinuation) {
              yield* offerContinuationRun(notification.sessionId);
            }
            return;
          }
          // Only fresh model output proves a retry recovered; progress on
          // tools and plans that started earlier can arrive mid-retry.
          if (
            update.sessionUpdate !== "tool_call_update" &&
            update.sessionUpdate !== "plan" &&
            update.sessionUpdate !== "plan_update" &&
            update.sessionUpdate !== "plan_removed" &&
            acpRootSessionUpdateIngestsOutput(notification)
          ) {
            yield* emitProviderRetry(context, "completed");
          }
          if (
            context.outgoingPrompt !== undefined &&
            (update.sessionUpdate === "user_message" ||
              update.sessionUpdate === "user_message_chunk")
          ) {
            // ACP v2 prompt acknowledgments lack a messageId; correlate one full echo by content.
            if (
              context.consumedPromptMessageId === undefined &&
              update.sessionUpdate === "user_message" &&
              Equal.equals(update.content, context.outgoingPrompt)
            ) {
              context.consumedPromptMessageId = update.messageId;
            }
            if (
              context.consumedPromptMessageId !== undefined &&
              context.consumedPromptMessageId === update.messageId
            )
              return;
          }
          switch (update.sessionUpdate) {
            case "state_update": {
              const toolCallId = `${context.nativeTurnId}:requires-action`;
              const existing = context.tools.get(toolCallId);
              if (update.state === "requires_action") {
                yield* emitTool(context, {
                  toolCallId,
                  kind: "other",
                  title: "Action required",
                  status: "requiresAction",
                  data: { state: "requires_action" },
                });
              } else if (existing?.status === "requiresAction") {
                yield* emitTool(context, {
                  ...existing,
                  status: "completed",
                  data: { ...existing.data, state: update.state },
                });
              }
              break;
            }
            case "agent_message_chunk": {
              const text = acpContentBlockDisplayText(update.content);
              if (text !== undefined) {
                const startsNewAssistantSegment = context.assistant.current === null;
                // The injected-turn report is streaming; the normal debounce
                // after the last chunk takes over from here. Drop matching
                // mid-turn armed ids so finalize does not open a duplicate
                // wake after the report already projected into this turn.
                if (context.pendingInjectedReport.size > 0) {
                  const reportedTaskIds = [...context.pendingInjectedReport];
                  context.pendingInjectedReport.clear();
                  yield* clearMidTurnUnreportedTaskIds(reportedTaskIds);
                } else if (
                  startsNewAssistantSegment &&
                  context.promptSettled &&
                  (yield* Ref.get(midTurnUnreportedCompletedTaskIds)).size > 0
                ) {
                  // Some ACP implementations deliver the injected assistant
                  // report before the synthetic monitor end notice. Correlation
                  // arrives with that notice, so remember the unmatched report
                  // and consume its task id when the notice follows.
                  context.earlyInjectedReportObserved = true;
                }
                yield* appendText(context, "assistant", text, update.messageId);
              }
              break;
            }
            case "agent_thought_chunk": {
              const text = acpContentBlockDisplayText(update.content);
              if (text !== undefined) {
                yield* appendText(context, "reasoning", text, update.messageId);
              }
              break;
            }
            case "user_message":
            case "agent_message":
            case "agent_thought": {
              if (update.content === undefined) break;
              const text = (update.content ?? [])
                .flatMap((content) => {
                  const display = acpContentBlockDisplayText(content);
                  return display === undefined ? [] : [display];
                })
                .join("\n");
              yield* replaceText(
                context,
                update.sessionUpdate === "user_message"
                  ? "user"
                  : update.sessionUpdate === "agent_message"
                    ? "assistant"
                    : "reasoning",
                text,
                update.messageId,
              );
              break;
            }
            case "tool_call_content_chunk": {
              const text =
                update.content.type === "content"
                  ? acpContentBlockDisplayText(update.content.content)
                  : update.content.type === "diff"
                    ? "changes" in update.content
                      ? update.content.patch?.text
                      : update.content.newText
                    : undefined;
              if (text !== undefined) {
                const previous = context.tools.get(update.toolCallId) ?? {
                  toolCallId: update.toolCallId,
                  status: "inProgress" as const,
                  data: { toolCallId: update.toolCallId },
                };
                // Text chunks extend the content list so a later content replacement still shows.
                yield* emitTool(
                  context,
                  update.content.type === "content" && previous.data.rawOutput === undefined
                    ? {
                        ...previous,
                        data: {
                          ...previous.data,
                          content: appendToolContentText(previous.data.content, text),
                        },
                      }
                    : previous.data.rawOutput === undefined
                      ? setToolOutputText(
                          previous,
                          `${textFromUnknown(previous.data.content) ?? ""}${text}`,
                        )
                      : appendToolOutputText(previous, text),
                );
              }
              break;
            }
            case "compaction_summary_chunk": {
              const text = acpContentBlockDisplayText(update.content);
              if (text !== undefined) {
                const toolCallId = `acp-compaction:${update.compactionId}`;
                const previous = context.tools.get(toolCallId) ?? {
                  toolCallId,
                  kind: "think",
                  title: "Compact context",
                  status: "inProgress" as const,
                  data: { toolCallId },
                };
                yield* emitTool(context, appendToolOutputText(previous, text));
              }
              break;
            }
            case "user_message_chunk": {
              if (update.content.type === "text" && flavor.extractBackgroundToolMutation) {
                const mutations = flavor.extractBackgroundToolMutation(update.content.text);
                const terminalTaskIds = mutations
                  .filter((mutation) => mutation.status !== "running")
                  .map((mutation) => mutation.taskId);
                const reportArrivedBeforeNotice =
                  context.earlyInjectedReportObserved && terminalTaskIds.length > 0;
                if (reportArrivedBeforeNotice) {
                  context.earlyInjectedReportObserved = false;
                  yield* clearMidTurnUnreportedTaskIds(terminalTaskIds);
                }
                for (const mutation of mutations) {
                  const toolCallId = context.toolCallIdsByBackgroundTaskId.get(mutation.taskId);
                  const previous =
                    toolCallId !== undefined ? context.tools.get(toolCallId) : undefined;
                  if (previous !== undefined) {
                    let nextStatus =
                      mutation.status === "running"
                        ? ("inProgress" as const)
                        : mutation.status === "failed"
                          ? ("failed" as const)
                          : ("completed" as const);
                    // End notices typically omit full stdout (no get_command mention
                    // either). Keep the tool running and hold finalize until
                    // TaskOutput hydrates, or the safety timer force-completes.
                    if (nextStatus !== "inProgress") {
                      yield* markAwaitingBackgroundHydration(context, mutation.taskId);
                      nextStatus = "inProgress";
                    }
                    yield* emitTool(
                      context,
                      appendToolOutputText(
                        { ...previous, status: nextStatus },
                        mutation.appendOutput,
                      ),
                    );
                  }
                  // After emitTool: the hydration hold keeps the tool row at
                  // inProgress past an end notice, but the offer gate must see
                  // the mutation's semantic status. Also tracks monitors that
                  // never surfaced a tool_call row at all.
                  yield* applyBackgroundTaskMutationRunning(mutation);
                  if (mutation.status !== "running" && !reportArrivedBeforeNotice) {
                    yield* markPendingInjectedReport(context, mutation.taskId);
                  }
                }
              }
              if (update.content.type === "text" && flavor.extractSubagentEndNotice) {
                const notice = flavor.extractSubagentEndNotice(update.content.text);
                const subagent =
                  notice !== undefined
                    ? context.subagentsBySessionId.get(notice.childSessionId)
                    : undefined;
                if (
                  notice !== undefined &&
                  subagent !== undefined &&
                  (subagent.task.status === "running" || subagent.task.status === "pending")
                ) {
                  // The agent is free to answer with text only and never call
                  // get_command_or_subagent_output; without this, the subagent
                  // row stays running and holds deferred finalize open forever.
                  yield* emitSubagent(context, {
                    nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? notice.childSessionId,
                    prompt: subagent.task.prompt,
                    title: subagent.task.title,
                    model: subagent.task.model,
                    status: notice.status,
                    childSessionId: notice.childSessionId,
                    result: null,
                    suppressNormalTool: true,
                  });
                }
              }
              // startTurn already projects the submitted prompt. Active ACP
              // user chunks are transport echoes or injected background
              // notices, so only their semantic mutations belong in the turn.
              break;
            }
            default: {
              const parsed = parseSessionUpdateEvent(notification);
              for (const event of parsed.events) {
                if (event._tag === "ToolCallUpdated") {
                  yield* emitTool(context, event.toolCall);
                } else if (event._tag === "PlanUpdated") {
                  yield* emitPlan(context, event.payload, update.sessionUpdate !== "plan");
                } else if (event._tag === "NoticeReceived") {
                  yield* emitNotice(context, event);
                } else if (event._tag === "UnknownUpdate") {
                  yield* emitTool(context, {
                    toolCallId: `${context.nativeTurnId}:unsupported:${event.updateType}`,
                    kind: "other",
                    title: `Unsupported ACP update: ${event.updateType}`,
                    status: "completed",
                    data: { updateType: event.updateType },
                  });
                }
              }
            }
          }
          // Keep deferred finalize quiet-window fresh while wake traffic lands.
          yield* rearmDeferredFinalize(context);
        });

        const activeContext = Effect.gen(function* () {
          const context = yield* Ref.get(activeTurn);
          if (context === null) {
            return yield* new EffectAcpErrors.AcpTransportError({
              detail: "ACP agent requested input without an active turn",
              cause: "No active ACP turn",
            });
          }
          return context;
        });

        const beginApprovalRequest = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          params: EffectAcpSchema.RequestPermissionRequest,
          generation: number,
          transportRequestId: string,
        ) {
          yield* closeTextStreams(context);
          const parsed = parsePermissionRequest(params);
          const approvalOptions = flavor.approvalOptions?.(params);
          const nativeRequestId = params.toolCall.toolCallId;
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver,
            providerTurnId: context.providerTurnId,
            nativeRequestId,
          });
          const decision = yield* Deferred.make<ProviderApprovalDecision>();
          const nativeResponseAcknowledgement = yield* Deferred.make<
            void,
            EffectAcpErrors.AcpError
          >();
          yield* registerNativeResponseAcknowledgement(
            generation,
            transportRequestId,
            nativeResponseAcknowledgement,
          );
          const now = yield* DateTime.now;
          const nodeId = idAllocator.derive.approvalNode({ requestId });
          const requestKind = providerRequestKind(parsed.kind);
          const nativeItemRef = { driver, nativeId: nativeRequestId, strength: "weak" as const };
          const ordinal = yield* resolveItemOrdinal(
            context,
            `${context.nativeTurnId}:approval:${nativeRequestId}`,
          );
          const runtimeRequest: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: context.providerTurnId,
            nativeRequestRef: nativeItemRef,
            kind: requestKind,
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: input.providerSessionId,
            },
            createdAt: now,
            resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            parentNodeId: context.input.rootNodeId,
            rootNodeId: context.input.rootNodeId,
            kind: "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          };
          const turnItem: OrchestrationV2TurnItem = {
            id: idAllocator.derive.approvalTurnItem({ requestId }),
            threadId: context.input.threadId,
            runId: context.input.runId,
            nodeId,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "approval_request",
            requestId,
            requestKind,
            ...(parsed.detail === undefined ? {} : { prompt: parsed.detail }),
            ...(approvalOptions === undefined ? {} : { options: approvalOptions }),
          };
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(requestId), {
              type: "approval",
              generation,
              nativeResponseAcknowledgement,
              requestId,
              transportRequestId,
              decision,
              runtimeRequest,
              node,
              turnItem,
            });
            return updated;
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver,
            threadId: context.input.threadId,
            runtimeRequest,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem,
          });
          return {
            context,
            decision,
            nativeResponseAcknowledgement,
            requestId,
            transportRequestId,
          } as const;
        });

        const beginUserInputRequest = Effect.fnUntraced(function* (
          request: AcpAdapterV2UserInputRequest,
          generation: number,
          transportRequestId: string,
        ) {
          const context = yield* activeContext;
          yield* closeTextStreams(context);
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver,
            providerTurnId: context.providerTurnId,
            nativeRequestId: request.nativeRequestId,
          });
          const answers = yield* Deferred.make<ProviderUserInputAnswers | null>();
          const nativeResponseAcknowledgement = yield* Deferred.make<
            void,
            EffectAcpErrors.AcpError
          >();
          yield* registerNativeResponseAcknowledgement(
            generation,
            transportRequestId,
            nativeResponseAcknowledgement,
          );
          const now = yield* DateTime.now;
          const nodeId = providerNodeId(request.nativeItemId);
          const turnItemId = providerTurnItemId(request.nativeItemId);
          const nativeItemRef = {
            driver,
            nativeId: request.nativeItemId,
            strength: "weak" as const,
          };
          const ordinal = yield* resolveItemOrdinal(context, request.nativeItemId);
          const runtimeRequest: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: context.providerTurnId,
            nativeRequestRef: {
              driver,
              nativeId: request.nativeRequestId,
              strength: "weak",
            },
            kind: "user_input",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: input.providerSessionId,
            },
            createdAt: now,
            resolvedAt: null,
          };
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            parentNodeId: context.input.rootNodeId,
            rootNodeId: context.input.rootNodeId,
            kind: "user_input_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef,
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          };
          const turnItem: OrchestrationV2TurnItem = {
            id: turnItemId,
            threadId: context.input.threadId,
            runId: context.input.runId,
            nodeId,
            providerThreadId: context.input.providerThread.id,
            providerTurnId: context.providerTurnId,
            nativeItemRef,
            parentItemId: null,
            ordinal,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "user_input_request",
            requestId,
            questions: [...request.questions],
          };
          yield* Ref.update(pendingRuntimeRequests, (current) => {
            const updated = new Map(current);
            updated.set(String(requestId), {
              type: "user_input",
              generation,
              nativeResponseAcknowledgement,
              requestId,
              transportRequestId,
              answers,
              runtimeRequest,
              node,
              turnItem,
            });
            return updated;
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node,
          });
          yield* emitProviderEvent({
            type: "runtime_request.updated",
            driver,
            threadId: context.input.threadId,
            runtimeRequest,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem,
          });
          return {
            answers,
            context,
            nativeResponseAcknowledgement,
            requestId,
            transportRequestId,
          } as const;
        });

        const requestUserInputWithAdmission = (
          generation: number,
          request: Effect.Effect<AcpAdapterV2UserInputRequest>,
          transportRequestId: string,
        ) =>
          runRuntimeCallbackAtGeneration(
            generation,
            request.pipe(
              Effect.flatMap((value) =>
                beginUserInputRequest(value, generation, transportRequestId),
              ),
            ),
          ).pipe(
            Effect.flatMap((pending) => {
              if (Option.isNone(pending)) return Effect.never;
              const { answers, requestId, transportRequestId } = pending.value;
              return Deferred.await(answers).pipe(
                Effect.flatMap((result) =>
                  runRuntimeCallbackAtGeneration(generation, Effect.succeed(result)).pipe(
                    Effect.flatMap((checked) =>
                      Option.isSome(checked)
                        ? Effect.succeed({
                            acknowledgeNativeResponse: acknowledgeNativeResponse(
                              generation,
                              transportRequestId,
                            ),
                            answers: checked.value,
                          })
                        : Effect.never,
                    ),
                  ),
                ),
                Effect.ensuring(
                  runRuntimeCallbackAtGeneration(
                    generation,
                    Effect.gen(function* () {
                      yield* Ref.update(pendingRuntimeRequests, (current) => {
                        const updated = new Map(current);
                        updated.delete(String(requestId));
                        return updated;
                      });
                    }),
                  ).pipe(Effect.asVoid),
                ),
              );
            }),
            Effect.mapError(
              (cause) =>
                new EffectAcpErrors.AcpTransportError({
                  detail: "Failed to handle ACP user input request",
                  cause,
                }),
            ),
          );

        const cancelPendingRuntimeRequests = Effect.fnUntraced(function* (
          options: { readonly stopMcpCalls: boolean } = { stopMcpCalls: true },
        ) {
          const waiting = turnAttached;
          turnAttached = yield* Deferred.make<boolean>();
          yield* Deferred.succeed(waiting, false);
          // session/cancel does not end the agent's MCP calls; T3 runs them, so it stops them.
          if (options.stopMcpCalls && runtimeMcpBridge !== undefined) {
            yield* runtimeMcpBridge.stopCalls;
          }
          const requests = yield* Ref.modify(pendingRuntimeRequests, (current) => [
            [...current.values()],
            new Map<string, PendingRuntimeRequest>(),
          ]);
          if (requests.length === 0) return;

          const now = yield* DateTime.now;
          yield* Effect.forEach(
            requests,
            (request) =>
              Effect.gen(function* () {
                const cancelled = yield* request.type === "approval"
                  ? Deferred.succeed(request.decision, "cancel")
                  : Deferred.succeed(request.answers, null);
                if (!cancelled) return;

                yield* emitProviderEvent({
                  type: "runtime_request.updated",
                  driver,
                  threadId: request.node.threadId,
                  runtimeRequest: {
                    ...request.runtimeRequest,
                    status: "cancelled",
                    resolvedAt: now,
                  },
                });
                yield* emitProviderEvent({
                  type: "node.updated",
                  driver,
                  node: {
                    ...request.node,
                    status: "cancelled",
                    completedAt: now,
                  },
                });
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  driver,
                  turnItem: {
                    ...request.turnItem,
                    status: "cancelled",
                    completedAt: now,
                    updatedAt: now,
                  },
                });
              }),
            { concurrency: 1, discard: true },
          );
        });

        /**
         * Mutate a carryover subagent's in-memory task status without projecting.
         * Used after a non-completed root whose original run subscriber is no
         * longer guaranteed to ingest the terminal event.
         */
        const mutateCarryoverSubagentStatus = Effect.fnUntraced(function* (
          subagent: ActiveAcpSubagent,
          status: OrchestrationV2Subagent["status"],
          resultOverride?: string | null,
        ) {
          const now = yield* DateTime.now;
          const result =
            resultOverride !== undefined && resultOverride !== null && resultOverride.length > 0
              ? resultOverride
              : (subagent.task.result ?? (subagent.assistantText || null));
          const completedAt = acpSubagentStatusIsTerminal(status) ? now : null;
          subagent.task = {
            ...subagent.task,
            status,
            result,
            completedAt,
            updatedAt: now,
          };
        });

        /**
         * Project a carryover subagent status change without an ActiveAcpTurn.
         * Shared by completed-root post-settle completion, deferred attach, and
         * Direct Stop terminalization.
         */
        const projectCarryoverSubagentStatus = Effect.fnUntraced(function* (
          subagent: ActiveAcpSubagent,
          status: OrchestrationV2Subagent["status"],
          resultOverride?: string | null,
        ) {
          if (acpSubagentStatusIsTerminal(status)) yield* readSubagentTranscript(subagent, true);
          yield* flushSubagentAssistant(subagent);
          yield* mutateCarryoverSubagentStatus(subagent, status, resultOverride);
          const now = subagent.task.updatedAt;
          const nativeTaskId = subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id;
          const nativeItemRef = {
            driver,
            nativeId: nativeTaskId,
            strength: "strong" as const,
          };
          const parentProviderThreadId = subagent.parentProviderThreadId;
          const result = subagent.task.result;
          const completedAt = subagent.task.completedAt;
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: subagent.task.id,
              threadId: subagent.task.threadId,
              runId: subagent.task.runId,
              parentNodeId: subagent.task.parentNodeId,
              rootNodeId: subagent.task.parentNodeId,
              kind: "subagent",
              status,
              countsForRun: false,
              providerThreadId: parentProviderThreadId,
              providerTurnId: subagent.providerTurnId,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: subagent.task.startedAt,
              completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "node.updated",
            driver,
            node: {
              id: subagent.childRootNodeId,
              threadId: subagent.childThreadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: subagent.childRootNodeId,
              kind: "root_turn",
              status,
              countsForRun: false,
              providerThreadId: subagent.task.providerThreadId,
              providerTurnId: null,
              nativeItemRef,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: subagent.task.startedAt,
              completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "subagent.updated",
            driver,
            subagent: subagent.task,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver,
            turnItem: {
              id: subagent.turnItemId,
              threadId: subagent.task.threadId,
              runId: subagent.task.runId,
              nodeId: subagent.task.id,
              providerThreadId: parentProviderThreadId,
              providerTurnId: subagent.providerTurnId,
              nativeItemRef,
              parentItemId: null,
              ordinal: subagent.turnItemOrdinal,
              status,
              title: subagent.task.title,
              startedAt: subagent.task.startedAt,
              completedAt,
              updatedAt: now,
              type: "subagent",
              subagentId: subagent.task.id,
              origin: "provider_native",
              driver,
              providerInstanceId: subagent.task.providerInstanceId,
              childThreadId: subagent.childThreadId,
              prompt: subagent.task.prompt,
              result,
            },
          });
          if (acpSubagentStatusIsTerminal(status)) {
            subagent.terminalStatusProjected = true;
          }
        });

        /**
         * Update a carryover subagent matched by native task id or child session
         * id. Post-settle completions must flip the pin in hasPendingBackgroundWork
         * without waiting for a new user turn to consume carryover.
         * When `project` is false, only the in-memory carryover status advances
         * (the next attach projects the terminal state).
         * If status already matches but projection was deferred, a later
         * project:true caller still projects once via terminalStatusProjected.
         */
        const updateCarryoverSubagentStatus = Effect.fnUntraced(function* (
          nativeIdOrChildSessionId: string,
          status: OrchestrationV2Subagent["status"],
          result?: string | null,
          options?: { readonly project?: boolean },
        ) {
          const carryover = yield* Ref.get(carryoverSubagents);
          if (carryover === null) return false;
          const match = carryover.subagents.find((subagent) => {
            const nativeId = subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
            return (
              nativeId === nativeIdOrChildSessionId ||
              subagent.childSessionId === nativeIdOrChildSessionId
            );
          });
          if (match === undefined) return false;
          const shouldProject = options?.project !== false;
          if (match.task.status === status) {
            // Already at this status: only project if requested and not yet done.
            if (!shouldProject || match.terminalStatusProjected) {
              return true;
            }
            yield* projectCarryoverSubagentStatus(match, status, result);
            return true;
          }
          // Only advance nonterminal entries; do not resurrect a terminal one.
          if (match.task.status !== "running" && match.task.status !== "pending") {
            return false;
          }
          if (!shouldProject) {
            yield* mutateCarryoverSubagentStatus(match, status, result);
          } else {
            yield* projectCarryoverSubagentStatus(match, status, result);
          }
          return true;
        });

        const finishSubagentFromNotice = Effect.fnUntraced(function* (notice: {
          readonly childSessionId: string;
          readonly status: "completed" | "failed" | "cancelled";
          readonly result: string | null;
        }) {
          const context = yield* Ref.get(activeTurn);
          const subagent =
            context === null ? undefined : context.subagentsBySessionId.get(notice.childSessionId);
          const known =
            subagent ??
            (yield* Ref.get(carryoverSubagents))?.subagents.find(
              (candidate) =>
                candidate.childSessionId === notice.childSessionId ||
                candidate.task.nativeTaskRef?.nativeId === notice.childSessionId,
            );
          if (known !== undefined && acpSubagentStatusBlocksTurnSettlement(known.task.status)) {
            yield* recordWakeReport(notice.childSessionId, {
              kind: "subagent",
              label: known.task.title ?? known.task.prompt,
              outcome: notice.status,
              childThreadId: known.childThreadId,
            });
          }
          if (context !== null && subagent !== undefined && !context.finalized) {
            if (!acpSubagentStatusBlocksTurnSettlement(subagent.task.status)) return;
            yield* emitSubagent(context, {
              nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? notice.childSessionId,
              prompt: subagent.task.prompt,
              title: subagent.task.title,
              model: subagent.task.model,
              status: notice.status,
              childSessionId: notice.childSessionId,
              result: notice.result,
              suppressNormalTool: true,
            });
            yield* rearmDeferredFinalize(context);
            return;
          }
          // The root turn already settled: the subagent is carryover. Project
          // its end while the completed root still owns the run.
          const carryover = yield* Ref.get(carryoverSubagents);
          yield* updateCarryoverSubagentStatus(
            notice.childSessionId,
            notice.status,
            notice.result,
            {
              project:
                carryover !== null &&
                carryover.sessionId === (yield* Ref.get(activeSessionId)) &&
                carryover.projectsLateTerminals,
            },
          );
        });

        applyFinalizedActiveTurnSubagentTerminal = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          notification: EffectAcpSchema.SessionNotification,
        ) {
          if (flavor.extractSubagentUpdate === undefined) return false;

          const applyTerminal = Effect.fnUntraced(function* (
            subagent: ActiveAcpSubagent,
            update: AcpAdapterV2SubagentUpdate,
          ) {
            if (!acpSubagentStatusIsTerminal(update.status)) return false;
            if (acpSubagentStatusIsTerminal(subagent.task.status)) {
              if (subagent.terminalStatusProjected || context.finalizedStatus !== "completed") {
                return true;
              }
            }
            if (context.finalizedStatus === "completed") {
              yield* emitSubagent(context, update);
            } else {
              yield* mutateCarryoverSubagentStatus(subagent, update.status, update.result);
            }
            return true;
          });

          const sessionUpdate = notification.update;
          if (
            sessionUpdate.sessionUpdate === "tool_call" ||
            sessionUpdate.sessionUpdate === "tool_call_update"
          ) {
            for (const event of parseSessionUpdateEvent(notification).events) {
              if (event._tag !== "ToolCallUpdated") continue;
              const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
              const subagentUpdate = flavor.extractSubagentUpdate(toolCall);
              if (
                subagentUpdate === undefined ||
                !acpSubagentStatusIsTerminal(subagentUpdate.status)
              ) {
                continue;
              }
              const subagent =
                context.subagents.get(subagentUpdate.nativeTaskId) ??
                (subagentUpdate.childSessionId === null
                  ? undefined
                  : context.subagentsBySessionId.get(subagentUpdate.childSessionId)) ??
                context.subagentsBySessionId.get(notification.sessionId);
              if (subagent === undefined) continue;
              const nativeTaskId =
                subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id);
              if (
                subagentUpdate.nativeTaskId !== nativeTaskId &&
                (subagentUpdate.childSessionId === null ||
                  (subagentUpdate.childSessionId !== subagent.childSessionId &&
                    subagentUpdate.childSessionId !== notification.sessionId))
              ) {
                continue;
              }
              if (yield* applyTerminal(subagent, subagentUpdate)) return true;
            }
          }

          if (
            sessionUpdate.sessionUpdate === "user_message_chunk" &&
            sessionUpdate.content.type === "text" &&
            flavor.extractSubagentEndNotice !== undefined
          ) {
            const notice = flavor.extractSubagentEndNotice(sessionUpdate.content.text);
            const subagent =
              notice === undefined
                ? undefined
                : context.subagentsBySessionId.get(notice.childSessionId);
            if (notice !== undefined && subagent !== undefined) {
              return yield* applyTerminal(subagent, {
                nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? String(subagent.task.id),
                prompt: subagent.task.prompt,
                title: subagent.task.title,
                model: subagent.task.model,
                status: notice.status,
                childSessionId: notice.childSessionId,
                result: null,
                suppressNormalTool: true,
              });
            }
          }

          return false;
        });

        const projectDeferredCarryoverTerminals = Effect.fnUntraced(function* (
          subagents: ReadonlyArray<ActiveAcpSubagent>,
        ) {
          for (const subagent of subagents) {
            if (
              subagent.task.status === "running" ||
              subagent.task.status === "pending" ||
              subagent.terminalStatusProjected
            ) {
              continue;
            }
            yield* projectCarryoverSubagentStatus(
              subagent,
              subagent.task.status,
              subagent.task.result,
            );
          }
        });

        /**
         * Direct Stop after a soft steer clears carryover without an active turn.
         * Emit the same interrupted terminal events terminalizeOpenRunOwnedItems
         * would have, context-free (no ActiveAcpTurn).
         */
        const terminalizeCarryoverSubagents = Effect.fnUntraced(function* (
          carryover: AcpCarryoverSubagents | null,
          status: "interrupted" | "failed" = "interrupted",
        ) {
          if (carryover === null) return;
          for (const subagent of carryover.subagents) {
            if (acpSubagentStatusIsTerminal(subagent.task.status)) {
              if (!subagent.terminalStatusProjected) {
                yield* projectCarryoverSubagentStatus(
                  subagent,
                  subagent.task.status,
                  subagent.task.result,
                );
              }
              continue;
            }
            yield* projectCarryoverSubagentStatus(subagent, status);
          }
        });

        const projectAcpRuntimeSessionUpdateEffect = (
          rawNotification: EffectAcpSchema.SessionNotification,
        ) =>
          Effect.gen(function* () {
            yield* notePromptProgress(rawNotification);
            if (clientTerminals !== undefined) {
              if (
                rawNotification.update.sessionUpdate === "tool_call" ||
                rawNotification.update.sessionUpdate === "tool_call_update"
              ) {
                const turn = yield* Ref.get(activeTurn);
                if (!turn?.interrupted)
                  turn?.terminalCalls?.track(rawNotification.sessionId, rawNotification.update);
              }
              const embedded = embeddedTerminalIdsFromSessionUpdate(rawNotification);
              if (embedded !== undefined) {
                rememberEmbeddedTerminals({
                  ...embedded,
                  sessionId: rawNotification.sessionId,
                });
              } else if (
                rawNotification.update.sessionUpdate === "tool_call" &&
                embeddedTerminalsByToolCallId.has(
                  sessionScopedId(rawNotification.sessionId, rawNotification.update.toolCallId),
                )
              ) {
                rememberEmbeddedTerminals({
                  sessionId: rawNotification.sessionId,
                  toolCallId: rawNotification.update.toolCallId,
                  terminalIds: [],
                });
              }
            }
            let notification =
              clientTerminals === undefined
                ? rawNotification
                : resolveEmbeddedTerminalContent(
                    rawNotification,
                    clientTerminals.readOutputSnapshot,
                  );
            const update = notification.update;
            if (
              update.sessionUpdate === "tool_call_update" &&
              update.content == null &&
              update.rawOutput == null
            ) {
              const output = embeddedClientTerminalOutput(
                notification.sessionId,
                update.toolCallId,
              );
              if (output !== undefined)
                notification = {
                  ...notification,
                  update: { ...update, rawOutput: { type: "Text", text: output } },
                };
            }
            if (notification.update.sessionUpdate === "available_commands_update") {
              const commandNames = new Set(
                notification.update.availableCommands.map((command) =>
                  command.name.trim().toLowerCase(),
                ),
              );
              yield* Ref.update(advertisedCommandNames, (current) =>
                new Map(current).set(notification.sessionId, commandNames),
              );
              yield* Deferred.succeed(commandsReadyDeferred(notification.sessionId), undefined);
              const advertised = acpAdvertisedSkillNames(notification.update._meta);
              yield* Ref.update(sessionSkillNames, (current) =>
                new Map(current).set(notification.sessionId, advertised),
              );
              yield* (
                flavor.onAvailableCommandsUpdate?.(
                  notification.update.availableCommands,
                  notification.update._meta,
                ) ?? Effect.void
              );
            }
            if (
              notification.update.sessionUpdate === "config_option_update" ||
              notification.update.sessionUpdate === "current_mode_update"
            ) {
              const configOptions = yield* runtime.getConfigOptions;
              const modeState = yield* runtime.getModeState;
              if (
                configuredAcpMode &&
                notification.sessionId === (yield* Ref.get(activeSessionId))
              ) {
                const modes = findAcpApprovalModes(
                  acpProviderOptionDescriptors({ configOptions, modeState }),
                );
                const modeId =
                  notification.update.sessionUpdate === "current_mode_update"
                    ? notification.update.currentModeId
                    : modes?.descriptor.currentValue;
                if (modeId !== undefined && modeId !== configuredAcpMode.value) {
                  const previous = configuredAcpMode.runtimeMode;
                  const current = (Object.keys(modes?.approvals ?? {}) as RuntimeMode[]).find(
                    (mode) => modes?.approvals[mode]?.id === modeId,
                  );
                  configuredAcpMode = { value: modeId, runtimeMode: current ?? previous };
                  const providerThread = (yield* Ref.get(providerThreadByNativeSessionId)).get(
                    notification.sessionId,
                  );
                  if (providerThread && current !== undefined && current !== previous) {
                    yield* Queue.offer(events, {
                      type: "provider_thread.updated",
                      driver,
                      providerThread,
                      sessionScoped: true,
                      reportedRuntimeMode: { previous, current },
                    });
                  }
                }
              }
              yield* (
                flavor.onSessionConfigurationUpdate?.(
                  configOptions,
                  modeState,
                  yield* activeModelState,
                ) ?? Effect.void
              );
            }
            const normalized = flavor.normalizeSessionUpdate?.(notification) ?? notification;
            yield* projectBackgroundCommand(normalized);
            yield* handleSessionUpdate(normalized);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new EffectAcpErrors.AcpTransportError({
                  detail: "Failed to project an ACP session update",
                  cause,
                }),
            ),
          );
        const projectAcpRuntimeSessionUpdate = (
          handlerGeneration: number,
          rawNotification: EffectAcpSchema.SessionNotification,
        ) =>
          runRuntimeCallbackAtGeneration(
            handlerGeneration,
            projectAcpRuntimeSessionUpdateEffect(rawNotification),
          ).pipe(Effect.asVoid);

        if (clientTerminals !== undefined)
          yield* Stream.fromQueue(clientTerminalOutputs).pipe(
            Stream.runForEach((entry) =>
              Effect.sync(() => {
                pendingClientTerminalOutputs.delete(entry.key);
              }).pipe(
                Effect.andThen(
                  runRuntimeCallbackAtGeneration(
                    entry.generation,
                    projectClientTerminalOutput(entry.sessionId, entry.terminalId),
                  ),
                ),
                Effect.asVoid,
              ),
            ),
            Effect.forkIn(sessionScope),
          );

        // Falls back to the latest turn policy when no turn is active so
        // post-settle background work stays under the policy it started with.
        const clientPolicyContext = Effect.map(Ref.get(activeTurn), (context) => ({
          policy: context?.input.runtimePolicy ?? latestRuntimePolicy,
          turnKey: context === null ? null : String(context.providerTurnId),
        }));

        const denyClientRequest = (operation: string, disposition: "ask" | "deny") =>
          Effect.logWarning("ACP client policy denied a client-mediated operation", {
            operation,
            disposition,
          }).pipe(
            Effect.andThen(
              Effect.fail(
                EffectAcpErrors.AcpRequestError.internalError(
                  disposition === "ask"
                    ? `The active SSHCode runtime policy requires approval for ${operation}. Request permission with session/request_permission before retrying.`
                    : `The active SSHCode runtime policy does not allow ${operation}.`,
                ),
              ),
            ),
          );

        const guardClientTerminalCreate = clientPolicyContext.pipe(
          Effect.flatMap(({ policy, turnKey }) => {
            const disposition = acpClientExecuteDisposition(policy);
            if (
              disposition === "allow" ||
              (disposition === "ask" && clientPolicyGrants.allowsExecute(turnKey))
            ) {
              return Effect.void;
            }
            return denyClientRequest("terminal/create", disposition);
          }),
        );

        const wireAcpRuntimeTerminalHandlers = Effect.fnUntraced(function* (
          targetRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"],
          handlerGeneration: number,
        ) {
          if (clientTerminals === undefined) return;
          yield* targetRuntime.handleCreateTerminal((request) =>
            runtimeCallbackPermit.withPermit(
              Effect.gen(function* () {
                const turn = yield* Ref.get(activeTurn);
                if (
                  turn?.interrupted ||
                  (yield* Ref.get(stoppedRunQuarantine)) ||
                  handlerGeneration !== (yield* Ref.get(runtimeCallbackGeneration))
                ) {
                  return yield* EffectAcpErrors.AcpRequestError.internalError(
                    "The ACP turn has stopped.",
                  );
                }
                yield* guardClientTerminalCreate;
                const created = yield* clientTerminals.create(request);
                turn?.terminalCalls?.created(
                  request.sessionId,
                  created.terminalId,
                  request.command,
                  request.args,
                );
                clientTerminalGenerations.set(
                  sessionScopedId(request.sessionId, created.terminalId),
                  handlerGeneration,
                );
                notifyClientTerminalOutput(request.sessionId, created.terminalId);
                return created;
              }),
            ),
          );
          yield* targetRuntime.handleTerminalOutput(clientTerminals.output);
          yield* targetRuntime.handleTerminalWaitForExit(clientTerminals.waitForExit);
          yield* targetRuntime.handleTerminalKill(clientTerminals.kill);
          yield* targetRuntime.handleTerminalRelease((request) =>
            clientTerminals.release(request).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  (yield* Ref.get(activeTurn))?.terminalCalls?.released(request.terminalId);
                  notifyClientTerminalOutput(request.sessionId, request.terminalId);
                  clientTerminalGenerations.delete(
                    sessionScopedId(request.sessionId, request.terminalId),
                  );
                }),
              ),
            ),
          );
        });

        const wireAcpRuntimeMcpHandlers = Effect.fnUntraced(function* (
          targetRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"],
          mcpBridge: AcpMcpOverAcpBridge | undefined,
        ) {
          if (mcpBridge === undefined) return;
          const mapMcpBridgeError = Effect.mapError(
            (error: Error) =>
              new EffectAcpErrors.AcpRequestError({
                code: -32603,
                errorMessage: error.message,
                cause: error,
              }),
          );
          yield* targetRuntime.handleMcpConnect((request) =>
            mcpBridge.connect(request).pipe(mapMcpBridgeError),
          );
          yield* targetRuntime.handleMcpMessage((request) =>
            mcpBridge.message(request).pipe(mapMcpBridgeError),
          );
          yield* targetRuntime.handleMcpNotification((request) =>
            mcpBridge.notification(request).pipe(mapMcpBridgeError),
          );
          yield* targetRuntime.handleMcpDisconnect((request) =>
            mcpBridge.disconnect(request).pipe(mapMcpBridgeError),
          );
        });

        const wireAcpRuntimeHandlers = Effect.fnUntraced(function* (
          targetRuntime: AcpSessionRuntime.AcpSessionRuntime["Service"],
          handlerGeneration: number,
          handlerOptions: {
            readonly sessionUpdates?: boolean;
            readonly terminals?: boolean;
            readonly mcp?: boolean;
            // A rollback wires its replacement before adopting its scope; the old one closes after.
            readonly scope?: Scope.Scope;
          } = {},
        ) {
          yield* targetRuntime.getEvents().pipe(
            Stream.runForEach((event) => {
              if (event._tag === "EventStreamBarrier") {
                return Deferred.succeed(event.acknowledge, undefined).pipe(Effect.asVoid);
              }
              return runRuntimeCallbackAtGeneration(
                handlerGeneration,
                flavor.onSessionEvent?.(event, input.runtimePolicy.cwd ?? process.cwd()) ??
                  Effect.void,
              ).pipe(Effect.asVoid);
            }),
            Effect.forkIn(handlerOptions.scope ?? runtimeScope ?? sessionScope),
          );
          const requestUserInput = (
            request: AcpAdapterV2UserInputRequest,
            requestContext: EffectAcpProtocol.AcpRequestContext,
          ) =>
            requestUserInputWithAdmission(
              handlerGeneration,
              Effect.succeed(request),
              requestContext.requestId,
            );
          // Without the capability no fs handler is registered, so a stray
          // request (OpenCode and Kilo send one after approved edits) gets
          // method-not-found and cannot touch the disk. A flavor that opts in
          // serves requests itself, confined to the workspace of the policy
          // active when the request arrives; the agent asks before its edits.
          const clientFileSystem = flavor.clientFileSystem;
          if (clientFileSystem !== undefined) {
            yield* targetRuntime.handleReadTextFile((request) =>
              clientPolicyContext.pipe(
                Effect.flatMap(({ policy }) => clientFileSystem.readTextFile(request, policy.cwd)),
              ),
            );
            const writeTextFile = clientFileSystem.writeTextFile;
            if (writeTextFile !== undefined) {
              yield* targetRuntime.handleWriteTextFile((request) =>
                clientPolicyContext.pipe(
                  Effect.flatMap(({ policy }) => writeTextFile(request, policy.cwd)),
                ),
              );
            }
          }
          if (handlerOptions.mcp !== false) {
            yield* wireAcpRuntimeMcpHandlers(targetRuntime, runtimeMcpBridge);
          }
          if (handlerOptions.terminals !== false) {
            yield* wireAcpRuntimeTerminalHandlers(targetRuntime, handlerGeneration);
          }
          if (handlerOptions.sessionUpdates !== false) {
            yield* targetRuntime.handleSessionUpdate((rawNotification) =>
              projectAcpRuntimeSessionUpdate(handlerGeneration, rawNotification),
            );
          }
          yield* targetRuntime.handleRequestPermission((nativeParams, requestContext) =>
            Effect.gen(function* () {
              if (
                postSettleContinuationEnabled &&
                flavor.wakeOnDetachedRequest &&
                nativeParams.sessionId !== (yield* Ref.get(activeSessionId))
              ) {
                return { outcome: { outcome: "cancelled" } } as const;
              }
              // A request after the prompt ended waits for the continuation run it offers.
              if (!(yield* awaitRequestTurn(handlerGeneration)))
                return { outcome: { outcome: "cancelled" } } as const;
              const trackedTurn = yield* Ref.get(activeTurn);
              const params =
                trackedTurn !== null && nativeParams.sessionId === (yield* Ref.get(activeSessionId))
                  ? withTrackedPermissionToolCall(
                      nativeParams,
                      trackedTurn.tools.get(nativeParams.toolCall.toolCallId),
                    )
                  : nativeParams;
              const transportRequestId = requestContext.requestId;
              const permissionQuestion = flavor.extractPermissionQuestion?.(params);
              if (permissionQuestion !== undefined) {
                const userInput = yield* requestUserInputWithAdmission(
                  handlerGeneration,
                  Effect.succeed({
                    nativeItemId: `${params.sessionId}:question:${params.toolCall.toolCallId}`,
                    nativeMethod: "session/request_permission",
                    nativeRequestId: params.toolCall.toolCallId,
                    nativeSessionId: params.sessionId,
                    questions: [permissionQuestion.question],
                  }),
                  transportRequestId,
                );
                const response =
                  userInput.answers === null
                    ? undefined
                    : permissionQuestion.respond(userInput.answers);
                yield* userInput.acknowledgeNativeResponse;
                return response ?? ({ outcome: { outcome: "cancelled" } } as const);
              }
              const admitted = yield* runRuntimeCallbackAtGeneration(
                handlerGeneration,
                Effect.gen(function* () {
                  const context = yield* activeContext;
                  const disposition = (flavor.permissionDisposition ?? acpPermissionDisposition)(
                    context.input.runtimePolicy,
                    params,
                  );
                  if (disposition === "allow") {
                    const optionId = selectAutoApprovedPermissionOption(params);
                    return {
                      _tag: "Immediate" as const,
                      response:
                        optionId === undefined
                          ? ({ outcome: { outcome: "cancelled" } } as const)
                          : ({ outcome: { outcome: "selected", optionId } } as const),
                    };
                  }
                  if (disposition === "deny") {
                    const optionId = selectPermissionOptionId(params, "decline");
                    return {
                      _tag: "Immediate" as const,
                      response:
                        optionId === undefined
                          ? ({ outcome: { outcome: "cancelled" } } as const)
                          : ({ outcome: { outcome: "selected", optionId } } as const),
                    };
                  }
                  return {
                    _tag: "Pending" as const,
                    pending: yield* beginApprovalRequest(
                      context,
                      params,
                      handlerGeneration,
                      transportRequestId,
                    ),
                  };
                }),
              );
              if (Option.isNone(admitted)) {
                return yield* Effect.never;
              }
              if (admitted.value._tag === "Immediate") {
                const response = admitted.value.response;
                const checked = yield* runRuntimeCallbackAtGeneration(
                  handlerGeneration,
                  Effect.gen(function* () {
                    const nativeResponseAcknowledgement = yield* Deferred.make<
                      void,
                      EffectAcpErrors.AcpError
                    >();
                    yield* registerNativeResponseAcknowledgement(
                      handlerGeneration,
                      transportRequestId,
                      nativeResponseAcknowledgement,
                    );
                    return response;
                  }),
                );
                return Option.isSome(checked) ? checked.value : yield* Effect.never;
              }
              const {
                context,
                decision: pendingDecision,
                requestId,
                transportRequestId: pendingTransportRequestId,
              } = admitted.value.pending;
              const parsedPermission = parsePermissionRequest(params);
              const decision = yield* Deferred.await(pendingDecision).pipe(
                Effect.ensuring(
                  runRuntimeCallbackAtGeneration(
                    handlerGeneration,
                    Effect.gen(function* () {
                      yield* Ref.update(pendingRuntimeRequests, (current) => {
                        const updated = new Map(current);
                        updated.delete(String(requestId));
                        return updated;
                      });
                    }),
                  ).pipe(Effect.asVoid),
                ),
              );
              if (decision === "accept" || decision === "acceptForSession") {
                clientPolicyGrants.recordApproval({
                  toolKind: parsedPermission.kind,
                  scope: decision === "acceptForSession" ? "session" : "turn",
                  turnKey: String(context.providerTurnId),
                });
              }
              const response = (() => {
                if (decision === "cancel") {
                  return { outcome: { outcome: "cancelled" } } as const;
                }
                const optionId = selectPermissionOptionId(params, decision);
                return optionId === undefined
                  ? ({ outcome: { outcome: "cancelled" } } as const)
                  : ({ outcome: { outcome: "selected", optionId } } as const);
              })();
              const checked = yield* runRuntimeCallbackAtGeneration(
                handlerGeneration,
                Effect.succeed(response),
              );
              if (Option.isNone(checked)) return yield* Effect.never;
              yield* acknowledgeNativeResponse(handlerGeneration, pendingTransportRequestId);
              return checked.value;
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new EffectAcpErrors.AcpTransportError({
                    detail: "Failed to handle an ACP permission request",
                    cause,
                  }),
              ),
              holdingAgentRequest(handlerGeneration),
            ),
          );
          yield* targetRuntime.handleElicitation((params, requestContext) =>
            Effect.gen(function* () {
              const transportRequestId = requestContext.requestId;
              if (
                params.mode === "form" &&
                (unknownRecord(params._meta)?.codex_approval_kind === "mcp_tool_call" ||
                  transportRequestId.startsWith("mcp_tool_call_approval_"))
              ) {
                const mcpApprovalDisposition = yield* runRuntimeCallbackAtGeneration(
                  handlerGeneration,
                  Effect.gen(function* () {
                    const context = yield* activeContext;
                    const disposition = acpMcpToolApprovalElicitationDisposition(
                      context.input.runtimePolicy,
                      params,
                      transportRequestId,
                    );
                    if (disposition === undefined || disposition === "ask") {
                      return disposition;
                    }
                    const nativeResponseAcknowledgement = yield* Deferred.make<
                      void,
                      EffectAcpErrors.AcpError
                    >();
                    yield* registerNativeResponseAcknowledgement(
                      handlerGeneration,
                      transportRequestId,
                      nativeResponseAcknowledgement,
                    );
                    return disposition;
                  }),
                );
                if (Option.isNone(mcpApprovalDisposition)) return yield* Effect.never;
                if (mcpApprovalDisposition.value === "allow") {
                  return { action: "accept", content: {} } as const;
                }
                if (mcpApprovalDisposition.value === "deny") {
                  return { action: "decline" } as const;
                }
              }
              if (
                params.mode === "url" &&
                "url" in params &&
                typeof params.url === "string" &&
                "elicitationId" in params &&
                typeof params.elicitationId === "string"
              ) {
                const { elicitationId, url } = params;
                const admitted = yield* runRuntimeCallbackAtGeneration(
                  handlerGeneration,
                  Effect.gen(function* () {
                    const nativeResponseAcknowledgement = yield* Deferred.make<
                      void,
                      EffectAcpErrors.AcpError
                    >();
                    yield* registerNativeResponseAcknowledgement(
                      handlerGeneration,
                      transportRequestId,
                      nativeResponseAcknowledgement,
                    );
                    const accepted = yield* (
                      flavor.onUrlElicitation?.({
                        elicitationId,
                        url,
                        message: params.message,
                      }) ?? Effect.succeed(false)
                    );
                    return accepted
                      ? ({ action: "accept" } as const)
                      : ({ action: "decline" } as const);
                  }),
                );
                if (Option.isNone(admitted)) return yield* Effect.never;
                return admitted.value;
              }
              if (params.mode !== "form" || !("requestedSchema" in params)) {
                // Future elicitation modes beyond form and url decline rather
                // than guessing at their semantics.
                return { action: "decline" } as const;
              }
              const parsedForm = parseElicitationForm(params.requestedSchema, params.message, {
                useFieldTitleAsQuestion: flavor.useElicitationFieldTitleAsQuestion === true,
              });
              if (parsedForm === undefined) return { action: "decline" } as const;
              const elicitationScopeId =
                "sessionId" in params ? params.sessionId : `request:${params.requestId}`;
              const userInput = yield* requestUserInputWithAdmission(
                handlerGeneration,
                Effect.gen(function* () {
                  const ordinal = yield* Ref.getAndUpdate(
                    nextElicitationOrdinal,
                    (current) => current + 1,
                  );
                  const nativeRequestId = `${elicitationScopeId}:elicitation:${ordinal}`;
                  return {
                    nativeItemId: nativeRequestId,
                    nativeRequestId,
                    questions: parsedForm.questions,
                  };
                }),
                transportRequestId,
              );
              const content =
                userInput.answers === null ? undefined : parsedForm.content(userInput.answers);
              const response =
                content === undefined
                  ? ({ action: "cancel" } as const)
                  : ({ action: "accept", content } as const);
              yield* userInput.acknowledgeNativeResponse;
              return response;
            }),
          );
          if (flavor.registerExtensions !== undefined) {
            yield* flavor.registerExtensions({
              runtime: targetRuntime,
              reportProviderRetry: (notice) =>
                runRuntimeCallbackAtGeneration(handlerGeneration, reportProviderRetry(notice)).pipe(
                  Effect.asVoid,
                ),
              requestUserInput,
              captureProposedPlan,
              lastProposedPlanMarkdown,
              finishSubagent: (notice) =>
                runRuntimeCallbackAtGeneration(
                  handlerGeneration,
                  Effect.gen(function* () {
                    if (yield* Ref.get(stoppedRunQuarantine)) return;
                    // Root-session notices only; nested subagents report to
                    // their own parent session.
                    if ((yield* Ref.get(activeSessionId)) !== notice.sessionId) return;
                    yield* finishSubagentFromNotice(notice);
                  }),
                ).pipe(Effect.asVoid),
              applyBackgroundTaskMutation: (mutation) =>
                runRuntimeCallbackAtGeneration(
                  handlerGeneration,
                  Effect.gen(function* () {
                    // Direct Stop quarantine: drop residual task lifecycle from
                    // the stopped run instead of mutating wake machinery.
                    if (yield* Ref.get(stoppedRunQuarantine)) return;
                    // Root-session tasks only: a cancelled subagent's re-run in
                    // its child session must not gate root wake machinery.
                    if ((yield* Ref.get(activeSessionId)) !== mutation.sessionId) return;
                    if (
                      mutation.status !== "running" &&
                      mutation.report !== undefined &&
                      !(yield* Ref.get(handledBackgroundTaskIdsInActiveTurn)).has(mutation.taskId)
                    ) {
                      yield* recordWakeReport(mutation.taskId, {
                        ...mutation.report,
                        outcome: mutation.status,
                      });
                    }
                    yield* applyLateBackgroundMutation(mutation.sessionId, mutation);
                    if (mutation.status !== "running") {
                      yield* finishRegisteredBackgroundTool({
                        taskId: mutation.taskId,
                        status: mutation.status,
                        ...(mutation.output === undefined ? {} : { output: mutation.output }),
                      });
                    }
                  }),
                ).pipe(Effect.asVoid),
            });
          }
        });

        /** Builds the MCP-over-ACP bridge for one runtime, disposed with that runtime's scope. */
        const makeRuntimeMcpBridge = Effect.fnUntraced(function* (
          mcpContext: AcpMcpContext,
          scope: Scope.Scope,
        ) {
          if (mcpContext.endpoint === undefined || mcpContext.authorization === undefined) {
            return undefined;
          }
          const mcpBridge = yield* makeAcpMcpOverAcpBridge({
            endpoint: mcpContext.endpoint,
            authorization: mcpContext.authorization,
            allocateConnectionId: crypto.randomUUIDv4().pipe(Effect.orDie),
          });
          yield* Scope.addFinalizer(scope, mcpBridge.dispose);
          return mcpBridge;
        });

        const spawnAcpRuntime = Effect.fnUntraced(function* (
          threadId: ThreadId | null,
          resumeSessionId?: string,
        ) {
          if (runtimeScope !== undefined) {
            yield* Scope.close(runtimeScope, Exit.void);
          }
          runtimeScope = yield* Scope.make();
          const mcpContext = yield* readMcpContext(threadId);
          runtimeMcpBridge = yield* makeRuntimeMcpBridge(mcpContext, runtimeScope);
          const runtimeGeneration = yield* Ref.get(runtimeCallbackGeneration);
          openAgentRequests = new Set();
          runtime = yield* flavor
            .makeRuntime(
              makeRuntimeInput(runtimeGeneration, openAgentRequests, mcpContext, resumeSessionId),
            )
            .pipe(
              Effect.provideService(Scope.Scope, runtimeScope),
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
              Effect.provideService(AgentScope, agentScope),
              Effect.provideService(AgentScopeThreadId, threadId ?? undefined),
            );
        });

        const startAcpRuntime = Effect.fnUntraced(function* (
          threadId: ThreadId | null,
          resumeSessionId?: string,
        ) {
          if (resumeSessionId !== undefined) yield* Ref.set(loadingSessionId, resumeSessionId);
          const startup = Effect.gen(function* () {
            yield* spawnAcpRuntime(threadId, resumeSessionId);
            yield* wireAcpRuntimeHandlers(runtime, yield* Ref.get(runtimeCallbackGeneration));
            return yield* runtime.start();
          });
          return yield* (flavor.withRuntimeStartup?.(startup) ?? startup).pipe(
            Effect.onError(() => Ref.set(loadingSessionId, null)),
          );
        });

        const restartAcpRuntime = Effect.fnUntraced(function* (threadId: ThreadId | null) {
          yield* spawnAcpRuntime(threadId);
          yield* wireAcpRuntimeHandlers(runtime, yield* Ref.get(runtimeCallbackGeneration));
        });

        const startReplacementAcpRuntime = Effect.fnUntraced(function* (
          threadId: ThreadId | null,
          commitSessionState: (
            replacement: AcpSessionRuntime.AcpSessionRuntimeStartResult,
          ) => Effect.Effect<void>,
        ) {
          const previousScope = runtimeScope;
          const previousGeneration = yield* Ref.get(runtimeCallbackGeneration);
          yield* runtimeCallbackPermit.withPermit(awaitAdmittedNativeResponses);

          // Keep the original generation active until the candidate has
          // completed session startup. A failed candidate therefore cannot
          // suppress termination or background callbacks from the live session.
          const replacementGeneration = yield* allocateRuntimeCallbackGeneration;
          const replacementScope = yield* Scope.make();
          const replacementAgentRequests = new Set<string>();
          type CandidateLifecycle =
            | { readonly _tag: "Starting" }
            | { readonly _tag: "Terminated"; readonly error: EffectAcpErrors.AcpError }
            | { readonly _tag: "Committed" };
          const candidateLifecycle = yield* Ref.make<CandidateLifecycle>({ _tag: "Starting" });
          const handleCandidateTermination: AcpAdapterV2RuntimeInput["onTermination"] = (error) =>
            Ref.modify(
              candidateLifecycle,
              (current): readonly [Effect.Effect<void>, CandidateLifecycle] => {
                if (current._tag === "Committed") {
                  return [
                    handleRuntimeTerminationAtGeneration(replacementGeneration, error),
                    current,
                  ];
                }
                return [
                  Effect.void,
                  current._tag === "Terminated"
                    ? current
                    : ({ _tag: "Terminated", error } as const),
                ];
              },
            ).pipe(Effect.flatten);
          const stagedSessionUpdates: Array<EffectAcpSchema.SessionNotification> = [];
          let handleCandidateSessionUpdate: (
            notification: EffectAcpSchema.SessionNotification,
          ) => Effect.Effect<void, EffectAcpErrors.AcpError> = (notification) =>
            Effect.sync(() => {
              stagedSessionUpdates.push(notification);
            });
          let replacementMcpBridge: AcpMcpOverAcpBridge | undefined;
          const startup = Effect.gen(function* () {
            const mcpContext = yield* readMcpContext(threadId);
            replacementMcpBridge = yield* makeRuntimeMcpBridge(mcpContext, replacementScope);
            const replacementRuntime = yield* flavor
              .makeRuntime(
                makeRuntimeInput(
                  replacementGeneration,
                  replacementAgentRequests,
                  mcpContext,
                  undefined,
                  handleCandidateTermination,
                ),
              )
              .pipe(
                Effect.provideService(Scope.Scope, replacementScope),
                Effect.provideService(Crypto.Crypto, crypto),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                Effect.provideService(AgentScope, agentScope),
                Effect.provideService(AgentScopeThreadId, threadId ?? undefined),
              );
            // Session setup may publish commands before it returns. Buffer those
            // notifications, but do not expose request or extension handlers
            // until the candidate generation has committed.
            yield* replacementRuntime.handleSessionUpdate((notification) =>
              Effect.suspend(() => handleCandidateSessionUpdate(notification)),
            );
            yield* wireAcpRuntimeMcpHandlers(replacementRuntime, replacementMcpBridge);
            const started = yield* replacementRuntime.start();
            return { replacementRuntime, started };
          });
          const replacementExit = yield* Effect.exit(
            (flavor.withRuntimeStartup?.(startup) ?? startup).pipe(
              Effect.onInterrupt(() =>
                Scope.close(replacementScope, Exit.void).pipe(Effect.ignore),
              ),
            ),
          );
          if (Exit.isFailure(replacementExit)) {
            yield* runtimeCallbackPermit.withPermit(
              quarantineNativeTransportAtGeneration(replacementGeneration),
            );
            yield* Scope.close(replacementScope, Exit.void).pipe(Effect.ignore);
            return yield* Effect.failCause(replacementExit.cause);
          }

          yield* runtimeCallbackPermit
            .withPermit(
              Effect.uninterruptible(
                Effect.gen(function* () {
                  yield* awaitAdmittedNativeResponses;
                  // Session updates and MCP were wired during candidate startup
                  // (against its own bridge); terminals attach after commit below.
                  yield* wireAcpRuntimeHandlers(
                    replacementExit.value.replacementRuntime,
                    replacementGeneration,
                    {
                      sessionUpdates: false,
                      terminals: false,
                      mcp: false,
                      scope: replacementScope,
                    },
                  );
                  const lifecycle = yield* Ref.modify(
                    candidateLifecycle,
                    (current): readonly [CandidateLifecycle, CandidateLifecycle] =>
                      current._tag === "Terminated"
                        ? [current, current]
                        : [{ _tag: "Committed" }, { _tag: "Committed" }],
                  );
                  if (lifecycle._tag === "Terminated") {
                    return yield* lifecycle.error;
                  }
                  yield* quarantineNativeTransportAtGeneration(previousGeneration);
                  runtime = replacementExit.value.replacementRuntime;
                  runtimeScope = replacementScope;
                  runtimeMcpBridge = replacementMcpBridge;
                  openAgentRequests = replacementAgentRequests;
                  yield* Ref.set(runtimeCallbackGeneration, replacementGeneration);
                  prepareTerminalEnvironment(
                    yield* readMcpContext(threadId),
                    replacementExit.value.started.sessionId,
                  );
                  yield* wireAcpRuntimeTerminalHandlers(
                    replacementExit.value.replacementRuntime,
                    replacementGeneration,
                  );
                  yield* commitSessionState(replacementExit.value.started);
                  while (true) {
                    const buffered = stagedSessionUpdates.splice(0, stagedSessionUpdates.length);
                    if (buffered.length === 0) {
                      handleCandidateSessionUpdate = (notification) =>
                        projectAcpRuntimeSessionUpdate(replacementGeneration, notification);
                      break;
                    }
                    yield* Effect.forEach(
                      buffered,
                      (notification) =>
                        projectAcpRuntimeSessionUpdateEffect(notification).pipe(
                          Effect.catchCause((cause) =>
                            Effect.logError("failed to replay staged ACP session update", {
                              driver,
                              cause,
                            }),
                          ),
                        ),
                      { discard: true },
                    );
                  }
                  yield* cancelPendingRuntimeRequests();
                  if (previousScope !== undefined) {
                    yield* Scope.close(previousScope, Exit.void).pipe(
                      Effect.catchCause((cause) =>
                        Effect.logError("failed to close replaced ACP runtime scope", {
                          driver,
                          cause,
                        }),
                      ),
                    );
                  }
                }),
              ),
            )
            .pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Ref.get(candidateLifecycle).pipe(
                      Effect.flatMap((lifecycle) =>
                        lifecycle._tag === "Committed"
                          ? Effect.void
                          : Scope.close(replacementScope, Exit.void).pipe(Effect.ignore),
                      ),
                    )
                  : Effect.void,
              ),
            );
          return replacementExit.value.started;
        });

        const initialStart = yield* Effect.result(
          startAcpRuntime(input.threadId, input.initialNativeThreadId),
        );
        const started = Result.isSuccess(initialStart)
          ? initialStart.success
          : yield* Effect.gen(function* () {
              const failedMethod =
                "method" in initialStart.failure ? initialStart.failure.method : undefined;
              if (
                input.initialNativeThreadId === undefined ||
                (failedMethod !== "session/load" && failedMethod !== "session/resume")
              ) {
                return yield* initialStart.failure;
              }
              yield* Ref.set(initialSessionActivationFailure, {
                sessionId: input.initialNativeThreadId,
                error: initialStart.failure,
              });
              itemIdentityVersion = 2;
              yield* Ref.set(runtimeRestartRequired, false);
              prepareClaimableTerminalEnvironment(yield* readMcpContext(input.threadId));
              return yield* startAcpRuntime(input.threadId);
            });
        yield* Ref.set(activeSessionId, started.sessionId);
        yield* Ref.set(loadingSessionId, null);
        yield* Ref.set(activeSessionSetup, started);
        rememberTerminalEnvironment(started.sessionId, yield* readMcpContext(input.threadId));
        const readApprovalModes = Effect.gen(function* () {
          if (flavor.sessionModeForPolicy !== undefined) return null;
          return findAcpApprovalModes(
            acpProviderOptionDescriptors({
              configOptions: yield* runtime.getConfigOptions,
              modeState: yield* runtime.getModeState,
            }),
          );
        });
        const setAcpMode = Effect.fnUntraced(function* (id: string, value: string) {
          const config = (yield* runtime.getConfigOptions).find((option) => option.id === id);
          if (config && config.category !== "mode") {
            yield* runtime.setConfigOption(id, value);
          } else {
            yield* runtime.setMode(value);
          }
        });
        const baseCapabilities = negotiatedCapabilities(flavor.capabilities, started, flavor);
        const supportsAcpApprovalModes = (yield* readApprovalModes) !== null;
        const capabilities = supportsAcpApprovalModes
          ? {
              ...baseCapabilities,
              sessions: {
                ...baseCapabilities.sessions,
                supportsRuntimeModeSwitchInSession: true,
                appliesRuntimeModeChangesImmediately: true,
              },
            }
          : baseCapabilities;
        const steersWithPrompt = flavor.steersWithPrompt?.(started.initializeResult) === true;
        const canLoadSession = started.initializeResult.agentCapabilities?.loadSession === true;
        const canResumeSession =
          started.initializeResult.agentCapabilities?.sessionCapabilities?.resume != null;
        const supportsImagePrompts = acpSupportsImagePrompts({
          flavorSupportsImagePrompts: flavor.supportsImagePrompts,
          negotiatedImage:
            started.initializeResult.agentCapabilities?.promptCapabilities?.image === true,
        });

        const activateSession = Effect.fnUntraced(function* (
          sessionId: string,
          threadId: ThreadId | null,
        ) {
          const initialFailure = yield* Ref.modify(initialSessionActivationFailure, (failure) =>
            failure?.sessionId === sessionId ? [failure.error, null] : [undefined, failure],
          );
          if (initialFailure !== undefined) {
            return yield* initialFailure;
          }
          const mcpContext = yield* readMcpContext(threadId);
          const activationOptions = acpMcpActivation(mcpContext);
          prepareTerminalEnvironment(mcpContext, sessionId);
          yield* Ref.set(loadingSessionId, sessionId);
          const activated = yield* Effect.gen(function* () {
            return flavor.preferResumeSession === true && canResumeSession
              ? yield* runtime.resumeSession(sessionId, activationOptions)
              : canLoadSession
                ? yield* runtime.loadSession(sessionId, activationOptions)
                : canResumeSession
                  ? yield* runtime.resumeSession(sessionId, activationOptions)
                  : yield* new ProviderAdapter.ProviderAdapterProtocolError({
                      driver,
                      detail: `ACP driver cannot load or resume session ${sessionId}`,
                    });
          }).pipe(Effect.onError(() => Ref.set(loadingSessionId, null)));
          rememberTerminalEnvironment(activated.sessionId, yield* readMcpContext(threadId));
          return activated;
        });

        const validateModelSelection = Effect.fn("AcpAdapterV2.validateModelSelection")(function* (
          modelSelection: ModelSelection,
        ) {
          const model = flavor.resolveModelId?.(modelSelection) ?? modelSelection.model;
          if (
            flavor.applyModelSelection !== undefined ||
            model.length === 0 ||
            model === "default" ||
            model === "auto" ||
            flavor.customModels?.includes(model) === true
          )
            return;
          const option = findModelConfigOption(yield* runtime.getConfigOptions);
          const models = (yield* Ref.get(activeSessionSetup))?.sessionSetupResult.models;
          const available =
            option?.type === "select"
              ? flattenSelectChoices(option.options).some((choice) => choice.value === model)
              : models?.availableModels.some((choice) => choice.modelId === model);
          if (available === false) {
            return yield* new AcpModelSelectionError({
              model: modelSelection.model,
              cause: EffectAcpErrors.AcpRequestError.invalidParams(
                "The requested model is not available in this session.",
              ),
            });
          }
        });

        const configureSession = Effect.fnUntraced(function* (
          startResult: AcpSessionRuntime.AcpSessionRuntimeStartResult,
          modelSelection: ModelSelection,
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
        ) {
          // A step failing below leaves the native config partly changed, so
          // the previously applied selection no longer describes the session.
          // Callers record the new selection only once this completes.
          yield* Ref.set(activeSelection, null);
          configuredAcpMode = null;
          yield* validateModelSelection(modelSelection);
          const requestedModel = flavor.resolveModelId?.(modelSelection) ?? modelSelection.model;
          const rejectedModel = (error: EffectAcpErrors.AcpError) =>
            error._tag === "AcpRequestError" && error.code === -32602
              ? new AcpModelSelectionError({ model: modelSelection.model, cause: error })
              : error;
          let appliedModel: string | undefined;
          if (flavor.applyModelSelection !== undefined) {
            appliedModel = yield* flavor
              .applyModelSelection({
                runtime,
                startResult,
                modelSelection,
              })
              .pipe(Effect.mapError(rejectedModel));
          } else if (requestedModel.length > 0) {
            // Stored catalog choices can expire; explicitly configured custom IDs
            // are validated by the agent instead.
            const isCustomModel = flavor.customModels?.includes(requestedModel) === true;
            const modelOption = findModelConfigOption(yield* runtime.getConfigOptions);
            const modelState = startResult.sessionSetupResult.models;
            if (modelOption?.type === "select") {
              if (
                isCustomModel ||
                flattenSelectChoices(modelOption.options).some(
                  (choice) => choice.value === requestedModel,
                )
              ) {
                yield* runtime
                  .setConfigOption(modelOption.id, requestedModel)
                  .pipe(Effect.mapError(rejectedModel));
                appliedModel = requestedModel;
              }
            } else if (
              modelState != null &&
              (isCustomModel ||
                modelState.availableModels.some((model) => model.modelId === requestedModel))
            ) {
              if (modelState.currentModelId !== requestedModel) {
                yield* runtime.setSessionModel(requestedModel).pipe(Effect.mapError(rejectedModel));
              }
              appliedModel = requestedModel;
            }
          }
          // Same-runtime switches compare against this stored setup, so keep
          // its model metadata in sync with what the session now runs on;
          // otherwise switching A -> B -> A would see the stale setup-time A
          // and skip the final switch.
          if (appliedModel !== undefined) {
            const applied = appliedModel;
            yield* Ref.update(activeSessionSetup, (setup) => {
              if (setup === null) {
                return setup;
              }
              const models = setup.sessionSetupResult.models;
              if (models == null || models.currentModelId === applied) {
                return setup;
              }
              return {
                ...setup,
                sessionSetupResult: {
                  ...setup.sessionSetupResult,
                  models: { ...models, currentModelId: applied },
                },
              };
            });
          }
          // Restore the agent's own empty value for choices T3 stores under a
          // reserved ID (see ACP_EMPTY_OPTION_VALUE).
          const optionSelections = (modelSelection.options ?? [])
            .filter((selection) => !flavor.ownedModelOptionIds?.includes(selection.id))
            .map((selection) =>
              selection.value === ACP_EMPTY_OPTION_VALUE ? { ...selection, value: "" } : selection,
            );
          const configOptions = yield* runtime.getConfigOptions;
          const modeState = yield* runtime.getModeState;
          const approvalModes = yield* readApprovalModes;
          const availableConfigIds = new Set(configOptions.map((option) => option.id));
          const hasNativeConfigWithSyntheticModeId = availableConfigIds.has(
            ACP_SESSION_MODE_OPTION_ID,
          );
          const modeSelection = hasNativeConfigWithSyntheticModeId
            ? undefined
            : optionSelections.find((selection) => selection.id === ACP_SESSION_MODE_OPTION_ID);
          const configSelections = hasNativeConfigWithSyntheticModeId
            ? optionSelections
            : optionSelections.filter((selection) => selection.id !== ACP_SESSION_MODE_OPTION_ID);
          // Probe-time descriptors are a per-model union, so a stored
          // selection can reference an option the live session does not
          // expose (Kilo advertises per-model "effort" descriptors while its
          // session config omits them). Failing the open here wedges the run
          // in a retry loop; skip like the out-of-range values below and let
          // the agent default apply.
          const unsupportedConfigIds = configSelections
            .map((selection) => selection.id)
            .filter((id) => !availableConfigIds.has(id));
          if (unsupportedConfigIds.length > 0) {
            yield* Effect.logWarning(
              "ACP session does not expose requested configuration option(s)",
              {
                driver,
                sessionId: startResult.sessionId,
                optionIds: unsupportedConfigIds,
              },
            );
          }
          for (const selection of configSelections) {
            if (
              !availableConfigIds.has(selection.id) ||
              selection.id === approvalModes?.descriptor.id
            )
              continue;
            // Tuning knobs degrade instead of failing the session open: agents
            // advertise the union of values across models but can reject a
            // per-model invalid one at set time (codex-acp advertises "ultra"
            // reasoning effort and then rejects it for most models). Skip
            // values the session does not currently offer and downgrade an
            // agent-side set rejection to a warning; the agent's default
            // applies for that option.
            const option = configOptions.find((candidate) => candidate.id === selection.id);
            if (
              option !== undefined &&
              option.type === "select" &&
              typeof selection.value === "string"
            ) {
              const advertisedValues = option.options.flatMap((entry) =>
                "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
              );
              if (!advertisedValues.includes(selection.value)) continue;
            }
            yield* runtime.setConfigOption(selection.id, selection.value).pipe(
              Effect.catchTags({
                AcpRequestError: (error) =>
                  error.code === -32602
                    ? Effect.logWarning("ACP session rejected a configuration option value", {
                        optionId: selection.id,
                        value: selection.value,
                        detail: error.message,
                      })
                    : Effect.fail(error),
              }),
            );
          }
          const policyMode = flavor.sessionModeForPolicy?.(runtimePolicy);
          if (policyMode !== undefined) {
            yield* runtime.setMode(policyMode);
          }
          // The synthetic mode selection is skipped rather than failed when the
          // agent no longer advertises it: mode sets are volatile across agent
          // versions and a stale persisted mode should not block the turn.
          if (
            approvalModes === null &&
            modeSelection !== undefined &&
            typeof modeSelection.value === "string" &&
            modeState?.availableModes.some((mode) => mode.id === modeSelection.value) === true &&
            modeState.currentModeId !== modeSelection.value
          ) {
            yield* runtime.setMode(modeSelection.value);
          }
          if (approvalModes !== null) {
            const { descriptor, approvals, workModes, plan } = approvalModes;
            const saved = optionSelections.find(
              (selection) => selection.id === descriptor.id,
            )?.value;
            const work = workModes.find((choice) => choice.id === saved && choice !== workModes[0]);
            const choice =
              (runtimePolicy.interactionMode === "plan" ? plan : undefined) ??
              work ??
              approvals[runtimePolicy.runtimeMode] ??
              Object.values(approvals).find((candidate) => candidate.id === saved) ??
              approvals["approval-required"]!;
            if (descriptor.currentValue !== choice.id) {
              yield* setAcpMode(descriptor.id, choice.id);
            }
            const reported = yield* readApprovalModes;
            configuredAcpMode = {
              value: reported?.descriptor.currentValue ?? choice.id,
              runtimeMode: runtimePolicy.runtimeMode,
            };
          }
          const effectiveModeState = yield* runtime.getModeState;
          const effectiveConfigOptions = yield* runtime.getConfigOptions;
          const planSensitiveOptions = effectiveConfigOptions.filter(
            (
              option,
            ): option is Extract<
              EffectAcpSchema.SessionConfigOption,
              { readonly type: "select" }
            > =>
              option.type === "select" &&
              option.id !== approvalModes?.descriptor.id &&
              (option.category === "mode" || option.category === "collaboration_mode"),
          );
          if (runtimePolicy.interactionMode === "plan") {
            if (!nativeBuildConfigurationBySessionId.has(startResult.sessionId)) {
              nativeBuildConfigurationBySessionId.set(startResult.sessionId, {
                ...(effectiveModeState === undefined || approvalModes !== null
                  ? {}
                  : { modeId: effectiveModeState.currentModeId }),
                configOptions: planSensitiveOptions.map((option) => ({
                  id: option.id,
                  value: option.currentValue,
                })),
              });
            }
            const planMode = effectiveModeState?.availableModes.find(
              (mode) => mode.id === "plan" || mode.id === "architect",
            );
            if (
              approvalModes === null &&
              planMode !== undefined &&
              effectiveModeState?.currentModeId !== planMode.id
            ) {
              yield* runtime.setMode(planMode.id);
            }
            for (const option of planSensitiveOptions) {
              const choices = option.options.flatMap((entry) =>
                "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
              );
              const requested = choices.find(
                (choice) => choice === "plan" || choice === "architect",
              );
              if (requested !== undefined && option.currentValue !== requested) {
                yield* runtime.setConfigOption(option.id, requested);
              }
            }
          } else {
            const nativeBuild = nativeBuildConfigurationBySessionId.get(startResult.sessionId);
            if (nativeBuild !== undefined) {
              if (
                nativeBuild.modeId !== undefined &&
                effectiveModeState?.currentModeId !== nativeBuild.modeId &&
                effectiveModeState?.availableModes.some(
                  (mode) => mode.id === nativeBuild.modeId,
                ) === true
              ) {
                yield* runtime.setMode(nativeBuild.modeId);
              }
              for (const saved of nativeBuild.configOptions) {
                const option = effectiveConfigOptions.find(
                  (candidate) => candidate.type === "select" && candidate.id === saved.id,
                );
                if (option === undefined || option.type !== "select") continue;
                const choices = option.options.flatMap((entry) =>
                  "value" in entry ? [entry.value] : entry.options.map((choice) => choice.value),
                );
                if (option.currentValue !== saved.value && choices.includes(saved.value)) {
                  yield* runtime.setConfigOption(option.id, saved.value);
                }
              }
              nativeBuildConfigurationBySessionId.delete(startResult.sessionId);
            }
          }
          yield* validateModelSelection(modelSelection);
          yield* (
            flavor.onSessionConfigurationUpdate?.(
              yield* runtime.getConfigOptions,
              yield* runtime.getModeState,
              (yield* activeModelState) ?? startResult.sessionSetupResult.models ?? undefined,
            ) ?? Effect.void
          );
        });

        yield* configureSession(started, input.modelSelection, input.runtimePolicy);
        yield* Ref.set(activeSelection, input.modelSelection);
        yield* Ref.set(activeInteractionMode, input.runtimePolicy.interactionMode);
        const createdAt = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: input.providerSessionId,
          driver,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd: input.runtimePolicy.cwd ?? process.cwd(),
          model: input.modelSelection.model,
          capabilities,
          createdAt,
          updatedAt: createdAt,
          lastError: null,
        };

        const providerTurnPayload = (
          context: ActiveAcpTurn,
          status: OrchestrationV2ProviderTurn["status"],
          completedAt: DateTime.Utc | null,
        ): OrchestrationV2ProviderTurn => {
          const isRunning = status === "running" || status === "pending";
          const tokenUsage = acpProviderTurnTokenUsage(
            context.turnTokenUsage,
            context.contextUsage,
            isRunning ? undefined : context.promptUsage,
            flavor.extractContextUsage ? undefined : context.promptUsage?.totalTokens,
            completedAt ?? context.startedAt,
          );
          const generation = generationSnapshot(context.generation);
          return {
            id: context.providerTurnId,
            providerThreadId: context.input.providerThread.id,
            nodeId: context.input.rootNodeId,
            runAttemptId: context.input.attemptId,
            nativeTurnRef: {
              driver,
              nativeId: context.nativeTurnId,
              strength: "weak",
            },
            ordinal: context.input.providerTurnOrdinal,
            status,
            startedAt: context.startedAt,
            completedAt,
            ...(tokenUsage === undefined ? {} : { tokenUsage }),
            ...(generation === undefined ? {} : { generation }),
            ...(isRunning
              ? {}
              : {
                  // The prompt tap only captures usage for flavors that declared
                  // per-turn counters, so undeclared agents stay unavailable here.
                  turnTokenUsage: acpPerTurnPromptUsage(
                    context.promptUsage,
                    context.subagents.size > 0,
                    status,
                  ),
                }),
          };
        };

        const terminalizeOpenRunOwnedItems = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          options: {
            readonly terminalizeSubagents: boolean;
            readonly status?: "interrupted" | "failed";
          },
        ) {
          for (const tool of context.tools.values()) {
            const status = toolStatus(tool.status);
            if (status === "pending" || status === "running" || status === "waiting") {
              yield* emitTool(context, tool, options.status ?? "interrupted");
            }
          }
          if (!options.terminalizeSubagents) return;
          for (const subagent of context.subagents.values()) {
            if (subagent.task.status !== "running" && subagent.task.status !== "pending") {
              continue;
            }
            yield* emitSubagent(context, {
              nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id,
              prompt: subagent.task.prompt,
              title: subagent.task.title,
              model: subagent.task.model,
              status: options.status ?? "interrupted",
              childSessionId: subagent.childSessionId,
              result: subagent.task.result,
              suppressNormalTool: true,
            });
          }
        });

        const idleErrorFailure = (error: EffectAcpSchema.PromptResponse["error"]) => {
          if (error == null) {
            return makeProviderFailure({
              class: "provider_error",
              code: "acp_idle_error",
              message:
                "The agent reported an error while ending the turn. Retry the turn or check the provider logs for details.",
            });
          }
          const cause = new EffectAcpErrors.AcpRequestError({
            code: error.code,
            errorMessage: error.message,
            ...(error.data === undefined ? {} : { data: error.data }),
          });
          return flavor.promptFailure?.(cause) ?? acpPromptFailure(cause);
        };

        const stopReasonFailure = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          stopReason: EffectAcpSchema.StopReason | null | undefined,
          error: EffectAcpSchema.PromptResponse["error"],
        ) {
          const flavorFailure =
            stopReason == null || flavor.promptStopFailure === undefined
              ? undefined
              : yield* flavor.promptStopFailure({
                  stopReason,
                  error,
                  replyText: context.assistant.current?.text,
                  model: context.input.modelSelection.model,
                  now: yield* DateTime.now,
                });
          if (flavorFailure !== undefined) return flavorFailure;
          if (stopReason === "error") return idleErrorFailure(error);
          const message = acpUnfinishedStopMessage(stopReason);
          return message === undefined
            ? undefined
            : makeProviderFailure({ message, code: stopReason, class: "provider_error" });
        });

        const terminalizeOpenForegroundTools = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          status: "completed" | "failed" = "completed",
          options?: { readonly unstartedOnly: boolean },
        ) {
          for (const [key, tool] of context.tools) {
            // Child-session tools are keyed by their owning task and project in that child.
            if (key !== tool.toolCallId) continue;
            if (options?.unstartedOnly && tool.status !== "pending") continue;
            if (status === "completed" && isBackgroundCommand?.(tool)) continue;
            if (!acpCompletedTurnShouldTerminalizeTool(tool, flavor)) continue;
            yield* emitTool(context, tool, status);
          }
        });

        const endSettledPersistentTasks = Effect.fnUntraced(function* (
          status: "interrupted" | "failed",
          runningTaskIds: ReadonlySet<string>,
        ) {
          for (const [taskId, settled] of settledPersistentTasks) {
            if (!runningTaskIds.has(taskId)) continue;
            const toolCallId = settled.toolCallIdsByBackgroundTaskId.get(taskId);
            const tool = toolCallId === undefined ? undefined : settled.tools.get(toolCallId);
            if (tool !== undefined) yield* emitTool(settled, tool, status, true);
          }
          settledPersistentTasks.clear();
        });

        const quarantineStoppedRun = Effect.fnUntraced(function* () {
          const runningTaskIds = yield* Ref.get(runningBackgroundTaskIds);
          yield* continuationPermit.withPermit(
            Effect.gen(function* () {
              yield* Ref.update(continuationGeneration, (value) => value + 1);
              yield* Ref.set(stoppedRunQuarantine, true);
              yield* Ref.set(wakeBuffer, []);
              yield* Ref.set(wakeReports, noWakeReports);
              yield* Ref.set(continuationRequested, false);
              yield* Ref.set(runningBackgroundTaskIds, new Set());
              yield* Ref.set(midTurnUnreportedCompletedTaskIds, new Set());
              yield* Ref.set(carryoverSubagents, null);
              yield* Ref.set(lastTurnRoute, null);
            }),
          );
          if (reportsBackgroundWait) {
            yield* endSettledPersistentTasks("interrupted", runningTaskIds);
          }
          yield* endBackgroundCommands("interrupted");
        });

        const finalizeTurn = Effect.fnUntraced(function* (
          context: ActiveAcpTurn,
          status: "completed" | "interrupted" | "failed" | "cancelled",
          failure?: OrchestrationV2ProviderFailure,
          options?: {
            readonly childTurnsContinue?: boolean;
            /** The turn ended on a quiet spell after its prompt, not on the prompt's response. */
            readonly endedOnQuiet?: boolean;
          },
        ) {
          if (context.finalized) return;
          const settledStatus = context.interrupted ? "interrupted" : status;
          context.finalizedStatus = settledStatus;
          context.finalized = true;
          if (context.promptHoldsBackgroundWork && settledStatus !== "interrupted") {
            for (const [id, tool] of context.tools) {
              const status = toolStatus(tool.status);
              if (
                id !== tool.toolCallId ||
                (status !== "pending" && status !== "running") ||
                !isPromptBackgroundTool(tool)
              )
                continue;
              // The native prompt's terminal response closes the work it held open for.
              const terminal = settledStatus === "cancelled" ? "interrupted" : settledStatus;
              yield* emitTool(
                context,
                { ...tool, status: terminal === "completed" ? "completed" : "failed" },
                terminal,
              );
            }
          }
          if (settledStatus === "completed" && isBackgroundCommand !== undefined) {
            lastBackgroundCommandTurn = context;
            for (const [id, tool] of context.tools) {
              if (
                id === tool.toolCallId &&
                !backgroundCommands.has(id) &&
                isBackgroundCommand(tool)
              ) {
                backgroundCommands.set(id, { turn: context, sessionScoped: false });
              }
            }
          }
          const watchdog = context.inactivityWatchdog;
          context.inactivityWatchdog = undefined;
          if (watchdog !== undefined) {
            yield* Fiber.interrupt(watchdog).pipe(Effect.forkDetach, Effect.asVoid);
          }
          const directStopQuarantine = yield* Ref.get(stoppedRunQuarantine);
          if (flavor.subagentsIdleOnTurnCompletion === true) {
            for (const subagent of context.subagents.values()) {
              if (!acpSubagentStatusBlocksTurnSettlement(subagent.task.status)) continue;
              yield* emitSubagent(context, {
                nativeTaskId: subagent.task.nativeTaskRef?.nativeId ?? subagent.task.id,
                prompt: subagent.task.prompt,
                title: subagent.task.title,
                model: subagent.task.model,
                status: settledStatus === "completed" ? "idle" : settledStatus,
                childSessionId: subagent.childSessionId,
                result: null,
              });
            }
          }
          if (settledStatus === "completed") {
            yield* terminalizeOpenForegroundTools(context);
          } else if (settledStatus === "interrupted") {
            // Direct Stop terminalizes every visible run-owned item. restart_active
            // keeps live subagent lineages for in-process replacement carryover.
            yield* terminalizeOpenRunOwnedItems(context, {
              terminalizeSubagents: directStopQuarantine,
            });
          }
          yield* closeTextStreams(context);
          // Ingestion may stop at turn.terminal, before a delayed flush would run.
          yield* textEmissionPermit.withPermit(
            Effect.forEach(context.subagents.values(), flushPendingSubagentAssistant, {
              discard: true,
            }),
          );
          if (settledStatus !== "failed") {
            yield* emitProviderRetry(context, settledStatus);
          }
          const now = yield* DateTime.now;
          if (
            compactsContext &&
            isCompactionMessage(context.input.message) &&
            settledStatus === "completed" &&
            !Array.from(context.tools.keys()).some((id) => id.startsWith("acp-compaction:"))
          ) {
            context.contextUsage = null;
            yield* Ref.update(contextUsageBySessionId, (current) => {
              const updated = new Map(current);
              updated.delete(context.nativeThreadId);
              return updated;
            });
            const nativeItemId = `${context.nativeTurnId}:compaction`;
            yield* Ref.update(compactionMarkers, (current) =>
              new Map(current).set(context.nativeThreadId, Symbol()),
            );
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver,
              turnItem: {
                id: idAllocator.derive.turnItemFromProviderItem({ driver, nativeItemId }),
                threadId: context.input.threadId,
                runId: context.input.runId,
                nodeId: context.input.rootNodeId,
                providerThreadId: context.input.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: { driver, nativeId: nativeItemId, strength: "weak" },
                parentItemId: null,
                ordinal: yield* resolveItemOrdinal(context, nativeItemId),
                type: "compaction",
                driver,
                status: "completed",
                title: "Context compacted",
                startedAt: context.startedAt,
                completedAt: now,
                updatedAt: now,
              },
            });
          }
          const turn = providerTurnPayload(context, settledStatus, now);
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver,
            threadId: context.input.threadId,
            providerTurn: turn,
          });
          const {
            waitingOnBackgroundWork: _clearedWaiting,
            backgroundWaitStartedAt: _clearedWaitStart,
            ...baseProviderThread
          } = context.input.providerThread;
          const updatedProviderThread: OrchestrationV2ProviderThread = {
            ...baseProviderThread,
            providerSessionId: input.providerSessionId,
            status: "active",
            lastRunOrdinal: context.input.runOrdinal,
            firstRunOrdinal:
              context.input.providerThread.firstRunOrdinal ?? context.input.runOrdinal,
            pendingBackgroundTasks: [],
            contextUsage: context.contextUsage,
            nativeMetadata: context.nativeMetadata,
            updatedAt: now,
          };
          yield* Ref.update(providerThreadByNativeSessionId, (current) =>
            new Map(current).set(context.nativeThreadId, updatedProviderThread),
          );
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver,
            providerThread: updatedProviderThread,
          });
          const childTurnsContinue =
            settledStatus === "failed" && options?.childTurnsContinue === true;
          yield* emitProviderEvent(
            settledStatus === "failed"
              ? {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: context.input.providerThread.id,
                  providerTurnId: context.providerTurnId,
                  runOrdinal: context.input.runOrdinal,
                  failureItemOrdinal: yield* resolveItemOrdinal(
                    context,
                    `terminal-failure:${context.providerTurnId}`,
                  ),
                  status: settledStatus,
                  ...(childTurnsContinue ? { childTurnsContinue: true } : {}),
                  failure: failure ?? makeProviderFailure({ class: "provider_error" }),
                  ...(context.providerRetry === undefined
                    ? {}
                    : {
                        retry: context.providerRetry.retry,
                        retryStartedAt: context.providerRetry.startedAt,
                      }),
                  threadDisposition: "reusable",
                }
              : {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: context.input.providerThread.id,
                  providerTurnId: context.providerTurnId,
                  runOrdinal: context.input.runOrdinal,
                  status: settledStatus,
                  // An agent that goes on by itself may still be working after a quiet spell.
                  ...(settledStatus === "completed" &&
                  options?.endedOnQuiet === true &&
                  postSettleContinuationEnabled
                    ? { continuationExpected: true as const }
                    : {}),
                  failure: null,
                  threadDisposition: "reusable",
                },
          );
          const subagentsRequiringCarryover = [...context.subagents.values()].filter(
            acpSubagentHasPendingBackgroundWork,
          );
          // Direct Stop must not carry residual subagents into a later run.
          if (subagentsRequiringCarryover.length > 0 && !directStopQuarantine) {
            const sessionId = yield* Ref.get(activeSessionId);
            if (sessionId !== null) {
              yield* Ref.set(carryoverSubagents, {
                sessionId,
                projectsLateTerminals: settledStatus === "completed" || childTurnsContinue,
                subagents: subagentsRequiringCarryover,
              });
            }
          }
          const runningTaskIds = yield* Ref.get(runningBackgroundTaskIds);
          for (const taskId of settledPersistentTasks.keys()) {
            if (!runningTaskIds.has(taskId)) settledPersistentTasks.delete(taskId);
          }
          for (const taskId of context.persistentBackgroundTaskIds) {
            if (runningTaskIds.has(taskId)) settledPersistentTasks.set(taskId, context);
          }
          yield* Ref.set(activeTurn, null);
          // A mid-turn background completion may have deferred its offer while
          // this root turn was still streaming. Once the turn leaves the active
          // slot, re-check: empty running set + residual wake evidence (or a
          // mid-turn unreported completion) means a legitimate unhandled
          // completion can open exactly one continuation. Sticky
          // continuationRequested prevents double-offer if a later frame also
          // races into offerContinuationRun.
          if (
            postSettleContinuationEnabled &&
            settledStatus === "completed" &&
            !directStopQuarantine &&
            (yield* Ref.get(runningBackgroundTaskIds)).size === 0 &&
            ((yield* Ref.get(wakeBuffer)).length > 0 ||
              (yield* Ref.get(midTurnUnreportedCompletedTaskIds)).size > 0)
          ) {
            const sessionId = yield* Ref.get(activeSessionId);
            if (sessionId !== null) {
              yield* offerContinuationRun(sessionId);
            }
          }
          // Clear mid-turn unreported marks unless a completed turn still has
          // running background work: keep them so the post-finalize gate can
          // offer once when the last task ends. Interrupted/failed turns must
          // not leave marks that open a wake after interrupt (quarantine owns
          // that path). Non-continuation turn start also clears (~user turn).
          if (
            settledStatus !== "completed" ||
            (yield* Ref.get(runningBackgroundTaskIds)).size === 0
          ) {
            yield* Ref.set(midTurnUnreportedCompletedTaskIds, new Set());
          }
          yield* Deferred.succeed(context.completed, undefined).pipe(Effect.ignore);
        });

        settleRuntimeTermination = Effect.fnUntraced(function* (error) {
          const context = yield* Ref.get(activeTurn);
          if (context !== null && !context.finalized) {
            yield* terminalizeOpenRunOwnedItems(context, {
              terminalizeSubagents: true,
              status: "failed",
            });
          }
          yield* terminalizeCarryoverSubagents(yield* Ref.get(carryoverSubagents), "failed");
          // A settled run's pending timer lived in the ended process, so it never fires.
          yield* endSettledPersistentTasks("failed", yield* Ref.get(runningBackgroundTaskIds));
          yield* endBackgroundCommands("failed");
          yield* quarantineStoppedRun();
          if (context !== null && !context.finalized) {
            yield* finalizeTurn(
              context,
              "failed",
              flavor.promptFailure?.(error) ?? acpPromptFailure(error),
            );
          }
          yield* Queue.fail(
            events,
            new ProviderAdapter.ProviderAdapterEventStreamError({
              driver,
              providerSessionId: input.providerSessionId,
              cause: error,
            }),
          );
        });

        scheduleDeferredFinalize = (context) =>
          Effect.gen(function* () {
            if (!flavor.deferFinalizeForBackgroundWork) return;
            if (!context.promptSettled || context.finalized || context.interrupted) return;
            if (hasDeferredBackgroundWork(context)) return;
            context.backgroundFinalizeGeneration += 1;
            const generation = context.backgroundFinalizeGeneration;
            const debounce = context.replyOpen
              ? ACP_OPEN_REPLY_QUIET_LIMIT
              : ACP_DEFERRED_FINALIZE_DEBOUNCE;
            yield* Effect.gen(function* () {
              yield* Effect.sleep(debounce);
              if (
                context.finalized ||
                context.interrupted ||
                context.backgroundFinalizeGeneration !== generation
              ) {
                return;
              }
              if (hasDeferredBackgroundWork(context)) return;
              const status = context.promptSettledStatus ?? "completed";
              yield* finalizeTurn(context, status, undefined, { endedOnQuiet: true });
            }).pipe(Effect.forkIn(sessionScope), Effect.asVoid);
            yield* options.testHooks?.onDeferredFinalizeScheduled?.(debounce) ?? Effect.void;
          });

        const promptInactivityPaused = Effect.fn("AcpAdapterV2.promptInactivityPaused")(function* (
          context: ActiveAcpTurn,
        ) {
          if (openAgentRequests.size > 0) return true;
          if ((yield* Ref.get(pendingRuntimeRequests)).size > 0) return true;
          for (const tool of context.tools.values()) {
            const status = toolStatus(tool.status);
            if (status === "pending" || status === "running" || status === "waiting") return true;
          }
          for (const subagent of context.subagents.values()) {
            if (acpSubagentStatusBlocksTurnSettlement(subagent.task.status)) return true;
          }
          return false;
        });

        /**
         * Holds the transition permit from the deadline check through process teardown,
         * so Stop and the next turn see either a running prompt or a replaced runtime.
         */
        const retireInactivePrompt = Effect.fn("AcpAdapterV2.retireInactivePrompt")(function* (
          context: ActiveAcpTurn,
          generation: number,
          timeoutMillis: number,
        ) {
          const retired = yield* runRuntimeCallbackAtGeneration(
            generation,
            Effect.gen(function* () {
              if (context.finalized || context.interrupted) return "done" as const;
              if ((yield* Ref.get(activeTurn)) !== context) return "done" as const;
              if (yield* Deferred.isDone(context.promptWireSettled)) return "done" as const;
              const now = yield* Clock.currentTimeMillis;
              if (context.lastProgressAt + timeoutMillis > now) return "rearm" as const;
              if (yield* promptInactivityPaused(context)) {
                context.lastProgressAt = now;
                return "rearm" as const;
              }
              context.inactivityWatchdog = undefined;
              openAgentRequests.clear();
              yield* quarantineNativeTransportAtGeneration(generation);
              yield* advanceRuntimeCallbackGeneration;
              yield* Ref.set(runtimeRestartRequired, true);
              yield* cancelPendingRuntimeRequests();
              yield* terminalizeOpenForegroundTools(context, "failed");
              const minutes = Math.max(1, Math.round(timeoutMillis / 60_000));
              yield* finalizeTurn(
                context,
                "failed",
                makeProviderFailure({
                  class: "provider_error",
                  message: `${flavor.runtimeHarness ?? driver} sent nothing for ${minutes} ${minutes === 1 ? "minute" : "minutes"}, so SSHCode stopped the turn and restarted the agent. Send a message to continue.`,
                }),
              );
              return "retired" as const;
            }),
          );
          if (Option.isNone(retired) || retired.value !== "retired") {
            return Option.getOrElse(retired, () => "done" as const);
          }
          yield* Effect.logWarning("orchestration-v2.acp-prompt-inactive", {
            driver,
            providerSessionId: input.providerSessionId,
            providerTurnId: context.providerTurnId,
            timeoutMillis,
          });
          if (runtimeScope !== undefined) {
            yield* Scope.close(runtimeScope, Exit.void).pipe(Effect.ignore);
          }
          return "retired" as const;
        });

        const watchPromptInactivity = Effect.fn("AcpAdapterV2.watchPromptInactivity")(function* (
          context: ActiveAcpTurn,
          generation: number,
          timeoutMillis: number,
          dispatched: Deferred.Deferred<void>,
        ) {
          yield* Deferred.await(dispatched);
          context.lastProgressAt = yield* Clock.currentTimeMillis;
          while (true) {
            const sliceStartedAt = yield* Clock.currentTimeMillis;
            const remaining = context.lastProgressAt + timeoutMillis - sliceStartedAt;
            if (remaining > 0) {
              const slice = Math.min(remaining, ACP_PROMPT_INACTIVITY_SLICE_MILLIS);
              yield* Effect.sleep(Duration.millis(slice));
              // Host sleep is not agent silence. Timers either fire late on wake (macOS, Windows)
              // or pause while the wall clock jumps (Linux); both overrun a short slice.
              const now = yield* Clock.currentTimeMillis;
              if (now - sliceStartedAt > slice + ACP_HOST_SLEEP_TOLERANCE_MILLIS) {
                context.lastProgressAt = now;
              }
              continue;
            }
            const outcome = yield* runtimeTransitionPermit.withPermit(
              retireInactivePrompt(context, generation, timeoutMillis),
            );
            if (outcome !== "rearm") return;
          }
        });

        /** A message's prompt blocks: its text and images, or the flavor's own build. */
        const promptContentBlocks = Effect.fnUntraced(function* (
          text: string,
          attachments: ProviderAdapter.ProviderAdapterV2TurnInput["message"]["attachments"],
        ) {
          const prompt: Array<EffectAcpSchema.ContentBlock> =
            text.length > 0 ? [{ type: "text", text }] : [];
          // Every prompt includes the saved path, including for agents without native images.
          const imageAttachments =
            supportsImagePrompts && !flavor.buildPrompt
              ? attachments.filter(isProviderNativeImageAttachment)
              : [];
          if (flavor.buildPrompt) {
            const setup = yield* Ref.get(activeSessionSetup);
            const blocks = yield* flavor
              .buildPrompt({
                text,
                attachments,
                promptCapabilities: setup?.initializeResult.agentCapabilities?.promptCapabilities,
              })
              .pipe(
                Effect.provideService(Scope.Scope, sessionScope),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterProtocolError({
                      driver,
                      detail: "Failed to build ACP attachment prompt",
                      payload: cause,
                    }),
                ),
              );
            prompt.splice(0, prompt.length, ...blocks);
          }
          for (const attachment of imageAttachments) {
            const path = host.resolveAttachmentPath(attachment as ChatAttachment);
            if (path === null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver,
                detail: `Invalid attachment id '${attachment.id}'`,
              });
            }
            const bytes = yield* fileSystem.readFile(path).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver,
                    detail: `Failed to read attachment '${attachment.id}'`,
                    payload: cause,
                  }),
              ),
            );
            prompt.push({
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            });
          }
          return prompt;
        });

        const resolvePromptParts = Effect.fnUntraced(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          sessionId: string,
        ) {
          const mcp = yield* readMcpContext(turnInput.threadId);
          const formatDiscovery = flavor.mcpDiscoveryInstructions;
          const setup = yield* Ref.get(activeSessionSetup);
          const supportsDiscovery =
            flavor.supportsMcpDiscovery === undefined ||
            (setup !== null &&
              flavor.supportsMcpDiscovery(setup.initializeResult, turnInput.modelSelection.model));
          const toolDiscoveryInstructions =
            !supportsDiscovery ||
            formatDiscovery === undefined ||
            mcp.toolDiscoveryCatalog === undefined
              ? undefined
              : yield* mcp.toolDiscoveryCatalog.pipe(
                  Effect.map((catalog) => (catalog ? formatDiscovery(catalog) : undefined)),
                );
          const instructionState = t3AcpInstructionState({
            runtimeHarness: flavor.runtimeHarness,
            threadId: turnInput.threadId,
            isSubagent: turnInput.appThread.lineage.relationshipToParent === "subagent",
            interactionMode: turnInput.runtimePolicy.interactionMode,
            hasT3Mcp: mcp.servers.length > 0,
            subagentsEnabled: subagentsEnabledFor(turnInput.threadId),
            toolDiscoveryInstructions,
          });
          const previousInstructionState = (yield* Ref.get(promptInstructionStates)).get(sessionId);
          const compactionMarker = (yield* Ref.get(compactionMarkers)).get(sessionId);
          const messageText = dispatchAcpSkillMention(
            providerMessageTextWithAttachmentPaths({
              text: turnInput.message.text,
              attachments: turnInput.message.attachments,
              resolveAttachmentPath: host.resolveAttachmentPath,
            }),
            (yield* Ref.get(sessionSkillNames)).get(sessionId) ?? new Set(),
          );
          const text = t3AcpPromptWithInstructions({
            prompt: messageText,
            state: instructionState,
            ...(previousInstructionState === undefined || compactionMarker !== undefined
              ? {}
              : { previousState: previousInstructionState }),
          });
          const prompt = yield* promptContentBlocks(text, turnInput.message.attachments);
          if (prompt.length === 0) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver,
              detail: "ACP turn requires non-empty text or attachments",
            });
          }
          return {
            prompt,
            instructionState: text === messageText ? undefined : instructionState,
            compactionMarker,
          };
        });

        const restartRuntimeAfterTeardownIfRequired = Effect.fnUntraced(function* (
          threadId: ThreadId | null,
          resumeSessionId?: string,
        ) {
          const restartRequired = yield* Ref.get(runtimeRestartRequired);
          if (!restartRequired) {
            return { restarted: false as const, activated: undefined };
          }
          const initialFailure =
            resumeSessionId === undefined
              ? undefined
              : yield* Ref.modify(initialSessionActivationFailure, (failure) =>
                  failure?.sessionId === resumeSessionId
                    ? [failure.error, null]
                    : [undefined, failure],
                );
          if (initialFailure !== undefined) {
            return yield* initialFailure;
          }
          if (resumeSessionId !== undefined && (canLoadSession || canResumeSession)) {
            yield* Ref.set(advertisedCommandNames, new Map());
            advertisedCommandsReady.clear();
            const mcpContext = yield* readMcpContext(threadId);
            prepareTerminalEnvironment(mcpContext, resumeSessionId);
            const activated = yield* startAcpRuntime(threadId, resumeSessionId);
            rememberTerminalEnvironment(activated.sessionId, yield* readMcpContext(threadId));
            yield* Ref.set(runtimeRestartRequired, false);
            yield* Ref.set(activeSessionId, activated.sessionId);
            yield* Ref.set(loadingSessionId, null);
            yield* Ref.set(activeSessionSetup, activated);
            yield* Ref.set(activeSelection, null);
            yield* Ref.set(activeInteractionMode, null);
            yield* Ref.set(snapshot, emptySnapshotState());
            return { restarted: true as const, activated };
          }
          yield* Ref.set(advertisedCommandNames, new Map());
          advertisedCommandsReady.clear();
          yield* restartAcpRuntime(threadId);
          yield* Ref.set(runtimeRestartRequired, false);
          yield* Ref.set(activeSessionId, null);
          yield* Ref.set(activeSessionSetup, null);
          yield* Ref.set(activeSelection, null);
          yield* Ref.set(activeInteractionMode, null);
          yield* Ref.set(snapshot, emptySnapshotState());
          return { restarted: true as const, activated: undefined };
        });

        /** Follows a turn's `session/prompt`; a prompt-steer's prompt supersedes the one before. */
        const followPrompt = (
          context: ActiveAcpTurn,
          prompt: (
            superseded: () => boolean,
          ) => Effect.Effect<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>,
          settle: {
            readonly generation: number;
            readonly sessionId: string;
            readonly promptParts: Effect.Success<ReturnType<typeof resolvePromptParts>> | null;
          },
        ) => {
          const sequence = ++context.promptSequence;
          const superseded = () => context.promptSequence !== sequence;
          const promptParts = settle.promptParts;
          return Effect.gen(function* () {
            const readFailure = yield* (
              flavor.watchPromptFailure?.(settle.sessionId) ?? Effect.undefined
            );
            const result = yield* prompt(superseded);
            return { result, readFailure };
          }).pipe(
            Effect.tap(() =>
              Ref.update(promptInstructionStates, (current) => {
                if (promptParts?.instructionState === undefined) return current;
                const updated = new Map(current);
                updated.set(settle.sessionId, promptParts.instructionState);
                return updated;
              }),
            ),
            Effect.tap(() =>
              Ref.update(compactionMarkers, (current) => {
                if (
                  promptParts?.instructionState === undefined ||
                  promptParts.compactionMarker === undefined ||
                  current.get(settle.sessionId) !== promptParts.compactionMarker
                )
                  return current;
                const updated = new Map(current);
                updated.delete(settle.sessionId);
                return updated;
              }),
            ),
            // Settle the wire before the completion callback's permit so a settled-soft
            // Stop sees the native return. Capture usage only before finalize: a late
            // response must not flip a settled turn.
            Effect.tap(({ result }) =>
              Effect.gen(function* () {
                if (flavor.extractContextUsage && !context.finalized) {
                  yield* observeContextUsage(settle.sessionId, result, context);
                }
                if (
                  flavor.reportsPerTurnPromptUsage === true &&
                  !context.finalized &&
                  result.usage != null
                ) {
                  const normalizedUsage =
                    flavor.normalizePromptUsage?.(result.usage) ?? result.usage;
                  context.promptUsage = addAcpUsage(context.promptUsage, normalizedUsage);
                  if (!superseded() && normalizedUsage.outputTokens > 0) {
                    const endedAt = yield* DateTime.now;
                    // Prompt usage includes tool-only steps, and thought updates can be
                    // summaries. The text stream cannot time all of those output tokens.
                    endGenerationReply(context.generation, {
                      outputTokens: normalizedUsage.outputTokens,
                      endedAt,
                      firstOutputHidden:
                        (normalizedUsage.thoughtTokens ?? 0) > 0 ||
                        context.generationRequiresEndToEnd,
                    });
                    context.generationRequiresEndToEnd = false;
                  }
                }
                if (!superseded()) {
                  yield* Deferred.succeed(context.promptWireSettled, undefined).pipe(Effect.asVoid);
                }
              }),
            ),
            Effect.tap(() => options.testHooks?.afterPromptWireSettled?.() ?? Effect.void),
            Effect.flatMap(({ result, readFailure }) =>
              runRuntimeCallbackAtGeneration(
                settle.generation,
                Effect.gen(function* () {
                  if (context.finalized || superseded()) return;
                  // ACP v2 reports a failed prompt through its idle stop reason, not an RPC error.
                  const failure = context.interrupted
                    ? undefined
                    : ((yield* readFailure?.(result) ?? Effect.undefined) ??
                      (yield* stopReasonFailure(context, result.stopReason, result.error)));
                  const status =
                    failure !== undefined
                      ? "failed"
                      : result.stopReason === "cancelled"
                        ? context.interrupted
                          ? "interrupted"
                          : "cancelled"
                        : "completed";
                  if (failure !== undefined) {
                    // Flush completions buffered before the prompt settled before failing it.
                    context.promptSettled = true;
                    context.promptSettledStatus = "failed";
                    yield* finishBackgroundToolsEndedBeforeSettle(context);
                    yield* terminalizeOpenForegroundTools(context, "failed");
                    yield* finalizeTurn(context, "failed", failure, {
                      childTurnsContinue: hasSurvivingBackgroundWork(context),
                    });
                    return;
                  }
                  if (status === "completed" && !context.interrupted) {
                    yield* idleReportedSubagents(context);
                    if (context.finalized || superseded()) return;
                  }
                  // Grok monitors (and async subagents) keep working after the root
                  // prompt RPC returns. Defer finalize so their later updates and
                  // wake-turn traffic still project onto this run.
                  if (
                    flavor.deferFinalizeForBackgroundWork === true &&
                    !context.interrupted &&
                    hasDeferredBackgroundWork(context)
                  ) {
                    context.promptSettled = true;
                    context.promptSettledStatus = status;
                    // The agent finished this prompt's reply. Background work
                    // holds the run open, not the text it already sent.
                    yield* closeTextStreams(context);
                    yield* (
                      options.testHooks?.afterPromptSettledWithBackgroundWork?.() ?? Effect.void
                    );
                    yield* finishBackgroundToolsEndedBeforeSettle(context);
                    yield* syncOpenPromptBackgroundWait(context);
                    return;
                  }
                  if (status === "completed" && turnProducedNothing(context)) {
                    yield* finalizeTurn(
                      context,
                      "failed",
                      makeProviderFailure({
                        message: EMPTY_TURN_FAILURE_MESSAGE,
                        class: "provider_error",
                      }),
                    );
                    return;
                  }
                  yield* finalizeTurn(context, status);
                }),
              ).pipe(Effect.asVoid),
            ),
            // Prompt failure is not wire-settled: only a successful resolve marks
            // the signal. catchCause must not complete promptWireSettled.
            Effect.catchCause((cause) =>
              runRuntimeCallbackAtGeneration(
                settle.generation,
                Effect.gen(function* () {
                  if (context.finalized || superseded()) return;
                  const error = Cause.squash(cause);
                  if (!context.interrupted) {
                    // An agent replying with an RPC error can still finish a tool it started.
                    yield* terminalizeOpenForegroundTools(context, "failed", {
                      unstartedOnly: Schema.is(EffectAcpErrors.AcpRequestError)(error),
                    });
                  }
                  yield* finalizeTurn(
                    context,
                    context.interrupted ? "interrupted" : "failed",
                    flavor.promptFailure?.(error) ?? acpPromptFailure(error),
                  ).pipe(
                    Effect.andThen(
                      Effect.logWarning("orchestration-v2.acp-prompt-failed", {
                        driver,
                        providerSessionId: input.providerSessionId,
                        providerThreadId: context.input.providerThread.id,
                        providerTurnId: context.providerTurnId,
                        cause,
                      }),
                    ),
                  );
                }),
              ).pipe(Effect.asVoid),
            ),
          );
        };

        const startTurnUnlocked = Effect.fn("AcpAdapterV2.startTurn")(
          function* (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) {
            yield* awaitRuntimeTeardown();
            const existing = yield* Ref.get(activeTurn);
            if (existing !== null) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver,
                detail: `ACP provider turn ${existing.providerTurnId} is still active`,
              });
            }
            useProviderThreadIdentity(turnInput.providerThread);
            // Session activation can itself invoke client fs/terminal methods.
            // Install the incoming thread policy before load/resume so those
            // requests can never inherit the previously active thread's policy.
            const runtimeModeChanged =
              latestRuntimePolicy.runtimeMode !== turnInput.runtimePolicy.runtimeMode;
            latestRuntimePolicy = turnInput.runtimePolicy;
            const requestedSessionId = yield* nativeThreadId(driver, turnInput.providerThread);
            const restartOutcome = yield* restartRuntimeAfterTeardownIfRequired(
              turnInput.threadId,
              requestedSessionId,
            );
            const needsSessionActivation =
              restartOutcome.activated === undefined &&
              ((yield* Ref.get(activeSessionId)) !== requestedSessionId ||
                restartOutcome.restarted);
            if (needsSessionActivation) {
              const activated = yield* activateSession(requestedSessionId, turnInput.threadId);
              yield* Ref.set(activeSessionId, activated.sessionId);
              yield* Ref.set(loadingSessionId, null);
              yield* Ref.set(activeSessionSetup, activated);
              yield* configureSession(activated, turnInput.modelSelection, turnInput.runtimePolicy);
              yield* Ref.set(activeSelection, turnInput.modelSelection);
              yield* Ref.set(activeInteractionMode, turnInput.runtimePolicy.interactionMode);
            } else {
              const configuredSelection = yield* Ref.get(activeSelection);
              const configuredInteractionMode = yield* Ref.get(activeInteractionMode);
              if (
                configuredSelection === null ||
                !modelSelectionsEqual(configuredSelection, turnInput.modelSelection) ||
                configuredInteractionMode !== turnInput.runtimePolicy.interactionMode ||
                runtimeModeChanged
              ) {
                const currentSessionSetup = yield* Ref.get(activeSessionSetup);
                if (currentSessionSetup === null) {
                  return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                    driver,
                    detail: `ACP session ${requestedSessionId} has no active setup metadata`,
                  });
                }
                yield* configureSession(
                  currentSessionSetup,
                  turnInput.modelSelection,
                  turnInput.runtimePolicy,
                );
                yield* Ref.set(activeSelection, turnInput.modelSelection);
                yield* Ref.set(activeInteractionMode, turnInput.runtimePolicy.interactionMode);
              }
            }

            // Activation must finish first: each session advertises its own commands.
            if (
              flavor.compactViaAdvertisedCommand === true &&
              isCompactionMessage(turnInput.message)
            ) {
              let commands = (yield* Ref.get(advertisedCommandNames)).get(requestedSessionId);
              if (commands === undefined) {
                yield* Deferred.await(commandsReadyDeferred(requestedSessionId)).pipe(
                  Effect.timeoutOption(ACP_COMPACT_COMMANDS_WAIT_TIMEOUT),
                );
                commands = (yield* Ref.get(advertisedCommandNames)).get(requestedSessionId);
              }
              if (commands?.has("compact") !== true) {
                return yield* new ProviderAdapter.ProviderCompactionUnsupportedError({
                  driver,
                  providerThreadId: turnInput.providerThread.id,
                });
              }
            }
            yield* validateModelSelection(turnInput.modelSelection);
            yield* Ref.set(lastTurnRoute, {
              threadId: turnInput.threadId,
              providerThreadId: turnInput.providerThread.id,
            });
            yield* Ref.set(suppressPostSettleMonitorPrompt, false);
            yield* Ref.set(handledBackgroundTaskIdsInActiveTurn, new Set());
            // Continuation turns attach to wake traffic the agent already produced
            // after the prior root turn settled; do not re-prompt the ACP session.
            const isContinuationTurn =
              postSettleContinuationEnabled && acpIsProviderContinuationMessage(turnInput.message);
            const isAppOwnedWakeTurn = acpIsAppOwnedWakeTurn(turnInput.message);
            // An app-owned wake reports on a sibling delegated child and owns
            // none of this session's background work, so it must not discard
            // pending wake evidence: neither the mid-turn completion marks kept
            // across a settle with work still running, nor the wake buffer
            // below. Dropping the marks here would lose the offer for a task
            // that completed unreported before the settle.
            if (!isAppOwnedWakeTurn) {
              yield* Ref.set(midTurnUnreportedCompletedTaskIds, new Set());
            }
            // A user turn supersedes an empty offer, but not an offer that owns
            // buffered wake traffic. ProviderContinuationService queues that
            // continuation behind the user run so it can drain afterwards.
            const continuationWasRequested = yield* continuationPermit.withPermit(
              Effect.gen(function* () {
                const wasRequested = yield* Ref.get(continuationRequested);
                const preserveBufferedContinuation = acpTurnStartShouldPreserveContinuation({
                  continuationRequested: wasRequested,
                  isContinuationTurn,
                  wakeBufferLength: (yield* Ref.get(wakeBuffer)).length,
                });
                // User turns must not inherit prior-turn wake residue. Stale
                // injected-turn ack chatter can otherwise arm a later offer.
                // Preserve only a queued continuation that owns buffered wake
                // traffic, and exempt app-owned sibling wakes entirely.
                if (!isContinuationTurn && !isAppOwnedWakeTurn && !preserveBufferedContinuation) {
                  yield* Ref.set(wakeBuffer, []);
                  yield* Ref.set(wakeReports, noWakeReports);
                }
                if (preserveBufferedContinuation) return wasRequested;
                yield* Ref.update(continuationGeneration, (value) => value + 1);
                yield* Ref.set(continuationRequested, false);
                return wasRequested;
              }),
            );
            const promptParts = isContinuationTurn
              ? null
              : yield* resolvePromptParts(turnInput, requestedSessionId);
            const startedAt = yield* DateTime.now;
            const nativeTurnId = `${requestedSessionId}:turn:${turnInput.providerTurnOrdinal}`;
            const providerTurnId = deriveProviderTurnId(nativeTurnId);
            const completed = yield* Deferred.make<void, never>();
            const promptWireSettled = yield* Deferred.make<void, never>();
            const promptDispatched = yield* Deferred.make<void, never>();
            const rememberedContextUsage = (yield* Ref.get(contextUsageBySessionId)).get(
              requestedSessionId,
            );
            const rememberedNativeMetadata = (yield* Ref.get(nativeMetadataBySessionId)).get(
              requestedSessionId,
            );
            const initialNativeMetadata =
              rememberedNativeMetadata === undefined
                ? (turnInput.providerThread.nativeMetadata ?? null)
                : {
                    ...turnInput.providerThread.nativeMetadata,
                    ...rememberedNativeMetadata,
                  };
            if (initialNativeMetadata !== null) {
              yield* Ref.update(nativeMetadataBySessionId, (current) =>
                new Map(current).set(requestedSessionId, initialNativeMetadata),
              );
            }
            const sessionSetup = yield* Ref.get(activeSessionSetup);
            const context: ActiveAcpTurn = {
              input: turnInput,
              providerTurnId,
              nativeThreadId: requestedSessionId,
              nativeTurnId,
              startedAt,
              completed,
              itemOrdinals: new Map(),
              outgoingPrompt:
                sessionSetup?.initializeResult.protocolVersion === 2
                  ? promptParts?.prompt
                  : undefined,
              user: { current: null, nextSegment: 0, closedNamedSegments: new Map() },
              assistant: { current: null, nextSegment: 0, closedNamedSegments: new Map() },
              reasoning: { current: null, nextSegment: 0, closedNamedSegments: new Map() },
              contextUsage: rememberedContextUsage ?? turnInput.providerThread.contextUsage ?? null,
              nativeMetadata: initialNativeMetadata,
              tools: new Map(),
              ...(clientTerminals === undefined ? {} : { terminalCalls: makeRunningToolCalls() }),
              toolUpdatesSkipped: new Map(),
              toolStartedAt: new Map(),
              subagents: new Map(),
              subagentsBySessionId: new Map(),
              pendingSubagentNotifications: new Map(),
              toolCallIdsByBackgroundTaskId: new Map(),
              persistentBackgroundTaskIds: new Set(),
              awaitingBackgroundHydration: new Set(),
              backgroundTaskEndsBeforeSettle: new Map(),
              endedBackgroundToolStatus: new Map(),
              agentStoppedTools: flavor.trackAgentStoppedTools?.(),
              pendingInjectedReport: new Set(),
              earlyInjectedReportObserved: false,
              plans: new Map(),
              interrupted: false,
              nativeSteerSent: false,
              finalized: false,
              finalizedStatus: null,
              promptSettled: false,
              promptSettledStatus: null,
              promptWireSettled,
              foregroundIdle: yield* Deferred.make<void>(),
              promptSequence: 0,
              promptUsage: undefined,
              turnTokenUsage: undefined,
              generation: makeGenerationMeter(startedAt),
              generationRequiresEndToEnd: false,
              backgroundFinalizeGeneration: 0,
              promptDispatched,
              replyOpen: false,
              replyLastOutputWasText: false,
              wakeReplyBeforePrompt: false,
              promptHoldsBackgroundWork:
                sessionSetup !== null &&
                flavor.promptHoldsBackgroundWork?.(sessionSetup.initializeResult) === true,
              publishedBackgroundWaitKey: "",
              lastProgressAt: 0,
              inactivityWatchdog: undefined,
            };
            const carryover = yield* Ref.getAndSet(carryoverSubagents, null);
            let rehydratedCarryoverSubagents: ReadonlyArray<ActiveAcpSubagent> = [];
            if (carryover !== null && carryover.sessionId === requestedSessionId) {
              rehydratedCarryoverSubagents = carryover.subagents;
              for (const subagent of carryover.subagents) {
                const nativeId = subagent.task.nativeTaskRef?.nativeId ?? null;
                if (nativeId !== null) {
                  context.subagents.set(nativeId, subagent);
                }
                if (subagent.childSessionId !== null) {
                  context.subagentsBySessionId.set(subagent.childSessionId, subagent);
                }
              }
            }
            yield* Ref.set(activeTurn, context);
            // Direct Stop closes and recreates the old runtime before reaching
            // this reset. The quarantine remains session-scoped by design.
            yield* Ref.set(stoppedRunQuarantine, false);
            const runningTurn = providerTurnPayload(context, "running", null);
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver,
              threadId: turnInput.threadId,
              providerTurn: runningTurn,
            });
            const activeProviderThread: OrchestrationV2ProviderThread = {
              ...turnInput.providerThread,
              providerSessionId: input.providerSessionId,
              status: "active",
              contextUsage: context.contextUsage,
              nativeMetadata: context.nativeMetadata,
              updatedAt: startedAt,
            };
            yield* Ref.update(providerThreadByNativeSessionId, (current) =>
              new Map(current).set(requestedSessionId, activeProviderThread),
            );
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver,
              providerThread: activeProviderThread,
            });
            yield* rememberSnapshotMessage({
              createdBy: turnInput.message.createdBy,
              creationSource: turnInput.message.creationSource,
              ...(turnInput.message.scheduledTaskId === undefined
                ? {}
                : { scheduledTaskId: turnInput.message.scheduledTaskId }),
              ...(turnInput.message.senderThreadId === undefined
                ? {}
                : { senderThreadId: turnInput.message.senderThreadId }),
              id: turnInput.message.messageId,
              threadId: turnInput.threadId,
              runId: turnInput.runId,
              nodeId: turnInput.rootNodeId,
              role: "user",
              text: turnInput.message.text,
              attachments: [...turnInput.message.attachments],
              streaming: false,
              createdAt: startedAt,
              updatedAt: startedAt,
            });
            const attached = turnAttached;
            turnAttached = yield* Deferred.make<boolean>();
            yield* Deferred.succeed(attached, true);
            // Every attach ends the deferred-terminal contract, but only the
            // queued provider continuation owns wake traffic. A user turn may
            // start before that continuation and must leave its buffer intact.
            yield* projectDeferredCarryoverTerminals(rehydratedCarryoverSubagents);
            // Keep projected terminals addressable through the wake drain so
            // emitSubagent's monotonic guard can reject replayed spawn frames.
            // Finalize carries only entries with pending background work, so a
            // terminal-and-projected lineage still expires with this turn.
            if (isContinuationTurn) {
              yield* Ref.set(continuationRequested, false);
              // This turn delivers what its offer named. Work that ended after
              // the offer keeps its report for the next one.
              yield* Ref.update(wakeReports, ({ reports, offered }) => ({
                reports: new Map([...reports].filter(([key]) => !offered.has(key))),
                offered: noWakeReports.offered,
              }));
              const drainedWakeCount = yield* Ref.modify(wakeBuffer, (current) => {
                const next: Array<EffectAcpSchema.SessionNotification> = [];
                return [
                  current.filter((notification) => notification.sessionId === requestedSessionId),
                  next,
                ] as const;
              }).pipe(
                Effect.tap((drained) =>
                  Effect.forEach(drained, handleSessionUpdate, {
                    concurrency: 1,
                    discard: true,
                  }),
                ),
                Effect.map((drained) => drained.length),
              );
              // Treat attach mode as prompt-settled so deferred finalize / quiet
              // windows can complete the continuation after wake traffic drains.
              context.promptSettled = true;
              context.promptSettledStatus = "completed";
              yield* idleReportedSubagents(context);
              yield* finishBackgroundToolsEndedBeforeSettle(context);
              if (drainedWakeCount === 0) {
                // A requested continuation with only mid-turn evidence has no
                // buffered frame yet. Wait the quiet window so late CLI frames
                // can attach. A provider-authored attach without a matching
                // request only exists to project deferred carryover terminals,
                // so it can finish immediately once those terminals are visible.
                if (continuationWasRequested && flavor.deferFinalizeForBackgroundWork === true) {
                  if (hasDeferredBackgroundWork(context)) {
                    yield* rearmDeferredFinalize(context);
                  } else {
                    yield* scheduleDeferredFinalize(context);
                  }
                } else {
                  yield* finalizeTurn(context, "completed");
                }
                return;
              }
              if (!context.finalized) {
                if (hasDeferredBackgroundWork(context)) {
                  yield* rearmDeferredFinalize(context);
                } else {
                  yield* scheduleDeferredFinalize(context);
                }
              }
              return;
            }
            const promptGeneration = yield* Ref.get(runtimeCallbackGeneration);
            const promptOptions = {
              dispatched: context.promptDispatched,
              released: context.foregroundIdle,
            };
            if (promptInactivityTimeoutMillis !== undefined) {
              context.inactivityWatchdog = yield* watchPromptInactivity(
                context,
                promptGeneration,
                promptInactivityTimeoutMillis,
                context.promptDispatched,
              ).pipe(Effect.forkIn(sessionScope));
            }
            yield* followPrompt(
              context,
              () => runtime.prompt({ prompt: promptParts!.prompt }, promptOptions),
              { generation: promptGeneration, sessionId: requestedSessionId, promptParts },
            ).pipe(Effect.forkIn(sessionScope));
          },
          (effect, turnInput) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
        );

        /**
         * `steersWithPrompt`: sends the steer as the turn's next `session/prompt`. The agent keeps
         * its tools and subagents running. If a promptless wake reply is streaming, the agent
         * finishes that reply before answering the new prompt within the same turn.
         */
        const steerWithPrompt = Effect.fn("AcpAdapterV2.steerWithPrompt")(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2SteerInput,
        ) {
          const handBack = new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
            driver,
            providerThreadId: turnInput.providerThread.id,
          });
          const sessionId = yield* nativeThreadId(driver, turnInput.providerThread);
          const text = dispatchAcpSkillMention(
            providerMessageTextWithAttachmentPaths({
              text: turnInput.message.text,
              attachments: turnInput.message.attachments,
              resolveAttachmentPath: host.resolveAttachmentPath,
            }),
            (yield* Ref.get(sessionSkillNames)).get(sessionId) ?? new Set(),
          );
          const prompt = yield* promptContentBlocks(text, turnInput.message.attachments);
          if (prompt.length === 0) {
            return yield* new ProviderAdapter.ProviderAdapterProtocolError({
              driver,
              detail: "ACP steer requires non-empty text or attachments",
            });
          }
          const { dispatched, dispatchError } = yield* runtimeTransitionPermit.withPermit(
            Effect.gen(function* () {
              const context = yield* Ref.get(activeTurn);
              if (
                context === null ||
                context.finalized ||
                context.interrupted ||
                context.providerTurnId !== turnInput.providerTurnId
              ) {
                return yield* handBack;
              }
              const generation = yield* Ref.get(runtimeCallbackGeneration);
              const dispatched = yield* Deferred.make<void>();
              const dispatchError = yield* Deferred.make<ProviderAdapter.ProviderAdapterV2Error>();
              const steered = yield* runRuntimeCallbackAtGeneration(
                generation,
                Effect.gen(function* () {
                  if (context.finalized || context.interrupted) return false;
                  // The steer prompt carries the turn on, also past a prompt that already settled.
                  const firstPrompt = context.promptSequence === 0;
                  const closeWakeReply = firstPrompt && !context.replyOpen;
                  context.promptSettled = false;
                  context.promptSettledStatus = null;
                  context.backgroundFinalizeGeneration += 1;
                  if (firstPrompt) {
                    // agy 1.5 sends chunks without message ids. Keep the wake's remaining
                    // chunks in its own message and split at the usage update that ends it.
                    context.wakeReplyBeforePrompt = context.replyOpen;
                  }
                  const released = context.foregroundIdle;
                  context.foregroundIdle = yield* Deferred.make<void>();
                  if (firstPrompt || (yield* Deferred.isDone(context.promptWireSettled))) {
                    context.promptWireSettled = yield* Deferred.make<void, never>();
                  }
                  if (closeWakeReply) yield* closeTextStreams(context);
                  context.replyOpen = true;
                  yield* syncOpenPromptBackgroundWait(context);
                  abandonGenerationReply(context.generation);
                  markGenerationRequest(context.generation, yield* DateTime.now);
                  context.generationRequiresEndToEnd = false;
                  context.lastProgressAt = yield* Clock.currentTimeMillis;
                  const watchdog = context.inactivityWatchdog;
                  context.inactivityWatchdog = undefined;
                  if (watchdog !== undefined) {
                    yield* Fiber.interrupt(watchdog).pipe(Effect.forkDetach, Effect.asVoid);
                  }
                  if (promptInactivityTimeoutMillis !== undefined) {
                    context.inactivityWatchdog = yield* watchPromptInactivity(
                      context,
                      generation,
                      promptInactivityTimeoutMillis,
                      dispatched,
                    ).pipe(Effect.forkIn(sessionScope));
                  }
                  const releasedForSteer = context.foregroundIdle;
                  yield* followPrompt(
                    context,
                    () =>
                      runtime
                        .prompt(
                          { prompt },
                          { dispatched, released: releasedForSteer, isSteer: true },
                        )
                        .pipe(
                          Effect.tapError((cause) =>
                            Deferred.isDone(dispatched).pipe(
                              Effect.flatMap((done) =>
                                done
                                  ? Effect.void
                                  : Deferred.succeed(
                                      dispatchError,
                                      new ProviderAdapter.ProviderAdapterSteerRunError({
                                        driver,
                                        providerThreadId: turnInput.providerThread.id,
                                        providerTurnId: turnInput.providerTurnId,
                                        cause,
                                      }),
                                    ),
                              ),
                            ),
                          ),
                        ),
                    { generation, sessionId: context.nativeThreadId, promptParts: null },
                  ).pipe(
                    // If the forked prompt ends or is interrupted before dispatching, wake steerWithPrompt.
                    Effect.ensuring(
                      Deferred.isDone(dispatched).pipe(
                        Effect.flatMap((done) =>
                          done ? Effect.void : Deferred.succeed(dispatchError, handBack),
                        ),
                      ),
                    ),
                    Effect.forkIn(sessionScope),
                  );
                  yield* Deferred.succeed(released, undefined);
                  return true;
                }),
              );
              if (!Option.contains(steered, true)) {
                return yield* handBack;
              }
              return { dispatched, dispatchError };
            }),
          );
          const failure = yield* Effect.raceFirst(
            Deferred.await(dispatched).pipe(Effect.as(undefined)),
            Deferred.await(dispatchError),
          );
          if (failure !== undefined) {
            return yield* failure;
          }
        });

        const startTurn = Effect.fn("AcpAdapterV2.startTurn.transition")(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
        ) {
          return yield* runtimeTransitionPermit.withPermit(startTurnUnlocked(turnInput));
        });

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* continuationPermit.withPermit(
              Effect.gen(function* () {
                yield* Ref.set(continuationClosed, true);
                yield* Ref.update(continuationGeneration, (value) => value + 1);
              }),
            );
            // A session released mid-prompt (worktree handoff) never sees its prompt settle.
            const openTurn = yield* Ref.get(activeTurn);
            if (openTurn !== null && !openTurn.finalized) {
              openTurn.interrupted = true;
              yield* finalizeTurn(openTurn, "interrupted");
            }
            const requests = [...(yield* Ref.get(pendingRuntimeRequests)).values()];
            yield* Effect.forEach(
              requests,
              (request) =>
                request.type === "approval"
                  ? Deferred.succeed(request.decision, "cancel").pipe(Effect.ignore)
                  : Deferred.succeed(request.answers, null).pipe(Effect.ignore),
              { discard: true },
            );
            const closingError = new EffectAcpErrors.AcpTransportError({
              detail: "The ACP session closed before its admitted response reached the transport",
              cause: "ACP session transport closed",
            });
            yield* Effect.forEach(
              requests,
              (request) => Deferred.fail(request.nativeResponseAcknowledgement, closingError),
              { discard: true },
            );
            const transportHadOutstandingResponses = yield* closeNativeTransport;
            yield* options.testHooks?.afterNativeResponseTransportClosed?.() ?? Effect.void;
            const sessionCapabilities =
              started.initializeResult.agentCapabilities?.sessionCapabilities;
            if (sessionCapabilities?.close != null) {
              yield* runtimeTransitionPermit.withPermitsIfAvailable(1)(
                Effect.gen(function* () {
                  const teardownState = yield* Ref.get(runtimeTeardownState);
                  const restartRequired = yield* Ref.get(runtimeRestartRequired);
                  if (
                    teardownState._tag === "Idle" &&
                    !restartRequired &&
                    !transportHadOutstandingResponses
                  ) {
                    // Finalizers can't be interrupted, so an agent that never
                    // answers would keep its process and this scope open.
                    yield* runtime
                      .closeSession()
                      .pipe(Effect.timeoutOption("10 seconds"), Effect.ignore);
                  }
                }),
              );
            }
            if (flavor.assertComplete !== undefined) {
              yield* flavor.assertComplete.pipe(Effect.orDie);
            }
            if (runtimeScope !== undefined) {
              yield* Scope.close(runtimeScope, Exit.void).pipe(Effect.ignore);
            }
          }),
        );

        const sessionRuntime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: options.instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession,
          events: Stream.fromQueue(events),
          ...(postSettleContinuationEnabled
            ? {
                hasPendingBackgroundWork: Effect.gen(function* () {
                  if ((yield* Ref.get(wakeBuffer)).length > 0) return true;
                  if (yield* Ref.get(continuationRequested)) return true;
                  if ((yield* Ref.get(runningBackgroundTaskIds)).size > 0) return true;
                  if (backgroundCommands.size > 0) return true;
                  // Projected post-settle Grok subagents can outlive the root
                  // turn via carryover; keep the ACP process pinned until they
                  // terminalize or teardown clears the carryover.
                  // Also pin while a terminal status is held only in memory
                  // (project:false) so idle release cannot drop the session
                  // before the continuation drain (or a later project:true path)
                  // delivers the turn_item terminal.
                  const active = yield* Ref.get(activeTurn);
                  if (
                    active !== null &&
                    [...active.subagents.values()].some(acpSubagentHasPendingBackgroundWork)
                  ) {
                    return true;
                  }
                  const carryover = yield* Ref.get(carryoverSubagents);
                  if (
                    carryover !== null &&
                    carryover.subagents.some(acpSubagentHasPendingBackgroundWork)
                  ) {
                    return true;
                  }
                  return false;
                }),
              }
            : {}),
          ...(supportsAcpApprovalModes
            ? {
                setRuntimeMode: (change) =>
                  runtimeTransitionPermit
                    .withPermit(
                      Effect.gen(function* () {
                        const sessionId = yield* Ref.get(activeSessionId);
                        if (
                          sessionId === null ||
                          (yield* Ref.get(providerThreadByNativeSessionId)).get(sessionId)?.id !==
                            change.providerThreadId
                        )
                          return;
                        const modes = yield* readApprovalModes;
                        if (!modes) return;
                        const value = modes.descriptor.currentValue;
                        // A native work mode occupies the same ACP slot. Keep it until
                        // the user returns to Code, when the saved approval level applies.
                        if (!Object.values(modes.approvals).some((choice) => choice.id === value))
                          return;
                        const next =
                          modes.approvals[change.runtimeMode] ??
                          modes.approvals["approval-required"];
                        if (!next) return;
                        const previous = configuredAcpMode;
                        configuredAcpMode = null;
                        yield* setAcpMode(modes.descriptor.id, next.id).pipe(
                          Effect.onError(() =>
                            Effect.sync(() => {
                              configuredAcpMode = previous;
                            }),
                          ),
                        );
                        const reported = yield* readApprovalModes;
                        configuredAcpMode = {
                          value: reported?.descriptor.currentValue ?? next.id,
                          runtimeMode: change.runtimeMode,
                        };
                        yield* (
                          flavor.onSessionConfigurationUpdate?.(
                            yield* runtime.getConfigOptions,
                            yield* runtime.getModeState,
                            yield* activeModelState,
                          ) ?? Effect.void
                        );
                      }),
                    )
                    .pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapter.ProviderAdapterProtocolError({
                            driver,
                            detail: "ACP agent could not change approval mode",
                            cause,
                          }),
                      ),
                    ),
              }
            : {}),
          ensureThread: Effect.fn("AcpAdapterV2.ensureThread")(
            function* (threadInput: ProviderAdapter.ProviderAdapterV2EnsureThreadInput) {
              const now = yield* DateTime.now;
              const sessionId = yield* Ref.get(activeSessionId);
              if (sessionId === null) {
                return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                  driver,
                  detail: "ACP runtime did not produce a session id",
                });
              }
              const initial = makeProviderThread({
                driver,
                providerInstanceId: options.instanceId,
                idAllocator,
                appThreadId: threadInput.threadId,
                providerSessionId: input.providerSessionId,
                nativeThreadId: sessionId,
                ...(itemIdentityVersion === undefined ? {} : { itemIdentityVersion }),
                now,
              });
              const rememberedUsage = (yield* Ref.get(contextUsageBySessionId)).get(sessionId);
              const providerThread =
                rememberedUsage === undefined
                  ? initial
                  : { ...initial, contextUsage: rememberedUsage };
              yield* Ref.update(providerThreadByNativeSessionId, (current) =>
                new Map(current).set(sessionId, providerThread),
              );
              return providerThread;
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterEnsureThreadError({
                      driver,
                      threadId: threadInput.threadId,
                      cause,
                    }),
                ),
              ),
          ),
          resumeThread: Effect.fn("AcpAdapterV2.resumeThread")(
            function* (threadInput: {
              readonly providerThread: OrchestrationV2ProviderThread;
              readonly modelSelection?: ModelSelection;
              readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
            }) {
              return yield* runtimeTransitionPermit.withPermit(
                Effect.gen(function* () {
                  yield* awaitRuntimeTeardown();
                  const sessionId = yield* nativeThreadId(driver, threadInput.providerThread);
                  const previousItemIdentityVersion = itemIdentityVersion;
                  useProviderThreadIdentity(threadInput.providerThread);
                  const restorePreviousItemIdentity = Effect.sync(() => {
                    itemIdentityVersion = previousItemIdentityVersion;
                  });
                  const restartOutcome = yield* restartRuntimeAfterTeardownIfRequired(
                    threadInput.providerThread.appThreadId,
                    sessionId,
                  ).pipe(Effect.tapError(() => restorePreviousItemIdentity));
                  if (
                    restartOutcome.activated !== undefined ||
                    (yield* Ref.get(activeSessionId)) !== sessionId ||
                    restartOutcome.restarted
                  ) {
                    const activated =
                      restartOutcome.activated ??
                      (yield* Ref.set(snapshot, emptySnapshotState()).pipe(
                        Effect.andThen(
                          activateSession(sessionId, threadInput.providerThread.appThreadId).pipe(
                            Effect.tapError(() => restorePreviousItemIdentity),
                          ),
                        ),
                      ));
                    yield* Ref.set(activeSessionId, activated.sessionId);
                    yield* Ref.set(loadingSessionId, null);
                    yield* Ref.set(activeSessionSetup, activated);
                    const nextSelection = threadInput.modelSelection ?? input.modelSelection;
                    const nextRuntimePolicy = threadInput.runtimePolicy ?? input.runtimePolicy;
                    yield* configureSession(activated, nextSelection, nextRuntimePolicy);
                    yield* Ref.set(activeSelection, nextSelection);
                    yield* Ref.set(activeInteractionMode, nextRuntimePolicy.interactionMode);
                  }
                  const now = yield* DateTime.now;
                  return {
                    ...threadInput.providerThread,
                    contextUsage:
                      (yield* Ref.get(contextUsageBySessionId)).get(sessionId) ??
                      threadInput.providerThread.contextUsage,
                    providerSessionId: input.providerSessionId,
                    status: "idle" as const,
                    updatedAt: now,
                  };
                }),
              );
            },
            (effect, threadInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterResumeThreadError({
                      driver,
                      providerSessionId: input.providerSessionId,
                      providerThreadId: threadInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          startTurn,
          ...(compactsContext
            ? {
                compactThread: (turnInput: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                  startTurn({
                    ...turnInput,
                    message: { ...turnInput.message, text: "/compact" },
                  }),
              }
            : {}),
          steerTurn: Effect.fn("AcpAdapterV2.steerTurn")(function* (
            turnInput: ProviderAdapter.ProviderAdapterV2SteerInput,
          ) {
            if (steersWithPrompt) return yield* steerWithPrompt(turnInput);
            const setup = yield* Ref.get(activeSessionSetup);
            const turn = yield* Ref.get(activeTurn);
            const sessionId = yield* Ref.get(activeSessionId);
            if (
              (flavor.steer === undefined &&
                (setup === null || !supportsAcpSteering(setup.initializeResult))) ||
              turn?.providerTurnId !== turnInput.providerTurnId ||
              sessionId === null
            ) {
              return yield* new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                driver,
                providerThreadId: turnInput.providerThread.id,
              });
            }
            const steer = flavor.steer ?? steerAcpTurn;
            if (flavor.steer === undefined) turn.nativeSteerSent = true;
            yield* steer({
              driver,
              runtime,
              sessionId,
              text: providerMessageTextWithAttachmentPaths({
                text: turnInput.message.text,
                attachments: turnInput.message.attachments,
                resolveAttachmentPath: host.resolveAttachmentPath,
              }),
              messageId: turnInput.message.messageId,
              providerTurnId: turnInput.providerTurnId,
              providerThreadId: turnInput.providerThread.id,
              turnOver: {
                await: Effect.raceFirst(
                  Deferred.await(turn.promptWireSettled),
                  Deferred.await(turn.completed),
                ),
                isDone: Effect.zipWith(
                  Deferred.isDone(turn.promptWireSettled),
                  Deferred.isDone(turn.completed),
                  (settled, completed) => settled || completed,
                ),
              },
            });
          }),
          interruptTurn: Effect.fn("AcpAdapterV2.interruptTurn")(
            function* (turnInput: ProviderAdapter.ProviderAdapterV2InterruptInput) {
              return yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  yield* restore(runtimeTransitionPermit.take(1));
                  return yield* Effect.gen(function* () {
                    const transition = yield* Effect.gen(function* () {
                      const interruptContext = yield* Ref.get(activeTurn);
                      // Settled steering restart: the native prompt already
                      // returned and this is not a user Stop, so keep the
                      // process (and its background subagents) alive instead
                      // of hard-killing it. The turn still terminalizes below.
                      const softSteerCandidate =
                        flavor.preserveRuntimeOnSettledInterrupt === true &&
                        turnInput.requestRuntimeRestart !== true &&
                        interruptContext?.providerTurnId === turnInput.providerTurnId;
                      // Settlement is read under the callback permit after
                      // draining admitted responses: the native prompt can have
                      // returned on the wire while its completion callback has
                      // not yet run, and a cancel sent in that window is exactly
                      // what settled-soft mode exists to avoid. Also treat the
                      // turn as settled when the wire signal is already done
                      // (non-blocking; do not await under the permit).
                      let settledSoftInterrupt = false;
                      if (softSteerCandidate && interruptContext !== null) {
                        const promptSettledUnderPermit = yield* runtimeCallbackPermit.withPermit(
                          awaitAdmittedNativeResponses.pipe(
                            Effect.andThen(
                              Effect.sync(() => interruptContext.promptSettled === true),
                            ),
                          ),
                        );
                        const wireSettled = yield* Deferred.isDone(
                          interruptContext.promptWireSettled,
                        );
                        settledSoftInterrupt = promptSettledUnderPermit || wireSettled;
                      }
                      const restartRuntime =
                        !settledSoftInterrupt &&
                        (turnInput.requestRuntimeRestart === true ||
                          flavor.restartRuntimeOnEveryInterrupt === true);
                      const hardRestart =
                        restartRuntime && flavor.terminateRuntimeProcessGroupOnInterrupt === true;
                      if (hardRestart) {
                        const teardownState = yield* Ref.get(runtimeTeardownState);
                        if (teardownState._tag === "Failed") {
                          return yield* teardownState.error;
                        }
                        if (teardownState._tag === "InProgress") {
                          // Concurrent Stop/restart: wait for the in-flight hard
                          // teardown instead of failing the durable effect.
                          yield* Effect.logInfo(
                            "ACP interrupt awaiting in-progress hard teardown",
                            {
                              driver,
                              providerTurnId: turnInput.providerTurnId,
                            },
                          );
                          yield* Deferred.await(teardownState.completed);
                          return undefined;
                        }
                      }
                      const context = interruptContext;
                      if (context?.providerTurnId !== turnInput.providerTurnId) {
                        if (
                          context === null &&
                          turnInput.requestRuntimeRestart === true &&
                          ((lastBackgroundCommandTurn?.input.providerThread.id ===
                            turnInput.providerThread.id &&
                            backgroundCommands.size > 0) ||
                            (reportsBackgroundWait &&
                              Array.from(yield* Ref.get(runningBackgroundTaskIds)).some(
                                (taskId) =>
                                  settledPersistentTasks.get(taskId)?.input.providerThread.id ===
                                  turnInput.providerThread.id,
                              )))
                        ) {
                          yield* runtimeCallbackPermit.withPermit(quarantineStoppedRun());
                          yield* runtime.cancel;
                          return undefined;
                        }
                        // A soft steering interrupt can clear the turn while
                        // intentionally leaving the process alive. A queued user
                        // Stop must still contain that orphan runtime. With a
                        // different live turn active this stays a pure no-op
                        // success instead: quarantine and teardown are
                        // session-global and would maim the replacement turn.
                        const containOrphanRuntime =
                          context === null &&
                          hardRestart &&
                          turnInput.requestRuntimeRestart === true;
                        // Transport death or a prior Stop already cleared the
                        // turn. Failing here caused effect-worker retries while
                        // the process was already gone; treat as success.
                        yield* Effect.logWarning(
                          containOrphanRuntime
                            ? "ACP Stop raced a soft interrupt that cleared the turn; containing the orphan runtime"
                            : "ACP interrupt raced transport teardown or a prior Stop; treating as already interrupted",
                          {
                            driver,
                            requestedProviderTurnId: turnInput.providerTurnId,
                            activeProviderTurnId: context?.providerTurnId ?? null,
                            hardRestart,
                            requestRuntimeRestart: turnInput.requestRuntimeRestart === true,
                            teardownState: (yield* Ref.get(runtimeTeardownState))._tag,
                          },
                        );
                        if (containOrphanRuntime) {
                          const teardownBarrier = yield* Deferred.make<
                            void,
                            ProviderAdapter.ProviderAdapterProtocolError
                          >();
                          yield* runtimeCallbackPermit.withPermit(
                            Effect.gen(function* () {
                              yield* awaitAdmittedNativeResponses;
                              const stoppedGeneration = yield* Ref.get(runtimeCallbackGeneration);
                              yield* quarantineNativeTransportAtGeneration(stoppedGeneration);
                              yield* Ref.set(runtimeTeardownState, {
                                _tag: "InProgress",
                                completed: teardownBarrier,
                              });
                              yield* advanceRuntimeCallbackGeneration;
                            }),
                          );
                          // Capture before quarantineStoppedRun clears carryover.
                          const orphanCarryover = yield* Ref.getAndSet(carryoverSubagents, null);
                          yield* quarantineStoppedRun();
                          // Match the main hard-restart path: cancel pending
                          // approvals/elicitations after quarantine, before kill.
                          yield* cancelPendingRuntimeRequests();
                          yield* terminalizeCarryoverSubagents(orphanCarryover);
                          if (runtime.terminateProcessGroup === undefined) {
                            const error = new ProviderAdapter.ProviderAdapterProtocolError({
                              driver,
                              detail:
                                "ACP runtime does not expose its required process-group teardown; the session is poisoned",
                            });
                            yield* Ref.set(runtimeTeardownState, { _tag: "Failed", error });
                            yield* Deferred.fail(teardownBarrier, error).pipe(Effect.ignore);
                            return yield* error;
                          }
                          const teardownExit = yield* runtime.terminateProcessGroup.pipe(
                            Effect.exit,
                          );
                          if (Exit.isFailure(teardownExit)) {
                            const error = new ProviderAdapter.ProviderAdapterProtocolError({
                              driver,
                              detail:
                                "ACP orphan runtime process-group teardown failed; the session is poisoned",
                              payload: Cause.squash(teardownExit.cause),
                            });
                            yield* Ref.set(runtimeTeardownState, { _tag: "Failed", error });
                            yield* Deferred.fail(teardownBarrier, error).pipe(Effect.ignore);
                            return yield* error;
                          }
                          yield* Ref.set(runtimeRestartRequired, true);
                          yield* Ref.set(runtimeTeardownState, { _tag: "Idle" });
                          yield* Deferred.succeed(teardownBarrier, undefined).pipe(Effect.ignore);
                        }
                        return undefined;
                      }
                      const teardownBarrier = hardRestart
                        ? yield* Deferred.make<void, ProviderAdapter.ProviderAdapterProtocolError>()
                        : null;
                      if (teardownBarrier !== null) {
                        yield* runtimeCallbackPermit.withPermit(
                          Effect.gen(function* () {
                            yield* awaitAdmittedNativeResponses;
                            const stoppedGeneration = yield* Ref.get(runtimeCallbackGeneration);
                            yield* quarantineNativeTransportAtGeneration(stoppedGeneration);
                            yield* Ref.set(runtimeTeardownState, {
                              _tag: "InProgress",
                              completed: teardownBarrier,
                            });
                            yield* advanceRuntimeCallbackGeneration;
                            yield* (
                              options.testHooks?.afterHardTeardownTransportDrained?.() ??
                                Effect.void
                            );
                          }),
                        );
                      }
                      return {
                        context,
                        restartRuntime,
                        hardRestart,
                        teardownBarrier,
                        settledSoftInterrupt,
                      };
                    });
                    // Concurrent hard teardown already completed above.
                    if (transition === undefined) return;
                    const {
                      context,
                      restartRuntime,
                      hardRestart,
                      teardownBarrier,
                      settledSoftInterrupt,
                    } = transition;
                    const poisonTeardown = Effect.fnUntraced(function* (
                      detail: string,
                      payload?: unknown,
                    ) {
                      const error = new ProviderAdapter.ProviderAdapterProtocolError({
                        driver,
                        detail,
                        ...(payload === undefined ? {} : { payload }),
                      });
                      yield* Ref.set(runtimeTeardownState, { _tag: "Failed", error });
                      yield* Deferred.fail(teardownBarrier!, error).pipe(Effect.ignore);
                      return error;
                    });
                    const runTransition = Effect.gen(function* () {
                      context.interrupted = true;
                      // Quarantine only when this run is discarded (user Stop /
                      // hard process kill). Soft in-process restarts must keep
                      // carryoverSubagents so a still-running subagent can
                      // complete into the replacement turn.
                      if (hardRestart || turnInput.requestRuntimeRestart === true) {
                        yield* quarantineStoppedRun();
                      }
                      yield* cancelPendingRuntimeRequests({ stopMcpCalls: !settledSoftInterrupt });
                      // Agents such as Devin leave a foreground command running in a client
                      // terminal after session/cancel; Stop ends it, as it does for others.
                      if (!settledSoftInterrupt && clientTerminals && context.terminalCalls) {
                        const foreground = yield* runtimeCallbackPermit.withPermit(
                          Effect.sync(() => context.terminalCalls!.foreground()),
                        );
                        yield* Effect.forEach(
                          foreground,
                          (request) => clientTerminals.kill(request).pipe(Effect.ignore),
                          { concurrency: "unbounded", discard: true },
                        );
                      }
                      // Finalize before process-group kill so projection/UI cannot
                      // lag a dead transport, and concurrent interrupt effects see
                      // activeTurn cleared (idempotent success) rather than racing.
                      if (
                        (hardRestart || context.promptSettled || settledSoftInterrupt) &&
                        !context.finalized
                      ) {
                        // hardRestart: always terminalize locally.
                        // promptSettled / settledSoftInterrupt (incl. wire-settled):
                        // native prompt already returned; only deferred background
                        // work remains, so session/cancel has nothing to acknowledge.
                        yield* finalizeTurn(context, "interrupted");
                      }
                      if (hardRestart) {
                        if (runtime.terminateProcessGroup === undefined) {
                          return yield* poisonTeardown(
                            "ACP runtime does not expose its required process-group teardown; the session is poisoned",
                          ).pipe(Effect.flatMap(Effect.fail));
                        }
                        const teardownExit = yield* runtime.terminateProcessGroup!.pipe(
                          Effect.exit,
                        );
                        if (Exit.isFailure(teardownExit)) {
                          return yield* poisonTeardown(
                            "ACP runtime process-group teardown failed; the session is poisoned",
                            Cause.squash(teardownExit.cause),
                          ).pipe(Effect.flatMap(Effect.fail));
                        }
                        // Process group is gone; the next turn must spawn a
                        // replacement even if the flavor only set hardRestart
                        // without restartRuntimeAfterInterrupt.
                        yield* Ref.set(runtimeRestartRequired, true);
                        yield* Ref.set(runtimeTeardownState, { _tag: "Idle" });
                        yield* Deferred.succeed(teardownBarrier!, undefined).pipe(Effect.ignore);
                      } else {
                        // Settled soft interrupt: the native prompt already
                        // returned, so session/cancel has nothing to
                        // acknowledge and would only threaten still-running
                        // background subagents. Skip it and leave the runtime
                        // untouched for the replacement turn.
                        if (!settledSoftInterrupt) {
                          yield* runtime.cancel;
                        }
                        // Some agents settle cancellation before clearing the injected input.
                        // Reopen the durable session before dispatching the next prompt.
                        const reopenSteeredSession =
                          turnInput.requestRuntimeRestart === true &&
                          context.nativeSteerSent &&
                          (canLoadSession || canResumeSession);
                        if (
                          reopenSteeredSession ||
                          (restartRuntime && flavor.restartRuntimeAfterInterrupt === true)
                        ) {
                          yield* Ref.set(runtimeRestartRequired, true);
                        }
                      }
                      const stopped = yield* Deferred.await(context.completed).pipe(
                        Effect.timeoutOption("10 seconds"),
                      );
                      if (Option.isNone(stopped)) {
                        if (!context.finalized) {
                          yield* finalizeTurn(context, "interrupted");
                        }
                        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                          driver,
                          detail: `ACP provider turn ${turnInput.providerTurnId} did not acknowledge cancellation before the interrupt timeout`,
                        });
                      }
                    });
                    if (!hardRestart) {
                      return yield* restore(runTransition);
                    }
                    return yield* runTransition.pipe(
                      Effect.catchCause((cause) =>
                        Effect.gen(function* () {
                          const state = yield* Ref.get(runtimeTeardownState);
                          if (state._tag === "InProgress") {
                            yield* poisonTeardown(
                              "ACP hard teardown failed unexpectedly; the session is poisoned",
                              Cause.squash(cause),
                            );
                          }
                          return yield* Effect.failCause(cause);
                        }),
                      ),
                    );
                  }).pipe(Effect.ensuring(runtimeTransitionPermit.release(1)));
                }),
              );
            },
            (effect, turnInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterInterruptError({
                      driver,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      cause,
                    }),
                ),
              ),
          ),
          respondToRuntimeRequest: (requestInput) =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                yield* restore(runtimeTransitionPermit.take(1));
                return yield* Effect.gen(function* () {
                  yield* awaitRuntimeTeardown();
                  const generation = yield* Ref.get(runtimeCallbackGeneration);
                  const pending = (yield* Ref.get(pendingRuntimeRequests)).get(
                    String(requestInput.requestId),
                  );
                  if (pending === undefined || pending.generation !== generation) {
                    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                      driver,
                      detail: `No pending ACP runtime request ${requestInput.requestId}`,
                    });
                  }
                  const settled =
                    pending.type === "user_input"
                      ? yield* Deferred.succeed(pending.answers, requestInput.answers ?? null)
                      : requestInput.decision === undefined
                        ? yield* new ProviderAdapter.ProviderAdapterProtocolError({
                            driver,
                            detail: `ACP approval request ${requestInput.requestId} requires a decision`,
                          })
                        : yield* Deferred.succeed(pending.decision, requestInput.decision);
                  if (!settled) {
                    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                      driver,
                      detail: `ACP runtime request ${requestInput.requestId} was already resolved`,
                    });
                  }
                  yield* awaitNativeResponseAcknowledgements([
                    [pending.transportRequestId, pending.nativeResponseAcknowledgement],
                  ]);
                  yield* Deferred.await(pending.nativeResponseAcknowledgement);
                }).pipe(Effect.ensuring(runtimeTransitionPermit.release(1)));
              }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver,
                    requestId: requestInput.requestId,
                    cause,
                  }),
              ),
            ),
          readThreadSnapshot: Effect.fn("AcpAdapterV2.readThreadSnapshot")(
            function* (snapshotInput) {
              return yield* runtimeTransitionPermit.withPermit(
                Effect.gen(function* () {
                  yield* awaitRuntimeTeardown();
                  useProviderThreadIdentity(snapshotInput.providerThread);
                  yield* restartRuntimeAfterTeardownIfRequired(
                    snapshotInput.providerThread.appThreadId,
                  );
                  const sessionId = yield* nativeThreadId(driver, snapshotInput.providerThread);
                  if ((yield* Ref.get(activeSessionId)) !== sessionId) {
                    if (!capabilities.threads.canReadThreadSnapshot) {
                      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                        driver,
                        detail: "ACP driver does not support session/load snapshots",
                      });
                    }
                    yield* Ref.set(snapshot, emptySnapshotState());
                    const mcpContext = yield* readMcpContext(
                      snapshotInput.providerThread.appThreadId,
                    );
                    prepareTerminalEnvironment(mcpContext, sessionId);
                    yield* Ref.set(loadingSessionId, sessionId);
                    const activated = yield* runtime
                      .loadSession(sessionId, acpMcpActivation(mcpContext))
                      .pipe(Effect.onError(() => Ref.set(loadingSessionId, null)));
                    rememberTerminalEnvironment(
                      activated.sessionId,
                      yield* readMcpContext(snapshotInput.providerThread.appThreadId),
                    );
                    yield* Ref.set(activeSessionId, activated.sessionId);
                    yield* Ref.set(loadingSessionId, null);
                    yield* Ref.set(activeSessionSetup, activated);
                    yield* Ref.set(activeSelection, null);
                    yield* Ref.set(activeInteractionMode, null);
                  }
                  const state = yield* Ref.get(snapshot);
                  const messages = state.order.flatMap((key) => {
                    const message = state.messages.get(key);
                    return message === undefined ||
                      (message.text.trim().length === 0 && message.attachments.length === 0)
                      ? []
                      : [message];
                  });
                  const now = yield* DateTime.now;
                  return {
                    providerThread: {
                      ...snapshotInput.providerThread,
                      providerSessionId: input.providerSessionId,
                      status: "idle" as const,
                      updatedAt: now,
                    },
                    // Turn events carry usage and generation to orchestration.
                    messages,
                    reasoningMessageIds: [...state.reasoningIds],
                    runtimeRequests: [],
                    providerPayload: { protocol: ACP_PROTOCOL, sessionId },
                  };
                }),
              );
            },
            (effect, snapshotInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                      driver,
                      providerThreadId: snapshotInput.providerThread.id,
                      cause,
                    }),
                ),
              ),
          ),
          rollbackThread: (rollbackInput) =>
            runtimeTransitionPermit
              .withPermit(
                Effect.gen(function* () {
                  const currentTurn = yield* Ref.get(activeTurn);
                  if (currentTurn !== null) {
                    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                      driver,
                      detail: `Cannot roll back ACP provider thread ${rollbackInput.providerThread.id} while turn ${currentTurn.providerTurnId} is active`,
                    });
                  }
                  // ACP defines no conversation truncation, so rollback stages
                  // a fresh native session before retiring the original.
                  // Returning its binding keeps the next turn runnable without
                  // loading any of the rolled-back conversation.
                  yield* awaitRuntimeTeardown();
                  itemIdentityVersion = 2;
                  prepareTerminalEnvironment(
                    yield* readMcpContext(rollbackInput.providerThread.appThreadId),
                  );
                  const replacement = yield* startReplacementAcpRuntime(
                    rollbackInput.providerThread.appThreadId,
                    (candidate) =>
                      Effect.gen(function* () {
                        rememberTerminalEnvironment(
                          candidate.sessionId,
                          yield* readMcpContext(rollbackInput.providerThread.appThreadId),
                        );
                        yield* Ref.set(runtimeRestartRequired, false);
                        yield* Ref.set(activeSessionId, candidate.sessionId);
                        yield* Ref.set(activeSessionSetup, candidate);
                        yield* Ref.set(activeSelection, null);
                        yield* Ref.set(activeInteractionMode, null);
                        yield* Ref.set(promptInstructionStates, new Map());
                        yield* Ref.set(compactionMarkers, new Map());
                        yield* Ref.set(snapshot, emptySnapshotState());
                        yield* endBackgroundCommands("interrupted");
                        yield* continuationPermit.withPermit(
                          Effect.gen(function* () {
                            yield* Ref.update(continuationGeneration, (value) => value + 1);
                            yield* Ref.set(stoppedRunQuarantine, false);
                            yield* Ref.set(wakeBuffer, []);
                            yield* Ref.set(wakeReports, noWakeReports);
                            yield* Ref.set(continuationRequested, false);
                            yield* Ref.set(runningBackgroundTaskIds, new Set());
                            yield* Ref.set(endedBackgroundTaskIds, new Set());
                            yield* Ref.set(midTurnUnreportedCompletedTaskIds, new Set());
                            yield* Ref.set(handledBackgroundTaskIdsInActiveTurn, new Set());
                            yield* Ref.set(carryoverSubagents, null);
                            yield* Ref.set(suppressPostSettleMonitorPrompt, false);
                            yield* Ref.set(lastTurnRoute, null);
                          }),
                        );
                      }),
                  ).pipe(Effect.retry({ times: 1 }));
                  const now = yield* DateTime.now;
                  return {
                    providerThread: {
                      ...rollbackInput.providerThread,
                      nativeThreadRef: {
                        driver,
                        nativeId: replacement.sessionId,
                        strength: "strong" as const,
                      },
                      nativeConversationHeadRef: null,
                      nativeMetadata: {
                        ...rollbackInput.providerThread.nativeMetadata,
                        itemIdentityVersion: 2 as const,
                      },
                      status: "idle" as const,
                      updatedAt: now,
                    },
                    messages: [],
                    runtimeRequests: [],
                  };
                }),
              )
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterRollbackThreadError({
                      driver,
                      providerThreadId: rollbackInput.providerThread.id,
                      checkpointId: rollbackInput.target.checkpointId,
                      cause,
                    }),
                ),
              ),
          forkThread: Effect.fn("AcpAdapterV2.forkThread")(
            function* (forkInput) {
              return yield* runtimeTransitionPermit.withPermit(
                Effect.gen(function* () {
                  yield* awaitRuntimeTeardown();
                  useProviderThreadIdentity(forkInput.sourceProviderThread);
                  yield* restartRuntimeAfterTeardownIfRequired(
                    forkInput.sourceProviderThread.appThreadId,
                  );
                  if (!capabilities.threads.canForkThread) {
                    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                      driver,
                      detail: "ACP driver did not negotiate session/fork",
                    });
                  }
                  if (forkInput.providerTurnId !== undefined) {
                    return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                      driver,
                      detail: "ACP session/fork can only fork the current session head",
                    });
                  }
                  const sourceSessionId = yield* nativeThreadId(
                    driver,
                    forkInput.sourceProviderThread,
                  );
                  const mcpContext = yield* readMcpContext(forkInput.targetThreadId);
                  prepareTerminalEnvironment(mcpContext);
                  const forked = yield* runtime.forkSession(
                    sourceSessionId,
                    acpMcpActivation(mcpContext),
                  );
                  rememberTerminalEnvironment(
                    forked.sessionId,
                    yield* readMcpContext(forkInput.targetThreadId),
                  );
                  yield* Ref.set(activeSessionId, forked.sessionId);
                  yield* Ref.set(activeSessionSetup, forked);
                  yield* Ref.set(activeSelection, null);
                  yield* Ref.set(activeInteractionMode, null);
                  itemIdentityVersion = 2;
                  const now = yield* DateTime.now;
                  const providerThread = makeProviderThread({
                    driver,
                    providerInstanceId: options.instanceId,
                    idAllocator,
                    appThreadId: forkInput.targetThreadId,
                    providerSessionId: input.providerSessionId,
                    nativeThreadId: forked.sessionId,
                    itemIdentityVersion: 2,
                    ...(forkInput.ownerNodeId === undefined
                      ? {}
                      : { ownerNodeId: forkInput.ownerNodeId }),
                    forkedFrom: {
                      providerThreadId: forkInput.sourceProviderThread.id,
                      ...(forkInput.providerTurnId === undefined
                        ? {}
                        : { providerTurnId: forkInput.providerTurnId }),
                    },
                    now,
                  });
                  yield* Ref.update(providerThreadByNativeSessionId, (current) =>
                    new Map(current).set(forked.sessionId, providerThread),
                  );
                  return providerThread;
                }),
              );
            },
            (effect, forkInput) =>
              effect.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterForkThreadError({
                      driver,
                      providerThreadId: forkInput.sourceProviderThread.id,
                      cause,
                    }),
                ),
              ),
          ),
        };
        return sessionRuntime;
      },
      (effect, input) =>
        effect.pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver,
                providerSessionId: input.providerSessionId,
                ...(flavor.requiresSignIn?.(cause) === true ? { requiresSignIn: true } : {}),
                cause,
              }),
          ),
        ),
    ),
  });
});

export type AcpAdapterV2Env =
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions;
