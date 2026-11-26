import { SubagentsEnabled } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as NodeURL from "node:url";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { revertCodexThread } from "../../provider/CodexThreadRevert.ts";
import { historyResponseItems } from "@t3tools/provider-core/server/handoffBudget";
import { makeProviderTextDeltaCoalescer } from "./ProviderTextDeltaCoalescer.ts";
import {
  mcpToolPresentation,
  type McpToolPresentation,
} from "../../provider/CodexToolPresentation.ts";
import {
  makeCodexTurnTokenUsageState,
  getCodexTurnAccumulator,
  accumulateCodexTurnTokenUsage,
  codexTokenUsageReportIsNew,
  completeCodexTurnTokenUsage,
  type CodexTurnTokenUsageState,
} from "../../provider/CodexTurnTokenUsage.ts";
import {
  type CodexGeneration,
  endCodexReply,
  makeCodexGeneration,
  observeCodexOutput,
  observeCodexResponseEnd,
  observeCodexToolStart,
} from "./CodexGeneration.ts";
import { generationSnapshot } from "@t3tools/shared/generationRate";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import type { CodexEffectiveRuntime } from "../../provider/CodexManagedRuntime.ts";
import {
  buildCodexInitializeParams,
  codexAppServerEnvironment,
} from "../../provider/CodexProvider.ts";
import {
  codexRateLimitsToUpdate,
  mergeCodexRateLimits,
  codexMessageResetAt,
  codexTimeZone,
  codexUsageLimitResetAt,
  type CodexRateLimitSnapshot,
} from "../../provider/codexUsageLimits.ts";
import {
  type ServerProvider,
  CodexSettings,
  defaultInstanceIdForDriver,
  isOrchestrationV2WorkActive,
  OrchestrationV2ProviderGoal,
  ProviderDriverKind,
  ProviderSessionId,
  type ProviderSetupError,
  type SideChatActivity,
} from "@t3tools/contracts";
import {
  CODEX_SIDE_CONVERSATION_BOUNDARY,
  CODEX_SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS,
  codexSideConversationActivityLabel,
  codexSleepLabel,
} from "../../provider/CodexSideConversation.ts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { isWorkspaceImagePreviewPath } from "@t3tools/shared/filePreview";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  COMPUTER_USE_TOOL_SOURCE,
  dynamicToolSurface,
  dynamicToolTitle,
} from "@t3tools/shared/toolActivity";
import { getModelSelectionStringOptionValue, modelSelectionsEqual } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import {
  appendTerminalOutput,
  EMPTY_TERMINAL_OUTPUT,
  TERMINAL_OUTPUT_TAIL_CHARS,
  type TerminalOutputState,
} from "@t3tools/shared/terminalOutput";
import type {
  ChatAttachment,
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  ModelSelection,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2PlanStep,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
  ProviderUserInputAnswers,
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  ProviderThreadId,
  ProviderTurnId,
  ProviderInstanceId,
  RuntimeMode,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH } from "@t3tools/shared/toolOutput";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexSchema from "effect-codex-app-server/schema";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Cache from "effect/Cache";
import * as ScopedCache from "effect/ScopedCache";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { resolveAttachmentPath, resolveAttachmentPathById } from "../../attachmentStore.ts";
import { getCodexServiceTierOptionValue } from "../../codexModelOptions.ts";
import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  buildCodexAdditionalContext,
  buildCodexBrowserContext,
  buildCodexDeveloperInstructions,
  type CodexHostBrowser,
} from "../../provider/CodexDeveloperInstructions.ts";
import {
  describeMcpElicitation,
  toMcpElicitationResponse,
} from "../../provider/CodexMcpElicitation.ts";
import {
  CODEX_SQLITE_RECOVERY_GUIDANCE,
  materializeCodexShadowHome,
  mergeCodexEnvironment,
  resolveCodexHomeLayout,
  withCodexSqliteHome,
} from "../../provider/Drivers/CodexHomeLayout.ts";
import {
  boundProviderEventForLogging,
  shouldPersistProviderEvent,
} from "../../provider/EventNdjsonLogger.ts";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { codexAppServerArgs, resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { codexLaunchArgsWithSharedSkills } from "../../sharedSkills/library.ts";
import { field, text as fieldText } from "../unknownField.ts";
import { CHAT_ID_ENV, CODEX_APP_SERVER_ENV } from "../../process/agentScope.ts";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  MCP_APP_EXTENSION_ID,
  MCP_APP_MIME_TYPE,
  MCP_APP_OUTPUT_KEY,
  MCP_APP_RESOURCE_SCHEME,
} from "@t3tools/shared/mcpApp";
import { snapshotMcpApp } from "../../mcpApps/McpAppSnapshot.ts";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@t3tools/provider-core/server/adapterDriver";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { backgroundWorkNotification } from "@t3tools/provider-core/server/notification";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
  makeProviderRetryTurnItem,
  providerAccountFailureReason,
  classifyProviderFailure,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const CODEX_PROVIDER = ProviderDriverKind.make("codex");
export const CODEX_DRIVER_KIND = CODEX_PROVIDER;
export const CODEX_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(CODEX_DRIVER_KIND);

/** Describe approval scope even when Codex omits or blanks the optional reason. */
export function codexFileChangeApprovalPrompt(input: {
  readonly reason?: string | null;
  readonly grantRoot?: string | null;
  readonly fileChanges?: CodexSchema.ServerRequest__ApplyPatchApprovalParams["fileChanges"];
}): string | undefined {
  const reason = input.reason?.trim();
  if (reason) return reason;
  const entries = Object.entries(input.fileChanges ?? {}).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length > 0) {
    const described = entries.slice(0, 20).map(([path, change]) => {
      const movePath = change.type === "update" ? change.move_path : undefined;
      return movePath ? `${change.type} ${path} -> ${movePath}` : `${change.type} ${path}`;
    });
    const remaining = entries.length - described.length;
    return remaining > 0 ? `${described.join("\n")}\n+${remaining} more` : described.join("\n");
  }
  return input.grantRoot?.trim() || undefined;
}

// Reasoning effort changes future generation, not the existing context's tokenizer
// or model window. All other option changes remain untrusted until new telemetry.
export function canReuseCodexContextUsage(previous: ModelSelection, next: ModelSelection): boolean {
  return modelSelectionsEqual(
    {
      ...previous,
      options: (previous.options ?? []).filter((option) => option.id !== "reasoningEffort"),
    },
    { ...next, options: (next.options ?? []).filter((option) => option.id !== "reasoningEffort") },
  );
}

export function codexProviderTurnTokenUsage(
  tokenUsage: CodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
  updatedAt: string,
) {
  return {
    usedTokens: Math.max(0, tokenUsage.last.totalTokens),
    maxTokens: tokenUsage.modelContextWindow ?? null,
    inputTokens: Math.max(0, tokenUsage.last.inputTokens),
    cachedInputTokens: Math.max(0, tokenUsage.last.cachedInputTokens),
    outputTokens: Math.max(0, tokenUsage.last.outputTokens),
    reasoningOutputTokens: Math.max(0, tokenUsage.last.reasoningOutputTokens),
    updatedAt,
  };
}
const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS = 50;
// Each plan flush stores the whole plan three times (node, plan, turn item), so
// flush at the cadence clients already see for assistant text.
const CODEX_PLAN_DELTA_FLUSH_INTERVAL_MS = 400;
const CodexBackgroundTerminalTerminateResponse = Schema.Struct({
  terminated: Schema.Boolean,
});
const CodexBackgroundTerminalsListResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      processId: Schema.String,
    }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
type CodexBackgroundTerminalsListPage = typeof CodexBackgroundTerminalsListResponse.Type;
const decodeCodexBackgroundTerminalTerminateResponse = Schema.decodeUnknownEffect(
  CodexBackgroundTerminalTerminateResponse,
);
const decodeCodexBackgroundTerminalsListResponse = Schema.decodeUnknownEffect(
  CodexBackgroundTerminalsListResponse,
);
const CODEX_CLIENT_CAPABILITIES = {
  experimentalApi: true,
  optOutNotificationMethods: ["turn/diff/updated"],
  // Declares MCP Apps support (SEP-1724 extension negotiation), so servers
  // attach their UI resources and Codex reports them on tool call items.
  extensions: { [MCP_APP_EXTENSION_ID]: { mimeTypes: [MCP_APP_MIME_TYPE] } },
} as const;

export const CodexProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: true,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: true,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: true,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: true,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: true,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: true,
  },
  planning: {
    emitsPlanUpdated: true,
    emitsTodoList: true,
    emitsProposedPlan: true,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: true,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: true,
  },
  context: {
    acceptsSystemContext: true,
    acceptsDeveloperContext: true,
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
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: {
    enforcement: "native",
  },
} satisfies OrchestrationV2ProviderCapabilities;

function toProtocolError(
  detail: string,
  payload?: unknown,
): ProviderAdapter.ProviderAdapterProtocolError {
  return new ProviderAdapter.ProviderAdapterProtocolError({
    driver: CODEX_PROVIDER,
    detail,
    ...(payload === undefined ? {} : { payload }),
  });
}

function normalizeCodexCause(error: unknown): unknown {
  return error;
}

/** The turn's output speed, once a response has been timed. */
function codexGenerationField(context: Pick<ActiveCodexTurnContext, "generation">) {
  const generation = generationSnapshot(context.generation.meter);
  return generation === undefined ? {} : { generation };
}

function observeCodexItemStarted(
  generation: CodexGeneration,
  type: CodexSchema.V2ItemStartedNotification["item"]["type"],
  at: DateTime.Utc,
): void {
  switch (type) {
    case "agentMessage":
    case "plan":
      observeCodexOutput(generation, at, "text");
      return;
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    case "webSearch":
    case "imageView":
    case "imageGeneration":
      observeCodexToolStart(generation, at);
      return;
    default:
      // Reasoning arrives whole once it is done; the rest is not model output.
      return;
  }
}

function codexTimestamp(seconds: number | null | undefined): DateTime.Utc {
  return seconds === null || seconds === undefined
    ? DateTime.nowUnsafe()
    : DateTime.makeUnsafe(seconds * 1000);
}

function codexUserMessageText(
  content: ReadonlyArray<CodexSchema.V2ItemCompletedNotification__UserInput>,
): string {
  return content
    .flatMap((item) => (item.type === "text" ? [item.text] : []))
    .join("\n")
    .trim();
}

function mapCodexTurnStatus(
  status: CodexSchema.V2TurnCompletedNotification__TurnStatus,
): OrchestrationV2ProviderTurn["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "inProgress":
      return "running";
  }
}

function providerTurnStatusToTerminal(
  status: OrchestrationV2ProviderTurn["status"],
): Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }>["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "interrupted":
      return "interrupted";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "pending":
    case "running":
      return "failed";
  }
}

function codexItemStatus(status: "inProgress" | "completed" | "failed" | "declined"): {
  readonly node: OrchestrationV2ExecutionNode["status"];
  readonly turnItem: OrchestrationV2TurnItem["status"];
  readonly completed: boolean;
} {
  switch (status) {
    case "inProgress":
      return { node: "running", turnItem: "running", completed: false };
    case "completed":
      return {
        node: "completed",
        turnItem: "completed",
        completed: true,
      };
    case "failed":
      return { node: "failed", turnItem: "failed", completed: true };
    case "declined":
      return {
        node: "cancelled",
        turnItem: "cancelled",
        completed: true,
      };
  }
}

/**
 * The composers let a skill be typed with any currency sigil (`€review`), but
 * Codex only parses `$name` as a skill mention. Rewrite the sigil so the skill
 * runs; currency amounts like `€20` do not match and stay prose.
 */
export function codexSkillMentionText(text: string): string {
  return text.replace(SKILL_MENTION_PATTERN, "$1$$$2");
}

const BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH = 200;
const BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH = 1_000;

export function codexBackgroundCommandDetail(item: {
  readonly command: string;
  readonly exitCode?: number | null | undefined;
  readonly aggregatedOutput?: string | null | undefined;
}): string {
  // Codex rejects a turn/start with a lone surrogate and never answers it, so cut on code points.
  let commandEnd = BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH;
  const finalCommandUnit = item.command.charCodeAt(commandEnd - 1);
  if (finalCommandUnit >= 0xd800 && finalCommandUnit <= 0xdbff) commandEnd -= 1;
  const command =
    item.command.length > BACKGROUND_COMMAND_DETAIL_COMMAND_MAX_LENGTH
      ? `${item.command.slice(0, commandEnd)}...`
      : item.command;
  const exit =
    item.exitCode === null || item.exitCode === undefined ? "" : ` (exit ${item.exitCode})`;
  const output = (item.aggregatedOutput ?? "").trimEnd();
  let outputStart = output.length - BACKGROUND_COMMAND_DETAIL_OUTPUT_TAIL_MAX_LENGTH;
  const firstOutputUnit = output.charCodeAt(outputStart);
  if (firstOutputUnit >= 0xdc00 && firstOutputUnit <= 0xdfff) outputStart += 1;
  const outputTail = outputStart > 0 ? `...${output.slice(outputStart)}` : output;
  const header = `Background command completed${exit}: ${command}`;
  return outputTail.length === 0 ? header : `${header}\n\nOutput tail:\n${outputTail}`;
}

function codexNativeSubagentLabel(task: OrchestrationV2Subagent): string | undefined {
  return task.title?.trim() || task.prompt.trim() || undefined;
}

function codexNativeSubagentDetail(task: OrchestrationV2Subagent): string {
  const header = `Subagent ${task.status}: ${codexNativeSubagentLabel(task) ?? task.id}`;
  return task.result == null || task.result.length === 0
    ? header
    : `${header}\n\nResult:\n${task.result}`;
}

export interface CodexDynamicToolProjection extends McpToolPresentation {
  readonly toolName: string;
  readonly title?: string;
  readonly input: unknown;
  readonly output?: unknown;
  readonly status: OrchestrationV2TurnItem["status"];
}

function codexMcpToolOutput(
  item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>,
): unknown | undefined {
  const resultOutput =
    item.result === null || item.result === undefined
      ? undefined
      : item.result.structuredContent !== null && item.result.structuredContent !== undefined
        ? item.result.structuredContent
        : item.result.content;

  if (item.error === null || item.error === undefined) {
    return resultOutput;
  }
  return resultOutput === undefined
    ? { error: item.error.message }
    : { error: item.error.message, result: resultOutput };
}

// Reading an app's resource is one MCP round trip; a server that hangs must not
// hold the item (and the run's ingestion) open.
const MCP_APP_CAPTURE_TIMEOUT = "20 seconds";
const CODEX_APP_SERVER_REQUEST_DEADLINE = "2 minutes";
// Initialize normally answers in under a second; leave room for a slow first launch.
const CODEX_INITIALIZE_TIMEOUT = "30 seconds";
const CODEX_APP_SERVER_FORCE_KILL_AFTER = "2 seconds";

export class CodexAppServerUnresponsiveError extends Schema.TaggedError<CodexAppServerUnresponsiveError>()(
  "CodexAppServerUnresponsiveError",
  { method: Schema.String, deadline: Schema.optional(Schema.String) },
) {
  override get message() {
    return `Codex app-server did not answer ${this.method} within ${this.deadline ?? CODEX_APP_SERVER_REQUEST_DEADLINE}.`;
  }
}

/** The UI resource a completed Codex MCP tool call names, under any field Codex reports it in. */
function codexMcpAppResourceUri(item: CodexDynamicToolItem): string | undefined {
  if (item.type !== "mcpToolCall") return undefined;
  const uri = item.mcpAppUi?.resourceUri ?? item.mcpAppResourceUri ?? item.appContext?.resourceUri;
  return typeof uri === "string" && uri.startsWith(MCP_APP_RESOURCE_SCHEME) ? uri : undefined;
}

function codexDynamicToolOutput(
  item: Extract<CodexDynamicToolItem, { readonly type: "dynamicToolCall" }>,
): unknown | undefined {
  if (item.contentItems !== null && item.contentItems !== undefined) {
    return item.contentItems;
  }
  return item.success === false ? { success: false } : undefined;
}

export const projectCodexDynamicToolItem = Effect.fn("CodexAdapterV2.projectDynamicToolItem")(
  function* (
    item: CodexDynamicToolItem,
  ): Effect.fn.Return<CodexDynamicToolProjection, never, Crypto.Crypto> {
    const output =
      item.type === "mcpToolCall" ? codexMcpToolOutput(item) : codexDynamicToolOutput(item);
    const toolName =
      item.type === "mcpToolCall"
        ? `${item.server}.${item.tool}`
        : [trimText(item.namespace), item.tool].filter(Boolean).join(".");
    const presentation: McpToolPresentation =
      item.type === "mcpToolCall" ? yield* mcpToolPresentation(item) : {};
    const title =
      dynamicToolTitle(toolName, item.arguments, presentation.title) ?? presentation.title;
    const toolSurface = presentation.toolSurface ?? dynamicToolSurface(toolName, item.arguments);
    const toolSource =
      toolSurface === "computer" && presentation.toolSource?.kind !== "computer"
        ? COMPUTER_USE_TOOL_SOURCE
        : presentation.toolSource;
    const projection: CodexDynamicToolProjection = {
      ...presentation,
      ...(toolSurface ? { toolSurface } : {}),
      ...(toolSource ? { toolSource } : {}),
      toolName,
      ...(title ? { title } : {}),
      input: item.arguments,
      status: codexItemStatus(item.status).turnItem,
    };
    return output === undefined ? projection : { ...projection, output };
  },
);

function codexNativeItemRef(nativeItemId: string) {
  return {
    driver: CODEX_PROVIDER,
    nativeId: nativeItemId,
    strength: "strong" as const,
  };
}

function trimText(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function nonEmptyText(value: string | null | undefined, fallback: string): string {
  return trimText(value) ?? fallback;
}

function codexPlanStepStatus(
  status: CodexSchema.V2TurnPlanUpdatedNotification__TurnPlanStepStatus,
): OrchestrationV2PlanStep["status"] {
  switch (status) {
    case "completed":
      return "completed";
    case "inProgress":
      return "running";
    case "pending":
      return "pending";
  }
}

function approvalDecisionToLegacyReviewDecision(
  decision: ProviderApprovalDecision,
): CodexSchema.ExecCommandApprovalResponse__ReviewDecision {
  switch (decision) {
    case "accept":
      return "approved";
    case "acceptForSession":
    case "acceptAlways":
      return "approved_for_session";
    case "decline":
      return { denied: { rejection: "User declined the request." } };
    case "cancel":
      return "abort";
  }
}

function providerRequestKindFromPermissions(
  permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"],
): ProviderRequestKind {
  if (
    (permissions.fileSystem?.write?.length ?? 0) > 0 ||
    permissions.fileSystem?.entries?.some((entry) => entry.access === "write")
  ) {
    return "file-change";
  }
  if (
    (permissions.fileSystem?.read?.length ?? 0) > 0 ||
    permissions.fileSystem?.entries?.some((entry) => entry.access === "read")
  ) {
    return "file-read";
  }
  return "command";
}

const MAX_CODEX_APPROVAL_DETAIL_CHARS = 16_000;
const CODEX_APPROVAL_TOO_LARGE =
  "This request is too large to display safely. Deny it and ask for a smaller request.";
const CODEX_DENY_ONLY = [
  { decision: "decline", label: "Deny" },
] as const satisfies ReadonlyArray<ProviderApprovalOption>;

function boundedCodexApprovalDetail(parts: ReadonlyArray<string | undefined>): string | undefined {
  const detail = parts.filter((part): part is string => part !== undefined).join("\n\n");
  return detail.length <= MAX_CODEX_APPROVAL_DETAIL_CHARS ? detail : undefined;
}

function codexPermissionApprovalDetail(
  payload: CodexSchema.PermissionsRequestApprovalParams,
): string | undefined {
  return boundedCodexApprovalDetail([
    payload.reason ? `Reason: ${payload.reason}` : undefined,
    `Working directory: ${JSON.stringify(payload.cwd)}`,
    `Requested permissions:\n${JSON.stringify(payload.permissions, null, 2)}`,
  ]);
}

function codexCommandApprovalDetail(
  payload: CodexSchema.CommandExecutionRequestApprovalParams,
): string | undefined {
  return boundedCodexApprovalDetail([
    payload.reason ? `Reason: ${payload.reason}` : undefined,
    payload.command ? `Command: ${payload.command}` : undefined,
    payload.cwd ? `Working directory: ${JSON.stringify(payload.cwd)}` : undefined,
    payload.networkApprovalContext
      ? `Network destination:\n${JSON.stringify(payload.networkApprovalContext, null, 2)}`
      : undefined,
    payload.proposedNetworkPolicyAmendments?.length
      ? `Proposed network rules:\n${JSON.stringify(payload.proposedNetworkPolicyAmendments, null, 2)}`
      : undefined,
  ]);
}

function permissionsResponseFromDecision(input: {
  readonly decision: ProviderApprovalDecision;
  readonly permissions: CodexSchema.PermissionsRequestApprovalParams["permissions"];
}): CodexSchema.PermissionsRequestApprovalResponse {
  if (input.decision !== "accept" && input.decision !== "acceptForSession") {
    return { permissions: {}, scope: "turn" };
  }

  return {
    permissions: input.permissions,
    scope: input.decision === "acceptForSession" ? "session" : "turn",
  };
}

function answerValueToStrings(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }
  if (typeof value === "string") {
    return [value];
  }
  if (value === null || value === undefined) {
    return [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return [String(value)];
  }
  return [JSON.stringify(value)];
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
  allowedQuestionIds: ReadonlySet<string>,
): CodexSchema.ToolRequestUserInputResponse["answers"] {
  return Object.fromEntries(
    Object.entries(answers).flatMap(([questionId, value]) =>
      allowedQuestionIds.has(questionId)
        ? [[questionId, { answers: [...answerValueToStrings(value)] }]]
        : [],
    ),
  );
}

function compactStrings(values: ReadonlyArray<string | null | undefined>): ReadonlyArray<string> {
  // Codex derives the item's `query` from its action, so it often repeats an action value.
  return [
    ...new Set(
      values.flatMap((value) => {
        const trimmed = trimText(value);
        return trimmed === undefined ? [] : [trimmed];
      }),
    ),
  ];
}

function webSearchPatterns(item: CodexWebSearchItem): ReadonlyArray<string> {
  if (item.action === null || item.action === undefined) {
    return compactStrings([item.query]);
  }

  switch (item.action.type) {
    case "search":
      return compactStrings([...(item.action.queries ?? []), item.action.query, item.query]);
    case "openPage":
      return compactStrings([item.action.url, item.query]);
    case "findInPage":
      return compactStrings([item.action.pattern, item.action.url, item.query]);
    case "other":
      return compactStrings([item.query]);
  }
}

const decodeTurnApprovalPolicy = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__AskForApproval, Schema.Null]),
);
const decodeTurnSandboxPolicy = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__SandboxPolicy, Schema.Null]),
);
const decodeTurnReasoningEffort = Schema.decodeUnknownEffect(
  Schema.Union([CodexSchema.V2TurnStartParams__ReasoningEffort, Schema.Null]),
);

const CodexAdditionalContext = Schema.Record(
  Schema.String,
  CodexSchema.V2TurnStartParams__AdditionalContextEntry,
);
const encodeCodexAdditionalContextJson = Schema.encodeEffect(
  Schema.fromJsonString(CodexAdditionalContext),
);
const CodexTurnStartParamsWithCollaborationMode = CodexSchema.V2TurnStartParams.pipe(
  Schema.fieldsAssign({
    collaborationMode: Schema.optionalKey(CodexSchema.ClientRequest__CollaborationMode),
    additionalContext: Schema.optionalKey(CodexAdditionalContext),
  }),
);
type CodexTurnStartParamsWithCollaborationMode =
  typeof CodexTurnStartParamsWithCollaborationMode.Type;
const decodeCodexTurnStartParamsWithCollaborationMode = Schema.decodeUnknownEffect(
  CodexTurnStartParamsWithCollaborationMode,
);
const isProviderAdapterRuntimeRequestResponseError = Schema.is(
  ProviderAdapter.ProviderAdapterRuntimeRequestResponseError,
);

function codexRuntimeModeTurnDefaults(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: CodexSchema.V2TurnStartParams__AskForApproval;
  readonly approvalsReviewer: CodexSchema.V2TurnStartParams__ApprovalsReviewer;
  readonly sandboxPolicy: CodexSchema.V2TurnStartParams__SandboxPolicy;
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "readOnly",
        },
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "auto":
      return {
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
      };
    case "full-access":
      return {
        // `never` also rejects browser and app access prompts before the client sees them.
        approvalPolicy: {
          granular: {
            mcp_elicitations: true,
            request_permissions: false,
            rules: false,
            sandbox_approval: false,
            skill_approval: false,
          },
        },
        approvalsReviewer: "user",
        sandboxPolicy: {
          type: "dangerFullAccess",
        },
      };
  }
}

export function buildCodexTurnStartParams(input: {
  readonly nativeThreadId: string;
  readonly codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly modelSelection: ModelSelection;
  readonly hasT3Mcp?: boolean;
  readonly configuredReasoningEffort?: string | null | undefined;
  readonly chatTempDir?: string | undefined;
  readonly browserToolsAvailable?: boolean;
  readonly deviceToolsAvailable?: boolean;
  readonly toolDiscoveryCatalog?: string | undefined;
  /** The Mac's default browser for Codex's Computer Use; omitted off macOS. */
  readonly hostBrowser?: CodexHostBrowser | null | undefined;
  /** ChatGPT token sharing does not accept service tiers. */
  readonly omitServiceTier?: boolean;
  /** What the thread's MCP Apps want the agent to know (`ui/update-model-context`). */
  readonly appContext?: ProviderAdapter.ProviderAdapterV2TurnInput["appContext"];
  readonly isSubagent?: boolean;
  /** Selects the solo orchestration text when this chat has subagents off. */
  readonly threadId?: string;
}) {
  return Effect.gen(function* () {
    const runtimeModeDefaults = codexRuntimeModeTurnDefaults(input.runtimePolicy.runtimeMode);
    const approvalPolicy =
      input.runtimePolicy.approvalPolicy === undefined
        ? runtimeModeDefaults.approvalPolicy
        : yield* decodeTurnApprovalPolicy(input.runtimePolicy.approvalPolicy);
    const sandboxPolicy =
      input.runtimePolicy.sandboxPolicy === undefined
        ? runtimeModeDefaults.sandboxPolicy
        : yield* decodeTurnSandboxPolicy(input.runtimePolicy.sandboxPolicy);
    const selectedEffort = getModelSelectionStringOptionValue(
      input.modelSelection,
      "reasoningEffort",
    );
    const effort =
      selectedEffort === undefined ? undefined : yield* decodeTurnReasoningEffort(selectedEffort);
    const serviceTier =
      input.omitServiceTier === true
        ? undefined
        : getCodexServiceTierOptionValue(input.modelSelection);
    // Default mode runs on Codex's own collaboration-mode prompt; only Plan
    // mode carries T3's instructions, which its plan card depends on.
    const developerInstructions =
      input.hasT3Mcp !== true || input.runtimePolicy.interactionMode !== "plan"
        ? undefined
        : buildCodexDeveloperInstructions(input.runtimePolicy.interactionMode);
    // An app's context is text an MCP server wrote, so it goes in as untrusted
    // context: Codex renders it as quoted user-side input, never as developer
    // instructions. Codex resends it only when it changes.
    const appContext = Object.fromEntries(
      (input.appContext ?? []).map((entry) => [
        entry.key,
        { kind: "untrusted" as const, value: entry.text },
      ]),
    );
    const t3Context =
      input.hasT3Mcp === true
        ? // Shared guidance covers optional tools concisely. The discovered
          // tool descriptions carry browser and device operation details.
          buildCodexAdditionalContext(
            { model: input.modelSelection.model, reasoningEffort: effort ?? "medium" },
            false,
            input.threadId,
            yield* SubagentsEnabled,
            input.isSubagent,
          )
        : undefined;
    const browserContext =
      input.hostBrowser === undefined ? undefined : buildCodexBrowserContext(input.hostBrowser);
    const toolCatalogContext =
      input.hasT3Mcp === true && input.toolDiscoveryCatalog !== undefined
        ? {
            t3_code_tool_catalog: {
              kind: "application" as const,
              value: input.toolDiscoveryCatalog
                ? `Available t3-code MCP tools. For a deferred schema, use tool_search with its exact name and limit 1, or filter ALL_TOOLS by name in Code Mode.\n${input.toolDiscoveryCatalog}`
                : "No t3-code MCP tools are currently enabled.",
            },
          }
        : undefined;
    const additionalContext =
      t3Context === undefined &&
      browserContext === undefined &&
      toolCatalogContext === undefined &&
      Object.keys(appContext).length === 0
        ? undefined
        : { ...t3Context, ...browserContext, ...toolCatalogContext, ...appContext };
    // Sent on every turn, with no instructions in Default mode, so a thread
    // leaving Plan mode returns to Codex's own Default mode.
    const collaborationEffort = effort ?? input.configuredReasoningEffort ?? undefined;
    const collaborationMode: CodexSchema.ClientRequest__CollaborationMode | undefined =
      input.hasT3Mcp !== true && input.runtimePolicy.interactionMode !== "plan"
        ? undefined
        : {
            mode: input.runtimePolicy.interactionMode === "plan" ? "plan" : "default",
            settings: {
              model: input.modelSelection.model,
              // Collaboration settings replace the configured effort. Only omit
              // it when config/read has none, letting Codex use the model default.
              ...(collaborationEffort === undefined
                ? {}
                : { reasoning_effort: collaborationEffort }),
              ...(developerInstructions === undefined
                ? {}
                : { developer_instructions: developerInstructions }),
            },
          };

    return yield* decodeCodexTurnStartParamsWithCollaborationMode({
      threadId: input.nativeThreadId,
      input: input.codexInput,
      ...(additionalContext ? { additionalContext } : {}),
      cwd: input.runtimePolicy.cwd,
      model: input.modelSelection.model,
      // Always explicit: omitting this on resume leaves Codex's previous
      // reviewer sticky after switching away from Auto mode.
      approvalsReviewer: runtimeModeDefaults.approvalsReviewer,
      ...(approvalPolicy === undefined ? {} : { approvalPolicy }),
      sandboxPolicy:
        sandboxPolicy?.type === "workspaceWrite" &&
        !sandboxPolicy.excludeTmpdirEnvVar &&
        input.chatTempDir !== undefined
          ? {
              ...sandboxPolicy,
              writableRoots: [
                ...new Set([...(sandboxPolicy.writableRoots ?? []), input.chatTempDir]),
              ],
            }
          : sandboxPolicy,
      ...(effort === undefined ? {} : { effort }),
      ...(serviceTier === undefined ? {} : { serviceTier }),
      ...(collaborationMode === undefined ? {} : { collaborationMode }),
    });
  });
}

function needsCodexConfiguredEffort(
  modelSelection: ModelSelection,
  interactionMode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["interactionMode"],
  hasT3Mcp: boolean,
): boolean {
  return (
    (hasT3Mcp || interactionMode === "plan") &&
    getModelSelectionStringOptionValue(modelSelection, "reasoningEffort") === undefined
  );
}

function readCodexConfiguredEffort(
  client: CodexClient.CodexAppServerClient["Service"],
  cwd: string | null,
) {
  // Read through Codex so its selected profile and project config layers apply.
  return client
    .request("config/read", { cwd })
    .pipe(Effect.map((response) => response.config.model_reasoning_effort));
}

function providerSession(input: {
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly cwd: string | null;
  readonly model: string;
  readonly now: DateTime.Utc;
}): OrchestrationV2ProviderSession {
  return {
    id: input.providerSessionId,
    driver: CODEX_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    status: "ready",
    cwd: input.cwd ?? process.cwd(),
    model: input.model,
    capabilities: CodexProviderCapabilitiesV2,
    createdAt: input.now,
    updatedAt: input.now,
    lastError: null,
  };
}

function getNativeThreadId(providerThread: OrchestrationV2ProviderThread) {
  return Effect.gen(function* () {
    const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
    if (nativeThreadId === undefined || nativeThreadId === null) {
      return yield* toProtocolError(
        `Provider thread ${providerThread.id} is missing a native Codex thread id.`,
      );
    }
    return nativeThreadId;
  });
}

function providerThreadFromCodexThread(input: {
  readonly appThreadId: ThreadId | null;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly ownerNodeId: OrchestrationV2ProviderThread["ownerNodeId"];
  readonly providerSessionId: OrchestrationV2ProviderThread["providerSessionId"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly thread: {
    readonly createdAt: number;
    readonly forkedFromId?: string | null;
    readonly id: string;
    readonly updatedAt: number;
  };
  readonly forkedFrom?: OrchestrationV2ProviderThread["forkedFrom"];
}): OrchestrationV2ProviderThread {
  return {
    id: input.idAllocator.derive.providerThread({
      driver: CODEX_PROVIDER,
      nativeThreadId: input.thread.id,
    }),
    driver: CODEX_PROVIDER,
    providerInstanceId: input.providerInstanceId,
    providerSessionId: input.providerSessionId,
    appThreadId: input.appThreadId,
    ownerNodeId: input.ownerNodeId,
    nativeThreadRef: {
      driver: CODEX_PROVIDER,
      nativeId: input.thread.id,
      strength: "strong" as const,
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: input.forkedFrom ?? null,
    createdAt: codexTimestamp(input.thread.createdAt),
    updatedAt: codexTimestamp(input.thread.updatedAt),
  };
}

// Counts toward native rollback. `/goal` control turns never reach Codex and
// carry no native ref, so they must not consume a native turn on revert.
const isTerminalProviderTurn = (turn: OrchestrationV2ProviderTurn): boolean =>
  turn.nativeTurnRef !== null &&
  (turn.status === "completed" ||
    turn.status === "interrupted" ||
    turn.status === "failed" ||
    turn.status === "cancelled");

export type CodexGoalCommand =
  | { readonly type: "show" }
  | { readonly type: "clear" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "set"; readonly objective: string };

/**
 * Parses a `/goal` message the way the Codex TUI does: `clear`, `pause` and
 * `resume` control the current goal, a bare `/goal` shows it, and any other
 * text becomes the new objective. Returns null for every other message.
 */
export function parseCodexGoalCommand(text: string): CodexGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) return null;
  const argument = (match[1] ?? "").trim();
  switch (argument.toLowerCase()) {
    case "":
    case "edit":
      return { type: "show" };
    case "clear":
      return { type: "clear" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    default:
      return { type: "set", objective: argument };
  }
}

type CodexThreadGoal = CodexSchema.V2ThreadGoalUpdatedNotification["goal"];

const CODEX_GOAL_STATUSES = {
  active: "active",
  paused: "paused",
  blocked: "blocked",
  usageLimited: "usage_limited",
  budgetLimited: "budget_limited",
  complete: "complete",
} as const satisfies Record<CodexThreadGoal["status"], OrchestrationV2ProviderGoal["status"]>;

function providerGoalFromCodex(goal: CodexThreadGoal): OrchestrationV2ProviderGoal | null {
  const objective = goal.objective.trim();
  if (objective.length === 0) return null;
  return {
    objective,
    status: CODEX_GOAL_STATUSES[goal.status],
    tokensUsed: Math.max(0, goal.tokensUsed),
    tokenBudget: goal.tokenBudget ?? null,
    timeUsedSeconds: Math.max(0, goal.timeUsedSeconds),
  };
}

const providerGoalsEqual = Schema.toEquivalence(Schema.NullOr(OrchestrationV2ProviderGoal));

function describeCodexGoal(goal: OrchestrationV2ProviderGoal): string {
  return `Goal ${goal.status.replace("_", " ")}: ${goal.objective}`;
}

// Codex starts the next goal turn milliseconds after the last one completes.
// A run waits this long for it before settling, in case Codex declines.
const CODEX_GOAL_CONTINUATION_GRACE = "5 seconds";

const providerTurnsForThread = (
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerThread: OrchestrationV2ProviderThread,
): ReadonlyArray<OrchestrationV2ProviderTurn> =>
  providerTurns.filter((turn) => turn.providerThreadId === providerThread.id);

const countTerminalTurnsAfterBoundary = (
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerTurnId: ProviderTurnId,
): number | null => {
  const boundaryTurn = providerTurns.find((turn) => turn.id === providerTurnId);
  if (boundaryTurn === undefined) {
    return null;
  }

  return providerTurns.filter(
    (turn) => turn.ordinal > boundaryTurn.ordinal && isTerminalProviderTurn(turn),
  ).length;
};

const resolveCodexForkRollbackTurnCount = Effect.fn("CodexAdapterV2.resolveForkRollbackTurnCount")(
  function* (input: ProviderAdapter.ProviderAdapterV2ForkThreadInput) {
    if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
      return 0;
    }

    const rollbackTurnCount = countTerminalTurnsAfterBoundary(
      providerTurnsForThread(input.sourceProviderTurns, input.sourceProviderThread),
      input.providerTurnId,
    );
    if (rollbackTurnCount === null) {
      return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
        driver: CODEX_PROVIDER,
        providerThreadId: input.sourceProviderThread.id,
        cause: `Cannot fork Codex thread from provider turn ${input.providerTurnId}: source turn was not found in provider thread ${input.sourceProviderThread.id}.`,
      });
    }

    return rollbackTurnCount;
  },
);

/**
 * Prefer a native `thread/fork` turn boundary over the fork-then-rollback
 * fallback. `lastTurnId` is inclusive on the Codex side, so a fork requested at
 * the selected turn omits every later turn atomically. That matters for
 * paginated threads. The count fallback resolves a `thread/revert` boundary
 * only for source turns that predate native turn references.
 */
export const resolveCodexForkBoundary = Effect.fn("CodexAdapterV2.resolveForkBoundary")(function* (
  input: ProviderAdapter.ProviderAdapterV2ForkThreadInput,
) {
  const rollbackTurnCount = yield* resolveCodexForkRollbackTurnCount(input);
  if (input.providerTurnId === undefined || input.sourceProviderTurns === undefined) {
    return { lastTurnId: undefined, rollbackTurnCount };
  }

  const boundaryTurn = providerTurnsForThread(
    input.sourceProviderTurns,
    input.sourceProviderThread,
  ).find((turn) => turn.id === input.providerTurnId);
  const nativeTurnId = boundaryTurn?.nativeTurnRef?.nativeId;
  if (nativeTurnId === null || nativeTurnId === undefined) {
    return { lastTurnId: undefined, rollbackTurnCount };
  }

  return { lastTurnId: nativeTurnId, rollbackTurnCount: 0 };
});

/**
 * The generated `thread/read` response schema does not surface `historyMode`,
 * so the probe goes through the raw request channel with a permissive decode.
 */
const CodexThreadHistoryMetadata = Schema.Struct({
  thread: Schema.Struct({
    historyMode: Schema.optionalKey(Schema.Literals(["legacy", "paginated"])),
    status: Schema.optionalKey(Schema.Struct({ type: Schema.String })),
  }),
});
const decodeCodexThreadHistoryMetadata = Schema.decodeUnknownEffect(CodexThreadHistoryMetadata);

const readCodexThreadHistoryMetadata = Effect.fn("CodexAdapterV2.readThreadHistoryMetadata")(
  function* (
    raw: Pick<CodexClient.CodexAppServerClient["Service"]["raw"], "request">,
    threadId: string,
  ) {
    const response = yield* raw.request("thread/read", { threadId, includeTurns: false });
    const metadata = yield* decodeCodexThreadHistoryMetadata(response).pipe(
      Effect.mapError((error) =>
        CodexErrors.CodexAppServerRequestError.invalidPayload(
          "thread/read",
          "decode-payload",
          error,
        ),
      ),
    );
    return {
      historyMode: metadata.thread.historyMode,
      loaded: metadata.thread.status?.type !== "notLoaded",
    };
  },
);

export const resolveCodexRollbackTurns = Effect.fn("CodexAdapterV2.resolveRollbackTurns")(
  function* (input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput) {
    const turns = providerTurnsForThread(input.providerThreadTurns, input.providerThread);
    let retainedOrdinal = -1;
    if (input.target.type === "provider_turn") {
      const target = input.target.providerTurn;
      if (target.providerThreadId !== input.providerThread.id) {
        return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
          driver: CODEX_PROVIDER,
          providerThreadId: input.providerThread.id,
          cause: `Cannot roll back Codex thread ${input.providerThread.id} to provider turn ${target.id}: target turn belongs to provider thread ${target.providerThreadId}.`,
        });
      }
      const retained = turns.find((turn) => turn.id === target.id);
      if (retained === undefined) {
        return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
          driver: CODEX_PROVIDER,
          providerThreadId: input.providerThread.id,
          cause: `Cannot roll back Codex thread ${input.providerThread.id} to provider turn ${target.id}: target turn was not found in durable provider turn history.`,
        });
      }
      retainedOrdinal = retained.ordinal;
    }
    return turns
      .filter((turn) => turn.ordinal > retainedOrdinal && isTerminalProviderTurn(turn))
      .sort((a, b) => a.ordinal - b.ordinal);
  },
);

function parseCodexRetryProgress(
  message: string,
): Pick<OrchestrationV2ProviderRetry, "attempt" | "maxAttempts"> | null {
  const match = /\b(\d+)\s*\/\s*(\d+)\b/u.exec(message);
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  const attempt = Number.parseInt(match[1], 10);
  const maxAttempts = Number.parseInt(match[2], 10);
  if (attempt < 1 || maxAttempts < 1) {
    return null;
  }
  return { attempt, maxAttempts };
}

function codexErrorInfoFailureClass(
  code: string | null,
  status: number | undefined,
  message: string,
): OrchestrationV2ProviderFailureClass | undefined {
  if (status === 429) return "usage_limit";
  const classified = classifyProviderFailure(message, code);
  // A busy provider without a 429 stays retryable.
  if (classified === "provider_error") return undefined;
  if (classified !== undefined) return classified;
  if (
    code === "usageLimitExceeded" ||
    code === "rateLimitExceeded" ||
    code === "sessionBudgetExceeded"
  )
    return "usage_limit";
  if (code === "unauthorized") return "authentication_error";
  if (code === "badRequest" || code === "contextWindowExceeded") return "validation_error";
  if (status === 401) return "authentication_error";
  if (status === 402) return "billing_error";
  if (status === 403) return "permission_error";
  if (status !== undefined && status >= 400 && status < 500 && status !== 408)
    return "validation_error";
  return undefined;
}

function codexFailureInfo(value: unknown, message: string) {
  const fields = typeof value === "object" && value !== null ? value : undefined;
  const code = typeof value === "string" ? value : (Object.keys(fields ?? {})[0] ?? null);
  const metadata =
    code === null ? undefined : (fields as Record<string, unknown> | undefined)?.[code];
  const status =
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    typeof metadata.httpStatusCode === "number"
      ? metadata.httpStatusCode
      : undefined;
  return {
    code: status === 429 ? "api_error_429" : code,
    failureClass: codexErrorInfoFailureClass(code, status, message),
  };
}

function isCodexCapacityFailure(code: string | null | undefined, message?: string): boolean {
  return (
    code === "serverOverloaded" ||
    code === "flexUnavailable" ||
    code === "modelCapacityExceeded" ||
    /^(?:The task is incomplete; retry it or choose another current model\. )?Selected model is at capacity\. Please try a different model\.?$/iu.test(
      message?.trim() ?? "",
    )
  );
}

interface ActiveCodexTurnContext {
  closedCommandItemIds?: ReadonlySet<string>;
  latestProviderFailure?: {
    readonly nativeMessage: string;
    readonly failure: OrchestrationV2ProviderFailure;
  };
  readonly nativeStartReady?: Deferred.Deferred<void>;
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly projectionAppThread: OrchestrationV2AppThread;
  readonly projectionThreadId: ThreadId;
  readonly projectionRunId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
  readonly nativeTurnId: string;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly providerTurnId: ProviderTurnId;
  readonly providerTurnOrdinal: number;
  readonly providerNodeId: OrchestrationV2ExecutionNode["id"];
  readonly providerNodeKind: OrchestrationV2ExecutionNode["kind"];
  readonly providerNodeStartedAt: DateTime.Utc | null;
  readonly itemParentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly subagent: CodexSubagentThreadContext | null;
  readonly startedAt: DateTime.Utc;
  // Output speed of this turn's model responses (see CodexGeneration.ts).
  readonly generation: CodexGeneration;
  // Item positions allocated in this turn. Later turns never look items up
  // here: late background items resolve their settled turn's context, and a
  // subagent's approvals allocate on the owning root turn.
  readonly itemPositions: Map<
    string,
    { readonly ordinal: number; readonly startedAt: DateTime.Utc }
  >;
}

interface ActiveCodexProviderRetry {
  readonly nativeMessage: string;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

/** Snapshot of a still-running commandExecution item for interrupt/fail terminalization. */
interface TrackedRunningCommandItem {
  readonly id: string;
  readonly command: string;
  readonly output: TerminalOutputState;
  readonly processId?: string;
}

function isPersistentCodexDynamicTool(item: CodexDynamicToolItem): boolean {
  const input = item.arguments;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return false;
  }
  return Reflect.get(input, "persistent") === true;
}

type CodexRootTerminalEvent = Extract<
  ProviderAdapter.ProviderAdapterV2Event,
  { readonly type: "turn.terminal" }
>;

/** A completed root turn whose run stays open for the goal turn Codex starts next. */
interface CodexGoalHold {
  readonly context: ActiveCodexTurnContext;
  readonly event: Extract<CodexRootTerminalEvent, { readonly failure: null }>;
  /** Sent when the hold resolves, so until then Stop and steering still target this turn. */
  readonly completedTurn: OrchestrationV2ProviderTurn;
  /** The turn Codex continued with, or undefined when the run settled instead. */
  readonly next: Deferred.Deferred<ActiveCodexTurnContext | undefined>;
}

interface DeferredCodexRootTerminal {
  readonly context: ActiveCodexTurnContext;
  readonly event: CodexRootTerminalEvent;
}

interface CodexSubagentThreadContext {
  parentContext: ActiveCodexTurnContext;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly childThread: OrchestrationV2AppThread;
  readonly subagentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childThreadId: ThreadId;
  readonly nativeToolCallId: string;
  readonly ordinal: number;
  readonly nativeTurnIds: Set<string>;
  startedAt: DateTime.Utc;
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  task: OrchestrationV2Subagent;
}

/**
 * The top-level turn a (possibly nested) subagent turn runs under, and the
 * subagent on that turn's thread that leads to it. Native subagent threads are
 * hidden from the sidebar, so their approvals are asked there instead.
 */
const approvalOwnerCodexTurn = (
  context: ActiveCodexTurnContext,
): {
  readonly owner: ActiveCodexTurnContext;
  readonly subagent: CodexSubagentThreadContext | null;
} => {
  let owner = context;
  let subagent: CodexSubagentThreadContext | null = null;
  while (owner.subagent !== null) {
    subagent = owner.subagent;
    owner = owner.subagent.parentContext;
  }
  return { owner, subagent };
};

const isDescendantCodexTurn = (
  candidate: ActiveCodexTurnContext,
  ancestor: ActiveCodexTurnContext,
): boolean => {
  let parent = candidate.subagent?.parentContext;
  while (parent !== undefined) {
    if (parent === ancestor) {
      return true;
    }
    parent = parent.subagent?.parentContext;
  }
  return false;
};

interface PendingCodexSubagentTurnStarted {
  readonly nativeTurnId: string;
  readonly startedAt: DateTime.Utc;
}

type PendingCodexRuntimeRequest =
  | {
      readonly type: "approval";
      readonly requestId: RuntimeRequestId;
      readonly requestKind: ProviderRequestKind;
      readonly decision: Deferred.Deferred<ProviderApprovalDecision, never>;
    }
  | {
      readonly type: "user_input";
      readonly requestId: RuntimeRequestId;
      readonly answers: Deferred.Deferred<ProviderUserInputAnswers, never>;
    };

type CodexWebSearchItem = {
  readonly id: string;
  readonly type: "webSearch";
  readonly query?: string | null;
  readonly action?:
    | CodexSchema.V2ItemStartedNotification__WebSearchAction
    | CodexSchema.V2ItemCompletedNotification__WebSearchAction
    | null;
};

export type CodexDynamicToolItem = Extract<
  | CodexSchema.V2ItemStartedNotification__ThreadItem
  | CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "mcpToolCall" | "dynamicToolCall" }
>;

type CodexImageViewItem = Extract<
  CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "imageView" }
>;

type CodexImageGenerationItem = Extract<
  CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "imageGeneration" }
>;

/**
 * The file an `imageView` item showed the model, as a path the chat can preview.
 * Codex reports it as a file URL, including when code mode calls `view_image`.
 */
export function codexViewedImagePath(reported: string): string | undefined {
  let path = reported.trim();
  if (path.startsWith("file://")) {
    try {
      path = NodeURL.fileURLToPath(path);
    } catch {
      return undefined;
    }
  }
  return path.length > 0 &&
    path.length <= 4096 &&
    !/[\r\n]/.test(path) &&
    isWorkspaceImagePreviewPath(path)
    ? path
    : undefined;
}

type CodexCollabAgentToolCallItem = Extract<
  CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "collabAgentToolCall" }
>;

type CodexSubAgentActivityItem = Extract<
  | CodexSchema.V2ItemStartedNotification__ThreadItem
  | CodexSchema.V2ItemCompletedNotification__ThreadItem,
  { readonly type: "subAgentActivity" }
>;

export interface CodexAppServerClientFactoryShape {
  readonly open: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
    readonly providerSessionId: OrchestrationV2ProviderSession["id"];
    readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    readonly resolveLogThreadId?: (nativeId: string) => ThreadId | null;
    readonly settings: CodexSettings;
    readonly environment: NodeJS.ProcessEnv;
    /** Library skills to hide. Omitted by tests that spawn a fixed command. */
    readonly sharedSkills?: {
      readonly homeDir: string;
      readonly stateDir: string;
    };
  }) => Effect.Effect<
    CodexClient.CodexAppServerClient["Service"],
    ProviderAdapter.ProviderAdapterOpenSessionError,
    Scope.Scope
  >;
}

export class CodexAppServerClientFactory extends Context.Service<
  CodexAppServerClientFactory,
  CodexAppServerClientFactoryShape
>()("t3/orchestration-v2/Adapters/CodexAdapterV2/CodexAppServerClientFactory") {}

/**
 * Config overrides sent with every `thread/start`, `thread/resume` and `thread/fork`.
 * Codex layers these above the user's and project's `config.toml`.
 *
 * - Codex 0.152 made the `update_plan` checklist tool opt-in; T3 renders it as
 *   the todo list.
 * - Codex waits this long for MCP servers before the first model request and
 *   leaves out any server still starting (default 1 s, too short for cold
 *   `npx`/`uvx` servers). 10 s covers most slow starts, and a hung server
 *   delays only the first turn of a session by 10 s, not its 30 s timeout.
 */
export const CODEX_THREAD_CONFIG = {
  mcp_optional_startup_grace_ms: 10_000,
} as const;

// T3 wait tools can block for up to an hour. Keep Codex's MCP timeout above
// that limit so the server's own wait timeout ends a long call.
const CODEX_T3_MCP_TOOL_TIMEOUT_SEC = 65 * 60;

/** Names of the stdio MCP servers in a `config/read` config, the ones Codex starts per thread. */
export function codexStdioMcpServerNames(mcpServers: unknown): ReadonlyArray<string> {
  if (mcpServers === null || typeof mcpServers !== "object") return [];
  return Object.entries(mcpServers)
    .filter(
      ([name, server]) =>
        // Codex splits config override keys on every dot.
        !name.includes(".") &&
        server !== null &&
        typeof server === "object" &&
        typeof Reflect.get(server, "command") === "string",
    )
    .map(([name]) => name);
}

export function codexThreadRuntimeParams(input: {
  /**
   * Commands get their chat id here because the account shares one app-server.
   */
  readonly chatId: string | null | undefined;
  /** The user's stdio MCP servers, which Codex starts per thread outside the shell policy. */
  readonly stdioMcpServers?: ReadonlyArray<string>;
  readonly chatTempDir?: string | undefined;
  readonly mcpSession: McpProviderSession.McpProviderSessionConfig | undefined;
  readonly modelSelection?: { readonly model: string };
  readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): {
  readonly cwd?: string;
  readonly model?: string;
  readonly config: Readonly<Record<string, Schema.Json>>;
} {
  const { mcpSession } = input;
  return {
    ...(input.runtimePolicy?.cwd == null ? {} : { cwd: input.runtimePolicy.cwd }),
    ...(input.modelSelection === undefined ? {} : { model: input.modelSelection.model }),
    config: {
      ...CODEX_THREAD_CONFIG,
      // A dotted key adds to the user's own `shell_environment_policy.set` and leaves the rest.
      ...(input.chatId == null
        ? {}
        : {
            [`shell_environment_policy.set.${CHAT_ID_ENV}`]: input.chatId,
            ...Object.fromEntries(
              (input.stdioMcpServers ?? []).map((name) => [
                `mcp_servers.${name}.env.${CHAT_ID_ENV}`,
                input.chatId,
              ]),
            ),
          }),
      ...(input.chatTempDir === undefined
        ? {}
        : {
            "shell_environment_policy.set.TMPDIR": input.chatTempDir,
            "shell_environment_policy.set.TMP": input.chatTempDir,
            "shell_environment_policy.set.TEMP": input.chatTempDir,
          }),
      ...(mcpSession === undefined
        ? {}
        : {
            // Listen for Tools settings changes on this conversation's MCP connection.
            "features.mcp_tool_list_changed": true,
            // A dotted key, like the stdio env above: an `mcp_servers` table here would
            // replace those keys and the launch-argument servers.
            "mcp_servers.t3-code": {
              url: mcpSession.endpoint,
              tool_timeout_sec: CODEX_T3_MCP_TOOL_TIMEOUT_SEC,
              http_headers: {
                Authorization: mcpSession.authorizationHeader,
              },
            },
          }),
    },
  };
}

const decodeCodexResumeMetadata = Schema.decodeUnknownEffect(
  Schema.Struct({ thread: Schema.Struct({ id: Schema.String, updatedAt: Schema.Number }) }),
);

const CodexChildSelection = Schema.Struct({
  thread: Schema.Struct({ id: Schema.String }),
  model: Schema.NullOr(Schema.String),
  reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
  serviceTier: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeCodexChildModel = Schema.decodeUnknownEffect(CodexChildSelection);

const decodeCodexChildThread = Schema.decodeUnknownEffect(
  Schema.Struct({
    thread: Schema.Struct({
      id: Schema.String,
      model: Schema.optional(Schema.NullOr(Schema.String)),
      reasoningEffort: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  }),
);

export const makeCodexAppServerSpawnCommand = Effect.fn(
  "CodexAdapterV2.makeCodexAppServerSpawnCommand",
)(function* (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly extendEnv?: boolean | undefined;
}) {
  const launch = yield* (yield* AgentScope).wrap({
    command: input.command,
    args: input.args,
    name: "codex",
    env: input.env,
  });
  const spawnCommand = yield* resolveSpawnCommand(launch.command, launch.args, {
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.extendEnv === undefined ? {} : { extendEnv: input.extendEnv }),
  });
  return ChildProcess.make(spawnCommand.command, spawnCommand.args, {
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.env === undefined ? {} : { env: input.env }),
    ...(input.extendEnv === undefined ? {} : { extendEnv: input.extendEnv }),
    forceKillAfter: CODEX_APP_SERVER_FORCE_KILL_AFTER,
    shell: spawnCommand.shell,
  });
});

const layerCodexAppServerClientFactoryCommand = (
  options: CodexClient.CodexAppServerClientOptions & {
    readonly command: string;
    readonly args?: ReadonlyArray<string>;
    readonly cwd?: string;
    readonly env?: NodeJS.ProcessEnv;
  },
): Layer.Layer<CodexAppServerClientFactory, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Layer.effect(
    CodexAppServerClientFactory,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      return CodexAppServerClientFactory.of({
        open: (input) =>
          Effect.gen(function* () {
            const scope = yield* Scope.Scope;
            const command = yield* makeCodexAppServerSpawnCommand({
              command: options.command,
              args: [...(options.args ?? [])],
              ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
              ...(options.env === undefined ? {} : { env: options.env, extendEnv: true }),
            });
            const handle = yield* spawner.spawn(command).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CODEX_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
              ),
            );
            const context = yield* Layer.build(CodexClient.layerChildProcess(handle, options));
            return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
              Effect.provide(context),
            );
          }),
      });
    }),
  );

function codexProtocolThreadId(payload: unknown): string | undefined {
  // A fork names its source but configures a different chat.
  if (field(payload, "method") === "thread/fork") return;
  const params = field(payload, "params") ?? field(payload, "result");
  return fieldText(field(params, "threadId")) ?? fieldText(field(field(params, "thread"), "id"));
}

export function makeCodexAppServerProtocolLogger(input: {
  readonly resolveLogThreadId?: ((nativeId: string) => ThreadId | null) | undefined;
  readonly nativeEventLogger: ProviderEventLoggers.EventNdjsonLogger | undefined;
  readonly threadId: ThreadId;
  readonly providerSessionId: OrchestrationV2ProviderSession["id"];
}): CodexClient.CodexAppServerClientOptions["logger"] | undefined {
  const { nativeEventLogger } = input;
  if (nativeEventLogger === undefined) {
    return undefined;
  }

  return (event) => {
    if (!shouldPersistProviderEvent("native", event)) return Effect.void;
    let owner: ThreadId | null = input.threadId;
    if (input.resolveLogThreadId !== undefined) {
      const id = codexProtocolThreadId(event.payload);
      owner = id === undefined ? null : input.resolveLogThreadId(id);
    }
    return nativeEventLogger
      .write(
        {
          provider: CODEX_PROVIDER,
          protocol: "codex.app-server",
          kind: "protocol",
          providerSessionId: input.providerSessionId,
          event: redactCodexProtocolValue(boundProviderEventForLogging(event)),
        },
        owner,
      )
      .pipe(Effect.ignore);
  };
}

function redactCodexProtocolValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactCodexProtocolValue);
  }
  if (value === null || typeof value !== "object") {
    if (typeof value !== "string") {
      return value;
    }
    if (/^Bearer\s+/i.test(value)) {
      return "[REDACTED]";
    }
    const trimmed = value.trim();
    if (
      !(
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("[") && trimmed.endsWith("]"))
      )
    ) {
      return value;
    }
    try {
      return JSON.stringify(
        redactCodexProtocolValue(boundProviderEventForLogging(JSON.parse(trimmed) as unknown)),
      );
    } catch {
      return value;
    }
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      isSensitiveCodexProtocolKey(key) ? "[REDACTED]" : redactCodexProtocolValue(nested),
    ]),
  );
}

function isSensitiveCodexProtocolKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized.endsWith("authorization") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("token") ||
    normalized.endsWith("password") ||
    normalized.endsWith("secret")
  );
}

export const layerAppServerClientFactory: Layer.Layer<
  CodexAppServerClientFactory,
  never,
  ChildProcessSpawner.ChildProcessSpawner | ProviderEventLoggers.ProviderEventLoggers
> = Layer.effect(
  CodexAppServerClientFactory,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { native: nativeEventLogger } = yield* ProviderEventLoggers.ProviderEventLoggers;
    const agentScope = yield* AgentScope;

    return CodexAppServerClientFactory.of({
      open: (input) =>
        Effect.gen(function* () {
          const scope = yield* Scope.Scope;
          const environment = {
            ...codexAppServerEnvironment(input.environment),
            [CHAT_ID_ENV]: undefined,
            [CODEX_APP_SERVER_ENV]: "1",
            ...(input.settings.homePath ? { CODEX_HOME: input.settings.homePath } : {}),
          };
          const command = yield* makeCodexAppServerSpawnCommand({
            command: input.settings.binaryPath || "codex",
            args: codexAppServerArgs(
              input.sharedSkills === undefined
                ? resolveCodexLaunchArgs(input.settings.launchArgs, input.environment)
                : codexLaunchArgsWithSharedSkills(
                    input.settings.launchArgs,
                    input.environment,
                    input.sharedSkills.homeDir,
                    input.sharedSkills.stateDir,
                    resolveCodexLaunchArgs,
                  ),
            ),
            env: environment,
          }).pipe(Effect.provideService(AgentScope, agentScope));
          const handle = yield* spawner.spawn(command).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CODEX_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
          const protocolLogger = makeCodexAppServerProtocolLogger({
            resolveLogThreadId: input.resolveLogThreadId,
            nativeEventLogger,
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
          });
          const clientOptions: CodexClient.CodexAppServerClientOptions =
            protocolLogger === undefined
              ? {}
              : {
                  logIncoming: true,
                  logOutgoing: true,
                  logger: protocolLogger,
                };
          const context = yield* Layer.build(CodexClient.layerChildProcess(handle, clientOptions));
          return yield* Effect.service(CodexClient.CodexAppServerClient).pipe(
            Effect.provide(context),
          );
        }),
    });
  }),
);

export type CodexAdapterV2DriverEnv =
  | CodexAppServerClientFactory
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | Path.Path
  | ServerConfig;

export const createCodexAdapterV2 = (
  { instanceId, environment, enabled, config }: ProviderAdapterDriverCreateInput<CodexSettings>,
  hooks: Pick<
    CodexAdapterV2Options,
    "onUsageLimits" | "getUsageLimits" | "resolveRuntime" | "hostBrowser"
  > = {},
) =>
  Effect.gen(function* () {
    const clientFactory = yield* CodexAppServerClientFactory;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const hostEnvironment = yield* HostProcess.Environment;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* ServerConfig;
    const homeLayout = yield* resolveCodexHomeLayout(config);

    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterDriverCreateError({
            driver: CODEX_DRIVER_KIND,
            instanceId,
            detail:
              cause._tag === "CodexShadowHomeSqliteRecoveryRequiredError"
                ? CODEX_SQLITE_RECOVERY_GUIDANCE
                : "Failed to materialize the Codex shadow home.",
            cause,
          }),
      ),
    );

    const settings = {
      ...config,
      enabled,
      binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
      homePath: homeLayout.effectiveHomePath ?? "",
    } satisfies CodexSettings;

    return yield* makeCodexAdapterV2({
      instanceId,
      settings,
      environment: withCodexSqliteHome(
        homeLayout,
        yield* mergeCodexEnvironment(environment, hostEnvironment),
      ),
      clientFactory,
      crypto,
      fileSystem,
      idAllocator,
      serverConfig,
      continuationRequests,
      ...hooks,
    });
  });

export const CodexAdapterV2Driver: ProviderAdapterDriver<CodexSettings, CodexAdapterV2DriverEnv> = {
  driverKind: CODEX_DRIVER_KIND,
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => DEFAULT_CODEX_SETTINGS,
  create: createCodexAdapterV2,
};

const layer: Layer.Layer<
  ProviderAdapter.ProviderAdapterV2,
  never,
  | CodexAppServerClientFactory
  | Crypto.Crypto
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ServerConfig
> = Layer.effect(
  ProviderAdapter.ProviderAdapterV2,
  Effect.gen(function* () {
    const clientFactory = yield* CodexAppServerClientFactory;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const crypto = yield* Crypto.Crypto;
    const fileSystem = yield* FileSystem.FileSystem;
    const hostEnvironment = yield* HostProcess.Environment;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const serverConfig = yield* ServerConfig;

    return yield* makeCodexAdapterV2({
      instanceId: CODEX_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_CODEX_SETTINGS,
      environment: hostEnvironment,
      clientFactory,
      crypto,
      fileSystem,
      idAllocator,
      serverConfig,
      continuationRequests,
    });
  }),
);

export interface CodexAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CodexSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly clientFactory: CodexAppServerClientFactoryShape;
  readonly onUsageLimits?: ManagedServerProvider["applyUsageLimits"];
  readonly getUsageLimits?: Effect.Effect<ServerProvider["usageLimits"]>;
  /**
   * Resolves launch settings when each session opens, replacing `settings` and
   * `environment`. Managed ChatGPT sign-in uses it to launch the T3-installed
   * Codex with a current access token.
   */
  readonly resolveRuntime?: Effect.Effect<CodexEffectiveRuntime, ProviderSetupError, Scope.Scope>;
  /**
   * The Mac's default browser, for a note that points Codex's Computer Use at
   * it. Omitted, Codex gets no browser note.
   */
  readonly hostBrowser?: Effect.Effect<CodexHostBrowser | null | undefined>;
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly serverConfig: ServerConfig["Service"];
  /**
   * Sink for post-settle background command completions so the orchestrator
   * can start a continuation run. Optional: adapters that omit it keep
   * projection-only handling for late item completions.
   */
  readonly continuationRequests?: {
    readonly offer: (
      request: ProviderContinuationRequests.ProviderContinuationRequest,
    ) => Effect.Effect<void>;
  };
}

export const makeCodexAdapterV2 = Effect.fn("makeCodexAdapterV2")(function* (
  adapterOptions: CodexAdapterV2Options,
) {
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  const prepareChatEnvironment = yield* ProviderHost.chatEnvironment;
  const readMcpSession = (threadId: ThreadId | null) =>
    threadId === null ? Effect.succeed(undefined) : mcpSessions.read(threadId);
  const { clientFactory, crypto, fileSystem, idAllocator, serverConfig } = adapterOptions;
  const continuationRequests = adapterOptions.continuationRequests;

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: adapterOptions.instanceId,
    driver: CODEX_PROVIDER,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    openSideChat: (sideInput) =>
      readMcpSession(sideInput.threadId).pipe(
        Effect.flatMap((mcpSession) =>
          openCodexSideChat(adapterOptions, sideInput, mcpSession, prepareChatEnvironment),
        ),
      ),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: (input) =>
      Effect.gen(function* () {
        const scope = yield* Scope.Scope;
        const resolvedRuntime =
          adapterOptions.resolveRuntime === undefined
            ? undefined
            : yield* adapterOptions.resolveRuntime.pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver: CODEX_PROVIDER,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
        const environment = resolvedRuntime?.environment ?? adapterOptions.environment;
        const codexZone = codexTimeZone(environment);
        const prepareChatTempDir = (threadId: ThreadId | null) =>
          prepareChatEnvironment({
            instanceId: adapterOptions.instanceId,
            driver: CODEX_PROVIDER,
            threadId,
            environment,
          }).pipe(
            Effect.map((prepared) => (prepared === environment ? undefined : prepared.TMPDIR)),
          );
        // Running commands keep their scratch directory through idle turns until unload.
        const chatTempDirs = yield* ScopedCache.makeWith({
          capacity: Infinity,
          timeToLive: (exit) => (Exit.isSuccess(exit) ? Infinity : 0),
          lookup: prepareChatTempDir,
        });
        const rootProviderThreads = new Map<string, OrchestrationV2ProviderThread>();
        const clientScope = yield* Scope.fork(scope);
        const client = yield* clientFactory
          .open({
            resolveLogThreadId: (id) => rootProviderThreads.get(id)?.appThreadId ?? null,
            instanceId: adapterOptions.instanceId,
            threadId: input.threadId,
            providerSessionId: input.providerSessionId,
            runtimePolicy: input.runtimePolicy,
            settings: resolvedRuntime?.config ?? adapterOptions.settings,
            environment,
            sharedSkills: {
              homeDir: environment.HOME?.trim() || (yield* HostProcess.HomeDirectory),
              stateDir: adapterOptions.serverConfig.stateDir,
            },
          })
          .pipe(Effect.provideService(Scope.Scope, clientScope));
        // Delegated subagents run in the user's own Codex home, so each one would
        // otherwise stay in the Codex app's recent chats. Archive them when this
        // session closes; resuming one later unarchives it first.
        const subagentNativeThreadIds = new Set<string>();
        yield* Effect.addFinalizer(() =>
          Effect.forEach(
            subagentNativeThreadIds,
            (threadId) =>
              client
                .request("thread/archive", { threadId })
                .pipe(Effect.timeout("3 seconds"), Effect.ignore),
            { concurrency: 4, discard: true },
          ),
        );
        const configuredReasoningEffort = yield* Cache.makeWith(
          (cwd: string | null) => readCodexConfiguredEffort(client, cwd),
          { capacity: 64, timeToLive: (exit) => (Exit.isSuccess(exit) ? Infinity : 0) },
        );
        const hostBrowser = yield* Effect.cached(
          adapterOptions.hostBrowser ?? Effect.succeed(undefined),
        );
        const additionalContextByThread = yield* Ref.make(
          new Map<
            string,
            NonNullable<CodexTurnStartParamsWithCollaborationMode["additionalContext"]>
          >(),
        );
        const digestAdditionalContext = Effect.fn("CodexAdapterV2.digestAdditionalContext")(
          function* (context: typeof CodexAdditionalContext.Type) {
            return Hex.encode(
              yield* crypto.digest(
                "SHA-256",
                new TextEncoder().encode(yield* encodeCodexAdditionalContextJson(context)),
              ),
            );
          },
        );
        // Absent falls back to persisted metadata; undefined means the context is invalidated.
        const deliveredContextDigests = new Map<string, string | undefined>();
        // Codex drops client developer messages during compaction but only
        // resends additionalContext when it changes. Restore the current entries
        // after turn/completed: items injected mid-turn make the turn sample again.
        const threadsAwaitingContextRestore = new Set<string>();
        const restoreAdditionalContext = (threadId: string) =>
          Effect.gen(function* () {
            yield* invalidateAdditionalContext(threadId);
            const context = (yield* Ref.get(additionalContextByThread)).get(threadId);
            if (!context) return;
            yield* client.request("thread/inject_items", {
              threadId,
              // Restored as Codex sent them: application context as developer
              // input, untrusted context as quoted user-side input.
              items: Object.entries(context).map(([key, entry]) =>
                entry.kind === "untrusted"
                  ? {
                      type: "message",
                      role: "user",
                      content: [
                        {
                          type: "input_text",
                          text: `<external_${key}>${entry.value}</external_${key}>`,
                        },
                      ],
                    }
                  : {
                      type: "message",
                      role: "developer",
                      content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
                    },
              ),
            });
            yield* recordAdditionalContextDigest(threadId, yield* digestAdditionalContext(context));
          }).pipe(
            Effect.timeout("10 seconds"),
            Effect.catch((cause) =>
              invalidateAdditionalContext(threadId).pipe(
                Effect.andThen(
                  Effect.logWarning(
                    "Failed to restore Codex additional context after compaction.",
                    { cause },
                  ),
                ),
              ),
            ),
          );
        const events = yield* Queue.unbounded<
          ProviderAdapter.ProviderAdapterV2Event,
          ProviderAdapter.ProviderAdapterEventStreamError
        >();
        const retireAppServer = (cause: unknown) =>
          Queue.fail(
            events,
            new ProviderAdapter.ProviderAdapterEventStreamError({
              driver: CODEX_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
          );
        const initialized = yield* Ref.make(false);
        // After a timed-out handshake the session is retiring; waiters must not
        // re-send to the hung app-server.
        const initializeTimeout = yield* Ref.make<CodexAppServerUnresponsiveError | undefined>(
          undefined,
        );
        // Threads share this app-server, and Codex rejects a second
        // `initialize`. Callers wait for an in-flight handshake instead of
        // starting their own; a failed handshake leaves the flag unset so the
        // next caller retries.
        const initializePermit = yield* Semaphore.make(1);
        const ensureInitialized = initializePermit.withPermit(
          Effect.gen(function* () {
            const alreadyInitialized = yield* Ref.get(initialized);
            if (alreadyInitialized) {
              return;
            }
            const timedOut = yield* Ref.get(initializeTimeout);
            if (timedOut !== undefined) return yield* timedOut;

            yield* client
              .request("initialize", {
                // Codex uses the client name as the request originator, so sessions
                // identify themselves exactly like the provider probe.
                clientInfo: buildCodexInitializeParams().clientInfo,
                capabilities: CODEX_CLIENT_CAPABILITIES,
              })
              .pipe(
                Effect.catchTags({
                  // A caller interrupted after its `initialize` reached Codex
                  // leaves the app-server initialized but the flag unset.
                  CodexAppServerRequestError: (error) =>
                    error.code === -32600 && error.errorMessage === "Already initialized"
                      ? Effect.void
                      : Effect.fail(error),
                }),
                // A hung app-server never answers, and every thread on this shared
                // session waits behind the permit. Retiring the session lets the
                // next turn spawn a fresh app-server.
                Effect.timeoutOrElse({
                  duration: CODEX_INITIALIZE_TIMEOUT,
                  orElse: () => {
                    const error = new CodexAppServerUnresponsiveError({
                      method: "initialize",
                      deadline: CODEX_INITIALIZE_TIMEOUT,
                    });
                    return Ref.set(initializeTimeout, error).pipe(
                      Effect.andThen(retireAppServer(error)),
                      Effect.andThen(Effect.fail(error)),
                    );
                  },
                }),
              );
            yield* client.notify("initialized", undefined);
            yield* Ref.set(initialized, true);
          }),
        );
        // Read per thread: a workspace's project config can add its own servers.
        const readStdioMcpServers = (cwd: string | null | undefined) =>
          ensureInitialized.pipe(
            Effect.andThen(
              client
                .request("config/read", { ...(cwd == null ? {} : { cwd }), includeLayers: false })
                .pipe(
                  Effect.map((response) => codexStdioMcpServerNames(response.config.mcp_servers)),
                  Effect.catch(() =>
                    Effect.logDebug("Codex config read failed.").pipe(
                      Effect.as<ReadonlyArray<string>>([]),
                    ),
                  ),
                ),
            ),
          );
        const threadParams = Effect.fnUntraced(function* (
          chatId: ThreadId | null,
          options: Pick<
            Parameters<typeof codexThreadRuntimeParams>[0],
            "modelSelection" | "runtimePolicy"
          >,
        ) {
          return codexThreadRuntimeParams({
            ...options,
            chatId,
            mcpSession: yield* readMcpSession(chatId),
            chatTempDir: yield* prepareChatTempDir(chatId),
            ...(chatId === null
              ? {}
              : { stdioMcpServers: yield* readStdioMcpServers(options.runtimePolicy?.cwd) }),
          });
        });
        const now = yield* DateTime.now;
        const session = providerSession({
          providerSessionId: input.providerSessionId,
          providerInstanceId: adapterOptions.instanceId,
          cwd: input.runtimePolicy.cwd,
          model: input.modelSelection.model,
          now,
        });
        if (client.awaitTermination !== undefined) {
          yield* client.awaitTermination.pipe(
            Effect.flatMap(retireAppServer),
            Effect.forkIn(clientScope),
          );
        }
        // An unanswered request may already have taken effect, so do not replay it.
        const withAppServerDeadline =
          (method: string) =>
          <A, E, R>(effect: Effect.Effect<A, E, R>) =>
            effect.pipe(
              Effect.timeoutOrElse({
                duration: CODEX_APP_SERVER_REQUEST_DEADLINE,
                orElse: () => {
                  const error = new CodexAppServerUnresponsiveError({ method });
                  return retireAppServer(error).pipe(Effect.andThen(Effect.fail(error)));
                },
              }),
            );
        const rateLimitSnapshot = yield* Ref.make<CodexRateLimitSnapshot | undefined>(undefined);
        const limitedTurnItems = yield* Ref.make(
          new Map<ProviderThreadId, Extract<OrchestrationV2TurnItem, { type: "error" }>>(),
        );
        const activeTurns = yield* Ref.make(new Map<string, ActiveCodexTurnContext>());
        const turnTokenUsageByThread = new Map<string, CodexTurnTokenUsageState>();
        const usageStateForThread = (nativeThreadId: string) => {
          let state = turnTokenUsageByThread.get(nativeThreadId);
          if (!state) {
            state = makeCodexTurnTokenUsageState();
            turnTokenUsageByThread.set(nativeThreadId, state);
          }
          return state;
        };
        const beginTurnTokenUsage = (context: ActiveCodexTurnContext) => {
          const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
          if (!nativeThreadId) return;
          const state = usageStateForThread(nativeThreadId);
          if (state.activeTurnId !== context.nativeTurnId) {
            state.byTurnId.clear();
            state.activeTurnId = context.nativeTurnId;
            getCodexTurnAccumulator(state, context.nativeTurnId);
          }
        };
        const markSubagentUsage = (context: ActiveCodexTurnContext) => {
          const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
          if (!nativeThreadId) return;
          getCodexTurnAccumulator(
            usageStateForThread(nativeThreadId),
            context.nativeTurnId,
          ).hasSubagents = true;
        };
        const pendingRootTurns = yield* Ref.make(
          new Map<string, ProviderAdapter.ProviderAdapterV2TurnInput>(),
        );
        const turnWaiters = yield* Ref.make(new Map<string, Deferred.Deferred<void, never>>());
        const subagentThreads = yield* Ref.make(new Map<string, CodexSubagentThreadContext>());
        const subagentSelections = new Map<string, Omit<ModelSelection, "instanceId">>();
        const pendingSubagentTurns = yield* Ref.make(
          new Map<string, ReadonlyArray<PendingCodexSubagentTurnStarted>>(),
        );
        const nextProviderTurnOrdinals = yield* Ref.make(new Map<string, number>());
        const providerRetries = yield* Ref.make(
          new Map<ProviderTurnId, ActiveCodexProviderRetry>(),
        );
        const planIds = yield* Ref.make(new Map<string, OrchestrationV2PlanArtifact["id"]>());
        const pendingRuntimeRequests = yield* Ref.make(
          new Map<string, PendingCodexRuntimeRequest>(),
        );
        /**
         * Approval kinds the user chose "Always allow this session" for, by
         * native thread. Codex's own acceptForSession only skips the exact
         * command or patch it answered, so every new command would ask again.
         * A turn in another runtime mode ends the allowance, and so does the
         * thread unloading, like Codex's own session approvals.
         */
        const sessionApprovals = new Map<
          string,
          { readonly runtimeMode: RuntimeMode; readonly kinds: Set<ProviderRequestKind> }
        >();
        /**
         * The allowed kinds for an approval request's turn. Read it when the
         * request arrives and add to that same set when the user answers, so a
         * late answer from a turn whose mode has since ended is dropped.
         */
        /** Every native turn registers here. A turn in another mode ends the allowance. */
        const endSessionApprovalsOnModeChange = (context: ActiveCodexTurnContext) => {
          const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
          if (
            nativeThreadId != null &&
            sessionApprovals.get(nativeThreadId)?.runtimeMode !==
              context.input.runtimePolicy.runtimeMode
          ) {
            sessionApprovals.delete(nativeThreadId);
          }
        };
        const sessionAllowance = (
          nativeThreadId: string,
          context: ActiveCodexTurnContext,
        ): Set<ProviderRequestKind> => {
          const runtimeMode = context.input.runtimePolicy.runtimeMode;
          const allowed = sessionApprovals.get(nativeThreadId);
          if (allowed?.runtimeMode === runtimeMode) return allowed.kinds;
          if (allowed !== undefined) return new Set();
          const kinds = new Set<ProviderRequestKind>();
          sessionApprovals.set(nativeThreadId, { runtimeMode, kinds });
          return kinds;
        };
        /**
         * Turn contexts retained past turn/completed while background command
         * items started in that turn are still running, so late item events
         * keep projecting instead of being dropped.
         */
        const settledTurns = yield* Ref.make(new Map<string, ActiveCodexTurnContext>());
        const runningCommandItemsByTurn = yield* Ref.make(
          new Map<string, Map<string, TrackedRunningCommandItem>>(),
        );
        const runningDynamicToolsByTurn = yield* Ref.make(
          new Map<string, Map<string, CodexDynamicToolItem>>(),
        );
        const runningSleepsByTurn = new Map<string, Map<string, number>>();
        const runningImagesByTurn = new Map<string, Map<string, CodexImageGenerationItem>>();
        const runningWebSearchesByTurn = new Map<string, Map<string, CodexWebSearchItem>>();
        const interruptingNativeTurns = yield* Ref.make(new Set<string>());
        const terminalizedNonCompletedNativeTurns = yield* Ref.make(new Set<string>());
        // Keep the run event stream open until descendant provider state is
        // terminal, otherwise the root terminal can strand child projections.
        const deferredRootTerminals = yield* Ref.make(new Map<string, DeferredCodexRootTerminal>());
        const offeredContinuationItemsByTurn = yield* Ref.make(new Map<string, Set<string>>());
        const finalAnswerItemIdsByTurn = yield* Ref.make(new Map<string, Set<string>>());
        const completedFinalAnswerTextsByTurn = yield* Ref.make(new Map<string, Set<string>>());
        // Native completion and the interrupt timeout share one finalization
        // path. Serialize the race so only one can publish terminal events.
        const turnTerminalizationPermit = yield* Semaphore.make(1);
        // Native goals by Codex thread, and the root provider thread snapshot
        // each goal change is written onto.
        const goalsByNativeThread = new Map<string, OrchestrationV2ProviderGoal | null>();
        // A completed root turn whose goal is still active. Its run stays open
        // for the turn Codex starts next, so goal phases do not read as Done.
        const goalHolds = new Map<string, CodexGoalHold>();
        // The root turns of each continued goal run, keyed by each of its turns.
        // A Stop or steer that names an earlier turn reaches the newest one, and
        // Stop also reaches work an earlier turn left running. Dropped when the
        // run settles.
        const goalRuns = new Map<ProviderTurnId, Array<ActiveCodexTurnContext>>();
        // `/goal` runs whose goal turns active after the first turn starts.
        const goalActivations = new Map<string, { stopped: boolean }>();
        // Stops in progress by native thread. Until a Stop resolves its target,
        // a held run must not settle as completed.
        const goalStops = new Map<string, number>();
        const latestGoalTurnId = (providerTurnId: ProviderTurnId) =>
          goalRuns.get(providerTurnId)?.at(-1)?.providerTurnId ?? providerTurnId;

        const emitProviderEvent = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);

        const withCurrentContextDigest = (
          threadId: string,
          providerThread: OrchestrationV2ProviderThread,
        ) => {
          if (!deliveredContextDigests.has(threadId)) return providerThread;
          const { codexAdditionalContextDigest: _digest, ...nativeMetadata } =
            providerThread.nativeMetadata ?? {};
          const digest = deliveredContextDigests.get(threadId);
          return {
            ...providerThread,
            nativeMetadata: {
              ...nativeMetadata,
              ...(digest === undefined ? {} : { codexAdditionalContextDigest: digest }),
            },
          };
        };
        const recordAdditionalContextDigest = Effect.fn(
          "CodexAdapterV2.recordAdditionalContextDigest",
        )(function* (threadId: string, digest: string | undefined) {
          deliveredContextDigests.set(threadId, digest);
          const providerThread = rootProviderThreads.get(threadId);
          if (
            !providerThread ||
            providerThread.nativeMetadata?.codexAdditionalContextDigest === digest
          )
            return;
          const updated = withCurrentContextDigest(threadId, providerThread);
          rootProviderThreads.set(threadId, updated);
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver: CODEX_PROVIDER,
            providerThread: updated,
          });
        });
        const invalidateAdditionalContext = (threadId: string) =>
          recordAdditionalContextDigest(threadId, undefined);

        /** Writes the thread's current native goal onto its root provider thread. */
        const emitGoalUpdate = Effect.fnUntraced(function* (nativeThreadId: string) {
          const providerThread = rootProviderThreads.get(nativeThreadId);
          if (providerThread === undefined || !goalsByNativeThread.has(nativeThreadId)) return;
          const goal = goalsByNativeThread.get(nativeThreadId) ?? null;
          if (providerGoalsEqual(providerThread.goal ?? null, goal)) return;
          const updated = { ...providerThread, goal, updatedAt: yield* DateTime.now };
          rootProviderThreads.set(nativeThreadId, updated);
          yield* emitProviderEvent({
            type: "provider_thread.updated",
            driver: CODEX_PROVIDER,
            providerThread: updated,
          });
        });

        const rememberRootProviderThread = Effect.fnUntraced(function* (
          providerThread: OrchestrationV2ProviderThread,
        ) {
          const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
          if (nativeThreadId == null) return;
          rootProviderThreads.set(
            nativeThreadId,
            withCurrentContextDigest(nativeThreadId, providerThread),
          );
          yield* emitGoalUpdate(nativeThreadId);
        });

        // Call only for new model-output activity. A local item/completed can
        // arrive while the upstream response stream is still retrying.
        const completeProviderRetry = Effect.fn("CodexAdapterV2.completeProviderRetry")(function* (
          context: ActiveCodexTurnContext,
          updatedAt: DateTime.Utc,
        ) {
          const providerRetry = yield* Ref.modify(providerRetries, (current) => {
            const retry = current.get(context.providerTurnId);
            if (retry === undefined) {
              return [undefined, current] as const;
            }
            const updated = new Map(current);
            updated.delete(context.providerTurnId);
            return [retry, updated] as const;
          });
          if (providerRetry === undefined) {
            return;
          }
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: makeProviderRetryTurnItem({
              driver: CODEX_PROVIDER,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId: context.providerNodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              itemOrdinal: providerRetry.itemOrdinal,
              failure: providerRetry.failure,
              retry: providerRetry.retry,
              status: "completed",
              startedAt: providerRetry.startedAt,
              updatedAt,
            }),
          });
        });

        const registerRootTurn = (input: {
          readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
          readonly nativeTurnId: string;
          readonly startedAt: DateTime.Utc;
          readonly waitForNativeStart?: boolean;
        }) =>
          Effect.gen(function* () {
            const existing = (yield* Ref.get(activeTurns)).get(input.nativeTurnId);
            if (existing !== undefined) {
              return existing;
            }
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: CODEX_PROVIDER,
              nativeTurnId: input.nativeTurnId,
            });
            const context: ActiveCodexTurnContext = {
              ...(input.waitForNativeStart
                ? { nativeStartReady: yield* Deferred.make<void>() }
                : {}),
              input: input.turnInput,
              projectionAppThread: input.turnInput.appThread,
              projectionThreadId: input.turnInput.threadId,
              projectionRunId: input.turnInput.runId,
              nativeTurnId: input.nativeTurnId,
              providerThread: input.turnInput.providerThread,
              providerTurnId,
              providerTurnOrdinal: input.turnInput.providerTurnOrdinal,
              providerNodeId: input.turnInput.rootNodeId,
              providerNodeKind: "root_turn",
              providerNodeStartedAt: input.startedAt,
              itemParentNodeId: input.turnInput.rootNodeId,
              rootNodeId: input.turnInput.rootNodeId,
              subagent: null,
              startedAt: input.startedAt,
              // Codex reports turn start in whole seconds; time replies locally.
              generation: makeCodexGeneration(yield* DateTime.now),
              itemPositions: new Map(),
            };
            yield* Ref.update(limitedTurnItems, (current) => {
              const next = new Map(current);
              next.delete(context.providerThread.id);
              return next;
            });
            beginTurnTokenUsage(context);
            endSessionApprovalsOnModeChange(context);
            yield* Ref.update(activeTurns, (current) => {
              const updated = new Map(current);
              updated.set(input.nativeTurnId, context);
              return updated;
            });
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CODEX_PROVIDER,
              threadId: input.turnInput.threadId,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: input.turnInput.providerThread.id,
                nodeId: input.turnInput.rootNodeId,
                runAttemptId: input.turnInput.attemptId,
                nativeTurnRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: input.nativeTurnId,
                  strength: "strong",
                },
                ordinal: input.turnInput.providerTurnOrdinal,
                status: "running",
                startedAt: input.startedAt,
                completedAt: null,
              },
            });
            yield* rememberRootProviderThread(input.turnInput.providerThread);
            return context;
          });

        const findActiveTurnByNativeThreadId = (nativeThreadId: string) =>
          Effect.gen(function* () {
            const turns = Array.from((yield* Ref.get(activeTurns)).values());
            return turns.find(
              (context) => context.providerThread.nativeThreadRef?.nativeId === nativeThreadId,
            );
          });

        // Native events can arrive before their turn registers, so lookups retry briefly.
        const awaitRegisteredTurn = Effect.fnUntraced(function* (
          lookup: Effect.Effect<ActiveCodexTurnContext | undefined>,
          attemptsRemaining = 1_000,
        ): Effect.fn.Return<ActiveCodexTurnContext | undefined> {
          const context = yield* lookup;
          if (context !== undefined || attemptsRemaining <= 0) {
            return context;
          }
          yield* Effect.yieldNow;
          return yield* awaitRegisteredTurn(lookup, attemptsRemaining - 1);
        });

        // Streaming updates repeatedly await this context; avoid a span for each update.
        const awaitActiveTurn = (nativeTurnId: string) =>
          awaitRegisteredTurn(
            Ref.get(activeTurns).pipe(Effect.map((turns) => turns.get(nativeTurnId))),
          );

        /**
         * Like awaitActiveTurn, but item lifecycle events for a turn that
         * already settled (background command completions) resolve the
         * retained settled context instead of dropping.
         */
        const resolveItemEventContext = (nativeTurnId: string) =>
          Effect.gen(function* () {
            const settled = (yield* Ref.get(settledTurns)).get(nativeTurnId);
            if (settled !== undefined) {
              return { context: settled, settled: true } as const;
            }
            const context = yield* awaitActiveTurn(nativeTurnId);
            return context === undefined ? undefined : ({ context, settled: false } as const);
          });

        const trackRunningCommandItem = (nativeTurnId: string, item: TrackedRunningCommandItem) =>
          Ref.update(runningCommandItemsByTurn, (current) => {
            const updated = new Map(current);
            const items = new Map(updated.get(nativeTurnId) ?? []);
            items.set(item.id, item);
            updated.set(nativeTurnId, items);
            return updated;
          });

        /** Returns true when the turn has no running command items left. */
        const clearRunningCommandItem = (nativeTurnId: string, nativeItemId: string) =>
          Ref.modify(runningCommandItemsByTurn, (current) => {
            const items = current.get(nativeTurnId);
            if (items === undefined || !items.has(nativeItemId)) {
              return [items === undefined || items.size === 0, current] as const;
            }
            const remaining = new Map(items);
            remaining.delete(nativeItemId);
            const updated = new Map(current);
            if (remaining.size === 0) {
              updated.delete(nativeTurnId);
            } else {
              updated.set(nativeTurnId, remaining);
            }
            return [remaining.size === 0, updated] as const;
          });

        // MCP app captures still reading their resource, by native turn and
        // item. Each counts as retained background work, so the turn's context
        // and the run's ingestion stay open until its app lands on the item.
        // A turn that ends badly cancels its captures and settles their items
        // itself (terminalizeMcpAppCaptures).
        interface PendingMcpAppCapture {
          readonly item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>;
          readonly fiber: Fiber.Fiber<void>;
        }
        const pendingMcpAppCaptures = yield* Ref.make(
          new Map<string, ReadonlyMap<string, PendingMcpAppCapture>>(),
        );
        /** Removes a capture; true when this call removed it (each settles once). */
        const takePendingMcpAppCapture = (nativeTurnId: string, nativeItemId: string) =>
          Ref.modify(pendingMcpAppCaptures, (current) => {
            const captures = current.get(nativeTurnId);
            if (captures === undefined || !captures.has(nativeItemId)) {
              return [false, current] as const;
            }
            const remaining = new Map(captures);
            remaining.delete(nativeItemId);
            const updated = new Map(current);
            if (remaining.size === 0) updated.delete(nativeTurnId);
            else updated.set(nativeTurnId, remaining);
            return [true, updated] as const;
          });

        const trackRunningDynamicTool = (nativeTurnId: string, item: CodexDynamicToolItem) =>
          Ref.update(runningDynamicToolsByTurn, (current) => {
            const updated = new Map(current);
            const items = new Map(updated.get(nativeTurnId) ?? []);
            items.set(item.id, item);
            updated.set(nativeTurnId, items);
            return updated;
          });

        const clearRunningDynamicTool = (nativeTurnId: string, nativeItemId: string) =>
          Ref.update(runningDynamicToolsByTurn, (current) => {
            const items = current.get(nativeTurnId);
            if (items === undefined || !items.has(nativeItemId)) {
              return current;
            }
            const remaining = new Map(items);
            remaining.delete(nativeItemId);
            const updated = new Map(current);
            if (remaining.size === 0) {
              updated.delete(nativeTurnId);
            } else {
              updated.set(nativeTurnId, remaining);
            }
            return updated;
          });

        const turnHasRetainedBackgroundWork = (nativeTurnId: string) =>
          Effect.gen(function* () {
            const commands = (yield* Ref.get(runningCommandItemsByTurn)).get(nativeTurnId);
            if (commands !== undefined && commands.size > 0) {
              return true;
            }
            if ((yield* Ref.get(pendingMcpAppCaptures)).has(nativeTurnId)) {
              return true;
            }
            const tools = (yield* Ref.get(runningDynamicToolsByTurn)).get(nativeTurnId);
            if (tools === undefined) {
              return false;
            }
            for (const item of tools.values()) {
              if (isPersistentCodexDynamicTool(item)) {
                return true;
              }
            }
            return false;
          });

        const releaseSettledTurnIfIdle = (nativeTurnId: string) =>
          Effect.gen(function* () {
            if (yield* turnHasRetainedBackgroundWork(nativeTurnId)) {
              return;
            }
            yield* Ref.update(settledTurns, (current) => {
              if (!current.has(nativeTurnId)) {
                return current;
              }
              const updated = new Map(current);
              updated.delete(nativeTurnId);
              return updated;
            });
            yield* Ref.update(offeredContinuationItemsByTurn, (current) => {
              if (!current.has(nativeTurnId)) {
                return current;
              }
              const updated = new Map(current);
              updated.delete(nativeTurnId);
              return updated;
            });
            yield* Ref.update(completedFinalAnswerTextsByTurn, (current) => {
              if (!current.has(nativeTurnId)) {
                return current;
              }
              const updated = new Map(current);
              updated.delete(nativeTurnId);
              return updated;
            });
            yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
              if (!current.has(nativeTurnId)) {
                return current;
              }
              const updated = new Map(current);
              updated.delete(nativeTurnId);
              return updated;
            });
          });

        /**
         * When a turn is interrupted or failed, Codex often leaves commandExecution
         * items mid-flight (no item/completed). Emit terminal turn items before
         * turn.terminal so the projection never keeps a forever-running command card.
         * Does not retain settled context: late completions must not wake the run.
         */
        const terminalizeRunningCommandItems = (
          context: ActiveCodexTurnContext,
          nativeTurnId: string,
          status: "interrupted" | "failed",
          completedAt: DateTime.Utc,
        ) =>
          Effect.gen(function* () {
            const items = (yield* Ref.get(runningCommandItemsByTurn)).get(nativeTurnId);
            if (items === undefined || items.size === 0) {
              return;
            }
            for (const tracked of items.values()) {
              const nodeId = idAllocator.derive.nodeFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: tracked.id,
              });
              const turnItemId = idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: tracked.id,
              });
              const { ordinal, startedAt } = yield* resolveItemPosition(context, tracked.id);
              const node: OrchestrationV2ExecutionNode = {
                id: nodeId,
                threadId: context.projectionThreadId,
                runId: context.projectionRunId,
                parentNodeId: context.itemParentNodeId,
                rootNodeId: context.rootNodeId,
                kind: "tool_call",
                status,
                countsForRun: false,
                providerThreadId: context.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(tracked.id),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt,
                completedAt,
              };
              const turnItem: OrchestrationV2TurnItem = {
                id: turnItemId,
                threadId: context.projectionThreadId,
                runId: context.projectionRunId,
                nodeId,
                providerThreadId: context.providerThread.id,
                providerTurnId: context.providerTurnId,
                nativeItemRef: codexNativeItemRef(tracked.id),
                parentItemId: null,
                ordinal,
                status,
                title: null,
                startedAt,
                completedAt,
                updatedAt: completedAt,
                type: "command_execution",
                input: tracked.command,
                ...(tracked.output.text.length === 0 ? {} : { output: tracked.output.text }),
              };
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem,
              });
            }
          });

        const terminateBackgroundTerminal = Effect.fn("CodexAdapterV2.terminateBackgroundTerminal")(
          function* (nativeThreadId: string, processId: string) {
            const response = yield* client.raw
              .request("thread/backgroundTerminals/terminate", {
                threadId: nativeThreadId,
                processId,
              })
              .pipe(
                // The app-server that ran the terminal is gone, and with it
                // the only handle to the terminal: nothing is left to stop.
                Effect.catchTags({
                  CodexAppServerProcessExitedError: () => Effect.succeed({ terminated: true }),
                  CodexAppServerInputStreamEndedError: () => Effect.succeed({ terminated: true }),
                  // The thread is unloaded, as Codex does a minute after a
                  // settle or archive unsubscribes it. Unloading kills the
                  // thread's terminals, so nothing is left to stop.
                  CodexAppServerRequestError: (error) =>
                    error.code === -32600 && error.errorMessage.startsWith("thread not found:")
                      ? Effect.succeed({ terminated: true })
                      : Effect.fail(error),
                }),
              );
            const result = yield* decodeCodexBackgroundTerminalTerminateResponse(response);
            if (result.terminated) return;
            let cursor: string | null = null;
            while (true) {
              const response: unknown = yield* client.raw.request(
                "thread/backgroundTerminals/list",
                {
                  threadId: nativeThreadId,
                  ...(cursor === null ? {} : { cursor }),
                },
              );
              const page: CodexBackgroundTerminalsListPage =
                yield* decodeCodexBackgroundTerminalsListResponse(response);
              if (page.data.some((terminal) => terminal.processId === processId)) {
                return yield* toProtocolError(
                  `Codex background terminal ${processId} remained active after termination.`,
                );
              }
              if (page.nextCursor === null) return;
              cursor = page.nextCursor;
            }
          },
          Effect.timeout("10 seconds"),
        );

        /**
         * Yielded exec cells can start MCP / dynamic tools that never receive
         * item/completed when functions.wait terminates the cell. Terminalize
         * leftover nonpersistent tools before turn.terminal. Persistent tools
         * can outlive the root turn and must stay running.
         */
        const terminalizeRunningDynamicTools = (
          context: ActiveCodexTurnContext,
          nativeTurnId: string,
          status: "cancelled" | "interrupted" | "failed",
          completedAt: DateTime.Utc,
          includePersistent: boolean,
        ) =>
          Effect.gen(function* () {
            const items = (yield* Ref.get(runningDynamicToolsByTurn)).get(nativeTurnId);
            if (items === undefined || items.size === 0) {
              return;
            }
            for (const tracked of items.values()) {
              if (!includePersistent && isPersistentCodexDynamicTool(tracked)) {
                continue;
              }
              const artifacts = yield* buildDynamicToolArtifacts(context, tracked);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: {
                  ...artifacts.node,
                  status,
                  completedAt,
                },
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: {
                  ...artifacts.turnItem,
                  status,
                  completedAt,
                  updatedAt: completedAt,
                },
              });
            }
            yield* Ref.update(runningDynamicToolsByTurn, (current) => {
              if (!current.has(nativeTurnId)) {
                return current;
              }
              const remaining = new Map(current.get(nativeTurnId) ?? []);
              for (const tracked of remaining.values()) {
                if (includePersistent || !isPersistentCodexDynamicTool(tracked)) {
                  remaining.delete(tracked.id);
                }
              }
              const updated = new Map(current);
              if (remaining.size === 0) {
                updated.delete(nativeTurnId);
              } else {
                updated.set(nativeTurnId, remaining);
              }
              return updated;
            });
          });

        /**
         * Allocates an item's ordinal and start time on first sight. `item/started` seeds
         * Codex's own start time; items that stream without it start when first seen.
         */
        const resolveItemPosition = (
          context: ActiveCodexTurnContext,
          nativeItemId: string,
          startedAt?: DateTime.Utc,
        ) =>
          Effect.gen(function* () {
            // Read the clock first so the lookup and the insert run without yielding.
            const now = startedAt ?? (yield* DateTime.now);
            const existing = context.itemPositions.get(nativeItemId);
            if (existing !== undefined) {
              return existing;
            }
            const position = {
              ordinal: context.providerTurnOrdinal * 100 + context.itemPositions.size + 1,
              startedAt: now,
            };
            context.itemPositions.set(nativeItemId, position);
            return position;
          });

        const resolveItemOrdinal = (context: ActiveCodexTurnContext, nativeItemId: string) =>
          resolveItemPosition(context, nativeItemId).pipe(
            Effect.map((position) => position.ordinal),
          );

        const nextProviderTurnOrdinal = (
          providerThreadId: OrchestrationV2ProviderThread["id"],
          minimum: number,
        ) =>
          Ref.modify(nextProviderTurnOrdinals, (current) => {
            const previous = current.get(String(providerThreadId));
            const next = previous === undefined ? minimum : Math.max(previous + 1, minimum);
            const updated = new Map(current);
            updated.set(String(providerThreadId), next);
            return [next, updated];
          });

        const emitSubagentTaskUpdate = (input: {
          readonly subagent: CodexSubagentThreadContext;
          readonly status: OrchestrationV2Subagent["status"];
          readonly result?: string | null;
          readonly completedAt?: DateTime.Utc | null;
          readonly startedAt?: DateTime.Utc;
          readonly reopen?: boolean;
        }) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const prior = input.subagent.task;
            const settled = !isOrchestrationV2WorkActive(prior.status);
            // Snapshots can arrive after completion. Only an actual new turn
            // may reopen the reusable child identity.
            if (settled && isOrchestrationV2WorkActive(input.status) && !input.reopen) return;
            const status = settled && !input.reopen ? prior.status : input.status;
            const completedAt = isOrchestrationV2WorkActive(status)
              ? null
              : (prior.completedAt ?? input.completedAt ?? now);
            const task = {
              ...prior,
              status,
              ...(input.reopen
                ? {
                    runId: input.subagent.parentContext.projectionRunId,
                    parentNodeId: input.subagent.parentContext.itemParentNodeId,
                  }
                : {}),
              startedAt: input.startedAt ?? prior.startedAt,
              result: input.result === undefined ? input.subagent.task.result : input.result,
              completedAt,
              updatedAt: now,
            } satisfies OrchestrationV2Subagent;
            input.subagent.task = task;
            if (input.startedAt !== undefined) input.subagent.startedAt = input.startedAt;

            yield* emitProviderEvent({
              type: "subagent.updated",
              driver: CODEX_PROVIDER,
              subagent: task,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: {
                id: input.subagent.turnItemId,
                threadId: task.threadId,
                runId: task.runId,
                nodeId: task.id,
                providerThreadId: task.providerThreadId,
                providerTurnId: input.subagent.parentContext.providerTurnId,
                nativeItemRef: task.nativeTaskRef,
                parentItemId: null,
                ordinal: input.subagent.turnItemOrdinal,
                status: task.status,
                title: task.title,
                startedAt: task.startedAt,
                completedAt: task.completedAt,
                updatedAt: task.updatedAt,
                type: "subagent",
                subagentId: task.id,
                origin: task.origin,
                driver: task.driver,
                providerInstanceId: task.providerInstanceId,
                childThreadId: task.childThreadId,
                prompt: task.prompt,
                result: task.result,
              },
            });
          });

        const emitSubagentProviderTurnStarted = (
          subagent: CodexSubagentThreadContext,
          turn: PendingCodexSubagentTurnStarted,
        ) =>
          Effect.gen(function* () {
            if (subagent.nativeTurnIds.has(turn.nativeTurnId)) return;
            subagent.nativeTurnIds.add(turn.nativeTurnId);
            const parentNativeThreadId = yield* getNativeThreadId(
              subagent.parentContext.providerThread,
            );
            const currentParent = yield* findActiveTurnByNativeThreadId(parentNativeThreadId);
            if (currentParent !== undefined) subagent.parentContext = currentParent;
            const terminalizedNativeTurns = yield* Ref.get(terminalizedNonCompletedNativeTurns);
            let ancestor: ActiveCodexTurnContext | undefined = subagent.parentContext;
            while (ancestor !== undefined) {
              if (terminalizedNativeTurns.has(ancestor.nativeTurnId)) {
                const nativeThreadId = yield* getNativeThreadId(subagent.providerThread);
                // Fork requests off the notification reader so it can read their responses.
                yield* client
                  .request("turn/interrupt", {
                    threadId: nativeThreadId,
                    turnId: turn.nativeTurnId,
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration-v2.codex-late-subagent-interrupt-failed", {
                        nativeThreadId,
                        nativeTurnId: turn.nativeTurnId,
                        cause,
                      }),
                    ),
                    Effect.timeoutOrElse({
                      duration: "10 seconds",
                      orElse: () =>
                        Effect.logWarning(
                          "orchestration-v2.codex-late-subagent-interrupt-timeout",
                          {
                            nativeThreadId,
                            nativeTurnId: turn.nativeTurnId,
                          },
                        ),
                    }),
                    Effect.forkIn(scope),
                  );
                return;
              }
              ancestor = ancestor.subagent?.parentContext;
            }
            const providerTurnId = idAllocator.derive.providerTurn({
              driver: CODEX_PROVIDER,
              nativeTurnId: turn.nativeTurnId,
            });
            const providerTurnOrdinal = yield* nextProviderTurnOrdinal(
              subagent.providerThread.id,
              1,
            );
            const providerNodeId =
              providerTurnOrdinal === 1
                ? subagent.childRootNodeId
                : idAllocator.derive.nodeFromProviderItem({
                    driver: CODEX_PROVIDER,
                    nativeItemId: `${turn.nativeTurnId}:thread-root`,
                  });
            const activeContext: ActiveCodexTurnContext = {
              input: subagent.parentContext.input,
              projectionAppThread: subagent.childThread,
              projectionThreadId: subagent.childThreadId,
              projectionRunId: null,
              nativeTurnId: turn.nativeTurnId,
              providerThread: subagent.providerThread,
              providerTurnId,
              providerTurnOrdinal,
              providerNodeId,
              providerNodeKind: "root_turn",
              providerNodeStartedAt: turn.startedAt,
              itemParentNodeId: providerNodeId,
              rootNodeId: providerNodeId,
              subagent,
              startedAt: turn.startedAt,
              generation: makeCodexGeneration(yield* DateTime.now),
              itemPositions: new Map(),
            };
            beginTurnTokenUsage(activeContext);
            endSessionApprovalsOnModeChange(activeContext);
            yield* Ref.update(activeTurns, (current) => {
              const updated = new Map(current);
              updated.set(turn.nativeTurnId, activeContext);
              return updated;
            });
            yield* emitSubagentTaskUpdate({
              subagent,
              status: "running",
              startedAt: turn.startedAt,
              ...(providerTurnOrdinal > 1 ? { reopen: true, result: null } : {}),
            });
            const now = yield* DateTime.now;
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: CODEX_PROVIDER,
              providerThread: {
                ...subagent.providerThread,
                status: "active",
                updatedAt: now,
              },
            });
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CODEX_PROVIDER,
              threadId: subagent.childThreadId,
              providerTurn: {
                id: providerTurnId,
                providerThreadId: subagent.providerThread.id,
                nodeId: providerNodeId,
                runAttemptId: null,
                nativeTurnRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: turn.nativeTurnId,
                  strength: "strong",
                },
                ordinal: activeContext.providerTurnOrdinal,
                status: "running",
                startedAt: turn.startedAt,
                completedAt: null,
              },
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: {
                id: providerNodeId,
                threadId: subagent.childThreadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: providerNodeId,
                kind: "root_turn",
                status: "running",
                countsForRun: false,
                providerThreadId: subagent.providerThread.id,
                providerTurnId,
                nativeItemRef: subagent.task.nativeTaskRef,
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: turn.startedAt,
                completedAt: null,
              },
            });
          });

        const rememberSubagentTurnStarted = (input: {
          readonly nativeThreadId: string;
          readonly nativeTurnId: string;
          readonly startedAt: DateTime.Utc;
        }) =>
          Effect.gen(function* () {
            const subagent = (yield* Ref.get(subagentThreads)).get(input.nativeThreadId);
            if (subagent !== undefined) {
              yield* emitSubagentProviderTurnStarted(subagent, input);
              return;
            }
            yield* Ref.update(pendingSubagentTurns, (current) => {
              const updated = new Map(current);
              updated.set(input.nativeThreadId, [
                ...(updated.get(input.nativeThreadId) ?? []),
                { nativeTurnId: input.nativeTurnId, startedAt: input.startedAt },
              ]);
              return updated;
            });
          });

        const updateSubagentSelection = Effect.fnUntraced(function* (
          nativeThreadId: string,
          value: string | null,
          effort?: string | null,
          tier?: string | null,
        ) {
          const model = value?.trim();
          if (!model) return;
          const previous = subagentSelections.get(nativeThreadId);
          const previousOptions = previous?.options;
          const options =
            effort === undefined && tier === undefined
              ? previousOptions
              : [
                  ...(previousOptions ?? []).filter(({ id }) =>
                    id === "reasoningEffort"
                      ? effort === undefined
                      : id === "serviceTier" && tier === undefined,
                  ),
                  ...[
                    { id: "reasoningEffort", value: effort },
                    { id: "serviceTier", value: tier },
                  ].flatMap(({ id, value }) =>
                    value?.trim() ? [{ id, value: value.trim() }] : [],
                  ),
                ];
          const selection = {
            model,
            ...(options === undefined ? {} : { options }),
          };
          subagentSelections.set(nativeThreadId, selection);
          const subagent = (yield* Ref.get(subagentThreads)).get(nativeThreadId);
          if (subagent === undefined) return;
          const modelSelection = { instanceId: subagent.task.providerInstanceId, ...selection };
          if (
            subagent.task.modelSelection &&
            modelSelectionsEqual(subagent.task.modelSelection, modelSelection)
          )
            return;
          subagent.task = {
            ...subagent.task,
            model,
            modelSelection,
            updatedAt: yield* DateTime.now,
          };
          yield* emitProviderEvent({
            type: "subagent.updated",
            driver: CODEX_PROVIDER,
            subagent: subagent.task,
          });
        });

        const registerSubagentThread = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeThreadId: string;
          readonly nativeItemId: string;
          readonly nativeToolCallId: string;
          readonly prompt: string;
          readonly title: string | null;
          readonly model: string | null;
          readonly reasoningEffort?: string | null | undefined;
          readonly ordinal: number;
          readonly emitInitialPrompt: boolean;
        }) =>
          Effect.gen(function* () {
            const registeredSubagents = yield* Ref.get(subagentThreads);
            if (registeredSubagents.has(input.nativeThreadId)) {
              return;
            }
            if (input.model && !subagentSelections.has(input.nativeThreadId)) {
              yield* updateSubagentSelection(
                input.nativeThreadId,
                input.model,
                input.reasoningEffort,
              );
            }

            const now = yield* DateTime.now;
            const subagentNodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const childRootNodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: `${input.nativeItemId}:thread-root`,
            });
            const childThreadId = idAllocator.derive.threadFromProviderThread({
              driver: CODEX_PROVIDER,
              nativeThreadId: input.nativeThreadId,
            });
            const turnItemOrdinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
            const providerThread = {
              id: idAllocator.derive.providerThread({
                driver: CODEX_PROVIDER,
                nativeThreadId: input.nativeThreadId,
              }),
              driver: CODEX_PROVIDER,
              providerInstanceId: input.context.input.modelSelection.instanceId,
              providerSessionId: input.context.providerThread.providerSessionId,
              appThreadId: childThreadId,
              ownerNodeId: null,
              nativeThreadRef: {
                driver: CODEX_PROVIDER,
                nativeId: input.nativeThreadId,
                strength: "strong" as const,
              },
              nativeConversationHeadRef: null,
              status: "idle" as const,
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: {
                providerThreadId: input.context.providerThread.id,
                providerTurnId: input.context.providerTurnId,
              },
              createdAt: now,
              updatedAt: now,
            } satisfies OrchestrationV2ProviderThread;
            const reportedSelection = subagentSelections.get(input.nativeThreadId);
            const task = {
              id: subagentNodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              origin: "provider_native",
              createdBy: "agent",
              driver: CODEX_PROVIDER,
              providerInstanceId: input.context.input.modelSelection.instanceId,
              providerThreadId: providerThread.id,
              childThreadId,
              nativeTaskRef: codexNativeItemRef(input.nativeItemId),
              prompt: input.prompt,
              title: input.title,
              model: reportedSelection?.model ?? input.model,
              modelSelection: reportedSelection
                ? {
                    instanceId: input.context.input.modelSelection.instanceId,
                    ...reportedSelection,
                  }
                : undefined,
              status: "running",
              result: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
            } satisfies OrchestrationV2Subagent;
            const childThread = makeSubagentChildThread({
              parentThread: input.context.projectionAppThread,
              childThreadId,
              parentNodeId: subagentNodeId,
              activeProviderThreadId: providerThread.id,
              providerInstanceId: input.context.input.modelSelection.instanceId,
              modelSelection: {
                ...input.context.input.modelSelection,
                model: task.model ?? input.context.input.modelSelection.model,
              },
              title: subagentThreadTitle({
                parentTitle: input.context.projectionAppThread.title,
                prompt: task.prompt,
                title: task.title,
                ordinal: input.ordinal,
              }),
              now,
              createdBy: "agent",
              creationSource: "provider",
            });
            const subagent = {
              parentContext: input.context,
              providerThread,
              childThread,
              subagentNodeId,
              childRootNodeId,
              childThreadId,
              nativeToolCallId: input.nativeToolCallId,
              ordinal: input.ordinal,
              nativeTurnIds: new Set<string>(),
              startedAt: now,
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              }),
              turnItemOrdinal,
              task,
            } satisfies CodexSubagentThreadContext;

            yield* Ref.update(subagentThreads, (current) => {
              const updated = new Map(current);
              updated.set(input.nativeThreadId, subagent);
              return updated;
            });
            yield* emitProviderEvent({
              type: "app_thread.created",
              driver: CODEX_PROVIDER,
              appThread: childThread,
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: {
                id: subagentNodeId,
                threadId: input.context.projectionThreadId,
                runId: input.context.projectionRunId,
                parentNodeId: input.context.itemParentNodeId,
                rootNodeId: input.context.rootNodeId,
                kind: "subagent",
                status: "running",
                countsForRun: false,
                providerThreadId: providerThread.id,
                providerTurnId: input.context.providerTurnId,
                nativeItemRef: codexNativeItemRef(input.nativeToolCallId),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: {
                id: childRootNodeId,
                threadId: childThreadId,
                runId: null,
                parentNodeId: null,
                rootNodeId: childRootNodeId,
                kind: "root_turn",
                status: "running",
                countsForRun: false,
                providerThreadId: providerThread.id,
                providerTurnId: null,
                nativeItemRef: codexNativeItemRef(input.nativeItemId),
                runtimeRequestId: null,
                checkpointScopeId: null,
                startedAt: now,
                completedAt: null,
              },
            });
            yield* emitProviderEvent({
              type: "provider_thread.updated",
              driver: CODEX_PROVIDER,
              providerThread,
            });
            if (input.emitInitialPrompt && input.prompt.length > 0) {
              const promptNativeItemId = `${input.nativeItemId}:prompt`;
              const promptArtifacts = makeSubagentConversationArtifacts({
                senderThreadId: input.context.projectionThreadId,
                messageId: idAllocator.derive.messageFromProviderItem({
                  driver: CODEX_PROVIDER,
                  nativeItemId: promptNativeItemId,
                }),
                turnItemId: idAllocator.derive.turnItemFromProviderItem({
                  driver: CODEX_PROVIDER,
                  nativeItemId: promptNativeItemId,
                }),
                threadId: childThreadId,
                rootNodeId: childRootNodeId,
                providerThreadId: providerThread.id,
                providerTurnId: null,
                nativeItemRef: codexNativeItemRef(promptNativeItemId),
                role: "user",
                text: input.prompt,
                ordinal: 100,
                now,
              });
              yield* emitProviderEvent({
                type: "message.updated",
                driver: CODEX_PROVIDER,
                message: promptArtifacts.message,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: promptArtifacts.turnItem,
              });
            }
            yield* emitSubagentTaskUpdate({
              subagent,
              status: "running",
            });

            const pendingTurns = yield* Ref.modify(pendingSubagentTurns, (current) => {
              const pending = current.get(input.nativeThreadId) ?? [];
              const updated = new Map(current);
              updated.delete(input.nativeThreadId);
              return [pending, updated];
            });
            for (const pendingTurn of pendingTurns) {
              yield* emitSubagentProviderTurnStarted(subagent, pendingTurn);
            }
            if (task.model === null) {
              yield* client.raw
                .request("thread/read", { threadId: input.nativeThreadId, includeTurns: false })
                .pipe(
                  Effect.flatMap(decodeCodexChildThread),
                  Effect.map((response): typeof CodexChildSelection.Type | null =>
                    response.thread.id === input.nativeThreadId && response.thread.model?.trim()
                      ? {
                          thread: response.thread,
                          model: response.thread.model,
                          reasoningEffort: response.thread.reasoningEffort,
                        }
                      : null,
                  ),
                  Effect.catch(() => Effect.succeed(null)),
                  Effect.flatMap((response) =>
                    response === null
                      ? client.raw
                          .request("thread/resume", {
                            threadId: input.nativeThreadId,
                            excludeTurns: true,
                          })
                          .pipe(Effect.flatMap(decodeCodexChildModel))
                      : Effect.succeed(response),
                  ),
                  Effect.timeout("5 seconds"),
                  Effect.flatMap((response) =>
                    response.thread.id === input.nativeThreadId &&
                    !subagentSelections.has(input.nativeThreadId)
                      ? updateSubagentSelection(
                          input.nativeThreadId,
                          response.model,
                          response.reasoningEffort,
                          response.serviceTier,
                        )
                      : Effect.void,
                  ),
                  Effect.catch(() => Effect.void),
                  Effect.forkIn(scope),
                );
            }
          });

        const registerSubagentThreads = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly item: CodexCollabAgentToolCallItem;
        }) =>
          Effect.gen(function* () {
            if (input.item.tool !== "spawnAgent" || input.item.receiverThreadIds.length === 0) {
              return;
            }

            for (const [index, nativeThreadId] of input.item.receiverThreadIds.entries()) {
              const model =
                typeof input.item.model === "string" && input.item.model.length > 0
                  ? input.item.model
                  : null;
              yield* registerSubagentThread({
                context: input.context,
                nativeThreadId,
                nativeItemId: `${input.item.id}:${nativeThreadId}`,
                nativeToolCallId: input.item.id,
                prompt: input.item.prompt ?? "",
                title: null,
                model,
                reasoningEffort: input.item.reasoningEffort,
                ordinal: index + 1,
                emitInitialPrompt: true,
              });
            }
          });

        const registerSubagentActivity = (input: {
          readonly context?: ActiveCodexTurnContext;
          readonly item: CodexSubAgentActivityItem;
        }) =>
          Effect.gen(function* () {
            if (input.item.kind === "started") {
              const context = input.context;
              if (context === undefined) return;
              const registeredSubagents = yield* Ref.get(subagentThreads);
              const ordinal =
                Array.from(registeredSubagents.values()).filter(
                  (subagent) => subagent.parentContext.rootNodeId === context.rootNodeId,
                ).length + 1;
              yield* registerSubagentThread({
                context,
                nativeThreadId: input.item.agentThreadId,
                nativeItemId: `${input.item.id}:${input.item.agentThreadId}`,
                nativeToolCallId: input.item.id,
                prompt: "",
                title: input.item.agentPath,
                model: null,
                ordinal,
                emitInitialPrompt: false,
              });
              return;
            }

            const subagent = (yield* Ref.get(subagentThreads)).get(input.item.agentThreadId);
            if (subagent === undefined) {
              return;
            }

            if (input.item.kind === "interrupted" || input.item.kind === "completed") {
              yield* emitSubagentTaskUpdate({
                subagent,
                status: input.item.kind,
              });
            }
          });

        const updateSubagentStates = (input: { readonly item: CodexCollabAgentToolCallItem }) =>
          Effect.gen(function* () {
            const subagents = yield* Ref.get(subagentThreads);
            for (const [nativeThreadId, state] of Object.entries(input.item.agentsStates)) {
              const subagent = subagents.get(nativeThreadId);
              if (subagent === undefined) {
                continue;
              }
              const statuses = {
                pendingInit: "pending",
                running: "running",
                interrupted: "interrupted",
                completed: "completed",
                errored: "failed",
                shutdown: "cancelled",
                notFound: "failed",
              } as const satisfies Record<
                CodexSchema.ServerNotification__CollabAgentStatus,
                OrchestrationV2Subagent["status"]
              >;
              const status = statuses[state.status];
              yield* emitSubagentTaskUpdate({
                subagent,
                status,
                ...(state.message === null ? {} : { result: state.message }),
              });
            }
          });

        const resolvePlanId = (context: ActiveCodexTurnContext, planKey: string) =>
          Effect.gen(function* () {
            const existing = (yield* Ref.get(planIds)).get(planKey);
            if (existing !== undefined) {
              return existing;
            }
            const planId = yield* idAllocator.allocate.plan({
              threadId: context.projectionThreadId,
              ...(context.projectionRunId === null ? {} : { runId: context.projectionRunId }),
              driver: CODEX_PROVIDER,
            });
            yield* Ref.update(planIds, (current) => {
              const updated = new Map(current);
              updated.set(planKey, planId);
              return updated;
            });
            return planId;
          });

        const resolveCodexAttachment = (attachment: ChatAttachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (attachmentPath === null) {
              return yield* toProtocolError(`Invalid attachment id '${attachment.id}'`);
            }
            const bytes = yield* fileSystem
              .readFile(attachmentPath)
              .pipe(
                Effect.mapError((cause) =>
                  toProtocolError(`Failed to read attachment '${attachment.id}'.`, cause),
                ),
              );
            return {
              type: "image" as const,
              url: `data:${attachment.mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
            } satisfies CodexSchema.V2TurnStartParams__UserInput;
          });

        const toCodexInput = (
          turnInput: Pick<
            | ProviderAdapter.ProviderAdapterV2TurnInput
            | ProviderAdapter.ProviderAdapterV2SteerInput,
            "message"
          >,
        ) =>
          Effect.gen(function* () {
            const inputItems: Array<CodexSchema.V2TurnStartParams__UserInput> = [];
            const text = providerMessageTextWithAttachmentPaths({
              text: codexSkillMentionText(turnInput.message.text),
              attachments: turnInput.message.attachments,
              resolveAttachmentPath: (attachment) =>
                resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment }),
            });
            if (text.length > 0) {
              inputItems.push({
                type: "text",
                text,
              });
            }
            const attachmentItems = yield* Effect.forEach(
              turnInput.message.attachments.filter(isProviderNativeImageAttachment),
              resolveCodexAttachment,
              { concurrency: 1 },
            );
            inputItems.push(...attachmentItems);
            if (inputItems.length === 0) {
              return yield* toProtocolError("Turn requires non-empty text or attachments.");
            }
            return inputItems;
          });

        const buildAgentMessageArtifacts = (
          context: ActiveCodexTurnContext,
          item: { readonly id: string; readonly text: string },
          completed: boolean,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const completedAt = completed ? updatedAt : null;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
            const messageId = idAllocator.derive.messageFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "assistant_message",
              status: completed ? "completed" : "running",
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const message: OrchestrationV2ConversationMessage = {
              createdBy: "agent",
              creationSource: "provider",
              id: messageId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              role: "assistant",
              text: item.text,
              attachments: [],
              streaming: !completed,
              createdAt: startedAt,
              updatedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              parentItemId: null,
              ordinal,
              status: completed ? "completed" : "running",
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "assistant_message",
              messageId,
              text: item.text,
              streaming: !completed,
            };
            return { node, message, turnItem };
          });

        // Summary and raw reasoning are separate streams, with independently indexed parts.
        // Reuse the text coalescer so token bursts do not create one database write per token.
        const reasoningParts = new Map<
          string,
          { turnId: string; nativeItemId: string; stream: "summary" | "content"; index: number }
        >();
        const reasoningDeltas = yield* makeProviderTextDeltaCoalescer({
          flushIntervalMs: CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS,
          emit: (update) =>
            Effect.gen(function* () {
              const part = reasoningParts.get(update.itemId);
              if (part === undefined) return;
              const context = yield* awaitActiveTurn(update.turnId);
              if (context === undefined) return;
              const artifacts = yield* buildAgentMessageArtifacts(
                context,
                { id: update.itemId, text: update.text },
                update.completed,
              );
              const interrupted = (yield* Ref.get(terminalizedNonCompletedNativeTurns)).has(
                update.turnId,
              );
              const { messageId: _messageId, ...item } = artifacts.turnItem;
              const nativeItemRef = codexNativeItemRef(part.nativeItemId);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: {
                  ...artifacts.node,
                  kind: "reasoning",
                  nativeItemRef,
                  ...(interrupted ? { status: "interrupted" as const } : {}),
                },
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: {
                  ...item,
                  type: "reasoning",
                  nativeItemRef,
                  ...(interrupted ? { status: "interrupted" as const } : {}),
                },
              });
            }),
        });
        const reasoningPartKey = (
          turnId: string,
          nativeItemId: string,
          stream: "summary" | "content",
          index: number,
        ) => {
          const key = JSON.stringify([turnId, nativeItemId, stream, index]);
          reasoningParts.set(key, { turnId, nativeItemId, stream, index });
          return key;
        };
        const appendReasoning = Effect.fn("CodexAdapterV2.appendReasoning")(function* (
          payload: { turnId: string; itemId: string; delta: string },
          stream: "summary" | "content",
          index: number,
        ) {
          const context = yield* awaitActiveTurn(payload.turnId);
          if (context === undefined || payload.delta.length === 0) return;
          const now = yield* DateTime.now;
          // Raw reasoning streams from the first token; a summary trails the reasoning it sums up.
          if (stream === "content") observeCodexOutput(context.generation, now, "reasoning");
          yield* completeProviderRetry(context, now);
          const itemId = reasoningPartKey(payload.turnId, payload.itemId, stream, index);
          // Reserve the position before the delayed flush, ahead of later tool items.
          yield* resolveItemOrdinal(context, itemId);
          yield* reasoningDeltas.append({ turnId: payload.turnId, itemId, delta: payload.delta });
        });
        const completeReasoning = Effect.fn("CodexAdapterV2.completeReasoning")(function* (
          turnId: string,
          item: { id: string; summary?: ReadonlyArray<string>; content?: ReadonlyArray<string> },
        ) {
          for (const stream of ["summary", "content"] as const) {
            for (const [index] of (item[stream] ?? []).entries()) {
              reasoningPartKey(turnId, item.id, stream, index);
            }
          }
          for (const [key, part] of reasoningParts) {
            if (part.turnId !== turnId || part.nativeItemId !== item.id) continue;
            const finalText = item[part.stream]?.[part.index];
            yield* reasoningDeltas.complete({
              turnId,
              itemId: key,
              ...(finalText ? { finalText } : {}),
              emitEmpty: false,
            });
            reasoningParts.delete(key);
          }
        });

        const agentMessageDeltas = yield* makeProviderTextDeltaCoalescer({
          flushIntervalMs: CODEX_ASSISTANT_DELTA_FLUSH_INTERVAL_MS,
          emit: (update) =>
            Effect.gen(function* () {
              const context = yield* awaitActiveTurn(update.turnId);
              if (context === undefined) {
                return;
              }
              const finalAnswerItem = (yield* Ref.get(finalAnswerItemIdsByTurn))
                .get(update.turnId)
                ?.has(update.itemId);
              if (finalAnswerItem) {
                const finalAnswerItemIds = (yield* Ref.get(finalAnswerItemIdsByTurn)).get(
                  update.turnId,
                );
                const completedTexts =
                  (yield* Ref.get(completedFinalAnswerTextsByTurn)).get(update.turnId) ??
                  new Set<string>();
                const firstFinalAnswerItemId = finalAnswerItemIds?.values().next().value;
                const duplicateCompletion =
                  update.completed &&
                  completedTexts.size > 0 &&
                  (update.text.length === 0 || completedTexts.has(update.text));
                const deferredStreamingUpdate =
                  !update.completed &&
                  (completedTexts.size > 0 || firstFinalAnswerItemId !== update.itemId);
                if (deferredStreamingUpdate || duplicateCompletion) {
                  return;
                }
              }
              const artifacts = yield* buildAgentMessageArtifacts(
                context,
                { id: update.itemId, text: update.text },
                update.completed,
              );
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              // Clients render streaming text from the turn item, so the
              // message only carries the final text. flushTurn completes every
              // buffered item when a turn ends, interrupted or not.
              if (update.completed) {
                yield* emitProviderEvent({
                  type: "message.updated",
                  driver: CODEX_PROVIDER,
                  message: artifacts.message,
                });
              }
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              if (finalAnswerItem && update.completed) {
                yield* Ref.update(completedFinalAnswerTextsByTurn, (current) => {
                  const updated = new Map(current);
                  const texts = new Set(updated.get(update.turnId) ?? []);
                  texts.add(update.text);
                  updated.set(update.turnId, texts);
                  return updated;
                });
              }
            }),
        });

        const emitSubagentUserMessage = (
          context: ActiveCodexTurnContext,
          item: Extract<
            | CodexSchema.V2ItemStartedNotification__ThreadItem
            | CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "userMessage" }
          >,
          nativeStartedAt?: DateTime.Utc,
        ) =>
          Effect.gen(function* () {
            if (context.subagent === null || context.providerTurnOrdinal === 1) {
              return false;
            }
            const text = codexUserMessageText(item.content);
            if (text.length === 0) {
              return false;
            }
            const { ordinal, startedAt } = yield* resolveItemPosition(
              context,
              item.id,
              nativeStartedAt,
            );
            const artifacts = makeSubagentConversationArtifacts({
              senderThreadId: context.subagent.parentContext.projectionThreadId,
              messageId: idAllocator.derive.messageFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: item.id,
              }),
              turnItemId: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: item.id,
              }),
              threadId: context.projectionThreadId,
              rootNodeId: context.rootNodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              role: "user",
              text,
              ordinal,
              now: startedAt,
            });
            yield* emitProviderEvent({
              type: "message.updated",
              driver: CODEX_PROVIDER,
              message: artifacts.message,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            return true;
          });

        const buildCommandExecutionArtifacts = (
          context: ActiveCodexTurnContext,
          item: Extract<
            | CodexSchema.V2ItemStartedNotification__ThreadItem
            | CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "commandExecution" }
          >,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const status = codexItemStatus(item.status);
            const completedAt = status.completed ? updatedAt : null;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "tool_call",
              status: status.node,
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              parentItemId: null,
              ordinal,
              status: status.turnItem,
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "command_execution",
              input: item.command,
              ...(item.aggregatedOutput === null || item.aggregatedOutput === undefined
                ? {}
                : { output: item.aggregatedOutput }),
              ...(item.exitCode === null || item.exitCode === undefined
                ? {}
                : { exitCode: item.exitCode }),
            };
            return { node, turnItem };
          });

        const buildFileChangeArtifacts = (
          context: ActiveCodexTurnContext,
          item: Extract<
            CodexSchema.V2ItemCompletedNotification__ThreadItem,
            { type: "fileChange" }
          >,
        ) =>
          Effect.gen(function* () {
            const firstChange = item.changes[0];
            if (firstChange === undefined) {
              return null;
            }

            const updatedAt = yield* DateTime.now;
            const status = codexItemStatus(item.status);
            const completedAt = status.completed ? updatedAt : null;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "tool_call",
              status: status.node,
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              parentItemId: null,
              ordinal,
              status: status.turnItem,
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "file_change",
              fileName: firstChange.path,
              diffStr: firstChange.diff,
              changes: item.changes.map((change) => {
                const movePath = change.kind.type === "update" ? change.kind.move_path : undefined;
                return movePath
                  ? { operation: change.kind.type, path: movePath, oldPath: change.path }
                  : { operation: change.kind.type, path: change.path };
              }),
            };
            return { node, turnItem };
          });

        const buildWebSearchArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly item: CodexWebSearchItem;
          readonly status: "running" | "completed" | "cancelled" | "failed" | "interrupted";
          readonly updatedAt?: DateTime.Utc;
        }) =>
          Effect.gen(function* () {
            const updatedAt = input.updatedAt ?? (yield* DateTime.now);
            const completedAt = input.status === "running" ? null : updatedAt;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(input.context, input.item.id);
            const patterns = webSearchPatterns(input.item);
            const { status } = input;
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              rootNodeId: input.context.rootNodeId,
              kind: "tool_call",
              status,
              countsForRun: false,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.item.id),
              parentItemId: null,
              ordinal,
              status,
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "web_search",
              ...(patterns.length === 0 ? {} : { patterns: [...patterns] }),
            };
            return { node, turnItem };
          });

        const buildImageViewArtifacts = (
          context: ActiveCodexTurnContext,
          item: CodexImageViewItem,
          imagePath: string,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "tool_call",
              status: "completed",
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt: updatedAt,
            };
            // Shown like a Claude Read of an image: the chat previews the file.
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt,
              completedAt: updatedAt,
              updatedAt,
              type: "dynamic_tool",
              toolName: "view_image",
              viewedImagePath: imagePath,
              input: { path: imagePath },
            };
            return { node, turnItem };
          });

        const buildImageGenerationArtifacts = (
          context: ActiveCodexTurnContext,
          item: CodexImageGenerationItem,
          status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const completedAt = status === "running" ? null : updatedAt;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
            let note: string | undefined;
            let output: unknown;
            let viewedImagePath: string | undefined;
            if (status === "failed") {
              note =
                item.failure?.type === "usageLimitExceeded"
                  ? `Image generation limit reached (${item.failure.limitId.slice(0, 200)})`
                  : "Image generation failed";
              output = [{ type: "text", text: note }];
            } else if (status === "completed") {
              const result = item.result?.trim() ?? "";
              const path = codexViewedImagePath(item.savedPath ?? result);
              const dataUrl = /^data:(image\/(?:png|jpeg|gif|webp));base64,/i.exec(result);
              const data = dataUrl ? result.slice(dataUrl[0].length) : result;
              const detectedMimeType = data.startsWith("iVBORw0KGgo")
                ? "image/png"
                : data.startsWith("/9j/")
                  ? "image/jpeg"
                  : data.startsWith("R0lGOD")
                    ? "image/gif"
                    : data.startsWith("UklGR")
                      ? "image/webp"
                      : undefined;
              const mimeType =
                dataUrl && dataUrl[1]?.toLowerCase() !== detectedMimeType
                  ? undefined
                  : detectedMimeType;
              const decodedSize =
                Math.floor((data.length * 3) / 4) -
                (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
              if (
                mimeType &&
                (data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH ||
                  decodedSize > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
              ) {
                note = "Image too large to show";
              } else if (
                mimeType &&
                data.length >= 16 &&
                data.length % 4 !== 1 &&
                /^[A-Za-z0-9+/]*={0,2}$/.test(data)
              ) {
                output = [{ type: "image", mimeType, data }];
              } else if (path) {
                const stat = yield* fileSystem.stat(path).pipe(Effect.option);
                if (Option.isSome(stat) && stat.value.type === "File") {
                  if (stat.value.size > BigInt(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)) {
                    note = "Image too large to show";
                  } else if (stat.value.size === 0n) {
                    note = "Image unavailable";
                  } else {
                    viewedImagePath = path;
                  }
                } else {
                  note = "Image unavailable";
                }
              } else {
                note = "Image unavailable";
              }
              if (note) output = [{ type: "text", text: note }];
            }
            const title = note ? `Generated image: ${note}` : "Generated image";
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "tool_call",
              status,
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: item.id,
              }),
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              parentItemId: null,
              ordinal,
              status,
              title,
              startedAt,
              completedAt,
              updatedAt,
              type: "dynamic_tool",
              toolName: "image_gen",
              input: {
                ...(item.revisedPrompt ? { revisedPrompt: item.revisedPrompt.slice(0, 8192) } : {}),
                ...(item.transparentBackground == null
                  ? {}
                  : { transparentBackground: item.transparentBackground }),
              },
              ...(viewedImagePath ? { viewedImagePath } : {}),
              ...(output === undefined ? {} : { output }),
            };
            return { node, turnItem };
          });

        const emitImageGeneration = (
          context: ActiveCodexTurnContext,
          item: CodexImageGenerationItem,
          status: "running" | "completed" | "failed" | "interrupted" | "cancelled",
        ) =>
          Effect.gen(function* () {
            const artifacts = yield* buildImageGenerationArtifacts(context, item, status);
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          });

        const buildDynamicToolArtifacts = (
          context: ActiveCodexTurnContext,
          item: CodexDynamicToolItem,
        ) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const status = codexItemStatus(item.status);
            const completedAt = status.completed ? updatedAt : null;
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: item.id,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(context, item.id);
            const projection = yield* projectCodexDynamicToolItem(item).pipe(
              Effect.provideService(Crypto.Crypto, crypto),
            );
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "tool_call",
              status: status.node,
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(item.id),
              parentItemId: null,
              ordinal,
              title: projection.title ?? null,
              startedAt,
              completedAt,
              updatedAt,
              type: "dynamic_tool",
              ...projection,
            };
            return { node, turnItem };
          });

        /**
         * Completes an MCP tool call whose tool names a UI resource: reads the
         * resource through Codex's MCP client, stores it, and records the app
         * in the item's output. The item stays running until then, which keeps
         * the run's event ingestion open past turn/completed; it runs off the
         * notification reader so a slow server cannot stall other events.
         */
        const captureMcpApp = (
          context: ActiveCodexTurnContext,
          nativeTurnId: string,
          item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>,
          resourceUri: string,
        ) =>
          Effect.gen(function* () {
            // Registered before it can run, so a turn ending right away sees it.
            const started = yield* Deferred.make<void>();
            const fiber = yield* Deferred.await(started).pipe(
              Effect.andThen(captureMcpAppItem(context, nativeTurnId, item, resourceUri)),
              Effect.forkIn(scope, { startImmediately: true }),
            );
            yield* Ref.update(pendingMcpAppCaptures, (current) => {
              const updated = new Map(current);
              updated.set(
                nativeTurnId,
                new Map(current.get(nativeTurnId) ?? []).set(item.id, { item, fiber }),
              );
              return updated;
            });
            yield* Deferred.succeed(started, undefined);
          });

        const captureMcpAppItem = (
          context: ActiveCodexTurnContext,
          nativeTurnId: string,
          item: Extract<CodexDynamicToolItem, { readonly type: "mcpToolCall" }>,
          resourceUri: string,
        ) =>
          // Only reading and storing the document can be cancelled; a write
          // cut short removes its file. Once a document is stored, the capture
          // either lands it on the item or, when its turn already settled the
          // item, removes it, so no stored app goes unreferenced.
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const reference =
                item.status === "completed" && item.result != null && item.error == null
                  ? yield* restore(
                      getNativeThreadId(context.providerThread).pipe(
                        Effect.flatMap((threadId) =>
                          client.request("mcpServer/resource/read", {
                            threadId,
                            server: item.server,
                            uri: resourceUri,
                          }),
                        ),
                        Effect.timeout(MCP_APP_CAPTURE_TIMEOUT),
                        Effect.flatMap((response) =>
                          snapshotMcpApp({
                            attachmentsDir: serverConfig.attachmentsDir,
                            threadId: context.projectionThreadId,
                            server: item.server,
                            tool: item.tool,
                            resourceUri,
                            contents: response.contents,
                          }),
                        ),
                        Effect.provideService(FileSystem.FileSystem, fileSystem),
                        // Every failure and defect becomes a plain tool row,
                        // so a crashed read never holds the turn open; only
                        // interruption, the turn cancelling the capture, ends
                        // the fiber here. Nothing typed is left for orDie.
                        Effect.catchCauseIf(
                          (cause) => !Cause.hasInterruptsOnly(cause),
                          (cause) =>
                            Effect.logWarning(
                              "Failed to capture an MCP app; showing a plain tool row.",
                              { server: item.server, tool: item.tool, resourceUri, cause },
                            ).pipe(Effect.as(undefined)),
                        ),
                        Effect.orDie,
                      ),
                    )
                  : undefined;
              const artifacts = yield* buildDynamicToolArtifacts(context, item);
              // Cleared before the final emit: ingestion re-checks pending work
              // after each event, and must see this capture done by then. A turn
              // that already ended badly took the capture and settled its item.
              if (!(yield* takePendingMcpAppCapture(nativeTurnId, item.id))) {
                if (reference !== undefined) {
                  const filePath = resolveAttachmentPathById({
                    attachmentsDir: serverConfig.attachmentsDir,
                    attachmentId: reference.attachmentId,
                  });
                  if (filePath !== null) {
                    yield* fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore);
                  }
                }
                return;
              }
              const turnItem =
                reference === undefined || artifacts.turnItem.type !== "dynamic_tool"
                  ? artifacts.turnItem
                  : {
                      ...artifacts.turnItem,
                      // The full CallToolResult the app replays, beside the app.
                      output: { [MCP_APP_OUTPUT_KEY]: reference, result: item.result },
                    };
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem,
              });
              // Only a turn that already ended is released; an active one
              // still needs its final-answer bookkeeping.
              if ((yield* Ref.get(settledTurns)).has(nativeTurnId)) {
                yield* releaseSettledTurnIfIdle(nativeTurnId);
              }
            }),
          );

        /**
         * Settles the items of app captures still running when their turn is
         * interrupted or fails: the capture is cancelled and its tool call is
         * reported as it completed, without the app, before the turn's
         * terminal event closes ingestion.
         */
        const terminalizeMcpAppCaptures = (context: ActiveCodexTurnContext, nativeTurnId: string) =>
          Effect.gen(function* () {
            const captures = (yield* Ref.get(pendingMcpAppCaptures)).get(nativeTurnId);
            if (captures === undefined) return;
            for (const { item, fiber } of captures.values()) {
              if (!(yield* takePendingMcpAppCapture(nativeTurnId, item.id))) continue;
              yield* Fiber.interrupt(fiber);
              const artifacts = yield* buildDynamicToolArtifacts(context, item);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
            }
          });

        const buildProposedPlanArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeItemId: string;
          readonly status: OrchestrationV2PlanArtifact["status"];
          readonly markdown: string;
          readonly completed?: boolean;
        }) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const completedAt = input.completed === true ? updatedAt : null;
            const planId = yield* resolvePlanId(input.context, input.nativeItemId);
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(
              input.context,
              input.nativeItemId,
            );
            const plan: OrchestrationV2PlanArtifact = {
              id: planId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              kind: "proposed_plan",
              status: input.status,
              markdown: input.markdown,
            };
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              rootNodeId: input.context.rootNodeId,
              kind: "plan",
              status: input.completed === true ? "completed" : "running",
              countsForRun: false,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              parentItemId: null,
              ordinal,
              status: input.completed === true ? "completed" : "running",
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "proposed_plan",
              planId,
              markdown: input.markdown,
              streaming: input.completed !== true,
            };
            return { node, plan, turnItem };
          });

        // Streamed plan text, flushed at most once per interval. A turn that ends
        // early leaves its partial plan streaming, as an unfinished plan item.
        const planDeltas = yield* makeProviderTextDeltaCoalescer({
          flushIntervalMs: CODEX_PLAN_DELTA_FLUSH_INTERVAL_MS,
          emit: (update) =>
            Effect.gen(function* () {
              const resolved = yield* resolveItemEventContext(update.turnId);
              if (resolved === undefined) return;
              const interrupted = (yield* Ref.get(terminalizedNonCompletedNativeTurns)).has(
                update.turnId,
              );
              const artifacts = yield* buildProposedPlanArtifacts({
                context: resolved.context,
                nativeItemId: update.itemId,
                // A finished proposal stays active until Implement consumes it.
                status: "active",
                markdown: update.text,
                completed: update.completed && !interrupted,
              });
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "plan.updated",
                driver: CODEX_PROVIDER,
                plan: artifacts.plan,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
            }).pipe(Effect.orDie),
        });

        const buildTodoListArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeItemId: string;
          readonly status: OrchestrationV2PlanArtifact["status"];
          readonly steps: ReadonlyArray<OrchestrationV2PlanStep>;
          readonly explanation?: string;
          readonly completed?: boolean;
        }) =>
          Effect.gen(function* () {
            const updatedAt = yield* DateTime.now;
            const completedAt = input.completed === true ? updatedAt : null;
            const planId = yield* resolvePlanId(input.context, input.nativeItemId);
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const { ordinal, startedAt } = yield* resolveItemPosition(
              input.context,
              input.nativeItemId,
            );
            const plan: OrchestrationV2PlanArtifact = {
              id: planId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              kind: "todo_list",
              status: input.status,
              steps: [...input.steps],
              ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
            };
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              rootNodeId: input.context.rootNodeId,
              kind: "todo_list",
              status: input.completed === true ? "completed" : "running",
              countsForRun: false,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              parentItemId: null,
              ordinal,
              status: input.completed === true ? "completed" : "running",
              title: null,
              startedAt,
              completedAt,
              updatedAt,
              type: "todo_list",
              planId,
              steps: [...input.steps],
              ...(input.explanation === undefined ? {} : { explanation: input.explanation }),
            };
            return { node, plan, turnItem };
          });

        const buildApprovalRequestArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeItemId: string;
          readonly nativeRequestId: string;
          readonly requestKind: ProviderRequestKind;
          readonly prompt?: string | null;
          readonly appName?: string;
          readonly options?: ReadonlyArray<ProviderApprovalOption>;
        }) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            // A subagent's approval is asked on the top-level thread and run,
            // under the subagent that asked, where the user can see and answer it.
            const { owner, subagent } = approvalOwnerCodexTurn(input.context);
            const parentNodeId =
              subagent?.subagentNodeId ??
              idAllocator.derive.nodeFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: input.nativeItemId,
              });
            const ordinal = yield* resolveItemOrdinal(
              owner,
              `${input.nativeItemId}:approval:${input.nativeRequestId}`,
            );
            const requestId = yield* idAllocator.allocate.runtimeRequest({
              driver: CODEX_PROVIDER,
              providerTurnId: owner.providerTurnId,
              nativeRequestId: input.nativeRequestId,
            });
            const nodeId = idAllocator.derive.approvalNode({ requestId });
            const providerSessionId = owner.input.providerThread.providerSessionId;
            if (providerSessionId === null) {
              return yield* toProtocolError(
                `Provider thread ${owner.providerThread.id} is missing a provider session id.`,
              );
            }
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: owner.projectionThreadId,
              runId: owner.projectionRunId,
              parentNodeId,
              rootNodeId: owner.rootNodeId,
              kind: "approval_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: owner.providerThread.id,
              providerTurnId: owner.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: createdAt,
              completedAt: null,
            };
            const request: OrchestrationV2RuntimeRequest = {
              id: requestId,
              nodeId,
              providerTurnId: owner.providerTurnId,
              nativeRequestRef: {
                driver: CODEX_PROVIDER,
                nativeId: input.nativeRequestId,
                strength: "strong",
              },
              kind: input.requestKind,
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId,
              },
              createdAt,
              resolvedAt: null,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: idAllocator.derive.approvalTurnItem({ requestId }),
              threadId: owner.projectionThreadId,
              runId: owner.projectionRunId,
              nodeId,
              providerThreadId: owner.providerThread.id,
              providerTurnId: owner.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              parentItemId: null,
              ordinal,
              status: "waiting",
              title: null,
              startedAt: createdAt,
              completedAt: null,
              updatedAt: createdAt,
              type: "approval_request",
              requestId,
              requestKind: input.requestKind,
              ...(input.prompt === null || input.prompt === undefined
                ? {}
                : { prompt: input.prompt }),
              ...(input.appName === undefined ? {} : { appName: input.appName }),
              ...(input.options === undefined ? {} : { options: input.options }),
            };
            return { node, request, turnItem };
          });

        const buildUserInputRequestArtifacts = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeItemId: string;
          readonly nativeRequestId: string;
          readonly questions: ReadonlyArray<CodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion>;
          readonly responseMode?: "message";
        }) =>
          Effect.gen(function* () {
            const createdAt = yield* DateTime.now;
            const requestId = yield* idAllocator.allocate.runtimeRequest({
              driver: CODEX_PROVIDER,
              providerTurnId: input.context.providerTurnId,
              nativeRequestId: input.nativeRequestId,
            });
            const providerSessionId = input.context.input.providerThread.providerSessionId;
            if (providerSessionId === null) {
              return yield* toProtocolError(
                `Provider thread ${input.context.providerThread.id} is missing a provider session id.`,
              );
            }
            const questions = input.questions.map((question, index) => ({
              id: nonEmptyText(question.id, `question-${index + 1}`),
              header: nonEmptyText(question.header, "Question"),
              question: nonEmptyText(question.question, "Choose an answer."),
              options:
                question.options?.map((option, optionIndex) => ({
                  label: nonEmptyText(option.label, `Option ${optionIndex + 1}`),
                  description: nonEmptyText(option.description, option.label),
                })) ?? [],
            }));
            const nodeId = idAllocator.derive.nodeFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const turnItemId = idAllocator.derive.turnItemFromProviderItem({
              driver: CODEX_PROVIDER,
              nativeItemId: input.nativeItemId,
            });
            const ordinal = yield* resolveItemOrdinal(input.context, input.nativeItemId);
            const node: OrchestrationV2ExecutionNode = {
              id: nodeId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              parentNodeId: input.context.itemParentNodeId,
              rootNodeId: input.context.rootNodeId,
              kind: "user_input_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              runtimeRequestId: requestId,
              checkpointScopeId: null,
              startedAt: createdAt,
              completedAt: null,
            };
            const request: OrchestrationV2RuntimeRequest = {
              id: requestId,
              nodeId,
              providerTurnId: input.context.providerTurnId,
              nativeRequestRef: {
                driver: CODEX_PROVIDER,
                nativeId: input.nativeRequestId,
                strength: "strong",
              },
              kind: "user_input",
              status: "pending",
              responseCapability:
                input.responseMode === "message"
                  ? { type: "message" }
                  : { type: "live", providerSessionId },
              createdAt,
              resolvedAt: null,
            };
            const turnItem: OrchestrationV2TurnItem = {
              id: turnItemId,
              threadId: input.context.projectionThreadId,
              runId: input.context.projectionRunId,
              nodeId,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              nativeItemRef: codexNativeItemRef(input.nativeItemId),
              parentItemId: null,
              ordinal,
              status: "waiting",
              title: null,
              startedAt: createdAt,
              completedAt: null,
              updatedAt: createdAt,
              type: "user_input_request",
              requestId,
              questions,
              ...(input.responseMode === undefined ? {} : { responseMode: input.responseMode }),
            };
            return { node, request, turnItem };
          });

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
            if (context !== undefined) {
              const now = yield* DateTime.now;
              observeCodexOutput(context.generation, now, "text");
              yield* completeProviderRetry(context, now);
            }
            yield* agentMessageDeltas.append({
              turnId: payload.turnId,
              itemId: payload.itemId,
              delta: payload.delta,
            });
          }),
        );

        yield* client.handleServerNotification("item/commandExecution/outputDelta", (payload) =>
          Effect.gen(function* () {
            // A delta always follows its item/started, so the turn is already
            // known; background commands keep printing after it settles.
            const context =
              (yield* Ref.get(activeTurns)).get(payload.turnId) ??
              (yield* Ref.get(settledTurns)).get(payload.turnId);
            if (context === undefined) return;
            yield* Ref.update(runningCommandItemsByTurn, (current) => {
              const items = current.get(payload.turnId);
              const tracked = items?.get(payload.itemId);
              if (tracked === undefined) return current;
              const updated = new Map(current);
              const nextItems = new Map(items);
              nextItems.set(payload.itemId, {
                ...tracked,
                output: appendTerminalOutput(tracked.output, payload.delta),
              });
              updated.set(payload.turnId, nextItems);
              return updated;
            });
            yield* emitProviderEvent({
              type: "command_output.delta",
              driver: CODEX_PROVIDER,
              threadId: context.projectionThreadId,
              itemId: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId: payload.itemId,
              }),
              chunk: payload.delta,
            });
          }).pipe(turnTerminalizationPermit.withPermits(1)),
        );

        yield* client.handleServerNotification("item/reasoning/summaryTextDelta", (payload) =>
          appendReasoning(payload, "summary", payload.summaryIndex),
        );
        yield* client.handleServerNotification("item/reasoning/textDelta", (payload) =>
          appendReasoning(payload, "content", payload.contentIndex),
        );

        yield* client.handleServerNotification("item/plan/delta", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return;
            }
            const now = yield* DateTime.now;
            observeCodexOutput(context.generation, now, "text");
            yield* completeProviderRetry(context, now);
            yield* planDeltas.append({
              turnId: payload.turnId,
              itemId: payload.itemId,
              delta: payload.delta,
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("turn/plan/updated", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return;
            }
            yield* completeProviderRetry(context, yield* DateTime.now);
            const steps = payload.plan.map((step, index) => ({
              id: `step-${index + 1}`,
              text: nonEmptyText(step.step, `Step ${index + 1}`),
              status: codexPlanStepStatus(step.status),
            }));
            const explanation = trimText(payload.explanation);
            const artifacts = yield* buildTodoListArtifacts({
              context,
              nativeItemId: `turn-plan:${payload.turnId}`,
              status: "active",
              // Each update is a complete snapshot; nothing later completes the item.
              completed: true,
              ...(explanation === undefined ? {} : { explanation }),
              steps,
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "plan.updated",
              driver: CODEX_PROVIDER,
              plan: artifacts.plan,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("account/rateLimits/updated", (payload) =>
          Effect.gen(function* () {
            yield* Ref.update(rateLimitSnapshot, (previous) =>
              mergeCodexRateLimits(previous, payload.rateLimits),
            );
            const resetAt = codexUsageLimitResetAt(yield* Ref.get(rateLimitSnapshot));
            for (const item of (yield* Ref.get(limitedTurnItems)).values()) {
              // Fill late reset data once; later account windows do not change this stopped turn.
              if (resetAt === null || item.failure.resetAt != null) continue;
              const updated = {
                ...item,
                updatedAt: yield* DateTime.now,
                failure: { ...item.failure, resetAt },
              };
              yield* Ref.update(limitedTurnItems, (current) =>
                new Map(current).set(item.providerThreadId!, updated),
              );
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: updated,
              });
            }
            // Map only named windows, with metadata retained from earlier notifications.
            const merged = yield* Ref.get(rateLimitSnapshot);
            const knownLimits = adapterOptions.getUsageLimits
              ? yield* adapterOptions.getUsageLimits
              : undefined;
            const update = codexRateLimitsToUpdate(
              {
                ...payload.rateLimits,
                primary: payload.rateLimits.primary == null ? null : (merged?.primary ?? null),
                secondary:
                  payload.rateLimits.secondary == null ? null : (merged?.secondary ?? null),
              },
              knownLimits,
            );
            if (update && adapterOptions.onUsageLimits) {
              const checkedAt = DateTime.formatIso(yield* DateTime.now);
              yield* adapterOptions.onUsageLimits({ ...update, checkedAt });
            }
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerNotification("thread/tokenUsage/updated", (payload) =>
          Effect.gen(function* () {
            const receivedAt = yield* DateTime.now;
            const usageState = usageStateForThread(payload.threadId);
            // Codex repeats the last report (on rate-limit updates); only a moved total is a new response.
            const newResponse = codexTokenUsageReportIsNew(usageState, payload.tokenUsage);
            accumulateCodexTurnTokenUsage(usageState, payload.turnId, payload.tokenUsage);
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return;
            }
            if (newResponse ?? context.generation.observed) {
              endCodexReply(context.generation, {
                outputTokens: payload.tokenUsage.last.outputTokens,
                reasoningOutputTokens: payload.tokenUsage.last.reasoningOutputTokens,
                at: receivedAt,
              });
            }
            const now = yield* DateTime.now;
            // Live context usage rides on the provider turn (#8144): the turn
            // is the natural owner and re-emitting it never disturbs items.
            yield* emitProviderEvent({
              type: "provider_turn.updated",
              driver: CODEX_PROVIDER,
              threadId: context.projectionThreadId,
              providerTurn: {
                id: context.providerTurnId,
                providerThreadId: context.providerThread.id,
                nodeId: context.providerNodeId,
                runAttemptId: context.subagent === null ? context.input.attemptId : null,
                nativeTurnRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: payload.turnId,
                  strength: "strong",
                },
                ordinal: context.providerTurnOrdinal,
                status: "running",
                startedAt: context.startedAt,
                completedAt: null,
                ...codexGenerationField(context),
                tokenUsage: codexProviderTurnTokenUsage(
                  payload.tokenUsage,
                  DateTime.formatIso(now),
                ),
              },
            });
          }).pipe(Effect.orDie),
        );

        // Codex reports a response's moderation metadata as the response finishes.
        yield* client.handleServerNotification("turn/moderationMetadata", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turnId);
            if (context !== undefined) {
              observeCodexResponseEnd(context.generation, yield* DateTime.now);
            }
          }),
        );

        yield* client.handleServerNotification("thread/settings/updated", (payload) =>
          updateSubagentSelection(
            payload.threadId,
            payload.threadSettings.model,
            payload.threadSettings.effort,
            payload.threadSettings.serviceTier,
          ),
        );
        yield* client.handleServerNotification("model/rerouted", (payload) =>
          updateSubagentSelection(payload.threadId, payload.toModel),
        );

        yield* client.handleServerNotification("turn/started", (payload) =>
          Effect.gen(function* () {
            const context = (yield* Ref.get(activeTurns)).get(payload.turn.id);
            if (context !== undefined) {
              if (context.nativeStartReady !== undefined) {
                yield* Deferred.succeed(context.nativeStartReady, undefined);
              }
              return;
            }
            const pendingRootTurn = (yield* Ref.get(pendingRootTurns)).get(payload.threadId);
            if (pendingRootTurn !== undefined) {
              yield* registerRootTurn({
                turnInput: pendingRootTurn,
                nativeTurnId: payload.turn.id,
                startedAt: codexTimestamp(payload.turn.startedAt),
              });
              yield* Ref.update(pendingRootTurns, (current) => {
                const updated = new Map(current);
                updated.delete(payload.threadId);
                return updated;
              });
              return;
            }
            // Codex continues an active goal on its own. The next turn joins the
            // run its previous turn belongs to.
            const goalHold = goalHolds.get(payload.threadId);
            if (goalHold !== undefined) {
              goalHolds.delete(payload.threadId);
              yield* emitProviderEvent({
                type: "provider_turn.updated",
                driver: CODEX_PROVIDER,
                threadId: goalHold.context.projectionThreadId,
                providerTurn: goalHold.completedTurn,
              });
              const next = yield* registerRootTurn({
                turnInput: {
                  ...goalHold.context.input,
                  providerTurnOrdinal: goalHold.context.providerTurnOrdinal + 1,
                },
                nativeTurnId: payload.turn.id,
                startedAt: codexTimestamp(payload.turn.startedAt),
              });
              const goalRun = goalRuns.get(goalHold.context.providerTurnId) ?? [goalHold.context];
              goalRun.push(next);
              goalRuns.set(goalHold.context.providerTurnId, goalRun);
              goalRuns.set(next.providerTurnId, goalRun);
              yield* Deferred.succeed(goalHold.next, next);
              return;
            }
            // A goal turn with no run to own it (Codex continued after the run
            // settled, or raced a Stop): stop it and pause the goal rather than
            // work out of sight.
            if (
              rootProviderThreads.has(payload.threadId) &&
              (goalsByNativeThread.get(payload.threadId)?.status === "active" ||
                goalStops.has(payload.threadId))
            ) {
              yield* Effect.logWarning("orchestration-v2.codex-goal-turn-without-run", {
                nativeThreadId: payload.threadId,
                nativeTurnId: payload.turn.id,
              });
              yield* client
                .request("thread/goal/set", { threadId: payload.threadId, status: "paused" })
                .pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration-v2.codex-goal-pause-failed", { cause }),
                  ),
                  Effect.andThen(
                    client.request("turn/interrupt", {
                      threadId: payload.threadId,
                      turnId: payload.turn.id,
                    }),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration-v2.codex-goal-turn-stop-failed", { cause }),
                  ),
                  Effect.forkIn(scope),
                );
              return;
            }
            yield* rememberSubagentTurnStarted({
              nativeThreadId: payload.threadId,
              nativeTurnId: payload.turn.id,
              startedAt: codexTimestamp(payload.turn.startedAt),
            });
          }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
        );

        // A goal that stops being active ends any run held open for its next turn.
        yield* client.handleServerNotification("thread/goal/updated", (payload) =>
          Effect.gen(function* () {
            goalsByNativeThread.set(payload.threadId, providerGoalFromCodex(payload.goal));
            yield* emitGoalUpdate(payload.threadId);
            if (payload.goal.status !== "active") yield* releaseGoalHold(payload.threadId);
          }).pipe(turnTerminalizationPermit.withPermits(1)),
        );
        yield* client.handleServerNotification("thread/goal/cleared", (payload) =>
          Effect.gen(function* () {
            goalsByNativeThread.set(payload.threadId, null);
            yield* emitGoalUpdate(payload.threadId);
            yield* releaseGoalHold(payload.threadId);
          }).pipe(turnTerminalizationPermit.withPermits(1)),
        );

        yield* client.handleServerNotification("error", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return;
            }
            const message = payload.error.additionalDetails?.trim() || payload.error.message;
            const { code, failureClass } = codexFailureInfo(payload.error.codexErrorInfo, message);
            if (!payload.willRetry) {
              context.latestProviderFailure = {
                nativeMessage: payload.error.message,
                failure: makeProviderFailure({
                  message,
                  code,
                  ...(isCodexCapacityFailure(code, payload.error.message)
                    ? { retryable: true }
                    : {}),
                  class: failureClass ?? "provider_error",
                }),
              };
              return;
            }
            const updatedAt = yield* DateTime.now;
            const previous = (yield* Ref.get(providerRetries)).get(context.providerTurnId);
            const progress = parseCodexRetryProgress(payload.error.message);
            const retry: OrchestrationV2ProviderRetry = {
              attempt: progress?.attempt ?? (previous?.retry.attempt ?? 0) + 1,
              maxAttempts: progress?.maxAttempts ?? previous?.retry.maxAttempts ?? null,
              retryDelayMs: null,
            };
            const failure = makeProviderFailure({
              message,
              code,
              class:
                failureClass ??
                (code?.startsWith("http") === true || code?.startsWith("responseStream") === true
                  ? "transport_error"
                  : "provider_error"),
              retryable: true,
            });
            const itemOrdinal =
              previous?.itemOrdinal ??
              (yield* resolveItemOrdinal(context, `terminal-failure:${context.providerTurnId}`));
            const state: ActiveCodexProviderRetry = {
              nativeMessage: payload.error.message,
              retry,
              failure,
              startedAt: previous?.startedAt ?? updatedAt,
              itemOrdinal,
            };
            yield* Ref.update(providerRetries, (current) => {
              const updated = new Map(current);
              updated.set(context.providerTurnId, state);
              return updated;
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: makeProviderRetryTurnItem({
                driver: CODEX_PROVIDER,
                threadId: context.projectionThreadId,
                runId: context.projectionRunId,
                nodeId: context.providerNodeId,
                providerThreadId: context.providerThread.id,
                providerTurnId: context.providerTurnId,
                itemOrdinal,
                failure,
                retry,
                status: "running",
                startedAt: state.startedAt,
                updatedAt,
              }),
            });
          }).pipe(Effect.orDie),
        );

        const emitCompactionItem = Effect.fn("CodexAdapterV2.emitCompactionItem")(function* (
          context: ActiveCodexTurnContext,
          nativeItemId: string,
          status: "running" | "completed",
          nativeStartedAt?: DateTime.Utc,
        ) {
          const now = yield* DateTime.now;
          const { ordinal, startedAt } = yield* resolveItemPosition(
            context,
            nativeItemId,
            nativeStartedAt,
          );
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId,
              }),
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId: context.providerNodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(nativeItemId),
              parentItemId: null,
              ordinal,
              type: "compaction",
              driver: CODEX_PROVIDER,
              status,
              title: status === "completed" ? "Context compacted" : "Compacting context",
              startedAt,
              completedAt: status === "completed" ? now : null,
              updatedAt: now,
            },
          });
        });

        const emitSleepItem = Effect.fn("CodexAdapterV2.emitSleepItem")(function* (
          context: ActiveCodexTurnContext,
          nativeItemId: string,
          durationMs: number,
          status: "running" | "completed" | "interrupted" | "failed" | "cancelled",
          nativeStartedAt?: DateTime.Utc,
        ) {
          const now = yield* DateTime.now;
          const { ordinal, startedAt } = yield* resolveItemPosition(
            context,
            nativeItemId,
            nativeStartedAt,
          );
          const nodeId = idAllocator.derive.nodeFromProviderItem({
            driver: CODEX_PROVIDER,
            nativeItemId,
          });
          const completedAt = status === "running" ? null : now;
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: {
              id: nodeId,
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              parentNodeId: context.itemParentNodeId,
              rootNodeId: context.rootNodeId,
              kind: "tool_call",
              status,
              countsForRun: false,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(nativeItemId),
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt,
              completedAt,
            },
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: {
              id: idAllocator.derive.turnItemFromProviderItem({
                driver: CODEX_PROVIDER,
                nativeItemId,
              }),
              threadId: context.projectionThreadId,
              runId: context.projectionRunId,
              nodeId,
              providerThreadId: context.providerThread.id,
              providerTurnId: context.providerTurnId,
              nativeItemRef: codexNativeItemRef(nativeItemId),
              parentItemId: null,
              ordinal,
              type: "dynamic_tool",
              toolName: codexSleepLabel(durationMs, status === "completed"),
              input: null,
              title: null,
              status,
              startedAt,
              completedAt,
              updatedAt: now,
            },
          });
        });

        // Unloading an idle thread kills its terminals without completing
        // their command items, while the shared provider session stays alive.
        yield* client.handleServerNotification("thread/closed", (payload) =>
          Effect.gen(function* () {
            const completedAt = yield* DateTime.now;
            for (const context of (yield* Ref.get(settledTurns)).values()) {
              if (context.providerThread.nativeThreadRef?.nativeId !== payload.threadId) continue;
              const commands = (yield* Ref.get(runningCommandItemsByTurn)).get(
                context.nativeTurnId,
              );
              if (commands !== undefined) {
                context.closedCommandItemIds = new Set(commands.keys());
              }
              yield* terminalizeRunningCommandItems(
                context,
                context.nativeTurnId,
                "interrupted",
                completedAt,
              );
              yield* Ref.update(runningCommandItemsByTurn, (current) => {
                const updated = new Map(current);
                updated.delete(context.nativeTurnId);
                return updated;
              });
              yield* releaseSettledTurnIfIdle(context.nativeTurnId);
            }
          }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
        );

        yield* client.handleServerNotification("item/started", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return;
            }
            observeCodexItemStarted(context.generation, payload.item.type, yield* DateTime.now);

            if (payload.item.type === "contextCompaction") {
              yield* emitCompactionItem(
                context,
                payload.item.id,
                "running",
                DateTime.makeUnsafe(payload.startedAtMs),
              );
              return;
            }

            if (payload.item.type === "userMessage") {
              yield* emitSubagentUserMessage(
                context,
                payload.item,
                DateTime.makeUnsafe(payload.startedAtMs),
              );
              return;
            }

            if (payload.item.type === "subAgentActivity") {
              markSubagentUsage(context);
              yield* registerSubagentActivity({
                context,
                item: payload.item,
              });
              return;
            }

            yield* completeProviderRetry(context, yield* DateTime.now);
            // Reasoning streams per part, so its parts take their own first-seen times.
            if (payload.item.type !== "reasoning") {
              yield* resolveItemPosition(
                context,
                payload.item.id,
                DateTime.makeUnsafe(payload.startedAtMs),
              );
            }

            if (payload.item.type === "agentMessage") {
              if (payload.item.phase == null || payload.item.phase === "final_answer") {
                yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
                  const updated = new Map(current);
                  const itemIds = new Set(updated.get(payload.turnId) ?? []);
                  itemIds.add(payload.item.id);
                  updated.set(payload.turnId, itemIds);
                  return updated;
                });
              }
              return;
            }

            if (payload.item.type === "imageGeneration") {
              const images = runningImagesByTurn.get(payload.turnId) ?? new Map();
              images.set(payload.item.id, payload.item);
              runningImagesByTurn.set(payload.turnId, images);
              yield* emitImageGeneration(context, payload.item, "running");
              return;
            }

            if (payload.item.type === "sleep") {
              const sleeps = runningSleepsByTurn.get(payload.turnId) ?? new Map<string, number>();
              sleeps.set(payload.item.id, payload.item.durationMs);
              runningSleepsByTurn.set(payload.turnId, sleeps);
              yield* emitSleepItem(
                context,
                payload.item.id,
                payload.item.durationMs,
                "running",
                DateTime.makeUnsafe(payload.startedAtMs),
              );
              return;
            }

            if (payload.item.type === "commandExecution") {
              if (!codexItemStatus(payload.item.status).completed) {
                yield* trackRunningCommandItem(payload.turnId, {
                  id: payload.item.id,
                  command: payload.item.command,
                  output: appendTerminalOutput(
                    EMPTY_TERMINAL_OUTPUT,
                    (payload.item.aggregatedOutput ?? "").slice(-TERMINAL_OUTPUT_TAIL_CHARS * 4),
                  ),
                  ...(typeof payload.item.processId === "string"
                    ? { processId: payload.item.processId }
                    : {}),
                });
              }
              const artifacts = yield* buildCommandExecutionArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type === "mcpToolCall" || payload.item.type === "dynamicToolCall") {
              if (!codexItemStatus(payload.item.status).completed) {
                yield* trackRunningDynamicTool(payload.turnId, payload.item);
              }
              const artifacts = yield* buildDynamicToolArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type !== "webSearch") {
              return;
            }

            const searches = runningWebSearchesByTurn.get(payload.turnId) ?? new Map();
            searches.set(payload.item.id, payload.item);
            runningWebSearchesByTurn.set(payload.turnId, searches);
            const artifacts = yield* buildWebSearchArtifacts({
              context,
              item: payload.item,
              status: "running",
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
          }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
        );

        yield* client.handleServerNotification("item/completed", (payload) =>
          Effect.gen(function* () {
            if (payload.item.type === "contextCompaction") {
              // Invalidate now so a session lost before turn/completed resends the context.
              yield* invalidateAdditionalContext(payload.threadId);
              threadsAwaitingContextRestore.add(payload.threadId);
            }
            if (
              (payload.item.type === "subAgentActivity" ||
                payload.item.type === "collabAgentToolCall") &&
              (yield* Ref.get(terminalizedNonCompletedNativeTurns)).has(payload.turnId)
            )
              return;
            // Child lifecycle notifications outlive the parent's turn context.
            if (payload.item.type === "subAgentActivity" && payload.item.kind !== "started") {
              yield* registerSubagentActivity({ item: payload.item });
              return;
            }
            if (payload.item.type === "collabAgentToolCall" && payload.item.tool !== "spawnAgent") {
              yield* updateSubagentStates({ item: payload.item });
              return;
            }
            const resolved = yield* resolveItemEventContext(payload.turnId);
            if (resolved === undefined) {
              return;
            }
            const { context, settled } = resolved;

            if (payload.item.type === "imageGeneration") {
              runningImagesByTurn.get(payload.turnId)?.delete(payload.item.id);
              if (runningImagesByTurn.get(payload.turnId)?.size === 0) {
                runningImagesByTurn.delete(payload.turnId);
              }
              yield* emitImageGeneration(
                context,
                payload.item,
                payload.item.status === "failed" || payload.item.failure != null
                  ? "failed"
                  : "completed",
              );
              return;
            }

            if (payload.item.type === "sleep") {
              runningSleepsByTurn.get(payload.turnId)?.delete(payload.item.id);
              if (runningSleepsByTurn.get(payload.turnId)?.size === 0)
                runningSleepsByTurn.delete(payload.turnId);
              yield* emitSleepItem(context, payload.item.id, payload.item.durationMs, "completed");
              return;
            }

            if (payload.item.type === "reasoning") {
              yield* completeReasoning(payload.turnId, payload.item);
              return;
            }

            if (payload.item.type === "contextCompaction") {
              yield* emitCompactionItem(context, payload.item.id, "completed");
              return;
            }

            if (payload.item.type === "userMessage") {
              if (yield* emitSubagentUserMessage(context, payload.item)) {
                return;
              }
            }

            if (payload.item.type === "commandExecution") {
              // Other tools can retain the context after thread closure.
              if (context.closedCommandItemIds?.has(payload.item.id)) return;
              const turnDrained = yield* clearRunningCommandItem(payload.turnId, payload.item.id);
              const artifacts = yield* buildCommandExecutionArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              if (settled) {
                if (
                  context.subagent === null &&
                  continuationRequests !== undefined &&
                  !(yield* Ref.get(interruptingNativeTurns)).has(payload.turnId)
                ) {
                  const alreadyOffered = yield* Ref.modify(
                    offeredContinuationItemsByTurn,
                    (current) => {
                      const items = current.get(payload.turnId);
                      if (items !== undefined && items.has(payload.item.id)) {
                        return [true, current] as const;
                      }
                      const updated = new Map(current);
                      const updatedItems = new Set(items ?? []);
                      updatedItems.add(payload.item.id);
                      updated.set(payload.turnId, updatedItems);
                      return [false, updated] as const;
                    },
                  );
                  if (!alreadyOffered) {
                    yield* continuationRequests.offer({
                      threadId: context.projectionThreadId,
                      providerThreadId: context.providerThread.id,
                      driver: CODEX_PROVIDER,
                      detail: codexBackgroundCommandDetail(payload.item),
                      notification: {
                        ...backgroundWorkNotification([
                          {
                            kind: "command",
                            label: payload.item.command,
                            outcome:
                              payload.item.exitCode === 0
                                ? "completed"
                                : payload.item.exitCode == null
                                  ? "unknown"
                                  : "failed",
                            exitCode: payload.item.exitCode ?? undefined,
                          },
                        ]),
                        detail: payload.item.command,
                      },
                    });
                  }
                }
                if (turnDrained) {
                  yield* releaseSettledTurnIfIdle(payload.turnId);
                }
              }
              return;
            }

            if (payload.item.type === "mcpToolCall" || payload.item.type === "dynamicToolCall") {
              yield* clearRunningDynamicTool(payload.turnId, payload.item.id);
              const appResourceUri = codexMcpAppResourceUri(payload.item);
              if (appResourceUri !== undefined && payload.item.type === "mcpToolCall") {
                yield* captureMcpApp(context, payload.turnId, payload.item, appResourceUri);
                return;
              }
              const artifacts = yield* buildDynamicToolArtifacts(context, payload.item);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              if (settled) {
                yield* releaseSettledTurnIfIdle(payload.turnId);
              }
              return;
            }

            if (payload.item.type === "fileChange") {
              const artifacts = yield* buildFileChangeArtifacts(context, payload.item);
              if (artifacts === null) {
                return;
              }
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type === "webSearch") {
              runningWebSearchesByTurn.get(payload.turnId)?.delete(payload.item.id);
              if (runningWebSearchesByTurn.get(payload.turnId)?.size === 0) {
                runningWebSearchesByTurn.delete(payload.turnId);
              }
              const artifacts = yield* buildWebSearchArtifacts({
                context,
                item: payload.item,
                status: "completed",
              });
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type === "plan") {
              yield* planDeltas.complete({
                turnId: payload.turnId,
                itemId: payload.item.id,
                ...(payload.item.text.length > 0 ? { finalText: payload.item.text } : {}),
              });
              return;
            }

            if (payload.item.type === "collabAgentToolCall") {
              if (payload.item.tool === "spawnAgent") markSubagentUsage(context);
              yield* registerSubagentThreads({
                context,
                item: payload.item,
              });
              yield* updateSubagentStates({
                item: payload.item,
              });
              return;
            }

            if (payload.item.type === "subAgentActivity") {
              markSubagentUsage(context);
              yield* registerSubagentActivity({
                context,
                item: payload.item,
              });
              return;
            }

            if (payload.item.type === "imageView") {
              const imagePath = codexViewedImagePath(payload.item.path);
              if (imagePath === undefined) return;
              const artifacts = yield* buildImageViewArtifacts(context, payload.item, imagePath);
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              return;
            }

            if (payload.item.type !== "agentMessage") {
              return;
            }

            if (payload.item.delivery === "async" && payload.item.questions?.length) {
              const artifacts = yield* buildUserInputRequestArtifacts({
                context,
                nativeItemId: payload.item.id,
                nativeRequestId: `async:${payload.item.id}`,
                responseMode: "message",
                questions: payload.item.questions.map((question, index) => ({
                  id: String(index),
                  header: "Question",
                  question: question.title,
                  options: (question.options ?? []).map((label) => ({ label, description: "" })),
                })),
              });
              yield* emitProviderEvent({
                type: "node.updated",
                driver: CODEX_PROVIDER,
                node: artifacts.node,
              });
              yield* emitProviderEvent({
                type: "turn_item.updated",
                driver: CODEX_PROVIDER,
                turnItem: artifacts.turnItem,
              });
              yield* emitProviderEvent({
                type: "runtime_request.updated",
                driver: CODEX_PROVIDER,
                threadId: artifacts.node.threadId,
                runtimeRequest: artifacts.request,
              });
              yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
                const ids = current.get(payload.turnId);
                if (!ids?.has(payload.item.id)) return current;
                const next = new Map(current);
                const remaining = new Set(ids);
                remaining.delete(payload.item.id);
                if (remaining.size === 0) next.delete(payload.turnId);
                else next.set(payload.turnId, remaining);
                return next;
              });
              return;
            }

            const finalAnswer = payload.item.phase == null || payload.item.phase === "final_answer";
            if (finalAnswer) {
              yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
                const updated = new Map(current);
                const itemIds = new Set(updated.get(payload.turnId) ?? []);
                itemIds.add(payload.item.id);
                updated.set(payload.turnId, itemIds);
                return updated;
              });
            }
            const completedTextsBefore =
              (yield* Ref.get(completedFinalAnswerTextsByTurn)).get(payload.turnId) ??
              new Set<string>();
            const text = yield* agentMessageDeltas.complete({
              turnId: payload.turnId,
              itemId: payload.item.id,
              finalText: payload.item.text,
            });
            yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
              const itemIds = current.get(payload.turnId);
              if (itemIds === undefined || !itemIds.has(payload.item.id)) {
                return current;
              }
              const updated = new Map(current);
              const remainingItemIds = new Set(itemIds);
              remainingItemIds.delete(payload.item.id);
              if (remainingItemIds.size === 0) {
                updated.delete(payload.turnId);
              } else {
                updated.set(payload.turnId, remainingItemIds);
              }
              return updated;
            });
            const emitted =
              !finalAnswer ||
              completedTextsBefore.size === 0 ||
              (text.length > 0 && !completedTextsBefore.has(text));
            if (emitted && context.subagent !== null && finalAnswer) {
              yield* emitSubagentTaskUpdate({
                subagent: context.subagent,
                status: context.subagent.task.status,
                result: text,
              });
            }
          }).pipe(Effect.orDie, turnTerminalizationPermit.withPermits(1)),
        );

        yield* client.handleServerRequest("item/commandExecution/requestApproval", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for approval turn ${payload.turnId}.`,
                payload,
              );
            }
            if (context.input.runtimePolicy.runtimeMode === "full-access") {
              return {
                decision: "accept",
              } satisfies CodexSchema.CommandExecutionRequestApprovalResponse;
            }
            const allowance = sessionAllowance(payload.threadId, context);
            const detail = codexCommandApprovalDetail(payload);
            const isNetworkRequest =
              payload.networkApprovalContext != null ||
              (payload.proposedNetworkPolicyAmendments?.length ?? 0) > 0;
            if (detail !== undefined && !isNetworkRequest && allowance.has("command")) {
              return {
                decision: "acceptForSession",
              } satisfies CodexSchema.CommandExecutionRequestApprovalResponse;
            }

            const nativeRequestId = payload.approvalId ?? payload.itemId;
            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: payload.itemId,
              nativeRequestId,
              requestKind: "command",
              prompt: detail ?? CODEX_APPROVAL_TOO_LARGE,
              ...(detail === undefined ? { options: CODEX_DENY_ONLY } : {}),
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind: "command",
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            if (detail === undefined)
              return {
                decision: "decline",
              } satisfies CodexSchema.CommandExecutionRequestApprovalResponse;
            if (
              !isNetworkRequest &&
              (resolved === "acceptForSession" || resolved === "acceptAlways")
            ) {
              allowance.add("command");
            }
            return {
              decision: resolved === "acceptAlways" ? "acceptForSession" : resolved,
            } satisfies CodexSchema.CommandExecutionRequestApprovalResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("item/fileChange/requestApproval", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for file change approval turn ${payload.turnId}.`,
                payload,
              );
            }
            if (context.input.runtimePolicy.runtimeMode === "full-access") {
              return { decision: "accept" } satisfies CodexSchema.FileChangeRequestApprovalResponse;
            }
            const allowance = sessionAllowance(payload.threadId, context);
            if (allowance.has("file-change")) {
              return {
                decision: "acceptForSession",
              } satisfies CodexSchema.FileChangeRequestApprovalResponse;
            }

            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: payload.itemId,
              nativeRequestId: payload.itemId,
              requestKind: "file-change",
              prompt: codexFileChangeApprovalPrompt(payload) ?? null,
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind: "file-change",
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            if (resolved === "acceptForSession" || resolved === "acceptAlways") {
              allowance.add("file-change");
            }
            return {
              decision: resolved === "acceptAlways" ? "acceptForSession" : resolved,
            } satisfies CodexSchema.FileChangeRequestApprovalResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("item/permissions/requestApproval", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for permissions approval turn ${payload.turnId}.`,
                payload,
              );
            }
            if (context.input.runtimePolicy.runtimeMode === "full-access") {
              return permissionsResponseFromDecision({
                decision: "accept",
                permissions: payload.permissions,
              });
            }

            const requestKind = providerRequestKindFromPermissions(payload.permissions);
            const detail = codexPermissionApprovalDetail(payload);
            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: payload.itemId,
              nativeRequestId: payload.itemId,
              requestKind,
              prompt: detail ?? CODEX_APPROVAL_TOO_LARGE,
              ...(detail === undefined ? { options: CODEX_DENY_ONLY } : {}),
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind,
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            return permissionsResponseFromDecision({
              decision: detail === undefined ? "decline" : resolved,
              permissions: payload.permissions,
            });
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("mcpServer/elicitation/request", (payload) =>
          Effect.gen(function* () {
            // Unsupported elicitation shapes cannot express an approval, so
            // cancel instead of presenting a request the user cannot answer.
            const acceptance = toMcpElicitationResponse(payload, "accept");
            if (acceptance.action !== "accept") {
              yield* Effect.logWarning("Cancelled an unsupported MCP elicitation.", {
                serverName: payload.serverName,
                mode: payload.mode,
              });
              return {
                action: "cancel",
              } satisfies CodexSchema.McpServerElicitationRequestResponse;
            }
            const context =
              payload.turnId === undefined || payload.turnId === null
                ? yield* awaitRegisteredTurn(findActiveTurnByNativeThreadId(payload.threadId))
                : yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              yield* Effect.logWarning(
                "Cancelled an MCP elicitation without an active Codex turn context.",
                { serverName: payload.serverName },
              );
              return {
                action: "cancel",
              } satisfies CodexSchema.McpServerElicitationRequestResponse;
            }

            if (context.input.runtimePolicy.runtimeMode === "full-access") {
              return acceptance;
            }

            const nativeRequestId =
              payload.mode === "url"
                ? payload.elicitationId
                : `mcp-elicitation:${payload.serverName}`;
            const described = describeMcpElicitation(payload);
            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: nativeRequestId,
              nativeRequestId,
              requestKind: "mcp-elicitation",
              prompt: payload.message,
              appName: described.appName,
              options: described.options,
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind: "mcp-elicitation",
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            return toMcpElicitationResponse(payload, resolved);
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("execCommandApproval", (payload) =>
          Effect.gen(function* () {
            const context = yield* findActiveTurnByNativeThreadId(payload.conversationId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for exec approval thread ${payload.conversationId}.`,
                payload,
              );
            }
            const allowance = sessionAllowance(payload.conversationId, context);
            if (allowance.has("command")) {
              return {
                decision: "approved_for_session",
              } satisfies CodexSchema.ExecCommandApprovalResponse;
            }

            const nativeRequestId = payload.approvalId ?? payload.callId;
            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: payload.callId,
              nativeRequestId,
              requestKind: "command",
              prompt: payload.reason ?? payload.command.join(" "),
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind: "command",
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            if (resolved === "acceptForSession" || resolved === "acceptAlways") {
              allowance.add("command");
            }
            return {
              decision: approvalDecisionToLegacyReviewDecision(resolved),
            } satisfies CodexSchema.ExecCommandApprovalResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("applyPatchApproval", (payload) =>
          Effect.gen(function* () {
            const context = yield* findActiveTurnByNativeThreadId(payload.conversationId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for apply patch approval thread ${payload.conversationId}.`,
                payload,
              );
            }
            const allowance = sessionAllowance(payload.conversationId, context);
            if (allowance.has("file-change")) {
              return {
                decision: "approved_for_session",
              } satisfies CodexSchema.ApplyPatchApprovalResponse;
            }

            const artifacts = yield* buildApprovalRequestArtifacts({
              context,
              nativeItemId: payload.callId,
              nativeRequestId: payload.callId,
              requestKind: "file-change",
              prompt: codexFileChangeApprovalPrompt(payload) ?? null,
            });
            const decision = yield* Deferred.make<ProviderApprovalDecision, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "approval",
                requestId: artifacts.request.id,
                requestKind: "file-change",
                decision,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });

            const resolved = yield* Deferred.await(decision).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            if (resolved === "acceptForSession" || resolved === "acceptAlways") {
              allowance.add("file-change");
            }
            return {
              decision: approvalDecisionToLegacyReviewDecision(resolved),
            } satisfies CodexSchema.ApplyPatchApprovalResponse;
          }).pipe(Effect.orDie),
        );

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Effect.gen(function* () {
            const context = yield* awaitActiveTurn(payload.turnId);
            if (context === undefined) {
              return yield* toProtocolError(
                `No active Codex turn context for user input request turn ${payload.turnId}.`,
                payload,
              );
            }

            const artifacts = yield* buildUserInputRequestArtifacts({
              context,
              nativeItemId: payload.itemId,
              nativeRequestId: payload.itemId,
              questions: payload.questions,
            });
            const answers = yield* Deferred.make<ProviderUserInputAnswers, never>();
            yield* Ref.update(pendingRuntimeRequests, (current) => {
              const updated = new Map(current);
              updated.set(String(artifacts.request.id), {
                type: "user_input",
                requestId: artifacts.request.id,
                answers,
              });
              return updated;
            });
            yield* emitProviderEvent({
              type: "node.updated",
              driver: CODEX_PROVIDER,
              node: artifacts.node,
            });
            yield* emitProviderEvent({
              type: "turn_item.updated",
              driver: CODEX_PROVIDER,
              turnItem: artifacts.turnItem,
            });
            yield* emitProviderEvent({
              type: "runtime_request.updated",
              driver: CODEX_PROVIDER,
              threadId: artifacts.node.threadId,
              runtimeRequest: artifacts.request,
            });

            const resolved = yield* Deferred.await(answers).pipe(
              Effect.ensuring(
                Ref.update(pendingRuntimeRequests, (current) => {
                  const updated = new Map(current);
                  updated.delete(String(artifacts.request.id));
                  return updated;
                }),
              ),
            );
            return {
              answers: toCodexUserInputAnswers(
                resolved,
                new Set(payload.questions.map((question) => question.id)),
              ),
            } satisfies CodexSchema.ToolRequestUserInputResponse;
          }).pipe(Effect.orDie),
        );

        const makeRootTerminalEvent = Effect.fn("CodexAdapterV2.makeRootTerminalEvent")(
          function* (input: {
            readonly context: ActiveCodexTurnContext;
            readonly status: OrchestrationV2ProviderTurn["status"];
            readonly failureMessage?: string;
            readonly failureCode?: string | null;
            readonly failureClass?: OrchestrationV2ProviderFailureClass;
            readonly providerRetry?: ActiveCodexProviderRetry;
          }): Effect.fn.Return<CodexRootTerminalEvent> {
            const terminalStatus = providerTurnStatusToTerminal(input.status);
            if (terminalStatus === "failed") {
              const previousFailure = input.context.latestProviderFailure ?? input.providerRetry;
              const baseFailure =
                previousFailure !== undefined &&
                (input.failureMessage === undefined ||
                  input.failureMessage === previousFailure.nativeMessage) &&
                (input.failureCode === undefined ||
                  input.failureCode === previousFailure.failure.code)
                  ? previousFailure.failure
                  : makeProviderFailure({
                      message: input.failureMessage,
                      code: input.failureCode,
                      class:
                        input.failureCode === "usageLimitExceeded" ||
                        input.failureCode === "rateLimitExceeded"
                          ? "usage_limit"
                          : "provider_error",
                    });
              const permanentClass =
                providerAccountFailureReason(baseFailure.class) !== undefined
                  ? baseFailure.class
                  : (input.failureClass ??
                    (baseFailure.class === "usage_limit" ||
                    baseFailure.class === "permission_error" ||
                    baseFailure.class === "validation_error"
                      ? baseFailure.class
                      : undefined));
              const failure =
                baseFailure.code === "cyberPolicy"
                  ? makeProviderFailure({
                      class: "validation_error",
                      code: baseFailure.code,
                      message: "Codex stopped this request under its safety policy.",
                      retryable: false,
                    })
                  : permanentClass !== undefined
                    ? { ...baseFailure, class: permanentClass, retryable: false }
                    : isCodexCapacityFailure(
                          baseFailure.code,
                          input.failureMessage ?? baseFailure.message,
                        )
                      ? makeProviderFailure({
                          class: baseFailure.class,
                          code: baseFailure.code,
                          retryable: true,
                          message: `The task is incomplete; retry it or choose another current model. ${baseFailure.message}`,
                        })
                      : baseFailure;
              return {
                type: "turn.terminal",
                driver: CODEX_PROVIDER,
                providerThreadId: input.context.providerThread.id,
                providerTurnId: input.context.providerTurnId,
                runOrdinal: input.context.input.runOrdinal,
                failureItemOrdinal: yield* resolveItemOrdinal(
                  input.context,
                  `terminal-failure:${input.context.providerTurnId}`,
                ),
                status: terminalStatus,
                failure:
                  failure.class === "usage_limit"
                    ? {
                        ...failure,
                        // A proxy such as CLIProxyAPI strips the snapshot; Codex's text still names the reset.
                        resetAt:
                          codexUsageLimitResetAt(yield* Ref.get(rateLimitSnapshot)) ??
                          codexMessageResetAt(failure.message, yield* DateTime.now, codexZone),
                      }
                    : failure,
                ...(input.providerRetry === undefined
                  ? {}
                  : {
                      retry: input.providerRetry.retry,
                      retryStartedAt: input.providerRetry.startedAt,
                    }),
                threadDisposition: "reusable",
              };
            }
            return {
              type: "turn.terminal",
              driver: CODEX_PROVIDER,
              providerThreadId: input.context.providerThread.id,
              providerTurnId: input.context.providerTurnId,
              runOrdinal: input.context.input.runOrdinal,
              status: terminalStatus,
              failure: null,
              threadDisposition: "reusable",
            };
          },
        );

        const emitRootTerminal = Effect.fnUntraced(function* (
          context: ActiveCodexTurnContext,
          event: CodexRootTerminalEvent,
        ) {
          const current =
            event.status === "failed" && event.failure.class === "usage_limit"
              ? {
                  ...event,
                  failure: {
                    ...event.failure,
                    resetAt:
                      event.failure.resetAt ??
                      codexUsageLimitResetAt(yield* Ref.get(rateLimitSnapshot)),
                  },
                }
              : event;
          yield* emitProviderEvent(current);
          for (const turn of goalRuns.get(context.providerTurnId) ?? []) {
            goalRuns.delete(turn.providerTurnId);
          }
          // Later goal updates must not mark the settled thread active again.
          const nativeThreadId = context.providerThread.nativeThreadRef?.nativeId;
          const rootProviderThread =
            nativeThreadId == null ? undefined : rootProviderThreads.get(nativeThreadId);
          if (nativeThreadId != null && rootProviderThread !== undefined) {
            rootProviderThreads.set(nativeThreadId, { ...rootProviderThread, status: "idle" });
          }
          if (current.status === "failed" && current.failure.class === "usage_limit") {
            const item = makeProviderFailureTurnItem({
              driver: CODEX_PROVIDER,
              threadId: context.input.threadId,
              runId: context.input.runId,
              nodeId: context.input.rootNodeId,
              providerThreadId: current.providerThreadId,
              providerTurnId: current.providerTurnId,
              itemOrdinal: current.failureItemOrdinal,
              failure: current.failure,
              occurredAt: yield* DateTime.now,
            });
            yield* Ref.update(limitedTurnItems, (items) =>
              new Map(items).set(context.providerThread.id, item),
            );
          }
        });

        const emitOrDeferRootTerminal = Effect.fn("CodexAdapterV2.emitOrDeferRootTerminal")(
          function* (input: {
            readonly context: ActiveCodexTurnContext;
            readonly nativeTurnId: string;
            readonly status: OrchestrationV2ProviderTurn["status"];
            readonly failureMessage?: string;
            readonly failureCode?: string | null;
            readonly failureClass?: OrchestrationV2ProviderFailureClass;
            readonly providerRetry?: ActiveCodexProviderRetry;
            readonly goalHoldTurn?: OrchestrationV2ProviderTurn;
          }) {
            const event = yield* makeRootTerminalEvent(input);
            const hasActiveDescendants = Array.from((yield* Ref.get(activeTurns)).values()).some(
              (candidate) => isDescendantCodexTurn(candidate, input.context),
            );
            if (event.status !== "completed" && hasActiveDescendants) {
              yield* Ref.update(deferredRootTerminals, (current) => {
                const updated = new Map(current);
                updated.set(input.nativeTurnId, { context: input.context, event });
                return updated;
              });
              return;
            }
            const nativeThreadId = input.context.providerThread.nativeThreadRef?.nativeId;
            if (
              input.goalHoldTurn !== undefined &&
              event.status === "completed" &&
              nativeThreadId != null
            ) {
              goalHolds.set(nativeThreadId, {
                context: input.context,
                event,
                completedTurn: input.goalHoldTurn,
                next: yield* Deferred.make<ActiveCodexTurnContext | undefined>(),
              });
              yield* Effect.sleep(CODEX_GOAL_CONTINUATION_GRACE).pipe(
                Effect.andThen(
                  turnTerminalizationPermit.withPermits(1)(releaseGoalHold(nativeThreadId, event)),
                ),
                Effect.forkIn(scope),
              );
              return;
            }
            yield* emitRootTerminal(input.context, event);
          },
        );

        /**
         * Settles a held goal run with its last turn. Call with the
         * terminalization permit, after removing the hold from `goalHolds`.
         */
        const settleGoalHold = Effect.fnUntraced(function* (
          hold: CodexGoalHold,
          status: "completed" | "interrupted",
        ) {
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver: CODEX_PROVIDER,
            threadId: hold.context.projectionThreadId,
            providerTurn: hold.completedTurn,
          });
          yield* emitRootTerminal(hold.context, { ...hold.event, status });
          yield* Deferred.succeed(hold.next, undefined);
        });

        /** Settles a held goal run unless Stop owns it or a newer hold replaced it. */
        const releaseGoalHold = Effect.fnUntraced(function* (
          nativeThreadId: string,
          expected?: CodexRootTerminalEvent,
        ) {
          const hold = goalHolds.get(nativeThreadId);
          if (hold === undefined || goalStops.has(nativeThreadId)) return;
          if (expected !== undefined && hold.event !== expected) return;
          goalHolds.delete(nativeThreadId);
          yield* settleGoalHold(hold, "completed");
        });

        const flushReadyRootTerminals = Effect.fn("CodexAdapterV2.flushReadyRootTerminals")(
          function* () {
            const activeTurnContexts = Array.from((yield* Ref.get(activeTurns)).values());
            const readyEvents = yield* Ref.modify(deferredRootTerminals, (current) => {
              const updated = new Map(current);
              const ready: Array<{
                context: ActiveCodexTurnContext;
                event: CodexRootTerminalEvent;
              }> = [];
              for (const [nativeTurnId, deferred] of current) {
                if (
                  !activeTurnContexts.some((candidate) =>
                    isDescendantCodexTurn(candidate, deferred.context),
                  )
                ) {
                  updated.delete(nativeTurnId);
                  ready.push(deferred);
                }
              }
              return [ready, updated] as const;
            });
            for (const ready of readyEvents) {
              yield* emitRootTerminal(ready.context, ready.event);
            }
          },
        );

        const finalizeCodexTurn = (input: {
          readonly context: ActiveCodexTurnContext;
          readonly nativeTurnId: string;
          readonly status: OrchestrationV2ProviderTurn["status"];
          readonly completedAt: DateTime.Utc;
          readonly failureMessage?: string;
          readonly failureCode?: string | null;
          readonly failureClass?: OrchestrationV2ProviderFailureClass;
        }) =>
          turnTerminalizationPermit.withPermits(1)(
            Effect.gen(function* () {
              const current = (yield* Ref.get(activeTurns)).get(input.nativeTurnId);
              if (current !== input.context) {
                return false;
              }
              const providerRetry = yield* Ref.modify(providerRetries, (current) => {
                const retry = current.get(input.context.providerTurnId);
                if (retry === undefined) {
                  return [undefined, current] as const;
                }
                const updated = new Map(current);
                updated.delete(input.context.providerTurnId);
                return [retry, updated] as const;
              });
              if (
                providerRetry !== undefined &&
                (input.status !== "failed" || input.context.subagent !== null)
              ) {
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  driver: CODEX_PROVIDER,
                  turnItem: makeProviderRetryTurnItem({
                    driver: CODEX_PROVIDER,
                    threadId: input.context.projectionThreadId,
                    runId: input.context.projectionRunId,
                    nodeId: input.context.providerNodeId,
                    providerThreadId: input.context.providerThread.id,
                    providerTurnId: input.context.providerTurnId,
                    itemOrdinal: providerRetry.itemOrdinal,
                    failure: providerRetry.failure,
                    retry: providerRetry.retry,
                    status: providerTurnStatusToTerminal(input.status),
                    startedAt: providerRetry.startedAt,
                    updatedAt: input.completedAt,
                  }),
                });
              }
              if (input.status !== "completed") {
                yield* Ref.update(terminalizedNonCompletedNativeTurns, (current) => {
                  const updated = new Set(current);
                  updated.add(input.nativeTurnId);
                  return updated;
                });
              }
              yield* agentMessageDeltas.flushTurn(input.nativeTurnId);
              yield* reasoningDeltas.flushTurn(input.nativeTurnId);
              yield* planDeltas.flushTurn(input.nativeTurnId);
              for (const [key, part] of reasoningParts) {
                if (part.turnId === input.nativeTurnId) reasoningParts.delete(key);
              }
              const nativeThreadId = input.context.providerThread.nativeThreadRef?.nativeId;
              // Codex continues an active goal with another turn, so the run stays
              // open and this turn reads as running until that turn starts.
              const activation =
                nativeThreadId == null ? undefined : goalActivations.get(nativeThreadId);
              const holdsForGoal =
                input.context.subagent === null &&
                input.status === "completed" &&
                nativeThreadId != null &&
                (goalsByNativeThread.get(nativeThreadId)?.status === "active" ||
                  (activation !== undefined && !activation.stopped));
              const completedTurn: OrchestrationV2ProviderTurn = {
                id: input.context.providerTurnId,
                providerThreadId: input.context.providerThread.id,
                nodeId: input.context.providerNodeId,
                runAttemptId:
                  input.context.subagent === null ? input.context.input.attemptId : null,
                nativeTurnRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: input.nativeTurnId,
                  strength: "strong",
                },
                ordinal: input.context.providerTurnOrdinal,
                status: input.status,
                startedAt: input.context.startedAt,
                completedAt: input.completedAt,
                ...codexGenerationField(input.context),
                turnTokenUsage: completeCodexTurnTokenUsage(
                  usageStateForThread(
                    input.context.providerThread.nativeThreadRef?.nativeId ??
                      String(input.context.providerThread.id),
                  ),
                  input.nativeTurnId,
                  input.status === "completed",
                ),
              };
              if (!holdsForGoal) {
                yield* emitProviderEvent({
                  type: "provider_turn.updated",
                  driver: CODEX_PROVIDER,
                  threadId: input.context.projectionThreadId,
                  providerTurn: completedTurn,
                });
              }
              if (input.context.subagent !== null) {
                yield* emitProviderEvent({
                  type: "node.updated",
                  driver: CODEX_PROVIDER,
                  node: {
                    id: input.context.providerNodeId,
                    threadId: input.context.projectionThreadId,
                    runId: null,
                    parentNodeId: null,
                    rootNodeId: input.context.rootNodeId,
                    kind: "root_turn",
                    status: input.status,
                    countsForRun: false,
                    providerThreadId: input.context.providerThread.id,
                    providerTurnId: input.context.providerTurnId,
                    nativeItemRef: input.context.subagent.task.nativeTaskRef,
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt: input.context.providerNodeStartedAt,
                    completedAt: input.completedAt,
                  },
                });
                yield* emitProviderEvent({
                  type: "provider_thread.updated",
                  driver: CODEX_PROVIDER,
                  providerThread: {
                    ...input.context.providerThread,
                    status: "idle",
                    updatedAt: input.completedAt,
                  },
                });
                yield* emitProviderEvent({
                  type: "node.updated",
                  driver: CODEX_PROVIDER,
                  node: {
                    id: input.context.subagent.subagentNodeId,
                    threadId: input.context.subagent.parentContext.projectionThreadId,
                    runId: input.context.subagent.parentContext.projectionRunId,
                    parentNodeId: input.context.subagent.parentContext.itemParentNodeId,
                    rootNodeId: input.context.subagent.parentContext.rootNodeId,
                    kind: "subagent",
                    status: input.status,
                    countsForRun: false,
                    providerThreadId: input.context.providerThread.id,
                    providerTurnId: input.context.subagent.parentContext.providerTurnId,
                    nativeItemRef: input.context.subagent.task.nativeTaskRef,
                    runtimeRequestId: null,
                    checkpointScopeId: null,
                    startedAt: input.context.subagent.startedAt,
                    completedAt: input.completedAt,
                  },
                });
                yield* emitSubagentTaskUpdate({
                  subagent: input.context.subagent,
                  status: input.status,
                  completedAt: input.completedAt,
                });
                const parent = input.context.subagent.parentContext;
                if (
                  continuationRequests !== undefined &&
                  parent.subagent === null &&
                  (input.status === "completed" || input.status === "failed") &&
                  !(yield* Ref.get(terminalizedNonCompletedNativeTurns)).has(parent.nativeTurnId) &&
                  ![...(yield* Ref.get(activeTurns)).values()].some(
                    (active) =>
                      active.subagent === null &&
                      active.providerThread.id === parent.providerThread.id,
                  )
                ) {
                  const task = input.context.subagent.task;
                  yield* continuationRequests.offer({
                    threadId: parent.projectionThreadId,
                    providerThreadId: parent.providerThread.id,
                    driver: CODEX_PROVIDER,
                    detail: codexNativeSubagentDetail(task),
                    delivery: "message_text",
                    notification: backgroundWorkNotification([
                      {
                        kind: "subagent",
                        label: codexNativeSubagentLabel(task),
                        outcome: input.status,
                        childThreadId: input.context.subagent.childThreadId,
                      },
                    ]),
                  });
                }
              }
              if (input.status === "interrupted" || input.status === "failed") {
                yield* terminalizeRunningCommandItems(
                  input.context,
                  input.nativeTurnId,
                  input.status,
                  input.completedAt,
                );
                yield* terminalizeMcpAppCaptures(input.context, input.nativeTurnId);
              }
              const dynamicToolStatus: "cancelled" | "interrupted" | "failed" =
                input.status === "interrupted" || input.status === "failed"
                  ? input.status
                  : "cancelled";
              const sleeps = runningSleepsByTurn.get(input.nativeTurnId);
              runningSleepsByTurn.delete(input.nativeTurnId);
              for (const [itemId, durationMs] of sleeps ?? []) {
                yield* emitSleepItem(input.context, itemId, durationMs, dynamicToolStatus);
              }
              const images = runningImagesByTurn.get(input.nativeTurnId);
              runningImagesByTurn.delete(input.nativeTurnId);
              for (const item of images?.values() ?? []) {
                yield* emitImageGeneration(input.context, item, dynamicToolStatus);
              }
              // A completed turn does not establish whether an unfinished search succeeded.
              const searches = runningWebSearchesByTurn.get(input.nativeTurnId);
              runningWebSearchesByTurn.delete(input.nativeTurnId);
              for (const item of searches?.values() ?? []) {
                const artifacts = yield* buildWebSearchArtifacts({
                  context: input.context,
                  item,
                  status: dynamicToolStatus,
                  updatedAt: input.completedAt,
                });
                yield* emitProviderEvent({
                  type: "node.updated",
                  driver: CODEX_PROVIDER,
                  node: artifacts.node,
                });
                yield* emitProviderEvent({
                  type: "turn_item.updated",
                  driver: CODEX_PROVIDER,
                  turnItem: artifacts.turnItem,
                });
              }
              yield* terminalizeRunningDynamicTools(
                input.context,
                input.nativeTurnId,
                dynamicToolStatus,
                input.completedAt,
                input.status === "interrupted" || input.status === "failed",
              );
              if (input.context.subagent === null) {
                yield* emitOrDeferRootTerminal({
                  ...input,
                  ...(providerRetry === undefined ? {} : { providerRetry }),
                  ...(holdsForGoal ? { goalHoldTurn: completedTurn } : {}),
                });
              }
              const waiter = (yield* Ref.get(turnWaiters)).get(input.nativeTurnId);
              if (waiter !== undefined) {
                yield* Deferred.succeed(waiter, undefined);
              }
              const interruptInProgress = (yield* Ref.get(interruptingNativeTurns)).has(
                input.nativeTurnId,
              );
              // Completed turns can retain late background command context and
              // leftover persistent dynamic tools. Interrupted and failed turns
              // never wake from late item events.
              const retainSettledContext =
                input.status === "completed" &&
                (yield* turnHasRetainedBackgroundWork(input.nativeTurnId));
              if (retainSettledContext) {
                yield* Ref.update(settledTurns, (current) => {
                  const updated = new Map(current);
                  updated.set(input.nativeTurnId, input.context);
                  return updated;
                });
                // Background work that finished between the check above and
                // the turn being recorded as settled saw no settled turn to
                // release, so it is re-checked once recorded.
                yield* releaseSettledTurnIfIdle(input.nativeTurnId);
              }
              yield* Ref.update(activeTurns, (current) => {
                const updated = new Map(current);
                updated.delete(input.nativeTurnId);
                return updated;
              });
              if (input.context.nativeStartReady !== undefined) {
                yield* Deferred.succeed(input.context.nativeStartReady, undefined);
              }
              yield* flushReadyRootTerminals();
              if (!retainSettledContext && !interruptInProgress) {
                yield* Ref.update(runningCommandItemsByTurn, (current) => {
                  if (!current.has(input.nativeTurnId)) {
                    return current;
                  }
                  const updated = new Map(current);
                  updated.delete(input.nativeTurnId);
                  return updated;
                });
                yield* Ref.update(runningDynamicToolsByTurn, (current) => {
                  if (!current.has(input.nativeTurnId)) {
                    return current;
                  }
                  const updated = new Map(current);
                  updated.delete(input.nativeTurnId);
                  return updated;
                });
              }
              if (!retainSettledContext) {
                yield* Ref.update(completedFinalAnswerTextsByTurn, (current) => {
                  if (!current.has(input.nativeTurnId)) {
                    return current;
                  }
                  const updated = new Map(current);
                  updated.delete(input.nativeTurnId);
                  return updated;
                });
                yield* Ref.update(finalAnswerItemIdsByTurn, (current) => {
                  if (!current.has(input.nativeTurnId)) {
                    return current;
                  }
                  const updated = new Map(current);
                  updated.delete(input.nativeTurnId);
                  return updated;
                });
              }
              return true;
            }),
          );

        yield* client.handleServerNotification("turn/completed", (payload) =>
          Effect.gen(function* () {
            if (threadsAwaitingContextRestore.delete(payload.threadId))
              // The notification callback runs on the input reader. Let it read
              // the injection response while the session-scoped request waits.
              yield* restoreAdditionalContext(payload.threadId).pipe(
                Effect.forkIn(scope, { startImmediately: true }),
              );
            const context = (yield* Ref.get(activeTurns)).get(payload.turn.id);
            if (context === undefined) {
              return;
            }
            const nativeStatus = mapCodexTurnStatus(payload.turn.status);
            const status =
              nativeStatus === "completed" &&
              (yield* Ref.get(interruptingNativeTurns)).has(payload.turn.id)
                ? "interrupted"
                : nativeStatus;
            const error = payload.turn.error;
            const failureInfo =
              error == null ? undefined : codexFailureInfo(error.codexErrorInfo, error.message);
            yield* finalizeCodexTurn({
              context,
              nativeTurnId: payload.turn.id,
              status,
              completedAt: codexTimestamp(payload.turn.completedAt),
              ...(error == null || failureInfo === undefined
                ? {}
                : {
                    failureMessage: error.message,
                    ...(error.codexErrorInfo == null ? {} : { failureCode: failureInfo.code }),
                    ...(failureInfo.failureClass === undefined
                      ? {}
                      : { failureClass: failureInfo.failureClass }),
                  }),
            });
          }),
        );

        /**
         * Settles a `/goal` run that started no Codex turn. Its reply is plain
         * assistant text, as Claude's own `/goal` output is.
         */
        const completeGoalCommandTurn = Effect.fnUntraced(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          reply: string,
        ) {
          const now = yield* DateTime.now;
          const nativeId = `goal-command:${turnInput.attemptId}`;
          const context: ActiveCodexTurnContext = {
            input: turnInput,
            projectionAppThread: turnInput.appThread,
            projectionThreadId: turnInput.threadId,
            projectionRunId: turnInput.runId,
            nativeTurnId: nativeId,
            providerThread: turnInput.providerThread,
            providerTurnId: idAllocator.derive.providerTurn({
              driver: CODEX_PROVIDER,
              nativeTurnId: nativeId,
            }),
            providerTurnOrdinal: turnInput.providerTurnOrdinal,
            providerNodeId: turnInput.rootNodeId,
            providerNodeKind: "root_turn",
            providerNodeStartedAt: now,
            itemParentNodeId: turnInput.rootNodeId,
            rootNodeId: turnInput.rootNodeId,
            subagent: null,
            startedAt: now,
            generation: makeCodexGeneration(now),
            itemPositions: new Map(),
          };
          const providerTurn = {
            id: context.providerTurnId,
            providerThreadId: turnInput.providerThread.id,
            nodeId: turnInput.rootNodeId,
            runAttemptId: turnInput.attemptId,
            nativeTurnRef: null,
            ordinal: turnInput.providerTurnOrdinal,
            status: "running",
            startedAt: now,
            completedAt: null,
          } satisfies OrchestrationV2ProviderTurn;
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver: CODEX_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn,
          });
          yield* rememberRootProviderThread(turnInput.providerThread);
          const artifacts = yield* buildAgentMessageArtifacts(
            context,
            { id: nativeId, text: reply },
            true,
          );
          yield* emitProviderEvent({
            type: "node.updated",
            driver: CODEX_PROVIDER,
            node: artifacts.node,
          });
          yield* emitProviderEvent({
            type: "message.updated",
            driver: CODEX_PROVIDER,
            message: artifacts.message,
          });
          yield* emitProviderEvent({
            type: "turn_item.updated",
            driver: CODEX_PROVIDER,
            turnItem: artifacts.turnItem,
          });
          yield* emitProviderEvent({
            type: "provider_turn.updated",
            driver: CODEX_PROVIDER,
            threadId: turnInput.threadId,
            providerTurn: { ...providerTurn, status: "completed", completedAt: now },
          });
          yield* emitRootTerminal(context, {
            type: "turn.terminal",
            driver: CODEX_PROVIDER,
            providerThreadId: turnInput.providerThread.id,
            providerTurnId: context.providerTurnId,
            runOrdinal: turnInput.runOrdinal,
            status: "completed",
            failure: null,
            threadDisposition: "reusable",
          });
        });

        /** The goal hold whose run still reports this provider turn as running. */
        const heldGoalTurn = (
          providerThread: OrchestrationV2ProviderThread,
          providerTurnId: ProviderTurnId,
        ) => {
          const nativeThreadId = providerThread.nativeThreadRef?.nativeId;
          const hold = nativeThreadId == null ? undefined : goalHolds.get(nativeThreadId);
          return hold?.context.providerTurnId === providerTurnId && nativeThreadId != null
            ? { nativeThreadId, hold }
            : undefined;
        };

        /**
         * Like the Codex TUI, Stop pauses an active goal first so Codex starts
         * no further goal turn. Codex can end or continue the turn while the
         * pause is in flight, so the target resolves after it: a held run
         * settles here and leaves only its retained work to stop, and a
         * continued run moves Stop to its newest turn. `goalTurns` lists the
         * run's root turns, seen before and after the pause, whose descendants
         * Stop also reaches.
         */
        const resolveGoalStopTarget = Effect.fnUntraced(function* (
          turnInput: ProviderAdapter.ProviderAdapterV2InterruptInput,
        ) {
          const goalThreadId = turnInput.providerThread.nativeThreadRef?.nativeId;
          if (goalThreadId == null) {
            return { turnInput, goalTurns: [] as ReadonlyArray<ActiveCodexTurnContext> };
          }
          goalStops.set(goalThreadId, (goalStops.get(goalThreadId) ?? 0) + 1);
          return yield* Effect.gen(function* () {
            // The run can settle while the pause is in flight, which drops its record.
            const requestedTurnId = latestGoalTurnId(turnInput.providerTurnId);
            const heldBefore = goalHolds.get(goalThreadId)?.context;
            const turnsBefore = [
              ...(goalRuns.get(requestedTurnId) ?? []),
              ...Array.from((yield* Ref.get(activeTurns)).values()).filter(
                (context) => context.providerTurnId === requestedTurnId,
              ),
              ...(heldBefore?.providerTurnId === requestedTurnId ? [heldBefore] : []),
            ];
            const activation = goalActivations.get(goalThreadId);
            if (activation !== undefined) activation.stopped = true;
            if (goalsByNativeThread.get(goalThreadId)?.status === "active") {
              yield* client
                .request("thread/goal/set", { threadId: goalThreadId, status: "paused" })
                .pipe(
                  Effect.timeout("10 seconds"),
                  Effect.tap(({ goal }) =>
                    Effect.sync(() =>
                      goalsByNativeThread.set(goalThreadId, providerGoalFromCodex(goal)),
                    ),
                  ),
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration-v2.codex-goal-pause-failed", { cause }),
                  ),
                );
            }
            return yield* turnTerminalizationPermit.withPermits(1)(
              Effect.gen(function* () {
                const providerTurnId = latestGoalTurnId(turnInput.providerTurnId);
                const hold = goalHolds.get(goalThreadId);
                const held = hold !== undefined && hold.context.providerTurnId === providerTurnId;
                const goalTurns: ReadonlyArray<ActiveCodexTurnContext> = Array.from(
                  new Set([
                    ...turnsBefore,
                    ...(goalRuns.get(providerTurnId) ?? []),
                    ...(held ? [hold.context] : []),
                  ]),
                );
                if (!held) return { turnInput: { ...turnInput, providerTurnId }, goalTurns };
                goalHolds.delete(goalThreadId);
                yield* settleGoalHold(hold, "interrupted");
                return {
                  turnInput: { ...turnInput, providerTurnId, requestRuntimeRestart: true },
                  goalTurns,
                };
              }),
            );
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                const stops = (goalStops.get(goalThreadId) ?? 1) - 1;
                if (stops > 0) goalStops.set(goalThreadId, stops);
                else goalStops.delete(goalThreadId);
              }),
            ),
          );
        });

        /** Starts a native turn with this run's full turn configuration. */
        const startNativeTurn = (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          codexInput: ReadonlyArray<CodexSchema.V2TurnStartParams__UserInput>,
        ) =>
          Effect.gen(function* () {
            const threadId = yield* getNativeThreadId(turnInput.providerThread);
            const mcpSession = yield* mcpSessions.read(turnInput.threadId);
            const turnStartParams = yield* buildCodexTurnStartParams({
              isSubagent: turnInput.appThread.lineage.relationshipToParent === "subagent",
              nativeThreadId: threadId,
              chatTempDir: yield* ScopedCache.get(chatTempDirs, turnInput.threadId),
              codexInput,
              runtimePolicy: turnInput.runtimePolicy,
              modelSelection: turnInput.modelSelection,
              hasT3Mcp: mcpSession !== undefined,
              configuredReasoningEffort: needsCodexConfiguredEffort(
                turnInput.modelSelection,
                turnInput.runtimePolicy.interactionMode,
                mcpSession !== undefined,
              )
                ? yield* Cache.get(configuredReasoningEffort, turnInput.runtimePolicy.cwd)
                : undefined,
              browserToolsAvailable: mcpSession?.browserToolsAvailable ?? true,
              deviceToolsAvailable: mcpSession?.capabilities?.has("device") ?? false,
              toolDiscoveryCatalog: yield* (
                mcpSession?.toolDiscoveryCatalog ?? Effect.succeed(undefined)
              ),
              hostBrowser: yield* hostBrowser,
              omitServiceTier: adapterOptions.resolveRuntime !== undefined,
              ...(turnInput.appContext === undefined ? {} : { appContext: turnInput.appContext }),
              threadId: turnInput.threadId,
            });
            yield* Ref.update(pendingRootTurns, (current) => {
              const updated = new Map(current);
              updated.set(threadId, turnInput);
              return updated;
            });
            yield* Ref.update(additionalContextByThread, (current) => {
              const next = new Map(current);
              if (turnStartParams.additionalContext)
                next.set(threadId, turnStartParams.additionalContext);
              else next.delete(threadId);
              return next;
            });
            // Completion can remove the old context while turn/start is in flight.
            const previousTurns = new Map([
              ...(yield* Ref.get(settledTurns)),
              ...(yield* Ref.get(activeTurns)),
            ]);
            const { additionalContext, ...paramsWithoutContext } = turnStartParams;
            const contextDigest =
              additionalContext === undefined
                ? undefined
                : yield* digestAdditionalContext(additionalContext);
            const deliveredDigest = deliveredContextDigests.has(threadId)
              ? deliveredContextDigests.get(threadId)
              : turnInput.providerThread.nativeMetadata?.codexAdditionalContextDigest;
            const started = yield* client
              .request(
                "turn/start",
                contextDigest !== undefined && contextDigest === deliveredDigest
                  ? paramsWithoutContext
                  : turnStartParams,
              )
              .pipe(withAppServerDeadline("turn/start"));
            const previousTurn =
              previousTurns.get(started.turn.id) ??
              (yield* Ref.get(activeTurns)).get(started.turn.id);
            if (
              previousTurn !== undefined &&
              previousTurn.input.attemptId !== turnInput.attemptId
            ) {
              return yield* new ProviderAdapter.ProviderAdapterProtocolError({
                driver: CODEX_PROVIDER,
                detail:
                  "Codex returned a turn belonging to an earlier run. Stop the existing turn before retrying this message.",
              });
            }
            rootProviderThreads.set(
              threadId,
              withCurrentContextDigest(threadId, turnInput.providerThread),
            );
            if (contextDigest !== undefined && contextDigest !== deliveredDigest)
              yield* recordAdditionalContextDigest(threadId, contextDigest);
            const providerThread = rootProviderThreads.get(threadId) ?? turnInput.providerThread;
            yield* registerRootTurn({
              turnInput: { ...turnInput, providerThread },
              nativeTurnId: started.turn.id,
              startedAt: codexTimestamp(started.turn.startedAt),
              waitForNativeStart: started.turn.startedAt === null,
            });
          }).pipe(
            Effect.ensuring(
              Effect.flatMap(getNativeThreadId(turnInput.providerThread), (threadId) =>
                Ref.update(pendingRootTurns, (current) => {
                  const updated = new Map(current);
                  updated.delete(threadId);
                  return updated;
                }),
              ).pipe(Effect.ignore),
            ),
          );

        /**
         * Runs `/goal` through Codex's native goal API, as the Codex TUI does.
         * Setting or resuming a goal starts the first goal turn with this run's
         * turn configuration (approvals, sandbox, model, plan mode), since a
         * turn Codex starts on its own reuses the last turn's settings. Codex
         * continues later goal turns itself. Other commands settle with a reply.
         */
        const runGoalCommand = (
          turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
          command: CodexGoalCommand,
        ) =>
          Effect.gen(function* () {
            const threadId = yield* getNativeThreadId(turnInput.providerThread);
            // Goal notifications during the command belong to this run's snapshot.
            rootProviderThreads.set(
              threadId,
              withCurrentContextDigest(threadId, turnInput.providerThread),
            );
            const readGoal = client
              .request("thread/goal/get", { threadId })
              .pipe(
                Effect.map((response) =>
                  response.goal == null ? null : providerGoalFromCodex(response.goal),
                ),
              );
            const current = yield* readGoal;
            goalsByNativeThread.set(threadId, current);
            if (command.type === "show") {
              return yield* completeGoalCommandTurn(
                turnInput,
                current === null ? "No goal is set." : describeCodexGoal(current),
              );
            }
            if (command.type === "clear") {
              const { cleared } = yield* client.request("thread/goal/clear", { threadId });
              goalsByNativeThread.set(threadId, null);
              return yield* completeGoalCommandTurn(
                turnInput,
                cleared ? "Goal cleared." : "No goal to clear.",
              );
            }
            if (current === null && command.type !== "set") {
              return yield* completeGoalCommandTurn(turnInput, "No goal is set.");
            }
            if (command.type === "pause") {
              const { goal } = yield* client.request("thread/goal/set", {
                threadId,
                status: "paused",
              });
              goalsByNativeThread.set(threadId, providerGoalFromCodex(goal));
              return yield* completeGoalCommandTurn(
                turnInput,
                "Goal paused. Send /goal resume to continue.",
              );
            }
            if (command.type === "set") {
              // A new objective replaces the goal and its accounting, like the TUI.
              if (current !== null) yield* client.request("thread/goal/clear", { threadId });
              // Paused until our turn runs, so Codex does not start one first.
              const { goal } = yield* client.request("thread/goal/set", {
                threadId,
                objective: command.objective,
                status: "paused",
              });
              goalsByNativeThread.set(threadId, providerGoalFromCodex(goal));
            }
            // Until the goal is active, a fast first turn still holds the run,
            // and Stop cancels the activation.
            const activation = { stopped: false };
            goalActivations.set(threadId, activation);
            yield* Effect.gen(function* () {
              // The first goal turn carries the objective; a resume continues from history.
              yield* startNativeTurn(
                turnInput,
                command.type === "set"
                  ? yield* toCodexInput({
                      ...turnInput,
                      message: { ...turnInput.message, text: command.objective },
                    })
                  : [],
              );
              if (activation.stopped) return;
              const { goal } = yield* client.request("thread/goal/set", {
                threadId,
                status: "active",
              });
              goalsByNativeThread.set(threadId, providerGoalFromCodex(goal));
              if (activation.stopped) {
                const paused = yield* client.request("thread/goal/set", {
                  threadId,
                  status: "paused",
                });
                goalsByNativeThread.set(threadId, providerGoalFromCodex(paused.goal));
              }
            }).pipe(
              Effect.ensuring(
                turnTerminalizationPermit.withPermits(1)(
                  Effect.gen(function* () {
                    if (goalActivations.get(threadId) === activation) {
                      goalActivations.delete(threadId);
                    }
                    // A run held for an activation that did not happen settles now.
                    if (goalsByNativeThread.get(threadId)?.status !== "active") {
                      yield* releaseGoalHold(threadId);
                    }
                  }),
                ),
              ),
            );
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: CODEX_PROVIDER,
                  threadId: turnInput.threadId,
                  providerThreadId: turnInput.providerThread.id,
                  runId: turnInput.runId,
                  cause,
                }),
            ),
          );

        // MCP Apps reach their server through Codex's own MCP client, so any
        // server the user configured for Codex works without T3 connecting to it.
        const mcpAppsError = (detail: string) => (cause: unknown) =>
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: CODEX_PROVIDER,
            detail,
            payload: cause,
          });
        const mcpApps: ProviderAdapter.ProviderAdapterV2McpApps = {
          listTools: (toolsInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(toolsInput.providerThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  client.request("mcpServerStatus/list", {
                    threadId,
                    serverName: toolsInput.server,
                    detail: "toolsAndAuthOnly",
                  }),
                ),
              );
              const server = response.data.find((entry) => entry.name === toolsInput.server);
              return Object.values(server?.tools ?? {});
            }).pipe(Effect.mapError(mcpAppsError("Failed to list Codex MCP tools."))),
          callTool: (callInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(callInput.providerThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  client.request("mcpServer/tool/call", {
                    threadId,
                    server: callInput.server,
                    tool: callInput.tool,
                    arguments: callInput.arguments as Schema.Json,
                  }),
                ),
              );
              return {
                content: response.content,
                ...(response.structuredContent === undefined
                  ? {}
                  : { structuredContent: response.structuredContent }),
                ...(response.isError === true ? { isError: true } : {}),
                ...(response._meta === undefined ? {} : { _meta: response._meta }),
              };
            }).pipe(Effect.mapError(mcpAppsError("Codex MCP tool call failed."))),
          readResource: (readInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(readInput.providerThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  client.request("mcpServer/resource/read", {
                    threadId,
                    server: readInput.server,
                    uri: readInput.uri,
                  }),
                ),
              );
              return { contents: response.contents };
            }).pipe(Effect.mapError(mcpAppsError("Codex MCP resource read failed."))),
        };

        const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
          instanceId: adapterOptions.instanceId,
          driver: CODEX_PROVIDER,
          providerSessionId: input.providerSessionId,
          providerSession: session,
          events: Stream.fromQueue(events),
          canReuseContextUsage: canReuseCodexContextUsage,
          // Known gap: a subagent that Codex resumes later reads as completed
          // (not pending) between turns, so idle release can win the race
          // against a long-delayed resume. Codex emits no resume-expected
          // signal to pin on.
          hasPendingBackgroundWork: Effect.gen(function* () {
            for (const items of (yield* Ref.get(runningCommandItemsByTurn)).values()) {
              if (items.size > 0) {
                return true;
              }
            }
            for (const items of (yield* Ref.get(runningDynamicToolsByTurn)).values()) {
              if (items.size > 0) {
                return true;
              }
            }
            if ((yield* Ref.get(pendingMcpAppCaptures)).size > 0) {
              return true;
            }
            for (const subagent of (yield* Ref.get(subagentThreads)).values()) {
              if (subagent.task.status === "running") {
                return true;
              }
            }
            return false;
          }),
          hasPendingBackgroundWorkForThread: (providerThread) =>
            Effect.gen(function* () {
              const contexts = [
                ...(yield* Ref.get(activeTurns)).values(),
                ...(yield* Ref.get(settledTurns)).values(),
              ];
              const roots = contexts.filter(
                (context) => context.providerThread.id === providerThread.id,
              );
              for (const context of contexts) {
                if (!roots.some((root) => context === root || isDescendantCodexTurn(context, root)))
                  continue;
                if (yield* turnHasRetainedBackgroundWork(context.nativeTurnId)) return true;
                if (
                  context.subagent !== null &&
                  (yield* Ref.get(activeTurns)).has(context.nativeTurnId)
                )
                  return true;
              }
              return false;
            }),
          ensureThread: (threadInput) =>
            ensureInitialized.pipe(
              Effect.andThen(
                threadParams(threadInput.threadId, {
                  modelSelection: threadInput.modelSelection,
                  runtimePolicy: threadInput.runtimePolicy,
                }),
              ),
              Effect.flatMap((params) => client.request("thread/start", params)),
              Effect.map((response): OrchestrationV2ProviderThread =>
                providerThreadFromCodexThread({
                  appThreadId: threadInput.threadId,
                  idAllocator,
                  ownerNodeId: null,
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: adapterOptions.instanceId,
                  thread: response.thread,
                }),
              ),
              withAppServerDeadline("thread/start"),
              Effect.scoped,
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterEnsureThreadError({
                    driver: CODEX_PROVIDER,
                    threadId: threadInput.threadId,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
          resumeThread: (threadInput) =>
            Effect.gen(function* () {
              const nativeThreadId = yield* getNativeThreadId(threadInput.providerThread);
              // excludeTurns is not in the generated request schema yet.
              const resume = client.raw.request("thread/resume", {
                threadId: nativeThreadId,
                excludeTurns: true,
                ...(yield* threadParams(
                  threadInput.threadId ?? threadInput.providerThread.appThreadId,
                  {
                    ...(threadInput.modelSelection === undefined
                      ? {}
                      : { modelSelection: threadInput.modelSelection }),
                    ...(threadInput.runtimePolicy === undefined
                      ? {}
                      : { runtimePolicy: threadInput.runtimePolicy }),
                  },
                )),
              });
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  resume.pipe(
                    Effect.catchTags({
                      CodexAppServerRequestError: (cause) => {
                        if (
                          !/\bsession \S+ is archived\b|\bcodex unarchive\b/i.test(
                            cause.errorMessage,
                          )
                        ) {
                          return Effect.fail(cause);
                        }
                        // Keep the session's history without decoding the unarchive response.
                        return client.raw
                          .request("thread/unarchive", { threadId: nativeThreadId })
                          .pipe(Effect.andThen(resume));
                      },
                    }),
                  ),
                ),
                withAppServerDeadline("thread/resume"),
                Effect.flatMap(decodeCodexResumeMetadata),
              );
              // Codex follows a resume with a goal snapshot notification; the
              // run's first turn writes it if it differs from the stored goal.
              return {
                ...threadInput.providerThread,
                providerSessionId: input.providerSessionId,
                providerInstanceId: adapterOptions.instanceId,
                status: "idle",
                nativeThreadRef: {
                  driver: CODEX_PROVIDER,
                  nativeId: response.thread.id,
                  strength: "strong",
                },
                nativeConversationHeadRef: threadInput.providerThread.nativeConversationHeadRef,
                updatedAt: codexTimestamp(response.thread.updatedAt),
              } satisfies OrchestrationV2ProviderThread;
            }).pipe(
              Effect.scoped,
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterResumeThreadError({
                    driver: CODEX_PROVIDER,
                    providerSessionId: input.providerSessionId,
                    providerThreadId: threadInput.providerThread.id,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
          compactThread: (turnInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(turnInput.providerThread);
              yield* Ref.update(pendingRootTurns, (current) =>
                new Map(current).set(threadId, turnInput),
              );
              rootProviderThreads.set(
                threadId,
                withCurrentContextDigest(threadId, turnInput.providerThread),
              );
              yield* invalidateAdditionalContext(threadId);
              // Cleared on interrupt too, as startTurn does: an interrupted start
              // must not adopt the native turn that a late turn/started reports.
              yield* client.request("thread/compact/start", { threadId }).pipe(
                Effect.onError(() =>
                  Ref.update(pendingRootTurns, (current) => {
                    const next = new Map(current);
                    next.delete(threadId);
                    return next;
                  }),
                ),
              );
            }).pipe(
              withAppServerDeadline("thread/compact/start"),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: CODEX_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            ),
          injectHistory: (input) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(input.providerThread);
              return yield* client
                .request("thread/inject_items", {
                  threadId,
                  items: historyResponseItems(input.messages, input.context),
                })
                .pipe(
                  Effect.as(true),
                  // Older app servers reject unknown methods before mutating history.
                  // Transport errors and invalid payloads are ambiguous and must not
                  // fall through to a second delivery in the current user message.
                  Effect.catchTags({
                    CodexAppServerRequestError: (error) =>
                      error.code === -32601 ? Effect.succeed(false) : Effect.fail(error),
                  }),
                );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: CODEX_PROVIDER,
                    detail: "Failed to inject historical context",
                    cause,
                  }),
              ),
            ),
          startTurn: (turnInput) => {
            const goalCommand =
              turnInput.message.attachments.length === 0 &&
              turnInput.restartContinuationOfRunId === undefined
                ? parseCodexGoalCommand(turnInput.message.text)
                : null;
            if (goalCommand !== null) return runGoalCommand(turnInput, goalCommand);
            return Effect.gen(function* () {
              if (turnInput.appThread.lineage.relationshipToParent === "subagent") {
                subagentNativeThreadIds.add(yield* getNativeThreadId(turnInput.providerThread));
              }
              yield* startNativeTurn(
                turnInput,
                turnInput.restartContinuationOfRunId === undefined
                  ? yield* toCodexInput(turnInput)
                  : [],
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: CODEX_PROVIDER,
                    threadId: turnInput.threadId,
                    providerThreadId: turnInput.providerThread.id,
                    runId: turnInput.runId,
                    cause,
                  }),
              ),
            );
          },
          steerTurn: (turnInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(turnInput.providerThread);
              // Between goal turns, steer the turn Codex continues with.
              const latestTurnId = latestGoalTurnId(turnInput.providerTurnId);
              const held = heldGoalTurn(turnInput.providerThread, latestTurnId);
              const providerTurnId =
                held === undefined
                  ? latestTurnId
                  : ((yield* Deferred.await(held.hold.next))?.providerTurnId ?? latestTurnId);
              const activeTurn = Array.from((yield* Ref.get(activeTurns)).values()).find(
                (candidate) => candidate.providerTurnId === providerTurnId,
              );
              if (activeTurn === undefined) {
                return yield* new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                  driver: CODEX_PROVIDER,
                  providerThreadId: turnInput.providerThread.id,
                });
              }

              const codexInput = yield* toCodexInput(turnInput);
              yield* client.request("turn/steer", {
                expectedTurnId: activeTurn.nativeTurnId,
                input: codexInput,
                threadId,
              });
            }).pipe(
              withAppServerDeadline("turn/steer"),
              Effect.mapError((cause) =>
                cause._tag === "ProviderAdapterSteerRunUnsupportedError"
                  ? cause
                  : new ProviderAdapter.ProviderAdapterSteerRunError({
                      driver: CODEX_PROVIDER,
                      providerThreadId: turnInput.providerThread.id,
                      providerTurnId: turnInput.providerTurnId,
                      cause,
                    }),
              ),
            ),
          // Dropping this connection's subscription lets the shared app-server
          // shut the native thread (and its MCP servers) down once it is idle.
          // `notLoaded` / `notSubscribed` mean there is nothing left to unload.
          unloadThread: (unloadInput) =>
            Effect.gen(function* () {
              const nativeThreadId = yield* getNativeThreadId(unloadInput.providerThread);
              sessionApprovals.delete(nativeThreadId);
              yield* client.request("thread/unsubscribe", { threadId: nativeThreadId });
              yield* ScopedCache.invalidate(chatTempDirs, unloadInput.providerThread.appThreadId);
            }).pipe(
              Effect.mapError((cause) =>
                cause._tag === "ProviderAdapterProtocolError"
                  ? cause
                  : new ProviderAdapter.ProviderAdapterProtocolError({
                      driver: CODEX_PROVIDER,
                      detail: `Failed to unload Codex thread for provider thread ${unloadInput.providerThread.id}`,
                      cause: normalizeCodexCause(cause),
                    }),
              ),
            ),
          interruptTurn: (requestedInput) =>
            Effect.gen(function* () {
              const { turnInput, goalTurns } = yield* resolveGoalStopTarget(requestedInput);
              const [activeTurnContexts, settledTurnContexts] =
                yield* turnTerminalizationPermit.withPermits(1)(
                  Effect.gen(function* () {
                    return [
                      Array.from((yield* Ref.get(activeTurns)).values()),
                      Array.from((yield* Ref.get(settledTurns)).values()),
                    ] as const;
                  }),
                );
              const activeTurn =
                activeTurnContexts.find(
                  (candidate) => candidate.providerTurnId === turnInput.providerTurnId,
                ) ??
                (turnInput.requestRuntimeRestart === true
                  ? settledTurnContexts.find(
                      (candidate) => candidate.providerThread.id === turnInput.providerThread.id,
                    )
                  : undefined);
              // A goal run spans several root turns, and work an earlier one
              // started can outlive it.
              const lineageRoots = Array.from(
                new Set([...(activeTurn === undefined ? [] : [activeTurn]), ...goalTurns]),
              );
              const inLineage = (context: ActiveCodexTurnContext) =>
                lineageRoots.some(
                  (root) => context === root || isDescendantCodexTurn(context, root),
                );
              const interruptTargetContexts = [
                ...(activeTurn === undefined ? [] : [activeTurn]),
                ...activeTurnContexts.filter(
                  (candidate) => candidate !== activeTurn && inLineage(candidate),
                ),
                ...settledTurnContexts.filter(
                  (candidate) =>
                    candidate !== activeTurn &&
                    ((turnInput.requestRuntimeRestart === true &&
                      candidate.providerThread.id === turnInput.providerThread.id) ||
                      inLineage(candidate)),
                ),
              ];
              if (interruptTargetContexts.length === 0) {
                // Stop on a settled turn this process retains nothing for
                // (released, restarted, or every command already reported).
                if (turnInput.requestRuntimeRestart === true) return;
                return yield* toProtocolError(
                  `Provider turn ${turnInput.providerTurnId} is not active and cannot be interrupted.`,
                );
              }
              const interruptTargets: Array<{
                readonly context: ActiveCodexTurnContext;
                readonly completion: Deferred.Deferred<void, never>;
              }> = [];
              for (const context of interruptTargetContexts) {
                interruptTargets.push({ context, completion: yield* Deferred.make<void>() });
              }
              yield* Ref.update(turnWaiters, (current) => {
                const updated = new Map(current);
                for (const target of interruptTargets) {
                  updated.set(target.context.nativeTurnId, target.completion);
                }
                return updated;
              });
              yield* Ref.update(interruptingNativeTurns, (current) => {
                const updated = new Set(current);
                for (const target of interruptTargets) {
                  updated.add(target.context.nativeTurnId);
                }
                return updated;
              });
              const registeredActiveTurns = yield* Ref.get(activeTurns);
              for (const target of interruptTargets) {
                if (registeredActiveTurns.get(target.context.nativeTurnId) !== target.context) {
                  yield* Deferred.succeed(target.completion, undefined);
                }
              }

              const cleanupInterruptState = Effect.gen(function* () {
                yield* Ref.update(turnWaiters, (current) => {
                  const updated = new Map(current);
                  for (const target of interruptTargets) {
                    updated.delete(target.context.nativeTurnId);
                  }
                  return updated;
                });
                yield* Ref.update(interruptingNativeTurns, (current) => {
                  const updated = new Set(current);
                  for (const target of interruptTargets) {
                    updated.delete(target.context.nativeTurnId);
                  }
                  return updated;
                });
                yield* Ref.update(runningCommandItemsByTurn, (current) => {
                  const updated = new Map(current);
                  for (const target of interruptTargets) {
                    if (settledTurnContexts.includes(target.context)) continue;
                    updated.delete(target.context.nativeTurnId);
                  }
                  return updated;
                });
              });

              const trackedInterruptNativeTurnIds = new Set(
                interruptTargets.map((target) => target.context.nativeTurnId),
              );
              const finalizeRemainingInterruptLineage = Effect.gen(function* () {
                while (true) {
                  const newlyDiscovered: Array<ActiveCodexTurnContext> = [];
                  const activeLineage = yield* turnTerminalizationPermit.withPermits(1)(
                    Effect.gen(function* () {
                      const lineage = Array.from((yield* Ref.get(activeTurns)).values()).filter(
                        inLineage,
                      );
                      for (const context of lineage) {
                        if (trackedInterruptNativeTurnIds.has(context.nativeTurnId)) {
                          continue;
                        }
                        const completion = yield* Deferred.make<void>();
                        interruptTargets.push({ context, completion });
                        trackedInterruptNativeTurnIds.add(context.nativeTurnId);
                        newlyDiscovered.push(context);
                        yield* Ref.update(turnWaiters, (current) => {
                          const updated = new Map(current);
                          updated.set(context.nativeTurnId, completion);
                          return updated;
                        });
                        yield* Ref.update(interruptingNativeTurns, (current) => {
                          const updated = new Set(current);
                          updated.add(context.nativeTurnId);
                          return updated;
                        });
                      }
                      return lineage;
                    }),
                  );
                  if (activeLineage.length === 0) {
                    return;
                  }
                  if (newlyDiscovered.length > 0) {
                    const completed = yield* Effect.forEach(
                      newlyDiscovered,
                      (context) =>
                        Effect.flatMap(getNativeThreadId(context.providerThread), (threadId) =>
                          client.request("turn/interrupt", {
                            threadId,
                            turnId: context.nativeTurnId,
                          }),
                        ).pipe(
                          Effect.catch((cause) =>
                            Effect.logWarning(
                              "orchestration-v2.codex-remaining-lineage-interrupt-failed",
                              {
                                nativeTurnId: context.nativeTurnId,
                                providerSessionId: input.providerSessionId,
                                cause,
                              },
                            ),
                          ),
                        ),
                      { concurrency: "unbounded", discard: true },
                    ).pipe(Effect.timeoutOption("10 seconds"));
                    if (Option.isNone(completed)) {
                      yield* Effect.logWarning(
                        "orchestration-v2.codex-remaining-lineage-interrupt-timeout",
                        {
                          nativeTurnIds: newlyDiscovered.map((context) => context.nativeTurnId),
                          providerSessionId: input.providerSessionId,
                        },
                      );
                    }
                  }
                  const completedAt = yield* DateTime.now;
                  for (const context of activeLineage) {
                    yield* finalizeCodexTurn({
                      context,
                      nativeTurnId: context.nativeTurnId,
                      status: "interrupted",
                      completedAt,
                    });
                  }
                }
              });

              const interruptLateDescendants = Effect.gen(function* () {
                const activeLineage = yield* turnTerminalizationPermit.withPermits(1)(
                  Effect.gen(function* () {
                    const lineage = Array.from((yield* Ref.get(activeTurns)).values()).filter(
                      (context) =>
                        !lineageRoots.includes(context) &&
                        inLineage(context) &&
                        !trackedInterruptNativeTurnIds.has(context.nativeTurnId),
                    );
                    for (const context of lineage) {
                      const completion = yield* Deferred.make<void>();
                      interruptTargets.push({ context, completion });
                      trackedInterruptNativeTurnIds.add(context.nativeTurnId);
                      yield* Ref.update(turnWaiters, (current) => {
                        const updated = new Map(current);
                        updated.set(context.nativeTurnId, completion);
                        return updated;
                      });
                      yield* Ref.update(interruptingNativeTurns, (current) => {
                        const updated = new Set(current);
                        updated.add(context.nativeTurnId);
                        return updated;
                      });
                    }
                    return lineage;
                  }),
                );
                const completed = yield* Effect.forEach(
                  activeLineage,
                  (context) =>
                    Effect.flatMap(getNativeThreadId(context.providerThread), (threadId) =>
                      client.request("turn/interrupt", {
                        threadId,
                        turnId: context.nativeTurnId,
                      }),
                    ),
                  { concurrency: "unbounded", discard: true },
                ).pipe(Effect.timeoutOption("10 seconds"));
                if (Option.isNone(completed)) {
                  yield* Effect.logWarning(
                    "orchestration-v2.codex-late-descendant-interrupt-timeout",
                    {
                      nativeTurnIds: activeLineage.map((context) => context.nativeTurnId),
                      providerSessionId: input.providerSessionId,
                    },
                  );
                }
              });

              yield* Effect.gen(function* () {
                const containedTerminalKeys = new Set<string>();
                const attemptedTerminalKeys = new Set<string>();
                const collectTrackedTerminals = (targets: typeof interruptTargets) =>
                  Effect.gen(function* () {
                    const trackedTerminals = new Map<
                      string,
                      { readonly nativeThreadId: string; readonly processId: string }
                    >();
                    const runningItems = yield* Ref.get(runningCommandItemsByTurn);
                    for (const target of targets) {
                      const nativeThreadId = yield* getNativeThreadId(
                        target.context.providerThread,
                      );
                      const items = runningItems.get(target.context.nativeTurnId);
                      for (const item of items?.values() ?? []) {
                        if (item.processId !== undefined) {
                          trackedTerminals.set(`${nativeThreadId}:${item.processId}`, {
                            nativeThreadId,
                            processId: item.processId,
                          });
                        }
                      }
                    }
                    return trackedTerminals;
                  });
                const terminateTrackedTerminals = (targets: typeof interruptTargets) =>
                  Effect.gen(function* () {
                    const trackedTerminals = yield* collectTrackedTerminals(targets);
                    const pendingTerminals = Array.from(trackedTerminals.entries())
                      .filter(([key]) => !containedTerminalKeys.has(key))
                      .sort(
                        ([leftKey], [rightKey]) =>
                          Number(attemptedTerminalKeys.has(leftKey)) -
                          Number(attemptedTerminalKeys.has(rightKey)),
                      );
                    return yield* Effect.forEach(
                      pendingTerminals,
                      ([key, { nativeThreadId, processId }]) =>
                        Effect.gen(function* () {
                          attemptedTerminalKeys.add(key);
                          yield* terminateBackgroundTerminal(nativeThreadId, processId);
                          containedTerminalKeys.add(key);
                        }).pipe(
                          Effect.as({ success: true as const }),
                          Effect.catch((error) =>
                            Effect.succeed({ success: false as const, error }),
                          ),
                        ),
                    );
                  });

                // The request itself can stall too. Share the completion
                // deadline so Stop still reaches local finalization.
                const confirmedInterrupts = new Set<string>();
                const completed = yield* Effect.gen(function* () {
                  for (const target of interruptTargets) {
                    const context = target.context;
                    // A null start timestamp acknowledges a queued turn; Codex cannot interrupt it
                    // until turn/started confirms that the native task exists.
                    if (context.nativeStartReady !== undefined) {
                      yield* Deferred.await(context.nativeStartReady);
                    }
                    if ((yield* Ref.get(activeTurns)).get(context.nativeTurnId) !== context) {
                      continue;
                    }
                    yield* client.request("turn/interrupt", {
                      threadId: yield* getNativeThreadId(context.providerThread),
                      turnId: context.nativeTurnId,
                    });
                    confirmedInterrupts.add(context.nativeTurnId);
                  }
                  yield* Effect.all(
                    [
                      terminateTrackedTerminals(interruptTargets),
                      Effect.forEach(
                        interruptTargets,
                        (target) => Deferred.await(target.completion),
                        { concurrency: "unbounded", discard: true },
                      ),
                    ],
                    { concurrency: "unbounded" },
                  );
                }).pipe(Effect.timeoutOption("10 seconds"));
                if (Option.isNone(completed)) {
                  let unconfirmed = false;
                  for (const target of interruptTargets) {
                    const context = target.context;
                    if ((yield* Ref.get(activeTurns)).get(context.nativeTurnId) !== context) {
                      continue;
                    }
                    if (!confirmedInterrupts.has(context.nativeTurnId)) unconfirmed = true;
                    yield* Effect.logWarning("orchestration-v2.codex-interrupt-timeout", {
                      providerSessionId: input.providerSessionId,
                      providerThreadId: context.providerThread.id,
                      providerTurnId: context.providerTurnId,
                      nativeTurnId: context.nativeTurnId,
                    });
                  }
                  if (unconfirmed) {
                    // A queued turn can start after our deadline. Kill its owner before
                    // publishing a successful Stop, then retire this unusable session.
                    return yield* Effect.gen(function* () {
                      yield* Scope.close(clientScope, Exit.void);
                      yield* finalizeRemainingInterruptLineage;
                    }).pipe(
                      Effect.ensuring(
                        retireAppServer(
                          new CodexAppServerUnresponsiveError({ method: "turn/interrupt" }),
                        ),
                      ),
                      Effect.uninterruptible,
                    );
                  }
                }

                yield* interruptLateDescendants;
                yield* finalizeRemainingInterruptLineage;

                const terminationResults = yield* terminateTrackedTerminals(interruptTargets);
                const failedTermination = terminationResults.find((result) => !result.success);
                if (failedTermination !== undefined && !failedTermination.success) {
                  return yield* Effect.fail(failedTermination.error);
                }
                // Stop the retained items without rewriting the completed root turn.
                yield* turnTerminalizationPermit.withPermits(1)(
                  Effect.gen(function* () {
                    const completedAt = yield* DateTime.now;
                    for (const target of interruptTargets) {
                      const context = target.context;
                      if ((yield* Ref.get(settledTurns)).get(context.nativeTurnId) !== context)
                        continue;
                      yield* terminalizeRunningCommandItems(
                        context,
                        context.nativeTurnId,
                        "interrupted",
                        completedAt,
                      );
                      yield* terminalizeRunningDynamicTools(
                        context,
                        context.nativeTurnId,
                        "interrupted",
                        completedAt,
                        true,
                      );
                      yield* terminalizeMcpAppCaptures(context, context.nativeTurnId);
                      yield* Ref.update(runningCommandItemsByTurn, (current) => {
                        const updated = new Map(current);
                        updated.delete(context.nativeTurnId);
                        return updated;
                      });
                      yield* releaseSettledTurnIfIdle(context.nativeTurnId);
                    }
                  }),
                );
              }).pipe(
                Effect.onError(() => finalizeRemainingInterruptLineage),
                Effect.ensuring(cleanupInterruptState),
              );
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: requestedInput.providerThread.id,
                    providerTurnId: requestedInput.providerTurnId,
                    cause,
                  }),
              ),
            ),
          respondToRuntimeRequest: (requestInput) =>
            Effect.gen(function* () {
              const pending = (yield* Ref.get(pendingRuntimeRequests)).get(
                String(requestInput.requestId),
              );
              if (pending === undefined) {
                return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver: CODEX_PROVIDER,
                  requestId: requestInput.requestId,
                  cause: toProtocolError(
                    `No pending Codex runtime request ${requestInput.requestId}.`,
                  ),
                });
              }
              if (pending.type === "user_input") {
                if (requestInput.answers === undefined) {
                  return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: CODEX_PROVIDER,
                    requestId: requestInput.requestId,
                    cause: toProtocolError(
                      `Codex user input request ${requestInput.requestId} requires answers.`,
                    ),
                  });
                }
                yield* Deferred.succeed(pending.answers, requestInput.answers);
                return;
              }
              if (requestInput.decision === undefined) {
                return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                  driver: CODEX_PROVIDER,
                  requestId: requestInput.requestId,
                  cause: toProtocolError(
                    `Codex ${pending.requestKind} request ${requestInput.requestId} requires an approval decision.`,
                  ),
                });
              }
              yield* Deferred.succeed(pending.decision, requestInput.decision);
            }).pipe(
              Effect.mapError((cause) =>
                isProviderAdapterRuntimeRequestResponseError(cause)
                  ? cause
                  : new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                      driver: CODEX_PROVIDER,
                      requestId: requestInput.requestId,
                      cause,
                    }),
              ),
            ),
          uploadFeedback: (feedbackInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(feedbackInput.providerThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  client.request("feedback/upload", {
                    classification: "bug",
                    includeLogs: true,
                    ...(feedbackInput.reason ? { reason: feedbackInput.reason } : {}),
                    threadId,
                  }),
                ),
              );
              return { feedbackId: response.threadId };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterProtocolError({
                    driver: CODEX_PROVIDER,
                    detail: "Failed to upload Codex thread feedback.",
                    payload: cause,
                  }),
              ),
            ),
          mcpApps,
          readThreadSnapshot: (threadInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(threadInput.providerThread);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(client.request("thread/read", { threadId, includeTurns: true })),
              );
              return {
                providerThread: {
                  ...threadInput.providerThread,
                  nativeThreadRef: {
                    driver: CODEX_PROVIDER,
                    nativeId: response.thread.id,
                    strength: "strong" as const,
                  },
                  nativeConversationHeadRef: threadInput.providerThread.nativeConversationHeadRef,
                  updatedAt: codexTimestamp(response.thread.updatedAt),
                },
                messages: [],
                runtimeRequests: [],
                providerPayload: response.thread,
              };
            }).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.providerThread.id,
                    cause,
                  }),
              ),
            ),
          rollbackThread: (threadInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(threadInput.providerThread);
              const removed = yield* resolveCodexRollbackTurns(threadInput);
              const nativeConversationHeadRef =
                threadInput.target.type === "provider_turn"
                  ? threadInput.target.providerTurn.nativeTurnRef
                  : null;
              if (removed.length === 0) {
                return {
                  providerThread: {
                    ...threadInput.providerThread,
                    nativeConversationHeadRef,
                    status: "idle" as const,
                  },
                  messages: [],
                  runtimeRequests: [],
                };
              }
              // Codex 0.156 can revert paginated history at a turn boundary.
              // Legacy history no longer has a rollback endpoint.
              const { historyMode, loaded } = yield* ensureInitialized.pipe(
                Effect.andThen(readCodexThreadHistoryMetadata(client.raw, threadId)),
              );
              if (historyMode !== "paginated") {
                return yield* new ProviderAdapter.ProviderAdapterRollbackThreadError({
                  driver: CODEX_PROVIDER,
                  providerThreadId: threadInput.providerThread.id,
                  cause: `Cannot roll back Codex thread ${threadId}: the thread uses legacy history, which Codex 0.156 cannot revert.`,
                });
              }
              // `thread/revert` only acts on a thread loaded in this app-server
              // process. After a restart or idle release, load it the same way
              // the next turn would before reverting.
              if (!loaded) {
                yield* client.raw.request("thread/resume", {
                  threadId,
                  excludeTurns: true,
                  ...(yield* threadParams(threadInput.providerThread.appThreadId, threadInput)),
                });
              }
              const firstRemoved = removed[0]?.nativeTurnRef?.nativeId;
              // A retry may find the original suffix already removed. Use its durable
              // boundary in place. Count-only histories can be trimmed safely on a copy.
              const response =
                firstRemoved != null
                  ? yield* revertCodexThread(client, threadId, removed.length, {
                      firstRemoved,
                      lastRetained: nativeConversationHeadRef?.nativeId ?? null,
                    })
                  : yield* Effect.gen(function* () {
                      // The copy becomes the thread, so it gets the same thread config.
                      const copy = yield* client.request("thread/fork", {
                        threadId,
                        ...(yield* threadParams(threadInput.providerThread.appThreadId, {
                          modelSelection: input.modelSelection,
                          runtimePolicy: input.runtimePolicy,
                        })),
                      });
                      return yield* revertCodexThread(client, copy.thread.id, removed.length);
                    });
              turnTokenUsageByThread.delete(threadId);
              deliveredContextDigests.set(response.thread.id, undefined);
              yield* Ref.update(additionalContextByThread, (current) => {
                const next = new Map(current);
                next.delete(threadId);
                return next;
              });
              const { codexAdditionalContextDigest: _reverted, ...nativeMetadata } =
                threadInput.providerThread.nativeMetadata ?? {};
              return {
                providerThread: {
                  ...threadInput.providerThread,
                  ...(_reverted === undefined ? {} : { nativeMetadata }),
                  nativeThreadRef: {
                    driver: CODEX_PROVIDER,
                    nativeId: response.thread.id,
                    strength: "strong" as const,
                  },
                  nativeConversationHeadRef,
                  status: "idle" as const,
                  updatedAt: codexTimestamp(response.thread.updatedAt),
                },
                messages: [],
                runtimeRequests: [],
                providerPayload: response.thread,
              };
            }).pipe(
              Effect.scoped,
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.providerThread.id,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
          forkThread: (threadInput) =>
            Effect.gen(function* () {
              const threadId = yield* getNativeThreadId(threadInput.sourceProviderThread);
              const boundary = yield* resolveCodexForkBoundary(threadInput);
              const response = yield* ensureInitialized.pipe(
                Effect.andThen(
                  client.request("thread/fork", {
                    threadId,
                    ...(boundary.lastTurnId === undefined
                      ? {}
                      : { lastTurnId: boundary.lastTurnId }),
                    ...(yield* threadParams(threadInput.targetThreadId, {
                      ...(threadInput.modelSelection === undefined
                        ? {}
                        : { modelSelection: threadInput.modelSelection }),
                      ...(threadInput.runtimePolicy === undefined
                        ? {}
                        : { runtimePolicy: threadInput.runtimePolicy }),
                    })),
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterForkThreadError({
                      driver: CODEX_PROVIDER,
                      providerThreadId: threadInput.sourceProviderThread.id,
                      cause: normalizeCodexCause(cause),
                    }),
                ),
              );
              let forkedThread = response.thread;
              if (boundary.rollbackTurnCount > 0) {
                // Reached only when the selected source turn has no native
                // turn reference, so the fork had to be taken at head and then
                // trimmed with the paginated history API.
                const { historyMode } = yield* ensureInitialized.pipe(
                  Effect.andThen(readCodexThreadHistoryMetadata(client.raw, response.thread.id)),
                );
                if (historyMode !== "paginated") {
                  return yield* new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.sourceProviderThread.id,
                    cause: `Cannot fork Codex thread ${threadId} at provider turn ${threadInput.providerTurnId}: the source turn has no native Codex turn reference, and the forked thread uses legacy history which Codex 0.156 cannot revert.`,
                  });
                }
                forkedThread = (yield* ensureInitialized.pipe(
                  Effect.andThen(
                    revertCodexThread(client, response.thread.id, boundary.rollbackTurnCount),
                  ),
                  Effect.mapError(
                    (cause) =>
                      new ProviderAdapter.ProviderAdapterForkThreadError({
                        driver: CODEX_PROVIDER,
                        providerThreadId: threadInput.sourceProviderThread.id,
                        cause: normalizeCodexCause(cause),
                      }),
                  ),
                )).thread;
              }
              return providerThreadFromCodexThread({
                appThreadId: threadInput.targetThreadId,
                idAllocator,
                ownerNodeId: threadInput.ownerNodeId ?? null,
                providerSessionId: input.providerSessionId,
                providerInstanceId: adapterOptions.instanceId,
                thread: forkedThread,
                forkedFrom: {
                  providerThreadId: threadInput.sourceProviderThread.id,
                  ...(threadInput.providerTurnId === undefined
                    ? {}
                    : { providerTurnId: threadInput.providerTurnId }),
                },
              });
            }).pipe(
              Effect.scoped,
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterForkThreadError({
                    driver: CODEX_PROVIDER,
                    providerThreadId: threadInput.sourceProviderThread.id,
                    cause: normalizeCodexCause(cause),
                  }),
              ),
            ),
        };
        return runtime;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: CODEX_PROVIDER,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      ),
  });
});

type CodexSideTurn = {
  readonly onUpdate: (
    update: ProviderAdapter.ProviderAdapterV2SideChatUpdate,
  ) => Effect.Effect<void>;
  readonly done: Deferred.Deferred<string, ProviderAdapter.ProviderAdapterV2Error>;
  readonly messages: Map<string, string>;
  readonly activities: Map<string, SideChatActivity>;
};

const codexSideTurnText = (turn: CodexSideTurn) =>
  [...turn.messages.values()].filter((text) => text.length > 0).join("\n\n");

/**
 * Codex's `/side`: an ephemeral fork of the thread in its own app-server, so
 * nothing it does reaches the main thread's process or its rollout. It runs
 * with the thread's permissions; approval prompts are declined because the
 * side chat has nowhere to show them.
 */
const openCodexSideChat = Effect.fn("CodexAdapterV2.openSideChat")(
  function* (
    adapterOptions: CodexAdapterV2Options,
    sideInput: ProviderAdapter.ProviderAdapterV2SideChatInput,
    // The thread's T3 MCP session. The fork gets the same servers, model and
    // turn settings as the thread so its requests reuse the cached prefix.
    mcpSession: McpProviderSession.McpProviderSessionConfig | undefined,
    prepareChatEnvironment: NonNullable<
      ProviderHost.ProviderHost["Service"]["prepareChatEnvironment"]
    >,
  ) {
    const parentThreadId = sideInput.providerThread.nativeThreadRef?.nativeId;
    if (parentThreadId === undefined || parentThreadId === null) {
      return yield* new ProviderAdapter.ProviderAdapterProtocolError({
        driver: CODEX_PROVIDER,
        detail: `Provider thread ${sideInput.providerThread.id} has no native Codex thread yet`,
      });
    }
    const resolvedRuntime =
      adapterOptions.resolveRuntime === undefined
        ? undefined
        : yield* adapterOptions.resolveRuntime;
    const environment = resolvedRuntime?.environment ?? adapterOptions.environment;
    const prepared = yield* prepareChatEnvironment({
      instanceId: adapterOptions.instanceId,
      driver: CODEX_PROVIDER,
      threadId: sideInput.threadId,
      environment,
    });
    const chatTempDir = prepared === environment ? undefined : prepared.TMPDIR;
    const client = yield* adapterOptions.clientFactory.open({
      instanceId: adapterOptions.instanceId,
      threadId: sideInput.threadId,
      providerSessionId:
        sideInput.providerThread.providerSessionId ??
        ProviderSessionId.make(`side-chat:${parentThreadId}`),
      runtimePolicy: sideInput.runtimePolicy,
      settings: resolvedRuntime?.config ?? adapterOptions.settings,
      environment,
    });

    let sideThreadId: string | null = null;
    let current: CodexSideTurn | null = null;
    const forSideThread = (threadId: string, run: (turn: CodexSideTurn) => Effect.Effect<void>) =>
      threadId === sideThreadId && current !== null ? run(current) : Effect.void;
    const updateActivity = (
      turn: CodexSideTurn,
      item: CodexSchema.V2ItemStartedNotification__ThreadItem,
      status: SideChatActivity["status"],
    ) => {
      const label =
        item.type === "sleep"
          ? codexSleepLabel(item.durationMs, status === "completed")
          : codexSideConversationActivityLabel(item);
      if (label === null) return Effect.void;
      const activity = { id: item.id, label, status };
      turn.activities.set(item.id, activity);
      return turn.onUpdate({ type: "activity", activity });
    };

    yield* client.handleServerRequest("item/commandExecution/requestApproval", () =>
      Effect.succeed({ decision: "decline" } as const),
    );
    yield* client.handleServerRequest("item/fileChange/requestApproval", () =>
      Effect.succeed({ decision: "decline" } as const),
    );
    yield* client.handleServerRequest("item/permissions/requestApproval", () =>
      Effect.succeed({ permissions: {}, scope: "turn" } as const),
    );
    yield* client.handleServerRequest("mcpServer/elicitation/request", (payload) =>
      forSideThread(payload.threadId, (turn) => {
        const activity = {
          id: `elicitation:${payload.mode === "url" ? payload.elicitationId : payload.serverName}`,
          label: "Side conversation cannot answer an MCP request",
          status: "failed",
        } as const;
        turn.activities.set(activity.id, activity);
        return turn.onUpdate({ type: "activity", activity });
      }).pipe(Effect.as({ action: "decline" } as const)),
    );
    yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
      forSideThread(payload.threadId, (turn) => {
        const activity = {
          id: `input:${payload.itemId}`,
          label: "Side conversation cannot answer a tool question",
          status: "failed",
        } as const;
        turn.activities.set(activity.id, activity);
        return turn.onUpdate({ type: "activity", activity });
      }).pipe(Effect.as({ answers: {} })),
    );
    yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
      forSideThread(payload.threadId, (turn) => {
        turn.messages.set(
          payload.itemId,
          (turn.messages.get(payload.itemId) ?? "") + payload.delta,
        );
        return turn.onUpdate({ type: "text", text: codexSideTurnText(turn) });
      }),
    );
    yield* client.handleServerNotification("item/started", (payload) =>
      forSideThread(payload.threadId, (turn) => updateActivity(turn, payload.item, "running")),
    );
    yield* client.handleServerNotification("item/completed", (payload) =>
      forSideThread(payload.threadId, (turn) => {
        const item = payload.item;
        if (item.type === "agentMessage") {
          turn.messages.set(item.id, item.text);
          return turn.onUpdate({ type: "text", text: codexSideTurnText(turn) });
        }
        const failed = "status" in item && (item.status === "failed" || item.status === "declined");
        return updateActivity(turn, item, failed ? "failed" : "completed");
      }),
    );
    yield* client.handleServerNotification("turn/completed", (payload) =>
      forSideThread(payload.threadId, (turn) =>
        Effect.gen(function* () {
          if (payload.turn.status === "failed" || payload.turn.status === "interrupted") {
            for (const activity of turn.activities.values()) {
              if (activity.status !== "running") continue;
              const stopped = { ...activity, status: "failed" as const };
              turn.activities.set(activity.id, stopped);
              yield* turn.onUpdate({ type: "activity", activity: stopped });
            }
          }
          return yield* payload.turn.status === "failed"
            ? Deferred.fail(
                turn.done,
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver: CODEX_PROVIDER,
                  detail: payload.turn.error?.message ?? "The side conversation failed",
                }),
              ).pipe(Effect.asVoid)
            : Deferred.succeed(turn.done, codexSideTurnText(turn)).pipe(Effect.asVoid);
        }),
      ),
    );

    const protocolError = (detail: string) => (cause: unknown) =>
      new ProviderAdapter.ProviderAdapterProtocolError({ driver: CODEX_PROVIDER, detail, cause });

    yield* client
      .request("initialize", {
        clientInfo: buildCodexInitializeParams().clientInfo,
        capabilities: CODEX_CLIENT_CAPABILITIES,
      })
      .pipe(Effect.mapError(protocolError("Codex did not start the side conversation")));
    yield* client
      .notify("initialized", undefined)
      .pipe(Effect.mapError(protocolError("Codex did not start the side conversation")));
    const forked = yield* client
      .request("thread/fork", {
        threadId: parentThreadId,
        ephemeral: true,
        excludeTurns: true,
        developerInstructions: CODEX_SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS,
        ...codexThreadRuntimeParams({
          chatId: sideInput.threadId,
          chatTempDir,
          mcpSession,
          modelSelection: sideInput.modelSelection,
          runtimePolicy: sideInput.runtimePolicy,
        }),
      })
      .pipe(
        Effect.mapError(protocolError("Codex could not fork the thread for a side conversation")),
      );
    const configuredReasoningEffort = yield* Effect.cached(
      readCodexConfiguredEffort(client, sideInput.runtimePolicy.cwd).pipe(
        Effect.mapError(protocolError("Codex could not read its configured reasoning effort")),
      ),
    );
    const hostBrowser = yield* Effect.cached(
      adapterOptions.hostBrowser ?? Effect.succeed(undefined),
    );
    const forkedThreadId = forked.thread.id;
    yield* client
      .request("thread/inject_items", {
        threadId: forkedThreadId,
        items: [
          {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: CODEX_SIDE_CONVERSATION_BOUNDARY }],
          },
        ],
      })
      .pipe(Effect.mapError(protocolError("Codex could not start the side conversation")));
    sideThreadId = forkedThreadId;

    return {
      kind: "side" as const,
      ask: ({ prompt, onUpdate }) =>
        Effect.gen(function* () {
          const turn: CodexSideTurn = {
            onUpdate,
            done: yield* Deferred.make<string, ProviderAdapter.ProviderAdapterV2Error>(),
            messages: new Map(),
            activities: new Map(),
          };
          current = turn;
          const params = yield* buildCodexTurnStartParams({
            nativeThreadId: forkedThreadId,
            codexInput: [{ type: "text", text: prompt }],
            runtimePolicy: { ...sideInput.runtimePolicy, interactionMode: "default" },
            modelSelection: sideInput.modelSelection,
            hasT3Mcp: mcpSession !== undefined,
            chatTempDir,
            configuredReasoningEffort: needsCodexConfiguredEffort(
              sideInput.modelSelection,
              "default",
              mcpSession !== undefined,
            )
              ? yield* configuredReasoningEffort
              : undefined,
            browserToolsAvailable: mcpSession?.browserToolsAvailable ?? true,
            deviceToolsAvailable: mcpSession?.capabilities?.has("device") ?? false,
            toolDiscoveryCatalog: yield* (
              mcpSession?.toolDiscoveryCatalog ?? Effect.succeed(undefined)
            ),
            hostBrowser: yield* hostBrowser,
            omitServiceTier: adapterOptions.resolveRuntime !== undefined,
            threadId: sideInput.threadId,
          }).pipe(Effect.mapError(protocolError("Could not prepare the side conversation turn")));
          yield* client
            .request("turn/start", params)
            .pipe(Effect.mapError(protocolError("Codex did not start the side conversation turn")));
          // Only turn/completed settles the answer, so a side app-server that
          // exits mid-turn must fail it rather than leave the chat busy forever.
          const exited =
            client.awaitTermination === undefined
              ? Effect.never
              : client.awaitTermination.pipe(
                  // A client without the signal (a test double) just never ends.
                  Effect.catchCause(() => Effect.never),
                  Effect.flatMap((cause) =>
                    Effect.fail(
                      protocolError("Codex stopped before the side answer finished")(cause),
                    ),
                  ),
                );
          return yield* Effect.raceFirst(Deferred.await(turn.done), exited);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              current = null;
            }),
          ),
        ),
    } satisfies ProviderAdapter.ProviderAdapterV2SideChat;
  },
  (effect) =>
    effect.pipe(
      Effect.mapError((cause) =>
        Schema.is(ProviderAdapter.ProviderAdapterV2Error)(cause)
          ? cause
          : new ProviderAdapter.ProviderAdapterProtocolError({
              driver: CODEX_PROVIDER,
              detail: "Codex could not open a side conversation",
              cause,
            }),
      ),
    ),
);
