import { accountAcceptsModel } from "@t3tools/shared/accountBalance";
import { derive } from "@t3tools/provider-core/server/IdAllocator";
import { accountUnavailable } from "../provider/accountAvailability.ts";
import { preferSiblingAccount } from "../provider/siblingAccount.ts";
import { providerDataUse, trainingNotice } from "./providerDataUse.ts";
import { modelFailureNote, modelFailureNotice } from "../provider/modelFailures.ts";
import { snapshotNotice } from "../git/ParentEditsSnapshot.ts";
import { pendingTaskRequests } from "./pendingTaskRequests.ts";
import { captureCallerSteer, raceWithSteer, STEER_NOTICE } from "./McpSteerWait.ts";
import {
  resolveTaskReference,
  encodeRequestPart,
  taskReference,
  withTaskReference,
} from "../orchestration-v2/taskReference.ts";
import {
  runtimeModeRank,
  interactionModeRank,
  resolveRuntimeMode,
  resolveInteractionMode,
} from "./delegationModes.ts";
import * as WorkflowsService from "../workflows/WorkflowsService.ts";
import { registerWorkflowsDelegate } from "../workflows/workflowsBeta.ts";
import { SubagentRankings } from "../subagentRankings/SubagentRankings.ts";
import type { RecordedGrade } from "../subagentRankings/records.ts";
import {
  modelRankingFamily,
  modelFamilySupersessions,
  modelRankingSelectionKey,
} from "@t3tools/shared/modelRankings";
import {
  SECRET_REQUEST_TURN_ITEM_ID_PREFIX,
  activeProviderFailure,
  rememberedAccountFailure,
  CommandId,
  type RunId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  type OrchestratorMcpTaskGrades,
  type OrchestratorMcpGradesResult,
  SubagentGrade,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type WorkflowsError,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentRole,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2WorkspacePreparation,
  type OrchestrationV2TurnItem,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpCapabilitiesInput,
  type OrchestratorMcpCreateThreadsInput,
  type OrchestratorMcpCreateThreadsResult,
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpCouncilInput,
  type OrchestratorMcpCouncilResult,
  type OrchestratorMcpDelegateTaskInput,
  type WorkflowContextRecord,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpDeleteScheduledTaskInput,
  type OrchestratorMcpAskUserInput,
  type OrchestratorMcpAskUserResult,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
  type OrchestratorMcpDeleteScheduledTaskResult,
  type OrchestratorMcpListScheduledTasksResult,
  type OrchestratorMcpScheduledTask,
  type OrchestratorMcpScheduleTaskInput,
  type OrchestratorMcpScheduleTaskResult,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpUpdateScheduledTaskInput,
  type OrchestratorMcpListScheduledTasksInput,
  type ProjectId,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadReference,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ScheduledTaskListRunsInput,
  type ScheduledTaskListRunsResult,
  type ScheduledTaskPreviewWebhookInput,
  type ScheduledTaskPreviewWebhookResult,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  ThreadId,
  isOrchestrationV2WorkActive,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import {
  hasPendingBackgroundSubagent,
  threadSendMessageId,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { isAbsolutePath } from "@t3tools/shared/path";
import {
  nativeHarnessModelSelection,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import {
  delegatedTaskProgressForTask,
  delegatedTaskRuns,
  followupRunsByMessage,
} from "../orchestration-v2/DelegatedTaskProgress.ts";
import * as MonitorService from "../monitors/MonitorService.ts";
import { makeRepeatChecks, unchangedNotice } from "./repeatChecks.ts";
import { type DelegateTaskDetails } from "./delegateTaskDetails.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import {
  registerGradingEnabled,
  registerRankedTaskKinds,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { rankedModelRankingKinds } from "@t3tools/shared/modelRankings";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { type ProjectionTimelinePage } from "../orchestration-v2/ProjectionStore.ts";
import {
  EMPTY_CHILD_RESULT_TEXT,
  subagentResultForRun,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { placeholderThreadTitle } from "../orchestration-v2/placeholderThreadTitle.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import {
  assertTargetWithinLimits,
  resolveTaskThreadReference,
  UNKNOWN_PROJECT_MESSAGE,
} from "./threadAccess.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  clientRuntimeModeCeiling,
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "./McpInvocationContext.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import {
  collectUsageLimits,
  type UsageLimitsInput,
  type UsageLimitsResult,
} from "./OrchestratorUsageLimits.ts";
import {
  addHeldMessage,
  combineHeldMessages,
  HELD_PARENT_MESSAGE_MAX_WAIT,
  hasSteerableTurn,
  type HeldParentMessage,
  shouldHoldForParent,
} from "./HeldParentMessages.ts";

const decodeTaskGrade = Schema.decodeUnknownOption(
  Schema.Struct({
    taskId: NodeId,
    score: SubagentGrade.fields.score,
    note: Schema.optionalKey(Schema.String),
  }),
);

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
// Nothing is written while a task wait blocks, and Node fetch drops a silent call at 300 s.
const DEFAULT_TASK_WAIT_TIMEOUT_MS = 4 * 60 * 1_000;
const COUNCIL_DEFAULT_TIMEOUT_MS = 15 * 60 * 1_000;

/** The brief every council member gets: the same question, answered blind. */
const councilBrief = (input: OrchestratorMcpCouncilInput) =>
  [
    "Answer independently for the lead. Read-only: no edits, installs, commits, deploys, subagents or user questions. Under 400 words: recommendation, key reasons, main risk or what would change your mind, confidence (low/medium/high).",
    "",
    "Question:",
    input.question,
    ...(input.context === undefined ? [] : ["", "Context:", input.context]),
  ].join("\n");
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
// Events that can end a delegated task wait: the parent's task record,
// and the child's runs, nested tasks, provider background work, and questions.
const TASK_WAKE_EVENTS = [
  { thread: "parent", eventType: "subagent.updated" },
  { thread: "child", eventType: "run.updated" },
  { thread: "child", eventType: "subagent.updated" },
  { thread: "child", eventType: "provider-thread.updated" },
  { thread: "child", eventType: "runtime-request.updated" },
] as const;
/** A person answers the card, so a slower poll is plenty. */
const DEFAULT_THREAD_LIST_LIMIT = 50;
// An omitted read is the page agents pay for. Callers can still request the
// previous 50 items, 10 runs, and 20_000 characters, up to the input caps.
const DEFAULT_THREAD_READ_LIMIT = 15;
const THREAD_SEARCH_SCAN_LIMIT = 1_000;
const THREAD_SEARCH_BATCH_SIZE = 100;
const DEFAULT_THREAD_RUN_LIMIT = 1;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 4_000;
// Claude Code saves MCP results over ~25k tokens to a file instead of showing them. Thread JSON
// runs about 2 chars per token, so a read stops adding items here and reports the rest as more.
const THREAD_READ_BUDGET_CHARS = 30_000;
const encodeJsonText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

interface ResolvedTarget {
  readonly modelSelection: ModelSelection;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly notice?: string;
}

type TerminalTaskStatus = Extract<
  OrchestratorMcpDelegateTaskResult["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export interface OrchestratorMcpServiceShape {
  readonly capabilities: (
    scope: McpInvocationScope,
    input?: OrchestratorMcpCapabilitiesInput,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly usageLimits: (
    scope: McpInvocationScope,
    input: typeof UsageLimitsInput.Type,
  ) => Effect.Effect<UsageLimitsResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<DelegateTaskDetails, OrchestratorMcpFailure>;
  /** Asks several models one question independently, as parallel waited delegations. */
  readonly council: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCouncilInput,
  ) => Effect.Effect<OrchestratorMcpCouncilResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<DelegateTaskDetails, OrchestratorMcpFailure>;
  /** Saves grades for the caller's finished tasks; one that can't be saved is skipped, never failed. */
  readonly gradeTasks: (
    scope: McpInvocationScope,
    grades: OrchestratorMcpTaskGrades | undefined,
  ) => Effect.Effect<OrchestratorMcpGradesResult>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  readonly createThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCreateThreadsInput,
  ) => Effect.Effect<OrchestratorMcpCreateThreadsResult, OrchestratorMcpFailure>;
  readonly scheduleTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpScheduleTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly listScheduledTaskRuns: (
    scope: McpInvocationScope,
    input: ScheduledTaskListRunsInput,
  ) => Effect.Effect<ScheduledTaskListRunsResult, OrchestratorMcpFailure>;
  readonly previewScheduledTaskWebhook: (
    scope: McpInvocationScope,
    input: ScheduledTaskPreviewWebhookInput,
  ) => Effect.Effect<ScheduledTaskPreviewWebhookResult, OrchestratorMcpFailure>;
  readonly listScheduledTasks: (
    scope: McpInvocationScope,
    input: OrchestratorMcpListScheduledTasksInput,
  ) => Effect.Effect<OrchestratorMcpListScheduledTasksResult, OrchestratorMcpFailure>;
  readonly updateScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpUpdateScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly deleteScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDeleteScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpDeleteScheduledTaskResult, OrchestratorMcpFailure>;
  /**
   * Asks the user for a secret through a card in the calling thread and waits
   * for the answer. The value never reaches the agent: the result is a status.
   */
  readonly requestSecret: (
    scope: McpInvocationScope,
    input: OrchestratorMcpRequestSecretInput,
  ) => Effect.Effect<OrchestratorMcpRequestSecretResult, OrchestratorMcpFailure>;
  readonly askUser: (
    scope: McpInvocationScope,
    input: OrchestratorMcpAskUserInput,
  ) => Effect.Effect<OrchestratorMcpAskUserResult, OrchestratorMcpFailure>;
  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/OrchestratorMcpService") {}

const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function threadManagementFailure(error: unknown): OrchestratorMcpFailure {
  if (!isThreadManagementError(error)) return failure("orchestration_error", errorMessage(error));
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return failure("thread_not_found", error.message);
    case "ThreadManagementRunNotFoundError":
      return failure("run_not_found", error.message);
    case "ThreadManagementThreadArchivedError":
      return failure("thread_not_sendable", error.message);
    case "ThreadManagementNoSteerableRunError":
      return failure(
        "thread_not_sendable",
        `${error.message} Send with mode: "auto" or "queue" to start a new turn there.`,
      );
    case "ThreadManagementThreadNotInterruptibleError":
      return failure("thread_not_interruptible", error.message);
    case "ThreadManagementProjectionLoadError":
    case "ThreadManagementProjectThreadsListError":
    case "ThreadManagementDurableRunProjectionError":
      return failure("orchestration_error", error.message);
    case "ThreadManagementProviderInstanceDisabledError":
      return failure("invalid_request", error.message);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Workspace strategy for a scheduled task created/updated over MCP: bound runs
 * post into the existing thread (the strategy is unused, keep root); unbound
 * runs launch a fresh worktree per run.
 */
function scheduledTaskWorkspaceStrategy(
  boundToThread: boolean,
): ScheduledTask["workspaceStrategy"] {
  return boundToThread
    ? { type: "root" }
    : { type: "worktree", baseRef: "main", startFromOrigin: true };
}

/** Webhook mechanics ride in the result, not in every turn's tool description. */
const WEBHOOK_SETUP_NOTE =
  "Webhook prompts receive untrusted request values through {{body.path}}, {{headers.name}}, {{query.name}}, {{body}} or {{request}} (method, redacted headers, body). For signatures, first collect the secret privately with request_secret, then set signature with its secretRef, header, encoding and optional prefix.";

/**
 * A scheduled task as an agent sees it. `mayRun` says whether the caller may
 * run it: a webhook's URL carries the secret that starts the task's runs, so
 * only such a caller sees it.
 */
function scheduledTaskSummary(task: ScheduledTask, mayRun: boolean): OrchestratorMcpScheduledTask {
  return {
    scheduledTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    boundThreadId: task.threadId,
    schedule: task.schedule,
    nextRunAt: task.nextRunAt,
    lastRunStatus: task.lastRunStatus,
    // A bare path is not a URL anyone can call, so agents never get one to share.
    ...(task.webhook?.url == null || !mayRun ? {} : { webhookUrl: task.webhook.url }),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
    ...(task.schedule.type === "webhook" ? { webhookSetup: WEBHOOK_SETUP_NOTE } : {}),
  };
}

const RECENT_FAILURE_NOTE_MESSAGE_LENGTH = 160;

/** A short line for agents choosing a provider: a usage limit or a failing provider. */
function recentFailureNote(
  provider: ServerProvider,
  now: number,
  model?: string,
): { readonly recentFailure?: string } {
  // An account failure outlives its retry time until a run works: a lead should
  // know the last run here ended signed out, even when another try is allowed.
  const failure = activeProviderFailure(provider, now, model) ?? rememberedAccountFailure(provider);
  if (!failure) return {};
  const message =
    failure.message.length <= RECENT_FAILURE_NOTE_MESSAGE_LENGTH
      ? failure.message
      : `${failure.message.slice(0, RECENT_FAILURE_NOTE_MESSAGE_LENGTH - 1)}…`;
  const what =
    failure.kind === "usage_limit"
      ? `usage limit${failure.resetAt ? ` until ${failure.resetAt}` : ""}`
      : `provider error at ${failure.occurredAt}`;
  return { recentFailure: `${what}: ${message}` };
}

/** Names advertised slugs to retry with: same last `/` segment first, else a few current ones. */
/** Antigravity 1.3 IDs append the thinking level (`gemini-3.8-flash-high`); the agent still accepts them. */
function antigravitySuffixedModel(provider: ServerProvider, model: string) {
  if (provider.driver !== "antigravity" || provider.models.some((entry) => entry.slug === model))
    return;
  const separator = model.lastIndexOf("-");
  if (separator === -1) return;
  const family = model.slice(0, separator);
  const value = model.slice(separator + 1);
  const thinking = provider.models
    .find((candidate) => candidate.slug === family)
    ?.capabilities?.optionDescriptors?.find(
      (descriptor) => descriptor.type === "select" && descriptor.role === "reasoning",
    );
  if (thinking?.type === "select" && thinking.options.some((choice) => choice.id === value)) {
    return { model: family, thinking: { id: thinking.id, value } };
  }
}

function advertisedModelsHint(models: ServerProvider["models"], requested: string): string {
  const limit = 5;
  const lastSegment = (slug: string) => slug.slice(slug.lastIndexOf("/") + 1).toLowerCase();
  const wanted = lastSegment(requested);
  const close = models.filter((model) => lastSegment(model.slug) === wanted);
  if (close.length > 0) {
    return ` Did you mean ${close
      .slice(0, limit)
      .map((model) => model.slug)
      .join(", ")}?`;
  }
  const current = models.filter((model) => model.isLegacy !== true);
  if (current.length === 0) return "";
  const omitted = current.length - Math.min(current.length, limit);
  return ` Advertised: ${current
    .slice(0, limit)
    .map((model) => model.slug)
    .join(", ")}${omitted > 0 ? ` and ${omitted} more` : ""}.`;
}

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  if (!provider.enabled) constraints.push("Provider instance is disabled.");
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/**
 * Checks requested option selections for duplicates and, when the model
 * advertises option descriptors, against those descriptors. Models without
 * descriptors skip the descriptor checks (mirroring how model slugs are only
 * validated when the provider advertises models), but duplicate ids always
 * fail: downstream consumers disagree on whether the first or last value of
 * a duplicated id wins.
 */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

function taskStatusForRun(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork"> | undefined,
): OrchestratorMcpDelegateTaskResult["status"] {
  switch (run === undefined ? undefined : runOutcome(run)) {
    case "queued":
      return "queued";
    case "starting":
      return "starting";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "preparing":
    case "running":
    case undefined:
      return "running";
  }
}

export function delegatedTaskRun(
  childProjection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "contextTransfers"
  >,
  task: OrchestrationV2Subagent,
): OrchestrationV2Run | undefined {
  const taskRun = childProjection.runs.find((run) => run.delegatedTaskId === task.id);
  if (taskRun !== undefined) return taskRun;
  const messageId = threadSendMessageId(task.id);
  if (messageId !== undefined)
    return childProjection.runs.find((run) => run.userMessageId === messageId);
  if (
    childProjection.thread.forkedFrom?.type === "node" &&
    childProjection.thread.forkedFrom.nodeId !== task.id
  ) {
    return followupRunsByMessage(childProjection, task)[0];
  }
  const spawnTransfer = childProjection.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.sourceThreadId === task.threadId &&
      transfer.targetThreadId === task.childThreadId,
  );
  if (spawnTransfer === undefined) {
    // Legacy delegated-task projections predate the durable spawn transfer.
    return childProjection.runs[0];
  }
  return spawnTransfer.targetRunId === null
    ? undefined
    : childProjection.runs.find((run) => run.id === spawnTransfer.targetRunId);
}

export function hasPendingChildRuns(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): boolean {
  // Held queued runs wait for the user to resume the child; task_cancel holds them.
  return childProjection.runs.some(
    (run) =>
      !ThreadManagementService.isTerminalRunStatus(run.status) &&
      !(run.status === "queued" && run.queueHeld === true) &&
      (delegatedRun === undefined || run.ordinal > delegatedRun.ordinal),
  );
}

function isTerminalTaskStatus(
  status: OrchestratorMcpDelegateTaskResult["status"],
): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function directAppOwnedChildTasks(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<OrchestrationV2Subagent> {
  if (
    target.thread.lineage.parentEnvironmentId !== undefined ||
    target.thread.lineage.parentThreadId !== parent.thread.id ||
    target.thread.lineage.relationshipToParent !== "subagent"
  ) {
    return [];
  }
  return parent.subagents.filter(
    (task) =>
      task.origin === "app_owned" &&
      task.remote === undefined &&
      task.threadId === parent.thread.id &&
      task.childThreadId === target.thread.id &&
      delegatedTaskRuns(target, task).some((run) => returnedRunIds.has(run.id)),
  );
}

function taskResultTransfer(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">,
  child: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages" | "contextTransfers">,
  task: OrchestrationV2Subagent,
) {
  const originalRun = delegatedTaskRun(child, task);
  const taskRuns = delegatedTaskRuns(child, task);
  const runIds = new Set(taskRuns.map((run) => run.id));
  if (originalRun !== undefined) runIds.add(originalRun.id);
  const original =
    child.thread.forkedFrom?.type !== "node" || child.thread.forkedFrom.nodeId === task.id;
  const transfers = parent.contextTransfers.filter(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.sourceThreadId === task.childThreadId &&
      transfer.targetThreadId === parent.thread.id &&
      ((transfer.sourcePoint.runId !== undefined && runIds.has(transfer.sourcePoint.runId)) ||
        (original &&
          transfer.sourcePoint.runId === undefined &&
          originalRun?.delegatedTaskId === undefined)),
  );
  if (original) return transfers[0];
  for (const run of taskRuns.toSorted((a, b) =>
    runRanAfter(a, b) ? -1 : runRanAfter(b, a) ? 1 : 0,
  )) {
    const transfer = transfers.find((candidate) => candidate.sourcePoint.runId === run.id);
    if (transfer !== undefined) return transfer;
  }
  return undefined;
}

function pageIncludesTerminalTaskResult(input: {
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">;
  readonly page: ReadonlyArray<OrchestrationV2ThreadProjection["visibleTurnItems"][number]>;
  readonly task: OrchestrationV2Subagent;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers" | "messages" | "turnItems"
  >;
  readonly maxChars: number;
}): boolean {
  const transfer = taskResultTransfer(input.parent, input.target, input.task);
  if (transfer === undefined) return false;
  const run =
    transfer.sourcePoint.runId === undefined
      ? delegatedTaskRun(input.target, input.task)
      : input.target.runs.find((run) => run.id === transfer.sourcePoint.runId);
  if (run === undefined || !isTerminalTaskStatus(taskStatusForRun(run))) return false;

  const result = subagentResultForRun(input.target, run);
  if (result.messageId === null && result.turnItemId === null) return false;

  const report = result.priorReport;
  if (
    report !== undefined &&
    (report.text.length > input.maxChars ||
      !input.page.some(
        (row) =>
          row.sourceThreadId === input.target.thread.id &&
          row.sourceItemId === report.itemId &&
          row.item.type === "assistant_message" &&
          row.item.text === report.text,
      ))
  )
    return false;
  return input.page.some((row) => {
    if (row.sourceThreadId !== input.target.thread.id) return false;
    const matchesResult =
      (result.turnItemId !== null && row.sourceItemId === result.turnItemId) ||
      (result.messageId !== null &&
        row.item.type === "assistant_message" &&
        row.item.messageId === result.messageId);
    if (!matchesResult) return false;

    const text = turnItemText(row.item);
    return text !== null && text.length <= input.maxChars;
  });
}

function latestTerminalResultRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
  awaitingContinuationRun: OrchestrationV2Run | undefined,
): OrchestrationV2Run | undefined {
  const monitorMessageIds = new Set(
    projection.messages
      .filter(
        (message) =>
          message.notification?.source.kind === "monitor" &&
          message.notification.outcome === "updated",
      )
      .map((message) => message.id),
  );
  const finalMonitorRuns = new Set(
    projection.messages
      .filter(
        (message) =>
          message.notification?.source.kind === "monitor" &&
          message.notification.outcome !== "updated",
      )
      .map((message) => message.runId),
  );
  // A restart-cut run, and each cut run before it in the chain, has no outcome while a
  // continuation is pending, live, or ran to a result.
  const runsById = new Map(projection.runs.map((run) => [run.id, run]));
  const supersededRunIds = new Set<RunId>();
  const supersede = (runId: RunId | undefined) => {
    let id = runId;
    while (id !== undefined && !supersededRunIds.has(id)) {
      supersededRunIds.add(id);
      id = runsById.get(id)?.restartContinuationOfRunId;
    }
  };
  supersede(awaitingContinuationRun?.id);
  for (const run of projection.runs) {
    if (
      !ThreadManagementService.isTerminalRunStatus(run.status) ||
      (run.status !== "rolled_back" && run.startedAt !== null)
    )
      supersede(run.restartContinuationOfRunId);
  }
  return projection.runs
    .filter(
      (run) =>
        ThreadManagementService.isTerminalRunStatus(run.status) &&
        (!monitorMessageIds.has(run.userMessageId) || finalMonitorRuns.has(run.id)) &&
        !supersededRunIds.has(run.id) &&
        run.status !== "rolled_back" &&
        (run.id === delegatedRun?.id || run.startedAt !== null),
    )
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
      undefined,
    );
}

function canExposeTaskRunResult(run: OrchestrationV2Run | undefined): run is OrchestrationV2Run {
  return (
    run !== undefined && run.status !== "rolled_back" && isTerminalTaskStatus(taskStatusForRun(run))
  );
}

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly index?: number;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      encodeRequestPart(input.scope.requestNamespace),
      encodeRequestPart(input.operation),
      encodeRequestPart(input.requestKey),
      ...(input.index === undefined ? [] : [String(input.index)]),
    ].join(":"),
  );
}

function stableThreadId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): ThreadId {
  return ThreadId.make(
    [
      "thread",
      "mcp",
      encodeRequestPart(input.scope.requestNamespace),
      encodeRequestPart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      encodeRequestPart(input.scope.requestNamespace),
      encodeRequestPart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableOperationMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      encodeRequestPart(input.scope.requestNamespace),
      encodeRequestPart(input.operation),
      encodeRequestPart(input.requestKey),
    ].join(":"),
  );
}

function threadTitle(input: {
  readonly parentTitle: string;
  readonly prompt: string | undefined;
  readonly title: string | undefined;
  readonly index: number;
}): string {
  const detail = input.title?.trim() || input.prompt?.trim();
  if (!detail) return placeholderThreadTitle(input.parentTitle, input.index);
  return detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
}

/**
 * The role a lead picked, as data for the task record. The brief itself is sent as written: a
 * child already knows it is a subagent, and an added role sentence could contradict the brief.
 */
export function taskRole(
  input: Pick<OrchestratorMcpDelegateTaskInput, "role">,
): OrchestrationV2SubagentRole | undefined {
  return input.role === undefined || input.role === "general" ? undefined : input.role;
}

function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): { readonly settled: boolean; readonly settledAt: string | null } {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

function threadSnooze(
  thread: Parameters<typeof isSnoozed>[0],
  nowMs: number,
): { readonly snoozed: boolean; readonly snoozedUntil: string | null } {
  const snoozed = isSnoozed(thread, nowMs);
  return {
    snoozed,
    snoozedUntil:
      snoozed && thread.snoozedUntil != null ? DateTime.formatIso(thread.snoozedUntil) : null,
  };
}

// Shells already use the shared pending-work derivation, including its settlement gate.
function threadBackgroundWork(
  shell: Pick<OrchestrationV2ThreadShell, "blockedOnThreadWait" | "pendingBackgroundTasks">,
) {
  const tasks = (shell.pendingBackgroundTasks ?? []).map((task) => ({
    taskId: task.taskId,
    kind: task.kind,
    ...(task.description === undefined ? {} : { description: task.description }),
    ...(task.kind === "subagent" && task.childThreadId !== undefined
      ? { childThreadId: task.childThreadId }
      : {}),
  }));
  return {
    ...(shell.blockedOnThreadWait === true ? { blockedOnThreadWait: true as const } : {}),
    ...(tasks.length === 0 ? {} : { pendingBackgroundTasks: tasks }),
  };
}

function listItemFromShell(
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadListItem {
  const { settled, settledAt } = threadSettlement(shell);
  const { snoozed, snoozedUntil } = threadSnooze(shell, nowMs);
  // Rows leave out fields with no value: a list of 50 chats repeated them all.
  return {
    ...threadBackgroundWork(shell),
    threadId: shell.id,
    title: shell.title,
    createdBy: shell.createdBy,
    creationSource: shell.creationSource === "workflows" ? "server" : shell.creationSource,
    status: shell.activityRunStatus ?? shell.status,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    ...(shell.linkedPullRequest ? { linkedPullRequest: shell.linkedPullRequest } : {}),
    settled,
    ...(settledAt === null ? {} : { settledAt }),
    snoozed,
    ...(snoozedUntil === null ? {} : { snoozedUntil }),
    ...(shell.pinnedAt == null ? {} : { pinned: true }),
    ...(shell.lineage.parentThreadId === null
      ? {}
      : { parentThreadId: shell.lineage.parentThreadId }),
    ...(shell.lineage.relationshipToParent === null
      ? {}
      : { relationshipToParent: shell.lineage.relationshipToParent }),
    itemCount: shell.visibleItemCount,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

function threadDetail(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  itemCount: number,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadDetail {
  const latest = ThreadManagementService.latestRun(projection);
  const active = ThreadManagementService.latestActiveRun(projection);
  const { settled, settledAt } = threadSettlement(projection.thread);
  // From the shell, like the list, so read and list agree on snooze state.
  const { snoozed, snoozedUntil } = threadSnooze(shell, nowMs);
  const regeneration = projection.thread.titleRegeneration;
  // Like list rows, fields with no value are left out.
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    createdBy: projection.thread.createdBy,
    creationSource:
      projection.thread.creationSource === "workflows"
        ? "server"
        : projection.thread.creationSource,
    status: active?.status ?? latest?.status ?? "idle",
    ...(latest === undefined ? {} : { latestRunId: latest.id }),
    ...(active === undefined ? {} : { activeRunId: active.id }),
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    ...(projection.thread.linkedPullRequest == null
      ? {}
      : { linkedPullRequest: projection.thread.linkedPullRequest }),
    ...(regeneration == null
      ? {}
      : {
          titleRegeneration: {
            requestId: regeneration.requestId,
            startedAt: DateTime.formatIso(regeneration.startedAt),
          },
        }),
    ...(projection.thread.branch === null ? {} : { branch: projection.thread.branch }),
    ...(projection.thread.worktreePath === null
      ? {}
      : { worktreePath: projection.thread.worktreePath }),
    ...(projection.thread.lineage.parentThreadId === null
      ? {}
      : { parentThreadId: projection.thread.lineage.parentThreadId }),
    ...(projection.thread.lineage.relationshipToParent === null
      ? {}
      : { relationshipToParent: projection.thread.lineage.relationshipToParent }),
    runCount: projection.runs.length,
    itemCount,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: projection.thread.archivedAt !== null,
    settled,
    ...(settledAt === null ? {} : { settledAt }),
    snoozed,
    ...(snoozedUntil === null ? {} : { snoozedUntil }),
    ...(shell.pinnedAt == null ? {} : { pinned: true }),
    ...threadBackgroundWork(shell),
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.thread.updatedAt),
  };
}

function threadRun(run: OrchestrationV2Run): OrchestratorMcpThreadRun {
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    requestedAt: DateTime.formatIso(run.requestedAt),
    ...(run.startedAt === null ? {} : { startedAt: DateTime.formatIso(run.startedAt) }),
    ...(run.completedAt === null ? {} : { completedAt: DateTime.formatIso(run.completedAt) }),
  };
}

function jsonText(value: unknown): string {
  try {
    // Item text counts against maxCharsPerItem, so indentation would spend the cap on whitespace.
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function turnItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
      // The text the provider received, context records expanded: a handoff that
      // shortened this item promises the rest can be read back here by its id, and
      // the cut part can be exactly what only the expansion contains.
      return projectComposerContextForProvider({
        text: item.text,
        records: item.context?.records ?? [],
      });
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonText(item.questions);
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`,
        item.diffStr ?? item.newStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "file_search":
      return jsonText({ pattern: item.pattern, results: item.results });
    case "web_search":
      return jsonText({ patterns: item.patterns, results: item.results });
    case "approval_request":
      return item.prompt ?? item.requestKind;
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "thread_created":
      return `Created thread ${item.targetThreadId} with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "secret_request":
      return `Asked the user for ${item.label}: ${item.secretStatus}.`;
    case "subagent":
      // Result first, so a capped read still opens with it. The task follows: a
      // handoff carries both and names the item when it cuts either.
      return [item.result ?? item.progress ?? "No result yet.", `Task: ${item.prompt}`].join(
        "\n\n",
      );
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

function timelineItem(input: {
  readonly row: OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  /** The thread being read; its own items omit sourceThreadId. */
  readonly threadId: ThreadId;
  readonly maxChars: number;
  readonly textOffset?: number;
  readonly messagesByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["messages"]>;
}): OrchestratorMcpThreadTimelineItem {
  const text = turnItemText(input.row.item);
  const offset = input.textOffset ?? 0;
  const end = offset + input.maxChars;
  const textTruncated = text !== null && text.length > end;
  const messageId =
    input.row.item.type === "user_message" || input.row.item.type === "assistant_message"
      ? input.row.item.messageId
      : null;
  const message =
    messageId === null
      ? undefined
      : input.messagesByThreadId
          .get(input.row.sourceThreadId)
          ?.find((candidate) => candidate.id === messageId);
  // Fields with no value are left out: a page repeats them per item.
  return {
    position: input.row.position,
    visibility: input.row.visibility,
    ...(input.row.sourceThreadId === input.threadId
      ? {}
      : { sourceThreadId: input.row.sourceThreadId }),
    itemId: input.row.sourceItemId,
    ...(input.row.item.type === "subagent" ? { subagentId: input.row.item.subagentId } : {}),
    ...(input.row.item.runId === null ? {} : { runId: input.row.item.runId }),
    ...(messageId === null ? {} : { messageId }),
    ...(message === undefined ? {} : { createdBy: message.createdBy }),
    ...(message === undefined
      ? {}
      : {
          creationSource:
            message.creationSource === "workflows" ? ("server" as const) : message.creationSource,
        }),
    type: input.row.item.type,
    status: input.row.item.status,
    ...(input.row.item.title === null ? {} : { title: input.row.item.title }),
    ...(text === null ? {} : { text: text.slice(offset, end) }),
    ...(textTruncated ? { textTruncated: true as const, nextTextOffset: end } : {}),
    updatedAt: DateTime.formatIso(input.row.item.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const workflows = yield* Effect.serviceOption(WorkflowsService.WorkflowsService);
  const monitors = yield* Effect.serviceOption(MonitorService.MonitorService);
  const rankings = yield* Effect.serviceOption(SubagentRankings);
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const usageLimitSources = yield* UsageLimitSources.UsageLimitSources;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const layerScope = yield* Effect.scope;
  const createThreadLock = yield* KeyedLock.make<CommandId>();

  // Settings' grading switch: off drops the rule from agent instructions and
  // ignores grades from clients that still have the field cached.
  // Read in the background: until it lands, or if settings fail, grading stays on.
  let gradingOn = true;
  registerGradingEnabled(() => gradingOn);
  // Null until settings are read: the general rankings rule stays until then.
  let rankedKinds: ReadonlyArray<string> | null = null;
  registerRankedTaskKinds(() => rankedKinds);
  yield* Effect.gen(function* () {
    // Subscribe before the snapshot so a change in between is not lost.
    const changes = yield* serverSettings.subscribeChanges;
    yield* Stream.concat(Stream.fromEffect(serverSettings.getSettings), changes).pipe(
      Stream.runForEach((settings) =>
        Effect.sync(() => {
          gradingOn = settings.subagentGrading;
          rankedKinds = rankedModelRankingKinds(settings.modelRankings);
        }),
      ),
    );
  }).pipe(
    Effect.catchCause(() => Effect.void),
    Effect.forkIn(layerScope),
  );

  // Subagent updates held for an idle parent, kept in memory: they are only
  // progress notes, and each task's result still wakes the parent durably.
  const heldByParent = new Map<ThreadId, ReadonlyArray<HeldParentMessage>>();
  const watchedParents = new Set<ThreadId>();
  const sendingHeldByParent = new Map<ThreadId, ReadonlySet<MessageId>>();
  // The provider credential owns the request namespace and reuses its scope
  // on every call. Its receipts can be collected when the credential is gone.
  const acceptedHeldByScope = new WeakMap<McpInvocationScope, Map<MessageId, ThreadId>>();

  const isPermanentHeldParentError = (error: { readonly _tag: string }) =>
    error._tag === "ThreadManagementThreadNotFoundError" ||
    error._tag === "ThreadManagementThreadArchivedError" ||
    error._tag === "ThreadManagementProviderInstanceDisabledError";

  const deliverHeld = (parentThreadId: ThreadId) =>
    Effect.gen(function* () {
      const held = heldByParent.get(parentThreadId) ?? [];
      const memberIds = new Set(held.map((message) => message.messageId));
      sendingHeldByParent.set(parentThreadId, memberIds);
      const clearBatch = () => {
        const remaining = (heldByParent.get(parentThreadId) ?? []).filter(
          (message) => !memberIds.has(message.messageId),
        );
        if (remaining.length === 0) heldByParent.delete(parentThreadId);
        else heldByParent.set(parentThreadId, remaining);
      };
      yield* Effect.gen(function* () {
        const delivery = yield* combineHeldMessages(parentThreadId, held).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
        );
        if (delivery === null) return;
        yield* Effect.suspend(() =>
          threadManagement.sendToThread({
            projectId: delivery.projectId,
            commandId: delivery.commandId,
            threadId: parentThreadId,
            ...(delivery.senderThreadId === undefined
              ? {}
              : { senderThreadId: delivery.senderThreadId }),
            messageId: delivery.messageId,
            text: delivery.text,
            attachments: [],
            mode: "auto",
            createdBy: "agent",
            creationSource: "mcp",
          }),
        ).pipe(
          Effect.tapError((error) =>
            isPermanentHeldParentError(error)
              ? Effect.void
              : Effect.logWarning("Retrying held subagent updates", { threadId: parentThreadId }),
          ),
          Effect.retry({
            schedule: Schedule.spaced("5 seconds"),
            times: 11,
            while: (error) => !isPermanentHeldParentError(error),
          }),
        );
        // New updates can arrive during dispatch; acknowledge only this accepted batch.
        for (const message of held) message.recordAcceptance?.();
      }).pipe(Effect.ensuring(Effect.sync(clearBatch)));
    }).pipe(
      Effect.ensuring(Effect.sync(() => sendingHeldByParent.delete(parentThreadId))),
      Effect.catchCause((cause) =>
        Effect.logWarning("delivering held subagent updates failed", {
          threadId: parentThreadId,
          cause,
        }),
      ),
    );

  /**
   * Waits for the parent's next running turn, or at most the held-update wait,
   * then sends everything held: steered into the running turn, or waking a
   * parent that is still idle.
   */
  const watchParent = (parentThreadId: ThreadId) =>
    Effect.gen(function* () {
      const afterSequence = yield* threadManagement.getThreadEventSequence(parentThreadId);
      // A turn may have started after the hold was decided but before this cursor.
      const parent = yield* threadManagement.getThreadRecords(parentThreadId, [
        "runs",
        "providerTurns",
      ]);
      if (!hasSteerableTurn(parent)) {
        yield* threadManagement
          .streamStoredEventsFrom({
            threadId: parentThreadId,
            afterSequence,
            eventType: "provider-turn.updated",
          })
          .pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "provider-turn.updated" &&
                stored.event.payload.status === "running",
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.timeoutOption(HELD_PARENT_MESSAGE_MAX_WAIT),
          );
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("watching for a parent's next turn failed", {
          threadId: parentThreadId,
          cause,
        }),
      ),
      Effect.andThen(deliverHeld(parentThreadId)),
    );

  const holdForParent = (parentThreadId: ThreadId, message: HeldParentMessage) =>
    Effect.gen(function* () {
      heldByParent.set(
        parentThreadId,
        addHeldMessage(heldByParent.get(parentThreadId) ?? [], message),
      );
      if (watchedParents.has(parentThreadId)) return;
      watchedParents.add(parentThreadId);
      yield* watchParent(parentThreadId).pipe(
        Effect.repeat({ while: () => heldByParent.has(parentThreadId) }),
        Effect.ensuring(Effect.sync(() => watchedParents.delete(parentThreadId))),
        Effect.forkIn(layerScope),
      );
    });

  /** A caller-named project, which must exist before anything is recorded against it. */
  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read project ${projectId}: ${error.message}`),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(failure("invalid_request", UNKNOWN_PROJECT_MESSAGE)),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** A client has no thread to inherit a model from, so it falls back to the project default. */
  // Resolved like the app does: the project's own choice, else the environment default,
  // else the machine's default harness/model when providers are known.
  const projectDefaultModelSelection = Effect.fn(
    "OrchestratorMcpService.projectDefaultModelSelection",
  )(function* (
    project: Effect.Success<ReturnType<typeof requireProject>>,
    availableProviders?: ReadonlyArray<ServerProvider>,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
    );
    const selection =
      resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ??
      (availableProviders === undefined
        ? null
        : nativeHarnessModelSelection(availableProviders, null));
    if (selection === null)
      return yield* failure(
        "invalid_request",
        `Project ${project.id} has no default model, so this caller cannot pick one for it.`,
      );
    return selection;
  });
  const secretRequests = yield* SecretRequests.SecretRequests;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadProjection = (threadId: ThreadId, includeUserMessages = true) =>
    threadManagement
      .getThreadRecords(
        threadId,
        [
          "runs",
          ...(includeUserMessages ? (["messages"] as const) : []),
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        {
          turnItemTypes: [],
          messageRoles: includeUserMessages ? ["user"] : [],
          unorderedMessages: true,
        },
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadProjectThread = (
    projectId: OrchestrationV2ThreadProjection["thread"]["projectId"],
    threadId: ThreadId,
  ) =>
    threadManagement
      .getProjectThreadRecords(
        { projectId, threadId },
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"], unorderedMessages: true },
      )
      .pipe(Effect.mapError(threadManagementFailure));

  /**
   * The caller's own thread and the most it may hand to threads it targets. A
   * thread caller is capped by its own modes; an OAuth client by the ceiling
   * chosen when it was approved.
   */
  const loadCaller = (scope: McpInvocationScope) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      if (scope.thread === undefined) {
        return {
          parent: undefined,
          limits: {
            runtimeMode: clientRuntimeModeCeiling(scope.client),
            interactionMode: "default",
          } satisfies { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode },
        } as const;
      }
      const parent = yield* loadProjection(scope.thread.threadId, false);
      return {
        parent,
        limits: {
          runtimeMode: parent.thread.runtimeMode,
          interactionMode: parent.thread.interactionMode,
        },
      } as const;
    });

  /** The caller's own thread, for operations that act as the caller. */
  const loadThreadCaller = (scope: McpInvocationScope, operation: string) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const threadScope = yield* requireThreadScope(scope, operation);
      const parent = yield* loadProjection(threadScope.thread.threadId);
      return { scope: threadScope, parent } as const;
    });

  /** A target project: the one passed, else the calling thread's. */
  const resolveProjectTarget = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread"> | undefined,
    projectId: ProjectId | undefined,
  ) =>
    projectId !== undefined
      ? Effect.succeed(projectId)
      : parent !== undefined
        ? Effect.succeed(parent.thread.projectId)
        : Effect.fail(
            failure(
              "target_required",
              "Pass projectId: this MCP client is not running inside a SSHCode thread.",
            ),
          );

  /** Any live thread in the environment. */
  const loadTargetThread = (
    reference: OrchestratorMcpThreadReference,
    includeHistory = true,
    parentThreadId?: ThreadId,
  ) =>
    Effect.gen(function* () {
      const threadId = yield* resolveTaskThreadReference(
        threadManagement,
        parentThreadId,
        reference,
      );
      const shell = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      if (shell === null || shell.deletedAt !== null) {
        return yield* failure("thread_not_found", `Thread ${reference} was not found.`);
      }
      return yield* includeHistory
        ? loadProjectThread(shell.projectId, threadId)
        : threadManagement
            .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [])
            .pipe(
              Effect.map((records) => ({ ...records, runs: [], providerTurns: [] })),
              Effect.mapError(threadManagementFailure),
            );
    });

  const loadScopedThread = (
    scope: McpInvocationScope,
    threadId: OrchestratorMcpThreadReference,
    includeHistory = true,
  ) =>
    Effect.gen(function* () {
      const caller = yield* loadCaller(scope);
      const target =
        caller.parent !== undefined && threadId === caller.parent.thread.id
          ? caller.parent
          : yield* loadTargetThread(threadId, includeHistory, caller.parent?.thread.id);
      return { ...caller, target } as const;
    });

  /**
   * A thread caller writes to another thread only while its own run is live,
   * so a credential that outlived its session cannot reach across threads.
   */
  const assertLiveCallerForOtherThread = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    target: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) =>
    parent === undefined || target.thread.id === parent.thread.id
      ? Effect.void
      : assertLiveCaller(scope, parent);

  /** Scheduled work outside the caller's own project needs the same live run. */
  const assertLiveCallerForOtherProject = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    projectId: ProjectId,
  ) =>
    parent === undefined || projectId === parent.thread.projectId
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCaller = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  ) => {
    const activeRun = ThreadManagementService.latestActiveRun(parent);
    return parent.thread.archivedAt !== null ||
      activeRun === undefined ||
      activeRun.providerInstanceId !== scope.thread?.providerInstanceId
      ? Effect.fail(
          failure("parent_not_active", "The calling provider no longer owns an active thread run."),
        )
      : Effect.void;
  };

  // A background subagent keeps calling tools after the run that started it settles. Its
  // delegations join that latest run, whose completion cohort wakes the thread once they finish.
  const backgroundSubagentRun = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  ) =>
    threadManagement.getThreadShell(parent.thread.id).pipe(
      Effect.mapError(threadManagementFailure),
      Effect.map((shell) =>
        shell === null ||
        shell.archivedAt !== null ||
        shell.activeRunId !== null ||
        shell.latestRunId === null ||
        shell.providerInstanceId !== scope.thread?.providerInstanceId ||
        !hasPendingBackgroundSubagent(shell.pendingBackgroundTasks)
          ? undefined
          : parent.runs.find((run) => run.id === shell.latestRunId),
      ),
    );

  const loadReadableThread = (
    scope: McpInvocationScope,
    reference: OrchestratorMcpThreadReference,
  ) =>
    Effect.gen(function* () {
      const { parent } = yield* loadCaller(scope);
      const threadId = yield* resolveTaskThreadReference(
        threadManagement,
        parent?.thread.id,
        reference,
      );
      const shell = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      if (shell === null || shell.deletedAt !== null) {
        return yield* failure("thread_not_found", `Thread ${reference} is no longer available.`);
      }
      const target = yield* threadManagement
        .getProjectThreadRecords(
          { projectId: shell.projectId, threadId },
          parent === undefined
            ? ["runs", "messages", "runtimeRequests"]
            : ["runs", "messages", "runtimeRequests", "contextTransfers"],
          {
            // Only child-result acknowledgement needs the target's original task messages.
            messageRoles:
              parent !== undefined &&
              shell.lineage.parentEnvironmentId === undefined &&
              shell.lineage.parentThreadId === parent.thread.id &&
              shell.lineage.relationshipToParent === "subagent"
                ? ["user"]
                : [],
          },
        )
        .pipe(Effect.mapError(threadManagementFailure));
      return { parent, target, shell } as const;
    });

  const loadProviders = providerRegistry.getProviders;

  const loadModelPreferences = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.providerModelPreferences ?? {}),
    Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
  );

  // Models the user hid from pickers stay out of the catalog agents choose from.
  const selectableModels = (
    provider: ServerProvider,
    modelPreferences: Effect.Success<typeof loadModelPreferences>,
  ) =>
    provider.models.filter(
      (model) =>
        model.isCustom || !modelPreferences[provider.instanceId]?.hiddenModels.includes(model.slug),
    );

  const loadFavoriteModels = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.favorites ?? []),
    Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
  );

  // Capabilities pages a long catalog, so its first page should hold the
  // models the user picks: favorites in their saved order, then the picker's
  // custom order, then catalog order.
  const orderModelsForListing = <T extends { readonly slug: string }>(
    provider: ServerProvider,
    models: ReadonlyArray<T>,
    modelPreferences: Effect.Success<typeof loadModelPreferences>,
    favorites: Effect.Success<typeof loadFavoriteModels>,
  ): ReadonlyArray<T> => {
    const favoriteRank = new Map(
      favorites
        .filter((favorite) => favorite.provider === provider.instanceId)
        .map((favorite, index) => [favorite.model, index] as const),
    );
    const orderRank = new Map(
      (modelPreferences[provider.instanceId]?.modelOrder ?? []).map(
        (slug, index) => [slug, index] as const,
      ),
    );
    const rank = (ranks: ReadonlyMap<string, number>, slug: string) =>
      ranks.get(slug) ?? Number.POSITIVE_INFINITY;
    return models
      .map((model, index) => ({ model, index }))
      .sort(
        (left, right) =>
          rank(favoriteRank, left.model.slug) - rank(favoriteRank, right.model.slug) ||
          rank(orderRank, left.model.slug) - rank(orderRank, right.model.slug) ||
          left.index - right.index,
      )
      .map(({ model }) => model);
  };

  /**
   * Instance ids the adapter registry resolves — the same lookup a
   * `delegated_task.request` performs when it runs. Capability reporting and
   * target resolution must not advertise a set narrower (or wider) than what
   * dispatch can actually serve.
   */
  const loadOrchestrationCapableInstanceIds = () =>
    providerAdapters.list().pipe(Effect.map((instanceIds) => new Set(instanceIds)));

  const assertTargetEnabledForProject = (
    projectId: ProjectId,
    commandId: CommandId,
    target: ResolvedTarget,
  ) =>
    threadManagement
      .assertProviderInstanceEnabled({
        projectId,
        commandId,
        instanceId: target.modelSelection.instanceId,
      })
      .pipe(Effect.mapError(threadManagementFailure));

  // Provider snapshots can be stale when no client is in the foreground.
  const resolveTargetRechecking = (input: Parameters<typeof resolveTarget>[0]) => {
    const instanceId =
      input.target?.providerInstanceId ??
      (input.target?.driverKind === undefined ? input.defaultSelection?.instanceId : undefined);
    const resolved = resolveTarget(input);
    if (instanceId === undefined) return resolved;
    return resolved.pipe(
      Effect.catchIf(
        (error) => error.code === "provider_unavailable",
        () =>
          providerRegistry
            .refreshInstance(instanceId)
            .pipe(Effect.flatMap((providers) => resolveTarget({ ...input, providers }))),
      ),
    );
  };

  const resolveTarget = (input: {
    readonly projectId: ProjectId;
    readonly defaultSelection: ModelSelection | undefined;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    /**
     * Skips the per-candidate project-enablement check in driver-only
     * resolution. Set only when the command that will dispatch this target
     * already has a receipt: that dispatch can only replay the recorded
     * result, never start anything new, so filtering candidates by the
     * project's current settings would just refuse a retry that does no new
     * work. For the same reason it skips the older-model refusal. Never set
     * this for a resolution whose dispatch uses a different command id than
     * the one checked for a receipt.
     */
    readonly skipProjectEnablementFilter?: boolean;
  }): Effect.Effect<ResolvedTarget, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const requestedInstanceId = input.target?.providerInstanceId;
      const requestedDriver = input.target?.driverKind;
      const inheritedSelection = input.defaultSelection;
      const defaultProvider = input.providers.find(
        (candidate) => candidate.instanceId === inheritedSelection?.instanceId,
      );
      const inheritDriverSelection =
        inheritedSelection !== undefined &&
        (input.target?.model === undefined ||
          input.target.model.trim().toLowerCase() === "default") &&
        requestedDriver === defaultProvider?.driver &&
        defaultProvider?.continuation?.groupKey !== undefined;
      const inheritedSelectionOn = (candidate: ServerProvider) =>
        candidate.instanceId === inheritedSelection?.instanceId ||
        (candidate.driver === defaultProvider?.driver &&
          defaultProvider?.continuation?.groupKey !== undefined &&
          candidate.continuation?.groupKey === defaultProvider.continuation.groupKey)
          ? inheritedSelection
          : undefined;
      // "default" is a sentinel unless this catalog actually lists that slug.
      const requestedModelOn = (candidate: ServerProvider) =>
        input.target?.model?.trim().toLowerCase() === "default" &&
        !candidate.models.some((entry) => entry.slug === input.target?.model)
          ? undefined
          : input.target?.model === undefined
            ? undefined
            : (antigravitySuffixedModel(candidate, input.target.model)?.model ??
              input.target.model);
      const modelOn = (candidate: ServerProvider) =>
        requestedModelOn(candidate) ??
        inheritedSelectionOn(candidate)?.model ??
        candidate.models[0]?.slug;
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
      );
      const acceptsModel = accountAcceptsModel(settings, input.projectId);
      const now = yield* Clock.currentTimeMillis;
      const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
      let instanceId = requestedInstanceId;

      if (instanceId === undefined && requestedDriver !== undefined) {
        const candidates = input.providers.filter(
          (provider) =>
            provider.driver === requestedDriver &&
            orchestrationCapableInstanceIds.has(provider.instanceId),
        );
        if (candidates.length === 0) {
          return yield* failure(
            "provider_unavailable",
            `No V2 provider adapter is registered for driver ${requestedDriver}.`,
          );
        }
        // Inherit the parent's instance only when it can actually serve the
        // child; an unavailable parent yields to a healthy instance of the
        // requested driver rather than failing the delegation. An instance
        // the project turned off cannot serve either, so selection skips it
        // for the next candidate instead of failing the enablement check.
        const readyCandidates = candidates.filter((candidate) => {
          if (providerConstraints(candidate, true).length > 0) return false;
          const modelId = modelOn(candidate);
          if (
            input.skipProjectEnablementFilter !== true &&
            modelId !== undefined &&
            !acceptsModel(candidate, modelId)
          )
            return false;
          if (
            !inheritDriverSelection ||
            requestedModelOn(candidate) !== undefined ||
            input.skipProjectEnablementFilter === true
          )
            return true;
          const model = candidate.models.find((entry) => entry.slug === inheritedSelection.model);
          return (
            candidate.continuation?.groupKey === defaultProvider?.continuation?.groupKey &&
            model !== undefined &&
            invalidOptionSelections(
              input.target?.options ?? inheritedSelection.options ?? [],
              model.capabilities?.optionDescriptors,
            ).length === 0
          );
        });
        const healthy = readyCandidates.filter(
          (candidate) =>
            input.skipProjectEnablementFilter === true ||
            accountUnavailable(candidate, now, modelOn(candidate)) === undefined,
        );
        const healthyCandidates =
          healthy.length > 0
            ? healthy
            : readyCandidates.filter((candidate) => candidate.recentFailure?.outOfCredit);
        // With balancing off, surface the inherited account's refusal to the caller.
        const inheritedCandidate = (
          settings.balanceAccounts ? healthyCandidates : readyCandidates
        ).find((candidate) => candidate.instanceId === inheritedSelection?.instanceId);
        const orderedCandidates = [
          ...(inheritedCandidate === undefined ? [] : [inheritedCandidate]),
          ...healthyCandidates.filter((candidate) => candidate !== inheritedCandidate),
        ];
        for (const candidate of orderedCandidates) {
          const enabledForProject =
            input.skipProjectEnablementFilter === true ||
            (yield* threadManagement.isProviderInstanceEnabledForProject({
              projectId: input.projectId,
              instanceId: candidate.instanceId,
            }));
          if (enabledForProject) {
            instanceId = candidate.instanceId;
            break;
          }
        }
        if (instanceId === undefined) {
          return yield* failure(
            "provider_unavailable",
            healthyCandidates.length === 0
              ? `No available V2 provider instance for driver ${requestedDriver}.${inheritDriverSelection ? ` Inherited model ${inheritedSelection.model} and options require a compatible account in the same group.` : ""}${candidates
                  .map((candidate) => {
                    const account = accountUnavailable(candidate, now, modelOn(candidate));
                    return account
                      ? ` ${candidate.instanceId}: ${account.reason}${account.recheckAt ? ` Recheck ${account.recheckAt}.` : ""}`
                      : "";
                  })
                  .join("")}`
              : `No instance of driver ${requestedDriver} is enabled for this project.`,
          );
        }
      }
      instanceId ??= inheritedSelection?.instanceId;
      if (instanceId === undefined) {
        return yield* failure(
          "invalid_request",
          "Pass a target provider or set a project default model.",
        );
      }

      let provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
      if (provider === undefined) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${instanceId} is not registered.`,
        );
      }
      if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
        return yield* failure(
          "invalid_request",
          `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
        );
      }
      let account = accountUnavailable(provider, now, modelOn(provider));
      const refusal = activeProviderFailure(provider, now, modelOn(provider))?.kind;
      // Running out of credit only warns. A sign-out refuses even once it has no recheck time.
      const accountFailure =
        account !== undefined &&
        input.skipProjectEnablementFilter !== true &&
        (account.recheckAt !== undefined || refusal === "authentication_error")
          ? failure(
              "account_unavailable",
              account.recheckAt === undefined
                ? account.reason
                : `${account.reason} Recheck ${account.recheckAt}.`,
            )
          : undefined;
      if (
        accountFailure &&
        refusal !== "usage_limit" &&
        (refusal !== "authentication_error" || input.target?.providerInstanceId !== undefined)
      ) {
        return yield* accountFailure;
      }
      // Defer usage-limit refusals, and sign-outs on an account the agent did not name, until
      // a sibling can be considered, while preserving the original refusal if the target
      // cannot otherwise resolve.
      const rejectTarget = (code: OrchestratorMcpFailure["code"], message: string) =>
        accountFailure ?? failure(code, message);
      const canBalanceSignedOut =
        settings.balanceAccounts &&
        input.target?.providerInstanceId === undefined &&
        input.target?.userNamedAccount !== true &&
        input.skipProjectEnablementFilter !== true &&
        provider.auth.status === "unauthenticated" &&
        provider.enabled &&
        provider.installed &&
        isProviderAvailable(provider) &&
        orchestrationCapableInstanceIds.has(provider.instanceId) &&
        provider.continuation?.groupKey !== undefined;
      let deferredFailure: OrchestratorMcpFailure | undefined;
      const constraints = providerConstraints(
        provider,
        orchestrationCapableInstanceIds.has(provider.instanceId),
      );
      if (constraints.length > 0) {
        const constraintFailure = rejectTarget(
          "provider_unavailable",
          `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
        );
        if (!canBalanceSignedOut) {
          return yield* constraintFailure;
        }
        deferredFailure = constraintFailure;
      }

      const providerSelection = inheritedSelectionOn(provider);
      const requestedModel = requestedModelOn(provider);
      const model = modelOn(provider);
      if (model === undefined) {
        return yield* (
          deferredFailure ??
            rejectTarget(
              "model_unavailable",
              `Provider ${instanceId} has no model available for inheritance.`,
            )
        );
      }
      const advertised = provider.models.find((candidate) => candidate.slug === model);
      // A recorded retry does no new work. An empty catalog may also represent
      // a harness with user-supplied custom IDs, but that requires an exact
      // user request, never implicit inheritance of an unknown parent model.
      const explicitCustom =
        provider.models.length === 0 &&
        requestedModel !== undefined &&
        input.target?.userNamedModel === true;
      if (
        !advertised &&
        !explicitCustom &&
        input.skipProjectEnablementFilter !== true &&
        !(canBalanceSignedOut && provider.models.length === 0)
      ) {
        // A model the installed CLI is too old for: retrying another slug will not help.
        const updateRequired = provider.updateRequiredModels?.find(
          (candidate) => candidate.slug === model,
        );
        if (updateRequired !== undefined) {
          const withV = (version: string) => (version.startsWith("v") ? version : `v${version}`);
          return yield* rejectTarget(
            "model_unavailable",
            `Model ${model} needs provider ${instanceId} at ${withV(updateRequired.minVersion)} or newer, but the detected CLI is ${provider.version === null ? "an unknown version" : withV(provider.version)}. Ask the user to update it or point the provider's binary path at a newer install.`,
          );
        }
        return yield* rejectTarget(
          "model_unavailable",
          `Model ${model} is unavailable on ${instanceId}.${advertisedModelsHint(provider.models, model)} Use an exact orchestrator_capabilities id, including for inheritance. Empty catalogs allow custom ids only if user-named with target.userNamedModel:true.`,
        );
      }
      const supersessions =
        input.target?.userNamedModel !== true && input.skipProjectEnablementFilter !== true
          ? modelFamilySupersessions(input.providers)
          : undefined;
      if (input.target?.userNamedModel !== true && input.skipProjectEnablementFilter !== true) {
        const newer = supersessions?.get(modelRankingSelectionKey({ instanceId, model }));
        const gone = advertised?.unavailableReason;
        if (gone !== undefined) {
          return yield* rejectTarget(
            "model_unavailable",
            `${model} on ${instanceId} failed as gone: ${gone} Choose a current model. Pass target.userNamedModel: true only if the user asked for ${model} by name.`,
          );
        }
        if (newer !== undefined || advertised?.isLegacy) {
          return yield* rejectTarget(
            "model_unavailable",
            `${model} is ${newer ? `an older version of ${newer.model} on ${newer.instanceId}; use ${newer.model}` : `a legacy model on ${instanceId}; choose a current model`}. Retry the current model or pick another current line or provider if unavailable. An older-version exception requires a concrete valid reason. Pass target.userNamedModel: true only when the user asked for ${model} by name, and explain that exact request.`,
          );
        }
      }

      const suffixThinking =
        input.target?.model === undefined
          ? undefined
          : antigravitySuffixedModel(provider, input.target.model)?.thinking;
      const inheritedOptions =
        model === providerSelection?.model ? providerSelection.options : undefined;
      // The suffix's level joins the inherited options; explicit options override it, and an
      // explicit empty list clears it too.
      const requestedOptions =
        suffixThinking === undefined
          ? (input.target?.options ?? inheritedOptions)
          : input.target?.options?.length === 0
            ? []
            : [
                ...new Map(
                  [
                    ...(input.target?.options === undefined ? (inheritedOptions ?? []) : []),
                    suffixThinking,
                    ...(input.target?.options ?? []),
                  ].map((selection) => [selection.id, selection]),
                ).values(),
              ];
      if (requestedOptions !== undefined) {
        const descriptors = provider.models.find((candidate) => candidate.slug === model)
          ?.capabilities?.optionDescriptors;
        const invalid = invalidOptionSelections(requestedOptions, descriptors);
        if (invalid.length > 0) {
          return yield* rejectTarget(
            "invalid_request",
            `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
          );
        }
      }

      let modelSelection: ModelSelection =
        model === providerSelection?.model &&
        input.target?.options === undefined &&
        suffixThinking === undefined
          ? { ...providerSelection, instanceId }
          : requestedOptions === undefined
            ? { instanceId, model }
            : { instanceId, model, options: requestedOptions };
      let planNotice: string | undefined;
      if (
        settings.balanceAccounts &&
        input.target?.userNamedAccount !== true &&
        input.skipProjectEnablementFilter !== true &&
        (account === undefined || accountFailure !== undefined)
      ) {
        // Filter before asking for a tip so an ineligible account with the most
        // room cannot hide another usable sibling. Keep the original model/options.
        const eligible = [provider];
        for (const candidate of input.providers) {
          const candidateModel = candidate.models.find((entry) => entry.slug === model);
          if (
            candidate.instanceId === instanceId ||
            candidate.driver !== provider.driver ||
            provider.continuation?.groupKey === undefined ||
            candidate.continuation?.groupKey !== provider.continuation.groupKey ||
            providerConstraints(
              candidate,
              orchestrationCapableInstanceIds.has(candidate.instanceId),
            ).length > 0 ||
            accountUnavailable(candidate, now, model) !== undefined ||
            candidateModel === undefined ||
            !acceptsModel(candidate, model) ||
            (input.target?.userNamedModel !== true &&
              (candidateModel.unavailableReason !== undefined ||
                candidateModel.isLegacy ||
                supersessions?.has(
                  modelRankingSelectionKey({ instanceId: candidate.instanceId, model }),
                ))) ||
            (modelSelection.options !== undefined &&
              invalidOptionSelections(
                modelSelection.options,
                candidateModel.capabilities?.optionDescriptors,
              ).length > 0)
          )
            continue;
          if (
            yield* threadManagement.isProviderInstanceEnabledForProject({
              projectId: input.projectId,
              instanceId: candidate.instanceId,
            })
          )
            eligible.push(candidate);
        }
        const moved = preferSiblingAccount({
          current: provider,
          candidates: eligible.slice(1),
          model,
          options: modelSelection.options,
          limitReached: accountFailure !== undefined && refusal === "usage_limit",
          named: input.target?.providerInstanceId !== undefined,
          balance: settings.balanceAccounts,
          now,
        });
        if (moved) {
          planNotice = moved.notice;
          provider = moved.provider;
          instanceId = moved.provider.instanceId;
          account = undefined;
          deferredFailure = undefined;
          modelSelection = { ...modelSelection, instanceId };
        }
      }
      if (deferredFailure) return yield* deferredFailure;
      if (accountFailure && account !== undefined) return yield* accountFailure;
      // An inherited selection can carry the option too, so the resolved one is what counts.
      const modelFailure = (yield* providerRegistry.getModelFailures).get(
        modelRankingSelectionKey({ instanceId, model }),
      );
      const notice = [
        planNotice,
        provider.recentFailure?.outOfCredit && account ? account.reason : undefined,
        modelFailure === undefined ? undefined : modelFailureNotice(model, modelFailure),
        trainingNotice(provider, modelSelection),
      ]
        .filter((part) => part !== undefined)
        .join(" ");
      return {
        modelSelection,
        ...(notice.length > 0 ? { notice } : {}),
        supportedRuntimeModes: provider.supportedRuntimeModes,
      };
    });

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined
      ? crypto.randomUUIDv4().pipe(Effect.orDie)
      : Effect.succeed(clientRequestId);

  const readTaskDetails = (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
    acknowledgeTerminal = false,
    acknowledgementOperation = "task-status-acknowledge",
  ): Effect.Effect<
    { readonly task: DelegateTaskDetails; readonly hasAssistantOutput: boolean },
    OrchestratorMcpFailure
  > =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const parentProjection = yield* threadManagement
        .getThreadRecords(scope.thread.threadId, ["runs", "subagents", "contextTransfers"])
        .pipe(Effect.mapError(threadManagementFailure));
      const owned = parentProjection.subagents.filter(
        (candidate) =>
          candidate.origin === "app_owned" && candidate.threadId === scope.thread.threadId,
      );
      const task = resolveTaskReference(owned, taskId);
      if (task === undefined || task.childThreadId === null) {
        const suggested = owned
          .filter((candidate) => candidate.childThreadId !== null)
          .slice(-5)
          .map((candidate) => taskReference(candidate.id));
        return yield* failure(
          "task_not_found",
          `Unknown or ambiguous task. Use a returned taskId, full id, or unique clientRequestId. ${
            suggested.length > 0
              ? `Available taskIds: ${suggested.join(", ")}.`
              : "No tasks in this thread."
          } Other chats: t3_thread_read(childThreadId).`,
        );
      }
      const childControls = yield* threadManagement
        .getThreadRecords(
          task.childThreadId,
          [
            "runs",
            "messages",
            "contextTransfers",
            "subagents",
            "providerThreads",
            "runtimeRequests",
          ],
          { messageRoles: ["user"] },
        )
        .pipe(Effect.mapError(threadManagementFailure));
      const childRun = delegatedTaskRun(childControls, task);
      const progress = delegatedTaskProgressForTask(
        childControls,
        task,
        Option.isSome(monitors) && monitors.value.hasOpenWork(task.childThreadId),
      );
      const taskResultRun = progress.resultRun;
      const taskWorkState = progress.state;
      // A restart cut the child's run and its continuation has not settled, or
      // the child started working again after this read.
      const heldForRestart =
        task.result === null &&
        taskWorkState === "result_available" &&
        (yield* threadManagement
          .delegatedTaskResultPending(task.childThreadId, task.id)
          .pipe(Effect.mapError(threadManagementFailure)));
      // Nothing holds the task any more, yet its record still shows it running, as a task
      // an earlier build left behind does. Settle it, so the parent's chat stops waiting on it.
      if (
        task.result === null &&
        taskWorkState === "result_available" &&
        !heldForRestart &&
        isOrchestrationV2WorkActive(task.status)
      ) {
        yield* threadManagement.recoverDelegatedTask(task.childThreadId);
      }
      const terminalRun = latestTerminalResultRun(
        childControls,
        childRun,
        heldForRestart ? taskResultRun : undefined,
      );
      const resultRunIds = [
        ...new Set(
          [
            taskResultRun?.id,
            terminalRun?.id,
            ...(task.status === "failed" || taskResultRun?.status === "failed"
              ? progress.runs.map((run) => run.id)
              : []),
          ].filter((id): id is RunId => id !== undefined),
        ),
      ];
      const resultRecords = yield* threadManagement
        .getThreadRecords(task.childThreadId, ["messages", "turnItems"], {
          messageRoles: ["assistant"],
          messageRunIds: resultRunIds,
          turnItemRunIds: resultRunIds,
          turnItemTypes: ["assistant_message", "error"],
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const childProjection = {
        ...childControls,
        messages: [...childControls.messages, ...resultRecords.messages],
        turnItems: resultRecords.turnItems,
      };
      const workState =
        task.result !== null ? "result_available" : heldForRestart ? "working" : taskWorkState;
      const runStatus = taskStatusForRun(taskResultRun ?? childRun);
      const status =
        task.result === null && childRun?.status === "queued" && childRun.queueHeld === true
          ? "held"
          : task.result !== null
            ? taskStatusForRun(
                task.status === "completed" ||
                  task.status === "failed" ||
                  task.status === "cancelled" ||
                  task.status === "interrupted"
                  ? { status: task.status }
                  : childRun,
              )
            : workState === "result_available"
              ? runStatus
              : runStatus === "queued" || runStatus === "starting"
                ? runStatus
                : "running";
      const derivedResult =
        task.result !== null
          ? task.result
          : taskResultRun !== undefined && isTerminalTaskStatus(status)
            ? subagentResultForRun(childProjection, taskResultRun).text
            : null;
      const resultTransfers = parentProjection.contextTransfers.filter(
        (transfer) =>
          transfer.type === "subagent_result" &&
          transfer.sourceThreadId === task.childThreadId &&
          transfer.targetThreadId === scope.thread.threadId,
      );
      const resultTransferForRun = (run: OrchestrationV2Run | undefined) =>
        !canExposeTaskRunResult(run)
          ? null
          : (resultTransfers.find((transfer) => transfer.sourcePoint.runId === run.id) ??
            (run.id === childRun?.id
              ? resultTransfers.find((transfer) => transfer.sourcePoint.runId === undefined)
              : undefined) ??
            null);
      const resultTransfer = taskResultTransfer(parentProjection, childProjection, task) ?? null;
      const terminalStatus = terminalRun === undefined ? null : taskStatusForRun(terminalRun);
      const failureItem =
        status === "failed"
          ? resultRecords.turnItems.findLast(
              (item) =>
                item.type === "error" &&
                item.status === "failed" &&
                item.runId === (taskResultRun ?? childRun)?.id,
            )
          : undefined;
      const latestTerminalTransferId = resultTransferForRun(terminalRun)?.id;
      const pendingRuntimeRequests = childControls.runtimeRequests.filter(
        (request) => request.status === "pending",
      );
      const pendingRequests = pendingTaskRequests({
        runtimeRequests: childControls.runtimeRequests,
        turnItems:
          pendingRuntimeRequests.length > 0
            ? (yield* threadManagement
                .getThreadRecords(task.childThreadId, ["turnItems"], {
                  turnItemNodeIds: [
                    ...new Set(pendingRuntimeRequests.map((request) => request.nodeId)),
                  ],
                  turnItemTypes: ["user_input_request", "approval_request"],
                })
                .pipe(Effect.mapError(threadManagementFailure))).turnItems
            : [],
      });
      const latestTerminalText =
        canExposeTaskRunResult(terminalRun) && terminalRun.id !== childRun?.id
          ? subagentResultForRun(childProjection, terminalRun).text
          : null;
      const pendingChildRuns = hasPendingChildRuns(childProjection, childRun);
      const pendingQuestion = childControls.runtimeRequests.some(
        (request) =>
          request.kind === "user_input" &&
          request.status === "pending" &&
          request.responseCapability.type === "live",
      );
      // Fields with no value are left out: every poll re-reads this result.
      const response = {
        ...(pendingRequests.length === 0 ? {} : { pendingRequests }),
        taskId: task.id,
        childThreadId: task.childThreadId,
        childRunId: childRun?.id ?? null,
        status,
        workState,
        ...(pendingChildRuns ? { hasPendingChildRuns: true as const } : {}),
        providerInstanceId: task.providerInstanceId,
        ...(task.model === null ? {} : { model: task.model }),
        ...(derivedResult === null ? {} : { summary: derivedResult }),
        // Computed once at finish from the app's records, so the lead need not redo checks.
        ...(task.seen === undefined ? {} : { seen: task.seen }),
        ...(failureItem?.type === "error" ? { failure: failureItem.failure } : {}),
        // Where the child's commits are, once its own worktree exists.
        ...(childControls.thread.worktreePath !== null &&
        childControls.thread.worktreePath !== parentProjection.thread.worktreePath
          ? {
              worktree: {
                path: childControls.thread.worktreePath,
                branch: childControls.thread.branch,
              },
            }
          : {}),
        ...(resultTransfer === null ? {} : { resultContextTransferId: resultTransfer.id }),
        // The long ids are left out where they repeat another field.
        ...(terminalRun !== undefined && terminalRun.id !== childRun?.id
          ? { latestTerminalRunId: terminalRun.id }
          : {}),
        ...(terminalStatus !== null && isTerminalTaskStatus(terminalStatus)
          ? { latestTerminalStatus: terminalStatus }
          : {}),
        ...(latestTerminalText === null || latestTerminalText === derivedResult
          ? {}
          : { latestTerminalSummary: latestTerminalText }),
        ...(latestTerminalTransferId !== undefined &&
        latestTerminalTransferId !== resultTransfer?.id
          ? { latestTerminalResultContextTransferId: latestTerminalTransferId }
          : {}),
        ...(pendingQuestion ? { hasPendingQuestion: true as const } : {}),
        ...(waitTimedOut ? { waitTimedOut: true as const } : {}),
      } satisfies DelegateTaskDetails;
      if (
        acknowledgeTerminal &&
        isTerminalTaskStatus(status) &&
        task.completionDelivery?.state !== "acknowledged" &&
        task.completionDelivery?.state !== "disposed"
      ) {
        // Only a live turn of the calling provider reads the result.
        const observingRun = ThreadManagementService.latestActiveRun({
          runs: parentProjection.runs.filter(
            (run) => run.providerInstanceId === scope.thread.providerInstanceId,
          ),
        });
        const acknowledgementRequestKey = yield* requestKey(undefined);
        yield* threadManagement
          .dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: stableCommandId({
              scope,
              requestKey: acknowledgementRequestKey,
              operation: acknowledgementOperation,
            }),
            parentThreadId: scope.thread.threadId,
            taskId: task.id,
            observedByRunId: observingRun?.id ?? null,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Unable to acknowledge delegated task ${task.id}: ${errorMessage(error)}`,
              ),
            ),
          );
      }
      const taskRunIds = new Set(progress.runs.map((run) => run.id));
      return {
        task: response,
        hasAssistantOutput:
          resultRecords.messages.some(
            (message) =>
              message.runId !== null &&
              taskRunIds.has(message.runId) &&
              message.role === "assistant" &&
              Boolean(message.text.trim()),
          ) ||
          (resultRecords.turnItems ?? []).some(
            (item) =>
              item.runId !== null &&
              taskRunIds.has(item.runId) &&
              item.type === "assistant_message" &&
              Boolean(item.text.trim()),
          ),
      };
    });

  const readTask = (...args: Parameters<typeof readTaskDetails>) =>
    readTaskDetails(...args).pipe(Effect.map(({ task }) => task));

  // Re-read the task only when an event on the parent or child thread can
  // change its status, instead of polling the projections every 50 ms.
  const waitForTask = (scope: McpThreadInvocationScope, taskId: NodeId, timeoutMs: number) =>
    Effect.gen(function* () {
      const streamError = (error: unknown) =>
        failure(
          "orchestration_error",
          `Unable to watch delegated task ${taskId}: ${errorMessage(error)}`,
        );
      // Sequences are global, so one cursor taken before the first read
      // replays anything either thread records after it.
      const afterSequence = yield* threadManagement
        .getThreadEventSequence(scope.thread.threadId)
        .pipe(Effect.mapError(streamError));
      const initial = yield* readTask(scope, taskId, false, true);
      if (initial.hasPendingQuestion || isTerminalTaskStatus(initial.status)) {
        return Option.some(initial);
      }
      // One stream per event type, so transcript events never fill a buffer.
      return yield* Stream.mergeAll(
        TASK_WAKE_EVENTS.map(({ thread, eventType }) =>
          threadManagement
            .streamStoredEventsFrom({
              threadId: thread === "parent" ? scope.thread.threadId : initial.childThreadId,
              afterSequence,
              eventType,
            })
            .pipe(
              Stream.filter(
                ({ event }) =>
                  thread === "child" ||
                  event.type !== "subagent.updated" ||
                  event.payload.id === initial.taskId,
              ),
            ),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(streamError),
        Stream.mapEffect(() => readTask(scope, taskId, false, true)),
        Stream.filter((result) => result.hasPendingQuestion || isTerminalTaskStatus(result.status)),
        Stream.runHead,
      );
    }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.map(Option.flatten));

  /**
   * The modes a task's runs execute at: its own, or for a task bound to a
   * thread, also that thread's modes as they are now, since its runs are
   * messages to that thread.
   */
  const scheduledTaskRunModes = (task: ScheduledTask) =>
    Effect.gen(function* () {
      const modes = [{ runtimeMode: task.runtimeMode, interactionMode: task.interactionMode }];
      if (task.threadId === null) return modes;
      const bound = yield* threadManagement
        .getThreadShell(task.threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      return bound === null || bound.deletedAt !== null ? modes : [...modes, bound];
    });

  const withinLimits = (
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
    modes: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ) =>
    runtimeModeRank(modes.runtimeMode) <= runtimeModeRank(limits.runtimeMode) &&
    interactionModeRank(modes.interactionMode) <= interactionModeRank(limits.interactionMode);

  /**
   * Creation returns a webhook URL only to callers allowed to start its runs: never a read-only
   * client, and a thread caller only with a live turn at modes covering every mode the task runs at.
   */
  const summarizeScheduledTask = (
    scope: McpInvocationScope,
    caller: {
      readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined;
      readonly limits: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      };
    },
    task: ScheduledTask,
  ) =>
    Effect.gen(function* () {
      const live =
        caller.parent === undefined
          ? scope.client?.access !== "read-only"
          : Exit.isSuccess(yield* Effect.exit(assertLiveCaller(scope, caller.parent)));
      // This runs after a save, so a failed lookup of the bound thread hides
      // the webhook URL instead of reporting a saved task as an error.
      const modes = yield* scheduledTaskRunModes(task).pipe(Effect.option);
      return scheduledTaskSummary(
        task,
        live &&
          Option.isSome(modes) &&
          modes.value.every((mode) => withinLimits(caller.limits, mode)),
      );
    });

  /**
   * A scheduled task the caller may change: one whose runs execute at modes no
   * broader than the caller's own, so editing its prompt cannot run work above
   * the caller's limits.
   */
  const loadScheduledTask = (
    scheduledTaskId: ScheduledTask["id"],
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ): Effect.Effect<ScheduledTask, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const { tasks } = yield* scheduledTasks
        .list()
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not load scheduled task: ${error.message}`),
          ),
        );
      const task = tasks.find((candidate) => candidate.id === scheduledTaskId);
      if (task === undefined) {
        return yield* failure("task_not_found", `Scheduled task ${scheduledTaskId} was not found.`);
      }
      for (const modes of yield* scheduledTaskRunModes(task)) {
        yield* resolveRuntimeMode(limits.runtimeMode, modes.runtimeMode);
        yield* resolveInteractionMode(limits.interactionMode, modes.interactionMode);
      }
      return task;
    });

  const upgradeTaskWake = (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    key: string,
    operation = "delegate-task-wake-policy",
  ) =>
    threadManagement
      .dispatch({
        type: "delegated_task.wake-policy",
        commandId: stableCommandId({
          scope,
          requestKey: key,
          operation,
        }),
        parentThreadId: scope.thread.threadId,
        taskId,
        completionWake: "always",
      })
      .pipe(
        // The tool result still returns after a timeout or question, so failures
        // stay warnings. Keep the two shapes apart: a rejected receipt
        // means this exact command id already failed (a replay of a
        // no-op upgrade), while anything else is a fresh dispatch fault.
        Effect.catch((error) =>
          Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
            taskId,
            outcome:
              error._tag === "OrchestratorCommandPreviouslyRejectedError"
                ? "previously_rejected"
                : "dispatch_failed",
            error,
          }),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
            taskId,
            outcome: "defect",
            cause,
          }),
        ),
      );

  const watchedThreadCompletions = new Set<string>();
  const wakeAfterThread = (
    scope: McpThreadInvocationScope,
    projectId: ProjectId,
    target: { threadId: ThreadId; runId: RunId },
  ) =>
    Effect.gen(function* () {
      const watchKey = [scope.thread.threadId, target.threadId, target.runId]
        .map(encodeRequestPart)
        .join(":");
      if (watchedThreadCompletions.has(watchKey)) return;
      watchedThreadCompletions.add(watchKey);
      yield* Effect.gen(function* () {
        let result: ThreadManagementService.ThreadManagementWaitResult;
        do {
          result = yield* threadManagement.waitForThread({
            ...target,
            projectId,
            timeoutMs: MAX_WAIT_TIMEOUT_MS,
          });
        } while (result.timedOut);
        const run = result.run;
        if (run === null) return;
        const caller = yield* threadManagement.getThreadShell(scope.thread.threadId);
        if (caller === null || caller.deletedAt !== null) return;
        const send = (mode: "steer" | "auto") =>
          threadManagement.sendToThread({
            projectId: caller.projectId,
            threadId: caller.id,
            commandId: stableCommandId({
              scope,
              requestKey: watchKey,
              operation: "thread-wait-completed",
            }),
            messageId: stableOperationMessageId({
              scope,
              requestKey: watchKey,
              operation: "thread-wait-completed",
            }),
            text: `Thread ${target.threadId} ${runOutcome(run)}. Read it with t3_thread_read.`,
            attachments: [],
            mode,
            createdBy: "system",
            creationSource: "mcp",
          });
        yield* send("steer").pipe(
          Effect.catchTags({
            ThreadManagementNoSteerableRunError: () => send("auto"),
          }),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestrator-mcp.thread-wait.wake-failed", {
            threadId: target.threadId,
            cause,
          }),
        ),
        Effect.ensuring(Effect.sync(() => watchedThreadCompletions.delete(watchKey))),
        Effect.interruptible,
        Effect.forkIn(layerScope),
      );
    }).pipe(Effect.uninterruptible);

  const repeatTaskChecks = makeRepeatChecks();
  const service = {
    scheduleTask: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        const projectId = yield* resolveProjectTarget(parent, input.projectId);
        yield* assertLiveCallerForOtherProject(scope, parent, projectId);
        const project = yield* requireProject(projectId);
        // Binding means "wake this thread", which only a thread caller in that project has.
        const bindToCurrentThread =
          input.bindToCurrentThread ??
          (parent !== undefined && parent.thread.projectId === projectId);
        if (
          bindToCurrentThread &&
          (parent === undefined || parent.thread.projectId !== projectId)
        ) {
          return yield* failure(
            "invalid_request",
            parent === undefined
              ? "bindToCurrentThread needs an agent running inside a SSHCode thread."
              : "bindToCurrentThread binds to this thread, which belongs to a different project.",
          );
        }
        const modelSelection =
          parent?.thread.modelSelection ?? (yield* projectDefaultModelSelection(project));
        const derivedTitle = input.prompt.split("\n")[0]?.trim() ?? "";
        const title =
          input.title ?? (derivedTitle.length > 0 ? derivedTitle.slice(0, 80) : "Scheduled task");
        const upsertInput: ScheduledTaskUpsertInput = {
          title,
          prompt: input.prompt,
          enabled: input.enabled ?? true,
          schedule: input.schedule,
          projectId,
          threadId: bindToCurrentThread && parent !== undefined ? parent.thread.id : null,
          workspaceStrategy: scheduledTaskWorkspaceStrategy(bindToCurrentThread),
          modelSelection,
          runtimeMode: limits.runtimeMode,
          interactionMode: limits.interactionMode,
          createdBy: "agent",
          creationSource: "mcp",
          // Scope the idempotency key by provider session so two callers
          // reusing the same clientRequestId cannot collide on one task row.
          ...(input.clientRequestId === undefined
            ? {}
            : {
                commandId: stableCommandId({
                  scope,
                  requestKey: input.clientRequestId,
                  operation: "schedule-task",
                }),
              }),
        };
        const { task } = yield* scheduledTasks
          .upsert(upsertInput)
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not schedule task: ${error.message}`),
            ),
          );
        return yield* summarizeScheduledTask(scope, { parent, limits }, task);
      }),
    listScheduledTaskRuns: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        const task = yield* loadScheduledTask(input.id, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, task.projectId);
        return yield* scheduledTasks
          .listRuns(input)
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
      }),
    previewScheduledTaskWebhook: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        const task = yield* loadScheduledTask(input.id, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, task.projectId);
        return yield* scheduledTasks
          .previewWebhook(input)
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
      }),
    listScheduledTasks: (scope, input) =>
      Effect.gen(function* () {
        const { parent } = yield* loadCaller(scope);
        const projectId = input.projectId ?? parent?.thread.projectId;
        const { tasks } = yield* scheduledTasks
          .list()
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
            ),
          );
        // Webhook URLs are bearer secrets: only creation returns one.
        return {
          tasks: tasks
            .filter(
              (task) =>
                (projectId === undefined || task.projectId === projectId) &&
                (input.scheduledTaskId === undefined || task.id === input.scheduledTaskId),
            )
            .map((task) => scheduledTaskSummary(task, false)),
        };
      }),
    updateScheduledTask: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        if (
          input.bindToCurrentThread === true &&
          (parent === undefined || parent.thread.projectId !== existing.projectId)
        ) {
          return yield* failure(
            "invalid_request",
            parent === undefined
              ? "bindToCurrentThread needs an agent running inside a SSHCode thread."
              : "bindToCurrentThread binds to this thread, which belongs to a different project.",
          );
        }
        const threadId =
          input.bindToCurrentThread === undefined
            ? existing.threadId
            : input.bindToCurrentThread && parent !== undefined
              ? parent.thread.id
              : null;
        // Only a binding change should reset where runs execute; edits keep saved checkout choices.
        const workspaceStrategy =
          (threadId === null) === (existing.threadId === null)
            ? existing.workspaceStrategy
            : scheduledTaskWorkspaceStrategy(threadId !== null);
        const upsertInput: ScheduledTaskUpsertInput = {
          id: existing.id,
          requireExisting: true,
          title: input.title ?? existing.title,
          prompt: input.prompt ?? existing.prompt,
          enabled: input.enabled ?? existing.enabled,
          schedule: input.schedule ?? existing.schedule,
          projectId: existing.projectId,
          threadId,
          workspaceStrategy,
          modelSelection: existing.modelSelection,
          ...(existing.accountPinned === true ? { accountPinned: true } : {}),
          runtimeMode: existing.runtimeMode,
          interactionMode: existing.interactionMode,
          createdBy: existing.createdBy,
          creationSource:
            existing.creationSource === "workflows" ? "server" : existing.creationSource,
        };
        const { task } = yield* scheduledTasks
          .upsert(upsertInput)
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not update scheduled task: ${error.message}`),
            ),
          );
        return scheduledTaskSummary(task, false);
      }),
    deleteScheduledTask: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        yield* scheduledTasks
          .delete({ id: existing.id })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not delete scheduled task: ${error.message}`),
            ),
          );
        return { scheduledTaskId: existing.id, deleted: true };
      }),
    askUser: (scope, input) =>
      Effect.gen(function* () {
        // The card is shown in, and answered from, the caller's own thread.
        const { scope: threadScope, parent } = yield* loadThreadCaller(scope, "ask_user");
        const threadId = threadScope.thread.threadId;
        const run = ThreadManagementService.latestActiveRun(parent);
        if (
          run === undefined ||
          run.rootNodeId === null ||
          run.providerInstanceId !== threadScope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Asking the user requires an active run owned by this MCP provider session.",
          );
        }
        const key = yield* requestKey(input.clientRequestId);
        const requestId = RuntimeRequestId.make(
          `runtime-request:ask-user:${encodeRequestPart(threadId)}:${encodeRequestPart(key)}`,
        );
        yield* threadManagement
          .dispatch({
            type: "user_question.ask",
            commandId: stableCommandId({ scope, requestKey: key, operation: "ask-user" }),
            threadId,
            runId: run.id,
            nodeId: run.rootNodeId,
            requestId,
            turnItemId: TurnItemId.make(
              `turn-item:ask-user:${encodeRequestPart(threadId)}:${encodeRequestPart(key)}`,
            ),
            questions: input.questions.map((question, index) => ({
              id: `q${index + 1}`,
              header: question.header ?? "Question",
              question: question.question,
              options: (question.options ?? []).map((option) => ({
                label: option.label,
                description: option.description ?? option.label,
              })),
              ...(question.multiSelect === undefined ? {} : { multiSelect: question.multiSelect }),
              ...(question.important === true ? { waitsForUser: true } : {}),
              allowCustomAnswer: true,
            })),
          })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not show the question: ${errorMessage(error)}`),
            ),
          );
        return {
          status: "asked" as const,
          requestId,
          note: "The user sees the question now. Keep working on what you can; their answer arrives as a new user message, possibly while you work. Unless a question is important, if they haven't answered within 10 minutes your recommended option is chosen for them and arrives as their answer.",
        };
      }),
    requestSecret: (scope, input) =>
      Effect.gen(function* () {
        // The card is shown in, and answered from, the caller's own thread.
        const { scope: threadScope, parent } = yield* loadThreadCaller(scope, "request_secret");
        const threadId = threadScope.thread.threadId;
        const run = ThreadManagementService.latestActiveRun(parent);
        if (
          run === undefined ||
          run.rootNodeId === null ||
          run.providerInstanceId !== threadScope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Asking for a secret requires an active run owned by this MCP provider session.",
          );
        }
        const key = yield* requestKey(input.clientRequestId);
        const turnItemId = TurnItemId.make(
          `${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}${input.apiKey === undefined ? "" : "api-key:"}${encodeRequestPart(threadId)}:${encodeRequestPart(key)}`,
        );
        const records = yield* threadManagement
          .getThreadRecords(threadId, ["turnItems"], {
            turnItemIds: [turnItemId],
            turnItemTypes: ["secret_request"],
            messageRoles: [],
          })
          .pipe(Effect.mapError((error) => failure("orchestration_error", errorMessage(error))));
        const existing = records.turnItems.find((item) => item.id === turnItemId);
        if (existing === undefined) {
          yield* threadManagement
            .dispatch({
              type: "secret_request.record",
              commandId: stableCommandId({ scope, requestKey: key, operation: "secret-pending" }),
              threadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              turnItemId,
              label: input.label,
              reason: input.reason,
              ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
              ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
              ...(input.apiKey === undefined && input.delivery === "file"
                ? { delivery: "file" as const }
                : {}),
              secretStatus: "pending",
            })
            .pipe(Effect.mapError((error) => failure("orchestration_error", errorMessage(error))));
        }
        const status = existing?.type === "secret_request" ? existing.secretStatus : "pending";
        const resultStatus = status === "pending" ? "asked" : status;
        yield* Effect.annotateCurrentSpan({ "secret_request.status": resultStatus });
        yield* Metrics.increment(Metrics.secretRequestsTotal, { status: resultStatus });
        if (status === "pending")
          return {
            status: "asked" as const,
            clientRequestId: key,
            note: "The user sees the card. Keep working on what you can; a message arrives when they save or decline.",
          };
        if (status !== "saved") return { status };
        if (existing?.type === "secret_request" && existing.apiKey !== undefined)
          return {
            status: "api_key_saved" as const,
            note: "API key saved privately. Call list_api_keys to check availability, then prepare_api_key to get a one-use sshcode secret run command. Never ask for the value in chat.",
          };
        if (existing?.type === "secret_request" && existing.delivery === "file") {
          const file = yield* secretRequests
            .saveToFile({ threadId, turnItemId })
            .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
          return { status, file, deletedAt: yield* secretRequests.fileDeletedAt(file) };
        }
        // Saved means the value was stored before the card said so; a missing
        // value is a storage fault, not an answer the agent can act on.
        const secretRef = yield* secretRequests.savedRef({ threadId: threadId, turnItemId });
        if (Option.isNone(secretRef)) {
          return yield* failure(
            "orchestration_error",
            "The user saved the secret, but it could not be read. Ask again with a new clientRequestId.",
          );
        }
        return { status, secretRef: secretRef.value };
      }).pipe(Effect.withSpan("OrchestratorMcpService.requestSecret")),

    usageLimits: (scope, input) =>
      Effect.gen(function* () {
        yield* loadCaller(scope);
        const providers = yield* providerRegistry.getProvidersForUsageLimits(
          input.providerInstanceId,
        );
        const sources = yield* usageLimitSources.current;
        return collectUsageLimits(providers, sources, yield* Clock.currentTimeMillis, input);
      }),

    capabilities: (scope, input = {}) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        const providers = yield* loadProviders;
        const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
        const modelPreferences = yield* loadModelPreferences;
        const favorites = yield* loadFavoriteModels;
        const superseded = modelFamilySupersessions(providers);
        const now = yield* Clock.currentTimeMillis;
        const modelFailures = yield* providerRegistry.getModelFailures;
        const runEvidence = Option.isSome(rankings)
          ? (yield* rankings.value.getSnapshot()).models
          : [];
        const evidenceByModel = new Map(
          runEvidence.map((model) => [modelRankingSelectionKey(model), model.yourRuns]),
        );
        const listed = providers.filter(
          (provider) =>
            input.providerInstanceId === undefined ||
            provider.instanceId === input.providerInstanceId,
        );
        // A search lists only the providers with a matching model: most have none, and
        // their empty entries made up most of a search's result.
        const providerEntries = listed.flatMap((provider) => {
          const account = accountUnavailable(provider, now);
          const dataUse = providerDataUse(provider);
          const constraints = providerConstraints(
            provider,
            orchestrationCapableInstanceIds.has(provider.instanceId),
          );
          const models = orderModelsForListing(
            provider,
            selectableModels(provider, modelPreferences),
            modelPreferences,
            favorites,
          );
          // Agents are told never to pick a superseded or legacy model, so the
          // default listing leaves them out; a search that names one finds it.
          const filtered =
            input.modelSearch === undefined
              ? models.filter(
                  (model) =>
                    !model.isLegacy &&
                    !superseded.has(
                      modelRankingSelectionKey({
                        instanceId: provider.instanceId,
                        model: model.slug,
                      }),
                    ),
                )
              : models.filter((model) =>
                  `${model.slug} ${model.name ?? ""}`
                    .toLowerCase()
                    .includes(input.modelSearch!.toLowerCase()),
                );
          if (
            input.modelSearch !== undefined &&
            input.providerInstanceId === undefined &&
            filtered.length === 0
          )
            return [];
          const cursor = input.cursor ?? 0;
          const limit = input.limit ?? 20;
          return [
            {
              providerInstanceId: provider.instanceId,
              driverKind: provider.driver,
              displayName: provider?.displayName ?? null,
              models: filtered.slice(cursor, cursor + limit).map((model) => {
                const scopedAccount =
                  provider.recentFailure?.modelIds === undefined
                    ? undefined
                    : accountUnavailable(provider, now, model.slug);
                const scopedNote =
                  provider.recentFailure?.modelIds === undefined
                    ? {}
                    : recentFailureNote(provider, now, model.slug);
                const modelFailure = modelFailures.get(
                  modelRankingSelectionKey({ instanceId: provider.instanceId, model: model.slug }),
                );
                const newer = superseded.get(
                  modelRankingSelectionKey({
                    instanceId: provider.instanceId,
                    model: model.slug,
                  }),
                );
                const yourRuns = evidenceByModel.get(
                  modelRankingSelectionKey({
                    instanceId: provider.instanceId,
                    model: model.slug,
                  }),
                );
                const readsImages = model.capabilities?.imageInput;
                const unavailable = model.unavailableReason ?? scopedAccount?.reason;
                return {
                  id: model.slug,
                  ...(yourRuns === undefined ? {} : { yourRuns }),
                  ...(modelFailure === undefined
                    ? scopedNote
                    : { recentFailure: modelFailureNote(modelFailure, now) }),
                  ...(readsImages === false ? { images: false as const } : {}),
                  family: modelRankingFamily(model, provider),
                  ...(model.isLegacy ? { isLegacy: true } : {}),
                  label: model.name ?? null,
                  ...(input.includeOptions && model.capabilities?.optionDescriptors !== undefined
                    ? { options: model.capabilities.optionDescriptors }
                    : {}),
                  ...(newer
                    ? {
                        supersededBy: newer.model,
                        supersededByProviderInstanceId: newer.instanceId,
                      }
                    : {}),
                  ...(unavailable ? { unavailable } : {}),
                };
              }),
              // Defaults are left out: agents read this list before every delegation.
              ...(cursor + limit < filtered.length
                ? { totalModels: filtered.length, nextCursor: cursor + limit }
                : {}),
              ...(provider.supportedRuntimeModes === undefined ||
              provider.supportedRuntimeModes.length === 0
                ? {}
                : { runtimeModes: [...provider.supportedRuntimeModes] }),
              ...(constraints.length === 0 && account === undefined
                ? {}
                : { canRunChildTask: false as const }),
              ...(constraints.length === 0 ? {} : { constraints: [...constraints] }),
              ...(account ? { accountUnavailable: account } : recentFailureNote(provider, now)),
              ...(dataUse === undefined ? {} : { dataUse }),
            },
          ];
        });
        return {
          parentThreadId: parent?.thread.id ?? null,
          inheritedProviderInstanceId: parent?.thread.modelSelection.instanceId ?? null,
          inheritedModel: parent?.thread.modelSelection.model ?? null,
          runtimeMode: limits.runtimeMode,
          interactionMode: limits.interactionMode,
          providers: providerEntries,
          features: {
            appOwnedSubagents: true,
            asyncPolling: true,
            cancellation: true,
            batchThreadCreation: true,
            threadManagement: true,
            incrementalThreadRead: true,
            scheduledTasks: true,
            maxBatchThreads: 20,
          },
        };
      }),
    delegateTask: (callerScope, input, callerSteer?: Effect.Effect<void, OrchestratorMcpFailure>) =>
      Effect.gen(function* () {
        const steer =
          input.mode === "wait"
            ? (callerSteer ??
              (yield* captureCallerSteer(callerScope).pipe(
                Effect.provideService(
                  ThreadManagementService.ThreadManagementService,
                  threadManagement,
                ),
              )))
            : Effect.never;
        const { scope, parent } = yield* loadThreadCaller(callerScope, "delegate_task");
        const parentRun =
          ThreadManagementService.latestActiveRun(parent) ??
          (yield* backgroundSubagentRun(scope, parent));
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Delegated tasks require an active run owned by this MCP provider session.",
          );
        }
        const key = yield* requestKey(input.clientRequestId);
        const commandId = stableCommandId({
          scope,
          requestKey: key,
          operation: "delegate-task",
        });
        const parentNodeId = parentRun.rootNodeId;
        let workflowDelegation = false;
        const originalInput = input;
        const create = (
          input: OrchestratorMcpDelegateTaskInput,
          context?: WorkflowContextRecord,
          admit?: (
            command: Extract<OrchestrationV2ServerCommand, { type: "delegated_task.request" }>,
          ) => Effect.Effect<void, WorkflowsError>,
        ) =>
          Effect.gen(function* () {
            let committedSnapshot: string | undefined;
            workflowDelegation = input !== originalInput;
            if (input.target?.userNamedAccount && input.target.providerInstanceId === undefined) {
              return yield* failure(
                "invalid_request",
                "A user-named account requires providerInstanceId.",
              );
            }
            if (input.withEdits && input.isolation !== "worktree") {
              return yield* failure(
                "invalid_request",
                "withEdits requires isolation: worktree. Shared isolation already sees parent edits.",
              );
            }
            const isRetryOfAcceptedDelegation = yield* threadManagement.hasReceipt(commandId);
            // Dispatch replays an existing receipt before examining the command's
            // payload. Do not resolve a mutable provider catalog for that replay.
            const target = isRetryOfAcceptedDelegation
              ? { modelSelection: parent.thread.modelSelection, supportedRuntimeModes: undefined }
              : yield* resolveTargetRechecking({
                  projectId: parent.thread.projectId,
                  defaultSelection: parent.thread.modelSelection,
                  target: input.target,
                  providers: yield* loadProviders,
                  skipProjectEnablementFilter: false,
                });
            const runtimeMode = isRetryOfAcceptedDelegation
              ? parent.thread.runtimeMode
              : yield* resolveRuntimeMode(parent.thread.runtimeMode, input.runtimeMode, target);
            const interactionMode = isRetryOfAcceptedDelegation
              ? parent.thread.interactionMode
              : yield* resolveInteractionMode(parent.thread.interactionMode, input.interactionMode);
            let workspaceStrategy: OrchestrationV2WorkspacePreparation | undefined;
            /** Tells the caller how its request was adjusted to run. */
            let notice: string | undefined = input.withEdits
              ? "The subagent started from the parent's edits."
              : undefined;
            if (
              input.repositoryPath !== undefined &&
              !isRetryOfAcceptedDelegation &&
              !isAbsolutePath(input.repositoryPath)
            ) {
              return yield* failure("invalid_request", "repositoryPath must be an absolute path.");
            }
            if (input.isolation === "worktree" && !isRetryOfAcceptedDelegation) {
              const project = yield* requireProject(parent.thread.projectId);
              const cwd =
                input.repositoryPath ?? parent.thread.worktreePath ?? project.workspaceRoot;
              const snapshot = input.withEdits
                ? yield* Effect.acquireRelease(
                    gitDriver
                      .captureParentEdits(cwd)
                      .pipe(Effect.mapError((error) => failure("invalid_request", error.message))),
                    (snapshot) =>
                      snapshot.directory === committedSnapshot
                        ? Effect.void
                        : gitDriver.discardParentEdits(snapshot.directory),
                  )
                : undefined;
              if (snapshot) {
                notice = snapshotNotice(snapshot);
              }
              const base = snapshot
                ? Option.some({ commitSha: snapshot.baseCommit })
                : yield* gitDriver
                    .resolveCommit({
                      cwd,
                      revision: "HEAD",
                    })
                    .pipe(Effect.option);
              // A parent working in its own worktree (often a child itself) whose
              // project root cannot reach that commit (a scratch folder) is the
              // source; otherwise the project's repository is, setup files included.
              const parentIsSource =
                Option.isSome(base) &&
                input.repositoryPath === undefined &&
                cwd !== project.workspaceRoot &&
                Option.isNone(
                  yield* gitDriver
                    .resolveCommit({ cwd: project.workspaceRoot, revision: base.value.commitSha })
                    .pipe(Effect.option),
                );
              if (Option.isSome(base)) {
                // The child starts from the commit alone; surface leftover tracked
                // edits instead of dropping them silently. Best effort: a failed
                // check must not block the delegation.
                if (!input.withEdits) {
                  const tracked = yield* gitDriver
                    .execute({
                      operation: "OrchestratorMcpService.delegateTask.trackedChanges",
                      cwd,
                      args: ["status", "--porcelain", "--untracked-files=no"],
                    })
                    .pipe(Effect.option);
                  if (Option.isSome(tracked)) {
                    const count = tracked.value.stdout.split("\n").filter(Boolean).length;
                    if (count > 0)
                      notice = `${count} uncommitted ${count === 1 ? "file" : "files"} stayed behind; withEdits:true includes them.`;
                  }
                }
                const sourcePath = input.repositoryPath ?? (parentIsSource ? cwd : undefined);
                workspaceStrategy = {
                  type: "worktree",
                  baseRef: base.value.commitSha,
                  ...(snapshot ? { parentSnapshot: snapshot.directory } : {}),
                  startFromOrigin: false,
                  ...(sourcePath === undefined ? {} : { sourcePath }),
                };
              } else if (input.repositoryPath !== undefined) {
                return yield* failure(
                  "invalid_request",
                  `Unable to resolve HEAD in the checkout at "${cwd}". Pass repositoryPath with the absolute path to a Git repository with at least one commit, or use isolation: "shared" to work in that folder directly. A repository named in task text is not selected automatically.`,
                );
              } else {
                if (workflowDelegation)
                  return yield* failure(
                    "invalid_request",
                    "This workflow box requires a Git worktree. Pass repositoryPath with a committed Git checkout.",
                  );
                // A scratch chat's folder is not a Git checkout, so there is nothing
                // to isolate; the child shares it, as a retry without worktree would.
                notice = `No worktree: "${cwd}" is not a Git checkout with a commit, so the child shares the parent's folder. To isolate work in a repository elsewhere, pass repositoryPath.`;
              }
            } else if (input.repositoryPath !== undefined && !isRetryOfAcceptedDelegation) {
              workspaceStrategy = { type: "existing_worktree", worktreePath: input.repositoryPath };
            }
            // ThreadManagementService.dispatch is the chokepoint for this command
            // type's own enablement check, using the same command id and its
            // receipt-replay exemption, so no separate assert runs here.
            const command = {
              type: "delegated_task.request",
              createdBy: "agent",
              creationSource: "mcp",
              commandId,
              parentThreadId: scope.thread.threadId,
              parentRunId: parentRun.id,
              parentNodeId,
              task: input.task,
              ...(taskRole(input) === undefined ? {} : { role: taskRole(input) }),
              ...(context ? { context: { version: 1, records: [context] } } : {}),
              ...(input.title === undefined ? {} : { title: input.title }),
              modelSelection: target.modelSelection,
              runtimeMode,
              interactionMode,
              ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
              // Async delegations wake the parent on every child terminal; wait
              // delegations deliver through the blocking tool call, so a wake is
              // only needed if the parent settled first (timeout, disconnect).
              completionWake: input.mode === "wait" ? "settled_only" : "always",
            } satisfies Extract<OrchestrationV2ServerCommand, { type: "delegated_task.request" }>;
            if (admit)
              yield* admit(command).pipe(
                Effect.mapError((e) => failure("invalid_request", e.message)),
              );
            const result = yield* threadManagement.dispatch(command).pipe(
              Effect.tap(({ storedEvents }) =>
                Effect.sync(() => {
                  // Concurrent retries can capture different snapshots before either commits.
                  const run = storedEvents.find(({ event }) => event.type === "run.created");
                  const preparation =
                    run?.event.type === "run.created"
                      ? run.event.payload.workspacePreparation
                      : undefined;
                  if (preparation?.type === "worktree")
                    committedSnapshot = preparation.parentSnapshot;
                }),
              ),
              Effect.uninterruptible,
              Effect.mapError((error) =>
                error._tag === "ThreadManagementProviderInstanceDisabledError"
                  ? threadManagementFailure(error)
                  : failure(
                      "orchestration_error",
                      `Unable to create delegated task: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                    ),
              ),
            );
            const taskEvent = result.storedEvents.find(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.origin === "app_owned",
            );
            if (taskEvent?.event.type !== "subagent.updated") {
              return yield* failure(
                "orchestration_error",
                "Delegated task command did not produce a task projection.",
              );
            }
            const taskId = taskEvent.event.payload.id;
            const childThreadId = taskEvent.event.payload.childThreadId;
            const childRunEvent = result.storedEvents.find(
              (stored) =>
                stored.event.type === "run.created" && stored.event.threadId === childThreadId,
            );
            if (
              childThreadId !== null &&
              childRunEvent?.event.type === "run.created" &&
              childRunEvent.event.payload.workspacePreparation !== undefined
            ) {
              yield* threadLaunch.prepareRun({
                commandId,
                threadId: childThreadId,
                runId: childRunEvent.event.payload.id,
              });
            }

            const withNotice = (result: DelegateTaskDetails) =>
              notice === undefined && target.notice === undefined
                ? result
                : { ...result, notice: [target.notice, notice].filter(Boolean).join(" ") };
            return withNotice(yield* readTask(scope, taskId, false, true));
          }).pipe(Effect.scoped);
        // `loadProjection` uses `unorderedMessages: true` to skip whole-thread ordinal
        // sorts on every MCP call. Only when multiple workflow-bearing user messages share
        // the active run do we need canonical turn-item order to pick the latest steer.
        const workflowMessagesOnParentRun = Option.isSome(workflows)
          ? parent.messages.filter(
              (m) =>
                m.runId === parentRun.id &&
                m.context?.records.some((r) => r.kind === "workflow" && !("payload" in r)),
            )
          : [];
        const workflowContext =
          workflowMessagesOnParentRun.length === 0
            ? undefined
            : workflowMessagesOnParentRun.length === 1
              ? workflowMessagesOnParentRun[0]!.context
              : (yield* threadManagement
                  .getThreadRecords(scope.thread.threadId, ["messages"], {
                    messageIds: workflowMessagesOnParentRun.map((m) => m.id),
                    messageRoles: ["user"],
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      failure(
                        "orchestration_error",
                        `Unable to read thread ${scope.thread.threadId}: ${errorMessage(error)}`,
                      ),
                    ),
                  )).messages
                  .toReversed()
                  .find(
                    (m) =>
                      m.runId === parentRun.id &&
                      m.context?.records.some((r) => r.kind === "workflow" && !("payload" in r)),
                  )?.context;
        const initial = yield* Option.isSome(workflows)
          ? workflows.value
              .delegate(
                scope.thread.threadId,
                commandId,
                input,
                parent.thread.modelSelection,
                create,
                workflowContext,
              )
              .pipe(
                Effect.mapError((error) =>
                  error._tag === "WorkflowsError"
                    ? failure("invalid_request", error.message)
                    : error,
                ),
              )
          : create(input);
        if (input.mode !== "wait") return initial;
        const taskId = initial.taskId;
        const withNotice = (result: DelegateTaskDetails) =>
          initial.notice === undefined ? result : { ...result, notice: initial.notice };
        const timeoutMs = Math.min(
          MAX_WAIT_TIMEOUT_MS,
          Math.max(1, input.timeoutMs ?? DEFAULT_TASK_WAIT_TIMEOUT_MS),
        );
        // A wait that ends without a terminal result gives up delivery, including a
        // tools/call cancelled by a steer: upgrade so a later terminal wakes the
        // parent even mid-turn. Best effort; settled_only still wakes a settled
        // parent if the upgrade fails.
        const upgradeWake = upgradeTaskWake(scope, taskId, key);
        const delivered = (waited: Option.Option<DelegateTaskDetails>) =>
          Option.isSome(waited) && isTerminalTaskStatus(waited.value.status);
        // The finalizer runs uninterruptibly, so a cancel right after the wait returns still upgrades.
        const outcome = yield* raceWithSteer(waitForTask(scope, taskId, timeoutMs), steer).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) && Option.isSome(exit.value) && delivered(exit.value.value)
              ? Effect.void
              : upgradeWake,
          ),
        );
        const waited = Option.flatten(outcome);
        if (Option.isSome(waited) && delivered(waited)) return withNotice(waited.value);
        const result = withNotice(
          yield* readTask(scope, taskId, Option.isSome(outcome) && Option.isNone(waited), true),
        );
        return Option.isNone(outcome)
          ? { ...result, notice: [result.notice, STEER_NOTICE].filter(Boolean).join(" ") }
          : result;
      }).pipe(Effect.map(withTaskReference)),
    gradeTasks: (callerScope, grades) =>
      Effect.gen(function* () {
        const skipped: Array<{ taskId?: string; reason: string }> = [];
        if (grades === undefined) return { saved: 0, skipped };
        if (!Array.isArray(grades)) return { saved: 0, skipped: [{ reason: "invalid grades" }] };
        const accepted: Array<RecordedGrade & { taskId: NodeId }> = [];
        const acceptedReferences: NodeId[] = [];
        let grader: RecordedGrade["grader"];
        for (const raw of grades) {
          const checked = decodeTaskGrade(raw);
          const taskId =
            raw !== null &&
            typeof raw === "object" &&
            "taskId" in raw &&
            typeof raw.taskId === "string"
              ? raw.taskId
              : undefined;
          if (Option.isNone(checked)) {
            skipped.push({ ...(taskId === undefined ? {} : { taskId }), reason: "invalid grade" });
            continue;
          }
          const { taskId: id, score, note } = checked.value;
          const grade = {
            taskId: id,
            score,
            ...(note === undefined ? {} : { note: note.slice(0, 80) }),
          };
          if (Option.isNone(rankings) || !gradingOn) {
            skipped.push({ taskId: id, reason: "grading disabled" });
            continue;
          }
          const result = yield* Effect.gen(function* () {
            const scope = yield* requireThreadScope(callerScope, "grades");
            const details = yield* readTaskDetails(scope, id);
            const task = details.task;
            if (!isTerminalTaskStatus(task.status)) return "unfinished";
            // A run the provider or the app cut short says nothing about the model's work,
            // whatever it wrote before it ended.
            if (task.status === "failed") return "ended on a provider failure";
            if (grader === undefined) {
              const parent = yield* threadManagement
                .getThreadRecords(scope.thread.threadId, ["runs"])
                .pipe(Effect.mapError(threadManagementFailure));
              const graderRun = parent.runs
                .filter((run) => run.providerInstanceId === scope.thread.providerInstanceId)
                .toSorted((a, b) => b.ordinal - a.ordinal)[0];
              const model = (graderRun?.modelSelection ?? parent.thread.modelSelection).model;
              const provider = (yield* loadProviders).find(
                (candidate) => candidate.instanceId === scope.thread.providerInstanceId,
              );
              grader = {
                instanceId: scope.thread.providerInstanceId,
                family: modelRankingFamily(
                  provider?.models.find((candidate) => candidate.slug === model) ?? { slug: model },
                  provider ?? { driver: scope.thread.providerInstanceId },
                ),
              };
            }
            accepted.push({
              ...grade,
              taskId: task.taskId,
              grader,
            });
            acceptedReferences.push(id);
            return undefined;
          }).pipe(Effect.catchCause(() => Effect.succeed("unavailable")));
          if (result !== undefined) skipped.push({ taskId: id, reason: result });
        }
        if (accepted.length === 0 || Option.isNone(rankings)) return { saved: 0, skipped };
        const saved = yield* rankings.value.gradeMany(accepted).pipe(
          Effect.as(accepted.length),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrator-mcp.grade-skipped", { cause }).pipe(Effect.as(0)),
          ),
        );
        if (saved === 0)
          for (const taskId of acceptedReferences) skipped.push({ taskId, reason: "save failed" });
        return { saved, skipped };
      }),
    taskStatus: (callerScope, taskId) =>
      Effect.gen(function* () {
        const scope = yield* requireThreadScope(callerScope, "task_status");
        const result = yield* readTask(scope, taskId, false, true);
        if (isTerminalTaskStatus(result.status) || result.hasPendingQuestion) return result;
        const since = repeatTaskChecks(
          `${scope.thread.threadId}\u0000${result.taskId}`,
          `${result.status}|${result.workState}|${result.childRunId}|${result.hasPendingChildRuns}`,
          yield* Clock.currentTimeMillis,
        );
        return since === undefined
          ? result
          : { ...result, notice: unchangedNotice(since, "The task's completion or question") };
      }).pipe(Effect.map(withTaskReference)),
    cancelTask: (callerScope, input) =>
      Effect.gen(function* () {
        const scope = yield* requireThreadScope(callerScope, "task_cancel");
        const current = yield* readTask(scope, input.taskId);
        const key = yield* requestKey(input.clientRequestId);
        const parentProjection = yield* loadProjection(scope.thread.threadId);
        // Cancelling stops the child and every task under it, each a write to a
        // thread its user may have raised above the parent's modes since it was
        // delegated. All of them are checked before anything is stopped.
        const assertStoppable = (threadId: ThreadId): Effect.Effect<void, OrchestratorMcpFailure> =>
          Effect.gen(function* () {
            const shell = yield* threadManagement
              .getThreadShell(threadId)
              .pipe(Effect.mapError(threadManagementFailure));
            // A deleted thread takes no stop, but the tasks under it still do.
            if (shell !== null && shell.deletedAt === null) {
              yield* resolveRuntimeMode(parentProjection.thread.runtimeMode, shell.runtimeMode);
              yield* resolveInteractionMode(
                parentProjection.thread.interactionMode,
                shell.interactionMode,
              );
            }
            const { subagents } = yield* threadManagement
              .getThreadRecords(threadId, ["subagents"])
              .pipe(Effect.mapError(threadManagementFailure));
            for (const task of subagents) {
              if (
                task.origin === "app_owned" &&
                task.remote === undefined &&
                task.childThreadId !== null
              ) {
                yield* assertStoppable(task.childThreadId);
              }
            }
          });
        const parentTask = parentProjection.subagents.find(
          (task) => task.id === current.taskId && task.origin === "app_owned",
        );
        const disposeCompletionDelivery =
          parentTask?.completionDelivery?.state === "disposed"
            ? Effect.void
            : threadManagement
                .dispatch({
                  type: "delegated_task.completion-delivery.dispose",
                  commandId: stableCommandId({
                    scope,
                    requestKey: key,
                    operation: "cancel-task-completion-delivery",
                  }),
                  parentThreadId: scope.thread.threadId,
                  taskId: current.taskId,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to dispose delegated task ${input.taskId} completion delivery: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                    ),
                  ),
                );
        // A send owns one queued message, not the child's queue or running work.
        const sentMessageId = threadSendMessageId(current.taskId);
        if (sentMessageId !== undefined && parentTask !== undefined) {
          const child = yield* loadProjection(current.childThreadId);
          const sentRun = child.runs.find((run) => run.userMessageId === sentMessageId);
          if (sentRun?.status === "cancelled") {
            yield* disposeCompletionDelivery;
            return {
              taskId: current.taskId,
              status: "cancelled",
            } satisfies OrchestratorMcpTaskCancelResult;
          }
          if (
            sentRun?.status === "queued" &&
            child.thread.lineage.parentEnvironmentId === undefined &&
            child.thread.lineage.parentThreadId === scope.thread.threadId &&
            child.thread.lineage.relationshipToParent === "subagent"
          ) {
            yield* resolveRuntimeMode(
              parentProjection.thread.runtimeMode,
              child.thread.runtimeMode,
            );
            yield* resolveInteractionMode(
              parentProjection.thread.interactionMode,
              child.thread.interactionMode,
            );
            const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
            yield* threadManagement
              .dispatch({
                type: "queued-run.cancel",
                commandId: stableCommandId({
                  scope,
                  requestKey: key,
                  operation: "cancel-task-queued-send",
                }),
                threadId: current.childThreadId,
                runId: sentRun.id,
              })
              .pipe(
                Effect.provideService(DispatchModeLimit, {
                  runtimeMode: parentProjection.thread.runtimeMode,
                  interactionMode: parentProjection.thread.interactionMode,
                  refused,
                }),
                Effect.catch((error) =>
                  Effect.flatMap(Ref.get(refused), (refusal) =>
                    Effect.fail(
                      failure(
                        refusal === undefined
                          ? "task_not_cancellable"
                          : refusal.mode === "runtime"
                            ? "runtime_mode_escalation_denied"
                            : "interaction_mode_escalation_denied",
                        errorMessage(error),
                      ),
                    ),
                  ),
                ),
              );
            yield* disposeCompletionDelivery;
            return {
              taskId: current.taskId,
              status: "cancelled",
            } satisfies OrchestratorMcpTaskCancelResult;
          }
        }
        yield* assertStoppable(current.childThreadId);
        // Cancelling stops the child thread the way Stop does, including work that came
        // after a published result: follow-up runs, pull request watch wakes, and the
        // tasks it delegated. The published result stays terminal.
        const stopChild = Effect.gen(function* () {
          const commandId = stableCommandId({ scope, requestKey: key, operation: "cancel-task" });
          const reason = input.reason;
          yield* threadManagement
            .dispatch({
              type: "thread.stop",
              commandId,
              threadId: current.childThreadId,
              stopDelegatedTasks: false,
              ...(reason === undefined ? {} : { reason }),
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "task_not_cancellable",
                  `Unable to stop delegated task ${input.taskId}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                ),
              ),
            );
          // A retry with the same clientRequestId repeats only the stops that failed.
          yield* threadManagement
            .stopDelegatedTasks({ threadId: current.childThreadId, commandId, reason })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "task_not_cancellable",
                  `Stopped delegated task ${input.taskId}, but not every task it delegated: ${errorMessage(error)}`,
                ),
              ),
            );
        });
        // Checked above; a user raising one of these threads meanwhile is
        // caught again under that thread's lock, which leaves it running.
        const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
        const stopWithinLimit = stopChild.pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: parentProjection.thread.runtimeMode,
            interactionMode: parentProjection.thread.interactionMode,
            refused,
          }),
          Effect.catch((error) =>
            Effect.flatMap(Ref.get(refused), (refusal) =>
              Effect.fail(
                refusal === undefined
                  ? error
                  : failure(
                      refusal.mode === "runtime"
                        ? "runtime_mode_escalation_denied"
                        : "interaction_mode_escalation_denied",
                      `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this thread's; its user changed it while the task was being cancelled.`,
                    ),
              ),
            ),
          ),
        );
        if (isTerminalTaskStatus(current.status)) {
          yield* stopWithinLimit;
          yield* disposeCompletionDelivery;
          return {
            taskId: current.taskId,
            status: current.status,
          } satisfies OrchestratorMcpTaskCancelResult;
        }
        // A task waiting on its own delegates, a scheduled automatic provider retry, or a
        // completed run's provider-continuation grace has work to stop below it. One with
        // none (such as one awaiting a restart) keeps its delivery.
        const child = yield* loadProjection(current.childThreadId);
        const hasScheduledAutomaticRetry = child.runs.some(
          (run) =>
            (run.status === "failed" || run.status === "cancelled") &&
            run.automaticProviderRetry?.status === "scheduled",
        );
        const task = parentProjection.subagents.find((task) => task.id === current.taskId);
        const progress = task === undefined ? undefined : delegatedTaskProgressForTask(child, task);
        const providerContinuationGrace =
          current.workState === "working" &&
          progress?.state === "result_available" &&
          progress.resultRun?.status === "completed";
        if (
          current.workState !== "waiting_for_children" &&
          ThreadManagementService.latestActiveRun(child) === undefined &&
          !hasScheduledAutomaticRetry &&
          !providerContinuationGrace
        ) {
          return yield* failure(
            "task_not_cancellable",
            `Delegated task ${input.taskId} has no interruptible child run.`,
          );
        }
        yield* stopWithinLimit;
        yield* disposeCompletionDelivery.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrator-mcp.cancel-task.delivery-dispose-failed", {
              taskId: input.taskId,
              cause,
            }),
          ),
        );
        return {
          taskId: current.taskId,
          status: "cancel_requested",
        } satisfies OrchestratorMcpTaskCancelResult;
      }).pipe(Effect.map(withTaskReference)),
    createThreads: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        let origin:
          | { threadId: ThreadId; runId: RunId; nodeId: NodeId; afterSequence: number }
          | undefined;
        if (parent !== undefined) {
          const parentRun = ThreadManagementService.latestActiveRun(parent);
          if (
            parentRun === undefined ||
            parentRun.rootNodeId === null ||
            parentRun.providerInstanceId !== scope.thread?.providerInstanceId
          ) {
            return yield* failure(
              "parent_not_active",
              "Thread creation requires an active run owned by this MCP provider session.",
            );
          }
          origin = {
            threadId: parent.thread.id,
            runId: parentRun.id,
            nodeId: parentRun.rootNodeId,
            afterSequence: yield* threadManagement
              .getThreadEventSequence(parent.thread.id)
              .pipe(Effect.mapError(threadManagementFailure)),
          };
        }
        for (const request of input.threads) {
          yield* resolveRuntimeMode(limits.runtimeMode, request.runtimeMode);
          yield* resolveInteractionMode(limits.interactionMode, request.interactionMode);
        }
        const projectId =
          parent === undefined && input.projectId === undefined
            ? (yield* managedFolders.ensureScratchProject.pipe(
                Effect.mapError((error) => failure("orchestration_error", error.message)),
              )).projectId
            : yield* resolveProjectTarget(parent, input.projectId);
        if (parent !== undefined && projectId !== parent.thread.projectId) {
          return yield* failure(
            "invalid_request",
            "Thread callers can only create chats in their own project.",
          );
        }
        const project = parent === undefined ? yield* requireProject(projectId) : undefined;
        const providers = yield* Effect.cached(loadProviders);
        const key = yield* requestKey(input.clientRequestId);
        const created = yield* Effect.forEach(
          input.threads,
          (request, index) =>
            Effect.gen(function* () {
              const threadId = stableThreadId({
                scope,
                requestKey: key,
                index,
              });
              const commandId = stableCommandId({
                scope,
                requestKey: key,
                operation: "create-thread",
                index,
              });
              const replay =
                input.clientRequestId !== undefined &&
                (yield* threadManagement.hasReceipt(commandId, { acceptedOnly: true }));
              const existing = replay
                ? (yield* threadManagement
                    .getProjectThreadRecords({ projectId, threadId }, [])
                    .pipe(Effect.mapError(threadManagementFailure))).thread
                : undefined;
              // A committed create keeps its selection even if the catalog or default changed.
              const loadedProviders = existing === undefined ? yield* providers : undefined;
              const target: ResolvedTarget =
                existing === undefined
                  ? yield* resolveTargetRechecking({
                      projectId,
                      defaultSelection:
                        project !== undefined &&
                        request.target?.providerInstanceId === undefined &&
                        request.target?.driverKind === undefined
                          ? yield* projectDefaultModelSelection(project, loadedProviders)
                          : parent?.thread.modelSelection,
                      target: request.target,
                      providers: loadedProviders!,
                    })
                  : { modelSelection: existing.modelSelection, supportedRuntimeModes: undefined };
              const runtimeMode =
                existing?.runtimeMode ??
                (yield* resolveRuntimeMode(limits.runtimeMode, request.runtimeMode, target));
              const interactionMode =
                existing?.interactionMode ??
                (yield* resolveInteractionMode(limits.interactionMode, request.interactionMode));
              yield* assertTargetEnabledForProject(projectId, commandId, target);
              const title = threadTitle({
                parentTitle: parent?.thread.title ?? project?.title ?? "New",
                prompt: request.prompt,
                title: request.title,
                index,
              });
              const createThread = Effect.gen(function* () {
                // A concurrent retry may have committed while we resolved the model.
                const hasReceipt =
                  replay ||
                  (input.clientRequestId !== undefined &&
                    (yield* threadManagement.hasReceipt(commandId)));
                const folder = hasReceipt
                  ? undefined
                  : Option.getOrUndefined(
                      yield* managedFolders.folderForThread({
                        projectId,
                        threadId,
                        text: request.prompt ?? title,
                        parentWorkspacePath: parent?.thread.worktreePath ?? null,
                      }),
                    );
                return yield* threadManagement.dispatch({
                  type: "thread.create",
                  createdBy: "agent",
                  creationSource: "mcp",
                  commandId,
                  threadId,
                  projectId,
                  title,
                  modelSelection: target.modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: folder === undefined ? (parent?.thread.branch ?? null) : null,
                  worktreePath: folder ?? parent?.thread.worktreePath ?? null,
                });
              });
              const { sequence, storedEvents } = yield* createThreadLock
                .withLock(commandId, createThread)
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                    ),
                  ),
                );
              const createdEvent = storedEvents.find(
                ({ event }) => event.type === "thread.created",
              );
              const selection =
                createdEvent?.event.type === "thread.created"
                  ? createdEvent.event.payload.modelSelection
                  : target.modelSelection;
              const messageId = stableMessageId({ scope, requestKey: key, index });
              if (request.prompt !== undefined) {
                const start = threadManagement
                  .dispatch({
                    type: "message.dispatch",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "dispatch-thread",
                      index,
                    }),
                    threadId,
                    ...(origin === undefined ? {} : { senderThreadId: origin.threadId }),
                    messageId,
                    text: request.prompt,
                    attachments: [],
                    modelSelection: selection,
                    dispatchMode: { type: "start_immediately" },
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      failure(
                        "orchestration_error",
                        `Unable to start thread ${index + 1}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                      ),
                    ),
                  );
                yield* start.pipe(Effect.provideService(DispatchModeLimit, limits));
              }
              const projection = yield* loadProjection(threadId);
              const run = projection.runs.find(
                (candidate) => candidate.userMessageId === messageId,
              );
              if (origin !== undefined) {
                yield* threadManagement
                  .dispatch({
                    type: "thread.created.record",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "record-created-thread",
                      index,
                    }),
                    parentThreadId: origin.threadId,
                    parentRunId: origin.runId,
                    parentNodeId: origin.nodeId,
                    targetThreadId: threadId,
                    targetRunId: run?.id ?? null,
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      failure(
                        "orchestration_error",
                        `Unable to record thread ${index + 1} in the parent timeline: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                      ),
                    ),
                  );
              }
              return {
                threadId,
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: projection.thread.title,
                createdBy: projection.thread.createdBy,
                creationSource:
                  projection.thread.creationSource === "workflows"
                    ? "server"
                    : projection.thread.creationSource,
                ...(target.notice ? { notice: target.notice } : {}),
                providerInstanceId: selection.instanceId,
                model: selection.model,
                afterSequence: origin?.afterSequence ?? sequence,
              } satisfies Omit<OrchestratorMcpCreatedThread, "startup"> & { afterSequence: number };
            }),
          { concurrency: 1 },
        );
        const threads = yield* Effect.forEach(
          created,
          ({ afterSequence, ...thread }, index) =>
            Effect.gen(function* () {
              const startup = yield* threadManagement
                .waitForThreadStartup({
                  threadId: thread.threadId,
                  runId: thread.runId,
                  afterSequence,
                })
                .pipe(Effect.mapError(threadManagementFailure));
              if (origin !== undefined) {
                yield* threadManagement
                  .dispatch({
                    type: "thread.created.report",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "report-created-thread",
                      index,
                    }),
                    threadId: thread.threadId,
                    startup: startup.startup,
                  })
                  .pipe(Effect.mapError(threadManagementFailure));
              }
              return { ...thread, ...startup } satisfies OrchestratorMcpCreatedThread;
            }),
          { concurrency: "unbounded" },
        );
        return { threads };
      }),
    listThreads: (scope, input) =>
      Effect.gen(function* () {
        const { parent } = yield* loadCaller(scope);
        const projectId = yield* resolveProjectTarget(parent, input.projectId);
        const projectThreads = yield* threadManagement
          .listProjectThreads({
            projectId,
            includeSubagents: input.includeSubagents !== false,
          })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Unable to list threads: ${errorMessage(error)}`),
            ),
          );
        const nowMs = yield* Clock.currentTimeMillis;
        const statuses = input.statuses === undefined ? null : new Set(input.statuses);
        const titleContains = input.titleContains?.toLocaleLowerCase();
        const filtered = projectThreads
          .filter(
            (thread) =>
              statuses === null || statuses.has(thread.activityRunStatus ?? thread.status),
          )
          .filter(
            (thread) =>
              input.settled === undefined || threadSettlement(thread).settled === input.settled,
          )
          .filter(
            (thread) => input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed,
          )
          .filter(
            (thread) =>
              titleContains === undefined ||
              thread.title.toLocaleLowerCase().includes(titleContains),
          );
        const cursor = input.cursor ?? 0;
        const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
        const page = filtered.slice(cursor, cursor + limit);
        const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
        return {
          projectId,
          currentThreadId: parent?.thread.id ?? null,
          threads: page.map((shell) => listItemFromShell(shell, nowMs)),
          nextCursor,
          total: filtered.length,
        } satisfies OrchestratorMcpThreadListResult;
      }),
    readThread: (scope, input) =>
      Effect.gen(function* () {
        const { parent, target, shell } = yield* loadReadableThread(scope, input.threadId);
        const view = input.view ?? "messages";
        // Agents read the newest items unless they ask for the start; clients (the CLI) page forward.
        const fromEnd =
          input.fromEnd ??
          (scope.thread !== undefined &&
          input.afterPosition === undefined &&
          input.itemId === undefined &&
          input.query === undefined
            ? true
            : undefined);
        const backwards = fromEnd === true || input.beforePosition !== undefined;
        const words = input.query?.trim().toLowerCase().split(/\s+/u);
        if (
          (words !== undefined && words[0] === "") ||
          (input.afterPosition !== undefined && (backwards || words !== undefined)) ||
          (input.itemId !== undefined && (backwards || words !== undefined))
        ) {
          return yield* failure(
            "invalid_request",
            "Use a non-empty query. Do not combine afterPosition with backward/search reads, or itemId with query/backward reads.",
          );
        }
        const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
        const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
        const snippets = new Map<number, string>();
        let timeline: ProjectionTimelinePage;
        let paging: Pick<
          OrchestratorMcpThreadReadResult,
          "nextPosition" | "hasMore" | "prevPosition" | "search"
        >;
        if (words === undefined) {
          timeline = yield* threadManagement
            .getTimelinePage(target.thread.id, {
              afterPosition: input.afterPosition ?? -1,
              limit,
              view,
              ...(fromEnd === undefined ? {} : { fromEnd }),
              ...(input.beforePosition === undefined
                ? {}
                : { beforePosition: input.beforePosition }),
              ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
            })
            .pipe(Effect.mapError(threadManagementFailure));
          paging = {
            nextPosition: timeline.items.at(-1)?.position ?? null,
            hasMore: timeline.hasMore,
            ...(backwards
              ? { prevPosition: timeline.hasMore ? (timeline.items[0]?.position ?? null) : null }
              : {}),
          };
        } else {
          // Hydrate bounded batches through the normal visibility/fork-aware read path.
          const matches: Array<ProjectionTimelinePage["items"][number]> = [];
          let beforePosition = input.beforePosition;
          let scannedItems = 0;
          let totalItems = 0;
          let hasMore = false;
          let extraMatch = false;
          do {
            const batch = yield* threadManagement
              .getTimelinePage(target.thread.id, {
                fromEnd: true,
                ...(beforePosition === undefined ? {} : { beforePosition }),
                limit: Math.min(THREAD_SEARCH_BATCH_SIZE, THREAD_SEARCH_SCAN_LIMIT - scannedItems),
                view,
              })
              .pipe(Effect.mapError(threadManagementFailure));
            totalItems = batch.totalItems;
            hasMore = batch.hasMore;
            for (let index = batch.items.length - 1; index >= 0; index--) {
              const row = batch.items[index]!;
              scannedItems++;
              beforePosition = row.position;
              const text = [row.item.title, turnItemText(row.item)]
                .filter((part) => part !== null)
                .join("\n");
              const lower = text.toLowerCase();
              if (!words.every((word) => lower.includes(word))) continue;
              if (matches.length === limit) {
                extraMatch = true;
                hasMore = true;
                break;
              }
              matches.push(row);
              const matchOffset = Math.min(...words.map((word) => lower.indexOf(word)));
              const start = Math.max(0, matchOffset - 80);
              const end = start + 240;
              snippets.set(
                row.position,
                `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`,
              );
            }
          } while (hasMore && !extraMatch && scannedItems < THREAD_SEARCH_SCAN_LIMIT);
          timeline = { items: matches, totalItems, hasMore };
          paging = {
            nextPosition: null,
            hasMore,
            prevPosition: hasMore
              ? ((extraMatch ? matches.at(-1)?.position : beforePosition) ?? null)
              : null,
            search: {
              scannedItems,
              scanLimitReached: hasMore && !extraMatch && scannedItems === THREAD_SEARCH_SCAN_LIMIT,
              hasMoreMatches: extraMatch ? true : hasMore ? null : false,
            },
          };
        }
        const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
        for (const row of timeline.items) {
          if (row.item.type !== "user_message" && row.item.type !== "assistant_message") continue;
          const ids = messageIdsByThread.get(row.sourceThreadId) ?? [];
          ids.push(row.item.messageId);
          messageIdsByThread.set(row.sourceThreadId, ids);
        }
        const sourceMessages = yield* Effect.forEach(
          [...messageIdsByThread],
          ([threadId, messageIds]) =>
            threadManagement.getThreadRecords(threadId, ["messages"], { messageIds }).pipe(
              Effect.map((records) => [threadId, records.messages] as const),
              Effect.mapError(threadManagementFailure),
            ),
          { concurrency: 1 },
        );
        const messagesByThreadId = new Map(sourceMessages);
        const thread = threadDetail(
          target,
          timeline.totalItems,
          shell,
          yield* Clock.currentTimeMillis,
        );
        const recentRuns = target.runs
          .toSorted((left, right) => right.ordinal - left.ordinal)
          .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
          .map(threadRun);
        const allItems = timeline.items.map((row) => ({
          ...timelineItem({
            row,
            threadId: target.thread.id,
            maxChars,
            messagesByThreadId,
            ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
          }),
          ...(snippets.has(row.position) ? { snippet: snippets.get(row.position)! } : {}),
        }));
        // Keep the end of the page the caller reads toward, and at least one item. Search
        // matches are already newest first; a backward page is in position order.
        const keepEnd = backwards && words === undefined;
        let size = encodeJsonText({ thread, recentRuns }).length;
        let kept = 0;
        for (const item of keepEnd ? allItems.toReversed() : allItems) {
          size += encodeJsonText(item).length + 1;
          if (kept > 0 && size > THREAD_READ_BUDGET_CHARS) break;
          kept++;
        }
        const start = keepEnd ? allItems.length - kept : 0;
        const items = allItems.slice(start, start + kept);
        const page = timeline.items.slice(start, start + kept);
        if (kept < allItems.length) {
          paging =
            words !== undefined
              ? {
                  ...paging,
                  hasMore: true,
                  prevPosition: page.at(-1)?.position ?? null,
                  ...(paging.search === undefined
                    ? {}
                    : { search: { ...paging.search, hasMoreMatches: true } }),
                }
              : keepEnd
                ? { ...paging, hasMore: true, prevPosition: page[0]?.position ?? null }
                : { ...paging, hasMore: true, nextPosition: page.at(-1)?.position ?? null };
        }
        const returnedRunIds = new Set(
          page
            .filter((row) => row.sourceThreadId === target.thread.id)
            .map((row) => row.item.runId),
        );
        const tasks =
          parent === undefined ? [] : directAppOwnedChildTasks(parent, target, returnedRunIds);
        if (
          parent !== undefined &&
          scope.thread !== undefined &&
          tasks.length > 0 &&
          (input.textOffset ?? 0) === 0
        ) {
          for (const task of tasks) {
            const transfer = taskResultTransfer(parent, target, task);
            const resultRunId = transfer?.sourcePoint.runId ?? delegatedTaskRun(target, task)?.id;
            const resultRunIds = resultRunId === undefined ? [] : [resultRunId];
            const resultRecords = yield* threadManagement
              .getThreadRecords(target.thread.id, ["messages", "turnItems"], {
                messageRoles: ["assistant"],
                messageRunIds: resultRunIds,
                turnItemRunIds: resultRunIds,
                turnItemTypes: ["assistant_message", "error"],
              })
              .pipe(Effect.mapError(threadManagementFailure));
            if (
              pageIncludesTerminalTaskResult({
                parent,
                page,
                task,
                target: {
                  ...target,
                  ...resultRecords,
                  messages: [...target.messages, ...resultRecords.messages],
                },
                maxChars,
              })
            ) {
              yield* readTask(
                scope as McpThreadInvocationScope,
                task.id,
                false,
                true,
                "thread-read-acknowledge",
              );
            }
          }
        }
        return {
          thread,
          recentRuns,
          items,
          ...paging,
        } satisfies OrchestratorMcpThreadReadResult;
      }),
    sendToThread: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
        yield* assertLiveCallerForOtherThread(scope, parent, target);
        yield* assertTargetWithinLimits(limits, target.thread);

        const mode = input.mode ?? "auto";
        const key = yield* requestKey(input.clientRequestId);
        const messageId = stableOperationMessageId({
          scope,
          requestKey: key,
          operation: "thread-send",
        });
        const heldResult = {
          threadId: target.thread.id,
          messageId,
          runId: null,
          status: null,
          delivery: "held",
        } satisfies OrchestratorMcpThreadSendResult;
        const targetId = target.thread.id;
        if (
          acceptedHeldByScope.get(scope)?.get(messageId) === targetId ||
          sendingHeldByParent.get(targetId)?.has(messageId) ||
          heldByParent.get(targetId)?.some((message) => message.messageId === messageId)
        ) {
          return heldResult;
        }
        if (parent !== undefined && shouldHoldForParent({ mode, caller: parent, target })) {
          yield* holdForParent(targetId, {
            projectId: target.thread.projectId,
            senderThreadId: parent.thread.id,
            senderTitle: parent.thread.title,
            messageId,
            commandId: stableCommandId({ scope, requestKey: key, operation: "thread-send" }),
            text: input.message,
            ...(input.clientRequestId === undefined
              ? {}
              : {
                  recordAcceptance: () => {
                    const receipts =
                      acceptedHeldByScope.get(scope) ?? new Map<MessageId, ThreadId>();
                    receipts.set(messageId, targetId);
                    acceptedHeldByScope.set(scope, receipts);
                  },
                }),
          });
          return heldResult;
        }
        const send = (sendMode: typeof mode) =>
          threadManagement.sendToThread({
            projectId: target.thread.projectId,
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "thread-send",
            }),
            threadId: target.thread.id,
            ...(parent === undefined ? {} : { senderThreadId: parent.thread.id }),
            messageId,
            text: input.message,
            attachments: [],
            mode: sendMode,
            createdBy: "agent",
            creationSource: "mcp",
          });
        const result = yield* send(mode)
          .pipe(
            // A turn that ended before the steer arrived still gets the message,
            // as a new turn; `delivery: "started"` tells the caller.
            Effect.catchTags({
              ThreadManagementNoSteerableRunError: (error) =>
                error.mode === "steer" ? send("auto") : Effect.fail(error),
            }),
          )
          .pipe(
            Effect.mapError((error) =>
              isThreadManagementError(error)
                ? threadManagementFailure(error)
                : failure(
                    "orchestration_error",
                    `Unable to send to thread ${target.thread.id}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                  ),
            ),
          );
        return {
          threadId: target.thread.id,
          messageId,
          ...(result.run.delegatedTaskId === undefined
            ? { runId: result.run.id }
            : { taskId: taskReference(result.run.delegatedTaskId) }),
          status: result.run.status,
          delivery: result.delivery,
        } satisfies OrchestratorMcpThreadSendResult;
      }),
    waitForThread: (scope, input) =>
      Effect.gen(function* () {
        const steer = yield* captureCallerSteer(scope).pipe(
          Effect.provideService(ThreadManagementService.ThreadManagementService, threadManagement),
        );
        const { parent, target } = yield* loadScopedThread(scope, input.threadId, false);
        const selectedRunId =
          input.runId ??
          ThreadManagementService.latestRun(
            yield* threadManagement
              .getProjectThreadRecords(
                { projectId: target.thread.projectId, threadId: target.thread.id },
                ["runs"],
              )
              .pipe(Effect.mapError(threadManagementFailure)),
          )?.id;
        const waited = yield* raceWithSteer(
          threadManagement
            .waitForThread({
              projectId: target.thread.projectId,
              threadId: target.thread.id,
              ...(selectedRunId === undefined ? {} : { runId: selectedRunId }),
              timeoutMs: Math.min(
                MAX_WAIT_TIMEOUT_MS,
                Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
              ),
            })
            .pipe(Effect.mapError(threadManagementFailure)),
          steer,
        );
        if (Option.isSome(waited)) {
          const result = waited.value;
          return {
            threadId: target.thread.id,
            runId: result.run?.id ?? null,
            status: result.run === null ? "idle" : runOutcome(result.run),
            timedOut: result.timedOut,
          } satisfies OrchestratorMcpThreadWaitResult;
        }
        const current = yield* threadManagement
          .getProjectThreadRecords(
            { projectId: target.thread.projectId, threadId: target.thread.id },
            ["runs"],
          )
          .pipe(Effect.mapError(threadManagementFailure));
        let run =
          selectedRunId === undefined
            ? undefined
            : current.runs.find((candidate) => candidate.id === selectedRunId);
        // Preserve the wait's restart-chain selection when returning partial state.
        for (let hops = 0; run !== undefined && hops < current.runs.length; hops++) {
          const next = current.runs.find(
            (candidate) => candidate.restartContinuationOfRunId === run?.id,
          );
          if (next === undefined) break;
          run = next;
        }
        if (parent !== undefined && scope.thread !== undefined) {
          const tasks = parent.subagents.filter(
            (task) =>
              task.origin === "app_owned" &&
              task.childThreadId === target.thread.id &&
              (run?.delegatedTaskId === undefined || task.id === run.delegatedTaskId),
          );
          for (const task of tasks) {
            if (task.completionWake === "always") continue;
            yield* upgradeTaskWake(
              scope as McpThreadInvocationScope,
              task.id,
              yield* requestKey(undefined),
              "thread-wait-wake-policy",
            );
          }
          // Arbitrary thread waits have no delegated-task delivery to upgrade.
          if (
            tasks.length === 0 &&
            run !== undefined &&
            !ThreadManagementService.isTerminalRunStatus(run.status) &&
            target.thread.id !== scope.thread.threadId
          ) {
            yield* wakeAfterThread(scope as McpThreadInvocationScope, target.thread.projectId, {
              threadId: target.thread.id,
              runId: run.id,
            });
          }
        }
        return {
          threadId: target.thread.id,
          runId: run?.id ?? null,
          status: run === undefined ? "idle" : runOutcome(run),
          timedOut: false,
          notice: STEER_NOTICE,
        } satisfies OrchestratorMcpThreadWaitResult;
      }),
    interruptThread: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
        yield* assertLiveCallerForOtherThread(scope, parent, target);
        // Stopping another thread's work is a write: it must run within the caller's modes.
        yield* assertTargetWithinLimits(limits, target.thread);
        const key = yield* requestKey(input.clientRequestId);
        const result = yield* threadManagement
          .interruptThread({
            projectId: target.thread.projectId,
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "thread-interrupt",
            }),
            threadId: target.thread.id,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
          .pipe(
            Effect.mapError((error) =>
              isThreadManagementError(error)
                ? threadManagementFailure(error)
                : failure(
                    "orchestration_error",
                    `Unable to interrupt thread ${target.thread.id}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                  ),
            ),
          );
        if (result.type === "no_active_run") {
          return {
            threadId: target.thread.id,
            runId: null,
            status: "no_active_run",
          } satisfies OrchestratorMcpThreadInterruptResult;
        }
        return {
          threadId: target.thread.id,
          runId: result.run.id,
          status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }),

    council: (
      callerScope,
      input,
    ): Effect.Effect<OrchestratorMcpCouncilResult, OrchestratorMcpFailure> =>
      Effect.gen(function* () {
        const signal = yield* captureCallerSteer(callerScope).pipe(
          Effect.provideService(ThreadManagementService.ThreadManagementService, threadManagement),
        );
        let steered = false;
        const steer = signal.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              steered = true;
            }),
          ),
        );
        const task = councilBrief(input);
        const timeoutMs = input.timeoutMs ?? COUNCIL_DEFAULT_TIMEOUT_MS;
        const key = input.clientRequestId;
        const memberKey = Effect.fnUntraced(function* (index: number) {
          if (key === undefined) return undefined;
          const suffix = `:council-${index + 1}`;
          if (key.length <= 240) return key + suffix;
          // Older calls kept only the first 240 characters. Replay their receipts when present.
          const legacy = key.slice(0, 240) + suffix;
          const hasMember = (requestKey: string) =>
            threadManagement.hasReceipt(
              stableCommandId({ scope: callerScope, operation: "delegate-task", requestKey }),
            );
          // 241 characters keeps this outside the old key space and leaves room for the suffix.
          const current = key.slice(0, 225) + taskReference(encodeRequestPart(key)) + suffix;
          return (yield* hasMember(legacy)) && !(yield* hasMember(current)) ? legacy : current;
        });
        const answers = yield* Effect.forEach(
          input.members,
          (member, index) =>
            Effect.gen(function* () {
              const clientRequestId = yield* memberKey(index);
              return yield* service.delegateTask(
                callerScope,
                {
                  task,
                  target: member,
                  title: `Council: ${member.model ?? member.providerInstanceId ?? `member ${index + 1}`}`,
                  mode: "wait",
                  timeoutMs,
                  ...(clientRequestId === undefined ? {} : { clientRequestId }),
                },
                steer,
              );
            }).pipe(
              Effect.map((result) => {
                // A member whose provider ended its turn without writing anything gave no
                // answer; saying so keeps the lead from treating silence as a view.
                const silent =
                  result.status === "completed" &&
                  (result.summary === undefined ||
                    result.summary.trim() === "" ||
                    result.summary === EMPTY_CHILD_RESULT_TEXT);
                return {
                  providerInstanceId: result.providerInstanceId,
                  model: result.model ?? null,
                  taskId: result.taskId,
                  status: silent ? "no_answer" : result.status,
                  answer: silent ? null : (result.summary ?? null),
                  waitTimedOut: result.waitTimedOut ?? false,
                  ...(silent
                    ? {
                        error:
                          "This member's provider ended without writing an answer. Don't count it; retry with another model if you need a third view.",
                      }
                    : {}),
                };
              }),
              // One member failing to start leaves the others' answers usable.
              Effect.catch((error) =>
                Effect.succeed({
                  providerInstanceId: member.providerInstanceId ?? null,
                  model: member.model ?? null,
                  taskId: null,
                  status: "failed",
                  answer: null,
                  waitTimedOut: false,
                  error: error.message,
                }),
              ),
            ),
          { concurrency: "unbounded" },
        );
        const pending = answers.filter(
          (answer) =>
            !["completed", "failed", "cancelled", "interrupted", "no_answer"].includes(
              answer.status,
            ),
        ).length;
        const silent = answers.filter((answer) => answer.status === "no_answer").length;
        return {
          answers,
          note: `${steered ? `${STEER_NOTICE} ` : ""}Compare the answers yourself: where they agree, where they differ and why. Then decide and tell the user which way you went and why; don't just count votes.${pending > 0 ? ` ${pending} member${pending === 1 ? " is" : "s are"} still answering and will wake you when done.` : ""}${silent > 0 ? ` ${silent} member${silent === 1 ? "" : "s"} gave no answer; tell the user which.` : ""}`,
        };
      }).pipe(Effect.withSpan("OrchestratorMcpService.council")),
  } satisfies OrchestratorMcpService["Service"];
  registerWorkflowsDelegate((scope, key) => {
    const workflowScope = {
      ...scope,
      requestNamespace: `workflow-start:${scope.thread?.threadId}`,
    };
    const commandId = stableCommandId({
      scope: workflowScope,
      requestKey: key,
      operation: "delegate-task",
    });
    return {
      key: commandId,
      threadId: derive.delegatedTaskThread({ commandId }),
      spawn: (input) => service.delegateTask(workflowScope, { ...input, clientRequestId: key }),
    };
  });
  yield* Effect.addFinalizer(() => Effect.sync(() => registerWorkflowsDelegate(null)));
  return OrchestratorMcpService.of(service);
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | Crypto.Crypto
  | ThreadManagementService.ThreadManagementService
  | ThreadLaunchService.ThreadLaunchService
  | ManagedProjectFolders.ManagedProjectFolders
  | GitVcsDriver.GitVcsDriver
  | ProviderRegistry.ProviderRegistry
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | ScheduledTaskService.ScheduledTaskService
  | ProjectService.ProjectService
  | SecretRequests.SecretRequests
  | ServerSettings.ServerSettingsService
  | UsageLimitSources.UsageLimitSources
> = Layer.effect(OrchestratorMcpService, make);
