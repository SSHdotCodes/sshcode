import { makeMessageDispatchHistory, javascriptTrimWhitespace } from "./MessageDispatchHistory.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import { isShownRunItem } from "./modelSwitch.ts";
import { omitIdleSubagentShells, type IdleSubagentOmission } from "./ShellStream.ts";
import { delegatedTaskRuns, followupRunsByMessage } from "./DelegatedTaskProgress.ts";
import type { ExecutionResource } from "../execution/ExecutionResources.ts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { MESSAGE_PREVIEW_SCAN_CHARS, messagePreviewLine } from "@t3tools/shared/messagePreview";
import { threadMediaIndex } from "@t3tools/client-runtime/thread-media";
import {
  MAX_TOOL_OUTPUT_IMAGES,
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  readToolOutputImage,
} from "@t3tools/shared/toolOutput";
import { applyThreadPullRequestLinkUpdate } from "@t3tools/shared/threadPullRequests";
import { COMMAND_OUTPUT_FAILURE_SCAN_CHARS, projectTurnItemForWire } from "./WireProjection.ts";
import * as SubagentRankings from "../subagentRankings/SubagentRankings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { terminalRunRecord } from "../subagentRankings/recording.ts";
import * as Stream from "effect/Stream";
import { makeThreadFind, findProjectedThreadItems } from "./ThreadFind.ts";
import type {
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
  OrchestrationV2ThreadHistoryPage,
  ThreadMediaPage,
  ChatAttachment,
} from "@t3tools/contracts";
import {
  runRanAfter,
  latestExecutedRun,
  latestRootProviderFailure,
  latestUnheldRun,
  threadErrorSummary,
  usageLimitRunPresentedAsLatest,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { threadPullRequestsOf } from "@t3tools/shared/threadPullRequests";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import type {
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2CheckpointScope,
  OrchestrationV2ExecutionNode,
  OrchestrationV2PlanArtifact,
  PlanId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShellSnapshot,
  OrchestrationV2ShellThreadStatus,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadShellStep,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
} from "@t3tools/contracts";
import {
  AssetResource,
  SECRET_REQUEST_TURN_ITEM_ID_PREFIX,
  PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES,
  isProviderSendTurnSupportedImageMimeType,
  OrchestrationV2AppThreadJson as OrchestrationV2AppThreadJsonSchema,
  OrchestrationV2CheckpointJson as OrchestrationV2CheckpointJsonSchema,
  OrchestrationV2CheckpointScopeJson as OrchestrationV2CheckpointScopeJsonSchema,
  OrchestrationV2ContextHandoffJson as OrchestrationV2ContextHandoffJsonSchema,
  OrchestrationV2ContextTransferJson as OrchestrationV2ContextTransferJsonSchema,
  OrchestrationV2ConversationMessageJson as OrchestrationV2ConversationMessageJsonSchema,
  OrchestrationV2ExecutionNodeJson as OrchestrationV2ExecutionNodeJsonSchema,
  OrchestrationV2PlanArtifact as OrchestrationV2PlanArtifactSchema,
  OrchestrationV2ProviderSessionJson as OrchestrationV2ProviderSessionJsonSchema,
  OrchestrationV2ProviderThreadJson as OrchestrationV2ProviderThreadJsonSchema,
  OrchestrationV2ProviderTurnJson as OrchestrationV2ProviderTurnJsonSchema,
  OrchestrationV2ProviderFailure as OrchestrationV2ProviderFailureSchema,
  OrchestrationV2RunAttemptJson as OrchestrationV2RunAttemptJsonSchema,
  OrchestrationV2RunJson as OrchestrationV2RunJsonSchema,
  OrchestrationV2RuntimeRequestJson as OrchestrationV2RuntimeRequestJsonSchema,
  OrchestrationV2SubagentJson as OrchestrationV2SubagentJsonSchema,
  OrchestrationV2TurnItemJson as OrchestrationV2TurnItemJsonSchema,
  orchestrationV2RunWorkStartedAt,
  isOrchestrationV2WorkActive,
  ProviderInstanceId,
  RunId,
  MessageId,
  RuntimeRequestId,
  CheckpointScopeId,
  ThreadId,
  TurnItemId,
  NodeId,
} from "@t3tools/contracts";
import {
  createOrchestrationV2TurnItemVisibility,
  isOrchestrationV2SupersededInterrupt,
} from "@t3tools/shared/orchestrationV2Timeline";
import {
  derivePendingBackgroundWork,
  deriveBlockedOnThreadWait,
  longRunningWorkForShell,
  type PendingBackgroundChildRun,
  type PendingBackgroundWorkSubagent,
} from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

import { MCP_APP_OUTPUT_KEY } from "@t3tools/shared/mcpApp";
import { sessionBoxAttention, sessionBoxNow } from "@t3tools/shared/sessionBoxes";
import * as BoxFaces from "../sessionBoxes/boxFaces.ts";
import * as ChatControls from "../sessionBoxes/chatControls.ts";
import * as ScheduledTaskShells from "../scheduledTasks/ScheduledTaskShells.ts";
import * as ChatTabs from "../sessionBoxes/chatTabs.ts";
import { lookupBoxNaming } from "../sessionBoxes/boxNamerCache.ts";
import { appMonitorCount } from "../monitors/appMonitorCounts.ts";
import { threadHtmlRenderAttachmentIds } from "../attachmentStore.ts";
import {
  decodeThreadMediaCursor,
  encodeThreadMediaCursor,
  isThreadHistoryUserTurn,
  isConversationHistoryItem,
  threadHistoryTurnStarts,
  THREAD_HISTORY_MAX_RAW_TURNS,
  missingInterruptRequests,
  olderHistoryPagePolicy,
  selectHistoryPageFromCursor,
  selectRecentTimelineWindow,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";

export class ProjectionStoreApplyEventError extends Schema.TaggedError<ProjectionStoreApplyEventError>()(
  "ProjectionStoreApplyEventError",
  {
    eventType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to apply orchestration projection event ${this.eventType}.`;
  }
}

export class ProjectionStoreSetupError extends Schema.TaggedError<ProjectionStoreSetupError>()(
  "ProjectionStoreSetupError",
  {
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return "Failed to initialize orchestration projection store.";
  }
}

export class ProjectionStoreThreadNotFoundError extends Schema.TaggedError<ProjectionStoreThreadNotFoundError>()(
  "ProjectionStoreThreadNotFoundError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `No orchestration projection exists for thread ${this.threadId}.`;
  }
}

export class ProjectionStoreReadError extends Schema.TaggedError<ProjectionStoreReadError>()(
  "ProjectionStoreReadError",
  {
    threadId: ThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to read orchestration projection for thread ${this.threadId}.`;
  }
}

export class ProjectionStoreNativeSessionReadError extends Schema.TaggedError<ProjectionStoreNativeSessionReadError>()(
  "ProjectionStoreNativeSessionReadError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Failed to read native session bindings.";
  }
}

export const ProjectionStoreV2Error = Schema.Union([
  ProjectionStoreSetupError,
  ProjectionStoreApplyEventError,
  ProjectionStoreThreadNotFoundError,
  ProjectionStoreReadError,
  ProjectionStoreNativeSessionReadError,
]);
export type ProjectionStoreV2Error = typeof ProjectionStoreV2Error.Type;

export type ProjectionRecoveryKind =
  | "queued-runs"
  | "steer-when-live"
  | "runtime"
  | "subagent-activity"
  | "subagent-results"
  | "delegated-completions";

interface SubagentActivityState {
  readonly task: OrchestrationV2Subagent;
  readonly item: OrchestrationV2TurnItem | undefined;
  readonly run: OrchestrationV2Run | undefined;
  readonly result: string | null;
}

function activityOnNewestCard(
  cards: ReadonlyArray<Pick<SubagentActivityState, "task" | "item">>,
  run?: OrchestrationV2Run,
  result: string | null = null,
): ReadonlyArray<SubagentActivityState> {
  return cards.flatMap(({ task, item }, index) => {
    const displayed = index === 0 ? run : undefined;
    if (!displayed && !task.childActivity && !(item?.type === "subagent" && item.childActivity))
      return [];
    return [{ task, item, run: displayed, result: displayed ? result : null }];
  });
}

/** Persisted state needed for limit recovery, without transcript or fork history. */
export type ProjectionLimitRecoveryCandidate = Pick<
  OrchestrationV2ThreadShell,
  | "lineage"
  | "creationSource"
  | "id"
  | "status"
  | "lastErrorClass"
  | "latestRunId"
  | "usageLimitResetAt"
  | "archivedAt"
  | "settledOverride"
  | "pendingRuntimeRequest"
  | "latestRunCompletedAt"
  | "updatedAt"
  | "limitRecovery"
  | "snoozedUntil"
>;

/** A chat whose latest run stopped because its provider was signed out. */
export interface ProjectionSignedOutStop {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly completedAt: DateTime.Utc;
}

/** The lead decides whether to retry a delegated task. */
export function isLeadManagedTask(
  thread: Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "creationSource">,
): boolean {
  return thread.lineage.relationshipToParent === "subagent" && thread.creationSource !== "provider";
}

/** Revalidate after provider I/O, which may outlive the failure or the user's selection. */
export function isCurrentRecoveryStop(
  stop: ProjectionSignedOutStop,
  thread: OrchestrationV2ThreadShell | null,
  now: DateTime.Utc,
): boolean {
  return (
    thread !== null &&
    !isLeadManagedTask(thread) &&
    thread.status === "failed" &&
    thread.latestRunId === stop.runId &&
    thread.providerInstanceId === stop.providerInstanceId &&
    modelSelectionsEqual(thread.modelSelection, stop.modelSelection) &&
    thread.pendingRuntimeRequest === null &&
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    thread.settledOverride !== "settled" &&
    (thread.snoozedUntil == null ||
      DateTime.toEpochMillis(thread.snoozedUntil) <= DateTime.toEpochMillis(now))
  );
}

/** The thread fields pull request sync reads, for a thread with at least one link. */
export type ProjectionThreadPullRequests = Pick<
  OrchestrationV2AppThread,
  "id" | "projectId" | "lineage" | "settledOverride" | "settledAt" | "pullRequests"
>;

/**
 * Thread activity needed by settlement, without transcript or fork history.
 * Settlement always loads `latestUserAuthoredMessageAt`, so it is required here.
 */
export type ProjectionSettlementCandidate = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "projectId"
  | "branch"
  | "worktreePath"
  | "pullRequests"
  | "linkedPullRequest"
  | "branchPullRequest"
  | "createdAt"
  | "updatedAt"
  | "archivedAt"
  | "settledOverride"
  | "pinnedAt"
  | "autoSettleDisabledAt"
  | "createdBy"
  | "creationSource"
  | "lineage"
  | "snoozedUntil"
  | "snoozedAt"
  | "latestRunId"
  | "latestRunRequestedAt"
  | "latestRunStartedAt"
  | "latestRunCompletedAt"
  | "latestUserMessageAt"
  | "status"
  | "activityRunStartedAt"
  | "activityRunStatus"
  | "pendingRuntimeRequest"
  | "pendingBackgroundTasks"
> &
  Pick<OrchestrationV2AppThread, "lastSnoozeWakeAt"> & {
    readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
  };

const ProjectionCheckpointContext = Schema.Struct({
  runs: Schema.Array(
    OrchestrationV2RunJsonSchema.mapFields(({ id, ordinal, status }) => ({ id, ordinal, status })),
  ),
  checkpointScopes: Schema.Array(
    OrchestrationV2CheckpointScopeJsonSchema.mapFields(({ id, runId, kind, cwd }) => ({
      id,
      runId,
      kind,
      cwd,
    })),
  ),
  checkpoints: Schema.Array(
    OrchestrationV2CheckpointJsonSchema.mapFields(
      ({ scopeId, runId, appRunOrdinal, status, ref }) => ({
        scopeId,
        runId,
        appRunOrdinal,
        status,
        ref,
      }),
    ),
  ),
});
export type ProjectionCheckpointContext = typeof ProjectionCheckpointContext.Type;
const decodeCheckpointContext = Schema.decodeUnknownEffect(ProjectionCheckpointContext);

/** Durable capture targets, without transcript or checkpoint file payloads. */
export interface ProjectionCheckpointCaptureContext {
  readonly run: OrchestrationV2Run | undefined;
  readonly rootNode: OrchestrationV2ExecutionNode | undefined;
  readonly scope: OrchestrationV2CheckpointScope | undefined;
  readonly providerThread: OrchestrationV2ProviderThread | undefined;
  readonly readyCheckpointOrdinals: ReadonlyArray<number>;
  /** Ordinals whose checkpoint belongs to a run, whatever its status. */
  readonly runCheckpointOrdinals: ReadonlyArray<number>;
}

/** Exact durable targets used by interrupt, restart, and steering effects. */
export interface ProjectionProviderControlContext {
  readonly providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] | undefined;
  readonly providerTurn: OrchestrationV2ProviderTurn | undefined;
  readonly attempt: OrchestrationV2ThreadProjection["attempts"][number] | undefined;
  readonly message: OrchestrationV2ConversationMessage | undefined;
  readonly run: OrchestrationV2Run | undefined;
}

export interface ProjectionProviderControlTarget {
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly attemptId?: RunAttemptId;
  readonly messageId?: MessageId;
}

export type ProjectionRuntimeRecoveryState = Pick<
  OrchestrationV2ThreadProjection,
  | "thread"
  | "runs"
  | "attempts"
  | "nodes"
  | "subagents"
  | "providerSessions"
  | "providerThreads"
  | "providerTurns"
  | "runtimeRequests"
  | "messages"
  | "turnItems"
>;

export type ProjectionPendingUserInputs = Pick<
  OrchestrationV2ThreadProjection,
  "runtimeRequests" | "nodes" | "turnItems"
>;

export type ProjectionThreadProviderContext = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "providerSessions" | "providerThreads"
>;
export interface ProjectionRuntimeResponseContext {
  readonly request: OrchestrationV2ThreadProjection["runtimeRequests"][number] | undefined;
  readonly node: OrchestrationV2ThreadProjection["nodes"][number] | undefined;
  readonly item: OrchestrationV2ThreadProjection["turnItems"][number] | undefined;
  readonly session: OrchestrationV2ThreadProjection["providerSessions"][number] | undefined;
}

/** A question pending on a delegated child thread, with the run that asked it. */
export interface ProjectionPendingChildQuestion {
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly request: OrchestrationV2ThreadProjection["runtimeRequests"][number];
}

/** Control rows used to accept a send, including a stale explicit steering target. */
export interface MessageDispatchRead {
  readonly messageId?: MessageId | undefined;
  readonly queuedStart?: boolean;
  readonly includeSubagents?: boolean;
  readonly resumeQueue?: boolean;
  readonly followupTaskId?: NodeId;
  readonly checkMaintenanceHistory?: boolean;
  readonly targetRunId?: RunId | undefined;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly needsRunHistory: boolean;
  readonly pendingHistoryEdits?: boolean;
}
export interface ProjectionRecordFilter {
  readonly activeRunsOnly?: boolean;
  readonly providerThreadIds?: ReadonlyArray<ProviderThreadId>;
  readonly providerTurnIds?: ReadonlyArray<ProviderTurnId>;
  readonly providerTurnAttemptIds?: ReadonlyArray<RunAttemptId | null>;
  /** Identity-based command decisions do not consume transcript order. */
  readonly unorderedMessages?: boolean;
  readonly nodeIds?: ReadonlyArray<NodeId>;
  readonly nodeRunIds?: ReadonlyArray<RunId>;
  readonly liveNodesOnly?: boolean;
  readonly attemptRunIds?: ReadonlyArray<RunId>;
  readonly pendingRuntimeRequestsOnly?: boolean;
  /** Resolve pending runtime requests and their matching nodes/cards in one snapshot. */
  readonly pendingRuntimeRequestControls?: boolean;
  readonly pendingIncomingTransfersOnly?: boolean;
  /** Resolve the selected queued runs and their records in the same snapshot. */
  readonly queuedControls?: boolean;
  readonly turnItemIds?: ReadonlyArray<OrchestrationV2TurnItem["id"]>;
  readonly turnItemNodeIds?: ReadonlyArray<NodeId>;
  readonly turnItemMessageIds?: ReadonlyArray<MessageId>;
  readonly checkpointScopeIds?: ReadonlyArray<CheckpointScopeId>;
  readonly messageRoles?: ReadonlyArray<OrchestrationV2ConversationMessage["role"]>;
  readonly turnItemRunId?: RunId;
  readonly messageIds?: ReadonlyArray<MessageId>;
  readonly messageRunIds?: ReadonlyArray<RunId>;
  readonly turnItemRunIds?: ReadonlyArray<RunId | null>;
  readonly runIds?: ReadonlyArray<RunId>;
  readonly turnItemTypes?: ReadonlyArray<OrchestrationV2TurnItem["type"]>;
  readonly turnItemStatuses?: ReadonlyArray<OrchestrationV2TurnItem["status"]>;
  // Skips finished tool call, assistant message and reasoning nodes of finished
  // runs. Command decisions only read root, subagent and active-run nodes.
  readonly omitSettledLeafNodes?: boolean;
}

const queueFilter = (runs: readonly OrchestrationV2Run[], filter: ProjectionRecordFilter) => {
  const messageIds = runs.map((run) => run.userMessageId);
  const runIds = runs.map((run) => run.id);
  return {
    ...filter,
    runIds,
    messageIds,
    turnItemMessageIds: messageIds,
    nodeIds: runs.flatMap((run) => (run.rootNodeId === null ? [] : [run.rootNodeId])),
    attemptRunIds: runIds,
    unorderedMessages: true,
  };
};
// The slice orchestration_v2_projection_turn_items_recovery_idx covers.
const ACTIVE_BACKGROUND_WORK_TYPES = ["command_execution", "dynamic_tool", "subagent"] as const;
const ACTIVE_BACKGROUND_WORK_STATUSES = ["pending", "running", "waiting"] as const;
const hasExactly = (
  values: ReadonlyArray<string> | undefined,
  wanted: ReadonlyArray<string>,
): boolean =>
  values !== undefined &&
  values.length === wanted.length &&
  wanted.every((value) => values.includes(value));
type ProjectionNode = OrchestrationV2ThreadProjection["nodes"][number];
type ProjectionRun = OrchestrationV2ThreadProjection["runs"][number];
const settledLeafNodeKinds: ReadonlySet<ProjectionNode["kind"]> = new Set([
  "tool_call",
  "assistant_message",
  "reasoning",
]);
const settledNodeStatuses: ReadonlySet<ProjectionNode["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);
const activeRunStatuses: ReadonlySet<ProjectionRun["status"]> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

// In-memory twin of the omitSettledLeafNodes SQL clause in readCanonicalProjection.
const isSettledLeafNode = (node: ProjectionNode, runs: ReadonlyArray<ProjectionRun>) =>
  settledLeafNodeKinds.has(node.kind) &&
  settledNodeStatuses.has(node.status) &&
  node.runId !== null &&
  !runs.some((run) => run.id === node.runId && activeRunStatuses.has(run.status));
export type ProjectionRecordField = Exclude<
  keyof OrchestrationV2ThreadProjection,
  "thread" | "updatedAt" | "visibleTurnItems"
>;
export type ProjectionRecords<K extends ProjectionRecordField> = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | K
>;

export interface ProjectionTimelinePageOptions {
  readonly afterPosition?: number;
  readonly fromEnd?: boolean;
  readonly beforePosition?: number;
  readonly itemId?: TurnItemId;
  readonly view?: "messages" | "activity";
  readonly limit: number;
}
export interface ProjectionTimelinePage {
  readonly items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>;
  readonly totalItems: number;
  readonly hasMore: boolean;
}

export interface ShellSnapshotOptions {
  readonly location?: "active" | "archive";
  /**
   * Reads only this project's threads. Fork sources in other projects still
   * load, so visible item counts match the unscoped snapshot.
   */
  readonly projectId?: ProjectId;
  /**
   * For background sweeps, not clients: skips settled threads before any of
   * their run, item or session rows are read.
   */
  readonly unsettledOnly?: boolean;
  /**
   * Only the subagent threads sharing this thread's `lineage.rootThreadId`. The thread may be
   * deleted: forks keep a deleted source's root, and their subagent trees still need it.
   */
  readonly subagentFamilyOf?: ThreadId;
  readonly allSubagentThreads?: boolean;
  /** Leaves subagent threads out before their rows are read. Fork sources still load. */
  readonly excludeSubagents?: boolean;
  readonly omitIdleSubagents?: IdleSubagentOmission | undefined;
  readonly worktreePath?: string;
}

/** A chat's read mark: when someone last opened it. */
export interface ProjectionReadMark {
  readonly threadId: ThreadId;
  readonly lastVisitedAt: DateTime.Utc | null;
}

/** What the chat visit log records at each opening. */
export interface ProjectionChatVisitSnapshot {
  /** Unarchived, unsettled chats other than subagents, in shell snapshot order. */
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** Every unarchived, unsettled chat's read mark, subagents included. */
  readonly readMarks: ReadonlyArray<ProjectionReadMark>;
}

interface NativeSessionBinding {
  readonly providerInstanceId: string;
  readonly nativeId: string;
  readonly threadId: ThreadId;
}

export interface UsageProjectionBinding {
  readonly threadId: ThreadId;
  readonly title: string;
  readonly instanceId: ProviderInstanceId;
  readonly sessionId: string;
  readonly parentThreadId: ThreadId | null;
}

export interface ProjectionStoreV2Shape {
  readonly getUsageSubagentRuns: (threadIds: readonly ThreadId[]) => Effect.Effect<
    {
      readonly runs: readonly {
        readonly id: string;
        readonly threadId: ThreadId;
        readonly model: string;
      }[];
      readonly truncated: boolean;
    },
    ProjectionStoreV2Error
  >;

  /** Hard bounds keep panel reads off large history scans on the shared reader. */
  readonly getUsageBindings: (
    threadId: ThreadId,
    instanceIds: readonly ProviderInstanceId[],
  ) => Effect.Effect<
    { readonly bindings: readonly UsageProjectionBinding[]; readonly truncated: boolean },
    ProjectionStoreV2Error
  >;
  readonly getUsageCompactions: (threadId: ThreadId) => Effect.Effect<
    {
      readonly items: readonly Extract<OrchestrationV2TurnItem, { type: "compaction" }>[];
      readonly truncated: boolean;
    },
    ProjectionStoreV2Error
  >;
  readonly findNativeSessionThreads: (
    sessions: ReadonlyArray<Pick<NativeSessionBinding, "providerInstanceId" | "nativeId">>,
  ) => Effect.Effect<ReadonlyArray<NativeSessionBinding>, ProjectionStoreNativeSessionReadError>;
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, ProjectionStoreV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, ProjectionStoreV2Error>;
  readonly getThreadAttachmentIds: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<string>, ProjectionStoreV2Error>;
  readonly getThreadHistoryPage: (
    threadId: ThreadId,
    cursor: string,
    throughEntryId?: string,
    conversationOnly?: boolean,
  ) => Effect.Effect<OrchestrationV2ThreadHistoryPage, ProjectionStoreV2Error>;
  readonly getThreadMediaPage: (
    threadId: ThreadId,
    cursor: string,
  ) => Effect.Effect<ThreadMediaPage, ProjectionStoreV2Error>;
  readonly getTimelinePage: (
    threadId: ThreadId,
    options: ProjectionTimelinePageOptions,
  ) => Effect.Effect<ProjectionTimelinePage, ProjectionStoreV2Error>;
  readonly getMessageDispatchProjection: (
    threadId: ThreadId,
    input: MessageDispatchRead,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>;
  readonly hasMessages: (threadId: ThreadId) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly hasStartedRunAfter: (
    threadId: ThreadId,
    ordinal: number,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly getMessageCount: (threadId: ThreadId) => Effect.Effect<number, ProjectionStoreV2Error>;
  readonly getNextTurnItemOrdinal: (
    threadId: ThreadId,
  ) => Effect.Effect<number, ProjectionStoreV2Error>;
  /** One persisted turn item, or null when the thread has no such item. */
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2TurnItem | null, ProjectionStoreV2Error>;
  readonly getThreadRecords: <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<ProjectionRecords<K>, ProjectionStoreV2Error>;

  /** Newest assignment and any older cards whose display activity needs clearing. */
  readonly getSubagentActivityState: (
    childThreadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<SubagentActivityState>, ProjectionStoreV2Error>;

  /** Read metadata in the transaction; return a save that runs only after commit, without SQL. */
  readonly prepareSubagentRankings?: (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<Effect.Effect<void>>;
  /** Same contract: finds each chat's first subagent and opens or closes its ask. */
  readonly prepareFirstSubagentAsk?: (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<Effect.Effect<void>>;
  /**
   * Same contract: returns what clears the shell's cached message boxes for the
   * events' threads. A transaction that applies events must run it after commit.
   */
  readonly prepareMessageBoxInvalidation?: (
    events: ReadonlyArray<OrchestrationV2DomainEvent>,
  ) => Effect.Effect<Effect.Effect<void>>;
  readonly apply: (
    event: OrchestrationV2DomainEvent,
  ) => Effect.Effect<void, ProjectionStoreV2Error>;
  readonly getPullRequestSnapshot: (options: {
    readonly threadId?: ThreadId;
    readonly unsettledOnly?: boolean;
  }) => Effect.Effect<
    {
      readonly snapshotSequence: number;
      readonly threads: ReadonlyArray<typeof PullRequestThread.Type>;
    },
    ProjectionStoreV2Error
  >;
  readonly getShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error>;
  /**
   * The unsettled unarchived shell snapshot's top-level chats and every chat's read mark,
   * from one read. Subagents, most of the unsettled list, cost one payload field each
   * instead of their item counts, runs and messages.
   */
  readonly getChatVisitSnapshot: () => Effect.Effect<
    ProjectionChatVisitSnapshot,
    ProjectionStoreV2Error
  >;
  /**
   * Unarchived chats with a turn in flight, and the model each is set to. It reads
   * the few unfinished runs from their index, so a poll that only wants live chats
   * never pays for the whole chat list on the connection every write shares.
   */
  readonly getLiveThreadModels: () => Effect.Effect<
    ReadonlyArray<LiveThreadModel>,
    ProjectionStoreV2Error
  >;
  /**
   * Runs the shell snapshot's SQL reads and returns the step that decodes them.
   * Callers that combine the shell with other reads run this inside their own
   * transaction and the returned decode after it commits, so the shared
   * connection is not held while thousands of rows are converted.
   */
  readonly readShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, ProjectionStoreV2Error>,
    ProjectionStoreV2Error
  >;
  readonly getThreadShell: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadShell | null, ProjectionStoreV2Error>;
  readonly getThread: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2AppThread, ProjectionStoreV2Error>;
  readonly getProviderRetryCandidates: (
    now: DateTime.Utc,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2Run>, ProjectionStoreV2Error>;
  /**
   * Child threads of local app-owned tasks still recorded as working, whose child has had
   * no queued, starting or running run, and whose task record has not changed, since
   * `idleSince`.
   */
  readonly getIdleDelegatedTaskThreadIds: (
    idleSince: DateTime.Utc,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionStoreV2Error>;
  readonly getLimitRecoveryCandidates: (options: {
    readonly now: DateTime.Utc;
    readonly autoResume: boolean;
    readonly snooze: boolean;
  }) => Effect.Effect<ReadonlyArray<ProjectionLimitRecoveryCandidate>, ProjectionStoreV2Error>;
  /**
   * Chats whose latest run failed since `since` with an error whose message
   * starts with `messagePrefix` (or contains `messageContains`), and that
   * nothing else has picked up: no newer run, no pending request, not
   * archived, settled, snoozed, or a provider's own subagent. Oldest first.
   */
  readonly getSignedOutStops: (
    options: { readonly since: DateTime.Utc } & (
      | { readonly messagePrefix: string; readonly messageContains?: undefined }
      | { readonly messageContains: string; readonly messagePrefix?: undefined }
    ),
  ) => Effect.Effect<ReadonlyArray<ProjectionSignedOutStop>, ProjectionStoreV2Error>;
  /** Every candidate, or only `threadId` when a sweep checks one thread. */
  readonly getSettlementCandidates: (
    threadId?: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionSettlementCandidate>, ProjectionStoreV2Error>;
  /**
   * Active (not deleted, not archived) threads with at least one pull request
   * link, in shell snapshot order, or only `threadId` when given. Skips run,
   * message and item reads.
   */
  readonly getThreadsWithPullRequests: (
    threadId?: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPullRequests>, ProjectionStoreV2Error>;
  /** Admissions committed with the child's launch effects, including deleted owners. */
  readonly getExecutionResources: (
    threadId?: ThreadId,
    pinsOnly?: boolean,
  ) => Effect.Effect<ReadonlyArray<ExecutionResource>, ProjectionStoreV2Error>;
  /**
   * The given subagent threads with work left in their subtree: a live run, live background tool
   * work, an unfinished subagent, or one of `liveThreadIds` (monitor owners). Stop skips the rest.
   */
  readonly getSubagentThreadsWithLiveWork: (
    threadIds: ReadonlyArray<ThreadId>,
    liveThreadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlySet<ThreadId>, ProjectionStoreV2Error>;
  /**
   * Active (not deleted, not archived) threads that have a worktree path, the
   * same threads as the shell snapshot's `threads`. Reads only the thread rows,
   * so callers can check who uses a path without a shell snapshot.
   */
  readonly getThreadWorktreePaths: () => Effect.Effect<
    ReadonlyArray<{ readonly threadId: ThreadId; readonly worktreePath: string }>,
    ProjectionStoreV2Error
  >;
  readonly getTurnStartContext: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<
    Pick<
      OrchestrationV2ThreadProjection,
      | "thread"
      | "runs"
      | "attempts"
      | "nodes"
      | "subagents"
      | "providerSessions"
      | "providerThreads"
      | "providerTurns"
      | "messages"
      | "checkpointScopes"
      | "contextHandoffs"
      | "contextTransfers"
      | "turnItems"
    > & { readonly hasConversation: boolean },
    ProjectionStoreV2Error
  >;
  readonly getTurnStartHistory: (
    threadId: ThreadId,
    runIds?: ReadonlyArray<RunId>,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2TurnItem>, ProjectionStoreV2Error>;
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error>;
  readonly getRuntimeRecoveryProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionRuntimeRecoveryState, ProjectionStoreV2Error>;
  readonly getPendingNativeUserInputs: (
    threadId: ThreadId,
    providerTurnId: ProviderTurnId,
  ) => Effect.Effect<ProjectionPendingUserInputs, ProjectionStoreV2Error>;
  readonly getPlan: (
    threadId: ThreadId,
    planId: PlanId,
  ) => Effect.Effect<OrchestrationV2PlanArtifact | undefined, ProjectionStoreV2Error>;
  readonly hasUnpairedRunInterruptRequest: (
    threadId: ThreadId,
    requestId: TurnItemId,
    resultId: TurnItemId,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  /** True when the projection already stores this exact node, so a write would change nothing. */
  readonly isNodeStored: (
    node: OrchestrationV2ExecutionNode,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  readonly getRuntimeRequest: (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) => Effect.Effect<
    OrchestrationV2ThreadProjection["runtimeRequests"][number] | undefined,
    ProjectionStoreV2Error
  >;
  /** Pending delegated questions, newest first; the cursor excludes the last returned row. */
  readonly getPendingChildQuestions: (
    limit: number,
    before?: { readonly createdAt: DateTime.Utc; readonly requestId: RuntimeRequestId },
  ) => Effect.Effect<ReadonlyArray<ProjectionPendingChildQuestion>, ProjectionStoreV2Error>;
  readonly getProviderControlContext: (
    threadId: ThreadId,
    target: ProjectionProviderControlTarget,
  ) => Effect.Effect<ProjectionProviderControlContext, ProjectionStoreV2Error>;
  readonly getRunningTurnContext: (
    threadId: ThreadId,
  ) => Effect.Effect<
    Pick<ProjectionProviderControlContext, "run" | "providerThread" | "providerTurn">,
    ProjectionStoreV2Error
  >;
  readonly getThreadProviderContext: (
    threadId: ThreadId,
    targetInstanceId?: ProviderInstanceId,
  ) => Effect.Effect<ProjectionThreadProviderContext, ProjectionStoreV2Error>;
  readonly getRuntimeResponseContext: (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
  ) => Effect.Effect<ProjectionRuntimeResponseContext, ProjectionStoreV2Error>;
  readonly getCheckpointContext: (
    threadId: ThreadId,
  ) => Effect.Effect<ProjectionCheckpointContext, ProjectionStoreV2Error>;
  readonly getCheckpointCaptureContext: (
    threadId: ThreadId,
    target: { readonly runId: RunId; readonly scopeId: CheckpointScopeId },
  ) => Effect.Effect<ProjectionCheckpointCaptureContext, ProjectionStoreV2Error>;
  readonly getRunMessage: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<OrchestrationV2ConversationMessage | undefined, ProjectionStoreV2Error>;
  readonly canStartQueuedRun: (
    threadId: ThreadId,
  ) => Effect.Effect<boolean, ProjectionStoreV2Error>;
  /**
   * The context window this provider instance last reported for any thread, for providers
   * that report it only after a turn. Undefined when none has, or the read fails.
   */
  readonly getReportedContextWindow?: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<number | undefined>;
  readonly getRecoveryThreadIds: (
    kind: ProjectionRecoveryKind,
  ) => Effect.Effect<ReadonlyArray<ThreadId>, ProjectionStoreV2Error>;
  readonly getUnreadableThreadIds: () => Effect.Effect<
    ReadonlyArray<ThreadId>,
    ProjectionStoreV2Error
  >;
  readonly getThreadSnapshot: (threadId: ThreadId) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    ProjectionStoreV2Error
  >;
  readonly getThreadSnapshotWindow: (
    threadId: ThreadId,
    options: {
      /** Row fallback for histories without turn starts. */
      readonly rowLimit: number;
      /** User-turn window, with extra anchors for the inclusive cursor and has-more check. */
      readonly userTurnLimit?: number | undefined;
      readonly anchorItemId?: TurnItemId | undefined;
      readonly anchorThreadId?: ThreadId | undefined;
      readonly requiredRunId?: RunId | undefined;
      /** Trim fields discarded by wire projection before crossing the SQLite worker boundary. */
      readonly forWire?: boolean | undefined;
    },
  ) => Effect.Effect<
    {
      readonly schemaVersion: number;
      readonly snapshotSequence: number;
      readonly projection: OrchestrationV2ThreadProjection;
    },
    ProjectionStoreV2Error
  >;
}

export class ProjectionStoreV2 extends Context.Service<ProjectionStoreV2, ProjectionStoreV2Shape>()(
  "t3/orchestration-v2/ProjectionStore/ProjectionStoreV2",
) {}

export const ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION = 2;

const TERMINAL_RUN_STATUSES = new Set<OrchestrationV2Run["status"]>([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
  "rolled_back",
]);

/** A follow-up task, not the child's original one, whose unbound run has ended. */
function lostFollowupSettled(
  child: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "messages">,
  task: OrchestrationV2Subagent,
): boolean {
  const forkedFrom = child.thread.forkedFrom;
  return (
    forkedFrom?.type === "node" &&
    task.id !== forkedFrom.nodeId &&
    followupRunsByMessage(child, task).some((run) => TERMINAL_RUN_STATUSES.has(run.status))
  );
}

function needsRecovery(
  projection: OrchestrationV2ThreadProjection,
  kind: ProjectionRecoveryKind,
  parent?: Pick<OrchestrationV2ThreadProjection, "subagents" | "contextTransfers">,
): boolean {
  if (projection.thread.deletedAt !== null) return false;
  switch (kind) {
    case "subagent-activity":
      return (
        projection.runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ||
        projection.turnItems.some(
          (item) => item.type === "subagent" && item.childActivity?.status === "running",
        )
      );
    case "queued-runs":
      return (
        projection.thread.archivedAt === null &&
        projection.runs.some((run) => run.status === "queued") &&
        !projection.runs.some((run) =>
          ["preparing", "starting", "running", "waiting"].includes(run.status),
        )
      );
    case "steer-when-live":
      return projection.runs.some(
        (run) => run.status === "queued" && run.steerWhenLiveRunId !== undefined,
      );
    case "delegated-completions":
      return (
        projection.runs.some((run) => run.delegatedCompletion?.delivery != null) ||
        projection.subagents.some(
          (task) =>
            task.origin === "app_owned" &&
            (task.completionDelivery?.withNextTurn ||
              (task.completionWake ?? "settled_only") === "settled_only") &&
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status) &&
            !["acknowledged", "delivered", "disposed"].includes(
              task.completionDelivery?.state ?? "pending",
            ),
        )
      );
    case "subagent-results": {
      const parentThreadId = projection.thread.lineage.parentThreadId;
      return (
        projection.thread.lineage.relationshipToParent === "subagent" &&
        projection.thread.lineage.parentEnvironmentId === undefined &&
        parentThreadId !== null &&
        projection.thread.forkedFrom?.type === "node" &&
        ((parent?.subagents ?? []).some(
          (task) =>
            task.origin === "app_owned" &&
            task.result === null &&
            task.childThreadId === projection.thread.id &&
            projection.runs.some(
              (run) =>
                run.delegatedTaskId === task.id &&
                ["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
                  run.status,
                ),
            ),
        ) ||
          (parent?.subagents ?? []).some(
            (task) =>
              task.origin === "app_owned" &&
              task.result === null &&
              task.childThreadId === projection.thread.id &&
              lostFollowupSettled(projection, task),
          ) ||
          (["completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(
            latestUnheldRun(projection.runs)?.status ?? "idle",
          ) &&
            ![...projection.contextTransfers, ...(parent?.contextTransfers ?? [])].some(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === projection.thread.id &&
                transfer.targetThreadId === parentThreadId,
            )))
      );
    }
    case "runtime":
      return (
        projection.runs.some(
          (run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status) ||
            (run.status === "queued" && run.queueHeld !== true),
        ) ||
        projection.runtimeRequests.some((request) => request.status === "pending") ||
        projection.subagents.some(
          (subagent) =>
            subagent.origin === "provider_native" &&
            ["pending", "running", "waiting"].includes(subagent.status),
        ) ||
        projection.providerSessions.some(
          (session) => session.status !== "stopped" && session.status !== "error",
        ) ||
        projection.providerThreads.some(
          (thread) =>
            thread.status === "active" || (thread.pendingBackgroundTasks?.length ?? 0) > 0,
        ) ||
        projection.turnItems.some(
          (item) =>
            ["command_execution", "dynamic_tool", "subagent"].includes(item.type) &&
            ["pending", "running", "waiting"].includes(item.status) &&
            !projection.runs.some((run) => run.id === item.runId && run.status === "rolled_back"),
        )
      );
  }
}

function upsertById<T extends { readonly id: string }>(items: ReadonlyArray<T>, next: T): Array<T> {
  const index = items.findIndex((item) => item.id === next.id);
  if (index === -1) {
    return [...items, next];
  }

  const updated = [...items];
  updated[index] = next;
  return updated;
}

export function upsertProviderTurn(
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  next: OrchestrationV2ProviderTurn,
): Array<OrchestrationV2ProviderTurn> {
  const current = turns.find((turn) => turn.id === next.id);
  const tokenUsage = next.tokenUsage ?? current?.tokenUsage;
  const generation = next.generation ?? current?.generation;
  return upsertById(turns, {
    ...next,
    ...(tokenUsage === undefined ? {} : { tokenUsage }),
    ...(generation === undefined ? {} : { generation }),
  });
}

/** A stale run snapshot must not erase fields that other events recorded on the run. */
function preserveRunRecordedFields(
  current: OrchestrationV2Run | undefined,
  next: OrchestrationV2Run,
): OrchestrationV2Run {
  if (current === undefined) return next;
  return {
    ...next,
    // A follow-up can bind its task to a run that is already going (a message
    // steered into it). That run's own later updates come from an older copy
    // and must not drop the binding, or the task never settles.
    ...(next.delegatedTaskId === undefined && current.delegatedTaskId !== undefined
      ? { delegatedTaskId: current.delegatedTaskId }
      : {}),
    ...(next.carriedTaskIds === undefined && current.carriedTaskIds !== undefined
      ? { carriedTaskIds: current.carriedTaskIds }
      : {}),
    ...(next.delegatedCompletion === undefined && current.delegatedCompletion !== undefined
      ? { delegatedCompletion: current.delegatedCompletion }
      : {}),
    ...(next.restartCancelledBackgroundWork === undefined &&
    current.restartCancelledBackgroundWork !== undefined
      ? { restartCancelledBackgroundWork: current.restartCancelledBackgroundWork }
      : {}),
  };
}

function preserveCompletionDelivery(
  current: OrchestrationV2Subagent | undefined,
  next: OrchestrationV2Subagent,
): OrchestrationV2Subagent {
  if (next.completionDelivery !== undefined || current?.completionDelivery === undefined) {
    return next;
  }
  return { ...next, completionDelivery: current.completionDelivery };
}

export function emptyProjection<
  E extends Pick<
    Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>,
    "payload" | "occurredAt"
  >,
>(event: E): OrchestrationV2ThreadProjection {
  return {
    thread: event.payload,
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: event.occurredAt,
  };
}

// A roster update fills an empty pointer only: provider-native subagent threads
// have no app runs, so their first real provider thread is their active one. It
// never replaces a pointer that admission already chose.
function rosterSelectsProviderThread(
  thread: { readonly id: ThreadId; readonly activeProviderThreadId: ProviderThreadId | null },
  providerThread: OrchestrationV2ProviderThread,
): boolean {
  return (
    providerThread.appThreadId === thread.id &&
    thread.activeProviderThreadId === null &&
    !(
      providerThread.status === "not_loaded" &&
      providerThread.firstRunOrdinal === null &&
      providerThread.nativeThreadRef === null &&
      providerThread.providerSessionId === null
    )
  );
}

// Roster and lifecycle updates never select a thread. Admission does, including
// a held run that starts after a newer submission has already finished.
function selectsProviderThread(current: OrchestrationV2Run | undefined, next: OrchestrationV2Run) {
  return (
    next.providerThreadId !== null &&
    ["preparing", "starting", "running", "waiting"].includes(next.status) &&
    (current === undefined || current.status === "queued" || current.providerThreadId === null)
  );
}

export function applyToProjection(
  projection: OrchestrationV2ThreadProjection,
  event: OrchestrationV2DomainEvent,
): OrchestrationV2ThreadProjection {
  const base = {
    ...projection,
    thread: {
      ...projection.thread,
      updatedAt: event.occurredAt,
    },
    updatedAt: event.occurredAt,
  };

  switch (event.type) {
    case "thread.pull-request-link-updated":
      return {
        ...base,
        thread: applyThreadPullRequestLinkUpdate(projection.thread, event.payload),
      };
    case "thread.created":
    case "thread.archived":
    case "thread.unarchived":
    case "thread.deleted":
    case "thread.settled":
    case "thread.unsettled":
    case "thread.snoozed":
    case "thread.unsnoozed":
    case "thread.auto-settle-set":
    case "thread.pinned":
    case "thread.unpinned":
    case "thread.pin-reordered":
    case "thread.active-reordered":
    case "thread.metadata-updated":
    case "thread.pull-request-synced":
    case "thread.runtime-mode-updated":
    case "thread.interaction-mode-updated":
    case "thread.model-selection-updated":
    case "thread.provider-switched":
      return {
        ...base,
        thread: event.payload,
      };
    // Visited tracking is read state, not activity: skip the updatedAt bump so
    // viewing a thread does not surface it as recently active.
    case "thread.visited":
    case "thread.marked-unread":
      return {
        ...projection,
        thread: event.payload,
      };
    case "run.created":
    case "run.updated":
      return withLocalVisibleTurnItems({
        ...base,
        thread: selectsProviderThread(
          base.runs.find((run) => run.id === event.payload.id),
          event.payload,
        )
          ? { ...base.thread, activeProviderThreadId: event.payload.providerThreadId }
          : base.thread,
        runs: upsertById(
          base.runs,
          preserveRunRecordedFields(
            base.runs.find((run) => run.id === event.payload.id),
            event.payload,
          ),
        ),
      });
    case "run.background-work-cancelled":
      return {
        ...base,
        runs: base.runs.map((run) =>
          run.id === event.payload.runId
            ? {
                ...run,
                restartCancelledBackgroundWork: event.payload.restartCancelledBackgroundWork,
              }
            : run,
        ),
      };
    case "run-attempt.created":
    case "run-attempt.updated":
      return withLocalVisibleTurnItems({
        ...base,
        attempts: upsertById(base.attempts, event.payload),
      });
    case "node.updated":
      return {
        ...base,
        nodes: upsertById(base.nodes, event.payload),
      };
    case "subagent.updated":
      return {
        ...base,
        subagents: upsertById(
          base.subagents,
          preserveCompletionDelivery(
            base.subagents.find((task) => task.id === event.payload.id),
            event.payload,
          ),
        ),
      };
    case "provider-session.attached":
    case "provider-session.updated":
      return {
        ...base,
        providerSessions: upsertById(base.providerSessions, event.payload),
      };
    case "provider-session.detached":
      return {
        ...base,
        providerSessions: base.providerSessions.filter(
          (session) => session.id !== event.payload.providerSessionId,
        ),
      };
    case "provider-thread.updated":
      return {
        ...base,
        thread: rosterSelectsProviderThread(base.thread, event.payload)
          ? { ...base.thread, activeProviderThreadId: event.payload.id }
          : base.thread,
        providerThreads: upsertById(base.providerThreads, event.payload),
      };
    case "provider-turn.updated":
      return {
        ...base,
        providerTurns: upsertProviderTurn(base.providerTurns, event.payload),
      };
    case "runtime-request.updated":
      return {
        ...base,
        runtimeRequests: upsertById(base.runtimeRequests, event.payload),
      };
    case "message.updated":
      return {
        ...base,
        messages: upsertById(base.messages, event.payload),
      };
    case "turn-item.updated":
      return withLocalVisibleTurnItems({
        ...base,
        turnItems: upsertById(base.turnItems, event.payload),
      });
    case "plan.updated":
      return {
        ...base,
        plans: upsertById(base.plans, event.payload),
      };
    case "checkpoint-scope.created":
      return {
        ...base,
        checkpointScopes: upsertById(base.checkpointScopes, event.payload),
      };
    case "checkpoint.captured":
      return {
        ...base,
        checkpoints: upsertById(base.checkpoints, event.payload),
      };
    case "checkpoint.rollback-requested":
      return base;
    case "context-handoff.updated":
      return {
        ...base,
        contextHandoffs: upsertById(base.contextHandoffs, event.payload),
      };
    case "context-transfer.created":
    case "context-transfer.updated":
      return {
        ...base,
        contextTransfers: upsertById(base.contextTransfers, event.payload),
      };
  }
}

/**
 * Replay state for entities whose persisted projection is shared across thread bindings.
 *
 * Provider sessions are process-scoped: one session row can be bound to several app
 * threads. Updating that row changes what every bound thread reads, even though the
 * application event itself belongs to one thread stream. Keeping the binding index here
 * makes in-memory replay match the normalized SQL projection without scanning every
 * thread for every session event.
 */
/**
 * Whether the thread's queue holds a run the settle command would refuse: a
 * queued run whose user message is a regular one. Notifications and delegated
 * completions are automatic messages the settle command cancels, so they do
 * not block. Mirrors the settle command's queue check and the SQL candidate
 * query's queued-run exclusion; keep the three in step.
 */
export function projectionHasBlockingQueuedRun(projection: {
  readonly runs: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["runs"][number], "status" | "userMessageId">
  >;
  readonly messages: ReadonlyArray<
    Pick<
      OrchestrationV2ThreadProjection["messages"][number],
      "id" | "notification" | "delegatedCompletion"
    >
  >;
}): boolean {
  const automaticMessageIds = new Set(
    projection.messages
      .filter(
        (message) =>
          message.notification !== undefined || message.delegatedCompletion !== undefined,
      )
      .map((message) => message.id),
  );
  return projection.runs.some(
    (run) => run.status === "queued" && !automaticMessageIds.has(run.userMessageId),
  );
}

export interface ProjectionReplayState {
  readonly projections: Map<ThreadId, OrchestrationV2ThreadProjection>;
  readonly providerSessionThreadIds: Map<ProviderSessionId, ReadonlySet<ThreadId>>;
}

function makeProjectionReplayState(): ProjectionReplayState {
  return {
    projections: new Map(),
    providerSessionThreadIds: new Map(),
  };
}

function applyToProjectionReplayState(
  state: ProjectionReplayState,
  event: OrchestrationV2DomainEvent,
): boolean {
  if (event.type === "thread.created" && !state.projections.has(event.threadId)) {
    state.projections.set(event.threadId, emptyProjection(event));
    return true;
  }

  const current = state.projections.get(event.threadId);
  if (current === undefined) {
    return false;
  }

  let next = applyToProjection(current, event);
  if (event.type === "provider-session.updated") {
    const boundThreadIds = state.providerSessionThreadIds.get(event.payload.id);
    if (boundThreadIds?.has(event.threadId) !== true) {
      // The SQL projection updates the global session row but does not implicitly
      // create a thread binding for an update event.
      next = { ...next, providerSessions: current.providerSessions };
    }
  }
  state.projections.set(event.threadId, next);

  switch (event.type) {
    case "provider-session.attached": {
      const boundThreadIds = new Set(state.providerSessionThreadIds.get(event.payload.id) ?? []);
      boundThreadIds.add(event.threadId);
      state.providerSessionThreadIds.set(event.payload.id, boundThreadIds);
      for (const threadId of boundThreadIds) {
        if (threadId === event.threadId) continue;
        const projection = state.projections.get(threadId);
        if (projection === undefined) continue;
        state.projections.set(threadId, {
          ...projection,
          providerSessions: upsertById(projection.providerSessions, event.payload),
        });
      }
      break;
    }
    case "provider-session.updated": {
      const boundThreadIds = state.providerSessionThreadIds.get(event.payload.id) ?? [];
      for (const threadId of boundThreadIds) {
        if (threadId === event.threadId) continue;
        const projection = state.projections.get(threadId);
        if (projection === undefined) continue;
        state.projections.set(threadId, {
          ...projection,
          providerSessions: upsertById(projection.providerSessions, event.payload),
        });
      }
      break;
    }
    case "provider-session.detached": {
      const boundThreadIds = new Set(
        state.providerSessionThreadIds.get(event.payload.providerSessionId) ?? [],
      );
      boundThreadIds.delete(event.threadId);
      if (boundThreadIds.size === 0) {
        state.providerSessionThreadIds.delete(event.payload.providerSessionId);
      } else {
        state.providerSessionThreadIds.set(event.payload.providerSessionId, boundThreadIds);
      }
      break;
    }
  }

  return true;
}

type PayloadRow = {
  readonly payload_json: string;
};

type ShellThreadRow = {
  readonly thread_id: string;
  readonly payload_json: string;
  readonly forked_from_run_source_thread_id: string | null;
  readonly latest_run_id: string | null;
  readonly latest_run_status: string | null;
  readonly latest_run_requested_at: string | null;
  readonly latest_run_started_at: string | null;
  readonly latest_run_completed_at: string | null;
  readonly active_run_id: string | null;
  readonly activity_run_status: string | null;
  readonly active_run_status: string | null;
  readonly activity_run_started_at: string | null;
  readonly last_error: string | null;
  readonly terminal_failure_payload_json: string | null;
  readonly blocking_run_id: string | null;
  readonly blocking_run_requested_at: string | null;
  readonly blocking_run_started_at: string | null;
  readonly blocking_run_completed_at: string | null;
  readonly blocking_failure_payload_json: string | null;
  readonly pending_request_payload_json: string | null;
  readonly pending_secret_request_payload_json: string | null;
  readonly latest_user_message_at: string | null;
  readonly latest_user_authored_message_at: string | null;
  readonly has_actionable_proposed_plan: number;
  readonly item_count: number;
  readonly runless_item_count: number;
};

type ShellRunRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly ordinal: number;
};

type ShellLiveChildSubagentRow = {
  readonly subagent_id: string;
  readonly thread_id: string;
  readonly run_id: string | null;
  readonly child_thread_id: string;
  readonly started_at: string | null;
  readonly status: string;
  readonly title: string | null;
  readonly prompt: string | null;
};

type SettlementThreadRow = Pick<
  ShellThreadRow,
  | "thread_id"
  | "payload_json"
  | "latest_run_id"
  | "latest_run_status"
  | "latest_run_requested_at"
  | "latest_run_started_at"
  | "latest_run_completed_at"
  | "latest_user_message_at"
  | "latest_user_authored_message_at"
>;

type ShellRunItemCountRow = {
  readonly thread_id: string;
  readonly run_id: string;
  readonly item_count: number;
};

const isAssetResource = Schema.is(AssetResource);
const decodeRankingFailure = Schema.decodeUnknownOption(
  Schema.fromJsonString(OrchestrationV2ProviderFailureSchema),
);
const decodeMarkdownOccurrence = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.Literal("markdown"), Schema.Number])),
);

type MediaTimelineRow = Parameters<typeof threadMediaIndex>[0]["visibleTurnItems"][number];

/** Bound metadata and never emit inline data URLs in a media history response. */
export function selectThreadMediaPage(input: {
  readonly rows: ReadonlyArray<MediaTimelineRow>;
  readonly cursor: string;
  readonly end?: number;
  readonly nextCursor: string | null;
  readonly hasMoreHistory: boolean;
}): ThreadMediaPage {
  let partial = false;
  const items = threadMediaIndex(
    { visibleTurnItems: input.rows, messages: [] },
    { workspaceRoot: "." },
  ).flatMap((item): Array<ThreadMediaPage["items"][number]> => {
    if (item.id.length > 4096 || item.mimeType.length > 100) {
      partial = true;
      return [];
    }
    if (item.target.type === "url") {
      if (
        /^data:image\//i.test(item.target.url) &&
        isProviderSendTurnSupportedImageMimeType(item.mimeType)
      ) {
        const occurrence = Option.getOrNull(decodeMarkdownOccurrence(item.id));
        const comma = item.target.url.indexOf(",");
        if (
          occurrence &&
          Number.isSafeInteger(occurrence[2]) &&
          occurrence[2] >= 0 &&
          comma > 0 &&
          comma < 128 &&
          /;base64$/i.test(item.target.url.slice(0, comma)) &&
          item.target.url.length - comma - 1 <= MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH &&
          /^[a-z0-9+/]*={0,2}$/i.test(item.target.url.slice(comma + 1))
        ) {
          return [
            {
              ...item,
              name: "Embedded image",
              target: {
                type: "asset" as const,
                resource: {
                  _tag: "message-inline-image" as const,
                  threadId: item.sourceThreadId,
                  itemId: item.sourceItemId,
                  index: occurrence[2],
                },
              },
            },
          ];
        }
      }
      if (!/^(?:https?:\/\/|\/\/)/i.test(item.target.url) || item.target.url.length > 2048) {
        partial = true;
        return [];
      }
    } else if (
      !isAssetResource(item.target.resource) ||
      (item.target.srcFragment?.length ?? 0) > 1024
    ) {
      partial = true;
      return [];
    }
    return [{ ...item, name: item.name.slice(0, 255) }];
  });
  const end = Math.min(input.end ?? items.length, items.length);
  const start = Math.max(0, end - 64);
  return {
    items: items.slice(start, end),
    nextCursor: start > 0 ? encodeThreadMediaCursor(input.cursor, start) : input.nextCursor,
    hasMoreHistory: start > 0 || input.hasMoreHistory,
    ...(partial ? { partial: true as const } : {}),
  };
}

const encodeTimelineSources = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ threadId: Schema.String, id: Schema.String })),
  ),
);
const encodeNativeSessionSelectors = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Array(Schema.Struct({ providerInstanceId: Schema.String, nativeId: Schema.String })),
  ),
);
const encodeNullableIds = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(Schema.NullOr(Schema.String))),
);
const encodeIdList = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const encodeThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
const encodeThreadUpdatedAt = Schema.encodeEffect(
  OrchestrationV2AppThreadJsonSchema.fields.updatedAt,
);
const encodeRunPayload = Schema.encodeEffect(Schema.fromJsonString(OrchestrationV2RunJsonSchema));
const encodeRestartCancelledBackgroundWork = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema.fields.restartCancelledBackgroundWork),
);
const encodeRunAttemptPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);
const encodeNodePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);
const encodeSubagentPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);
const encodeProviderSessionPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);
/** Encodes a provider thread exactly as its projection row stores `payload_json`. */
export const encodeProviderThreadPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);
const encodeProviderTurnPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);
const encodeRuntimeRequestPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);
const encodeMessagePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);
const encodePlanPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2PlanArtifactSchema),
);
const encodeTurnItemPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);
const encodeCheckpointScopePayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);
const encodeCheckpointPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);
const encodeContextHandoffPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);
const encodeContextTransferPayload = Schema.encodeEffect(
  Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

const PullRequestThread = OrchestrationV2AppThreadJsonSchema.mapFields(
  ({
    id,
    projectId,
    lineage,
    branch,
    worktreePath,
    archivedAt,
    settledOverride,
    settledAt,
    linkedPullRequest,
    branchPullRequest,
    pullRequests,
  }) => ({
    id,
    projectId,
    lineage,
    branch,
    worktreePath,
    archivedAt,
    settledOverride,
    settledAt,
    linkedPullRequest,
    branchPullRequest,
    pullRequests,
  }),
);
const decodePullRequestThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PullRequestThread),
);

const LiveThreadModelPayload = OrchestrationV2AppThreadJsonSchema.mapFields(
  ({ id, modelSelection }) => ({ id, modelSelection }),
);
const decodeLiveThreadModel = Schema.decodeUnknownEffect(
  Schema.fromJsonString(LiveThreadModelPayload),
);
export interface LiveThreadModel {
  readonly threadId: ThreadId;
  readonly modelSelection: ModelSelection;
}
/** A chat counts as live under the same run states its sidebar row shows as activity. */
const liveThreadModelsOf = (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<LiveThreadModel> =>
  threads.flatMap((thread) =>
    (thread.activityRunStatus ?? null) === null
      ? []
      : [{ threadId: thread.id, modelSelection: thread.modelSelection }],
  );

const localExecutionResource = (
  task: Pick<OrchestrationV2Subagent, "id" | "threadId" | "childThreadId" | "status">,
  cwd: string | null,
): ExecutionResource => {
  const released = ["completed", "failed", "cancelled", "interrupted"].includes(task.status);
  return {
    id: task.id,
    owner: { threadId: task.threadId, taskId: task.id },
    workspace: { type: "local", cwd },
    state: released ? "released" : task.status === "pending" ? "admitted" : "running",
    cleanupPin: !released,
    stop: { type: "subagent", threadId: task.childThreadId! },
  };
};

const decodeThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJsonSchema),
);
// The thread payload's own `lastVisitedAt` field, read alone.
const decodeReadMark = Schema.decodeUnknownEffect(
  OrchestrationV2AppThreadJsonSchema.fields.lastVisitedAt,
);
const decodeRunPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunJsonSchema),
);
const decodeRunAttemptPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RunAttemptJsonSchema),
);
const decodeNodePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ExecutionNodeJsonSchema),
);
const decodeSubagentPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2SubagentJsonSchema),
);
const decodeProviderSessionPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderSessionJsonSchema),
);
const decodeProviderThreadPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderThreadJsonSchema),
);
const decodeProviderTurnPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ProviderTurnJsonSchema),
);
const decodeRuntimeRequestPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2RuntimeRequestJsonSchema),
);
const decodeMessagePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ConversationMessageJsonSchema),
);
const decodePlanArtifact = Schema.decodeUnknownEffect(OrchestrationV2PlanArtifactSchema);
const decodePlanPayload = (json: string) => decodePlanArtifact(parseEncodedPayload(json));
const decodeTurnItemPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2TurnItemJsonSchema),
);
const decodeCheckpointScopePayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointScopeJsonSchema),
);
const decodeCheckpointPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2CheckpointJsonSchema),
);
const decodeContextHandoffPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextHandoffJsonSchema),
);
const decodeContextTransferPayload = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2ContextTransferJsonSchema),
);

const isProjectionStoreThreadNotFoundError = Schema.is(ProjectionStoreThreadNotFoundError);
const isProjectionStoreReadError = Schema.is(ProjectionStoreReadError);

function parseEncodedPayload(json: string): Record<string, unknown> {
  return JSON.parse(json) as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  return typeof value === "string" ? value : String(value);
}

function nullableStringField(payload: Record<string, unknown>, field: string): string | null {
  const value = payload[field];
  if (value === null || value === undefined) {
    return null;
  }
  return typeof value === "string" ? value : String(value);
}

function booleanInt(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

const decodeRows =
  <A, E>(decode: (json: string) => Effect.Effect<A, E>, threadId: ThreadId) =>
  (rows: ReadonlyArray<PayloadRow>): Effect.Effect<Array<A>, ProjectionStoreReadError> =>
    Effect.forEach(rows, (row) => decode(row.payload_json)).pipe(
      Effect.mapError(
        (cause) =>
          new ProjectionStoreReadError({
            threadId,
            cause,
          }),
      ),
    );

function messageIdForTurnItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return item.messageId;
    default:
      return null;
  }
}

function sortMessagesByTurnItemOrder(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  messageOrdinals = new Map<string, number>(),
): Array<OrchestrationV2ConversationMessage> {
  for (const turnItem of turnItems) {
    const messageId = messageIdForTurnItem(turnItem);
    if (messageId === null) {
      continue;
    }
    const existing = messageOrdinals.get(messageId);
    if (existing === undefined || turnItem.ordinal < existing) {
      messageOrdinals.set(messageId, turnItem.ordinal);
    }
  }

  return messages.toSorted((left, right) => {
    const leftOrdinal = messageOrdinals.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = messageOrdinals.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrdinal !== rightOrdinal) {
      return leftOrdinal - rightOrdinal;
    }

    const leftCreatedAt = DateTime.toEpochMillis(left.createdAt);
    const rightCreatedAt = DateTime.toEpochMillis(right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });
}

function activeLocalTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  const isVisible = createOrchestrationV2TurnItemVisibility({
    runs: projection.runs,
    attempts: projection.attempts,
    items: projection.turnItems,
  });
  return projection.turnItems.filter(isVisible).map((item, position) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

function localVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): Array<OrchestrationV2ProjectedTurnItem> {
  return activeLocalTurnItems(projection);
}

function inheritedVisibleTurnItemsFromLocalItems(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  return items.map((item) => ({
    visibility: "inherited" as const,
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
    item,
  }));
}

function withLocalVisibleTurnItems(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  return {
    ...projection,
    visibleTurnItems: localVisibleTurnItems(projection),
  };
}

function renumberVisibleTurnItems(
  rows: ReadonlyArray<Omit<OrchestrationV2ProjectedTurnItem, "position">>,
): Array<OrchestrationV2ProjectedTurnItem> {
  return rows.map((row, position) => ({ ...row, position }));
}

function makeForkMarkerTurnItem(input: {
  readonly targetProjection: Pick<OrchestrationV2ThreadProjection, "thread">;
  readonly sourceThreadId: ThreadId;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): Extract<OrchestrationV2TurnItem, { type: "fork" }> {
  const createdAt = input.targetProjection.thread.createdAt;
  return {
    id: TurnItemId.make(`turn-item:fork:${input.targetProjection.thread.id}`),
    threadId: input.targetProjection.thread.id,
    runId: null,
    nodeId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: "Forked from conversation",
    startedAt: null,
    completedAt: createdAt,
    updatedAt: createdAt,
    type: "fork",
    source: { type: "run", threadId: input.sourceThreadId, runId: input.sourceRunId },
    targetThreadId: input.targetProjection.thread.id,
  };
}

export function isTurnItemAtOrBeforeRun(input: {
  readonly historyOrigin: OrchestrationV2ThreadProjection["thread"]["historyOrigin"];
  readonly itemRunId: OrchestrationV2TurnItem["runId"];
  readonly runOrdinalById: ReadonlyMap<NonNullable<OrchestrationV2TurnItem["runId"]>, number>;
  readonly sourceRunOrdinal: number;
}): boolean {
  if (input.itemRunId === null) {
    return input.historyOrigin === "v1_import";
  }
  const ordinal = input.runOrdinalById.get(input.itemRunId);
  return ordinal !== undefined && ordinal <= input.sourceRunOrdinal;
}

function visibleTurnItemsThroughRun(input: {
  readonly sourceProjection: OrchestrationV2ThreadProjection;
  readonly sourceRunId: NonNullable<OrchestrationV2TurnItem["runId"]>;
}): Array<Omit<OrchestrationV2ProjectedTurnItem, "position">> {
  const sourceRun = input.sourceProjection.runs.find((run) => run.id === input.sourceRunId);
  if (sourceRun === undefined) {
    return [];
  }

  const runOrdinalById = new Map(input.sourceProjection.runs.map((run) => [run.id, run.ordinal]));
  const inheritedPrefix = input.sourceProjection.visibleTurnItems
    .filter(
      (row) => row.item.threadId !== input.sourceProjection.thread.id || row.item.type === "fork",
    )
    .map((row) => ({
      visibility: "inherited" as const,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item: row.item,
    }));
  const localPrefix = inheritedVisibleTurnItemsFromLocalItems(
    input.sourceProjection.turnItems.filter((item) => {
      if (
        isOrchestrationV2SupersededInterrupt({
          item,
          attempts: input.sourceProjection.attempts,
          items: input.sourceProjection.turnItems,
        })
      ) {
        return false;
      }
      return isTurnItemAtOrBeforeRun({
        historyOrigin: input.sourceProjection.thread.historyOrigin,
        itemRunId: item.runId,
        runOrdinalById,
        sourceRunOrdinal: sourceRun.ordinal,
      });
    }),
  );

  return [...inheritedPrefix, ...localPrefix];
}

function buildVisibleTurnItems(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly sourceProjection: OrchestrationV2ThreadProjection | null;
}): Array<OrchestrationV2ProjectedTurnItem> {
  const forkedFrom = input.projection.thread.forkedFrom;
  if (forkedFrom?.type !== "run" || input.sourceProjection === null) {
    return localVisibleTurnItems(input.projection);
  }

  const inherited = visibleTurnItemsThroughRun({
    sourceProjection: input.sourceProjection,
    sourceRunId: forkedFrom.runId,
  });
  const markerItem = makeForkMarkerTurnItem({
    targetProjection: input.projection,
    sourceThreadId: forkedFrom.threadId,
    sourceRunId: forkedFrom.runId,
  });
  const local = activeLocalTurnItems(input.projection).map((row) => ({
    visibility: "local" as const,
    sourceThreadId: row.sourceThreadId,
    sourceItemId: row.sourceItemId,
    item: row.item,
  }));

  return renumberVisibleTurnItems([
    ...inherited,
    {
      visibility: "synthetic",
      sourceThreadId: forkedFrom.threadId,
      sourceItemId: markerItem.id,
      item: markerItem,
    },
    ...local,
  ]);
}

/** The first id past every secret card's: the prefix with its last character advanced. */
const SECRET_REQUEST_TURN_ITEM_ID_PREFIX_END =
  SECRET_REQUEST_TURN_ITEM_ID_PREFIX.slice(0, -1) +
  String.fromCharCode(
    SECRET_REQUEST_TURN_ITEM_ID_PREFIX.charCodeAt(SECRET_REQUEST_TURN_ITEM_ID_PREFIX.length - 1) +
      1,
  );

/**
 * A pending secret still needs user input while the agent keeps working,
 * so the shell reports it as pending user input. Secret requests have no
 * runtime request of their own; this stands one in for the shell summary
 * only, keyed by the card's turn item.
 */
function secretRequestAsPendingInput(
  item: OrchestrationV2TurnItem | null,
): OrchestrationV2ThreadProjection["runtimeRequests"][number] | null {
  if (item?.type !== "secret_request" || item.nodeId === null) return null;
  return {
    id: RuntimeRequestId.make(item.id),
    nodeId: item.nodeId,
    providerTurnId: item.providerTurnId,
    nativeRequestRef: null,
    kind: "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: item.startedAt ?? item.updatedAt,
    resolvedAt: null,
  };
}

// Session boxes show the agent's latest step; these item types are steps.
const SHELL_STEP_ITEM_TYPES: ReadonlySet<string> = new Set([
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
  "subagent",
  "reasoning",
  "assistant_message",
  "compaction",
]);
const SHELL_STEP_DETAIL_CHARS = 200;
// A live child named from its subagent row: enough of the brief to label it.
const SHELL_SUBAGENT_PROMPT_CHARS = 280;
const SHELL_REPLY_TAIL_CHARS = 600;
// Enough of the latest request for its first sentence; the box shows its opening.
const SHELL_REQUEST_CHARS = 400;

function shellStepDetail(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "command_execution":
      return item.input.slice(0, SHELL_STEP_DETAIL_CHARS);
    case "file_change":
      return item.fileName;
    case "file_search":
      return item.pattern ?? null;
    case "web_search":
      return item.patterns?.[0] ?? null;
    case "dynamic_tool":
      return item.toolName;
    default:
      return null;
  }
}

/** The latest step of a run, or null when it has none yet. */
function shellCurrentStep(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  runId: RunId | null,
): OrchestrationV2ThreadShellStep | null {
  if (runId === null) return null;
  let latest: OrchestrationV2TurnItem | null = null;
  for (const item of turnItems) {
    if (item.runId !== runId || !SHELL_STEP_ITEM_TYPES.has(item.type)) continue;
    if (latest === null || item.ordinal >= latest.ordinal) latest = item;
  }
  return latest === null
    ? null
    : { itemType: latest.type, detail: shellStepDetail(latest), startedAt: latest.startedAt };
}

/** What a finished run's final reply asks of the user. */
function shellReplyAttention(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  run: { readonly id: RunId; readonly status: string } | null,
): OrchestrationV2ThreadShell["replyAttention"] {
  if (run === null || run.status !== "completed") return null;
  let latest: Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> | null = null;
  for (const item of turnItems) {
    if (item.type !== "assistant_message" || item.runId !== run.id) continue;
    if (latest === null || item.ordinal >= latest.ordinal) latest = item;
  }
  return latest === null ? null : sessionBoxAttention(latest.text.slice(-SHELL_REPLY_TAIL_CHARS));
}

/**
 * One plain line for chat list rows: how a finished run's final reply opens, or, while a
 * run works, how the agent's latest message in it opens (what it last said it is doing).
 */
function shellReplyPreview(
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  run: { readonly id: RunId; readonly status: string } | null,
  activityRunId: RunId | null,
): string | null {
  const runId = activityRunId ?? (run !== null && run.status === "completed" ? run.id : null);
  if (runId === null) return null;
  let latest: Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> | null = null;
  for (const item of turnItems) {
    if (item.type !== "assistant_message" || item.runId !== runId) continue;
    if (latest === null || item.ordinal >= latest.ordinal) latest = item;
  }
  return latest === null ? null : messagePreviewLine(latest.text);
}

/** The user's latest typed request: its id and opening. */
type ShellRequest = { readonly id: string; readonly text: string };

/**
 * A box's name and "now" line. The local box-namer model writes them when it is installed
 * and has read this request; until then the "now" line is the opening of the user's latest
 * typed request, when the chat has moved on from its title. Answers to agent questions
 * come from the server and carry the question instead, so they never count as requests.
 */
function shellBoxNaming(
  threadId: ThreadId,
  title: string,
  request: ShellRequest | null,
): Pick<OrchestrationV2ThreadShell, "latestRequest" | "boxName"> {
  if (request === null) return { latestRequest: null, boxName: null };
  const model = lookupBoxNaming(threadId, { title, requestId: request.id });
  return {
    latestRequest:
      model?.now !== undefined
        ? model.now
        : sessionBoxNow(request.text.slice(0, SHELL_REQUEST_CHARS), title),
    boxName: model?.name ?? null,
  };
}

/** The app's own monitors run outside the transcript; the monitor service counts them per chat. */
function withAppMonitors(
  work: OrchestrationV2ThreadShell["longRunningWork"],
  threadId: string,
): OrchestrationV2ThreadShell["longRunningWork"] {
  const count = appMonitorCount(threadId);
  if (count === 0) return work;
  return {
    monitorCount: (work?.monitorCount ?? 0) + count,
    backgroundTaskCount: work?.backgroundTaskCount ?? 0,
    runningSubagentCount: work?.runningSubagentCount ?? 0,
  };
}

type SessionBoxStores = {
  readonly boxFaces: BoxFaces.BoxFaces["Service"];
  readonly chatTabs: ChatTabs.ChatTabs["Service"];
  readonly chatControls: ChatControls.ChatControls["Service"];
  readonly shellSchedules?: ScheduledTaskShells.ScheduledTaskShells["Service"];
};

export function threadShellFromProjection(
  projection: OrchestrationV2ThreadProjection,
  children?: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>,
  stores?: SessionBoxStores,
): OrchestrationV2ThreadShell {
  const providerSession =
    projection.providerSessions
      .filter((session) => session.providerInstanceId === projection.thread.providerInstanceId)
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
      )[0] ?? null;
  const latestRun =
    usageLimitRunPresentedAsLatest(
      projection.runs,
      projection.turnItems,
      providerSession?.lastError ?? null,
    ) ?? latestUnheldRun(projection.runs);
  const activeRun =
    projection.runs
      .filter(isInterruptibleRunForShell)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const activityRun =
    projection.runs
      .filter(isActivityRunForShell)
      .toSorted((left, right) => right.ordinal - left.ordinal)[0] ?? null;
  const pendingRuntimeRequest =
    projection.runtimeRequests
      .filter((request) => request.status === "pending")
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
      )[0] ??
    secretRequestAsPendingInput(
      projection.turnItems
        .filter(
          (item) =>
            item.type === "secret_request" &&
            item.status === "waiting" &&
            item.secretStatus === "pending",
        )
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
        )[0] ?? null,
    );
  const userMessages = projection.messages
    .filter((message) => message.role === "user")
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt),
    );
  const latestUserMessage = userMessages[0] ?? null;
  const backgroundInput = {
    latestRun,
    providerThreads: projection.providerThreads,
    turnItems: projection.turnItems.map(projectTurnItemForWire),
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    runs: projection.runs,
    pullRequests: projection.thread.pullRequests,
    subagents: projection.subagents,
    childRuns: [
      ...new Set(
        projection.turnItems.flatMap((item) =>
          item.type === "subagent" && item.childThreadId !== null ? [item.childThreadId] : [],
        ),
      ),
    ].flatMap((id) => children?.get(id)?.runs ?? []),
  };
  const pendingBackgroundTasks = derivePendingBackgroundWork(backgroundInput);
  return {
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    id: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    providerInstanceId: projection.thread.providerInstanceId,
    modelSelection: projection.thread.modelSelection,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    pullRequests: threadPullRequestsOf(projection.thread),
    ...(projection.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: projection.thread.linkedPullRequest }),
    ...(projection.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: projection.thread.branchPullRequest }),
    ...(projection.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: projection.thread.activeOrderKey }),
    lineage: projection.thread.lineage,
    forkedFrom: projection.thread.forkedFrom,
    activeProviderThreadId: projection.thread.activeProviderThreadId,
    ...(projection.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: projection.thread.historyOrigin }),
    latestRunId: latestRun?.id ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    activeRunId: activeRun?.id ?? null,
    activityRunStatus: activityRun?.status ?? null,
    activityRunStartedAt:
      activityRun === null ? null : orchestrationV2RunWorkStartedAt(activityRun),
    status: latestRun?.status ?? "idle",
    ...threadErrorSummary(
      latestRootProviderFailure(latestRun, projection.turnItems),
      providerSession?.lastError ?? null,
    ),
    pendingRuntimeRequest:
      pendingRuntimeRequest === null
        ? null
        : {
            id: pendingRuntimeRequest.id,
            kind: pendingRuntimeRequest.kind,
            createdAt: pendingRuntimeRequest.createdAt,
          },
    // Thread detail owns message bodies. Keeping them out of shell rows makes
    // initial hydration and streaming updates independent of transcript size.
    latestVisibleMessage: null,
    ...(projection.thread.createdBy === "agent" &&
    projection.thread.creationSource === "mcp" &&
    projection.thread.lineage.parentThreadId === null
      ? {
          createdChatPreview:
            projection.messages
              .slice(-2)
              .reverse()
              .find((message) => message.role === "assistant")
              ?.text.slice(0, 280) ?? "",
        }
      : {}),
    currentStep: shellCurrentStep(projection.turnItems, activityRun?.id ?? null),
    replyAttention: shellReplyAttention(projection.turnItems, latestRun),
    replyPreview: shellReplyPreview(projection.turnItems, latestRun, activityRun?.id ?? null),
    ...shellBoxNaming(
      projection.thread.id,
      projection.thread.title,
      userMessages.find(
        (message) => message.createdBy === "user" && message.creationSource !== "server",
      ) ?? null,
    ),
    boxFace: stores?.boxFaces.get(projection.thread.id) ?? null,
    chatTab: stores?.chatTabs.get(projection.thread.id) ?? null,
    ...chatControlShellFields(stores?.chatControls, projection.thread.id, [
      latestRun?.requestedAt,
      userMessages.find((message) => message.createdBy === "user")?.updatedAt,
    ]),
    comparison: stores?.chatTabs.comparison(projection.thread.id) ?? null,
    latestUserMessageAt: latestUserMessage?.updatedAt ?? null,
    latestUserAuthoredMessageAt:
      userMessages.find((message) => message.createdBy === "user")?.updatedAt ?? null,
    hasActionableProposedPlan: projection.plans.some(
      (plan) => plan.kind === "proposed_plan" && plan.status === "active",
    ),
    ...(deriveBlockedOnThreadWait({
      activeRun,
      turnItems: backgroundInput.turnItems,
    })
      ? { blockedOnThreadWait: true as const }
      : {}),
    pendingBackgroundTasks: [...pendingBackgroundTasks],
    longRunningWork: withAppMonitors(
      longRunningWorkForShell(backgroundInput),
      projection.thread.id,
    ),
    nextScheduledRunAt: stores?.shellSchedules?.nextRunAt(projection.thread.id) ?? null,
    providerInstanceHistory: providerInstanceHistoryForShell({
      threadId: projection.thread.id,
      providerThreads: projection.providerThreads,
    }),
    goal: activeProviderGoalForShell(
      projection.providerThreads,
      projection.thread.activeProviderThreadId,
    ),
    itemCount: activeLocalTurnItems(projection).length,
    visibleItemCount: projection.visibleTurnItems.length,
    createdAt: projection.thread.createdAt,
    updatedAt: projection.updatedAt,
    archivedAt: projection.thread.archivedAt,
    settledOverride: projection.thread.settledOverride,
    settledAt: projection.thread.settledAt,
    unsettledAt: projection.thread.unsettledAt ?? null,
    snoozedUntil: projection.thread.snoozedUntil ?? null,
    snoozedAt: projection.thread.snoozedAt ?? null,
    pinnedAt: projection.thread.pinnedAt ?? null,

    autoSettleDisabledAt: projection.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: projection.thread.pinOrderKey ?? null,
    lastVisitedAt: projection.thread.lastVisitedAt,
    titleRegeneration: projection.thread.titleRegeneration ?? null,
    limitRecovery: projection.thread.limitRecovery ?? null,
    deletedAt: projection.thread.deletedAt,
  };
}

/**
 * Provider instances that have owned this thread's root conversation, oldest
 * first. Subagent provider threads carry an owner node and are excluded so a
 * delegated Codex child does not make a Claude thread look handed off.
 */
function providerInstanceHistoryForShell(input: {
  readonly threadId: ThreadId;
  readonly providerThreads: ReadonlyArray<
    OrchestrationV2ThreadProjection["providerThreads"][number]
  >;
}): ReadonlyArray<ProviderInstanceId> {
  const history: Array<ProviderInstanceId> = [];
  for (const providerThread of input.providerThreads
    .filter((thread) => thread.appThreadId === input.threadId && thread.ownerNodeId === null)
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt) ||
        left.id.localeCompare(right.id),
    )) {
    if (!history.includes(providerThread.providerInstanceId)) {
      history.push(providerThread.providerInstanceId);
    }
  }
  return history;
}

/** The native goal lives on the provider thread that currently owns the conversation. */
function activeProviderGoalForShell(
  providerThreads: ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>,
  activeProviderThreadId: OrchestrationV2ThreadProjection["thread"]["activeProviderThreadId"],
): OrchestrationV2ThreadShell["goal"] {
  return providerThreads.find((thread) => thread.id === activeProviderThreadId)?.goal ?? null;
}

function isInterruptibleRunForShell(run: OrchestrationV2ThreadProjection["runs"][number]): boolean {
  return run.status === "preparing" || run.status === "starting" || run.status === "running";
}

type ShellActivityRunStatus = "preparing" | "running" | "starting" | "waiting";

function isActivityRunForShell(
  run: OrchestrationV2ThreadProjection["runs"][number],
): run is OrchestrationV2ThreadProjection["runs"][number] & {
  readonly status: ShellActivityRunStatus;
} {
  return isInterruptibleRunForShell(run) || run.status === "waiting";
}

/** Per-run step and reply attention for session boxes, read alongside shell rows. */
type ShellBoxData = {
  readonly createdChatPreviewByThreadId: ReadonlyMap<ThreadId, string>;
  readonly stepByRunId: ReadonlyMap<RunId, OrchestrationV2ThreadShellStep>;
  readonly attentionByRunId: ReadonlyMap<RunId, OrchestrationV2ThreadShell["replyAttention"]>;
  /** How each finished run's final reply opens, as one plain line. */
  readonly replyPreviewByRunId: ReadonlyMap<RunId, string>;
  /** The user's latest typed request per thread, cut to its opening. */
  readonly requestByThreadId: ReadonlyMap<ThreadId, ShellRequest>;
};

type ShellThreadState = {
  readonly thread: OrchestrationV2ThreadProjection["thread"];
  readonly latestRunId: RunId | null;
  readonly latestRunStatus: OrchestrationV2ShellThreadStatus;
  readonly latestRunRequestedAt: DateTime.Utc | null;
  readonly latestRunStartedAt: DateTime.Utc | null;
  readonly latestRunCompletedAt: DateTime.Utc | null;
  readonly activeRunId: RunId | null;
  readonly activityRunStatus: ShellActivityRunStatus | null;
  readonly activityRunStartedAt: DateTime.Utc | null;
  readonly lastError: string | null;
  readonly lastErrorClass: OrchestrationV2ThreadShell["lastErrorClass"];
  readonly usageLimitResetAt: OrchestrationV2ThreadShell["usageLimitResetAt"];
  readonly pendingRuntimeRequest: OrchestrationV2ThreadProjection["runtimeRequests"][number] | null;
  readonly latestUserMessageAt: DateTime.Utc | null;
  readonly latestUserAuthoredMessageAt: DateTime.Utc | null;
  readonly hasActionableProposedPlan: boolean;
  readonly blockedOnThreadWait?: boolean;
  readonly pendingBackgroundTasks: OrchestrationV2ThreadShell["pendingBackgroundTasks"];
  readonly longRunningWork: OrchestrationV2ThreadShell["longRunningWork"];
  readonly providerInstanceHistory: OrchestrationV2ThreadShell["providerInstanceHistory"];
  readonly goal: OrchestrationV2ThreadShell["goal"];
  readonly itemCount: number;
  readonly runlessItemCount: number;
  readonly updatedAt: OrchestrationV2ThreadProjection["updatedAt"];
  readonly runOrdinalById: ReadonlyMap<RunId, number>;
  readonly itemCountByRunId: ReadonlyMap<RunId, number>;
};

function shellStatusFromStoredRunStatus(status: string | null): OrchestrationV2ShellThreadStatus {
  switch (status) {
    case null:
      return "idle";
    case "preparing":
    case "queued":
    case "starting":
    case "running":
    case "waiting":
    case "completed":
    case "interrupted":
    case "failed":
    case "cancelled":
    case "rolled_back":
      return status;
    default:
      return "failed";
  }
}

function itemCountThroughRun(input: {
  readonly state: ShellThreadState;
  readonly runId: RunId;
}): number {
  const runOrdinal = input.state.runOrdinalById.get(input.runId);
  if (runOrdinal === undefined) {
    return 0;
  }

  let count = input.state.thread.historyOrigin === "v1_import" ? input.state.runlessItemCount : 0;
  for (const [runId, itemCount] of input.state.itemCountByRunId) {
    const itemRunOrdinal = input.state.runOrdinalById.get(runId);
    if (itemRunOrdinal !== undefined && itemRunOrdinal <= runOrdinal) {
      count += itemCount;
    }
  }
  return count;
}

/**
 * Threads that some shell row forks from at a run. Only these need run
 * ordinals and per-run item counts, to count the inherited prefix, so a thread
 * nobody forked from never pays for a scan of its run history.
 */
function shellForkSourceIds(
  rows: ReadonlyArray<{ readonly forked_from_run_source_thread_id: string | null }>,
): ReadonlyArray<ThreadId> {
  return [
    ...new Set(
      rows.flatMap((row) =>
        row.forked_from_run_source_thread_id === null
          ? []
          : [ThreadId.make(row.forked_from_run_source_thread_id)],
      ),
    ),
  ];
}

function visibleItemCountForShell(input: {
  readonly threadId: ThreadId;
  readonly statesByThreadId: ReadonlyMap<ThreadId, ShellThreadState>;
  readonly seenThreadIds?: ReadonlySet<ThreadId>;
}): number {
  const state = input.statesByThreadId.get(input.threadId);
  if (state === undefined) {
    return 0;
  }

  const forkedFrom = state.thread.forkedFrom;
  if (forkedFrom?.type !== "run") {
    return state.itemCount;
  }

  const seenThreadIds = input.seenThreadIds ?? new Set<ThreadId>();
  if (seenThreadIds.has(state.thread.id)) {
    return state.itemCount;
  }

  const sourceState = input.statesByThreadId.get(forkedFrom.threadId);
  if (sourceState === undefined) {
    return state.itemCount;
  }

  const sourceForkedFrom = sourceState.thread.forkedFrom;
  const inheritedPrefixCount =
    sourceForkedFrom?.type === "run"
      ? visibleItemCountForShell({
          threadId: sourceState.thread.id,
          statesByThreadId: input.statesByThreadId,
          seenThreadIds: new Set([...seenThreadIds, state.thread.id]),
        }) - sourceState.itemCount
      : 0;

  return (
    inheritedPrefixCount +
    itemCountThroughRun({ state: sourceState, runId: forkedFrom.runId }) +
    1 +
    state.itemCount
  );
}

function shellFromState(input: {
  readonly state: ShellThreadState;
  readonly visibleItemCount: number;
  readonly boxes?: ShellBoxData;
  readonly stores: SessionBoxStores;
}): OrchestrationV2ThreadShell {
  const activeRunId = input.state.activityRunStatus === null ? null : input.state.activeRunId;
  const latestRunId = input.state.latestRunId;
  return {
    createdBy: input.state.thread.createdBy,
    creationSource: input.state.thread.creationSource,
    id: input.state.thread.id,
    projectId: input.state.thread.projectId,
    title: input.state.thread.title,
    providerInstanceId: input.state.thread.providerInstanceId,
    modelSelection: input.state.thread.modelSelection,
    runtimeMode: input.state.thread.runtimeMode,
    interactionMode: input.state.thread.interactionMode,
    branch: input.state.thread.branch,
    worktreePath: input.state.thread.worktreePath,
    pullRequests: threadPullRequestsOf(input.state.thread),
    ...(input.state.thread.linkedPullRequest === undefined
      ? {}
      : { linkedPullRequest: input.state.thread.linkedPullRequest }),
    ...(input.state.thread.branchPullRequest === undefined
      ? {}
      : { branchPullRequest: input.state.thread.branchPullRequest }),
    ...(input.state.thread.activeOrderKey === undefined
      ? {}
      : { activeOrderKey: input.state.thread.activeOrderKey }),
    lineage: input.state.thread.lineage,
    forkedFrom: input.state.thread.forkedFrom,
    activeProviderThreadId: input.state.thread.activeProviderThreadId,
    ...(input.state.thread.historyOrigin === undefined
      ? {}
      : { historyOrigin: input.state.thread.historyOrigin }),
    latestRunId: input.state.latestRunId,
    latestRunRequestedAt: input.state.latestRunRequestedAt,
    latestRunStartedAt: input.state.latestRunStartedAt,
    latestRunCompletedAt: input.state.latestRunCompletedAt,
    activeRunId: input.state.activeRunId,
    activityRunStatus: input.state.activityRunStatus,
    activityRunStartedAt: input.state.activityRunStartedAt,
    status: input.state.latestRunStatus,
    lastError: input.state.lastError,
    lastErrorClass: input.state.lastErrorClass,
    usageLimitResetAt: input.state.usageLimitResetAt,
    pendingRuntimeRequest:
      input.state.pendingRuntimeRequest === null
        ? null
        : {
            id: input.state.pendingRuntimeRequest.id,
            kind: input.state.pendingRuntimeRequest.kind,
            createdAt: input.state.pendingRuntimeRequest.createdAt,
          },
    latestVisibleMessage: null,
    ...(input.boxes?.createdChatPreviewByThreadId.has(input.state.thread.id)
      ? { createdChatPreview: input.boxes.createdChatPreviewByThreadId.get(input.state.thread.id)! }
      : {}),
    currentStep: activeRunId === null ? null : (input.boxes?.stepByRunId.get(activeRunId) ?? null),
    replyAttention:
      input.state.latestRunStatus !== "completed" || latestRunId === null
        ? null
        : (input.boxes?.attentionByRunId.get(latestRunId) ?? null),
    replyPreview:
      activeRunId !== null
        ? (input.boxes?.replyPreviewByRunId.get(activeRunId) ?? null)
        : input.state.latestRunStatus !== "completed" || latestRunId === null
          ? null
          : (input.boxes?.replyPreviewByRunId.get(latestRunId) ?? null),
    ...shellBoxNaming(
      input.state.thread.id,
      input.state.thread.title,
      input.boxes?.requestByThreadId.get(input.state.thread.id) ?? null,
    ),
    boxFace: input.stores.boxFaces.get(input.state.thread.id),
    chatTab: input.stores.chatTabs.get(input.state.thread.id),
    ...chatControlShellFields(input.stores.chatControls, input.state.thread.id, [
      input.state.latestRunRequestedAt,
      input.state.latestUserAuthoredMessageAt,
    ]),
    comparison: input.stores.chatTabs.comparison(input.state.thread.id),
    latestUserMessageAt: input.state.latestUserMessageAt,
    latestUserAuthoredMessageAt: input.state.latestUserAuthoredMessageAt,
    hasActionableProposedPlan: input.state.hasActionableProposedPlan,
    ...(input.state.blockedOnThreadWait === true ? { blockedOnThreadWait: true as const } : {}),
    pendingBackgroundTasks: input.state.pendingBackgroundTasks,
    longRunningWork: withAppMonitors(input.state.longRunningWork, input.state.thread.id),
    nextScheduledRunAt: input.stores.shellSchedules?.nextRunAt(input.state.thread.id) ?? null,
    providerInstanceHistory: input.state.providerInstanceHistory,
    goal: input.state.goal,
    itemCount: input.state.itemCount,
    visibleItemCount: input.visibleItemCount,
    createdAt: input.state.thread.createdAt,
    updatedAt: input.state.updatedAt,
    archivedAt: input.state.thread.archivedAt,
    settledOverride: input.state.thread.settledOverride,
    settledAt: input.state.thread.settledAt,
    unsettledAt: input.state.thread.unsettledAt ?? null,
    snoozedUntil: input.state.thread.snoozedUntil ?? null,
    snoozedAt: input.state.thread.snoozedAt ?? null,
    pinnedAt: input.state.thread.pinnedAt ?? null,

    autoSettleDisabledAt: input.state.thread.autoSettleDisabledAt ?? null,
    pinOrderKey: input.state.thread.pinOrderKey ?? null,
    lastVisitedAt: input.state.thread.lastVisitedAt,
    titleRegeneration: input.state.thread.titleRegeneration ?? null,
    limitRecovery: input.state.thread.limitRecovery ?? null,
    deletedAt: input.state.thread.deletedAt,
  };
}

function chatControlShellFields(
  chatControls: ChatControls.ChatControls["Service"] | undefined,
  threadId: string,
  instants: ReadonlyArray<DateTime.Utc | null | undefined>,
) {
  if (chatControls === undefined) return {};
  chatControls.observeActivity(
    threadId,
    instants.map((value) => (value == null ? null : DateTime.formatIso(value))),
  );
  const view = chatControls.view(threadId);
  return {
    ...(view.override === null ? {} : { longRunningOverride: view.override }),
    ...(view.dayCount === 0 ? {} : { activityDayCount: view.dayCount }),
    ...(view.lastActiveAt === null
      ? {}
      : { activityLastAt: DateTime.makeUnsafe(view.lastActiveAt) }),
    ...(view.subagentsEnabled ? {} : { subagentsEnabled: false as const }),
    ...(view.firstSubagentAsk === null
      ? {}
      : { firstSubagentAsk: NodeId.make(view.firstSubagentAsk) }),
  };
}

export const layer: Layer.Layer<ProjectionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const boxFaces = Option.getOrElse(
      yield* Effect.serviceOption(BoxFaces.BoxFaces),
      () => BoxFaces.make().store,
    );
    const chatTabs = Option.getOrElse(
      yield* Effect.serviceOption(ChatTabs.ChatTabs),
      () => ChatTabs.make().store,
    );
    const chatControls = Option.getOrElse(
      yield* Effect.serviceOption(ChatControls.ChatControls),
      () => ChatControls.make().store,
    );
    const shellSchedules = Option.getOrUndefined(
      yield* Effect.serviceOption(ScheduledTaskShells.ScheduledTaskShells),
    );
    const stores = {
      boxFaces,
      chatTabs,
      chatControls,
      ...(shellSchedules === undefined ? {} : { shellSchedules }),
    };
    const sql = yield* SqlClient.SqlClient;
    const rankings = yield* Effect.serviceOption(SubagentRankings.SubagentRankings);
    const rankingProviders = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
    // Past activity is indexed once, after startup settles. The SQLite driver is
    // synchronous, so even this scan must stay off the startup path. Hour buckets
    // map exactly onto America/New_York days (its offsets are whole hours), and
    // every user message starts a run, so runs alone carry the history. Later
    // activity is recorded from timestamps already on the shell.
    const indexActivity = Effect.gen(function* () {
      if (!chatControls.needsActivityIndex()) return;
      const rows = yield* sql<{ readonly thread_id: string; readonly hour: string }>`
        SELECT DISTINCT thread_id, substr(requested_at, 1, 13) AS hour
        FROM orchestration_v2_projection_runs
        WHERE requested_at IS NOT NULL
      `;
      chatControls.mergeActivity(
        rows.map((row) => ({
          threadId: row.thread_id,
          at: `${row.hour.replace(" ", "T")}:00:00.000Z`,
        })),
      );
      chatControls.markActivityIndexed();
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not index chat activity.", { cause })),
    );
    yield* Effect.sleep("30 seconds").pipe(Effect.andThen(indexActivity), Effect.forkScoped);

    // For run upserts: a snapshot without `path` keeps the value another event recorded there.

    const keepRecordedRunField = (payload: Statement.Fragment, path: string) => sql`
      CASE
        WHEN json_type(excluded.payload_json, ${path}) IS NULL
          AND json_type(orchestration_v2_projection_runs.payload_json, ${path}) IS NOT NULL
        THEN json_set(
          ${payload},
          ${path},
          json_extract(orchestration_v2_projection_runs.payload_json, ${path})
        )
        ELSE ${payload}
      END
    `;

    // Latest user-authored request and MCP-created chat preview per thread.
    // Invalidated once a write to a thread's messages has committed: a reader
    // snapshot taken before the commit cannot see it, so clearing earlier would
    // let such a reader cache the old value under a key the commit keeps. A
    // reader caches only if no invalidation landed since before its snapshot.
    const SHELL_MESSAGE_BOX_CACHE_MAX = 4_000;
    let messageBoxWriteEpoch = 0;
    const latestRequestCache = new Map<
      ThreadId,
      { readonly key: string; readonly request: ShellRequest | null }
    >();
    const createdChatPreviewCache = new Map<
      ThreadId,
      { readonly key: string; readonly preview: string | null }
    >();
    const rememberLatestRequest = (
      threadId: ThreadId,
      key: string,
      request: ShellRequest | null,
    ) => {
      latestRequestCache.set(threadId, { key, request });
      if (latestRequestCache.size > SHELL_MESSAGE_BOX_CACHE_MAX) {
        const oldest = latestRequestCache.keys().next();
        if (oldest.done !== true) latestRequestCache.delete(oldest.value);
      }
    };
    const rememberCreatedChatPreview = (
      threadId: ThreadId,
      key: string,
      preview: string | null,
    ) => {
      createdChatPreviewCache.set(threadId, { key, preview });
      if (createdChatPreviewCache.size > SHELL_MESSAGE_BOX_CACHE_MAX) {
        const oldest = createdChatPreviewCache.keys().next();
        if (oldest.done !== true) createdChatPreviewCache.delete(oldest.value);
      }
    };
    const invalidateMessageBoxes = (threadIds: Iterable<ThreadId>) => {
      messageBoxWriteEpoch += 1;
      for (const threadId of threadIds) {
        latestRequestCache.delete(threadId);
        createdChatPreviewCache.delete(threadId);
      }
    };
    const messageBoxThreadIds = (events: ReadonlyArray<OrchestrationV2DomainEvent>) => {
      const threadIds = new Set<ThreadId>();
      for (const event of events) {
        if (event.type === "message.updated") threadIds.add(event.payload.threadId);
        else if (event.type === "thread.created" || event.type === "thread.deleted") {
          threadIds.add(event.payload.id);
        }
      }
      return threadIds;
    };
    const prepareMessageBoxInvalidation = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.sync(() => {
        const threadIds = messageBoxThreadIds(events);
        return threadIds.size === 0
          ? Effect.void
          : Effect.sync(() => invalidateMessageBoxes(threadIds));
      });
    // A write outside a transaction has committed by the time its statement
    // returns. Inside one, the committer runs `prepareMessageBoxInvalidation`.
    const invalidateMessageBoxesIfCommitted = (threadId: ThreadId) =>
      Effect.map(Effect.serviceOption(sql.transactionService), (transaction) => {
        if (Option.isNone(transaction)) invalidateMessageBoxes([threadId]);
      });

    const dispatchHistory = yield* makeMessageDispatchHistory;
    const apply: ProjectionStoreV2Shape["apply"] = (event) =>
      Effect.gen(function* () {
        dispatchHistory.observe(event);
        switch (event.type) {
          case "thread.pull-request-link-updated": {
            const thread = yield* getThread(event.threadId);
            yield* apply({
              ...event,
              type: "thread.pull-request-synced",
              payload: applyThreadPullRequestLinkUpdate(thread, event.payload),
            });
            break;
          }
          case "thread.created":
          case "thread.archived":
          case "thread.unarchived":
          case "thread.deleted":
          case "thread.settled":
          case "thread.unsettled":
          case "thread.snoozed":
          case "thread.unsnoozed":
          case "thread.auto-settle-set":
          case "thread.pinned":
          case "thread.unpinned":
          case "thread.pin-reordered":
          case "thread.active-reordered":
          case "thread.visited":
          case "thread.marked-unread":
          case "thread.metadata-updated":
          case "thread.pull-request-synced":
          case "thread.runtime-mode-updated":
          case "thread.interaction-mode-updated":
          case "thread.model-selection-updated":
          case "thread.provider-switched": {
            const payloadJson = yield* encodeThreadPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_threads (
                thread_id,
                project_id,
                title,
                default_provider,
                provider_instance_id,
                runtime_mode,
                interaction_mode,
                active_provider_thread_id,
                created_at,
                updated_at,
                archived_at,
                deleted_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.projectId},
                ${event.payload.title},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.runtimeMode},
                ${event.payload.interactionMode},
                ${event.payload.activeProviderThreadId},
                ${stringField(payload, "createdAt")},
                ${stringField(payload, "updatedAt")},
                ${nullableStringField(payload, "archivedAt")},
                ${nullableStringField(payload, "deletedAt")},
                ${payloadJson}
              )
              ON CONFLICT(thread_id)
              DO UPDATE SET
                project_id = excluded.project_id,
                title = excluded.title,
                default_provider = excluded.default_provider,
                provider_instance_id = excluded.provider_instance_id,
                runtime_mode = excluded.runtime_mode,
                interaction_mode = excluded.interaction_mode,
                active_provider_thread_id = excluded.active_provider_thread_id,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                archived_at = excluded.archived_at,
                deleted_at = excluded.deleted_at,
                payload_json = excluded.payload_json
            `;
            if (event.type === "thread.created" || event.type === "thread.deleted") {
              yield* invalidateMessageBoxesIfCommitted(event.payload.id);
            }
            break;
          }
          case "run.created":
          case "run.updated": {
            const currentRows =
              event.payload.providerThreadId !== null &&
              ["preparing", "starting", "running", "waiting"].includes(event.payload.status)
                ? yield* sql<PayloadRow>`
                    SELECT payload_json FROM orchestration_v2_projection_runs
                    WHERE run_id = ${event.payload.id}
                  `
                : [];
            const current =
              currentRows[0] === undefined
                ? undefined
                : yield* decodeRunPayload(currentRows[0].payload_json);
            const payloadJson = yield* encodeRunPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_runs (
                run_id,
                thread_id,
                ordinal,
                provider,
                provider_instance_id,
                provider_thread_id,
                status,
                requested_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.ordinal},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.status},
                ${stringField(payload, "requestedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(run_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                ordinal = excluded.ordinal,
                provider = excluded.provider,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                status = excluded.status,
                requested_at = excluded.requested_at,
                completed_at = excluded.completed_at,
                payload_json = ${keepRecordedRunField(
                  keepRecordedRunField(
                    keepRecordedRunField(
                      keepRecordedRunField(sql`excluded.payload_json`, "$.delegatedTaskId"),
                      "$.carriedTaskIds",
                    ),
                    "$.delegatedCompletion",
                  ),
                  "$.restartCancelledBackgroundWork",
                )}
            `;
            dispatchHistory.observe(event);
            if (selectsProviderThread(current, event.payload)) {
              yield* sql`
                UPDATE orchestration_v2_projection_threads
                SET active_provider_thread_id = ${event.payload.providerThreadId},
                  payload_json = json_set(payload_json, '$.activeProviderThreadId', ${event.payload.providerThreadId})
                WHERE thread_id = ${event.payload.threadId}
              `;
            }
            break;
          }
          case "run.background-work-cancelled": {
            // Only this field changes, so a concurrent lifecycle write is never regressed.
            const workJson = yield* encodeRestartCancelledBackgroundWork(
              event.payload.restartCancelledBackgroundWork,
            );
            yield* sql`
              UPDATE orchestration_v2_projection_runs
              SET payload_json = json_set(
                payload_json,
                '$.restartCancelledBackgroundWork',
                json(${workJson})
              )
              WHERE run_id = ${event.payload.runId} AND thread_id = ${event.threadId}
            `;
            break;
          }
          case "run-attempt.created":
          case "run-attempt.updated": {
            const payloadJson = yield* encodeRunAttemptPayload(event.payload);
            yield* sql`
              INSERT INTO orchestration_v2_projection_run_attempts (
                attempt_id,
                thread_id,
                run_id,
                attempt_ordinal,
                root_node_id,
                provider,
                provider_instance_id,
                provider_thread_id,
                provider_turn_id,
                status,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.runId},
                ${event.payload.attemptOrdinal},
                ${event.payload.rootNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.status},
                ${payloadJson}
              )
              ON CONFLICT(attempt_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                attempt_ordinal = excluded.attempt_ordinal,
                root_node_id = excluded.root_node_id,
                provider = excluded.provider,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "node.updated": {
            const payloadJson = yield* encodeNodePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_nodes (
                node_id,
                thread_id,
                run_id,
                parent_node_id,
                root_node_id,
                kind,
                status,
                provider_thread_id,
                provider_turn_id,
                runtime_request_id,
                checkpoint_scope_id,
                started_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.parentNodeId},
                ${event.payload.rootNodeId},
                ${event.payload.kind},
                ${event.payload.status},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.runtimeRequestId},
                ${event.payload.checkpointScopeId},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(node_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                parent_node_id = excluded.parent_node_id,
                root_node_id = excluded.root_node_id,
                kind = excluded.kind,
                status = excluded.status,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                runtime_request_id = excluded.runtime_request_id,
                checkpoint_scope_id = excluded.checkpoint_scope_id,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "subagent.updated": {
            const payloadJson = yield* encodeSubagentPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_subagents (
                subagent_id,
                thread_id,
                run_id,
                parent_node_id,
                provider,
                driver,
                provider_instance_id,
                provider_thread_id,
                child_thread_id,
                origin,
                status,
                started_at,
                completed_at,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.parentNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.providerThreadId},
                ${event.payload.childThreadId},
                ${event.payload.origin},
                ${event.payload.status},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(subagent_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                parent_node_id = excluded.parent_node_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                provider_thread_id = excluded.provider_thread_id,
                child_thread_id = excluded.child_thread_id,
                origin = excluded.origin,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                updated_at = excluded.updated_at,
                payload_json = CASE
                  WHEN json_type(excluded.payload_json, '$.completionDelivery') IS NULL
                    AND json_type(orchestration_v2_projection_subagents.payload_json, '$.completionDelivery') IS NOT NULL
                  THEN json_set(
                    excluded.payload_json,
                    '$.completionDelivery',
                    json_extract(
                      orchestration_v2_projection_subagents.payload_json,
                      '$.completionDelivery'
                    )
                  )
                  ELSE excluded.payload_json
                END
            `;
            break;
          }
          case "provider-session.attached":
          case "provider-session.updated": {
            const payloadJson = yield* encodeProviderSessionPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_sessions (
                provider_session_id,
                thread_id,
                provider,
                driver,
                provider_instance_id,
                status,
                model,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.status},
                ${event.payload.model},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_session_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                status = excluded.status,
                model = excluded.model,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            if (event.type === "provider-session.attached") {
              yield* sql`
                INSERT OR IGNORE INTO orchestration_v2_projection_provider_session_bindings (
                  provider_session_id,
                  thread_id
                )
                VALUES (${event.payload.id}, ${event.threadId})
              `;
            }
            break;
          }
          case "provider-session.detached": {
            yield* sql`
              DELETE FROM orchestration_v2_projection_provider_session_bindings
              WHERE provider_session_id = ${event.payload.providerSessionId}
                AND thread_id = ${event.threadId}
            `;
            break;
          }
          case "provider-thread.updated": {
            const payloadJson = yield* encodeProviderThreadPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_threads (
                provider_thread_id,
                thread_id,
                owner_node_id,
                provider,
                driver,
                provider_instance_id,
                provider_session_id,
                status,
                first_run_ordinal,
                last_run_ordinal,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.appThreadId},
                ${event.payload.ownerNodeId},
                ${event.payload.providerInstanceId},
                ${event.payload.driver},
                ${event.payload.providerInstanceId},
                ${event.payload.providerSessionId},
                ${event.payload.status},
                ${event.payload.firstRunOrdinal},
                ${event.payload.lastRunOrdinal},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_thread_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                owner_node_id = excluded.owner_node_id,
                provider = excluded.provider,
                driver = excluded.driver,
                provider_instance_id = excluded.provider_instance_id,
                provider_session_id = excluded.provider_session_id,
                status = excluded.status,
                first_run_ordinal = excluded.first_run_ordinal,
                last_run_ordinal = excluded.last_run_ordinal,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            if (event.payload.appThreadId !== null) {
              const threadRows = yield* sql<PayloadRow>`
                SELECT payload_json
                FROM orchestration_v2_projection_threads
                WHERE thread_id = ${event.payload.appThreadId}
                  AND active_provider_thread_id IS NULL
                LIMIT 1
              `;
              const threadRow = threadRows[0];
              if (threadRow !== undefined) {
                const thread = yield* decodeThreadPayload(threadRow.payload_json);
                if (rosterSelectsProviderThread(thread, event.payload)) {
                  const updatedThreadPayloadJson = yield* encodeThreadPayload({
                    ...thread,
                    activeProviderThreadId: event.payload.id,
                  });
                  yield* sql`
                    UPDATE orchestration_v2_projection_threads
                    SET
                      active_provider_thread_id = ${event.payload.id},
                      payload_json = ${updatedThreadPayloadJson}
                    WHERE thread_id = ${event.payload.appThreadId}
                      AND active_provider_thread_id IS NULL
                  `;
                }
              }
            }
            break;
          }
          case "provider-turn.updated": {
            const existingRows =
              event.payload.tokenUsage === undefined || event.payload.generation === undefined
                ? yield* sql<PayloadRow>`
                    SELECT payload_json
                    FROM orchestration_v2_projection_provider_turns
                    WHERE provider_turn_id = ${event.payload.id}
                    LIMIT 1
                  `
                : [];
            const existing = existingRows[0];
            const providerTurn =
              existing === undefined
                ? event.payload
                : upsertProviderTurn(
                    [yield* decodeProviderTurnPayload(existing.payload_json)],
                    event.payload,
                  )[0]!;
            const payloadJson = yield* encodeProviderTurnPayload(providerTurn);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_provider_turns (
                provider_turn_id,
                thread_id,
                provider_thread_id,
                node_id,
                run_attempt_id,
                ordinal,
                status,
                started_at,
                completed_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${providerTurn.providerThreadId},
                ${providerTurn.nodeId},
                ${providerTurn.runAttemptId},
                ${providerTurn.ordinal},
                ${providerTurn.status},
                ${nullableStringField(payload, "startedAt")},
                ${nullableStringField(payload, "completedAt")},
                ${payloadJson}
              )
              ON CONFLICT(provider_turn_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                provider_thread_id = excluded.provider_thread_id,
                node_id = excluded.node_id,
                run_attempt_id = excluded.run_attempt_id,
                ordinal = excluded.ordinal,
                status = excluded.status,
                started_at = excluded.started_at,
                completed_at = excluded.completed_at,
                payload_json = excluded.payload_json
            `;
            dispatchHistory.observe(event);
            break;
          }
          case "runtime-request.updated": {
            const payloadJson = yield* encodeRuntimeRequestPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_runtime_requests (
                runtime_request_id,
                thread_id,
                node_id,
                provider_turn_id,
                kind,
                status,
                created_at,
                resolved_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.threadId},
                ${event.payload.nodeId},
                ${event.payload.providerTurnId},
                ${event.payload.kind},
                ${event.payload.status},
                ${stringField(payload, "createdAt")},
                ${nullableStringField(payload, "resolvedAt")},
                ${payloadJson}
              )
              ON CONFLICT(runtime_request_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                node_id = excluded.node_id,
                provider_turn_id = excluded.provider_turn_id,
                kind = excluded.kind,
                status = excluded.status,
                created_at = excluded.created_at,
                resolved_at = excluded.resolved_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "message.updated": {
            const payloadJson = yield* encodeMessagePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_messages (
                message_id,
                thread_id,
                run_id,
                node_id,
                role,
                streaming,
                created_at,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.role},
                ${booleanInt(event.payload.streaming)},
                ${stringField(payload, "createdAt")},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(message_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                role = excluded.role,
                streaming = excluded.streaming,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            yield* invalidateMessageBoxesIfCommitted(event.payload.threadId);
            break;
          }
          case "plan.updated": {
            const payloadJson = yield* encodePlanPayload(event.payload);
            yield* sql`
              INSERT INTO orchestration_v2_projection_plans (
                plan_id,
                thread_id,
                run_id,
                node_id,
                kind,
                status,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.kind},
                ${event.payload.status},
                ${payloadJson}
              )
              ON CONFLICT(plan_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                kind = excluded.kind,
                status = excluded.status,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "turn-item.updated": {
            // The pending-work index follows display activity. The JSON keeps
            // the original completion for orchestration and notification consumers.
            const payloadJson = yield* encodeTurnItemPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_turn_items (
                turn_item_id,
                thread_id,
                run_id,
                node_id,
                provider_thread_id,
                provider_turn_id,
                parent_item_id,
                ordinal,
                type,
                status,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.providerThreadId},
                ${event.payload.providerTurnId},
                ${event.payload.parentItemId},
                ${event.payload.ordinal},
                ${event.payload.type},
                ${event.payload.type === "subagent" ? (event.payload.childActivity?.status ?? event.payload.status) : event.payload.status},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(turn_item_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                provider_thread_id = excluded.provider_thread_id,
                provider_turn_id = excluded.provider_turn_id,
                parent_item_id = excluded.parent_item_id,
                ordinal = excluded.ordinal,
                type = excluded.type,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            dispatchHistory.observe(event);
            break;
          }
          case "checkpoint-scope.created": {
            const payloadJson = yield* encodeCheckpointScopePayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_checkpoint_scopes (
                scope_id,
                thread_id,
                run_id,
                node_id,
                parent_scope_id,
                provider_thread_id,
                kind,
                ordinal_within_parent,
                advances_app_run_count,
                created_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.parentScopeId},
                ${event.payload.providerThreadId},
                ${event.payload.kind},
                ${event.payload.ordinalWithinParent},
                ${booleanInt(event.payload.advancesAppRunCount)},
                ${stringField(payload, "createdAt")},
                ${payloadJson}
              )
              ON CONFLICT(scope_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                parent_scope_id = excluded.parent_scope_id,
                provider_thread_id = excluded.provider_thread_id,
                kind = excluded.kind,
                ordinal_within_parent = excluded.ordinal_within_parent,
                advances_app_run_count = excluded.advances_app_run_count,
                created_at = excluded.created_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "checkpoint.captured": {
            const payloadJson = yield* encodeCheckpointPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_checkpoints (
                checkpoint_id,
                thread_id,
                scope_id,
                run_id,
                node_id,
                parent_checkpoint_id,
                ordinal_within_scope,
                app_run_ordinal,
                status,
                captured_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.scopeId},
                ${event.payload.runId},
                ${event.payload.nodeId},
                ${event.payload.parentCheckpointId},
                ${event.payload.ordinalWithinScope},
                ${event.payload.appRunOrdinal},
                ${event.payload.status},
                ${stringField(payload, "capturedAt")},
                ${payloadJson}
              )
              ON CONFLICT(checkpoint_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                scope_id = excluded.scope_id,
                run_id = excluded.run_id,
                node_id = excluded.node_id,
                parent_checkpoint_id = excluded.parent_checkpoint_id,
                ordinal_within_scope = excluded.ordinal_within_scope,
                app_run_ordinal = excluded.app_run_ordinal,
                status = excluded.status,
                captured_at = excluded.captured_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "checkpoint.rollback-requested":
            break;
          case "context-handoff.updated": {
            const payloadJson = yield* encodeContextHandoffPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_context_handoffs (
                context_handoff_id,
                thread_id,
                target_run_id,
                to_provider_thread_id,
                strategy,
                status,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.threadId},
                ${event.payload.targetRunId},
                ${event.payload.toProviderThreadId},
                ${event.payload.strategy},
                ${event.payload.status},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(context_handoff_id)
              DO UPDATE SET
                thread_id = excluded.thread_id,
                target_run_id = excluded.target_run_id,
                to_provider_thread_id = excluded.to_provider_thread_id,
                strategy = excluded.strategy,
                status = excluded.status,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
          case "context-transfer.created":
          case "context-transfer.updated": {
            const payloadJson = yield* encodeContextTransferPayload(event.payload);
            const payload = parseEncodedPayload(payloadJson);
            yield* sql`
              INSERT INTO orchestration_v2_projection_context_transfers (
                context_transfer_id,
                source_thread_id,
                target_thread_id,
                target_run_id,
                type,
                status,
                source_provider,
                target_provider,
                source_provider_instance_id,
                target_provider_instance_id,
                updated_at,
                payload_json
              )
              VALUES (
                ${event.payload.id},
                ${event.payload.sourceThreadId},
                ${event.payload.targetThreadId},
                ${event.payload.targetRunId},
                ${event.payload.type},
                ${event.payload.status},
                ${event.payload.sourceProviderInstanceId},
                ${event.payload.targetProviderInstanceId},
                ${event.payload.sourceProviderInstanceId},
                ${event.payload.targetProviderInstanceId},
                ${stringField(payload, "updatedAt")},
                ${payloadJson}
              )
              ON CONFLICT(context_transfer_id)
              DO UPDATE SET
                source_thread_id = excluded.source_thread_id,
                target_thread_id = excluded.target_thread_id,
                target_run_id = excluded.target_run_id,
                type = excluded.type,
                status = excluded.status,
                source_provider = excluded.source_provider,
                target_provider = excluded.target_provider,
                source_provider_instance_id = excluded.source_provider_instance_id,
                target_provider_instance_id = excluded.target_provider_instance_id,
                updated_at = excluded.updated_at,
                payload_json = excluded.payload_json
            `;
            break;
          }
        }

        if (
          event.type !== "thread.created" &&
          event.type !== "thread.archived" &&
          event.type !== "thread.unarchived" &&
          event.type !== "thread.deleted" &&
          event.type !== "thread.settled" &&
          event.type !== "thread.unsettled" &&
          event.type !== "thread.snoozed" &&
          event.type !== "thread.unsnoozed" &&
          event.type !== "thread.auto-settle-set" &&
          event.type !== "thread.pinned" &&
          event.type !== "thread.unpinned" &&
          event.type !== "thread.pin-reordered" &&
          event.type !== "thread.visited" &&
          event.type !== "thread.marked-unread" &&
          event.type !== "thread.metadata-updated" &&
          event.type !== "thread.runtime-mode-updated" &&
          event.type !== "thread.interaction-mode-updated" &&
          event.type !== "thread.model-selection-updated" &&
          event.type !== "thread.provider-switched"
        ) {
          // Only the activity timestamp changes. This runs for every streamed
          // run, node and turn-item event, so the thread row is patched in place
          // instead of being read, decoded and re-encoded each time.
          const updatedAt = yield* encodeThreadUpdatedAt(event.occurredAt);
          yield* sql`
            UPDATE orchestration_v2_projection_threads
            SET
              updated_at = ${updatedAt},
              payload_json = json_set(payload_json, '$.updatedAt', ${updatedAt})
            WHERE thread_id = ${event.threadId}
          `;
        }
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectionStoreApplyEventError({
              eventType: event.type,
              cause,
            }),
        ),
      );

    // SQLite trim defaults to ASCII space; use exactly JavaScript's trim set so
    // outputOmitted also survives an all-whitespace prefix and a nonblank tail.
    const wireWhitespace =
      "\u0009\u000a\u000b\u000c\u000d \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff";
    const wireTurnItemPayload = sql`
      CASE item.type
        WHEN 'handoff' THEN json_remove(item.payload_json, '$.summary')
        WHEN 'file_change' THEN CASE WHEN item.status = 'failed'
          THEN json_remove(item.payload_json, '$.oldStr', '$.newStr')
          ELSE json_remove(item.payload_json, '$.oldStr', '$.newStr', '$.diffStr') END
        WHEN 'command_execution' THEN (
          SELECT CASE
          -- substr counts Unicode code points, so this preserves at least the
          -- UTF-16 prefix the wire failure scan needs, including when a later
          -- NUL stops SQLite's length/substr. Shorter prefixes stay intact.
          WHEN json_type(payload, '$.output') = 'text'
            AND length(substr(json_extract(payload, '$.output'), 1, ${COMMAND_OUTPUT_FAILURE_SCAN_CHARS + 1})) > ${COMMAND_OUTPUT_FAILURE_SCAN_CHARS}
          THEN json_patch(
            json_set(jsonb_remove(payload, '$.output'),
              '$.output', substr(json_extract(payload, '$.output'), 1, ${COMMAND_OUTPUT_FAILURE_SCAN_CHARS})),
            CASE WHEN length(trim(substr(json_extract(payload, '$.output'), 1, ${COMMAND_OUTPUT_FAILURE_SCAN_CHARS}), ${wireWhitespace})) > 0
                OR length(trim(json_extract(payload, '$.output'), ${wireWhitespace})) > 0
                OR instr(json_extract(payload, '$.output'), char(0)) > 0
              THEN '{"outputOmitted":true}' ELSE '{}' END
          ) ELSE item.payload_json END
          -- A per-row coroutine parses the large JSON once. OFFSET prevents
          -- flattening from duplicating jsonb() at every field access.
          FROM (SELECT jsonb(item.payload_json) AS payload LIMIT -1 OFFSET 0)
        )
        ELSE item.payload_json
      END
    `;

    const readCanonicalProjection = (
      threadId: ThreadId,
      window?: {
        readonly rowLimit: number;
        readonly userTurnLimit?: number | undefined;
        readonly anchorItemId?: TurnItemId | undefined;
        readonly requiredRunId?: RunId | undefined;
        readonly suppressLocal?: boolean | undefined;
        readonly forWire?: boolean | undefined;
      },
      fields?: ReadonlyArray<ProjectionRecordField>,
      filter?: ProjectionRecordFilter,
    ) =>
      Effect.gen(function* () {
        const threadRows = yield* sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
          LIMIT 1
        `;
        const threadRow = threadRows[0];
        if (!threadRow) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }

        // Where a partial index covers exactly the wanted slice, spell it
        // with literals and name the index outright, so the read seeks
        // matching items instead of walking every item the thread holds.
        // Run-bounded reads keep the run index.
        const failedErrors =
          filter?.turnItemTypes?.length === 1 &&
          filter.turnItemTypes[0] === "error" &&
          filter.turnItemStatuses?.length === 1 &&
          filter.turnItemStatuses[0] === "failed";
        // Secret cards share a primary-key prefix, so seeking that range avoids
        // walking the thread's full tool history when no narrower key is given.
        const secretRequests =
          filter?.turnItemIds === undefined &&
          filter?.turnItemNodeIds === undefined &&
          filter?.turnItemRunId === undefined &&
          filter?.turnItemRunIds === undefined &&
          filter?.turnItemTypes?.length === 1 &&
          filter.turnItemTypes[0] === "secret_request";
        // Background work still running, which Stop and the Waiting strip read thread-wide.
        const activeBackgroundWork =
          filter?.turnItemRunId === undefined &&
          filter?.turnItemRunIds === undefined &&
          filter?.turnItemNodeIds === undefined &&
          hasExactly(filter?.turnItemTypes, ACTIVE_BACKGROUND_WORK_TYPES) &&
          hasExactly(filter?.turnItemStatuses, ACTIVE_BACKGROUND_WORK_STATUSES);
        const turnItemIndexHint =
          filter?.turnItemIds !== undefined || secretRequests
            ? sql`INDEXED BY sqlite_autoindex_orchestration_v2_projection_turn_items_1`
            : failedErrors
              ? sql`INDEXED BY orchestration_v2_projection_turn_items_failed_error_idx`
              : activeBackgroundWork
                ? sql`INDEXED BY orchestration_v2_projection_turn_items_recovery_idx`
                : filter?.turnItemNodeIds !== undefined
                  ? sql`INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx`
                  : filter?.turnItemRunId !== undefined || filter?.turnItemRunIds !== undefined
                    ? sql`INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx`
                    : filter?.turnItemTypes?.length === 1 &&
                        filter.turnItemTypes[0] === "user_message"
                      ? sql`INDEXED BY orchestration_v2_projection_turn_items_user_message_idx`
                      : sql``;
        const boundedTurnItemRows =
          (fields !== undefined && !fields.includes("turnItems")) ||
          (window === undefined &&
            (filter?.turnItemIds?.length === 0 ||
              filter?.turnItemNodeIds?.length === 0 ||
              filter?.turnItemTypes?.length === 0 ||
              filter?.turnItemMessageIds?.length === 0 ||
              filter?.turnItemStatuses?.length === 0 ||
              filter?.turnItemRunIds?.length === 0))
            ? []
            : window === undefined
              ? yield* sql<PayloadRow>`
                SELECT payload_json
                FROM ${filter?.turnItemRunIds === undefined ? sql`orchestration_v2_projection_turn_items` : sql`(SELECT value AS wanted_run FROM json_each(${encodeNullableIds([...new Set(filter.turnItemRunIds)])})) CROSS JOIN orchestration_v2_projection_turn_items`} ${turnItemIndexHint}
                WHERE thread_id = ${threadId}
                  ${filter?.turnItemIds === undefined ? sql`` : sql`AND turn_item_id IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemIds)}))`}
                  ${secretRequests ? sql`AND turn_item_id >= ${SECRET_REQUEST_TURN_ITEM_ID_PREFIX} AND turn_item_id < ${SECRET_REQUEST_TURN_ITEM_ID_PREFIX_END}` : sql``}
                  ${filter?.turnItemNodeIds === undefined ? sql`` : sql`AND node_id IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemNodeIds)}))`}
                  ${filter?.turnItemTypes === undefined ? sql`` : activeBackgroundWork ? sql`AND type IN ('command_execution', 'dynamic_tool', 'subagent')` : secretRequests ? sql`AND type = 'secret_request'` : filter.turnItemTypes.length === 1 && filter.turnItemTypes[0] === "user_message" ? sql`AND type = 'user_message'` : filter.turnItemTypes.length === 1 && filter.turnItemTypes[0] === "error" ? sql`AND type = 'error'` : sql`AND type IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemTypes)}))`}
                  ${filter?.turnItemMessageIds === undefined ? sql`` : sql`AND json_extract(payload_json, '$.messageId') IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemMessageIds)}))`}
                  ${filter?.turnItemStatuses === undefined ? sql`` : activeBackgroundWork ? sql`AND status IN ('pending', 'running', 'waiting')` : filter.turnItemStatuses.length === 1 && filter.turnItemStatuses[0] === "failed" ? sql`AND status = 'failed'` : sql`AND status IN (SELECT value FROM json_each(${encodeIdList(filter.turnItemStatuses)}))`}
                  ${filter?.turnItemRunId === undefined ? sql`` : sql`AND run_id = ${filter.turnItemRunId}`}
                  ${filter?.turnItemRunIds === undefined ? sql`` : sql`AND run_id IS wanted_run`}
                ORDER BY ordinal ASC, turn_item_id ASC
              `
              : yield* sql<PayloadRow>`
                WITH eligible AS NOT MATERIALIZED (
                  SELECT item.rowid AS item_rowid, item.payload_json, item.ordinal, item.turn_item_id,
                    item.run_id, item.node_id, item.type
                  FROM orchestration_v2_projection_turn_items AS item
                  LEFT JOIN orchestration_v2_projection_runs AS run
                    ON run.run_id = item.run_id
                  WHERE item.thread_id = ${threadId}
                    AND item.ordinal <= COALESCE(
                      (
                        SELECT ordinal
                        FROM orchestration_v2_projection_turn_items
                        WHERE thread_id = ${threadId}
                          AND turn_item_id = ${window.anchorItemId ?? null}
                        LIMIT 1
                      ),
                      9223372036854775807
                    )
                    AND (
                      ${window.requiredRunId ?? null} IS NOT NULL
                      OR (
                        (run.status IS NULL OR run.status <> 'rolled_back')
                        AND NOT (
                          item.type = 'user_message'
                          AND json_extract(item.payload_json, '$.inputIntent') = 'queued_turn'
                          AND run.status IS 'cancelled'
                          AND COALESCE(json_extract(run.payload_json, '$.retainQueuedMessage'), 0) = 0
                        )
                      )
                    )
                    AND (
                      ${window.requiredRunId ?? null} IS NULL
                      OR (
                        item.run_id IS NULL
                        AND EXISTS (
                          SELECT 1
                          FROM orchestration_v2_projection_threads AS source_thread
                          WHERE source_thread.thread_id = item.thread_id
                            AND json_extract(source_thread.payload_json, '$.historyOrigin') = 'v1_import'
                        )
                      )
                      OR run.ordinal <= (
                        SELECT required_run.ordinal
                        FROM orchestration_v2_projection_runs AS required_run
                        WHERE required_run.thread_id = item.thread_id
                          AND required_run.run_id = ${window.requiredRunId ?? null}
                        LIMIT 1
                      )
                    )
                    AND NOT (
                      item.type = 'run_interrupt_result'
                      AND EXISTS (
                        SELECT 1
                        FROM orchestration_v2_projection_run_attempts AS attempt
                        WHERE attempt.run_id = item.run_id
                          AND attempt.root_node_id = item.node_id
                          AND attempt.status = 'superseded'
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM orchestration_v2_projection_turn_items AS request
                        WHERE request.thread_id = item.thread_id
                          AND request.run_id = item.run_id
                          AND request.type = 'run_interrupt_request'
                      )
                    )
                ), run_starts AS (
                  -- A wake (PR watch, task completion) starts its run with a
                  -- notification instead of a user message. Read the first
                  -- input of each run, newest run first, and add the
                  -- notifications to the user-message turn starts. A run
                  -- without an eligible first input (queued, rolled back) is
                  -- skipped, so it cannot hide older turns. CROSS JOIN keeps
                  -- the runs as the outer loop, and each probe reads only the
                  -- first rows of a run.
                  SELECT start.ordinal, start.type
                  FROM orchestration_v2_projection_runs AS recent_run
                  CROSS JOIN eligible AS start ON start.item_rowid = (
                    SELECT first_input.rowid
                    FROM orchestration_v2_projection_turn_items AS first_input
                    WHERE first_input.run_id = recent_run.run_id
                      AND first_input.type IN ('user_message', 'notification')
                    ORDER BY first_input.ordinal
                    LIMIT 1
                  )
                  WHERE recent_run.thread_id = ${threadId}
                    AND recent_run.ordinal <= COALESCE(
                      (
                        SELECT anchor_run.ordinal
                        FROM orchestration_v2_projection_turn_items AS anchor_item
                        JOIN orchestration_v2_projection_runs AS anchor_run
                          ON anchor_run.run_id = anchor_item.run_id
                        WHERE anchor_item.thread_id = ${threadId}
                          AND anchor_item.turn_item_id = ${window.anchorItemId ?? null}
                        LIMIT 1
                      ),
                      9223372036854775807
                    )
                    AND ${window.userTurnLimit ?? null} IS NOT NULL
                  ORDER BY recent_run.ordinal DESC
                  LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
                ), turn_anchors AS (
                  SELECT ordinal, payload_json
                  FROM (
                    SELECT ordinal, payload_json
                    FROM eligible
                    WHERE type = 'user_message'
                      AND json_extract(payload_json, '$.inputIntent') IN ('turn_start', 'queued_turn')
                      AND ${window.userTurnLimit ?? null} IS NOT NULL
                    ORDER BY ordinal DESC
                    LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
                  )
                  UNION ALL
                  SELECT ordinal, NULL FROM run_starts WHERE type = 'notification'
                  ORDER BY ordinal DESC
                  LIMIT ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
                ), user_anchors AS (
                  SELECT ordinal
                  FROM turn_anchors
                  WHERE json_extract(payload_json, '$.createdBy') = 'user'
                  ORDER BY ordinal DESC
                  LIMIT ${(window.userTurnLimit ?? 0) + 2}
                ), boundary AS (
                  SELECT CASE
                    WHEN COUNT(*) >= ${(window.userTurnLimit ?? 0) + 2} THEN MIN(ordinal)
                    WHEN (SELECT COUNT(*) FROM turn_anchors) >= ${THREAD_HISTORY_MAX_RAW_TURNS + 2}
                      THEN (SELECT MIN(ordinal) FROM turn_anchors)
                    ELSE 0
                  END AS ordinal
                  FROM user_anchors
                ), latest_user_turn AS (
                  -- Mirrors selectOlderTimelinePage: whole turns while the
                  -- newest user turn fits the turn row budget, otherwise the
                  -- window pages from inside that turn with the row limit.
                  SELECT COUNT(*) AS row_count
                  FROM (
                    SELECT 1
                    FROM eligible
                    WHERE ordinal >= (SELECT MAX(ordinal) FROM user_anchors)
                    LIMIT ${THREAD_HISTORY_PAGE_POLICY.maxTurnItems + 1}
                  )
                ), selected AS (
                  -- Choose and sort rows by ID, then fetch payloads in that
                  -- order. A turn window can hold megabytes of tool output, and
                  -- carrying it through the union and sort cost about a second.
                  SELECT item_rowid, ordinal, turn_item_id, run_id, type
                  FROM eligible
                  WHERE ordinal >= (SELECT ordinal FROM boundary)
                  ORDER BY ordinal DESC, turn_item_id DESC
                  LIMIT CASE
                    WHEN ${window.rowLimit} = 0 THEN 0
                    WHEN (SELECT row_count FROM latest_user_turn)
                      BETWEEN 1 AND ${THREAD_HISTORY_PAGE_POLICY.maxTurnItems}
                      THEN ${THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT}
                    ELSE ${window.rowLimit}
                  END
                ), retained AS MATERIALIZED (
                  SELECT item_rowid, ordinal, turn_item_id FROM selected
                  UNION
                  SELECT request.rowid AS item_rowid, request.ordinal, request.turn_item_id
                  FROM orchestration_v2_projection_turn_items AS request
                  WHERE request.run_id IN (
                      SELECT run_id FROM selected
                      WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
                    )
                    AND request.type = 'run_interrupt_request'
                  UNION
                  SELECT rowid AS item_rowid, ordinal, turn_item_id
                  FROM orchestration_v2_projection_turn_items
                    INDEXED BY orchestration_v2_projection_turn_items_recovery_idx
                  WHERE thread_id = ${threadId}
                    AND type IN ('command_execution', 'dynamic_tool', 'subagent')
                    AND status IN ('pending', 'running', 'waiting')
                    AND type = 'subagent' AND json_type(payload_json, '$.childActivity') = 'object'
                    AND ${window.anchorItemId ?? null} IS NULL
                    AND ${window.requiredRunId ?? null} IS NULL
                  UNION
                  -- A question or approval still waiting for an answer renders
                  -- from its request item, however many turns ago it was asked.
                  -- Without it the chat shows no card while the chat list still
                  -- says it needs an answer.
                  SELECT item.rowid AS item_rowid, item.ordinal, item.turn_item_id
                  -- CROSS JOIN keeps the few open requests as the outer loop:
                  -- without statistics SQLite may walk every item of the chat.
                  FROM orchestration_v2_projection_runtime_requests AS request
                  CROSS JOIN orchestration_v2_projection_turn_items AS item
                    INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
                    ON item.node_id = request.node_id AND item.thread_id = request.thread_id
                  WHERE request.thread_id = ${threadId}
                    AND request.status = 'pending'
                    AND item.type IN ('user_input_request', 'approval_request')
                    AND ${window.rowLimit} > 0
                    AND ${window.anchorItemId ?? null} IS NULL
                    AND ${window.requiredRunId ?? null} IS NULL
                  UNION
                  SELECT latest.item_rowid, latest.ordinal, latest.turn_item_id
                  FROM (
                    SELECT rowid AS item_rowid, ordinal, turn_item_id
                    FROM orchestration_v2_projection_turn_items
                    WHERE thread_id = ${threadId}
                      AND ${window.anchorItemId ?? null} IS NULL
                      AND ${window.requiredRunId ?? null} IS NULL
                    ORDER BY ordinal DESC, turn_item_id DESC
                    LIMIT 1
                  ) AS latest
                  ORDER BY ordinal ASC, turn_item_id ASC
                )
                -- CROSS JOIN keeps the sorted IDs as the outer loop, so SQLite
                -- skips sorting again once the payloads are attached. Carry the
                -- rowid through selection to avoid a second string-key index lookup.
                SELECT ${window.forWire === true ? wireTurnItemPayload : sql`item.payload_json`} AS payload_json
                FROM retained
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  ON item.rowid = retained.item_rowid
                ORDER BY retained.ordinal ASC, retained.turn_item_id ASC
              `;
        // Reuse the decoded items for cohort IDs and the resulting projection.
        // Parsing these rows separately duplicates every retained tool output.
        const turnItems = yield* decodeRows(decodeTurnItemPayload, threadId)(boundedTurnItemRows);
        const cohortJson = (field: string) =>
          JSON.stringify(
            turnItems.flatMap((payload) => {
              const value = nullableStringField(payload, field);
              return value === null ? [] : [value];
            }),
          );
        const cohortRunIds = cohortJson("runId");
        // A run can contain thousands of completed nodes. Load the visible
        // nodes and live control dependencies, then walk only their ancestors.
        const cohortNodeIds =
          window === undefined ||
          (fields !== undefined &&
            fields.every(
              (field) => field === "runs" || field === "attempts" || field === "turnItems",
            ))
            ? cohortJson("nodeId")
            : encodeIdList(
                (yield* sql<{ readonly node_id: string }>`
            WITH RECURSIVE retained(node_id) AS (
              SELECT value FROM json_each(${cohortJson("nodeId")})
              UNION
              SELECT node_id FROM orchestration_v2_projection_nodes
              WHERE thread_id = ${threadId} AND status IN ('pending','starting','running','waiting')
              UNION
              SELECT root_node_id FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId} AND (
                status IN ('pending','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR run_id = ${window.requiredRunId ?? null})
              UNION
              SELECT json_extract(run.payload_json, '$.rootNodeId')
              FROM orchestration_v2_projection_runs AS run
                INDEXED BY orchestration_v2_projection_runs_recovery_idx
              WHERE run.thread_id = ${threadId}
                AND run.status IN ('queued','preparing','starting','running','waiting')
              UNION
              SELECT json_extract(run.payload_json, '$.rootNodeId')
              FROM json_each(${cohortRunIds}) AS wanted
              CROSS JOIN orchestration_v2_projection_runs AS run
                ON run.run_id = wanted.value
              WHERE run.thread_id = ${threadId}
              UNION
              SELECT json_extract(payload_json, '$.rootNodeId')
              FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId}
                AND run_id = ${window.requiredRunId ?? null}
              UNION
              SELECT node_id FROM orchestration_v2_projection_runtime_requests
              WHERE thread_id = ${threadId} AND status IN ('pending','waiting')
              UNION
              SELECT parent_node_id FROM orchestration_v2_projection_subagents
              WHERE thread_id = ${threadId} AND status IN ('pending','starting','running','waiting')
              UNION
              SELECT node_id FROM orchestration_v2_projection_provider_turns
              WHERE thread_id = ${threadId} AND status IN ('starting','running','waiting')
              UNION
              SELECT parent.parent_node_id FROM orchestration_v2_projection_nodes AS parent
              INNER JOIN retained ON parent.node_id = retained.node_id
              WHERE parent.thread_id = ${threadId} AND parent.parent_node_id IS NOT NULL
            )
            -- Sort IDs before fetching bodies, so large payloads never enter
            -- SQLite's temporary sort. The node read restores this order by key.
            SELECT retained.node_id
            FROM retained
            LEFT JOIN orchestration_v2_projection_nodes AS node
              ON node.node_id = retained.node_id AND node.thread_id = ${threadId}
            WHERE retained.node_id IS NOT NULL
            ORDER BY COALESCE(node.started_at, ''), retained.node_id ASC
          `).map((row) => row.node_id),
              );
        const cohortProviderThreadIds = cohortJson("providerThreadId");
        const cohortProviderTurnIds = cohortJson("providerTurnId");
        const cohortMessageIds = cohortJson("messageId");
        const cohortPlanIds = cohortJson("planId");
        const cohortCheckpointIds = cohortJson("checkpointId");
        const cohortHandoffIds = cohortJson("contextHandoffId");

        const [
          thread,
          runRows,
          attemptRows,
          nodeRows,
          subagentRows,
          providerSessionRows,
          providerThreadRows,
          providerTurnRows,
          runtimeRequestRows,
          messageRows,
          planRows,
          checkpointScopeRows,
          checkpointRows,
          contextHandoffRows,
          contextTransferRows,
        ] = yield* Effect.all([
          decodeThreadPayload(threadRow.payload_json),
          fields !== undefined && !fields.includes("runs")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_runs ${filter?.activeRunsOnly ? sql`INDEXED BY orchestration_v2_projection_runs_thread_status_idx` : filter?.runIds === undefined ? sql`` : sql`INDEXED BY sqlite_autoindex_orchestration_v2_projection_runs_1`}
            WHERE thread_id = ${threadId}
              ${filter?.activeRunsOnly ? sql`AND status IN ('queued','preparing','starting','running','waiting')` : sql``}
              ${filter?.runIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.runIds)}))`}
            ORDER BY ordinal ASC
          `
              : sql<PayloadRow>`
            SELECT run.payload_json
            FROM (
              SELECT run_id
              FROM orchestration_v2_projection_runs
                INDEXED BY orchestration_v2_projection_runs_recovery_idx
              WHERE thread_id = ${threadId}
                AND status IN ('queued','preparing','starting','running','waiting')
              UNION
              SELECT run.run_id
              FROM json_each(${cohortRunIds}) AS wanted
              CROSS JOIN orchestration_v2_projection_runs AS run
                ON run.run_id = wanted.value
              WHERE run.thread_id = ${threadId}
              UNION
              SELECT run_id
              FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId}
                AND run_id = ${window.requiredRunId ?? null}
            ) AS retained
            CROSS JOIN orchestration_v2_projection_runs AS run
              ON run.run_id = retained.run_id
            ORDER BY run.ordinal ASC
          `,
          fields !== undefined && !fields.includes("attempts")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId}
              ${filter?.attemptRunIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.attemptRunIds)}))`}
            ORDER BY run_id ASC, attempt_ordinal ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_run_attempts
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds})))
            ORDER BY run_id ASC, attempt_ordinal ASC
          `,
          (fields !== undefined && !fields.includes("nodes")) ||
          (window === undefined &&
            (filter?.nodeIds?.length === 0 || filter?.nodeRunIds?.length === 0))
            ? Effect.succeed([])
            : window === undefined
              ? sql<
                  PayloadRow & {
                    readonly node_id: string;
                    readonly started_at: string | null;
                  }
                >`
            SELECT payload_json, node.node_id, node.started_at
            FROM orchestration_v2_projection_nodes AS node ${filter?.nodeIds !== undefined ? sql`INDEXED BY sqlite_autoindex_orchestration_v2_projection_nodes_1` : filter?.liveNodesOnly === true && filter?.nodeRunIds === undefined ? sql`INDEXED BY orchestration_v2_projection_nodes_live_idx` : sql``}
            WHERE node.thread_id = ${threadId}
              ${filter?.nodeIds === undefined ? sql`` : sql`AND node.node_id IN (SELECT value FROM json_each(${encodeIdList(filter.nodeIds)}))`}
              ${filter?.nodeRunIds === undefined ? sql`` : sql`AND node.run_id IN (SELECT value FROM json_each(${encodeIdList(filter.nodeRunIds)}))`}
              ${filter?.liveNodesOnly === true ? sql`AND node.status IN ('pending', 'starting', 'running', 'waiting')` : sql``}
              ${
                filter?.omitSettledLeafNodes === true
                  ? sql`AND NOT (
                      node.kind IN ('tool_call', 'assistant_message', 'reasoning')
                      AND node.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                      AND node.run_id IS NOT NULL
                      -- Build the small live-run set once rather than seeking
                      -- the run for every finished leaf in the chat.
                      AND node.run_id NOT IN (
                        SELECT run_id FROM orchestration_v2_projection_runs
                        WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                      )
                    )`
                  : sql``
              }
              `.pipe(
                  // SQLite's synchronous temporary sort copies every payload.
                  // Sort references by the same keys after reading the bodies.
                  Effect.map((rows) =>
                    rows.toSorted((left, right) => {
                      const leftStart = left.started_at ?? "";
                      const rightStart = right.started_at ?? "";
                      if (leftStart !== rightStart) return leftStart < rightStart ? -1 : 1;
                      return left.node_id < right.node_id
                        ? -1
                        : left.node_id > right.node_id
                          ? 1
                          : 0;
                    }),
                  ),
                )
              : sql<PayloadRow & { readonly position: number }>`
            -- Keep retained IDs outermost so SQLite looks up each node by its
            -- primary key instead of scanning every historical node in the thread.
            SELECT node.payload_json, retained.key AS position
            FROM json_each(${cohortNodeIds}) AS retained
            CROSS JOIN orchestration_v2_projection_nodes AS node
              ON node.node_id = retained.value
            WHERE node.thread_id = ${threadId}
          `.pipe(
                  Effect.map((rows) =>
                    rows.toSorted((left, right) => left.position - right.position),
                  ),
                ),
          fields !== undefined && !fields.includes("subagents")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId}
            ORDER BY COALESCE(started_at, ''), subagent_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','starting','running','waiting')
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR parent_node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY COALESCE(started_at, ''), subagent_id ASC
          `,
          fields !== undefined && !fields.includes("providerSessions")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT sessions.payload_json
            FROM orchestration_v2_projection_provider_sessions AS sessions
            INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
              ON bindings.provider_session_id = sessions.provider_session_id
            WHERE bindings.thread_id = ${threadId}
            ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
          `
              : sql<PayloadRow>`
            SELECT DISTINCT sessions.payload_json
            FROM orchestration_v2_projection_provider_sessions AS sessions
            INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
              ON bindings.provider_session_id = sessions.provider_session_id
            LEFT JOIN orchestration_v2_projection_provider_threads AS threads
              ON threads.provider_session_id = sessions.provider_session_id
            WHERE bindings.thread_id = ${threadId}
              AND (sessions.status IN ('starting','running','waiting')
                OR threads.provider_thread_id IN (SELECT value FROM json_each(${cohortProviderThreadIds})))
            ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
          `,
          (fields !== undefined && !fields.includes("providerThreads")) ||
          (window === undefined && filter?.providerThreadIds?.length === 0)
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT owned.payload_json
            -- The OR of these owners can scan every provider thread. Seek each
            -- ownership index, deduplicate IDs, then fetch only matching payloads.
            FROM (
              SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads
                INDEXED BY orchestration_v2_projection_provider_threads_thread_idx
              WHERE thread_id = ${threadId}
              UNION
              SELECT provider.provider_thread_id
              -- A long chat can have hundreds of thousands of nodes but few
              -- owned provider threads. Start with non-null owners in the
              -- existing index, then seek their nodes by primary key.
              FROM orchestration_v2_projection_provider_threads provider
                INDEXED BY orchestration_v2_projection_provider_threads_owner_idx
              CROSS JOIN orchestration_v2_projection_nodes node
                INDEXED BY sqlite_autoindex_orchestration_v2_projection_nodes_1
                ON node.node_id = provider.owner_node_id
              WHERE provider.owner_node_id IS NOT NULL AND node.thread_id = ${threadId}
              UNION
              SELECT provider_thread_id
              FROM orchestration_v2_projection_subagents
                INDEXED BY orchestration_v2_projection_subagents_thread_idx
              WHERE thread_id = ${threadId} AND provider_thread_id IS NOT NULL
            ) owners
            CROSS JOIN orchestration_v2_projection_provider_threads owned
              ON owned.provider_thread_id = owners.provider_thread_id
            ${filter?.providerThreadIds === undefined ? sql`` : sql`WHERE owned.provider_thread_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerThreadIds)}))`}
            ORDER BY COALESCE(owned.first_run_ordinal, 0), owned.provider_thread_id ASC
          `
              : sql<PayloadRow>`
            SELECT owned.payload_json
            FROM (
              SELECT provider_thread_id
              FROM orchestration_v2_projection_provider_threads
                INDEXED BY orchestration_v2_projection_provider_threads_thread_idx
              WHERE thread_id = ${threadId} AND status = 'active'
              UNION
              SELECT value FROM json_each(${cohortProviderThreadIds})
              UNION
              SELECT provider.provider_thread_id
              FROM json_each(${cohortNodeIds}) retained
              CROSS JOIN orchestration_v2_projection_provider_threads provider
                INDEXED BY orchestration_v2_projection_provider_threads_owner_idx
                ON provider.owner_node_id = retained.value
            ) owners
            CROSS JOIN orchestration_v2_projection_provider_threads owned
              ON owned.provider_thread_id = owners.provider_thread_id
            ORDER BY COALESCE(owned.first_run_ordinal, 0), owned.provider_thread_id ASC
          `,
          (fields !== undefined && !fields.includes("providerTurns")) ||
          (window === undefined && filter?.providerTurnAttemptIds?.length === 0)
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_provider_turns ${filter?.providerTurnIds === undefined ? sql`` : sql`INDEXED BY sqlite_autoindex_orchestration_v2_projection_provider_turns_1`}
            WHERE thread_id = ${threadId}
              ${filter?.providerTurnIds === undefined ? sql`` : sql`AND provider_turn_id IN (SELECT value FROM json_each(${encodeIdList(filter.providerTurnIds)}))`}
              ${filter?.providerTurnAttemptIds === undefined ? sql`` : sql`AND (run_attempt_id IN (SELECT value FROM json_each(${encodeNullableIds(filter.providerTurnAttemptIds)})) ${filter.providerTurnAttemptIds.includes(null) ? sql`OR run_attempt_id IS NULL` : sql``})`}
            ORDER BY provider_thread_id ASC, ordinal ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId}
              AND (status IN ('starting','running','waiting')
                OR provider_turn_id IN (SELECT value FROM json_each(${cohortProviderTurnIds}))
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY provider_thread_id ASC, ordinal ASC
          `,
          fields !== undefined && !fields.includes("runtimeRequests")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_runtime_requests ${filter?.pendingRuntimeRequestsOnly ? sql`INDEXED BY orchestration_v2_projection_requests_recovery_idx` : sql``}
            WHERE thread_id = ${threadId}
              ${filter?.pendingRuntimeRequestsOnly ? sql`AND status = 'pending'` : sql``}
            ORDER BY created_at ASC, runtime_request_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_runtime_requests
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','waiting')
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds}))
                OR provider_turn_id IN (SELECT value FROM json_each(${cohortProviderTurnIds})))
            ORDER BY created_at ASC, runtime_request_id ASC
          `,
          (fields !== undefined && !fields.includes("messages")) ||
          (window === undefined &&
            (filter?.messageIds?.length === 0 ||
              filter?.messageRunIds?.length === 0 ||
              filter?.messageRoles?.length === 0))
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_messages ${filter?.messageIds !== undefined ? sql`INDEXED BY sqlite_autoindex_orchestration_v2_projection_messages_1` : filter?.messageRunIds !== undefined ? sql`INDEXED BY orchestration_v2_projection_messages_run_idx` : sql``}
                WHERE thread_id = ${threadId}
                  ${filter?.messageIds === undefined ? sql`` : sql`AND message_id IN (SELECT value FROM json_each(${encodeIdList(filter.messageIds)}))`}
                  ${filter?.messageRoles === undefined ? sql`` : sql`AND role IN (SELECT value FROM json_each(${encodeIdList(filter.messageRoles)}))`}
                  ${filter?.messageRunIds === undefined ? sql`` : sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.messageRunIds)}))`}
                ORDER BY created_at ASC, message_id ASC
              `
              : sql<PayloadRow>`
                SELECT message.payload_json
                FROM (
                  SELECT message.message_id
                  FROM json_each(${cohortMessageIds}) AS wanted
                  CROSS JOIN orchestration_v2_projection_messages AS message
                    ON message.message_id = wanted.value
                  WHERE message.thread_id = ${threadId}
                  UNION
                  SELECT message.message_id
                  FROM orchestration_v2_projection_runs AS run
                    INDEXED BY orchestration_v2_projection_runs_recovery_idx
                  CROSS JOIN orchestration_v2_projection_messages AS message
                    ON message.run_id = run.run_id
                  WHERE run.thread_id = ${threadId}
                    AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                    AND message.thread_id = ${threadId}
                ) AS retained
                CROSS JOIN orchestration_v2_projection_messages AS message
                  ON message.message_id = retained.message_id
                ORDER BY message.created_at ASC, message.message_id ASC
              `,
          fields !== undefined && !fields.includes("plans")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_plans
                WHERE thread_id = ${threadId} ORDER BY plan_id ASC
              `
              : sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_plans AS plan
                WHERE plan.thread_id = ${threadId}
                  AND (
                    plan.status = 'active'
                    OR plan.plan_id IN (
                      SELECT value FROM json_each(${cohortPlanIds})
                    )
                  )
                ORDER BY plan_id ASC
              `,
          fields !== undefined && !fields.includes("checkpointScopes")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_checkpoint_scopes ${filter?.checkpointScopeIds === undefined ? sql`` : sql`INDEXED BY sqlite_autoindex_orchestration_v2_projection_checkpoint_scopes_1`}
            WHERE thread_id = ${threadId}
              ${filter?.checkpointScopeIds === undefined ? sql`` : sql`AND scope_id IN (SELECT value FROM json_each(${encodeIdList(filter.checkpointScopeIds)}))`}
            ORDER BY ordinal_within_parent ASC, scope_id ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId}
              AND (run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY ordinal_within_parent ASC, scope_id ASC
          `,
          fields !== undefined && !fields.includes("checkpoints")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
            ORDER BY scope_id ASC, ordinal_within_scope ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId}
              AND (status IN ('pending','capturing')
                OR checkpoint_id IN (SELECT value FROM json_each(${cohortCheckpointIds}))
                OR run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR node_id IN (SELECT value FROM json_each(${cohortNodeIds})))
            ORDER BY scope_id ASC, ordinal_within_scope ASC
          `,
          fields !== undefined && !fields.includes("contextHandoffs")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
                SELECT payload_json FROM orchestration_v2_projection_context_handoffs
                WHERE thread_id = ${threadId} ORDER BY rowid ASC
              `
              : sql<PayloadRow>`
                -- Settled handoffs stay in status 'ready' permanently. Loading
                -- all ready handoffs for a long chat ships hundreds of KB of
                -- history on every bounded open; load only pending handoffs and
                -- those referenced by the window's items or active/window runs.
                SELECT handoff.payload_json
                FROM (
                  SELECT rowid AS handoff_rowid
                  FROM orchestration_v2_projection_context_handoffs
                  WHERE thread_id = ${threadId}
                    AND status = 'pending'
                  UNION
                  SELECT handoff.rowid AS handoff_rowid
                  FROM json_each(${cohortHandoffIds}) AS wanted
                  CROSS JOIN orchestration_v2_projection_context_handoffs AS handoff
                    ON handoff.context_handoff_id = wanted.value
                  WHERE handoff.thread_id = ${threadId}
                  UNION
                  SELECT handoff.rowid AS handoff_rowid
                  FROM json_each(${cohortRunIds}) AS wanted
                  CROSS JOIN orchestration_v2_projection_context_handoffs AS handoff
                    INDEXED BY orchestration_v2_projection_context_handoffs_target_run_idx
                    ON handoff.target_run_id = wanted.value
                  WHERE handoff.thread_id = ${threadId}
                  UNION
                  SELECT handoff.rowid AS handoff_rowid
                  FROM orchestration_v2_projection_runs AS run
                    INDEXED BY orchestration_v2_projection_runs_recovery_idx
                  CROSS JOIN orchestration_v2_projection_context_handoffs AS handoff
                    INDEXED BY orchestration_v2_projection_context_handoffs_target_run_idx
                    ON handoff.target_run_id = run.run_id
                  WHERE run.thread_id = ${threadId}
                    AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                    AND handoff.thread_id = ${threadId}
                ) AS retained
                CROSS JOIN orchestration_v2_projection_context_handoffs AS handoff
                  ON handoff.rowid = retained.handoff_rowid
                ORDER BY handoff.rowid ASC
              `,
          fields !== undefined && !fields.includes("contextTransfers")
            ? Effect.succeed([])
            : window === undefined
              ? sql<PayloadRow>`
            SELECT payload_json
            FROM orchestration_v2_projection_context_transfers
            WHERE ${filter?.pendingIncomingTransfersOnly ? sql`target_thread_id = ${threadId} AND status = 'pending'` : sql`source_thread_id = ${threadId} OR target_thread_id = ${threadId}`}
            ORDER BY rowid ASC
          `
              : sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_context_transfers
            WHERE (source_thread_id = ${threadId} OR target_thread_id = ${threadId})
              AND (status IN ('pending','running','waiting')
                OR target_run_id IN (SELECT value FROM json_each(${cohortRunIds}))
                OR json_extract(payload_json, '$.contextHandoffId') IN
                  (SELECT value FROM json_each(${cohortHandoffIds})))
            ORDER BY rowid ASC
          `,
        ]);

        const [
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          plans,
          checkpointScopes,
          checkpoints,
          contextHandoffs,
          contextTransfers,
        ] = yield* Effect.all([
          decodeRows(decodeRunPayload, threadId)(runRows),
          decodeRows(decodeRunAttemptPayload, threadId)(attemptRows),
          decodeRows(decodeNodePayload, threadId)(nodeRows),
          decodeRows(decodeSubagentPayload, threadId)(subagentRows),
          decodeRows(decodeProviderSessionPayload, threadId)(providerSessionRows),
          decodeRows(decodeProviderThreadPayload, threadId)(providerThreadRows),
          decodeRows(decodeProviderTurnPayload, threadId)(providerTurnRows),
          decodeRows(decodeRuntimeRequestPayload, threadId)(runtimeRequestRows),
          decodeRows(decodeMessagePayload, threadId)(messageRows),
          decodeRows(decodePlanPayload, threadId)(planRows),
          decodeRows(decodeCheckpointScopePayload, threadId)(checkpointScopeRows),
          decodeRows(decodeCheckpointPayload, threadId)(checkpointRows),
          decodeRows(decodeContextHandoffPayload, threadId)(contextHandoffRows),
          decodeRows(decodeContextTransferPayload, threadId)(contextTransferRows),
        ]);
        // A metadata read must preserve message ordering without decoding tool output.
        const messageOrdinals = new Map<string, number>();
        if (
          !filter?.unorderedMessages &&
          fields !== undefined &&
          fields.includes("messages") &&
          messages.length > 1
        ) {
          // Every writer gives a message's turn items the message's run and its role's
          // item type, so a lookup may seek only those runs and that type.
          const allUserMessages = messages.every((message) => message.role === "user");
          const allAssistantMessages = messages.every((message) => message.role === "assistant");
          const neededTurnItemTypes: ReadonlyArray<"user_message" | "assistant_message"> =
            allUserMessages
              ? ["user_message"]
              : allAssistantMessages
                ? ["assistant_message"]
                : ["user_message", "assistant_message"];
          const loadedRunIds = messages.every((message) => message.runId !== null)
            ? [...new Set(messages.map((message) => message.runId!))]
            : undefined;
          const turnItemsCoverMessages =
            fields.includes("turnItems") &&
            window === undefined &&
            filter?.turnItemIds === undefined &&
            filter?.turnItemNodeIds === undefined &&
            filter?.turnItemStatuses === undefined &&
            filter?.turnItemMessageIds === undefined &&
            (filter?.turnItemTypes === undefined ||
              neededTurnItemTypes.every((type) => filter.turnItemTypes!.includes(type))) &&
            ((filter?.turnItemRunId === undefined && filter?.turnItemRunIds === undefined) ||
              (loadedRunIds !== undefined &&
                loadedRunIds.every(
                  (runId) =>
                    (filter?.turnItemRunId === undefined || filter.turnItemRunId === runId) &&
                    (filter?.turnItemRunIds === undefined || filter.turnItemRunIds.includes(runId)),
                )));
          if (!turnItemsCoverMessages) {
            // Broad role reads keep the original query to avoid per-ID lookup overhead.
            const loadedMessageIds =
              filter?.messageIds === undefined &&
              filter?.messageRunIds === undefined &&
              (filter?.messageRoles === undefined ||
                (filter.messageRoles.includes("user") && filter.messageRoles.includes("assistant")))
                ? undefined
                : messages.map((message) => message.id);
            const seekRunIds =
              (filter?.messageIds !== undefined || filter?.messageRunIds !== undefined) &&
              loadedRunIds !== undefined &&
              loadedRunIds.length > 0 &&
              (!allUserMessages || loadedRunIds.length <= 32)
                ? loadedRunIds
                : undefined;
            const typeCondition = allUserMessages
              ? sql`item.type = 'user_message'`
              : allAssistantMessages
                ? sql`item.type = 'assistant_message'`
                : sql`item.type IN ('user_message', 'assistant_message')`;
            const rows =
              seekRunIds !== undefined
                ? yield* sql<{ message_id: string; ordinal: number }>`
                    SELECT json_extract(item.payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
                    FROM (SELECT value AS wanted_run FROM json_each(${encodeIdList(seekRunIds)})) AS wanted
                    CROSS JOIN orchestration_v2_projection_turn_items AS item
                      INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                    WHERE item.thread_id = ${threadId}
                      AND item.run_id = wanted.wanted_run
                      AND ${typeCondition}
                      ${loadedMessageIds === undefined ? sql`` : sql`AND json_extract(item.payload_json, '$.messageId') IN (SELECT value FROM json_each(${encodeIdList(loadedMessageIds)}))`}
                    GROUP BY json_extract(item.payload_json, '$.messageId')
                  `
                : yield* sql<{ message_id: string; ordinal: number }>`
                    SELECT json_extract(item.payload_json, '$.messageId') AS message_id, MIN(ordinal) AS ordinal
                    FROM orchestration_v2_projection_turn_items AS item
                      ${allUserMessages ? sql`INDEXED BY orchestration_v2_projection_turn_items_user_message_idx` : sql``}
                    WHERE item.thread_id = ${threadId} AND ${typeCondition}
                      ${loadedMessageIds === undefined ? sql`` : sql`AND json_extract(item.payload_json, '$.messageId') IN (SELECT value FROM json_each(${encodeIdList(loadedMessageIds)}))`}
                    GROUP BY json_extract(item.payload_json, '$.messageId')
                  `;
            for (const row of rows) messageOrdinals.set(row.message_id, row.ordinal);
          }
        }
        const orderedMessages = filter?.unorderedMessages
          ? messages
          : sortMessagesByTurnItemOrder(messages, turnItems, messageOrdinals);
        const projection = {
          thread,
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages: orderedMessages,
          plans,
          turnItems,
          checkpointScopes,
          checkpoints,
          contextHandoffs,
          contextTransfers,
          visibleTurnItems: [],
          updatedAt: thread.updatedAt,
        } satisfies OrchestrationV2ThreadProjection;
        return projection;
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({
                threadId,
                cause,
              }),
        ),
      );

    const readProjection = (
      threadId: ThreadId,
      seenThreadIds: ReadonlySet<ThreadId>,
      window?: {
        readonly rowLimit: number;
        readonly userTurnLimit?: number | undefined;
        readonly anchorItemId?: TurnItemId | undefined;
        readonly requiredRunId?: RunId | undefined;
        readonly suppressLocal?: boolean | undefined;
        readonly forWire?: boolean | undefined;
        readonly historyAnchor?:
          | { readonly threadId: ThreadId; readonly itemId: TurnItemId }
          | undefined;
      },
    ): Effect.Effect<OrchestrationV2ThreadProjection, ProjectionStoreV2Error> =>
      Effect.gen(function* () {
        const localWindow =
          window?.suppressLocal === true ||
          (window?.historyAnchor !== undefined && window.historyAnchor.threadId !== threadId)
            ? { ...window, rowLimit: 0, anchorItemId: undefined }
            : window;
        // Ancestors contribute timeline items, not their provider/control state.
        // Keep their runs and attempts for fork boundaries and visibility.
        const projection = yield* readCanonicalProjection(
          threadId,
          localWindow,
          window !== undefined && seenThreadIds.size > 0
            ? ["runs", "attempts", "turnItems"]
            : undefined,
        );
        const forkedFrom = projection.thread.forkedFrom;
        if (forkedFrom?.type !== "run" || seenThreadIds.has(forkedFrom.threadId)) {
          return withLocalVisibleTurnItems(projection);
        }

        // A row-limited segment without turn anchors must finish paging locally
        // before inherited user turns can influence the page boundary.
        if (
          window?.userTurnLimit !== undefined &&
          localWindow !== undefined &&
          localWindow.rowLimit > 0 &&
          projection.turnItems.length >= localWindow.rowLimit &&
          !projection.turnItems.some(isThreadHistoryUserTurn)
        ) {
          return withLocalVisibleTurnItems(projection);
        }

        const sourceWindow =
          window === undefined
            ? undefined
            : yield* Effect.gen(function* () {
                const historyAnchor = window.historyAnchor;
                const anchorBelongsToSource = historyAnchor?.threadId === forkedFrom.threadId;
                const rows = yield* sql<{ readonly turn_item_id: string }>`
                  WITH fork_run AS (
                    SELECT ordinal
                    FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${forkedFrom.threadId}
                      AND run_id = ${forkedFrom.runId}
                    LIMIT 1
                  ), fork_boundary AS (
                    SELECT (
                      SELECT item.ordinal
                      FROM orchestration_v2_projection_turn_items AS item
                      WHERE item.run_id = run.run_id
                      ORDER BY item.ordinal DESC
                      LIMIT 1
                    ) AS ordinal
                    FROM orchestration_v2_projection_runs AS run
                    WHERE run.thread_id = ${forkedFrom.threadId}
                      AND run.ordinal <= (SELECT ordinal FROM fork_run)
                      AND EXISTS (
                        SELECT 1
                        FROM orchestration_v2_projection_turn_items AS item
                        WHERE item.run_id = run.run_id
                        LIMIT 1
                      )
                    ORDER BY run.ordinal DESC
                    LIMIT 1
                  ), effective_boundary AS (
                    SELECT COALESCE(
                      (SELECT ordinal FROM fork_boundary),
                      (
                        SELECT ordinal
                        FROM orchestration_v2_projection_turn_items
                        WHERE thread_id = ${forkedFrom.threadId}
                          AND run_id IS NULL
                          AND json_extract(payload_json, '$.historyOrigin') = 'v1_import'
                        ORDER BY ordinal DESC, turn_item_id DESC
                        LIMIT 1
                      ),
                      -1
                    ) AS ordinal
                  )
                  SELECT turn_item_id
                  FROM orchestration_v2_projection_turn_items
                  WHERE thread_id = ${forkedFrom.threadId}
                    AND ordinal <= COALESCE(
                      (SELECT ordinal FROM effective_boundary),
                      -1
                    )
                    AND (
                      ${anchorBelongsToSource ? 1 : 0} = 0
                      OR ordinal <= COALESCE(
                        (SELECT ordinal FROM orchestration_v2_projection_turn_items
                         WHERE thread_id = ${forkedFrom.threadId}
                           AND turn_item_id = ${historyAnchor?.itemId ?? null}
                         LIMIT 1),
                        (SELECT ordinal FROM effective_boundary),
                        -1
                      )
                    )
                  ORDER BY ordinal DESC, turn_item_id DESC
                  LIMIT 1
                `;
                const anchor = rows[0]?.turn_item_id;
                const anchorIsInDescendant =
                  historyAnchor !== undefined &&
                  historyAnchor.threadId !== threadId &&
                  historyAnchor.threadId !== forkedFrom.threadId;
                return {
                  rowLimit: window.rowLimit,
                  userTurnLimit: window.userTurnLimit,
                  forWire: window.forWire,
                  requiredRunId: forkedFrom.runId,
                  suppressLocal: anchor === undefined || anchorIsInDescendant,
                  ...(anchor === undefined || anchorIsInDescendant
                    ? {}
                    : { anchorItemId: TurnItemId.make(anchor) }),
                  ...(historyAnchor === undefined || historyAnchor.threadId === threadId
                    ? {}
                    : { historyAnchor }),
                };
              });

        const sourceProjection = yield* readProjection(
          forkedFrom.threadId,
          new Set([...seenThreadIds, threadId]),
          sourceWindow,
        );
        return {
          ...projection,
          visibleTurnItems: buildVisibleTurnItems({
            projection,
            sourceProjection,
          }),
        };
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const getProviderRetryCandidates: ProjectionStoreV2Shape["getProviderRetryCandidates"] = (
      now,
    ) =>
      Effect.gen(function* () {
        // Read only due failed runs. The dispatch lock rechecks source ownership,
        // model selection, requests, and Stop before sending a continuation.
        const rows = yield* sql<{ readonly payload_json: string }>`
          SELECT r.payload_json
          FROM orchestration_v2_projection_threads t
          CROSS JOIN orchestration_v2_projection_runs r INDEXED BY orchestration_v2_projection_runs_thread_status_idx
            ON r.thread_id = t.thread_id
          WHERE r.status IN ('failed', 'cancelled')
            AND json_extract(r.payload_json, '$.automaticProviderRetry.status') = 'scheduled'
            AND json_extract(r.payload_json, '$.automaticProviderRetry.scheduledAt') <= ${DateTime.formatIso(now)}
            AND t.deleted_at IS NULL
            AND t.archived_at IS NULL
            AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
          ORDER BY r.thread_id, r.ordinal
        `;
        return yield* Effect.forEach(rows, (row) => decodeRunPayload(row.payload_json));
      }).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
      );

    const getIdleDelegatedTaskThreadIds: ProjectionStoreV2Shape["getIdleDelegatedTaskThreadIds"] = (
      idleSince,
    ) =>
      Effect.gen(function* () {
        const cutoff = DateTime.formatIso(idleSince);
        // Few task rows are still working, and the status column filters to them first.
        const rows = yield* sql<{ readonly thread_id: string }>`
          SELECT DISTINCT task.child_thread_id AS thread_id
          FROM orchestration_v2_projection_subagents AS task
          JOIN orchestration_v2_projection_threads AS child
            ON child.thread_id = task.child_thread_id
          WHERE task.status IN ('pending', 'running', 'waiting')
            AND task.origin = 'app_owned'
            AND task.updated_at <= ${cutoff}
            AND json_extract(task.payload_json, '$.remote') IS NULL
            AND child.deleted_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs AS run
              WHERE run.thread_id = task.child_thread_id
                AND (
                  run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  OR run.completed_at > ${cutoff}
                )
            )
        `;
        return rows.map((row) => ThreadId.make(row.thread_id));
      }).pipe(
        NodeSqliteClient.readOnly,
        Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
      );

    const getLimitRecoveryCandidates = Effect.fn("ProjectionStore.getLimitRecoveryCandidates")(
      function* (options: Parameters<ProjectionStoreV2Shape["getLimitRecoveryCandidates"]>[0]) {
        // Indexed latest-run and root-error lookups avoid reading run histories,
        // counting transcript items, or walking fork ancestors on scheduler ticks.
        const rows = yield* sql<{
          readonly payload_json: string;
          readonly run_id: string;
          readonly completed_at: string | null;
          readonly failure_payload_json: string;
          readonly last_error: string | null;
        }>`
          SELECT t.payload_json, r.run_id, r.completed_at,
            item.payload_json AS failure_payload_json,
            (
              SELECT json_extract(session.payload_json, '$.lastError')
              -- Keep bindings outermost: one provider instance can hold every session.
              FROM orchestration_v2_projection_provider_session_bindings binding
              CROSS JOIN orchestration_v2_projection_provider_sessions session
                ON session.provider_session_id = binding.provider_session_id
              WHERE binding.thread_id = t.thread_id
                AND session.provider_instance_id = t.provider_instance_id
              ORDER BY session.updated_at DESC, session.provider_session_id DESC
              LIMIT 1
            ) AS last_error
          FROM orchestration_v2_projection_threads t
          -- Most threads have no failed run. Avoid sorting their history.
          INNER JOIN orchestration_v2_projection_runs r ON r.run_id = CASE WHEN EXISTS (
            SELECT 1 FROM orchestration_v2_projection_runs failed
            WHERE failed.thread_id = t.thread_id AND failed.status = 'failed'
          ) THEN (
            SELECT latest.run_id FROM orchestration_v2_projection_runs latest
            WHERE latest.thread_id = t.thread_id
              AND latest.status <> 'queued'
              AND NOT (
                latest.status = 'cancelled'
                AND json_extract(latest.payload_json, '$.startedAt') IS NULL
              )
            -- latestExecutedRun: the run that ended last (runRanAfter).
            ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
              latest.ordinal DESC, latest.run_id DESC
            LIMIT 1
          ) END AND r.status = 'failed'
          INNER JOIN orchestration_v2_projection_turn_items item ON item.turn_item_id = (
            SELECT error.turn_item_id FROM orchestration_v2_projection_turn_items error
            WHERE error.thread_id = t.thread_id AND error.run_id = r.run_id
              AND error.type = 'error' AND error.status = 'failed'
              AND error.node_id IS json_extract(r.payload_json, '$.rootNodeId')
            ORDER BY error.updated_at DESC, error.ordinal DESC, error.turn_item_id DESC
            LIMIT 1
          )
          WHERE t.deleted_at IS NULL
            AND t.archived_at IS NULL
            AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
            AND json_extract(item.payload_json, '$.failure.class') = 'usage_limit'
            AND json_extract(item.payload_json, '$.failure.resetAt') IS NOT NULL
            AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(COALESCE(r.completed_at, json_extract(t.payload_json, '$.updatedAt')))
            AND (
              (
                json_extract(t.payload_json, '$.limitRecovery.runId') IS r.run_id
                AND json_extract(t.payload_json, '$.limitRecovery.resetAt') IS json_extract(item.payload_json, '$.failure.resetAt')
                AND json_extract(t.payload_json, '$.limitRecovery.autoResume') = 1
                AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) <= julianday(${DateTime.formatIso(options.now)})
                AND (
                  json_extract(t.payload_json, '$.snoozedUntil') IS NULL
                  OR julianday(json_extract(t.payload_json, '$.snoozedUntil')) <= julianday(${DateTime.formatIso(options.now)})
                )
              )
              OR (
                (
                  json_extract(t.payload_json, '$.limitRecovery.runId') IS NOT r.run_id
                  OR json_extract(t.payload_json, '$.limitRecovery.resetAt') IS NOT json_extract(item.payload_json, '$.failure.resetAt')
                )
                AND julianday(json_extract(item.payload_json, '$.failure.resetAt')) > julianday(${DateTime.formatIso(options.now)})
                AND (${booleanInt(options.autoResume)} OR ${booleanInt(options.snooze)})
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runtime_requests request
              WHERE request.thread_id = t.thread_id AND request.status = 'pending'
            )
          ORDER BY t.thread_id
        `;
        const candidates: Array<ProjectionLimitRecoveryCandidate> = [];
        for (const row of rows) {
          const thread = yield* decodeThreadPayload(row.payload_json);
          const item = yield* decodeTurnItemPayload(row.failure_payload_json);
          const summary = threadErrorSummary(
            item.type === "error" ? item.failure : null,
            row.last_error,
          );
          if (summary.lastErrorClass !== "usage_limit") continue;
          candidates.push({
            id: thread.id,
            lineage: thread.lineage,
            creationSource: thread.creationSource,
            status: "failed",
            lastErrorClass: summary.lastErrorClass,
            usageLimitResetAt: summary.usageLimitResetAt,
            latestRunId: RunId.make(row.run_id),
            latestRunCompletedAt:
              row.completed_at === null ? null : DateTime.makeUnsafe(row.completed_at),
            updatedAt: thread.updatedAt,
            archivedAt: thread.archivedAt,
            settledOverride: thread.settledOverride,
            pendingRuntimeRequest: null,
            limitRecovery: thread.limitRecovery ?? null,
            snoozedUntil: thread.snoozedUntil ?? null,
          });
        }
        return candidates;
      },
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    const getSignedOutStops = Effect.fn("ProjectionStore.getSignedOutStops")(
      function* (options: Parameters<ProjectionStoreV2Shape["getSignedOutStops"]>[0]) {
        const now = yield* DateTime.now;
        // LIKE treats % and _ as wildcards; literal text escapes them.
        const escape = (text: string) => text.replace(/[!%_]/g, "!$&");
        const pattern =
          options.messagePrefix !== undefined
            ? `${escape(options.messagePrefix)}%`
            : `%${escape(options.messageContains)}%`;
        const rows = yield* sql<{
          readonly thread_id: string;
          readonly provider_instance_id: string;
          readonly run_id: string;
          readonly completed_at: string;
          readonly run_payload_json: string;
        }>`
          SELECT t.thread_id, r.provider_instance_id, r.run_id, r.completed_at,
            r.payload_json AS run_payload_json
          FROM orchestration_v2_projection_threads t
          CROSS JOIN orchestration_v2_projection_runs r INDEXED BY orchestration_v2_projection_runs_thread_status_idx
            ON r.thread_id = t.thread_id
          WHERE r.status = 'failed'
            AND r.completed_at IS NOT NULL
            AND julianday(r.completed_at) >= julianday(${DateTime.formatIso(options.since)})
            -- Check the failure text before ordering this thread's run history.
            AND r.run_id = CASE WHEN EXISTS (
              SELECT 1 FROM orchestration_v2_projection_turn_items error
              WHERE error.thread_id = r.thread_id AND error.run_id = r.run_id
                AND error.type = 'error' AND error.status = 'failed'
                AND json_extract(error.payload_json, '$.failure.message') LIKE ${pattern} ESCAPE '!'
            ) THEN (
              SELECT latest.run_id FROM orchestration_v2_projection_runs latest
              WHERE latest.thread_id = r.thread_id
                AND latest.status <> 'queued'
                AND NOT (
                  latest.status = 'cancelled'
                  AND json_extract(latest.payload_json, '$.startedAt') IS NULL
                )
              ORDER BY latest.completed_at IS NULL DESC, latest.completed_at DESC,
                latest.ordinal DESC, latest.run_id DESC
              LIMIT 1
            ) END
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs pending
              WHERE pending.thread_id = r.thread_id
                AND pending.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
            )
            AND t.deleted_at IS NULL
            AND t.archived_at IS NULL
            AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'
            AND (json_extract(t.payload_json, '$.snoozedUntil') IS NULL
              OR julianday(json_extract(t.payload_json, '$.snoozedUntil')) <= julianday(${DateTime.formatIso(now)}))
            AND NOT (
              json_extract(t.payload_json, '$.lineage.relationshipToParent') IS 'subagent'
              AND json_extract(t.payload_json, '$.creationSource') IS 'provider'
            )
            AND NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runtime_requests request
              WHERE request.thread_id = t.thread_id AND request.status = 'pending'
            )
          ORDER BY r.completed_at, t.thread_id
        `;
        return yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            const run = yield* decodeRunPayload(row.run_payload_json);
            return {
              threadId: ThreadId.make(row.thread_id),
              runId: RunId.make(row.run_id),
              providerInstanceId: ProviderInstanceId.make(row.provider_instance_id),
              modelSelection: run.modelSelection,
              completedAt: DateTime.makeUnsafe(row.completed_at),
            } satisfies ProjectionSignedOutStop;
          }),
        );
      },
      NodeSqliteClient.readOnly,
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    const getRecoveryThreadIds = Effect.fn("ProjectionStore.getRecoveryThreadIds")(
      function* (kind: ProjectionRecoveryKind) {
        const candidates = (() => {
          switch (kind) {
            case "subagent-activity":
              return sql`
                SELECT thread_id FROM orchestration_v2_projection_runs
                WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                UNION
                SELECT json_extract(payload_json, '$.childThreadId') AS thread_id
                FROM orchestration_v2_projection_turn_items
                WHERE type IN ('command_execution', 'dynamic_tool', 'subagent')
                  AND status IN ('pending', 'running', 'waiting')
                  AND type = 'subagent' AND json_type(payload_json, '$.childActivity') = 'object'
              `;
            case "queued-runs":
              return sql`
                SELECT thread_id FROM orchestration_v2_projection_runs
                WHERE status = 'queued'
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS active
                    WHERE active.thread_id = orchestration_v2_projection_runs.thread_id
                      AND active.status IN ('preparing', 'starting', 'running', 'waiting')
                  )
              `;
            case "steer-when-live":
              return sql`
                SELECT thread_id FROM orchestration_v2_projection_runs
                WHERE status = 'queued'
                  AND CASE WHEN json_valid(payload_json)
                    THEN json_extract(payload_json, '$.steerWhenLiveRunId') IS NOT NULL
                    ELSE 0 END
              `;
            case "delegated-completions":
              return sql`
                SELECT thread_id FROM orchestration_v2_projection_runs
                WHERE CASE WHEN json_valid(payload_json)
                  THEN json_type(payload_json, '$.delegatedCompletion.delivery') = 'object'
                  ELSE 0 END
                UNION
                SELECT thread_id FROM orchestration_v2_projection_subagents
                WHERE status IN ('completed', 'failed', 'cancelled', 'interrupted')
                  AND json_extract(payload_json, '$.origin') = 'app_owned'
                  AND (COALESCE(json_extract(payload_json, '$.completionWake'), 'settled_only') = 'settled_only'
                    OR json_extract(payload_json, '$.completionDelivery.withNextTurn') = 1)
                  AND COALESCE(json_extract(payload_json, '$.completionDelivery.state'), 'pending') NOT IN ('acknowledged', 'delivered', 'disposed')
              `;
            case "subagent-results":
              return sql`
                SELECT child.thread_id FROM orchestration_v2_projection_threads AS child
                WHERE CASE WHEN json_valid(child.payload_json) THEN
                  json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
                  AND json_extract(child.payload_json, '$.lineage.parentEnvironmentId') IS NULL
                  AND json_extract(child.payload_json, '$.lineage.parentThreadId') IS NOT NULL
                  AND json_extract(child.payload_json, '$.forkedFrom.type') = 'node'
                  AND (EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS requested
                    JOIN orchestration_v2_projection_subagents AS task
                      ON task.subagent_id = json_extract(requested.payload_json, '$.delegatedTaskId')
                    WHERE requested.thread_id = child.thread_id
                      AND requested.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                      AND task.child_thread_id = child.thread_id
                      AND json_extract(task.payload_json, '$.origin') = 'app_owned'
                      AND json_extract(task.payload_json, '$.result') IS NULL
                  ) OR EXISTS (
                    -- A follow-up whose run lost its delegatedTaskId: the
                    -- follow-up's own message still names the run.
                    SELECT 1 FROM orchestration_v2_projection_subagents AS task
                    JOIN orchestration_v2_projection_messages AS message
                      ON message.thread_id = child.thread_id
                      AND message.role = 'user'
                      AND message.created_at = task.started_at
                    JOIN orchestration_v2_projection_runs AS sent
                      ON sent.run_id = message.run_id
                    WHERE task.child_thread_id = child.thread_id
                      AND task.subagent_id IS NOT json_extract(child.payload_json, '$.forkedFrom.nodeId')
                      AND json_extract(task.payload_json, '$.origin') = 'app_owned'
                      AND json_extract(task.payload_json, '$.result') IS NULL
                      AND json_extract(message.payload_json, '$.text') = json_extract(task.payload_json, '$.prompt')
                      AND json_extract(sent.payload_json, '$.delegatedTaskId') IS NULL
                      AND sent.status IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                  ) OR (
                    -- The original task still waits for the latest unheld work.
                    (SELECT status FROM orchestration_v2_projection_runs
                     WHERE thread_id = child.thread_id
                       AND NOT (status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1)
                     ORDER BY ordinal DESC LIMIT 1
                    ) IN ('completed', 'interrupted', 'failed', 'cancelled', 'rolled_back')
                    AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_context_transfers
                    WHERE source_thread_id = child.thread_id
                      AND target_thread_id = json_extract(child.payload_json, '$.lineage.parentThreadId')
                      AND type = 'subagent_result'
                  )))
                  ELSE 0 END
              `;
            case "runtime":
              return sql`
                WITH pending_provider_threads AS MATERIALIZED (
                  SELECT provider_thread_id, thread_id, owner_node_id
                  FROM orchestration_v2_projection_provider_threads
                  WHERE status = 'active'
                    OR CASE WHEN json_valid(payload_json)
                      THEN json_array_length(payload_json, '$.pendingBackgroundTasks') > 0
                      ELSE 0 END
                )
                SELECT thread_id FROM orchestration_v2_projection_runs
                WHERE status IN ('preparing', 'starting', 'running', 'waiting')
                UNION
                -- A held queue already went through recovery; rereading it on
                -- every boot costs a projection read per held thread.
                SELECT thread_id FROM orchestration_v2_projection_runs
                WHERE status = 'queued'
                  AND CASE WHEN json_valid(payload_json)
                    THEN json_extract(payload_json, '$.queueHeld') IS NOT 1
                    ELSE 1 END
                UNION
                SELECT thread_id FROM orchestration_v2_projection_runtime_requests
                WHERE status = 'pending'
                UNION
                -- One thread per live session, the first recovery visits. It stops
                -- the session there, so the other threads of a shared session (one
                -- Codex app-server holds hundreds) have nothing left to recover.
                SELECT thread_id FROM (
                  SELECT bindings.thread_id, ROW_NUMBER() OVER (
                    PARTITION BY sessions.provider_session_id
                    ORDER BY bound.updated_at ASC, bound.thread_id ASC
                  ) AS visit_order
                  FROM orchestration_v2_projection_provider_sessions AS sessions
                  CROSS JOIN orchestration_v2_projection_provider_session_bindings AS bindings
                    ON bindings.provider_session_id = sessions.provider_session_id
                  JOIN orchestration_v2_projection_threads AS bound
                    ON bound.thread_id = bindings.thread_id AND bound.deleted_at IS NULL
                  WHERE sessions.status NOT IN ('stopped', 'error')
                )
                WHERE visit_order = 1
                UNION
                -- A detach drops the binding but keeps the session's status.
                SELECT sessions.thread_id
                FROM orchestration_v2_projection_provider_sessions AS sessions
                WHERE sessions.status NOT IN ('stopped', 'error')
                  AND sessions.thread_id IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS bindings
                    WHERE bindings.provider_session_id = sessions.provider_session_id
                  )
                UNION
                SELECT thread_id FROM pending_provider_threads
                UNION
                SELECT nodes.thread_id FROM pending_provider_threads
                CROSS JOIN orchestration_v2_projection_nodes AS nodes
                  ON nodes.node_id = pending_provider_threads.owner_node_id
                UNION
                SELECT subagents.thread_id FROM pending_provider_threads
                CROSS JOIN orchestration_v2_projection_subagents AS subagents
                  ON subagents.provider_thread_id = pending_provider_threads.provider_thread_id
                -- A delegated task's provider thread belongs to its child thread.
                WHERE subagents.origin = 'provider_native'
                UNION
                SELECT subagents.child_thread_id FROM orchestration_v2_projection_subagents AS subagents
                WHERE subagents.child_thread_id IS NOT NULL
                  AND EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_nodes AS node
                    WHERE node.thread_id = subagents.child_thread_id
                      -- Matches nodes_live_idx; +run_id keeps thread_run_idx from scanning settled nodes.
                      AND node.status IN ('pending', 'starting', 'running', 'waiting')
                      AND +node.run_id IS NULL
                      AND node.kind = 'root_turn'
                  )
                UNION
                -- No native subagent outlives the provider process that ran it.
                SELECT thread_id FROM orchestration_v2_projection_subagents
                WHERE origin = 'provider_native'
                  AND status IN ('pending', 'running', 'waiting')
                UNION
                SELECT item.thread_id FROM orchestration_v2_projection_turn_items AS item
                WHERE NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs AS run
                    WHERE run.run_id = item.run_id AND run.status = 'rolled_back'
                  )
                  AND type IN ('command_execution', 'dynamic_tool', 'subagent')
                  AND status IN ('pending', 'running', 'waiting')
                UNION
                SELECT thread_id FROM orchestration_v2_effect_outbox
                WHERE status IN ('pending', 'running')
              `;
          }
        })();
        const rows = yield* sql<{ readonly thread_id: string }>`
          SELECT thread_id FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL
            AND thread_id IN (${candidates})
            ${kind === "queued-runs" ? sql`AND archived_at IS NULL` : sql``}
          ORDER BY updated_at ASC, thread_id ASC
        `;
        return rows.map((row) => ThreadId.make(row.thread_id));
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    // Decode every canonical row once. Full thread reads repeat shared sessions,
    // provider threads, transfers, and inherited fork histories for each owner.
    const getUnreadableThreadIds = Effect.fn("ProjectionStore.getUnreadableThreadIds")(
      function* () {
        const actualThreadIds = new Set<ThreadId>();
        const unreadable = new Set<ThreadId>();
        const forkChildren = new Map<ThreadId, Array<ThreadId>>();
        const tables: ReadonlyArray<{
          readonly name: string;
          readonly id: string;
          readonly decode: (payload: string, entityId: string) => Effect.Effect<unknown, unknown>;
        }> = [
          {
            name: "threads",
            id: "thread_id",
            decode: (payload: string, entityId: string) =>
              decodeThreadPayload(payload).pipe(
                Effect.tap((thread) =>
                  Effect.sync(() => {
                    if (thread.forkedFrom?.type !== "run") return;
                    const sourceId = thread.forkedFrom.threadId;
                    const children = forkChildren.get(sourceId) ?? [];
                    children.push(ThreadId.make(entityId));
                    forkChildren.set(sourceId, children);
                  }),
                ),
              ),
          },
          { name: "runs", id: "run_id", decode: (payload) => decodeRunPayload(payload) },
          {
            name: "run_attempts",
            id: "attempt_id",
            decode: (payload) => decodeRunAttemptPayload(payload),
          },
          { name: "nodes", id: "node_id", decode: (payload) => decodeNodePayload(payload) },
          {
            name: "subagents",
            id: "subagent_id",
            decode: (payload) => decodeSubagentPayload(payload),
          },
          {
            name: "provider_sessions",
            id: "provider_session_id",
            decode: (payload) => decodeProviderSessionPayload(payload),
          },
          {
            name: "provider_threads",
            id: "provider_thread_id",
            decode: (payload) => decodeProviderThreadPayload(payload),
          },
          {
            name: "provider_turns",
            id: "provider_turn_id",
            decode: (payload) => decodeProviderTurnPayload(payload),
          },
          {
            name: "runtime_requests",
            id: "runtime_request_id",
            decode: (payload) => decodeRuntimeRequestPayload(payload),
          },
          {
            name: "messages",
            id: "message_id",
            decode: (payload) => decodeMessagePayload(payload),
          },
          { name: "plans", id: "plan_id", decode: decodePlanPayload },
          {
            name: "turn_items",
            id: "turn_item_id",
            decode: (payload) => decodeTurnItemPayload(payload),
          },
          {
            name: "checkpoint_scopes",
            id: "scope_id",
            decode: (payload) => decodeCheckpointScopePayload(payload),
          },
          {
            name: "checkpoints",
            id: "checkpoint_id",
            decode: (payload) => decodeCheckpointPayload(payload),
          },
          {
            name: "context_handoffs",
            id: "context_handoff_id",
            decode: (payload) => decodeContextHandoffPayload(payload),
          },
          {
            name: "context_transfers",
            id: "context_transfer_id",
            decode: (payload) => decodeContextTransferPayload(payload),
          },
        ];
        const pageSize = 500;
        for (const table of tables) {
          let afterRowId = 0;
          while (true) {
            const rows = yield* sql<{
              readonly row_id: number;
              readonly entity_id: string;
              readonly thread_id: string | null;
              readonly target_thread_id: string | null;
              readonly payload_json: string;
            }>`
              SELECT rowid AS row_id, ${sql(table.id)} AS entity_id,
                ${sql(table.name === "context_transfers" ? "source_thread_id" : "thread_id")} AS thread_id,
                ${table.name === "context_transfers" ? sql`target_thread_id` : sql`NULL`} AS target_thread_id,
                payload_json
              FROM ${sql(`orchestration_v2_projection_${table.name}`)}
              WHERE rowid > ${afterRowId}
              ORDER BY rowid ASC LIMIT ${pageSize}
            `;
            for (const row of rows) {
              if (table.name === "threads") actualThreadIds.add(ThreadId.make(row.entity_id));
              const decoded = yield* Effect.exit(
                Effect.suspend(() => table.decode(row.payload_json, row.entity_id)),
              );
              if (decoded._tag === "Success") continue;
              if (table.name === "provider_sessions") {
                const bindings = yield* sql<{ readonly thread_id: string }>`
                  SELECT thread_id FROM orchestration_v2_projection_provider_session_bindings
                  WHERE provider_session_id = ${row.entity_id}
                `;
                for (const binding of bindings) unreadable.add(ThreadId.make(binding.thread_id));
              } else {
                if (row.thread_id !== null) unreadable.add(ThreadId.make(row.thread_id));
                if (row.target_thread_id !== null)
                  unreadable.add(ThreadId.make(row.target_thread_id));
              }
              if (table.name === "provider_threads") {
                const owners = yield* sql<{ readonly thread_id: string }>`
                  SELECT thread_id FROM orchestration_v2_projection_nodes
                  WHERE node_id = (
                    SELECT owner_node_id FROM orchestration_v2_projection_provider_threads
                    WHERE provider_thread_id = ${row.entity_id}
                  )
                  UNION
                  SELECT thread_id FROM orchestration_v2_projection_subagents
                  WHERE provider_thread_id = ${row.entity_id}
                `;
                for (const owner of owners) unreadable.add(ThreadId.make(owner.thread_id));
              }
            }
            if (rows.length < pageSize) break;
            afterRowId = rows[rows.length - 1]!.row_id;
            yield* Effect.yieldNow;
          }
        }
        // A full fork projection also reads its source. Propagate decode failures
        // and missing sources through the same ancestry without loading history.
        const pending = [
          ...unreadable,
          ...[...forkChildren.keys()].filter((sourceId) => !actualThreadIds.has(sourceId)),
        ];
        for (let index = 0; index < pending.length; index += 1) {
          for (const childId of forkChildren.get(pending[index]!) ?? []) {
            if (unreadable.has(childId)) continue;
            unreadable.add(childId);
            pending.push(childId);
          }
        }
        return [...unreadable].filter((threadId) => actualThreadIds.has(threadId)).sort();
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    // Read a consistent snapshot first, then release the shared connection before
    // decoding execution history. Handoffs and transfers are limited to those
    // that can affect this run's provider thread or native fork.
    const getTurnStartContext: ProjectionStoreV2Shape["getTurnStartContext"] = (threadId, runId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const thread = yield* getThread(threadId);
            const runs = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} ORDER BY ordinal ASC
            `;
            const attempts = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId} ORDER BY run_id ASC, attempt_ordinal ASC
            `;
            const nodes = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_nodes
              WHERE thread_id = ${threadId} AND node_id IN (SELECT json_extract(payload_json, '$.rootNodeId') FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND run_id = ${runId}) ORDER BY node_id ASC
            `;
            const subagents = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_subagents
              WHERE thread_id = ${threadId} AND (status NOT IN ('interrupted','failed','cancelled')
                OR json_extract(payload_json, '$.completionDelivery.state') = 'claimed'
                OR json_extract(payload_json, '$.completionDelivery.withNextTurn') = 1)
              ORDER BY subagent_id ASC
            `;
            const providerThreads = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_provider_threads
              WHERE thread_id = ${threadId} ORDER BY COALESCE(first_run_ordinal, 0), provider_thread_id ASC
            `;
            const providerTurns = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_provider_turns
              WHERE thread_id = ${threadId} ORDER BY provider_thread_id ASC, ordinal ASC
            `;
            const checkpointScopes = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
              WHERE thread_id = ${threadId} AND scope_id IN (SELECT checkpoint_scope_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId} AND node_id IN (SELECT json_extract(payload_json, '$.rootNodeId') FROM orchestration_v2_projection_runs WHERE thread_id = ${threadId} AND run_id = ${runId})) ORDER BY ordinal_within_parent ASC, scope_id ASC
            `;
            const contextHandoffs = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_context_handoffs
              WHERE thread_id = ${threadId} AND (
                target_run_id = ${runId} OR to_provider_thread_id IN (
                  SELECT provider_thread_id FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId} AND run_id = ${runId}
                )
              ) ORDER BY rowid ASC
            `;
            const contextTransfers = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_context_transfers
              WHERE target_thread_id = ${threadId} AND target_run_id = ${runId}
                AND type = 'fork' AND status = 'pending'
              ORDER BY rowid ASC
            `;
            const turnItems = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_turn_items
                INDEXED BY orchestration_v2_projection_turn_items_run_ordinal_idx
              WHERE thread_id = ${threadId} AND run_id = ${runId} ORDER BY ordinal ASC, turn_item_id ASC
            `;
            const providerSessions = yield* sql<PayloadRow>`
              SELECT sessions.payload_json FROM orchestration_v2_projection_provider_sessions AS sessions
              INNER JOIN orchestration_v2_projection_provider_session_bindings AS bindings
                ON bindings.provider_session_id = sessions.provider_session_id
              WHERE bindings.thread_id = ${threadId}
              ORDER BY sessions.updated_at ASC, sessions.provider_session_id ASC
            `;
            // Compact retries need their original markers; emptiness is an existence check.
            const messages = yield* sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId} AND (
                message_id IN (SELECT json_extract(payload_json, '$.userMessageId') FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId} AND run_id = ${runId})
                OR (role = 'user' AND lower(trim(json_extract(payload_json, '$.text'), ${javascriptTrimWhitespace})) = '/compact')
              ) ORDER BY created_at ASC, message_id ASC
            `;
            const conversation = yield* sql<{ present: number }>`
              SELECT EXISTS(
                SELECT 1 FROM orchestration_v2_projection_messages AS m
                WHERE m.thread_id = ${threadId} AND m.role = 'user'
                    AND (lower(trim(json_extract(m.payload_json, '$.text'), ${javascriptTrimWhitespace})) <> '/compact'
                      OR json_array_length(m.payload_json, '$.attachments') > 0)
                    AND (m.run_id = ${runId} OR NOT EXISTS (
                      SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.run_id = m.run_id
                        AND (r.status IN ('queued', 'rolled_back') OR
                          (r.status = 'cancelled' AND json_extract(r.payload_json, '$.startedAt') IS NULL))
                    ))
              ) AS present
            `;
            return {
              hasConversation: conversation[0]?.present === 1,
              thread,
              runs,
              attempts,
              nodes,
              subagents,
              providerSessions,
              providerThreads,
              providerTurns,
              messages,
              checkpointScopes,
              contextHandoffs,
              contextTransfers,
              turnItems,
            };
          }),
        )
        .pipe(
          Effect.flatMap((rows) =>
            Effect.gen(function* () {
              return {
                ...rows,
                runs: yield* decodeRows(decodeRunPayload, threadId)(rows.runs),
                attempts: yield* decodeRows(decodeRunAttemptPayload, threadId)(rows.attempts),
                nodes: yield* decodeRows(decodeNodePayload, threadId)(rows.nodes),
                subagents: yield* decodeRows(decodeSubagentPayload, threadId)(rows.subagents),
                providerThreads: yield* decodeRows(
                  decodeProviderThreadPayload,
                  threadId,
                )(rows.providerThreads),
                providerTurns: yield* decodeRows(
                  decodeProviderTurnPayload,
                  threadId,
                )(rows.providerTurns),
                checkpointScopes: yield* decodeRows(
                  decodeCheckpointScopePayload,
                  threadId,
                )(rows.checkpointScopes),
                contextHandoffs: yield* decodeRows(
                  decodeContextHandoffPayload,
                  threadId,
                )(rows.contextHandoffs),
                contextTransfers: yield* decodeRows(
                  decodeContextTransferPayload,
                  threadId,
                )(rows.contextTransfers),
                turnItems: yield* decodeRows(decodeTurnItemPayload, threadId)(rows.turnItems),
                providerSessions: yield* decodeRows(
                  decodeProviderSessionPayload,
                  threadId,
                )(rows.providerSessions),
                messages: yield* decodeRows(decodeMessagePayload, threadId)(rows.messages),
              };
            }),
          ),
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const getTurnStartHistory: ProjectionStoreV2Shape["getTurnStartHistory"] = (threadId, runIds) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
            AND type IN ('user_message','assistant_message','command_execution','error',
              'run_interrupt_result','file_change','proposed_plan')
            AND ${runIds === undefined ? sql`1` : sql`run_id IN ${sql.in(runIds)}`}
          ORDER BY ordinal ASC, turn_item_id ASC
        `;
        return yield* decodeRows(decodeTurnItemPayload, threadId)(rows);
      }).pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));

    const getThreadProjection: ProjectionStoreV2Shape["getThreadProjection"] = (threadId) =>
      readProjection(threadId, new Set());

    const getRuntimeRecoveryProjection: ProjectionStoreV2Shape["getRuntimeRecoveryProjection"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const threadRows = yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId}
          `;
        if (threadRows[0] === undefined) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }
        const [
          thread,
          runRows,
          attemptRows,
          nodeRows,
          subagentRows,
          providerSessionRows,
          providerThreadRows,
          providerTurnRows,
          runtimeRequestRows,
          messageRows,
          turnItemRows,
        ] = yield* Effect.all([
          decodeThreadPayload(threadRows[0].payload_json),
          sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_runs AS run
              WHERE run.thread_id = ${threadId}
                AND (
                  run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  OR run.run_id = (
                    SELECT latest.run_id FROM orchestration_v2_projection_runs AS latest
                    WHERE latest.thread_id = ${threadId}
                    ORDER BY latest.ordinal DESC LIMIT 1
                  )
                  -- Retain the latest run for each provider thread with lost
                  -- background work, including owners used before a handoff.
                  OR run.run_id IN (
                    SELECT (
                      SELECT ended.run_id FROM orchestration_v2_projection_runs AS ended
                      WHERE ended.thread_id = ${threadId}
                        AND ended.provider_thread_id = roster.provider_thread_id
                        AND ended.status NOT IN ('queued', 'rolled_back')
                      ORDER BY ended.completed_at IS NULL DESC, ended.completed_at DESC,
                        ended.ordinal DESC
                      LIMIT 1
                    )
                    FROM orchestration_v2_projection_provider_threads AS roster
                    WHERE roster.thread_id = ${threadId}
                      AND CASE WHEN json_valid(roster.payload_json)
                        THEN json_array_length(roster.payload_json, '$.pendingBackgroundTasks') > 0
                        ELSE 0 END
                  )
                  OR run.run_id IN (
                    SELECT item.run_id FROM orchestration_v2_projection_turn_items AS item
                      -- IS NOT NULL otherwise makes SQLite prefer the broad
                      -- (thread_id, run_id) index over the pending-work slice.
                      INDEXED BY orchestration_v2_projection_turn_items_recovery_idx
                    WHERE item.thread_id = ${threadId}
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                      AND item.run_id IS NOT NULL
                  )
                )
              ORDER BY run.ordinal ASC
            `,
          sql<PayloadRow>`
              SELECT attempt.payload_json
              FROM orchestration_v2_projection_run_attempts AS attempt
              WHERE attempt.thread_id = ${threadId}
                AND attempt.run_id IN (
                  SELECT run_id FROM orchestration_v2_projection_runs
                  WHERE thread_id = ${threadId}
                    AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                )
              ORDER BY attempt.run_id ASC, attempt.attempt_ordinal ASC
            `,
          sql<PayloadRow>`
              SELECT node.payload_json FROM orchestration_v2_projection_nodes AS node
              WHERE node.thread_id = ${threadId}
                AND node.status IN ('pending', 'starting', 'running', 'waiting')
                AND (
                  (node.run_id IS NULL AND node.kind = 'root_turn')
                  OR node.run_id IN (
                    SELECT run_id FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId}
                      AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                  OR node.node_id IN (
                    SELECT item.node_id FROM orchestration_v2_projection_turn_items AS item
                    WHERE item.thread_id = ${threadId}
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                  )
                  OR node.node_id IN (
                    SELECT json_extract(item.payload_json, '$.subagentId')
                    FROM orchestration_v2_projection_turn_items AS item
                    WHERE item.thread_id = ${threadId}
                      -- The recovery index's own terms, so the planner reads
                      -- only live items instead of every item in the thread.
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                      AND item.type = 'subagent'
                  )
                  OR node.node_id IN (
                    SELECT subagent_id FROM orchestration_v2_projection_subagents
                    WHERE thread_id = ${threadId} AND origin = 'provider_native'
                      AND status IN ('pending', 'running', 'waiting')
                  )
                )
              ORDER BY COALESCE(node.started_at, ''), node.node_id ASC
            `,
          sql<PayloadRow>`
              SELECT subagent.payload_json FROM orchestration_v2_projection_subagents AS subagent
              WHERE subagent.thread_id = ${threadId}
                AND subagent.status IN ('pending', 'starting', 'running', 'waiting')
                AND (
                  subagent.origin = 'provider_native'
                  OR subagent.run_id IN (
                    SELECT run_id FROM orchestration_v2_projection_runs
                    WHERE thread_id = ${threadId}
                      AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                  OR subagent.subagent_id IN (
                    SELECT json_extract(item.payload_json, '$.subagentId')
                    FROM orchestration_v2_projection_turn_items AS item
                    WHERE item.thread_id = ${threadId}
                      -- The recovery index's own terms, so the planner reads
                      -- only live items instead of every item in the thread.
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                      AND item.type = 'subagent'
                  )
                )
              ORDER BY COALESCE(subagent.started_at, ''), subagent.subagent_id ASC
            `,
          sql<PayloadRow>`
              SELECT session.payload_json
              FROM orchestration_v2_projection_provider_sessions AS session
              WHERE (
                  session.provider_session_id IN (
                    SELECT binding.provider_session_id
                    FROM orchestration_v2_projection_provider_session_bindings AS binding
                    WHERE binding.thread_id = ${threadId}
                  )
                  AND (
                    session.status NOT IN ('stopped', 'error')
                    OR session.provider_session_id IN (
                      SELECT provider_thread.provider_session_id
                      FROM orchestration_v2_projection_provider_threads AS provider_thread
                      WHERE provider_thread.provider_thread_id IN (
                        SELECT run.provider_thread_id
                        FROM orchestration_v2_projection_runs AS run
                        WHERE run.thread_id = ${threadId}
                          AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                      )
                    )
                  )
                )
                -- This thread detached it, which keeps its status. Its process
                -- did not outlive the server either, so recovery stops it.
                OR (
                  session.thread_id = ${threadId}
                  AND session.status NOT IN ('stopped', 'error')
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS binding
                    WHERE binding.provider_session_id = session.provider_session_id
                  )
                )
              ORDER BY session.updated_at ASC, session.provider_session_id ASC
            `,
          sql<PayloadRow>`
              SELECT provider_thread.payload_json
              FROM orchestration_v2_projection_provider_threads AS provider_thread
              WHERE provider_thread.provider_thread_id IN (
                  SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
                  WHERE thread_id = ${threadId}
                  UNION
                  -- Start with non-null owners; a thread can have a large settled node history.
                  SELECT owned.provider_thread_id
                  FROM orchestration_v2_projection_provider_threads AS owned
                    INDEXED BY orchestration_v2_projection_provider_threads_owner_idx
                  CROSS JOIN orchestration_v2_projection_nodes AS owner
                    ON owner.node_id = owned.owner_node_id
                  WHERE owned.owner_node_id IS NOT NULL AND owner.thread_id = ${threadId}
                  UNION
                  SELECT provider_thread_id FROM orchestration_v2_projection_subagents
                  WHERE thread_id = ${threadId} AND provider_thread_id IS NOT NULL
                    AND origin = 'provider_native'
                )
                AND (
                  provider_thread.status = 'active'
                  OR CASE WHEN json_valid(provider_thread.payload_json)
                    THEN json_array_length(provider_thread.payload_json, '$.pendingBackgroundTasks') > 0
                    ELSE 0 END
                  OR provider_thread.provider_thread_id IN (
                    SELECT run.provider_thread_id FROM orchestration_v2_projection_runs AS run
                    WHERE run.thread_id = ${threadId}
                      AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  )
                  OR provider_thread.provider_thread_id IN (
                    -- Seek the same indexed pending-item cohorts as the pending_items query below
                    -- instead of scanning every historical turn item in the thread.
                    SELECT item.provider_thread_id
                    FROM orchestration_v2_projection_turn_items AS item
                      INDEXED BY orchestration_v2_projection_turn_items_recovery_idx
                    WHERE item.thread_id = ${threadId}
                      AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                      AND item.status IN ('pending', 'running', 'waiting')
                    UNION
                    SELECT item.provider_thread_id
                    FROM orchestration_v2_projection_runs AS run
                      INDEXED BY orchestration_v2_projection_runs_recovery_idx
                    CROSS JOIN orchestration_v2_projection_turn_items AS item
                      INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                      ON item.thread_id = run.thread_id AND item.run_id = run.run_id
                    WHERE run.thread_id = ${threadId}
                      AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                      AND item.status IN ('pending', 'running', 'waiting')
                    UNION
                    SELECT item.provider_thread_id
                    FROM orchestration_v2_projection_nodes AS node
                      INDEXED BY orchestration_v2_projection_nodes_live_idx
                    CROSS JOIN orchestration_v2_projection_turn_items AS item
                      INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
                      ON item.node_id = node.node_id
                    WHERE node.thread_id = ${threadId} AND node.run_id IS NULL
                      AND node.kind = 'root_turn'
                      AND node.status IN ('pending', 'starting', 'running', 'waiting')
                      AND node.status <> 'starting'
                      AND item.thread_id = node.thread_id AND item.run_id IS NULL
                      AND item.status IN ('pending', 'running', 'waiting')
                  )
                )
              ORDER BY COALESCE(provider_thread.first_run_ordinal, 0), provider_thread.provider_thread_id ASC
            `,
          sql<PayloadRow>`
              SELECT provider_turn.payload_json
              FROM orchestration_v2_projection_provider_turns AS provider_turn
              WHERE provider_turn.thread_id = ${threadId}
                AND provider_turn.status IN ('pending', 'starting', 'running', 'waiting')
                AND (
                  provider_turn.run_attempt_id IN (
                    SELECT attempt_id FROM orchestration_v2_projection_run_attempts
                    WHERE thread_id = ${threadId}
                      AND run_id IN (
                        SELECT run_id FROM orchestration_v2_projection_runs
                        WHERE thread_id = ${threadId}
                          AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                      )
                  )
                  OR (
                    provider_turn.run_attempt_id IS NULL
                    AND provider_turn.node_id IN (
                      SELECT node_id FROM orchestration_v2_projection_nodes
                      WHERE thread_id = ${threadId}
                        AND run_id IS NULL
                        AND kind = 'root_turn'
                        AND status IN ('pending', 'running', 'waiting')
                    )
                  )
                )
              ORDER BY provider_turn.provider_thread_id ASC, provider_turn.ordinal ASC
            `,
          sql<PayloadRow>`
              SELECT payload_json FROM orchestration_v2_projection_runtime_requests
              WHERE thread_id = ${threadId} AND status = 'pending'
              ORDER BY created_at ASC, runtime_request_id ASC
            `,
          // CROSS JOIN keeps empty run cohorts out of message history; the run index bounds each lookup.
          sql<PayloadRow>`
              SELECT message.payload_json FROM orchestration_v2_projection_runs AS run
              CROSS JOIN orchestration_v2_projection_messages AS message
                INDEXED BY orchestration_v2_projection_messages_run_idx ON message.run_id = run.run_id
              WHERE run.thread_id = ${threadId}
                AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                AND message.thread_id = ${threadId} AND message.streaming = 1
              ORDER BY message.created_at ASC, message.message_id ASC
            `,
          sql<PayloadRow>`
              -- Seek each pending cohort independently and deduplicate row IDs
              -- before fetching the payloads.
              WITH pending_items AS (
                SELECT rowid AS item_rowid
                FROM orchestration_v2_projection_turn_items
                  INDEXED BY orchestration_v2_projection_turn_items_recovery_idx
                WHERE thread_id = ${threadId}
                  AND type IN ('command_execution', 'dynamic_tool', 'subagent')
                  AND status IN ('pending', 'running', 'waiting')
                UNION
                SELECT item.rowid
                FROM orchestration_v2_projection_runs AS run
                  INDEXED BY orchestration_v2_projection_runs_recovery_idx
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                  ON item.thread_id = run.thread_id AND item.run_id = run.run_id
                WHERE run.thread_id = ${threadId}
                  AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                  AND item.status IN ('pending', 'running', 'waiting')
                UNION
                SELECT item.rowid
                FROM orchestration_v2_projection_nodes AS node
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  INDEXED BY orchestration_v2_projection_turn_items_node_ordinal_idx
                  ON item.node_id = node.node_id
                WHERE node.thread_id = ${threadId} AND node.run_id IS NULL
                  AND node.kind = 'root_turn'
                  AND node.status IN ('pending', 'running', 'waiting')
                  AND item.thread_id = node.thread_id AND item.run_id IS NULL
                  AND item.status IN ('pending', 'running', 'waiting')
              )
              SELECT item.payload_json
              FROM pending_items
              CROSS JOIN orchestration_v2_projection_turn_items AS item
                ON item.rowid = pending_items.item_rowid
              ORDER BY item.ordinal ASC, item.turn_item_id ASC
            `,
        ]);
        const [
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          turnItems,
        ] = yield* Effect.all([
          decodeRows(decodeRunPayload, threadId)(runRows),
          decodeRows(decodeRunAttemptPayload, threadId)(attemptRows),
          decodeRows(decodeNodePayload, threadId)(nodeRows),
          decodeRows(decodeSubagentPayload, threadId)(subagentRows),
          decodeRows(decodeProviderSessionPayload, threadId)(providerSessionRows),
          decodeRows(decodeProviderThreadPayload, threadId)(providerThreadRows),
          decodeRows(decodeProviderTurnPayload, threadId)(providerTurnRows),
          decodeRows(decodeRuntimeRequestPayload, threadId)(runtimeRequestRows),
          decodeRows(decodeMessagePayload, threadId)(messageRows),
          decodeRows(decodeTurnItemPayload, threadId)(turnItemRows),
        ]);
        return {
          thread,
          runs,
          attempts,
          nodes,
          subagents,
          providerSessions,
          providerThreads,
          providerTurns,
          runtimeRequests,
          messages,
          turnItems,
        } satisfies ProjectionRuntimeRecoveryState;
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const getThread: ProjectionStoreV2Shape["getThread"] = (threadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
        `;
        if (rows[0] === undefined) {
          return yield* new ProjectionStoreThreadNotFoundError({ threadId });
        }
        return yield* decodeThreadPayload(rows[0].payload_json);
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const requireThread = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} LIMIT 1
      `;
        if (rows.length === 0) return yield* new ProjectionStoreThreadNotFoundError({ threadId });
      });
    const controlReadError = (threadId: ThreadId) => (cause: unknown) =>
      isProjectionStoreThreadNotFoundError(cause)
        ? cause
        : new ProjectionStoreReadError({ threadId, cause });

    const getPendingNativeUserInputs: ProjectionStoreV2Shape["getPendingNativeUserInputs"] = (
      threadId,
      providerTurnId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId} AND provider_turn_id = ${providerTurnId}
            AND kind = 'user_input' AND status = 'pending'
        `;
            const runtimeRequests = (yield* decodeRows(
              decodeRuntimeRequestPayload,
              threadId,
            )(rows)).filter((request) => request.responseCapability.type !== "message");
            if (runtimeRequests.length === 0) return { runtimeRequests, nodes: [], turnItems: [] };
            const nodeRows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND ${sql.in(
            "node_id",
            runtimeRequests.map((request) => request.nodeId),
          )}
        `;
            const itemRows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND provider_turn_id = ${providerTurnId}
            AND type = 'user_input_request'
        `;
            const requestIds = new Set(runtimeRequests.map((request) => request.id));
            return {
              runtimeRequests,
              nodes: yield* decodeRows(decodeNodePayload, threadId)(nodeRows),
              turnItems: (yield* decodeRows(decodeTurnItemPayload, threadId)(itemRows)).filter(
                (item) => item.type === "user_input_request" && requestIds.has(item.requestId),
              ),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getPlan: ProjectionStoreV2Shape["getPlan"] = (threadId, planId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_plans
          WHERE thread_id = ${threadId} AND plan_id = ${planId}`;
            return rows[0] === undefined
              ? undefined
              : yield* decodePlanPayload(rows[0].payload_json);
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const hasUnpairedRunInterruptRequest: ProjectionStoreV2Shape["hasUnpairedRunInterruptRequest"] =
      (threadId, requestId, resultId) =>
        Effect.gen(function* () {
          const rows = yield* sql<{ pending: number }>`
        SELECT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND turn_item_id = ${requestId}
        ) AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND turn_item_id = ${resultId}
        ) AS pending
      `;
          return rows[0]?.pending === 1;
        }).pipe(Effect.mapError(controlReadError(threadId)));

    const isNodeStored: ProjectionStoreV2Shape["isNodeStored"] = (node) =>
      Effect.gen(function* () {
        const payloadJson = yield* encodeNodePayload(node);
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_nodes WHERE node_id = ${node.id}
        `;
        return rows[0]?.payload_json === payloadJson;
      }).pipe(Effect.mapError(controlReadError(node.threadId)));

    const getRuntimeRequest: ProjectionStoreV2Shape["getRuntimeRequest"] = (threadId, requestId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runtime_requests
          WHERE thread_id = ${threadId} AND runtime_request_id = ${requestId}
        `;
            return rows[0] === undefined
              ? undefined
              : yield* decodeRuntimeRequestPayload(rows[0].payload_json);
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getPendingChildQuestions = Effect.fn("ProjectionStore.getPendingChildQuestions")(
      function* (
        limit: number,
        before?: { readonly createdAt: DateTime.Utc; readonly requestId: RuntimeRequestId },
      ) {
        const rows = yield* sql<{
          readonly thread_id: string;
          readonly run_id: string | null;
          readonly payload_json: string;
        }>`
          SELECT request.thread_id, node.run_id, request.payload_json
          FROM orchestration_v2_projection_runtime_requests AS request
          INNER JOIN orchestration_v2_projection_threads AS thread
            ON thread.thread_id = request.thread_id
          LEFT JOIN orchestration_v2_projection_nodes AS node ON node.node_id = request.node_id
          WHERE request.status = 'pending' AND request.kind = 'user_input'
            AND thread.deleted_at IS NULL
            AND json_extract(thread.payload_json, '$.lineage.relationshipToParent') = 'subagent'
            AND json_extract(thread.payload_json, '$.lineage.parentThreadId') IS NOT NULL
            AND json_extract(thread.payload_json, '$.lineage.parentEnvironmentId') IS NULL
            ${
              before === undefined
                ? sql``
                : sql`AND (request.created_at < ${DateTime.formatIso(before.createdAt)}
              OR (request.created_at = ${DateTime.formatIso(before.createdAt)} AND request.runtime_request_id < ${before.requestId}))`
            }
          ORDER BY request.created_at DESC, request.runtime_request_id DESC
          LIMIT ${limit}
        `;
        return yield* Effect.forEach(rows, (row) =>
          decodeRuntimeRequestPayload(row.payload_json).pipe(
            Effect.map((request): ProjectionPendingChildQuestion => ({
              threadId: ThreadId.make(row.thread_id),
              runId: row.run_id === null ? null : RunId.make(row.run_id),
              request,
            })),
          ),
        );
      },
      Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
    );

    const getProviderControlContext: ProjectionStoreV2Shape["getProviderControlContext"] = (
      threadId,
      target,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            // Match the full projection's ownership scope, but fetch only the target
            // records. Transcript items and fork ancestors are never read here.
            const [threadRows, turnRows, attemptRows, messageRows] = yield* Effect.all([
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${target.providerThreadId} AND (
              thread_id = ${threadId}
              OR owner_node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId})
              OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId})
            )`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns
            WHERE thread_id = ${threadId} AND provider_turn_id = ${target.providerTurnId}`,
              target.attemptId === undefined
                ? Effect.succeed([] as ReadonlyArray<PayloadRow>)
                : sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_run_attempts
              WHERE thread_id = ${threadId} AND attempt_id = ${target.attemptId}`,
              target.messageId === undefined
                ? Effect.succeed([] as ReadonlyArray<PayloadRow>)
                : sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_messages
              WHERE thread_id = ${threadId} AND message_id = ${target.messageId}`,
            ]);
            const providerThread =
              threadRows[0] === undefined
                ? undefined
                : yield* decodeProviderThreadPayload(threadRows[0].payload_json);
            const providerTurn =
              turnRows[0] === undefined
                ? undefined
                : yield* decodeProviderTurnPayload(turnRows[0].payload_json);
            const attempt =
              attemptRows[0] === undefined
                ? undefined
                : yield* decodeRunAttemptPayload(attemptRows[0].payload_json);
            const message =
              messageRows[0] === undefined
                ? undefined
                : yield* decodeMessagePayload(messageRows[0].payload_json);
            let run: OrchestrationV2Run | undefined;
            if (target.messageId !== undefined && providerTurn !== undefined) {
              const rows =
                yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs
            WHERE thread_id = ${threadId} AND json_extract(payload_json, '$.activeAttemptId') IS ${providerTurn.runAttemptId}
            ORDER BY ordinal ASC LIMIT 1`;
              if (rows[0] !== undefined) run = yield* decodeRunPayload(rows[0].payload_json);
            }
            return { providerThread, providerTurn, attempt, message, run };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getRunningTurnContext: ProjectionStoreV2Shape["getRunningTurnContext"] = (threadId) =>
      Effect.flatMap(Effect.serviceOption(sql.transactionService), (outer) =>
        sql.withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_runs INDEXED BY orchestration_v2_projection_runs_thread_status_idx
          WHERE thread_id = ${threadId} AND status = 'running' ORDER BY ordinal ASC LIMIT 1`;
            const run =
              rows[0] === undefined ? undefined : yield* decodeRunPayload(rows[0].payload_json);
            if (run === undefined)
              return { run, providerThread: undefined, providerTurn: undefined };
            const threadRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads WHERE provider_thread_id = ${run.providerThreadId}`;
            const turnIds =
              run.activeAttemptId === null
                ? []
                : yield* dispatchHistory.providerTurnIds(
                    threadId,
                    [run.activeAttemptId],
                    Option.isNone(outer) ? yield* dispatchHistory.dataVersion : undefined,
                  );
            const turnRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_turns INDEXED BY sqlite_autoindex_orchestration_v2_projection_provider_turns_1
          WHERE provider_turn_id IN (SELECT value FROM json_each(${encodeIdList(turnIds)})) AND provider_thread_id = ${run.providerThreadId}
            AND run_attempt_id = ${run.activeAttemptId}
            AND node_id = ${run.rootNodeId}
            AND status = 'running' ORDER BY ordinal LIMIT 1`;
            return {
              run,
              providerThread:
                threadRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderThreadPayload(threadRows[0].payload_json),
              providerTurn:
                turnRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderTurnPayload(turnRows[0].payload_json),
            };
          }),
        ),
      ).pipe(Effect.mapError(controlReadError(threadId)));

    const getThreadProviderContext: ProjectionStoreV2Shape["getThreadProviderContext"] = (
      threadId,
      targetInstanceId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const thread = yield* getThread(threadId);
            const sessionRows = yield* sql<PayloadRow>`
          SELECT session.payload_json FROM orchestration_v2_projection_provider_sessions AS session
          JOIN orchestration_v2_projection_provider_session_bindings AS binding
            ON binding.provider_session_id = session.provider_session_id
          WHERE binding.thread_id = ${threadId}
          ORDER BY session.updated_at ASC, session.provider_session_id ASC
        `;
            const threadRows =
              targetInstanceId === undefined
                ? []
                : yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_provider_threads
          WHERE provider_thread_id = ${thread.activeProviderThreadId}
             OR provider_thread_id = (
               SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
               WHERE thread_id = ${threadId} AND owner_node_id IS NULL
                 AND provider_instance_id = ${targetInstanceId}
               ORDER BY updated_at DESC, provider_thread_id ASC LIMIT 1
             )
          ORDER BY updated_at ASC, provider_thread_id ASC
        `;
            return {
              thread,
              providerSessions: yield* decodeRows(
                decodeProviderSessionPayload,
                threadId,
              )(sessionRows),
              providerThreads: yield* decodeRows(decodeProviderThreadPayload, threadId)(threadRows),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getRuntimeResponseContext: ProjectionStoreV2Shape["getRuntimeResponseContext"] = (
      threadId,
      requestId,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const request = yield* getRuntimeRequest(threadId, requestId);
            if (request === undefined)
              return { request, node: undefined, item: undefined, session: undefined };
            const nodeRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
          WHERE thread_id = ${threadId} AND node_id = ${request.nodeId}`;
            const itemRows =
              yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId} AND node_id = ${request.nodeId} AND type IN ('approval_request', 'user_input_request')
            AND json_extract(payload_json, '$.requestId') = ${requestId}
          ORDER BY ordinal ASC LIMIT 1`;
            const sessionRows =
              request.responseCapability.type !== "live"
                ? []
                : yield* sql<PayloadRow>`
          SELECT session.payload_json FROM orchestration_v2_projection_provider_sessions AS session
          JOIN orchestration_v2_projection_provider_session_bindings AS binding
            ON binding.provider_session_id = session.provider_session_id
          WHERE binding.thread_id = ${threadId} AND session.provider_session_id = ${request.responseCapability.providerSessionId}`;
            return {
              request,
              node:
                nodeRows[0] === undefined
                  ? undefined
                  : yield* decodeNodePayload(nodeRows[0].payload_json),
              item:
                itemRows[0] === undefined
                  ? undefined
                  : yield* decodeTurnItemPayload(itemRows[0].payload_json),
              session:
                sessionRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderSessionPayload(sessionRows[0].payload_json),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getCheckpointContext: ProjectionStoreV2Shape["getCheckpointContext"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const threads = yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads
            WHERE thread_id = ${threadId} LIMIT 1
          `;
            if (threads.length === 0) {
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            }
            // Checkpoint diffs need no transcript or fork ancestry. Select just the
            // metadata columns so large run/checkpoint JSON payloads stay in SQLite.
            const [runs, checkpointScopes, checkpoints] = yield* Effect.all([
              sql`
              SELECT run_id AS id, ordinal, status
              FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId}
              ORDER BY ordinal ASC
            `,
              sql`
              SELECT scope_id AS id, run_id AS "runId", kind,
                json_extract(payload_json, '$.cwd') AS cwd
              FROM orchestration_v2_projection_checkpoint_scopes
              WHERE thread_id = ${threadId}
              ORDER BY ordinal_within_parent ASC, scope_id ASC
            `,
              sql`
              SELECT scope_id AS "scopeId", run_id AS "runId",
                app_run_ordinal AS "appRunOrdinal", status,
                json_extract(payload_json, '$.ref') AS ref
              FROM orchestration_v2_projection_checkpoints
              WHERE thread_id = ${threadId}
              ORDER BY scope_id ASC, ordinal_within_scope ASC
            `,
            ]);
            return yield* decodeCheckpointContext({ runs, checkpointScopes, checkpoints });
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const getCheckpointCaptureContext: ProjectionStoreV2Shape["getCheckpointCaptureContext"] = (
      threadId,
      target,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const runRows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${threadId} AND run_id = ${target.runId}`;
            const run =
              runRows[0] === undefined
                ? undefined
                : yield* decodeRunPayload(runRows[0].payload_json);
            const [nodeRows, scopeRows, providerRows, readyRows] = yield* Effect.all([
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_nodes
            WHERE thread_id = ${threadId} AND node_id = ${run?.rootNodeId ?? null}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_checkpoint_scopes
            WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId}`,
              sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_provider_threads
            WHERE provider_thread_id = ${run?.providerThreadId ?? null}
              AND (thread_id = ${threadId}
                OR owner_node_id IN (SELECT node_id FROM orchestration_v2_projection_nodes WHERE thread_id = ${threadId})
                OR provider_thread_id IN (SELECT provider_thread_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${threadId}))`,
              sql<{
                readonly ordinal: number;
                readonly status: string;
                readonly ofRun: number;
              }>`SELECT ordinal_within_scope AS ordinal, status, run_id IS NOT NULL AS "ofRun"
            FROM orchestration_v2_projection_checkpoints
            WHERE thread_id = ${threadId} AND scope_id = ${target.scopeId}
              AND (status = 'ready' OR run_id IS NOT NULL)`,
            ]);
            return {
              run,
              rootNode:
                nodeRows[0] === undefined
                  ? undefined
                  : yield* decodeNodePayload(nodeRows[0].payload_json),
              scope:
                scopeRows[0] === undefined
                  ? undefined
                  : yield* decodeCheckpointScopePayload(scopeRows[0].payload_json),
              providerThread:
                providerRows[0] === undefined
                  ? undefined
                  : yield* decodeProviderThreadPayload(providerRows[0].payload_json),
              readyCheckpointOrdinals: readyRows
                .filter(({ status }) => status === "ready")
                .map(({ ordinal }) => ordinal),
              runCheckpointOrdinals: readyRows
                .filter(({ ofRun }) => ofRun === 1)
                .map(({ ordinal }) => ordinal),
            };
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getRunMessage: ProjectionStoreV2Shape["getRunMessage"] = (threadId, runId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows = yield* sql<PayloadRow>`
          SELECT message.payload_json FROM orchestration_v2_projection_messages AS message
          JOIN orchestration_v2_projection_runs AS run
            ON message.message_id = json_extract(run.payload_json, '$.userMessageId')
          WHERE run.thread_id = ${threadId} AND run.run_id = ${runId}
            AND message.thread_id = ${threadId}`;
            return rows[0] === undefined
              ? undefined
              : yield* decodeMessagePayload(rows[0].payload_json);
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const canStartQueuedRun: ProjectionStoreV2Shape["canStartQueuedRun"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* requireThread(threadId);
            const rows = yield* sql<{ readonly ready: number }>`
          SELECT 1 AS ready FROM orchestration_v2_projection_threads AS thread
          WHERE thread.thread_id = ${threadId} AND thread.archived_at IS NULL AND thread.deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId} AND status = 'queued')
            AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs
              WHERE thread_id = ${threadId}
                AND status IN ('preparing', 'starting', 'running', 'waiting', 'queued')
                AND (status <> 'queued' OR json_extract(payload_json, '$.queueHeld') = 1))`;
            return rows.length > 0;
          }),
        )
        .pipe(Effect.mapError(controlReadError(threadId)));

    const getReportedContextWindow: NonNullable<
      ProjectionStoreV2Shape["getReportedContextWindow"]
    > = (instanceId) =>
      sql<{ readonly max_tokens: number | null }>`
        SELECT json_extract(payload_json, '$.contextUsage.maxTokens') AS max_tokens
        FROM orchestration_v2_projection_provider_threads
        WHERE provider_instance_id = ${instanceId}
          AND json_extract(payload_json, '$.contextUsage.maxTokens') > 0
        ORDER BY updated_at DESC
        LIMIT 1`.pipe(
        Effect.map((rows) => {
          const value = Number(rows[0]?.max_tokens);
          return Number.isFinite(value) && value > 0 ? value : undefined;
        }),
        Effect.orElseSucceed(() => undefined),
      );

    const hasMessages: ProjectionStoreV2Shape["hasMessages"] = (threadId) =>
      sql`SELECT 1 FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId} LIMIT 1`.pipe(
        Effect.map((rows) => rows.length !== 0),
        Effect.mapError(controlReadError(threadId)),
      );
    const hasStartedRunAfter: ProjectionStoreV2Shape["hasStartedRunAfter"] = (threadId, ordinal) =>
      sql`SELECT 1 FROM orchestration_v2_projection_runs AS run
        WHERE run.thread_id = ${threadId} AND run.ordinal > ${ordinal} AND run.status <> 'queued'
          AND EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items AS item
            INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
            WHERE item.thread_id = ${threadId} AND item.run_id = run.run_id AND item.type IN ('user_message','notification'))
        LIMIT 1`.pipe(
        Effect.map((rows) => rows.length !== 0),
        Effect.mapError(controlReadError(threadId)),
      );
    const getMessageCount: ProjectionStoreV2Shape["getMessageCount"] = (threadId) =>
      sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => rows[0]?.count ?? 0),
        Effect.mapError(controlReadError(threadId)),
      );
    const getNextTurnItemOrdinal: ProjectionStoreV2Shape["getNextTurnItemOrdinal"] = (threadId) =>
      sql<{ ordinal: number | null }>`SELECT MAX(ordinal) AS ordinal
        FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}`.pipe(
        Effect.map((rows) => (rows[0]?.ordinal ?? 0) + 1),
        Effect.mapError(controlReadError(threadId)),
      );

    const getTurnItem: ProjectionStoreV2Shape["getTurnItem"] = ({ threadId, itemId }) =>
      sql<{ payload_json: string }>`SELECT payload_json
        FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id = ${itemId} AND thread_id = ${threadId}`.pipe(
        Effect.flatMap((rows) =>
          rows[0] === undefined
            ? Effect.succeed(null)
            : decodeTurnItemPayload(rows[0].payload_json),
        ),
        Effect.mapError(controlReadError(threadId)),
      );

    const getThreadAttachmentIds: ProjectionStoreV2Shape["getThreadAttachmentIds"] = (threadId) =>
      Effect.all([
        sql<{ id: string }>`
      SELECT DISTINCT json_extract(attachment.value, '$.id') AS id
      FROM orchestration_v2_projection_messages AS message,
        json_each(message.payload_json, '$.attachments') AS attachment
      WHERE message.thread_id = ${threadId}
    `,
        // Pages published by html_render, and captured MCP App documents,
        // live in the attachment store too.
        sql<{ payload_json: string }>`
      SELECT payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id = ${threadId}
        AND type = 'dynamic_tool'
        AND (payload_json LIKE '%htmlRender%' OR payload_json LIKE ${`%${MCP_APP_OUTPUT_KEY}%`})
    `,
      ]).pipe(
        Effect.map(([messages, renders]) => [
          ...new Set([
            ...messages.map((row) => row.id),
            ...threadHtmlRenderAttachmentIds(
              threadId,
              renders.map((row) => {
                const item = parseEncodedPayload(row.payload_json);
                return {
                  toolName: typeof item.toolName === "string" ? item.toolName : null,
                  output: item.output,
                };
              }),
            ),
          ]),
        ]),
        Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
      );

    const getThreadRecords: ProjectionStoreV2Shape["getThreadRecords"] = (
      threadId,
      fields,
      filter,
    ) =>
      Effect.flatMap(Effect.serviceOption(sql.transactionService), (outer) =>
        sql.withTransaction(
          Effect.gen(function* () {
            if (filter?.pendingRuntimeRequestControls) {
              const rows = yield* sql<PayloadRow>`
                SELECT payload_json
                FROM orchestration_v2_projection_runtime_requests
                  INDEXED BY orchestration_v2_projection_requests_recovery_idx
                WHERE thread_id = ${threadId} AND status = 'pending'
                ORDER BY created_at ASC, runtime_request_id ASC
              `;
              const runtimeRequests = yield* decodeRows(
                decodeRuntimeRequestPayload,
                threadId,
              )(rows);
              const requestNodeIds = [...new Set(runtimeRequests.map((request) => request.nodeId))];
              const records = yield* readCanonicalProjection(
                threadId,
                undefined,
                fields.filter((field) => field !== "runtimeRequests"),
                {
                  ...filter,
                  pendingRuntimeRequestsOnly: true,
                  nodeIds: requestNodeIds,
                  turnItemNodeIds: requestNodeIds,
                },
              );
              return { ...records, runtimeRequests };
            }
            if (!filter?.queuedControls)
              return yield* readCanonicalProjection(threadId, undefined, fields, filter);
            const rows = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runs ${filter.runIds ? sql`INDEXED BY sqlite_autoindex_orchestration_v2_projection_runs_1` : sql`INDEXED BY orchestration_v2_projection_runs_thread_status_idx`}
          WHERE thread_id = ${threadId} AND status = 'queued'
            ${filter.runIds ? sql`AND run_id IN (SELECT value FROM json_each(${encodeIdList(filter.runIds)}))` : sql``}
          ORDER BY ordinal
        `;
            const runs = yield* decodeRows(decodeRunPayload, threadId)(rows);
            const scoped = queueFilter(runs, filter);
            if (
              fields.some((field) => field === "turnItems") &&
              scoped.turnItemTypes?.length &&
              scoped.turnItemMessageIds.length
            ) {
              const version = Option.isNone(outer) ? yield* dispatchHistory.dataVersion : undefined;
              scoped.turnItemMessageIds = yield* Effect.filter(scoped.turnItemMessageIds, (id) =>
                dispatchHistory.mayHaveUserItem(threadId, id, version),
              );
            }
            const records = yield* readCanonicalProjection(
              threadId,
              undefined,
              fields.filter((field) => field !== "runs"),
              scoped,
            );
            return { ...records, runs };
          }),
        ),
      ).pipe(
        Effect.map(
          (projection) =>
            Object.fromEntries([
              ["thread", projection.thread],
              ...fields.map((field) => [field, projection[field]]),
            ]) as ProjectionRecords<(typeof fields)[number]>,
        ),
        Effect.mapError(controlReadError(threadId)),
      );

    // Provider selection considers root provider threads. An explicitly referenced
    // provider thread can also belong to this chat through its node or subagent.
    const dispatchProviderThreads = (threadId: ThreadId, ids: readonly ProviderThreadId[]) =>
      sql<PayloadRow>`SELECT owned.payload_json FROM (
        SELECT provider_thread_id FROM orchestration_v2_projection_provider_threads
          INDEXED BY orchestration_v2_projection_provider_threads_thread_idx
          WHERE thread_id = ${threadId} AND owner_node_id IS NULL
        UNION SELECT value FROM json_each(${encodeIdList(ids)})
      ) wanted CROSS JOIN orchestration_v2_projection_provider_threads owned ON owned.provider_thread_id = wanted.provider_thread_id
      WHERE owned.thread_id = ${threadId}
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_nodes n WHERE n.node_id = owned.owner_node_id AND n.thread_id = ${threadId})
        OR EXISTS (SELECT 1 FROM orchestration_v2_projection_subagents s INDEXED BY orchestration_v2_projection_subagents_provider_thread_idx
          WHERE s.provider_thread_id = owned.provider_thread_id AND s.thread_id = ${threadId})
      ORDER BY COALESCE(owned.first_run_ordinal, 0), owned.provider_thread_id`.pipe(
        Effect.flatMap(decodeRows(decodeProviderThreadPayload, threadId)),
      );

    const getMessageDispatchProjection: ProjectionStoreV2Shape["getMessageDispatchProjection"] = (
      threadId,
      input,
    ) =>
      Effect.flatMap(Effect.serviceOption(sql.transactionService), (outer) =>
        sql.withTransaction(
          Effect.gen(function* () {
            const base = yield* readCanonicalProjection(
              threadId,
              undefined,
              input.followupTaskId
                ? []
                : input.resumeQueue
                  ? ["providerSessions"]
                  : ["providerSessions", "contextTransfers"],
              { pendingIncomingTransfersOnly: true },
            );
            const nativeId = base.thread.activeProviderThreadId;
            let providerThreads =
              input.resumeQueue || input.followupTaskId
                ? []
                : yield* dispatchProviderThreads(threadId, nativeId ? [nativeId] : []);
            const activeProvider = providerThreads.find(
              (row) => row.id === base.thread.activeProviderThreadId,
            );
            // Handoffs summarize a range of previous runs. Recovery commands compare
            // historical attempts, failures and ownership. Their run metadata is input.
            let fullRunHistory =
              input.needsRunHistory ||
              base.contextTransfers.length > 0 ||
              (activeProvider !== undefined &&
                activeProvider.providerInstanceId !==
                  (input.instanceId ?? base.thread.modelSelection.instanceId));
            const version = Option.isNone(outer) ? yield* dispatchHistory.dataVersion : undefined;
            const runIds = fullRunHistory
              ? undefined
              : yield* dispatchHistory.runIds(threadId, input.targetRunId, version);
            let { runs } = yield* readCanonicalProjection(
              threadId,
              undefined,
              ["runs"],
              runIds === undefined ? undefined : { runIds },
            );
            if (input.followupTaskId) {
              const subagents =
                yield* sql<PayloadRow>`SELECT payload_json FROM orchestration_v2_projection_subagents
                WHERE subagent_id = ${input.followupTaskId} AND thread_id = ${threadId}`.pipe(
                  Effect.flatMap(decodeRows(decodeSubagentPayload, threadId)),
                );
              const owner =
                runs.findLast(
                  (run) => activeRunStatuses.has(run.status) && run.status !== "queued",
                ) ?? latestExecutedRun(runs);
              if (!owner || !owner.activeAttemptId) return { ...base, runs, subagents };
              const { attempts } = yield* readCanonicalProjection(
                threadId,
                undefined,
                ["attempts"],
                { attemptRunIds: [owner.id] },
              );
              const linked = attempts.find(
                (attempt) => attempt.id === owner.activeAttemptId,
              )?.providerTurnId;
              const turnIds = yield* dispatchHistory.providerTurnIds(
                threadId,
                [owner.activeAttemptId],
                version,
              );
              if (linked) turnIds.push(linked);
              const { providerTurns } = yield* readCanonicalProjection(
                threadId,
                undefined,
                ["providerTurns"],
                { providerTurnIds: turnIds },
              );
              return { ...base, runs, subagents, attempts, providerTurns };
            }
            if (input.resumeQueue) {
              const failed = latestExecutedRun(runs);
              const failures =
                failed?.status !== "failed"
                  ? []
                  : (yield* readCanonicalProjection(threadId, undefined, ["turnItems"], {
                      turnItemTypes: ["error"],
                      turnItemStatuses: ["failed"],
                      turnItemRunId: failed.id,
                    })).turnItems;
              return { ...base, runs, turnItems: failures };
            }
            if (input.queuedStart && !fullRunHistory) {
              const previous = runs.findLast((run) =>
                ["completed", "failed", "interrupted"].includes(run.status),
              );
              if (
                previous &&
                runs.some(
                  (run) =>
                    run.status === "queued" &&
                    run.providerInstanceId !== previous.providerInstanceId,
                )
              ) {
                fullRunHistory = true;
                runs = (yield* readCanonicalProjection(threadId, undefined, ["runs"])).runs;
              }
            }
            const active = runs.filter(
              (run) => activeRunStatuses.has(run.status) || run.id === input.targetRunId,
            );
            const controls = fullRunHistory ? runs : active;
            if (fullRunHistory) {
              providerThreads = (yield* readCanonicalProjection(threadId, undefined, [
                "providerThreads",
              ])).providerThreads;
            } else {
              const required = active.flatMap((run) =>
                run.providerThreadId === null ? [] : [run.providerThreadId],
              );
              if (required.some((id) => !providerThreads.some((row) => row.id === id)))
                providerThreads = yield* dispatchProviderThreads(
                  threadId,
                  nativeId ? [...required, nativeId] : required,
                );
            }
            const latestCandidate = runs.reduce<OrchestrationV2Run | undefined>(
              (latest, run) =>
                run.status !== "rolled_back" &&
                run.status !== "queued" &&
                (latest === undefined || runRanAfter(run, latest))
                  ? run
                  : latest,
              undefined,
            );
            const itemRunIds = [
              ...new Set([
                ...active.map((run) => run.id),
                ...(latestCandidate ? [latestCandidate.id] : []),
              ]),
            ];
            const attemptIds = [...new Set(controls.map((run) => run.activeAttemptId))];
            const turnFilter = fullRunHistory
              ? {}
              : {
                  providerTurnAttemptIds: attemptIds,
                  providerTurnIds: yield* dispatchHistory.providerTurnIds(
                    threadId,
                    attemptIds,
                    version,
                  ),
                };
            const details = yield* readCanonicalProjection(
              threadId,
              undefined,
              [
                "messages",
                "nodes",
                "attempts",
                "providerTurns",
                "runtimeRequests",
                "turnItems",
                ...(input.needsRunHistory || input.includeSubagents || input.queuedStart
                  ? ["subagents" as const]
                  : []),
              ],
              {
                ...(input.pendingHistoryEdits
                  ? {}
                  : {
                      messageIds: [
                        ...new Set([
                          ...(input.messageId === undefined ? [] : [input.messageId]),
                          ...active.map((run) => run.userMessageId),
                        ]),
                      ],
                    }),
                messageRoles: ["user"],
                unorderedMessages: true,
                nodeIds: active.flatMap((run) => (run.rootNodeId === null ? [] : [run.rootNodeId])),
                attemptRunIds: controls.map((run) => run.id),
                ...turnFilter,
                pendingRuntimeRequestsOnly: true,
                turnItemRunIds: itemRunIds,
                turnItemTypes: ["user_message"],
              },
            );
            const messages = [...details.messages];
            // One ordinary user message disproves maintenance-only history. Read
            // further only when the newest prompts are all /compact or /logout.
            if (
              input.checkMaintenanceHistory &&
              !input.pendingHistoryEdits &&
              messages.every(isNativeMaintenanceCommand)
            ) {
              let before: { updated_at: string; message_id: string } | undefined;
              for (;;) {
                const rows: ReadonlyArray<PayloadRow & { updated_at: string; message_id: string }> =
                  yield* sql<PayloadRow & { updated_at: string; message_id: string }>`
              SELECT payload_json, updated_at, message_id FROM orchestration_v2_projection_messages
                INDEXED BY orchestration_v2_projection_messages_latest_user_idx
              WHERE thread_id = ${threadId} AND role = 'user'
                ${before ? sql`AND (updated_at, message_id) < (${before.updated_at}, ${before.message_id})` : sql``}
              ORDER BY updated_at DESC, message_id DESC LIMIT 8
            `;
                let witness: OrchestrationV2ConversationMessage | undefined;
                for (const row of rows) {
                  const message = yield* decodeMessagePayload(row.payload_json);
                  if (messages.length === 0) messages.push(message);
                  if (!isNativeMaintenanceCommand(message)) {
                    witness = message;
                    break;
                  }
                }
                if (witness !== undefined && !messages.some((row) => row.id === witness.id))
                  messages.push(witness);
                if (witness !== undefined || rows.length < 8) break;
                before = rows[rows.length - 1]!;
              }
            }
            let turnItems = details.turnItems;
            let decisionRuns = runs;
            // An unseen latest run (a compact, cancelled queue entry or wake) may
            // put the visible model boundary earlier. Preserve the existing ordering
            // across legacy item IDs, rollbacks and reordered queued runs.
            if (input.pendingHistoryEdits) {
              turnItems = (yield* readCanonicalProjection(threadId, undefined, ["turnItems"], {
                turnItemTypes: ["user_message"],
              })).turnItems;
            } else if (
              latestCandidate &&
              latestCandidate.contextHandoffId === null &&
              !turnItems.some((item) => item.runId === latestCandidate.id && isShownRunItem(item))
            ) {
              // A /compact or a wake can hide the latest user row. Walk run
              // metadata in execution order and stop at the first displayed run.
              // Probe only that run's rows, even for noncanonical imported IDs.
              const id = yield* dispatchHistory.latestShownRun(threadId, runIds, version);
              if (id) {
                const witness = yield* readCanonicalProjection(
                  threadId,
                  undefined,
                  decisionRuns.some((run) => run.id === id) ? ["turnItems"] : ["turnItems", "runs"],
                  {
                    runIds: [id],
                    turnItemRunId: id,
                    turnItemTypes: ["user_message", "notification"],
                  },
                );
                if (witness.runs.length)
                  decisionRuns = [...decisionRuns, ...witness.runs].sort(
                    (a, b) => a.ordinal - b.ordinal,
                  );
                turnItems = [
                  ...turnItems.filter((item) => item.runId !== id),
                  ...witness.turnItems,
                ];
              }
            }
            if (
              !input.pendingHistoryEdits &&
              input.messageId !== undefined &&
              (active.length > 0 ||
                runs.some(
                  (run) =>
                    run.workspacePreparation?.type === "worktree" &&
                    (run.status === "interrupted" || run.status === "failed"),
                ))
            ) {
              // A replayed mailbox message can have a legacy item ID or an item
              // attached to an older run. Queueing moves its first user row.
              const possible = yield* dispatchHistory.mayHaveUserItem(
                threadId,
                input.messageId,
                version,
              );
              const prior = !possible
                ? []
                : yield* sql<PayloadRow>`
            SELECT payload_json FROM orchestration_v2_projection_turn_items INDEXED BY orchestration_v2_projection_turn_items_user_message_idx
            WHERE thread_id = ${threadId} AND type = 'user_message' AND json_extract(payload_json, '$.messageId') = ${input.messageId}
            ORDER BY ordinal, turn_item_id LIMIT 1
          `;
              if (prior[0]) {
                const item = yield* decodeTurnItemPayload(prior[0].payload_json);
                turnItems = [item, ...turnItems.filter((other) => other.id !== item.id)];
              }
            }
            if (input.needsRunHistory || input.queuedStart) {
              const failureRunIds = [latestExecutedRun(runs), latestUnheldRun(runs)].flatMap(
                (run) => (run?.status === "failed" ? [run.id] : []),
              );
              const failures = (yield* readCanonicalProjection(threadId, undefined, ["turnItems"], {
                turnItemTypes: ["error"],
                turnItemStatuses: ["failed"],
                ...(input.pendingHistoryEdits ? {} : { turnItemRunIds: failureRunIds }),
              })).turnItems;
              turnItems = [...turnItems, ...failures].sort(
                (a, b) => a.ordinal - b.ordinal || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
              );
            }
            return {
              ...base,
              providerThreads,
              checkpointScopes: input.queuedStart
                ? (yield* readCanonicalProjection(threadId, undefined, ["checkpointScopes"], {
                    checkpointScopeIds: details.nodes.flatMap((node) =>
                      node.checkpointScopeId === null ? [] : [node.checkpointScopeId],
                    ),
                  })).checkpointScopes
                : [],
              nodes: details.nodes,
              attempts: details.attempts,
              providerTurns: details.providerTurns,
              runtimeRequests: details.runtimeRequests,
              subagents: details.subagents,
              messages,
              runs: decisionRuns,
              turnItems,
            };
          }),
        ),
      ).pipe(Effect.mapError(controlReadError(threadId)));

    const getThreadSnapshot: ProjectionStoreV2Shape["getThreadSnapshot"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const projection = yield* getThreadProjection(threadId);
            const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
            SELECT MAX(sequence) AS snapshot_sequence
            FROM orchestration_events
            WHERE application_event_version = 2
              AND aggregate_kind = 'thread'
              AND stream_id = ${threadId}
          `;
            return {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
              projection,
            };
          }),
        )
        .pipe(
          // Opening a chat reads off the event loop, so it neither waits behind
          // nor stalls streaming writes.
          NodeSqliteClient.readOnly,
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    // Only the timeline index is assembled across fork ancestry. Payloads are read
    // after page selection, so history and MCP pages hydrate only the requested rows.
    type TimelineIndexItem = Pick<
      OrchestrationV2TurnItem,
      "id" | "threadId" | "runId" | "nodeId" | "type"
    > & {
      readonly inputIntent?: Extract<
        OrchestrationV2TurnItem,
        { type: "user_message" }
      >["inputIntent"];
      readonly createdBy?: "user" | "agent" | "system";
      readonly messageId?: MessageId;
    };
    type TimelineIndexRow = {
      readonly sourceThreadId: ThreadId;
      readonly sourceItemId: TurnItemId;
      readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
      readonly item: TimelineIndexItem;
      readonly synthetic?: OrchestrationV2TurnItem;
    };
    type TimelineIndexOptions = {
      readonly includeUserMeta?: boolean;
      readonly includeMessageIds?: boolean;
    };
    // SQLite orders TEXT columns by BINARY (UTF-8 byte order). JS `<` compares UTF-16
    // code units, which reverses U+E000..U+FFFF relative to U+10000+ surrogate pairs.
    const compareSqliteBinary = (left: string, right: string): number => {
      if (left === right) return 0;
      const minLen = Math.min(left.length, right.length);
      let i = 0;
      while (i < minLen && left.charCodeAt(i) === right.charCodeAt(i)) {
        i++;
      }
      if (i === minLen) return left.length - right.length;
      const leftUnit = left.charCodeAt(i);
      const rightUnit = right.charCodeAt(i);
      if (
        leftUnit < 0xd800 &&
        rightUnit < 0xd800 &&
        (i === 0 || left.charCodeAt(i - 1) < 0xd800 || left.charCodeAt(i - 1) > 0xdbff)
      ) {
        return leftUnit - rightUnit;
      }
      return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
    };
    const compareTimelineCursor = (
      left: { readonly ordinal: number; readonly turn_item_id: string },
      right: { readonly ordinal: number; readonly turn_item_id: string },
    ) =>
      left.ordinal !== right.ordinal
        ? left.ordinal - right.ordinal
        : compareSqliteBinary(left.turn_item_id, right.turn_item_id);
    const readHiddenTimelineItems = (
      threadId: ThreadId,
      records: ProjectionRecords<"runs" | "attempts">,
    ) =>
      Effect.gen(function* () {
        const rolledBackRunIds = new Set<string>(
          records.runs.filter((run) => run.status === "rolled_back").map((run) => run.id),
        );
        const unretainedCancelledRunIds = new Set<string>(
          records.runs
            .filter((run) => run.status === "cancelled" && !run.retainQueuedMessage)
            .map((run) => run.id),
        );
        const supersededRoots = new Map<string, Set<string>>();
        for (const attempt of records.attempts) {
          if (attempt.status !== "superseded") continue;
          let roots = supersededRoots.get(attempt.runId);
          if (roots === undefined) supersededRoots.set(attempt.runId, (roots = new Set()));
          roots.add(attempt.rootNodeId);
        }
        const candidateRunIds = [
          ...new Set([
            ...rolledBackRunIds,
            ...unretainedCancelledRunIds,
            ...supersededRoots.keys(),
          ]),
        ];
        if (candidateRunIds.length === 0) {
          return {
            hiddenItems: [] as ReadonlyArray<{
              readonly ordinal: number;
              readonly turn_item_id: string;
            }>,
            hiddenIdSet: new Set<string>(),
          };
        }
        const rows = yield* sql<{
          readonly turn_item_id: string;
          readonly ordinal: number;
          readonly run_id: string | null;
          readonly node_id: string | null;
          readonly type: OrchestrationV2TurnItem["type"];
          readonly input_intent: NonNullable<TimelineIndexItem["inputIntent"]> | null;
        }>`
          SELECT item.turn_item_id, item.ordinal, item.run_id, item.node_id, item.type,
            CASE
              WHEN item.type = 'user_message'
                THEN json_extract(item.payload_json, '$.inputIntent')
            END AS input_intent
          FROM (SELECT value AS wanted_run FROM json_each(${encodeIdList(candidateRunIds)})) AS wanted
          CROSS JOIN orchestration_v2_projection_turn_items AS item
            INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
          WHERE item.thread_id = ${threadId}
            AND item.run_id = wanted.wanted_run
        `;
        const interruptRuns = new Set<string>();
        for (const row of rows) {
          if (row.type === "run_interrupt_request" && row.run_id !== null) {
            interruptRuns.add(row.run_id);
          }
        }
        const hiddenItems: Array<{ readonly ordinal: number; readonly turn_item_id: string }> = [];
        for (const row of rows) {
          if (row.run_id === null) continue;
          const hidden =
            rolledBackRunIds.has(row.run_id) ||
            (unretainedCancelledRunIds.has(row.run_id) &&
              row.type === "user_message" &&
              row.input_intent === "queued_turn") ||
            (row.type === "run_interrupt_result" &&
              row.node_id !== null &&
              supersededRoots.get(row.run_id)?.has(row.node_id) === true &&
              !interruptRuns.has(row.run_id));
          if (hidden) {
            hiddenItems.push({ ordinal: row.ordinal, turn_item_id: row.turn_item_id });
          }
        }
        hiddenItems.sort(compareTimelineCursor);
        return {
          hiddenItems,
          hiddenIdSet: new Set(hiddenItems.map((item) => item.turn_item_id)),
        };
      });
    const readTimelineIndex = (
      threadId: ThreadId,
      seen: ReadonlySet<ThreadId>,
      options: TimelineIndexOptions = {},
    ): Effect.Effect<
      {
        readonly records: ProjectionRecords<"runs" | "attempts">;
        readonly local: ReadonlyArray<TimelineIndexRow>;
        readonly visible: ReadonlyArray<TimelineIndexRow>;
      },
      ProjectionStoreV2Error
    > =>
      Effect.gen(function* () {
        const records = yield* getThreadRecords(threadId, ["runs", "attempts"]);
        type TimelineRawRow = {
          readonly turn_item_id: string;
          readonly run_id: string | null;
          readonly node_id: string | null;
          readonly type: OrchestrationV2TurnItem["type"];
          readonly input_intent?: NonNullable<TimelineIndexItem["inputIntent"]> | null;
          readonly created_by?: "user" | "agent" | "system" | null;
          readonly message_id?: string | null;
        };
        const rows: ReadonlyArray<TimelineRawRow> = options.includeMessageIds
          ? yield* sql<TimelineRawRow>`SELECT turn_item_id, run_id, node_id, type,
              CASE WHEN type = 'user_message' THEN json_extract(payload_json, '$.inputIntent') END AS input_intent,
              CASE WHEN type = 'user_message' THEN json_extract(payload_json, '$.createdBy') END AS created_by,
              CASE WHEN type IN ('user_message', 'assistant_message') THEN json_extract(payload_json, '$.messageId') END AS message_id
            FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}
            ORDER BY ordinal ASC, turn_item_id ASC`
          : yield* sql<TimelineRawRow>`SELECT turn_item_id, run_id, node_id, type
            FROM orchestration_v2_projection_turn_items WHERE thread_id = ${threadId}
            ORDER BY ordinal ASC, turn_item_id ASC`;
        const userMetaByItemId = new Map<
          string,
          {
            readonly inputIntent: NonNullable<TimelineIndexItem["inputIntent"]> | null;
            readonly createdBy: "user" | "agent" | "system" | null;
          }
        >();
        if (!options.includeMessageIds) {
          if (options.includeUserMeta) {
            const userMetaRows = yield* sql<{
              readonly turn_item_id: string;
              readonly input_intent: NonNullable<TimelineIndexItem["inputIntent"]> | null;
              readonly created_by: "user" | "agent" | "system" | null;
            }>`
              SELECT turn_item_id,
                json_extract(payload_json, '$.inputIntent') AS input_intent,
                json_extract(payload_json, '$.createdBy') AS created_by
              FROM orchestration_v2_projection_turn_items
                INDEXED BY orchestration_v2_projection_turn_items_user_message_idx
              WHERE thread_id = ${threadId} AND type = 'user_message'
            `;
            for (const row of userMetaRows) {
              userMetaByItemId.set(row.turn_item_id, {
                inputIntent: row.input_intent,
                createdBy: row.created_by,
              });
            }
          } else {
            const unretainedCancelledRunIds = records.runs
              .filter((run) => run.status === "cancelled" && !run.retainQueuedMessage)
              .map((run) => run.id);
            if (unretainedCancelledRunIds.length > 0) {
              const cancelledRows = yield* sql<{
                readonly turn_item_id: string;
                readonly input_intent: NonNullable<TimelineIndexItem["inputIntent"]> | null;
              }>`
                SELECT item.turn_item_id,
                  json_extract(item.payload_json, '$.inputIntent') AS input_intent
                FROM (SELECT value AS wanted_run FROM json_each(${encodeIdList(unretainedCancelledRunIds)})) AS wanted
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                WHERE item.thread_id = ${threadId}
                  AND item.run_id = wanted.wanted_run
                  AND item.type = 'user_message'
              `;
              for (const row of cancelledRows) {
                userMetaByItemId.set(row.turn_item_id, {
                  inputIntent: row.input_intent,
                  createdBy: null,
                });
              }
            }
          }
        }
        const items: Array<TimelineIndexItem> = rows.map((row) => {
          const inputIntent =
            row.input_intent !== undefined
              ? row.input_intent
              : (userMetaByItemId.get(row.turn_item_id)?.inputIntent ?? null);
          const createdBy =
            row.created_by !== undefined
              ? row.created_by
              : (userMetaByItemId.get(row.turn_item_id)?.createdBy ?? null);
          const messageId = row.message_id ?? null;
          return {
            id: TurnItemId.make(row.turn_item_id),
            threadId,
            runId: row.run_id === null ? null : RunId.make(row.run_id),
            nodeId: row.node_id === null ? null : NodeId.make(row.node_id),
            type: row.type,
            ...(inputIntent === null ? {} : { inputIntent }),
            ...(createdBy === null ? {} : { createdBy }),
            ...(messageId === null ? {} : { messageId: MessageId.make(messageId) }),
          };
        });
        const local: Array<TimelineIndexRow> = items.map((item) => ({
          sourceThreadId: threadId,
          sourceItemId: item.id,
          visibility: "local",
          item,
        }));
        const isVisible = createOrchestrationV2TurnItemVisibility({
          runs: records.runs,
          attempts: records.attempts,
          items,
        });
        const visible = local.filter((row) => isVisible(row.item));
        const fork = records.thread.forkedFrom;
        if (fork?.type !== "run" || seen.has(fork.threadId)) return { records, local, visible };
        const source = yield* readTimelineIndex(
          fork.threadId,
          new Set([...seen, threadId]),
          options,
        );
        const sourceRun = source.records.runs.find((run) => run.id === fork.runId);
        let inherited: Array<TimelineIndexRow> = [];
        if (sourceRun !== undefined) {
          const ordinals = new Map(source.records.runs.map((run) => [run.id, run.ordinal]));
          const sourceItems = source.local.map((row) => row.item);
          inherited = [
            ...source.visible.filter(
              (row) => row.item.threadId !== fork.threadId || row.item.type === "fork",
            ),
            ...source.local.filter(
              (row) =>
                !isOrchestrationV2SupersededInterrupt({
                  item: row.item,
                  attempts: source.records.attempts,
                  items: sourceItems,
                }) &&
                isTurnItemAtOrBeforeRun({
                  historyOrigin: source.records.thread.historyOrigin,
                  itemRunId: row.item.runId,
                  runOrdinalById: ordinals,
                  sourceRunOrdinal: sourceRun.ordinal,
                }),
            ),
          ].map((row) => ({ ...row, visibility: "inherited" }));
        }
        const marker = makeForkMarkerTurnItem({
          targetProjection: records,
          sourceThreadId: fork.threadId,
          sourceRunId: fork.runId,
        });
        return {
          records,
          local,
          visible: [
            ...inherited,
            {
              sourceThreadId: fork.threadId,
              sourceItemId: marker.id,
              visibility: "synthetic" as const,
              item: marker,
              synthetic: marker,
            },
            ...visible,
          ],
        };
      }).pipe(
        Effect.mapError((cause) =>
          isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
            ? cause
            : new ProjectionStoreReadError({ threadId, cause }),
        ),
      );

    const { searchThread, searchThreadStream } = yield* makeThreadFind((threadId) =>
      readTimelineIndex(threadId, new Set()).pipe(Effect.map((index) => index.visible)),
    );

    const getThreadHistoryPage: ProjectionStoreV2Shape["getThreadHistoryPage"] = (
      threadId,
      cursor,
      throughEntryId,
      conversationOnly,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const index = yield* readTimelineIndex(threadId, new Set(), {
              includeUserMeta: true,
              includeMessageIds: throughEntryId !== undefined,
            });
            if (index.records.thread.deletedAt !== null)
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            const revisions = yield* sql<{
              sequence: number;
            }>`SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM orchestration_events WHERE application_event_version = 2
          AND aggregate_kind = 'thread' AND stream_id = ${threadId}`;
            const snapshotSequence = revisions[0]?.sequence ?? 0;
            const indexed = index.visible.map((row, position) => ({
              ...row,
              position,
              canonicalPosition: position,
            }));
            const selection = yield* Effect.try({
              try: () => {
                const policy = olderHistoryPagePolicy({ items: indexed, cursor, throughEntryId });
                const page = selectHistoryPageFromCursor({
                  items: indexed,
                  cursor,
                  snapshotSequence,
                  rowEncodedBytes: () => 0,
                  policy,
                });
                return { policy, page };
              },
              catch: (cause) => new ProjectionStoreReadError({ threadId, cause }),
            });
            const { policy, page } = selection;
            const end = (page.items.at(-1)?.canonicalPosition ?? -1) + 1;
            const hasUserTurns = index.visible
              .slice(0, end)
              .some((row) => isThreadHistoryUserTurn(row.item));
            const materialize = Effect.fn("ProjectionStore.materializeHistoryRows")(function* (
              rows: ReadonlyArray<(typeof indexed)[number]>,
            ) {
              if (rows.length === 0) return [];
              const sources = yield* encodeTimelineSources(
                rows
                  .filter((row) => !row.synthetic)
                  .map((row) => ({ threadId: row.sourceThreadId, id: row.sourceItemId })),
              );
              const payloads = yield* sql<{
                thread_id: string;
                turn_item_id: string;
                payload_json: string;
              }>`
          SELECT item.thread_id, item.turn_item_id, item.payload_json
          FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted
          ON item.thread_id = json_extract(wanted.value, '$.threadId')
            AND item.turn_item_id = json_extract(wanted.value, '$.id')`;
              const byIdentity = new Map(
                payloads.map((row) => [`${row.thread_id}:${row.turn_item_id}`, row.payload_json]),
              );
              return yield* Effect.forEach(rows, (row) =>
                Effect.gen(function* () {
                  const payload = byIdentity.get(`${row.sourceThreadId}:${row.sourceItemId}`);
                  const item =
                    row.synthetic ??
                    (payload === undefined
                      ? yield* new ProjectionStoreReadError({ threadId })
                      : yield* decodeTurnItemPayload(payload));
                  return {
                    position: row.canonicalPosition,
                    visibility: row.visibility,
                    sourceThreadId: row.sourceThreadId,
                    sourceItemId: row.sourceItemId,
                    item: projectTurnItemForWire(item),
                  };
                }),
              );
            });
            const items = yield* materialize(
              conversationOnly && hasUserTurns
                ? page.items.filter((row) => isConversationHistoryItem(row.item))
                : page.items,
            );
            const bounded = selectRecentTimelineWindow({ items, snapshotSequence, policy });
            const requests = yield* materialize(missingInterruptRequests(indexed, bounded.items));
            const pageItems = [...requests, ...bounded.items].map((row, position) => ({
              ...row,
              position,
            }));
            return {
              snapshotSequence,
              items: conversationOnly
                ? pageItems.filter((row) => isConversationHistoryItem(row.item))
                : pageItems,
              nextCursor: bounded.hasMoreHistory ? bounded.nextCursor : page.nextCursor,
              hasMoreHistory: bounded.hasMoreHistory || page.hasMoreHistory,
            };
          }),
        )
        .pipe(NodeSqliteClient.readOnly, Effect.mapError(controlReadError(threadId)));

    const getThreadMediaPage: ProjectionStoreV2Shape["getThreadMediaPage"] = (
      threadId,
      mediaCursor,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const { cursor, end } = yield* Effect.try({
              try: () => decodeThreadMediaCursor(mediaCursor),
              catch: (cause) => new ProjectionStoreReadError({ threadId, cause }),
            });
            const index = yield* readTimelineIndex(threadId, new Set());
            if (index.records.thread.deletedAt !== null)
              return yield* new ProjectionStoreThreadNotFoundError({ threadId });
            const revisions = yield* sql<{
              sequence: number;
            }>`SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND stream_id = ${threadId}`;
            const snapshotSequence = revisions[0]?.sequence ?? 0;
            const indexed = index.visible.map((row, position) => ({ ...row, position }));
            const page = yield* Effect.try({
              try: () =>
                selectHistoryPageFromCursor({
                  items: indexed,
                  cursor,
                  snapshotSequence,
                  rowEncodedBytes: () => 0,
                  policy: { maxItems: 75, maxTurnItems: 75, maxEncodedBytes: 1_048_576 },
                }),
              catch: (cause) => new ProjectionStoreReadError({ threadId, cause }),
            });
            const selected = page.items.filter((row) =>
              ["user_message", "assistant_message", "dynamic_tool"].includes(row.item.type),
            );
            const sources = yield* encodeTimelineSources(
              selected
                .filter((row) => !row.synthetic)
                .map((row) => ({ threadId: row.sourceThreadId, id: row.sourceItemId })),
            );
            const fields = yield* sql<{
              thread_id: string;
              turn_item_id: string;
              item_type: string;
              message_id: MessageId | null;
              text: string | null;
              title: string | null;
              viewed_path: string | null;
            }>`
          SELECT item.thread_id, item.turn_item_id, item.type AS item_type,
            json_extract(item.payload_json, '$.messageId') AS message_id,
            json_extract(item.payload_json, '$.text') AS text,
            json_extract(item.payload_json, '$.title') AS title,
            json_extract(item.payload_json, '$.viewedImagePath') AS viewed_path
          FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted
            ON item.thread_id = json_extract(wanted.value, '$.threadId') AND item.turn_item_id = json_extract(wanted.value, '$.id')`;
            const attachments = yield* sql<{
              thread_id: string;
              turn_item_id: string;
              id: string;
              type: ChatAttachment["type"];
              name: string;
              mime_type: string;
              size_bytes: number;
            }>`
          SELECT item.thread_id, item.turn_item_id, json_extract(a.value, '$.id') AS id, json_extract(a.value, '$.type') AS type, json_extract(a.value, '$.name') AS name, json_extract(a.value, '$.mimeType') AS mime_type, json_extract(a.value, '$.sizeBytes') AS size_bytes
          FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted ON item.thread_id = json_extract(wanted.value, '$.threadId') AND item.turn_item_id = json_extract(wanted.value, '$.id') JOIN json_each(item.payload_json, '$.attachments') a WHERE a.type = 'object'`;
            type ImageRow = {
              thread_id: string;
              turn_item_id: string;
              source_type: string | null;
              source_object: number;
              source_mime: string | null;
              mime_type: string | null;
              unavailable: number | null;
              position: number;
            };
            const imageMimeTypes = encodeIdList(PROVIDER_SEND_TURN_SUPPORTED_IMAGE_MIME_TYPES);
            const images = yield* sql<ImageRow>`
          WITH candidates AS (
          SELECT item.thread_id, item.turn_item_id,
            substr(json_extract(block.value, '$.source.type'), 1, 32) AS source_type,
            json_type(block.value, '$.source') = 'object' AS source_object,
            substr(json_extract(block.value, '$.source.media_type'), 1, 100) AS source_mime,
            substr(json_extract(block.value, '$.mimeType'), 1, 100) AS mime_type,
            json_extract(block.value, '$.imageUnavailable') AS unavailable,
            CAST(block.key AS INTEGER) AS position
          FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted ON item.thread_id = json_extract(wanted.value, '$.threadId') AND item.turn_item_id = json_extract(wanted.value, '$.id') JOIN json_each(item.payload_json, '$.output') block
          WHERE json_type(item.payload_json, '$.output') = 'array' AND block.type = 'object' AND json_extract(block.value, '$.type') = 'image'
          UNION ALL
          SELECT item.thread_id, item.turn_item_id,
            substr(json_extract(block.value, '$.source.type'), 1, 32),
            json_type(block.value, '$.source') = 'object',
            substr(json_extract(block.value, '$.source.media_type'), 1, 100),
            substr(json_extract(block.value, '$.mimeType'), 1, 100),
            json_extract(block.value, '$.imageUnavailable'), CAST(block.key AS INTEGER)
          FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted ON item.thread_id = json_extract(wanted.value, '$.threadId') AND item.turn_item_id = json_extract(wanted.value, '$.id') JOIN json_each(item.payload_json, '$.output.content') block
          WHERE json_type(item.payload_json, '$.output.content') = 'array' AND block.type = 'object' AND json_extract(block.value, '$.type') = 'image'
          UNION ALL
          SELECT item.thread_id, item.turn_item_id,
            substr(json_extract(item.payload_json, '$.output.source.type'), 1, 32),
            json_type(item.payload_json, '$.output.source') = 'object',
            substr(json_extract(item.payload_json, '$.output.source.media_type'), 1, 100),
            substr(json_extract(item.payload_json, '$.output.mimeType'), 1, 100),
            json_extract(item.payload_json, '$.output.imageUnavailable'), 0
          FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted ON item.thread_id = json_extract(wanted.value, '$.threadId') AND item.turn_item_id = json_extract(wanted.value, '$.id')
          WHERE json_extract(item.payload_json, '$.output.type') = 'image'
          ), accepted AS (
            SELECT *, ROW_NUMBER() OVER (PARTITION BY thread_id, turn_item_id ORDER BY position) AS image_number
            FROM candidates
            WHERE (COALESCE(source_object, 0) = 0 OR source_type = 'base64')
              AND lower(CASE WHEN source_object = 1 THEN source_mime ELSE mime_type END) IN (SELECT value FROM json_each(${imageMimeTypes}))
          ) SELECT thread_id, turn_item_id, source_type, source_object, source_mime, mime_type, unavailable, position FROM accepted WHERE image_number <= ${MAX_TOOL_OUTPUT_IMAGES} ORDER BY position`;
            const rows = selected.flatMap((row): MediaTimelineRow[] => {
              if (row.synthetic) return [{ ...row, item: projectTurnItemForWire(row.synthetic) }];
              const field = fields.find(
                (entry) =>
                  entry.thread_id === row.sourceThreadId && entry.turn_item_id === row.sourceItemId,
              );
              if (!field) return [];
              const outputImages = images
                .filter(
                  (image) =>
                    image.thread_id === row.sourceThreadId &&
                    image.turn_item_id === row.sourceItemId,
                )
                .flatMap((image) => {
                  if (image.source_object && image.source_type !== "base64") return [];
                  const block = {
                    type: "image",
                    mimeType: image.source_type === "base64" ? image.source_mime : image.mime_type,
                    imageUnavailable: image.unavailable === 1,
                  };
                  const parsed = readToolOutputImage(block);
                  return parsed
                    ? [
                        {
                          mimeType: parsed.mimeType,
                          ...(parsed.unavailable ? { unavailable: true } : {}),
                        },
                      ]
                    : [];
                })
                .slice(0, MAX_TOOL_OUTPUT_IMAGES);
              const item = {
                id: row.sourceItemId,
                threadId: row.sourceThreadId,
                type: row.item.type,
                ...(field.message_id === null ? {} : { messageId: field.message_id }),
                text: field.text ?? "",
                title: field.title ?? "",
                viewedImagePath: field.viewed_path ?? undefined,
                outputImages,
                outputOmitted: true,
                attachments: attachments
                  .filter(
                    (attachment) =>
                      attachment.thread_id === row.sourceThreadId &&
                      attachment.turn_item_id === row.sourceItemId,
                  )
                  .map((attachment) => ({
                    id: attachment.id,
                    type: attachment.type,
                    name: attachment.name,
                    mimeType: attachment.mime_type,
                    sizeBytes: attachment.size_bytes,
                  })),
                // Media indexing reads only these fields; the full turn-item type is wider.
              } as unknown as MediaTimelineRow["item"];
              return [{ ...row, item }];
            });
            return selectThreadMediaPage({
              rows,
              cursor,
              ...(end === undefined ? {} : { end }),
              nextCursor: page.nextCursor,
              hasMoreHistory: page.hasMoreHistory,
            });
          }),
        )
        .pipe(NodeSqliteClient.readOnly, Effect.mapError(controlReadError(threadId)));

    const getTimelinePage: ProjectionStoreV2Shape["getTimelinePage"] = (threadId, options) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const records = yield* getThreadRecords(threadId, ["runs", "attempts"]);
            // Non-forked threads (the common case) seek directly on the covering
            // (thread_id, ordinal, turn_item_id) index and walk bounded chunks
            // instead of scanning every item in the thread.
            if (records.thread.forkedFrom?.type !== "run" && options.limit > 0) {
              const { hiddenItems, hiddenIdSet } = yield* readHiddenTimelineItems(
                threadId,
                records,
              );
              const countRows = yield* sql<{ readonly count: number }>`
                SELECT COUNT(*) AS count
                FROM orchestration_v2_projection_turn_items
                  INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                WHERE thread_id = ${threadId}
              `;
              const totalRaw = countRows[0]?.count ?? 0;
              const totalVisible = Math.max(0, totalRaw - hiddenItems.length);
              if (options.itemId !== undefined) {
                const targetRows = yield* sql<{
                  readonly turn_item_id: string;
                  readonly ordinal: number;
                  readonly payload_json: string;
                }>`
                  SELECT turn_item_id, ordinal, payload_json
                  FROM orchestration_v2_projection_turn_items
                    INDEXED BY sqlite_autoindex_orchestration_v2_projection_turn_items_1
                  WHERE thread_id = ${threadId}
                    AND turn_item_id = ${options.itemId}
                  LIMIT 1
                `;
                const target = targetRows[0];
                if (target === undefined || hiddenIdSet.has(target.turn_item_id)) {
                  return { items: [], totalItems: totalVisible, hasMore: false };
                }
                const beforeRows = yield* sql<{ readonly count: number }>`
                  SELECT COUNT(*) AS count
                  FROM orchestration_v2_projection_turn_items
                    INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                  WHERE thread_id = ${threadId}
                    AND (
                      ordinal < ${target.ordinal}
                      OR (ordinal = ${target.ordinal} AND turn_item_id < ${target.turn_item_id})
                    )
                `;
                let hiddenBefore = 0;
                for (const hidden of hiddenItems) {
                  if (compareTimelineCursor(hidden, target) < 0) hiddenBefore++;
                  else break;
                }
                const item = yield* decodeTurnItemPayload(target.payload_json).pipe(
                  Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
                );
                return {
                  items: [
                    {
                      position: (beforeRows[0]?.count ?? 0) - hiddenBefore,
                      sourceThreadId: threadId,
                      sourceItemId: TurnItemId.make(target.turn_item_id),
                      visibility: "local" as const,
                      item,
                    },
                  ],
                  totalItems: totalVisible,
                  hasMore: false,
                };
              }

              const startInclusive = Math.max(0, Math.floor(options.afterPosition ?? -1) + 1);
              const endExclusive =
                options.beforePosition === undefined
                  ? totalVisible
                  : Math.min(totalVisible, Math.max(0, Math.ceil(options.beforePosition)));
              if (startInclusive >= endExclusive) {
                return { items: [], totalItems: totalVisible, hasMore: false };
              }
              const backwards = options.fromEnd === true || options.beforePosition !== undefined;
              const seekVisibleCursor = (targetVisiblePos: number) =>
                Effect.gen(function* () {
                  const fromEnd = totalVisible - 1 - targetVisiblePos < targetVisiblePos;
                  const targetSkip = fromEnd
                    ? totalVisible - 1 - targetVisiblePos
                    : targetVisiblePos;
                  let rawOffset = targetSkip;
                  while (true) {
                    const probeRows = fromEnd
                      ? yield* sql<{ readonly ordinal: number; readonly turn_item_id: string }>`
                          SELECT ordinal, turn_item_id
                          FROM orchestration_v2_projection_turn_items
                            INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                          WHERE thread_id = ${threadId}
                          ORDER BY ordinal DESC, turn_item_id DESC
                          LIMIT 1 OFFSET ${rawOffset}
                        `
                      : yield* sql<{ readonly ordinal: number; readonly turn_item_id: string }>`
                          SELECT ordinal, turn_item_id
                          FROM orchestration_v2_projection_turn_items
                            INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                          WHERE thread_id = ${threadId}
                          ORDER BY ordinal ASC, turn_item_id ASC
                          LIMIT 1 OFFSET ${rawOffset}
                        `;
                    const row = probeRows[0];
                    if (row === undefined) return undefined;
                    let hiddenSkipped = 0;
                    for (const hidden of hiddenItems) {
                      const cmp = compareTimelineCursor(hidden, row);
                      if (fromEnd ? cmp > 0 : cmp < 0) hiddenSkipped++;
                    }
                    const visibleSkipped = rawOffset - hiddenSkipped;
                    const isHidden = hiddenIdSet.has(row.turn_item_id);
                    if (visibleSkipped === targetSkip && !isHidden) return row;
                    rawOffset += targetSkip - visibleSkipped + (isHidden ? 1 : 0);
                  }
                });

              const selected: Array<{ readonly position: number; readonly turn_item_id: string }> =
                [];
              let hasMore = false;
              const CHUNK_SIZE = 256;
              if (options.view === "activity") {
                const countNeeded = Math.min(options.limit, endExclusive - startInclusive);
                hasMore = endExclusive - startInclusive > options.limit;
                let curPos = backwards ? endExclusive - 1 : startInclusive;
                let cursor:
                  | { readonly ordinal: number; readonly turn_item_id: string }
                  | undefined =
                  backwards && endExclusive === totalVisible
                    ? undefined
                    : !backwards && startInclusive === 0
                      ? undefined
                      : yield* seekVisibleCursor(curPos);
                let firstChunk = true;
                while (selected.length < countNeeded) {
                  const batchSize = Math.min(
                    CHUNK_SIZE,
                    countNeeded - selected.length + hiddenItems.length + 1,
                  );
                  const chunk =
                    cursor === undefined
                      ? backwards
                        ? yield* sql<{ readonly ordinal: number; readonly turn_item_id: string }>`
                            SELECT ordinal, turn_item_id
                            FROM orchestration_v2_projection_turn_items
                              INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                            WHERE thread_id = ${threadId}
                            ORDER BY ordinal DESC, turn_item_id DESC
                            LIMIT ${batchSize}
                          `
                        : yield* sql<{ readonly ordinal: number; readonly turn_item_id: string }>`
                            SELECT ordinal, turn_item_id
                            FROM orchestration_v2_projection_turn_items
                              INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                            WHERE thread_id = ${threadId}
                            ORDER BY ordinal ASC, turn_item_id ASC
                            LIMIT ${batchSize}
                          `
                      : backwards
                        ? firstChunk
                          ? yield* sql<{ readonly ordinal: number; readonly turn_item_id: string }>`
                              SELECT ordinal, turn_item_id
                              FROM orchestration_v2_projection_turn_items
                                INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                              WHERE thread_id = ${threadId}
                                AND (
                                  ordinal < ${cursor.ordinal}
                                  OR (ordinal = ${cursor.ordinal} AND turn_item_id <= ${cursor.turn_item_id})
                                )
                              ORDER BY ordinal DESC, turn_item_id DESC
                              LIMIT ${batchSize}
                            `
                          : yield* sql<{ readonly ordinal: number; readonly turn_item_id: string }>`
                              SELECT ordinal, turn_item_id
                              FROM orchestration_v2_projection_turn_items
                                INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                              WHERE thread_id = ${threadId}
                                AND (
                                  ordinal < ${cursor.ordinal}
                                  OR (ordinal = ${cursor.ordinal} AND turn_item_id < ${cursor.turn_item_id})
                                )
                              ORDER BY ordinal DESC, turn_item_id DESC
                              LIMIT ${batchSize}
                            `
                        : firstChunk
                          ? yield* sql<{ readonly ordinal: number; readonly turn_item_id: string }>`
                              SELECT ordinal, turn_item_id
                              FROM orchestration_v2_projection_turn_items
                                INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                              WHERE thread_id = ${threadId}
                                AND (
                                  ordinal > ${cursor.ordinal}
                                  OR (ordinal = ${cursor.ordinal} AND turn_item_id >= ${cursor.turn_item_id})
                                )
                              ORDER BY ordinal ASC, turn_item_id ASC
                              LIMIT ${batchSize}
                            `
                          : yield* sql<{ readonly ordinal: number; readonly turn_item_id: string }>`
                              SELECT ordinal, turn_item_id
                              FROM orchestration_v2_projection_turn_items
                                INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                              WHERE thread_id = ${threadId}
                                AND (
                                  ordinal > ${cursor.ordinal}
                                  OR (ordinal = ${cursor.ordinal} AND turn_item_id > ${cursor.turn_item_id})
                                )
                              ORDER BY ordinal ASC, turn_item_id ASC
                              LIMIT ${batchSize}
                            `;
                  firstChunk = false;
                  if (chunk.length === 0) break;
                  for (const row of chunk) {
                    if (hiddenIdSet.has(row.turn_item_id)) continue;
                    selected.push({ position: curPos, turn_item_id: row.turn_item_id });
                    curPos += backwards ? -1 : 1;
                    if (selected.length >= countNeeded) break;
                  }
                  if (chunk.length < batchSize) break;
                  cursor = chunk.at(-1);
                }
              } else {
                let curPos = backwards ? endExclusive - 1 : startInclusive;
                let cursor:
                  | { readonly ordinal: number; readonly turn_item_id: string }
                  | undefined =
                  backwards && endExclusive === totalVisible
                    ? undefined
                    : !backwards && startInclusive === 0
                      ? undefined
                      : yield* seekVisibleCursor(curPos);
                let firstChunk = true;
                while (!hasMore) {
                  if (backwards ? curPos < startInclusive : curPos >= endExclusive) break;
                  const chunk =
                    cursor === undefined
                      ? backwards
                        ? yield* sql<{
                            readonly ordinal: number;
                            readonly turn_item_id: string;
                            readonly type: OrchestrationV2TurnItem["type"];
                          }>`
                            SELECT ordinal, turn_item_id, type
                            FROM orchestration_v2_projection_turn_items
                              INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                            WHERE thread_id = ${threadId}
                            ORDER BY ordinal DESC, turn_item_id DESC
                            LIMIT ${CHUNK_SIZE}
                          `
                        : yield* sql<{
                            readonly ordinal: number;
                            readonly turn_item_id: string;
                            readonly type: OrchestrationV2TurnItem["type"];
                          }>`
                            SELECT ordinal, turn_item_id, type
                            FROM orchestration_v2_projection_turn_items
                              INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                            WHERE thread_id = ${threadId}
                            ORDER BY ordinal ASC, turn_item_id ASC
                            LIMIT ${CHUNK_SIZE}
                          `
                      : backwards
                        ? firstChunk
                          ? yield* sql<{
                              readonly ordinal: number;
                              readonly turn_item_id: string;
                              readonly type: OrchestrationV2TurnItem["type"];
                            }>`
                              SELECT ordinal, turn_item_id, type
                              FROM orchestration_v2_projection_turn_items
                                INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                              WHERE thread_id = ${threadId}
                                AND (
                                  ordinal < ${cursor.ordinal}
                                  OR (ordinal = ${cursor.ordinal} AND turn_item_id <= ${cursor.turn_item_id})
                                )
                              ORDER BY ordinal DESC, turn_item_id DESC
                              LIMIT ${CHUNK_SIZE}
                            `
                          : yield* sql<{
                              readonly ordinal: number;
                              readonly turn_item_id: string;
                              readonly type: OrchestrationV2TurnItem["type"];
                            }>`
                              SELECT ordinal, turn_item_id, type
                              FROM orchestration_v2_projection_turn_items
                                INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                              WHERE thread_id = ${threadId}
                                AND (
                                  ordinal < ${cursor.ordinal}
                                  OR (ordinal = ${cursor.ordinal} AND turn_item_id < ${cursor.turn_item_id})
                                )
                              ORDER BY ordinal DESC, turn_item_id DESC
                              LIMIT ${CHUNK_SIZE}
                            `
                        : firstChunk
                          ? yield* sql<{
                              readonly ordinal: number;
                              readonly turn_item_id: string;
                              readonly type: OrchestrationV2TurnItem["type"];
                            }>`
                              SELECT ordinal, turn_item_id, type
                              FROM orchestration_v2_projection_turn_items
                                INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                              WHERE thread_id = ${threadId}
                                AND (
                                  ordinal > ${cursor.ordinal}
                                  OR (ordinal = ${cursor.ordinal} AND turn_item_id >= ${cursor.turn_item_id})
                                )
                              ORDER BY ordinal ASC, turn_item_id ASC
                              LIMIT ${CHUNK_SIZE}
                            `
                          : yield* sql<{
                              readonly ordinal: number;
                              readonly turn_item_id: string;
                              readonly type: OrchestrationV2TurnItem["type"];
                            }>`
                              SELECT ordinal, turn_item_id, type
                              FROM orchestration_v2_projection_turn_items
                                INDEXED BY orchestration_v2_projection_turn_items_thread_ordinal_idx
                              WHERE thread_id = ${threadId}
                                AND (
                                  ordinal > ${cursor.ordinal}
                                  OR (ordinal = ${cursor.ordinal} AND turn_item_id > ${cursor.turn_item_id})
                                )
                              ORDER BY ordinal ASC, turn_item_id ASC
                              LIMIT ${CHUNK_SIZE}
                            `;
                  firstChunk = false;
                  if (chunk.length === 0) break;
                  for (const row of chunk) {
                    if (hiddenIdSet.has(row.turn_item_id)) continue;
                    if (backwards ? curPos < startInclusive : curPos >= endExclusive) break;
                    if (
                      row.type === "user_message" ||
                      row.type === "assistant_message" ||
                      row.type === "proposed_plan"
                    ) {
                      if (selected.length < options.limit) {
                        selected.push({ position: curPos, turn_item_id: row.turn_item_id });
                      } else {
                        hasMore = true;
                        break;
                      }
                    }
                    curPos += backwards ? -1 : 1;
                  }
                  if (chunk.length < CHUNK_SIZE) break;
                  cursor = chunk.at(-1);
                }
              }
              if (backwards) selected.reverse();
              if (selected.length === 0) {
                return { items: [], totalItems: totalVisible, hasMore };
              }
              const payloads = yield* sql<{
                readonly turn_item_id: string;
                readonly payload_json: string;
              }>`
                SELECT item.turn_item_id, item.payload_json
                FROM json_each(${encodeIdList(selected.map((row) => row.turn_item_id))}) AS wanted
                CROSS JOIN orchestration_v2_projection_turn_items AS item
                  INDEXED BY sqlite_autoindex_orchestration_v2_projection_turn_items_1
                  ON item.turn_item_id = wanted.value
                WHERE item.thread_id = ${threadId}
              `;
              const byId = new Map(payloads.map((row) => [row.turn_item_id, row.payload_json]));
              const items = yield* Effect.forEach(selected, (row) =>
                Effect.gen(function* () {
                  const payload = byId.get(row.turn_item_id);
                  if (payload === undefined)
                    return yield* new ProjectionStoreReadError({
                      threadId,
                      cause: "Timeline item disappeared during snapshot",
                    });
                  const item = yield* decodeTurnItemPayload(payload).pipe(
                    Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
                  );
                  return {
                    position: row.position,
                    sourceThreadId: threadId,
                    sourceItemId: TurnItemId.make(row.turn_item_id),
                    visibility: "local" as const,
                    item,
                  };
                }),
              );
              return { items, totalItems: totalVisible, hasMore };
            }

            const index = yield* readTimelineIndex(threadId, new Set());
            const matching = index.visible
              .map((row, position) => ({ ...row, position }))
              .filter((row) =>
                options.itemId === undefined
                  ? row.position > (options.afterPosition ?? -1) &&
                    row.position < (options.beforePosition ?? Infinity) &&
                    (options.view === "activity" ||
                      ["user_message", "assistant_message", "proposed_plan"].includes(
                        row.item.type,
                      ))
                  : row.sourceItemId === options.itemId,
              );
            const page =
              options.fromEnd === true || options.beforePosition !== undefined
                ? matching.slice(-options.limit)
                : matching.slice(0, options.limit);
            const sources = yield* encodeTimelineSources(
              page
                .filter((row) => row.synthetic === undefined)
                .map((row) => ({ threadId: row.sourceThreadId, id: row.sourceItemId })),
            );
            const payloads = yield* sql<{
              thread_id: string;
              turn_item_id: string;
              payload_json: string;
            }>`
          SELECT item.thread_id, item.turn_item_id, item.payload_json
          FROM orchestration_v2_projection_turn_items item JOIN json_each(${sources}) wanted
          ON item.thread_id = json_extract(wanted.value, '$.threadId')
            AND item.turn_item_id = json_extract(wanted.value, '$.id')`;
            const byIdentity = new Map(
              payloads.map((row) => [`${row.thread_id}:${row.turn_item_id}`, row.payload_json]),
            );
            const items = yield* Effect.forEach(page, (row) =>
              Effect.gen(function* () {
                if (row.synthetic !== undefined)
                  return {
                    position: row.position,
                    sourceThreadId: row.sourceThreadId,
                    sourceItemId: row.sourceItemId,
                    visibility: row.visibility,
                    item: row.synthetic,
                  };
                const payload = byIdentity.get(`${row.sourceThreadId}:${row.sourceItemId}`);
                if (payload === undefined)
                  return yield* new ProjectionStoreReadError({
                    threadId,
                    cause: "Timeline item disappeared during snapshot",
                  });
                const item = yield* decodeTurnItemPayload(payload).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProjectionStoreReadError({ threadId: row.sourceThreadId, cause }),
                  ),
                );
                return {
                  position: row.position,
                  sourceThreadId: row.sourceThreadId,
                  sourceItemId: row.sourceItemId,
                  visibility: row.visibility,
                  item,
                };
              }),
            );
            return {
              items,
              totalItems: index.visible.length,
              hasMore: matching.length > page.length,
            };
          }),
        )
        .pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    const getThreadSnapshotWindow: ProjectionStoreV2Shape["getThreadSnapshotWindow"] = (
      threadId,
      options,
    ) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const historyAnchor =
              options.anchorItemId === undefined
                ? undefined
                : {
                    itemId: options.anchorItemId,
                    threadId:
                      options.anchorThreadId ??
                      (yield* sql<{ readonly thread_id: string }>`
                        SELECT thread_id
                        FROM orchestration_v2_projection_turn_items
                        WHERE turn_item_id = ${options.anchorItemId}
                        LIMIT 1
                      `).map((row) => ThreadId.make(row.thread_id))[0] ??
                      threadId,
                  };
            const projection = yield* readProjection(threadId, new Set(), {
              rowLimit: options.rowLimit,
              userTurnLimit: options.userTurnLimit,
              forWire: options.forWire,
              ...(historyAnchor?.threadId === threadId
                ? { anchorItemId: historyAnchor.itemId }
                : {}),
              ...(historyAnchor === undefined ? {} : { historyAnchor }),
            });
            const rows = yield* sql<{ readonly snapshot_sequence: number | null }>`
              SELECT MAX(sequence) AS snapshot_sequence
              FROM orchestration_events
              WHERE application_event_version = 2
                AND aggregate_kind = 'thread'
                AND stream_id = ${threadId}
            `;
            return {
              schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
              snapshotSequence: rows[0]?.snapshot_sequence ?? 0,
              projection,
            };
          }),
        )
        .pipe(
          // Opening a chat reads off the event loop, so it neither waits behind
          // nor stalls streaming writes.
          NodeSqliteClient.readOnly,
          Effect.mapError((cause) =>
            isProjectionStoreThreadNotFoundError(cause) || isProjectionStoreReadError(cause)
              ? cause
              : new ProjectionStoreReadError({ threadId, cause }),
          ),
        );

    // Shared by the shell and the visit log's read marks, so both name the same chats.
    const unsettledThreadsOnly = () =>
      sql` AND json_extract(t.payload_json, '$.settledAt') IS NULL AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'`;

    const selectShellThreadRows = (
      threadId?: ThreadId,
      {
        location,
        projectId,
        unsettledOnly = false,
        subagentFamilyOf,
        allSubagentThreads,
        excludeSubagents = false,
        worktreePath,
        omitIdleSubagents,
      }: ShellSnapshotOptions = {},
    ) => {
      const preselect = omitIdleSubagents === "all" && location === "active";
      // The id range uses the existing primary key. Keep only the winning identity per
      // thread and fetch its JSON after thread selection. Secrets can outlive their runs.
      return sql<ShellThreadRow>`
            WITH RECURSIVE pending_secret AS MATERIALIZED (
              SELECT thread_id, turn_item_id,
                ROW_NUMBER() OVER (
                  PARTITION BY thread_id ORDER BY updated_at DESC, turn_item_id DESC
                ) AS rank
              FROM orchestration_v2_projection_turn_items
                INDEXED BY sqlite_autoindex_orchestration_v2_projection_turn_items_1
              WHERE turn_item_id >= ${SECRET_REQUEST_TURN_ITEM_ID_PREFIX}
                AND turn_item_id < ${SECRET_REQUEST_TURN_ITEM_ID_PREFIX_END}
                ${threadId === undefined ? sql`` : sql`AND thread_id = ${threadId}`}
                AND type = 'secret_request' AND status = 'waiting'
            )
            ${
              preselect
                ? sql`
            , candidate_threads(thread_id) AS (
              -- A cheap superset of the final selection. Exact background work and
              -- run presentation still come from shellThreadStateFromRow.
              SELECT t.thread_id
              FROM orchestration_v2_projection_threads t
              WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND (
                json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
                OR json_extract(t.payload_json, '$.createdBy') = 'user'
                OR json_extract(t.payload_json, '$.lastVisitedAt') IS NOT NULL
                OR json_extract(t.payload_json, '$.linkedPullRequest') IS NOT NULL
                OR json_extract(t.payload_json, '$.branchPullRequest') IS NOT NULL
                OR json_array_length(t.payload_json, '$.pullRequests') > 0
                OR (
                  t.active_provider_thread_id IS NOT NULL
                  AND json_extract(t.payload_json, '$.creationSource') IS NOT 'provider'
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
                  )
                )
                OR t.thread_id IN (SELECT thread_id FROM pending_secret)
                OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_runs r
                  WHERE r.thread_id = t.thread_id
                    AND r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting', 'failed')
                )
                OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_runtime_requests request
                  WHERE request.thread_id = t.thread_id AND request.status = 'pending'
                )
                OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_plans plan
                  WHERE plan.thread_id = t.thread_id AND plan.kind = 'proposed_plan' AND plan.status = 'active'
                )
                OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_provider_threads provider
                  WHERE provider.thread_id = t.thread_id
                    AND json_array_length(provider.payload_json, '$.pendingBackgroundTasks') > 0
                )
                OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_turn_items item
                  WHERE item.thread_id = t.thread_id
                    AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                    AND item.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
                )
                OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_subagents s
                  WHERE s.thread_id = t.thread_id AND s.child_thread_id IS NOT NULL
                    AND s.origin = 'app_owned'
                    AND COALESCE(json_extract(s.payload_json, '$.childActivity.status'), s.status)
                      IN ('pending', 'running', 'waiting')
                )
              )
              UNION
              SELECT parent.thread_id
              FROM candidate_threads candidates
              JOIN orchestration_v2_projection_threads child ON child.thread_id = candidates.thread_id
              JOIN orchestration_v2_projection_threads parent
                ON parent.thread_id = json_extract(child.payload_json, '$.lineage.parentThreadId')
              WHERE json_extract(child.payload_json, '$.lineage.parentEnvironmentId') IS NULL
                AND parent.deleted_at IS NULL AND parent.archived_at IS NULL
            )
            `
                : sql``
            }
            SELECT
              t.thread_id,
              t.payload_json,
              CASE
                WHEN json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
                  THEN json_extract(t.payload_json, '$.forkedFrom.threadId')
                ELSE NULL
              END AS forked_from_run_source_thread_id,
              presented.run_id AS latest_run_id,
              presented.status AS latest_run_status,
              presented.requested_at AS latest_run_requested_at,
              json_extract(presented.payload_json, '$.startedAt') AS latest_run_started_at,
              presented.completed_at AS latest_run_completed_at,
              active_run.run_id AS active_run_id,
              active_run.status AS active_run_status,
              activity_run.status AS activity_run_status,
              -- Mirrors orchestrationV2RunWorkStartedAt.
              COALESCE(
                json_extract(activity_run.payload_json, '$.workStartedAt'),
                json_extract(activity_run.payload_json, '$.startedAt'),
                activity_run.requested_at
              ) AS activity_run_started_at,
              (
                SELECT json_extract(session.payload_json, '$.lastError')
                -- Keep bindings outermost: one provider instance can hold every session.
                FROM orchestration_v2_projection_provider_session_bindings binding
                CROSS JOIN orchestration_v2_projection_provider_sessions session
                  ON session.provider_session_id = binding.provider_session_id
                WHERE binding.thread_id = t.thread_id
                  AND session.provider_instance_id = t.provider_instance_id
                ORDER BY session.updated_at DESC, session.provider_session_id DESC
                LIMIT 1
              ) AS last_error,
              (
                SELECT item.payload_json
                FROM orchestration_v2_projection_turn_items item
                INNER JOIN orchestration_v2_projection_runs r ON r.run_id = item.run_id
                WHERE r.run_id = presented.run_id
                  AND r.status = 'failed'
                  AND item.thread_id = t.thread_id
                  AND item.type = 'error' AND item.status = 'failed'
                  AND item.node_id IS json_extract(r.payload_json, '$.rootNodeId')
                ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
                LIMIT 1
              ) AS terminal_failure_payload_json,
              blocked.run_id AS blocking_run_id,
              blocked.requested_at AS blocking_run_requested_at,
              json_extract(blocked.payload_json, '$.startedAt') AS blocking_run_started_at,
              blocked.completed_at AS blocking_run_completed_at,
              (
                SELECT item.payload_json
                FROM orchestration_v2_projection_turn_items item
                WHERE item.thread_id = t.thread_id
                  AND item.run_id = blocked.run_id
                  AND item.type = 'error' AND item.status = 'failed'
                  AND item.node_id IS json_extract(blocked.payload_json, '$.rootNodeId')
                ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
                LIMIT 1
              ) AS blocking_failure_payload_json,
              (
                SELECT request.payload_json
                FROM orchestration_v2_projection_runtime_requests request
                WHERE request.thread_id = t.thread_id
                  AND request.status = 'pending'
                ORDER BY request.created_at DESC, request.runtime_request_id DESC
                LIMIT 1
              ) AS pending_request_payload_json,
              secret.payload_json AS pending_secret_request_payload_json,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id
                  AND message.role = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_message_at,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id
                  AND message.role = 'user'
                  AND json_extract(message.payload_json, '$.createdBy') = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_authored_message_at,
              EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_plans plan
                WHERE plan.thread_id = t.thread_id
                  AND plan.kind = 'proposed_plan'
                  AND plan.status = 'active'
              ) AS has_actionable_proposed_plan,
              -- Count per run on the covering (thread_id, run_id) index, then
              -- look up each run once, instead of one run lookup per item.
              (
                SELECT COALESCE(SUM(per_run.item_count), 0)
                FROM (
                  SELECT i.run_id, COUNT(*) AS item_count
                  FROM orchestration_v2_projection_turn_items i
                  WHERE i.thread_id = t.thread_id
                  GROUP BY i.run_id
                ) per_run
                LEFT JOIN orchestration_v2_projection_runs r
                  ON r.run_id = per_run.run_id
                WHERE per_run.run_id IS NULL OR r.status <> 'rolled_back'
              ) AS item_count,
              CASE WHEN json_extract(t.payload_json, '$.historyOrigin') = 'v1_import' THEN (
                SELECT COUNT(*)
                FROM orchestration_v2_projection_turn_items i
                WHERE i.thread_id = t.thread_id
                  AND i.run_id IS NULL
              ) ELSE 0 END AS runless_item_count
            FROM orchestration_v2_projection_threads t
            LEFT JOIN pending_secret pending ON pending.thread_id = t.thread_id AND pending.rank = 1
            LEFT JOIN orchestration_v2_projection_turn_items secret
              ON secret.turn_item_id = pending.turn_item_id
            -- The newest run not waiting in a held queue, matching latestUnheldRun.
            LEFT JOIN orchestration_v2_projection_runs presented ON presented.run_id = (
              SELECT candidate.run_id
              FROM orchestration_v2_projection_runs candidate
              WHERE candidate.thread_id = t.thread_id
                AND NOT (
                  candidate.status = 'queued'
                  AND json_extract(candidate.payload_json, '$.queueHeld') IS 1
                )
              ORDER BY candidate.ordinal DESC, candidate.run_id DESC
              LIMIT 1
            )
            -- Seek active/activity runs by (thread_id, status) once per thread
            -- rather than walking every historical run four times.
            LEFT JOIN orchestration_v2_projection_runs active_run ON active_run.run_id = (
              SELECT r.run_id
              FROM orchestration_v2_projection_runs r
                INDEXED BY orchestration_v2_projection_runs_thread_status_idx
              WHERE r.thread_id = t.thread_id
                AND r.status IN ('preparing', 'starting', 'running')
              ORDER BY r.ordinal DESC, r.run_id DESC
              LIMIT 1
            )
            LEFT JOIN orchestration_v2_projection_runs activity_run ON activity_run.run_id = (
              SELECT r.run_id
              FROM orchestration_v2_projection_runs r
                INDEXED BY orchestration_v2_projection_runs_thread_status_idx
              WHERE r.thread_id = t.thread_id
                AND r.status IN ('preparing', 'starting', 'running', 'waiting')
              ORDER BY r.ordinal DESC, r.run_id DESC
              LIMIT 1
            )
            LEFT JOIN orchestration_v2_projection_runs blocked ON blocked.run_id = CASE WHEN
              -- Most chats have no failure. Avoid sorting their entire run history
              -- to discover that none of it can block the queue.
              EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_runs failed
                  WHERE failed.thread_id = t.thread_id AND failed.status = 'failed'
              ) THEN (
              SELECT candidate.run_id
              FROM orchestration_v2_projection_runs candidate
              WHERE candidate.thread_id = t.thread_id
                AND candidate.status <> 'queued'
                AND NOT (
                  candidate.status = 'cancelled'
                  AND json_extract(candidate.payload_json, '$.startedAt') IS NULL
                )
              -- latestExecutedRun: the run that ended last (runRanAfter).
              ORDER BY candidate.completed_at IS NULL DESC, candidate.completed_at DESC,
                candidate.ordinal DESC, candidate.run_id DESC
              LIMIT 1
            ) END AND blocked.status = 'failed'
            WHERE t.deleted_at IS NULL${preselect ? sql` AND t.thread_id IN (SELECT thread_id FROM candidate_threads)` : sql``}${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`}${
              projectId === undefined ? sql`` : sql` AND t.project_id = ${projectId}`
            }${
              location === "active"
                ? sql` AND t.archived_at IS NULL`
                : location === "archive"
                  ? sql` AND t.archived_at IS NOT NULL`
                  : sql``
            }${unsettledOnly ? unsettledThreadsOnly() : sql``}${
              excludeSubagents
                ? sql` AND json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'`
                : sql``
            }${
              allSubagentThreads
                ? sql` AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'`
                : subagentFamilyOf === undefined
                  ? sql``
                  : sql` AND json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent' AND json_extract(t.payload_json, '$.lineage.rootThreadId') = (
                    SELECT json_extract(member.payload_json, '$.lineage.rootThreadId')
                    FROM orchestration_v2_projection_threads member
                    WHERE member.thread_id = ${subagentFamilyOf}
                  )`
            }${
              worktreePath === undefined
                ? sql``
                : sql` AND json_extract(t.payload_json, '$.worktreePath') = ${worktreePath}`
            }
            ORDER BY t.updated_at ASC, t.thread_id ASC
          `;
    };

    const selectShellRunRows = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<ShellRunRow>`
            SELECT thread_id, run_id, ordinal
            FROM orchestration_v2_projection_runs
          `
        : sql<ShellRunRow>`
            SELECT thread_id, run_id, ordinal
            FROM orchestration_v2_projection_runs
            WHERE thread_id IN ${sql.in(threadIds)}
          `;

    const selectShellRunItemCounts = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<ShellRunItemCountRow>`
            SELECT thread_id, run_id, COUNT(*) AS item_count
            FROM orchestration_v2_projection_turn_items
            WHERE run_id IS NOT NULL
            GROUP BY thread_id, run_id
          `
        : sql<ShellRunItemCountRow>`
            SELECT thread_id, run_id, COUNT(*) AS item_count
            FROM orchestration_v2_projection_turn_items
            WHERE run_id IS NOT NULL
              AND thread_id IN ${sql.in(threadIds)}
            GROUP BY thread_id, run_id
          `;

    const selectShellProviderThreadRows = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<PayloadRow & { readonly thread_id: string }>`
            SELECT thread_id, payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE thread_id IS NOT NULL
          `
        : sql<PayloadRow & { readonly thread_id: string }>`
            SELECT thread_id, payload_json
            FROM orchestration_v2_projection_provider_threads
            WHERE thread_id IN ${sql.in(threadIds)}
          `;

    const selectShellPendingTurnItemRows = (threadIds?: ReadonlyArray<ThreadId>) =>
      threadIds === undefined
        ? sql<
            PayloadRow & {
              readonly thread_id: string;
              readonly held_run_payload_json: string | null;
            }
          >`
            SELECT i.thread_id, i.payload_json, held.payload_json AS held_run_payload_json
            FROM orchestration_v2_projection_turn_items i
            LEFT JOIN orchestration_v2_projection_runs r
              ON r.run_id = i.run_id
            LEFT JOIN orchestration_v2_projection_runs held
              ON held.thread_id = json_extract(i.payload_json, '$.childThreadId')
                AND i.type = 'subagent' AND held.status = 'queued'
                AND json_extract(held.payload_json, '$.queueHeld') = 1
            WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
              AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
              -- A rolled-back run's items are abandoned, not pending. Without
              -- this the shell reports Waiting for work no one will finish,
              -- matching the item_count query's exclusion above.
              AND (i.run_id IS NULL OR r.status <> 'rolled_back')
          `
        : sql<
            PayloadRow & {
              readonly thread_id: string;
              readonly held_run_payload_json: string | null;
            }
          >`
            SELECT i.thread_id, i.payload_json, held.payload_json AS held_run_payload_json
            FROM orchestration_v2_projection_turn_items i
            LEFT JOIN orchestration_v2_projection_runs r
              ON r.run_id = i.run_id
            LEFT JOIN orchestration_v2_projection_runs held
              ON held.thread_id = json_extract(i.payload_json, '$.childThreadId')
                AND i.type = 'subagent' AND held.status = 'queued'
                AND json_extract(held.payload_json, '$.queueHeld') = 1
            WHERE i.type IN ('command_execution', 'dynamic_tool', 'subagent')
              AND i.status NOT IN ('completed', 'interrupted', 'failed', 'cancelled')
              AND (i.run_id IS NULL OR r.status <> 'rolled_back')
              AND i.thread_id IN ${sql.in(threadIds)}
          `;

    // App-owned subagents whose own chat still runs. Their card in the parent can
    // be interrupted with the run that started them, so the pending-card read
    // above misses them; background work names them from these rows.
    const selectShellLiveChildSubagentRows = (threadIds: ReadonlyArray<ThreadId>) =>
      sql<ShellLiveChildSubagentRow>`
        SELECT s.subagent_id, s.thread_id, s.run_id, s.child_thread_id, s.started_at,
          COALESCE(json_extract(s.payload_json, '$.childActivity.status'), s.status) AS status,
          json_extract(s.payload_json, '$.title') AS title,
          substr(json_extract(s.payload_json, '$.prompt'), 1, ${SHELL_SUBAGENT_PROMPT_CHARS}) AS prompt
        FROM orchestration_v2_projection_subagents AS s
          INDEXED BY orchestration_v2_projection_subagents_thread_idx
        WHERE s.thread_id IN ${sql.in(threadIds)}
          AND s.child_thread_id IS NOT NULL
          AND s.origin = 'app_owned'
          AND COALESCE(json_extract(s.payload_json, '$.childActivity.status'), s.status)
            IN ('pending', 'running', 'waiting')
          AND (
            s.run_id IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs r
              WHERE r.run_id = s.run_id AND r.status = 'rolled_back'
            )
          )
      `;

    // Final replies of finished runs, by run id. A full shell asked for ~2,500 of them on every
    // client connect, 2-7 s each time on a cold 22 GB database. Bounded: ~1 KB per entry.
    const COMPLETED_REPLY_CACHE_MAX = 4_000;
    const completedReplyCache = new Map<
      RunId,
      { readonly reply_tail: string | null; readonly reply_head: string | null }
    >();
    const rememberCompletedReply = (
      runId: RunId,
      reply: { readonly reply_tail: string | null; readonly reply_head: string | null },
    ) => {
      completedReplyCache.set(runId, reply);
      if (completedReplyCache.size > COMPLETED_REPLY_CACHE_MAX) {
        const oldest = completedReplyCache.keys().next();
        if (oldest.done !== true) completedReplyCache.delete(oldest.value);
      }
    };

    // Session boxes: the latest step of each active run and the final reply of each
    // finished one. Box data is decoration; failing to read it never fails the shell.
    // Seek to the winning identity before reading its JSON. Equal ordinals keep
    // the legacy window query's insertion order via rowid.
    const readShellBoxData = (
      states: ReadonlyArray<ShellThreadState>,
      options?: {
        /** Read inside the caller's transaction, which took `readEpoch` before its first read. */
        readonly inTransaction?: { readonly readEpoch: number };
      },
    ) => {
      // Taken before the snapshot the box rows come from: in the caller's
      // transaction, before its first read; otherwise before the box transaction.
      const readEpoch = options?.inTransaction?.readEpoch ?? messageBoxWriteEpoch;
      const stepRunIds = states.flatMap((state) =>
        state.activityRunStatus !== null && state.activeRunId !== null ? [state.activeRunId] : [],
      );
      const workingRunIds = new Set<string>(stepRunIds);
      // A finished run's final reply never changes, so only the first shell reads it.
      const completedRunIds = states.flatMap((state) =>
        state.latestRunStatus === "completed" &&
        state.latestRunId !== null &&
        !workingRunIds.has(state.latestRunId)
          ? [state.latestRunId]
          : [],
      );
      const cachedReplyRows = completedRunIds.flatMap((runId) => {
        const cached = completedReplyCache.get(runId);
        return cached === undefined ? [] : [{ run_id: runId as string, ...cached }];
      });
      // A finished run's final reply, and what a working run's agent last said.
      const replyRunIds = [
        ...completedRunIds.filter((runId) => !completedReplyCache.has(runId)),
        ...stepRunIds,
      ];
      const requestKeyByThreadId = new Map<ThreadId, string>();
      const cachedRequestByThreadId = new Map<ThreadId, ShellRequest>();
      const uncachedRequestThreadIds: ThreadId[] = [];
      for (const state of states) {
        if (state.latestUserAuthoredMessageAt === null) continue;
        const key = `${DateTime.toEpochMillis(state.latestUserAuthoredMessageAt)}:${state.itemCount}`;
        const cached = latestRequestCache.get(state.thread.id);
        if (cached !== undefined && cached.key === key) {
          if (cached.request !== null) cachedRequestByThreadId.set(state.thread.id, cached.request);
        } else {
          requestKeyByThreadId.set(state.thread.id, key);
          uncachedRequestThreadIds.push(state.thread.id);
        }
      }
      const createdChatKeyByThreadId = new Map<ThreadId, string>();
      const cachedCreatedChatPreviewByThreadId = new Map<ThreadId, string>();
      const uncachedCreatedChatIds: ThreadId[] = [];
      for (const state of states) {
        const { thread } = state;
        if (
          thread.createdBy !== "agent" ||
          thread.creationSource !== "mcp" ||
          thread.lineage.parentThreadId !== null
        ) {
          continue;
        }
        if (state.activityRunStatus !== null) {
          uncachedCreatedChatIds.push(thread.id);
          continue;
        }
        const key = `${state.latestRunId ?? ""}:${state.latestRunStatus ?? ""}:${state.itemCount}`;
        const cached = createdChatPreviewCache.get(thread.id);
        if (cached !== undefined && cached.key === key) {
          if (cached.preview !== null)
            cachedCreatedChatPreviewByThreadId.set(thread.id, cached.preview);
        } else {
          createdChatKeyByThreadId.set(thread.id, key);
          uncachedCreatedChatIds.push(thread.id);
        }
      }

      const buildBoxData = (input: {
        readonly stepRows: ReadonlyArray<{
          readonly run_id: string;
          readonly type: string;
          readonly started_at: string | null;
          readonly detail: string | null;
        }>;
        readonly replyRows: ReadonlyArray<{
          readonly run_id: string;
          readonly reply_tail: string | null;
          readonly reply_head: string | null;
        }>;
        readonly requestRows: ReadonlyArray<{
          readonly thread_id: string;
          readonly message_id: string;
          readonly request: string | null;
        }>;
        readonly previews: ReadonlyArray<{
          readonly thread_id: string;
          readonly preview: string | null;
        }>;
      }): ShellBoxData => {
        const createdChatPreviewByThreadId = new Map<ThreadId, string>(
          cachedCreatedChatPreviewByThreadId,
        );
        for (const row of input.previews)
          if (row.preview)
            createdChatPreviewByThreadId.set(ThreadId.make(row.thread_id), row.preview);
        const requestByThreadId = new Map<ThreadId, ShellRequest>(cachedRequestByThreadId);
        for (const row of input.requestRows) {
          if (row.request !== null) {
            requestByThreadId.set(ThreadId.make(row.thread_id), {
              id: row.message_id,
              text: row.request,
            });
          }
        }
        const stepByRunId = new Map<RunId, OrchestrationV2ThreadShellStep>();
        for (const row of input.stepRows) {
          stepByRunId.set(RunId.make(row.run_id), {
            itemType: row.type,
            detail: row.detail,
            startedAt: row.started_at === null ? null : DateTime.makeUnsafe(row.started_at),
          });
        }
        const attentionByRunId = new Map<RunId, OrchestrationV2ThreadShell["replyAttention"]>();
        // Only a finished reply asks something of the user; a working run's words are not read.
        for (const row of input.replyRows) {
          if (workingRunIds.has(row.run_id)) continue;
          attentionByRunId.set(
            RunId.make(row.run_id),
            row.reply_tail === null ? null : sessionBoxAttention(row.reply_tail),
          );
        }
        const replyPreviewByRunId = new Map<RunId, string>();
        for (const row of input.replyRows) {
          const preview = row.reply_head === null ? null : messagePreviewLine(row.reply_head);
          if (preview !== null) replyPreviewByRunId.set(RunId.make(row.run_id), preview);
        }
        return {
          createdChatPreviewByThreadId,
          stepByRunId,
          attentionByRunId,
          replyPreviewByRunId,
          requestByThreadId,
        } satisfies ShellBoxData;
      };

      // Avoid opening a second reader transaction when every box field is already cached.
      if (
        stepRunIds.length === 0 &&
        replyRunIds.length === 0 &&
        uncachedRequestThreadIds.length === 0 &&
        uncachedCreatedChatIds.length === 0
      ) {
        return Effect.succeed<ShellBoxData | undefined>(
          buildBoxData({
            stepRows: [],
            replyRows: cachedReplyRows,
            requestRows: [],
            previews: [],
          }),
        );
      }

      const queryBoxes = Effect.gen(function* () {
        // Nested in an outer transaction, the snapshot is older than `readEpoch`,
        // or on the writer may hold uncommitted rows: read, but never cache.
        const transaction = yield* Effect.serviceOption(sql.transactionService);
        const topLevel = Option.isNone(transaction) || transaction.value[1] === 0;
        const mayRemember = () => topLevel && messageBoxWriteEpoch === readEpoch;
        const stepRows =
          stepRunIds.length === 0
            ? []
            : yield* sql<{
                readonly run_id: string;
                readonly type: string;
                readonly started_at: string | null;
                readonly detail: string | null;
              }>`
                SELECT
                    i.run_id,
                    i.type,
                    json_extract(i.payload_json, '$.startedAt') AS started_at,
                    CASE i.type
                      WHEN 'command_execution'
                        THEN substr(json_extract(i.payload_json, '$.input'), 1, ${SHELL_STEP_DETAIL_CHARS})
                      WHEN 'file_change' THEN json_extract(i.payload_json, '$.fileName')
                      WHEN 'file_search' THEN json_extract(i.payload_json, '$.pattern')
                      WHEN 'web_search' THEN json_extract(i.payload_json, '$.patterns[0]')
                      WHEN 'dynamic_tool' THEN json_extract(i.payload_json, '$.toolName')
                      ELSE NULL
                    END AS detail
                FROM orchestration_v2_projection_runs r
                JOIN orchestration_v2_projection_turn_items i ON i.turn_item_id = (
                  SELECT latest.turn_item_id
                  FROM orchestration_v2_projection_turn_items latest
                  WHERE latest.run_id = r.run_id
                    AND latest.type IN ${sql.in([...SHELL_STEP_ITEM_TYPES])}
                  ORDER BY latest.ordinal DESC, latest.rowid ASC
                  LIMIT 1
                )
                WHERE r.run_id IN ${sql.in(stepRunIds)}
              `;
        const readReplyRows =
          replyRunIds.length === 0
            ? []
            : yield* sql<{
                readonly run_id: string;
                readonly reply_tail: string | null;
                readonly reply_head: string | null;
              }>`
                SELECT
                    i.run_id,
                    substr(json_extract(i.payload_json, '$.text'), -${SHELL_REPLY_TAIL_CHARS}) AS reply_tail,
                    substr(json_extract(i.payload_json, '$.text'), 1, ${MESSAGE_PREVIEW_SCAN_CHARS}) AS reply_head
                FROM orchestration_v2_projection_runs r
                JOIN orchestration_v2_projection_turn_items i ON i.turn_item_id = (
                  SELECT latest.turn_item_id
                  FROM orchestration_v2_projection_turn_items latest
                  WHERE latest.run_id = r.run_id AND latest.type = 'assistant_message'
                  ORDER BY latest.ordinal DESC, latest.rowid ASC
                  LIMIT 1
                )
                WHERE r.run_id IN ${sql.in(replyRunIds)}
              `;
        const readReplyByRunId = new Map(readReplyRows.map((row) => [row.run_id, row] as const));
        for (const runId of completedRunIds) {
          if (completedReplyCache.has(runId)) continue;
          const row = readReplyByRunId.get(runId);
          rememberCompletedReply(runId, {
            reply_tail: row?.reply_tail ?? null,
            reply_head: row?.reply_head ?? null,
          });
        }
        const replyRows = [...readReplyRows, ...cachedReplyRows];
        const requestRows =
          uncachedRequestThreadIds.length === 0
            ? []
            : yield* sql<{
                readonly thread_id: string;
                readonly message_id: string;
                readonly request: string | null;
              }>`
                SELECT
                    m.thread_id,
                    m.message_id,
                    substr(json_extract(m.payload_json, '$.text'), 1, ${SHELL_REQUEST_CHARS}) AS request
                FROM orchestration_v2_projection_threads t
                JOIN orchestration_v2_projection_messages m ON m.message_id = (
                  SELECT latest.message_id
                  FROM orchestration_v2_projection_messages latest
                  WHERE latest.thread_id = t.thread_id AND latest.role = 'user'
                    AND json_extract(latest.payload_json, '$.createdBy') = 'user'
                    AND json_extract(latest.payload_json, '$.creationSource') IS NOT 'server'
                  ORDER BY latest.updated_at DESC, latest.message_id DESC
                  LIMIT 1
                )
                WHERE t.thread_id IN ${sql.in(uncachedRequestThreadIds)}
              `;
        if (mayRemember()) {
          const readRequestByThreadId = new Map(
            requestRows.map((row) => [row.thread_id, row] as const),
          );
          for (const threadId of uncachedRequestThreadIds) {
            const key = requestKeyByThreadId.get(threadId);
            if (key === undefined) continue;
            const row = readRequestByThreadId.get(threadId);
            rememberLatestRequest(
              threadId,
              key,
              row && row.request !== null ? { id: row.message_id, text: row.request } : null,
            );
          }
        }
        // The existing (thread_id, created_at, message_id) index bounds this to two rows per
        // created chat, including after reload. Tool history never enters the read.
        const previews =
          uncachedCreatedChatIds.length === 0
            ? []
            : yield* sql<{ readonly thread_id: string; readonly preview: string | null }>`
          SELECT t.thread_id, (
            SELECT substr(json_extract(recent.payload_json, '$.text'), 1, 280)
            FROM (
              SELECT m.role, m.payload_json, m.created_at, m.message_id
              FROM orchestration_v2_projection_messages m
              WHERE m.thread_id = t.thread_id
              ORDER BY m.created_at DESC, m.message_id DESC LIMIT 2
            ) recent
            WHERE recent.role = 'assistant'
            ORDER BY recent.created_at DESC, recent.message_id DESC LIMIT 1
          ) AS preview
          FROM orchestration_v2_projection_threads t WHERE t.thread_id IN ${sql.in(uncachedCreatedChatIds)}
        `;
        if (mayRemember()) {
          const readPreviewByThreadId = new Map(
            previews.map((row) => [row.thread_id, row.preview] as const),
          );
          for (const threadId of uncachedCreatedChatIds) {
            const key = createdChatKeyByThreadId.get(threadId);
            if (key === undefined) continue;
            rememberCreatedChatPreview(threadId, key, readPreviewByThreadId.get(threadId) ?? null);
          }
        }
        return buildBoxData({ stepRows, replyRows, requestRows, previews });
      });

      const run =
        options?.inTransaction !== undefined
          ? queryBoxes
          : sql.withTransaction(queryBoxes).pipe(NodeSqliteClient.readOnly);

      return run.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not read session box data for the shell.", {
            cause,
          }).pipe(Effect.as(undefined)),
        ),
      );
    };

    const runMapsByThreadId = (input: {
      readonly runRows: ReadonlyArray<ShellRunRow>;
      readonly itemCountRows: ReadonlyArray<ShellRunItemCountRow>;
    }) => {
      const runOrdinalsByThreadId = new Map<ThreadId, Map<RunId, number>>();
      for (const row of input.runRows) {
        const threadId = ThreadId.make(row.thread_id);
        const runId = RunId.make(row.run_id);
        const existing = runOrdinalsByThreadId.get(threadId) ?? new Map<RunId, number>();
        existing.set(runId, row.ordinal);
        runOrdinalsByThreadId.set(threadId, existing);
      }
      const itemCountsByThreadId = new Map<ThreadId, Map<RunId, number>>();
      for (const row of input.itemCountRows) {
        const threadId = ThreadId.make(row.thread_id);
        const runId = RunId.make(row.run_id);
        const existing = itemCountsByThreadId.get(threadId) ?? new Map<RunId, number>();
        existing.set(runId, row.item_count);
        itemCountsByThreadId.set(threadId, existing);
      }
      return { runOrdinalsByThreadId, itemCountsByThreadId };
    };

    const pendingBackgroundDataByThreadId = (input: {
      readonly providerThreadRows: ReadonlyArray<PayloadRow & { readonly thread_id: string }>;
      readonly pendingTurnItemRows: ReadonlyArray<
        PayloadRow & { readonly thread_id: string; readonly held_run_payload_json?: string | null }
      >;
      readonly liveChildSubagentRows: ReadonlyArray<ShellLiveChildSubagentRow>;
    }) =>
      Effect.gen(function* () {
        const providerThreadsByThreadId = new Map<
          ThreadId,
          Array<OrchestrationV2ThreadProjection["providerThreads"][number]>
        >();
        for (const row of input.providerThreadRows) {
          const providerThread = yield* decodeProviderThreadPayload(row.payload_json);
          const threadId =
            row.thread_id.length > 0 ? ThreadId.make(row.thread_id) : providerThread.appThreadId;
          if (threadId === null) {
            continue;
          }
          const existing = providerThreadsByThreadId.get(threadId) ?? [];
          existing.push(providerThread);
          providerThreadsByThreadId.set(threadId, existing);
        }

        const childRuns = new Map<string, PendingBackgroundChildRun>();
        const seenItems = new Set<string>();
        const pendingTurnItemsByThreadId = new Map<ThreadId, Array<OrchestrationV2TurnItem>>();
        for (const row of input.pendingTurnItemRows) {
          if (row.held_run_payload_json != null && !childRuns.has(row.held_run_payload_json)) {
            const run = yield* decodeRunPayload(row.held_run_payload_json);
            childRuns.set(row.held_run_payload_json, run);
          }
          if (seenItems.has(row.payload_json)) continue;
          seenItems.add(row.payload_json);
          const turnItem = projectTurnItemForWire(yield* decodeTurnItemPayload(row.payload_json));
          const threadId = ThreadId.make(row.thread_id);
          const existing = pendingTurnItemsByThreadId.get(threadId) ?? [];
          existing.push(turnItem);
          pendingTurnItemsByThreadId.set(threadId, existing);
        }

        const liveChildSubagentsByThreadId = new Map<
          ThreadId,
          Array<PendingBackgroundWorkSubagent>
        >();
        for (const row of input.liveChildSubagentRows) {
          const threadId = ThreadId.make(row.thread_id);
          const existing = liveChildSubagentsByThreadId.get(threadId) ?? [];
          existing.push({
            id: NodeId.make(row.subagent_id),
            runId: row.run_id,
            origin: "app_owned",
            childThreadId: ThreadId.make(row.child_thread_id),
            startedAt: row.started_at === null ? null : DateTime.makeUnsafe(row.started_at),
            // The query keeps only active statuses.
            status: row.status === "pending" || row.status === "waiting" ? row.status : "running",
            title: row.title,
            prompt: row.prompt ?? "",
          });
          liveChildSubagentsByThreadId.set(threadId, existing);
        }

        return {
          providerThreadsByThreadId,
          pendingTurnItemsByThreadId,
          liveChildSubagentsByThreadId,
          childRuns: [...childRuns.values()],
        };
      });

    const getSettlementCandidates: ProjectionStoreV2Shape["getSettlementCandidates"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // Settlement needs activity timestamps, not item counts, run history,
            // provider sessions or inherited fork rows. Reject parked and busy
            // threads before loading the remaining candidates' background work.
            const rows = yield* sql<SettlementThreadRow>`
            SELECT t.thread_id, t.payload_json,
              r.run_id AS latest_run_id,
              r.status AS latest_run_status,
              r.requested_at AS latest_run_requested_at,
              json_extract(r.payload_json, '$.startedAt') AS latest_run_started_at,
              r.completed_at AS latest_run_completed_at,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id AND message.role = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_message_at,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id AND message.role = 'user'
                  AND json_extract(message.payload_json, '$.createdBy') = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_authored_message_at
            FROM orchestration_v2_projection_threads t
            LEFT JOIN orchestration_v2_projection_runs r ON r.run_id = (
              SELECT latest.run_id FROM orchestration_v2_projection_runs latest
              WHERE latest.thread_id = t.thread_id
              ORDER BY latest.ordinal DESC, latest.run_id DESC
              LIMIT 1
            )
            WHERE t.deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`}
              AND t.archived_at IS NULL
              AND json_extract(t.payload_json, '$.settledOverride') IS NULL
              AND json_extract(t.payload_json, '$.pinnedAt') IS NULL
              AND json_extract(t.payload_json, '$.autoSettleDisabledAt') IS NULL
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runs active
                WHERE active.thread_id = t.thread_id
                  AND active.status IN ('preparing', 'starting', 'running', 'waiting')
              )
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runtime_requests request
                WHERE request.thread_id = t.thread_id AND request.status = 'pending'
              )
              -- A queued run whose user message is a regular one blocks the
              -- settle command ("has a queued message"), so selecting such a
              -- thread only produces a dispatch failure on every sweep.
              -- Messages carrying a notification or a delegated completion are
              -- automatic and settle cancels them, so they do not block.
              -- Mirrors the settle command's queue check and
              -- projectionHasBlockingQueuedRun; keep the three in step.
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_runs queued
                WHERE queued.thread_id = t.thread_id
                  AND queued.status = 'queued'
                  AND NOT EXISTS (
                    SELECT 1 FROM orchestration_v2_projection_messages message
                    WHERE message.thread_id = t.thread_id
                      AND message.message_id = json_extract(queued.payload_json, '$.userMessageId')
                      AND (
                        json_extract(message.payload_json, '$.notification') IS NOT NULL
                        OR json_extract(message.payload_json, '$.delegatedCompletion') IS NOT NULL
                      )
                  )
              )
            ORDER BY t.updated_at ASC, t.thread_id ASC
          `;
            if (rows.length === 0) return [];
            const threadIds = rows.map((row) => ThreadId.make(row.thread_id));
            const {
              providerThreadsByThreadId,
              pendingTurnItemsByThreadId,
              liveChildSubagentsByThreadId,
              childRuns,
            } = yield* pendingBackgroundDataByThreadId({
              providerThreadRows: yield* selectShellProviderThreadRows(threadIds),
              pendingTurnItemRows: yield* selectShellPendingTurnItemRows(threadIds),
              liveChildSubagentRows: yield* selectShellLiveChildSubagentRows(threadIds),
            });
            return yield* Effect.forEach(rows, (row) =>
              Effect.gen(function* () {
                const thread = yield* decodeThreadPayload(row.payload_json);
                const status = shellStatusFromStoredRunStatus(row.latest_run_status);
                const latestRunId =
                  row.latest_run_id === null ? null : RunId.make(row.latest_run_id);
                return {
                  ...thread,
                  pinnedAt: thread.pinnedAt ?? null,

                  autoSettleDisabledAt: thread.autoSettleDisabledAt ?? null,
                  snoozedUntil: thread.snoozedUntil ?? null,
                  snoozedAt: thread.snoozedAt ?? null,
                  status,
                  latestRunId,
                  latestRunRequestedAt:
                    row.latest_run_requested_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_run_requested_at),
                  latestRunStartedAt:
                    row.latest_run_started_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_run_started_at),
                  latestRunCompletedAt:
                    row.latest_run_completed_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_run_completed_at),
                  latestUserMessageAt:
                    row.latest_user_message_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_user_message_at),
                  latestUserAuthoredMessageAt:
                    row.latest_user_authored_message_at === null
                      ? null
                      : DateTime.makeUnsafe(row.latest_user_authored_message_at),
                  activityRunStatus: null,
                  activityRunStartedAt: null,
                  pendingRuntimeRequest: null,
                  pendingBackgroundTasks: derivePendingBackgroundWork({
                    latestRun:
                      latestRunId === null || status === "idle"
                        ? null
                        : { id: latestRunId, ordinal: 0, status },
                    providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
                    turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
                    activeProviderThreadId: thread.activeProviderThreadId,
                    hasActiveRun: false,
                    pullRequests: thread.pullRequests,
                    childRuns,
                    subagents: liveChildSubagentsByThreadId.get(thread.id) ?? [],
                  }),
                } satisfies ProjectionSettlementCandidate;
              }),
            );
          }),
        )
        .pipe(Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })));

    const getThreadsWithPullRequests: ProjectionStoreV2Shape["getThreadsWithPullRequests"] = (
      threadId,
    ) =>
      Effect.gen(function* () {
        const rows = yield* sql<PayloadRow>`
          SELECT payload_json
          FROM orchestration_v2_projection_threads
          WHERE deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND thread_id = ${threadId}`}
            AND archived_at IS NULL
            AND json_array_length(payload_json, '$.pullRequests') > 0
          ORDER BY updated_at ASC, thread_id ASC
        `;
        return yield* Effect.forEach(rows, (row) =>
          decodeThreadPayload(row.payload_json).pipe(
            Effect.map((thread): ProjectionThreadPullRequests => ({
              id: thread.id,
              projectId: thread.projectId,
              lineage: thread.lineage,
              settledOverride: thread.settledOverride,
              settledAt: thread.settledAt,
              pullRequests: thread.pullRequests ?? [],
            })),
          ),
        );
      }).pipe(Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })));

    const getExecutionResources: ProjectionStoreV2Shape["getExecutionResources"] = (
      threadId,
      pinsOnly,
    ) =>
      Effect.gen(function* () {
        // Ownership reads never materialize task prompts, results, or thread history.
        const rows = yield* sql<{
          task_id: string;
          owner_id: string;
          child_id: string;
          task_status: OrchestrationV2Subagent["status"];
          cwd: string | null;
        }>`
          SELECT task.subagent_id AS task_id, task.thread_id AS owner_id,
            task.child_thread_id AS child_id, COALESCE(json_extract(task.payload_json, '$.childActivity.status'), task.status) AS task_status,
            COALESCE(json_extract(child.payload_json, '$.worktreePath'), project.workspace_root) AS cwd
          FROM orchestration_v2_projection_subagents AS task
          LEFT JOIN orchestration_v2_projection_threads AS child ON child.thread_id = task.child_thread_id
          LEFT JOIN projection_projects AS project ON project.project_id = child.project_id
          WHERE ${threadId === undefined ? sql`1 = 1` : sql`task.thread_id = ${threadId}`}
            AND ${pinsOnly === true ? sql`COALESCE(json_extract(task.payload_json, '$.childActivity.status'), task.status) NOT IN ('completed', 'failed', 'cancelled', 'interrupted')` : sql`1 = 1`}
            AND task.child_thread_id IS NOT NULL
            AND json_extract(task.payload_json, '$.origin') = 'app_owned'
            AND json_extract(task.payload_json, '$.remote') IS NULL
        `;
        return rows.map((row) =>
          localExecutionResource(
            {
              id: NodeId.make(row.task_id),
              threadId: ThreadId.make(row.owner_id),
              childThreadId: ThreadId.make(row.child_id),
              status: row.task_status,
            },
            row.cwd,
          ),
        );
      }).pipe(Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })));

    // One read for the whole set: a chat can own hundreds of finished subagents, and dispatching
    // a stop to each one held its effect lane (and the stopped run's checkpoint) for 41 s.
    const getSubagentThreadsWithLiveWork: ProjectionStoreV2Shape["getSubagentThreadsWithLiveWork"] =
      (threadIds, liveThreadIds) =>
        threadIds.length === 0
          ? Effect.succeed(new Set<ThreadId>())
          : sql<{ readonly root_id: string }>`
              WITH RECURSIVE tree(root_id, thread_id, depth) AS (
                SELECT value, value, 0 FROM json_each(${encodeIdList(threadIds)})
                UNION
                SELECT tree.root_id, task.child_thread_id, tree.depth + 1
                FROM tree
                JOIN orchestration_v2_projection_subagents AS task
                  ON task.thread_id = tree.thread_id
                WHERE task.child_thread_id IS NOT NULL AND tree.depth < 16
              )
              SELECT DISTINCT tree.root_id AS root_id
              FROM tree
              WHERE tree.thread_id IN (SELECT value FROM json_each(${encodeIdList(liveThreadIds)}))
                OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_runs AS run
                  WHERE run.thread_id = tree.thread_id
                    AND run.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
                )
                OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_turn_items AS item
                  WHERE item.thread_id = tree.thread_id
                    AND item.type IN ('command_execution', 'dynamic_tool', 'subagent')
                    AND item.status IN ('pending', 'running', 'waiting')
                )
                OR EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_subagents AS live_task
                  WHERE live_task.thread_id = tree.thread_id
                    AND COALESCE(json_extract(live_task.payload_json, '$.childActivity.status'), live_task.status)
                      NOT IN ('completed', 'failed', 'cancelled', 'interrupted')
                )
            `.pipe(
              Effect.map((rows) => new Set(rows.map((row) => ThreadId.make(row.root_id)))),
              Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
            );

    const getThreadWorktreePaths: ProjectionStoreV2Shape["getThreadWorktreePaths"] = () =>
      sql<{ readonly thread_id: string; readonly worktree_path: string }>`
        SELECT thread_id, json_extract(payload_json, '$.worktreePath') AS worktree_path
        FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL
          AND archived_at IS NULL
          AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
      `.pipe(
        Effect.map((rows) =>
          rows.map((row) => ({
            threadId: ThreadId.make(row.thread_id),
            worktreePath: row.worktree_path,
          })),
        ),
        Effect.mapError((cause) => new ProjectionStoreSetupError({ cause })),
      );

    const shellThreadStateFromRow = (input: {
      readonly childRuns: ReadonlyArray<PendingBackgroundChildRun>;
      readonly row: ShellThreadRow;
      readonly runOrdinalsByThreadId: ReadonlyMap<ThreadId, Map<RunId, number>>;
      readonly itemCountsByThreadId: ReadonlyMap<ThreadId, Map<RunId, number>>;
      readonly providerThreadsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<OrchestrationV2ThreadProjection["providerThreads"][number]>
      >;
      readonly pendingTurnItemsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<OrchestrationV2TurnItem>
      >;
      readonly liveChildSubagentsByThreadId: ReadonlyMap<
        ThreadId,
        ReadonlyArray<PendingBackgroundWorkSubagent>
      >;
    }) =>
      Effect.gen(function* () {
        const {
          childRuns,
          row,
          runOrdinalsByThreadId,
          itemCountsByThreadId,
          providerThreadsByThreadId,
          pendingTurnItemsByThreadId,
          liveChildSubagentsByThreadId,
        } = input;
        const thread = yield* decodeThreadPayload(row.payload_json);
        const pendingRuntimeRequest =
          row.pending_request_payload_json !== null
            ? yield* decodeRuntimeRequestPayload(row.pending_request_payload_json)
            : row.pending_secret_request_payload_json !== null
              ? secretRequestAsPendingInput(
                  yield* decodeTurnItemPayload(row.pending_secret_request_payload_json),
                )
              : null;
        let terminalFailureItem =
          row.terminal_failure_payload_json === null
            ? null
            : yield* decodeTurnItemPayload(row.terminal_failure_payload_json);
        let latestRunId = row.latest_run_id === null ? null : RunId.make(row.latest_run_id);
        let latestRunStatus = shellStatusFromStoredRunStatus(row.latest_run_status);
        let latestRunRequestedAt =
          row.latest_run_requested_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_run_requested_at);
        let latestRunStartedAt =
          row.latest_run_started_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_run_started_at);
        let latestRunCompletedAt =
          row.latest_run_completed_at === null
            ? null
            : DateTime.makeUnsafe(row.latest_run_completed_at);
        if (row.blocking_run_id !== null) {
          const blockingFailure =
            row.blocking_failure_payload_json === null
              ? null
              : yield* decodeTurnItemPayload(row.blocking_failure_payload_json).pipe(
                  Effect.orElseSucceed(() => null),
                );
          const blocksQueue =
            threadErrorSummary(
              blockingFailure?.type === "error" ? blockingFailure.failure : null,
              row.last_error,
            ).lastErrorClass === "usage_limit";
          if (
            (blocksQueue && blockingFailure !== null) ||
            (latestRunStatus === "cancelled" && latestRunStartedAt === null)
          ) {
            terminalFailureItem = blockingFailure;
            latestRunId = RunId.make(row.blocking_run_id);
            latestRunStatus = "failed";
            latestRunRequestedAt =
              row.blocking_run_requested_at === null
                ? null
                : DateTime.makeUnsafe(row.blocking_run_requested_at);
            latestRunStartedAt =
              row.blocking_run_started_at === null
                ? null
                : DateTime.makeUnsafe(row.blocking_run_started_at);
            latestRunCompletedAt =
              row.blocking_run_completed_at === null
                ? null
                : DateTime.makeUnsafe(row.blocking_run_completed_at);
          }
        }
        const pendingBackgroundTasks = [
          ...derivePendingBackgroundWork({
            latestRun:
              latestRunId === null || latestRunStatus === "idle"
                ? null
                : {
                    id: latestRunId,
                    ordinal: 0,
                    status: latestRunStatus,
                  },
            providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
            turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
            activeProviderThreadId: thread.activeProviderThreadId,
            hasActiveRun: row.active_run_id !== null,
            pullRequests: thread.pullRequests,
            childRuns,
            subagents: liveChildSubagentsByThreadId.get(thread.id) ?? [],
          }),
        ];
        return {
          thread,
          latestRunId,
          latestRunStatus,
          latestRunRequestedAt,
          latestRunStartedAt,
          latestRunCompletedAt,
          activeRunId: row.active_run_id === null ? null : RunId.make(row.active_run_id),
          ...(deriveBlockedOnThreadWait({
            activeRun:
              row.active_run_id === null || row.active_run_status !== "running"
                ? null
                : { id: RunId.make(row.active_run_id), status: "running" },
            turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
          })
            ? { blockedOnThreadWait: true as const }
            : {}),
          activityRunStartedAt:
            row.activity_run_started_at === null
              ? null
              : DateTime.makeUnsafe(row.activity_run_started_at),
          activityRunStatus:
            row.activity_run_status === "preparing" ||
            row.activity_run_status === "starting" ||
            row.activity_run_status === "running" ||
            row.activity_run_status === "waiting"
              ? row.activity_run_status
              : null,
          ...threadErrorSummary(
            terminalFailureItem?.type === "error" ? terminalFailureItem.failure : null,
            row.last_error,
          ),
          pendingRuntimeRequest,
          latestUserMessageAt:
            row.latest_user_message_at === null
              ? null
              : DateTime.makeUnsafe(row.latest_user_message_at),
          latestUserAuthoredMessageAt:
            row.latest_user_authored_message_at === null
              ? null
              : DateTime.makeUnsafe(row.latest_user_authored_message_at),
          hasActionableProposedPlan: row.has_actionable_proposed_plan === 1,
          pendingBackgroundTasks,
          longRunningWork: longRunningWorkForShell({
            runs:
              row.activity_run_status !== null && row.active_run_id !== null
                ? [{ id: RunId.make(row.active_run_id), ordinal: 0, status: "running" }]
                : [],
            providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
            turnItems: pendingTurnItemsByThreadId.get(thread.id) ?? [],
            activeProviderThreadId: thread.activeProviderThreadId,
            pullRequests: thread.pullRequests,
            childRuns,
            subagents: liveChildSubagentsByThreadId.get(thread.id) ?? [],
          }),
          providerInstanceHistory: providerInstanceHistoryForShell({
            threadId: thread.id,
            providerThreads: providerThreadsByThreadId.get(thread.id) ?? [],
          }),
          goal: activeProviderGoalForShell(
            providerThreadsByThreadId.get(thread.id) ?? [],
            thread.activeProviderThreadId,
          ),
          itemCount: row.item_count,
          runlessItemCount: row.runless_item_count,
          updatedAt: thread.updatedAt,
          runOrdinalById: runOrdinalsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
          itemCountByRunId: itemCountsByThreadId.get(ThreadId.make(row.thread_id)) ?? new Map(),
        } satisfies ShellThreadState;
      });

    const shellSnapshotReadError = (cause: unknown) =>
      new ProjectionStoreReadError({ threadId: ThreadId.make("thread:shell"), cause });

    const readShellSnapshotRows = (options: ShellSnapshotOptions | undefined) =>
      Effect.gen(function* () {
        const targetThreadRows = yield* selectShellThreadRows(undefined, options);
        const targetThreadIds = new Set(
          targetThreadRows.map((row) => ThreadId.make(row.thread_id)),
        );
        const rowsByThreadId = new Map(
          targetThreadRows.map((row) => [ThreadId.make(row.thread_id), row] as const),
        );
        const pendingSourceIds = targetThreadRows.flatMap((row) =>
          row.forked_from_run_source_thread_id === null
            ? []
            : [ThreadId.make(row.forked_from_run_source_thread_id)],
        );
        while (pendingSourceIds.length > 0) {
          const sourceId = pendingSourceIds.pop();
          if (sourceId === undefined || rowsByThreadId.has(sourceId)) continue;
          const source = (yield* selectShellThreadRows(sourceId))[0];
          if (source === undefined) continue;
          rowsByThreadId.set(sourceId, source);
          if (source.forked_from_run_source_thread_id !== null) {
            pendingSourceIds.push(ThreadId.make(source.forked_from_run_source_thread_id));
          }
        }
        const threadRows = [...rowsByThreadId.values()];
        const threadIds = [...rowsByThreadId.keys()];
        const forkSourceIds = shellForkSourceIds(threadRows);
        const readForThreadIds = <A>(
          read: (ids: ReadonlyArray<ThreadId>) => Effect.Effect<ReadonlyArray<A>, unknown>,
          ids: ReadonlyArray<ThreadId> = threadIds,
        ) => (ids.length === 0 ? Effect.succeed([] as ReadonlyArray<A>) : read(ids));
        const [
          runRows,
          itemCountRows,
          sequenceRows,
          providerThreadRows,
          pendingTurnItemRows,
          liveChildSubagentRows,
        ] = yield* Effect.all([
          readForThreadIds(selectShellRunRows, forkSourceIds),
          readForThreadIds(selectShellRunItemCounts, forkSourceIds),
          sql<{ readonly snapshot_sequence: number | null }>`
        SELECT MAX(sequence) AS snapshot_sequence
        FROM orchestration_events INDEXED BY idx_orchestration_events_application_sequence
        WHERE application_event_version = 2
          AND aggregate_kind = 'thread'
      `,
          readForThreadIds(selectShellProviderThreadRows),
          readForThreadIds(selectShellPendingTurnItemRows),
          readForThreadIds(selectShellLiveChildSubagentRows),
        ]);
        return {
          targetThreadIds,
          omitIdleSubagents: options?.omitIdleSubagents,
          // Family rows stand in for idle children the shell omitted, so they keep their
          // boxes. Worktree reads only want ids and branches.
          includeBoxes: options?.allSubagentThreads !== true && options?.worktreePath === undefined,
          threadRows,
          runRows,
          itemCountRows,
          sequenceRows,
          providerThreadRows,
          pendingTurnItemRows,
          liveChildSubagentRows,
        };
      });

    const decodeShellSnapshot = ({
      targetThreadIds,
      omitIdleSubagents,
      includeBoxes,
      threadRows,
      runRows,
      itemCountRows,
      sequenceRows,
      providerThreadRows,
      pendingTurnItemRows,
      liveChildSubagentRows,
    }: Effect.Success<ReturnType<typeof readShellSnapshotRows>>) =>
      Effect.gen(function* () {
        const { runOrdinalsByThreadId, itemCountsByThreadId } = runMapsByThreadId({
          runRows,
          itemCountRows,
        });
        const {
          providerThreadsByThreadId,
          pendingTurnItemsByThreadId,
          liveChildSubagentsByThreadId,
          childRuns,
        } = yield* pendingBackgroundDataByThreadId({
          providerThreadRows,
          pendingTurnItemRows,
          liveChildSubagentRows,
        });
        const states = yield* Effect.forEach(threadRows, (row) =>
          shellThreadStateFromRow({
            childRuns,
            row,
            runOrdinalsByThreadId,
            itemCountsByThreadId,
            providerThreadsByThreadId,
            pendingTurnItemsByThreadId,
            liveChildSubagentsByThreadId,
          }),
        );
        const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));
        let targetStates = states.filter((state) => targetThreadIds.has(state.thread.id));
        if (omitIdleSubagents !== undefined) {
          const kept = omitIdleSubagentShells(
            targetStates.map((state) => ({
              ...state.thread,
              status: state.latestRunStatus,
              activityRunStatus: state.activityRunStatus,
              pendingRuntimeRequest: state.pendingRuntimeRequest,
              pendingBackgroundTasks: state.pendingBackgroundTasks,
              hasActionableProposedPlan: state.hasActionableProposedPlan,
            })),
            omitIdleSubagents,
          );
          const keptIds = new Set(kept.map((thread) => thread.id));
          targetStates = targetStates.filter((state) => keptIds.has(state.thread.id));
        }
        // Decoding runs after the rows' read transaction, so without its own reader transaction
        // these reads ran on the writer: synchronous, on the event loop, freezing every client.
        const boxes = includeBoxes ? yield* readShellBoxData(targetStates) : undefined;

        const shells = targetStates.map((state) =>
          shellFromState({
            stores,
            state,
            visibleItemCount: visibleItemCountForShell({
              threadId: state.thread.id,
              statesByThreadId,
            }),
            ...(boxes === undefined ? {} : { boxes }),
          }),
        );

        return {
          schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
          snapshotSequence: sequenceRows[0]?.snapshot_sequence ?? 0,
          threads: shells.filter((thread) => thread.archivedAt === null),
          archivedThreads: shells.filter((thread) => thread.archivedAt !== null),
        };
      }).pipe(Effect.mapError(shellSnapshotReadError));

    const readShellSnapshot: ProjectionStoreV2Shape["readShellSnapshot"] = (options) =>
      readShellSnapshotRows(options).pipe(
        Effect.mapError(shellSnapshotReadError),
        Effect.map(decodeShellSnapshot),
      );

    const getPullRequestSnapshot: ProjectionStoreV2Shape["getPullRequestSnapshot"] = Effect.fn(
      "ProjectionStore.getPullRequestSnapshot",
    )(function* ({ threadId, unsettledOnly = false }) {
      const { rows, sequenceRows } = yield* sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<PayloadRow>`
          SELECT t.payload_json FROM orchestration_v2_projection_threads t
          WHERE t.deleted_at IS NULL${
            threadId === undefined
              ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NULL`
              : sql` AND t.thread_id = ${threadId}`
          }${
            unsettledOnly
              ? sql` AND json_extract(t.payload_json, '$.settledAt') IS NULL
                AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'`
              : sql``
          }
          ORDER BY t.updated_at ASC, t.thread_id ASC
        `;
          const sequenceRows = yield* sql<{ readonly snapshot_sequence: number | null }>`
          SELECT MAX(sequence) AS snapshot_sequence
          FROM orchestration_events INDEXED BY idx_orchestration_events_application_sequence
          WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        `;
          return { rows, sequenceRows };
        }),
      );
      // Decode after releasing the reader, keeping rows and sequence from the same transaction.
      const threads = yield* Effect.forEach(rows, (row) =>
        decodePullRequestThread(row.payload_json).pipe(
          Effect.map((thread) => ({ ...thread, pullRequests: threadPullRequestsOf(thread) })),
        ),
      );
      return { snapshotSequence: sequenceRows[0]?.snapshot_sequence ?? 0, threads };
    }, Effect.mapError(shellSnapshotReadError));

    const getShellSnapshot: ProjectionStoreV2Shape["getShellSnapshot"] = (options) =>
      sql.withTransaction(readShellSnapshotRows(options)).pipe(
        // Off the event loop; inside an open write transaction it stays on the writer.
        NodeSqliteClient.readOnly,
        Effect.mapError(shellSnapshotReadError),
        Effect.flatMap(decodeShellSnapshot),
      );

    const getChatVisitSnapshot: ProjectionStoreV2Shape["getChatVisitSnapshot"] = () =>
      sql
        .withTransaction(
          Effect.all([
            readShellSnapshotRows({
              location: "active",
              unsettledOnly: true,
              excludeSubagents: true,
            }),
            // The chats `getShellSnapshot({ location: "active", unsettledOnly: true })` lists.
            sql<{ readonly thread_id: string; readonly last_visited_at: string | null }>`
              SELECT t.thread_id, json_extract(t.payload_json, '$.lastVisitedAt') AS last_visited_at
              FROM orchestration_v2_projection_threads t
              WHERE t.deleted_at IS NULL AND t.archived_at IS NULL${unsettledThreadsOnly()}
            `,
          ]),
        )
        .pipe(
          NodeSqliteClient.readOnly,
          Effect.mapError(shellSnapshotReadError),
          Effect.flatMap(([rows, markRows]) =>
            Effect.all([
              decodeShellSnapshot(rows),
              Effect.forEach(markRows, (row) =>
                decodeReadMark(row.last_visited_at).pipe(
                  Effect.map((lastVisitedAt): ProjectionReadMark => ({
                    threadId: ThreadId.make(row.thread_id),
                    lastVisitedAt,
                  })),
                ),
              ).pipe(Effect.mapError(shellSnapshotReadError)),
            ]),
          ),
          Effect.map(([snapshot, readMarks]) => ({ threads: snapshot.threads, readMarks })),
        );

    const getLiveThreadModels: ProjectionStoreV2Shape["getLiveThreadModels"] = Effect.fn(
      "ProjectionStore.getLiveThreadModels",
    )(function* () {
      // The first status list repeats the partial index's own condition word for word:
      // SQLite uses that index only when the query states it.
      const rows = yield* sql<PayloadRow>`
        SELECT t.payload_json FROM orchestration_v2_projection_threads t
        WHERE t.deleted_at IS NULL
          AND json_extract(t.payload_json, '$.archivedAt') IS NULL
          AND t.thread_id IN (
            SELECT r.thread_id FROM orchestration_v2_projection_runs r
            WHERE r.status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
              AND r.status <> 'queued'
          )
        ORDER BY t.thread_id ASC
      `;
      return yield* Effect.forEach(rows, (row) =>
        decodeLiveThreadModel(row.payload_json).pipe(
          Effect.map((thread): LiveThreadModel => ({
            threadId: thread.id,
            modelSelection: thread.modelSelection,
          })),
        ),
      );
    }, Effect.mapError(shellSnapshotReadError));

    // Per-thread shell for the live shell streams: reads only the target thread
    // plus its fork-source chain instead of materializing every thread. Returns
    // null when the thread is deleted or unknown.
    const getThreadShell: ProjectionStoreV2Shape["getThreadShell"] = (threadId) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            // Before the first read, which fixes this transaction's snapshot.
            const readEpoch = messageBoxWriteEpoch;
            const rowsByThreadId = new Map<ThreadId, ShellThreadRow>();
            const pending: Array<ThreadId> = [threadId];
            while (pending.length > 0) {
              const nextId = pending.pop();
              if (nextId === undefined || rowsByThreadId.has(nextId)) {
                continue;
              }
              const rows = yield* selectShellThreadRows(nextId);
              const row = rows[0];
              if (row === undefined) {
                continue;
              }
              rowsByThreadId.set(nextId, row);
              if (row.forked_from_run_source_thread_id !== null) {
                pending.push(ThreadId.make(row.forked_from_run_source_thread_id));
              }
            }
            if (!rowsByThreadId.has(threadId)) {
              return null;
            }

            const threadIds = [...rowsByThreadId.keys()];
            const forkSourceIds = shellForkSourceIds([...rowsByThreadId.values()]);
            const [
              runRows,
              itemCountRows,
              providerThreadRows,
              pendingTurnItemRows,
              liveChildSubagentRows,
            ] = yield* Effect.all([
              forkSourceIds.length === 0
                ? Effect.succeed([] as ReadonlyArray<ShellRunRow>)
                : selectShellRunRows(forkSourceIds),
              forkSourceIds.length === 0
                ? Effect.succeed([] as ReadonlyArray<ShellRunItemCountRow>)
                : selectShellRunItemCounts(forkSourceIds),
              selectShellProviderThreadRows(threadIds),
              selectShellPendingTurnItemRows(threadIds),
              selectShellLiveChildSubagentRows(threadIds),
            ]);
            const { runOrdinalsByThreadId, itemCountsByThreadId } = runMapsByThreadId({
              runRows,
              itemCountRows,
            });
            const {
              providerThreadsByThreadId,
              pendingTurnItemsByThreadId,
              liveChildSubagentsByThreadId,
              childRuns,
            } = yield* pendingBackgroundDataByThreadId({
              providerThreadRows,
              pendingTurnItemRows,
              liveChildSubagentRows,
            });

            const states = yield* Effect.forEach([...rowsByThreadId.values()], (row) =>
              shellThreadStateFromRow({
                childRuns,
                row,
                runOrdinalsByThreadId,
                itemCountsByThreadId,
                providerThreadsByThreadId,
                pendingTurnItemsByThreadId,
                liveChildSubagentsByThreadId,
              }),
            );
            const statesByThreadId = new Map(states.map((state) => [state.thread.id, state]));
            const state = statesByThreadId.get(threadId);
            if (state === undefined) {
              return null;
            }
            const boxes = yield* readShellBoxData([state], { inTransaction: { readEpoch } });
            return shellFromState({
              stores,
              state,
              visibleItemCount: visibleItemCountForShell({ threadId, statesByThreadId }),
              ...(boxes === undefined ? {} : { boxes }),
            });
          }),
        )
        .pipe(
          // Every live batch re-reads the touched chats for each connected
          // client; on the writer that blocked the event loop behind ingest.
          NodeSqliteClient.readOnly,
          Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })),
        );

    const getUsageBindings: ProjectionStoreV2Shape["getUsageBindings"] = (threadId, instanceIds) =>
      Effect.gen(function* () {
        // Both branches seek existing indexes and stop before decoding any history.
        const rows = yield* sql<{
          thread_id: string | null;
          owner_node_id: string | null;
          scope: "target" | "account";
          title: string;
          instance_id: string;
          native_id: string | null;
          parent_id: string | null;
        }>`
          SELECT 'target' AS scope, p.owner_node_id, p.thread_id, json_extract(t.payload_json, '$.title') AS title,
            p.provider_instance_id AS instance_id,
            json_extract(p.payload_json, '$.nativeThreadRef.nativeId') AS native_id,
            CASE WHEN json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
              THEN json_extract(t.payload_json, '$.lineage.parentThreadId') END AS parent_id
          FROM (
            SELECT thread_id, provider_instance_id, payload_json, owner_node_id
            FROM orchestration_v2_projection_provider_threads INDEXED BY orchestration_v2_projection_provider_threads_thread_idx
            WHERE thread_id = ${threadId} LIMIT 128
          ) AS p
          LEFT JOIN orchestration_v2_projection_threads AS t ON t.thread_id = p.thread_id
          UNION ALL
          SELECT 'account', p.owner_node_id, p.thread_id, json_extract(t.payload_json, '$.title'), p.provider_instance_id,
            json_extract(p.payload_json, '$.nativeThreadRef.nativeId'),
            CASE WHEN json_extract(t.payload_json, '$.lineage.relationshipToParent') = 'subagent'
              THEN json_extract(t.payload_json, '$.lineage.parentThreadId') END
          FROM (
            SELECT thread_id, provider_instance_id, payload_json, owner_node_id
            FROM orchestration_v2_projection_provider_threads INDEXED BY orchestration_v2_projection_provider_threads_instance_status_idx
            WHERE provider_instance_id IN ${sql.in(instanceIds.slice(0, 32))}
            LIMIT 2049
          ) AS p
          LEFT JOIN orchestration_v2_projection_threads AS t ON t.thread_id = p.thread_id
        `;
        const bindings = new Map<string, UsageProjectionBinding>();
        for (const row of rows) {
          if (!row.thread_id || !row.native_id || row.owner_node_id !== null) continue;
          const identity = `${row.instance_id}:${row.native_id}`;
          if (!bindings.has(identity))
            bindings.set(identity, {
              threadId: ThreadId.make(row.thread_id),
              title: row.title || "Chat",
              instanceId: ProviderInstanceId.make(row.instance_id),
              sessionId: row.native_id,
              parentThreadId: row.parent_id ? ThreadId.make(row.parent_id) : null,
            });
        }
        return {
          bindings: [...bindings.values()],
          truncated:
            rows.filter((row) => row.scope === "account").length >= 2049 ||
            rows.filter((row) => row.scope === "target").length >= 128 ||
            instanceIds.length > 32,
        };
      }).pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));

    const getUsageSubagentRuns: ProjectionStoreV2Shape["getUsageSubagentRuns"] = (threadIds) =>
      Effect.gen(function* () {
        if (threadIds.length === 0) return { runs: [], truncated: false };
        const rows = yield* sql<{
          run_id: string;
          thread_id: string;
          model: string;
          started_at: string | null;
        }>`
          SELECT run_id, thread_id, json_extract(payload_json, '$.modelSelection.model') AS model,
            json_extract(payload_json, '$.startedAt') AS started_at
          FROM orchestration_v2_projection_runs INDEXED BY orchestration_v2_projection_runs_thread_ordinal_idx
          WHERE thread_id IN ${sql.in(threadIds.slice(0, 256))} LIMIT 2049
        `;
        return {
          runs: rows
            .filter((row) => row.started_at !== null)
            .map((row) => ({
              id: row.run_id,
              threadId: ThreadId.make(row.thread_id),
              model: row.model || "Unknown model",
            })),
          truncated: rows.length >= 2049 || threadIds.length > 256,
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProjectionStoreReadError({
              threadId: threadIds[0] ?? ThreadId.make("usage"),
              cause,
            }),
        ),
      );

    const getUsageCompactions: ProjectionStoreV2Shape["getUsageCompactions"] = (threadId) =>
      Effect.gen(function* () {
        // Limit examined rows, not matching rows: a type filter before LIMIT could
        // otherwise walk the chat's entire turn-item history on the only reader.
        const rows = yield* sql<{ type: string; payload_json: string | null }>`
          SELECT type, CASE WHEN type = 'compaction' THEN json_remove(payload_json, '$.summary') END AS payload_json
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
          ORDER BY ordinal DESC, turn_item_id DESC LIMIT 2049
        `;
        const items = yield* decodeRows(
          decodeTurnItemPayload,
          threadId,
        )(rows.flatMap((row) => (row.payload_json ? [{ payload_json: row.payload_json }] : [])));
        return {
          items: items.filter(
            (item): item is Extract<OrchestrationV2TurnItem, { type: "compaction" }> =>
              item.type === "compaction",
          ),
          truncated: rows.length >= 2049,
        };
      }).pipe(Effect.mapError((cause) => new ProjectionStoreReadError({ threadId, cause })));

    const findNativeSessionThreads: ProjectionStoreV2Shape["findNativeSessionThreads"] = (
      sessions,
    ) =>
      Effect.gen(function* () {
        if (sessions.length === 0) return [];
        const selectors = yield* encodeNativeSessionSelectors(sessions);
        const rows = yield* sql<{
          readonly provider_instance_id: string;
          readonly native_id: string;
          readonly thread_id: string;
        }>`
        SELECT provider.provider_instance_id, json_extract(provider.payload_json, '$.nativeThreadRef.nativeId') AS native_id, thread.thread_id
        FROM orchestration_v2_projection_provider_threads AS provider
        INNER JOIN orchestration_v2_projection_threads AS thread ON thread.active_provider_thread_id = provider.provider_thread_id
        WHERE thread.deleted_at IS NULL AND provider.owner_node_id IS NULL
          AND EXISTS (SELECT 1 FROM json_each(${selectors}) AS wanted
            WHERE json_extract(wanted.value, '$.providerInstanceId') = provider.provider_instance_id
              AND json_extract(wanted.value, '$.nativeId') = json_extract(provider.payload_json, '$.nativeThreadRef.nativeId'))
        ORDER BY thread.updated_at DESC, thread.thread_id
      `;
        return rows.map((row) => ({
          providerInstanceId: row.provider_instance_id,
          nativeId: row.native_id,
          threadId: ThreadId.make(row.thread_id),
        }));
      }).pipe(Effect.mapError((cause) => new ProjectionStoreNativeSessionReadError({ cause })));

    const getSubagentActivityState: ProjectionStoreV2Shape["getSubagentActivityState"] = (
      childThreadId,
    ) =>
      Effect.gen(function* () {
        // Use the child's assignment and node indexes. Older cards only need decoding
        // if they already carry an overlay that this refresh must remove.
        const rows = yield* sql<PayloadRow & { original_id: string; item_json: string | null }>`
          WITH assignments AS (
            SELECT task.subagent_id, json_extract(child.payload_json, '$.forkedFrom.nodeId') AS original_id,
              row_number() OVER (ORDER BY task.started_at DESC, task.rowid DESC) AS position
            FROM orchestration_v2_projection_threads child
            JOIN orchestration_v2_projection_subagents task ON task.child_thread_id = child.thread_id
            WHERE child.thread_id = ${childThreadId} AND child.deleted_at IS NULL
              AND json_extract(child.payload_json, '$.lineage.relationshipToParent') = 'subagent'
              AND json_type(child.payload_json, '$.lineage.parentEnvironmentId') IS NULL
              AND task.origin = 'app_owned' AND json_type(task.payload_json, '$.remote') IS NULL
              AND task.thread_id = json_extract(child.payload_json, '$.lineage.parentThreadId')
          )
          SELECT task.payload_json, a.original_id, item.payload_json AS item_json FROM assignments a
          JOIN orchestration_v2_projection_subagents task ON task.subagent_id = a.subagent_id
          LEFT JOIN orchestration_v2_projection_turn_items item ON item.turn_item_id = (
            SELECT turn_item_id FROM orchestration_v2_projection_turn_items
            WHERE node_id = task.subagent_id AND type = 'subagent' ORDER BY ordinal LIMIT 1
          )
          WHERE a.position = 1 OR json_type(task.payload_json, '$.childActivity') = 'object'
            OR json_type(item.payload_json, '$.childActivity') = 'object'
          ORDER BY a.position
        `;
        const cards = yield* Effect.forEach(rows, (row) =>
          Effect.gen(function* () {
            return {
              task: yield* decodeSubagentPayload(row.payload_json),
              item:
                row.item_json === null ? undefined : yield* decodeTurnItemPayload(row.item_json),
            };
          }),
        );
        const newest = cards[0]?.task;
        if (!newest || (newest.id === rows[0]!.original_id && newest.result === null))
          return activityOnNewestCard(cards);
        const [first] = yield* sql<{ readonly ordinal: number }>`
          SELECT ordinal FROM orchestration_v2_projection_runs
          WHERE thread_id = ${childThreadId} ORDER BY ordinal LIMIT 1
        `;
        if (first === undefined) return activityOnNewestCard(cards);
        const [active] = yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runs
            INDEXED BY orchestration_v2_projection_runs_thread_status_idx
          WHERE thread_id = ${childThreadId} AND ordinal > ${first.ordinal}
            AND status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
            AND NOT (status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1)
          ORDER BY ordinal DESC LIMIT 1
        `;
        const latest =
          active === undefined
            ? (yield* sql<PayloadRow>`
          SELECT payload_json FROM orchestration_v2_projection_runs
          WHERE thread_id = ${childThreadId} AND ordinal > ${first.ordinal}
            AND NOT (status = 'queued' AND json_extract(payload_json, '$.queueHeld') IS 1)
          ORDER BY ordinal DESC LIMIT 1
        `)[0]
            : active;
        if (latest === undefined) return activityOnNewestCard(cards);
        const run = yield* decodeRunPayload(latest.payload_json);
        if (newest.id !== rows[0]!.original_id) {
          if (newest.startedAt && DateTime.isLessThan(run.requestedAt, newest.startedAt))
            return activityOnNewestCard(cards);
          // Walk only this candidate's ancestry. An old steered assignment may
          // have lost its run binding; its original timestamp and message survive.
          const ownership = yield* sql<{ owned: number }>`
            WITH RECURSIVE ancestry(id) AS (
              SELECT ${run.id}
              UNION
              SELECT COALESCE(json_extract(r.payload_json, '$.restartContinuationOfRunId'),
                json_extract(r.payload_json, '$.providerRetryContinuationOfRunId'),
                json_extract(m.payload_json, '$.delegatedCompletion.parentRunId'))
              FROM ancestry JOIN orchestration_v2_projection_runs r ON r.run_id = ancestry.id
              LEFT JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(r.payload_json, '$.userMessageId')
            )
            SELECT 1 AS owned FROM ancestry JOIN orchestration_v2_projection_runs r ON r.run_id = ancestry.id
            WHERE r.thread_id = ${childThreadId} AND (r.ordinal = ${first.ordinal}
              OR json_extract(r.payload_json, '$.delegatedTaskId') IS NOT NULL
              OR EXISTS (
                SELECT 1 FROM orchestration_v2_projection_messages m
                JOIN orchestration_v2_projection_subagents t ON t.child_thread_id = r.thread_id AND t.started_at = m.created_at
                WHERE m.run_id = r.run_id AND m.role = 'user' AND t.origin = 'app_owned'
                  AND json_extract(m.payload_json,'$.text') = json_extract(t.payload_json,'$.prompt')
              ))
            LIMIT 1
          `;
          if (ownership.length > 0) return activityOnNewestCard(cards);
        }
        const [reply] =
          active !== undefined
            ? []
            : yield* sql<{ readonly text: string | null }>`
          SELECT COALESCE(
            (SELECT substr(json_extract(payload_json, '$.text'), 1, 32768)
             FROM orchestration_v2_projection_messages
               INDEXED BY orchestration_v2_projection_messages_run_idx
             WHERE run_id = ${run.id} AND role = 'assistant'
             ORDER BY rowid DESC LIMIT 1),
            (SELECT substr(json_extract(payload_json, '$.text'), 1, 32768)
             FROM (
               SELECT payload_json, type, ordinal
               FROM orchestration_v2_projection_turn_items
               WHERE run_id = ${run.id} ORDER BY ordinal DESC LIMIT 64
             )
             WHERE type = 'assistant_message' ORDER BY ordinal DESC LIMIT 1)
          ) AS text
        `;
        return activityOnNewestCard(cards, run, reply?.text ?? null);
      }).pipe(NodeSqliteClient.readOnly, Effect.mapError(controlReadError(childThreadId)));

    const prepareSubagentRankings = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        if (Option.isNone(rankings)) return [];
        const latest = new Map(
          events.flatMap((event) =>
            event.type === "subagent.updated" && event.payload.childActivity === undefined
              ? [[event.payload.id, event.payload] as const]
              : [],
          ),
        );
        const tasks = [...latest.values()].filter((task) =>
          terminalRunRecord(task, { isolated: false, fixRounds: 0 }),
        );
        if (tasks.length === 0) return [];
        const providers = Option.isSome(rankingProviders)
          ? yield* rankingProviders.value.getProviders
          : [];
        const records = [];
        for (const task of tasks) {
          const child =
            task.childThreadId === null
              ? undefined
              : yield* getThreadRecords(task.childThreadId, ["runs", "messages"], {
                  messageRoles: ["user"],
                });
          // t3_thread_send creates another task for the same child, not another model run.
          if (
            child?.thread.forkedFrom?.type === "node" &&
            child.thread.forkedFrom.nodeId !== task.id
          )
            continue;
          const runs =
            child === undefined
              ? []
              : delegatedTaskRuns(child, task).filter(
                  (run) =>
                    DateTime.toEpochMillis(run.completedAt ?? run.requestedAt) <=
                    DateTime.toEpochMillis(task.completedAt ?? task.updatedAt),
                );
          const resultRun = runs
            .filter((run) => TERMINAL_RUN_STATUSES.has(run.status))
            .toSorted((a, b) => b.ordinal - a.ordinal)[0];
          const rankedTask =
            resultRun === undefined
              ? task
              : {
                  ...task,
                  modelSelection: resultRun.modelSelection,
                  providerInstanceId: resultRun.providerInstanceId,
                };
          const metadata =
            task.childThreadId === null
              ? []
              : yield* sql<{
                  readonly title: string;
                  readonly isolated: number;
                  readonly fix_rounds: number;
                  readonly failure_json: string | null;
                  readonly has_assistant_output: number;
                }>`
            SELECT child.title,
              (EXISTS (SELECT 1 FROM orchestration_v2_projection_messages AS message
                WHERE ${task.status} = 'failed' AND message.thread_id = child.thread_id AND message.role = 'assistant'
                  AND length(trim(json_extract(message.payload_json, '$.text'), char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) > 0
                  AND message.run_id IN (SELECT value FROM json_each(${encodeIdList(runs.map((run) => run.id))})))
              OR EXISTS (SELECT 1 FROM orchestration_v2_projection_turn_items AS item
                WHERE ${task.status} = 'failed' AND item.thread_id = child.thread_id AND item.type = 'assistant_message'
                  AND length(trim(json_extract(item.payload_json, '$.text'), char(9) || char(10) || char(11) || char(12) || char(13) || ' ')) > 0
                  AND item.run_id IN (SELECT value FROM json_each(${encodeIdList(runs.map((run) => run.id))})))) AS has_assistant_output,
              (SELECT json_extract(item.payload_json, '$.failure') FROM orchestration_v2_projection_turn_items AS item
                WHERE ${task.status} = 'failed' AND item.thread_id = child.thread_id AND item.type = 'error'
                  AND item.run_id = ${resultRun?.id ?? null}
                ORDER BY item.ordinal DESC LIMIT 1
              ) AS failure_json,
              json_extract(child.payload_json, '$.worktreePath') IS NOT NULL AND json_extract(child.payload_json, '$.worktreePath') IS NOT json_extract(parent.payload_json, '$.worktreePath') AS isolated,
              (SELECT MAX(0, COUNT(*) - 1) FROM orchestration_v2_projection_messages AS message
                WHERE message.thread_id = child.thread_id AND message.role = 'user'
                  AND json_extract(message.payload_json, '$.senderThreadId') = ${task.threadId}
                  AND message.created_at <= ${DateTime.formatIso(task.completedAt ?? task.updatedAt)}
                  AND message.created_at >= ${DateTime.formatIso(task.startedAt ?? task.completedAt ?? task.updatedAt)}
                  ${runs.length === 0 ? sql`AND 0` : sql`AND message.run_id IN (SELECT value FROM json_each(${encodeIdList(runs.map((run) => run.id))}))`}
              ) AS fix_rounds
            FROM orchestration_v2_projection_threads AS child
            LEFT JOIN orchestration_v2_projection_threads AS parent ON parent.thread_id = ${task.threadId}
            WHERE child.thread_id = ${task.childThreadId}
          `;
          const row = metadata[0];
          const provider = providers.find(
            (p) =>
              p.instanceId ===
              (rankedTask.modelSelection?.instanceId ?? rankedTask.providerInstanceId),
          );
          const providerFailure =
            row?.failure_json == null ? Option.none() : decodeRankingFailure(row.failure_json);
          const record = terminalRunRecord(rankedTask, {
            ...(row === undefined ? {} : { title: row.title }),
            ...(Option.isSome(providerFailure) ? { providerFailure: providerFailure.value } : {}),
            isolated: row?.isolated === 1,
            fixRounds: row?.fix_rounds ?? 0,
            hasAssistantOutput: row?.has_assistant_output === 1,
            ...(provider === undefined ? {} : { provider }),
          });
          if (record) records.push(record);
        }
        return records;
      }).pipe(
        Effect.map((records) =>
          Option.isNone(rankings)
            ? Effect.void
            : rankings.value
                .record(records)
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not record subagent rankings.", { cause }),
                  ),
                ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not prepare subagent rankings.", { cause }).pipe(
            Effect.as(Effect.void),
          ),
        ),
      );

    /**
     * The ask stays open while a chat's first app-owned subagent runs. Rowid is
     * insertion order, so the thread's lowest app-owned row is its first
     * subagent. Each chat is looked up once per process; later events only
     * close the ask when that subagent stops.
     */
    const prepareFirstSubagentAsk = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
      Effect.gen(function* () {
        const latest = new Map<ThreadId, Map<NodeId, OrchestrationV2Subagent["status"]>>();
        for (const event of events) {
          if (event.type !== "subagent.updated" || event.payload.origin !== "app_owned") continue;
          const tasks = latest.get(event.payload.threadId) ?? new Map();
          tasks.set(event.payload.id, event.payload.status);
          latest.set(event.payload.threadId, tasks);
        }
        const asks: Array<readonly [ThreadId, string | null]> = [];
        for (const [threadId, tasks] of latest) {
          if (chatControls.firstSubagentChecked(threadId)) {
            const ask = chatControls.firstSubagentAsk(threadId);
            const status = ask === null ? undefined : tasks.get(NodeId.make(ask));
            if (status !== undefined && !isOrchestrationV2WorkActive(status))
              asks.push([threadId, null]);
            continue;
          }
          const [first] = yield* sql<{
            readonly subagent_id: string;
            readonly status: OrchestrationV2Subagent["status"];
            readonly created_by: string | null;
          }>`
            SELECT subagent_id, status, json_extract(payload_json, '$.createdBy') AS created_by
            FROM orchestration_v2_projection_subagents
            WHERE thread_id = ${threadId} AND origin = 'app_owned'
            ORDER BY rowid LIMIT 1
          `;
          asks.push([
            threadId,
            // A subagent the user started themselves leaves nothing to ask them.
            first !== undefined &&
            first.created_by !== "user" &&
            isOrchestrationV2WorkActive(first.status)
              ? first.subagent_id
              : null,
          ]);
        }
        return Effect.sync(() => {
          for (const [threadId, ask] of asks) chatControls.setFirstSubagentAsk(threadId, ask);
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not check the first subagent.", { cause }).pipe(
            Effect.as(Effect.void),
          ),
        ),
      );

    return {
      getSubagentActivityState,
      findNativeSessionThreads,
      getUsageBindings: (threadId, instanceIds) =>
        getUsageBindings(threadId, instanceIds).pipe(NodeSqliteClient.readOnly),
      getUsageCompactions: (threadId) =>
        getUsageCompactions(threadId).pipe(NodeSqliteClient.readOnly),
      getUsageSubagentRuns: (threadIds) =>
        getUsageSubagentRuns(threadIds).pipe(NodeSqliteClient.readOnly),
      prepareSubagentRankings,
      prepareFirstSubagentAsk,
      prepareMessageBoxInvalidation,
      apply,
      getShellSnapshot,
      getChatVisitSnapshot,
      getLiveThreadModels,
      readShellSnapshot,
      getThreadShell,
      getThread,
      getSettlementCandidates,
      getThreadsWithPullRequests,
      getThreadWorktreePaths,
      getExecutionResources,
      getSubagentThreadsWithLiveWork,
      getPullRequestSnapshot: (options) =>
        getPullRequestSnapshot(options).pipe(NodeSqliteClient.readOnly),
      getThreadProjection,
      getTurnStartContext,
      getTurnStartHistory,
      getRuntimeRecoveryProjection,
      getRunningTurnContext,
      getThreadProviderContext,
      getRuntimeResponseContext,
      getCheckpointContext,
      getCheckpointCaptureContext,
      getRunMessage,
      canStartQueuedRun,
      getReportedContextWindow,
      getPendingNativeUserInputs,
      hasUnpairedRunInterruptRequest,
      isNodeStored,
      getMessageDispatchProjection,
      getMessageCount,
      hasMessages,
      hasStartedRunAfter,
      getNextTurnItemOrdinal,
      getTurnItem,
      getThreadRecords,
      getRuntimeRequest,
      getPendingChildQuestions,
      getPlan,
      getProviderControlContext,
      getLimitRecoveryCandidates,
      getSignedOutStops,
      getProviderRetryCandidates,
      getIdleDelegatedTaskThreadIds,
      getRecoveryThreadIds,
      getUnreadableThreadIds,
      getThreadSnapshot,
      getThreadSnapshotWindow,
      getTimelinePage,
      getThreadHistoryPage,
      getThreadMediaPage,
      searchThread,
      searchThreadStream,
      getThreadAttachmentIds,
    } satisfies ProjectionStoreV2Shape;
  }),
);

export const layerMemory: Layer.Layer<ProjectionStoreV2> = Layer.effect(
  ProjectionStoreV2,
  Effect.gen(function* () {
    const boxFaces = Option.getOrElse(
      yield* Effect.serviceOption(BoxFaces.BoxFaces),
      () => BoxFaces.make().store,
    );
    const chatTabs = Option.getOrElse(
      yield* Effect.serviceOption(ChatTabs.ChatTabs),
      () => ChatTabs.make().store,
    );
    const chatControls = Option.getOrElse(
      yield* Effect.serviceOption(ChatControls.ChatControls),
      () => ChatControls.make().store,
    );
    const shellSchedules = Option.getOrUndefined(
      yield* Effect.serviceOption(ScheduledTaskShells.ScheduledTaskShells),
    );
    const stores = {
      boxFaces,
      chatTabs,
      chatControls,
      ...(shellSchedules === undefined ? {} : { shellSchedules }),
    };
    const replayState = yield* Ref.make(makeProjectionReplayState());
    const sequence = yield* Ref.make(0);

    const service: ProjectionStoreV2Shape = {
      getUsageSubagentRuns: (threadIds) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => ({
            runs: threadIds.flatMap((id) =>
              (state.projections.get(id)?.runs ?? [])
                .filter((run) => run.startedAt !== null)
                .map((run) => ({ id: run.id, threadId: id, model: run.modelSelection.model })),
            ),
            truncated: false,
          })),
        ),
      getSubagentActivityState: (childThreadId) =>
        Effect.gen(function* () {
          const projections = (yield* Ref.get(replayState)).projections;
          const child = projections.get(childThreadId);
          if (
            child?.thread.lineage.relationshipToParent !== "subagent" ||
            child.thread.lineage.parentEnvironmentId !== undefined ||
            child.thread.lineage.parentThreadId === null ||
            child.thread.forkedFrom?.type !== "node"
          )
            return [];
          const parent = projections.get(child.thread.lineage.parentThreadId);
          if (!parent || child.thread.deletedAt !== null) return [];
          const tasks = parent.subagents
            .filter(
              (task) =>
                task.origin === "app_owned" && !task.remote && task.childThreadId === childThreadId,
            )
            .toReversed()
            .sort(
              (a, b) =>
                (b.startedAt ? DateTime.toEpochMillis(b.startedAt) : 0) -
                (a.startedAt ? DateTime.toEpochMillis(a.startedAt) : 0),
            );
          const cards = tasks.map((task) => ({
            task,
            item: parent.turnItems.find(
              (item) => item.type === "subagent" && item.subagentId === task.id,
            ),
          }));
          const newest = tasks[0];
          if (!newest || (newest.id === child.thread.forkedFrom.nodeId && newest.result === null))
            return activityOnNewestCard(cards);
          const first = child.runs.toSorted((a, b) => a.ordinal - b.ordinal)[0];
          const later = child.runs
            .filter(
              (run) =>
                first !== undefined &&
                run.ordinal > first.ordinal &&
                !(run.status === "queued" && run.queueHeld === true),
            )
            .toSorted((a, b) => b.ordinal - a.ordinal);
          const run = later.find((run) => !TERMINAL_RUN_STATUSES.has(run.status)) ?? later[0];
          if (!run) return activityOnNewestCard(cards);
          if (newest.id !== child.thread.forkedFrom.nodeId) {
            if (newest.startedAt && DateTime.isLessThan(run.requestedAt, newest.startedAt))
              return activityOnNewestCard(cards);
            const visited = new Set<RunId>();
            let source: OrchestrationV2Run | undefined = run;
            while (source && !visited.has(source.id)) {
              if (
                source.id === first?.id ||
                source.delegatedTaskId !== undefined ||
                tasks.some((task) =>
                  followupRunsByMessage(child, task).some((bound) => bound.id === source?.id),
                )
              )
                return activityOnNewestCard(cards);
              visited.add(source.id);
              const message = child.messages.find((m) => m.id === source?.userMessageId);
              const previous: RunId | undefined =
                source.restartContinuationOfRunId ??
                source.providerRetryContinuationOfRunId ??
                message?.delegatedCompletion?.parentRunId;
              source = child.runs.find((r) => r.id === previous);
            }
          }
          const reply = child.turnItems
            .toReversed()
            .find((item) => item.runId === run?.id && item.type === "assistant_message");
          return activityOnNewestCard(
            cards,
            run,
            child.messages
              .toReversed()
              .find((message) => message.runId === run.id && message.role === "assistant")
              ?.text.slice(0, 32768) ??
              (reply?.type === "assistant_message" ? reply.text.slice(0, 32768) : null),
          );
        }),
      getUsageBindings: (threadId, instanceIds) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => ({
            bindings: [...state.projections.values()].flatMap((projection) =>
              projection.providerThreads
                .filter(
                  (p) =>
                    p.ownerNodeId === null &&
                    (projection.thread.id === threadId ||
                      instanceIds.includes(p.providerInstanceId)),
                )
                .flatMap((p) =>
                  p.nativeThreadRef?.nativeId
                    ? [
                        {
                          threadId: projection.thread.id,
                          title: projection.thread.title,
                          instanceId: p.providerInstanceId,
                          sessionId: p.nativeThreadRef.nativeId,
                          parentThreadId:
                            projection.thread.lineage.relationshipToParent === "subagent"
                              ? projection.thread.lineage.parentThreadId
                              : null,
                        },
                      ]
                    : [],
                ),
            ),
            truncated: false,
          })),
        ),
      getUsageCompactions: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => ({
            items: (state.projections.get(threadId)?.turnItems ?? []).filter(
              (item): item is Extract<OrchestrationV2TurnItem, { type: "compaction" }> =>
                item.type === "compaction",
            ),
            truncated: false,
          })),
        ),
      findNativeSessionThreads: (sessions) =>
        Effect.gen(function* () {
          const projections = (yield* Ref.get(replayState)).projections;
          return [...projections.values()]
            .filter((projection) => projection.thread.deletedAt === null)
            .flatMap((projection) =>
              projection.providerThreads.flatMap((provider) => {
                const nativeId = provider.nativeThreadRef?.nativeId;
                return projection.thread.activeProviderThreadId === provider.id &&
                  provider.ownerNodeId === null &&
                  nativeId &&
                  sessions.some(
                    (session) =>
                      session.providerInstanceId === provider.providerInstanceId &&
                      session.nativeId === nativeId,
                  )
                  ? [
                      {
                        providerInstanceId: provider.providerInstanceId,
                        nativeId,
                        threadId: projection.thread.id,
                      },
                    ]
                  : [];
              }),
            );
        }),
      apply: (event) =>
        Effect.gen(function* () {
          const result = yield* Ref.modify(replayState, (existing) => {
            const next: ProjectionReplayState = {
              projections: new Map(existing.projections),
              providerSessionThreadIds: new Map(existing.providerSessionThreadIds),
            };
            if (!applyToProjectionReplayState(next, event)) {
              return [
                new ProjectionStoreThreadNotFoundError({ threadId: event.threadId }),
                existing,
              ] as const;
            }
            return [undefined, next] as const;
          });

          if (result) {
            return yield* result;
          }
          yield* Ref.update(sequence, (current) => current + 1);
        }),
      getPullRequestSnapshot: (options) =>
        service.getShellSnapshot({}).pipe(
          Effect.map((snapshot) => ({
            snapshotSequence: snapshot.snapshotSequence,
            threads: [...snapshot.threads, ...snapshot.archivedThreads]
              .filter((thread) =>
                options.threadId === undefined
                  ? thread.archivedAt === null
                  : thread.id === options.threadId,
              )
              .filter(
                (thread) =>
                  !options.unsettledOnly ||
                  (thread.settledAt === null && thread.settledOverride !== "settled"),
              )
              .map(
                ({
                  id,
                  projectId,
                  lineage,
                  branch,
                  worktreePath,
                  archivedAt,
                  settledOverride,
                  settledAt,
                  linkedPullRequest,
                  branchPullRequest,
                  pullRequests,
                }) => ({
                  id,
                  projectId,
                  lineage,
                  branch,
                  worktreePath,
                  archivedAt,
                  settledOverride,
                  settledAt,
                  linkedPullRequest,
                  branchPullRequest,
                  pullRequests: threadPullRequestsOf({
                    pullRequests,
                    linkedPullRequest,
                  }),
                }),
              ),
          })),
        ),
      getShellSnapshot: (options) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(replayState)).projections;
          const selectedThreadIds = [...existing.entries()]
            .filter(([, projection]) => {
              if (
                options?.projectId !== undefined &&
                projection.thread.projectId !== options.projectId
              ) {
                return false;
              }
              if (
                options?.unsettledOnly &&
                (projection.thread.settledAt !== null ||
                  projection.thread.settledOverride === "settled")
              ) {
                return false;
              }
              if (
                (options?.allSubagentThreads === true || options?.subagentFamilyOf !== undefined) &&
                projection.thread.lineage.relationshipToParent !== "subagent"
              )
                return false;
              if (
                options?.excludeSubagents === true &&
                projection.thread.lineage.relationshipToParent === "subagent"
              )
                return false;
              if (
                options?.subagentFamilyOf !== undefined &&
                projection.thread.lineage.rootThreadId !==
                  existing.get(options.subagentFamilyOf)?.thread.lineage.rootThreadId
              )
                return false;
              if (
                options?.worktreePath !== undefined &&
                projection.thread.worktreePath !== options.worktreePath
              )
                return false;
              if (options?.location === "active") return projection.thread.archivedAt === null;
              if (options?.location === "archive") return projection.thread.archivedAt !== null;
              return true;
            })
            .map(([threadId]) => threadId);
          const shells = yield* Effect.forEach(
            selectedThreadIds.toSorted((left, right) => String(left).localeCompare(String(right))),
            (threadId) =>
              service
                .getThreadProjection(threadId)
                .pipe(
                  Effect.map((projection) =>
                    threadShellFromProjection(projection, existing, stores),
                  ),
                ),
          );
          const visible = shells.filter((thread) => thread.deletedAt === null);
          const active = visible.filter((thread) => thread.archivedAt === null);
          return {
            schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
            snapshotSequence: yield* Ref.get(sequence),
            threads:
              options?.omitIdleSubagents === undefined
                ? active
                : omitIdleSubagentShells(active, options.omitIdleSubagents),
            archivedThreads: visible.filter((thread) => thread.archivedAt !== null),
          };
        }),
      getChatVisitSnapshot: () =>
        service.getShellSnapshot({ location: "active", unsettledOnly: true }).pipe(
          Effect.map((snapshot) => ({
            threads: snapshot.threads.filter(
              (thread) => thread.lineage.relationshipToParent !== "subagent",
            ),
            readMarks: snapshot.threads.map((thread) => ({
              threadId: thread.id,
              lastVisitedAt: thread.lastVisitedAt ?? null,
            })),
          })),
        ),
      getLiveThreadModels: () =>
        service
          .getShellSnapshot()
          .pipe(Effect.map((snapshot) => liveThreadModelsOf(snapshot.threads))),
      readShellSnapshot: (options) =>
        service.getShellSnapshot(options).pipe(Effect.map(Effect.succeed)),
      getThreadShell: (threadId) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(replayState)).projections;
          if (!existing.has(threadId)) {
            return null;
          }
          const shell = yield* service
            .getThreadProjection(threadId)
            .pipe(
              Effect.map((projection) => threadShellFromProjection(projection, existing, stores)),
            );
          return shell.deletedAt === null ? shell : null;
        }),
      getThread: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return projection.thread;
        }),
      getSettlementCandidates: (threadId) =>
        Effect.gen(function* () {
          const projections = (yield* Ref.get(replayState)).projections;
          return [...projections.values()]
            .filter(
              ({ thread, runs, runtimeRequests, messages }) =>
                (threadId === undefined || thread.id === threadId) &&
                thread.deletedAt === null &&
                thread.archivedAt === null &&
                thread.settledOverride === null &&
                thread.pinnedAt == null &&
                thread.autoSettleDisabledAt == null &&
                !runs.some(isActivityRunForShell) &&
                !runtimeRequests.some((request) => request.status === "pending") &&
                !projectionHasBlockingQueuedRun({ runs, messages }),
            )
            .map((projection) => {
              const shell = threadShellFromProjection(projection, projections, stores);
              return {
                ...shell,
                lastSnoozeWakeAt: projection.thread.lastSnoozeWakeAt ?? null,
                latestUserAuthoredMessageAt: shell.latestUserAuthoredMessageAt ?? null,
              };
            })
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(left.updatedAt) - DateTime.toEpochMillis(right.updatedAt) ||
                left.id.localeCompare(right.id),
            );
        }),
      getSubagentThreadsWithLiveWork: (threadIds, liveThreadIds) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => {
            const liveOwners = new Set(liveThreadIds);
            const hasLiveWork = (threadId: ThreadId) => {
              if (liveOwners.has(threadId)) return true;
              const projection = state.projections.get(threadId);
              if (projection === undefined) return false;
              return (
                projection.runs.some((run) =>
                  ["queued", "preparing", "starting", "running", "waiting"].includes(run.status),
                ) ||
                projection.turnItems.some(
                  (item) =>
                    ["command_execution", "dynamic_tool", "subagent"].includes(item.type) &&
                    ["pending", "running", "waiting"].includes(item.status),
                ) ||
                projection.subagents.some(
                  (task) =>
                    !["completed", "failed", "cancelled", "interrupted"].includes(
                      task.childActivity?.status ?? task.status,
                    ),
                )
              );
            };
            const live = new Set<ThreadId>();
            for (const root of threadIds) {
              const seen = new Set<ThreadId>();
              const pending = [root];
              while (pending.length > 0) {
                const threadId = pending.pop()!;
                if (seen.has(threadId)) continue;
                seen.add(threadId);
                if (hasLiveWork(threadId)) {
                  live.add(root);
                  break;
                }
                for (const task of state.projections.get(threadId)?.subagents ?? []) {
                  if (task.childThreadId !== null) pending.push(task.childThreadId);
                }
              }
            }
            return live as ReadonlySet<ThreadId>;
          }),
        ),
      getExecutionResources: (threadId, pinsOnly) =>
        Ref.get(replayState).pipe(
          Effect.map((state) =>
            [...state.projections.values()].flatMap((projection) =>
              projection.subagents.flatMap((task) => {
                if (
                  task.origin !== "app_owned" ||
                  task.remote !== undefined ||
                  task.childThreadId === null ||
                  (threadId !== undefined && task.threadId !== threadId) ||
                  (pinsOnly === true &&
                    ["completed", "failed", "cancelled", "interrupted"].includes(
                      task.childActivity?.status ?? task.status,
                    ))
                )
                  return [];
                const child = state.projections.get(task.childThreadId)?.thread;
                return [
                  localExecutionResource(
                    { ...task, status: task.childActivity?.status ?? task.status },
                    child?.worktreePath ?? null,
                  ),
                ];
              }),
            ),
          ),
        ),
      getThreadWorktreePaths: () =>
        Ref.get(replayState).pipe(
          Effect.map((state) =>
            [...state.projections.values()].flatMap(({ thread }) =>
              thread.deletedAt === null &&
              thread.archivedAt === null &&
              thread.worktreePath !== null
                ? [{ threadId: thread.id, worktreePath: thread.worktreePath }]
                : [],
            ),
          ),
        ),
      getThreadsWithPullRequests: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) =>
            [...state.projections.values()]
              .map(({ thread }) => thread)
              .filter(
                (thread) =>
                  (threadId === undefined || thread.id === threadId) &&
                  thread.deletedAt === null &&
                  thread.archivedAt === null &&
                  (thread.pullRequests ?? []).length > 0,
              )
              .toSorted(
                (left, right) =>
                  DateTime.toEpochMillis(left.updatedAt) -
                    DateTime.toEpochMillis(right.updatedAt) || left.id.localeCompare(right.id),
              )
              .map((thread): ProjectionThreadPullRequests => ({
                id: thread.id,
                projectId: thread.projectId,
                lineage: thread.lineage,
                settledOverride: thread.settledOverride,
                settledAt: thread.settledAt,
                pullRequests: thread.pullRequests ?? [],
              })),
          ),
        ),
      getProviderRetryCandidates: (now) =>
        Ref.get(replayState).pipe(
          Effect.map((state) =>
            [...state.projections.values()].flatMap(({ thread, runs }) =>
              thread.deletedAt !== null ||
              thread.archivedAt !== null ||
              thread.settledOverride === "settled"
                ? []
                : runs.filter(
                    (run) =>
                      (run.status === "failed" || run.status === "cancelled") &&
                      run.automaticProviderRetry?.status === "scheduled" &&
                      run.automaticProviderRetry.scheduledAt !== null &&
                      Date.parse(run.automaticProviderRetry.scheduledAt) <=
                        DateTime.toEpochMillis(now),
                  ),
            ),
          ),
        ),
      getIdleDelegatedTaskThreadIds: (idleSince) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => {
            const cutoff = DateTime.toEpochMillis(idleSince);
            const childThreadIds = new Set<ThreadId>();
            for (const { subagents } of state.projections.values()) {
              for (const task of subagents) {
                const child =
                  task.childThreadId === null
                    ? undefined
                    : state.projections.get(task.childThreadId);
                if (
                  child === undefined ||
                  child.thread.deletedAt !== null ||
                  task.origin !== "app_owned" ||
                  task.remote !== undefined ||
                  !["pending", "running", "waiting"].includes(task.status) ||
                  DateTime.toEpochMillis(task.updatedAt) > cutoff ||
                  child.runs.some(
                    (run) =>
                      ["queued", "preparing", "starting", "running", "waiting"].includes(
                        run.status,
                      ) ||
                      (run.completedAt !== null &&
                        DateTime.toEpochMillis(run.completedAt) > cutoff),
                  )
                )
                  continue;
                childThreadIds.add(child.thread.id);
              }
            }
            return [...childThreadIds];
          }),
        ),
      getLimitRecoveryCandidates: (options) =>
        Ref.get(replayState).pipe(
          Effect.map((state) =>
            [...state.projections.values()]
              .filter(
                ({ thread }) =>
                  thread.deletedAt === null &&
                  thread.archivedAt === null &&
                  thread.settledOverride !== "settled",
              )
              .map((projection) => threadShellFromProjection(projection, state.projections, stores))
              .filter(
                (thread) =>
                  thread.status === "failed" &&
                  thread.lastErrorClass === "usage_limit" &&
                  thread.usageLimitResetAt !== null &&
                  thread.pendingRuntimeRequest === null,
              )
              .filter((thread) => {
                const resetMs = Date.parse(thread.usageLimitResetAt!);
                const nowMs = DateTime.toEpochMillis(options.now);
                if (
                  !Number.isFinite(resetMs) ||
                  resetMs <= DateTime.toEpochMillis(thread.latestRunCompletedAt ?? thread.updatedAt)
                )
                  return false;
                if (
                  thread.limitRecovery?.runId !== thread.latestRunId ||
                  thread.limitRecovery.resetAt !== thread.usageLimitResetAt
                ) {
                  return resetMs > nowMs && (options.autoResume || options.snooze);
                }
                return (
                  thread.limitRecovery.autoResume &&
                  resetMs <= nowMs &&
                  (thread.snoozedUntil == null ||
                    DateTime.toEpochMillis(thread.snoozedUntil) <= nowMs)
                );
              })
              .toSorted((left, right) => left.id.localeCompare(right.id)),
          ),
        ),
      getSignedOutStops: (options) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const state = yield* Ref.get(replayState);
          return [...state.projections.values()]
            .filter(
              ({ thread }) =>
                thread.deletedAt === null &&
                thread.archivedAt === null &&
                thread.settledOverride !== "settled" &&
                (thread.snoozedUntil == null ||
                  DateTime.toEpochMillis(thread.snoozedUntil) <= DateTime.toEpochMillis(now)) &&
                !(
                  thread.lineage.relationshipToParent === "subagent" &&
                  thread.creationSource === "provider"
                ),
            )
            .map((projection) => ({
              projection,
              shell: threadShellFromProjection(projection, state.projections, stores),
            }))
            .flatMap(({ projection, shell: thread }): Array<ProjectionSignedOutStop> => {
              const run = projection.runs.find((run) => run.id === thread.latestRunId);
              return run !== undefined &&
                thread.status === "failed" &&
                thread.pendingRuntimeRequest === null &&
                thread.latestRunId !== null &&
                thread.latestRunCompletedAt != null &&
                DateTime.toEpochMillis(thread.latestRunCompletedAt) >=
                  DateTime.toEpochMillis(options.since) &&
                (options.messagePrefix !== undefined
                  ? thread.lastError?.startsWith(options.messagePrefix) === true
                  : thread.lastError?.includes(options.messageContains) === true)
                ? [
                    {
                      threadId: thread.id,
                      runId: thread.latestRunId,
                      providerInstanceId: run.providerInstanceId,
                      modelSelection: run.modelSelection,
                      completedAt: thread.latestRunCompletedAt,
                    },
                  ]
                : [];
            })
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(left.completedAt) -
                  DateTime.toEpochMillis(right.completedAt) ||
                left.threadId.localeCompare(right.threadId),
            );
        }),
      getRecoveryThreadIds: (kind) =>
        Effect.gen(function* () {
          const projections = (yield* Ref.get(replayState)).projections;
          if (kind === "subagent-activity")
            return [
              ...new Set(
                [...projections.values()].flatMap((projection) => [
                  ...(projection.runs.some((run) => !TERMINAL_RUN_STATUSES.has(run.status))
                    ? [projection.thread.id]
                    : []),
                  ...projection.turnItems.flatMap((item) =>
                    item.type === "subagent" &&
                    item.childActivity?.status === "running" &&
                    item.childThreadId !== null
                      ? [item.childThreadId]
                      : [],
                  ),
                ]),
              ),
            ];
          return [...projections.values()]
            .filter((projection) =>
              needsRecovery(
                projection,
                kind,
                projection.thread.lineage.parentThreadId === null ||
                  projection.thread.lineage.parentEnvironmentId !== undefined
                  ? undefined
                  : projections.get(projection.thread.lineage.parentThreadId),
              ),
            )
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(left.thread.updatedAt) -
                  DateTime.toEpochMillis(right.thread.updatedAt) ||
                left.thread.id.localeCompare(right.thread.id),
            )
            .map((projection) => projection.thread.id);
        }),
      getUnreadableThreadIds: () => Effect.succeed([]),
      getPendingNativeUserInputs: (threadId, providerTurnId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined) return { runtimeRequests: [], nodes: [], turnItems: [] };
          const runtimeRequests = projection.runtimeRequests.filter(
            (request) =>
              request.providerTurnId === providerTurnId &&
              request.kind === "user_input" &&
              request.status === "pending" &&
              request.responseCapability.type !== "message",
          );
          const requestIds = new Set(runtimeRequests.map((request) => request.id));
          const nodeIds = new Set(runtimeRequests.map((request) => request.nodeId));
          return {
            runtimeRequests,
            nodes: projection.nodes.filter((node) => nodeIds.has(node.id)),
            turnItems: projection.turnItems.filter(
              (item) => item.type === "user_input_request" && requestIds.has(item.requestId),
            ),
          };
        }),
      getPlan: (threadId, planId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          return projection.plans.find((plan) => plan.id === planId);
        }),
      hasUnpairedRunInterruptRequest: (threadId, requestId, resultId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          return (
            projection !== undefined &&
            projection.turnItems.some((item) => item.id === requestId) &&
            !projection.turnItems.some((item) => item.id === resultId)
          );
        }),
      isNodeStored: (node) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => {
            const stored = state.projections
              .get(node.threadId)
              ?.nodes.find((candidate) => candidate.id === node.id);
            return stored !== undefined && Equal.equals(stored, node);
          }),
        ),
      hasMessages: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => (state.projections.get(threadId)?.messages.length ?? 0) > 0),
        ),
      hasStartedRunAfter: (threadId, ordinal) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => {
            const p = state.projections.get(threadId);
            const newer = new Set(
              p?.runs
                .filter((run) => run.status !== "queued" && run.ordinal > ordinal)
                .map((run) => run.id),
            );
            return (
              p?.turnItems.some(
                (item) =>
                  item.runId !== null &&
                  newer.has(item.runId) &&
                  (item.type === "user_message" || item.type === "notification"),
              ) ?? false
            );
          }),
        ),
      getMessageCount: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map((state) => state.projections.get(threadId)?.messages.length ?? 0),
        ),
      getNextTurnItemOrdinal: (threadId) =>
        Ref.get(replayState).pipe(
          Effect.map(
            (state) =>
              (state.projections
                .get(threadId)
                ?.turnItems.reduce((max, item) => Math.max(max, item.ordinal), 0) ?? 0) + 1,
          ),
        ),
      getTurnItem: ({ threadId, itemId }) =>
        Ref.get(replayState).pipe(
          Effect.map(
            (state) =>
              state.projections.get(threadId)?.turnItems.find((item) => item.id === itemId) ?? null,
          ),
        ),
      getThreadAttachmentIds: (threadId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => [
            ...new Set([
              ...projection.messages.flatMap((message) =>
                message.attachments.map((attachment) => attachment.id),
              ),
              ...threadHtmlRenderAttachmentIds(
                threadId,
                projection.turnItems.flatMap((item) =>
                  item.type === "dynamic_tool" ? [item] : [],
                ),
              ),
            ]),
          ]),
        ),
      getMessageDispatchProjection: (threadId) =>
        service
          .getThreadRecords(
            threadId,
            [
              "runs",
              "attempts",
              "nodes",
              "subagents",
              "providerSessions",
              "providerThreads",
              "providerTurns",
              "runtimeRequests",
              "messages",
              "turnItems",
              "contextTransfers",
              "checkpointScopes",
            ],
            { messageRoles: ["user"] },
          )
          .pipe(
            Effect.map((records) => ({
              ...records,
              turnItems: records.turnItems.filter(
                (item) =>
                  item.type === "user_message" ||
                  (item.type === "error" && item.status === "failed"),
              ),
              checkpoints: [],
              plans: [],
              contextHandoffs: [],
              visibleTurnItems: [],
              updatedAt: records.thread.updatedAt,
            })),
          ),
      getThreadRecords: (threadId, fields, options) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const filter = options?.pendingRuntimeRequestControls
            ? (() => {
                const requestNodeIds = [
                  ...new Set(
                    projection.runtimeRequests
                      .filter((request) => request.status === "pending")
                      .map((request) => request.nodeId),
                  ),
                ];
                return {
                  ...options,
                  pendingRuntimeRequestsOnly: true,
                  nodeIds: requestNodeIds,
                  turnItemNodeIds: requestNodeIds,
                };
              })()
            : options?.queuedControls
              ? queueFilter(
                  projection.runs.filter(
                    (run) =>
                      run.status === "queued" &&
                      (!options.runIds || options.runIds.includes(run.id)),
                  ),
                  options,
                )
              : options;
          const selected = {
            ...projection,
            providerThreads: projection.providerThreads.filter(
              (row) =>
                filter?.providerThreadIds === undefined ||
                filter.providerThreadIds.includes(row.id),
            ),
            providerTurns: projection.providerTurns.filter(
              (row) =>
                (filter?.providerTurnIds === undefined ||
                  filter.providerTurnIds.includes(row.id)) &&
                (filter?.providerTurnAttemptIds === undefined ||
                  filter.providerTurnAttemptIds.includes(row.runAttemptId)),
            ),
            messages: projection.messages.filter(
              (row) =>
                (filter?.messageRunIds === undefined ||
                  (row.runId !== null && filter.messageRunIds.includes(row.runId))) &&
                (filter?.messageIds === undefined || filter.messageIds.includes(row.id)) &&
                (filter?.messageRoles === undefined || filter.messageRoles.includes(row.role)),
            ),
            runs: projection.runs.filter(
              (row) =>
                (!filter?.activeRunsOnly || activeRunStatuses.has(row.status)) &&
                (filter?.runIds === undefined || filter.runIds.includes(row.id)),
            ),
            attempts: projection.attempts.filter(
              (row) =>
                filter?.attemptRunIds === undefined || filter.attemptRunIds.includes(row.runId),
            ),
            checkpointScopes: projection.checkpointScopes.filter(
              (scope) =>
                !filter?.checkpointScopeIds || filter.checkpointScopeIds.includes(scope.id),
            ),
            runtimeRequests: projection.runtimeRequests.filter(
              (row) => !filter?.pendingRuntimeRequestsOnly || row.status === "pending",
            ),
            contextTransfers: projection.contextTransfers.filter(
              (row) =>
                !filter?.pendingIncomingTransfersOnly ||
                (row.targetThreadId === threadId && row.status === "pending"),
            ),
            turnItems: projection.turnItems.filter(
              (row) =>
                (filter?.turnItemIds === undefined || filter.turnItemIds.includes(row.id)) &&
                (filter?.turnItemNodeIds === undefined ||
                  (row.nodeId !== null && filter.turnItemNodeIds.includes(row.nodeId))) &&
                (filter?.turnItemMessageIds === undefined ||
                  (row.type === "user_message" &&
                    filter.turnItemMessageIds.includes(row.messageId))) &&
                (filter?.turnItemRunIds === undefined ||
                  filter.turnItemRunIds.includes(row.runId)) &&
                (filter?.turnItemTypes === undefined || filter.turnItemTypes.includes(row.type)) &&
                (filter?.turnItemStatuses === undefined ||
                  filter.turnItemStatuses.includes(row.status)) &&
                (filter?.turnItemRunId === undefined || filter.turnItemRunId === row.runId),
            ),
            nodes: projection.nodes.filter(
              (row) =>
                (filter?.omitSettledLeafNodes !== true ||
                  !isSettledLeafNode(row, projection.runs)) &&
                (filter?.nodeIds === undefined || filter.nodeIds.includes(row.id)) &&
                (filter?.nodeRunIds === undefined ||
                  (row.runId !== null && filter.nodeRunIds.includes(row.runId))) &&
                (filter?.liveNodesOnly !== true ||
                  ["pending", "starting", "running", "waiting"].includes(row.status)),
            ),
          };
          return Object.fromEntries([
            ["thread", projection.thread],
            ...fields.map((field) => [field, selected[field]]),
          ]) as ProjectionRecords<(typeof fields)[number]>;
        }),
      getRuntimeRequest: (threadId, requestId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          return projection.runtimeRequests.find((request) => request.id === requestId);
        }),
      getPendingChildQuestions: (limit, before) =>
        Effect.gen(function* () {
          const projections = (yield* Ref.get(replayState)).projections;
          return [...projections.values()]
            .filter(
              (projection) =>
                projection.thread.deletedAt === null &&
                projection.thread.lineage.parentThreadId !== null &&
                projection.thread.lineage.relationshipToParent === "subagent" &&
                projection.thread.lineage.parentEnvironmentId === undefined,
            )
            .flatMap((projection) =>
              projection.runtimeRequests
                .filter((request) => request.status === "pending" && request.kind === "user_input")
                .map((request): ProjectionPendingChildQuestion => ({
                  threadId: projection.thread.id,
                  runId: projection.nodes.find((node) => node.id === request.nodeId)?.runId ?? null,
                  request,
                })),
            )
            .toSorted(
              (left, right) =>
                DateTime.toEpochMillis(right.request.createdAt) -
                  DateTime.toEpochMillis(left.request.createdAt) ||
                (left.request.id < right.request.id
                  ? 1
                  : left.request.id > right.request.id
                    ? -1
                    : 0),
            )
            .filter(
              ({ request }) =>
                before === undefined ||
                DateTime.toEpochMillis(request.createdAt) <
                  DateTime.toEpochMillis(before.createdAt) ||
                (DateTime.toEpochMillis(request.createdAt) ===
                  DateTime.toEpochMillis(before.createdAt) &&
                  request.id < before.requestId),
            )
            .slice(0, limit);
        }),
      getProviderControlContext: (threadId, target) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const providerTurn = projection.providerTurns.find(
            (turn) => turn.id === target.providerTurnId,
          );
          return {
            providerThread: projection.providerThreads.find(
              (thread) => thread.id === target.providerThreadId,
            ),
            providerTurn,
            attempt:
              target.attemptId === undefined
                ? undefined
                : projection.attempts.find((attempt) => attempt.id === target.attemptId),
            message:
              target.messageId === undefined
                ? undefined
                : projection.messages.find((message) => message.id === target.messageId),
            run:
              target.messageId === undefined || providerTurn === undefined
                ? undefined
                : projection.runs.find((run) => run.activeAttemptId === providerTurn.runAttemptId),
          };
        }),
      getRunningTurnContext: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const run = projection.runs.find((run) => run.status === "running");
          return {
            run,
            providerThread: projection.providerThreads.find(
              (thread) => thread.id === run?.providerThreadId,
            ),
            providerTurn: projection.providerTurns.find(
              (turn) =>
                turn.providerThreadId === run?.providerThreadId &&
                turn.runAttemptId === run?.activeAttemptId &&
                turn.nodeId === run?.rootNodeId &&
                turn.status === "running",
            ),
          };
        }),
      getThreadProviderContext: (threadId, targetInstanceId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const target = projection.providerThreads
            .filter(
              (thread) =>
                thread.appThreadId === threadId &&
                thread.ownerNodeId === null &&
                thread.providerInstanceId === targetInstanceId,
            )
            .toSorted(
              (a, b) =>
                DateTime.toEpochMillis(b.updatedAt) - DateTime.toEpochMillis(a.updatedAt) ||
                a.id.localeCompare(b.id),
            )[0];
          return {
            thread: projection.thread,
            providerSessions: projection.providerSessions,
            providerThreads:
              targetInstanceId === undefined
                ? []
                : projection.providerThreads.filter(
                    (thread) =>
                      thread.id === projection.thread.activeProviderThreadId ||
                      thread.id === target?.id,
                  ),
          };
        }),
      getRuntimeResponseContext: (threadId, requestId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const request = projection.runtimeRequests.find((request) => request.id === requestId);
          return {
            request,
            node: projection.nodes.find((node) => node.id === request?.nodeId),
            item: projection.turnItems.find(
              (item) =>
                item.nodeId === request?.nodeId &&
                (item.type === "approval_request" || item.type === "user_input_request") &&
                item.requestId === requestId,
            ),
            session: projection.providerSessions.find(
              (session) =>
                request?.responseCapability.type === "live" &&
                session.id === request.responseCapability.providerSessionId,
            ),
          };
        }),
      getCheckpointContext: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return {
            runs: projection.runs.map(({ id, ordinal, status }) => ({ id, ordinal, status })),
            checkpointScopes: projection.checkpointScopes.map(({ id, runId, kind, cwd }) => ({
              id,
              runId,
              kind,
              cwd,
            })),
            checkpoints: projection.checkpoints.map(
              ({ scopeId, runId, appRunOrdinal, status, ref }) => ({
                scopeId,
                runId,
                appRunOrdinal,
                status,
                ref,
              }),
            ),
          };
        }),
      getCheckpointCaptureContext: (threadId, target) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const run = projection.runs.find((candidate) => candidate.id === target.runId);
          return {
            run,
            rootNode: projection.nodes.find((candidate) => candidate.id === run?.rootNodeId),
            scope: projection.checkpointScopes.find((candidate) => candidate.id === target.scopeId),
            providerThread: projection.providerThreads.find(
              (candidate) => candidate.id === run?.providerThreadId,
            ),
            readyCheckpointOrdinals: projection.checkpoints
              .filter(
                (candidate) => candidate.scopeId === target.scopeId && candidate.status === "ready",
              )
              .map((candidate) => candidate.ordinalWithinScope),
            runCheckpointOrdinals: projection.checkpoints
              .filter(
                (candidate) => candidate.scopeId === target.scopeId && candidate.runId !== null,
              )
              .map((candidate) => candidate.ordinalWithinScope),
          };
        }),
      getRunMessage: (threadId, runId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          const run = projection.runs.find((candidate) => candidate.id === runId);
          return projection.messages.find((message) => message.id === run?.userMessageId);
        }),
      canStartQueuedRun: (threadId) =>
        Effect.gen(function* () {
          const projection = (yield* Ref.get(replayState)).projections.get(threadId);
          if (projection === undefined)
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          return (
            projection.thread.archivedAt === null &&
            projection.thread.deletedAt === null &&
            projection.runs.some((run) => run.status === "queued") &&
            !projection.runs.some(
              (run) =>
                run.status === "preparing" ||
                run.status === "starting" ||
                run.status === "running" ||
                run.status === "waiting" ||
                (run.status === "queued" && run.queueHeld === true),
            )
          );
        }),
      getThreadProjection: (threadId) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(replayState)).projections;
          const readProjection = (
            targetThreadId: ThreadId,
            seenThreadIds: ReadonlySet<ThreadId>,
          ): OrchestrationV2ThreadProjection | null => {
            const projection = existing.get(targetThreadId);
            if (!projection) {
              return null;
            }
            const forkedFrom = projection.thread.forkedFrom;
            if (forkedFrom?.type !== "run" || seenThreadIds.has(forkedFrom.threadId)) {
              return withLocalVisibleTurnItems(projection);
            }
            const sourceProjection = readProjection(
              forkedFrom.threadId,
              new Set([...seenThreadIds, targetThreadId]),
            );
            return {
              ...projection,
              visibleTurnItems: buildVisibleTurnItems({
                projection,
                sourceProjection,
              }),
            };
          };
          const projection = readProjection(threadId, new Set());
          if (!projection) {
            return yield* new ProjectionStoreThreadNotFoundError({ threadId });
          }
          return projection;
        }),
      getTurnStartContext: (threadId, runId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => {
            const excluded = new Set(
              projection.runs
                .filter(
                  (run) =>
                    run.id !== runId &&
                    (run.status === "queued" ||
                      run.status === "rolled_back" ||
                      (run.status === "cancelled" && run.startedAt === null)),
                )
                .map((run) => run.id),
            );
            return {
              ...projection,
              hasConversation: projection.messages.some(
                (message) =>
                  message.role === "user" &&
                  (message.runId === null || !excluded.has(message.runId)) &&
                  (message.text.trim().toLowerCase() !== "/compact" ||
                    message.attachments.length > 0),
              ),
              turnItems: projection.turnItems.filter((item) => item.runId === runId),
              contextHandoffs: projection.contextHandoffs.filter(
                (handoff) =>
                  handoff.targetRunId === runId ||
                  handoff.toProviderThreadId ===
                    projection.runs.find((run) => run.id === runId)?.providerThreadId,
              ),
              contextTransfers: projection.contextTransfers.filter(
                (transfer) =>
                  transfer.targetThreadId === threadId &&
                  transfer.targetRunId === runId &&
                  transfer.type === "fork" &&
                  transfer.status === "pending",
              ),
            };
          }),
        ),
      getTurnStartHistory: (threadId, runIds) =>
        service
          .getThreadProjection(threadId)
          .pipe(
            Effect.map((projection) =>
              projection.turnItems.filter(
                (item) =>
                  [
                    "user_message",
                    "assistant_message",
                    "command_execution",
                    "error",
                    "run_interrupt_result",
                    "file_change",
                    "proposed_plan",
                  ].includes(item.type) &&
                  (runIds === undefined || (item.runId !== null && runIds.includes(item.runId))),
              ),
            ),
          ),
      getRuntimeRecoveryProjection: (threadId) => service.getThreadProjection(threadId),
      getThreadSnapshot: (threadId) =>
        service.getThreadProjection(threadId).pipe(
          Effect.flatMap((projection) =>
            Ref.get(sequence).pipe(
              Effect.map((snapshotSequence) => ({
                schemaVersion: ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION,
                snapshotSequence,
                projection,
              })),
            ),
          ),
        ),
      searchThreadStream: (input) => Stream.fromEffect(service.searchThread(input)),
      searchThread: (input) =>
        service.getThreadSnapshot(input.threadId).pipe(
          Effect.flatMap(({ projection, snapshotSequence }) =>
            projection.thread.deletedAt !== null
              ? Effect.fail(new ProjectionStoreThreadNotFoundError({ threadId: input.threadId }))
              : Effect.succeed(
                  // This store has no project records, so only worktree paths resolve labels.
                  findProjectedThreadItems(
                    projection.visibleTurnItems,
                    input,
                    snapshotSequence,
                    projection.thread.worktreePath ?? undefined,
                  ),
                ),
          ),
        ),
      getThreadHistoryPage: (threadId, cursor, throughEntryId, conversationOnly) =>
        service.getThreadSnapshot(threadId).pipe(
          Effect.flatMap(({ projection, snapshotSequence }) =>
            Effect.gen(function* () {
              if (projection.thread.deletedAt !== null)
                return yield* new ProjectionStoreThreadNotFoundError({ threadId });
              return yield* Effect.try({
                try: () => {
                  const visible = projection.visibleTurnItems.map((row) => ({
                    ...row,
                    item: projectTurnItemForWire(row.item),
                  }));
                  const page = selectHistoryPageFromCursor({
                    items: visible,
                    cursor,
                    throughEntryId,
                    snapshotSequence,
                  });
                  const items = [
                    ...missingInterruptRequests(visible, page.items),
                    ...page.items,
                  ].map((row, position) => ({ ...row, position }));
                  return {
                    ...page,
                    snapshotSequence,
                    items: conversationOnly
                      ? items.filter((row) => isConversationHistoryItem(row.item))
                      : items,
                  };
                },
                catch: (cause) => new ProjectionStoreReadError({ threadId, cause }),
              });
            }),
          ),
        ),
      getThreadMediaPage: (threadId, mediaCursor) => {
        const { cursor, end } = decodeThreadMediaCursor(mediaCursor);
        return service.getThreadHistoryPage(threadId, cursor).pipe(
          Effect.map((page) =>
            selectThreadMediaPage({
              rows: page.items,
              cursor,
              ...(end === undefined ? {} : { end }),
              nextCursor: page.nextCursor,
              hasMoreHistory: page.hasMoreHistory,
            }),
          ),
        );
      },
      getTimelinePage: (threadId, options) =>
        service.getThreadProjection(threadId).pipe(
          Effect.map((projection) => {
            const matching = projection.visibleTurnItems.filter((row) =>
              options.itemId === undefined
                ? row.position > (options.afterPosition ?? -1) &&
                  row.position < (options.beforePosition ?? Infinity) &&
                  (options.view === "activity" ||
                    ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type))
                : row.sourceItemId === options.itemId,
            );
            return {
              items:
                options.fromEnd === true || options.beforePosition !== undefined
                  ? matching.slice(-options.limit)
                  : matching.slice(0, options.limit),
              totalItems: projection.visibleTurnItems.length,
              hasMore: matching.length > options.limit,
            };
          }),
        ),
      getThreadSnapshotWindow: (threadId, options) =>
        service.getThreadSnapshot(threadId).pipe(
          Effect.map((snapshot) => {
            const anchorIndex =
              options.anchorItemId === undefined
                ? snapshot.projection.visibleTurnItems.length
                : snapshot.projection.visibleTurnItems.findIndex(
                    (row) => row.sourceItemId === options.anchorItemId,
                  ) + 1;
            const candidates = snapshot.projection.visibleTurnItems.slice(0, anchorIndex);
            const turnStarts = threadHistoryTurnStarts(candidates.map((row) => row.item));
            const turnAnchors =
              options.userTurnLimit === undefined
                ? []
                : candidates.flatMap((_row, index) => (turnStarts[index] ? [index] : []));
            const rawStart = turnAnchors.at(-(THREAD_HISTORY_MAX_RAW_TURNS + 2)) ?? 0;
            const anchors = turnAnchors.filter(
              (index) => index >= rawStart && isThreadHistoryUserTurn(candidates[index]!.item),
            );
            const anchorLimit = (options.userTurnLimit ?? 0) + 2;
            const start =
              anchors.length > 0
                ? anchors.length < anchorLimit
                  ? rawStart
                  : anchors.at(-anchorLimit)!
                : Math.max(0, anchorIndex - options.rowLimit);
            const latestTurnRows = anchors.length > 0 ? anchorIndex - anchors.at(-1)! : 0;
            const rowLimit =
              options.rowLimit > 0 &&
              latestTurnRows > 0 &&
              latestTurnRows <= THREAD_HISTORY_PAGE_POLICY.maxTurnItems
                ? THREAD_HISTORY_TURN_SNAPSHOT_ROW_LIMIT
                : options.rowLimit;
            const visibleTurnItems = candidates.slice(
              Math.max(start, anchorIndex - Math.max(0, rowLimit)),
            );
            return {
              ...snapshot,
              projection: { ...snapshot.projection, visibleTurnItems },
            };
          }),
        ),
    };

    return service;
  }),
);
