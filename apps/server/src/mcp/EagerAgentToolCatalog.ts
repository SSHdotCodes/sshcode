import { TEAM_BOARD_DESCRIPTION } from "../teamBoard/model.ts";
import type { ToolsListTransform } from "./AgentToolCatalog.ts";
import { compactAdvertisedInput } from "./advertisedJsonSchema.ts";
const eagerRegistryAgents = new Set(["devin", "hermes", "kimi"]);

/** ACP registry instance ids are user-defined. Match the configured harness. */
export function callerUsesCompactCatalog(
  instances: Readonly<
    Record<string, { readonly driver: string; readonly config?: unknown } | undefined>
  >,
  instanceId: string | undefined,
): boolean {
  if (instanceId === undefined) return false;
  const instance = instances[instanceId];
  const driver = instance?.driver ?? instanceId;
  if (driver === "antigravity" || driver === "muse") return true;
  const config = instance?.config;
  if (driver !== "acpRegistry" || typeof config !== "object" || config === null) return false;
  if (
    "agentId" in config &&
    typeof config.agentId === "string" &&
    eagerRegistryAgents.has(config.agentId.trim())
  )
    return true;
  return (
    "commandPath" in config &&
    typeof config.commandPath === "string" &&
    /(?:^|[/\\])(?:devin|hermes(?:-acp)?|kimi(?:-steer)?)(?:\.exe)?$/iu.test(
      config.commandPath.trim(),
    )
  );
}

const descriptions: Readonly<Record<string, string>> = {
  bot_memory: "Add, edit or remove your dated notes.",
  ask_user:
    "Ask up to 4 user questions on a card with '(Recommended)' first; answers arrive as messages.",
  cloud_session_move:
    "Move chat/subagents to cloud when asked or needed to outlive this Mac; track via cloud_session_status.",
  cloud_session_return:
    "Return cloud session to this Mac; call alone last because it ends the turn.",
  computer_action:
    "Act on a computer lease via snapshot refs; clickAt needs captureId from computer_screenshot.",
  computer_open: "Lease desktop control for GUI testing.",
  council: "Ask 2–4 read-only subagents one self-contained question blind and compare reports.",
  device_list: "List device hosts, simulators, and emulators before opening one.",
  device_open: "Open a simulator/emulator and return its agent-device command.",
  create_threads:
    "Create top-level chats only on user request; use delegate_task for owned subagents.",
  delegate_task:
    "Start an owned subagent with a self-contained brief (no parent history). Fresh clientRequestId except on retry.",
  list_api_keys: "List stored API key names and metadata without values.",
  message_bot: "Tell the user's bot something.",
  list_scheduled_tasks:
    "List schedules (this project by default); pass scheduledTaskId for full prompt.",
  model_preferences:
    "Read user model family rankings for a task, resolved to current provider/model IDs.",
  monitor_list:
    "List this thread’s monitors (includeOutput adds recent output). Wait for wakes; don’t poll.",
  monitor_start:
    "Run a background command (full-access/default) with output/exit wakes. Own process over 10m: durable; waits on anything else: restartable.",
  monitor_stop: "Stop a monitor and its process group.",
  orchestrator_capabilities:
    "Find provider instances and model IDs (check recentFailure/yourRuns); filter with modelSearch, page via nextCursor.",
  prepare_api_key:
    "Prepare saved keys; run the returned one-use 60s commands on the server host, keeping values private.",
  preview_act: "Act on a tab via aria-ref from preview_snapshot or paired x/y.",
  preview_dialog: "Accept or dismiss a preview_status dialog; supply promptText for prompts.",
  preview_evaluate:
    "Run JS in a controlled preview tab and return JSON; use preview_snapshot for user-driven tabs.",
  preview_navigate: "Navigate a tab via url or target ({kind:'environment-port',port}).",
  preview_open:
    "Open a collaborative tab; parallel subagents set reuseExistingTab=false and pass their own tabId.",
  preview_recording_start: "Start recording a collaborative browser tab.",
  preview_recording_stop: "Stop a tab recording and save it locally.",
  preview_resize:
    "Set viewport via mode=fill, freeform (width, height), or preset (device, orientation).",
  preview_snapshot:
    "Read semantic tree with aria-ref locators; since returns patches (apply last to first); save writes PNG.",
  preview_wait_for: "Wait until a preview tab satisfies conditions.",
  qa_sandbox:
    "Start, check, or stop isolated T3 Code UI sandboxes with fake models and a background tab.",
  report_progress: "Update the user's progress card.",
  request_api_key: "Ask for a reusable named API key on a private card; never ask in chat.",
  request_secret:
    "Ask privately for a secret (or multi-part via fields); default secretRef or delivery=file for shell, never print.",
  schedule_task:
    "Create/edit/pause a scheduled task. scheduledTaskId updates supplied fields; enabled=false pauses.",
  show_card:
    "Show the user a native card: text, chat rows, stats, progress, small chart, image, reply buttons, or inputs.",
  t3_queue:
    "List, read, edit, cancel, or reorder queued messages; promote_to_steer targets an active run.",
  search_x: "Search X posts via keywords/operators. Defaults to 7 days; deep searches all dates.",
  team_board: TEAM_BOARD_DESCRIPTION,
  t3_pending_request_list: "List pending user questions for this or another accessible thread.",
  t3_pending_request_read: "Read a pending user question and its options.",
  t3_pending_request_respond: "Answer a pending user question by requestId and question IDs.",
  t3_thread_organize: "Pin, archive, settle, or snooze a thread; snooze needs snoozedUntil.",
  t3_thread_list: "List T3 threads and task IDs; filter by project and page via cursor=nextCursor.",
  t3_thread_read:
    "Read bounded thread history/activity by threadId or taskId; page via afterPosition/beforePosition.",
  t3_thread_send:
    "Message a thread or subagent (peer runs wake on completion). Answer questions via t3_pending_request_respond; reviews use delegate_task.",
  t3_thread_update: "Edit thread metadata.",
  t3_thread_wait:
    "Wait for a thread run to finish (prefer wakes for subagents/peer sends); timeout leaves it running.",
  task_cancel: "Stop an owned subagent, later turns and nested work, or remove a queued send.",
  task_status:
    "Read one subagent’s status or clipped report (don’t poll—wakes deliver results); pass nextSummaryOffset as summaryOffset.",
  usage_limits: "Read provider usage limits, remaining capacity, and reset times.",
  workflow: "Run or manage a multi-phase workflow via action and action-specific fields.",
};

// Field guidance that carries a choice the shape cannot express. Keep shared
// fields here once, and put tool-specific mechanics in the description above.
const fieldGuidance: Readonly<Record<string, string>> = {
  attachmentPaths: "Workspace or attachment files, 50 MiB total.",
  bindToCurrentThread: "Default true; false starts a fresh thread per run.",
  grades: "[{taskId,score:1-6,note}] for work below the brief.",
  restartable: "Relaunch after a restart; read-only waits only, not with durable.",
  silenceMs: "Wake once after this much silence; re-arms on output. Not with durable.",
  wakeOn: "Regex for matching lines plus exit; false for exit only.",
  expectMinutes: "Wake if the command runs well past this.",
  withEdits: "Include uncommitted edits in a worktree subagent.",
  userNamedModel: "User named this exact legacy or custom model.",
  userNamedAccount: "Exact user-named account.",
};

const toolFieldGuidance: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  delegate_task: {
    role: "Task kind: implementation, research, review, design, test, or general.",
    isolation: "shared by default; worktree starts at last commit and runs setup.",
    target:
      "Separate providerInstanceId and model from orchestrator_capabilities. Omit to inherit.",
    mode: "async by default; wait returns on result, question, or timeout.",
    repositoryPath: "Absolute checkout path; needed from a scratch chat.",
    runtimeMode: "Inherit by default; override only for user-requested supervision.",
    timeoutMs: "4 min default. Timeout leaves the subagent running.",
  },
  monitor_start: {
    durable:
      "Your own process: survives server restarts and returns logPath; default wake is exit only.",
    persistent: "Ordinary monitor with no default timeout.",
  },
  preview_snapshot: {
    includeImage: "Return a PNG for visual inspection; default false.",
    save: "Write a PNG and return its absolute screenshotPath.",
  },
  schedule_task: {
    secretRef: "One-use signing secret from request_secret.",
    signature: "Optional HMAC-SHA256 check over the raw request body.",
    schedule:
      "interval needs everyMs; fixed_time needs timeOfDay (HH:mm); once needs runAt (ISO timestamp); webhook needs only type.",
    weekdays: "0=Sunday through 6=Saturday; omit for every day.",
  },
  t3_thread_read: {
    itemId: "Read full item text; pass nextTextOffset as textOffset to continue.",
  },
  t3_thread_send: {
    mode: "auto starts idle or steers/queues busy; queue, steer, or restart to choose explicitly.",
  },
};

export const withCompactAgentCatalog: ToolsListTransform = (tool) => {
  if (typeof tool.name !== "string" || typeof tool.description !== "string") return tool;
  const name = tool.name;
  return {
    ...tool,
    description: descriptions[name] ?? tool.description.split(/(?<=[.!?])\s|\n/u, 1)[0],
    inputSchema: compactAdvertisedInput(
      tool.inputSchema,
      (field) => toolFieldGuidance[name]?.[field] ?? fieldGuidance[field],
    ),
  };
};
