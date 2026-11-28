import {
  assertProviderInstanceEnabled,
  ProjectAdmissionCommandId,
  ThreadManagementProviderInstanceDisabledError,
} from "./ProviderInstancePolicy.ts";
import * as TeamBoard from "../teamBoard/TeamBoard.ts";
import { AccountMoveUnavailableError, makeAccountMove } from "./AccountMove.ts";
import { isFirstCreatedChatFailure } from "./createdChatFailure.ts";
import * as LocalSubagentResources from "../execution/LocalSubagentResources.ts";
import * as ExecutionResources from "../execution/ExecutionResources.ts";
import { providerSteeringExecution } from "@t3tools/contracts";
import { delegatedTaskProgressForTask } from "./DelegatedTaskProgress.ts";
import {
  commitsSinceArgs,
  ownSubagentCheckout,
  SEEN_TURN_ITEM_TYPES,
  subagentSeen,
} from "./SubagentSeen.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as MonitorService from "../monitors/MonitorService.ts";
import type {
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2ThreadHistoryPage,
  ThreadMediaPage,
} from "@t3tools/contracts";
import {
  latestExecutedRun,
  latestRootProviderFailure,
  runRanAfter,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
  threadPullRequestKeysEqual,
  legacyThreadPullRequestKey,
} from "@t3tools/shared/threadPullRequests";
import {
  TerminalHandoffError,
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type ChatAttachment,
  CommandId,
  isProviderNativeSubagentThread,
  MessageId,
  NodeId,
  THREAD_PINNED_MESSAGES_LIMIT,
  type ThreadPinnedMessage,
  type ModelSelection,
  OrchestrationV2Command,
  type OrchestrationV2InternalCommand,
  type OrchestrationV2ServerCommand,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
  type OrchestrationV2AppThread,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2ContextSourcePoint,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ContextTransferResolution,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DelegatedCompletionCohort,
  type OrchestrationV2DelegatedCompletionDelivery,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ModelSwitch,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  latestProviderTurnForAttempt,
  orchestrationV2RunWorkStartedAt,
  ProviderInstanceId,
  ProviderInteractionMode,
  resolveProviderInstanceEnabled,
  type ProviderSessionId,
  type ProviderThreadId,
  RunId,
  RuntimeMode,
  SECRET_REQUEST_TURN_ITEM_ID_PREFIX,
  ThreadLinkedPullRequest,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { modelSwitchSince, unshownRunIds } from "./modelSwitch.ts";
import { isPlaceholderThreadTitle } from "./placeholderThreadTitle.ts";
import {
  backgroundWorkInterruptTarget,
  hasPendingBackgroundSubagent,
  pendingBackgroundTurnItems,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProjectStore from "./ProjectStore.ts";
import {
  isCheckpointRestoreIsolated,
  SHARED_WORKSPACE_RESTORE_MESSAGE,
} from "./CheckpointRestoreSafety.ts";
import { CheckpointServiceV2 } from "./CheckpointService.ts";
import {
  CommandPolicyV2,
  expandedCitationInputError,
  isNativeMaintenanceCommand,
  resolveMessageDispatchIntent,
} from "./CommandPolicy.ts";
import { CommandReceiptStoreV2 } from "./CommandReceiptStore.ts";
import { ContextHandoffServiceV2, isHandoffSourceRun } from "./ContextHandoffService.ts";
import { notificationTurnItem } from "@t3tools/provider-core/server/notification";
import {
  isRestartContinuationSource,
  rosterTaskWakesAgent,
  runOutcome,
} from "./RestartBackgroundNote.ts";
import {
  appOwnedMonitorGeneration,
  delegatedCompletionWakeDetail,
  isBufferedProviderNotification,
  isUndeliveredMailboxSteer,
  threadSendFields,
} from "./NotificationMailbox.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import type { OrchestrationEffectRequestV2, PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { DispatchModeLimit, exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import {
  applyToProjection,
  emptyProjection,
  threadShellFromProjection,
  ProjectionStoreV2,
  type ProjectionRecordField,
  type ProjectionTimelinePage,
  type ProjectionTimelinePageOptions,
  type ProjectionRecordFilter,
  type ProjectionRecords,
  type ProjectionCheckpointContext,
  type ShellSnapshotOptions,
} from "./ProjectionStore.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import { ProviderSessionManagerV2 } from "./ProviderSessionManager.ts";
import { ProviderSwitchServiceV2 } from "./ProviderSwitchService.ts";
import { isAutomaticCompletionRun, queuedRunsInDeliveryOrder } from "./QueuedRunOrder.ts";
import { RuntimePolicyV2 } from "./RuntimePolicy.ts";
import {
  endOrphanedNativeSubagent,
  endRunlessRootTurns,
  makeSubagentChildThread,
  subagentResultForRun,
  delegatedTaskProgress,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  forkableSourceRunStatusError,
  isForkableSourceRunStatus,
  ThreadForkServiceV2,
} from "./ThreadForkService.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";
import { WORKSPACE_PREPARATION_INPUT, workspacePreparationItem } from "./workspacePreparation.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ServerSettings from "../serverSettings.ts";

export class OrchestratorDispatchError extends Schema.TaggedError<OrchestratorDispatchError>()(
  "OrchestratorDispatchError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to dispatch orchestration command ${this.commandType} (${this.commandId}).`;
  }
}

export class OrchestratorThreadAlreadyExistsError extends Schema.TaggedError<OrchestratorThreadAlreadyExistsError>()(
  "OrchestratorThreadAlreadyExistsError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return `Thread ${this.threadId} already exists. Use a new thread id.`;
  }
}

export class OrchestratorCommandRejectedError extends Schema.TaggedError<OrchestratorCommandRejectedError>()(
  "OrchestratorCommandRejectedError",
  { commandId: CommandId, commandType: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return `Orchestration command ${this.commandType} (${this.commandId}) was rejected before commit.`;
  }
}

export class OrchestratorProjectionError extends Schema.TaggedError<OrchestratorProjectionError>()(
  "OrchestratorProjectionError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to load orchestration projection for thread ${this.threadId}.`;
  }
}

export class OrchestratorDomainEventStreamError extends Schema.TaggedError<OrchestratorDomainEventStreamError>()(
  "OrchestratorDomainEventStreamError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed while streaming orchestration domain events.";
  }
}

export class OrchestratorProviderAdapterError extends Schema.TaggedError<OrchestratorProviderAdapterError>()(
  "OrchestratorProviderAdapterError",
  {
    commandId: CommandId,
    providerInstanceId: ProviderInstanceId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider adapter failed while dispatching orchestration command ${this.commandId}.`;
  }
}

export class OrchestratorSubagentThreadReadOnlyError extends Schema.TaggedError<OrchestratorSubagentThreadReadOnlyError>()(
  "OrchestratorSubagentThreadReadOnlyError",
  { commandId: CommandId, threadId: ThreadId },
) {
  override get message(): string {
    return "This subagent is run by its provider and cannot take messages. Message the parent thread instead.";
  }
}

/** The command's thread runs above the modes its sender may touch (see `DispatchModeLimit`). */
export class OrchestratorThreadAboveModeLimitError extends Schema.TaggedError<OrchestratorThreadAboveModeLimitError>()(
  "OrchestratorThreadAboveModeLimitError",
  {
    commandId: CommandId,
    threadId: ThreadId,
    mode: Schema.Literals(["runtime", "interaction"]),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} now runs in ${this.runtimeMode}/${this.interactionMode} mode, above what this caller may change.`;
  }
}

export class OrchestratorCommandPreviouslyRejectedError extends Schema.TaggedError<OrchestratorCommandPreviouslyRejectedError>()(
  "OrchestratorCommandPreviouslyRejectedError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was previously rejected: ${this.detail}`;
  }
}

export class OrchestratorCommandIdConflictError extends Schema.TaggedError<OrchestratorCommandIdConflictError>()(
  "OrchestratorCommandIdConflictError",
  {
    commandId: CommandId,
    commandType: Schema.String,
    receiptThreadId: ThreadId,
    commandThreadId: ThreadId,
  },
) {
  override get message(): string {
    return `Command ${this.commandId} was already handled for thread ${this.receiptThreadId} and cannot be replayed for ${this.commandThreadId}.`;
  }
}

/**
 * A command receipt only proves that this exact command already ran for the
 * thread it was recorded against. Replaying it for a command aimed at another
 * thread would report success for work that never happened there, so the
 * dispatcher rejects the reuse instead (mirrors v1's command-id conflict).
 */
export function canReplayCommandReceipt(
  receiptThreadId: ThreadId,
  commandThreadId: ThreadId,
): boolean {
  return receiptThreadId === commandThreadId;
}

/**
 * The text of one answer to a question that is answered by message. Clients
 * send a multi-choice answer as the list of picked options; each picked option
 * gets its own line, since option labels can contain commas.
 */
export function messageAnswerText(answer: unknown): string {
  if (typeof answer === "string") return answer.trim();
  if (!Array.isArray(answer)) return "";
  const picked = answer.flatMap((option) =>
    typeof option === "string" && option.trim().length > 0 ? [option.trim()] : [],
  );
  return picked.length > 1 ? picked.map((option) => `- ${option}`).join("\n") : (picked[0] ?? "");
}

export const OrchestratorV2Error = Schema.Union([
  AccountMoveUnavailableError,
  ThreadManagementProviderInstanceDisabledError,
  TerminalHandoffError,
  OrchestratorDispatchError,
  OrchestratorThreadAlreadyExistsError,
  OrchestratorCommandRejectedError,
  OrchestratorProjectionError,
  OrchestratorDomainEventStreamError,
  OrchestratorProviderAdapterError,
  OrchestratorCommandPreviouslyRejectedError,
  OrchestratorCommandIdConflictError,
  OrchestratorSubagentThreadReadOnlyError,
  OrchestratorThreadAboveModeLimitError,
]);
export type OrchestratorV2Error = typeof OrchestratorV2Error.Type;

export interface OrchestratorV2DispatchResult {
  readonly sequence: number;
  readonly storedEvents: ReadonlyArray<OrchestrationV2StoredEvent>;
}

export interface OrchestratorV2Shape {
  readonly resumeQueuedRuns: Effect.Effect<number, OrchestratorV2Error>;
  /** Startup pass that settles delegated-task results and deliveries runs left behind. */
  readonly recoverDelegatedTasks: Effect.Effect<void>;
  /**
   * Settles a delegated child's task once nothing holds it any more: on demand, when a
   * read finds it unsettled, or after its restart continuation of `sourceRunId` declined
   * or failed, which then no longer holds it.
   */
  readonly recoverDelegatedTask: (threadId: ThreadId, sourceRunId?: RunId) => Effect.Effect<void>;
  /**
   * Whether a delegated child's apparent result is not final yet: a restart
   * continuation is pending, or the child is working again.
   * A taskId limits the check to that follow-up's runs.
   */
  readonly delegatedTaskResultPending: (
    childThreadId: ThreadId,
    taskId?: NodeId,
  ) => Effect.Effect<boolean, OrchestratorProjectionError>;
  /**
   * Whether a restart continuation of this cut run has not started yet, so the
   * run's status is not its outcome. A failed read counts as not pending.
   */
  readonly restartContinuationPending: (run: OrchestrationV2Run) => Effect.Effect<boolean>;
  /**
   * Resolves once that continuation has run or was declined. A declined one
   * records no thread event, so a waiter needs this to wake.
   */
  readonly awaitRestartContinuation: (run: OrchestrationV2Run) => Effect.Effect<void>;
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, OrchestratorV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, OrchestratorV2Error>;
  readonly getThreadHistoryPage: (
    threadId: ThreadId,
    cursor: string,
    throughEntryId?: string,
    conversationOnly?: boolean,
  ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, OrchestratorV2Error>;
  readonly getThreadMediaPage: (
    threadId: ThreadId,
    cursor: string,
  ) => Effect.Effect<ThreadMediaPage, OrchestratorV2Error>;
  readonly getTimelinePage: (
    threadId: ThreadId,
    options: ProjectionTimelinePageOptions,
  ) => Effect.Effect<ProjectionTimelinePage, OrchestratorProjectionError>;
  readonly getMessageCount: (threadId: ThreadId) => Effect.Effect<number, OrchestratorV2Error>;
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2TurnItem | null, OrchestratorV2Error>;
  readonly getThreadRecords: <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, OrchestratorV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, OrchestratorV2Error>;
  readonly getCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionCheckpointContext, OrchestratorV2Error>;
  readonly getThreadSnapshot: (threadId: ThreadId) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    OrchestratorV2Error
  >;
  readonly getThreadSnapshotWindow: (
    threadId: ThreadId,
    options: Parameters<ProjectionStoreV2["Service"]["getThreadSnapshotWindow"]>[1],
  ) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    OrchestratorV2Error
  >;
  readonly getPullRequestSnapshot: (
    options: Parameters<ProjectionStoreV2["Service"]["getPullRequestSnapshot"]>[0],
  ) => Effect.Effect<
    Effect.Success<ReturnType<ProjectionStoreV2["Service"]["getPullRequestSnapshot"]>>,
    OrchestratorV2Error
  >;
  readonly getShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, OrchestratorV2Error>;
  /** See `ProjectionStoreV2Shape.readShellSnapshot`. */
  readonly readShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, OrchestratorV2Error>,
    OrchestratorV2Error
  >;
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, OrchestratorV2Error>;
  readonly getThreadEventSequence: (
    threadId: ThreadId,
  ) => Effect.Effect<number, OrchestratorV2Error>;
  readonly streamStoredEvents: Stream.Stream<OrchestrationV2StoredEvent, OrchestratorV2Error>;
  readonly streamStoredEventsFrom: (input?: {
    readonly threadId?: ThreadId;
    readonly afterSequence?: number;
    /** Keep only this type, before the bounded buffer retains anything. */
    readonly eventType?: OrchestrationV2DomainEvent["type"];
  }) => Stream.Stream<OrchestrationV2StoredEvent, OrchestratorV2Error>;
  readonly streamDomainEvents: Stream.Stream<OrchestrationV2DomainEvent, OrchestratorV2Error>;
}

export class OrchestratorV2 extends Context.Service<OrchestratorV2, OrchestratorV2Shape>()(
  "t3/orchestration-v2/Orchestrator/OrchestratorV2",
) {}

/** Run ordinals can skip values: a queued run moves past newer runs when it starts. */
function nextRunOrdinal(projection: Pick<OrchestrationV2ThreadProjection, "runs">): number {
  return projection.runs.reduce((max, run) => Math.max(max, run.ordinal), 0) + 1;
}

/**
 * A wake (background notification, delegated task result, restart
 * continuation) carries on the work of the run that started last, so it keeps
 * that work's start. Stamp it when the wake run starts, not when it queues:
 * a queued prompt ahead of it has no start yet, and delegated results jump
 * the queue. Other runs start new work.
 */
function wakeWorkStartedAt(
  runs: ReadonlyArray<OrchestrationV2Run>,
  trigger: {
    readonly notification?: unknown;
    readonly delegatedCompletion?: unknown;
    readonly restartContinuationOfRunId?: RunId | undefined;
  },
): Pick<OrchestrationV2Run, "workStartedAt"> {
  if (
    trigger.notification === undefined &&
    trigger.delegatedCompletion === undefined &&
    trigger.restartContinuationOfRunId === undefined
  ) {
    return {};
  }
  const previous = runs
    .flatMap((run) => (run.startedAt === null ? [] : [{ run, startedAt: run.startedAt }]))
    .toSorted(
      (left, right) =>
        DateTime.Order(right.startedAt, left.startedAt) || right.run.ordinal - left.run.ordinal,
    )[0]?.run;
  return previous === undefined ? {} : { workStartedAt: orchestrationV2RunWorkStartedAt(previous) };
}

/** A native `/goal` command. It changes the provider's goal, so it never steers a running turn. */
function isGoalCommand(message: {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}): boolean {
  return message.attachments.length === 0 && /^\/goal(?:\s|$)/u.test(message.text.trim());
}

const threadPullRequestLinksEqual = Schema.toEquivalence(Schema.NullOr(ThreadLinkedPullRequest));

function commandThreadId(command: OrchestrationV2ServerCommand): ThreadId {
  switch (command.type) {
    case "delegated_task.remote.sync":
    case "thread.create":
    case "thread.created.report":
    case "thread.archive":
    case "thread.unarchive":
    case "thread.delete":
    case "thread.settle":
    case "thread.auto-settle":
    case "thread.unsettle":
    case "thread.snooze":
    case "thread.unsnooze":
    case "thread.auto-settle.set":
    case "thread.pin":
    case "thread.unpin":
    case "thread.pin.reorder":
    case "thread.active.reorder":
    case "thread.visit":
    case "thread.mark-unread":
    case "thread.metadata.update":
    case "thread.pull-request.link":
    case "thread.pull-request.unlink":
    case "thread.pull-request-link.sync":
    case "thread.pull-request.watch":
    case "thread.pull-request-watch.sync":
    case "thread.pull-request.sync":
    case "thread.title.regeneration.complete":
    case "thread.runtime-mode.set":
    case "thread.interaction-mode.set":
    case "thread.model-selection.set":
    case "provider-session.detach":
    case "provider-retry.cancel":
    case "message.dispatch":
    case "notification.delivery.accept":
    case "prepared-run.release":
    case "prepared-run.progress":
    case "prepared-run.fail":
    case "prepared-run.retry":
    case "subagent.stop":
    case "run.interrupt":
    case "queued-message.promote-to-steer":
    case "queue.resume":
    case "queued-run.reorder":
    case "queued-run.cancel":
    case "queued-run.edit":
    case "runtime-request.respond":
    case "thread.user-input.dismiss":
    case "checkpoint.rollback":
    case "checkpoint.rollback.fail":
    case "thread.background-work.settle":
    case "thread.stop":
    case "provider.switch":
      return command.threadId;
    case "delegated_task.request":
    case "delegated_task.wake-policy":
    case "delegated_task.cancel-requested":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
    case "thread.created.record":
      return command.parentThreadId;
    case "secret_request.record":
    case "user_question.ask":
      return command.threadId;
    case "thread.fork":
    case "thread.merge_back":
      return command.targetThreadId;
  }
}

function pendingThreadTitleGenerationEffect(
  commandId: CommandId,
  threadId: ThreadId,
  kind:
    | { readonly type: "initial"; readonly messageId: MessageId }
    | { readonly type: "regenerate" },
): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${commandId}:thread-title.generate`,
    commandId,
    threadId,
    request: { type: "thread-title.generate", kind },
  };
}

// Clients seed a new thread with its first message, and empty threads start as "New thread" (or
// "New chat") or an agent's placeholder. Any other title on a thread without messages was chosen
// on purpose. Forks, side chats included, are titled from their source history instead.
function hasTitleSetBeforeFirstMessage(
  thread: OrchestrationV2AppThread,
  titleSeed: string | undefined,
): boolean {
  const title = thread.title.trim();
  return (
    thread.forkedFrom === null &&
    title.length > 0 &&
    title !== "New thread" &&
    title !== "New chat" &&
    !isPlaceholderThreadTitle(title) &&
    title !== titleSeed?.trim()
  );
}

function delegatedTasksStopEffect(command: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly reason?: string | undefined;
}): PendingOrchestrationEffectV2 {
  return {
    id: `effect:${command.commandId}:delegated-tasks.stop`,
    commandId: command.commandId,
    threadId: command.threadId,
    request: {
      type: "delegated-tasks.stop",
      ...(command.reason === undefined ? {} : { reason: command.reason }),
    },
  };
}

/** A reopened preparation item drops the output and exit code of the attempt it replaces. */
function withoutPreparationResult(
  item: Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }>,
) {
  const { output: _output, exitCode: _exitCode, outputIndicatesFailure: _failure, ...rest } = item;
  return rest;
}

function isBlockingRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

/**
 * A parent thread is "live" for wake purposes while a run is still producing
 * agent output. A run parked at "waiting" is post-terminal drain, so its agent
 * turn is over and a wake is still needed.
 */
function hasLiveRun(projection: Pick<OrchestrationV2ThreadProjection, "runs">): boolean {
  return projection.runs.some(
    (run) => run.status === "preparing" || run.status === "starting" || run.status === "running",
  );
}

/** The link with its watch replaced, or removed when `watch` is undefined. */
function withPullRequestWatch(
  link: ThreadPullRequestLink,
  watch: ThreadPullRequestWatch | undefined,
): ThreadPullRequestLink {
  const { watch: _previous, ...rest } = link;
  return watch === undefined ? rest : { ...rest, watch };
}

/** A legacy single-PR link as a link entry. Re-linking a pull request keeps its watch. */
function legacyPullRequestLink(
  thread: OrchestrationV2AppThread,
  linked: ThreadLinkedPullRequest,
  now: DateTime.Utc,
): ThreadPullRequestLink {
  const key = legacyThreadPullRequestKey(linked);
  return withPullRequestWatch(
    {
      ...key,
      url: linked.url,
      source: "manual",
      linkedAt: DateTime.formatIso(now),
      snapshot: null,
      stack: null,
    },
    threadPullRequestsOf(thread).find((link) => threadPullRequestKeysEqual(link, key))?.watch,
  );
}

function isTerminalDelegatedTaskStatus(status: OrchestrationV2Subagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

/** Holds a child's settled run for the turn its ended background work starts by itself. */
const backgroundWakeContinuationEffectId = (runId: RunId) =>
  `effect:provider-continuation:${runId}:background-wake`;

function delegatedTaskTerminalStatus(
  status: OrchestrationV2Run["status"],
): "completed" | "failed" | "cancelled" | "interrupted" | null {
  switch (status) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return status;
    case "rolled_back":
      return "cancelled";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
      return null;
  }
}

function nextQueuedRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages">,
): OrchestrationV2Run | undefined {
  return queuedRunsInDeliveryOrder(projection)[0];
}

function latestStableRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | null {
  return (
    projection.runs
      .filter((run) => run.status === "completed" && run.checkpointId !== null)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null
  );
}

function runForSourcePoint(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "checkpoints">,
  sourcePoint: Extract<
    OrchestrationV2Command,
    { readonly type: "thread.fork" | "thread.merge_back" }
  >["sourcePoint"],
): OrchestrationV2Run | null {
  switch (sourcePoint.type) {
    case "latest_stable":
      return latestStableRun(projection);
    case "run":
      return projection.runs.find((run) => run.id === sourcePoint.runId) ?? null;
    case "checkpoint": {
      const checkpoint = projection.checkpoints.find(
        (candidate) => candidate.id === sourcePoint.checkpointId,
      );
      return checkpoint?.runId === null || checkpoint === undefined
        ? null
        : (projection.runs.find((run) => run.id === checkpoint.runId) ?? null);
    }
  }
}

function providerThreadForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads">,
  run: OrchestrationV2Run,
): OrchestrationV2ProviderThread | undefined {
  return run.providerThreadId === null
    ? undefined
    : projection.providerThreads.find((candidate) => candidate.id === run.providerThreadId);
}

function providerTurnForRun(
  projection: Pick<OrchestrationV2ThreadProjection, "providerTurns" | "attempts">,
  run: OrchestrationV2Run,
): OrchestrationV2ProviderTurn | undefined {
  if (run.activeAttemptId === null) {
    return undefined;
  }

  return (
    latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId) ??
    projection.providerTurns.find((turn) => {
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      return attempt?.providerTurnId === turn.id;
    })
  );
}

function contextSourcePointForRun(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "providerThreads" | "providerTurns" | "attempts"
  >,
  run: OrchestrationV2Run,
): OrchestrationV2ContextSourcePoint {
  const providerThread = providerThreadForRun(projection, run);
  const providerTurn = providerTurnForRun(projection, run);
  return {
    threadId: projection.thread.id,
    runId: run.id,
    ...(run.checkpointId === null ? {} : { checkpointId: run.checkpointId }),
    ...(providerThread?.nativeThreadRef === null || providerThread?.nativeThreadRef === undefined
      ? {}
      : { providerThreadRef: providerThread.nativeThreadRef }),
    ...(providerTurn?.nativeTurnRef === null || providerTurn?.nativeTurnRef === undefined
      ? {}
      : { providerTurnRef: providerTurn.nativeTurnRef }),
  };
}

function pendingForkTransferForThread(
  projection: Pick<OrchestrationV2ThreadProjection, "contextTransfers" | "thread">,
): OrchestrationV2ContextTransfer | undefined {
  return projection.contextTransfers.find(
    (transfer) =>
      transfer.type === "fork" &&
      transfer.targetThreadId === projection.thread.id &&
      transfer.status === "pending",
  );
}

function pendingMergeBackTransfersForThread(
  projection: Pick<OrchestrationV2ThreadProjection, "contextTransfers" | "thread">,
): ReadonlyArray<OrchestrationV2ContextTransfer> {
  return projection.contextTransfers.filter(
    (transfer) =>
      transfer.type === "merge_back" &&
      transfer.targetThreadId === projection.thread.id &&
      transfer.status === "pending",
  );
}

function latestContextTransfer(
  transfers: ReadonlyArray<OrchestrationV2ContextTransfer>,
): OrchestrationV2ContextTransfer | undefined {
  return transfers.reduce<OrchestrationV2ContextTransfer | undefined>((latest, transfer) => {
    if (latest === undefined) {
      return transfer;
    }
    return DateTime.toEpochMillis(transfer.updatedAt) >= DateTime.toEpochMillis(latest.updatedAt)
      ? transfer
      : latest;
  }, undefined);
}

function visibleDeltaRunOrdinals(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): OrchestrationV2ContextHandoff["coveredRunOrdinals"] {
  const ordinals = items.flatMap((item) => {
    if (item.runId === null) {
      return [];
    }
    const run = projection.runs.find((candidate) => candidate.id === item.runId);
    return run === undefined ? [] : [run.ordinal];
  });
  if (ordinals.length === 0) {
    return { from: 1, to: 1 };
  }
  return {
    from: Math.min(...ordinals),
    to: Math.max(...ordinals),
  };
}

export function shouldPrepareLegacyImportHandoff(input: {
  readonly hasNativeHistory?: boolean;
  readonly hasCompletedRun: boolean;
  readonly historyOrigin: OrchestrationV2AppThread["historyOrigin"];
  readonly legacyImportItemCount: number;
}): boolean {
  return (
    input.historyOrigin === "v1_import" &&
    !input.hasNativeHistory &&
    !input.hasCompletedRun &&
    input.legacyImportItemCount > 0
  );
}

export function appendContextHandoffId(
  handoffIds: OrchestrationV2ProviderThread["handoffIds"],
  handoffId: OrchestrationV2ContextHandoff["id"] | null,
): OrchestrationV2ProviderThread["handoffIds"] {
  return handoffId === null ? handoffIds : Array.from(new Set([...handoffIds, handoffId]));
}

function rootProviderThreadsForProvider(
  projection: Pick<OrchestrationV2ThreadProjection, "providerThreads" | "thread">,
  providerInstanceId: ModelSelection["instanceId"],
): ReadonlyArray<OrchestrationV2ProviderThread> {
  return projection.providerThreads
    .filter(
      (providerThread) =>
        providerThread.providerInstanceId === providerInstanceId &&
        providerThread.appThreadId === projection.thread.id &&
        providerThread.ownerNodeId === null,
    )
    .toSorted(
      (left, right) =>
        (right.lastRunOrdinal ?? 0) - (left.lastRunOrdinal ?? 0) ||
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
}

function lastDeliveredRunForProviderThread(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
  providerThreadId: OrchestrationV2ProviderThread["id"],
): OrchestrationV2Run | undefined {
  return projection.runs.findLast(
    (run) =>
      isHandoffSourceRun(run) &&
      run.providerThreadId === providerThreadId &&
      (run.status === "completed" ||
        projection.providerTurns.some((turn) => turn.runAttemptId === run.activeAttemptId)),
  );
}

/**
 * A chat's pinned messages after pinning or unpinning one: a new pin goes last, pinning a pinned
 * message keeps its place, and past the limit the oldest pins drop.
 */
export function withMessagePin(
  pins: ReadonlyArray<ThreadPinnedMessage>,
  change: {
    readonly messageId: MessageId;
    readonly pinned: boolean;
    readonly preview?: string | undefined;
  },
  now: DateTime.Utc,
): ReadonlyArray<ThreadPinnedMessage> {
  const others = pins.filter((pin) => pin.messageId !== change.messageId);
  if (!change.pinned) return others;
  if (others.length !== pins.length) return pins;
  const preview = change.preview?.trim();
  return [
    ...others,
    { messageId: change.messageId, pinnedAt: now, ...(preview ? { preview } : {}) },
  ].slice(-THREAD_PINNED_MESSAGES_LIMIT);
}

const makeOrchestrator = Effect.fn("orchestrationV2.Orchestrator.layer")(function* () {
  const teamBoard = Option.getOrUndefined(yield* Effect.serviceOption(TeamBoard.TeamBoard));
  const checkpointService = yield* CheckpointServiceV2;
  const commandPolicy = yield* CommandPolicyV2;
  const contextHandoffService = yield* ContextHandoffServiceV2;
  const eventSink = yield* EventSinkV2;
  const commandReceipts = yield* CommandReceiptStoreV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const projectionStore = yield* ProjectionStoreV2;
  const pendingSteerThreads = new Set(
    yield* projectionStore.getRecoveryThreadIds("steer-when-live").pipe(Effect.orDie),
  );
  const refreshPendingSteerThread = (threadId: ThreadId) =>
    projectionStore.getThreadRecords(threadId, ["runs"], { activeRunsOnly: true }).pipe(
      Effect.tap((projection) =>
        Effect.sync(() => {
          const activeIds = new Set(
            projection.runs
              .filter(
                (run) =>
                  run.status === "preparing" ||
                  run.status === "starting" ||
                  run.status === "running" ||
                  run.status === "waiting",
              )
              .map((run) => run.id),
          );
          if (
            !projection.runs.some(
              (run) =>
                run.status === "queued" &&
                run.steerWhenLiveRunId !== undefined &&
                activeIds.has(run.steerWhenLiveRunId),
            )
          ) {
            pendingSteerThreads.delete(threadId);
          }
        }),
      ),
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to refresh pending steers", { threadId, cause }),
      ),
    );
  const effectOutbox = yield* EffectOutbox.EffectOutboxV2;
  const nextTurnItemOrdinal = (
    projection: Pick<OrchestrationV2ThreadProjection, "thread"> &
      Partial<Pick<OrchestrationV2ThreadProjection, "turnItems">>,
  ) =>
    projectionStore.getNextTurnItemOrdinal(projection.thread.id).pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: projection.thread.id, cause }),
      ),
      Effect.map((next) =>
        (projection.turnItems ?? []).reduce(
          (ordinal, item) => Math.max(ordinal, item.ordinal + 1),
          next,
        ),
      ),
    );

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const providerAdapters = yield* ProviderAdapterRegistryV2;
  const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
  const providerSessions = yield* ProviderSessionManagerV2;
  const providerSwitchService = yield* ProviderSwitchServiceV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const accountMoves = yield* makeAccountMove;
  const runtimePolicy = yield* RuntimePolicyV2;
  const threadForkService = yield* ThreadForkServiceV2;
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const ownership = yield* ExecutionResources.ExecutionResources;
  const monitors = yield* Effect.serviceOption(MonitorService.MonitorService);
  // Only for the commits a finished subagent made; absent in tests that need no Git.
  const git = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
  const monitorStopReceiptType = "monitor.stop.applied";

  const mapDispatchError =
    (command: OrchestrationV2ServerCommand) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OrchestratorDispatchError, R> =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );

  const mapDelegatedCompletionError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: CommandId.make("command:system:delegated-completion-delivery"),
            commandType: "delegated_task.completion-delivery",
            cause,
          }),
      ),
    );

  const providerSessionIdFor = (input: {
    readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
    readonly providerInstanceId: ProviderInstanceId;
    readonly threadId: ThreadId;
  }) =>
    input.adapter.getCapabilities().pipe(
      Effect.flatMap((capabilities) =>
        capabilities.sessions.supportsMultipleProviderThreadsPerSession
          ? Effect.succeed(
              idAllocator.derive.providerSession({
                providerInstanceId: input.providerInstanceId,
              }),
            )
          : idAllocator.allocate.providerSession({
              providerInstanceId: input.providerInstanceId,
              threadId: input.threadId,
            }),
      ),
    );

  const enforceCommandPolicy =
    (command: OrchestrationV2Command) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, OrchestratorDispatchError, R> =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );

  const makeEvent = <Event extends OrchestrationV2DomainEvent>(
    command: OrchestrationV2ServerCommand,
    event: Omit<Event, "id">,
  ) =>
    Effect.gen(function* () {
      const eventId = yield* mapDispatchError(command)(
        idAllocator.allocate.event({
          threadId: event.threadId,
          commandId: command.commandId,
        }),
      );
      return {
        ...event,
        id: eventId,
      } as Event;
    });

  const emit =
    (events: Ref.Ref<Array<OrchestrationV2DomainEvent>>, command: OrchestrationV2ServerCommand) =>
    <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
      Effect.gen(function* () {
        const withId = yield* makeEvent(command, event);
        yield* Ref.update(events, (existing) => [...existing, withId]);
        return withId;
      });

  const readHandoffItems = (threadId: ThreadId, runIds?: ReadonlyArray<RunId | null>) =>
    projectionStore
      .getThreadRecords(
        threadId,
        ["turnItems"],
        runIds === undefined ? undefined : { turnItemRunIds: runIds },
      )
      .pipe(
        Effect.map((records) => records.turnItems),
        Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })),
      );

  // A wake run shows as a notification row, which command projections leave out. Its row draws
  // the run's model switch, so later runs measure from it.
  const modelSwitchFor = (
    threadId: ThreadId,
    projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
    to: ModelSelection,
    baseline?: ModelSelection,
  ) =>
    Effect.gen(function* () {
      const runIds = unshownRunIds(projection);
      // The usual case reads nothing: with every run in question on this selection already, no
      // row can change the answer. Only a thread whose wakes ran on another selection looks.
      const withoutWakes = modelSwitchSince(projection, to, baseline);
      const unshown = new Set<RunId>(runIds);
      if (
        runIds.length === 0 ||
        (withoutWakes.modelSwitch === undefined &&
          projection.runs.every(
            (run) => !unshown.has(run.id) || modelSelectionsEqual(run.modelSelection, to),
          ))
      ) {
        return withoutWakes;
      }
      const notifications = (yield* projectionStore
        .getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["notification"],
          turnItemRunIds: runIds,
        })
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))))
        .turnItems;
      return modelSwitchSince(
        { runs: projection.runs, turnItems: [...projection.turnItems, ...notifications] },
        to,
        baseline,
      );
    });

  const getDelegatedCohortProjectionWithPendingEvents = (
    threadId: ThreadId,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    options?: { readonly includeQueuedDelivery?: boolean },
  ) =>
    Effect.gen(function* () {
      const pending = (yield* Ref.get(events)).filter((event) => event.threadId === threadId);
      const baseRecords = yield* projectionStore
        .getThreadRecords(threadId, ["runs", "subagents"])
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      let projection: OrchestrationV2ThreadProjection = {
        ...emptyProjection({
          payload: baseRecords.thread,
          occurredAt: baseRecords.thread.updatedAt,
        }),
        ...baseRecords,
      };
      for (const event of pending) {
        if (event.type === "thread.created" && projection.thread.id === event.payload.id) {
          projection = { ...projection, thread: event.payload, updatedAt: event.occurredAt };
          continue;
        }
        projection = applyToProjection(projection, event);
      }
      if (options?.includeQueuedDelivery !== false) {
        const deliveryMessageIds = [
          ...new Set(
            projection.runs.flatMap((run) =>
              run.delegatedCompletion?.delivery != null
                ? [run.delegatedCompletion.delivery.messageId]
                : [],
            ),
          ),
        ];
        if (deliveryMessageIds.length > 0) {
          const queuedRuns = projection.runs.filter((run) => run.status === "queued");
          const deliveryRecords = yield* projectionStore
            .getThreadRecords(threadId, ["messages", "nodes", "attempts"], {
              messageIds: deliveryMessageIds,
              unorderedMessages: true,
              nodeIds: queuedRuns.flatMap((run) =>
                run.rootNodeId === null ? [] : [run.rootNodeId],
              ),
              attemptRunIds: queuedRuns.map((run) => run.id),
            })
            .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
          projection = {
            ...projection,
            messages: deliveryRecords.messages,
            nodes: deliveryRecords.nodes,
            attempts: deliveryRecords.attempts,
          };
          for (const event of pending) {
            if (
              event.type === "message.updated" ||
              event.type === "node.updated" ||
              event.type === "run-attempt.updated"
            ) {
              projection = applyToProjection(projection, event);
            }
          }
        }
      }
      return projection;
    });

  const getProjectionWithPendingEvents = (
    threadId: ThreadId,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    send: Extract<OrchestrationV2Command, { type: "message.dispatch" }> | "thread" | "handoff",
  ) =>
    Effect.gen(function* () {
      const pending = (yield* Ref.get(events)).filter((event) => event.threadId === threadId);
      // A child created by this command exists only in its pending events until commit.
      const created = pending.find((event) => event.type === "thread.created");
      if (created) return pending.reduce(applyToProjection, emptyProjection(created));
      const pendingHistoryEdits = pending.some(
        (event) =>
          event.type === "run.updated" ||
          event.type === "run.created" ||
          event.type === "message.updated" ||
          (event.type === "turn-item.updated" && event.payload.type === "user_message"),
      );
      const stored = yield* (
        send === "thread" || send === "handoff"
          ? projectionStore
              .getThreadRecords(
                threadId,
                send === "thread" ? [] : ["runs", "attempts", "providerTurns", "providerThreads"],
              )
              .pipe(
                Effect.map((records): OrchestrationV2ThreadProjection => ({
                  ...emptyProjection({
                    payload: records.thread,
                    occurredAt: records.thread.updatedAt,
                  }),
                  ...records,
                })),
              )
          : projectionStore.getMessageDispatchProjection(threadId, {
              messageId: send.messageId,
              targetRunId:
                "targetRunId" in send.dispatchMode ? send.dispatchMode.targetRunId : undefined,
              instanceId: send.modelSelection?.instanceId,
              // Also loads an earlier user message for the empty-thread test
              // an auto deferred start makes in resolveMessageDispatchIntent.
              checkMaintenanceHistory:
                (send.createdBy === "user" && !isNativeMaintenanceCommand(send)) ||
                (send.deliveryIntent === "auto" && send.dispatchMode.type === "defer_start"),
              includeSubagents: send.notification !== undefined,
              needsRunHistory:
                send.delegatedCompletion !== undefined ||
                send.providerRetryContinuationOfRunId !== undefined ||
                send.restartContinuationOfRunId !== undefined ||
                send.manualContinuationOfRunId !== undefined ||
                send.usageLimitContinuationOfRunId !== undefined ||
                pendingHistoryEdits,
              pendingHistoryEdits,
            })
      ).pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      return pending.reduce(applyToProjection, stored);
    });

  const makeSystemEvent = <Event extends OrchestrationV2DomainEvent>(event: Omit<Event, "id">) =>
    Effect.gen(function* () {
      const eventId = yield* idAllocator.allocate.event({
        threadId: event.threadId,
      });
      return {
        ...event,
        id: eventId,
      } as Event;
    });

  const writeSystemEvents = (
    events: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">>,
    effects: ReadonlyArray<PendingOrchestrationEffectV2> = [],
  ) =>
    Effect.gen(function* () {
      const withIds = yield* Effect.forEach(events, (event) =>
        makeSystemEvent(event as Omit<OrchestrationV2DomainEvent, "id">),
      );
      yield* eventSink.writeWithEffects({ events: withIds, effects });
    });

  const completionDeliveryRun = (
    projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
    delivery: OrchestrationV2DelegatedCompletionDelivery | null | undefined,
  ) => {
    if (delivery == null) return undefined;
    const message = projection.messages.find((candidate) => candidate.id === delivery.messageId);
    return projection.runs.find((candidate) => candidate.id === message?.runId);
  };

  const completionDeliveryMessage = (
    projection: Pick<OrchestrationV2ThreadProjection, "messages">,
    delivery: OrchestrationV2DelegatedCompletionDelivery | null | undefined,
  ) =>
    delivery === null || delivery === undefined
      ? undefined
      : projection.messages.find((candidate) => candidate.id === delivery.messageId);

  const offerDelegatedCompletionDelivery = (threadId: ThreadId, parentRunId: RunId) =>
    Effect.gen(function* () {
      const controls = yield* projectionStore.getThreadRecords(threadId, ["runs"], {
        runIds: [parentRunId],
      });
      const parentRun = controls.runs[0];
      const cohort = parentRun?.delegatedCompletion;
      const delivery = cohort?.delivery;
      if (
        parentRun === undefined ||
        cohort?.disposition !== "open" ||
        delivery == null ||
        delivery.taskIds.length === 0 ||
        controls.thread.archivedAt !== null ||
        controls.thread.deletedAt !== null
      )
        return;
      const messages = yield* projectionStore.getThreadRecords(threadId, ["messages"], {
        messageIds: [delivery.messageId],
      });
      const message = messages.messages[0];
      if (message !== undefined) {
        if (message.delegatedCompletion === undefined || message.runId === null) return;
        const runs = yield* projectionStore.getThreadRecords(threadId, ["runs"], {
          runIds: [message.runId],
        });
        const run = runs.runs[0];
        const turns = yield* projectionStore.getThreadRecords(threadId, ["providerTurns"], {
          providerTurnAttemptIds: run?.activeAttemptId == null ? [] : [run.activeAttemptId],
        });
        if (!isUndeliveredMailboxSteer({ ...messages, ...runs, ...turns }, delivery.messageId))
          return;
      }
      const projection = yield* projectionStore.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: parentRun.providerThreadId === null ? [] : [parentRun.providerThreadId],
      });
      const providerThread =
        parentRun.providerThreadId === null
          ? undefined
          : projection.providerThreads.find(
              (candidate) => candidate.id === parentRun.providerThreadId,
            );
      if (providerThread === undefined) {
        return;
      }
      yield* continuationRequests.offer({
        threadId,
        providerThreadId: providerThread.id,
        driver: providerThread.driver,
        detail: null,
        delivery: "message_text",
        delegatedCompletion: {
          parentRunId,
          generation: delivery.generation,
          messageId: delivery.messageId,
        },
      });
    });

  const offerDelegatedCompletionDeliveries = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
      for (const run of projection.runs) {
        if (
          run.delegatedCompletion?.delivery !== undefined &&
          run.delegatedCompletion.delivery !== null
        ) {
          yield* offerDelegatedCompletionDelivery(threadId, run.id);
        }
      }
    });

  const emitQueuedRunCancellation = (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<OrchestrationV2ThreadProjection, "nodes" | "attempts">;
    readonly run: OrchestrationV2Run;
    readonly now: DateTime.Utc;
  }) =>
    Effect.gen(function* () {
      const rootNode =
        input.run.rootNodeId === null
          ? undefined
          : input.projection.nodes.find((candidate) => candidate.id === input.run.rootNodeId);
      const attempt =
        input.run.activeAttemptId === null
          ? undefined
          : input.projection.attempts.find(
              (candidate) => candidate.id === input.run.activeAttemptId,
            );
      const emitEvent = emit(input.events, input.command);
      yield* emitEvent({
        type: "run.updated",
        threadId: input.run.threadId,
        runId: input.run.id,
        ...(input.run.rootNodeId === null ? {} : { nodeId: input.run.rootNodeId }),
        providerInstanceId: input.run.providerInstanceId,
        occurredAt: input.now,
        payload: {
          ...input.run,
          status: "cancelled",
          queuePosition: null,
          completedAt: input.now,
        },
      });
      if (attempt !== undefined && rootNode !== undefined) {
        yield* emitEvent({
          type: "run-attempt.updated",
          threadId: input.run.threadId,
          runId: input.run.id,
          nodeId: rootNode.id,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: input.now,
          payload: {
            ...attempt,
            status: "cancelled",
            completedAt: input.now,
          },
        });
      }
      if (rootNode !== undefined) {
        yield* emitEvent({
          type: "node.updated",
          threadId: input.run.threadId,
          runId: input.run.id,
          nodeId: rootNode.id,
          providerInstanceId: input.run.providerInstanceId,
          occurredAt: input.now,
          payload: {
            ...rootNode,
            status: "cancelled",
            completedAt: input.now,
          },
        });
      }
    });

  const failQueuedRunStart = (threadId: ThreadId, cause: unknown) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore.getThreadRecords(
        threadId,
        ["runs", "nodes", "attempts", "providerThreads", "turnItems", "messages"],
        { turnItemTypes: [], messageRoles: ["user"], queuedControls: true },
      );
      const queuedRun = nextQueuedRun(projection);
      if (queuedRun === undefined) return;
      const now = yield* DateTime.now;
      const rootNode = projection.nodes.find((node) => node.id === queuedRun.rootNodeId);
      const attempt = projection.attempts.find((entry) => entry.id === queuedRun.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (entry) => entry.id === queuedRun.providerThreadId,
      );
      const handoffUnsupported =
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        cause._tag === "CommandPolicyCapabilityUnsupportedError";
      const failureCause =
        typeof cause === "object" &&
        cause !== null &&
        "_tag" in cause &&
        cause._tag === "OrchestratorDispatchError" &&
        "cause" in cause
          ? cause.cause
          : cause;
      const failure = makeProviderFailure({
        cause: failureCause,
        code: handoffUnsupported ? "context_handoff_unsupported" : "queued_start_failed",
        class: handoffUnsupported ? "validation_error" : "unknown",
      });
      yield* writeSystemEvents([
        ...(attempt !== undefined && rootNode !== undefined
          ? [
              {
                type: "run-attempt.updated" as const,
                threadId,
                runId: queuedRun.id,
                nodeId: rootNode.id,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: { ...attempt, status: "failed" as const, completedAt: now },
              },
            ]
          : []),
        ...(rootNode === undefined
          ? []
          : [
              {
                type: "node.updated" as const,
                threadId,
                runId: queuedRun.id,
                nodeId: rootNode.id,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: { ...rootNode, status: "failed" as const, completedAt: now },
              },
            ]),
        ...(rootNode === undefined || providerThread === undefined
          ? []
          : [
              {
                type: "turn-item.updated" as const,
                threadId,
                runId: queuedRun.id,
                nodeId: rootNode.id,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: {
                  id: idAllocator.derive.turnItemFromProviderItem({
                    driver: providerThread.driver,
                    nativeItemId: `queued-start-failure:${queuedRun.id}`,
                  }),
                  threadId,
                  runId: queuedRun.id,
                  nodeId: rootNode.id,
                  providerThreadId: providerThread.id,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: yield* nextTurnItemOrdinal(projection),
                  status: "failed" as const,
                  title: "Queued provider could not start",
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  type: "error" as const,
                  failure,
                },
              },
            ]),
        {
          type: "run.updated",
          threadId,
          runId: queuedRun.id,
          ...(rootNode === undefined ? {} : { nodeId: rootNode.id }),
          providerInstanceId: queuedRun.providerInstanceId,
          occurredAt: now,
          payload: { ...queuedRun, status: "failed", queuePosition: null, completedAt: now },
        },
      ]);
    });

  const startNextQueuedRun = (
    threadId: ThreadId,
    options?: {
      readonly failedRunId?: RunId;
      readonly endedRunId?: RunId;
      /** Treat the latest executed run as the one that just ended, as its run-end handler would. */
      readonly latestRunEnded?: boolean;
    },
  ) =>
    Effect.gen(function* () {
      // Every terminal run checks the queue. Only a deliverable queued run
      // needs the transcript for provider handoff and legacy import context.
      if (!(yield* projectionStore.canStartQueuedRun(threadId))) return;
      const projection = yield* projectionStore.getMessageDispatchProjection(threadId, {
        needsRunHistory: false,
        queuedStart: true,
      });
      if (
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null ||
        projection.runs.some(isBlockingRun) ||
        projection.runs.some((run) => run.status === "queued" && run.queueHeld === true)
      ) {
        return;
      }

      const previous = latestExecutedRun(projection.runs);
      if (previous !== null && (yield* EffectOutbox.accountMoveHoldsQueue(effectOutbox, previous)))
        return;
      // The limit already stopped this thread. Starting the queue would send
      // every waiting message and drop it from the queue as each one fails.
      const sessionError =
        projection.providerSessions
          .filter((session) => session.providerInstanceId === projection.thread.providerInstanceId)
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
          )[0]?.lastError ?? null;
      if (usageLimitBlockedRun(projection.runs, projection.turnItems, sessionError) !== null) {
        return;
      }
      const queuedRun = nextQueuedRun(projection);
      if (queuedRun === undefined) {
        return;
      }
      // A provider that just failed will likely fail the next message too.
      // Hold the queue so the user decides when to resume it. Validation
      // failures (setup, unsupported handoff) belong to that message alone,
      // and a message queued for another provider is how users recover.
      // A message queued behind a worktree that was cancelled or never created
      // would run in the project checkout instead, so it waits for the user.
      const failedRun = latestExecutedRun(projection.runs);
      const endedRunId = options?.latestRunEnded === true ? failedRun?.id : options?.endedRunId;
      const failedRunId =
        options?.latestRunEnded === true && failedRun?.status === "failed"
          ? failedRun.id
          : options?.failedRunId;
      const failureClass =
        failedRun != null && failedRunId !== undefined && failedRun.id === failedRunId
          ? latestRootProviderFailure(failedRun, projection.turnItems)?.class
          : undefined;
      const worktreeMissing =
        endedRunId !== undefined &&
        failedRun?.id === endedRunId &&
        failedRun?.workspacePreparation?.type === "worktree" &&
        projection.thread.worktreePath === null;
      // A project can turn a provider off while a message waits in the queue,
      // including between a run ending and this check, or while the queue is
      // held and someone clicks resume. Neither path may start that run. Only
      // an explicit turn-off holds the queue: an instance with no settings
      // entry was already admitted when the message was queued.
      const settings = yield* serverSettings.getProviderPolicy.pipe(Effect.orDie);
      const projectOverride =
        settings.projectSettingsOverrides[projection.thread.projectId]?.providerInstances?.[
          queuedRun.providerInstanceId
        ]?.enabled;
      const machineInstance = Object.hasOwn(
        settings.providerInstances,
        queuedRun.providerInstanceId,
      )
        ? settings.providerInstances[queuedRun.providerInstanceId]
        : undefined;
      const instanceDisabledForProject =
        projectOverride !== undefined
          ? !projectOverride
          : machineInstance !== undefined && !resolveProviderInstanceEnabled(machineInstance);
      if (
        worktreeMissing ||
        instanceDisabledForProject ||
        (failureClass !== undefined &&
          failureClass !== "validation_error" &&
          failedRun?.providerInstanceId === queuedRun.providerInstanceId)
      ) {
        const now = yield* DateTime.now;
        yield* writeSystemEvents(
          projection.runs
            .filter((run) => run.status === "queued")
            .map((run) => ({
              type: "run.updated" as const,
              threadId,
              runId: run.id,
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: { ...run, queueHeld: true },
            })),
        );
        return;
      }
      // Run ordinals order the transcript, checkpoints, and the latest run. A
      // run that started while this one waited (a resume of a held queue, a
      // reorder, a delivery that jumps the queue) has a newer ordinal, so this
      // run moves after it. A started run has its prompt in the transcript (a
      // wake's prompt is a notification); a message cancelled from the queue has none.
      const startedAhead =
        projection.runs.some((run) => run.ordinal > queuedRun.ordinal) &&
        (yield* projectionStore.hasStartedRunAfter(threadId, queuedRun.ordinal));
      const ordinal = startedAhead ? nextRunOrdinal(projection) : queuedRun.ordinal;
      const rootNodeId = queuedRun.rootNodeId;
      const attemptId = queuedRun.activeAttemptId;
      const providerThreadId = queuedRun.providerThreadId;
      if (rootNodeId === null || attemptId === null || providerThreadId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: CommandId.make(`command:system:start-queued:${queuedRun.id}`),
          commandType: "message.dispatch",
          cause: `Queued run ${queuedRun.id} is missing execution identity.`,
        });
      }

      const rootNode = projection.nodes.find((candidate) => candidate.id === rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === attemptId);
      const queuedMessage = projection.messages.find(
        (candidate) => candidate.id === queuedRun.userMessageId,
      );
      const legacyQueuedTurnItem = projection.turnItems.find(
        (
          candidate,
        ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
          candidate.type === "user_message" &&
          candidate.runId === queuedRun.id &&
          candidate.messageId === queuedRun.userMessageId,
      );
      const queuedProviderThread = projection.providerThreads.find(
        (candidate) => candidate.id === providerThreadId,
      );
      const storedCheckpointScope = projection.checkpointScopes.find(
        (scope) => scope.id === rootNode?.checkpointScopeId,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        queuedMessage === undefined ||
        queuedProviderThread === undefined ||
        (rootNode.checkpointScopeId !== null && storedCheckpointScope === undefined)
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: CommandId.make(`command:system:start-queued:${queuedRun.id}`),
          commandType: "message.dispatch",
          cause: `Queued run ${queuedRun.id} is missing projection state.`,
        });
      }

      const commandId = CommandId.make(`command:system:start-queued:${queuedRun.id}`);
      const now = yield* DateTime.now;
      const selectionChanged = !modelSelectionsEqual(
        projection.thread.modelSelection,
        queuedRun.modelSelection,
      );
      const activeProviderThread = projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      );
      const owner = activeProviderThread?.providerInstanceId;
      const switchPlan =
        selectionChanged || (owner !== undefined && owner !== queuedRun.providerInstanceId)
          ? yield* providerSwitchService
              .plan({
                projection,
                currentInstanceId: owner,
                targetModelSelection: queuedRun.modelSelection,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId,
                      commandType: "message.dispatch",
                      cause,
                    }),
                ),
              )
          : null;
      const canResumeAcrossInstances =
        switchPlan?.instanceChanged === true &&
        switchPlan.transition.type === "restart_and_resume" &&
        activeProviderThread !== undefined &&
        activeProviderThread.nativeThreadRef?.nativeId != null;
      const deliveryProviderThread =
        canResumeAcrossInstances && activeProviderThread !== undefined
          ? {
              ...queuedProviderThread,
              nativeThreadRef: activeProviderThread.nativeThreadRef,
              nativeConversationHeadRef: activeProviderThread.nativeConversationHeadRef,
              nativeMetadata: activeProviderThread.nativeMetadata,
            }
          : queuedProviderThread;
      const targetAdapter = yield* providerAdapters.get(queuedRun.providerInstanceId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId,
              commandType: "message.dispatch",
              cause,
            }),
        ),
      );
      const targetCapabilities = yield* targetAdapter.getCapabilities().pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId,
              commandType: "message.dispatch",
              cause,
            }),
        ),
      );
      const latestCompletedRun = projection.runs.findLast((run) => run.status === "completed");
      const latestHandoffRun = projection.runs.findLast(isHandoffSourceRun);
      const targetLastCompletedRun = lastDeliveredRunForProviderThread(
        projection,
        queuedProviderThread.id,
      );
      const coveredRuns =
        canResumeAcrossInstances ||
        latestHandoffRun === undefined ||
        latestHandoffRun.providerInstanceId === queuedRun.providerInstanceId
          ? []
          : projection.runs.filter(
              (run) =>
                isHandoffSourceRun(run) &&
                run.ordinal > (targetLastCompletedRun?.ordinal ?? 0) &&
                run.ordinal <= latestHandoffRun.ordinal,
            );
      const needsFullContext = deliveryProviderThread.nativeThreadRef === null;
      const legacyImportItems =
        projection.thread.historyOrigin === "v1_import" &&
        needsFullContext &&
        (latestCompletedRun === undefined || coveredRuns.length > 0)
          ? yield* readHandoffItems(threadId, [null])
          : [];
      const handoffStrategy = needsFullContext
        ? ("full_thread_summary" as const)
        : ("delta_since_target_last_seen" as const);
      const transferId =
        coveredRuns.length === 0
          ? null
          : yield* idAllocator.allocate
              .contextTransfer({
                sourceThreadId: threadId,
                targetThreadId: threadId,
                type: "provider_handoff",
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId,
                      commandType: "message.dispatch",
                      cause,
                    }),
                ),
              );
      if (transferId !== null) {
        yield* commandPolicy.ensureContextHandoff({
          commandId,
          threadId,
          providerInstanceId: queuedRun.providerInstanceId,
          capabilities: targetCapabilities,
          strategy: needsFullContext ? "full_thread_summary" : "delta_context",
        });
      }
      const handoff =
        transferId === null || latestHandoffRun === undefined
          ? null
          : yield* contextHandoffService
              .prepareProviderHandoff({
                threadId,
                targetRunId: queuedRun.id,
                transferId,
                fromProviderThreadIds: Array.from(
                  new Set(
                    coveredRuns.flatMap((run) =>
                      run.providerThreadId === null ? [] : [run.providerThreadId],
                    ),
                  ),
                ),
                toProviderThreadId: queuedProviderThread.id,
                fromProviderInstanceId: latestHandoffRun.providerInstanceId,
                toProviderInstanceId: queuedRun.providerInstanceId,
                coveredRunOrdinals: {
                  from: coveredRuns[0]!.ordinal,
                  to: coveredRuns.at(-1)!.ordinal,
                },
                runs: projection.runs,
                strategy: handoffStrategy,
                items: [
                  ...(needsFullContext && latestCompletedRun !== undefined
                    ? legacyImportItems
                    : []),
                  ...(yield* readHandoffItems(
                    threadId,
                    coveredRuns.map((run) => run.id),
                  )),
                ],
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId,
                      commandType: "message.dispatch",
                      cause,
                    }),
                ),
              );
      const legacyImportRecoveryHandoff =
        latestCompletedRun === undefined && needsFullContext && legacyImportItems.length > 0
          ? yield* contextHandoffService
              .prepareLegacyImport({
                threadId,
                targetRunId: queuedRun.id,
                toProviderThreadId: queuedProviderThread.id,
                toProviderInstanceId: queuedRun.providerInstanceId,
                items: legacyImportItems,
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId,
                      commandType: "message.dispatch",
                      cause,
                    }),
                ),
              )
          : null;
      const activeHandoff = handoff ?? legacyImportRecoveryHandoff;
      const checkpointScope =
        storedCheckpointScope ??
        (yield* runtimePolicy
          .resolve({ thread: projection.thread, modelSelection: queuedRun.modelSelection })
          .pipe(
            Effect.flatMap((resolvedRuntimePolicy) =>
              checkpointService.prepareRootRunScope({
                threadId,
                runId: queuedRun.id,
                rootNodeId: rootNode.id,
                providerThreadId: queuedProviderThread.id,
                cwd: resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
                createdAt: now,
              }),
            ),
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId,
                  commandType: "message.dispatch",
                  cause,
                }),
            ),
          ));
      const providerSessionId =
        (!canResumeAcrossInstances &&
        queuedProviderThread.providerSessionId !== null &&
        !switchPlan?.releaseProviderSessionIds.includes(queuedProviderThread.providerSessionId)
          ? queuedProviderThread.providerSessionId
          : null) ??
        (yield* providerAdapters.get(queuedRun.providerInstanceId).pipe(
          Effect.flatMap((adapter) =>
            providerSessionIdFor({
              adapter,
              providerInstanceId: queuedRun.providerInstanceId,
              threadId,
            }),
          ),
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId,
                commandType: "message.dispatch",
                cause,
              }),
          ),
        ));
      const providerThread: OrchestrationV2ProviderThread = {
        ...deliveryProviderThread,
        providerInstanceId: queuedRun.providerInstanceId,
        providerSessionId,
        status: "not_loaded",
        firstRunOrdinal: queuedProviderThread.firstRunOrdinal ?? ordinal,
        lastRunOrdinal: ordinal,
        handoffIds: appendContextHandoffId(
          appendContextHandoffId(queuedProviderThread.handoffIds, handoff?.id ?? null),
          legacyImportRecoveryHandoff?.id ?? null,
        ),
        updatedAt: now,
      };
      const { sendNext: _sendNext, ...queuedRunForStart } = queuedRun;
      const startingRun: OrchestrationV2Run = {
        ...queuedRunForStart,
        ordinal,
        status: "starting",
        queuePosition: null,
        startedAt: null,
        contextHandoffId: activeHandoff?.id ?? null,
        ...wakeWorkStartedAt(projection.runs, {
          notification: queuedMessage.notification,
          delegatedCompletion: queuedMessage.delegatedCompletion,
          restartContinuationOfRunId: queuedRun.restartContinuationOfRunId,
        }),
      };
      const userTurnItem: OrchestrationV2TurnItem = {
        ...(legacyQueuedTurnItem ?? {
          id: idAllocator.derive.userTurnItem({ messageId: queuedMessage.id }),
          threadId,
          runId: queuedRun.id,
          nodeId: rootNodeId,
          providerThreadId: queuedProviderThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: ordinal * 100,
          status: "completed",
          title: null,
          type: "user_message",
          messageId: queuedMessage.id,
          text: queuedMessage.text,
          attachments: queuedMessage.attachments,
          ...(queuedMessage.context ? { context: queuedMessage.context } : {}),
          createdBy: queuedMessage.createdBy,
          creationSource: queuedMessage.creationSource,
          ...(queuedMessage.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: queuedMessage.scheduledTaskId }),
          ...threadSendFields(queuedMessage),
        }),
        inputIntent: "queued_turn",
        status: "completed",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        ...(activeHandoff === null
          ? yield* modelSwitchFor(threadId, projection, queuedRun.modelSelection)
          : {}),
      };
      const handoffTurnItem: OrchestrationV2TurnItem | null =
        activeHandoff === null
          ? null
          : {
              id: idAllocator.derive.runSignalTurnItem({
                runId: queuedRun.id,
                signal: `context-handoff:${activeHandoff.id}`,
              }),
              threadId,
              runId: queuedRun.id,
              nodeId: rootNodeId,
              providerThreadId: queuedProviderThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: ordinal * 100 - 1,
              status: "completed",
              title: handoff === null ? "Imported context" : "Provider handoff",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "handoff",
              contextHandoffId: activeHandoff.id,
              fromProviderThreadIds: activeHandoff.fromProviderThreadIds,
              toProviderThreadId: activeHandoff.toProviderThreadId,
              fromProviderInstanceIds: Array.from(
                new Set(coveredRuns.map((run) => run.providerInstanceId)),
              ),
              toProviderInstanceId: queuedRun.providerInstanceId,
              fromModelSelections: Array.from(
                new Map(
                  coveredRuns.map((run) => [
                    `${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
                    run.modelSelection,
                  ]),
                ).values(),
              ),
              toModel: queuedRun.modelSelection.model,
              strategy: activeHandoff.strategy,
              summary: activeHandoff.summaryText,
            };
      const checkpointEvents: ReadonlyArray<Omit<OrchestrationV2DomainEvent, "id">> =
        storedCheckpointScope === undefined
          ? [
              {
                type: "checkpoint-scope.created",
                threadId,
                runId: queuedRun.id,
                nodeId: rootNode.id,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: checkpointScope,
              },
              {
                type: "node.updated",
                threadId,
                runId: queuedRun.id,
                nodeId: rootNode.id,
                providerInstanceId: queuedRun.providerInstanceId,
                occurredAt: now,
                payload: { ...rootNode, checkpointScopeId: checkpointScope.id },
              },
            ]
          : [];
      const sessionsToDetach = projection.providerSessions.filter(
        (session) =>
          switchPlan?.releaseProviderSessionIds.includes(session.id) &&
          session.status !== "stopped" &&
          session.status !== "error",
      );
      yield* writeSystemEvents(
        [
          ...(selectionChanged
            ? [
                {
                  type:
                    queuedRun.providerInstanceId === projection.thread.providerInstanceId
                      ? ("thread.model-selection-updated" as const)
                      : ("thread.provider-switched" as const),
                  threadId,
                  providerInstanceId: queuedRun.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    ...projection.thread,
                    providerInstanceId: queuedRun.providerInstanceId,
                    modelSelection: queuedRun.modelSelection,
                    updatedAt: now,
                  },
                },
              ]
            : []),
          ...(handoff === null || transferId === null || latestHandoffRun === undefined
            ? []
            : [
                {
                  type: "context-transfer.created" as const,
                  threadId,
                  runId: queuedRun.id,
                  providerInstanceId: queuedRun.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    id: transferId,
                    type: "provider_handoff" as const,
                    sourceThreadId: threadId,
                    targetThreadId: threadId,
                    sourcePoint: contextSourcePointForRun(projection, latestHandoffRun),
                    basePoint:
                      needsFullContext || targetLastCompletedRun === undefined
                        ? null
                        : contextSourcePointForRun(projection, targetLastCompletedRun),
                    sourceProviderInstanceId: latestHandoffRun.providerInstanceId,
                    targetProviderInstanceId: queuedRun.providerInstanceId,
                    targetRunId: queuedRun.id,
                    status: "consumed" as const,
                    resolution: {
                      strategy: needsFullContext
                        ? ("portable_context" as const)
                        : ("delta_context" as const),
                      contextHandoffId: handoff.id,
                    },
                    createdBy: queuedMessage.createdBy,
                    error: null,
                    createdAt: now,
                    updatedAt: now,
                    consumedAt: now,
                  },
                },
                {
                  type: "context-handoff.updated" as const,
                  threadId,
                  runId: queuedRun.id,
                  providerInstanceId: queuedRun.providerInstanceId,
                  occurredAt: now,
                  payload: handoff,
                },
              ]),
          ...(legacyImportRecoveryHandoff === null
            ? []
            : [
                {
                  type: "context-handoff.updated" as const,
                  threadId,
                  runId: queuedRun.id,
                  providerInstanceId: queuedRun.providerInstanceId,
                  occurredAt: now,
                  payload: legacyImportRecoveryHandoff,
                },
              ]),
          ...(handoffTurnItem === null
            ? []
            : [
                {
                  type: "turn-item.updated" as const,
                  threadId,
                  runId: queuedRun.id,
                  nodeId: rootNodeId,
                  providerInstanceId: queuedRun.providerInstanceId,
                  occurredAt: now,
                  payload: handoffTurnItem,
                },
              ]),
          ...sessionsToDetach.map((session) => ({
            type: "provider-session.detached" as const,
            threadId,
            driver: session.driver,
            providerInstanceId: session.providerInstanceId,
            occurredAt: now,
            payload: {
              providerSessionId: session.id,
              detachedAt: now,
              reason: "Provider or model selection changed.",
            },
          })),
          ...checkpointEvents,
          {
            type: "provider-thread.updated",
            threadId,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: providerThread,
          },
          {
            type: "turn-item.updated",
            threadId,
            runId: queuedRun.id,
            nodeId: rootNodeId,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: notificationTurnItem(userTurnItem, queuedMessage, projection.subagents),
          },
          {
            type: "run.updated",
            threadId,
            runId: queuedRun.id,
            nodeId: rootNodeId,
            providerInstanceId: queuedRun.providerInstanceId,
            occurredAt: now,
            payload: startingRun,
          },
        ],
        [
          ...sessionsToDetach.map((session) => ({
            id: `effect:${commandId}:provider-session.detach:${session.id}`,
            commandId,
            threadId,
            request: {
              type: "provider-session.detach" as const,
              providerSessionId: session.id,
              detail: "Provider or model selection changed.",
              // Asked before the turn start below, which waits a little for it.
              ...(switchPlan?.transition.type === "create_with_handoff" &&
              session.id === activeProviderThread?.providerSessionId
                ? { handoffBrief: { targetInstanceId: queuedRun.providerInstanceId } }
                : {}),
            },
          })),
          {
            id: `effect:${commandId}:provider-turn.start:${queuedRun.id}`,
            commandId,
            threadId,
            request: { type: "provider-turn.start", runId: queuedRun.id },
          },
        ],
      );
    }).pipe(Effect.catch((cause) => failQueuedRunStart(threadId, cause)));

  const resumeQueuedRuns = Effect.gen(function* () {
    const threadIds = yield* projectionStore.getRecoveryThreadIds("queued-runs");
    let resumed = 0;
    for (const threadId of threadIds) {
      const resumedThread = yield* Effect.gen(function* () {
        if (!(yield* projectionStore.canStartQueuedRun(threadId))) return false;
        yield* threadDispatch.withLock(threadId, startNextQueuedRun(threadId));
        return true;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to resume queued V2 run after recovery", {
            threadId,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (resumedThread) {
        resumed += 1;
      }
    }
    return resumed;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestratorDispatchError({
          commandId: CommandId.make("command:system:resume-queued-runs"),
          commandType: "message.dispatch",
          cause,
        }),
    ),
  );

  const isUnobservedAcknowledgement = (
    command: OrchestrationV2ServerCommand,
  ): command is Extract<
    OrchestrationV2ServerCommand,
    { readonly type: "delegated_task.completion-delivery.acknowledge" }
  > & { readonly observedByRunId: null } =>
    command.type === "delegated_task.completion-delivery.acknowledge" &&
    command.observedByRunId === null;

  const dispatchDelegatedTaskCompletionDeliveryResolution = (
    command: Extract<
      OrchestrationV2Command,
      {
        readonly type:
          | "delegated_task.completion-delivery.acknowledge"
          | "delegated_task.completion-delivery.dispose";
      }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore
        .getThreadRecords(command.parentThreadId, ["subagents", "runs"])
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.parentThreadId,
                cause,
              }),
          ),
        );
      const task = projection.subagents.find(
        (candidate) => candidate.id === command.taskId && candidate.origin === "app_owned",
      );
      if (task === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Delegated task ${command.taskId} is not an app-owned task of thread ${command.parentThreadId}.`,
        });
      }
      const state =
        command.type === "delegated_task.completion-delivery.acknowledge"
          ? "acknowledged"
          : "disposed";
      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      // A read outside any live turn of the caller's provider is not one the agent saw. It
      // consumes nothing; a result held for its spawning run wakes the parent once that run ended.
      if (isUnobservedAcknowledgement(command)) {
        if (
          !isTerminalDelegatedTaskStatus(task.status) ||
          task.completionDelivery?.state !== "pending"
        )
          return;
        const parentRun = projection.runs.find((run) => run.id === task.runId);
        if (parentRun !== undefined && hasLiveRun({ runs: [parentRun] })) return;
        // The plan finds its delivery message by ID.
        const records = yield* projectionStore
          .getThreadRecords(command.parentThreadId, ["messages"], {
            messageRoles: ["user"],
            unorderedMessages: true,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProjectionError({
                  threadId: command.parentThreadId,
                  cause,
                }),
            ),
          );
        const plan = yield* planDelegatedCompletionDelivery({
          parentProjection: { ...projection, ...records },
          parentRun,
          task,
          updatedTask: task,
          now,
        });
        if (plan.task.completionDelivery?.state === "pending") return;
        yield* emitEvent({
          type: "subagent.updated",
          threadId: command.parentThreadId,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: now,
          payload: plan.task,
        });
        if (plan.parentRun !== undefined) {
          yield* emitEvent({
            type: "run.updated",
            threadId: command.parentThreadId,
            runId: plan.parentRun.id,
            ...(plan.parentRun.rootNodeId === null ? {} : { nodeId: plan.parentRun.rootNodeId }),
            providerInstanceId: plan.parentRun.providerInstanceId,
            occurredAt: now,
            payload: plan.parentRun,
          });
        }
        if (plan.message !== undefined) {
          yield* emitEvent({
            type: "message.updated",
            threadId: command.parentThreadId,
            ...(plan.message.runId === null ? {} : { runId: plan.message.runId }),
            ...(plan.message.nodeId === null ? {} : { nodeId: plan.message.nodeId }),
            providerInstanceId:
              plan.parentRun?.providerInstanceId ?? projection.thread.providerInstanceId,
            occurredAt: now,
            payload: plan.message,
          });
        }
        return;
      }
      // task_status and t3_thread_read use distinct command IDs, so two
      // valid observations can race after their read preflight. Re-emit the
      // existing task row so the second dispatch is a successful idempotent
      // no-op rather than "already acknowledged/disposed" or empty-events.
      if (
        task.completionDelivery?.state === state ||
        (command.type === "delegated_task.completion-delivery.acknowledge" &&
          task.completionDelivery?.state === "disposed")
      ) {
        yield* emitEvent({
          type: "subagent.updated",
          threadId: command.parentThreadId,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: now,
          payload: task,
        });
        return;
      }
      const updatedTask: OrchestrationV2Subagent = {
        ...task,
        completionDelivery: {
          state,
          observedByRunId:
            command.type === "delegated_task.completion-delivery.acknowledge"
              ? command.observedByRunId
              : null,
        },
        updatedAt: now,
      };
      yield* emitEvent({
        type: "subagent.updated",
        threadId: command.parentThreadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: updatedTask,
      });

      const parentRun =
        task.runId === null
          ? undefined
          : projection.runs.find((candidate) => candidate.id === task.runId);
      const cohort = parentRun?.delegatedCompletion;
      const delivery = cohort?.delivery;
      if (
        parentRun === undefined ||
        cohort === undefined ||
        delivery === null ||
        delivery === undefined
      ) {
        return;
      }
      if (!delivery.taskIds.includes(task.id)) {
        return;
      }

      const { messages } = yield* projectionStore
        .getThreadRecords(command.parentThreadId, ["messages"], {
          messageRoles: ["user"],
          messageIds: [delivery.messageId],
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.parentThreadId,
                cause,
              }),
          ),
        );
      const deliveryProjection = { ...projection, messages };
      const remainingTaskIds = delivery.taskIds.filter((taskId) => taskId !== task.id);
      const deliveryRun = completionDeliveryRun(deliveryProjection, delivery);
      const clearDelivery =
        remainingTaskIds.length === 0 &&
        (deliveryRun === undefined ||
          deliveryRun.status === "queued" ||
          delegatedTaskTerminalStatus(deliveryRun.status) !== null);
      const updatedCohort: OrchestrationV2DelegatedCompletionCohort = {
        ...cohort,
        delivery: clearDelivery
          ? null
          : {
              ...delivery,
              taskIds: remainingTaskIds,
            },
      };
      yield* emitEvent({
        type: "run.updated",
        threadId: command.parentThreadId,
        runId: parentRun.id,
        ...(parentRun.rootNodeId === null ? {} : { nodeId: parentRun.rootNodeId }),
        providerInstanceId: parentRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...parentRun,
          delegatedCompletion: updatedCohort,
        },
      });

      if (deliveryRun?.status === "queued") {
        if (remainingTaskIds.length === 0) {
          yield* emitQueuedRunCancellation({
            command,
            events,
            projection: yield* projectionStore
              .getThreadRecords(command.parentThreadId, ["nodes", "attempts"], {
                nodeIds: deliveryRun.rootNodeId === null ? [] : [deliveryRun.rootNodeId],
                attemptRunIds: [deliveryRun.id],
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorProjectionError({
                      threadId: command.parentThreadId,
                      cause,
                    }),
                ),
              ),
            run: deliveryRun,
            now,
          });
          return;
        }
        const message = completionDeliveryMessage(deliveryProjection, delivery);
        if (message !== undefined) {
          yield* emitEvent({
            type: "message.updated",
            threadId: command.parentThreadId,
            runId: deliveryRun.id,
            ...(deliveryRun.rootNodeId === null ? {} : { nodeId: deliveryRun.rootNodeId }),
            providerInstanceId: deliveryRun.providerInstanceId,
            occurredAt: now,
            payload: {
              ...message,
              text: delegatedCompletionWakeDetail(
                remainingTaskIds,
                projection.subagents,
                teamBoard?.completion,
              ),
              delegatedCompletion: {
                parentRunId: parentRun.id,
                generation: delivery.generation,
                taskIds: remainingTaskIds,
              },
              updatedAt: now,
            },
          });
        }
      }
    });

  /** Whether a run has a cohort to dispose, decided before reading the command projection. */
  const hasDelegatedCohort = (
    projection: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents">,
    parentRunId: RunId,
  ) =>
    projection.runs.some(
      (run) => run.id === parentRunId && run.delegatedCompletion !== undefined,
    ) ||
    projection.subagents.some((task) => task.origin === "app_owned" && task.runId === parentRunId);

  const disposeDelegatedCompletionCohort = (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "subagents" | "messages" | "nodes" | "attempts"
    >;
    readonly parentRunId: RunId;
    readonly disposition: "stopped" | "disposed";
    readonly now: DateTime.Utc;
    readonly cancelQueuedDelivery?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentRun = input.projection.runs.find(
        (candidate) => candidate.id === input.parentRunId,
      );
      if (parentRun === undefined) {
        return;
      }
      const cohort = parentRun.delegatedCompletion;
      const tasks = input.projection.subagents.filter(
        (candidate) => candidate.origin === "app_owned" && candidate.runId === input.parentRunId,
      );
      if (cohort === undefined && tasks.length === 0) {
        return;
      }
      const emitEvent = emit(input.events, input.command);
      const nextDisposition = cohort?.disposition === "disposed" ? "disposed" : input.disposition;
      const nextCohort = {
        disposition: nextDisposition,
        nextGeneration: cohort?.nextGeneration ?? 1,
        delivery: null,
      } as const;
      yield* emitEvent({
        type: "run.updated",
        threadId: parentRun.threadId,
        runId: parentRun.id,
        ...(parentRun.rootNodeId === null ? {} : { nodeId: parentRun.rootNodeId }),
        providerInstanceId: parentRun.providerInstanceId,
        occurredAt: input.now,
        payload: {
          ...parentRun,
          delegatedCompletion: nextCohort,
        },
      });
      for (const task of tasks) {
        if (
          task.completionDelivery?.state === "acknowledged" ||
          task.completionDelivery?.state === "delivered" ||
          task.completionDelivery?.state === "disposed"
        ) {
          continue;
        }
        yield* emitEvent({
          type: "subagent.updated",
          threadId: parentRun.threadId,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          occurredAt: input.now,
          payload: {
            ...task,
            completionDelivery: {
              state: "disposed",
              observedByRunId: null,
            },
            updatedAt: input.now,
          },
        });
      }
      const deliveryRun = completionDeliveryRun(input.projection, cohort?.delivery ?? null);
      if (input.cancelQueuedDelivery !== false && deliveryRun?.status === "queued") {
        yield* emitQueuedRunCancellation({
          command: input.command,
          events: input.events,
          projection: input.projection,
          run: deliveryRun,
          now: input.now,
        });
      }
    });

  const disposeAllDelegatedCompletionCohorts = (input: {
    readonly command: OrchestrationV2Command;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "subagents" | "messages" | "nodes" | "attempts"
    >;
    readonly now: DateTime.Utc;
    readonly cancelQueuedDelivery?: boolean;
  }) =>
    Effect.forEach(
      Array.from(
        new Set([
          ...input.projection.runs
            .filter((run) => run.delegatedCompletion !== undefined)
            .map((run) => run.id),
          ...input.projection.subagents
            .filter((task) => task.origin === "app_owned" && task.runId !== null)
            .map((task) => task.runId!),
        ]),
      ),
      (parentRunId) =>
        disposeDelegatedCompletionCohort({
          ...input,
          parentRunId,
          disposition: "disposed",
        }),
      { concurrency: 1, discard: true },
    );

  const dispatchThreadCreate = Effect.fn("orchestrationV2.dispatch.threadCreate")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.create" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.thread_id": command.threadId,
      "orchestration_v2.driver": command.modelSelection.instanceId,
    });

    // Tombstones reserve their ids too; recreating one would overwrite its history.
    const existing = yield* projectionStore.getThread(command.threadId).pipe(
      Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
      ),
    );
    if (existing !== null) {
      return yield* new OrchestratorThreadAlreadyExistsError({
        commandId: command.commandId,
        threadId: command.threadId,
      });
    }

    const now = yield* DateTime.now;
    const emitEvent = emit(events, command);
    const thread: OrchestrationV2AppThread = {
      createdBy: command.createdBy,
      creationSource: command.creationSource,
      id: command.threadId,
      projectId: command.projectId,
      title: command.title,
      providerInstanceId: command.modelSelection.instanceId,
      modelSelection: command.modelSelection,
      runtimeMode: command.runtimeMode,
      interactionMode: command.interactionMode,
      branch: command.branch,
      worktreePath: command.worktreePath,
      activeProviderThreadId:
        command.importedNativeThread === undefined
          ? null
          : idAllocator.derive.providerThread({
              driver: command.importedNativeThread.ref.driver,
              providerInstanceId: command.modelSelection.instanceId,
              nativeThreadId: command.importedNativeThread.ref.nativeId,
            }),
      lineage: {
        parentThreadId: command.remoteParent?.threadId ?? null,
        ...(command.remoteParent === undefined
          ? {}
          : { parentEnvironmentId: command.remoteParent.environmentId }),
        relationshipToParent: command.remoteParent === undefined ? null : "subagent",
        rootThreadId: command.threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };

    yield* emitEvent({
      type: "thread.created",
      threadId: command.threadId,
      providerInstanceId: command.modelSelection.instanceId,
      occurredAt: now,
      payload: thread,
    });
    if (command.importedNativeThread !== undefined) {
      yield* emitEvent({
        type: "provider-thread.updated",
        threadId: command.threadId,
        driver: command.importedNativeThread.ref.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: {
          id: idAllocator.derive.providerThread({
            driver: command.importedNativeThread.ref.driver,
            providerInstanceId: command.modelSelection.instanceId,
            nativeThreadId: command.importedNativeThread.ref.nativeId,
          }),
          driver: command.importedNativeThread.ref.driver,
          providerInstanceId: command.modelSelection.instanceId,
          providerSessionId: null,
          appThreadId: command.threadId,
          ownerNodeId: null,
          nativeThreadRef: command.importedNativeThread.ref,
          nativeConversationHeadRef: null,
          status: "not_loaded",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          contextUsage: null,
          nativeMetadata: command.importedNativeThread.metadata ?? null,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
  });

  const dispatchThreadVisit = Effect.fn("orchestrationV2.dispatch.threadVisit")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.visit" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const thread = yield* projectionStore
      .getThread(command.threadId)
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    if (thread.deletedAt !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is deleted.`,
      });
    }
    const visitedAt = DateTime.make(command.visitedAt);
    if (Option.isNone(visitedAt)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} visit time ${command.visitedAt} is not a valid timestamp.`,
      });
    }
    const movesForward =
      thread.lastVisitedAt === null ||
      DateTime.toEpochMillis(visitedAt.value) > DateTime.toEpochMillis(thread.lastVisitedAt);
    // Viewing a thread changes read state only. Loading its transcript (or
    // bumping updatedAt) makes a routine read receipt scale with its history.
    yield* emit(
      events,
      command,
    )({
      type: "thread.visited",
      threadId: command.threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: yield* DateTime.now,
      payload: movesForward ? { ...thread, lastVisitedAt: visitedAt.value } : thread,
    });
  });

  // Checked under the thread lock: the watch or the thread can change while the host is read.
  // The watch is recorded first so the wake's own thread events carry it.
  const dispatchPullRequestWatchSync = Effect.fn("orchestrationV2.dispatch.pullRequestWatchSync")(
    function* (
      command: Extract<
        OrchestrationV2ServerCommand,
        { readonly type: "thread.pull-request-watch.sync" }
      >,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const thread = yield* projectionStore
        .getThread(command.threadId)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      const key = normalizeThreadPullRequestKey(command);
      const link = threadPullRequestsOf(thread).find(
        (candidate) =>
          candidate.source !== "stack-dismissed" && threadPullRequestKeysEqual(candidate, key),
      );
      // Same rule as a direct message.dispatch: a provider-native subagent takes no messages.
      const inactive =
        thread.archivedAt !== null ||
        thread.settledOverride === "settled" ||
        thread.settledAt !== null ||
        isProviderNativeSubagentThread(thread);
      if (link?.watch?.startedAt !== command.startedAt || (command.wake && inactive)) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The pull request watch ended or its thread settled while it was read.",
        });
      }
      yield* dispatchThreadMutation(command, events, effects);
      if (command.wake === undefined) return;
      yield* dispatchMessage(
        {
          type: "message.dispatch",
          commandId: command.commandId,
          threadId: command.threadId,
          messageId: command.wake.messageId,
          text: command.wake.text,
          notification: command.wake.notification,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        },
        events,
        effects,
      );
    },
  );

  /**
   * A delegated child's parent names it on its subagent records and cards. A new chat title
   * (a rename, or a regenerated title) lands there too, in the same commit; the box namer
   * never retitles subagent chats. Callers hold the parent's lock (see dispatchWithReceipt).
   */
  const followDelegatedChildTitle = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    child: OrchestrationV2AppThread,
    now: DateTime.Utc,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const parentThreadId = child.lineage.parentThreadId;
    if (
      child.lineage.relationshipToParent !== "subagent" ||
      child.lineage.parentEnvironmentId !== undefined ||
      parentThreadId === null ||
      child.forkedFrom?.type !== "node"
    )
      return;
    const parent = yield* projectionStore
      .getThreadRecords(parentThreadId, ["subagents"])
      .pipe(mapDispatchError(command));
    if (parent.thread.deletedAt !== null) return;
    // Follow-ups are separate tasks on the same child, so every one of them follows.
    const tasks = parent.subagents.filter(
      (task) =>
        task.origin === "app_owned" && task.remote === undefined && task.childThreadId === child.id,
    );
    if (tasks.length === 0) return;
    const { turnItems } = yield* projectionStore
      .getThreadRecords(parentThreadId, ["turnItems"], {
        turnItemNodeIds: tasks.map((task) => task.id),
        turnItemTypes: ["subagent"],
      })
      .pipe(mapDispatchError(command));
    const emitEvent = emit(events, command);
    // A display rename: updatedAt stays, like the child activity overlay.
    for (const task of tasks) {
      if (task.title === child.title) continue;
      yield* emitEvent({
        type: "subagent.updated",
        threadId: parentThreadId,
        ...(task.runId === null ? {} : { runId: task.runId }),
        nodeId: task.id,
        occurredAt: now,
        payload: { ...task, title: child.title },
      });
    }
    for (const item of turnItems) {
      if (item.type !== "subagent" || item.title === child.title) continue;
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: parentThreadId,
        ...(item.runId === null ? {} : { runId: item.runId }),
        nodeId: item.subagentId,
        occurredAt: now,
        payload: { ...item, title: child.title },
      });
    }
  });

  const dispatchThreadMutation = Effect.fn("orchestrationV2.dispatch.threadMutation")(function* (
    command: Extract<
      OrchestrationV2ServerCommand,
      {
        readonly type:
          | "thread.archive"
          | "thread.unarchive"
          | "thread.settle"
          | "thread.unsettle"
          | "thread.snooze"
          | "thread.unsnooze"
          | "thread.auto-settle.set"
          | "thread.pin"
          | "thread.unpin"
          | "thread.pin.reorder"
          | "thread.active.reorder"
          | "thread.mark-unread"
          | "thread.metadata.update"
          | "thread.pull-request.link"
          | "thread.pull-request.unlink"
          | "thread.pull-request-link.sync"
          | "thread.pull-request.watch"
          | "thread.pull-request-watch.sync"
          | "thread.pull-request.sync"
          | "thread.title.regeneration.complete"
          | "thread.runtime-mode.set"
          | "thread.interaction-mode.set"
          | "thread.model-selection.set"
          | "provider.switch";
      }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const thread = yield* projectionStore.getThread(command.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorProjectionError({
            threadId: command.threadId,
            cause,
          }),
      ),
    );
    if (thread.deletedAt !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is deleted.`,
      });
    }
    if (
      command.type === "thread.pull-request.watch" &&
      command.watching &&
      isProviderNativeSubagentThread(thread)
    ) {
      return yield* new OrchestratorSubagentThreadReadOnlyError({
        commandId: command.commandId,
        threadId: command.threadId,
      });
    }
    if (
      command.type === "thread.pull-request.watch" &&
      command.watching &&
      (thread.settledOverride === "settled" ||
        thread.settledAt !== null ||
        thread.archivedAt !== null)
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is settled or archived and cannot watch pull requests.`,
      });
    }
    // A subagent or delegated task reports to its parent thread, which owns the pull request.
    // Its own watch would wake it on every change of a PR it was not asked to babysit.
    if (
      command.type === "thread.pull-request.watch" &&
      command.watching &&
      thread.lineage.relationshipToParent === "subagent"
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is a subagent; its parent thread watches pull requests.`,
      });
    }
    // Only the agent's watch_pull_request links as "agent". A call that raced a Stop may land
    // after its run ended, so the latest run that executed decides. A user can still watch.
    if (
      command.type === "thread.pull-request.watch" &&
      command.watching &&
      command.link?.source === "agent"
    ) {
      const { runs } = yield* projectionStore
        .getThreadRecords(command.threadId, ["runs"])
        .pipe(mapDispatchError(command));
      const latest = latestExecutedRun(runs);
      if (latest !== null && (yield* stopReachedRun(command, command.threadId, latest.id))) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} was stopped.`,
        });
      }
    }
    if (
      command.type === "thread.metadata.update" &&
      command.expectedWorktreePath !== undefined &&
      command.expectedWorktreePath !== thread.worktreePath
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} worktree changed before the metadata update could be applied.`,
      });
    }
    if (
      command.type === "thread.metadata.update" &&
      command.expectedBranch !== undefined &&
      command.expectedBranch !== thread.branch
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} branch changed before the metadata update could be applied.`,
      });
    }
    if (command.type === "thread.metadata.update" && command.expectedEmpty === true) {
      const records = yield* projectionStore
        .getThreadRecords(command.threadId, ["runs"])
        .pipe(mapDispatchError(command));
      const messageCount = yield* projectionStore
        .getMessageCount(command.threadId)
        .pipe(mapDispatchError(command));
      if (messageCount > 0 || records.runs.length > 0)
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} is no longer empty.`,
        });
    }
    if (command.type === "thread.archive" && thread.archivedAt !== null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is already archived.`,
      });
    }
    if (command.type === "thread.unarchive" && thread.archivedAt === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is not archived.`,
      });
    }
    if (
      (command.type === "thread.settle" ||
        command.type === "thread.unsettle" ||
        command.type === "thread.snooze" ||
        command.type === "thread.unsnooze" ||
        command.type === "thread.auto-settle.set" ||
        command.type === "thread.pin" ||
        command.type === "thread.unpin" ||
        command.type === "thread.pin.reorder" ||
        command.type === "thread.active.reorder" ||
        command.type === "thread.pull-request.sync") &&
      thread.archivedAt !== null
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is archived.`,
      });
    }
    // Only pinned threads have a slot in the arranged order. Rejecting
    // (rather than silently pinning) keeps a raced reorder-after-unpin from
    // resurrecting a pin the user just cleared.
    if (command.type === "thread.pin.reorder" && thread.pinnedAt == null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is not pinned and cannot be reordered.`,
      });
    }
    if (
      command.type === "thread.active.reorder" &&
      (thread.pinnedAt != null || thread.settledOverride === "settled")
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.threadId} is not active and cannot be reordered.`,
      });
    }
    if (command.type === "thread.pull-request.sync") {
      const project = yield* projects.get(command.projectId).pipe(mapDispatchError(command));
      const currentSequence = yield* eventSink.latestSequence({ threadId: command.threadId }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.threadId,
              cause,
            }),
        ),
      );
      if (
        Option.isNone(project) ||
        project.value.deletedAt !== null ||
        project.value.workspaceRoot !== command.expected.workspaceRoot ||
        currentSequence > command.snapshotSequence ||
        thread.projectId !== command.projectId ||
        thread.branch !== command.expected.branch ||
        thread.worktreePath !== command.expected.worktreePath ||
        !threadPullRequestLinksEqual(
          thread.linkedPullRequest ?? null,
          command.expected.linkedPullRequest,
        ) ||
        !threadPullRequestLinksEqual(
          thread.branchPullRequest ?? null,
          command.expected.branchPullRequest,
        )
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} changed before pull request discovery.`,
        });
      }
    }
    if (command.type === "thread.settle") {
      const projection = yield* loadProjectionForCommand(command, ["runs", "runtimeRequests"], {
        pendingRuntimeRequestsOnly: true,
      });
      const queuedRuns = projection.runs.filter((run) => run.status === "queued");
      const queuedMessages =
        queuedRuns.length === 0
          ? []
          : (yield* loadProjectionForCommand(command, ["messages"], {
              messageIds: queuedRuns.map((run) => run.userMessageId),
              unorderedMessages: true,
            })).messages;
      // Queued notification, delegated-completion, agent and scheduled runs are
      // not messages the user typed, so they must not block settling; they are
      // cancelled below instead.
      const automaticMessageIds = new Set(
        queuedMessages
          .filter(
            (message) =>
              message.createdBy !== "user" ||
              message.scheduledTaskId !== undefined ||
              message.notification !== undefined ||
              message.delegatedCompletion !== undefined,
          )
          .map((message) => message.id),
      );
      const automaticQueuedRuns = queuedRuns.filter((run) =>
        automaticMessageIds.has(run.userMessageId),
      );
      const runningRunExists = projection.runs.some((run) =>
        ["preparing", "starting", "running", "waiting"].includes(run.status),
      );
      // Includes a queue held after a Stop, which otherwise shows no activity.
      const queuedMessageExists = projection.runs.some(
        (run) => run.status === "queued" && !automaticQueuedRuns.includes(run),
      );
      const pendingRequests = projection.runtimeRequests.filter(
        (request) => request.status === "pending",
      );
      const blockingRequestExists = pendingRequests.some(
        (request) => request.kind !== "user_input" || request.responseCapability.type !== "message",
      );
      // The reason is shown to the user, so it names what to clear first.
      const blocker = blockingRequestExists
        ? "is waiting on an approval or question. Answer it before settling."
        : runningRunExists
          ? "is still running. Stop it before settling."
          : queuedMessageExists
            ? "has a queued message. Send it or remove it from the queue before settling."
            : null;
      if (blocker !== null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} ${blocker}`,
        });
      }

      // Message-capable async questions do not keep provider callbacks alive.
      // Resolve them in the settle transaction so a settled thread never has
      // an actionable question attached to it.
      for (const request of pendingRequests) {
        yield* dispatchRuntimeRequestRespond(
          {
            type: "runtime-request.respond",
            commandId: command.commandId,
            threadId: command.threadId,
            requestId: request.id,
            decision: "cancel",
          },
          events,
          effects,
        );
      }
      for (const run of automaticQueuedRuns) {
        yield* dispatchQueuedRunCancel(
          {
            type: "queued-run.cancel",
            commandId: command.commandId,
            threadId: command.threadId,
            runId: run.id,
          },
          events,
        );
      }
    }

    const needsProviderState =
      command.type === "thread.runtime-mode.set" ||
      command.type === "thread.model-selection.set" ||
      command.type === "provider.switch" ||
      command.type === "thread.archive" ||
      command.type === "thread.settle" ||
      (command.type === "thread.metadata.update" &&
        command.worktreePath !== undefined &&
        command.worktreePath !== thread.worktreePath);
    const providerContext = needsProviderState
      ? yield* projectionStore
          .getThreadProviderContext(
            command.threadId,
            command.type === "thread.model-selection.set" || command.type === "provider.switch"
              ? command.modelSelection.instanceId
              : command.type === "thread.runtime-mode.set" &&
                  command.runtimeMode !== thread.runtimeMode
                ? thread.providerInstanceId
                : undefined,
          )
          .pipe(mapDispatchError(command))
      : null;
    const providerSwitchPlan =
      command.type === "thread.model-selection.set" || command.type === "provider.switch"
        ? yield* Effect.gen(function* () {
            yield* providerAdapters.get(command.modelSelection.instanceId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorProviderAdapterError({
                    commandId: command.commandId,
                    providerInstanceId: command.modelSelection.instanceId,
                    cause,
                  }),
              ),
            );
            return yield* providerSwitchService
              .plan({
                projection: providerContext!,
                targetModelSelection: command.modelSelection,
              })
              .pipe(mapDispatchError(command));
          })
        : null;

    const now = yield* DateTime.now;
    if (command.type === "thread.metadata.update" && command.limitRecovery != null) {
      const projection = yield* loadProjectionForCommand(
        command,
        ["runs", "runtimeRequests", "turnItems"],
        {
          turnItemTypes: ["error"],
          turnItemStatuses: ["failed"],
          pendingRuntimeRequestsOnly: true,
        },
      );
      const run = usageLimitBlockedRun(projection.runs, projection.turnItems, null);
      const failure = latestRootProviderFailure(run, projection.turnItems);
      const resetMs = Date.parse(command.limitRecovery.resetAt);
      if (command.limitRecovery.snooze === true && resetMs <= DateTime.toEpochMillis(now)) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The reset time has passed. Retry the thread manually.",
        });
      }
      if (thread.settledOverride === "settled") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The thread is settled. Un-settle it to resume at the reset.",
        });
      }
      if (
        !Number.isFinite(resetMs) ||
        thread.archivedAt !== null ||
        run?.id !== command.limitRecovery.runId ||
        failure?.class !== "usage_limit" ||
        failure.resetAt !== command.limitRecovery.resetAt ||
        resetMs <= DateTime.toEpochMillis(run.completedAt ?? run.requestedAt) ||
        projection.runtimeRequests.some((request) => request.status === "pending")
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The provider limit changed before recovery could be configured.",
        });
      }
    }
    let snoozedUntil: DateTime.Utc | null = null;
    if (command.type === "thread.snooze") {
      const projection = yield* loadProjectionForCommand(command, ["runs", "runtimeRequests"], {
        pendingRuntimeRequestsOnly: true,
      });
      const parsedSnoozedUntil = DateTime.make(command.snoozedUntil);
      if (
        Option.isNone(parsedSnoozedUntil) ||
        DateTime.toEpochMillis(parsedSnoozedUntil.value) <= DateTime.toEpochMillis(now)
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} snooze wake time ${command.snoozedUntil} is not in the future.`,
        });
      }
      if (projection.runtimeRequests.some((request) => request.status === "pending")) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} has a pending approval or user-input request and cannot be snoozed.`,
        });
      }
      const queuedRuns = projection.runs.filter((run) => run.status === "queued");
      const queuedMessages =
        queuedRuns.length === 0
          ? []
          : (yield* loadProjectionForCommand(command, ["messages"], {
              messageIds: queuedRuns.map((run) => run.userMessageId),
              unorderedMessages: true,
            })).messages;
      // Automatic wakes are hidden from the user queue and must not block snooze.
      // Snooze only changes visibility, so keep those deliveries intact.
      const automaticMessageIds = new Set(
        queuedMessages
          .filter(
            (message) =>
              message.notification !== undefined || message.delegatedCompletion !== undefined,
          )
          .map((message) => message.id),
      );
      if (queuedRuns.some((run) => !automaticMessageIds.has(run.userMessageId))) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} has a queued run and cannot be snoozed.`,
        });
      }
      snoozedUntil = parsedSnoozedUntil.value;
    }
    let markUnreadVisitedAt: DateTime.Utc | null = null;
    if (command.type === "thread.mark-unread") {
      const projection = yield* loadProjectionForCommand(command, ["runs"]);
      const latestRunCompletedAt = projection.runs.at(-1)?.completedAt ?? null;
      if (latestRunCompletedAt === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} has no completed run to mark unread.`,
        });
      }
      markUnreadVisitedAt = DateTime.subtract(latestRunCompletedAt, { milliseconds: 1 });
    }
    const updatedThread: OrchestrationV2AppThread = (() => {
      switch (command.type) {
        case "thread.archive":
          // An archived thread takes no wakes, so its watches end like a settled thread's.
          return {
            ...thread,
            archivedAt: now,
            titleRegeneration: null,
            pullRequests: thread.pullRequests?.map((link) => withPullRequestWatch(link, undefined)),
            updatedAt: now,
          };
        case "thread.unarchive":
          return { ...thread, archivedAt: null, updatedAt: now };
        case "thread.settle": {
          // Settling is "I'm done with this": it clears a pin the same way it
          // parks the thread (mirrors the v1 decider's settle/pin exclusion).
          const wasPinned = thread.pinnedAt != null;
          const alreadySettled =
            thread.settledOverride === "settled" && thread.settledAt !== null && !wasPinned;
          return {
            ...thread,
            settledOverride: "settled",
            settledAt: alreadySettled ? thread.settledAt : (command.settledAt ?? now),
            // Settled threads refuse recovery, so an armed resume would stay hidden until un-settled.
            limitRecovery: thread.limitRecovery
              ? { ...thread.limitRecovery, autoResume: false, snooze: false }
              : thread.limitRecovery,
            pullRequests: thread.pullRequests?.map((link) => withPullRequestWatch(link, undefined)),
            unsettledAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            activeOrderKey: null,
            updatedAt: alreadySettled ? thread.updatedAt : now,
          };
        }
        case "thread.unsettle": {
          const alreadyPinnedActive = thread.settledOverride === "active";
          return {
            ...thread,
            settledOverride: "active",
            settledAt: null,
            unsettledAt: alreadyPinnedActive ? (thread.unsettledAt ?? null) : now,
            updatedAt: alreadyPinnedActive ? thread.updatedAt : now,
          };
        }
        case "thread.snooze": {
          const sameWakeTime =
            thread.snoozedUntil != null &&
            snoozedUntil !== null &&
            DateTime.toEpochMillis(thread.snoozedUntil) === DateTime.toEpochMillis(snoozedUntil);
          const existingSnoozedAt = sameWakeTime ? (thread.snoozedAt ?? null) : null;
          return {
            ...thread,
            snoozedUntil,
            limitRecovery: thread.limitRecovery ? { ...thread.limitRecovery, snooze: false } : null,
            snoozedAt: existingSnoozedAt ?? now,
            updatedAt: existingSnoozedAt === null ? now : thread.updatedAt,
          };
        }
        case "thread.unsnooze": {
          const alreadyAwake = thread.snoozedUntil == null;
          return {
            ...thread,
            snoozedUntil: null,
            snoozedAt: null,
            lastSnoozeWakeAt: alreadyAwake ? thread.lastSnoozeWakeAt : now,
            updatedAt: alreadyAwake ? thread.updatedAt : now,
          };
        }
        case "thread.auto-settle.set": {
          const unchanged = command.enabled === (thread.autoSettleDisabledAt == null);
          return {
            ...thread,
            autoSettleDisabledAt: command.enabled ? null : (thread.autoSettleDisabledAt ?? now),
            updatedAt: unchanged ? thread.updatedAt : now,
          };
        }
        case "thread.pin": {
          // Pinning is a promotion: it clears the parked states rather than
          // silently outranking them — an explicit settle is un-settled and a
          // snooze's return ticket is spent (the thread is on top NOW).
          const alreadyPinned = thread.pinnedAt != null;
          const promotes = thread.settledOverride === "settled" || thread.snoozedUntil != null;
          return {
            ...thread,
            pinnedAt: alreadyPinned ? thread.pinnedAt : now,
            // A fresh pin takes the client's slot in the arranged order; on a
            // re-pin the existing key wins so raced duplicates cannot move a
            // thread the user already placed.
            ...(alreadyPinned || command.orderKey === undefined
              ? {}
              : { pinOrderKey: command.orderKey }),
            settledOverride:
              thread.settledOverride === "settled" ? "active" : thread.settledOverride,
            settledAt: thread.settledOverride === "settled" ? null : thread.settledAt,
            snoozedUntil: null,
            snoozedAt: null,
            lastSnoozeWakeAt: thread.snoozedUntil == null ? thread.lastSnoozeWakeAt : now,
            updatedAt: alreadyPinned && !promotes ? thread.updatedAt : now,
          };
        }
        case "thread.unpin": {
          const alreadyUnpinned = thread.pinnedAt == null;
          return {
            ...thread,
            pinnedAt: null,
            // Unpin clears the slot: re-pinning is "pin again", not "restore
            // an ancient position".
            pinOrderKey: null,
            updatedAt: alreadyUnpinned ? thread.updatedAt : now,
          };
        }
        case "thread.pin.reorder": {
          // Idempotent by re-emission (see thread.settle): a duplicate drop on
          // the same slot keeps the existing updatedAt so it projects as a
          // no-op.
          const keyUnchanged = thread.pinOrderKey === command.orderKey;
          return {
            ...thread,
            pinOrderKey: command.orderKey,
            updatedAt: keyUnchanged ? thread.updatedAt : now,
          };
        }
        case "thread.active.reorder": {
          return {
            ...thread,
            activeOrderKey: command.orderKey,
            // Arranging the active list is not thread activity.
            updatedAt: thread.updatedAt,
          };
        }
        case "thread.mark-unread":
          return { ...thread, lastVisitedAt: markUnreadVisitedAt };
        case "thread.metadata.update": {
          const previousRecovery =
            thread.limitRecovery?.runId === command.limitRecovery?.runId &&
            thread.limitRecovery?.resetAt === command.limitRecovery?.resetAt
              ? thread.limitRecovery
              : null;
          const limitRecovery =
            command.limitRecovery === undefined
              ? thread.limitRecovery
              : command.limitRecovery === null
                ? null
                : {
                    ...command.limitRecovery,
                    autoResume:
                      command.limitRecovery.autoResume ?? previousRecovery?.autoResume ?? false,
                    snooze: command.limitRecovery.snooze ?? previousRecovery?.snooze ?? false,
                    requestId: command.commandId,
                  };
          return {
            ...thread,
            ...(command.title === undefined ? {} : { title: command.title }),
            ...(command.limitRecovery === undefined ? {} : { limitRecovery }),
            ...(command.limitRecovery !== undefined &&
            limitRecovery?.snooze === true &&
            Date.parse(limitRecovery.resetAt) > DateTime.toEpochMillis(now)
              ? {
                  snoozedUntil: DateTime.makeUnsafe(limitRecovery.resetAt),
                  // Recovery changes acknowledge the same stopped run; keep its
                  // metadata timestamp from appearing as a fresh failure wake.
                  snoozedAt: now,
                }
              : command.limitRecovery !== undefined &&
                  thread.limitRecovery?.snooze &&
                  thread.snoozedUntil != null &&
                  DateTime.toEpochMillis(thread.snoozedUntil) ===
                    Date.parse(thread.limitRecovery.resetAt)
                ? { snoozedUntil: null, snoozedAt: null, lastSnoozeWakeAt: now }
                : {}),
            ...(command.branch === undefined ? {} : { branch: command.branch }),
            ...(command.worktreePath === undefined ? {} : { worktreePath: command.worktreePath }),
            ...(command.messagePin === undefined
              ? {}
              : {
                  pinnedMessages: withMessagePin(
                    thread.pinnedMessages ?? [],
                    command.messagePin,
                    now,
                  ),
                }),
            ...(command.linkedPullRequest === undefined
              ? {}
              : {
                  linkedPullRequest: command.linkedPullRequest,
                  pullRequests: [
                    ...threadPullRequestsOf(thread).filter(
                      (link) =>
                        !(
                          thread.linkedPullRequest &&
                          threadPullRequestKeysEqual(
                            link,
                            legacyThreadPullRequestKey(thread.linkedPullRequest),
                          )
                        ) &&
                        !(
                          command.linkedPullRequest &&
                          threadPullRequestKeysEqual(
                            link,
                            legacyThreadPullRequestKey(command.linkedPullRequest),
                          )
                        ),
                    ),
                    ...(command.linkedPullRequest
                      ? [legacyPullRequestLink(thread, command.linkedPullRequest, now)]
                      : []),
                  ],
                }),
            // regenerateTitle: true arms the in-flight marker; a landing title
            // or an explicit false (generation failed/abandoned) clears it.
            ...(command.regenerateTitle === true
              ? { titleRegeneration: { requestId: command.commandId, startedAt: now } }
              : command.regenerateTitle === false || command.title !== undefined
                ? { titleRegeneration: null }
                : {}),
            updatedAt: now,
          };
        }
        case "thread.pull-request.link":
        case "thread.pull-request.unlink":
        case "thread.pull-request-link.sync": {
          const key = normalizeThreadPullRequestKey(command);
          const links = threadPullRequestsOf(thread);
          const existing = links.find((link) => threadPullRequestKeysEqual(link, key));
          let pullRequests = links;
          if (command.type === "thread.pull-request.link") {
            const undismisses =
              existing?.source === "stack-dismissed" &&
              command.source !== "stack" &&
              command.source !== "stack-dismissed";
            if (existing && !undismisses) return thread;
            const link = existing
              ? { ...existing, source: command.source, url: command.url }
              : {
                  ...key,
                  url: command.url,
                  source: command.source,
                  linkedAt: DateTime.formatIso(now),
                  snapshot: null,
                  stack: null,
                };
            const branch = thread.branchPullRequest;
            const branchKey = branch ? legacyThreadPullRequestKey(branch) : null;
            pullRequests = [
              ...(command.source === "manual" &&
              branch &&
              branchKey &&
              visibleThreadPullRequests(links).length === 0 &&
              !threadPullRequestKeysEqual(branchKey, key) &&
              !links.some((entry) => threadPullRequestKeysEqual(entry, branchKey))
                ? [
                    {
                      ...branchKey,
                      url: branch.url,
                      source: "manual" as const,
                      linkedAt: DateTime.formatIso(now),
                      snapshot: null,
                      stack: null,
                    },
                  ]
                : []),
              ...links.filter((entry) => !threadPullRequestKeysEqual(entry, key)),
              link,
            ];
          } else if (command.type === "thread.pull-request.unlink") {
            if (!existing) return thread;
            const belongsToStack =
              existing.source === "stack" ||
              existing.stack !== null ||
              links.some(
                (link) =>
                  link.host.toLowerCase() === key.host &&
                  link.repository.toLowerCase() === key.repository &&
                  link.stack?.layers.some((layer) => layer.number === key.number),
              );
            pullRequests = belongsToStack
              ? links.map((link) =>
                  link === existing
                    ? {
                        ...withPullRequestWatch(link, undefined),
                        source: "stack-dismissed" as const,
                      }
                    : link,
                )
              : links.filter((link) => link !== existing);
          } else {
            if (!existing) return thread;
            pullRequests = links.map((link) =>
              link === existing
                ? { ...link, snapshot: command.snapshot, stack: command.stack }
                : link,
            );
          }
          return {
            ...thread,
            pullRequests,
            linkedPullRequest:
              thread.linkedPullRequest &&
              pullRequests.some(
                (link) =>
                  link.source !== "stack-dismissed" &&
                  threadPullRequestKeysEqual(
                    link,
                    legacyThreadPullRequestKey(thread.linkedPullRequest!),
                  ),
              )
                ? thread.linkedPullRequest
                : null,
            updatedAt: command.type === "thread.pull-request-link.sync" ? thread.updatedAt : now,
          };
        }
        case "thread.pull-request.watch":
        case "thread.pull-request-watch.sync": {
          const key = normalizeThreadPullRequestKey(command);
          const startedAt = DateTime.formatIso(now);
          const linked = threadPullRequestsOf(thread);
          const visible = (link: ThreadPullRequestLink) =>
            link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, key);
          // A watch started on an unlinked (or dismissed) pull request links it in the same step.
          const links =
            command.type === "thread.pull-request.watch" &&
            command.watching &&
            command.link !== undefined &&
            !linked.some(visible)
              ? [
                  ...linked.filter((link) => !threadPullRequestKeysEqual(link, key)),
                  {
                    ...key,
                    url: command.link.url,
                    source: command.link.source,
                    linkedAt: startedAt,
                    snapshot: null,
                    stack: null,
                  },
                ]
              : linked;
          const existing = links.find(visible);
          if (existing === undefined) return thread;
          const watch =
            command.type === "thread.pull-request-watch.sync"
              ? // Progress read before a stop or restart must not bring the old watch back.
                existing.watch?.startedAt === command.startedAt
                ? (command.watch ?? undefined)
                : existing.watch
              : !command.watching
                ? undefined
                : (existing.watch ?? {
                    startedAt,
                    headSha: null,
                    failedChecks: [],
                    passed: false,
                    passedChecks: [],
                    remarksThrough: startedAt,
                    remarkIds: [],
                    conflicting: false,
                    wakes: 0,
                  });
          if (watch === existing.watch && links === linked) return thread;
          return {
            ...thread,
            pullRequests: links.map((link) =>
              link === existing ? withPullRequestWatch(link, watch) : link,
            ),
            // A user or agent starting or stopping a watch is activity; recorded progress is not.
            updatedAt: command.type === "thread.pull-request.watch" ? now : thread.updatedAt,
          };
        }
        case "thread.pull-request.sync":
          return {
            ...thread,
            branchPullRequest: command.branchPullRequest,
            ...(command.linkedPullRequest === undefined
              ? {}
              : {
                  linkedPullRequest: command.linkedPullRequest,
                  pullRequests: [
                    ...threadPullRequestsOf(thread).filter(
                      (link) =>
                        !(
                          thread.linkedPullRequest &&
                          threadPullRequestKeysEqual(
                            link,
                            legacyThreadPullRequestKey(thread.linkedPullRequest),
                          )
                        ) &&
                        !(
                          command.linkedPullRequest &&
                          threadPullRequestKeysEqual(
                            link,
                            legacyThreadPullRequestKey(command.linkedPullRequest),
                          )
                        ),
                    ),
                    ...(command.linkedPullRequest
                      ? [legacyPullRequestLink(thread, command.linkedPullRequest, now)]
                      : []),
                  ],
                }),
            updatedAt: thread.updatedAt,
          };
        case "thread.title.regeneration.complete":
          return thread.titleRegeneration?.requestId === command.requestId
            ? {
                ...thread,
                ...(command.title === undefined ? {} : { title: command.title }),
                titleRegeneration: null,
                updatedAt: now,
              }
            : thread;
        case "thread.runtime-mode.set":
          return { ...thread, runtimeMode: command.runtimeMode, updatedAt: now };
        case "thread.interaction-mode.set":
          return { ...thread, interactionMode: command.interactionMode, updatedAt: now };
        case "thread.model-selection.set":
        case "provider.switch":
          return {
            ...thread,
            providerInstanceId: command.modelSelection.instanceId,
            modelSelection: command.modelSelection,
            updatedAt: now,
          };
      }
    })();
    if (
      command.type === "thread.pull-request-link.sync" ||
      command.type === "thread.pull-request-watch.sync"
    ) {
      if (updatedThread === thread) return;
      const link = threadPullRequestsOf(updatedThread).find((candidate) =>
        threadPullRequestKeysEqual(candidate, normalizeThreadPullRequestKey(command)),
      );
      if (link === undefined) return;
      yield* emit(
        events,
        command,
      )({
        type: "thread.pull-request-link-updated",
        threadId: command.threadId,
        providerInstanceId: updatedThread.providerInstanceId,
        occurredAt: now,
        payload: link,
      });
      return;
    }
    const eventType = (() => {
      switch (command.type) {
        case "thread.archive":
          return "thread.archived" as const;
        case "thread.unarchive":
          return "thread.unarchived" as const;
        case "thread.settle":
          return "thread.settled" as const;
        case "thread.unsettle":
          return "thread.unsettled" as const;
        case "thread.snooze":
          return "thread.snoozed" as const;
        case "thread.unsnooze":
          return "thread.unsnoozed" as const;
        case "thread.auto-settle.set":
          return "thread.auto-settle-set" as const;
        case "thread.pin":
          return "thread.pinned" as const;
        case "thread.unpin":
          return "thread.unpinned" as const;
        case "thread.pin.reorder":
          return "thread.pin-reordered" as const;
        case "thread.active.reorder":
          return "thread.active-reordered" as const;
        case "thread.mark-unread":
          return "thread.marked-unread" as const;
        case "thread.metadata.update":
        case "thread.title.regeneration.complete":
          return "thread.metadata-updated" as const;
        case "thread.pull-request.link":
        case "thread.pull-request.unlink":
        case "thread.pull-request.watch":
        case "thread.pull-request.sync":
          return "thread.pull-request-synced" as const;
        case "thread.runtime-mode.set":
          return "thread.runtime-mode-updated" as const;
        case "thread.interaction-mode.set":
          return "thread.interaction-mode-updated" as const;
        case "thread.model-selection.set":
          return thread.providerInstanceId === command.modelSelection.instanceId
            ? ("thread.model-selection-updated" as const)
            : ("thread.provider-switched" as const);
        case "provider.switch":
          return "thread.provider-switched" as const;
      }
    })();
    yield* emit(
      events,
      command,
    )({
      type: eventType,
      threadId: command.threadId,
      providerInstanceId: updatedThread.providerInstanceId,
      occurredAt: now,
      payload: updatedThread,
    });

    // Only a real title change: re-sending a clipped child title must not replace the
    // subagent's full one.
    if (
      (command.type === "thread.metadata.update" ||
        command.type === "thread.title.regeneration.complete") &&
      updatedThread.title !== thread.title
    ) {
      yield* followDelegatedChildTitle(command, updatedThread, now, events);
    }

    if (command.type === "thread.metadata.update" && command.regenerateTitle === true) {
      yield* Ref.update(effects, (existing) => [
        ...existing,
        pendingThreadTitleGenerationEffect(command.commandId, command.threadId, {
          type: "regenerate",
        }),
      ]);
    }

    if (command.type === "thread.archive") {
      const projection = yield* loadProjectionForCommand(
        command,
        ["runs", "attempts", "nodes", "subagents"],
        { liveNodesOnly: true },
      );
      const emitEvent = emit(events, command);
      const activeRunIds = new Set(
        projection.runs.filter((run) => run.status === "queued").map((run) => run.id),
      );
      for (const run of projection.runs.filter((candidate) => activeRunIds.has(candidate.id))) {
        yield* emitEvent({
          type: "run.updated",
          threadId: command.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "cancelled", queuePosition: null, completedAt: now },
        });
      }
      for (const attempt of projection.attempts.filter(
        (candidate) =>
          activeRunIds.has(candidate.runId) &&
          (candidate.status === "pending" || candidate.status === "running"),
      )) {
        const run = projection.runs.find((candidate) => candidate.id === attempt.runId)!;
        yield* emitEvent({
          type: "run-attempt.updated",
          threadId: command.threadId,
          runId: attempt.runId,
          nodeId: attempt.rootNodeId,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...attempt, status: "cancelled", completedAt: now },
        });
      }
      for (const node of projection.nodes.filter(
        (candidate) =>
          candidate.runId !== null &&
          activeRunIds.has(candidate.runId) &&
          ["pending", "running", "waiting"].includes(candidate.status),
      )) {
        const run = projection.runs.find((candidate) => candidate.id === node.runId)!;
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: node.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...node, status: "cancelled", completedAt: now },
        });
      }
      yield* disposeAllDelegatedCompletionCohorts({
        command,
        events,
        projection: yield* getDelegatedCohortProjectionWithPendingEvents(command.threadId, events, {
          includeQueuedDelivery: false,
        }),
        now,
        cancelQueuedDelivery: false,
      });
    }

    // Settle joins archive here: both mean "done with this
    // thread", so a live provider session must not keep running background
    // work (PR monitors, dev servers, subagent fleets) after any of them
    // lands. The settle guard above already rejects active or blocked runs,
    // so for settle this only ever stops an idle session; commands are
    // decided serially against the projection, so a turn start that
    // re-engages the thread cannot race this detach.
    // The continuation releases the source session after its interrupt settles.
    if (
      (command.type === "provider.switch" || command.type === "thread.model-selection.set") &&
      providerSwitchPlan !== null &&
      (providerSwitchPlan.instanceChanged ||
        !modelSelectionsEqual(thread.modelSelection, command.modelSelection))
    ) {
      const prepared = yield* accountMoves
        .prepare(
          command.threadId,
          command.commandId,
          command.modelSelection,
          providerSwitchPlan,
          now,
        )
        .pipe(
          Effect.mapError((cause) =>
            cause._tag === "AccountMoveUnavailableError" ||
            cause._tag === "ThreadManagementProviderInstanceDisabledError"
              ? cause
              : new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      const move = prepared?.move;
      if (move === undefined) {
        // Runs queued under the replaced selection take the new one, so promoting them
        // never switches the thread back.
        for (const event of prepared?.events ?? [])
          yield* emit(events, command)<OrchestrationV2DomainEvent>(event);
        if (prepared?.inFlight) return;
      } else {
        const cancelled = yield* dispatchRunInterrupt(
          {
            type: "run.interrupt",
            commandId: command.commandId,
            threadId: command.threadId,
            runId: move.source.id,
            keepHelpers: true,
          },
          events,
          effects,
          true,
        );
        for (const event of prepared?.events ?? [])
          yield* emit(events, command)<OrchestrationV2DomainEvent>(event);
        yield* Ref.update(effects, (current) => [...current, move.continuation]);
        return cancelled;
      }
    }
    if (command.type === "thread.runtime-mode.set" && command.runtimeMode !== thread.runtimeMode) {
      const providerThread = providerContext?.providerThreads.find(
        (candidate) => candidate.id === thread.activeProviderThreadId,
      );
      const session = providerContext?.providerSessions.find(
        (candidate) => candidate.id === providerThread?.providerSessionId,
      );
      if (
        providerThread &&
        session &&
        session.capabilities.sessions.appliesRuntimeModeChangesImmediately &&
        session.status !== "stopped" &&
        session.status !== "error"
      ) {
        yield* Ref.update(effects, (current) => [
          ...current,
          {
            id: `effect:${command.commandId}:provider-session.runtime-mode.apply`,
            commandId: command.commandId,
            threadId: command.threadId,
            request: {
              type: "provider-session.runtime-mode.apply",
              providerSessionId: session.id,
              providerThreadId: providerThread.id,
              runtimeMode: command.runtimeMode,
            },
          } satisfies PendingOrchestrationEffectV2,
        ]);
      }
    }
    // Other in-flight selection changes take effect at the next turn boundary.
    const turnRunning =
      (providerSwitchPlan?.releaseProviderSessionIds.length ?? 0) > 0 &&
      (yield* loadProjectionForCommand(command, ["runs"])).runs.some(
        (run) =>
          run.status === "preparing" ||
          run.status === "starting" ||
          run.status === "running" ||
          run.status === "waiting",
      );
    const detachSessionIds = new Set(
      command.type === "thread.archive" || command.type === "thread.settle"
        ? (providerContext?.providerSessions ?? []).map((session) => session.id)
        : command.type === "thread.metadata.update" &&
            command.worktreePath !== undefined &&
            command.worktreePath !== thread.worktreePath
          ? (providerContext?.providerSessions ?? []).map((session) => session.id)
          : command.type === "thread.runtime-mode.set"
            ? (providerContext?.providerSessions ?? [])
                .filter(
                  (session) => !session.capabilities.sessions.supportsRuntimeModeSwitchInSession,
                )
                .map((session) => session.id)
            : turnRunning
              ? []
              : (providerSwitchPlan?.releaseProviderSessionIds ?? []),
    );
    // The outgoing model writes a brief for the next send's handoff before its session goes.
    const briefTargetInstanceId =
      (command.type === "thread.model-selection.set" || command.type === "provider.switch") &&
      providerSwitchPlan?.transition.type === "create_with_handoff"
        ? command.modelSelection.instanceId
        : undefined;
    const briefSessionId = providerContext?.providerThreads.find(
      (candidate) => candidate.id === providerContext.thread.activeProviderThreadId,
    )?.providerSessionId;
    if (detachSessionIds.size > 0) {
      const liveSessions = (providerContext?.providerSessions ?? []).filter(
        (session) =>
          detachSessionIds.has(session.id) &&
          session.status !== "stopped" &&
          session.status !== "error",
      );
      yield* Effect.forEach(
        liveSessions,
        (session) =>
          Effect.gen(function* () {
            yield* emit(
              events,
              command,
            )({
              type: "provider-session.detached",
              threadId: command.threadId,
              driver: session.driver,
              providerInstanceId: session.providerInstanceId,
              occurredAt: now,
              payload: {
                providerSessionId: session.id,
                detachedAt: now,
                reason:
                  command.type === "thread.archive"
                    ? "Thread archived."
                    : command.type === "thread.settle"
                      ? "Thread settled."
                      : command.type === "thread.metadata.update"
                        ? "Workspace changed."
                        : command.type === "thread.runtime-mode.set"
                          ? "Runtime mode changed."
                          : "Provider or model selection changed.",
              },
            });
            const pendingEffect = {
              id: `effect:${command.commandId}:provider-session.detach:${session.id}`,
              commandId: command.commandId,
              threadId: command.threadId,
              request: {
                type: "provider-session.detach",
                providerSessionId: session.id,
                detail:
                  command.type === "thread.archive"
                    ? "Thread archived."
                    : command.type === "thread.settle"
                      ? "Thread settled."
                      : command.type === "thread.metadata.update"
                        ? "Workspace changed."
                        : command.type === "thread.runtime-mode.set"
                          ? "Runtime mode changed."
                          : "Provider or model selection changed.",
                // Terminal detaches revoke the thread's MCP credentials; other
                // detach reasons keep them so a re-attaching provider process
                // stays authorized.
                ...(command.type === "thread.archive" ? { revokeMcpCredential: true } : {}),
                ...(briefTargetInstanceId !== undefined && session.id === briefSessionId
                  ? { handoffBrief: { targetInstanceId: briefTargetInstanceId } }
                  : {}),
              },
            } satisfies PendingOrchestrationEffectV2;
            yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
          }),
        { concurrency: 1, discard: true },
      );
    }

    if (command.type === "thread.archive") {
      yield* Ref.update(effects, (existing) => [
        ...existing,
        delegatedTasksStopEffect({ ...command, reason: "Parent thread archived." }),
        {
          id: `effect:${command.commandId}:terminal.cleanup`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "terminal.cleanup" },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    }
  });

  const dispatchProviderSessionDetach = Effect.fn("orchestrationV2.dispatch.providerSessionDetach")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "provider-session.detach" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const projection = yield* projectionStore
        .getThreadRecords(command.threadId, ["providerSessions"])
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      const session = projection.providerSessions.find(
        (candidate) => candidate.id === command.providerSessionId,
      );
      if (session === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Provider session ${command.providerSessionId} does not belong to thread ${command.threadId}.`,
        });
      }
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "provider-session.detached",
        threadId: command.threadId,
        driver: session.driver,
        providerInstanceId: session.providerInstanceId,
        occurredAt: now,
        payload: {
          providerSessionId: session.id,
          detachedAt: now,
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        },
      });
      const pendingEffect = {
        id: `effect:${command.commandId}:provider-session.detach:${command.providerSessionId}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: {
          type: "provider-session.detach",
          providerSessionId: command.providerSessionId,
          ...(command.reason === undefined ? {} : { detail: command.reason }),
        },
      } satisfies PendingOrchestrationEffectV2;
      yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
    },
  );

  /** Fails when a limited sender's command would touch a thread running above its limit. */
  const refuseAboveDispatchModeLimit = Effect.fn("orchestrationV2.dispatch.refuseAboveModeLimit")(
    function* (
      command: OrchestrationV2ServerCommand,
      threadId: ThreadId,
      modes: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      },
    ) {
      const limit = yield* DispatchModeLimit;
      const exceeded = limit === undefined ? undefined : exceededDispatchModeLimit(limit, modes);
      if (limit === undefined || exceeded === undefined) return;
      const refusal = {
        threadId,
        mode: exceeded,
        runtimeMode: modes.runtimeMode,
        interactionMode: modes.interactionMode,
      };
      if (limit.refused !== undefined) yield* Ref.set(limit.refused, refusal);
      return yield* new OrchestratorThreadAboveModeLimitError({
        commandId: command.commandId,
        ...refusal,
      });
    },
  );

  const dispatchThreadFork = Effect.fn("orchestrationV2.dispatch.threadFork")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.source_thread_id": command.sourceThreadId,
      "orchestration_v2.target_thread_id": command.targetThreadId,
      "orchestration_v2.source_point_type": command.sourcePoint.type,
    });

    const sourceProjection = yield* projectionStore
      .getThreadRecords(command.sourceThreadId, [
        "runs",
        ...(command.sourcePoint.type === "checkpoint" ? (["checkpoints"] as const) : []),
        "providerThreads",
        "providerTurns",
        "attempts",
        "contextTransfers",
      ])
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.sourceThreadId,
              cause,
            }),
        ),
      );
    // The source is not under this command's lock, so check the modes this
    // command copies, not an earlier read the source's user could outrun.
    yield* refuseAboveDispatchModeLimit(command, command.sourceThreadId, sourceProjection.thread);

    const sourceRun = runForSourcePoint(sourceProjection, command.sourcePoint);

    if (sourceRun === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `No stable source run was found for fork source ${command.sourcePoint.type}.`,
      });
    }
    if (!isForkableSourceRunStatus(sourceRun.status)) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: forkableSourceRunStatusError(sourceRun),
      });
    }
    const sourceProviderThread = providerThreadForRun(sourceProjection, sourceRun);
    const now = command.createdAt ?? (yield* DateTime.now);
    const emitEvent = emit(events, command);
    const transferId = yield* mapDispatchError(command)(
      idAllocator.allocate.contextTransfer({
        sourceThreadId: sourceProjection.thread.id,
        targetThreadId: command.targetThreadId,
        type: "fork",
      }),
    );
    const { targetThread, transfer } = yield* threadForkService
      .plan({
        sourceProjection,
        sourceRun,
        sourceProviderThread,
        canonicalSourcePoint: contextSourcePointForRun(sourceProjection, sourceRun),
        transferId,
        targetThreadId: command.targetThreadId,
        ...(command.title === undefined ? {} : { title: command.title }),
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        createdAt: now,
      })
      .pipe(mapDispatchError(command));

    yield* emitEvent({
      type: "thread.created",
      threadId: command.targetThreadId,
      providerInstanceId: targetThread.providerInstanceId,
      occurredAt: now,
      payload: targetThread,
    });
    yield* emitEvent({
      type: "context-transfer.created",
      threadId: command.targetThreadId,
      providerInstanceId: sourceRun.providerInstanceId,
      occurredAt: now,
      payload: transfer,
    });
  });

  const dispatchThreadMergeBack = Effect.fn("orchestrationV2.dispatch.threadMergeBack")(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.merge_back" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.source_thread_id": command.sourceThreadId,
      "orchestration_v2.target_thread_id": command.targetThreadId,
      "orchestration_v2.source_point_type": command.sourcePoint.type,
    });

    const sourceProjection = yield* projectionStore
      .getThreadRecords(command.sourceThreadId, [
        "runs",
        "checkpoints",
        "providerThreads",
        "providerTurns",
        "attempts",
        "contextTransfers",
      ])
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.sourceThreadId,
              cause,
            }),
        ),
      );
    // The source is not under this command's lock, so check the modes this
    // command copies, not an earlier read the source's user could outrun.
    yield* refuseAboveDispatchModeLimit(command, command.sourceThreadId, sourceProjection.thread);
    const targetProjection = yield* projectionStore
      .getThreadRecords(command.targetThreadId, ["contextTransfers"])
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.targetThreadId,
              cause,
            }),
        ),
      );

    if (
      sourceProjection.thread.lineage.relationshipToParent !== "fork" ||
      sourceProjection.thread.lineage.parentThreadId !== command.targetThreadId
    ) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Thread ${command.sourceThreadId} is not a fork of ${command.targetThreadId}.`,
      });
    }

    const sourceRun = runForSourcePoint(sourceProjection, command.sourcePoint);
    if (sourceRun === null) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `No stable source run was found for merge-back source ${command.sourcePoint.type}.`,
      });
    }
    if (sourceRun.status !== "completed" && sourceRun.status !== "waiting") {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Merge-back source run ${sourceRun.id} is ${sourceRun.status}; only provider-finished runs are supported.`,
      });
    }

    const forkTransfer = sourceProjection.contextTransfers.findLast(
      (transfer) =>
        transfer.type === "fork" &&
        transfer.sourceThreadId === command.targetThreadId &&
        transfer.targetThreadId === command.sourceThreadId,
    );
    if (forkTransfer === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `No fork transfer exists between ${command.targetThreadId} and ${command.sourceThreadId}.`,
      });
    }

    const sourceProviderThread = providerThreadForRun(sourceProjection, sourceRun);
    const now = command.createdAt ?? (yield* DateTime.now);
    const emitEvent = emit(events, command);
    const transferId = yield* mapDispatchError(command)(
      idAllocator.allocate.contextTransfer({
        sourceThreadId: command.sourceThreadId,
        targetThreadId: command.targetThreadId,
        type: "merge_back",
      }),
    );
    const pendingMergeBackTransfersForPair = targetProjection.contextTransfers.filter(
      (transfer) =>
        transfer.type === "merge_back" &&
        transfer.status === "pending" &&
        transfer.sourceThreadId === command.sourceThreadId &&
        transfer.targetThreadId === command.targetThreadId,
    );
    const transfer: OrchestrationV2ContextTransfer = {
      id: transferId,
      type: "merge_back",
      sourceThreadId: command.sourceThreadId,
      targetThreadId: command.targetThreadId,
      sourcePoint: contextSourcePointForRun(sourceProjection, sourceRun),
      basePoint: forkTransfer.sourcePoint,
      sourceProviderInstanceId: sourceRun.providerInstanceId,
      targetProviderInstanceId: targetProjection.thread.modelSelection.instanceId,
      targetRunId: null,
      status: "pending",
      resolution: null,
      createdBy: command.createdBy,
      error:
        sourceProviderThread === undefined ? "Source merge-back run has no provider thread." : null,
      createdAt: now,
      updatedAt: now,
      consumedAt: null,
    };

    for (const pendingTransfer of pendingMergeBackTransfersForPair) {
      yield* emitEvent({
        type: "context-transfer.updated",
        threadId: command.targetThreadId,
        providerInstanceId: sourceRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...pendingTransfer,
          status: "superseded",
          error: `Superseded by merge-back transfer ${transferId}.`,
          updatedAt: now,
        },
      });
    }
    yield* emitEvent({
      type: "context-transfer.created",
      threadId: command.targetThreadId,
      providerInstanceId: sourceRun.providerInstanceId,
      occurredAt: now,
      payload: transfer,
    });
  });

  const validateSteerInput = (
    command: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
    >,
    text: string,
  ) => {
    const cause = expandedCitationInputError(text);
    return cause === undefined
      ? Effect.void
      : Effect.fail(
          new OrchestratorCommandRejectedError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
        );
  };

  const dispatchSteerIntoRun = (input: {
    readonly command: Extract<
      OrchestrationV2Command,
      { readonly type: "message.dispatch" | "queued-message.promote-to-steer" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      | "runs"
      | "messages"
      | "providerSessions"
      | "providerThreads"
      | "providerTurns"
      | "subagents"
      | "attempts"
      | "nodes"
      | "thread"
      | "turnItems"
    >;
    readonly modelSelection: ModelSelection;
    readonly targetRunId: OrchestrationV2Run["id"];
    readonly messageId: OrchestrationV2ConversationMessage["id"];
    readonly text: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
    readonly context?: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
    readonly createdBy: OrchestrationV2ConversationMessage["createdBy"];
    readonly creationSource: OrchestrationV2ConversationMessage["creationSource"];
    readonly scheduledTaskId?: OrchestrationV2ConversationMessage["scheduledTaskId"];
    readonly senderThreadId?: OrchestrationV2ConversationMessage["senderThreadId"];
    readonly notifySenderOnCompletion?: boolean;
    readonly notification?: OrchestrationV2ConversationMessage["notification"];
    readonly delegatedCompletion?: OrchestrationV2ConversationMessage["delegatedCompletion"];
    readonly forceRestart: boolean;
  }) =>
    Effect.gen(function* () {
      yield* validateSteerInput(input.command, input.text);
      const targetRun = input.projection.runs.find(
        (candidate) => candidate.id === input.targetRunId,
      );
      if (targetRun === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Target run ${input.targetRunId} was not found.`,
        });
      }
      if (isNativeMaintenanceCommand(input)) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: /^\/compact(?:\s|$)/iu.test(input.text.trim())
            ? "Context compaction must run as a separate turn. Queue it or wait for the active turn to finish."
            : "Signing out must run as a separate turn. Queue it or wait for the active turn to finish.",
        });
      }
      if (isGoalCommand(input)) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause:
            "Goal commands must run as a separate turn. Queue it or wait for the active turn to finish.",
        });
      }
      const targetMessage = input.projection.messages.find(
        (message) => message.id === targetRun.userMessageId,
      );
      if (targetMessage !== undefined && isNativeMaintenanceCommand(targetMessage)) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: /^\/compact(?:\s|$)/iu.test(targetMessage.text.trim())
            ? "Wait for context compaction to finish before steering the thread."
            : "Wait for sign-out to finish before steering the thread.",
        });
      }
      const rootNodeId = targetRun.rootNodeId;
      if (rootNodeId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Target run ${targetRun.id} has no root node.`,
        });
      }
      if (targetRun.status !== "running") {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Target run ${targetRun.id} is ${targetRun.status} and cannot be steered.`,
        });
      }
      if (yield* stopReachedRun(input.command, input.command.threadId, targetRun.id)) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Target run ${targetRun.id} is stopping and cannot be steered.`,
        });
      }
      const providerThread = input.projection.providerThreads.find(
        (candidate) => candidate.id === targetRun.providerThreadId,
      );
      if (providerThread === undefined || providerThread.providerSessionId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Provider thread ${targetRun.providerThreadId} has no active provider session for steering.`,
        });
      }
      const providerSessionId = providerThread.providerSessionId;
      const providerTurn = input.projection.providerTurns.find(
        (candidate) =>
          candidate.nodeId === rootNodeId &&
          candidate.runAttemptId === targetRun.activeAttemptId &&
          candidate.status === "running",
      );
      if (providerTurn === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `No running provider turn found for active run ${targetRun.id}.`,
        });
      }
      if (!input.forceRestart && providerTurn.steeringUnavailable !== undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: "This turn can't be steered. Use Send now to interrupt it.",
        });
      }
      const sessionOption = yield* providerSessions.get(providerSessionId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: input.command.commandId,
              commandType: input.command.type,
              cause,
            }),
        ),
      );
      if (Option.isNone(sessionOption)) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Provider session ${providerThread.providerSessionId} is not active.`,
        });
      }

      const session = sessionOption.value;
      if (
        input.command.type === "message.dispatch" &&
        input.command.steerExistingOnly === true &&
        (!session.providerSession.capabilities.turns.supportsActiveSteering ||
          session.providerSession.capabilities.turns.activeSteeringInterruptsTools === true ||
          !modelSelectionsEqual(targetRun.modelSelection, input.modelSelection))
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: "This run does not support native notice delivery.",
        });
      }
      const now = yield* DateTime.now;
      const emitEvent = emit(input.events, input.command);
      const selectionChanged = !modelSelectionsEqual(
        targetRun.modelSelection,
        input.modelSelection,
      );
      const providerInstanceChanged =
        targetRun.providerInstanceId !== input.modelSelection.instanceId;
      const selectionTransition =
        selectionChanged && !providerInstanceChanged
          ? yield* providerAdapters.get(targetRun.providerInstanceId).pipe(
              Effect.flatMap((adapter) =>
                adapter.planSelectionTransition({
                  current: targetRun.modelSelection,
                  target: input.modelSelection,
                  sessionCapabilities: session.providerSession.capabilities,
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new OrchestratorProviderAdapterError({
                    commandId: input.command.commandId,
                    providerInstanceId: targetRun.providerInstanceId,
                    cause,
                  }),
              ),
            )
          : null;
      if (selectionTransition?.type === "reject") {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: selectionTransition.reason,
        });
      }
      // The agent's reply ended and only background work (a timer, a command, a subagent) holds
      // its prompt open, e.g. `agy acp` 1.5.15+. A steer then starts new work for the user.
      const agentWasWaiting = providerThread.waitingOnBackgroundWork === true;
      const appendSteeringMessage = (messageInput: {
        readonly runId: OrchestrationV2Run["id"];
        readonly nodeId: OrchestrationV2ExecutionNode["id"];
        readonly providerTurnId: typeof providerTurn.id | null;
        readonly providerThreadId: OrchestrationV2ProviderThread["id"];
        readonly providerInstanceId: ProviderInstanceId;
        readonly modelSwitch?: OrchestrationV2ModelSwitch | undefined;
      }) =>
        Effect.gen(function* () {
          const message: OrchestrationV2ConversationMessage = {
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            ...(input.notification === undefined ? {} : { notification: input.notification }),
            ...(input.delegatedCompletion === undefined
              ? {}
              : { delegatedCompletion: input.delegatedCompletion }),
            ...(input.scheduledTaskId === undefined
              ? {}
              : { scheduledTaskId: input.scheduledTaskId }),
            ...threadSendFields(input),
            id: input.messageId,
            threadId: input.command.threadId,
            runId: messageInput.runId,
            nodeId: messageInput.nodeId,
            role: "user",
            text: input.text,
            attachments: input.attachments,
            ...(input.context ? { context: input.context } : {}),
            streaming: false,
            createdAt: now,
            updatedAt: now,
          };
          const turnItem: OrchestrationV2TurnItem = {
            createdBy: input.createdBy,
            creationSource: input.creationSource,
            ...(input.scheduledTaskId === undefined
              ? {}
              : { scheduledTaskId: input.scheduledTaskId }),
            ...threadSendFields(input),
            id: idAllocator.derive.userTurnItem({ messageId: input.messageId }),
            threadId: input.command.threadId,
            runId: messageInput.runId,
            nodeId: messageInput.nodeId,
            providerThreadId: messageInput.providerThreadId,
            providerTurnId: messageInput.providerTurnId,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: yield* nextTurnItemOrdinal(input.projection),
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: input.messageId,
            inputIntent:
              input.command.type === "queued-message.promote-to-steer"
                ? "promoted_queued_to_steer"
                : "steer",
            ...(agentWasWaiting ? { agentWasWaiting: true as const } : {}),
            text: input.text,
            attachments: input.attachments,
            ...(input.context ? { context: input.context } : {}),
            ...(messageInput.modelSwitch === undefined
              ? {}
              : { modelSwitch: messageInput.modelSwitch }),
          };
          yield* emitEvent({
            type: "message.updated",
            threadId: input.command.threadId,
            runId: messageInput.runId,
            nodeId: messageInput.nodeId,
            providerInstanceId: messageInput.providerInstanceId,
            occurredAt: now,
            payload: message,
          });
          yield* emitEvent({
            type: "turn-item.updated",
            threadId: input.command.threadId,
            runId: messageInput.runId,
            nodeId: messageInput.nodeId,
            providerInstanceId: messageInput.providerInstanceId,
            occurredAt: now,
            payload: notificationTurnItem(turnItem, message, input.projection.subagents),
          });
        });

      // Native steering saves selection changes for the next turn. A restart
      // applies them to its replacement attempt.
      const steeringPolicy = yield* enforceCommandPolicy(input.command)(
        commandPolicy.decideSteeringExecution({
          commandId: input.command.commandId,
          threadId: input.command.threadId,
          providerInstanceId: targetRun.providerInstanceId,
          capabilities: session.providerSession.capabilities,
          driver: session.providerSession.driver,
          forceRestart: input.forceRestart,
        }),
      );

      if (steeringPolicy === "active_steering") {
        // The steer's selection becomes the saved next-turn choice, even when it
        // matches the running run again. A delegated completion carries the
        // run's selection, not a user choice, so it never replaces the saved one.
        // The saved choice may name another instance, so it moves with the steer.
        const instanceChanged =
          input.projection.thread.providerInstanceId !== input.modelSelection.instanceId;
        if (
          input.delegatedCompletion === undefined &&
          input.notification === undefined &&
          (instanceChanged ||
            !modelSelectionsEqual(input.projection.thread.modelSelection, input.modelSelection))
        ) {
          yield* emitEvent({
            type: instanceChanged ? "thread.provider-switched" : "thread.model-selection-updated",
            threadId: input.command.threadId,
            providerInstanceId: input.modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...input.projection.thread,
              providerInstanceId: input.modelSelection.instanceId,
              modelSelection: input.modelSelection,
              updatedAt: now,
            },
          });
        }
        yield* appendSteeringMessage({
          runId: targetRun.id,
          nodeId: rootNodeId,
          providerTurnId: providerTurn.id,
          providerThreadId: providerThread.id,
          providerInstanceId: targetRun.providerInstanceId,
        });
        // A message to a waiting agent starts new work: the working timer counts from it, not from
        // the prompt the wait belonged to. Wakes don't start new work.
        if (
          agentWasWaiting &&
          input.notification === undefined &&
          input.delegatedCompletion === undefined
        ) {
          yield* emitEvent({
            type: "run.updated",
            threadId: input.command.threadId,
            runId: targetRun.id,
            nodeId: rootNodeId,
            providerInstanceId: targetRun.providerInstanceId,
            occurredAt: now,
            payload: { ...targetRun, workStartedAt: now },
          });
        }
        yield* Ref.update(input.effects, (existing) => [
          ...existing,
          {
            id: `effect:${input.command.commandId}:provider-turn.steer:${providerTurn.id}`,
            commandId: input.command.commandId,
            threadId: input.command.threadId,
            request: {
              type: "provider-turn.steer",
              providerSessionId,
              providerThreadId: providerThread.id,
              providerTurnId: providerTurn.id,
              messageId: input.messageId,
              ...(input.command.type === "message.dispatch" &&
              input.command.steerExistingOnly === true
                ? { steerExistingOnly: true }
                : {}),
            },
          } satisfies PendingOrchestrationEffectV2,
        ]);
        return;
      }

      const currentAttempt = input.projection.attempts.find(
        (candidate) => candidate.id === targetRun.activeAttemptId,
      );
      const currentRootNode = input.projection.nodes.find(
        (candidate) => candidate.id === rootNodeId,
      );
      const attemptOrdinal =
        Math.max(
          0,
          ...input.projection.attempts
            .filter((candidate) => candidate.runId === targetRun.id)
            .map((candidate) => candidate.attemptOrdinal),
        ) + 1;
      const nextAttemptId = idAllocator.derive.runAttempt({
        runId: targetRun.id,
        attemptOrdinal,
      });
      const nextRootNodeId = idAllocator.derive.rootNodeAttempt({
        runId: targetRun.id,
        attemptOrdinal,
      });
      let restartProviderThread = providerThread;
      let restartSessionTransition:
        | {
            readonly type: "replace";
            readonly replacementProviderSessionId: ProviderSessionId;
          }
        | { readonly type: "detach" }
        | null = null;
      let restartHandoff: OrchestrationV2ContextHandoff | null = null;
      let restartTransfer: OrchestrationV2ContextTransfer | null = null;
      const canResumeAcrossInstances =
        providerInstanceChanged &&
        providerThread.nativeThreadRef !== null &&
        (yield* providerSwitchService
          .plan({
            projection: {
              ...input.projection,
              thread: { ...input.projection.thread, modelSelection: targetRun.modelSelection },
            },
            targetModelSelection: input.modelSelection,
          })
          .pipe(mapDispatchError(input.command))).transition.type === "restart_and_resume";
      const requiresProviderThreadHandoff =
        (providerInstanceChanged && !canResumeAcrossInstances) ||
        selectionTransition?.type === "create_with_handoff";
      const requiresProviderSessionRestart =
        canResumeAcrossInstances || selectionTransition?.type === "restart_session";
      if (requiresProviderThreadHandoff) {
        const targetAdapter = yield* providerAdapters.get(input.modelSelection.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: input.command.commandId,
                providerInstanceId: input.modelSelection.instanceId,
                cause,
              }),
          ),
        );
        const targetCapabilities = yield* targetAdapter.getCapabilities().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: input.command.commandId,
                providerInstanceId: input.modelSelection.instanceId,
                cause,
              }),
          ),
        );
        yield* enforceCommandPolicy(input.command)(
          commandPolicy.ensureContextHandoff({
            commandId: input.command.commandId,
            threadId: input.command.threadId,
            providerInstanceId: input.modelSelection.instanceId,
            capabilities: targetCapabilities,
            strategy: "full_thread_summary",
          }),
        );
        const existingTargetProviderThread = rootProviderThreadsForProvider(
          input.projection,
          input.modelSelection.instanceId,
        ).find((candidate) => candidate.id !== providerThread.id);
        const targetProviderSessionId =
          existingTargetProviderThread?.providerSessionId ??
          (yield* mapDispatchError(input.command)(
            providerSessionIdFor({
              adapter: targetAdapter,
              providerInstanceId: input.modelSelection.instanceId,
              threadId: input.command.threadId,
            }),
          ));
        const targetProviderThreadBase: OrchestrationV2ProviderThread =
          existingTargetProviderThread === undefined
            ? {
                id: idAllocator.derive.providerThread({
                  driver: targetAdapter.driver,
                  nativeThreadId: `pending:${targetRun.id}:attempt:${attemptOrdinal}`,
                }),
                driver: targetAdapter.driver,
                providerInstanceId: input.modelSelection.instanceId,
                providerSessionId: targetProviderSessionId,
                appThreadId: input.command.threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "not_loaded",
                firstRunOrdinal: targetRun.ordinal,
                lastRunOrdinal: targetRun.ordinal,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }
            : {
                ...existingTargetProviderThread,
                providerSessionId: targetProviderSessionId,
                lastRunOrdinal: targetRun.ordinal,
                updatedAt: now,
              };
        const transferId = yield* mapDispatchError(input.command)(
          idAllocator.allocate.contextTransfer({
            sourceThreadId: input.command.threadId,
            targetThreadId: input.command.threadId,
            type: "provider_handoff",
          }),
        );
        const handoffSource = yield* getProjectionWithPendingEvents(
          input.command.threadId,
          input.events,
          "handoff",
        );
        restartHandoff = yield* contextHandoffService
          .prepareProviderHandoff({
            threadId: input.command.threadId,
            targetRunId: targetRun.id,
            transferId,
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: targetProviderThreadBase.id,
            fromProviderInstanceId: targetRun.providerInstanceId,
            toProviderInstanceId: input.modelSelection.instanceId,
            coveredRunOrdinals: { from: 1, to: targetRun.ordinal },
            strategy: "full_thread_summary",
            items: yield* readHandoffItems(input.command.threadId, [
              null,
              ...handoffSource.runs
                .filter((run) => run.id === targetRun.id || isHandoffSourceRun(run))
                .map((run) => run.id),
            ]),
            runs: handoffSource.runs,
            createdAt: now,
          })
          .pipe(mapDispatchError(input.command));
        restartProviderThread = {
          ...targetProviderThreadBase,
          handoffIds: Array.from(
            new Set([...targetProviderThreadBase.handoffIds, restartHandoff.id]),
          ),
        };
        restartTransfer = {
          id: transferId,
          type: "provider_handoff",
          sourceThreadId: input.command.threadId,
          targetThreadId: input.command.threadId,
          sourcePoint: contextSourcePointForRun(handoffSource, targetRun),
          basePoint: null,
          sourceProviderInstanceId: targetRun.providerInstanceId,
          targetProviderInstanceId: input.modelSelection.instanceId,
          targetRunId: targetRun.id,
          status: "consumed",
          resolution: {
            strategy: "portable_context",
            contextHandoffId: restartHandoff.id,
          },
          createdBy: input.createdBy,
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: now,
        };
        restartSessionTransition = { type: "detach" };
      } else if (requiresProviderSessionRestart) {
        const nextProviderSessionId = yield* mapDispatchError(input.command)(
          idAllocator.allocate.providerSession({
            providerInstanceId: input.modelSelection.instanceId,
            threadId: input.command.threadId,
          }),
        );
        restartProviderThread = {
          ...providerThread,
          providerInstanceId: input.modelSelection.instanceId,
          providerSessionId: nextProviderSessionId,
          status: "not_loaded",
          updatedAt: now,
        };
        restartSessionTransition = {
          type: "replace",
          replacementProviderSessionId: nextProviderSessionId,
        };
      }
      const resolvedRuntimePolicy = yield* runtimePolicy
        .resolve({ thread: input.projection.thread, modelSelection: input.modelSelection })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: input.command.commandId,
                commandType: input.command.type,
                cause,
              }),
          ),
        );
      const checkpointScope = yield* checkpointService
        .prepareRootRunScope({
          threadId: input.command.threadId,
          runId: targetRun.id,
          rootNodeId: nextRootNodeId,
          providerThreadId: restartProviderThread.id,
          cwd:
            resolvedRuntimePolicy.cwd ??
            input.projection.thread.worktreePath ??
            session.providerSession.cwd,
          createdAt: now,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: input.command.commandId,
                commandType: input.command.type,
                cause,
              }),
          ),
        );
      const ensuredCheckpointScope = yield* checkpointService.ensureScope(checkpointScope).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: input.command.commandId,
              commandType: input.command.type,
              cause,
            }),
        ),
      );
      const restartedRun: OrchestrationV2Run = {
        ...targetRun,
        providerInstanceId: input.modelSelection.instanceId,
        modelSelection: input.modelSelection,
        providerThreadId: restartProviderThread.id,
        rootNodeId: nextRootNodeId,
        activeAttemptId: nextAttemptId,
        userMessageId: input.messageId,
        status: "starting",
        contextHandoffId: restartHandoff?.id ?? targetRun.contextHandoffId,
      };
      const nextAttempt: OrchestrationV2RunAttempt = {
        id: nextAttemptId,
        runId: targetRun.id,
        attemptOrdinal,
        rootNodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        providerThreadId: restartProviderThread.id,
        providerTurnId: null,
        reason: "steering_restart",
        status: "pending",
        startedAt: null,
        completedAt: null,
      };
      const nextRootNode: OrchestrationV2ExecutionNode = {
        id: nextRootNodeId,
        threadId: input.command.threadId,
        runId: targetRun.id,
        parentNodeId: null,
        rootNodeId: nextRootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId: restartProviderThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: ensuredCheckpointScope.id,
        startedAt: null,
        completedAt: null,
      };
      if (currentAttempt !== undefined) {
        yield* emitEvent({
          type: "run-attempt.updated",
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: rootNodeId,
          providerInstanceId: targetRun.providerInstanceId,
          occurredAt: now,
          payload: { ...currentAttempt, status: "superseded", completedAt: now },
        });
      }
      if (currentRootNode !== undefined) {
        yield* emitEvent({
          type: "node.updated",
          threadId: input.command.threadId,
          runId: targetRun.id,
          nodeId: rootNodeId,
          providerInstanceId: targetRun.providerInstanceId,
          occurredAt: now,
          payload: { ...currentRootNode, status: "interrupted", completedAt: now },
        });
      }
      if (selectionChanged) {
        yield* emitEvent({
          type: providerInstanceChanged
            ? "thread.provider-switched"
            : "thread.model-selection-updated",
          threadId: input.command.threadId,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...input.projection.thread,
            providerInstanceId: input.modelSelection.instanceId,
            modelSelection: input.modelSelection,
            updatedAt: now,
          },
        });
      }
      if (requiresProviderThreadHandoff || requiresProviderSessionRestart) {
        yield* emitEvent({
          type: "provider-thread.updated",
          threadId: input.command.threadId,
          driver: restartProviderThread.driver,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: restartProviderThread,
        });
      }
      if (restartHandoff !== null) {
        yield* emitEvent({
          type: "context-handoff.updated",
          threadId: input.command.threadId,
          runId: targetRun.id,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: restartHandoff,
        });
      }
      if (restartTransfer !== null) {
        yield* emitEvent({
          type: "context-transfer.created",
          threadId: input.command.threadId,
          runId: targetRun.id,
          providerInstanceId: input.modelSelection.instanceId,
          occurredAt: now,
          payload: restartTransfer,
        });
      }
      yield* emitEvent({
        type: "run.updated",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: restartedRun,
      });
      yield* emitEvent({
        type: "run-attempt.created",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: nextAttempt,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: nextRootNode,
      });
      yield* emitEvent({
        type: "checkpoint-scope.created",
        threadId: input.command.threadId,
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerInstanceId: input.modelSelection.instanceId,
        occurredAt: now,
        payload: ensuredCheckpointScope,
      });
      // The restart replaces the run's input, so the wake it was running can no longer be
      // settled at its terminal. Its provider turn was running, so the wake already landed.
      yield* acceptDelegatedCompletionDelivery({
        command: input.command,
        events: input.events,
        projection: yield* projectionStore
          .getThreadRecords(input.command.threadId, ["runs", "messages", "subagents"], {
            messageIds: [targetRun.userMessageId],
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorProjectionError({ threadId: input.command.threadId, cause }),
            ),
          ),
        messageId: targetRun.userMessageId,
        now,
      });
      yield* appendSteeringMessage({
        runId: targetRun.id,
        nodeId: nextRootNodeId,
        providerTurnId: null,
        providerThreadId: restartProviderThread.id,
        providerInstanceId: input.modelSelection.instanceId,
        // Measured on the pre-restart projection, so the rewritten run is not its own baseline.
        ...(restartHandoff === null
          ? yield* modelSwitchFor(input.command.threadId, input.projection, input.modelSelection)
          : {}),
      });
      const interruptedAttemptId = targetRun.activeAttemptId;
      if (interruptedAttemptId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: input.command.commandId,
          commandType: input.command.type,
          cause: `Active run ${targetRun.id} has no attempt to interrupt.`,
        });
      }
      yield* Ref.update(input.effects, (existing) => [
        ...existing,
        {
          id: `effect:${input.command.commandId}:provider-turn.restart:${providerTurn.id}`,
          commandId: input.command.commandId,
          threadId: input.command.threadId,
          request: {
            type: "provider-turn.restart",
            providerSessionId,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            interruptedAttemptId,
            runId: targetRun.id,
            ...(restartSessionTransition === null
              ? {}
              : { sessionTransition: restartSessionTransition }),
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    });

  const updateAutomaticProviderRetry = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    run: OrchestrationV2Run,
    status: "started" | "cancelled",
  ) {
    if (run.automaticProviderRetry?.status !== "scheduled") return;
    const now = yield* DateTime.now;
    const automaticProviderRetry = { ...run.automaticProviderRetry, status, scheduledAt: null };
    const records = yield* projectionStore
      .getThreadRecords(run.threadId, ["turnItems"], {
        turnItemRunIds: [run.id],
        turnItemTypes: ["error"],
      })
      .pipe(mapDispatchError(command));
    yield* emit(
      events,
      command,
    )({
      type: "run.updated",
      threadId: run.threadId,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, automaticProviderRetry },
    });
    for (const item of records.turnItems) {
      if (item.type !== "error" || item.automaticProviderRetry?.status !== "scheduled") continue;
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: run.threadId,
        runId: run.id,
        ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
        occurredAt: now,
        payload: { ...item, automaticProviderRetry, updatedAt: now },
      });
    }
  });

  const dispatchMessage = (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      let projection = yield* getProjectionWithPendingEvents(command.threadId, events, command);
      if (command.declinedSteerTurnId !== undefined) {
        const turn = projection.providerTurns.find(
          (turn) =>
            turn.id === command.declinedSteerTurnId &&
            turn.status === "running" &&
            turn.steeringUnavailable === undefined,
        );
        if (turn !== undefined) {
          yield* emit(
            events,
            command,
          )({
            type: "provider-turn.updated",
            threadId: command.threadId,
            nodeId: turn.nodeId,
            occurredAt: yield* DateTime.now,
            payload: { ...turn, steeringUnavailable: true },
          });
        }
      }
      const scheduledProviderRetries = projection.runs.filter(
        (run) => run.automaticProviderRetry?.status === "scheduled",
      );
      const retrySource =
        command.providerRetryContinuationOfRunId === undefined
          ? undefined
          : projection.runs.find((run) => run.id === command.providerRetryContinuationOfRunId);
      const continuedProviderRetry =
        retrySource?.automaticProviderRetry === undefined
          ? {}
          : {
              providerRetryContinuationOfRunId: retrySource.id,
              automaticProviderRetry: {
                ...retrySource.automaticProviderRetry,
                status: "started" as const,
                scheduledAt: null,
              },
            };
      if (command.providerRetryContinuationOfRunId !== undefined) {
        const now = yield* DateTime.now;
        const retry = retrySource?.automaticProviderRetry;
        const providerStartRequested = projection.attempts.find(
          (attempt) => attempt.id === retrySource?.activeAttemptId,
        )?.providerStartRequested;
        const recoveredBeforeProviderStart =
          providerStartRequested !== true &&
          retrySource?.status === "cancelled" &&
          (retrySource.startedAt === null || providerStartRequested === false) &&
          !projection.providerTurns.some(
            (turn) => turn.runAttemptId === retrySource.activeAttemptId,
          ) &&
          retrySource.providerRetryContinuationOfRunId !== undefined;
        const ownsRetry = recoveredBeforeProviderStart
          ? !projection.runs.some(
              (run) =>
                run.id !== retrySource.id &&
                run.status !== "queued" &&
                runRanAfter(run, retrySource),
            )
          : latestExecutedRun(projection.runs)?.id === retrySource?.id;
        const providerThread = projection.providerThreads.find(
          (thread) => thread.id === retrySource?.providerThreadId,
        );
        if (
          (retrySource?.status !== "failed" && !recoveredBeforeProviderStart) ||
          retry?.status !== "scheduled" ||
          retry.scheduledAt === null ||
          Date.parse(retry.scheduledAt) > DateTime.toEpochMillis(now) ||
          !ownsRetry ||
          projection.thread.archivedAt !== null ||
          projection.thread.deletedAt !== null ||
          projection.thread.settledOverride === "settled" ||
          (projection.thread.snoozedUntil != null &&
            DateTime.isGreaterThan(projection.thread.snoozedUntil, now)) ||
          !modelSelectionsEqual(projection.thread.modelSelection, retrySource.modelSelection) ||
          !modelSelectionsEqual(
            command.modelSelection ?? projection.thread.modelSelection,
            retrySource.modelSelection,
          ) ||
          command.dispatchMode.type !== "start_immediately" ||
          projection.runtimeRequests.some((request) => request.status === "pending") ||
          providerThread?.nativeThreadRef?.strength !== "strong" ||
          providerThread.status === "error" ||
          providerThread.status === "closed" ||
          providerThread.status === "archived" ||
          (yield* stopReachedRun(command, command.threadId, retrySource.id))
        ) {
          if (retrySource !== undefined)
            yield* updateAutomaticProviderRetry(command, events, retrySource, "cancelled");
          yield* emit(
            events,
            command,
          )({
            type: "thread.metadata-updated",
            threadId: command.threadId,
            occurredAt: now,
            payload: projection.thread,
          });
          return;
        }
        yield* updateAutomaticProviderRetry(command, events, retrySource, "started");
      } else {
        // A manual prompt or another wake supersedes the scheduled continue.
        for (const run of scheduledProviderRetries) {
          yield* updateAutomaticProviderRetry(command, events, run, "cancelled");
        }
      }
      if (scheduledProviderRetries.length > 0) {
        projection = yield* getProjectionWithPendingEvents(command.threadId, events, command);
      }
      let promptRecoveryOfRunId: RunId | undefined;
      if (command.manualContinuationOfRunId !== undefined) {
        const source = projection.runs.find((run) => run.id === command.manualContinuationOfRunId);
        const limited = latestRootProviderFailure(source ?? null, projection.turnItems);
        if (
          command.dispatchMode.type !== "start_immediately" ||
          source === undefined ||
          (source.status !== "interrupted" &&
            !(source.status === "failed" && limited?.class === "usage_limit")) ||
          latestExecutedRun(projection.runs)?.id !== source.id ||
          projection.thread.archivedAt !== null ||
          projection.thread.deletedAt !== null ||
          projection.runtimeRequests.some((request) => request.status === "pending")
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "This thread can no longer be resumed from that run.",
          });
        }
        if (
          latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId)
            ?.promptDropped
        ) {
          const steered = projection.attempts.some(
            (attempt) =>
              attempt.id === source.activeAttemptId && attempt.reason === "steering_restart",
          );
          promptRecoveryOfRunId = steered ? source.id : (source.promptRecoveryOfRunId ?? source.id);
        }
      }
      if (command.usageLimitContinuationOfRunId !== undefined) {
        const run = usageLimitBlockedRun(projection.runs, projection.turnItems, null);
        const failure = latestRootProviderFailure(run, projection.turnItems);
        const recovery = projection.thread.limitRecovery;
        const now = yield* DateTime.now;
        if (
          run?.id !== command.usageLimitContinuationOfRunId ||
          failure?.class !== "usage_limit" ||
          threadShellFromProjection(projection).lastErrorClass !== "usage_limit" ||
          !recovery?.autoResume ||
          recovery.requestId !== command.usageLimitRecoveryRequestId ||
          recovery.runId !== run.id ||
          recovery.resetAt !== failure.resetAt ||
          Date.parse(recovery.resetAt) > DateTime.toEpochMillis(now) ||
          projection.thread.archivedAt !== null ||
          projection.thread.deletedAt !== null ||
          projection.thread.settledOverride === "settled" ||
          projection.thread.providerInstanceId !== run.providerInstanceId ||
          projection.runtimeRequests.some((request) => request.status === "pending") ||
          (projection.thread.snoozedUntil != null &&
            DateTime.toEpochMillis(projection.thread.snoozedUntil) > DateTime.toEpochMillis(now))
        ) {
          yield* emit(
            events,
            command,
          )({
            type: "thread.metadata-updated",
            threadId: command.threadId,
            occurredAt: now,
            payload: {
              ...projection.thread,
              ...(recovery?.autoResume &&
              recovery.requestId === command.usageLimitRecoveryRequestId &&
              recovery.runId === command.usageLimitContinuationOfRunId &&
              projection.thread.snoozedUntil != null &&
              DateTime.toEpochMillis(projection.thread.snoozedUntil) > DateTime.toEpochMillis(now)
                ? { limitRecovery: { ...recovery, requestId: command.commandId } }
                : {}),
            },
          });
          return;
        }
      }

      const accountMove =
        command.restartContinuationOfRunId === undefined
          ? undefined
          : yield* EffectOutbox.pendingAccountMove(
              effectOutbox,
              command.restartContinuationOfRunId,
            ).pipe(mapDispatchError(command));
      if (command.restartContinuationOfRunId !== undefined) {
        const source = projection.runs.find((run) => run.id === command.restartContinuationOfRunId);
        const latest = latestExecutedRun(projection.runs);
        const now = yield* DateTime.now;
        if (
          !source ||
          (accountMove === undefined
            ? !isRestartContinuationSource(source, projection.providerTurns)
            : source.status !== "interrupted" && source.status !== "cancelled") ||
          projection.thread.archivedAt !== null ||
          projection.thread.deletedAt !== null ||
          (accountMove === undefined &&
            (projection.thread.providerInstanceId !== source.providerInstanceId ||
              projection.thread.settledOverride === "settled" ||
              (projection.thread.snoozedUntil != null &&
                DateTime.isGreaterThan(projection.thread.snoozedUntil, now)))) ||
          (latest !== null && latest.id !== source.id && runRanAfter(latest, source)) ||
          (yield* stopReachedRun(command, command.threadId, source.id))
        ) {
          // Preserve the current row so stale automatic deliveries receive an
          // accepted receipt without changing work or repeatedly retrying.
          yield* emit(
            events,
            command,
          )({
            type: "thread.metadata-updated",
            threadId: command.threadId,
            occurredAt: now,
            payload: projection.thread,
          });
          return;
        }
      }

      // The thread lock orders selection commands and continuation admission.
      if (accountMove && command.notification) {
        const target = projection.thread.modelSelection;
        const name =
          target.instanceId === accountMove.modelSelection.instanceId
            ? accountMove.accountName
            : yield* accountMoves.displayName(target.instanceId);
        command = {
          ...command,
          modelSelection: target,
          notification: { ...command.notification, summary: `Continued on ${name}` },
        };
      }
      const continuedTaskId = projection.runs.find(
        (run) =>
          run.id ===
          (command.restartContinuationOfRunId ?? command.providerRetryContinuationOfRunId),
      )?.delegatedTaskId;

      if (projection.thread.settledOverride !== null) {
        const now = yield* DateTime.now;
        const thread: OrchestrationV2AppThread = {
          ...projection.thread,
          settledOverride: null,
          settledAt: null,
          unsettledAt:
            projection.thread.settledOverride === "active"
              ? (projection.thread.unsettledAt ?? null)
              : now,
          updatedAt: now,
        };
        const event = yield* emit(
          events,
          command,
        )({
          type: "thread.unsettled",
          threadId: command.threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: now,
          payload: thread,
        });
        projection = applyToProjection(projection, event);
      }
      if (projection.thread.snoozedUntil != null && command.scheduledTaskId === undefined) {
        const now = yield* DateTime.now;
        const thread: OrchestrationV2AppThread = {
          ...projection.thread,
          snoozedUntil: null,
          snoozedAt: null,
          updatedAt: now,
        };
        const event = yield* emit(
          events,
          command,
        )({
          type: "thread.unsnoozed",
          threadId: command.threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: now,
          payload: thread,
        });
        projection = applyToProjection(projection, event);
      }
      const userMessages = projection.messages.filter((message) => message.role === "user");
      const onlyMaintenanceHistory =
        userMessages.length > 0 && userMessages.every(isNativeMaintenanceCommand);
      if (
        !isNativeMaintenanceCommand(command) &&
        // A thread named before its first message (for example by an agent's launch) keeps that
        // name instead of a title generated from a terse prompt such as "work on this".
        ((command.titleSeed !== undefined &&
          !(yield* projectionStore.hasMessages(command.threadId).pipe(mapDispatchError(command))) &&
          !hasTitleSetBeforeFirstMessage(projection.thread, command.titleSeed)) ||
          (command.createdBy === "user" && onlyMaintenanceHistory))
      ) {
        const now = yield* DateTime.now;
        const thread: OrchestrationV2AppThread = {
          ...projection.thread,
          title: command.titleSeed ?? projection.thread.title,
          titleRegeneration: { requestId: command.commandId, startedAt: now },
          updatedAt: now,
        };
        const event = yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: command.threadId,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: now,
          payload: thread,
        });
        yield* Ref.update(effects, (existing) => [
          ...existing,
          pendingThreadTitleGenerationEffect(command.commandId, command.threadId, {
            type: "initial",
            messageId: command.messageId,
          }),
        ]);
        projection = applyToProjection(projection, event);
      }
      const modelSelection = command.modelSelection ?? projection.thread.modelSelection;
      if ((yield* ProjectAdmissionCommandId) === command.commandId) {
        yield* assertProviderInstanceEnabled(
          yield* serverSettings.getProviderPolicy.pipe(Effect.orDie),
          {
            projectId: projection.thread.projectId,
            instanceId: modelSelection.instanceId,
          },
        );
      }
      const cardAnswer =
        command.createdBy === "user" &&
        command.creationSource === "server" &&
        command.messageId.startsWith("async-answer:");
      const scheduledAuto =
        command.scheduledTaskId !== undefined && command.deliveryIntent === "auto";
      // These sends should steer when the active turn becomes available.
      const activeBeforeLive =
        scheduledAuto ||
        (cardAnswer && command.dispatchMode.type === "queue_after_active") ||
        (command.createdBy === "user" &&
          command.creationSource === "mobile" &&
          command.deliveryIntent === "auto")
          ? projection.runs.findLast(
              (run) =>
                run.status === "preparing" ||
                run.status === "starting" ||
                (run.status === "running" &&
                  !projection.providerTurns.some(
                    (turn) =>
                      turn.runAttemptId === run.activeAttemptId && turn.status === "running",
                  )),
            )
          : undefined;
      let dispatchMode = resolveMessageDispatchIntent(
        projection,
        command.dispatchMode,
        activeBeforeLive ? "steer" : command.deliveryIntent,
      );
      if (dispatchMode.type === "steer_active") {
        const targetRunId = dispatchMode.targetRunId;
        const target = projection.runs.find((run) => run.id === targetRunId);
        const turn = latestProviderTurnForAttempt(
          projection.providerTurns.filter((candidate) => candidate.nodeId === target?.rootNodeId),
          target?.activeAttemptId,
        );
        // The client may still show a running turn while its completion is being
        // projected. Preserve the submission as a new turn when steering is too late.
        if (
          target !== undefined &&
          (target.status === "completed" ||
            ((target.status === "running" || target.status === "waiting") &&
              turn !== undefined &&
              turn.status === "completed"))
        ) {
          dispatchMode = { type: "start_immediately" };
        }
      }
      if (
        (command.deliveryIntent === "auto" || cardAnswer) &&
        (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active") &&
        (yield* stopReachedRun(command, command.threadId, dispatchMode.targetRunId))
      ) {
        dispatchMode = { type: "queue_after_active" };
      }
      // Keep the send order for automatically queued agent messages (for example behind
      // /compact). The sender explicitly requested a separate turn for the other messages.
      if (
        command.deliveryIntent === "auto" &&
        command.createdBy === "agent" &&
        (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active")
      ) {
        const queuedRuns = projection.runs.filter(
          (run) => run.status === "queued" && run.queueHeld !== true && run.explicitQueue !== true,
        );
        if (queuedRuns.length > 0) {
          const { messages } = yield* projectionStore
            .getThreadRecords(command.threadId, ["messages"], {
              messageIds: queuedRuns.map((run) => run.userMessageId),
            })
            .pipe(mapDispatchError(command));
          if (messages.some((message) => message.createdBy === "agent")) {
            dispatchMode = { type: "queue_after_active" };
          }
        }
      }
      let steerWhenLiveRunId: OrchestrationV2Run["id"] | undefined;
      if (dispatchMode.type === "steer_active") {
        const targetRunId = dispatchMode.targetRunId;
        const target = projection.runs.find((run) => run.id === targetRunId);
        const runningTurn = projection.providerTurns.find(
          (turn) =>
            turn.nodeId === target?.rootNodeId &&
            turn.runAttemptId === target?.activeAttemptId &&
            turn.status === "running",
        );
        const providerThread = projection.providerThreads.find(
          (thread) => thread.id === target?.providerThreadId,
        );
        const session = projection.providerSessions.find(
          (session) => session.id === providerThread?.providerSessionId,
        );
        const targetMessage = projection.messages.find(
          (message) => message.id === target?.userMessageId,
        );
        // This also covers stale clients and explicit steer requests. Providers
        // without a steering strategy receive a durable, visibly queued follow-up.
        // Maintenance and goal commands keep the steer path's explicit rejection.
        if (
          target !== undefined &&
          !isNativeMaintenanceCommand(command) &&
          !isGoalCommand(command) &&
          (targetMessage === undefined || !isNativeMaintenanceCommand(targetMessage)) &&
          (target.status === "preparing" ||
            target.status === "starting" ||
            target.status === "waiting" ||
            (target.status === "running" && runningTurn === undefined) ||
            runningTurn?.steeringUnavailable !== undefined ||
            providerSteeringExecution(session) === null)
        ) {
          if (
            (scheduledAuto ||
              cardAnswer ||
              (command.createdBy === "user" &&
                (command.creationSource === "web" || command.creationSource === "mobile"))) &&
            (targetMessage === undefined || !isGoalCommand(targetMessage)) &&
            !projection.turnItems.some(
              (item) =>
                item.runId === target.id &&
                item.type === "compaction" &&
                (item.status === "pending" ||
                  item.status === "running" ||
                  item.status === "waiting"),
            ) &&
            (target.status === "preparing" ||
              target.status === "starting" ||
              (target.status === "running" && runningTurn === undefined)) &&
            (session === undefined || providerSteeringExecution(session) !== null)
          ) {
            steerWhenLiveRunId = target.id;
          }
          yield* validateSteerInput(command, command.text);
          dispatchMode = { type: "queue_after_active" };
        }
      }
      if (command.steerExistingOnly === true && dispatchMode.type !== "steer_active") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The notice's target run is no longer steerable.",
        });
      }
      // A restart continuation resumes the interrupted turn, so it starts
      // immediately rather than queueing like other wakes.
      if (
        command.notification !== undefined &&
        (command.createdBy !== "agent" ||
          (command.creationSource !== "server" && command.creationSource !== "provider") ||
          (dispatchMode.type !== "queue_after_active" &&
            !(
              (command.restartContinuationOfRunId !== undefined ||
                command.providerRetryContinuationOfRunId !== undefined) &&
              dispatchMode.type === "start_immediately"
            ) &&
            // A restart that cut workspace preparation prepares it again.
            !(
              command.restartContinuationOfRunId !== undefined &&
              dispatchMode.type === "defer_start"
            )))
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Notifications must be server- or provider-created queued messages.",
        });
      }
      let delegatedCompletion:
        | OrchestrationV2ConversationMessage["delegatedCompletion"]
        | undefined;
      if (command.delegatedCompletion !== undefined) {
        const requestedCompletion = command.delegatedCompletion;
        if (
          command.createdBy !== "agent" ||
          command.creationSource !== "server" ||
          dispatchMode.type !== "queue_after_active"
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Delegated completion delivery must be a server-created queued message.",
          });
        }
        const parentRun = projection.runs.find(
          (candidate) => candidate.id === requestedCompletion.parentRunId,
        );
        const delivery = parentRun?.delegatedCompletion?.delivery;
        if (
          parentRun?.delegatedCompletion?.disposition !== "open" ||
          delivery === null ||
          delivery === undefined ||
          delivery.generation !== requestedCompletion.generation ||
          delivery.messageId !== command.messageId ||
          (projection.messages.some((candidate) => candidate.id === command.messageId) &&
            !isUndeliveredMailboxSteer(projection, command.messageId))
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Delegated completion delivery is no longer dispatchable.",
          });
        }
        delegatedCompletion = {
          parentRunId: requestedCompletion.parentRunId,
          generation: delivery.generation,
          taskIds: delivery.taskIds,
        };
      }
      // Route durable mailbox deliveries under the thread lock, using the live
      // session's capabilities. Never interrupt/restart a turn for a notification.
      if (
        (command.notification?.source.kind === "monitor" && command.creationSource === "server") ||
        // A subagent's question: the parent keeps working while its subagents
        // run, so the question must reach it mid-turn, not after the turn ends.
        (command.notification?.source.kind === "delegated_task" &&
          command.creationSource === "server") ||
        (delegatedCompletion !== undefined &&
          delegatedCompletion.taskIds.every(
            (id) =>
              projection.subagents.find((task) => task.id === id)?.completionWake === "always",
          ))
      ) {
        const active = projection.runs.find((run) => run.status === "running");
        const providerThread = projection.providerThreads.find(
          (row) => row.id === active?.providerThreadId,
        );
        const activeTurn = projection.providerTurns.find(
          (turn) => turn.runAttemptId === active?.activeAttemptId && turn.status === "running",
        );
        const activeMessage = projection.messages.find(
          (message) => message.id === active?.userMessageId,
        );
        if (
          active !== undefined &&
          activeTurn !== undefined &&
          providerThread?.providerSessionId != null &&
          (activeMessage === undefined || !isNativeMaintenanceCommand(activeMessage))
        ) {
          const session = yield* providerSessions
            .get(providerThread.providerSessionId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (
            Option.isSome(session) &&
            session.value.providerSession.capabilities.turns.supportsActiveSteering &&
            session.value.providerSession.capabilities.turns.activeSteeringInterruptsTools !==
              true &&
            // A run Stop already reached is ending; the notice queues behind it instead.
            !(yield* stopReachedRun(command, command.threadId, active.id))
          ) {
            dispatchMode = { type: "steer_active", targetRunId: active.id };
          }
        }
      }
      const dispatchText =
        delegatedCompletion === undefined
          ? command.text
          : delegatedCompletionWakeDetail(
              delegatedCompletion.taskIds,
              projection.subagents,
              teamBoard?.completion,
            );
      const sourcePlanThread =
        command.sourcePlanRef === undefined
          ? null
          : command.sourcePlanRef.threadId === command.threadId
            ? projection.thread
            : (yield* getProjectionWithPendingEvents(
                command.sourcePlanRef.threadId,
                events,
                "thread",
              )).thread;
      // Command projections leave plans out, so read the source plan directly.
      const sourcePlanArtifact =
        command.sourcePlanRef === undefined
          ? undefined
          : yield* projectionStore
              .getPlan(command.sourcePlanRef.threadId, command.sourcePlanRef.planId)
              .pipe(mapDispatchError(command));
      const sourcePlan = sourcePlanArtifact?.kind === "proposed_plan" ? sourcePlanArtifact : null;
      if (command.sourcePlanRef !== undefined && sourcePlan === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Proposed plan ${command.sourcePlanRef.planId} does not exist on thread ${command.sourcePlanRef.threadId}.`,
        });
      }
      if (sourcePlanThread !== null && sourcePlanThread.projectId !== projection.thread.projectId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Proposed plan ${command.sourcePlanRef?.planId} belongs to a different project.`,
        });
      }
      if (sourcePlan !== null && sourcePlan.status !== "active") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Proposed plan ${sourcePlan.id} is not active.`,
        });
      }
      const completeSourcePlan = (occurredAt: DateTime.Utc) =>
        sourcePlan === null
          ? Effect.void
          : emit(
              events,
              command,
            )({
              type: "plan.updated",
              threadId: sourcePlan.threadId,
              ...(sourcePlan.runId === null ? {} : { runId: sourcePlan.runId }),
              nodeId: sourcePlan.nodeId,
              occurredAt,
              payload: { ...sourcePlan, status: "completed" },
            });

      if (dispatchMode.type === "steer_active" || dispatchMode.type === "restart_active") {
        yield* dispatchSteerIntoRun({
          command,
          events,
          effects,
          projection,
          modelSelection:
            delegatedCompletion === undefined && command.notification === undefined
              ? modelSelection
              : (projection.runs.find((run) => run.id === dispatchMode.targetRunId)
                  ?.modelSelection ?? modelSelection),
          delegatedCompletion,
          ...(command.notification === undefined ? {} : { notification: command.notification }),
          targetRunId: dispatchMode.targetRunId,
          messageId: command.messageId,
          text: dispatchText,
          ...(command.context ? { context: command.context } : {}),
          attachments: command.attachments,
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          ...(command.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: command.scheduledTaskId }),
          ...threadSendFields(command),
          forceRestart: dispatchMode.type === "restart_active",
        });
        return;
      }

      const activeProviderThread = projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      );
      const activeRun = projection.runs.find(isBlockingRun);
      // A message queued during worktree setup can arrive after that setup failed
      // without a worktree. It waits, held, like the messages queued before the
      // failure, instead of starting in the project checkout.
      const latestRun = latestExecutedRun(projection.runs);
      const worktreeMissingRun =
        activeRun === undefined &&
        dispatchMode.type === "queue_after_active" &&
        (latestRun?.status === "failed" || latestRun?.status === "interrupted") &&
        latestRun.workspacePreparation?.type === "worktree" &&
        projection.thread.worktreePath === null
          ? latestRun
          : undefined;
      const movingRun =
        activeRun === undefined &&
        command.restartContinuationOfRunId === undefined &&
        latestRun !== null &&
        (latestRun.status === "interrupted" ||
          latestRun.providerInstanceId !== projection.thread.providerInstanceId) &&
        (yield* EffectOutbox.accountMoveHoldsQueue(effectOutbox, latestRun).pipe(
          mapDispatchError(command),
        ))
          ? latestRun
          : undefined;
      const queueBehindRun = activeRun ?? movingRun ?? worktreeMissingRun;
      const pendingMergeBackTransfers = pendingMergeBackTransfersForThread(projection);
      const startsOrQueuesRun =
        dispatchMode.type === "defer_start" ||
        dispatchMode.type === "start_immediately" ||
        dispatchMode.type === "queue_after_active";
      const shouldQueue = queueBehindRun !== undefined && startsOrQueuesRun;
      // A message the user sends from a client means they are back, so the
      // queue a stop or a restart held runs again, in its order, rather than
      // waiting for a Resume.
      // Continuations and scheduled tasks the server sends for them are not
      // them coming back. Starting the queue still re-holds it for a failed
      // provider or a usage limit; a queue held after worktree setup failed
      // keeps its hold until a worktree exists, even once later messages have
      // run, since its messages would start in the project checkout.
      const worktreeSetupUnresolved =
        projection.thread.worktreePath === null &&
        projection.runs.some(
          (run) =>
            (run.status === "failed" || run.status === "interrupted") &&
            run.workspacePreparation?.type === "worktree",
        );
      const sentByUserFromClient =
        command.createdBy === "user" &&
        (command.creationSource === "web" || command.creationSource === "mobile") &&
        command.declinedSteerTurnId === undefined &&
        command.scheduledTaskId === undefined;
      const heldRunsToRelease =
        (sentByUserFromClient || retrySource !== undefined) &&
        startsOrQueuesRun &&
        !worktreeSetupUnresolved
          ? projection.runs.filter((run) => run.status === "queued" && run.queueHeld === true)
          : [];
      const releasedAt = yield* DateTime.now;
      for (const held of heldRunsToRelease) {
        yield* emit(
          events,
          command,
        )({
          type: "run.updated",
          threadId: command.threadId,
          runId: held.id,
          providerInstanceId: held.providerInstanceId,
          occurredAt: releasedAt,
          payload: { ...held, queueHeld: false },
        });
      }
      if (shouldQueue) {
        if (pendingMergeBackTransfers.length > 0) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Thread ${command.threadId} has a pending merge-back transfer; queued merge-back consumption is not implemented yet.`,
          });
        }
        const queueProviderThread =
          activeProviderThread ??
          projection.providerThreads.find(
            (candidate) => candidate.id === queueBehindRun.providerThreadId,
          );
        if (queueProviderThread === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Active run ${queueBehindRun.id} has no provider thread for queued dispatch.`,
          });
        }
        const now = yield* DateTime.now;
        const ordinal = nextRunOrdinal(projection);
        const runId = idAllocator.derive.run({ threadId: command.threadId, ordinal });
        const targetProviderThread =
          modelSelection.instanceId === queueProviderThread.providerInstanceId
            ? queueProviderThread
            : rootProviderThreadsForProvider(projection, modelSelection.instanceId)[0];
        const queuedAdapter = yield* providerAdapters
          .get(modelSelection.instanceId)
          .pipe(mapDispatchError(command));
        const selectedProviderSession =
          targetProviderThread?.providerSessionId === null ||
          targetProviderThread?.providerSessionId === undefined
            ? undefined
            : projection.providerSessions.find(
                (candidate) => candidate.id === targetProviderThread.providerSessionId,
              );
        const queuedCapabilities =
          selectedProviderSession?.capabilities ??
          (yield* queuedAdapter.getCapabilities().pipe(mapDispatchError(command)));
        yield* enforceCommandPolicy(command)(
          commandPolicy.ensureQueuedMessages({
            commandId: command.commandId,
            threadId: command.threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities: queuedCapabilities,
          }),
        );
        const queuedProviderThread: OrchestrationV2ProviderThread = targetProviderThread ?? {
          id: idAllocator.derive.providerThread({
            driver: queuedAdapter.driver,
            nativeThreadId: `pending:${runId}`,
          }),
          driver: queuedAdapter.driver,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId: null,
          appThreadId: command.threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "not_loaded",
          firstRunOrdinal: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        const checkpointScope =
          queueBehindRun.status === "preparing" || worktreeMissingRun !== undefined
            ? null
            : yield* runtimePolicy.resolve({ thread: projection.thread, modelSelection }).pipe(
                Effect.flatMap((resolvedRuntimePolicy) =>
                  checkpointService.prepareRootRunScope({
                    threadId: command.threadId,
                    runId,
                    rootNodeId,
                    providerThreadId: queuedProviderThread.id,
                    cwd:
                      resolvedRuntimePolicy.cwd ??
                      selectedProviderSession?.cwd ??
                      projection.thread.worktreePath ??
                      process.cwd(),
                    createdAt: now,
                  }),
                ),
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause,
                    }),
                ),
              );
        const run: OrchestrationV2Run = {
          id: runId,
          threadId: command.threadId,
          ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: queuedProviderThread.id,
          userMessageId: command.messageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "queued",
          ...(command.explicitQueue === true ? { explicitQueue: true as const } : {}),
          ...(steerWhenLiveRunId === undefined ? {} : { steerWhenLiveRunId }),
          ...(worktreeMissingRun !== undefined ||
          (heldRunsToRelease.length === 0 &&
            projection.runs.some(
              (candidate) => candidate.status === "queued" && candidate.queueHeld === true,
            ))
            ? { queueHeld: true }
            : {}),
          queuePosition:
            Math.max(
              0,
              ...projection.runs
                .filter((candidate) => candidate.status === "queued")
                .map((candidate) => candidate.queuePosition ?? candidate.ordinal),
            ) + 1,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
          ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
          ...continuedProviderRetry,
          ...(promptRecoveryOfRunId === undefined ? {} : { promptRecoveryOfRunId }),
          ...(accountMove ? { accountMoveContinuation: true as const } : {}),
          ...(command.restartContinuationOfRunId === undefined
            ? {}
            : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
          ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
        };
        const attempt: OrchestrationV2RunAttempt = {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: queuedProviderThread.id,
          providerTurnId: null,
          reason: "initial",
          status: "pending",
          startedAt: null,
          completedAt: null,
        };
        const rootNode: OrchestrationV2ExecutionNode = {
          id: rootNodeId,
          threadId: command.threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: queuedProviderThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: checkpointScope?.id ?? null,
          startedAt: null,
          completedAt: null,
        };
        const message: OrchestrationV2ConversationMessage = {
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          ...(command.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: command.scheduledTaskId }),
          ...threadSendFields(command),
          id: command.messageId,
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: dispatchText,
          ...(command.context ? { context: command.context } : {}),
          attachments: command.attachments,
          streaming: false,
          createdAt: now,
          updatedAt: now,
          ...(delegatedCompletion === undefined ? {} : { delegatedCompletion }),
          ...(command.notification === undefined ? {} : { notification: command.notification }),
        };
        const emitEvent = emit(events, command);
        if (targetProviderThread === undefined) {
          yield* emitEvent({
            type: "provider-thread.updated",
            threadId: command.threadId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: queuedProviderThread,
          });
        }
        yield* emitEvent({
          type: "run.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: run,
        });
        yield* completeSourcePlan(now);
        yield* emitEvent({
          type: "run-attempt.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: attempt,
        });
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: rootNode,
        });
        if (checkpointScope !== null) {
          yield* emitEvent({
            type: "checkpoint-scope.created",
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: yield* checkpointService.ensureScope(checkpointScope).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            ),
          });
        }
        yield* emitEvent({
          type: "message.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: message,
        });
        const existingItem = projection.turnItems.find(
          (item) => item.type === "user_message" && item.messageId === command.messageId,
        );
        if (existingItem?.type === "user_message") {
          yield* emitEvent({
            type: "turn-item.updated",
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              ...existingItem,
              runId,
              nodeId: rootNodeId,
              providerThreadId: queuedProviderThread.id,
              providerTurnId: null,
              inputIntent: "queued_turn",
              status: "pending",
              startedAt: null,
              completedAt: null,
              updatedAt: now,
            },
          });
        }
        return;
      }
      const pendingForkTransfer = pendingForkTransferForThread(projection);
      const pendingMergeBackSourceThreadIds = new Set(
        pendingMergeBackTransfers.map((transfer) => transfer.sourceThreadId),
      );
      if (pendingMergeBackSourceThreadIds.size > 1) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} has pending merge-back transfers from multiple forks.`,
        });
      }
      const pendingMergeBackTransfer = latestContextTransfer(pendingMergeBackTransfers);
      const supersededMergeBackTransfers = pendingMergeBackTransfers.filter(
        (transfer) => transfer.id !== pendingMergeBackTransfer?.id,
      );
      const now = yield* DateTime.now;
      if (
        accountMove === undefined &&
        (!modelSelectionsEqual(projection.thread.modelSelection, modelSelection) ||
          projection.thread.providerInstanceId !== modelSelection.instanceId)
      ) {
        yield* emit(
          events,
          command,
        )({
          type:
            projection.thread.providerInstanceId === modelSelection.instanceId
              ? "thread.model-selection-updated"
              : "thread.provider-switched",
          threadId: command.threadId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...projection.thread,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            updatedAt: now,
          },
        });
      }
      const ordinal = nextRunOrdinal(projection);
      const runId = idAllocator.derive.run({ threadId: command.threadId, ordinal });
      const latestCompletedRun = projection.runs.findLast((run) => run.status === "completed");
      const latestHandoffRun = projection.runs.findLast(isHandoffSourceRun);
      const legacyImportItems =
        projection.thread.historyOrigin === "v1_import" &&
        (latestCompletedRun === undefined ||
          (activeProviderThread !== undefined &&
            activeProviderThread.providerInstanceId !== modelSelection.instanceId))
          ? yield* readHandoffItems(command.threadId, [null])
          : [];
      const isProviderSwitch =
        activeProviderThread !== undefined &&
        activeProviderThread.providerInstanceId !== modelSelection.instanceId;
      // Account overlays share native history. Selection commands may already
      // have updated the app thread, so classify against the native thread's owner.
      const canResumeAcrossInstances =
        isProviderSwitch &&
        activeProviderThread.nativeThreadRef?.nativeId != null &&
        (yield* providerSwitchService
          .plan({
            projection,
            currentInstanceId: activeProviderThread.providerInstanceId,
            targetModelSelection: modelSelection,
          })
          .pipe(mapDispatchError(command))).transition.type === "restart_and_resume";

      const emitPreparation = (
        driver: OrchestrationV2ProviderThread["driver"],
        userItem: OrchestrationV2TurnItem,
      ) =>
        emit(
          events,
          command,
        )({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId,
          ...(userItem.nodeId === null ? {} : { nodeId: userItem.nodeId }),
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: workspacePreparationItem(
            userItem,
            idAllocator.derive.turnItemFromProviderItem({
              driver,
              nativeItemId: `workspace-preparation:${runId}`,
            }),
            now,
          ),
        });

      if (
        pendingForkTransfer === undefined &&
        pendingMergeBackTransfer === undefined &&
        !isProviderSwitch
      ) {
        const adapter = yield* providerAdapters.get(modelSelection.instanceId).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProviderAdapterError({
                commandId: command.commandId,
                providerInstanceId: modelSelection.instanceId,
                cause,
              }),
          ),
        );
        const providerSessionId =
          activeProviderThread?.providerSessionId ??
          (yield* mapDispatchError(command)(
            providerSessionIdFor({
              adapter,
              providerInstanceId: modelSelection.instanceId,
              threadId: command.threadId,
            }),
          ));
        const providerThreadId =
          activeProviderThread?.id ??
          idAllocator.derive.providerThread({
            driver: adapter.driver,
            nativeThreadId: `pending:${runId}`,
          });
        const legacyImportHandoff = shouldPrepareLegacyImportHandoff({
          hasNativeHistory:
            activeProviderThread?.driver === "acpRegistry" &&
            activeProviderThread.nativeThreadRef !== null,
          historyOrigin: projection.thread.historyOrigin,
          hasCompletedRun: latestCompletedRun !== undefined,
          legacyImportItemCount: legacyImportItems.length,
        })
          ? yield* contextHandoffService
              .prepareLegacyImport({
                threadId: command.threadId,
                targetRunId: runId,
                toProviderThreadId: providerThreadId,
                toProviderInstanceId: modelSelection.instanceId,
                items: legacyImportItems,
                createdAt: now,
              })
              .pipe(mapDispatchError(command))
          : null;
        const providerThread: OrchestrationV2ProviderThread =
          activeProviderThread === undefined
            ? {
                id: providerThreadId,
                driver: adapter.driver,
                providerInstanceId: modelSelection.instanceId,
                providerSessionId,
                appThreadId: command.threadId,
                ownerNodeId: null,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                status: "not_loaded",
                firstRunOrdinal: ordinal,
                lastRunOrdinal: ordinal,
                handoffIds: legacyImportHandoff === null ? [] : [legacyImportHandoff.id],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }
            : {
                ...activeProviderThread,
                providerSessionId,
                lastRunOrdinal: ordinal,
                handoffIds: appendContextHandoffId(
                  activeProviderThread.handoffIds,
                  legacyImportHandoff?.id ?? null,
                ),
                updatedAt: now,
              };
        const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
        const rootNodeId = idAllocator.derive.rootNode({ runId });
        const checkpointScope =
          dispatchMode.type === "defer_start"
            ? null
            : yield* runtimePolicy
                .resolve({
                  thread: projection.thread,
                  modelSelection,
                })
                .pipe(
                  mapDispatchError(command),
                  Effect.flatMap((resolvedRuntimePolicy) =>
                    checkpointService.prepareRootRunScope({
                      threadId: command.threadId,
                      runId,
                      rootNodeId,
                      providerThreadId,
                      cwd:
                        resolvedRuntimePolicy.cwd ??
                        projection.thread.worktreePath ??
                        process.cwd(),
                      createdAt: now,
                    }),
                  ),
                  mapDispatchError(command),
                );
        const run: OrchestrationV2Run = {
          id: runId,
          threadId: command.threadId,
          ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: command.messageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: dispatchMode.type === "defer_start" ? "preparing" : "starting",
          queuePosition: null,
          requestedAt: now,
          startedAt: null,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: legacyImportHandoff?.id ?? null,
          ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
          ...continuedProviderRetry,
          ...(promptRecoveryOfRunId === undefined ? {} : { promptRecoveryOfRunId }),
          ...(accountMove ? { accountMoveContinuation: true as const } : {}),
          ...(command.restartContinuationOfRunId === undefined
            ? {}
            : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
          ...(dispatchMode.type === "defer_start" && dispatchMode.workspaceStrategy !== undefined
            ? { workspacePreparation: dispatchMode.workspaceStrategy }
            : {}),
          ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
          ...wakeWorkStartedAt(projection.runs, command),
        };
        const attempt: OrchestrationV2RunAttempt = {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId,
          providerTurnId: null,
          reason: "initial",
          status: "pending",
          startedAt: null,
          completedAt: null,
        };
        const rootNode: OrchestrationV2ExecutionNode = {
          id: rootNodeId,
          threadId: command.threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: checkpointScope?.id ?? null,
          startedAt: null,
          completedAt: null,
        };
        const message: OrchestrationV2ConversationMessage = {
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          ...(command.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: command.scheduledTaskId }),
          ...threadSendFields(command),
          id: command.messageId,
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: dispatchText,
          ...(command.context ? { context: command.context } : {}),
          attachments: command.attachments,
          streaming: false,
          createdAt: now,
          updatedAt: now,
          ...(delegatedCompletion === undefined ? {} : { delegatedCompletion }),
          ...(command.notification === undefined ? {} : { notification: command.notification }),
        };
        const turnItem: OrchestrationV2TurnItem = {
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          ...(command.scheduledTaskId === undefined
            ? {}
            : { scheduledTaskId: command.scheduledTaskId }),
          ...threadSendFields(command),
          id: idAllocator.derive.userTurnItem({ messageId: command.messageId }),
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: yield* nextTurnItemOrdinal(projection),
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: command.messageId,
          inputIntent: "turn_start",
          text: dispatchText,
          ...(command.context ? { context: command.context } : {}),
          attachments: command.attachments,
          ...(run.contextHandoffId === null
            ? yield* modelSwitchFor(command.threadId, projection, modelSelection)
            : {}),
        };
        const emitEvent = emit(events, command);
        yield* emitEvent({
          type: "provider-thread.updated",
          threadId: command.threadId,
          driver: adapter.driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: providerThread,
        });
        if (legacyImportHandoff !== null) {
          yield* emitEvent({
            type: "context-handoff.updated",
            threadId: command.threadId,
            runId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: legacyImportHandoff,
          });
        }
        yield* emitEvent({
          type: "run.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: run,
        });
        yield* completeSourcePlan(now);
        yield* emitEvent({
          type: "run-attempt.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: attempt,
        });
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: rootNode,
        });
        if (checkpointScope !== null) {
          yield* emitEvent({
            type: "checkpoint-scope.created",
            threadId: command.threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: checkpointScope,
          });
        }
        yield* emitEvent({
          type: "message.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: message,
        });
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: notificationTurnItem(turnItem, message, projection.subagents),
        });
        if (dispatchMode.type === "defer_start") yield* emitPreparation(adapter.driver, turnItem);
        const pendingEffect = {
          id: `effect:${command.commandId}:provider-turn.start:${runId}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "provider-turn.start", runId },
        } satisfies PendingOrchestrationEffectV2;
        if (dispatchMode.type !== "defer_start") {
          yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
        }
        return;
      }
      const sourceProjection =
        pendingForkTransfer === undefined
          ? null
          : yield* projectionStore
              .getThreadRecords(pendingForkTransfer.sourceThreadId, [
                "runs",
                "attempts",
                "providerThreads",
                "providerTurns",
              ])
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorProjectionError({
                      threadId: pendingForkTransfer.sourceThreadId,
                      cause,
                    }),
                ),
              );
      const sourceRun =
        pendingForkTransfer?.sourcePoint.runId === undefined || sourceProjection === null
          ? null
          : (sourceProjection.runs.find(
              (candidate) => candidate.id === pendingForkTransfer.sourcePoint.runId,
            ) ?? null);
      const sourceProviderThread =
        sourceProjection === null || sourceRun === null
          ? undefined
          : providerThreadForRun(sourceProjection, sourceRun);
      const sourceProviderTurnId =
        sourceProjection === null || sourceRun === null || sourceRun.activeAttemptId === null
          ? undefined
          : (latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceRun.activeAttemptId)
              ?.id ??
            sourceProjection.attempts.find(
              (candidate) => candidate.id === sourceRun.activeAttemptId,
            )?.providerTurnId ??
            undefined);
      if (pendingForkTransfer !== undefined) {
        if (sourceRun === null || sourceProviderThread === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Pending fork transfer ${pendingForkTransfer.id} has no resolvable source provider thread.`,
          });
        }
        if (pendingForkTransfer.sourceProviderInstanceId === null) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Pending fork transfer ${pendingForkTransfer.id} has no source provider.`,
          });
        }
      }

      const adapter = yield* providerAdapters.get(modelSelection.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: modelSelection.instanceId,
              cause,
            }),
        ),
      );
      const targetProviderThread =
        isProviderSwitch && !canResumeAcrossInstances
          ? rootProviderThreadsForProvider(projection, modelSelection.instanceId)[0]
          : activeProviderThread;
      const providerSessionId =
        (canResumeAcrossInstances ? undefined : targetProviderThread?.providerSessionId) ??
        (yield* mapDispatchError(command)(
          providerSessionIdFor({
            adapter,
            providerInstanceId: modelSelection.instanceId,
            threadId: command.threadId,
          }),
        ));
      const existingProviderSession = projection.providerSessions.find(
        (candidate) => candidate.id === providerSessionId,
      );
      const resolvedRuntimePolicy = yield* runtimePolicy
        .resolve({ thread: projection.thread, modelSelection })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        );

      const capabilities = yield* adapter.getCapabilities().pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: modelSelection.instanceId,
              cause,
            }),
        ),
      );
      const forkExecution =
        pendingForkTransfer === undefined || sourceRun === null
          ? null
          : yield* enforceCommandPolicy(command)(
              commandPolicy.decideForkExecution({
                commandId: command.commandId,
                threadId: command.threadId,
                providerInstanceId: modelSelection.instanceId,
                capabilities,
                sameProvider:
                  pendingForkTransfer.sourceProviderInstanceId === modelSelection.instanceId,
                hasStrongNativeSource: sourceProviderThread?.nativeThreadRef?.strength === "strong",
                sourceRunStatus: sourceRun.status,
                fromSpecificTurn: sourceRun !== null,
              }),
            );
      const canResolveForkNatively = forkExecution === "native_fork";
      const requiresPortableFork = forkExecution === "portable_context";

      if (canResolveForkNatively) {
        yield* enforceCommandPolicy(command)(
          commandPolicy.ensureNativeFork({
            commandId: command.commandId,
            threadId: command.threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities,
            fromSpecificTurn: sourceRun !== null,
          }),
        );
      }

      const ensuredProviderThread: OrchestrationV2ProviderThread =
        targetProviderThread === undefined
          ? {
              id: idAllocator.derive.providerThread({
                driver: adapter.driver,
                nativeThreadId: `pending:${runId}`,
              }),
              driver: adapter.driver,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId,
              appThreadId: command.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "not_loaded",
              firstRunOrdinal: ordinal,
              lastRunOrdinal: ordinal,
              handoffIds: [],
              forkedFrom:
                canResolveForkNatively && sourceProviderThread !== undefined
                  ? {
                      providerThreadId: sourceProviderThread.id,
                      ...(sourceProviderTurnId === undefined
                        ? {}
                        : { providerTurnId: sourceProviderTurnId }),
                    }
                  : null,
              createdAt: now,
              updatedAt: now,
            }
          : {
              ...targetProviderThread,
              providerInstanceId: modelSelection.instanceId,
              providerSessionId,
              updatedAt: now,
            };
      const portableForkItems =
        !requiresPortableFork || sourceProjection === null || sourceRun === null
          ? []
          : yield* readHandoffItems(sourceProjection.thread.id, [
              ...sourceProjection.runs
                .filter(
                  (run) =>
                    run.ordinal <= sourceRun.ordinal &&
                    (run.id === sourceRun.id || isHandoffSourceRun(run)),
                )
                .map((run) => run.id),
              ...(sourceProjection.thread.historyOrigin === "v1_import" ? [null] : []),
            ]);
      const portableForkHandoff =
        !requiresPortableFork ||
        pendingForkTransfer === undefined ||
        sourceProjection === null ||
        sourceRun === null
          ? null
          : yield* contextHandoffService
              .prepareProviderHandoff({
                threadId: command.threadId,
                targetRunId: runId,
                transferId: pendingForkTransfer.id,
                fromProviderThreadIds:
                  sourceProviderThread === undefined ? [] : [sourceProviderThread.id],
                toProviderThreadId: ensuredProviderThread.id,
                fromProviderInstanceId: sourceRun.providerInstanceId,
                toProviderInstanceId: modelSelection.instanceId,
                coveredRunOrdinals: visibleDeltaRunOrdinals(sourceProjection, portableForkItems),
                strategy: "full_thread_summary",
                items: portableForkItems,
                runs: sourceProjection.runs,
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause,
                    }),
                ),
              );
      const requiresFullProviderSwitchContext =
        isProviderSwitch && pendingMergeBackTransfer !== undefined;
      const targetLastCompletedRun =
        targetProviderThread === undefined
          ? undefined
          : lastDeliveredRunForProviderThread(projection, targetProviderThread.id);
      const providerSwitchCoveredRuns =
        !isProviderSwitch || canResumeAcrossInstances || latestHandoffRun === undefined
          ? []
          : projection.runs.filter(
              (run) =>
                isHandoffSourceRun(run) &&
                run.ordinal >
                  (requiresFullProviderSwitchContext
                    ? 0
                    : (targetLastCompletedRun?.ordinal ?? 0)) &&
                run.ordinal <= latestHandoffRun.ordinal,
            );
      const providerSwitchItems =
        providerSwitchCoveredRuns.length === 0
          ? []
          : [
              ...(latestCompletedRun !== undefined &&
              (targetProviderThread === undefined || requiresFullProviderSwitchContext)
                ? legacyImportItems
                : []),
              ...(yield* readHandoffItems(
                command.threadId,
                providerSwitchCoveredRuns.map((run) => run.id),
              )),
            ];
      const providerSwitchTransferId =
        providerSwitchCoveredRuns.length === 0 || latestHandoffRun === undefined
          ? null
          : yield* mapDispatchError(command)(
              idAllocator.allocate.contextTransfer({
                sourceThreadId: command.threadId,
                targetThreadId: command.threadId,
                type: "provider_handoff",
              }),
            );
      if (providerSwitchTransferId !== null) {
        yield* enforceCommandPolicy(command)(
          commandPolicy.ensureContextHandoff({
            commandId: command.commandId,
            threadId: command.threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities,
            strategy:
              targetProviderThread === undefined || requiresFullProviderSwitchContext
                ? "full_thread_summary"
                : "delta_context",
          }),
        );
      }
      const providerSwitchHandoff =
        providerSwitchTransferId === null || latestHandoffRun === undefined
          ? null
          : yield* contextHandoffService
              .prepareProviderHandoff({
                threadId: command.threadId,
                targetRunId: runId,
                transferId: providerSwitchTransferId,
                fromProviderThreadIds: Array.from(
                  new Set(
                    providerSwitchCoveredRuns.flatMap((run) =>
                      run.providerThreadId === null ? [] : [run.providerThreadId],
                    ),
                  ),
                ),
                toProviderThreadId: ensuredProviderThread.id,
                fromProviderInstanceId: latestHandoffRun.providerInstanceId,
                toProviderInstanceId: modelSelection.instanceId,
                coveredRunOrdinals: {
                  from: providerSwitchCoveredRuns[0]!.ordinal,
                  to: providerSwitchCoveredRuns.at(-1)!.ordinal,
                },
                strategy:
                  targetProviderThread === undefined || requiresFullProviderSwitchContext
                    ? "full_thread_summary"
                    : "delta_since_target_last_seen",
                items: providerSwitchItems,
                runs: projection.runs,
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause,
                    }),
                ),
              );
      const legacyImportRecoveryHandoff =
        isProviderSwitch &&
        !canResumeAcrossInstances &&
        latestCompletedRun === undefined &&
        legacyImportItems.length > 0
          ? yield* contextHandoffService
              .prepareLegacyImport({
                threadId: command.threadId,
                targetRunId: runId,
                toProviderThreadId: ensuredProviderThread.id,
                toProviderInstanceId: modelSelection.instanceId,
                items: legacyImportItems,
                createdAt: now,
              })
              .pipe(mapDispatchError(command))
          : null;
      const providerThread: OrchestrationV2ProviderThread = {
        ...ensuredProviderThread,
        status: "active",
        firstRunOrdinal: ensuredProviderThread.firstRunOrdinal ?? ordinal,
        lastRunOrdinal: ordinal,
        handoffIds: [
          ...ensuredProviderThread.handoffIds,
          ...[portableForkHandoff, providerSwitchHandoff, legacyImportRecoveryHandoff].flatMap(
            (handoff) => (handoff === null ? [] : [handoff.id]),
          ),
        ],
        updatedAt: now,
      };

      const attemptId = idAllocator.derive.runAttempt({ runId, attemptOrdinal: 1 });
      const rootNodeId = idAllocator.derive.rootNode({ runId });
      const emitEvent = emit(events, command);
      const mergeBackSourceProjection =
        pendingMergeBackTransfer === undefined
          ? null
          : yield* projectionStore
              .getThreadRecords(pendingMergeBackTransfer.sourceThreadId, [
                "runs",
                "attempts",
                "providerThreads",
                "providerTurns",
              ])
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorProjectionError({
                      threadId: pendingMergeBackTransfer.sourceThreadId,
                      cause,
                    }),
                ),
              );
      const mergeBackSourceRun =
        pendingMergeBackTransfer?.sourcePoint.runId === undefined ||
        mergeBackSourceProjection === null
          ? null
          : (mergeBackSourceProjection.runs.find(
              (candidate) => candidate.id === pendingMergeBackTransfer.sourcePoint.runId,
            ) ?? null);
      if (pendingMergeBackTransfer !== undefined && mergeBackSourceRun === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Pending merge-back transfer ${pendingMergeBackTransfer.id} has no resolvable source run.`,
        });
      }
      const mergeBackSourceProviderThread =
        mergeBackSourceProjection === null || mergeBackSourceRun === null
          ? undefined
          : providerThreadForRun(mergeBackSourceProjection, mergeBackSourceRun);
      if (pendingMergeBackTransfer !== undefined && mergeBackSourceProviderThread === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Pending merge-back transfer ${pendingMergeBackTransfer.id} has no resolvable source provider thread.`,
        });
      }
      if (pendingMergeBackTransfer !== undefined) {
        yield* enforceCommandPolicy(command)(
          commandPolicy.ensureContextHandoff({
            commandId: command.commandId,
            threadId: command.threadId,
            providerInstanceId: modelSelection.instanceId,
            capabilities,
            strategy: "fork_delta_context",
          }),
        );
      }
      const mergeBackDeltaItems =
        mergeBackSourceProjection === null || mergeBackSourceRun === null
          ? []
          : yield* readHandoffItems(
              mergeBackSourceProjection.thread.id,
              mergeBackSourceProjection.runs
                .filter(
                  (run) =>
                    run.ordinal <= mergeBackSourceRun.ordinal &&
                    (run.id === mergeBackSourceRun.id || isHandoffSourceRun(run)),
                )
                .map((run) => run.id),
            );
      const mergeBackHandoff =
        pendingMergeBackTransfer === undefined ||
        mergeBackSourceProjection === null ||
        mergeBackSourceRun === null ||
        mergeBackSourceProviderThread === undefined
          ? null
          : yield* contextHandoffService
              .prepareForkDelta({
                sourceThreadId: pendingMergeBackTransfer.sourceThreadId,
                targetThreadId: command.threadId,
                targetRunId: runId,
                transferId: pendingMergeBackTransfer.id,
                fromProviderThreadIds: [mergeBackSourceProviderThread.id],
                toProviderThreadId: providerThread.id,
                fromProviderInstanceId: mergeBackSourceRun.providerInstanceId,
                toProviderInstanceId: modelSelection.instanceId,
                coveredRunOrdinals: visibleDeltaRunOrdinals(
                  mergeBackSourceProjection,
                  mergeBackDeltaItems,
                ),
                deltaItems: mergeBackDeltaItems,
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause,
                    }),
                ),
              );
      const checkpointScope =
        dispatchMode.type === "defer_start"
          ? null
          : yield* checkpointService
              .prepareRootRunScope({
                threadId: command.threadId,
                runId,
                rootNodeId,
                providerThreadId: providerThread.id,
                cwd:
                  resolvedRuntimePolicy.cwd ??
                  existingProviderSession?.cwd ??
                  projection.thread.worktreePath ??
                  process.cwd(),
                createdAt: now,
              })
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new OrchestratorDispatchError({
                      commandId: command.commandId,
                      commandType: command.type,
                      cause,
                    }),
                ),
              );
      const run: OrchestrationV2Run = {
        id: runId,
        threadId: command.threadId,
        ordinal,
        providerInstanceId: modelSelection.instanceId,
        modelSelection,
        providerThreadId: providerThread.id,
        userMessageId: command.messageId,
        rootNodeId,
        activeAttemptId: attemptId,
        status: dispatchMode.type === "defer_start" ? "preparing" : "starting",
        ...(dispatchMode.type === "defer_start" && dispatchMode.workspaceStrategy !== undefined
          ? { workspacePreparation: dispatchMode.workspaceStrategy }
          : {}),
        queuePosition: null,
        requestedAt: now,
        startedAt: null,
        completedAt: null,
        checkpointId: null,
        contextHandoffId:
          portableForkHandoff?.id ??
          providerSwitchHandoff?.id ??
          mergeBackHandoff?.id ??
          legacyImportRecoveryHandoff?.id ??
          null,
        ...(command.sourcePlanRef === undefined ? {} : { sourcePlanRef: command.sourcePlanRef }),
        ...continuedProviderRetry,
        ...(promptRecoveryOfRunId === undefined ? {} : { promptRecoveryOfRunId }),
        ...(accountMove ? { accountMoveContinuation: true as const } : {}),
        ...(command.restartContinuationOfRunId === undefined
          ? {}
          : { restartContinuationOfRunId: command.restartContinuationOfRunId }),
        ...(continuedTaskId === undefined ? {} : { delegatedTaskId: continuedTaskId }),
        ...wakeWorkStartedAt(projection.runs, command),
      };
      const attempt: OrchestrationV2RunAttempt = {
        id: attemptId,
        runId,
        attemptOrdinal: 1,
        rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      };
      const rootNode: OrchestrationV2ExecutionNode = {
        id: rootNodeId,
        threadId: command.threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: checkpointScope?.id ?? null,
        startedAt: null,
        completedAt: null,
      };
      const message: OrchestrationV2ConversationMessage = {
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        ...(command.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: command.scheduledTaskId }),
        ...threadSendFields(command),
        id: command.messageId,
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        role: "user",
        text: dispatchText,
        ...(command.context ? { context: command.context } : {}),
        attachments: command.attachments,
        streaming: false,
        createdAt: now,
        updatedAt: now,
        ...(delegatedCompletion === undefined ? {} : { delegatedCompletion }),
        ...(command.notification === undefined ? {} : { notification: command.notification }),
      };
      const turnItem: OrchestrationV2TurnItem = {
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        ...(command.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: command.scheduledTaskId }),
        ...threadSendFields(command),
        id: idAllocator.derive.userTurnItem({ messageId: command.messageId }),
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerThreadId: providerThread.id,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: ordinal * 100,
        status: "completed",
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "user_message",
        messageId: command.messageId,
        inputIntent: "turn_start",
        text: dispatchText,
        ...(command.context ? { context: command.context } : {}),
        attachments: command.attachments,
        ...(run.contextHandoffId === null
          ? yield* modelSwitchFor(
              command.threadId,
              projection,
              modelSelection,
              sourceRun?.modelSelection,
            )
          : {}),
      };
      const activeHandoff = portableForkHandoff ?? mergeBackHandoff ?? providerSwitchHandoff;
      const handoffSourceRuns =
        portableForkHandoff !== null
          ? sourceRun === null
            ? []
            : [sourceRun]
          : providerSwitchHandoff === null
            ? mergeBackSourceRun === null
              ? []
              : [mergeBackSourceRun]
            : providerSwitchCoveredRuns;
      const handoffFromModelSelections = Array.from(
        new Map(
          handoffSourceRuns.map((run) => [
            `${run.modelSelection.instanceId}\0${run.modelSelection.model}`,
            run.modelSelection,
          ]),
        ).values(),
      );
      const handoffTurnItem: OrchestrationV2TurnItem | null =
        activeHandoff === null
          ? null
          : {
              id: idAllocator.derive.runSignalTurnItem({
                runId,
                signal: `context-handoff:${activeHandoff.id}`,
              }),
              threadId: command.threadId,
              runId,
              nodeId: rootNodeId,
              providerThreadId: providerThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: ordinal * 100 - 1,
              status: "completed",
              title:
                portableForkHandoff !== null
                  ? "Fork context"
                  : providerSwitchHandoff !== null
                    ? "Provider handoff"
                    : "Merge-back context",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "handoff",
              contextHandoffId: activeHandoff.id,
              fromProviderThreadIds: activeHandoff.fromProviderThreadIds,
              toProviderThreadId: activeHandoff.toProviderThreadId,
              fromProviderInstanceIds: Array.from(
                new Set(handoffSourceRuns.map((run) => run.providerInstanceId)),
              ),
              toProviderInstanceId: modelSelection.instanceId,
              fromModelSelections: handoffFromModelSelections,
              toModel: modelSelection.model,
              strategy: activeHandoff.strategy,
              summary: activeHandoff.summaryText,
            };
      const nativeForkResolution: OrchestrationV2ContextTransferResolution | null =
        !canResolveForkNatively || providerThread.nativeThreadRef === null
          ? null
          : {
              strategy: "native_fork",
              providerThreadRef: providerThread.nativeThreadRef,
            };
      const portableForkResolution: OrchestrationV2ContextTransferResolution | null =
        pendingForkTransfer === undefined || portableForkHandoff === null
          ? null
          : {
              strategy: "portable_context",
              contextHandoffId: portableForkHandoff.id,
            };
      const mergeBackResolution: OrchestrationV2ContextTransferResolution | null =
        pendingMergeBackTransfer === undefined || mergeBackHandoff === null
          ? null
          : {
              strategy: "fork_delta_context",
              contextHandoffId: mergeBackHandoff.id,
            };

      if (pendingForkTransfer !== undefined && canResolveForkNatively) {
        yield* emitEvent({
          type: "context-transfer.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...pendingForkTransfer,
            targetProviderInstanceId: modelSelection.instanceId,
            targetRunId: runId,
            status: "pending",
            resolution: null,
            error: null,
            updatedAt: now,
          },
        });
      }
      if (pendingForkTransfer !== undefined && portableForkResolution !== null) {
        yield* emitEvent({
          type: "context-transfer.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...pendingForkTransfer,
            targetProviderInstanceId: modelSelection.instanceId,
            targetRunId: runId,
            status: "resolved_portable",
            resolution: portableForkResolution,
            error: null,
            updatedAt: now,
          },
        });
      }
      yield* emitEvent({
        type: "provider-thread.updated",
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: providerThread,
      });
      if (portableForkHandoff !== null) {
        yield* emitEvent({
          type: "context-handoff.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: portableForkHandoff,
        });
      }
      if (legacyImportRecoveryHandoff !== null) {
        yield* emitEvent({
          type: "context-handoff.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: legacyImportRecoveryHandoff,
        });
      }
      if (
        providerSwitchTransferId !== null &&
        providerSwitchHandoff !== null &&
        latestHandoffRun !== undefined
      ) {
        const transfer: OrchestrationV2ContextTransfer = {
          id: providerSwitchTransferId,
          type: "provider_handoff",
          sourceThreadId: command.threadId,
          targetThreadId: command.threadId,
          sourcePoint: contextSourcePointForRun(projection, latestHandoffRun),
          basePoint:
            requiresFullProviderSwitchContext || targetLastCompletedRun === undefined
              ? null
              : contextSourcePointForRun(projection, targetLastCompletedRun),
          sourceProviderInstanceId: latestHandoffRun.providerInstanceId,
          targetProviderInstanceId: modelSelection.instanceId,
          targetRunId: runId,
          status: "consumed",
          resolution: {
            strategy:
              providerSwitchHandoff.strategy === "full_thread_summary"
                ? "portable_context"
                : "delta_context",
            contextHandoffId: providerSwitchHandoff.id,
          },
          createdBy: command.createdBy,
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: now,
        };
        yield* emitEvent({
          type: "context-transfer.created",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: transfer,
        });
        yield* emitEvent({
          type: "context-handoff.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: providerSwitchHandoff,
        });
      }
      if (mergeBackHandoff !== null) {
        yield* emitEvent({
          type: "context-handoff.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: mergeBackHandoff,
        });
      }
      for (const supersededTransfer of supersededMergeBackTransfers) {
        yield* emitEvent({
          type: "context-transfer.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...supersededTransfer,
            status: "superseded",
            error:
              pendingMergeBackTransfer === undefined
                ? "Superseded while consuming merge-back transfer."
                : `Superseded by merge-back transfer ${pendingMergeBackTransfer.id}.`,
            updatedAt: now,
          },
        });
      }
      if (pendingMergeBackTransfer !== undefined && mergeBackResolution !== null) {
        yield* emitEvent({
          type: "context-transfer.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...pendingMergeBackTransfer,
            targetProviderInstanceId: modelSelection.instanceId,
            targetRunId: runId,
            status: "consumed",
            resolution: mergeBackResolution,
            error: null,
            updatedAt: now,
            consumedAt: now,
          },
        });
      }
      yield* emitEvent({
        type: "run.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: run,
      });
      yield* completeSourcePlan(now);
      yield* emitEvent({
        type: "run-attempt.created",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: attempt,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: rootNode,
      });
      if (checkpointScope !== null)
        yield* emitEvent({
          type: "checkpoint-scope.created",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: yield* checkpointService.ensureScope(checkpointScope).pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause,
                }),
            ),
          ),
        });
      if (handoffTurnItem !== null) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: handoffTurnItem,
        });
      }
      yield* emitEvent({
        type: "message.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: message,
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: notificationTurnItem(turnItem, message, projection.subagents),
      });
      const forkResolution = nativeForkResolution ?? portableForkResolution;
      if (pendingForkTransfer !== undefined && forkResolution !== null) {
        yield* emitEvent({
          type: "context-transfer.updated",
          threadId: command.threadId,
          runId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            ...pendingForkTransfer,
            targetProviderInstanceId: modelSelection.instanceId,
            targetRunId: runId,
            status: "consumed",
            resolution: forkResolution,
            error: null,
            updatedAt: now,
            consumedAt: now,
          },
        });
      }

      if (canResumeAcrossInstances && activeProviderThread.providerSessionId !== null) {
        const previousProviderSessionId = activeProviderThread.providerSessionId;
        yield* emitEvent({
          type: "provider-session.detached",
          threadId: command.threadId,
          driver: activeProviderThread.driver,
          providerInstanceId: activeProviderThread.providerInstanceId,
          occurredAt: now,
          payload: {
            providerSessionId: previousProviderSessionId,
            detachedAt: now,
            reason: "Provider account changed; continuing the native thread.",
          },
        });
        yield* Ref.update(effects, (existing) => [
          ...existing,
          {
            id: `effect:${command.commandId}:provider-session.detach:${previousProviderSessionId}`,
            commandId: command.commandId,
            threadId: command.threadId,
            request: {
              type: "provider-session.detach",
              providerSessionId: previousProviderSessionId,
              detail: "Provider account changed; continuing the native thread.",
            },
          } satisfies PendingOrchestrationEffectV2,
        ]);
      }
      if (dispatchMode.type === "defer_start") {
        yield* emitPreparation(adapter.driver, turnItem);
        return;
      }
      const pendingEffect = {
        id: `effect:${command.commandId}:provider-turn.start:${runId}`,
        commandId: command.commandId,
        threadId: command.threadId,
        request: { type: "provider-turn.start", runId },
      } satisfies PendingOrchestrationEffectV2;
      yield* Ref.update(effects, (existing) => [...existing, pendingEffect]);
    });

  // A native background subagent keeps working, and delegating, after the latest run settles.
  const backgroundSubagentOutlivesRun = (run: OrchestrationV2Run) =>
    projectionStore.getThreadShell(run.threadId).pipe(
      Effect.map(
        (shell) =>
          shell !== null &&
          shell.archivedAt === null &&
          shell.activeRunId === null &&
          shell.latestRunId === run.id &&
          shell.providerInstanceId === run.providerInstanceId &&
          hasPendingBackgroundSubagent(shell.pendingBackgroundTasks),
      ),
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: run.threadId, cause }),
      ),
    );

  const dispatchDelegatedTaskRequest = Effect.fn("orchestrationV2.dispatch.delegatedTaskRequest")(
    function* (
      command: Extract<OrchestrationV2ServerCommand, { readonly type: "delegated_task.request" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      const parentProjection = yield* projectionStore
        .getThreadRecords(
          command.parentThreadId,
          ["runs", "nodes", "subagents", "providerThreads", "providerTurns", "attempts"],
          { nodeIds: [command.parentNodeId], attemptRunIds: [command.parentRunId] },
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.parentThreadId,
                cause,
              }),
          ),
        );
      const parentRun = parentProjection.runs.find(
        (candidate) => candidate.id === command.parentRunId,
      );
      // A user retry is still a delegated task of the original parent, even when
      // that parent's turn has ended. Only the server's workflow launcher uses this path.
      const workflowRetry =
        command.workflowAdmission === true &&
        command.createdBy === "system" &&
        command.creationSource === "server" &&
        command.context?.records.some(
          (r) => r.kind === "workflow" && !("payload" in r) && r.nodeId !== undefined,
        );
      // The user may start a subagent in an idle chat: its card sits in the last turn that
      // ran, and the result wakes the lead. A Stop on the lead's turn does not cancel it.
      const userStart =
        command.createdBy === "user" &&
        parentRun !== undefined &&
        (isBlockingRun(parentRun) || latestExecutedRun(parentProjection.runs)?.id === parentRun.id);
      if (
        parentRun === undefined ||
        (!isBlockingRun(parentRun) &&
          !workflowRetry &&
          !userStart &&
          !(yield* backgroundSubagentOutlivesRun(parentRun)))
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent run ${command.parentRunId} is not active.`,
        });
      }
      if (
        !workflowRetry &&
        !userStart &&
        (yield* stopReachedRun(command, command.parentThreadId, parentRun.id))
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent run ${command.parentRunId} is stopping.`,
        });
      }
      const parentNode = parentProjection.nodes.find(
        (candidate) => candidate.id === command.parentNodeId,
      );
      if (
        parentNode === undefined ||
        parentNode.runId !== parentRun.id ||
        parentRun.rootNodeId === null
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent node ${command.parentNodeId} is not part of active run ${parentRun.id}.`,
        });
      }

      const targetAdapter = yield* providerAdapters.get(command.modelSelection.instanceId).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: command.modelSelection.instanceId,
              cause,
            }),
        ),
      );

      const now = command.createdAt ?? (yield* DateTime.now);
      const taskNodeId = idAllocator.derive.delegatedTaskNode({
        commandId: command.commandId,
      });
      const childThreadId = idAllocator.derive.delegatedTaskThread({
        commandId: command.commandId,
      });
      const childMessageId = idAllocator.derive.delegatedTaskMessage({
        commandId: command.commandId,
      });
      const taskTurnItemId = idAllocator.derive.delegatedTaskTurnItem({
        commandId: command.commandId,
      });
      const taskTitle = subagentThreadTitle({
        parentTitle: parentProjection.thread.title,
        prompt: command.task,
        ...(command.title === undefined ? {} : { title: command.title }),
        ordinal: parentProjection.subagents.length + 1,
      });
      const childThread: OrchestrationV2AppThread = {
        ...makeSubagentChildThread({
          parentThread: parentProjection.thread,
          childThreadId,
          parentNodeId: taskNodeId,
          activeProviderThreadId: null,
          providerInstanceId: command.modelSelection.instanceId,
          modelSelection: command.modelSelection,
          title: taskTitle,
          now,
          createdBy: command.createdBy,
          creationSource: command.creationSource,
        }),
        runtimeMode: command.runtimeMode,
        interactionMode: command.interactionMode,
        ...(command.workspaceStrategy === undefined ? {} : { branch: null, worktreePath: null }),
      };
      const task: OrchestrationV2Subagent = {
        id: taskNodeId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        parentNodeId: command.parentNodeId,
        origin: "app_owned",
        createdBy: command.createdBy,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: command.task,
        ...(command.role === undefined ? {} : { role: command.role }),
        title: command.title ?? null,
        model: command.modelSelection.model,
        // With its options: "New subagent" offers the models a chat's subagents ran on, as run.
        modelSelection: command.modelSelection,
        ...(command.completionWake === undefined ? {} : { completionWake: command.completionWake }),
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };
      const taskNode: OrchestrationV2ExecutionNode = {
        id: taskNodeId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        parentNodeId: command.parentNodeId,
        rootNodeId: parentRun.rootNodeId,
        kind: "subagent",
        status: "running",
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      const parentProviderTurn = providerTurnForRun(parentProjection, parentRun);
      const taskTurnItem: OrchestrationV2TurnItem = {
        id: taskTurnItemId,
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        providerThreadId: parentRun.providerThreadId,
        providerTurnId: parentProviderTurn?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(parentProjection),
        status: "running",
        title: command.title ?? taskTitle,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "subagent",
        subagentId: taskNodeId,
        origin: "app_owned",
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        childThreadId,
        prompt: command.task,
        result: null,
      };
      const emitEvent = emit(events, command);

      yield* emitEvent({
        type: "thread.created",
        threadId: childThreadId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: childThread,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: taskNode,
      });
      yield* emitEvent({
        type: "subagent.updated",
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: task,
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.parentThreadId,
        runId: parentRun.id,
        nodeId: taskNodeId,
        driver: targetAdapter.driver,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: taskTurnItem,
      });

      const childMessageCommand = {
        type: "message.dispatch",
        createdBy: command.createdBy,
        creationSource: command.creationSource,
        commandId: command.commandId,
        threadId: childThreadId,
        senderThreadId: command.parentThreadId,
        messageId: childMessageId,
        text: command.task,
        attachments: command.attachments ?? [],
        ...(command.context ? { context: command.context } : {}),
        modelSelection: command.modelSelection,
        dispatchMode:
          command.workspaceStrategy === undefined
            ? { type: "start_immediately" }
            : { type: "defer_start", workspaceStrategy: command.workspaceStrategy },
      } satisfies Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
      yield* dispatchMessage(childMessageCommand, events, effects);

      const childProjection = yield* getProjectionWithPendingEvents(
        childThreadId,
        events,
        "handoff",
      );
      const childRun = childProjection.runs[0];
      if (childRun === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Delegated child thread ${childThreadId} did not create a run.`,
        });
      }
      const spawnTransferId = yield* mapDispatchError(command)(
        idAllocator.allocate.contextTransfer({
          sourceThreadId: command.parentThreadId,
          targetThreadId: childThreadId,
          type: "subagent_spawn",
        }),
      );
      const spawnTransfer: OrchestrationV2ContextTransfer = {
        id: spawnTransferId,
        type: "subagent_spawn",
        sourceThreadId: command.parentThreadId,
        targetThreadId: childThreadId,
        sourcePoint: {
          ...contextSourcePointForRun(parentProjection, parentRun),
          turnItemId: taskTurnItemId,
        },
        basePoint: null,
        sourceProviderInstanceId: parentRun.providerInstanceId,
        targetProviderInstanceId: command.modelSelection.instanceId,
        targetRunId: childRun.id,
        status: "consumed",
        resolution: null,
        createdBy: command.createdBy,
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: now,
      };
      yield* emitEvent({
        type: "context-transfer.created",
        threadId: childThreadId,
        runId: childRun.id,
        providerInstanceId: command.modelSelection.instanceId,
        occurredAt: now,
        payload: spawnTransfer,
      });
    },
  );

  // A follow-up is new requested work in the same child conversation. Give it
  // its own task so results, acknowledgments, Stop, and recovery use the same
  // lifecycle as a fresh delegation without replacing the original result.
  const recordSubagentFollowup = Effect.fnUntraced(function* (
    child: OrchestrationV2AppThread,
    command: Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    if (
      command.scheduledTaskId !== undefined ||
      command.notification !== undefined ||
      command.restartContinuationOfRunId !== undefined ||
      (command.createdBy !== "user" && command.creationSource !== "mcp")
    )
      return;
    const pending = yield* Ref.get(events);
    const message = pending
      .flatMap((event) =>
        event.type === "message.updated" && event.payload.id === command.messageId
          ? [event.payload]
          : [],
      )
      .at(-1);
    if (message?.runId == null) return;
    const parentThreadId = child.lineage.parentThreadId;
    if (
      child.lineage.relationshipToParent !== "subagent" ||
      child.lineage.parentEnvironmentId !== undefined ||
      parentThreadId === null ||
      (command.createdBy !== "user" && command.senderThreadId !== parentThreadId)
    )
      return;
    const run =
      pending
        .flatMap((event) =>
          (event.type === "run.created" || event.type === "run.updated") &&
          event.payload.id === message.runId
            ? [event.payload]
            : [],
        )
        .at(-1) ??
      (yield* projectionStore.getThreadRecords(command.threadId, ["runs"], {
        runIds: [message.runId],
      })).runs.find((row) => row.id === message.runId);
    if (run === undefined || run.delegatedTaskId !== undefined || child.forkedFrom?.type !== "node")
      return;
    const parent = yield* projectionStore
      .getMessageDispatchProjection(parentThreadId, {
        needsRunHistory: false,
        followupTaskId: child.forkedFrom.nodeId,
      })
      .pipe(mapDispatchError(command));
    const original = parent.subagents.find(
      (task) =>
        task.origin === "app_owned" &&
        task.remote === undefined &&
        task.childThreadId === child.id &&
        task.id === (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined),
    );
    // Before first publication, follow-ups remain part of the original task.
    if (original === undefined || original.result === null) return;
    const owner =
      parent.runs.filter(isBlockingRun).toSorted((a, b) => b.ordinal - a.ordinal)[0] ??
      latestExecutedRun(parent.runs);
    if (owner === null || owner.rootNodeId === null) return;
    const now = message.createdAt;
    const adapter = yield* providerAdapters.get(run.providerInstanceId);
    const taskId = idAllocator.derive.delegatedTaskNode({ commandId: command.commandId });
    const task: OrchestrationV2Subagent = {
      ...original,
      createdBy: command.createdBy,
      driver: adapter.driver,
      id: taskId,
      runId: owner.id,
      parentNodeId: owner.rootNodeId,
      providerInstanceId: run.providerInstanceId,
      providerThreadId: run.providerThreadId,
      model: run.modelSelection.model,
      modelSelection: run.modelSelection,
      prompt: command.text,
      title: child.title,
      completionWake: "always",
      completionDelivery: { state: "pending", observedByRunId: null },
      status: run.status === "queued" ? "pending" : "running",
      progress: undefined,
      childActivity: undefined,
      seen: undefined,
      cancellationRequested: undefined,
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: taskId,
      threadId: parentThreadId,
      runId: owner.id,
      parentNodeId: owner.rootNodeId,
      rootNodeId: owner.rootNodeId,
      kind: "subagent",
      status: task.status,
      countsForRun: false,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const turnItem: OrchestrationV2TurnItem = {
      id: idAllocator.derive.delegatedTaskTurnItem({ commandId: command.commandId }),
      threadId: parentThreadId,
      runId: owner.id,
      nodeId: taskId,
      providerThreadId: owner.providerThreadId,
      providerTurnId: providerTurnForRun(parent, owner)?.id ?? null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: yield* nextTurnItemOrdinal(parent),
      status: task.status,
      title: child.title,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "subagent",
      subagentId: taskId,
      origin: "app_owned",
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      childThreadId: child.id,
      prompt: command.text,
      result: null,
    };
    const emitEvent = emit(events, command);
    // Stop disposed the tasks it interrupted. A follow-up has a new result to deliver.
    if (owner.delegatedCompletion?.disposition === "stopped") {
      const { runs } = yield* projectionStore
        .getThreadRecords(parentThreadId, ["runs"], { runIds: [owner.id] })
        .pipe(mapDispatchError(command));
      const currentOwner = runs[0];
      if (currentOwner?.delegatedCompletion?.disposition === "stopped") {
        yield* emitEvent({
          type: "run.updated",
          threadId: parentThreadId,
          runId: currentOwner.id,
          nodeId: owner.rootNodeId,
          providerInstanceId: currentOwner.providerInstanceId,
          occurredAt: now,
          payload: {
            ...currentOwner,
            delegatedCompletion: { ...currentOwner.delegatedCompletion, disposition: "open" },
          },
        });
      }
    }
    yield* emitEvent({
      type: "run.updated",
      threadId: child.id,
      runId: run.id,
      occurredAt: now,
      payload: { ...run, delegatedTaskId: taskId },
    });
    yield* emitEvent({
      type: "node.updated",
      threadId: parentThreadId,
      runId: owner.id,
      nodeId: taskId,
      occurredAt: now,
      payload: node,
    });
    yield* emitEvent({
      type: "subagent.updated",
      threadId: parentThreadId,
      runId: owner.id,
      nodeId: taskId,
      occurredAt: now,
      payload: task,
    });
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: parentThreadId,
      runId: owner.id,
      nodeId: taskId,
      occurredAt: now,
      payload: turnItem,
    });
  });

  // Rewrites a delegated task's completionWake after creation. The wait path
  // uses this when its blocking window ends without a terminal (timeout), so
  // a child that later terminalizes mid-parent-turn still wakes the parent.
  // Runs under the parent thread's dispatch lock, which is also what finalize
  // takes for its parent-side writes, so the two never interleave on this row.
  const dispatchDelegatedTaskWakePolicy = Effect.fn(
    "orchestrationV2.dispatch.delegatedTaskWakePolicy",
  )(function* (
    command: Extract<OrchestrationV2Command, { readonly type: "delegated_task.wake-policy" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const parentProjection = yield* projectionStore
      .getThreadRecords(command.parentThreadId, ["subagents", "runs", "messages"], {
        // A completion plan looks up its delivery message, a user message, by ID.
        messageRoles: ["user"],
        unorderedMessages: true,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorProjectionError({
              threadId: command.parentThreadId,
              cause,
            }),
        ),
      );
    const task = parentProjection.subagents.find(
      (candidate) => candidate.id === command.taskId && candidate.origin === "app_owned",
    );
    // No-op commands reject with a descriptive cause, matching the thread
    // mutation handlers ("already archived", "not archived").
    if (task === undefined) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Delegated task ${command.taskId} is not an app-owned task of thread ${command.parentThreadId}.`,
      });
    }
    if (task.completionWake === command.completionWake) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Delegated task ${command.taskId} already wakes the parent with completionWake ${command.completionWake}.`,
      });
    }
    const now = yield* DateTime.now;
    const emitEvent = emit(events, command);
    const updatedTask: OrchestrationV2Subagent = {
      ...task,
      completionWake: command.completionWake,
      updatedAt: now,
    };
    // The durable mailbox deduplicates a prior offer; an unread terminal result
    // still needs one when a wait was lost at restart or its parent just settled.
    const parentRun =
      task.runId === null
        ? undefined
        : parentProjection.runs.find((candidate) => candidate.id === task.runId);
    const completionPlan =
      command.completionWake === "always" && isTerminalDelegatedTaskStatus(task.status)
        ? yield* planDelegatedCompletionDelivery({
            parentProjection,
            parentRun,
            task: updatedTask,
            updatedTask,
            now,
          })
        : undefined;
    yield* emitEvent({
      type: "subagent.updated",
      threadId: command.parentThreadId,
      ...(task.runId === null ? {} : { runId: task.runId }),
      nodeId: task.id,
      driver: task.driver,
      providerInstanceId: task.providerInstanceId,
      occurredAt: now,
      payload: completionPlan?.task ?? updatedTask,
    });
    if (completionPlan === undefined) {
      return;
    }
    if (completionPlan.parentRun !== undefined) {
      yield* emitEvent({
        type: "run.updated",
        threadId: command.parentThreadId,
        runId: completionPlan.parentRun.id,
        ...(completionPlan.parentRun.rootNodeId === null
          ? {}
          : { nodeId: completionPlan.parentRun.rootNodeId }),
        providerInstanceId: completionPlan.parentRun.providerInstanceId,
        occurredAt: now,
        payload: completionPlan.parentRun,
      });
    }
    if (completionPlan.message !== undefined) {
      yield* emitEvent({
        type: "message.updated",
        threadId: command.parentThreadId,
        ...(completionPlan.message.runId === null ? {} : { runId: completionPlan.message.runId }),
        ...(completionPlan.message.nodeId === null
          ? {}
          : { nodeId: completionPlan.message.nodeId }),
        providerInstanceId:
          completionPlan.parentRun?.providerInstanceId ??
          parentProjection.thread.providerInstanceId,
        occurredAt: now,
        payload: completionPlan.message,
      });
    }
  });

  const recordCreatedChatFailure = Effect.fnUntraced(function* (
    command: OrchestrationV2ServerCommand,
    thread: OrchestrationV2AppThread,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) {
    const receipt = thread.createdChat;
    if (
      receipt === undefined ||
      receipt.failure === undefined ||
      receipt.failureNoticeQueued ||
      receipt.startup === "pending" ||
      receipt.startup === "failed"
    )
      return thread;
    const failure = receipt.failure;
    yield* Ref.update(effects, (pending) => [
      ...pending,
      {
        id: `effect:created-chat-failure:${thread.id}`,
        commandId: command.commandId,
        threadId: thread.id,
        request: {
          type: "created-chat.failure",
          creatorThreadId: receipt.creatorThreadId,
          title: thread.title,
          error: failure,
        },
      } satisfies PendingOrchestrationEffectV2,
    ]);
    return { ...thread, createdChat: { ...receipt, failureNoticeQueued: true as const } };
  });

  const dispatchCreatedThreadRecord = Effect.fn("orchestrationV2.dispatch.createdThreadRecord")(
    function* (
      command: Extract<OrchestrationV2Command, { readonly type: "thread.created.record" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      const parentProjection = yield* projectionStore
        .getThreadRecords(command.parentThreadId, ["runs", "nodes", "attempts", "providerTurns"], {
          runIds: [command.parentRunId],
          nodeIds: [command.parentNodeId],
          attemptRunIds: [command.parentRunId],
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.parentThreadId,
                cause,
              }),
          ),
        );
      const targetProjection = yield* projectionStore
        .getThreadRecords(command.targetThreadId, ["runs"], {
          runIds: command.targetRunId === null ? [] : [command.targetRunId],
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorProjectionError({
                threadId: command.targetThreadId,
                cause,
              }),
          ),
        );
      const parentRun = parentProjection.runs.find(
        (candidate) => candidate.id === command.parentRunId,
      );
      const parentNode = parentProjection.nodes.find(
        (candidate) => candidate.id === command.parentNodeId,
      );
      if (
        parentRun === undefined ||
        parentNode === undefined ||
        parentNode.runId !== command.parentRunId ||
        parentRun.rootNodeId !== command.parentNodeId
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Parent node ${command.parentNodeId} is not the root of run ${command.parentRunId}.`,
        });
      }
      if (parentProjection.thread.projectId !== targetProjection.thread.projectId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Target thread ${command.targetThreadId} belongs to another project.`,
        });
      }
      if (
        command.targetRunId !== null &&
        !targetProjection.runs.some((candidate) => candidate.id === command.targetRunId)
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Target run ${command.targetRunId} does not belong to thread ${command.targetThreadId}.`,
        });
      }

      const now = yield* DateTime.now;
      if (
        targetProjection.thread.createdBy === "agent" &&
        targetProjection.thread.createdChat === undefined
      ) {
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: command.targetThreadId,
          occurredAt: now,
          payload: {
            ...targetProjection.thread,
            createdChat: {
              creatorThreadId: command.parentThreadId,
              firstRunId: command.targetRunId,
              startup: "pending",
            },
            updatedAt: now,
          },
        });
      }
      const parentProviderTurn = providerTurnForRun(parentProjection, parentRun);
      const turnItem: OrchestrationV2TurnItem = {
        id: idAllocator.derive.createdThreadTurnItem({ commandId: command.commandId }),
        threadId: command.parentThreadId,
        runId: command.parentRunId,
        nodeId: command.parentNodeId,
        providerThreadId: parentRun.providerThreadId,
        providerTurnId: parentProviderTurn?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(parentProjection),
        status: "completed",
        title: targetProjection.thread.title,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "thread_created",
        targetThreadId: command.targetThreadId,
        targetRunId: command.targetRunId,
        targetProviderInstanceId: targetProjection.thread.modelSelection.instanceId,
        targetModel: targetProjection.thread.modelSelection.model,
      };

      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.parentThreadId,
        runId: command.parentRunId,
        nodeId: command.parentNodeId,
        providerInstanceId: parentRun.providerInstanceId,
        occurredAt: now,
        payload: turnItem,
      });
    },
  );

  /**
   * Records or updates the card for a secret an agent asked the user for. The
   * item carries the request and its status only; the value goes straight to
   * the server's secret store and never through orchestration.
   */
  const dispatchSecretRequestRecord = Effect.fn("orchestrationV2.dispatch.secretRequestRecord")(
    function* (
      command: Extract<OrchestrationV2InternalCommand, { readonly type: "secret_request.record" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
      effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    ) {
      if (!command.turnItemId.startsWith(SECRET_REQUEST_TURN_ITEM_ID_PREFIX)) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Secret request turn item id ${command.turnItemId} must start with ${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}.`,
        });
      }
      const projection = yield* projectionStore
        .getThreadRecords(command.threadId, ["runs", "turnItems", "attempts", "providerTurns"], {
          runIds: [command.runId],
          attemptRunIds: [command.runId],
          turnItemIds: [command.turnItemId],
        })
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      if (
        command.secretStatus !== "cancelled" &&
        (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null)
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "This chat is archived or removed. Reopen it before answering.",
        });
      }
      const run = projection.runs.find((candidate) => candidate.id === command.runId);
      if (run === undefined || run.rootNodeId !== command.nodeId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Node ${command.nodeId} is not the root of run ${command.runId}.`,
        });
      }
      const existing = projection.turnItems.find((item) => item.id === command.turnItemId);
      if (existing !== undefined && existing.type !== "secret_request") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Turn item ${command.turnItemId} is not a secret request.`,
        });
      }
      if (existing !== undefined && existing.runId !== command.runId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Secret request ${command.turnItemId} belongs to another run.`,
        });
      }
      const now = yield* DateTime.now;
      // A request is answered once, and a retry finds its card as it was
      // asked: either one records the card unchanged.
      const unchanged =
        existing !== undefined &&
        (existing.secretStatus !== "pending" || command.secretStatus === "pending");
      const pending = command.secretStatus === "pending";
      const turnItem: OrchestrationV2TurnItem = unchanged
        ? existing
        : {
            id: command.turnItemId,
            threadId: command.threadId,
            runId: command.runId,
            nodeId: command.nodeId,
            providerThreadId: run.providerThreadId,
            providerTurnId: providerTurnForRun(projection, run)?.id ?? null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: existing?.ordinal ?? (yield* nextTurnItemOrdinal(projection)),
            status: pending
              ? "waiting"
              : command.secretStatus === "saved"
                ? "completed"
                : "cancelled",
            title: command.label,
            startedAt: existing?.startedAt ?? now,
            completedAt: pending ? null : now,
            updatedAt: now,
            type: "secret_request",
            label: command.label,
            reason: command.reason,
            ...(command.placeholder === undefined ? {} : { placeholder: command.placeholder }),
            ...(command.apiKey === undefined ? {} : { apiKey: command.apiKey }),
            ...(command.delivery === undefined ? {} : { delivery: command.delivery }),
            ...(command.fields === undefined ? {} : { fields: command.fields }),
            secretStatus: command.secretStatus,
          };
      const answerNotice = command.answerNotice;
      if (
        !unchanged &&
        existing?.secretStatus === "pending" &&
        answerNotice !== undefined &&
        (command.secretStatus === "saved" || command.secretStatus === "declined")
      ) {
        yield* Ref.update(effects, (pending) => [
          ...pending,
          {
            id: `effect:secret-request-answer:${command.turnItemId}`,
            commandId: command.commandId,
            threadId: command.threadId,
            request: {
              type: "secret-request.answered" as const,
              turnItemId: command.turnItemId,
              text: answerNotice,
              ...(command.answerNoticeSummary === undefined
                ? {}
                : { summary: command.answerNoticeSummary }),
            },
          },
        ]);
      }
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: command.runId,
        nodeId: command.nodeId,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: turnItem,
      });
    },
  );

  /**
   * Puts questions from the `ask_user` tool in the run as a pending question
   * the user answers with a message (`runtime-request.respond` on a message
   * request), the same shape as Codex's own async questions. A retry with the
   * same request id changes nothing.
   */
  const dispatchUserQuestionAsk = Effect.fn("orchestrationV2.dispatch.userQuestionAsk")(function* (
    command: Extract<OrchestrationV2InternalCommand, { readonly type: "user_question.ask" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* projectionStore
      .getThreadRecords(
        command.threadId,
        ["runs", "attempts", "providerTurns", "runtimeRequests"],
        { runIds: [command.runId], attemptRunIds: [command.runId] },
      )
      .pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
    const run = projection.runs.find((candidate) => candidate.id === command.runId);
    if (run === undefined || run.rootNodeId !== command.nodeId) {
      return yield* new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
        cause: `Node ${command.nodeId} is not the root of run ${command.runId}.`,
      });
    }
    if (projection.runtimeRequests.some((request) => request.id === command.requestId)) return;
    const now = yield* DateTime.now;
    const providerTurnId = providerTurnForRun(projection, run)?.id ?? null;
    const questionNodeId = NodeId.make(`node:user-question:${command.requestId}`);
    const emitEvent = emit(events, command);
    yield* emitEvent({
      type: "node.updated",
      threadId: command.threadId,
      runId: command.runId,
      nodeId: questionNodeId,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: {
        id: questionNodeId,
        threadId: command.threadId,
        runId: command.runId,
        parentNodeId: command.nodeId,
        rootNodeId: command.nodeId,
        kind: "user_input_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: run.providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        runtimeRequestId: command.requestId,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      },
    });
    yield* emitEvent({
      type: "runtime-request.updated",
      threadId: command.threadId,
      runId: command.runId,
      nodeId: questionNodeId,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: {
        id: command.requestId,
        nodeId: questionNodeId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: now,
        resolvedAt: null,
      },
    });
    yield* emitEvent({
      type: "turn-item.updated",
      threadId: command.threadId,
      runId: command.runId,
      nodeId: questionNodeId,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: {
        id: command.turnItemId,
        threadId: command.threadId,
        runId: command.runId,
        nodeId: questionNodeId,
        providerThreadId: run.providerThreadId,
        providerTurnId,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(projection),
        status: "waiting",
        title: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
        type: "user_input_request",
        requestId: command.requestId,
        questions: command.questions,
        responseMode: "message",
      },
    });
  });

  const dispatchRuntimeRequestRespond = (
    command: Extract<OrchestrationV2Command, { readonly type: "runtime-request.respond" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const context = yield* projectionStore
        .getRuntimeResponseContext(command.threadId, command.requestId)
        .pipe(
          Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
        );
      const runtimeRequest = context.request;
      if (runtimeRequest === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Runtime request ${command.requestId} was not found.`,
        });
      }
      if (runtimeRequest.status !== "pending") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Runtime request ${command.requestId} is ${runtimeRequest.status}.`,
        });
      }
      if (runtimeRequest.responseCapability.type === "not_resumable") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: runtimeRequest.responseCapability.reason,
        });
      }
      const providerSessionId =
        runtimeRequest.responseCapability.type === "live"
          ? runtimeRequest.responseCapability.providerSessionId
          : null;
      const providerSession = context.session;
      if (providerSessionId !== null && providerSession === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Provider session ${providerSessionId} was not found.`,
        });
      }

      if (
        runtimeRequest.responseCapability.type === "message" &&
        command.decision !== "decline" &&
        command.decision !== "cancel"
      ) {
        const thread = yield* projectionStore
          .getThread(command.threadId)
          .pipe(mapDispatchError(command));
        // The thread lock keeps this selection fixed through answer dispatch.
        // Refuse before resolving the question so it remains answerable.
        yield* assertProviderInstanceEnabled(
          yield* serverSettings.getProviderPolicy.pipe(Effect.orDie),
          {
            projectId: thread.projectId,
            instanceId: thread.modelSelection.instanceId,
          },
        );
      }
      const now = yield* DateTime.now;
      const resolvedRequest = {
        ...runtimeRequest,
        status: "resolved" as const,
        resolvedAt: now,
        ...(command.decision === undefined ? {} : { decision: command.decision }),
        ...(command.answers === undefined ? {} : { answers: command.answers }),
      };
      const emitEvent = emit(events, command);
      const requestNode = context.node;
      const resolvedNodeStatus =
        command.decision === "decline" || command.decision === "cancel"
          ? ("cancelled" as const)
          : ("completed" as const);
      yield* emitEvent({
        type: "runtime-request.updated",
        threadId: command.threadId,
        ...(requestNode?.runId == null ? {} : { runId: requestNode.runId }),
        nodeId: runtimeRequest.nodeId,
        ...(providerSession === undefined
          ? {}
          : {
              driver: providerSession.driver,
              providerInstanceId: providerSession.providerInstanceId,
            }),
        occurredAt: now,
        payload: resolvedRequest,
      });
      if (requestNode !== undefined) {
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
          nodeId: requestNode.id,
          ...(providerSession === undefined
            ? {}
            : {
                driver: providerSession.driver,
                providerInstanceId: providerSession.providerInstanceId,
              }),
          occurredAt: now,
          payload: {
            ...requestNode,
            status: resolvedNodeStatus,
            completedAt: now,
          },
        });
      }

      const approvalTurnItem = context.item;
      if (approvalTurnItem !== undefined) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          ...(approvalTurnItem.runId === null ? {} : { runId: approvalTurnItem.runId }),
          ...(approvalTurnItem.nodeId === null ? {} : { nodeId: approvalTurnItem.nodeId }),
          ...(providerSession === undefined
            ? {}
            : {
                driver: providerSession.driver,
                providerInstanceId: providerSession.providerInstanceId,
              }),
          occurredAt: now,
          payload: {
            ...approvalTurnItem,
            ...(approvalTurnItem.type === "user_input_request" && command.answers !== undefined
              ? {
                  questionAnswer: {
                    requestId: command.requestId,
                    answers: command.answers ?? {},
                    attachmentsByQuestionId: command.attachmentsByQuestionId ?? {},
                    questionTextById: Object.fromEntries(
                      approvalTurnItem.questions.map((question) => [
                        question.id,
                        question.question,
                      ]),
                    ),
                  },
                }
              : {}),
            status: resolvedNodeStatus,
            completedAt: now,
            updatedAt: now,
          },
        });
      }
      if (runtimeRequest.responseCapability.type === "message") {
        if (resolvedNodeStatus === "cancelled") return;
        if (approvalTurnItem?.type !== "user_input_request") {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "The question for this request was not found.",
          });
        }
        const replies: string[] = [];
        const attachments: ChatAttachment[] = [];
        for (const question of approvalTurnItem.questions) {
          const answer = messageAnswerText(command.answers?.[question.id]);
          const files = command.attachmentsByQuestionId?.[question.id] ?? [];
          if (answer.length === 0 && files.length === 0) {
            if (question.required === false) continue;
            return yield* new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause: "Answer each question before sending.",
            });
          }
          replies.push(answer ? `${question.question}\n${answer}` : question.question);
          attachments.push(...files);
        }
        if (replies.length === 0) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Enter an answer before sending.",
          });
        }
        let dispatchMode: Extract<
          OrchestrationV2Command,
          { type: "message.dispatch" }
        >["dispatchMode"] = {
          type: "queue_after_active",
        };
        const {
          run: activeRun,
          providerThread: activeProviderThread,
          providerTurn: activeProviderTurn,
        } = yield* projectionStore
          .getRunningTurnContext(command.threadId)
          .pipe(mapDispatchError(command));
        if (activeRun && activeProviderTurn && activeProviderThread?.providerSessionId) {
          const activeSession = yield* providerSessions
            .get(activeProviderThread.providerSessionId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause,
                  }),
              ),
            );
          if (
            Option.isSome(activeSession) &&
            activeSession.value.providerSession.capabilities.turns.supportsActiveSteering
          ) {
            dispatchMode = { type: "steer_active", targetRunId: activeRun.id };
          }
        }
        // The resolution and normal message dispatch share one event transaction.
        return yield* dispatchMessage(
          {
            type: "message.dispatch",
            commandId: command.commandId,
            threadId: command.threadId,
            messageId: MessageId.make(`async-answer:${command.requestId}`),
            text: replies.join("\n\n"),
            attachments,
            createdBy: "user",
            creationSource: "server",
            dispatchMode,
          },
          events,
          effects,
        );
      }
      if (providerSessionId === null) return;
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:runtime-request.respond:${command.requestId}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "runtime-request.respond",
            providerSessionId,
            requestId: command.requestId,
            ...(command.decision === undefined ? {} : { decision: command.decision }),
            ...(command.answers === undefined ? {} : { answers: command.answers }),
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    });

  const dispatchThreadUserInputDismiss = (
    command: Extract<OrchestrationV2Command, { readonly type: "thread.user-input.dismiss" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const request = yield* projectionStore
        .getRuntimeRequest(command.threadId, command.requestId)
        .pipe(
          Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
        );
      if (request === undefined || request.status !== "pending") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "This question has already been answered.",
        });
      }
      if (request.kind !== "user_input" || request.responseCapability.type !== "message") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "This question needs an answer. Answer it or stop the turn.",
        });
      }
      yield* dispatchRuntimeRequestRespond(
        {
          type: "runtime-request.respond",
          commandId: command.commandId,
          threadId: command.threadId,
          requestId: command.requestId,
          decision: "cancel",
        },
        events,
        effects,
      );
    });

  const dispatchQueuedMessagePromoteToSteer = (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-message.promote-to-steer" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore
        .getMessageDispatchProjection(command.threadId, {
          targetRunId: command.targetRunId,
          needsRunHistory: false,
        })
        .pipe(
          Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
        );
      if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Thread ${command.threadId} is not active.`,
        });
      }
      const queuedRun = projection.runs.find((candidate) => candidate.id === command.queuedRunId);
      if (queuedRun === undefined || queuedRun.status !== "queued") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Queued run ${command.queuedRunId} is not queued.`,
        });
      }
      const queuedRootNode =
        queuedRun.rootNodeId === null
          ? undefined
          : projection.nodes.find((candidate) => candidate.id === queuedRun.rootNodeId);
      const queuedAttempt =
        queuedRun.activeAttemptId === null
          ? undefined
          : projection.attempts.find((candidate) => candidate.id === queuedRun.activeAttemptId);
      const queuedMessage = projection.messages.find(
        (candidate) => candidate.id === queuedRun.userMessageId,
      );
      if (
        queuedRootNode === undefined ||
        queuedAttempt === undefined ||
        queuedMessage === undefined
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Queued run ${queuedRun.id} is missing message or execution state.`,
        });
      }
      if (
        queuedMessage.delegatedCompletion !== undefined ||
        queuedMessage.notification !== undefined
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Automatic completion deliveries cannot be promoted to Steer.",
        });
      }

      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...queuedRun,
          status: "cancelled",
          queuePosition: null,
          completedAt: now,
        },
      });
      yield* emitEvent({
        type: "run-attempt.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...queuedAttempt,
          status: "cancelled",
          completedAt: now,
        },
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        nodeId: queuedRootNode.id,
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...queuedRootNode,
          status: "cancelled",
          completedAt: now,
        },
      });

      yield* dispatchSteerIntoRun({
        command,
        events,
        effects,
        projection,
        modelSelection: queuedRun.modelSelection,
        targetRunId: command.targetRunId,
        messageId: queuedMessage.id,
        text: queuedMessage.text,
        attachments: queuedMessage.attachments,
        ...(queuedMessage.context ? { context: queuedMessage.context } : {}),
        createdBy: queuedMessage.createdBy,
        creationSource: queuedMessage.creationSource,
        ...(queuedMessage.scheduledTaskId === undefined
          ? {}
          : { scheduledTaskId: queuedMessage.scheduledTaskId }),
        ...threadSendFields(queuedMessage),
        forceRestart: false,
      });
    });

  const dispatchQueuedRunReorder = (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.reorder" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore
        .getThreadRecords(command.threadId, ["runs", "messages"], {
          messageRoles: ["user"],
          queuedControls: true,
        })
        .pipe(
          Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
        );
      const queuedRuns = queuedRunsInDeliveryOrder(projection);
      const moving = queuedRuns.find((run) => run.id === command.runId);
      if (moving === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not queued.`,
        });
      }
      const movingMessage = projection.messages.find(
        (candidate) => candidate.id === moving.userMessageId,
      );
      if (
        movingMessage?.delegatedCompletion !== undefined ||
        movingMessage?.notification !== undefined
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Automatic completion deliveries cannot be reordered.",
        });
      }
      const automaticRuns = queuedRuns.filter((run) => isAutomaticCompletionRun(projection, run));
      if (
        command.beforeRunId !== null &&
        automaticRuns.some((run) => run.id === command.beforeRunId)
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Queued messages cannot be reordered ahead of automatic completion delivery.",
        });
      }
      const reorderableRuns = queuedRuns.filter(
        (run) => !isAutomaticCompletionRun(projection, run),
      );
      const withoutMoving = reorderableRuns.filter((run) => run.id !== command.runId);
      const beforeIndex =
        command.beforeRunId === null
          ? withoutMoving.length
          : withoutMoving.findIndex((run) => run.id === command.beforeRunId);
      if (beforeIndex === -1) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Queue target ${command.beforeRunId} is not queued.`,
        });
      }
      const reordered = [
        ...automaticRuns,
        ...withoutMoving.slice(0, beforeIndex),
        moving,
        ...withoutMoving.slice(beforeIndex),
      ];
      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      yield* Effect.forEach(
        reordered,
        (run, index) =>
          Effect.gen(function* () {
            const queuePosition = index + 1;
            if (run.queuePosition === queuePosition) {
              return;
            }
            yield* emitEvent({
              type: "run.updated",
              threadId: command.threadId,
              runId: run.id,
              ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
              providerInstanceId: run.providerInstanceId,
              occurredAt: now,
              payload: {
                ...run,
                queuePosition,
              },
            });
          }),
        { concurrency: 1 },
      );
    });

  const dispatchQueuedRunCancel = (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.cancel" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore
        .getThreadRecords(
          command.threadId,
          ["runs", "messages", "nodes", "attempts", "turnItems"],
          {
            turnItemTypes: ["user_message"],
            messageRoles: ["user"],
            queuedControls: true,
            runIds: [command.runId],
          },
        )
        .pipe(
          Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
        );
      const queuedRun = projection.runs.find((candidate) => candidate.id === command.runId);
      if (queuedRun === undefined || queuedRun.status !== "queued") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not queued.`,
        });
      }
      const queuedMessage = projection.messages.find(
        (candidate) => candidate.id === queuedRun.userMessageId,
      );
      if (queuedMessage?.delegatedCompletion !== undefined) {
        const now = yield* DateTime.now;
        yield* disposeDelegatedCompletionCohort({
          command,
          events,
          projection: yield* projectionStore
            .getMessageDispatchProjection(command.threadId, { needsRunHistory: true })
            .pipe(mapDispatchError(command)),
          parentRunId: queuedMessage.delegatedCompletion.parentRunId,
          disposition: "disposed",
          now,
        });
        return;
      }
      const queuedRootNode =
        queuedRun.rootNodeId === null
          ? undefined
          : projection.nodes.find((candidate) => candidate.id === queuedRun.rootNodeId);
      const queuedAttempt =
        queuedRun.activeAttemptId === null
          ? undefined
          : projection.attempts.find((candidate) => candidate.id === queuedRun.activeAttemptId);

      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      const previous =
        queuedMessage === undefined
          ? undefined
          : projection.turnItems.find(
              (item) => item.type === "user_message" && item.messageId === queuedMessage.id,
            );
      const previousIsOpen =
        previous !== undefined &&
        (previous.status === "idle" ||
          previous.status === "pending" ||
          previous.status === "running" ||
          previous.status === "waiting");
      if (command.retainMessage && queuedMessage !== undefined) {
        // A never-started queue has a message record but no transcript item yet.
        // Materialize it only for the owner's history-preserving storage action.
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId: queuedRun.id,
          providerInstanceId: queuedRun.providerInstanceId,
          occurredAt: now,
          payload:
            previous === undefined
              ? {
                  id: idAllocator.derive.userTurnItem({ messageId: queuedMessage.id }),
                  threadId: command.threadId,
                  runId: queuedRun.id,
                  nodeId: queuedRun.rootNodeId,
                  providerThreadId: queuedRun.providerThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: yield* nextTurnItemOrdinal(projection),
                  status: "completed",
                  title: "Cancelled queued message",
                  type: "user_message",
                  messageId: queuedMessage.id,
                  text: queuedMessage.text,
                  attachments: queuedMessage.attachments,
                  ...(queuedMessage.context ? { context: queuedMessage.context } : {}),
                  createdBy: queuedMessage.createdBy,
                  creationSource: queuedMessage.creationSource,
                  ...(queuedMessage.scheduledTaskId === undefined
                    ? {}
                    : { scheduledTaskId: queuedMessage.scheduledTaskId }),
                  ...threadSendFields(queuedMessage),
                  inputIntent: "queued_turn",
                  startedAt: queuedMessage.createdAt,
                  completedAt: now,
                  updatedAt: now,
                }
              : previousIsOpen
                ? {
                    ...previous,
                    status: "completed",
                    title: previous.title ?? "Cancelled queued message",
                    startedAt: previous.startedAt ?? queuedMessage.createdAt,
                    completedAt: now,
                    updatedAt: now,
                  }
                : previous,
        });
      } else if (previousIsOpen) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId: queuedRun.id,
          providerInstanceId: queuedRun.providerInstanceId,
          occurredAt: now,
          payload: {
            ...previous,
            status: "cancelled",
            completedAt: now,
            updatedAt: now,
          },
        });
      }
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        ...(queuedRun.rootNodeId === null ? {} : { nodeId: queuedRun.rootNodeId }),
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...queuedRun,
          ...(command.retainMessage ? { retainQueuedMessage: true as const } : {}),
          status: "cancelled",
          queuePosition: null,
          completedAt: now,
        },
      });
      if (queuedAttempt !== undefined && queuedRootNode !== undefined) {
        yield* emitEvent({
          type: "run-attempt.updated",
          threadId: command.threadId,
          runId: queuedRun.id,
          nodeId: queuedRootNode.id,
          providerInstanceId: queuedRun.providerInstanceId,
          occurredAt: now,
          payload: {
            ...queuedAttempt,
            status: "cancelled",
            completedAt: now,
          },
        });
      }
      if (queuedRootNode !== undefined) {
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId: queuedRun.id,
          nodeId: queuedRootNode.id,
          providerInstanceId: queuedRun.providerInstanceId,
          occurredAt: now,
          payload: {
            ...queuedRootNode,
            status: "cancelled",
            completedAt: now,
          },
        });
      }
    });

  const dispatchQueuedRunEdit = (
    command: Extract<OrchestrationV2Command, { readonly type: "queued-run.edit" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      if (command.text.trim().length === 0) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Queued run ${command.runId} cannot be edited to an empty message.`,
        });
      }
      const projection = yield* projectionStore
        .getThreadRecords(command.threadId, ["runs", "messages", "turnItems"], {
          turnItemTypes: ["user_message"],
          messageRoles: ["user"],
          queuedControls: true,
          runIds: [command.runId],
        })
        .pipe(
          Effect.mapError(() => new OrchestratorProjectionError({ threadId: command.threadId })),
        );
      const queuedRun = projection.runs.find((candidate) => candidate.id === command.runId);
      if (queuedRun === undefined || queuedRun.status !== "queued") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not queued.`,
        });
      }
      const queuedMessage = projection.messages.find(
        (candidate) => candidate.id === queuedRun.userMessageId,
      );
      if (queuedMessage === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Queued run ${queuedRun.id} has no user message.`,
        });
      }
      if (
        queuedMessage.delegatedCompletion !== undefined ||
        queuedMessage.notification !== undefined
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Automatic completion deliveries cannot be edited.",
        });
      }
      const queuedTurnItem = projection.turnItems.find(
        (candidate) =>
          candidate.type === "user_message" && candidate.messageId === queuedMessage.id,
      );

      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      const editedAttachments =
        command.attachments === undefined ? {} : { attachments: command.attachments };
      yield* emitEvent({
        type: "message.updated",
        threadId: command.threadId,
        runId: queuedRun.id,
        ...(queuedRun.rootNodeId === null ? {} : { nodeId: queuedRun.rootNodeId }),
        providerInstanceId: queuedRun.providerInstanceId,
        occurredAt: now,
        payload: {
          ...queuedMessage,
          text: command.text,
          ...editedAttachments,
          ...(command.context ? { context: command.context } : {}),
          updatedAt: now,
        },
      });
      if (queuedTurnItem !== undefined && queuedTurnItem.type === "user_message") {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId: queuedRun.id,
          ...(queuedRun.rootNodeId === null ? {} : { nodeId: queuedRun.rootNodeId }),
          providerInstanceId: queuedRun.providerInstanceId,
          occurredAt: now,
          payload: {
            ...queuedTurnItem,
            text: command.text,
            ...editedAttachments,
            ...(command.context ? { context: command.context } : {}),
            updatedAt: now,
          },
        });
      }
    });

  const loadProjectionForCommand = <K extends ProjectionRecordField>(
    command: OrchestrationV2Command,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) =>
    projectionStore
      .getThreadRecords(commandThreadId(command), fields, filter)
      .pipe(
        Effect.mapError(
          () => new OrchestratorProjectionError({ threadId: commandThreadId(command) }),
        ),
      );

  const preparedRunState = (
    command: Extract<
      OrchestrationV2Command,
      {
        readonly type:
          | "prepared-run.release"
          | "prepared-run.progress"
          | "prepared-run.fail"
          | "prepared-run.retry";
      }
    >,
    projection: Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "attempts" | "nodes" | "providerThreads" | "turnItems"
    >,
  ) => {
    const run = projection.runs.find((candidate) => candidate.id === command.runId);
    const attempt = projection.attempts.find((candidate) => candidate.id === run?.activeAttemptId);
    const rootNode = projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === run?.providerThreadId,
    );
    const preparationItem = projection.turnItems.find(
      (
        candidate,
      ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "command_execution" }> =>
        candidate.runId === command.runId &&
        candidate.type === "command_execution" &&
        candidate.input === WORKSPACE_PREPARATION_INPUT,
    );
    if (
      run?.status !== (command.type === "prepared-run.retry" ? "failed" : "preparing") ||
      attempt === undefined ||
      rootNode === undefined ||
      providerThread === undefined ||
      preparationItem === undefined
    ) {
      return null;
    }
    return { run, attempt, rootNode, providerThread, preparationItem } as const;
  };

  const dispatchPreparedRunProgress = (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.progress" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(
        command,
        ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
        {
          runIds: [command.runId],
          attemptRunIds: [command.runId],
          nodeRunIds: [command.runId],
          turnItemTypes: ["command_execution"],
          turnItemRunId: command.runId,
        },
      );
      const state = preparedRunState(command, projection);
      if (state === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not awaiting workspace preparation.`,
        });
      }
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...state.preparationItem,
          title: command.phase === "worktree" ? "Preparing worktree" : "Starting setup script",
          updatedAt: now,
        },
      });
    });

  const dispatchPreparedRunRelease = (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.release" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(
        command,
        ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
        {
          runIds: [command.runId],
          attemptRunIds: [command.runId],
          nodeRunIds: [command.runId],
          turnItemTypes: ["command_execution"],
          turnItemRunId: command.runId,
        },
      );
      const state = preparedRunState(command, projection);
      if (state === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not awaiting workspace preparation.`,
        });
      }
      const now = yield* DateTime.now;
      const resolvedRuntimePolicy = yield* runtimePolicy
        .resolve({ thread: projection.thread, modelSelection: state.run.modelSelection })
        .pipe(mapDispatchError(command));
      const checkpointScope = yield* checkpointService
        .prepareRootRunScope({
          threadId: command.threadId,
          runId: state.run.id,
          rootNodeId: state.rootNode.id,
          providerThreadId: state.providerThread.id,
          cwd: resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath ?? process.cwd(),
          createdAt: now,
        })
        .pipe(mapDispatchError(command));
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "checkpoint-scope.created",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: checkpointScope,
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.rootNode, checkpointScopeId: checkpointScope.id },
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...state.preparationItem,
          status: "completed",
          title: "Workspace ready",
          output: command.setupNotice ?? "Workspace preparation completed.",
          ...(command.setupNotice === undefined ? {} : { outputIndicatesFailure: true }),
          exitCode: 0,
          completedAt: now,
          updatedAt: now,
        },
      });
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.run, status: "starting" },
      });
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:provider-turn.start:${state.run.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: { type: "provider-turn.start", runId: state.run.id },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    });

  const dispatchPreparedRunFail = (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.fail" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(
        command,
        ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
        {
          runIds: [command.runId],
          attemptRunIds: [command.runId],
          nodeRunIds: [command.runId],
          turnItemTypes: ["command_execution"],
          turnItemRunId: command.runId,
        },
      );
      const state = preparedRunState(command, projection);
      if (state === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not awaiting workspace preparation.`,
        });
      }
      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "run-attempt.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.attempt, status: "failed", completedAt: now },
      });
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.rootNode, status: "failed", completedAt: now },
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: {
          ...state.preparationItem,
          status: "failed",
          title: "Workspace preparation failed",
          output: command.failure.message,
          exitCode: 1,
          completedAt: now,
          updatedAt: now,
        },
      });
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: {
          id: idAllocator.derive.turnItemFromProviderItem({
            driver: state.providerThread.driver,
            nativeItemId: `workspace-preparation-failure:${state.run.id}`,
          }),
          threadId: command.threadId,
          runId: state.run.id,
          nodeId: state.rootNode.id,
          providerThreadId: state.providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: yield* nextTurnItemOrdinal(projection),
          status: "failed",
          title: "Workspace preparation failed",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure: {
            ...command.failure,
            code: ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
          },
        },
      });
      yield* emitEvent({
        type: "run.updated",
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
        payload: { ...state.run, status: "failed", completedAt: now },
      });
    });

  /**
   * Returns a run whose workspace preparation failed to preparing. The failure
   * item turns cancelled so clients stop offering the retry; ThreadLaunchService
   * runs the recorded preparation again once this commits.
   */
  const dispatchPreparedRunRetry = (
    command: Extract<OrchestrationV2Command, { readonly type: "prepared-run.retry" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(
        command,
        ["runs", "attempts", "nodes", "providerThreads", "turnItems"],
        {
          attemptRunIds: [command.runId],
          nodeRunIds: [command.runId],
          turnItemTypes: ["command_execution", "error"],
          turnItemRunId: command.runId,
        },
      );
      const state = preparedRunState(command, projection);
      const failureItem = projection.turnItems.find(
        (candidate): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "error" }> =>
          candidate.type === "error" &&
          candidate.status === "failed" &&
          candidate.failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
      );
      if (
        state === null ||
        state.run.workspacePreparation === undefined ||
        failureItem === undefined ||
        projection.thread.archivedAt !== null ||
        projection.thread.deletedAt !== null
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} has no failed workspace preparation to retry.`,
        });
      }
      if (projection.runs.some((run) => run.id !== state.run.id && isBlockingRun(run))) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Another run is active on this thread.",
        });
      }
      const now = yield* DateTime.now;
      const emitEvent = emit(events, command);
      const scope = {
        threadId: command.threadId,
        runId: state.run.id,
        nodeId: state.rootNode.id,
        providerInstanceId: state.run.providerInstanceId,
        occurredAt: now,
      };
      yield* emitEvent({
        ...scope,
        type: "turn-item.updated",
        payload: { ...failureItem, status: "cancelled", updatedAt: now },
      });
      yield* emitEvent({
        ...scope,
        type: "turn-item.updated",
        payload: {
          ...withoutPreparationResult(state.preparationItem),
          status: "running",
          title: WORKSPACE_PREPARATION_INPUT,
          completedAt: null,
          updatedAt: now,
        },
      });
      yield* emitEvent({
        ...scope,
        type: "run-attempt.updated",
        payload: { ...state.attempt, status: "pending", completedAt: null },
      });
      yield* emitEvent({
        ...scope,
        type: "node.updated",
        payload: { ...state.rootNode, status: "pending", completedAt: null },
      });
      yield* emitEvent({
        ...scope,
        type: "run.updated",
        payload: { ...state.run, status: "preparing", completedAt: null },
      });
      // Messages held when this preparation failed follow the run again. A hold
      // from a later run (a stop, say) is not this failure's to release.
      const failureOwnsQueue = latestExecutedRun(projection.runs)?.id === state.run.id;
      for (const run of projection.runs) {
        if (!failureOwnsQueue || run.status !== "queued" || run.queueHeld !== true) continue;
        yield* emitEvent({
          type: "run.updated",
          threadId: command.threadId,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, queueHeld: false },
        });
      }
    });

  /**
   * Ends the background work a settled thread still shows that no provider
   * process will report on: work on the provider thread whose interrupt just
   * returned (`stoppedProviderThreadId`), and work on provider threads with no
   * live session at all. Only the stopped run's work and older runs' is ended
   * (`throughRunOrdinal`); a later run's work is its own. A dead process's
   * roster goes too, as on restart.
   */
  const settleBackgroundWork = (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.background-work.settle" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "runs" | "nodes" | "subagents" | "turnItems" | "providerThreads"
    >;
    readonly movingAccount?: boolean;
    readonly stoppedProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
    readonly throughRunOrdinal: number;
    readonly now: DateTime.Utc;
  }) =>
    Effect.gen(function* () {
      const emitEvent = emit(input.events, input.command);
      const runOrdinals = new Map(input.projection.runs.map((run) => [run.id, run.ordinal]));
      const allocateEventId = () =>
        idAllocator.allocate.event({
          threadId: input.command.threadId,
          commandId: input.command.commandId,
        });
      const childThreadIds = new Set<ThreadId>();
      const liveness = new Map<string, boolean>();
      const hasLiveSession = (providerThreadId: OrchestrationV2ProviderThread["id"]) =>
        Effect.gen(function* () {
          const known = liveness.get(providerThreadId);
          if (known !== undefined) return known;
          const sessionId = input.projection.providerThreads.find(
            (candidate) => candidate.id === providerThreadId,
          )?.providerSessionId;
          const live =
            sessionId !== null &&
            sessionId !== undefined &&
            Option.isSome(
              yield* providerSessions
                .get(sessionId)
                .pipe(Effect.orElseSucceed(() => Option.none())),
            );
          liveness.set(providerThreadId, live);
          return live;
        });
      for (const item of pendingBackgroundTurnItems({
        turnItems: input.projection.turnItems,
        runs: input.projection.runs,
      })) {
        // Managed children own their lifecycle, independently of the provider process.
        if (item.type === "subagent" && item.origin === "app_owned") continue;
        // An item without a run counts as the stopped run's.
        const itemRunOrdinal = item.runId === null ? undefined : runOrdinals.get(item.runId);
        if (itemRunOrdinal !== undefined && itemRunOrdinal > input.throughRunOrdinal) continue;
        const providerThreadId = item.providerThreadId ?? null;
        if (
          providerThreadId !== null &&
          providerThreadId !== input.stoppedProviderThreadId &&
          (yield* hasLiveSession(providerThreadId))
        ) {
          continue;
        }
        const run = input.projection.runs.find((candidate) => candidate.id === item.runId);
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: input.command.threadId,
          ...(item.runId === null ? {} : { runId: item.runId }),
          ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
          ...(run === undefined ? {} : { providerInstanceId: run.providerInstanceId }),
          occurredAt: input.now,
          payload: {
            ...item,
            status: "interrupted",
            completedAt: input.now,
            updatedAt: input.now,
          },
        });
        if (item.type !== "subagent") continue;
        // A native subagent died with the process too: end its record, its own
        // thread's runless root turn, and the subagents it started there, which
        // a provider can record on that thread rather than this one.
        const dying: Array<{
          readonly projection: Pick<
            OrchestrationV2ThreadProjection,
            "nodes" | "subagents" | "turnItems"
          >;
          readonly subagent: Pick<
            Extract<OrchestrationV2TurnItem, { readonly type: "subagent" }>,
            "subagentId" | "origin" | "childThreadId" | "providerInstanceId"
          >;
        }> = [{ projection: input.projection, subagent: item }];
        for (const { projection, subagent } of dying) {
          const ended = yield* endOrphanedNativeSubagent({
            projection,
            subagentId: subagent.subagentId,
            status: "interrupted",
            now: input.now,
            emitted: yield* Ref.get(input.events),
            allocateEventId,
          }).pipe(mapDispatchError(input.command));
          yield* Ref.update(input.events, (events) => [...events, ...ended]);
          const childThreadId = subagent.childThreadId;
          if (
            subagent.origin !== "provider_native" ||
            childThreadId === null ||
            childThreadIds.has(childThreadId)
          ) {
            continue;
          }
          childThreadIds.add(childThreadId);
          const child = yield* projectionStore
            .getThreadRecords(childThreadId, ["nodes", "providerTurns", "subagents", "turnItems"], {
              // Runless items are the subagent's; any run there is the user's own.
              liveNodesOnly: true,
              turnItemRunIds: [null],
              turnItemStatuses: ["pending", "running", "waiting"],
            })
            .pipe(
              Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
              mapDispatchError(input.command),
            );
          if (child === null) continue;
          const childEnded = yield* endRunlessRootTurns({
            threadId: childThreadId,
            providerInstanceId: subagent.providerInstanceId,
            projection: child,
            status: "interrupted",
            now: input.now,
            emitted: yield* Ref.get(input.events),
            allocateEventId,
          }).pipe(mapDispatchError(input.command));
          yield* Ref.update(input.events, (events) => [...events, ...childEnded]);
          for (const nested of child.turnItems) {
            if (nested.type === "subagent") dying.push({ projection: child, subagent: nested });
          }
          // Workflow members have records and child roots without subagent turn items.
          for (const nested of child.subagents) {
            if (nested.origin === "provider_native" && nested.runId === null) {
              dying.push({
                projection: child,
                subagent: {
                  subagentId: nested.id,
                  origin: nested.origin,
                  childThreadId: nested.childThreadId,
                  providerInstanceId: nested.providerInstanceId,
                },
              });
            }
          }
        }
      }
      for (const providerThread of input.projection.providerThreads) {
        // A live process owns its roster and reports clearing it.
        if (
          (providerThread.pendingBackgroundTasks?.length ?? 0) === 0 ||
          (!(input.movingAccount && providerThread.id === input.stoppedProviderThreadId) &&
            (yield* hasLiveSession(providerThread.id)))
        ) {
          continue;
        }
        yield* emitEvent({
          type: "provider-thread.updated",
          threadId: input.command.threadId,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: input.now,
          payload: {
            ...providerThread,
            status:
              providerThread.status === "active" &&
              providerThread.lastRunOrdinal !== null &&
              providerThread.lastRunOrdinal <= input.throughRunOrdinal
                ? "idle"
                : providerThread.status,
            pendingBackgroundTasks: [],
            updatedAt: input.now,
          },
        });
      }
    });

  // A successful Stop may have no terminal event to ingest: the session or
  // native turn already died, or its final write failed when storage filled.
  const settleInterruptedRun = (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.background-work.settle" }
    >;
    readonly forAccountMove?: boolean;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      | "runs"
      | "attempts"
      | "nodes"
      | "subagents"
      | "runtimeRequests"
      | "messages"
      | "turnItems"
      | "providerThreads"
    >;
    readonly providerTurn: OrchestrationV2ProviderTurn;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>;
    readonly now: DateTime.Utc;
  }) =>
    Effect.gen(function* () {
      const attempt = input.projection.attempts.find(
        (candidate) => candidate.id === input.providerTurn.runAttemptId,
      );
      const run = input.projection.runs.find((candidate) => candidate.id === attempt?.runId);
      const rootNode = input.projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
      if (
        attempt === undefined ||
        run === undefined ||
        rootNode === undefined ||
        run.activeAttemptId !== attempt.id ||
        !(
          (run.status === "running" && attempt.status === "running") ||
          (input.forAccountMove && ["waiting", "completed", "cancelled"].includes(run.status))
        )
      )
        return;
      const emitEvent = emit(input.events, input.command);
      const base = {
        threadId: input.command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: input.now,
      };
      if (
        input.providerTurn.status === "running" ||
        (input.forAccountMove &&
          (input.providerTurn.status === "failed" || input.providerTurn.status === "cancelled"))
      ) {
        yield* emitEvent({
          ...base,
          type: "provider-turn.updated",
          payload: {
            ...input.providerTurn,
            status: "interrupted",
            completedAt: input.now,
          },
        });
      }
      yield* emitEvent({
        ...base,
        type: "run-attempt.updated",
        payload: {
          ...attempt,
          status: "interrupted",
          completedAt: input.now,
        },
      });
      const providerThread = input.projection.providerThreads.find(
        (candidate) => candidate.id === input.providerTurn.providerThreadId,
      );
      if (providerThread?.status === "active" && providerThread.lastRunOrdinal === run.ordinal) {
        yield* emitEvent({
          ...base,
          type: "provider-thread.updated",
          payload: { ...providerThread, status: "idle", updatedAt: input.now },
        });
      }
      for (const message of input.projection.messages) {
        if (message.runId !== run.id || !message.streaming) continue;
        yield* emitEvent({
          ...base,
          ...(message.nodeId === null ? {} : { nodeId: message.nodeId }),
          type: "message.updated",
          payload: { ...message, streaming: false, updatedAt: input.now },
        });
      }
      const delegatedNodeIds = new Set(
        input.projection.subagents
          .filter((subagent) => subagent.origin === "app_owned")
          .map((subagent) => subagent.id),
      );
      // Callers load only tool and message items; the request cards close with the requests below.
      const requestCards = yield* projectionStore
        .getThreadRecords(run.threadId, ["turnItems"], {
          turnItemTypes: ["approval_request", "user_input_request"],
          turnItemRunIds: [run.id],
          turnItemStatuses: ["waiting"],
        })
        .pipe(mapDispatchError(input.command));
      const cascaded = yield* RunExecutionService.cascadeTerminalizeRunOwnedSubagents({
        run,
        status: "interrupted",
        completedAt: input.now,
        allocateEventId: () =>
          idAllocator.allocate.event({
            threadId: input.command.threadId,
            commandId: input.command.commandId,
          }),
        open: {
          subagents: new Map(
            input.projection.subagents
              .filter((task) => task.runId === run.id && task.origin !== "app_owned")
              .map((task) => [task.id, task]),
          ),
          nodes: new Map(
            input.projection.nodes
              .filter((node) => node.runId === run.id && !delegatedNodeIds.has(node.id))
              .map((node) => [node.id, node]),
          ),
          turnItems: new Map(),
          childTurnItems: new Map(
            [
              ...input.projection.turnItems.filter(
                (item) =>
                  item.runId === run.id &&
                  (item.type === "assistant_message" || item.type === "reasoning"),
              ),
              ...requestCards.turnItems,
            ].map((item) => [item.id, item]),
          ),
          linkedChildThreadIds: new Set([run.threadId]),
        },
      }).pipe(mapDispatchError(input.command));
      yield* Ref.update(input.events, (events) => [...events, ...cascaded]);
      for (const request of input.projection.runtimeRequests) {
        if (
          request.status !== "pending" ||
          !input.projection.nodes.some(
            (node) => node.id === request.nodeId && node.runId === run.id,
          )
        )
          continue;
        yield* emitEvent({
          ...base,
          nodeId: request.nodeId,
          type: "runtime-request.updated",
          payload: {
            ...request,
            status: "cancelled",
            resolvedAt: input.now,
            responseCapability: { type: "not_resumable", reason: "The run was interrupted." },
          },
        });
      }
      if (providerThread !== undefined) {
        yield* emitEvent({
          ...base,
          type: "turn-item.updated",
          payload: RunExecutionService.makeInterruptResultTurnItem({
            idAllocator,
            run,
            rootNode,
            providerThread,
            completedAt: input.now,
          }),
        });
      }
      const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } = run;
      yield* emitEvent({
        ...base,
        type: "run.updated",
        payload: {
          ...runWithoutDelegatedCompletion,
          status: "interrupted",
          completedAt: input.now,
        },
      });
      const scopeId = rootNode.checkpointScopeId;
      if (scopeId !== null) {
        yield* Ref.update(input.effects, (effects) => [
          ...effects,
          {
            id: `effect:checkpoint.capture:${run.id}`,
            commandId: CommandId.make(`command:effect:checkpoint.capture:${run.id}`),
            threadId: input.command.threadId,
            request: {
              type: "checkpoint.capture",
              runId: run.id,
              scopeId,
            },
          } satisfies PendingOrchestrationEffectV2,
        ]);
      }
    });

  /**
   * Whether Stop reached a run, as its interrupt request records. Its agent can call tools
   * until the provider stops it, and a slow call can land after that, but nothing it starts
   * may outlive the Stop. A restart continuation of that run must not start either.
   */
  const stopReachedRun = (
    command: OrchestrationV2ServerCommand,
    threadId: ThreadId,
    runId: RunId,
  ) =>
    projectionStore
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemTypes: ["run_interrupt_request"],
        turnItemRunIds: [runId],
      })
      .pipe(
        Effect.map(({ turnItems }) =>
          turnItems.some((item) => item.type === "run_interrupt_request" && !item.forAccountMove),
        ),
        mapDispatchError(command),
      );

  /** Records Stop for a run without replacing a marker already written by its interrupt. */
  const markStoppedRun = Effect.fnUntraced(function* (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.stop" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly thread: OrchestrationV2AppThread;
    readonly run: OrchestrationV2Run;
    readonly now: DateTime.Utc;
  }) {
    const { command, events, thread, run, now } = input;
    if (run.rootNodeId === null || run.providerThreadId === null) return;
    const pendingItems = (yield* Ref.get(events)).flatMap((event) =>
      event.type === "turn-item.updated" ? [event.payload] : [],
    );
    if (
      pendingItems.some((item) => item.runId === run.id && item.type === "run_interrupt_request") ||
      (yield* stopReachedRun(command, thread.id, run.id))
    ) {
      return;
    }
    yield* emit(
      events,
      command,
    )({
      type: "turn-item.updated",
      threadId: thread.id,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerInstanceId: run.providerInstanceId,
      occurredAt: now,
      payload: {
        id: idAllocator.derive.runSignalTurnItem({ runId: run.id, signal: "interrupt-request" }),
        threadId: thread.id,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal({ thread, turnItems: pendingItems }),
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        message: command.reason ?? "Interrupt requested",
      },
    });
  });

  /**
   * What Stop holds besides the run it interrupts: durable queued messages wait for the
   * user, buffered provider wakes are cancelled, and the thread's pull request watches end.
   * Every wake its delegated tasks still owe is dropped, since Stop stops those tasks too.
   * `cohortRunIds` are dropped even when they owe nothing, like a plain interrupt's.
   */
  const holdStoppedThread = (input: {
    readonly command: Extract<
      OrchestrationV2ServerCommand,
      { readonly type: "run.interrupt" | "thread.stop" }
    >;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "subagents">;
    readonly cohortRunIds: ReadonlyArray<RunId>;
    readonly now: DateTime.Utc;
  }) =>
    Effect.gen(function* () {
      const emitEvent = emit(input.events, input.command);
      const { thread, runs, subagents } = input.projection;
      const queuedRuns = runs.filter((run) => run.status === "queued");
      const queuedMessages =
        queuedRuns.length === 0
          ? []
          : (yield* projectionStore
              .getThreadRecords(thread.id, ["messages"], {
                messageIds: queuedRuns.map((run) => run.userMessageId),
                unorderedMessages: true,
              })
              .pipe(
                Effect.mapError(
                  (cause) => new OrchestratorProjectionError({ threadId: thread.id, cause }),
                ),
              )).messages;
      const bufferedMessageIds = new Set(
        queuedMessages
          .filter(
            (message) =>
              isBufferedProviderNotification(message) ||
              appOwnedMonitorGeneration(message) !== undefined,
          )
          .map((message) => message.id),
      );
      for (const run of runs) {
        yield* updateAutomaticProviderRetry(input.command, input.events, run, "cancelled");
        // A resumed queue can have a lower ordinal than a pending continuation source.
        // Stop must reach those sources even when interrupting the resumed run succeeds.
        if (
          run.status === "cancelled" &&
          (yield* awaitsRestartContinuation(run).pipe(mapDispatchError(input.command)))
        ) {
          yield* markStoppedRun({ ...input, thread, run });
        }
        if (run.status !== "queued") continue;
        // Stop discards provider buffers and ends app-owned monitors, so their wakes cannot resume.
        if (bufferedMessageIds.has(run.userMessageId)) {
          yield* dispatchQueuedRunCancel(
            {
              type: "queued-run.cancel",
              commandId: input.command.commandId,
              threadId: thread.id,
              runId: run.id,
            },
            input.events,
          );
          continue;
        }
        if (run.queueHeld === true) continue;
        yield* emitEvent({
          type: "run.updated",
          threadId: thread.id,
          runId: run.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: input.now,
          payload: { ...run, queueHeld: true },
        });
      }
      const pullRequests = thread.pullRequests ?? [];
      if (pullRequests.some((link) => link.watch !== undefined)) {
        yield* emitEvent({
          type: "thread.pull-request-synced",
          threadId: thread.id,
          providerInstanceId: thread.providerInstanceId,
          occurredAt: input.now,
          payload: {
            ...thread,
            pullRequests: pullRequests.map((link) => withPullRequestWatch(link, undefined)),
          },
        });
      }
      const cohortRunIds = new Set(input.cohortRunIds);
      for (const run of runs) {
        if (run.delegatedCompletion?.delivery != null) cohortRunIds.add(run.id);
      }
      for (const task of subagents) {
        const delivery = task.completionDelivery?.state;
        if (
          task.origin === "app_owned" &&
          task.runId !== null &&
          delivery !== "acknowledged" &&
          delivery !== "delivered" &&
          delivery !== "disposed"
        ) {
          cohortRunIds.add(task.runId);
        }
      }
      // Each disposal reads the events the ones before it wrote.
      for (const parentRunId of cohortRunIds) {
        if (!hasDelegatedCohort(input.projection, parentRunId)) continue;
        yield* disposeDelegatedCompletionCohort({
          command: input.command,
          events: input.events,
          projection: yield* getDelegatedCohortProjectionWithPendingEvents(thread.id, input.events),
          parentRunId,
          disposition: "stopped",
          now: input.now,
        });
      }
    });

  const dispatchBackgroundWorkSettle = (
    command: Extract<
      OrchestrationV2InternalCommand,
      { readonly type: "thread.background-work.settle" }
    >,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const [projection, stopped] = yield* Effect.all([
        projectionStore.getThreadRecords(
          command.threadId,
          [
            "runs",
            "attempts",
            "nodes",
            "subagents",
            "runtimeRequests",
            "turnItems",
            "providerThreads",
          ],
          {
            turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
            turnItemStatuses: ["pending", "running", "waiting"],
            liveNodesOnly: true,
            pendingRuntimeRequestsOnly: true,
          },
        ),
        projectionStore.getProviderControlContext(command.threadId, {
          providerThreadId: command.providerThreadId,
          providerTurnId: command.providerTurnId,
        }),
      ]).pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
      if (command.subagent !== undefined) {
        const outcome = command.subagent.outcome;
        const subagent = projection.subagents.find((task) => task.id === command.subagent?.id);
        if (
          subagent?.origin !== "provider_native" ||
          !["pending", "running", "waiting"].includes(subagent.status) ||
          (subagent.startedAt !== null &&
            DateTime.toEpochMillis(subagent.startedAt) >
              DateTime.toEpochMillis(command.subagent.stoppedAt))
        )
          return;
        const now = yield* DateTime.now;
        const allocateEventId = () =>
          idAllocator.allocate.event({
            threadId: command.threadId,
            commandId: command.commandId,
          });
        const ended = yield* endOrphanedNativeSubagent({
          projection,
          subagentId: subagent.id,
          result: outcome.result,
          status: outcome.status,
          completedAt: outcome.completedAt,
          now,
          emitted: yield* Ref.get(events),
          allocateEventId,
        }).pipe(mapDispatchError(command));
        yield* Ref.update(events, (current) => [...current, ...ended]);
        if (subagent.childThreadId !== null) {
          const child = yield* projectionStore
            .getThreadRecords(subagent.childThreadId, ["nodes", "providerTurns", "turnItems"], {
              liveNodesOnly: true,
              turnItemRunIds: [null],
              turnItemStatuses: ["pending", "running", "waiting"],
            })
            .pipe(
              Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
              mapDispatchError(command),
            );
          if (child !== null) {
            const childEnded = yield* endRunlessRootTurns({
              threadId: subagent.childThreadId,
              providerInstanceId: subagent.providerInstanceId,
              projection: child,
              status: outcome.status,
              completedAt: outcome.completedAt,
              now,
              emitted: yield* Ref.get(events),
              allocateEventId,
            }).pipe(mapDispatchError(command));
            yield* Ref.update(events, (current) => [...current, ...childEnded]);
          }
        }
        return;
      }
      const stoppedRunId = projection.attempts.find(
        (attempt) => attempt.id === stopped.providerTurn?.runAttemptId,
      )?.runId;
      const stoppedRun = projection.runs.find((run) => run.id === stoppedRunId);
      if (
        stoppedRun === undefined ||
        (["preparing", "starting", "running"].includes(stoppedRun.status) &&
          stoppedRun.activeAttemptId !== stopped.providerTurn?.runAttemptId)
      )
        return;
      const now = yield* DateTime.now;
      const move = yield* EffectOutbox.pendingAccountMove(effectOutbox, stoppedRun.id).pipe(
        mapDispatchError(command),
      );
      const moving = move !== undefined;
      if (
        stopped.providerTurn !== undefined &&
        (stoppedRun.status === "running" ||
          (moving && stoppedRun.status === "cancelled") ||
          // A turn that finished before the move's interrupt reached it keeps its outcome.
          (move?.settled === true && ["waiting", "completed"].includes(stoppedRun.status)))
      ) {
        const output = yield* projectionStore
          .getThreadRecords(command.threadId, ["messages", "nodes", "turnItems"], {
            messageRunIds: [stoppedRun.id],
            messageRoles: ["assistant"],
            unorderedMessages: true,
            nodeRunIds: [stoppedRun.id],
            turnItemRunIds: [stoppedRun.id],
            turnItemTypes: ["assistant_message", "reasoning"],
            turnItemStatuses: ["pending", "running", "waiting"],
          })
          .pipe(mapDispatchError(command));
        yield* settleInterruptedRun({
          command,
          projection: {
            ...projection,
            messages: output.messages,
            nodes: output.nodes,
            turnItems: [...projection.turnItems, ...output.turnItems].toSorted(
              (left, right) =>
                left.ordinal - right.ordinal ||
                (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
            ),
          },
          providerTurn: stopped.providerTurn,
          forAccountMove: moving,
          events,
          effects,
          now,
        });
      }
      // A new turn may have started since Stop; its work is not this Stop's.
      if (
        projection.runs.some(
          (run) =>
            run.id !== stoppedRun.id &&
            (run.status === "preparing" || run.status === "starting" || run.status === "running"),
        )
      ) {
        return;
      }
      yield* settleBackgroundWork({
        command,
        events,
        projection,
        movingAccount: moving,
        stoppedProviderThreadId: command.providerThreadId,
        throughRunOrdinal: stoppedRun.ordinal,
        now,
      });
    });

  const dispatchSubagentStop = (
    command: Extract<OrchestrationV2Command, { readonly type: "subagent.stop" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(command, [
        "runs",
        "subagents",
        "providerThreads",
        "providerTurns",
      ]);
      const run = projection.runs.find((candidate) => candidate.id === command.runId);
      const subagent = projection.subagents.find(
        (candidate) => candidate.id === command.subagentId,
      );
      if (
        subagent === undefined ||
        subagent.runId !== command.runId ||
        subagent.origin !== "provider_native" ||
        subagent.driver !== "claudeAgent" ||
        subagent.nativeTaskRef?.strength !== "strong" ||
        subagent.nativeTaskRef.nativeId === null
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The requested native subagent cannot be stopped on this run.",
        });
      }
      if (!["pending", "running", "waiting"].includes(subagent.status)) return;
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run?.providerThreadId,
      );
      const providerTurn = projection.providerTurns.findLast(
        (candidate) => candidate.providerThreadId === providerThread?.id,
      );
      if (
        providerThread?.providerSessionId == null ||
        providerTurn === undefined ||
        providerThread.driver !== subagent.driver ||
        providerThread.providerInstanceId !== subagent.providerInstanceId
      ) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The requested native subagent has no owning provider session.",
        });
      }
      const providerSessionId = providerThread.providerSessionId;
      const nativeTaskId = subagent.nativeTaskRef.nativeId;
      const now = yield* DateTime.now;
      // The effect can repair stale projections only after the provider confirms an outcome.
      yield* emit(
        events,
        command,
      )({
        type: "subagent.updated",
        threadId: command.threadId,
        runId: command.runId,
        nodeId: subagent.id,
        providerInstanceId: subagent.providerInstanceId,
        occurredAt: now,
        payload: { ...subagent, updatedAt: now },
      });
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:subagent.stop:${subagent.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "provider-turn.interrupt",
            providerSessionId,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
            subagent: { id: subagent.id, nativeTaskId },
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
      return;
    });

  const dispatchRunInterrupt = (
    command: Extract<OrchestrationV2Command, { readonly type: "run.interrupt" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
    forAccountMove = false,
  ) =>
    Effect.gen(function* () {
      const threadRecords = yield* loadProjectionForCommand(
        command,
        [
          "runs",
          "providerThreads",
          "providerTurns",
          "attempts",
          "turnItems",
          "subagents",
          "runtimeRequests",
        ],
        // Thread-wide, like the Waiting strip: a settled thread's background
        // work can belong to an earlier run than the one Stop targets.
        {
          turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
          turnItemStatuses: ["pending", "running", "waiting"],
          pendingRuntimeRequestsOnly: true,
        },
      );
      let run = threadRecords.runs.find((candidate) => candidate.id === command.runId);
      if (command.sendQueuedRunId !== undefined) {
        if (
          command.keepHelpers !== true ||
          command.holdQueue === true ||
          run?.status !== "running" ||
          (yield* stopReachedRun(command, command.threadId, run.id))
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "The active turn has changed. Check the queue and try again.",
          });
        }
        const queuedRun = threadRecords.runs.find(
          (candidate) => candidate.id === command.sendQueuedRunId && candidate.status === "queued",
        );
        const message =
          queuedRun === undefined
            ? undefined
            : (yield* loadProjectionForCommand(command, ["messages"], {
                messageIds: [queuedRun.userMessageId],
              })).messages[0];
        if (
          queuedRun === undefined ||
          message?.createdBy !== "user" ||
          message.notification !== undefined ||
          message.delegatedCompletion !== undefined ||
          threadRecords.runs.some(
            (run) => run.status === "queued" && (run.queueHeld === true || run.sendNext === true),
          )
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "This message is no longer ready to send from the queue.",
          });
        }
        yield* emit(
          events,
          command,
        )({
          type: "run.updated",
          threadId: command.threadId,
          runId: queuedRun.id,
          providerInstanceId: queuedRun.providerInstanceId,
          occurredAt: yield* DateTime.now,
          payload: { ...queuedRun, sendNext: true },
        });
      }
      if (
        !forAccountMove &&
        run !== undefined &&
        ((command.holdQueue === true &&
          command.keepHelpers !== true &&
          run.automaticProviderRetry?.status === "started") ||
          threadRecords.runs.some(
            (candidate) =>
              candidate.restartContinuationOfRunId === run?.id &&
              (candidate.accountMoveContinuation ||
                candidate.providerInstanceId !== run?.providerInstanceId),
          ))
      ) {
        // A client can press Stop on the pending source just as the scheduler
        // admits its continuation. Follow only that work's automatic lineage.
        const retryRunIds = new Set([run.id]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const candidate of threadRecords.runs) {
            const parent =
              candidate.providerRetryContinuationOfRunId ?? candidate.restartContinuationOfRunId;
            if (parent === undefined || !retryRunIds.has(parent) || retryRunIds.has(candidate.id))
              continue;
            retryRunIds.add(candidate.id);
            changed = true;
          }
        }
        const successor = threadRecords.runs.findLast(
          (candidate) =>
            retryRunIds.has(candidate.id) &&
            (candidate.status === "preparing" ||
              candidate.status === "starting" ||
              candidate.status === "running" ||
              candidate.status === "waiting" ||
              candidate.automaticProviderRetry?.status === "scheduled"),
        );
        const latest = latestExecutedRun(threadRecords.runs);
        if (
          successor !== undefined &&
          (latest === null || retryRunIds.has(latest.id) || !runRanAfter(latest, successor))
        ) {
          run = successor;
        }
      }
      if (run?.automaticProviderRetry?.status === "scheduled") {
        const now = yield* DateTime.now;
        yield* markStoppedRun({ command, events, thread: threadRecords.thread, run, now });
        if (command.holdQueue === true && command.keepHelpers !== true) {
          yield* holdStoppedThread({
            command,
            events,
            projection: threadRecords,
            cohortRunIds: [run.id],
            now,
          });
        } else if (command.keepHelpers !== true) {
          yield* updateAutomaticProviderRetry(command, events, run, "cancelled");
          if (hasDelegatedCohort(threadRecords, run.id))
            yield* disposeDelegatedCompletionCohort({
              command,
              events,
              projection: yield* getDelegatedCohortProjectionWithPendingEvents(
                command.threadId,
                events,
              ),
              parentRunId: run.id,
              disposition: "stopped",
              now,
            });
        }
        return undefined;
      }
      if (
        !forAccountMove &&
        run?.status === "interrupted" &&
        (yield* EffectOutbox.pendingAccountMove(effectOutbox, run.id).pipe(
          mapDispatchError(command),
        ))
      ) {
        const now = yield* DateTime.now;
        yield* markStoppedRun({ command, events, thread: threadRecords.thread, run, now });
        if (command.holdQueue)
          yield* holdStoppedThread({
            command,
            events,
            projection: threadRecords,
            cohortRunIds: [run.id],
            now,
          });
        return;
      }
      // Everything else Stop ends belongs to the run it stops.
      const runRecords =
        run === undefined
          ? { nodes: [], messages: [], turnItems: [] }
          : yield* loadProjectionForCommand(command, ["nodes", "messages", "turnItems"], {
              nodeRunIds: [run.id],
              messageRunIds: [run.id],
              unorderedMessages: true,
              turnItemRunIds: [run.id],
              turnItemTypes: ["assistant_message", "reasoning"],
              turnItemStatuses: ["pending", "running", "waiting"],
            });
      const projection = {
        ...threadRecords,
        nodes: runRecords.nodes,
        messages: runRecords.messages,
        // In the order one read of both slices returns them.
        turnItems: [...threadRecords.turnItems, ...runRecords.turnItems].toSorted(
          (left, right) =>
            left.ordinal - right.ordinal || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
        ),
      };
      const rootNode =
        run?.rootNodeId === null
          ? undefined
          : projection.nodes.find((candidate) => candidate.id === run?.rootNodeId);
      const providerThread =
        run?.providerThreadId === null
          ? undefined
          : projection.providerThreads.find((candidate) => candidate.id === run?.providerThreadId);
      const hasBackgroundWork =
        run !== undefined && backgroundWorkInterruptTarget(projection)?.id === run.id;
      // A failed start has no provider turn. Background work still belongs
      // to the provider thread, so Stop reaches its latest accepted turn.
      const providerTurn =
        projection.providerTurns.findLast(
          (candidate) =>
            candidate.runAttemptId === run?.activeAttemptId &&
            (forAccountMove ||
              run?.status === "running" ||
              candidate.status === "running" ||
              hasBackgroundWork),
        ) ??
        (hasBackgroundWork
          ? projection.providerTurns.findLast(
              (candidate) => candidate.providerThreadId === run?.providerThreadId,
            )
          : undefined);
      if (run === undefined || rootNode === undefined || providerThread === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not interruptible.`,
        });
      }
      const now = yield* DateTime.now;
      const completionMessage =
        projection.messages.find((candidate) => candidate.id === run.userMessageId) ??
        (yield* loadProjectionForCommand(command, ["messages"], {
          messageIds: [run.userMessageId],
        })).messages[0];
      const completionCohortRunId = completionMessage?.delegatedCompletion?.parentRunId ?? run.id;
      // Stop holds the rest of the thread too. A plain interrupt only drops the wakes owed by
      // this run's delegated tasks, or on a wake run, by the cohort that woke it.
      const stopRemainingWork = () =>
        command.keepHelpers === true
          ? Effect.void
          : command.holdQueue === true
            ? holdStoppedThread({
                command,
                events,
                projection,
                cohortRunIds: [completionCohortRunId],
                now,
              })
            : Effect.gen(function* () {
                if (!hasDelegatedCohort(threadRecords, completionCohortRunId)) return;
                yield* disposeDelegatedCompletionCohort({
                  command,
                  events,
                  projection: yield* getDelegatedCohortProjectionWithPendingEvents(
                    command.threadId,
                    events,
                  ),
                  parentRunId: completionCohortRunId,
                  disposition: "stopped",
                  now,
                });
              });

      const emitEvent = emit(events, command);
      const interruptRequestItem: OrchestrationV2TurnItem = {
        id: idAllocator.derive.runSignalTurnItem({
          runId: run.id,
          signal: "interrupt-request",
        }),
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerThreadId: providerThread.id,
        providerTurnId: providerTurn?.id ?? null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: yield* nextTurnItemOrdinal(projection),
        status: "completed",
        title: "Interrupt requested",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "run_interrupt_request",
        ...(forAccountMove ? { forAccountMove: true } : {}),
        message: command.reason ?? "Interrupt requested",
      };

      // Background work can outlive a provider switch, such as a Codex dev
      // server left running when the thread moved to Claude. Stop also reaches
      // each other live provider thread that owns pending work; that
      // interrupt's settle follow-up ends what its provider leaves behind.
      // Work on a dead session is settled with this run's below.
      const otherProviderInterrupts: Array<PendingOrchestrationEffectV2> = [];
      if (command.keepHelpers !== true && (hasBackgroundWork || command.holdQueue === true)) {
        const runOrdinals = new Map(
          projection.runs.map((candidate) => [candidate.id, candidate.ordinal]),
        );
        const runOrdinalOf = (item: (typeof projection.turnItems)[number]) =>
          item.runId === null ? -1 : (runOrdinals.get(item.runId) ?? -1);
        // Each provider thread is interrupted at its latest pending work: that
        // turn's run bounds the settle follow-up, which must cover all of the
        // thread's work. The target comes from the item's provider turn, since
        // a native subagent item names its own provider thread but its
        // parent's turn; interrupting the parent's turn reaches the subagent.
        const latestTurnByProviderThread = new Map<
          OrchestrationV2ProviderThread["id"],
          { readonly turn: (typeof projection.providerTurns)[number]; readonly runOrdinal: number }
        >();
        for (const item of pendingBackgroundTurnItems({
          turnItems: projection.turnItems,
          runs: projection.runs,
        })) {
          const turn = projection.providerTurns.find(
            (candidate) => candidate.id === item.providerTurnId,
          );
          if (turn === undefined || turn.providerThreadId === providerThread.id) continue;
          const runOrdinal = runOrdinalOf(item);
          const latest = latestTurnByProviderThread.get(turn.providerThreadId);
          if (latest === undefined || runOrdinal > latest.runOrdinal) {
            latestTurnByProviderThread.set(turn.providerThreadId, { turn, runOrdinal });
          }
        }
        for (const { turn } of latestTurnByProviderThread.values()) {
          const owner = projection.providerThreads.find(
            (candidate) => candidate.id === turn.providerThreadId,
          );
          if (owner === undefined || owner.providerSessionId === null) continue;
          const ownerSession = yield* providerSessions
            .get(owner.providerSessionId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(ownerSession)) continue;
          otherProviderInterrupts.push({
            id: `effect:${command.commandId}:provider-turn.interrupt:${turn.id}`,
            commandId: command.commandId,
            threadId: command.threadId,
            request: {
              type: "provider-turn.interrupt",
              providerSessionId: owner.providerSessionId,
              providerThreadId: owner.id,
              providerTurnId: turn.id,
            },
          });
        }
      }

      if (
        providerTurn === undefined &&
        (run.status === "preparing" || run.status === "starting" || run.status === "running")
      ) {
        const attempt = projection.attempts.find(
          (candidate) => candidate.id === run.activeAttemptId,
        );
        if (attempt === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Run ${command.runId} has no active attempt to interrupt.`,
          });
        }
        const interruptResultItem: OrchestrationV2TurnItem = {
          id: idAllocator.derive.runSignalTurnItem({
            runId: run.id,
            signal: "interrupt-result",
          }),
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: interruptRequestItem.id,
          ordinal: interruptRequestItem.ordinal + 1,
          status: "interrupted",
          title: "Interrupted",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "run_interrupt_result",
          message: "Run interrupted before provider start",
        };
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: interruptRequestItem,
        });
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: interruptResultItem,
        });
        const preparationItem = projection.turnItems.find(
          (
            candidate,
          ): candidate is Extract<
            OrchestrationV2TurnItem,
            { readonly type: "command_execution" }
          > =>
            candidate.runId === run.id &&
            candidate.type === "command_execution" &&
            candidate.input === WORKSPACE_PREPARATION_INPUT &&
            candidate.status === "running",
        );
        if (preparationItem !== undefined) {
          yield* emitEvent({
            type: "turn-item.updated",
            threadId: command.threadId,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              ...preparationItem,
              status: "interrupted",
              title: "Workspace preparation interrupted",
              output: command.reason ?? "Interrupted before provider start",
              completedAt: now,
              updatedAt: now,
            },
          });
        }
        yield* emitEvent({
          type: "run-attempt.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...attempt, status: "interrupted", completedAt: now },
        });
        yield* emitEvent({
          type: "node.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...rootNode, status: "interrupted", completedAt: now },
        });
        yield* emitEvent({
          type: "run.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: { ...run, status: "interrupted", completedAt: now },
        });
        // Stop cancels a pending restart, so it must end the turn that restart could not stop.
        const supersededTurn = projection.providerTurns.findLast(
          (candidate) =>
            candidate.status === "running" &&
            projection.attempts.some(
              (attempt) => attempt.id === candidate.runAttemptId && attempt.runId === run.id,
            ),
        );
        const supersededOwner =
          supersededTurn === undefined
            ? undefined
            : projection.providerThreads.find(
                (candidate) => candidate.id === supersededTurn.providerThreadId,
              );
        if (
          supersededTurn !== undefined &&
          supersededOwner !== undefined &&
          supersededOwner.providerSessionId !== null &&
          Option.isSome(
            yield* providerSessions
              .get(supersededOwner.providerSessionId)
              .pipe(Effect.orElseSucceed(() => Option.none())),
          )
        ) {
          const id = `effect:${command.commandId}:provider-turn.interrupt:${supersededTurn.id}`;
          if (!otherProviderInterrupts.some((effect) => effect.id === id)) {
            otherProviderInterrupts.push({
              id,
              commandId: command.commandId,
              threadId: command.threadId,
              request: {
                type: "provider-turn.interrupt",
                providerSessionId: supersededOwner.providerSessionId,
                providerThreadId: supersededOwner.id,
                providerTurnId: supersededTurn.id,
              },
            });
          }
        }
        yield* stopRemainingWork();
        yield* Ref.update(effects, (existing) => [...existing, ...otherProviderInterrupts]);
        return {
          effectTypes: ["provider-turn.start", "provider-turn.restart"],
          reason: `Run ${run.id} was interrupted before its provider turn started.`,
        } satisfies {
          readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
          readonly reason: string;
        };
      }

      if (providerTurn === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Run ${command.runId} is not interruptible.`,
        });
      }
      // A dead session cannot report a terminal event for either a running
      // turn or a settled turn's background work. Stop ends both locally.
      const sessionOption =
        providerThread.providerSessionId === null
          ? Option.none()
          : yield* providerSessions.get(providerThread.providerSessionId).pipe(
              Effect.mapError(
                (cause) =>
                  new OrchestratorProviderAdapterError({
                    commandId: command.commandId,
                    providerInstanceId: run.providerInstanceId,
                    cause,
                  }),
              ),
            );
      if (Option.isNone(sessionOption)) {
        yield* emitEvent({
          type: "turn-item.updated",
          threadId: command.threadId,
          runId: run.id,
          nodeId: rootNode.id,
          providerInstanceId: run.providerInstanceId,
          occurredAt: now,
          payload: interruptRequestItem,
        });
        yield* stopRemainingWork();
        yield* settleInterruptedRun({
          command,
          projection,
          providerTurn,
          events,
          effects,
          now,
          forAccountMove,
        });
        yield* settleBackgroundWork({
          command,
          events,
          projection,
          stoppedProviderThreadId: providerThread.id,
          throughRunOrdinal: run.ordinal,
          now,
        });
        yield* Ref.update(effects, (existing) => [...existing, ...otherProviderInterrupts]);
        return undefined;
      }
      if (providerThread.providerSessionId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Provider thread ${providerThread.id} has no active provider session.`,
        });
      }
      const providerSessionId = providerThread.providerSessionId;
      yield* enforceCommandPolicy(command)(
        commandPolicy.ensureInterrupt({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: run.providerInstanceId,
          capabilities: sessionOption.value.providerSession.capabilities,
        }),
      );

      // Open interrupt edge cases are tracked in https://github.com/pingdotgg/t3code/issues/15013.
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        runId: run.id,
        nodeId: rootNode.id,
        providerInstanceId: run.providerInstanceId,
        occurredAt: now,
        payload: interruptRequestItem,
      });
      yield* stopRemainingWork();
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:provider-turn.interrupt:${providerTurn.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "provider-turn.interrupt",
            providerSessionId,
            providerThreadId: providerThread.id,
            providerTurnId: providerTurn.id,
          },
        } satisfies PendingOrchestrationEffectV2,
        ...otherProviderInterrupts,
      ]);
      return undefined;
    });

  /**
   * Stop for a thread whatever it is doing, the way the Stop button stops the run it
   * shows: the running turn (or one whose background work is still pending) is interrupted,
   * and the rest of the thread is held. A turn that cannot be interrupted still leaves the
   * thread held. Stop also stops its delegated tasks once it commits.
   */
  const dispatchThreadStop = (
    command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.stop" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* projectionStore
        .getThreadRecords(command.threadId, ["runs", "providerThreads", "turnItems", "subagents"], {
          turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
          turnItemStatuses: ["pending", "running", "waiting"],
        })
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
          ),
        );
      if (projection.thread.deletedAt !== null) return undefined;
      // Queued after the interrupt, since a thread's effects run in order.
      const stopDelegatedTasks =
        command.stopDelegatedTasks === false ||
        !projection.subagents.some(
          (task) => task.origin === "app_owned" && task.childThreadId !== null,
        )
          ? Effect.void
          : Ref.update(effects, (existing) => [...existing, delegatedTasksStopEffect(command)]);
      const cancelContinuation = (existing?: {
        readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
        readonly reason: string;
      }) => ({
        effectTypes: [...(existing?.effectTypes ?? []), "provider-continuation.await" as const],
        reason: existing?.reason ?? command.reason ?? "Thread was stopped.",
      });
      const target =
        projection.runs.findLast(
          (run) =>
            run.status === "preparing" || run.status === "starting" || run.status === "running",
        ) ?? backgroundWorkInterruptTarget(projection);
      if (target !== undefined) {
        const interruptEvents = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
        const interruptEffects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
        const interrupted = yield* Effect.exit(
          dispatchRunInterrupt(
            {
              type: "run.interrupt",
              commandId: command.commandId,
              threadId: command.threadId,
              runId: target.id,
              holdQueue: true,
              ...(command.reason === undefined ? {} : { reason: command.reason }),
            },
            interruptEvents,
            interruptEffects,
          ),
        );
        // A failed interrupt may have written part of its events, so they are kept apart.
        if (Exit.isSuccess(interrupted)) {
          const written = yield* Ref.get(interruptEvents);
          const enqueued = yield* Ref.get(interruptEffects);
          yield* Ref.update(events, (existing) => [...existing, ...written]);
          yield* Ref.update(effects, (existing) => [...existing, ...enqueued]);
          yield* stopDelegatedTasks;
          return cancelContinuation(interrupted.value);
        }
        yield* Effect.logWarning("thread.stop could not interrupt the running turn", {
          threadId: command.threadId,
          runId: target.id,
          cause: interrupted.cause,
        });
      }
      const now = yield* DateTime.now;
      // Record that Stop reached the turn it could not interrupt and the thread's last executed
      // run, so a late tool call from their agent starts nothing.
      const executed = latestExecutedRun(projection.runs);
      const reached = new Map<RunId, OrchestrationV2Run>();
      if (target !== undefined) reached.set(target.id, target);
      if (executed !== null && !hasLiveRun({ runs: [executed] }))
        reached.set(executed.id, executed);
      for (const run of reached.values()) {
        yield* markStoppedRun({ command, events, thread: projection.thread, run, now });
      }
      yield* holdStoppedThread({ command, events, projection, cohortRunIds: [], now });
      yield* stopDelegatedTasks;
      return cancelContinuation();
    });

  const dispatchCheckpointRollback = (
    command: Extract<OrchestrationV2Command, { readonly type: "checkpoint.rollback" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    effects: Ref.Ref<Array<PendingOrchestrationEffectV2>>,
  ) =>
    Effect.gen(function* () {
      const projection = yield* loadProjectionForCommand(
        command,
        ["providerThreads", "checkpoints", "checkpointScopes", "runs", "providerTurns", "attempts"],
        { turnItemTypes: [], messageRoles: ["user"] },
      );
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === projection.thread.activeProviderThreadId,
      );
      if (providerThread === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "No active provider thread exists for rollback.",
        });
      }
      if (providerThread.providerSessionId === null) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Provider thread ${providerThread.id} has no provider session.`,
        });
      }

      const modelSelection = projection.thread.modelSelection;
      const capabilities = yield* providerAdapters.get(modelSelection.instanceId).pipe(
        Effect.flatMap((adapter) => adapter.getCapabilities()),
        Effect.mapError(
          (cause) =>
            new OrchestratorProviderAdapterError({
              commandId: command.commandId,
              providerInstanceId: modelSelection.instanceId,
              cause,
            }),
        ),
      );
      yield* enforceCommandPolicy(command)(
        commandPolicy.ensureRollback({
          commandId: command.commandId,
          threadId: command.threadId,
          providerInstanceId: modelSelection.instanceId,
          capabilities,
        }),
      );

      const targetCheckpoint = projection.checkpoints.find(
        (candidate) => candidate.id === command.checkpointId,
      );
      if (targetCheckpoint === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint ${command.checkpointId} was not found.`,
        });
      }
      // A missing checkpoint (workspace without git) still allows a
      // conversation-only rewind; files are never restored from it.
      if (targetCheckpoint.status !== "ready" && targetCheckpoint.status !== "missing") {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint ${command.checkpointId} is ${targetCheckpoint.status} and cannot be restored.`,
        });
      }
      const restoreFiles = targetCheckpoint.status === "ready" && command.restoreFiles !== false;
      const targetScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === targetCheckpoint.scopeId,
      );
      if (targetScope === undefined) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint scope ${targetCheckpoint.scopeId} was not found.`,
        });
      }
      if (targetScope.id !== command.scopeId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Checkpoint ${command.checkpointId} belongs to scope ${targetScope.id}, not ${command.scopeId}.`,
        });
      }
      if (restoreFiles) {
        const isolated = yield* isCheckpointRestoreIsolated(projection.thread, targetScope, {
          projects,
          path,
          fileSystem,
          projections: projectionStore,
        }).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause,
              }),
          ),
        );
        if (!isolated)
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: SHARED_WORKSPACE_RESTORE_MESSAGE,
          });
      }

      const targetOrdinal = targetCheckpoint.appRunOrdinal ?? 0;
      if (targetOrdinal > 0) {
        const targetRun = projection.runs.find((run) => run.ordinal === targetOrdinal);
        const targetProviderTurn =
          targetRun === undefined ? undefined : providerTurnForRun(projection, targetRun);
        if (targetRun === undefined || targetProviderTurn === undefined) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Cannot roll back to checkpoint ${targetCheckpoint.id}: its provider turn is unavailable.`,
          });
        }
        if (targetProviderTurn.providerThreadId !== providerThread.id) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Cannot roll back provider thread ${providerThread.id} to checkpoint ${targetCheckpoint.id}: target provider turn ${targetProviderTurn.id} belongs to provider thread ${targetProviderTurn.providerThreadId}.`,
          });
        }
      }

      const now = yield* DateTime.now;
      // This rollback becomes the only one whose failure the thread records.
      yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        providerInstanceId: projection.thread.providerInstanceId,
        occurredAt: now,
        payload: {
          ...projection.thread,
          rollbackRequestId: command.commandId,
          rollbackFailure: null,
          updatedAt: now,
        },
      });
      yield* emit(
        events,
        command,
      )({
        type: "checkpoint.rollback-requested",
        threadId: command.threadId,
        providerInstanceId: modelSelection.instanceId,
        occurredAt: now,
        payload: {
          scopeId: targetScope.id,
          checkpointId: targetCheckpoint.id,
          requestedAt: now,
        },
      });
      yield* Ref.update(effects, (existing) => [
        ...existing,
        {
          id: `effect:${command.commandId}:provider-thread.rollback:${providerThread.id}:${targetCheckpoint.id}`,
          commandId: command.commandId,
          threadId: command.threadId,
          request: {
            type: "provider-thread.rollback",
            ...(restoreFiles ? {} : { restoreFiles: false }),
            providerThreadId: providerThread.id,
            checkpointId: targetCheckpoint.id,
            scopeId: targetScope.id,
          },
        } satisfies PendingOrchestrationEffectV2,
      ]);
    });

  /**
   * Records a provider rollback that failed after every retry, so clients
   * waiting on it stop and show the reason. A newer rollback clears it, and a
   * late failure from a rollback it superseded is rejected.
   */
  const dispatchCheckpointRollbackFail = (
    command: Extract<OrchestrationV2InternalCommand, { readonly type: "checkpoint.rollback.fail" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) =>
    Effect.gen(function* () {
      const thread = yield* projectionStore
        .getThread(command.threadId)
        .pipe(mapDispatchError(command));
      if (thread.deletedAt !== null) return;
      if (thread.rollbackRequestId !== command.requestId) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: `Rollback ${command.requestId} is no longer the thread's current rollback.`,
        });
      }
      const now = yield* DateTime.now;
      yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        providerInstanceId: thread.providerInstanceId,
        occurredAt: now,
        payload: {
          ...thread,
          rollbackFailure: { requestId: command.requestId, message: command.message },
          updatedAt: now,
        },
      });
    });

  /**
   * Parent thread of an app-owned delegated child, or undefined when the
   * thread is not one. Thread lineage and fork origin are immutable, so this
   * is safe to read without holding either thread's dispatch lock.
   */
  const appOwnedSubagentParentThreadId = (childThreadId: ThreadId) =>
    Effect.gen(function* () {
      const childThread = yield* projectionStore.getThread(childThreadId);
      const lineage = childThread.lineage;
      return lineage.relationshipToParent === "subagent" &&
        lineage.parentEnvironmentId === undefined &&
        lineage.parentThreadId !== null &&
        childThread.forkedFrom?.type === "node"
        ? lineage.parentThreadId
        : undefined;
    });

  /**
   * A run with a pending restart continuation has no outcome yet: restart
   * reconciliation cancelled it mid-turn, or cancelled the background work a
   * settled turn was waiting on. The continuation's own run settles it, or
   * RestartContinuation recovers the thread when it declines to continue.
   */
  const awaitsRestartContinuation = (run: OrchestrationV2Run) =>
    effectOutbox
      .get(`effect:restart-continuation:${run.id}`)
      .pipe(
        Effect.map(
          Option.exists((effect) => effect.status === "pending" || effect.status === "running"),
        ),
      );

  /**
   * The agent may still continue this run by itself, in its grace: the run ended on a quiet
   * spell, or background work the agent hears back from ended after it.
   */
  const awaitsProviderContinuation = (run: OrchestrationV2Run) =>
    Effect.forEach(
      [`effect:provider-continuation:${run.id}`, backgroundWakeContinuationEffectId(run.id)],
      (effectId) =>
        effectOutbox
          .get(effectId)
          .pipe(
            Effect.map(
              Option.exists((effect) => effect.status === "pending" || effect.status === "running"),
            ),
          ),
    ).pipe(Effect.map((pending) => pending.includes(true)));

  /**
   * A delegated child's result is held while its result run, or a run after it
   * that a second restart cut before it started, still has a continuation pending:
   * a restart's, or one the agent starts by itself after a quiet end.
   */
  const childAwaitsContinuation = (
    runs: ReadonlyArray<OrchestrationV2Run>,
    resultRun: OrchestrationV2Run,
    settledContinuationOf?: RunId,
  ) =>
    Effect.forEach(
      runs.filter(
        (run) =>
          run.id !== settledContinuationOf &&
          (run.id === resultRun.id || runRanAfter(run, resultRun)),
      ),
      (run) =>
        awaitsRestartContinuation(run).pipe(
          Effect.flatMap((pending) =>
            pending ? Effect.succeed(true) : awaitsProviderContinuation(run),
          ),
        ),
    ).pipe(Effect.map((pending) => pending.includes(true)));

  const planDelegatedCompletionDelivery = Effect.fn(
    "orchestrationV2.planDelegatedCompletionDelivery",
  )(function* (input: {
    /** Messages are found by ID, so callers may read them unordered. */
    readonly parentProjection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "messages" | "runs" | "subagents"
    >;
    readonly parentRun: OrchestrationV2Run | undefined;
    readonly task: OrchestrationV2Subagent;
    readonly updatedTask: OrchestrationV2Subagent;
    readonly now: DateTime.Utc;
  }) {
    const taskDelivery = input.updatedTask.completionDelivery;
    // delivered ownership has already settled through a completed wake run.
    // A later wake-policy upgrade must not re-claim the task or offer again.
    if (
      taskDelivery?.state === "acknowledged" ||
      taskDelivery?.state === "delivered" ||
      taskDelivery?.state === "disposed" ||
      taskDelivery?.withNextTurn === true
    ) {
      return {
        task: input.updatedTask,
        parentRun: undefined,
        message: undefined,
        offer: false,
      };
    }
    const cohort = input.parentRun?.delegatedCompletion;
    if (
      input.parentRun === undefined ||
      input.parentProjection.thread.archivedAt !== null ||
      input.parentProjection.thread.deletedAt !== null ||
      (cohort !== undefined && cohort.disposition !== "open")
    ) {
      return {
        task: {
          ...input.updatedTask,
          completionDelivery: {
            state: "disposed" as const,
            observedByRunId: null,
          },
        },
        parentRun: undefined,
        message: undefined,
        offer: false,
      };
    }
    // settled_only defers to a blocking delegate_task wait, which lives only as
    // long as the turn that spawned the task. Once that turn is over (a restart
    // continues it as a new run), nothing else delivers the result.
    if (
      (input.task.completionWake ?? "settled_only") === "settled_only" &&
      hasLiveRun({ runs: [input.parentRun] })
    ) {
      return {
        task: input.updatedTask,
        parentRun: undefined,
        message: undefined,
        offer: false,
      };
    }

    const delivery = cohort?.delivery ?? null;
    const deliveryRun = completionDeliveryRun(input.parentProjection, delivery);
    if (delivery !== null) {
      if (deliveryRun?.status === "queued" && deliveryRun.userMessageId === delivery?.messageId) {
        const taskIds = Array.from(new Set([...delivery.taskIds, input.task.id]));
        const message = completionDeliveryMessage(input.parentProjection, delivery);
        const nextCohort = {
          ...cohort!,
          delivery: {
            ...delivery,
            taskIds,
          },
        };
        return {
          task: {
            ...input.updatedTask,
            completionDelivery: {
              state: "claimed" as const,
              observedByRunId: null,
            },
          },
          parentRun: {
            ...input.parentRun,
            delegatedCompletion: nextCohort,
          },
          message:
            message === undefined
              ? undefined
              : {
                  ...message,
                  text: delegatedCompletionWakeDetail(
                    taskIds,
                    [
                      input.updatedTask,
                      ...input.parentProjection.subagents.filter(
                        (task) => task.id !== input.task.id,
                      ),
                    ],
                    teamBoard?.completion,
                  ),
                  delegatedCompletion: {
                    parentRunId: input.parentRun.id,
                    generation: delivery.generation,
                    taskIds,
                  },
                  updatedAt: input.now,
                },
          offer: false,
        };
      }
      if (deliveryRun !== undefined && isBlockingRun(deliveryRun)) {
        return {
          task: {
            ...input.updatedTask,
            completionDelivery: {
              state: "pending" as const,
              observedByRunId: null,
            },
          },
          parentRun: undefined,
          message: undefined,
          offer: false,
        };
      }
      if (deliveryRun !== undefined) {
        // The terminal-run listener owns reconciliation of a completed wake.
        // A sibling that wins the parent lock first remains pending for the
        // successor that listener reserves, rather than creating a competing
        // delivery.
        return {
          task: {
            ...input.updatedTask,
            completionDelivery: {
              state: "pending" as const,
              observedByRunId: null,
            },
          },
          parentRun: undefined,
          message: undefined,
          offer: false,
        };
      }
      const taskIds = Array.from(new Set([...delivery.taskIds, input.task.id]));
      const nextCohort = {
        ...cohort!,
        delivery: {
          ...delivery,
          taskIds,
        },
      };
      return {
        task: {
          ...input.updatedTask,
          completionDelivery: {
            state: "claimed" as const,
            observedByRunId: null,
          },
        },
        parentRun: {
          ...input.parentRun,
          delegatedCompletion: nextCohort,
        },
        message: undefined,
        offer: true,
      };
    }

    const generation = cohort?.nextGeneration ?? 1;
    const messageId = yield* mapDelegatedCompletionError(
      idAllocator.allocate.message({
        threadId: input.parentRun.threadId,
        ordinal:
          (yield* mapDelegatedCompletionError(
            projectionStore.getMessageCount(input.parentRun.threadId),
          )) + 1,
      }),
    );
    const nextCohort = {
      disposition: "open" as const,
      nextGeneration: generation + 1,
      delivery: {
        generation,
        messageId,
        taskIds: [input.task.id],
      },
    };
    return {
      task: {
        ...input.updatedTask,
        completionDelivery: {
          state: "claimed" as const,
          observedByRunId: null,
        },
      },
      parentRun: {
        ...input.parentRun,
        delegatedCompletion: nextCohort,
      },
      message: undefined,
      offer: true,
    };
  });

  const dispatchRemoteSubagentSync = Effect.fn("orchestrationV2.dispatch.remoteSubagentSync")(
    function* (
      command: Extract<OrchestrationV2InternalCommand, { type: "delegated_task.remote.sync" }>,
      events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
    ) {
      // Only the task's own node and card. A task's run never changes, so its card is
      // among that run's items, and its delivery message is found by ID.
      const parentProjection = yield* projectionStore.getThreadRecords(
        command.threadId,
        ["runs", "messages", "subagents", "providerTurns", "nodes", "turnItems", "attempts"],
        {
          nodeIds: [command.task.id],
          turnItemRunIds: [command.task.runId],
          turnItemTypes: ["subagent"],
          messageRoles: ["user"],
          unorderedMessages: true,
        },
      );
      const previous = parentProjection.subagents.find((task) => task.id === command.task.id);
      if (
        command.task.threadId !== command.threadId ||
        command.task.origin !== "app_owned" ||
        command.task.remote === undefined ||
        command.task.childThreadId === null ||
        (previous !== undefined &&
          (previous.remote === undefined ||
            previous.childThreadId !== command.task.childThreadId ||
            previous.remote.environmentId !== command.task.remote.environmentId))
      )
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Invalid remote subagent record.",
        });
      if (previous !== undefined && isTerminalDelegatedTaskStatus(previous.status)) return;
      const now = yield* DateTime.now;
      const task: OrchestrationV2Subagent = {
        ...command.task,
        ...(previous === undefined
          ? {}
          : {
              runId: previous.runId,
              parentNodeId: previous.parentNodeId,
              completionWake: previous.completionWake,
              completionDelivery: previous.completionDelivery,
              startedAt: previous.startedAt,
            }),
        updatedAt: now,
      };
      const parentRun = parentProjection.runs.find((run) => run.id === task.runId);
      const completion = isTerminalDelegatedTaskStatus(task.status)
        ? yield* planDelegatedCompletionDelivery({
            parentProjection,
            parentRun,
            task: previous ?? task,
            updatedTask: task,
            now,
          })
        : { task, parentRun: undefined, message: undefined };
      const emitEvent = emit(events, command);
      yield* emitEvent({
        type: "subagent.updated",
        threadId: command.threadId,
        nodeId: task.id,
        ...(task.runId === null ? {} : { runId: task.runId }),
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: completion.task,
      });
      const existingNode = parentProjection.nodes.find((node) => node.id === task.id);
      yield* emitEvent({
        type: "node.updated",
        threadId: command.threadId,
        nodeId: task.id,
        ...(task.runId === null ? {} : { runId: task.runId }),
        driver: task.driver,
        occurredAt: now,
        payload: {
          id: task.id,
          threadId: command.threadId,
          runId: task.runId,
          parentNodeId: task.parentNodeId,
          rootNodeId: existingNode?.rootNodeId ?? parentRun?.rootNodeId ?? task.parentNodeId,
          kind: "subagent",
          status: task.status === "idle" ? "pending" : task.status,
          countsForRun: false,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
        },
      });
      const existingItem = parentProjection.turnItems.find(
        (item) => item.type === "subagent" && item.subagentId === task.id,
      );
      yield* emitEvent({
        type: "turn-item.updated",
        threadId: command.threadId,
        nodeId: task.id,
        ...(task.runId === null ? {} : { runId: task.runId }),
        driver: task.driver,
        occurredAt: now,
        payload: {
          id: existingItem?.id ?? TurnItemId.make(`turn-item:${task.id}`),
          threadId: command.threadId,
          runId: task.runId,
          nodeId: task.id,
          providerThreadId: parentRun?.providerThreadId ?? null,
          providerTurnId:
            parentRun === undefined
              ? null
              : (providerTurnForRun(parentProjection, parentRun)?.id ?? null),
          nativeItemRef: null,
          parentItemId: null,
          ordinal: existingItem?.ordinal ?? (yield* nextTurnItemOrdinal(parentProjection)),
          status: task.status === "idle" ? "pending" : task.status,
          title: task.title,
          startedAt: task.startedAt,
          completedAt: task.completedAt,
          updatedAt: now,
          type: "subagent",
          subagentId: task.id,
          origin: "app_owned",
          driver: task.driver,
          providerInstanceId: task.providerInstanceId,
          childThreadId: task.childThreadId,
          prompt: task.prompt,
          result: task.result,
        },
      });
      if (completion.parentRun !== undefined)
        yield* emitEvent({
          type: "run.updated",
          threadId: command.threadId,
          runId: completion.parentRun.id,
          providerInstanceId: completion.parentRun.providerInstanceId,
          occurredAt: now,
          payload: completion.parentRun,
        });
      if (completion.message !== undefined)
        yield* emitEvent({
          type: "message.updated",
          threadId: command.threadId,
          occurredAt: now,
          payload: completion.message,
        });
    },
  );

  /**
   * What the app saw a finishing task do, read once from its runs' records and its checkout's
   * Git log. Never fails the finalization: a fact that cannot be read is left out.
   */
  const seenForTask = (
    child: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
    parentWorktreePath: string | null,
    task: Pick<OrchestrationV2Subagent, "startedAt">,
    taskRuns: ReadonlyArray<OrchestrationV2Run>,
    now: DateTime.Utc,
  ) =>
    Effect.gen(function* () {
      const { turnItems } = yield* projectionStore.getThreadRecords(
        child.thread.id,
        ["turnItems"],
        {
          turnItemRunIds: taskRuns.map((run) => run.id),
          turnItemTypes: [...SEEN_TURN_ITEM_TYPES],
          messageRoles: [],
        },
      );
      const startedAt =
        task.startedAt ??
        taskRuns.reduce<DateTime.Utc | null>(
          (earliest, run) =>
            run.startedAt !== null &&
            (earliest === null || DateTime.isLessThan(run.startedAt, earliest))
              ? run.startedAt
              : earliest,
          null,
        );
      // Only its own checkout: in a shared one the lead's and other tasks' commits look the same.
      const cwd = ownSubagentCheckout(child.thread.worktreePath, parentWorktreePath, child.runs);
      const commits =
        Option.isNone(git) || startedAt === null || cwd === null
          ? []
          : yield* git.value
              .execute({
                operation: "subagent-seen-commits",
                cwd,
                args: commitsSinceArgs(DateTime.toEpochMillis(startedAt)),
                allowNonZeroExit: true,
                timeoutMs: 2_000,
                maxOutputBytes: 1_024,
              })
              .pipe(
                Effect.map((result) =>
                  Number(result.exitCode) === 0
                    ? result.stdout.split("\n").filter((line) => /^[0-9a-f]{4,}$/u.test(line))
                    : [],
                ),
                Effect.orElseSucceed(() => []),
              );
      return subagentSeen({
        turnItems,
        commits,
        seconds:
          startedAt === null
            ? null
            : (DateTime.toEpochMillis(now) - DateTime.toEpochMillis(startedAt)) / 1000,
      });
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to read what a subagent did", {
          threadId: child.thread.id,
          cause,
        }).pipe(Effect.as(undefined)),
      ),
    );

  /**
   * Transfers a terminal child's result into its parent and offers the parent
   * wake. Every mutation here targets the PARENT thread, so callers must hold
   * the parent thread's dispatch lock rather than the child's: the
   * delegated_task.wake-policy handler rewrites the same subagent row under
   * that lock with a full-row payload, and unserialized writers clobber each
   * other (stale policy on the terminal row, or a terminal row regressed to
   * running). `settledContinuationOf` names the restart continuation that just
   * declined or failed, so its own still-running effect does not hold the child.
   */
  const finalizeAppOwnedSubagentTask = (
    childControls: ProjectionRecords<
      "runs" | "messages" | "subagents" | "providerThreads" | "providerTurns" | "attempts"
    >,
    options: {
      readonly settledContinuationOf?: RunId;
      readonly task: Pick<OrchestrationV2Subagent, "id" | "runId">;
      readonly progress: ReturnType<typeof delegatedTaskProgressForTask>;
    },
  ) =>
    Effect.gen(function* () {
      const childThreadId = childControls.thread.id;
      const forkedFrom = childControls.thread.forkedFrom;
      if (
        childControls.thread.lineage.relationshipToParent !== "subagent" ||
        childControls.thread.lineage.parentEnvironmentId !== undefined ||
        childControls.thread.lineage.parentThreadId === null ||
        forkedFrom?.type !== "node"
      ) {
        return;
      }
      const taskRuns = options.progress.runs;
      const childRun = options.progress.resultRun;
      if (childRun === undefined) return;
      const outcome = runOutcome(childRun);
      const childTerminalStatus = delegatedTaskTerminalStatus(outcome);
      if (childTerminalStatus === null) {
        return;
      }
      if (yield* childAwaitsContinuation(taskRuns, childRun, options?.settledContinuationOf)) {
        return;
      }

      const childResult = yield* projectionStore.getThreadRecords(
        childThreadId,
        ["messages", "turnItems"],
        {
          messageRoles: ["assistant"],
          messageRunIds: [childRun.id],
          turnItemRunId: childRun.id,
          turnItemTypes: ["assistant_message", "error"],
        },
      );
      const childProjection = {
        ...childControls,
        messages: childResult.messages,
        turnItems: childResult.turnItems,
      };
      const parentThreadId = childControls.thread.lineage.parentThreadId;
      const parentProjection = yield* projectionStore.getThreadRecords(
        parentThreadId,
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "nodes",
          "turnItems",
          "contextTransfers",
        ],
        {
          nodeIds: [options.task.id],
          turnItemTypes: ["subagent"],
          turnItemRunIds: [options.task.runId],
          messageRoles: ["user"],
          unorderedMessages: true,
        },
      );
      const task = parentProjection.subagents.find(
        (candidate) =>
          candidate.id === options.task.id &&
          candidate.origin === "app_owned" &&
          candidate.remote === undefined &&
          candidate.childThreadId === childThreadId,
      );
      if (task === undefined) {
        return;
      }
      const existingResultTransfer = parentProjection.contextTransfers.find(
        (transfer) =>
          transfer.type === "subagent_result" &&
          transfer.sourceThreadId === childThreadId &&
          transfer.targetThreadId === parentThreadId &&
          (transfer.sourcePoint.runId === childRun.id ||
            (options.task.id === forkedFrom.nodeId && transfer.sourcePoint.runId === undefined)),
      );
      const terminalStatus = task.cancellationRequested ? "cancelled" : childTerminalStatus;
      if (existingResultTransfer !== undefined && task.result !== null) {
        return;
      }

      const now = yield* DateTime.now;
      const result = subagentResultForRun(childProjection, {
        ...childRun,
        status: task.cancellationRequested ? "cancelled" : outcome,
      });
      const seen =
        task.seen ??
        (yield* seenForTask(
          childControls,
          parentProjection.thread.worktreePath,
          task,
          taskRuns,
          now,
        ));
      const parentRun =
        task.runId === null
          ? undefined
          : parentProjection.runs.find((candidate) => candidate.id === task.runId);
      const parentNode = parentProjection.nodes.find((candidate) => candidate.id === task.id);
      const parentTurnItem = parentProjection.turnItems.find(
        (candidate) => candidate.type === "subagent" && candidate.subagentId === task.id,
      );
      const settledNodeEvents = [
        ...(parentNode === undefined
          ? []
          : [
              {
                type: "node.updated" as const,
                threadId: parentThreadId,
                ...(parentNode.runId === null ? {} : { runId: parentNode.runId }),
                nodeId: parentNode.id,
                driver: task.driver,
                occurredAt: now,
                payload: {
                  ...parentNode,
                  status: terminalStatus,
                  providerThreadId: childRun.providerThreadId,
                  completedAt: now,
                },
              },
            ]),
        ...(parentTurnItem === undefined
          ? []
          : [
              {
                type: "turn-item.updated" as const,
                threadId: parentThreadId,
                ...(parentTurnItem.runId === null ? {} : { runId: parentTurnItem.runId }),
                ...(parentTurnItem.nodeId === null ? {} : { nodeId: parentTurnItem.nodeId }),
                driver: task.driver,
                occurredAt: now,
                payload: {
                  ...parentTurnItem,
                  status: terminalStatus,
                  result: result.text,
                  completedAt: now,
                  updatedAt: now,
                },
              },
            ]),
      ];
      if (existingResultTransfer !== undefined) {
        // The parent already has this run's result, handed over for another
        // task that shares the run (a follow-up whose turn finished both), or
        // before the task itself was recorded. Settle the task without a
        // second handover, so it stops showing as working and recovery stops
        // revisiting it on every start.
        yield* writeSystemEvents([
          {
            type: "subagent.updated",
            threadId: parentThreadId,
            ...(task.runId === null ? {} : { runId: task.runId }),
            nodeId: task.id,
            driver: task.driver,
            occurredAt: now,
            payload: {
              ...task,
              providerThreadId: childRun.providerThreadId,
              status: terminalStatus,
              result: result.text,
              ...(seen === undefined ? {} : { seen }),
              completedAt: now,
              updatedAt: now,
            },
          },
          ...settledNodeEvents,
        ]);
        return true;
      }
      const updatedTask: OrchestrationV2Subagent = {
        ...task,
        providerThreadId: childRun.providerThreadId,
        status: terminalStatus,
        result: result.text,
        ...(seen === undefined ? {} : { seen }),
        completedAt: now,
        updatedAt: now,
      };
      const completionPlan = yield* planDelegatedCompletionDelivery({
        parentProjection,
        parentRun,
        task,
        updatedTask,
        now,
      });
      const resultTransferId = yield* idAllocator.allocate.contextTransfer({
        sourceThreadId: childThreadId,
        targetThreadId: parentThreadId,
        type: "subagent_result",
      });
      const childProviderThread =
        childRun.providerThreadId === null
          ? undefined
          : childProjection.providerThreads.find(
              (candidate) => candidate.id === childRun.providerThreadId,
            );
      const parentProviderThread =
        parentRun?.providerThreadId === null || parentRun?.providerThreadId === undefined
          ? undefined
          : parentProjection.providerThreads.find(
              (candidate) => candidate.id === parentRun.providerThreadId,
            );
      const resultHandoff: OrchestrationV2ContextHandoff | null =
        parentRun === undefined ||
        childProviderThread === undefined ||
        parentProviderThread === undefined
          ? null
          : {
              id: yield* idAllocator.allocate.contextHandoff({
                threadId: parentThreadId,
                fromProviderInstanceId: childRun.providerInstanceId,
                toProviderInstanceId: parentRun.providerInstanceId,
              }),
              transferId: resultTransferId,
              threadId: parentThreadId,
              targetRunId: parentRun.id,
              fromProviderThreadIds: [childProviderThread.id],
              toProviderThreadId: parentProviderThread.id,
              coveredRunOrdinals: {
                from: childRun.ordinal,
                to: childRun.ordinal,
              },
              strategy: "manual_context",
              status: "ready",
              summaryMessageId: result.messageId,
              summaryText: result.text,
              createdByProviderInstanceId: childRun.providerInstanceId,
              createdAt: now,
              updatedAt: now,
            };
      const resultTransfer: OrchestrationV2ContextTransfer = {
        id: resultTransferId,
        type: "subagent_result",
        sourceThreadId: childThreadId,
        targetThreadId: parentThreadId,
        sourcePoint: {
          ...contextSourcePointForRun(childProjection, childRun),
          ...(result.turnItemId === null ? {} : { turnItemId: result.turnItemId }),
        },
        basePoint: null,
        sourceProviderInstanceId: childRun.providerInstanceId,
        targetProviderInstanceId:
          parentRun?.providerInstanceId ?? parentProjection.thread.providerInstanceId,
        targetRunId: parentRun?.id ?? null,
        status: "consumed",
        resolution:
          resultHandoff === null
            ? null
            : {
                strategy: "portable_context",
                contextHandoffId: resultHandoff.id,
              },
        createdBy: "system",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: now,
      };

      yield* writeSystemEvents([
        {
          type: "subagent.updated",
          threadId: parentThreadId,
          ...(task.runId === null ? {} : { runId: task.runId }),
          nodeId: task.id,
          driver: task.driver,
          occurredAt: now,
          payload: completionPlan.task,
        },
        ...(completionPlan.parentRun === undefined
          ? []
          : [
              {
                type: "run.updated" as const,
                threadId: parentThreadId,
                runId: completionPlan.parentRun.id,
                ...(completionPlan.parentRun.rootNodeId === null
                  ? {}
                  : { nodeId: completionPlan.parentRun.rootNodeId }),
                providerInstanceId: completionPlan.parentRun.providerInstanceId,
                occurredAt: now,
                payload: completionPlan.parentRun,
              },
            ]),
        ...(completionPlan.message === undefined
          ? []
          : [
              {
                type: "message.updated" as const,
                threadId: parentThreadId,
                ...(completionPlan.message.runId === null
                  ? {}
                  : { runId: completionPlan.message.runId }),
                ...(completionPlan.message.nodeId === null
                  ? {}
                  : { nodeId: completionPlan.message.nodeId }),
                providerInstanceId:
                  completionPlan.parentRun?.providerInstanceId ??
                  parentProjection.thread.providerInstanceId,
                occurredAt: now,
                payload: completionPlan.message,
              },
            ]),
        ...settledNodeEvents,
        ...(resultHandoff === null
          ? []
          : [
              {
                type: "context-handoff.updated" as const,
                threadId: parentThreadId,
                ...(parentRun === undefined ? {} : { runId: parentRun.id }),
                providerInstanceId: childRun.providerInstanceId,
                occurredAt: now,
                payload: resultHandoff,
              },
            ]),
        {
          type: "context-transfer.created",
          threadId: parentThreadId,
          ...(parentRun === undefined ? {} : { runId: parentRun.id }),
          providerInstanceId: childRun.providerInstanceId,
          occurredAt: now,
          payload: resultTransfer,
        },
      ]);

      if (completionPlan.offer && completionPlan.parentRun !== undefined) {
        yield* offerDelegatedCompletionDelivery(parentThreadId, completionPlan.parentRun.id);
      }
      return true;
    });

  /** Settles the child's tasks whose work is over; true when it settled one. */
  const finalizeAppOwnedSubagent = (
    childThreadId: ThreadId,
    options?: { readonly settledContinuationOf?: RunId },
  ) =>
    Effect.gen(function* () {
      const childControls = yield* projectionStore.getThreadRecords(
        childThreadId,
        ["runs", "messages", "subagents", "providerThreads", "providerTurns", "attempts"],
        { messageRoles: ["user"] },
      );
      const parentThreadId = childControls.thread.lineage.parentThreadId;
      if (
        childControls.thread.lineage.relationshipToParent !== "subagent" ||
        childControls.thread.lineage.parentEnvironmentId !== undefined ||
        parentThreadId === null ||
        childControls.thread.forkedFrom?.type !== "node"
      )
        return false;
      const progress = delegatedTaskProgress({
        ...childControls,
        hasOpenMonitors: Option.isSome(monitors) && monitors.value.hasOpenWork(childThreadId),
      });
      const parent = yield* projectionStore.getThreadRecords(parentThreadId, [
        "subagents",
        "contextTransfers",
      ]);
      let settled = false;
      for (const task of parent.subagents) {
        if (
          task.origin !== "app_owned" ||
          task.remote !== undefined ||
          task.childThreadId !== childThreadId ||
          (task.result !== null &&
            parent.contextTransfers.some(
              (transfer) =>
                transfer.type === "subagent_result" && transfer.sourceThreadId === childThreadId,
            ))
        )
          continue;
        const taskProgress = delegatedTaskProgressForTask(
          childControls,
          task,
          Option.isSome(monitors) && monitors.value.hasOpenWork(childThreadId),
        );
        if (taskProgress.state !== "result_available") continue;
        if (
          yield* finalizeAppOwnedSubagentTask(childControls, {
            ...options,
            task,
            progress: taskProgress,
          })
        )
          settled = true;
      }

      const { resultRun } = progress;
      if (progress.state !== "result_available" || resultRun === undefined) return settled;
      const status = delegatedTaskTerminalStatus(runOutcome(resultRun));
      if (status !== "cancelled" && status !== "interrupted") return settled;
      if (
        yield* childAwaitsContinuation(
          childControls.runs,
          resultRun,
          options?.settledContinuationOf,
        )
      )
        return settled;
      // Cancelled or interrupted tasks must not leave async questions that resume the child.
      // Callers hold the parent lock; dismiss takes the child lock, as follow-up intake does.
      const resultRunIds = new Set<RunId>();
      let run: OrchestrationV2Run | undefined = resultRun;
      while (run !== undefined && !resultRunIds.has(run.id)) {
        resultRunIds.add(run.id);
        const previousRunId: RunId | undefined = run.restartContinuationOfRunId;
        run =
          previousRunId === undefined
            ? undefined
            : childControls.runs.find((candidate) => candidate.id === previousRunId);
      }
      const { runtimeRequests, turnItems: secretCards } = yield* projectionStore.getThreadRecords(
        childThreadId,
        ["runtimeRequests", "turnItems"],
        {
          pendingRuntimeRequestsOnly: true,
          turnItemTypes: ["secret_request"],
          turnItemRunIds: [...resultRunIds],
        },
      );
      const pendingQuestions = runtimeRequests.filter(
        (request) =>
          request.status === "pending" &&
          request.kind === "user_input" &&
          request.responseCapability.type === "message",
      );
      if (
        pendingQuestions.length === 0 &&
        !secretCards.some(
          (item) => item.type === "secret_request" && item.secretStatus === "pending",
        )
      )
        return settled;
      const { nodes } =
        pendingQuestions.length === 0
          ? { nodes: [] }
          : yield* projectionStore.getThreadRecords(childThreadId, ["nodes"], {
              nodeIds: pendingQuestions.map((request) => request.nodeId),
            });
      for (const item of secretCards) {
        if (
          item.type !== "secret_request" ||
          item.secretStatus !== "pending" ||
          item.runId === null ||
          item.nodeId === null ||
          !resultRunIds.has(item.runId)
        )
          continue;
        yield* dispatchWithReceipt({
          type: "secret_request.record",
          commandId: CommandId.make(`command:system:delegated-task-secret:${item.id}`),
          threadId: childThreadId,
          runId: item.runId,
          nodeId: item.nodeId,
          turnItemId: item.id,
          label: item.label,
          reason: item.reason,
          ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
          ...(item.apiKey === undefined ? {} : { apiKey: item.apiKey }),
          ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
          ...(item.fields === undefined ? {} : { fields: item.fields }),
          secretStatus: "cancelled",
        });
      }
      for (const request of pendingQuestions) {
        if (
          nodes.some(
            (node) =>
              node.id === request.nodeId && node.runId !== null && resultRunIds.has(node.runId),
          )
        ) {
          yield* dispatchWithReceipt({
            type: "thread.user-input.dismiss",
            commandId: CommandId.make(`command:system:delegated-task-question:${request.id}`),
            threadId: childThreadId,
            requestId: request.id,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to dismiss task question", {
                requestId: request.id,
                cause,
              }),
            ),
          );
        }
      }
      return settled;
    });

  /**
   * Settles a delegated child's task under its parent's lock, then the task above it: a
   * child waiting only on the task that just settled has nothing left to wait for, and no
   * run of its own ends to say so. Takes each parent's lock in turn, so callers hold none.
   */
  const settleAppOwnedSubagent = (
    childThreadId: ThreadId,
    options?: { readonly settledContinuationOf?: RunId },
  ) =>
    Effect.gen(function* () {
      let threadId = childThreadId;
      let continuation = options;
      // As deep as the stop query walks.
      for (let depth = 0; depth < 16; depth += 1) {
        const parentThreadId = yield* appOwnedSubagentParentThreadId(threadId);
        if (parentThreadId === undefined) return;
        const settled = yield* threadDispatch.withLock(
          parentThreadId,
          finalizeAppOwnedSubagent(threadId, continuation),
        );
        if (!settled) return;
        threadId = parentThreadId;
        continuation = undefined;
      }
    });

  // Some providers announce a running turn before they have consumed its prompt.
  const runProducedOutput = (threadId: ThreadId, runId: RunId) =>
    projectionStore
      .getThreadRecords(threadId, ["turnItems"], {
        turnItemRunIds: [runId],
        turnItemTypes: ["assistant_message"],
      })
      .pipe(
        Effect.map(({ turnItems }) =>
          turnItems.some(
            (item) => item.type === "assistant_message" && item.text.trim().length > 0,
          ),
        ),
      );

  const finalizeDelegatedCompletionDelivery = (threadId: ThreadId, runId: RunId) =>
    Effect.gen(function* () {
      // Ordinary turns do not own a delegated delivery. Read just their input
      // before loading the cohort state needed to settle an actual delivery.
      const message = yield* projectionStore.getRunMessage(threadId, runId);
      if (message?.delegatedCompletion === undefined) return;
      const projection = yield* projectionStore.getThreadRecords(
        threadId,
        ["runs", "messages", "subagents"],
        {
          runIds: [runId, message.delegatedCompletion.parentRunId],
          messageIds: [message.id],
        },
      );
      const deliveryRun = projection.runs.find((candidate) => candidate.id === runId);
      const deliveryMessage =
        deliveryRun === undefined
          ? undefined
          : projection.messages.find((candidate) => candidate.id === deliveryRun.userMessageId);
      const messageOwnership = deliveryMessage?.delegatedCompletion;
      if (deliveryRun === undefined || messageOwnership === undefined) {
        return;
      }
      const parentRun = projection.runs.find(
        (candidate) => candidate.id === messageOwnership.parentRunId,
      );
      const cohort = parentRun?.delegatedCompletion;
      const delivery = cohort?.delivery;
      if (
        parentRun === undefined ||
        cohort === undefined ||
        delivery === null ||
        delivery === undefined ||
        delivery.messageId !== deliveryRun.userMessageId ||
        delivery.generation !== messageOwnership.generation
      ) {
        return;
      }

      const now = yield* DateTime.now;
      const cutStatus =
        deliveryRun.status === "failed" ||
        deliveryRun.status === "interrupted" ||
        deliveryRun.status === "cancelled";
      // A cut wake whose turn already answered was read: a restart's continuation resumes
      // that turn, so offering the same results again would make the lead redo its work.
      const unread = cutStatus && !(yield* runProducedOutput(threadId, runId));
      // An unread failed or interrupted wake rides the next turn; an unread cancelled one
      // wakes the parent again.
      const deferred = unread && deliveryRun.status !== "cancelled";
      const nextTaskStates = new Map<
        OrchestrationV2Subagent["id"],
        OrchestrationV2Subagent["completionDelivery"]
      >();
      for (const task of projection.subagents) {
        if (
          task.origin !== "app_owned" ||
          task.runId !== parentRun.id ||
          !delivery.taskIds.includes(task.id) ||
          task.completionDelivery?.state !== "claimed"
        ) {
          continue;
        }
        nextTaskStates.set(task.id, {
          state: unread ? "pending" : "acknowledged",
          observedByRunId: unread ? null : deliveryRun.id,
          ...(deferred ? { withNextTurn: true } : {}),
        });
      }
      const pendingTaskIds = projection.subagents
        .filter(
          (task) =>
            task.origin === "app_owned" &&
            task.runId === parentRun.id &&
            isTerminalDelegatedTaskStatus(task.status) &&
            (nextTaskStates.get(task.id) ?? task.completionDelivery)?.state === "pending" &&
            !(nextTaskStates.get(task.id) ?? task.completionDelivery)?.withNextTurn,
        )
        .map((task) => task.id);
      // Results that arrived while this delivery was outstanding go out
      // together in one successor. Each child becomes pending once, so a
      // cohort's successors are bounded by its children.
      const canReserveFollowUp =
        cohort.disposition === "open" &&
        projection.thread.archivedAt === null &&
        projection.thread.deletedAt === null &&
        pendingTaskIds.length > 0;
      const nextDelivery = canReserveFollowUp
        ? {
            generation: cohort.nextGeneration,
            messageId: yield* mapDelegatedCompletionError(
              idAllocator.allocate.message({
                threadId,
                ordinal:
                  (yield* mapDelegatedCompletionError(
                    projectionStore.getMessageCount(projection.thread.id),
                  )) + 1,
              }),
            ),
            taskIds: pendingTaskIds,
          }
        : null;
      if (nextDelivery !== null) {
        for (const taskId of pendingTaskIds) {
          nextTaskStates.set(taskId, {
            state: "claimed",
            observedByRunId: null,
          });
        }
      }
      const updatedParentRun: OrchestrationV2Run = {
        ...parentRun,
        delegatedCompletion: {
          ...cohort,
          nextGeneration: nextDelivery === null ? cohort.nextGeneration : cohort.nextGeneration + 1,
          delivery: nextDelivery,
        },
      };
      const taskEvents = projection.subagents.flatMap((task) => {
        const completionDelivery = nextTaskStates.get(task.id);
        if (completionDelivery === undefined) {
          return [];
        }
        return [
          {
            type: "subagent.updated" as const,
            threadId,
            ...(task.runId === null ? {} : { runId: task.runId }),
            nodeId: task.id,
            driver: task.driver,
            providerInstanceId: task.providerInstanceId,
            occurredAt: now,
            payload: {
              ...task,
              completionDelivery,
              updatedAt: now,
            },
          },
        ];
      });
      yield* writeSystemEvents([
        ...taskEvents,
        {
          type: "run.updated",
          threadId,
          runId: updatedParentRun.id,
          ...(updatedParentRun.rootNodeId === null ? {} : { nodeId: updatedParentRun.rootNodeId }),
          providerInstanceId: updatedParentRun.providerInstanceId,
          occurredAt: now,
          payload: updatedParentRun,
        },
      ]);
      if (nextDelivery !== null) {
        yield* offerDelegatedCompletionDelivery(threadId, parentRun.id);
      }
    });

  /** Accepts a wake the provider received and reserves the next one for pending siblings. */
  const acceptDelegatedCompletionDelivery = Effect.fn(
    "orchestrationV2.acceptDelegatedCompletionDelivery",
  )(function* (input: {
    readonly command: OrchestrationV2ServerCommand;
    readonly events: Ref.Ref<Array<OrchestrationV2DomainEvent>>;
    readonly projection: Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "runs" | "messages" | "subagents"
    >;
    readonly messageId: OrchestrationV2ConversationMessage["id"];
    readonly now: DateTime.Utc;
  }) {
    const { projection, now } = input;
    const threadId = projection.thread.id;
    const message = projection.messages.find((row) => row.id === input.messageId);
    const ownership = message?.delegatedCompletion;
    const parentRun = projection.runs.find((run) => run.id === ownership?.parentRunId);
    const cohort = parentRun?.delegatedCompletion;
    const delivery = cohort?.delivery;
    const emitEvent = emit(input.events, input.command);
    if (
      parentRun === undefined ||
      cohort === undefined ||
      cohort.disposition !== "open" ||
      delivery == null ||
      delivery.messageId !== input.messageId ||
      delivery.generation !== ownership?.generation
    ) {
      return undefined;
    }
    // settled_only tasks defer only to a blocking wait in their spawning run.
    const parentIsLive = hasLiveRun({ runs: [parentRun] });
    const pendingTaskIds =
      projection.thread.archivedAt === null && projection.thread.deletedAt === null
        ? projection.subagents
            .filter(
              (task) =>
                task.origin === "app_owned" &&
                task.runId === parentRun.id &&
                task.completionDelivery?.state === "pending" &&
                !task.completionDelivery.withNextTurn &&
                isTerminalDelegatedTaskStatus(task.status) &&
                (!parentIsLive || task.completionWake === "always"),
            )
            .map((task) => task.id)
        : [];
    const nextDelivery =
      pendingTaskIds.length === 0
        ? null
        : {
            generation: cohort.nextGeneration,
            messageId: yield* mapDelegatedCompletionError(
              idAllocator.allocate.message({
                threadId,
                ordinal:
                  (yield* mapDelegatedCompletionError(
                    projectionStore.getMessageCount(projection.thread.id),
                  )) + 1,
              }),
            ),
            taskIds: pendingTaskIds,
          };
    const acceptedIds = new Set(delivery.taskIds);
    const pendingIds = new Set(pendingTaskIds);
    for (const task of projection.subagents) {
      const state = pendingIds.has(task.id)
        ? "claimed"
        : acceptedIds.has(task.id) && task.completionDelivery?.state === "claimed"
          ? "acknowledged"
          : undefined;
      if (state === undefined) continue;
      yield* emitEvent({
        type: "subagent.updated",
        threadId,
        runId: parentRun.id,
        nodeId: task.id,
        driver: task.driver,
        providerInstanceId: task.providerInstanceId,
        occurredAt: now,
        payload: {
          ...task,
          completionDelivery: {
            state,
            observedByRunId: state === "acknowledged" ? (message?.runId ?? null) : null,
          },
          updatedAt: now,
        },
      });
    }
    // Accepted wakes carry the results, so they acknowledge only this batch.
    yield* emitEvent({
      type: "run.updated",
      threadId,
      runId: parentRun.id,
      providerInstanceId: parentRun.providerInstanceId,
      occurredAt: now,
      payload: {
        ...parentRun,
        delegatedCompletion: {
          ...cohort,
          nextGeneration: cohort.nextGeneration + (nextDelivery === null ? 0 : 1),
          delivery: nextDelivery,
        },
      },
    });
    return parentRun.id;
  });

  const dispatchNotificationAccepted = Effect.fn("orchestrationV2.notificationAccepted")(function* (
    command: Extract<OrchestrationV2Command, { type: "notification.delivery.accept" }>,
    events: Ref.Ref<Array<OrchestrationV2DomainEvent>>,
  ) {
    const projection = yield* projectionStore
      .getThreadRecords(command.threadId, ["runs", "messages", "subagents"], {
        messageIds: [command.messageId],
        unorderedMessages: true,
      })
      .pipe(mapDispatchError(command));
    const now = yield* DateTime.now;
    const accepted = yield* acceptDelegatedCompletionDelivery({
      command,
      events,
      projection,
      messageId: command.messageId,
      now,
    });
    if (accepted === undefined) {
      yield* emit(
        events,
        command,
      )({
        type: "thread.metadata-updated",
        threadId: command.threadId,
        occurredAt: now,
        payload: projection.thread,
      });
    }
  });

  const dispatchUnsupported = (command: OrchestrationV2ServerCommand) =>
    Effect.fail(
      new OrchestratorDispatchError({
        commandId: command.commandId,
        commandType: command.type,
      }),
    );

  const dispatchOnce = Effect.fn("orchestrationV2.dispatch.once")(function* (
    command: OrchestrationV2ServerCommand,
  ): Effect.fn.Return<
    {
      readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
      readonly effects: ReadonlyArray<PendingOrchestrationEffectV2>;
      readonly cancelUnsettledEffects?: {
        readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
        readonly reason: string;
      };
    },
    OrchestratorV2Error
  > {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.thread_id": commandThreadId(command),
    });

    const events = yield* Ref.make<Array<OrchestrationV2DomainEvent>>([]);
    const effects = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
    let cancelUnsettledEffects:
      | {
          readonly effectTypes: ReadonlyArray<OrchestrationEffectRequestV2["type"]>;
          readonly reason: string;
        }
      | undefined;
    if (
      [
        "thread.archive",
        "thread.delete",
        "thread.settle",
        "thread.snooze",
        "thread.model-selection.set",
        "provider.switch",
        "provider-session.detach",
      ].includes(command.type)
    ) {
      // A missing thread has no retries to cancel; the command itself reports it.
      const records = yield* projectionStore
        .getThreadRecords(commandThreadId(command), ["runs"])
        .pipe(
          Effect.catchTags({ ProjectionStoreThreadNotFoundError: () => Effect.succeed(null) }),
          mapDispatchError(command),
        );
      for (const run of records?.runs ?? [])
        yield* updateAutomaticProviderRetry(command, events, run, "cancelled");
    }
    switch (command.type) {
      case "delegated_task.remote.sync":
        yield* dispatchRemoteSubagentSync(command, events).pipe(mapDispatchError(command));
        break;
      case "thread.create":
        yield* dispatchThreadCreate(command, events);
        break;
      case "provider-retry.cancel": {
        const { thread, runs } = yield* projectionStore
          .getThreadRecords(command.threadId, ["runs"])
          .pipe(mapDispatchError(command));
        const run = runs.find((run) => run.id === command.runId);
        if (run !== undefined)
          yield* updateAutomaticProviderRetry(command, events, run, "cancelled");
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: command.threadId,
          occurredAt: yield* DateTime.now,
          payload: thread,
        });
        break;
      }
      case "thread.visit":
        yield* dispatchThreadVisit(command, events);
        break;
      case "thread.auto-settle": {
        // Automatic settlement (#8600): the sweep evaluated a shell snapshot,
        // so re-check against the live thread before settling. Any change
        // after the snapshot — or any explicit override, including the
        // un-settle button's "active" — wins over the sweep.
        const thread = yield* projectionStore
          .getThread(command.threadId)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        if (
          thread.settledOverride !== null ||
          DateTime.toEpochMillis(thread.updatedAt) > DateTime.toEpochMillis(command.snapshotAt)
        ) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Thread ${command.threadId} changed before automatic settlement.`,
          });
        }
        yield* dispatchThreadMutation(
          {
            type: "thread.settle",
            commandId: command.commandId,
            threadId: command.threadId,
            ...(command.settledAt === undefined ? {} : { settledAt: command.settledAt }),
          },
          events,
          effects,
        );
        break;
      }
      case "thread.delete": {
        const projection = yield* projectionStore
          .getThreadRecords(
            command.threadId,
            ["runs", "attempts", "nodes", "runtimeRequests", "subagents", "providerSessions"],
            { liveNodesOnly: true, pendingRuntimeRequestsOnly: true },
          )
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        return yield* mapDispatchError(command)(
          planThreadDeletion({
            command,
            projection,
            attachmentIds: yield* projectionStore
              .getThreadAttachmentIds(command.threadId)
              .pipe(mapDispatchError(command)),
            now: yield* DateTime.now,
            idAllocator,
          }),
        );
      }
      case "thread.archive":
      case "thread.unarchive":
      case "thread.settle":
      case "thread.unsettle":
      case "thread.snooze":
      case "thread.unsnooze":
      case "thread.auto-settle.set":
      case "thread.pin":
      case "thread.unpin":
      case "thread.pin.reorder":
      case "thread.active.reorder":
      case "thread.mark-unread":
      case "thread.metadata.update":
      case "thread.pull-request.link":
      case "thread.pull-request.unlink":
      case "thread.pull-request-link.sync":
      case "thread.pull-request.watch":
      case "thread.pull-request.sync":
      case "thread.title.regeneration.complete":
      case "thread.runtime-mode.set":
      case "thread.interaction-mode.set":
      case "thread.model-selection.set":
      case "provider.switch":
        cancelUnsettledEffects = yield* dispatchThreadMutation(command, events, effects);
        break;
      case "thread.pull-request-watch.sync":
        yield* dispatchPullRequestWatchSync(command, events, effects);
        break;
      case "provider-session.detach":
        yield* dispatchProviderSessionDetach(command, events, effects);
        break;
      case "message.dispatch": {
        // The provider owns a native subagent's conversation, so a sent
        // message has nowhere to go. Answers to a subagent's questions never
        // target it either: adapters ask them on the top-level parent thread.
        const thread = yield* projectionStore
          .getThread(command.threadId)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
            ),
          );
        if (
          command.threadSendCompletion &&
          (thread.archivedAt !== null || thread.deletedAt !== null)
        )
          break;
        if (isProviderNativeSubagentThread(thread)) {
          return yield* new OrchestratorSubagentThreadReadOnlyError({
            commandId: command.commandId,
            threadId: command.threadId,
          });
        }
        yield* dispatchMessage(command, events, effects);
        yield* recordSubagentFollowup(thread, command, events).pipe(mapDispatchError(command));
        break;
      }
      case "thread.created.report": {
        const thread = yield* projectionStore
          .getThread(command.threadId)
          .pipe(mapDispatchError(command));
        if (thread.createdChat?.startup !== "pending") break;
        const now = yield* DateTime.now;
        const shell = yield* projectionStore
          .getThreadShell(thread.id)
          .pipe(mapDispatchError(command));
        const failedFirst =
          shell?.status === "failed" && shell.latestRunId === thread.createdChat.firstRunId;
        const updated = yield* recordCreatedChatFailure(
          command,
          {
            ...thread,
            createdChat: {
              ...thread.createdChat,
              startup: command.startup,
              ...(failedFirst && thread.createdChat.failure === undefined
                ? { failure: (shell.lastError ?? "Unknown error").slice(0, 200) }
                : {}),
            },
            updatedAt: now,
          },
          effects,
        );
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: thread.id,
          occurredAt: now,
          payload: updated,
        });
        break;
      }
      case "notification.delivery.accept":
        yield* dispatchNotificationAccepted(command, events);
        break;
      case "prepared-run.release":
        yield* dispatchPreparedRunRelease(command, events, effects);
        break;
      case "prepared-run.progress":
        yield* dispatchPreparedRunProgress(command, events);
        break;
      case "prepared-run.fail":
        yield* dispatchPreparedRunFail(command, events);
        break;
      case "prepared-run.retry":
        yield* dispatchPreparedRunRetry(command, events);
        break;
      case "runtime-request.respond":
        yield* dispatchRuntimeRequestRespond(command, events, effects);
        break;
      case "thread.user-input.dismiss":
        yield* dispatchThreadUserInputDismiss(command, events, effects);
        break;
      case "subagent.stop":
        yield* dispatchSubagentStop(command, events, effects);
        break;
      case "run.interrupt":
        cancelUnsettledEffects = yield* dispatchRunInterrupt(command, events, effects);
        // Stop also stops every delegated task under the thread once it commits.
        if (command.holdQueue === true && command.keepHelpers !== true) {
          yield* Ref.update(effects, (existing) => [
            ...existing,
            delegatedTasksStopEffect(command),
          ]);
        }
        break;
      case "thread.stop":
        cancelUnsettledEffects = yield* dispatchThreadStop(command, events, effects);
        break;
      case "queued-message.promote-to-steer":
        yield* dispatchQueuedMessagePromoteToSteer(command, events, effects);
        break;
      case "queue.resume": {
        const projection = yield* projectionStore
          .getMessageDispatchProjection(command.threadId, {
            needsRunHistory: false,
            resumeQueue: true,
          })
          .pipe(mapDispatchError(command));
        if (projection.thread.archivedAt !== null || projection.thread.deletedAt !== null) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: `Thread ${command.threadId} is not active.`,
          });
        }
        const sessionError =
          projection.providerSessions
            .filter(
              (session) => session.providerInstanceId === projection.thread.providerInstanceId,
            )
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
            )[0]?.lastError ?? null;
        if (usageLimitBlockedRun(projection.runs, projection.turnItems, sessionError) !== null) {
          return yield* new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Continue the limited thread before resuming its queue.",
          });
        }
        const now = yield* DateTime.now;
        const queued = projection.runs.filter((run) => run.status === "queued");
        for (const run of queued) {
          yield* emit(
            events,
            command,
          )({
            type: "run.updated",
            threadId: command.threadId,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: { ...run, queueHeld: false },
          });
        }
        if (queued.length === 0) {
          yield* emit(
            events,
            command,
          )({
            type: "thread.metadata-updated",
            threadId: command.threadId,
            occurredAt: now,
            payload: projection.thread,
          });
        }
        break;
      }
      case "queued-run.reorder":
        yield* dispatchQueuedRunReorder(command, events);
        break;
      case "queued-run.cancel":
        yield* dispatchQueuedRunCancel(command, events);
        break;
      case "queued-run.edit":
        yield* dispatchQueuedRunEdit(command, events);
        break;
      case "checkpoint.rollback":
        yield* dispatchCheckpointRollback(command, events, effects);
        break;
      case "checkpoint.rollback.fail":
        yield* dispatchCheckpointRollbackFail(command, events);
        break;
      case "thread.background-work.settle":
        yield* dispatchBackgroundWorkSettle(command, events, effects);
        break;
      case "thread.fork":
        yield* dispatchThreadFork(command, events);
        break;
      case "thread.merge_back":
        yield* dispatchThreadMergeBack(command, events);
        break;
      case "delegated_task.request":
        yield* dispatchDelegatedTaskRequest(command, events, effects);
        break;
      case "delegated_task.wake-policy":
        yield* dispatchDelegatedTaskWakePolicy(command, events);
        break;
      case "delegated_task.cancel-requested": {
        const parent = yield* projectionStore
          .getThreadRecords(command.parentThreadId, ["subagents"])
          .pipe(mapDispatchError(command));
        const task = parent.subagents.find(
          (task) => task.id === command.taskId && task.origin === "app_owned",
        );
        if (task && !isTerminalDelegatedTaskStatus(task.status) && !task.cancellationRequested) {
          const now = yield* DateTime.now;
          yield* emit(
            events,
            command,
          )({
            type: "subagent.updated",
            threadId: command.parentThreadId,
            occurredAt: now,
            payload: { ...task, cancellationRequested: true, updatedAt: now },
          });
        }
        break;
      }
      case "delegated_task.completion-delivery.acknowledge":
      case "delegated_task.completion-delivery.dispose":
        yield* dispatchDelegatedTaskCompletionDeliveryResolution(command, events);
        break;
      case "thread.created.record":
        yield* dispatchCreatedThreadRecord(command, events);
        break;
      case "secret_request.record":
        yield* dispatchSecretRequestRecord(command, events, effects);
        break;
      case "user_question.ask":
        yield* dispatchUserQuestionAsk(command, events);
        break;
      default:
        return yield* dispatchUnsupported(command);
    }
    if (!String(command.commandId).startsWith("command:runtime-reconcile:")) {
      const planned = yield* Ref.get(events);
      for (const event of planned) {
        if (
          event.type !== "run.updated" ||
          event.payload.ordinal !== 1 ||
          event.payload.status !== "failed"
        )
          continue;
        const thread = yield* projectionStore
          .getThread(event.threadId)
          .pipe(mapDispatchError(command));
        const receipt = thread.createdChat;
        if (
          receipt === undefined ||
          receipt.failure !== undefined ||
          (receipt.firstRunId !== null && receipt.firstRunId !== event.payload.id)
        )
          continue;
        const error = planned.find(
          (candidate) =>
            candidate.type === "turn-item.updated" &&
            candidate.threadId === thread.id &&
            candidate.payload.type === "error" &&
            candidate.payload.runId === event.payload.id,
        );
        const failure =
          error?.type === "turn-item.updated" && error.payload.type === "error"
            ? error.payload.failure.message
            : "Unknown error";
        const now = yield* DateTime.now;
        const updated = yield* recordCreatedChatFailure(
          command,
          {
            ...thread,
            createdChat: {
              ...receipt,
              firstRunId: event.payload.id,
              failure: failure.slice(0, 200),
            },
            updatedAt: now,
          },
          effects,
        );
        yield* emit(
          events,
          command,
        )({
          type: "thread.metadata-updated",
          threadId: thread.id,
          occurredAt: now,
          payload: updated,
        });
      }
    }
    return {
      events: yield* Ref.get(events),
      effects: yield* Ref.get(effects),
      ...(cancelUnsettledEffects === undefined ? {} : { cancelUnsettledEffects }),
    };
  });

  const dispatchWithReceiptEffect = Effect.fn("orchestrationV2.dispatch.withReceipt")(function* (
    command: OrchestrationV2ServerCommand,
    steerGuard?: {
      readonly runId: RunId;
      readonly attemptId: NonNullable<OrchestrationV2Run["activeAttemptId"]>;
      readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
      readonly queuedRunId: RunId;
    },
  ): Effect.fn.Return<OrchestratorV2DispatchResult, OrchestratorV2Error> {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.command_id": command.commandId,
      "orchestration_v2.command_type": command.type,
      "orchestration_v2.thread_id": commandThreadId(command),
    });

    const existingReceipt = yield* commandReceipts.getByCommandId(command.commandId).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );

    if (Option.isSome(existingReceipt)) {
      const receipt = existingReceipt.value;
      if (receipt.commandType === monitorStopReceiptType) {
        return yield* new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "The command ID belongs to a monitor cleanup receipt.",
        });
      }
      if (receipt.status === "rejected") {
        return yield* new OrchestratorCommandPreviouslyRejectedError({
          commandId: command.commandId,
          commandType: command.type,
          detail: receipt.error ?? "Previously rejected.",
        });
      }
      // A receipt only proves this exact command was handled for its own
      // thread. Replaying it for a command aimed at another thread would
      // report success for work that never happened.
      const dispatchThreadId = commandThreadId(command);
      if (!canReplayCommandReceipt(receipt.threadId, dispatchThreadId)) {
        return yield* new OrchestratorCommandIdConflictError({
          commandId: command.commandId,
          commandType: command.type,
          receiptThreadId: receipt.threadId,
          commandThreadId: dispatchThreadId,
        });
      }
      const storedEvents = yield* eventSink.readByCommandId({ commandId: command.commandId }).pipe(
        Stream.runCollect,
        Effect.map((events): ReadonlyArray<OrchestrationV2StoredEvent> => Array.from(events)),
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );
      if (command.type === "queue.resume") {
        yield* mapDispatchError(command)(startNextQueuedRun(command.threadId));
      }
      return {
        sequence: receipt.resultSequence,
        storedEvents,
      } satisfies OrchestratorV2DispatchResult;
    }

    // A limited sender checked these modes before dispatching; the thread's
    // user may have raised them since, and only here can they not change.
    const limit = yield* DispatchModeLimit;
    if (limit !== undefined) {
      // A fork or merge-back source is not under this lock: its dispatch
      // checks the copy it reads instead.
      const threadId = commandThreadId(command);
      const shell = yield* projectionStore
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause })));
      if (shell !== null) yield* refuseAboveDispatchModeLimit(command, threadId, shell);
    }

    // The run-end release can lag behind a new send; start the queue first so the send waits
    // behind it. A continuation resumes the ended run, so it must not be overtaken by the queue.
    if (
      command.type === "message.dispatch" &&
      command.restartContinuationOfRunId === undefined &&
      command.providerRetryContinuationOfRunId === undefined &&
      (command.dispatchMode.type === "start_immediately" ||
        command.dispatchMode.type === "queue_after_active" ||
        command.dispatchMode.type === "defer_start")
    ) {
      yield* mapDispatchError(command)(
        startNextQueuedRun(command.threadId, { latestRunEnded: true }),
      );
    }

    const plan = yield* dispatchOnce(command).pipe(
      Effect.flatMap((planned) =>
        // A settle that finds the provider already ended everything, or a
        // stop that finds nothing running, has nothing to record. That is
        // its expected outcome, not a failure.
        planned.events.length > 0 ||
        isUnobservedAcknowledgement(command) ||
        (command.type === "message.dispatch" && command.threadSendCompletion === true) ||
        command.type === "thread.background-work.settle" ||
        command.type === "thread.stop" ||
        command.type === "subagent.stop"
          ? Effect.succeed(planned)
          : Effect.fail(
              new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: "Command produced no domain events.",
              }),
            ),
      ),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          // Refused like the check above: nothing recorded, so the same command
          // can go through once the thread's user lowers it again.
          if (
            cause._tag === "OrchestratorThreadAboveModeLimitError" ||
            cause._tag === "ThreadManagementProviderInstanceDisabledError"
          )
            return yield* cause;
          const rejectedAt = yield* DateTime.now;
          const receipt = yield* eventSink
            .commitRejectedCommand({
              commandId: command.commandId,
              threadId: commandThreadId(command),
              commandType: command.type,
              rejectedAt,
              error: cause instanceof Error ? cause.message : String(cause),
            })
            .pipe(
              Effect.mapError(
                (receiptCause) =>
                  new OrchestratorDispatchError({
                    commandId: command.commandId,
                    commandType: command.type,
                    cause: receiptCause,
                  }),
              ),
            );
          if (
            command.type === "queued-run.edit" &&
            receipt.status === "rejected" &&
            cause._tag === "OrchestratorDispatchError"
          ) {
            return yield* new OrchestratorCommandRejectedError({
              commandId: cause.commandId,
              commandType: cause.commandType,
              cause: cause.cause,
            });
          }
          return yield* cause;
        }),
      ),
    );

    if (
      plan.events.length === 0 &&
      plan.effects.length === 0 &&
      plan.cancelUnsettledEffects === undefined
    ) {
      // A settle that ended nothing still records its receipt: a replayed Stop
      // effect then finds it instead of settling work that appeared since.
      const resultSequence = yield* Effect.gen(function* () {
        const sequence = yield* eventSink.latestSequence({ threadId: commandThreadId(command) });
        yield* commandReceipts.insertIfAbsent({
          commandId: command.commandId,
          threadId: commandThreadId(command),
          commandType: command.type,
          acceptedAt: yield* DateTime.now,
          resultSequence: sequence,
          status: "accepted",
          error: null,
        });
        return sequence;
      }).pipe(
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );
      return { sequence: resultSequence, storedEvents: [] } satisfies OrchestratorV2DispatchResult;
    }
    const acceptedAt = plan.events.at(-1)?.occurredAt ?? (yield* DateTime.now);
    const threadId = commandThreadId(command);
    const wasPendingSteer = pendingSteerThreads.has(threadId);
    // Publishing can wake the provider listener before commitCommand returns.
    if (
      plan.events.some(
        (event) =>
          event.type === "run.created" &&
          event.payload.status === "queued" &&
          event.payload.steerWhenLiveRunId !== undefined,
      )
    ) {
      pendingSteerThreads.add(threadId);
    }
    const committed = yield* eventSink
      .commitCommand({
        commandId: command.commandId,
        threadId: commandThreadId(command),
        commandType: command.type,
        acceptedAt,
        ...(steerGuard === undefined ? {} : { steerGuard }),
        events: plan.events,
        effects: plan.effects,
        ...(plan.cancelUnsettledEffects === undefined
          ? {}
          : { cancelUnsettledEffects: plan.cancelUnsettledEffects }),
      })
      .pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            if (!wasPendingSteer) pendingSteerThreads.delete(threadId);
          }),
        ),
        Effect.mapError(
          (cause) =>
            new OrchestratorDispatchError({
              commandId: command.commandId,
              commandType: command.type,
              cause,
            }),
        ),
      );

    if (committed.receipt.status === "rejected") {
      if (!wasPendingSteer) pendingSteerThreads.delete(threadId);
      return yield* new OrchestratorCommandPreviouslyRejectedError({
        commandId: command.commandId,
        commandType: command.type,
        detail: committed.receipt.error ?? "Previously rejected.",
      });
    }
    if (
      pendingSteerThreads.has(threadId) &&
      plan.events.some((event) => event.type === "run.updated" && event.payload.status !== "queued")
    ) {
      yield* refreshPendingSteerThread(threadId);
    }
    if (command.type === "queue.resume") {
      yield* mapDispatchError(command)(startNextQueuedRun(command.threadId));
    }
    if (
      command.type === "notification.delivery.accept" ||
      // A steer restart that settled a wake can reserve the next one for its siblings.
      ((command.type === "message.dispatch" ||
        command.type === "queued-message.promote-to-steer") &&
        committed.storedEvents.some(
          ({ event }) =>
            event.type === "subagent.updated" &&
            event.payload.completionDelivery?.state === "claimed",
        ))
    ) {
      yield* mapDispatchError(command)(offerDelegatedCompletionDeliveries(command.threadId));
    }
    if (command.type === "delegated_task.remote.sync") {
      yield* mapDispatchError(command)(offerDelegatedCompletionDeliveries(command.threadId));
    }
    if (command.type === "delegated_task.wake-policy" || isUnobservedAcknowledgement(command)) {
      yield* mapDispatchError(command)(offerDelegatedCompletionDeliveries(command.parentThreadId));
    }

    return {
      sequence: committed.receipt.resultSequence,
      storedEvents: committed.storedEvents,
    } satisfies OrchestratorV2DispatchResult;
  });

  // Typed: a Stop settles through finalizeAppOwnedSubagent, which dispatches in turn.
  const dispatchWithReceipt: OrchestratorV2Shape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const dispatch = threadDispatch.withLock(
        commandThreadId(command),
        Effect.gen(function* () {
          // A stopped monitor's output may already be waiting for this lock.
          const generation =
            command.type === "message.dispatch"
              ? appOwnedMonitorGeneration({ ...command, id: command.messageId })
              : undefined;
          if (
            generation !== undefined &&
            Option.isSome(monitors) &&
            !monitors.value.canDeliver({ threadId: commandThreadId(command), generation })
          ) {
            return { sequence: 0, storedEvents: [] } satisfies OrchestratorV2DispatchResult;
          }
          const result = yield* dispatchWithReceiptEffect(command);
          if (
            command.type === "thread.stop" ||
            command.type === "thread.archive" ||
            command.type === "thread.delete" ||
            (command.type === "run.interrupt" &&
              command.holdQueue === true &&
              command.keepHelpers !== true)
          ) {
            // The command commits before cleanup. Record successful cleanup separately so a
            // replay can finish a failed stop without killing new monitors after a restart.
            const completionId = CommandId.make(
              `command:monitor-stop-applied:${command.commandId}`,
            );
            const recorded = yield* commandReceipts
              .getByCommandId(completionId)
              .pipe(mapDispatchError(command));
            if (Option.isSome(recorded)) {
              if (
                recorded.value.status !== "accepted" ||
                recorded.value.threadId !== command.threadId ||
                recorded.value.commandType !== monitorStopReceiptType
              ) {
                return yield* new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "The monitor cleanup receipt belongs to a different command.",
                });
              }
              return result;
            }
            yield* ownership
              .stopOwned({
                threadId: command.threadId,
                commandId: command.commandId,
                kind: "monitor",
              })
              .pipe(mapDispatchError(command));
            const stored = yield* commandReceipts
              .insertIfAbsent({
                commandId: completionId,
                threadId: command.threadId,
                commandType: monitorStopReceiptType,
                resultSequence: result.sequence,
                acceptedAt: yield* DateTime.now,
                status: "accepted",
                error: null,
              })
              .pipe(mapDispatchError(command));
            if (!stored) {
              return yield* new OrchestratorDispatchError({
                commandId: command.commandId,
                commandType: command.type,
                cause: "The monitor cleanup receipt could not be recorded.",
              });
            }
          }
          return result;
        }),
      );
      const followUp =
        command.type === "message.dispatch" &&
        (command.createdBy === "user" || command.creationSource === "mcp");
      // A delegated child's new title also rewrites its parent's subagent records.
      const retitle =
        (command.type === "thread.metadata.update" ||
          command.type === "thread.title.regeneration.complete") &&
        command.title !== undefined;
      if (!followUp && !retitle && command.type !== "thread.stop") return yield* dispatch;
      const parentThreadId = yield* appOwnedSubagentParentThreadId(command.threadId).pipe(
        Effect.mapError(
          (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
        ),
      );
      if (parentThreadId === undefined) return yield* dispatch;
      // Follow-up intake, retitles and Stop serialize on the parent before taking the child lock.
      if (command.type !== "thread.stop") {
        return yield* threadDispatch.withLock(parentThreadId, dispatch);
      }
      // A Stop can find nothing left to stop, such as a task an earlier build left showing
      // as running, so no run ends to settle its task. Settle it once the Stop commits.
      const [result, settled] = yield* threadDispatch.withLock(
        parentThreadId,
        Effect.flatMap(dispatch, (result) =>
          finalizeAppOwnedSubagent(command.threadId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to settle a stopped delegated task", {
                threadId: command.threadId,
                cause,
              }).pipe(Effect.as(false)),
            ),
            Effect.map((settled) => [result, settled] as const),
          ),
        ),
      );
      if (settled) {
        yield* settleAppOwnedSubagent(parentThreadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to settle the task above a stopped one", {
              threadId: parentThreadId,
              cause,
            }),
          ),
        );
      }
      return result;
    });

  const acknowledgeCarriedResults = (run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      if (
        !run.carriedTaskIds?.length ||
        (run.status !== "completed" &&
          !(
            (run.status === "failed" || run.status === "interrupted") &&
            (yield* runProducedOutput(run.threadId, run.id))
          ))
      )
        return;
      for (const taskId of run.carriedTaskIds) {
        yield* dispatchWithReceipt({
          type: "delegated_task.completion-delivery.acknowledge",
          parentThreadId: run.threadId,
          taskId,
          observedByRunId: run.id,
          commandId: CommandId.make(`server:carried-result:${run.id}:${taskId}`),
        });
      }
    });

  const handleTerminalRun = (stored: OrchestrationV2StoredEvent) =>
    Effect.gen(function* () {
      const threadId = stored.event.threadId;
      // finalize writes the parent thread and startNextQueuedRun writes this
      // thread, so each takes its own thread's lock, sequentially and never
      // nested: dispatchDelegatedTaskRequest already writes child events
      // while holding the parent lock, so nesting the parent lock inside the
      // child lock here would invert that order, and the keyed executor's
      // semaphores are neither reentrant nor deadlock-aware.
      if (
        stored.event.type === "run.updated" &&
        stored.event.payload.ordinal === 1 &&
        stored.event.payload.status === "failed"
      ) {
        const failedRun = stored.event.payload;
        yield* threadDispatch.withLock(
          threadId,
          Effect.gen(function* () {
            const thread = yield* projectionStore.getThread(threadId);
            const receipt = thread.createdChat;
            if (receipt === undefined || !isFirstCreatedChatFailure(failedRun, receipt)) return;
            const shell = yield* projectionStore.getThreadShell(threadId);
            const now = yield* DateTime.now;
            const pending = yield* Ref.make<Array<PendingOrchestrationEffectV2>>([]);
            const command = {
              type: "thread.created.report" as const,
              threadId,
              startup: "started" as const,
              commandId: CommandId.make(`command:created-chat-failure:${threadId}`),
            };
            const updated = yield* recordCreatedChatFailure(
              command,
              {
                ...thread,
                createdChat: {
                  ...receipt,
                  firstRunId: failedRun.id,
                  failure: receipt.failure ?? (shell?.lastError ?? "Unknown error").slice(0, 200),
                },
                updatedAt: now,
              },
              pending,
            );
            yield* writeSystemEvents(
              [{ type: "thread.metadata-updated", threadId, occurredAt: now, payload: updated }],
              yield* Ref.get(pending),
            );
          }),
        );
      }
      if (stored.event.type === "run.updated") {
        const run = stored.event.payload;
        teamBoard?.endRunNotices(threadId, run.id);
        if (teamBoard?.observeTeam(threadId) !== undefined) {
          // Process recovery commits its continuation with the interrupted run.
          // The resumed run adopts those claims. An ordinary terminal run releases them.
          const restarting =
            run.status === "interrupted" &&
            (yield* awaitsRestartContinuation(run).pipe(Effect.orElseSucceed(() => false)));
          if (!restarting) {
            const target = { threadId, runId: run.id };
            yield* teamBoard.finalScan(target).pipe(
              Effect.andThen(teamBoard.endRun(target)),
              Effect.catchCause(() => Effect.logWarning("Could not release team board claims")),
            );
          }
        }
        yield* acknowledgeCarriedResults(stored.event.payload);
        yield* threadDispatch.withLock(
          threadId,
          finalizeDelegatedCompletionDelivery(threadId, stored.event.payload.id),
        );
      }
      yield* threadDispatch
        .withLock(
          threadId,
          startNextQueuedRun(
            threadId,
            stored.event.type === "run.updated"
              ? {
                  endedRunId: stored.event.payload.id,
                  ...(stored.event.payload.status === "failed"
                    ? { failedRunId: stored.event.payload.id }
                    : {}),
                }
              : undefined,
          ),
        )
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to start the next queued V2 run", { threadId, cause }),
          ),
        );
      // After the queue decision: a provider failure holds the child's queued
      // wakes, and only then is the failed run the task's result.
      yield* settleAppOwnedSubagent(threadId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to react to terminal V2 run", {
          threadId: stored.event.threadId,
          sequence: stored.sequence,
          cause,
        }),
      ),
    );

  if (Option.isSome(monitors)) {
    yield* monitors.value.settled.pipe(
      Stream.runForEach((threadId) =>
        settleAppOwnedSubagent(threadId).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to settle monitored task", { threadId, cause }),
          ),
        ),
      ),
      Effect.forkDetach,
    );
  }

  const sameChildActivity = (
    left: OrchestrationV2Subagent["childActivity"],
    right: OrchestrationV2Subagent["childActivity"],
  ) =>
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.runId === right.runId &&
      left.status === right.status &&
      left.startedAt === right.startedAt &&
      left.completedAt === right.completedAt &&
      left.result === right.result);

  // Keep display activity separate from the original task result. In particular,
  // this never offers a completion delivery or creates another delegated task.
  const refreshSubagentActivity = (childThreadId: ThreadId) =>
    Effect.gen(function* () {
      const parentThreadId = yield* appOwnedSubagentParentThreadId(childThreadId);
      if (parentThreadId === undefined) return;
      yield* threadDispatch.withLock(
        parentThreadId,
        Effect.gen(function* () {
          const states = yield* projectionStore.getSubagentActivityState(childThreadId);
          if (states.length === 0) return;
          const now = yield* DateTime.now;
          const events: Array<Omit<OrchestrationV2DomainEvent, "id">> = [];
          for (const { task, item, run, result } of states) {
            const terminal = run === undefined ? null : delegatedTaskTerminalStatus(run.status);
            const childActivity =
              run === undefined
                ? undefined
                : {
                    runId: run.id,
                    status: terminal ?? ("running" as const),
                    startedAt: DateTime.toEpochMillis(run.startedAt ?? run.requestedAt),
                    completedAt:
                      terminal === null
                        ? null
                        : DateTime.toEpochMillis(run.completedAt ?? run.requestedAt),
                    result: terminal === null ? null : result,
                  };
            if (
              sameChildActivity(task.childActivity, childActivity) &&
              (item?.type !== "subagent" || sameChildActivity(item.childActivity, childActivity))
            )
              continue;
            events.push(
              {
                type: "subagent.updated",
                threadId: parentThreadId,
                ...(task.runId === null ? {} : { runId: task.runId }),
                nodeId: task.id,
                occurredAt: now,
                payload: { ...task, childActivity },
              },
              ...(item?.type !== "subagent"
                ? []
                : [
                    {
                      type: "turn-item.updated" as const,
                      threadId: parentThreadId,
                      ...(item.runId === null ? {} : { runId: item.runId }),
                      nodeId: task.id,
                      occurredAt: now,
                      payload: { ...item, childActivity },
                    },
                  ]),
            );
          }
          if (events.length) yield* writeSystemEvents(events);
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to refresh subagent activity", { childThreadId, cause }),
      ),
    );

  // Queue state is child-owned, but the parent's pending-work shell names it.
  // Refresh only on queued-run updates, never on streaming provider activity.
  const refreshQueuedChildParent = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const parentThreadId = yield* appOwnedSubagentParentThreadId(threadId);
      if (parentThreadId === undefined) return;
      yield* threadDispatch.withLock(
        parentThreadId,
        Effect.gen(function* () {
          const parent = yield* projectionStore.getThread(parentThreadId);
          const now = yield* DateTime.now;
          yield* writeSystemEvents([
            {
              type: "thread.metadata-updated",
              threadId: parentThreadId,
              occurredAt: now,
              payload: { ...parent, updatedAt: now },
            },
          ]);
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to refresh queued child's parent", { threadId, cause }),
      ),
    );

  // One thread's reactions run in event order; a reaction waiting on one thread's lock must
  // not hold up another thread's.
  const threadReactionTails = new Map<ThreadId, Deferred.Deferred<void>>();
  const reactInThreadOrder = Effect.fnUntraced(function* <R>(
    threadId: ThreadId,
    reaction: Effect.Effect<void, never, R>,
  ) {
    const done = yield* Deferred.make<void>();
    const previous = threadReactionTails.get(threadId);
    threadReactionTails.set(threadId, done);
    yield* (
      previous === undefined ? reaction : Effect.andThen(Deferred.await(previous), reaction)
    ).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          if (threadReactionTails.get(threadId) === done) threadReactionTails.delete(threadId);
          return Deferred.succeed(done, undefined);
        }),
      ),
      Effect.forkDetach,
    );
  });

  // Historical terminal events are already represented by the projections
  // below. Replaying the full event table on every server start delays live
  // queue promotion in proportion to the lifetime size of the database.
  const terminalEventsAfterSequence = yield* eventSink.latestSequence().pipe(Effect.orDie);
  // Queue promotion can wait on a provider or a thread lock. Subscribe to run
  // updates before buffering so that wait never retains unrelated tool bodies.
  yield* eventSink
    .stream({ afterSequence: terminalEventsAfterSequence, eventType: "run.updated" })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          !String(stored.commandId).startsWith("command:runtime-reconcile:") &&
          (stored.event.payload.status === "queued" ||
            (stored.event.payload.status === "starting" &&
              pendingSteerThreads.has(stored.event.threadId)) ||
            stored.event.payload.status === "completed" ||
            stored.event.payload.status === "interrupted" ||
            stored.event.payload.status === "failed" ||
            stored.event.payload.status === "cancelled" ||
            stored.event.payload.status === "rolled_back"),
      ),
      Stream.runForEach((stored) =>
        reactInThreadOrder(
          stored.event.threadId,
          Effect.gen(function* () {
            if (stored.event.type !== "run.updated") return;
            const threadId = stored.event.threadId;
            if (stored.event.payload.status !== "queued" && pendingSteerThreads.has(threadId)) {
              yield* threadDispatch.withLock(threadId, refreshPendingSteerThread(threadId));
            }
            if (stored.event.payload.status === "queued") yield* refreshQueuedChildParent(threadId);
            else if (stored.event.payload.status !== "starting") yield* handleTerminalRun(stored);
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to react to V2 run update", {
                threadId: stored.event.threadId,
                sequence: stored.sequence,
                cause,
              }),
            ),
          ),
        ),
      ),
      Effect.forkDetach,
    );

  // Run creation covers queued follow-ups, direct messages and background wakes.
  // Reconciliation updates cover restart continuations as well as normal terminals.
  yield* Stream.merge(
    eventSink.stream({ afterSequence: terminalEventsAfterSequence, eventType: "run.created" }),
    eventSink.stream({ afterSequence: terminalEventsAfterSequence, eventType: "run.updated" }),
  ).pipe(
    Stream.runForEach((stored) => refreshSubagentActivity(stored.event.threadId)),
    Effect.forkDetach,
  );

  // Work the agent hears back from (Claude reports every background command and monitor
  // exit) starts its next turn a moment after the roster empties. Settling first handed
  // parents the interim reply three times from 2026-11-23 to 11-25, so the task waits out
  // the continuation grace unless a Stop ended the work.
  const holdForAgentWake = (threadId: ThreadId, providerThreadId: ProviderThreadId) =>
    Effect.gen(function* () {
      if ((yield* appOwnedSubagentParentThreadId(threadId)) === undefined) return;
      const { runs } = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
      // As the task's progress reads rosters: the provider thread's latest turn, else the chat's.
      const run =
        latestExecutedRun(runs.filter((row) => row.providerThreadId === providerThreadId)) ??
        latestExecutedRun(runs);
      if (run?.status !== "completed") return;
      const { turnItems } = yield* projectionStore.getThreadRecords(threadId, ["turnItems"], {
        turnItemRunIds: [run.id],
        turnItemTypes: ["run_interrupt_request"],
      });
      if (turnItems.some((item) => item.type === "run_interrupt_request" && item.runId === run.id))
        return;
      yield* effectOutbox.enqueue([
        {
          id: backgroundWakeContinuationEffectId(run.id),
          commandId: CommandId.make(`command:${backgroundWakeContinuationEffectId(run.id)}`),
          threadId,
          request: { type: "provider-continuation.await", sourceRunId: run.id },
          availableAt: DateTime.add(
            yield* DateTime.now,
            RunExecutionService.PROVIDER_CONTINUATION_GRACE,
          ),
        },
      ]);
      yield* effectOutbox.notifyAvailable();
    });

  // A finished child turn can leave background work running, such as a backgrounded
  // command, and its task waits on it. A Stop, or the provider process exiting, ends that
  // work without another run, so the roster emptying is what settles the task. Rosters a
  // previous server left are startup recovery's.
  const rosteredProviderThreads = new Map<
    ProviderThreadId,
    NonNullable<OrchestrationV2ProviderThread["pendingBackgroundTasks"]>
  >();
  yield* eventSink
    .stream({ afterSequence: terminalEventsAfterSequence, eventType: "provider-thread.updated" })
    .pipe(
      Stream.runForEach((stored) => {
        if (stored.event.type !== "provider-thread.updated") return Effect.void;
        const providerThread = stored.event.payload;
        const roster = providerThread.pendingBackgroundTasks ?? [];
        if (roster.length > 0) {
          rosteredProviderThreads.set(providerThread.id, roster);
          return Effect.void;
        }
        const ended = rosteredProviderThreads.get(providerThread.id);
        if (ended === undefined) return Effect.void;
        rosteredProviderThreads.delete(providerThread.id);
        const threadId = stored.event.threadId;
        const hold = ended.some((task) => rosterTaskWakesAgent(task, providerThread.driver))
          ? holdForAgentWake(threadId, providerThread.id).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to hold a task for its agent's next turn", {
                  threadId,
                  cause,
                }),
              ),
            )
          : Effect.void;
        return reactInThreadOrder(
          threadId,
          Effect.andThen(hold, settleAppOwnedSubagent(threadId)).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to settle a task whose background work ended", {
                threadId,
                cause,
              }),
            ),
          ),
        );
      }),
      Effect.forkDetach,
    );

  // Provider events can arrive independently of commands. Recheck under the same
  // thread lock as edits, removals and manual promotion before consuming intent.
  yield* eventSink
    .stream({ afterSequence: terminalEventsAfterSequence, eventType: "provider-turn.updated" })
    .pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "provider-turn.updated" &&
          stored.event.payload.status === "running",
      ),
      Stream.runForEach((stored) => {
        const event = stored.event;
        if (event.type !== "provider-turn.updated" || !pendingSteerThreads.has(event.threadId))
          return Effect.void;
        const threadId = event.threadId;
        return reactInThreadOrder(
          threadId,
          threadDispatch
            .withLock(
              threadId,
              Effect.gen(function* () {
                const projection = yield* projectionStore.getMessageDispatchProjection(threadId, {
                  needsRunHistory: false,
                });
                const target = projection.runs.findLast(
                  (run) =>
                    run.status === "preparing" ||
                    run.status === "starting" ||
                    run.status === "running" ||
                    run.status === "waiting",
                );
                if (
                  target?.status !== "running" ||
                  target.activeAttemptId === null ||
                  target.activeAttemptId !== event.payload.runAttemptId ||
                  !projection.providerTurns.some(
                    (turn) => turn.id === event.payload.id && turn.status === "running",
                  )
                ) {
                  yield* refreshPendingSteerThread(threadId);
                  return;
                }
                const queued = projection.runs
                  .filter(
                    (run) =>
                      run.status === "queued" &&
                      run.steerWhenLiveRunId === target.id &&
                      run.providerInstanceId === target.providerInstanceId &&
                      run.modelSelection.model === target.modelSelection.model,
                  )
                  .sort(
                    (a, b) =>
                      (a.queuePosition ?? a.ordinal) - (b.queuePosition ?? b.ordinal) ||
                      a.ordinal - b.ordinal,
                  );
                if (queued.length === 0) {
                  yield* refreshPendingSteerThread(threadId);
                  return;
                }
                const providerThread = projection.providerThreads.find(
                  (thread) => thread.id === target.providerThreadId,
                );
                const session = projection.providerSessions.find(
                  (candidate) => candidate.id === providerThread?.providerSessionId,
                );
                if (
                  providerSteeringExecution(session) === null ||
                  projection.providerTurns.some(
                    (turn) =>
                      turn.id === event.payload.id && turn.steeringUnavailable !== undefined,
                  )
                ) {
                  if (session !== undefined) pendingSteerThreads.delete(threadId);
                  return;
                }
                for (const run of queued) {
                  yield* dispatchWithReceiptEffect(
                    {
                      type: "queued-message.promote-to-steer",
                      commandId: CommandId.make(`command:steer-when-live:${run.id}`),
                      threadId,
                      queuedRunId: run.id,
                      targetRunId: target.id,
                    },
                    {
                      runId: target.id,
                      attemptId: target.activeAttemptId,
                      providerTurnId: event.payload.id,
                      queuedRunId: run.id,
                    },
                  );
                }
                yield* refreshPendingSteerThread(threadId);
              }),
            )
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to promote queued steer", { threadId, cause }),
              ),
            ),
        );
      }),
      Effect.forkDetach,
    );

  // The task row and launch outbox commit atomically. Reading that admission
  // directly avoids an after-commit registration gap and rebuilds ownership on boot.
  yield* LocalSubagentResources.register({
    query: projectionStore.getExecutionResources,
    liveWork: projectionStore.getSubagentThreadsWithLiveWork,
    stopThread: dispatchWithReceipt,
  });

  // Settles child results and completion deliveries whose runs ended without
  // the listener above: before this boot, or in runtime reconciliation, which
  // it skips. Startup runs this after reconciliation and before the effect
  // worker. Queue recovery instead holds unstarted runs until an explicit
  // queue.resume command arrives.
  const recoverDelegatedTasks = Effect.gen(function* () {
    yield* projectionStore.getRecoveryThreadIds("subagent-activity").pipe(
      Effect.flatMap((threadIds) =>
        Effect.forEach(threadIds, refreshSubagentActivity, { concurrency: 1, discard: true }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to recover subagent activity", { cause }),
      ),
    );
    yield* projectionStore.getRecoveryThreadIds("subagent-results").pipe(
      // Candidate counts let a startup trace show whether recovery scales
      // with pending work or with history.
      Effect.tap((threadIds) =>
        Effect.annotateCurrentSpan("recovery.subagentResultThreads", threadIds.length),
      ),
      Effect.flatMap((threadIds) =>
        Effect.forEach(
          threadIds,
          (threadId) =>
            settleAppOwnedSubagent(threadId).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to recover terminal app-owned subagent", {
                  childThreadId: threadId,
                  cause,
                }),
              ),
            ),
          { concurrency: 8, discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to inspect app-owned subagents during recovery", {
          cause,
        }),
      ),
    );
    yield* projectionStore.getRecoveryThreadIds("delegated-completions").pipe(
      Effect.tap((threadIds) =>
        Effect.annotateCurrentSpan("recovery.delegatedCompletionThreads", threadIds.length),
      ),
      Effect.flatMap((threadIds) =>
        Effect.forEach(
          threadIds,
          (threadId) =>
            Effect.gen(function* () {
              const { subagents } = yield* projectionStore.getThreadRecords(threadId, [
                "subagents",
              ]);
              const deferred = new Set(
                subagents
                  .filter(
                    (task) =>
                      task.completionDelivery?.withNextTurn ||
                      task.completionDelivery?.state === "claimed",
                  )
                  .map((task) => task.id),
              );
              if (deferred.size > 0) {
                const { runs } = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
                for (const run of runs)
                  if (run.carriedTaskIds?.some((id) => deferred.has(id)))
                    yield* acknowledgeCarriedResults(run);
              }
              for (const task of subagents) {
                if (
                  task.origin !== "app_owned" ||
                  task.completionDelivery?.withNextTurn ||
                  (task.completionWake ?? "settled_only") !== "settled_only" ||
                  !isTerminalDelegatedTaskStatus(task.status) ||
                  ["acknowledged", "delivered", "disposed"].includes(
                    task.completionDelivery?.state ?? "pending",
                  )
                )
                  continue;
                yield* dispatchWithReceipt({
                  type: "delegated_task.wake-policy",
                  commandId: CommandId.make(`server:recover-waited-task:${task.id}`),
                  parentThreadId: threadId,
                  taskId: task.id,
                  completionWake: "always",
                });
              }
              yield* threadDispatch.withLock(
                threadId,
                Effect.gen(function* () {
                  const projection = yield* projectionStore.getThreadRecords(threadId, ["runs"]);
                  // Only the run that consumed a cohort's current delivery
                  // message can settle it. A long-lived parent keeps every
                  // past delivery run, and finalizing each of them would
                  // reload the thread once per historical delivery.
                  const openDeliveryMessageIds = new Set(
                    projection.runs.flatMap((run) =>
                      run.delegatedCompletion?.delivery == null
                        ? []
                        : [run.delegatedCompletion.delivery.messageId],
                    ),
                  );
                  const terminalDeliveryRunIds = projection.runs
                    .filter(
                      (run) =>
                        delegatedTaskTerminalStatus(run.status) !== null &&
                        openDeliveryMessageIds.has(run.userMessageId),
                    )
                    .map((run) => run.id);
                  for (const runId of terminalDeliveryRunIds) {
                    yield* finalizeDelegatedCompletionDelivery(threadId, runId);
                  }
                  const refreshed =
                    terminalDeliveryRunIds.length === 0
                      ? projection
                      : yield* projectionStore.getThreadRecords(threadId, ["runs"]);
                  for (const run of refreshed.runs) {
                    if (
                      run.delegatedCompletion?.delivery !== null &&
                      run.delegatedCompletion !== undefined
                    ) {
                      yield* offerDelegatedCompletionDelivery(threadId, run.id);
                    }
                  }
                }),
              );
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to recover delegated completion delivery", {
                  threadId,
                  cause,
                }),
              ),
            ),
          { concurrency: 8, discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to inspect delegated completion delivery during recovery", {
          cause,
        }),
      ),
    );
  });

  const delegatedTaskResultPending = (childThreadId: ThreadId, taskId?: NodeId) =>
    Effect.gen(function* () {
      const child = yield* projectionStore.getThreadRecords(
        childThreadId,
        ["runs", "messages", "subagents", "providerThreads", "providerTurns", "attempts"],
        { messageRoles: ["user"] },
      );
      const parentThreadId = child.thread.lineage.parentThreadId;
      const resolvedTaskId =
        taskId ??
        (child.thread.forkedFrom?.type === "node" ? child.thread.forkedFrom.nodeId : undefined);
      const parent =
        resolvedTaskId === undefined ||
        parentThreadId === null ||
        child.thread.lineage.parentEnvironmentId !== undefined
          ? undefined
          : yield* projectionStore.getThreadRecords(parentThreadId, ["subagents"]);
      const task = parent?.subagents.find(
        (task) => task.id === resolvedTaskId && task.remote === undefined,
      );
      const hasOpenMonitors = Option.isSome(monitors) && monitors.value.hasOpenWork(childThreadId);
      const progress =
        resolvedTaskId === undefined
          ? { ...delegatedTaskProgress({ ...child, hasOpenMonitors }), runs: child.runs }
          : task === undefined
            ? undefined
            : delegatedTaskProgressForTask(child, task, hasOpenMonitors);
      if (progress === undefined) return true;
      // A caller's older read saw a result; newer work since then means it is not final.
      if (progress.state !== "result_available") return true;
      if (progress.resultRun === undefined) return false;
      return yield* childAwaitsContinuation(progress.runs, progress.resultRun);
    }).pipe(
      Effect.mapError(
        (cause) => new OrchestratorProjectionError({ threadId: childThreadId, cause }),
      ),
    );

  const recoverDelegatedTask = (threadId: ThreadId, sourceRunId?: RunId) =>
    settleAppOwnedSubagent(
      threadId,
      sourceRunId === undefined ? undefined : { settledContinuationOf: sourceRunId },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to recover delegated task", {
          childThreadId: threadId,
          ...(sourceRunId === undefined ? {} : { sourceRunId }),
          cause,
        }),
      ),
    );

  const shellProjectionError = (cause: unknown) =>
    new OrchestratorProjectionError({ threadId: ThreadId.make("thread:shell"), cause });

  return OrchestratorV2.of({
    resumeQueuedRuns,
    recoverDelegatedTasks,
    recoverDelegatedTask,
    delegatedTaskResultPending,
    restartContinuationPending: (run) =>
      awaitsRestartContinuation(run).pipe(Effect.orElseSucceed(() => false)),
    awaitRestartContinuation: (run) =>
      effectOutbox.awaitSettled(`effect:restart-continuation:${run.id}`).pipe(Effect.ignore),
    dispatch: dispatchWithReceipt,
    searchThreadStream: (input) =>
      projectionStore
        .searchThreadStream(input)
        .pipe(
          Stream.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
          ),
        ),
    searchThread: (input) =>
      projectionStore
        .searchThread(input)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
          ),
        ),
    getThreadHistoryPage: (threadId, cursor, throughEntryId, conversationOnly) =>
      projectionStore
        .getThreadHistoryPage(threadId, cursor, throughEntryId, conversationOnly)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getThreadMediaPage: (threadId, cursor) =>
      projectionStore
        .getThreadMediaPage(threadId, cursor)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getTimelinePage: (threadId, options) =>
      projectionStore
        .getTimelinePage(threadId, options)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getMessageCount: (threadId) =>
      projectionStore
        .getMessageCount(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getTurnItem: (input) =>
      projectionStore
        .getTurnItem(input)
        .pipe(
          Effect.mapError(
            (cause) => new OrchestratorProjectionError({ threadId: input.threadId, cause }),
          ),
        ),
    getThreadRecords: (threadId, fields, filter) =>
      projectionStore
        .getThreadRecords(threadId, fields, filter)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getThreadProjection: (threadId) =>
      projectionStore
        .getThreadProjection(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getCheckpointContext: (threadId) =>
      projectionStore
        .getCheckpointContext(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getThreadSnapshot: (threadId) =>
      projectionStore
        .getThreadSnapshot(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getThreadSnapshotWindow: (threadId, options) =>
      projectionStore
        .getThreadSnapshotWindow(threadId, options)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getPullRequestSnapshot: (options) =>
      projectionStore.getPullRequestSnapshot(options).pipe(Effect.mapError(shellProjectionError)),
    getShellSnapshot: (options) =>
      projectionStore.getShellSnapshot(options).pipe(Effect.mapError(shellProjectionError)),
    readShellSnapshot: (options) =>
      projectionStore
        .readShellSnapshot(options)
        .pipe(
          Effect.mapError(shellProjectionError),
          Effect.map(Effect.mapError(shellProjectionError)),
        ),
    getThreadShell: (threadId) =>
      projectionStore
        .getThreadShell(threadId)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    getThreadEventSequence: (threadId) =>
      eventSink
        .latestSequence({ threadId })
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId, cause }))),
    streamStoredEvents: eventSink.stream().pipe(
      Stream.mapError(
        (cause) =>
          new OrchestratorDomainEventStreamError({
            cause,
          }),
      ),
    ),
    streamStoredEventsFrom: (input) =>
      eventSink.stream({ ...input, bounded: true }).pipe(
        Stream.mapError(
          (cause) =>
            new OrchestratorDomainEventStreamError({
              cause,
            }),
        ),
      ),
    // Live tail only. eventSink.stream() with no cursor replays the whole
    // store from genesis first; domain-event subscribers (the awareness relay)
    // react to new activity, and startup replay made them grind through the
    // entire event history doing per-event work after every boot.
    streamDomainEvents: Stream.unwrap(
      eventSink
        .latestSequence()
        .pipe(Effect.map((latest) => eventSink.stream({ afterSequence: latest }))),
    ).pipe(
      Stream.map((stored) => stored.event),
      Stream.mapError(
        (cause) =>
          new OrchestratorDomainEventStreamError({
            cause,
          }),
      ),
    ),
  });
});

export const layer: Layer.Layer<
  OrchestratorV2,
  never,
  | CheckpointServiceV2
  | FileSystem.FileSystem
  | Path.Path
  | CommandPolicyV2
  | CommandReceiptStoreV2
  | ContextHandoffServiceV2
  | EffectOutbox.EffectOutboxV2
  | EventSinkV2
  | IdAllocator.IdAllocatorV2
  | ProjectStore.ProjectStoreV2
  | ProviderAdapterRegistryV2
  | ProviderSessionManagerV2
  | ProviderSwitchServiceV2
  | ProjectionStoreV2
  | RuntimePolicyV2
  | ServerSettings.ServerSettingsService
  | ThreadForkServiceV2
> = Layer.effect(OrchestratorV2, makeOrchestrator()).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provideMerge(ExecutionResources.layer),
);

const layerUnavailable: Layer.Layer<OrchestratorV2> = Layer.succeed(
  OrchestratorV2,
  OrchestratorV2.of({
    resumeQueuedRuns: Effect.fail(
      new OrchestratorDispatchError({
        commandId: CommandId.make("command:system:resume-queued-runs"),
        commandType: "message.dispatch",
        cause: "Orchestration V2 live runtime is not configured.",
      }),
    ),
    recoverDelegatedTasks: Effect.void,
    recoverDelegatedTask: () => Effect.void,
    delegatedTaskResultPending: () => Effect.succeed(false),
    restartContinuationPending: () => Effect.succeed(false),
    awaitRestartContinuation: () => Effect.void,
    dispatch: (command) =>
      Effect.fail(
        new OrchestratorDispatchError({
          commandId: command.commandId,
          commandType: command.type,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    searchThreadStream: (input) =>
      Stream.fail(new OrchestratorProjectionError({ threadId: input.threadId })),
    searchThread: (input) =>
      Effect.fail(new OrchestratorProjectionError({ threadId: input.threadId })),
    getThreadHistoryPage: (threadId) => Effect.fail(new OrchestratorProjectionError({ threadId })),
    getThreadMediaPage: (threadId) => Effect.fail(new OrchestratorProjectionError({ threadId })),
    getTimelinePage: (threadId) => Effect.fail(new OrchestratorProjectionError({ threadId })),
    getMessageCount: (threadId) => Effect.fail(new OrchestratorProjectionError({ threadId })),
    getTurnItem: ({ threadId }) => Effect.fail(new OrchestratorProjectionError({ threadId })),
    getThreadRecords: (threadId) => Effect.fail(new OrchestratorProjectionError({ threadId })),
    getThreadProjection: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getCheckpointContext: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getThreadSnapshot: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getThreadSnapshotWindow: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getPullRequestSnapshot: () =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId: ThreadId.make("thread:shell"),
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getShellSnapshot: () =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId: ThreadId.make("thread:shell"),
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    readShellSnapshot: () =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId: ThreadId.make("thread:shell"),
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getThreadShell: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    getThreadEventSequence: (threadId) =>
      Effect.fail(
        new OrchestratorProjectionError({
          threadId,
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    streamStoredEvents: Stream.fail(
      new OrchestratorDomainEventStreamError({
        cause: "Orchestration V2 live runtime is not configured.",
      }),
    ),
    streamStoredEventsFrom: () =>
      Stream.fail(
        new OrchestratorDomainEventStreamError({
          cause: "Orchestration V2 live runtime is not configured.",
        }),
      ),
    streamDomainEvents: Stream.fail(
      new OrchestratorDomainEventStreamError({
        cause: "Orchestration V2 live runtime is not configured.",
      }),
    ),
  } satisfies OrchestratorV2Shape),
);
