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
    "Pick providers and models. Overview shows 6 models per provider. Filter by providerInstanceId or modelSearch and page with cursor=nextCursor for more. includeOptions adds model settings. Search for legacy/superseded ids explicitly. images:false means text only. Avoid accountUnavailable. Credit warnings allow retry. See usage_limits for quotas.",
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
    "Provider quotas, credits, resets and freshness. Refreshes stale readings for up to 3s. Use to choose subagent providers; spare quota is no reason to delegate. The limited flag is authoritative. 100% can be rounded.",
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
    "Start a child owned by this thread with a self-contained task brief and no parent history. worktree starts at the last local commit, without uncommitted edits unless withEdits=true. In a scratch chat pass an absolute repositoryPath. Settings inherit. Permission modes may step down. Use a new clientRequestId for each task or independent review round and reuse only for retries. Follow up via t3_thread_send with its taskId. Task ids or unique request keys work in every thread tool and task_status/cancel until workspace removal. wait returns on completion, a question or waitTimedOut. Read more at nextSummaryOffset via task_status.",
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
    "Read subagent status and report. summary is the original result. Pass nextSummaryOffset or a wake's UTF-16 offset as summaryOffset. latestTerminal* describes later non-monitor turns, omitted when they would repeat summary. workState distinguishes working, waiting_for_children and result_available. failure may be retryable. hasPendingChildRuns flags later turns. Wakes and terminal reads acknowledge delivery.",
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
    "Stop a task owned by this parent, including its later child turns, nested delegates and PR watches; remove a still-queued send; otherwise hold queued turns and dispose automatic parent delivery. Works after the original task ends. Terminal status and published results stay available.",
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
    "Stop one running Claude workflow in a SSHCode thread. Use the workflow coordinator's subagentId returned by t3_thread_read with view='activity'. Stops the whole workflow, including its phases and agents. Does not stop the parent thread or other workflows. Individual workflow phases and agents cannot be stopped separately.",
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
    "Create, edit or pause scheduled work. Creation needs prompt and schedule. Updates with scheduledTaskId change supplied fields only. enabled=false pauses. The schedule is an object such as {type:'interval',everyMs:3600000}, {type:'fixed_time',timeOfDay:'09:00',weekdays:[1,2,3,4,5]}, {type:'once',runAt:'2027-01-15T14:30:00.000Z'} or {type:'webhook'}. One-shots steer active threads or start idle ones, even after reconnect. Report nextRunAt or share webhookUrl (creation only with T3 Connect and run permission). See webhookSetup. Bind to this project's thread or start new ones. Inherits caller or project defaults.",
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
    "Ask for a missing/expired API key on a private card, never in chat. Returns at once: keep working, the answer arrives as a message. Check list_api_keys first. The user chooses chat-only or all-session scope and expiry (default chat, 30 days); values stay in the host vault. Then call prepare_api_key and run its command in a shell on the server host.",
  parameters: Schema.Struct({
    name: ApiKeyName,
    label: OrchestratorMcpRequestSecretInput.fields.label,
    reason: OrchestratorMcpRequestSecretInput.fields.reason,
    suggestedScope: Schema.optional(ApiKeyScope),
    suggestedExpiresAt: Schema.optional(ApiKeyExpiry),
    clientRequestId: OrchestratorMcpRequestSecretInput.fields.clientRequestId,
  }),
  success: OrchestratorMcpRequestSecretResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
}).annotate(Tool.Destructive, false);

const ListApiKeysTool = Tool.make("list_api_keys", {
  description:
    "List this chat's available API key names, scopes and expiries, never values. Excludes other threads' private keys and removes expired ones. Missing: request_api_key. To use: prepare_api_key.",
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
    "Prepare saved keys without seeing them. Pass name for one key (returns command) or names for several (returns commands, one per key). Each command carries a one-use, 60-second ticket bound to this thread and key. Run on the server host; the child receives an environment variable and exact echoed values are redacted. Never print, encode, write or extract credentials. Shell access requires a ticket.",
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
    "Ask 2-4 other models the same question independently and get their answers side by side; each runs as a delegated task told to stay read-only, with only your question and context. Use it when the user asks for a council or several models' views, or before a hard-to-reverse decision where capable models may disagree (architecture, research calls). Not for routine work. Waits up to timeoutMs (default 15 min).",
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
    "Ask for a secret on a private card. Returns at once: keep working, the answer arrives as a message. Never ask in chat or invent one. By default the value stays in the app and you receive a one-use secretRef for tools such as schedule_task's signature. For a sudo password (this host or over ssh) or a shell CLI token, set delivery:'file' and read the returned private file inside commands; never print it. The file is deleted after 24 hours: a key needed longer uses request_api_key.",
  parameters: OrchestratorMcpRequestSecretInput,
  success: OrchestratorMcpRequestSecretResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Request a secret from the user")
  .annotate(Tool.Destructive, false);

const AskUserTool = Tool.make("ask_user", {
  description:
    "Ask up to four user questions on a card. Put the '(Recommended)' choice first. Answers arrive as messages, possibly mid-turn.",
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
    'Create top-level chats only when the user asks. Use delegate_task for delegation. Outside a thread, omit projectId to start in this machine\'s "No project" scratch project (created if missing), or pass one from t3_project_list. Inherit caller settings. Share checkouts or use fresh scratch folders. Override target and modes per entry. Waits up to 20s for startup. Later first-run failures notify the calling chat.',
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
    "List project threads, newest first. Defaults to this thread's project and 20 rows. Filter by run status, title, settled or snoozed. Page with nextCursor. includeDetails adds metadata. Snoozed threads wake on a question, failure or completion.",
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
    "Read thread state and latest items by default (max ~30k chars). fromEnd=false starts at the beginning. messages includes plans; activity includes tools. Continue with afterPosition=nextPosition or beforePosition=prevPosition. query is a case-insensitive all-words match, newest first, with snippets. Scans at most 1000 items. Keep query/view and page back even past empty pages. search.hasMoreMatches is true for more, false if exhausted, null unknown past search.scanLimitReached. Read full text with itemId, then textOffset=nextTextOffset (UTF-16). itemId excludes query/backward paging. Reading a full child result acknowledges delivery. Omitted sourceThreadId means this thread.",
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
    "Update a thread. Omit threadId for this thread. rename uses title, link_pull_request uses pullRequest, cancel_queued uses runId. settle removes from active; this thread settles when your turn ends; unsettle restores. Workspace and branch unsupported. clientRequestId dedupes retries.",
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
    "Message a T3 thread within your permission modes. A peer run wakes you on completion. Independent review rounds use delegate_task with the full brief and a new key. For child history use its taskId. A completed task gets a new short taskId and wakes its parent on completion. If its workspace was removed, delegate again. Answer pending questions with t3_pending_request_respond, never a message. auto starts idle or steers/queues busy threads. Child-to-parent auto holds text-only progress up to 2 min, queue wakes now. queue starts a separate turn, steer updates it, restart interrupts it. Reuse clientRequestId only for retries.",
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
    "Wait for a SSHCode thread run to reach a terminal durable state. Without runId, the latest run at call time is selected; an idle thread returns immediately. Timeout does not interrupt work, so call again or use t3_thread_read/list after timedOut=true. Waiting reports status only and does not acknowledge a delegated result.",
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
    "Request interruption of a running turn in any SSHCode thread in this environment. Without runId, the newest interruptible run is selected. Terminal runs and threads without an active turn return without another side effect. clientRequestId makes retries idempotent.",
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
    "Run a shell command in this thread's directory (full-access/default). Returns monitorId now and wake on output or exit. For work over 10 min use durable:true to survive restarts and retain output at logPath. Ordinary monitors default to 1 h unless persistent:true and stop on excessive output. Use line-buffered output, wakeOn for milestones, restartable:true for read-only waits, and silenceMs for stalled output. Repeating errors can wake once. timeoutMs up to 24 h. Stop, archive or removal kills the entire process group. At most 8 per thread. Reuse clientRequestId only for retries.",
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
    "Stop one of this thread's monitors and its entire process group. Returns stopped=false if it already ended. Prefer the native Monitor tool for native Claude Code monitors.",
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
    "List this thread's monitors. includeOutput=true adds recent output. Wait for wakes instead of polling. Claude's native monitors use Monitor.",
  parameters: Schema.Struct({ includeOutput: Schema.optional(Schema.Boolean) }),
  success: MonitorListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: monitorDependencies,
})
  .annotate(Tool.Title, "List monitors")
  .annotate(Tool.Readonly, true);

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
);
