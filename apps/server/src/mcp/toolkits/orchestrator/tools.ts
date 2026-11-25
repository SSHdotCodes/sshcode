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
    "Live provider/model catalog, inherited settings and orchestration features. Avoid accountUnavailable; credit warnings allow retries. Other account failures reject. 20 models per provider by default; includeOptions=true adds option descriptors. Filter with providerInstanceId and modelSearch; page via cursor=nextCursor. Superseded and legacy models show only when modelSearch names them. images:false cannot read images. Quota: usage_limits.",
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
    "Provider quotas, credits, resets and freshness. Refreshes stale readings for up to 3s. Use to choose subagent providers; spare quota is no reason to delegate.",
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
    "Start one child owned by this thread, with only your self-contained task brief and no parent history. Requires a running agent in an SSHCode thread. Shares this checkout; isolation='worktree' starts from its last local commit, without uncommitted edits. From a scratch chat also pass the absolute repositoryPath; naming it in task text does not select it. Settings inherit unless target overrides them; requested runtimeMode must be supported, inherited modes step down if needed. Use a new clientRequestId for each task or independent review round; reuse only for retries of that call. Follow-ups needing the same child's history use t3_thread_send with its taskId, which every thread tool and task_status/cancel also accepts, unless its workspace was removed. mode='wait' ends on completion, a question or timeout; waitTimedOut leaves the child running.",
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
    "Read a task owned by this parent thread. Summary describes its original run; published results stay stable. workState distinguishes working, waiting_for_children and result_available. A finished turn with nested work is not a finished task. failure has provider errors and may remain retryable after automatic retries. hasPendingChildRuns includes later child turns even after the task ends; task_cancel stops them too. Held work reports held. latestTerminal* reports later non-monitor results. latestTerminalSummary is null when it would repeat summary. Completion wakes and terminal reads acknowledge parent delivery.",
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
  success: Schema.Struct({}),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop a workflow")
  .annotate(Tool.Destructive, true);

export const ScheduleTaskTool = Tool.make("schedule_task", {
  description:
    "Create persistent scheduled work; prompt and schedule are required. With scheduledTaskId, update only supplied fields; enabled=false pauses it. schedule is an object: {type:'interval',everyMs:3600000}, {type:'fixed_time',timeOfDay:'09:00',weekdays:[1,2,3,4,5]}, {type:'once',runAt:'2027-01-15T14:30:00.000Z'}, or {type:'webhook'}. One-shot messages steer an active thread or start an idle one, and deliver when the environment returns if it was offline. Report nextRunAt or webhookUrl; only creation returns it, given T3 Connect remote access and run permission. Don't share a local path. Webhook results carry webhookSetup with template and signature mechanics. Omit projectId for this thread's project, where bindToCurrentThread applies; other projects always get new threads. Provider/model/runtime settings inherit from this thread, or the project's default without a caller.",
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
    "List a project's scheduled tasks. Omit projectId for this thread's project, or all projects outside a thread. Use scheduledTaskId with schedule_task to update.",
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
  success: Schema.Array(
    Schema.Struct({ name: ApiKeyName, scope: ApiKeyScope, expiresAt: ApiKeyExpiry }),
  ),
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
    "Ask for a user decision with a card. Put the recommended option first, its label ending '(Recommended)'; omit options for free text. Unanswered after 10 minutes, it submits that option unless important=true. Answers arrive as new messages, possibly mid-turn. Up to 4 questions.",
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
    "List T3 threads in a project, newest first. Omit projectId for the calling thread's project. Filter by durable run status, title, or settled state (settled=true lists threads the user or auto-settlement moved out of the active list), or snoozed state, and paginate with the returned cursor. A snoozed thread wakes early when it asks for something, fails, or completes.",
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
    "Read durable state and a paginated timeline of any SSHCode thread in this environment. The default messages view returns user and assistant messages and proposed plans; activity returns all summarized timeline items. Reading an untruncated terminal assistant result of this thread's direct app-owned child acknowledges its automatic completion delivery. Returns the latest limit items (fromEnd=false: the first) in position order, up to ~30k chars. Read forward with afterPosition=nextPosition; page back with beforePosition=prevPosition (exclusive) while hasMore is true. query matches, case-insensitively, items in the selected view whose title/text contain all whitespace-separated words, newest first, with a snippet. Search scans at most 1000 items per call; continue with the same query/view and beforePosition=prevPosition while hasMore is true, even after an empty page. search.hasMoreMatches is true if another match exists, false when exhausted, null when the scan bound (search.scanLimitReached) leaves older matches unknown. Don't combine afterPosition with backward/search reads, or itemId with query/backward reads. Get long item text with itemId and textOffset=nextTextOffset until nextTextOffset is null; offsets count UTF-16 code units. Also reports the thread's snooze state.",
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
    "Send to a thread in this environment; its permission modes cannot exceed yours. For independent review rounds use delegate_task with the full brief and a new clientRequestId. Follow-ups needing a child's history use its taskId; a completed task gets a new short taskId, whose completion notifies the parent. Original results stay stable. If its workspace was removed, start a new delegate instead. To answer a pending question, use t3_pending_request_respond, never a message. mode='auto' starts idle threads, steers active turns or queues until steerable. From a child to its parent, auto holds progress for the next turn, waking it within 2 minutes; queue wakes it now. queue requests a separate turn, steer updates one in flight, restart interrupts and restarts. Reuse clientRequestId only for retries.",
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
    "Needs a full-access/default thread. Starts a shell command in this thread's working directory; returns monitorId immediately. For work over 10 minutes (training, builds, uploads, servers) use durable:true: it survives server restarts, returns logPath for complete stdout/stderr, is adopted without relaunching, is never stopped by output volume and has no default timeout (timeoutMs up to 24 h). wakeOn:false wakes only on exit; a regex wakes on matching stdout/stderr lines plus exit; omit for throttled output (durable: exit only). A repeating error also wakes once. Ordinary monitors batch nearby output and stop on excessive output, so use line-buffered filters (grep --line-buffered, sed -u, awk with fflush()); their default timeout is 1 h, removed by persistent:true. restartable:true relaunches ordinary read-only waits after restart; silenceMs reports quiet periods. Neither option applies to durable jobs. Stop, archive or removal kills the whole job group. At most 8 per thread. Reuse clientRequestId when retrying.",
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
    "List this thread's active app-owned monitors and recent output. Don't poll this list. Native Claude Code monitors remain managed by the native Monitor tool.",
  parameters: Tool.EmptyParams,
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
