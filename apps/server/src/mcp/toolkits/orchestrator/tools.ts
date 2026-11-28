import {
  MonitorStartInput,
  MonitorStartResult,
  MonitorStopInput,
  MonitorStopResult,
  MonitorListResult,
} from "@t3tools/contracts";
import * as MonitorMcpService from "../../MonitorMcpService.ts";
import {
  OrchestratorMcpCapabilitiesInput,
  OrchestratorMcpCapabilitiesResult,
  OrchestrationV2StopWorkflowInput,
  OrchestratorMcpCreateThreadsInput,
  OrchestratorMcpCreateThreadsResult,
  OrchestratorMcpCouncilInput,
  OrchestratorMcpCouncilResult,
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpDeleteScheduledTaskInput,
  OrchestratorMcpDeleteScheduledTaskResult,
  OrchestratorMcpAskUserInput,
  OrchestratorMcpAskUserResult,
  OrchestratorMcpRequestApiKeyResult,
  OrchestratorMcpRequestSecretInput,
  OrchestratorMcpRequestSecretResult,
  OrchestratorMcpFailure,
  ScheduledTaskListRunsInput,
  ScheduledTaskListRunsResult,
  ScheduledTaskPreviewWebhookInput,
  ScheduledTaskPreviewWebhookResult,
  OrchestratorMcpListScheduledTasksInput,
  OrchestratorMcpListScheduledTasksResult,
  OrchestratorMcpSaveScheduledTaskInput,
  OrchestratorMcpScheduleTaskResult,
  OrchestratorMcpTaskCancelInput,
  OrchestratorMcpTaskCancelResult,
  OrchestratorMcpTaskStatusInput,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadListResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSendInput,
  OrchestratorMcpThreadSendResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
  ThreadMetadataMcpUpdateInput,
  ThreadMetadataMcpUpdateResult,
} from "@t3tools/contracts";
import { ApiKeyName, ApiKeyScope, ApiKeyExpiry, ApiKeyError } from "@t3tools/contracts";
import * as ApiKeyStore from "../../../secrets/ApiKeyStore.ts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import { TeamBoardToolInput } from "../../../teamBoard/TeamBoard.ts";
import { TEAM_BOARD_DESCRIPTION, TEAM_BOARD_TOOL } from "../../../teamBoard/model.ts";

import { UsageLimitsInput, UsageLimitsResult } from "../../OrchestratorUsageLimits.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  OrchestratorMcpService.OrchestratorMcpService,
];
const threadMetadataDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ThreadMetadataMcpService.ThreadMetadataMcpService,
];

const OrchestratorCapabilitiesTool = Tool.make("orchestrator_capabilities", {
  description:
    "Pick providers and models. Defaults to 6 per provider; filter with providerInstanceId or modelSearch and page via cursor=nextCursor. includeOptions adds model settings. Search explicitly for legacy/superseded ids. images:false means text only; audioVideo:true reads audio/video files. Avoid accountUnavailable or recentFailure; credit warnings allow retry. Quotas: usage_limits.",
  parameters: OrchestratorMcpCapabilitiesInput,
  success: OrchestratorMcpCapabilitiesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get orchestration capabilities")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UsageLimitsTool = Tool.make("usage_limits", {
  description:
    "Provider quotas, credits, resets and freshness. Refreshes stale readings for up to 3s. Use to choose subagent providers; spare quota is no reason to delegate. limited is authoritative; 100% can be rounded.",
  parameters: UsageLimitsInput,
  success: UsageLimitsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get provider usage limits")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const DelegateTaskTool = Tool.make("delegate_task", {
  description:
    "Start a child owned by this thread with a self-contained task brief and no parent history (async by default; wakes you when done). worktree starts at the last local commit, without uncommitted edits unless withEdits=true. In a scratch chat pass an absolute repositoryPath. Settings inherit; modes may step down. Use a new clientRequestId for each task or independent review round; reuse only for retries. Follow up via t3_thread_send with its taskId; task ids or unique keys work in every thread tool and task_status/cancel until workspace removal. wait returns on completion, a question or waitTimedOut. Read clipped output at nextSummaryOffset via task_status.",
  parameters: OrchestratorMcpDelegateTaskInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delegate a child task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const TaskStatusTool = Tool.make("task_status", {
  description:
    "Read one subagent's status or clipped report. Don't poll running tasks—wakes deliver results. summary is the original result; pass nextSummaryOffset or a wake's UTF-16 offset as summaryOffset. latestTerminal* covers later non-monitor turns, omitted when they would repeat summary. workState: working, waiting_for_children or result_available. failure may be retryable; hasPendingChildRuns flags later turns. Wakes and terminal reads ack delivery.",
  parameters: OrchestratorMcpTaskStatusInput,
  success: OrchestratorMcpDelegateTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Get delegated task status")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const TaskCancelTool = Tool.make("task_cancel", {
  description:
    "Stop an owned subagent. Stops later child turns, nested delegates and PR watches; removes a queued send or holds queued turns and disposes automatic parent delivery. Works after the original task ends; terminal status/results stay readable.",
  parameters: OrchestratorMcpTaskCancelInput,
  success: OrchestratorMcpTaskCancelResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Cancel delegated task")
  .annotate(Tool.Destructive, true);

const WorkflowStopTool = Tool.make("t3_workflow_stop", {
  description:
    "Stop one running Claude workflow. Pass the coordinator's subagentId from t3_thread_read(view='activity'). Stops all phases/agents without affecting the parent or other workflows.",
  parameters: OrchestrationV2StopWorkflowInput,
  success: Schema.Record(Schema.String, Schema.Never),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop a workflow")
  .annotate(Tool.Destructive, true);

export const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create, edit or pause scheduled work. Creation needs prompt and schedule; scheduledTaskId updates supplied fields only; enabled=false pauses. The schedule is an object: {type:'interval',everyMs:3600000}, {type:'fixed_time',timeOfDay:'09:00',weekdays:[1,2,3,4,5]}, {type:'once',runAt:'2027-01-15T14:30:00.000Z'} or {type:'webhook'}. One-shots steer active threads or start idle ones. Report nextRunAt or share webhookUrl (creation only with T3 Connect and run permission; see webhookSetup). Binds to this thread or starts new ones; inherits defaults.",
  parameters: OrchestratorMcpSaveScheduledTaskInput,
  success: OrchestratorMcpScheduleTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Schedule a recurring task")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ListScheduledTaskRunsTool = Tool.make("scheduled_task_runs", {
  description: "Read recent dispatches and run outcomes. Pass nextCursor as before for older runs.",
  parameters: ScheduledTaskListRunsInput,
  success: ScheduledTaskListRunsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, true);

const PreviewWebhookTool = Tool.make("webhook_preview", {
  description: "Render a webhook template with a sample request. No dispatch or saved sample.",
  parameters: ScheduledTaskPreviewWebhookInput,
  success: ScheduledTaskPreviewWebhookResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Readonly, true);

const ListScheduledTasksTool = Tool.make("list_scheduled_tasks", {
  parameters: OrchestratorMcpListScheduledTasksInput,
  description:
    "List scheduled tasks. Defaults to this thread's project, or all projects outside a thread. Filter by scheduledTaskId for its full prompt. Edit via schedule_task.",
  success: OrchestratorMcpListScheduledTasksResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List scheduled tasks")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const DeleteScheduledTaskTool = Tool.make("delete_scheduled_task", {
  description:
    "Permanently remove a scheduledTaskId and stop future runs. To pause it, use schedule_task with enabled=false.",
  parameters: OrchestratorMcpDeleteScheduledTaskInput,
  success: OrchestratorMcpDeleteScheduledTaskResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Delete a scheduled task")
  .annotate(Tool.Destructive, true);

const RequestApiKeyTool = Tool.make("request_api_key", {
  description:
    "Request a reusable API key privately. Returns at once; reply arrives as a message. Check list_api_keys first. User picks chat/all-session scope and expiry (default chat, 30d); values stay in host vault. Use via prepare_api_key on the server host.",
  parameters: Schema.Struct({
    name: ApiKeyName,
    label: OrchestratorMcpRequestSecretInput.fields.label,
    reason: OrchestratorMcpRequestSecretInput.fields.reason,
    suggestedScope: Schema.optional(ApiKeyScope),
    suggestedExpiresAt: Schema.optional(ApiKeyExpiry),
    clientRequestId: OrchestratorMcpRequestSecretInput.fields.clientRequestId,
  }),
  success: OrchestratorMcpRequestApiKeyResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Destructive, false);

const ListApiKeysTool = Tool.make("list_api_keys", {
  description:
    "List available API keys without values. Returns names, scopes and expiries (drops expired/other-thread keys). Missing: request_api_key. Use: prepare_api_key.",
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    keys: Schema.Array(
      Schema.Struct({ name: ApiKeyName, scope: ApiKeyScope, expiresAt: ApiKeyExpiry }),
    ),
  }),
  failure: Schema.Union([ApiKeyError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ApiKeyStore.ApiKeyStore,
    ThreadManagementService.ThreadManagementService,
  ],
}).annotate(Tool.Readonly, true);

const PrepareApiKeyTool = Tool.make("prepare_api_key", {
  description:
    "Prepare saved keys without seeing them. Pass name (returns command) or names (returns commands). Each carries a one-use, 60-second ticket bound to this thread/key. Run on the server host; child gets env var and echoed values are redacted. Never print, encode, write or extract credentials.",
  parameters: Schema.Struct({
    name: Schema.optional(ApiKeyName),
    names: Schema.optional(
      Schema.Array(ApiKeyName).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    ),
  }),
  success: Schema.Union([
    Schema.Struct({ command: Schema.String }),
    Schema.Struct({
      commands: Schema.Array(Schema.Struct({ name: ApiKeyName, command: Schema.String })),
    }),
  ]),
  failure: Schema.Union([ApiKeyError, OrchestratorMcpFailure]),
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ApiKeyStore.ApiKeyStore,
    ThreadManagementService.ThreadManagementService,
  ],
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Readonly, false);

const CouncilTool = Tool.make("council", {
  description:
    "Ask 2-4 models one question blind. Each runs as a subagent told to stay read-only, seeing only question and context. Use when asked or before hard-to-reverse decisions (architecture, research calls), not routine work. Waits up to timeoutMs (default 15m).",
  parameters: OrchestratorMcpCouncilInput,
  success: OrchestratorMcpCouncilResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Ask a council of models")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const RequestSecretTool = Tool.make("request_secret", {
  description:
    "Ask for a secret on a private card. Returns at once; reply arrives as a message. Never ask in chat or invent one. Pass fields for multi-part credentials. Default returns a one-use secretRef for tools (e.g. schedule_task signature). For a sudo password or shell CLI token, set delivery:'file' (deleted after 24h; read inside commands, never print). Longer-lived keys use request_api_key.",
  // API keys are asked for with request_api_key; offering them here too only cost tokens.
  parameters: OrchestratorMcpRequestSecretInput.mapFields(
    ({ apiKey: _apiKey, ...fields }) => fields,
  ),
  success: OrchestratorMcpRequestSecretResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a secret from the user")
  .annotate(Tool.Destructive, false);

const AskUserTool = Tool.make("ask_user", {
  description:
    "Ask up to four user questions on a card. Put '(Recommended)' first. Answers arrive as messages, possibly mid-turn.",
  parameters: OrchestratorMcpAskUserInput,
  success: OrchestratorMcpAskUserResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Ask the user a question")
  .annotate(Tool.Destructive, false);

export const CreateThreadsTool = Tool.make("create_threads", {
  description:
    'Create top-level chats only when the user asks. Use delegate_task for delegation. Outside a thread, omit projectId for "No project" scratch (auto-created) or pick from t3_project_list. Inherits caller settings; Share checkouts or use fresh scratch folders. Override target/modes per entry. Waits up to 20s for startup; later first-run failures notify this chat.',
  parameters: OrchestratorMcpCreateThreadsInput,
  success: OrchestratorMcpCreateThreadsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Create T3 threads")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadListTool = Tool.make("t3_thread_list", {
  description:
    "List project threads, newest first. Defaults to this project and 20 rows. Filter by status, title, settled or snoozed; page via nextCursor. includeDetails adds metadata. Snoozed threads wake on questions, failure or completion.",
  parameters: OrchestratorMcpThreadListInput,
  success: OrchestratorMcpThreadListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List T3 threads")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadReadTool = Tool.make("t3_thread_read", {
  description:
    "Read thread state and latest items. Max ~30k chars; fromEnd=false starts at 0. messages includes plans; activity includes tools. Page via afterPosition=nextPosition or beforePosition=prevPosition. query does case-insensitive all-words match newest first with snippets (scans at most 1000 items; keep query/view across empty pages; search.hasMoreMatches is true/false or null unknown past search.scanLimitReached). Full text: itemId, then textOffset=nextTextOffset (UTF-16; excludes query/backward paging). Full child read acks delivery. Omitted sourceThreadId means this thread.",
  parameters: OrchestratorMcpThreadReadInput,
  success: OrchestratorMcpThreadReadResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read a SSHCode thread")
  // Strict so a misspelled paging param fails instead of silently reading from position 0.
  .annotate(Tool.Strict, true)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ThreadUpdateTool = Tool.make("t3_thread_update", {
  description:
    "Update thread metadata. Omit threadId for this thread. rename: title; link_pull_request: pullRequest; cancel_queued: runId; settle/unsettle (this thread settles when turn ends). Workspace and branch unsupported. clientRequestId dedupes retries.",
  parameters: ThreadMetadataMcpUpdateInput,
  success: ThreadMetadataMcpUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: threadMetadataDependencies,
})
  .annotate(Tool.Title, "Update SSHCode thread metadata")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

const ThreadSendTool = Tool.make("t3_thread_send", {
  description:
    "Message a T3 thread within your permission modes. Peer runs wake you on completion. Independent review rounds use delegate_task with full brief and new key. Child follow-ups use taskId; a completed task gets a new short taskId and wakes its parent (if workspace was removed, delegate again). Answer pending questions with t3_pending_request_respond, never a message. mode: auto starts idle or steers/queues busy (child-to-parent auto holds text-only progress up to 2m, queue wakes now); queue/steer/restart choose explicitly. Reuse clientRequestId only for retries.",
  parameters: OrchestratorMcpThreadSendInput,
  success: OrchestratorMcpThreadSendResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Send to a SSHCode thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const ThreadWaitTool = Tool.make("t3_thread_wait", {
  description:
    "Wait for a thread run to finish. Prefer wakes for subagents and peer sends. Omits runId for latest run; idle returns immediately. Timeout leaves work running without acking delegated results.",
  parameters: OrchestratorMcpThreadWaitInput,
  success: OrchestratorMcpThreadWaitResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Wait for a SSHCode thread")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ThreadInterruptTool = Tool.make("t3_thread_interrupt", {
  description:
    "Interrupt a running turn in any accessible thread. Default: newest interruptible run; terminal/idle threads no-op. clientRequestId dedupes retries.",
  parameters: OrchestratorMcpThreadInterruptInput,
  success: OrchestratorMcpThreadInterruptResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Interrupt a SSHCode thread")
  .annotate(Tool.Destructive, true);

const monitorDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  MonitorMcpService.MonitorMcpService,
];

const MonitorStartTool = Tool.make("monitor_start", {
  description:
    "Run a monitored shell command (full-access/default). Returns monitorId and wakes on output/exit. Your own process over 10m: durable:true survives restarts and keeps logPath. Waiting on anything else: a read-only check with restartable:true (relaunched after restarts) and silenceMs for stalls; durable takes neither. Default 1h timeout unless persistent:true (max 24h); stops on excessive output. Use line-buffered output and wakeOn regex for milestones. Stop/archive/removal kills the entire process group. Max 8/thread; reuse clientRequestId only for retries.",
  parameters: MonitorStartInput,
  success: MonitorStartResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: monitorDependencies,
})
  .annotate(Tool.Title, "Start a monitor")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const MonitorStopTool = Tool.make("monitor_stop", {
  description:
    "Stop a monitor and its process group. stopped=false if already ended. Prefer native Monitor for native Claude monitors.",
  parameters: MonitorStopInput,
  success: MonitorStopResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: monitorDependencies,
})
  .annotate(Tool.Title, "Stop a monitor")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true);

const MonitorListTool = Tool.make("monitor_list", {
  description:
    "List this thread's monitors. includeOutput=true adds recent output. Wait for wakes instead of polling. Native Claude monitors use Monitor.",
  parameters: Schema.Struct({ includeOutput: Schema.optional(Schema.Boolean) }),
  success: MonitorListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: monitorDependencies,
})
  .annotate(Tool.Title, "List monitors")
  .annotate(Tool.Readonly, true);

const TeamBoardTool = Tool.make(TEAM_BOARD_TOOL, {
  description: TEAM_BOARD_DESCRIPTION,
  parameters: TeamBoardToolInput,
  success: Schema.Struct({
    claimed: Schema.optionalKey(Schema.Array(Schema.String)),
    notGranted: Schema.optionalKey(Schema.Array(Schema.String)),
    conflicts: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({ file: Schema.String, owner: Schema.String, claim: Schema.String }),
      ),
    ),
    handoffs: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          by: Schema.String,
          commit: Schema.String,
          files: Schema.optionalKey(Schema.Array(Schema.String)),
        }),
      ),
    ),
    posts: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        by: Schema.String,
        kind: Schema.String,
        repo: Schema.optionalKey(Schema.String),
        text: Schema.String,
        files: Schema.optionalKey(Schema.Array(Schema.String)),
        to: Schema.optionalKey(Schema.String),
        replyTo: Schema.optionalKey(Schema.String),
        commit: Schema.optionalKey(Schema.String),
        pinned: Schema.optionalKey(Schema.Boolean),
        part: Schema.optionalKey(Schema.Int),
      }),
    ),
    more: Schema.optionalKey(Schema.Int),
    notice: Schema.optionalKey(Schema.String),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Team board")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);

export const OrchestratorToolkit = Toolkit.make(
  MonitorStartTool,
  MonitorStopTool,
  MonitorListTool,
  OrchestratorCapabilitiesTool,
  UsageLimitsTool,
  DelegateTaskTool,
  CouncilTool,
  TaskStatusTool,
  TaskCancelTool,
  WorkflowStopTool,
  ScheduleTaskTool,
  ListScheduledTasksTool,
  ListScheduledTaskRunsTool,
  PreviewWebhookTool,
  DeleteScheduledTaskTool,
  RequestApiKeyTool,
  ListApiKeysTool,
  PrepareApiKeyTool,
  RequestSecretTool,
  AskUserTool,
  CreateThreadsTool,
  ThreadListTool,
  ThreadReadTool,
  ThreadUpdateTool,
  ThreadSendTool,
  ThreadWaitTool,
  ThreadInterruptTool,
  TeamBoardTool,
);
