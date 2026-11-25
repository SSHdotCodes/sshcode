import { automaticProviderRetryPresentation } from "@t3tools/shared/orchestrationV2ThreadError";
import type {
  ThreadPendingApproval,
  ThreadPendingUserInput,
  ThreadUserInputQuestion,
} from "@t3tools/client-runtime/state/thread-requests";
import { turnItemIsWorkspacePreparation } from "@t3tools/client-runtime/state/turn-item-presentation";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import { isLiveSubagentTurnItem } from "@t3tools/client-runtime/state/subagentRuntime";
import { extractToolActivityPresentation } from "@t3tools/client-runtime/work-log/tool-presentation";
import {
  mergeMonitorUpdates,
  monitorNotificationLabel,
  monitorUpdateContinues,
} from "@t3tools/client-runtime/work-log/monitor-notification";
import {
  turnItemDetailRevision,
  turnItemHasDetail,
  turnItemNeedsDetailFetch,
} from "@t3tools/client-runtime/work-log/item-detail";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { resumedRestartNoticeIds } from "@t3tools/client-runtime/work-log/restart-notice";
import {
  contextCompactionLabel,
  toolItemForDisplay,
  workEntryDisplayIndicatesToolFailure,
  isNewerRunningTool,
  commandlessCommandLabel,
  liveToolActivityLabel,
  runningToolStatusLabel,
  toolGroupAction,
  resolveWorkEntryToolPresentation,
  summarizeToolGroup,
  isChatAttachmentImagePath,
  workEntryViewedImagePath,
  toolGroupSummaryKind,
  type ToolGroupSummaryKind,
  type WorkLogPresentationEntry,
  type WorkLogToolLifecycleStatus,
} from "@t3tools/client-runtime/work-log/presentation";
import {
  resolveT3McpToolDefinition,
  resolveT3McpToolPresentation,
  type T3McpToolLogo,
  type T3McpToolPresentation,
} from "@t3tools/shared/t3McpToolPresentation";
import type {
  ChatAttachment,
  MessageId,
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2ExecutionNode,
  OrchestrationMessageContext,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2RunAttempt,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItem,
  OrchestrationV2UserMessageInputIntent,
  RunAttemptId,
  ScheduledTaskId,
  TurnItemId,
  UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";
import { RunId, ThreadId } from "@t3tools/contracts";
import {
  classifyToolActivity,
  collectToolFilePaths,
  dynamicToolTitle,
  isJavaScriptReplTool,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import type { McpAppReference } from "@t3tools/shared/mcpApp";
import {
  compactDynamicToolOutput,
  htmlRenderFromToolItem,
  mcpAppFromToolItem,
} from "@t3tools/shared/toolOutput";
import { delegatedTaskHandle } from "@t3tools/shared/delegatedTaskHandle";
import * as DateTime from "effect/DateTime";

export type PendingApproval = ThreadPendingApproval;
export type PendingUserInput = ThreadPendingUserInput;

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionValues?: ReadonlyArray<string>;
  readonly customAnswer?: string;
  readonly attachmentCount?: number;
  readonly attachmentsBlocked?: boolean;
}

export interface ThreadFeedActivity {
  readonly id: string;
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly attemptId: RunAttemptId | null;
  readonly summary: string;
  readonly detail: string | null;
  readonly canExpand: boolean;
  /** Expanding fetches the withheld input and output with getTurnItem. */
  readonly fetchesDetail: boolean;
  readonly getFullDetail: () => string | null;
  readonly getCopyText: () => string;
  readonly icon:
    | "agent"
    | "alert"
    | "browser"
    | "computer"
    | "code"
    | "check"
    | "command"
    | "edit"
    | "eye"
    | "globe"
    | "search"
    | "hammer"
    | "lock"
    | "message"
    | "warning"
    | "wrench"
    | "zap";
  readonly logo: T3McpToolLogo | null;
  readonly toolLike: boolean;
  readonly prominent: boolean;
  readonly status: "success" | "failure" | "neutral" | null;
  readonly lifecycleStatus: WorkLogToolLifecycleStatus;
  readonly workEntry: WorkLogPresentationEntry;
  readonly groupedToolDetail?: boolean;
  readonly live?: boolean;
  readonly projectedItem: OrchestrationV2ProjectedTurnItem;
}

export interface ThreadFeedMessage {
  readonly context?: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
  readonly id: MessageId;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly runId: RunId | null;
  readonly streaming: boolean;
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  /** Set on the message that answers an `ask_user` card, which shows as a folded answer row. */
  readonly questionAnswer?: UserInputAttachmentAnswerPayload;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
  readonly sourceThreadId: ThreadId;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly projectedItem?: OrchestrationV2ProjectedTurnItem;
}

/** A message shown before the server has it: a pending creation or local feedback. */
export interface LocalThreadMessage {
  readonly id: MessageId;
  readonly role: string;
  readonly text: string;
  readonly context?: OrchestrationMessageContext | undefined;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type RawThreadFeedEntry =
  | {
      readonly type: "message";
      readonly id: string;
      readonly createdAt: string;
      readonly message: ThreadFeedMessage;
    }
  | {
      readonly type: "activity";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly activity: ThreadFeedActivity;
    }
  | {
      /** A page a completed `html_render` call published, shown in place of its work row. */
      readonly type: "html-render";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly render: HtmlRenderReference;
    }
  | {
      /** An MCP App a completed tool call captured, hosted in place of its work row. */
      readonly type: "mcp-app";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      /** The thread and item that own the app; a fork's inherited app is its source's. */
      readonly sourceThreadId: ThreadId;
      readonly itemId: TurnItemId;
      readonly revision: string;
      readonly app: McpAppReference;
    };

export type ThreadFeedEntry = ThreadFeedEntryContent & { readonly continuesWorkLog?: boolean };

type ThreadFeedEntryContent =
  | Extract<RawThreadFeedEntry, { type: "message" | "html-render" | "mcp-app" }>
  | {
      readonly type: "activity-group";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly activities: ReadonlyArray<ThreadFeedActivity>;
    }
  | {
      readonly type: "work-toggle";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly groupId: string;
      /** The group's calls, so the collapsed row can show images they produced. */
      readonly activities: ReadonlyArray<ThreadFeedActivity>;
      readonly hiddenCount: number;
      readonly expanded: boolean;
      readonly summary: string;
      readonly summaryKind: ToolGroupSummaryKind;
      readonly toolSurface?: WorkLogPresentationEntry["toolSurface"];
      readonly toolIcon?: WorkLogPresentationEntry["toolIcon"];
      readonly summaryToolIcon?:
        | "browser"
        | "computer"
        | "device"
        | "t3-code"
        | "pull-request"
        | "x-logo";
      readonly hasFailure: boolean;
      readonly live: boolean;
      readonly shimmer: boolean;
    }
  | {
      /** Viewed files stay visible when the containing run's work is folded. */
      readonly type: "viewed-images";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly activities: ReadonlyArray<ThreadFeedActivity>;
    }
  | {
      readonly type: "run-fold";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId;
      readonly label: string;
      readonly expanded: boolean;
    }
  | {
      readonly type: "thinking";
      readonly id: string;
      readonly createdAt: string;
      readonly runId: RunId | null;
      readonly label: string;
      readonly shimmer?: true;
    };

export interface ThreadFeedLatestRun {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
}

export interface AgentSpawnSummary {
  readonly title: string;
  readonly status: string;
  readonly tone: "working" | "completed" | "failed" | "stopped";
  readonly members: ReadonlyArray<{
    readonly title: string;
    readonly status: string;
    readonly tone: "working" | "completed" | "failed" | "stopped";
    readonly detail: string | undefined;
    readonly updatedAt: string;
  }>;
}

function compactWorkEntryText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

/** Expanded work rows keep their detail while compact rows show a stable one-line label. */
export function workEntryRowLabel(entry: WorkLogPresentationEntry, expanded = false): string {
  if (expanded && entry.itemType === "reasoning")
    return entry.toolLifecycleStatus === "inProgress" ? "Thinking" : "Thought";
  const presentation = resolveWorkEntryToolPresentation(entry);
  if (presentation) return presentation.displayName;
  if (entry.command?.trim()) return compactWorkEntryText(commandDisplayText(entry.command));
  const commandless = commandlessCommandLabel(entry);
  if (commandless !== null) return commandless;
  const action = toolGroupAction(entry);
  const isToolRead = action === "read" && entry.itemType === "dynamic_tool";
  if (action === "code-search" || action === "search") {
    const toolData =
      entry.toolData !== null &&
      typeof entry.toolData === "object" &&
      !Array.isArray(entry.toolData)
        ? (entry.toolData as Record<string, unknown>)
        : undefined;
    // Adapters title file searches with their target; the item keeps only the pattern.
    const searchLabel =
      entry.itemType === "file_search" ? entry.label : formatSearchToolLabel(toolData);
    if (searchLabel) return searchLabel;
  }
  if (isToolRead) {
    const [firstPath] = entry.changedFiles ?? collectToolFilePaths(entry.toolData);
    if (firstPath) {
      return formatReadToolLabel(firstPath, Math.max(0, (entry.changedFiles?.length ?? 1) - 1));
    }
    if (!expanded) return "Read file";
  }
  const preview =
    entry.command ??
    (isToolRead || (!expanded && (action === "code-search" || action === "search"))
      ? null
      : entry.detail) ??
    (entry.changedFiles?.length
      ? entry.changedFiles.length === 1
        ? entry.changedFiles[0]!
        : `${entry.changedFiles[0]!} +${entry.changedFiles.length - 1} more`
      : null);
  if (expanded) return preview?.trim() || entry.label;
  return preview ? compactWorkEntryText(preview) || entry.label : entry.label;
}

type ThreadFeedActivityGroup = Extract<ThreadFeedEntry, { readonly type: "activity-group" }>;

// Immutable source rows let retained history keep its identities while the active item streams.
const projectedEntriesCache = new WeakMap<
  OrchestrationV2ProjectedTurnItem,
  {
    readonly attemptId: RunAttemptId | null;
    readonly entry: RawThreadFeedEntry;
  }
>();
const localMessageEntriesCache = new WeakMap<
  LocalThreadMessage,
  Extract<RawThreadFeedEntry, { readonly type: "message" }>
>();
const activityGroupsCache = new WeakMap<ThreadFeedActivity, ThreadFeedActivityGroup>();
const failedActivityGroupsCache = new WeakMap<
  ThreadFeedActivityGroup,
  ReadonlyArray<ThreadFeedActivityGroup>
>();
const presentedActivityGroupsCache = new WeakMap<
  ThreadFeedActivityGroup,
  {
    readonly activeRunId: RunId | null;
    readonly isWorking: boolean;
    readonly activeTail: boolean;
    readonly runningTool: ThreadFeedActivity | undefined;
    readonly rows: ReadonlyArray<ThreadFeedEntry>;
  }
>();
const viewedImageRowsCache = new WeakMap<
  ThreadFeedActivityGroup,
  Extract<ThreadFeedEntry, { readonly type: "viewed-images" }> | null
>();
const runFoldRowsCache = new WeakMap<
  ThreadFeedEntry,
  Extract<ThreadFeedEntry, { readonly type: "run-fold" }>
>();
let cachedThinkingRow: Extract<ThreadFeedEntry, { readonly type: "thinking" }> | null = null;

export function isContextCompactionActivityGroup(entry: ThreadFeedActivityGroup): boolean {
  return (
    entry.activities.length === 1 && entry.activities[0]?.projectedItem.item.type === "compaction"
  );
}

export function isContextHandoffActivityGroup(entry: ThreadFeedActivityGroup): boolean {
  return (
    entry.activities.length === 1 && entry.activities[0]?.projectedItem.item.type === "handoff"
  );
}

export function isSecretRequestActivityGroup(entry: ThreadFeedActivityGroup): boolean {
  return (
    entry.activities.length === 1 &&
    entry.activities[0]?.projectedItem.item.type === "secret_request"
  );
}

function isUserInputActivityGroup(entry: ThreadFeedActivityGroup): boolean {
  return entry.activities.some((activity) => activity.workEntry.questionAnswer !== undefined);
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function resolvePendingUserInputOptionValue(
  question: ThreadUserInputQuestion,
  value: string,
): string | null {
  if (question.options.some((option) => option.value === value)) {
    return value;
  }

  const label = value.trim();
  return label.length > 0 &&
    question.options.some((option) => option.value === undefined && option.label.trim() === label)
    ? label
    : null;
}

function normalizeSelectedOptionValues(
  question: ThreadUserInputQuestion,
  value: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(
      value
        .map((entry) => resolvePendingUserInputOptionValue(question, entry))
        .filter((entry): entry is string => entry !== null),
    ),
  );
}

function resolvePendingUserInputAnswer(
  question: ThreadUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | ReadonlyArray<string> | null {
  if (draft?.attachmentsBlocked) return null;
  const customAnswer =
    question.allowCustomAnswer === false
      ? null
      : question.initialAnswer !== undefined
        ? (draft?.customAnswer ?? null)
        : normalizeDraftAnswer(draft?.customAnswer);
  const selectedOptionValues = normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  if (customAnswer !== null && customAnswer.length > 0) {
    // A multiple-choice answer can be both: the chosen options, then the user's own words.
    return question.multiSelect && selectedOptionValues.length > 0
      ? [...selectedOptionValues, customAnswer]
      : customAnswer;
  }
  if (question.required === false && question.options.length === 0) {
    return "";
  }

  if (question.multiSelect) {
    return selectedOptionValues.length > 0
      ? selectedOptionValues
      : (customAnswer ??
          (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null));
  }
  return (
    selectedOptionValues[0] ??
    customAnswer ??
    (question.allowCustomAnswer !== false && (draft?.attachmentCount ?? 0) > 0 ? "" : null)
  );
}

function capitalizePhrase(value: string): string {
  const trimmed = value.trim();
  return trimmed.length === 0 ? value : `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

function memoizeValue<T>(build: () => T): () => T {
  let value: T;
  let initialized = false;
  return () => {
    if (!initialized) {
      value = build();
      initialized = true;
    }
    return value;
  };
}

function itemIsToolLike(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "reasoning" ||
    item.type === "command_execution" ||
    item.type === "file_change" ||
    item.type === "file_search" ||
    item.type === "web_search" ||
    item.type === "approval_request" ||
    item.type === "user_input_request" ||
    item.type === "dynamic_tool" ||
    item.type === "subagent"
  );
}

function itemIsProminent(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "fork" ||
    item.type === "thread_created" ||
    item.type === "system_notice" ||
    // An answerable card: it must stand alone and never fold away with the run.
    item.type === "secret_request"
  );
}

function itemStatus(item: OrchestrationV2TurnItem): ThreadFeedActivity["status"] {
  if (item.type === "notification") return item.outcome === "failed" ? "failure" : null;
  if (item.type === "error") {
    if (item.status === "failed")
      return item.failure.class === "usage_limit" ? "neutral" : "failure";
    return item.status === "completed" ? "success" : "neutral";
  }
  if (!itemIsToolLike(item)) return null;
  if (item.status === "failed") return "failure";
  return item.status === "completed" ? "success" : "neutral";
}

function itemLifecycleStatus(item: OrchestrationV2TurnItem): WorkLogToolLifecycleStatus {
  switch (item.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "idle":
      return "idle";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

function itemWorkLogTone(item: OrchestrationV2TurnItem): WorkLogPresentationEntry["tone"] {
  if (item.type === "error") return "info";
  if (item.type === "reasoning") return "thinking";
  switch (item.type) {
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
      return "tool";
    default:
      return "info";
  }
}

function itemIcon(item: OrchestrationV2TurnItem): ThreadFeedActivity["icon"] {
  if (item.type === "notification") {
    const source = item.source;
    switch (source.kind) {
      case "subagent":
      case "delegated_task":
        return "hammer";
      case "command":
        return "command";
      case "monitor":
        return "eye";
      case "background_task":
      case "system":
        return "zap";
      default:
        source satisfies never;
        return "zap";
    }
  }
  if (item.type === "dynamic_tool") {
    const classified = classifyToolActivity({
      itemType: "dynamic_tool_call",
      data: { toolName: item.toolName ?? undefined, input: item.input },
    });
    if (classified === "read") {
      return "eye";
    }
    if (classified === "search") return "search";
  }
  switch (item.type) {
    case "reasoning":
      return "agent";
    case "command_execution":
      return "command";
    case "file_change":
      return "edit";
    case "file_search":
      return "search";
    case "web_search":
      return "globe";
    case "approval_request":
      return item.requestKind === "permission" ? "lock" : "message";
    case "user_input_request":
    case "user_message":
    case "assistant_message":
      return "message";
    case "dynamic_tool":
      return isJavaScriptReplTool(item.toolName) ? "code" : "wrench";
    case "subagent":
      return "hammer";
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return "warning";
    case "error":
      return item.failure.class === "usage_limit"
        ? item.status === "completed"
          ? "check"
          : "warning"
        : "alert";
    case "checkpoint":
    case "proposed_plan":
    case "todo_list":
      return "check";
    case "compaction":
    case "handoff":
    case "fork":
    case "thread_created":
      return "zap";
    case "secret_request":
      return "lock";
  }
}

function itemToolPresentation(item: OrchestrationV2TurnItem): T3McpToolPresentation | null {
  if (item.type !== "dynamic_tool") {
    return null;
  }
  return (
    resolveT3McpToolPresentation(item.toolName, item.input) ??
    resolveT3McpToolPresentation(item.title, item.input)
  );
}

function itemSummary(
  item: OrchestrationV2TurnItem,
  toolPresentation: T3McpToolPresentation | null = null,
): string {
  if (item.type === "notification") return monitorNotificationLabel(item);
  if (item.type === "error") {
    const automatic = automaticProviderRetryPresentation(item);
    if (automatic !== null) return automatic.label;
  }
  if (item.type === "system_notice") return item.message;
  if (item.type === "compaction") return contextCompactionLabel(item);
  const title =
    (item.type === "dynamic_tool"
      ? dynamicToolTitle(item.toolName, item.input, item.title)
      : undefined) ?? item.title?.trim();
  if (item.type === "subagent") return formatSubagentDisplayTitle(title || "Subagent");
  if (title) return toolPresentation?.displayName ?? capitalizePhrase(title);
  switch (item.type) {
    case "reasoning":
      return "Thinking";
    case "command_execution":
      return "Command";
    case "file_change":
      return item.changes !== undefined && item.changes.length > 1
        ? `Changed ${item.changes.length} files`
        : `Changed ${item.fileName}`;
    case "file_search":
      return item.title?.trim() || formatSearchToolLabel(item) || "Searched files";
    case "web_search":
      return "Searched the web";
    case "approval_request":
      return "Approval requested";
    case "user_input_request":
      return "Input requested";
    case "checkpoint":
      return "Checkpoint captured";
    case "run_interrupt_request":
      return "Interrupt requested";
    case "run_interrupt_result":
      return "Run interrupted";
    case "error":
      return item.failure.class === "usage_limit" ? "Usage limit reached" : "Provider error";
    case "handoff":
      return "Context handed off";
    case "fork":
      return "Chat forked";
    case "thread_created":
      return "Chat created";
    case "secret_request":
      return item.label;
    case "dynamic_tool": {
      const classified = classifyToolActivity({
        itemType: "dynamic_tool_call",
        data: { toolName: item.toolName ?? undefined, input: item.input },
      });
      if (classified === "read") {
        const [path] = collectToolFilePaths({ input: item.input });
        return formatReadToolLabel(path ?? "");
      }
      if (classified === "search") {
        return formatSearchToolLabel({ input: item.input }) ?? item.toolName ?? "Tool call";
      }
      return toolPresentation?.displayName ?? item.toolName ?? "Tool call";
    }
    case "proposed_plan":
      return "Proposed plan";
    case "todo_list":
      return "Plan updated";
    case "user_message":
      return "User message";
    case "assistant_message":
      return "Assistant message";
  }
}

function itemPreview(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "reasoning":
      return item.text || null;
    case "command_execution":
      return item.input || null;
    case "file_change":
      return item.fileName;
    case "file_search":
      return item.pattern ?? null;
    case "web_search":
      return item.patterns?.join(", ") ?? null;
    case "approval_request":
      return item.prompt ?? null;
    case "user_input_request":
      return item.questions.map((question) => question.question).join(" · ") || null;
    case "checkpoint":
      return item.files.length === 1
        ? (item.files[0]?.path ?? null)
        : `${item.files.length} changed files`;
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message || null;
    case "error":
      return automaticProviderRetryPresentation(item)?.detail ?? item.failure.message;
    case "compaction":
    case "handoff":
      return item.summary ?? null;
    case "fork":
    case "thread_created":
      return item.targetThreadId;
    case "secret_request":
      return item.reason || null;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return null;
    case "notification":
      return item.detail ?? null;
    case "proposed_plan":
      return item.markdown || null;
    case "todo_list":
      return `${item.steps.filter((step) => step.status === "completed").length}/${item.steps.length} completed`;
    case "user_message":
    case "assistant_message":
      return item.text || null;
  }
}

function toWorkLogEntry(
  item: OrchestrationV2TurnItem,
  createdAt: string,
  summary: string,
  detail: string | null,
): WorkLogPresentationEntry {
  const title = item.title?.trim() || null;
  const common = {
    ...extractToolActivityPresentation(item),
    id: item.id,
    createdAt,
    label: summary,
    tone: itemWorkLogTone(item),
    itemType: item.type,
    toolLifecycleStatus: itemLifecycleStatus(item),
    structuredPayload: item,
    ...(item.type === "user_input_request" && item.questionAnswer
      ? { questionAnswer: item.questionAnswer }
      : {}),
  } as const;

  switch (item.type) {
    case "reasoning":
      return { ...common, ...(item.text ? { detail: item.text } : {}) };
    case "command_execution":
      return {
        ...common,
        command: item.input,
        rawCommand: item.input,
        toolTitle: title ?? "Command",
        toolData: item,
      };
    case "file_change":
      return {
        ...common,
        changedFiles: [item.fileName],
        toolTitle: title ?? "File change",
        toolData: item,
      };
    case "file_search":
      return {
        ...common,
        ...(item.pattern ? { detail: item.pattern } : {}),
        toolTitle: title ?? "File search",
        toolData: item,
      };
    case "web_search":
      return {
        ...common,
        ...(item.patterns?.length ? { detail: item.patterns.join(", ") } : {}),
        toolTitle: title ?? "Web search",
        toolData: item,
      };
    case "checkpoint":
      return { ...common, changedFiles: item.files.map((file) => file.path), toolData: item };
    case "approval_request":
      return {
        ...common,
        ...(item.prompt ? { detail: item.prompt } : {}),
        requestKind: item.requestKind,
        toolData: item,
      };
    case "dynamic_tool":
      return {
        ...common,
        toolTitle: title ?? item.toolName ?? "Tool",
        toolData: { input: item.input, output: item.output },
      };
    default:
      return { ...common, ...(detail ? { detail } : {}), toolData: item };
  }
}

/** Expanded detail for a row, from its wire item or the full item from getTurnItem. */
export function formatItemFullDetail(
  row: OrchestrationV2ProjectedTurnItem,
  item: OrchestrationV2TurnItem,
): string {
  return JSON.stringify(
    {
      visibility: row.visibility,
      sourceThreadId: row.sourceThreadId,
      sourceItemId: row.sourceItemId,
      item: toolItemForDisplay(item),
    },
    null,
    2,
  );
}

export function toFeedActivity(
  row: OrchestrationV2ProjectedTurnItem,
  attemptId: RunAttemptId | null,
): ThreadFeedActivity {
  const item = row.item;
  const toolPresentation = itemToolPresentation(item);
  const summary = itemSummary(item, toolPresentation);
  const detail = item.type === "notification" ? null : itemPreview(item);
  const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
  const workEntry = toWorkLogEntry(item, createdAt, summary, detail);
  const readPaths =
    item.type === "dynamic_tool" && toolGroupAction(workEntry) === "read"
      ? collectToolFilePaths(item)
      : null;
  const getFullDetail = memoizeValue(() =>
    readPaths
      ? readPaths.join("\n") || null
      : item.type === "notification"
        ? item.detail?.trim() || null
        : formatItemFullDetail(row, item),
  );
  const getCopyText = memoizeValue(() =>
    [summary, detail, getFullDetail()]
      .filter(
        (value, index, values): value is string =>
          Boolean(value) && values.indexOf(value) === index,
      )
      .join("\n"),
  );
  return {
    id: `${row.visibility}:${row.sourceThreadId}:${row.sourceItemId}`,
    createdAt,
    runId: item.runId,
    attemptId,
    summary,
    detail,
    canExpand:
      !(item.type === "error" && item.status === "failed") &&
      (readPaths
        ? readPaths.length > 0 || turnItemNeedsDetailFetch(item)
        : turnItemHasDetail(item) || workEntry.questionAnswer !== undefined),
    // Read rows show their paths, then the fetched file contents.
    fetchesDetail: turnItemNeedsDetailFetch(item),
    getFullDetail,
    getCopyText,
    icon: workEntry.toolSurface ?? itemIcon(item),
    logo: toolPresentation?.logo ?? null,
    toolLike: itemIsToolLike(item),
    prominent: itemIsProminent(item) || (item.type === "error" && item.status === "failed"),
    status:
      item.type === "error" && item.failure.class === "usage_limit"
        ? itemStatus(item)
        : workEntryDisplayIndicatesToolFailure(workEntry)
          ? "failure"
          : itemStatus(item),
    lifecycleStatus: itemLifecycleStatus(item),
    workEntry,
    projectedItem: row,
  };
}

function singleToolCallLabel(activity: ThreadFeedActivity, expanded: boolean): string {
  if (activity.workEntry.itemType === "reasoning")
    return expanded
      ? "Thought"
      : compactWorkEntryText(activity.workEntry.detail ?? "") || "Thought";
  const presentation = resolveWorkEntryToolPresentation(activity.workEntry, "completed");
  if (presentation) return presentation.displayName;
  const command = activity.workEntry.command?.trim();
  return command ? compactWorkEntryText(commandDisplayText(command)) : activity.summary;
}

function isEmptyMessage(entry: RawThreadFeedEntry): boolean {
  return (
    entry.type === "message" &&
    entry.message.text.trim().length === 0 &&
    entry.message.attachments.length === 0
  );
}

type RawActivityEntry = Extract<RawThreadFeedEntry, { readonly type: "activity" }>;
type MonitorUpdateItem = Extract<OrchestrationV2TurnItem, { type: "notification" }>;

function monitorUpdateItem(entry: RawThreadFeedEntry | undefined): MonitorUpdateItem | null {
  if (entry?.type !== "activity") return null;
  const item = entry.activity.projectedItem.item;
  return item.type === "notification" &&
    item.source.kind === "monitor" &&
    item.outcome === "updated"
    ? item
    : null;
}

// The merged entry keeps its identity while its run of updates is unchanged, so the
// feed row is not drawn again on every projection update.
const mergedMonitorUpdateEntries = new WeakMap<
  ThreadFeedActivity,
  { readonly last: ThreadFeedActivity; readonly count: number; readonly entry: RawActivityEntry }
>();

/**
 * A monitor that reports several times in a row gets one row, not a wall of rows
 * that all begin with the same description.
 */
function mergeMonitorUpdateEntries(
  entries: ReadonlyArray<RawThreadFeedEntry>,
): ReadonlyArray<RawThreadFeedEntry> {
  let merged: RawThreadFeedEntry[] | null = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const first = monitorUpdateItem(entry);
    const updates: MonitorUpdateItem[] = [];
    let end = index + 1;
    if (first !== null && entry.type === "activity") {
      updates.push(first);
      while (end < entries.length) {
        const next = entries[end]!;
        const nextItem = monitorUpdateItem(next);
        if (
          nextItem === null ||
          next.type !== "activity" ||
          next.activity.attemptId !== entry.activity.attemptId ||
          !monitorUpdateContinues(first, nextItem)
        ) {
          break;
        }
        updates.push(nextItem);
        end += 1;
      }
    }
    if (updates.length < 2 || entry.type !== "activity") {
      merged?.push(entry);
      continue;
    }
    merged ??= entries.slice(0, index);
    const last = entries[end - 1] as RawActivityEntry;
    const cached = mergedMonitorUpdateEntries.get(entry.activity);
    if (cached?.last === last.activity && cached.count === updates.length) {
      merged.push(cached.entry);
    } else {
      const mergedEntry: RawActivityEntry = {
        ...entry,
        activity: {
          ...toFeedActivity(
            { ...entry.activity.projectedItem, item: mergeMonitorUpdates(updates) },
            entry.activity.attemptId,
          ),
          id: entry.activity.id,
          createdAt: entry.activity.createdAt,
        },
      };
      mergedMonitorUpdateEntries.set(entry.activity, {
        last: last.activity,
        count: updates.length,
        entry: mergedEntry,
      });
      merged.push(mergedEntry);
    }
    index = end - 1;
  }
  return merged ?? entries;
}

function groupAdjacentActivities(rawEntries: ReadonlyArray<RawThreadFeedEntry>): ThreadFeedEntry[] {
  const entries = mergeMonitorUpdateEntries(rawEntries);
  const childrenByRun = new Map<RunId, Set<string>>();
  for (const entry of entries) {
    if (entry.type !== "activity") continue;
    const item = entry.activity.projectedItem.item;
    if (item.type !== "subagent" || item.origin !== "app_owned" || item.runId === null) continue;
    const children = childrenByRun.get(item.runId) ?? new Set<string>();
    children.add(item.subagentId);
    // delegate_task answers with the short handle of the subagent's id.
    children.add(delegatedTaskHandle(item.subagentId));
    if (item.childThreadId !== null) children.add(item.childThreadId);
    childrenByRun.set(item.runId, children);
  }
  const grouped: ThreadFeedEntry[] = [];
  let firstActivityEntry: Extract<RawThreadFeedEntry, { readonly type: "activity" }> | null = null;
  let openGroupActivities: ThreadFeedActivity[] = [];
  const flushGroup = () => {
    if (firstActivityEntry === null) return;
    const cached = activityGroupsCache.get(firstActivityEntry.activity);
    if (
      cached &&
      cached.activities.length === openGroupActivities.length &&
      cached.activities.every((activity, index) => activity === openGroupActivities[index])
    ) {
      grouped.push(cached);
    } else {
      const group: ThreadFeedActivityGroup = {
        type: "activity-group",
        id: firstActivityEntry.id,
        createdAt: firstActivityEntry.createdAt,
        runId: firstActivityEntry.runId,
        activities: openGroupActivities,
      };
      activityGroupsCache.set(firstActivityEntry.activity, group);
      grouped.push(group);
    }
    firstActivityEntry = null;
    openGroupActivities = [];
  };

  for (const entry of entries) {
    // A successful delegation is already represented by its durable child card.
    // Pending, failed and unmatched calls remain visible, even with identical prompts.
    if (entry.type === "activity") {
      const item = entry.activity.projectedItem.item;
      if (
        item.type === "dynamic_tool" &&
        item.runId !== null &&
        (item.status === "running" || item.status === "completed") &&
        resolveT3McpToolDefinition(item.toolName)?.summaryAction === "delegate" &&
        !workEntryDisplayIndicatesToolFailure(entry.activity.workEntry)
      ) {
        const output = compactDynamicToolOutput(item.output);
        if (
          !output?.isError &&
          ((output?.taskId !== undefined && childrenByRun.get(item.runId)?.has(output.taskId)) ||
            (output?.childThreadId !== undefined &&
              childrenByRun.get(item.runId)?.has(output.childThreadId)))
        )
          continue;
      }
    }
    // Skip empty messages so they don't break activity grouping.
    if (isEmptyMessage(entry)) {
      continue;
    }

    if (entry.type !== "activity") {
      flushGroup();
      grouped.push(entry);
      continue;
    }

    const isStandaloneActivity =
      entry.activity.projectedItem.item.type === "compaction" ||
      entry.activity.projectedItem.item.type === "handoff" ||
      entry.activity.projectedItem.item.type === "notification";
    if (
      isStandaloneActivity ||
      entry.activity.prominent ||
      (entry.activity.projectedItem.item.type === "subagent") !==
        (firstActivityEntry?.activity.projectedItem.item.type === "subagent") ||
      firstActivityEntry?.runId !== entry.runId ||
      (entry.activity.projectedItem.item.type === "subagent" &&
        firstActivityEntry?.activity.projectedItem.item.providerTurnId !==
          entry.activity.projectedItem.item.providerTurnId) ||
      (entry.activity.projectedItem.item.type !== "subagent" &&
        firstActivityEntry?.activity.attemptId !== entry.activity.attemptId)
    ) {
      flushGroup();
    }
    firstActivityEntry ??= entry;
    openGroupActivities.push(entry.activity);
    if (isStandaloneActivity || entry.activity.prominent) {
      flushGroup();
    }
  }
  flushGroup();
  return grouped;
}

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  return Number.isFinite(start) && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

function maxIsoTimestamp(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return Date.parse(right) > Date.parse(left) ? right : left;
}

function unsettledRunId(latestRun: ThreadFeedLatestRun | null): RunId | null {
  return threadFeedRunIsUnsettled(latestRun) ? latestRun.runId : null;
}

export function threadFeedRunIsUnsettled(
  run: ThreadFeedLatestRun | null,
): run is ThreadFeedLatestRun {
  if (run === null || run.status === "queued") return false;
  return (
    run.completedAt === null ||
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

export function threadFeedActivityIsVisible(
  activity: Pick<ThreadFeedActivity, "prominent" | "status" | "toolLike"> &
    Partial<Pick<ThreadFeedActivity, "lifecycleStatus">>,
): boolean {
  return (
    activity.prominent ||
    activity.lifecycleStatus === "stopped" ||
    activity.lifecycleStatus === "declined" ||
    activity.lifecycleStatus === "idle" ||
    !(activity.toolLike && activity.status === "neutral")
  );
}

interface ThreadFeedRunFold {
  readonly runId: RunId;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly label: string;
}

export function failedFeedRunIds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
) {
  const failed = new Set<RunId>();
  if (latestRun?.status === "failed") failed.add(latestRun.runId);
  for (const entry of feed) {
    if (entry.type !== "activity-group") continue;
    for (const activity of entry.activities) {
      const item = activity.projectedItem.item;
      if (
        item.type === "error" &&
        item.status === "failed" &&
        item.parentItemId === null &&
        item.runId !== null
      )
        failed.add(item.runId);
    }
  }
  return failed;
}

/**
 * A prompt without a run (a provider-native subagent, or a turn imported from
 * V1) folds its response like a run. `runlessWorkActive` keeps the latest
 * runless response open; V2 work must not reopen imported turns.
 */
function deriveThreadFeedRunFolds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
  runlessWorkActive: boolean,
  feedFailedRunIds: ReadonlySet<RunId>,
): ReadonlyMap<string, ThreadFeedRunFold> {
  const terminalAssistantMessageIdByRun = new Map<RunId, string>();
  const interruptedRunIds = new Set<RunId>();
  const failedRunIds = new Set(feedFailedRunIds);
  const promptIndexByRunId = new Map<RunId, number>();
  for (const [index, entry] of feed.entries()) {
    // A steer joins a run that already started, maybe from a promptless wake.
    if (
      entry.type !== "message" ||
      entry.message.role !== "user" ||
      entry.message.inputIntent === "steer" ||
      entry.message.inputIntent === "promoted_queued_to_steer"
    ) {
      continue;
    }
    const runId = entry.message.runId;
    if (runId != null && !promptIndexByRunId.has(runId)) promptIndexByRunId.set(runId, index);
  }
  const groupsByRunId = new Map<
    RunId,
    { entries: ThreadFeedEntry[]; startBoundary: string | null }
  >();
  // Fold state is keyed by run, so each runless prompt lends its response a
  // stable key of its own. Decide per prompt, not per thread: a V1 thread's
  // first V2 run must not unfold every imported turn above it.
  let runlessKey: RunId | null = null;
  let responseKey: RunId | null = null;
  let pendingUserBoundary: string | null = null;
  for (const [index, entry] of feed.entries()) {
    if (entry.type === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      runlessKey = entry.message.runId == null ? RunId.make(`runless:${entry.id}`) : null;
      responseKey = entry.message.runId ?? runlessKey;
      continue;
    }
    const ownRunId =
      entry.type === "message" && entry.message.role === "assistant"
        ? (entry.message.runId ?? runlessKey)
        : entry.type === "activity-group" ||
            entry.type === "html-render" ||
            entry.type === "mcp-app"
          ? (entry.runId ?? runlessKey)
          : null;
    if (!ownRunId) continue;
    // Resuming a subagent moves its item to the resuming run, but the item
    // keeps its place in the turn that started it. It folds with that turn,
    // so the later run's fold still opens under its own prompt.
    const runId =
      responseKey !== null && (promptIndexByRunId.get(ownRunId) ?? -1) > index
        ? responseKey
        : ownRunId;
    let group = groupsByRunId.get(runId);
    if (!group) {
      group = { entries: [], startBoundary: pendingUserBoundary };
      pendingUserBoundary = null;
      groupsByRunId.set(runId, group);
    }
    group.entries.push(entry);
    if (entry.type === "message") {
      terminalAssistantMessageIdByRun.set(runId, entry.id);
    }
    if (entry.type !== "activity-group") continue;
    for (const activity of entry.activities) {
      const item = activity.projectedItem.item;
      if (item.type === "run_interrupt_result") interruptedRunIds.add(runId);
      if (
        runId === runlessKey &&
        item.type === "error" &&
        item.status === "failed" &&
        item.parentItemId === null
      ) {
        failedRunIds.add(runId);
      }
    }
  }

  const activeRunId = unsettledRunId(latestRun);
  const foldsByAnchorId = new Map<string, ThreadFeedRunFold>();
  for (const [runId, group] of groupsByRunId) {
    if (
      runId === activeRunId ||
      (runlessWorkActive && runId === runlessKey) ||
      interruptedRunIds.has(runId) ||
      failedRunIds.has(runId) ||
      group.entries.some((entry) => entry.type === "message" && entry.message.streaming)
    ) {
      continue;
    }
    // Assistant prose always stays in sequence, outside collapsed work.
    const terminalAssistantId = terminalAssistantMessageIdByRun.get(runId);
    const hiddenEntryIds = new Set(
      group.entries
        .filter(
          (entry) =>
            entry.type !== "message" &&
            entry.type !== "html-render" &&
            entry.type !== "mcp-app" &&
            !(
              entry.type === "activity-group" &&
              entry.activities.some(
                (activity) =>
                  activity.prominent ||
                  activity.projectedItem.item.type === "notification" ||
                  activity.projectedItem.item.type === "handoff" ||
                  // A child still working outlives its settled launching run;
                  // its group stays visible while any member is live.
                  isLiveSubagentTurnItem(activity.projectedItem.item),
              )
            ),
        )
        .map((entry) => entry.id),
    );
    // A run-wide fold cannot span prose. Consecutive activity groups already
    // provide compact tool rows on either side of each message.
    let hasProse = false;
    let crossesProse = false;
    for (const entry of group.entries) {
      if (entry.type === "message") hasProse = true;
      else if (hasProse && hiddenEntryIds.has(entry.id)) {
        crossesProse = true;
        break;
      }
    }
    if (crossesProse) continue;
    const firstEntry = group.entries[0];
    const firstHiddenEntry = group.entries.find((entry) => hiddenEntryIds.has(entry.id));
    const lastEntry = group.entries.at(-1);
    if (!firstHiddenEntry || !firstEntry || !lastEntry) continue;
    const hidesNonCompactionWork = group.entries.some(
      (entry) =>
        hiddenEntryIds.has(entry.id) &&
        !(entry.type === "activity-group" && isContextCompactionActivityGroup(entry)),
    );
    if (!hidesNonCompactionWork) continue;
    const terminalEntry = terminalAssistantId
      ? group.entries.find((entry) => entry.id === terminalAssistantId)
      : null;
    const latestRunMatches = latestRun?.runId === runId;
    const lastEntryEnd =
      lastEntry.type === "message"
        ? lastEntry.message.updatedAt
        : lastEntry.type === "activity-group"
          ? // Mac work entries are ungrouped; the group's first timestamp is not its end.
            (lastEntry.activities.at(-1)?.createdAt ?? lastEntry.createdAt)
          : lastEntry.createdAt;
    const elapsedMs =
      latestRunMatches && latestRun.startedAt && latestRun.completedAt
        ? computeElapsedMs(latestRun.startedAt, latestRun.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(
              terminalEntry?.type === "message" ? terminalEntry.message.updatedAt : null,
              lastEntryEnd,
            ) ?? lastEntryEnd,
          );
    const duration = elapsedMs === null ? null : formatDuration(elapsedMs);
    const interrupted =
      latestRunMatches && (latestRun.status === "interrupted" || latestRun.status === "cancelled");
    foldsByAnchorId.set(firstHiddenEntry.id, {
      runId,
      createdAt: firstHiddenEntry.createdAt,
      hiddenEntryIds,
      label: interrupted
        ? duration
          ? `You stopped after ${duration}`
          : "You stopped this response"
        : duration
          ? `Worked for ${duration}`
          : "Worked",
    });
  }
  return foldsByAnchorId;
}

export function deriveThreadFeedPresentation(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestRun: ThreadFeedLatestRun | null,
  expandedRunIds: ReadonlySet<RunId>,
  expandedWorkGroupIds: ReadonlySet<string> = new Set(),
  activeWorkStartedAt: string | null = null,
  /** The live work is a provider-native subagent's runless root turn. */
  runlessWorkActive = false,
): ThreadFeedEntry[] {
  const sourceFeed = feed.filter(
    (entry) =>
      entry.type !== "run-fold" &&
      entry.type !== "work-toggle" &&
      entry.type !== "thinking" &&
      entry.type !== "viewed-images",
  );
  const failedRunIds = failedFeedRunIds(sourceFeed, latestRun);
  const activeTailGroup = sourceFeed.at(-1);
  const activeRunId = unsettledRunId(latestRun);
  const isWorking = activeWorkStartedAt !== null && latestRun?.status !== "preparing";
  const hasActiveRun = isWorking && (activeRunId !== null || runlessWorkActive);
  let runningTool: ThreadFeedActivity | undefined;
  if (hasActiveRun) {
    for (const entry of sourceFeed) {
      if (entry.type !== "activity-group" || entry.runId !== activeRunId) continue;
      for (const activity of entry.activities) {
        if (isNewerRunningTool(activity.workEntry, runningTool?.workEntry)) runningTool = activity;
      }
    }
  }
  const foldsByAnchorId = deriveThreadFeedRunFolds(
    sourceFeed,
    latestRun,
    isWorking && runlessWorkActive,
    failedRunIds,
  );
  const collapsedEntryIds = new Set<string>();
  for (const fold of foldsByAnchorId.values()) {
    if (!expandedRunIds.has(fold.runId)) {
      for (const entryId of fold.hiddenEntryIds) collapsedEntryIds.add(entryId);
    }
  }
  const result: ThreadFeedEntry[] = [];
  const tailEntryId = sourceFeed.at(-1)?.id ?? null;
  let tailRowsStart = 0;
  for (const [entryIndex, entry] of sourceFeed.entries()) {
    if (entryIndex === sourceFeed.length - 1) tailRowsStart = result.length;
    // A provider-native subagent works without a run: its null-run tail is
    // live only while that runless work is active.
    const isActiveTailGroup =
      hasActiveRun &&
      entry.type === "activity-group" &&
      activeTailGroup?.type === "activity-group" &&
      activeTailGroup.id === entry.id &&
      entry.runId === activeRunId;
    const fold = foldsByAnchorId.get(entry.id);
    if (fold) {
      const expanded = expandedRunIds.has(fold.runId);
      let row = runFoldRowsCache.get(entry);
      if (
        !row ||
        row.runId !== fold.runId ||
        row.createdAt !== fold.createdAt ||
        row.label !== fold.label ||
        row.expanded !== expanded
      ) {
        row = {
          type: "run-fold",
          id: `run-fold:${fold.runId}`,
          createdAt: fold.createdAt,
          runId: fold.runId,
          label: fold.label,
          expanded,
        };
        runFoldRowsCache.set(entry, row);
      }
      result.push(row);
    }
    if (!collapsedEntryIds.has(entry.id)) {
      if (
        entry.type === "activity-group" &&
        entry.runId !== null &&
        failedRunIds.has(entry.runId)
      ) {
        let rows = failedActivityGroupsCache.get(entry);
        if (!rows) {
          rows =
            entry.activities.length === 1
              ? [entry]
              : entry.activities.map((activity) => ({
                  type: "activity-group" as const,
                  id: activity.id,
                  createdAt: activity.createdAt,
                  runId: activity.runId,
                  activities: [activity],
                }));
          failedActivityGroupsCache.set(entry, rows);
        }
        result.push(...rows);
        continue;
      }
      appendPresentedFeedEntry(
        result,
        entry,
        expandedWorkGroupIds,
        activeRunId,
        isWorking,
        isActiveTailGroup,
        isActiveTailGroup ? runningTool : undefined,
      );
    } else if (entry.type === "activity-group") {
      const images = viewedImagesForHiddenGroup(entry);
      if (images !== null) result.push(images);
    }
  }
  // If the current tool's group is above later content, keep its status at the tail,
  // unless that tool is already on screen as its own row.
  const runningToolShown =
    runningTool !== undefined && result.some((row) => feedRowShowsRunningTool(row, runningTool));
  if (
    isWorking &&
    activeWorkStartedAt !== null &&
    !runningToolShown &&
    !result.some(
      (row) =>
        (row.type === "work-toggle" && row.shimmer) ||
        (row.type === "activity-group" &&
          isContextCompactionActivityGroup(row) &&
          row.runId === activeRunId &&
          row.activities[0]?.projectedItem.item.status === "running"),
    )
  ) {
    result.push(thinkingRow(activeWorkStartedAt, activeRunId, runningTool));
  }
  const thinkingRowCount =
    result.length - tailRowsStart > 0 && result.at(-1)?.type === "thinking" ? 1 : 0;
  const rows = applyContinuedWorkLogRows(result);
  presentationMetaByRows.set(rows, {
    tailEntryId,
    tailRowsStart,
    thinkingRowCount,
    runningToolId: runningTool?.id ?? null,
    activeRunFailed: activeRunId !== null && failedRunIds.has(activeRunId),
  });
  return rows;
}

/** Where a full presentation derive placed its tail entry's rows, for incremental patching. */
export interface ThreadFeedPresentationMeta {
  readonly tailEntryId: string | null;
  readonly tailRowsStart: number;
  readonly thinkingRowCount: number;
  readonly runningToolId: string | null;
  readonly activeRunFailed: boolean;
}

const presentationMetaByRows = new WeakMap<
  ReadonlyArray<ThreadFeedEntry>,
  ThreadFeedPresentationMeta
>();

export function threadFeedPresentationMeta(
  rows: ReadonlyArray<ThreadFeedEntry>,
): ThreadFeedPresentationMeta | null {
  return presentationMetaByRows.get(rows) ?? null;
}

/** Reuse the normal work-image strip without keeping the folded tool rows mounted. */
function viewedImagesForHiddenGroup(entry: ThreadFeedActivityGroup) {
  const cached = viewedImageRowsCache.get(entry);
  if (cached !== undefined) return cached;
  const paths = new Set<string>();
  const activities = entry.activities.filter((activity) => {
    if (activity.status === "failure") return false;
    const path = workEntryViewedImagePath(activity.workEntry);
    if (path === null || paths.has(path) || isChatAttachmentImagePath(path)) return false;
    paths.add(path);
    return true;
  });
  const row =
    activities.length > 0
      ? {
          type: "viewed-images" as const,
          id: `${entry.id}:viewed-images`,
          createdAt: entry.createdAt,
          runId: entry.runId,
          activities,
        }
      : null;
  viewedImageRowsCache.set(entry, row);
  return row;
}

const continuedWorkLogRows = new WeakMap<ThreadFeedEntry, ThreadFeedEntry>();

/** Marks adjacent work rows so they draw as one continuous log; cached per row object. */
export function applyContinuedWorkLogRows(
  result: ReadonlyArray<ThreadFeedEntry>,
): ThreadFeedEntry[] {
  return result.map((row, index) => {
    if (!isWorkLogFeedRow(row) || !isWorkLogFeedRow(result[index + 1]) || row.continuesWorkLog) {
      return row;
    }
    let continued = continuedWorkLogRows.get(row);
    if (!continued) {
      continued = { ...row, continuesWorkLog: true };
      continuedWorkLogRows.set(row, continued);
    }
    return continued;
  });
}

/** Hide reasoning text in Discord mode while retaining the live status slot. */
const discordFeedRows = new WeakMap<ThreadFeedEntry, ThreadFeedEntry | null>();
export function filterDiscordThreadFeed<T extends ThreadFeedEntry>(feed: ReadonlyArray<T>): T[] {
  const result: T[] = [];
  for (const entry of feed) {
    if (entry.type !== "activity-group" && entry.type !== "work-toggle") {
      result.push(entry);
      continue;
    }
    let filtered = discordFeedRows.get(entry);
    if (filtered === undefined) {
      const activities = entry.activities.filter(
        (activity) => activity.projectedItem.item.type !== "reasoning",
      );
      filtered =
        activities.length === entry.activities.length
          ? entry
          : activities.length
            ? { ...entry, activities }
            : null;
      discordFeedRows.set(entry, filtered);
    }
    if (filtered) result.push(filtered as T);
  }
  return result;
}

/** Whether a presented row displays the running tool, so no separate status row is needed. */
export function feedRowShowsRunningTool(
  row: ThreadFeedEntry,
  runningTool: ThreadFeedActivity,
): boolean {
  return (
    (row.type === "activity-group" &&
      row.activities.some((activity) => activity.id === runningTool.id)) ||
    // A group's header names its one tool ("Running ssh"), and a live group's header names
    // its latest running tool however many it holds; thoughts beside them don't count.
    (row.type === "work-toggle" &&
      row.activities.some((activity) => activity.id === runningTool.id) &&
      (row.activities.filter((activity) => activity.workEntry.itemType !== "reasoning").length ===
        1 ||
        (row.live &&
          row.activities.findLast((activity) => activity.lifecycleStatus === "inProgress")?.id ===
            runningTool.id)))
  );
}

export function isWorkLogFeedRow(row: ThreadFeedEntry | undefined): boolean {
  return (
    row !== undefined &&
    (row.type === "work-toggle" ||
      row.type === "thinking" ||
      (row.type === "activity-group" &&
        !isContextCompactionActivityGroup(row) &&
        !isContextHandoffActivityGroup(row) &&
        row.activities.every(
          (activity) =>
            !activity.prominent &&
            activity.projectedItem.item.type !== "notification" &&
            activity.projectedItem.item.type !== "subagent",
        )))
  );
}

/** Shared by the trailing live tool row and the separate status row. */
export const LIVE_ACTIVITY_ROW_ID = "live-activity-row";

function thinkingRow(
  createdAt: string,
  runId: RunId | null,
  runningTool: ThreadFeedActivity | undefined,
) {
  const label = runningTool
    ? runningToolStatusLabel(liveToolActivitySummary(runningTool, true))
    : "Thinking…";
  const shimmer = runningTool === undefined ? undefined : true;
  if (
    cachedThinkingRow?.createdAt !== createdAt ||
    cachedThinkingRow.runId !== runId ||
    cachedThinkingRow.label !== label ||
    cachedThinkingRow.shimmer !== shimmer
  ) {
    cachedThinkingRow = {
      type: "thinking",
      id: LIVE_ACTIVITY_ROW_ID,
      createdAt,
      runId,
      label,
      ...(shimmer ? { shimmer } : {}),
    };
  }
  return cachedThinkingRow;
}

export function appendPresentedFeedEntry(
  result: ThreadFeedEntry[],
  entry: Exclude<
    ThreadFeedEntry,
    { readonly type: "run-fold" | "work-toggle" | "thinking" | "viewed-images" }
  >,
  expandedWorkGroupIds: ReadonlySet<string>,
  activeRunId: RunId | null,
  isWorking: boolean,
  activeTail: boolean,
  runningTool: ThreadFeedActivity | undefined,
): void {
  if (entry.type !== "activity-group") {
    result.push(entry);
    return;
  }
  if (
    isContextCompactionActivityGroup(entry) ||
    isContextHandoffActivityGroup(entry) ||
    isUserInputActivityGroup(entry) ||
    entry.activities[0]?.projectedItem.item.type === "subagent"
  ) {
    result.push(entry);
    return;
  }

  let cached = presentedActivityGroupsCache.get(entry);
  if (
    !cached ||
    cached.activeRunId !== activeRunId ||
    cached.isWorking !== isWorking ||
    cached.activeTail !== activeTail ||
    cached.runningTool !== runningTool ||
    cached.rows.some(
      (row) => row.type === "work-toggle" && expandedWorkGroupIds.has(row.groupId) !== row.expanded,
    )
  ) {
    const rows: ThreadFeedEntry[] = [];
    appendActivityGroupRows(
      rows,
      entry,
      expandedWorkGroupIds,
      activeRunId,
      isWorking,
      activeTail,
      runningTool,
    );
    cached = { activeRunId, isWorking, activeTail, runningTool, rows };
    presentedActivityGroupsCache.set(entry, cached);
  }
  for (const row of cached.rows) {
    result.push(row);
  }
}

function appendActivityGroupRows(
  result: ThreadFeedEntry[],
  entry: ThreadFeedActivityGroup,
  expandedWorkGroupIds: ReadonlySet<string>,
  activeRunId: RunId | null,
  isWorking: boolean,
  activeTail: boolean,
  runningTool: ThreadFeedActivity | undefined,
): void {
  const groupAnchorIdByActivityId = new Map<string, string>();
  let groupAnchorId: string | null = null;
  for (const activity of entry.activities) {
    const item = activity.projectedItem.item;
    if (activity.prominent || (item.type === "error" && item.status === "failed")) {
      groupAnchorId = null;
      continue;
    }
    groupAnchorId ??= activity.id;
    groupAnchorIdByActivityId.set(activity.id, groupAnchorId);
  }
  const activities = entry.activities.filter(
    (activity) =>
      threadFeedActivityIsVisible(activity) ||
      (isWorking && activity.lifecycleStatus === "inProgress" && activity.runId === activeRunId),
  );
  if (activities.length === 0) {
    return;
  }

  let groupableRun: ThreadFeedActivity[] = [];
  const flushGroupableRun = (isTrailingRun: boolean) => {
    if (groupableRun.length === 0) return;
    appendToolGroupRows(
      result,
      entry,
      groupableRun,
      `work-group:${groupAnchorIdByActivityId.get(groupableRun[0]!.id) ?? groupableRun[0]!.id}`,
      expandedWorkGroupIds,
      activeRunId,
      isWorking,
      activeTail && isTrailingRun,
      runningTool,
    );
    groupableRun = [];
  };
  for (const activity of activities) {
    const item = activity.projectedItem.item;
    const severeProviderError = item.type === "error" && item.status === "failed";
    // Thoughts stay inside the stretch of work they belong to, as on the Mac, so
    // a long turn folds into one row per stretch instead of a list of single calls.
    if (!activity.prominent && !severeProviderError && item.type !== "notification") {
      groupableRun.push(activity);
      continue;
    }
    flushGroupableRun(false);
    result.push({
      type: "activity-group",
      id: activity.id,
      createdAt: activity.createdAt,
      runId: activity.runId,
      activities: [activity],
    });
  }
  flushGroupableRun(true);
}

function appendToolGroupRows(
  result: ThreadFeedEntry[],
  sourceGroup: Extract<ThreadFeedEntry, { readonly type: "activity-group" }>,
  activities: ReadonlyArray<ThreadFeedActivity>,
  groupId: string,
  expandedWorkGroupIds: ReadonlySet<string>,
  activeRunId: RunId | null,
  isWorking: boolean,
  activeTail: boolean,
  runningTool: ThreadFeedActivity | undefined,
): void {
  // A lone thought is its own row: it collapses to its text and expands to its
  // markdown, so a group around it would show the same thought twice.
  if (activities.length === 1 && activities[0]!.workEntry.itemType === "reasoning") {
    const thought = activities[0]!;
    result.push({
      type: "activity-group",
      id: thought.id,
      createdAt: thought.createdAt,
      runId: thought.runId,
      activities: [thought],
    });
    return;
  }
  const expanded = expandedWorkGroupIds.has(groupId);
  const latestActiveActivity = activities.findLast(
    (activity) =>
      isWorking && activity.lifecycleStatus === "inProgress" && activity.runId === activeRunId,
  );
  const active = latestActiveActivity !== undefined;
  // Thoughts never take the live slot; a group of only thoughts leaves it to the Working row.
  const thoughtsOnly = activities.every((activity) => activity.workEntry.itemType === "reasoning");
  const live = (activeTail || active) && !thoughtsOnly;
  const carriesRunningTool =
    activeTail && runningTool !== undefined && activities.includes(runningTool);
  const latestActivity =
    (carriesRunningTool ? runningTool : undefined) ??
    latestActiveActivity ??
    activities.findLast((activity) => activity.workEntry.itemType !== "reasoning") ??
    activities.at(-1)!;
  // A successful trailing call remains the live slot until the next activity.
  // Failed/stopped calls hand that slot to the Working row.
  const shimmer =
    !thoughtsOnly &&
    activeTail &&
    (runningTool === undefined
      ? active || latestActivity.status === "success"
      : carriesRunningTool);
  const singleActivity = activities.length === 1 ? latestActivity : null;
  const groupSummary = summarizeToolGroup(activities.map((activity) => activity.workEntry));
  const summary = live
    ? liveToolActivitySummary(latestActivity, live)
    : thoughtsOnly && singleActivity !== null
      ? singleToolCallLabel(singleActivity, expanded)
      : singleActivity !== null &&
          singleActivity.toolLike &&
          toolGroupAction(singleActivity.workEntry) !== "edit"
        ? singleToolCallLabel(singleActivity, expanded)
        : singleActivity !== null && !singleActivity.toolLike
          ? singleActivity.workEntry.label
          : groupSummary.summary;
  const primarySourceActivity = activities.find(
    (activity) => activity.workEntry.toolSource !== undefined,
  );
  const primarySourceKey = primarySourceActivity?.workEntry.toolSource?.key;
  const primarySourceIcon = primarySourceKey
    ? (activities.find(
        (activity) =>
          activity.workEntry.toolSource?.key === primarySourceKey &&
          activity.workEntry.toolIcon !== undefined,
      )?.workEntry.toolIcon ?? primarySourceActivity?.workEntry.toolSource?.icon)
    : undefined;
  const groupToolSurface =
    primarySourceActivity?.workEntry.toolSurface ??
    latestActivity.workEntry.toolSurface ??
    activities.findLast((activity) => activity.workEntry.toolSurface !== undefined)?.workEntry
      .toolSurface;
  const groupToolIcon =
    primarySourceIcon ??
    latestActivity.workEntry.toolIcon ??
    activities.findLast((activity) => activity.workEntry.toolIcon !== undefined)?.workEntry
      .toolIcon;
  const summaryToolIcon = live
    ? resolveWorkEntryToolPresentation(latestActivity.workEntry)?.icon
    : singleActivity !== null &&
        singleActivity.toolLike &&
        toolGroupAction(singleActivity.workEntry) !== "edit"
      ? resolveWorkEntryToolPresentation(singleActivity.workEntry, "completed")?.icon
      : undefined;
  result.push({
    type: "work-toggle",
    id: shimmer ? LIVE_ACTIVITY_ROW_ID : `${live ? "work-live" : "work-toggle"}:${groupId}`,
    createdAt: sourceGroup.createdAt,
    runId: sourceGroup.runId,
    groupId,
    activities,
    hiddenCount: activities.filter((activity) => activity.workEntry.itemType !== "reasoning")
      .length,
    expanded,
    summary: carriesRunningTool ? runningToolStatusLabel(summary) : summary,
    summaryKind: toolGroupSummaryKind(
      (live ? [latestActivity] : activities).map((activity) => activity.workEntry),
    ),
    ...(groupToolSurface ? { toolSurface: groupToolSurface } : {}),
    ...(groupToolIcon ? { toolIcon: groupToolIcon } : {}),
    ...(summaryToolIcon ? { summaryToolIcon } : {}),
    hasFailure: (() => {
      const lastToolLike = activities.findLast((activity) => activity.toolLike);
      return (
        lastToolLike !== undefined && workEntryDisplayIndicatesToolFailure(lastToolLike.workEntry)
      );
    })(),
    live,
    shimmer,
  });
  if (!expanded) return;
  result.push({
    type: "activity-group",
    id: `work-details:${groupId}`,
    createdAt: activities[0]!.createdAt,
    runId: activities[0]!.runId,
    activities: activities.map((activity) => ({
      ...activity,
      groupedToolDetail: true,
      live:
        isWorking &&
        activity.id === latestActivity.id &&
        activity.lifecycleStatus === "inProgress" &&
        activity.runId === activeRunId,
    })),
  });
}

function liveToolActivitySummary(activity: ThreadFeedActivity, presentTense: boolean): string {
  return (
    liveToolActivityLabel(activity.workEntry, presentTense) ?? activity.detail ?? activity.summary
  );
}

export function setPendingUserInputCustomAnswer(
  question: ThreadUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  if (question.allowCustomAnswer === false) {
    return draft ?? {};
  }

  // Typing replaces the choice of a single-choice question and adds to a multiple-choice one.
  const selectedOptionValues =
    question.initialAnswer !== undefined ||
    (customAnswer.trim().length > 0 && question.multiSelect !== true)
      ? undefined
      : normalizeSelectedOptionValues(question, draft?.selectedOptionValues);
  return {
    customAnswer,
    ...(selectedOptionValues && selectedOptionValues.length > 0 ? { selectedOptionValues } : {}),
  };
}

export function isPendingUserInputOptionSelected(
  question: ThreadUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): boolean {
  if (
    question.multiSelect !== true &&
    question.allowCustomAnswer !== false &&
    normalizeDraftAnswer(draft?.customAnswer)
  ) {
    return false;
  }

  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  return (
    resolvedOptionValue !== null &&
    normalizeSelectedOptionValues(question, draft?.selectedOptionValues).includes(
      resolvedOptionValue,
    )
  );
}

export function togglePendingUserInputOptionSelection(
  question: ThreadUserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionValue: string,
): PendingUserInputDraftAnswer {
  const resolvedOptionValue = resolvePendingUserInputOptionValue(question, optionValue);
  if (resolvedOptionValue === null) {
    return draft ?? {};
  }

  if (question.multiSelect) {
    const selectedOptionValues = normalizeSelectedOptionValues(
      question,
      draft?.selectedOptionValues,
    );
    const nextSelectedOptionValues = selectedOptionValues.includes(resolvedOptionValue)
      ? selectedOptionValues.filter((value) => value !== resolvedOptionValue)
      : [...selectedOptionValues, resolvedOptionValue];

    return {
      customAnswer: draft?.customAnswer ?? "",
      ...(nextSelectedOptionValues.length > 0
        ? { selectedOptionValues: nextSelectedOptionValues }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionValues: [resolvedOptionValue],
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<ThreadUserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | ReadonlyArray<string>> | null {
  const entries: Array<[string, string | ReadonlyArray<string>]> = [];

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);
    if (answer === null) {
      return null;
    }
    entries.push([question.id, answer]);
  }

  return Object.fromEntries(entries);
}

// Item appends keep the immutable control-plane arrays. Release their indexes with the arrays.
function indexBy<T, K>(key: (value: T) => K) {
  const cache = new WeakMap<ReadonlyArray<T>, Map<K, T>>();
  return (values: ReadonlyArray<T>) => {
    let index = cache.get(values);
    if (!index) {
      index = new Map<K, T>();
      for (const value of values) index.set(key(value), value);
      cache.set(values, index);
    }
    return index;
  };
}

const attemptsByRoot = indexBy((attempt: OrchestrationV2RunAttempt) => attempt.rootNodeId);
const nodesById = indexBy((node: OrchestrationV2ExecutionNode) => node.id);

/**
 * Projects the server-authored visible sequence into mobile row presentation.
 * It deliberately preserves the incoming order and never rebuilds chat from
 * separate message, plan, or work-entry collections.
 */
export function buildThreadFeed(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  options?: {
    readonly anchoredMessages?: ReadonlyArray<LocalThreadMessage>;
    readonly attempts?: ReadonlyArray<OrchestrationV2RunAttempt>;
    readonly nodes?: ReadonlyArray<OrchestrationV2ExecutionNode>;
    /** Show thoughts while they stream, for models that send their full thinking. */
    readonly liveThoughts?: boolean;
  },
): ThreadFeedEntry[] {
  const entries: RawThreadFeedEntry[] = [];
  const attemptByRootNodeId = options?.attempts?.length ? attemptsByRoot(options.attempts) : null;
  const nodeById = attemptByRootNodeId && options?.nodes ? nodesById(options.nodes) : null;
  const resolveAttemptId = (item: OrchestrationV2TurnItem): RunAttemptId | null => {
    if (!attemptByRootNodeId || item.nodeId === null || item.runId === null) return null;
    let nodeId: OrchestrationV2ExecutionNode["id"] | null = item.nodeId;
    let visited: Set<OrchestrationV2ExecutionNode["id"]> | undefined;
    while (nodeId !== null) {
      const directAttempt = attemptByRootNodeId.get(nodeId);
      if (directAttempt?.runId === item.runId) return directAttempt.id;
      const node: OrchestrationV2ExecutionNode | undefined = nodeById?.get(nodeId);
      if (node === undefined) return null;
      const rootAttempt = attemptByRootNodeId.get(node.rootNodeId);
      if (rootAttempt?.runId === item.runId) return rootAttempt.id;
      if (visited?.has(nodeId)) return null;
      (visited ??= new Set()).add(nodeId);
      nodeId = node.parentNodeId;
    }
    return null;
  };
  // An `ask_user` answer arrives as its own message; it carries the question
  // and answer so it can show as a folded "Answered question" row.
  const answerByMessageId = new Map<string, UserInputAttachmentAnswerPayload>();
  for (const { item } of visibleTurnItems) {
    if (item.type === "user_input_request" && item.questionAnswer) {
      answerByMessageId.set(`async-answer:${item.questionAnswer.requestId}`, item.questionAnswer);
    }
  }
  const resumedRestartNotices = resumedRestartNoticeIds(visibleTurnItems);
  for (const row of visibleTurnItems) {
    const item = row.item;
    if (turnItemIsWorkspacePreparation(item)) continue;
    if (resumedRestartNotices.has(item.id)) continue;
    if (item.type === "todo_list" || item.type === "checkpoint") continue;
    if (
      item.type === "user_message" &&
      item.inputIntent === "queued_turn" &&
      item.status === "pending"
    )
      continue;
    // A finished thought is a collapsed row, like on web. While it streams the live
    // slot still says "Working", unless thoughts show live.
    if (item.type === "reasoning" && item.streaming && !options?.liveThoughts) continue;
    // Match the web timeline: only the terminal interrupt result is useful to
    // users; the preceding request is transient bookkeeping.
    if (item.type === "run_interrupt_request") {
      continue;
    }
    const attemptId = resolveAttemptId(item);
    const cached = projectedEntriesCache.get(row);
    // An answer's row changes when its question loads, so it isn't cached.
    const isAnswer = item.type === "user_message" && item.messageId.startsWith("async-answer:");
    if (cached?.attemptId === attemptId && !isAnswer) {
      entries.push(cached.entry);
      continue;
    }
    const createdAt = DateTime.formatIso(item.startedAt ?? item.updatedAt);
    // A running or failed render stays an ordinary work row.
    const render =
      item.type === "dynamic_tool" && item.status === "completed"
        ? htmlRenderFromToolItem(item)
        : undefined;
    if (render) {
      const entry: RawThreadFeedEntry = {
        type: "html-render",
        id: `html-render:${row.visibility}:${row.sourceThreadId}:${row.sourceItemId}`,
        createdAt,
        runId: item.runId,
        render,
      };
      projectedEntriesCache.set(row, { attemptId, entry });
      entries.push(entry);
      continue;
    }
    const app =
      item.type === "dynamic_tool" && item.status === "completed"
        ? mcpAppFromToolItem(item)
        : undefined;
    if (app) {
      const entry: RawThreadFeedEntry = {
        type: "mcp-app",
        id: `mcp-app:${row.visibility}:${row.sourceThreadId}:${row.sourceItemId}`,
        createdAt,
        runId: item.runId,
        sourceThreadId: row.sourceThreadId,
        itemId: row.sourceItemId,
        revision: turnItemDetailRevision(item),
        app,
      };
      projectedEntriesCache.set(row, { attemptId, entry });
      entries.push(entry);
      continue;
    }
    if (item.type === "user_message" || item.type === "assistant_message") {
      const updatedAt = DateTime.formatIso(item.updatedAt);
      const entry: RawThreadFeedEntry = {
        type: "message",
        id: item.messageId,
        createdAt,
        message: {
          id: item.messageId,
          role: item.type === "user_message" ? "user" : "assistant",
          text: item.text,
          ...(item.type === "user_message" && item.context ? { context: item.context } : {}),
          attachments: item.attachments ?? [],
          runId: item.runId,
          streaming: item.type === "assistant_message" && item.streaming,
          ...(item.type === "user_message"
            ? {
                inputIntent: item.inputIntent,
                createdBy: item.createdBy,
                creationSource: item.creationSource,
                ...(item.scheduledTaskId ? { scheduledTaskId: item.scheduledTaskId } : {}),
                ...(item.senderThreadId ? { senderThreadId: item.senderThreadId } : {}),
                ...(answerByMessageId.has(item.messageId)
                  ? { questionAnswer: answerByMessageId.get(item.messageId) }
                  : {}),
              }
            : {}),
          visibility: row.visibility,
          sourceThreadId: row.sourceThreadId,
          createdAt,
          updatedAt,
          projectedItem: row,
        },
      };
      projectedEntriesCache.set(row, { attemptId, entry });
      entries.push(entry);
      continue;
    }
    const activity = toFeedActivity(row, attemptId);
    const entry: RawThreadFeedEntry = {
      type: "activity",
      id: activity.id,
      createdAt,
      runId: item.runId,
      activity,
    };
    projectedEntriesCache.set(row, { attemptId, entry });
    entries.push(entry);
  }
  if (!options?.anchoredMessages?.length) return groupAdjacentActivities(entries);
  const retainedMessageIds = new Set([
    ...answerByMessageId.keys(),
    ...entries.flatMap((entry) => (entry.type === "message" ? [entry.id] : [])),
  ]);
  const appendLocalMessage = (message: LocalThreadMessage): RawThreadFeedEntry => {
    const cached = localMessageEntriesCache.get(message);
    if (cached) return cached;
    const entry: Extract<RawThreadFeedEntry, { readonly type: "message" }> = {
      type: "message",
      id: message.id,
      createdAt: message.createdAt,
      message: {
        id: message.id,
        role: message.role === "assistant" ? "assistant" : "user",
        text: message.text,
        ...(message.context ? { context: message.context } : {}),
        attachments: message.attachments ?? [],
        runId: null,
        streaming: message.streaming,
        visibility: "local",
        sourceThreadId: ThreadId.make("local-feedback"),
        createdAt: message.createdAt,
        updatedAt: message.updatedAt,
      },
    };
    localMessageEntriesCache.set(message, entry);
    return entry;
  };
  for (const message of options.anchoredMessages) {
    if (retainedMessageIds.has(message.id)) continue;
    retainedMessageIds.add(message.id);
    const entry = appendLocalMessage(message);
    const insertionIndex = entries.findIndex(
      (candidate) => candidate.createdAt > message.createdAt,
    );
    if (insertionIndex === -1) entries.push(entry);
    else entries.splice(insertionIndex, 0, entry);
  }
  return groupAdjacentActivities(entries);
}
