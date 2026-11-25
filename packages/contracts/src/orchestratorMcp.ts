import { ApiKeyRequest } from "./apiKey.ts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ContextTransferId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import {
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2ProviderFailure,
  OrchestrationV2RunStatus,
  OrchestrationV2SubagentSeen,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";
import {
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  ProviderOptionSelectionValue,
} from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

// Infer the schema before annotating its encoded side, so branded input types stay intact.
const describeInput = <S extends Schema.Top>(schema: S, description: string): S["Rebuild"] =>
  Schema.annotateEncoded<S>({ description })(schema);

const OrchestratorMcpPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)).annotate({
  description: "Complete task or message text for the target agent.",
});
const OrchestratorMcpTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "Optional concise display title.",
});
// MCP publishes the encoded side of these transforming string schemas.
const OrchestratorMcpClientRequestId = describeInput(
  TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  "Retry key; unique delegation keys also reference tasks.",
);

/**
 * OpenCode 1.15 has been observed serializing nested MCP union objects as JSON
 * strings. Keep the structured object as the documented form while accepting
 * that compatibility shape at the tool boundary and decoding it immediately.
 */
const OrchestratorMcpScheduleFromJsonString = Schema.fromJsonString(
  ScheduledTaskUpsertSchedule,
).annotate({
  description:
    "Compatibility-only JSON encoding of the schedule object. Prefer a structured object.",
});

const OrchestratorMcpSchedule = Schema.Union([
  ScheduledTaskUpsertSchedule,
  OrchestratorMcpScheduleFromJsonString,
]).annotate({
  description:
    "Trigger object: {type:'interval', everyMs}, {type:'fixed_time', timeOfDay, weekdays?}, {type:'once', runAt}, or {type:'webhook'} to run on each request to a generated URL. Never stringify it unless the provider requires the compatibility form.",
});

/**
 * Shorthand `{ id: value }` record form for target model options. Unlike the
 * legacy-tolerant `ProviderOptionSelections` persistence schema, this decodes
 * strictly: a value that is not a string or boolean fails the request rather
 * than being silently dropped.
 */
const OrchestratorMcpTargetOptionsFromRecord = Schema.Record(
  Schema.String,
  ProviderOptionSelectionValue,
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) =>
        Effect.succeed(Object.entries(record).map(([id, value]) => ({ id, value }))),
      encode: (selections: ReadonlyArray<ProviderOptionSelection>) =>
        Effect.succeed(
          Object.fromEntries(selections.map((selection) => [selection.id, selection.value])),
        ),
    }),
  ),
);

// Workflow provenance is client-only; agent tool schemas stay unchanged.
const McpCreationSource = Schema.Literals(["web", "mobile", "mcp", "provider", "server"]);

export const OrchestratorMcpTargetOptions = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  OrchestratorMcpTargetOptionsFromRecord,
]);
export type OrchestratorMcpTargetOptions = typeof OrchestratorMcpTargetOptions.Type;

export const OrchestratorMcpTarget = Schema.Struct({
  providerInstanceId: Schema.optional(
    describeInput(
      ProviderInstanceId,
      "Configured provider instance id from orchestrator_capabilities.",
    ),
  ),
  driverKind: Schema.optional(
    describeInput(
      ProviderDriverKind,
      "Provider driver kind; prefer providerInstanceId when available.",
    ),
  ),
  model: Schema.optional(
    describeInput(
      TrimmedNonEmptyString,
      "Exact orchestrator_capabilities model id, not its label; omit to inherit a current one. Custom ids require an empty catalog, that exact user request and userNamedModel:true.",
    ),
  ),
  /**
   * Model option selections for the child (for example reasoning effort).
   * Accepts the canonical `[{ id, value }]` array or the shorthand
   * `{ id: value }` record; valid ids come from the option descriptors
   * advertised by orchestrator_capabilities. When omitted, options inherit
   * from the parent only when the child runs the parent's provider and model.
   */
  options: Schema.optional(
    OrchestratorMcpTargetOptions.annotate({
      description: "Model option selections advertised by orchestrator_capabilities.",
    }),
  ),
  userNamedAccount: Schema.optional(
    Schema.Boolean.annotate({ description: "User named this exact account." }),
  ),
  userNamedModel: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True only if the user named this exact model. Required for legacy/superseded models and custom ids in empty catalogs; explain the request.",
    }),
  ),
});
export type OrchestratorMcpTarget = typeof OrchestratorMcpTarget.Type;

export const OrchestratorMcpRuntimeMode = Schema.Union([Schema.Literal("inherit"), RuntimeMode]);
export type OrchestratorMcpRuntimeMode = typeof OrchestratorMcpRuntimeMode.Type;

export const OrchestratorMcpInteractionMode = Schema.Union([
  Schema.Literal("inherit"),
  ProviderInteractionMode,
]);
export type OrchestratorMcpInteractionMode = typeof OrchestratorMcpInteractionMode.Type;

/** Wire input: a thread id or the short taskId of a child this thread owns. */
export const OrchestratorMcpThreadReference = TrimmedNonEmptyString;
export type OrchestratorMcpThreadReference = typeof OrchestratorMcpThreadReference.Type;

export const OrchestratorMcpTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;

export const OrchestratorMcpDelegatedTaskStatus = Schema.Literals([
  "queued",
  "held",
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpDelegatedTaskStatus = typeof OrchestratorMcpDelegatedTaskStatus.Type;

export const OrchestratorMcpTerminalDelegatedTaskStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpTerminalDelegatedTaskStatus =
  typeof OrchestratorMcpTerminalDelegatedTaskStatus.Type;

/** Grades ride on a subagent call the agent makes anyway, so rating costs no extra step. */
export const OrchestratorMcpTaskGrades = Schema.Unknown.annotateKey({
  description: "Rate work against the brief, not findings: [{taskId,score:1-10,note?}].",
});
export type OrchestratorMcpTaskGrades = typeof OrchestratorMcpTaskGrades.Type;

export const OrchestratorMcpGradesResult = Schema.Struct({
  saved: Schema.Number,
  skipped: Schema.Array(
    Schema.Struct({ taskId: Schema.optional(Schema.String), reason: Schema.String }),
  ),
});
export type OrchestratorMcpGradesResult = typeof OrchestratorMcpGradesResult.Type;

export const OrchestratorMcpDelegateTaskInput = Schema.Struct({
  task: describeInput(
    OrchestratorMcpPrompt,
    "Self-contained task for one delegated child agent/subagent.",
  ),
  // Some providers send the whole target object as JSON text.
  target: Schema.optional(
    Schema.Union([OrchestratorMcpTarget, Schema.fromJsonString(OrchestratorMcpTarget)]),
  ),
  title: Schema.optional(OrchestratorMcpTitle),
  role: Schema.optional(OrchestratorMcpTaskRole),
  isolation: Schema.optional(
    Schema.Literals(["shared", "worktree"]).annotate({
      description:
        "Defaults to shared: the parent's checkout, or repositoryPath. worktree copies the Git repository at its current local commit (uncommitted edits stay behind unless withEdits) and runs project setup first. Without repositoryPath, a non-Git parent folder runs shared and the result's notice says so.",
    }),
  ),
  withEdits: Schema.optional(
    describeInput(Schema.Boolean, "Include parent edits in a worktree subagent. Defaults false."),
  ),
  repositoryPath: Schema.optional(
    describeInput(
      TrimmedNonEmptyString,
      "Absolute path the child works in (for worktree, the Git checkout to copy). Defaults to the parent's checkout; set it when the target repository is elsewhere.",
    ),
  ),
  mode: Schema.optional(
    Schema.Literals(["async", "wait"]).annotate({
      description: "Defaults to async. Use wait only when this turn needs the result to continue.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Number).annotate({
    description:
      "mode=wait budget; default 4 minutes. Expiry returns waitTimedOut=true and does not cancel the child.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  runtimeMode: Schema.optional(
    OrchestratorMcpRuntimeMode.annotate({
      description:
        "Defaults to inherit; omit unless the user asks for a supervised child. Not a read-only switch: approval-required/auto-accept-edits pause the child at each action needing approval until a person approves in the child's thread, which this thread cannot do — to limit the child, say so in the task. Modes above this thread's are rejected; lower rank doesn't promise narrower provider permissions.",
    }),
  ),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
  grades: Schema.optionalKey(OrchestratorMcpTaskGrades),
});
export type OrchestratorMcpDelegateTaskInput = typeof OrchestratorMcpDelegateTaskInput.Type;

export const OrchestratorMcpCouncilInput = Schema.Struct({
  question: describeInput(
    OrchestratorMcpPrompt,
    "The decision or question, self-contained: members see only this and context.",
  ),
  context: Schema.optional(
    describeInput(
      OrchestratorMcpPrompt,
      "What members need to know: constraints, options considered, relevant files (they can read the checkout).",
    ),
  ),
  members: Schema.Array(
    Schema.Struct({
      providerInstanceId: ProviderInstanceId,
      model: TrimmedNonEmptyString,
    }),
  )
    .check(Schema.isMinLength(2), Schema.isMaxLength(4))
    .annotate({
      description:
        "2-4 current strongest models from orchestrator_capabilities, ideally different providers. Honor the user's model choices.",
    }),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 60_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({
    description:
      "How long to wait for all answers. Default 15 minutes; later answers wake you when they finish.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpCouncilInput = typeof OrchestratorMcpCouncilInput.Type;

export const OrchestratorMcpDelegateTaskResult = Schema.Struct({
  grades: Schema.optional(OrchestratorMcpGradesResult),
  childThreadLink: Schema.optional(Schema.String),
  /** Stable short handle. Canonical ids remain valid inputs. */
  taskId: NodeId,
  status: OrchestratorMcpDelegatedTaskStatus,
  workState: Schema.Literals(["working", "waiting_for_children", "result_available"]),
  /** Present (true) only while later child runs are pending. */
  hasPendingChildRuns: Schema.optionalKey(Schema.Literal(true)),
  /** Omitted while it is the task's current run or there is none. */
  latestTerminalRunId: Schema.optional(RunId),
  /** Omitted until a later run of the child ends. */
  latestTerminalStatus: Schema.optionalKey(OrchestratorMcpTerminalDelegatedTaskStatus),
  /** Omitted while it would repeat summary or there is none. */
  latestTerminalSummary: Schema.optionalKey(Schema.String),
  /** Omitted while it is resultContextTransferId or there is none. */
  latestTerminalResultContextTransferId: Schema.optional(ContextTransferId),
  providerInstanceId: ProviderInstanceId,
  /** Omitted while no model is recorded yet. */
  model: Schema.optionalKey(Schema.String),
  /** The original run's result text; omitted until it produces one. */
  summary: Schema.optionalKey(Schema.String),
  seen: Schema.optional(OrchestrationV2SubagentSeen),
  failure: Schema.optional(
    OrchestrationV2ProviderFailure.annotate({
      description:
        "Structured provider failure for a failed task, when available. retryable indicates a transient provider failure; the task is still incomplete.",
    }),
  ),
  /** Omitted until the original run's result can transfer context. */
  resultContextTransferId: Schema.optionalKey(ContextTransferId),
  pendingRequests: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: RuntimeRequestId,
        kind: Schema.String,
        label: Schema.String.check(Schema.isMaxLength(80)),
        threadId: Schema.optionalKey(ThreadId),
      }),
    ),
  ).annotate({ description: "Pending handles; an omitted threadId is the task's child thread." }),
  /** Present (true) only while a blocking question waits. */
  hasPendingQuestion: Schema.optionalKey(Schema.Literal(true)).annotate({
    description:
      "Blocking question ends mode=wait. Read/respond to user_input with t3_pending_request_* and its id/threadId; completion still wakes this thread.",
  }),
  /** A worktree child's own checkout and recorded branch, for reviewing and merging its commits. */
  worktree: Schema.optional(
    Schema.Struct({ path: Schema.String, branch: Schema.NullOr(Schema.String) }),
  ),
  /** How the request was adjusted to run (for example, no worktree), or that a repeat check found no change. */
  notice: Schema.optional(Schema.String),
  /** Present (true) only on the mode=wait call whose timeoutMs elapsed. */
  waitTimedOut: Schema.optionalKey(Schema.Literal(true)).annotate({
    description:
      "The timeout does not cancel the child. Later task_status reads omit it and use status for liveness.",
  }),
});
export type OrchestratorMcpDelegateTaskResult = typeof OrchestratorMcpDelegateTaskResult.Type;

export const OrchestratorMcpCouncilResult = Schema.Struct({
  answers: Schema.Array(
    Schema.Struct({
      providerInstanceId: Schema.NullOr(Schema.String),
      model: Schema.NullOr(Schema.String),
      taskId: Schema.NullOr(NodeId),
      status: Schema.String,
      answer: Schema.NullOr(Schema.String),
      waitTimedOut: Schema.Boolean,
      error: Schema.optional(Schema.String),
    }),
  ),
  note: Schema.String,
});
export type OrchestratorMcpCouncilResult = typeof OrchestratorMcpCouncilResult.Type;

export const OrchestratorMcpTaskStatusInput = Schema.Struct({
  taskId: describeInput(
    NodeId,
    "Task handle, full taskId, or unique clientRequestId from this parent thread.",
  ),
  grades: Schema.optionalKey(OrchestratorMcpTaskGrades),
});
export type OrchestratorMcpTaskStatusInput = typeof OrchestratorMcpTaskStatusInput.Type;

export const OrchestratorMcpTaskCancelInput = Schema.Struct({
  taskId: describeInput(
    NodeId,
    "Task handle, full taskId, or unique clientRequestId from this parent thread.",
  ),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpTaskCancelInput = typeof OrchestratorMcpTaskCancelInput.Type;

export const OrchestratorMcpTaskCancelResult = Schema.Struct({
  taskId: NodeId,
  status: Schema.Literals(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
});
export type OrchestratorMcpTaskCancelResult = typeof OrchestratorMcpTaskCancelResult.Type;

export const OrchestratorMcpCreateThreadRequest = Schema.Struct({
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  target: Schema.optional(OrchestratorMcpTarget),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpCreateThreadRequest = typeof OrchestratorMcpCreateThreadRequest.Type;

export const OrchestratorMcpCreateThreadsInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  threads: Schema.Array(OrchestratorMcpCreateThreadRequest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpCreateThreadsInput = typeof OrchestratorMcpCreateThreadsInput.Type;

export const OrchestratorMcpCreatedThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  Schema.Literal("preparing"),
  OrchestratorMcpDelegatedTaskStatus,
  Schema.Literal("rolled_back"),
]);
export type OrchestratorMcpCreatedThreadStatus = typeof OrchestratorMcpCreatedThreadStatus.Type;

export const OrchestratorMcpCreatedThread = Schema.Struct({
  startup: Schema.Literals(["started", "still starting", "failed"]),
  error: Schema.optional(Schema.String),
  notice: Schema.optional(Schema.String),
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpCreatedThreadStatus,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: McpCreationSource,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
});
export type OrchestratorMcpCreatedThread = typeof OrchestratorMcpCreatedThread.Type;

export const OrchestratorMcpCreateThreadsResult = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreatedThread),
});
export type OrchestratorMcpCreateThreadsResult = typeof OrchestratorMcpCreateThreadsResult.Type;

export const OrchestratorMcpThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  OrchestrationV2RunStatus,
]);
export type OrchestratorMcpThreadStatus = typeof OrchestratorMcpThreadStatus.Type;

const OrchestratorMcpProjectTarget = Schema.optional(
  ProjectId.annotate({
    description:
      "Project to act on. Omit for the calling thread's project; required when the caller is not a SSHCode thread.",
  }),
);

// Codex hides `minimum` and `maximum` from the model, so a value above the maximum clamps on
// decode instead of failing the call; pagination returns the rest. Values below 1 still fail:
// 0 asks for nothing, and answering it with one item would be a different request.
export const clampedPositiveInt = (maximum: number) =>
  PositiveInt.pipe(
    Schema.decodeTo(
      PositiveInt.check(Schema.isLessThanOrEqualTo(maximum)),
      SchemaTransformation.transform({
        decode: (value) => Math.min(value, maximum),
        encode: (value) => value,
      }),
    ),
  );

export const OrchestratorMcpThreadListInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
  statuses: Schema.optional(
    Schema.Array(OrchestratorMcpThreadStatus).check(Schema.isMaxLength(10)),
  ),
  titleContains: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  settled: Schema.optional(Schema.Boolean),
  snoozed: Schema.optional(Schema.Boolean),
  includeSubagents: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(clampedPositiveInt(100)),
});
export type OrchestratorMcpThreadListInput = typeof OrchestratorMcpThreadListInput.Type;

const ThreadBackgroundFields = {
  blockedOnThreadWait: Schema.optional(Schema.Boolean).annotate({
    description: "Waiting on threads.",
  }),
  pendingBackgroundTasks: Schema.optional(
    Schema.Array(
      Schema.Struct({
        taskId: TrimmedNonEmptyString,
        kind: Schema.Literals(["subagent", "command", "monitor", "background_task"]),
        description: Schema.optional(TrimmedNonEmptyString),
        childThreadId: Schema.optional(ThreadId),
      }),
    ),
  ).annotate({ description: "Open background work." }),
};

/** A list row; fields with no value are left out, and t3_thread_read has the rest. */
export const OrchestratorMcpThreadListItem = Schema.Struct({
  ...ThreadBackgroundFields,
  threadId: ThreadId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: McpCreationSource,
  status: OrchestratorMcpThreadStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.optional(ThreadLinkedPullRequest),
  settled: Schema.Boolean,
  settledAt: Schema.optional(IsoDateTime),
  snoozed: Schema.Boolean,
  /** When a snoozed thread wakes. */
  snoozedUntil: Schema.optional(IsoDateTime),
  /** Present only for a pinned thread. */
  pinned: Schema.optional(Schema.Boolean),
  parentThreadId: Schema.optional(ThreadId),
  relationshipToParent: Schema.optional(Schema.Literals(["fork", "subagent"])),
  itemCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadListItem = typeof OrchestratorMcpThreadListItem.Type;

export const OrchestratorMcpThreadListResult = Schema.Struct({
  projectId: ProjectId,
  /** The calling thread, or null when the caller is not a SSHCode thread. */
  currentThreadId: Schema.NullOr(ThreadId),
  threads: Schema.Array(OrchestratorMcpThreadListItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type OrchestratorMcpThreadListResult = typeof OrchestratorMcpThreadListResult.Type;

export const OrchestratorMcpThreadReadInput = Schema.Struct({
  threadId: OrchestratorMcpThreadReference,
  itemId: Schema.optional(TurnItemId),
  textOffset: Schema.optional(NonNegativeInt),
  view: Schema.optional(Schema.Literals(["messages", "activity"])),
  afterPosition: Schema.optional(NonNegativeInt),
  /** Read the latest items in position order; beforePosition continues backwards. */
  fromEnd: Schema.optional(Schema.Boolean),
  beforePosition: Schema.optional(NonNegativeInt),
  /** Case-insensitive, all-words search, returning matches newest first. */
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(1_000))),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  /** 0 leaves runs out. */
  runLimit: Schema.optional(NonNegativeInt.check(Schema.isLessThanOrEqualTo(50))),
  maxCharsPerItem: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50_000))),
});
export type OrchestratorMcpThreadReadInput = typeof OrchestratorMcpThreadReadInput.Type;

export const OrchestratorMcpThreadDetail = Schema.Struct({
  ...ThreadBackgroundFields,
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: McpCreationSource,
  status: OrchestratorMcpThreadStatus,
  /** Omitted until the thread has a run. */
  latestRunId: Schema.optionalKey(RunId),
  /** Omitted while no run is active. */
  activeRunId: Schema.optionalKey(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  linkedPullRequest: Schema.optionalKey(ThreadLinkedPullRequest),
  titleRegeneration: Schema.optionalKey(ThreadTitleRegeneration),
  branch: Schema.optionalKey(Schema.String),
  worktreePath: Schema.optionalKey(Schema.String),
  parentThreadId: Schema.optionalKey(ThreadId),
  relationshipToParent: Schema.optionalKey(Schema.Literals(["fork", "subagent"])),
  runCount: NonNegativeInt,
  itemCount: NonNegativeInt,
  pendingRequestCount: NonNegativeInt,
  archived: Schema.Boolean,
  settled: Schema.Boolean,
  settledAt: Schema.optionalKey(IsoDateTime),
  snoozed: Schema.Boolean,
  /** When a snoozed thread wakes; omitted when it is not snoozed. */
  snoozedUntil: Schema.optionalKey(IsoDateTime),
  /** Present only for a pinned thread. */
  pinned: Schema.optional(Schema.Boolean),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadDetail = typeof OrchestratorMcpThreadDetail.Type;

export const OrchestratorMcpThreadRun = Schema.Struct({
  runId: RunId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  requestedAt: IsoDateTime,
  /** Omitted until the run starts. */
  startedAt: Schema.optionalKey(IsoDateTime),
  /** Omitted until the run ends. */
  completedAt: Schema.optionalKey(IsoDateTime),
});
export type OrchestratorMcpThreadRun = typeof OrchestratorMcpThreadRun.Type;

export const OrchestratorMcpThreadTimelineItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  /** Omitted when the item belongs to the thread being read. */
  sourceThreadId: Schema.optionalKey(ThreadId),
  itemId: TurnItemId,
  subagentId: Schema.optional(NodeId),
  runId: Schema.optionalKey(RunId),
  messageId: Schema.optionalKey(MessageId),
  createdBy: Schema.optionalKey(OrchestrationV2Actor),
  creationSource: Schema.optionalKey(McpCreationSource),
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.optionalKey(Schema.String),
  /** Omitted when the item has no text. */
  text: Schema.optionalKey(Schema.String),
  snippet: Schema.optional(Schema.String),
  /** Present (true) only while more text remains at nextTextOffset. */
  textTruncated: Schema.optionalKey(Schema.Literal(true)),
  nextTextOffset: Schema.optional(NonNegativeInt),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = typeof OrchestratorMcpThreadTimelineItem.Type;

export const OrchestratorMcpThreadReadResult = Schema.Struct({
  thread: OrchestratorMcpThreadDetail,
  recentRuns: Schema.Array(OrchestratorMcpThreadRun),
  items: Schema.Array(OrchestratorMcpThreadTimelineItem),
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
  /** Exclusive backward cursor, also used to continue a bounded search. */
  prevPosition: Schema.optional(Schema.NullOr(NonNegativeInt)),
  search: Schema.optional(
    Schema.Struct({
      scannedItems: NonNegativeInt,
      scanLimitReached: Schema.Boolean,
      /** Null means the scan bound was reached before another match could be found. */
      hasMoreMatches: Schema.NullOr(Schema.Boolean),
    }),
  ),
});
export type OrchestratorMcpThreadReadResult = typeof OrchestratorMcpThreadReadResult.Type;

export const OrchestratorMcpThreadSendInput = Schema.Struct({
  threadId: OrchestratorMcpThreadReference,
  message: OrchestratorMcpPrompt,
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  grades: Schema.optionalKey(OrchestratorMcpTaskGrades),
});
export type OrchestratorMcpThreadSendInput = typeof OrchestratorMcpThreadSendInput.Type;

export const OrchestratorMcpThreadSendResult = Schema.Struct({
  grades: Schema.optional(OrchestratorMcpGradesResult),
  threadId: ThreadId,
  messageId: MessageId,
  /** Omitted when taskId names the run; null while `held` before the message has one. */
  runId: Schema.optionalKey(Schema.NullOr(RunId)),
  /** Short handle for a follow-up to an app-owned child; the previous task stays terminal. */
  taskId: Schema.optional(NodeId),
  status: Schema.NullOr(OrchestrationV2RunStatus),
  delivery: Schema.Literals(["started", "queued", "steered", "restarted", "held"]),
});
export type OrchestratorMcpThreadSendResult = typeof OrchestratorMcpThreadSendResult.Type;

export const OrchestratorMcpThreadWaitInput = Schema.Struct({
  threadId: OrchestratorMcpThreadReference,
  runId: Schema.optional(RunId),
  timeoutMs: Schema.optional(Schema.Number),
});
export type OrchestratorMcpThreadWaitInput = typeof OrchestratorMcpThreadWaitInput.Type;

export const OrchestratorMcpThreadWaitResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpThreadStatus,
  timedOut: Schema.Boolean,
  notice: Schema.optional(Schema.String),
});
export type OrchestratorMcpThreadWaitResult = typeof OrchestratorMcpThreadWaitResult.Type;

export const OrchestratorMcpThreadInterruptInput = Schema.Struct({
  threadId: OrchestratorMcpThreadReference,
  runId: Schema.optional(RunId),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadInterruptInput = typeof OrchestratorMcpThreadInterruptInput.Type;

export const OrchestratorMcpThreadInterruptResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: Schema.Union([
    Schema.Literal("interrupt_requested"),
    Schema.Literal("no_active_run"),
    Schema.Literals(["completed", "failed", "cancelled", "interrupted", "rolled_back"]),
  ]),
});
export type OrchestratorMcpThreadInterruptResult = typeof OrchestratorMcpThreadInterruptResult.Type;

export const OrchestratorMcpCapabilitiesInput = Schema.Struct({
  providerInstanceId: Schema.optional(ProviderInstanceId),
  modelSearch: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
  includeOptions: Schema.optional(Schema.Boolean),
});
export type OrchestratorMcpCapabilitiesInput = typeof OrchestratorMcpCapabilitiesInput.Type;

export const OrchestratorMcpProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.NullOr(Schema.String),
      /** Model options a target may select (for example reasoning effort). */
      options: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
      family: Schema.optional(Schema.String),
      yourRuns: Schema.optionalKey(Schema.String),
      /** Present (false) only for a model its provider says cannot read images. */
      images: Schema.optionalKey(Schema.Literal(false)),
      isLegacy: Schema.optional(Schema.Boolean),
      /** The newer version of this family/line, possibly on another provider instance. */
      supersededBy: Schema.optional(Schema.String),
      supersededByProviderInstanceId: Schema.optional(ProviderInstanceId),
      /** The provider said this model is gone. */
      unavailable: Schema.optionalKey(Schema.String),
      recentFailure: Schema.optionalKey(Schema.String).annotate({
        description: "Recent consecutive failures.",
      }),
    }),
  ),
  /** All matching models, present only while more remain past `nextCursor`. */
  totalModels: Schema.optionalKey(NonNegativeInt),
  /** Cursor for the next page; omitted on the last one. */
  nextCursor: Schema.optionalKey(NonNegativeInt),
  /** Runtime modes the provider offers; omitted when it offers all of them. */
  runtimeModes: Schema.optional(Schema.Array(RuntimeMode)),
  /** Present (false) only when it cannot run a child task now; constraints or accountUnavailable say why. */
  canRunChildTask: Schema.optionalKey(Schema.Literal(false)),
  /** Why it cannot run a child task; omitted when nothing stops it. */
  constraints: Schema.optionalKey(Schema.Array(Schema.String)),
  /** All models on this instance share this account failure. Recheck, not guaranteed recovery. */
  accountUnavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.String,
      recheckAt: Schema.optional(IsoDateTime),
    }),
  ),
  /** When to use this provider, for one that isn't an ordinary cloud provider. */
  note: Schema.optional(Schema.String),
  /** Present only when the provider trains on what it is sent, always or with an option on. */
  dataUse: Schema.optionalKey(Schema.String),
  /** Its latest run failed: a usage limit (until it resets) or a provider error. Pick another. */
  recentFailure: Schema.optional(Schema.String),
});
export type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  /** The calling thread, or null when the caller is not a SSHCode thread. */
  parentThreadId: Schema.NullOr(ThreadId),
  /** The calling thread's selection, or null when the caller is not a SSHCode thread. */
  inheritedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  inheritedModel: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  providers: Schema.Array(OrchestratorMcpProviderCapability),
  features: Schema.Struct({
    appOwnedSubagents: Schema.Boolean,
    asyncPolling: Schema.Boolean,
    cancellation: Schema.Boolean,
    batchThreadCreation: Schema.Boolean,
    threadManagement: Schema.Boolean,
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
    maxBatchThreads: Schema.Number,
  }),
});
export type OrchestratorMcpCapabilitiesResult = typeof OrchestratorMcpCapabilitiesResult.Type;

export const OrchestratorMcpScheduleTaskInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
  prompt: OrchestratorMcpPrompt.annotate({
    description: "Prompt executed on every scheduled run.",
  }),
  schedule: OrchestratorMcpSchedule,
  title: Schema.optional(OrchestratorMcpTitle),
  enabled: Schema.optional(
    Schema.Boolean.annotate({ description: "Whether the schedule starts enabled; defaults true." }),
  ),
  /**
   * When true (the default), the scheduled task fires into the calling thread
   * on each run instead of launching a fresh thread. This is the recurring
   * "wake up in this thread" behaviour reserved for agent-created tasks.
   */
  bindToCurrentThread: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "True (default) posts each run into this thread for orchestration/deduplication; false creates a fresh top-level thread per run.",
    }),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpScheduleTaskInput = typeof OrchestratorMcpScheduleTaskInput.Type;

/** Create a task, or update one when scheduledTaskId is supplied. */
export const OrchestratorMcpSaveScheduledTaskInput = Schema.Struct({
  ...OrchestratorMcpScheduleTaskInput.fields,
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  prompt: Schema.optional(OrchestratorMcpPrompt),
  schedule: Schema.optional(OrchestratorMcpSchedule),
});
export type OrchestratorMcpSaveScheduledTaskInput =
  typeof OrchestratorMcpSaveScheduledTaskInput.Type;

/** Summary of a scheduled task returned by the schedule/list/update tools. */
export const OrchestratorMcpScheduledTask = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  /** For webhook tasks: the public T3 Connect URL, returned only on creation. */
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL to give the sender, only on creation by a caller allowed to run it; lists and updates omit it (see Settings). Also absent without T3 Connect remote access.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])).annotate({
    description: "Whether requests must carry a valid signature.",
  }),
  /** Template and signature mechanics, delivered only with webhook tasks. */
  webhookSetup: Schema.optional(Schema.String),
});
export type OrchestratorMcpScheduledTask = typeof OrchestratorMcpScheduledTask.Type;

export const OrchestratorMcpScheduleTaskResult = OrchestratorMcpScheduledTask;
export type OrchestratorMcpScheduleTaskResult = typeof OrchestratorMcpScheduleTaskResult.Type;

export const OrchestratorMcpListScheduledTasksInput = Schema.Struct({
  projectId: Schema.optional(
    ProjectId.annotate({
      description:
        "Only list this project's tasks. Omit for the calling thread's project, or for every project when the caller is not a SSHCode thread.",
    }),
  ),
  scheduledTaskId: Schema.optional(ScheduledTaskId),
});
export type OrchestratorMcpListScheduledTasksInput =
  typeof OrchestratorMcpListScheduledTasksInput.Type;

export const OrchestratorMcpListScheduledTasksResult = Schema.Struct({
  tasks: Schema.Array(OrchestratorMcpScheduledTask),
});
export type OrchestratorMcpListScheduledTasksResult =
  typeof OrchestratorMcpListScheduledTasksResult.Type;

export const OrchestratorMcpUpdateScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  schedule: Schema.optional(OrchestratorMcpSchedule),
  enabled: Schema.optional(Schema.Boolean),
  bindToCurrentThread: Schema.optional(Schema.Boolean),
});
export type OrchestratorMcpUpdateScheduledTaskInput =
  typeof OrchestratorMcpUpdateScheduledTaskInput.Type;

export const OrchestratorMcpRequestSecretInput = Schema.Struct({
  apiKey: Schema.optional(ApiKeyRequest),
  label: TrimmedNonEmptyString.annotate({
    description: "What you need, shown as the card's title, e.g. 'GitHub webhook secret'.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description:
      "One or two sentences on what it is for and where the user gets or also enters it.",
  }),
  placeholder: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "Hint inside the input, e.g. 'Paste your GitHub token'.",
  }),
  delivery: Schema.optional(Schema.Literals(["secretRef", "file"])).annotate({
    description:
      "secretRef (default): for a T3 tool that takes one. file: for shell commands such as sudo or a CLI token; the result is a private file path to read inside your command, e.g. sudo -S -p '' <cmd> < <file>, ssh <host> \"sudo -S -p '' <cmd>\" < <file>, or TOKEN=\"$(cat <file>)\" <cli>.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description:
      "Reuse to get the same card or its saved result again, including after the answer message.",
  }),
});
export type OrchestratorMcpRequestSecretInput = typeof OrchestratorMcpRequestSecretInput.Type;

export const OrchestratorMcpRequestSecretResult = Schema.Union([
  // The tool description and the note say what "asked" means; the schema does not repeat it.
  Schema.Struct({
    status: Schema.Literal("asked"),
    clientRequestId: OrchestratorMcpClientRequestId,
    note: Schema.String,
  }),
  Schema.Struct({ status: Schema.Literal("api_key_saved"), note: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("saved").annotate({ description: "secretRef holds the value." }),
    secretRef: SecretRef.annotate({
      description:
        "Pass it to a tool that accepts a secretRef; it works once, and you never see the value.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literal("saved").annotate({ description: "file holds the value." }),
    file: Schema.String.annotate({
      description:
        "Owner-only file with the value. Read it inside commands and never print it; reuse it for this chat's later commands.",
    }),
    deletedAt: Schema.String.annotate({ description: "When the file is deleted." }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled"]).annotate({
      description:
        "declined: the user chose not to. cancelled: the card was dismissed; use a new clientRequestId to ask again.",
    }),
  }),
]);
export type OrchestratorMcpRequestSecretResult = typeof OrchestratorMcpRequestSecretResult.Type;

const OrchestratorMcpAskUserOption = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({ description: "The choice as the user sees it." }),
  description: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "One short line on what picking it means.",
  }),
});

const OrchestratorMcpAskUserQuestion = Schema.Struct({
  question: TrimmedNonEmptyString.annotate({ description: "The full question." }),
  header: Schema.optional(TrimmedNonEmptyString).annotate({
    description: "A label of a few words, e.g. 'Database'. Defaults to 'Question'.",
  }),
  options: Schema.optional(Schema.Array(OrchestratorMcpAskUserOption)).annotate({
    description:
      'Choices to pick from; the user can always write their own answer instead. Put the one you recommend first, ending its label with "(Recommended)". Omit for a free-text question.',
  }),
  multiSelect: Schema.optional(Schema.Boolean).annotate({
    description: "Let the user pick more than one option.",
  }),
  important: Schema.optional(Schema.Boolean).annotate({
    description:
      "Set when the decision is important enough that the user should make it themselves, such as spending beyond what they approved, one that is hard to undo, or one only they can make. It waits for their answer however long it takes; otherwise an unanswered question takes the recommended option after 10 minutes.",
  }),
});

export const OrchestratorMcpAskUserInput = Schema.Struct({
  questions: Schema.Array(OrchestratorMcpAskUserQuestion).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description: "Reuse when retrying a call that lost its result, so the user sees one card.",
  }),
});
export type OrchestratorMcpAskUserInput = typeof OrchestratorMcpAskUserInput.Type;

export const OrchestratorMcpAskUserResult = Schema.Struct({
  requestId: RuntimeRequestId,
  status: Schema.Literal("asked"),
  note: Schema.String,
});
export type OrchestratorMcpAskUserResult = typeof OrchestratorMcpAskUserResult.Type;

export const OrchestratorMcpDeleteScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
});
export type OrchestratorMcpDeleteScheduledTaskInput =
  typeof OrchestratorMcpDeleteScheduledTaskInput.Type;

export const OrchestratorMcpDeleteScheduledTaskResult = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  deleted: Schema.Boolean,
});
export type OrchestratorMcpDeleteScheduledTaskResult =
  typeof OrchestratorMcpDeleteScheduledTaskResult.Type;

export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "parent_not_active",
      "provider_unavailable",
      "account_unavailable",
      "model_unavailable",
      "runtime_mode_escalation_denied",
      "interaction_mode_escalation_denied",
      "task_not_found",
      "task_not_cancellable",
      "thread_not_found",
      "run_not_found",
      "thread_not_sendable",
      "thread_not_interruptible",
      "invalid_request",
      "orchestration_error",
      "thread_credential_required",
      "target_required",
    ]),
    message: Schema.String,
  },
) {}
