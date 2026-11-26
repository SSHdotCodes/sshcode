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
  ask_user:
    "Ask up to four user questions on a card with the recommended choice first; answers arrive as messages.",
  cloud_session_move:
    "Move a chat or its subagents to the cloud when asked or when work must outlive this Mac; follow progress via cloud_session_status.",
  cloud_session_return:
    "Return a cloud session to this Mac; call alone at the end because it ends the turn.",
  computer_action:
    "Act on a computer lease using snapshot refs; coordinate clicks need captureId from computer_screenshot.",
  computer_open: "Acquire a computer lease for GUI testing.",
  council: "Ask 2–4 independent read-only subagents a self-contained question and compare reports.",
  device_list: "List device hosts, simulators, and emulators before opening one.",
  device_open: "Open a simulator or emulator and return its agent-device command.",
  create_threads:
    "Create top-level chats only on user request; use delegate_task for owned subagents.",
  delegate_task:
    "Start an owned subagent with a self-contained brief and no parent history. Use a fresh clientRequestId except on retry.",
  list_api_keys: "List stored API key names and metadata without values.",
  list_scheduled_tasks:
    "List schedules (current project by default); filter by scheduledTaskId for the full prompt.",
  model_preferences:
    "Read the user’s model family rankings for a task, resolved to current provider and model IDs.",
  monitor_list:
    "List this thread’s monitors; includeOutput returns recent output. Wait for wakes instead of polling.",
  monitor_start:
    "Run a background command (full-access/default) with output or exit wakes. Use durable for work over 10 min.",
  monitor_stop: "Stop a monitor and its whole process group.",
  orchestrator_capabilities:
    "Find provider instances and exact model IDs; filter with modelSearch and page with nextCursor.",
  prepare_api_key:
    "Prepare one or more saved keys; run the returned one-use commands on the server host within 60 seconds and keep values private.",
  preview_act: "Act on a tab using aria-ref from preview_snapshot or paired x/y coordinates.",
  preview_dialog:
    "Accept or dismiss a dialog shown by preview_status; supply promptText when accepting a prompt.",
  preview_evaluate:
    "Run JavaScript in a controlled preview tab and return its JSON result; use preview_snapshot for user-controlled tabs.",
  preview_navigate:
    "Navigate a tab with exactly one of url (website) or target (for a local server, kind=environment-port plus port).",
  preview_open:
    "Open a collaborative tab; parallel subagents set reuseExistingTab=false and pass their own tabId.",
  preview_recording_start: "Start recording a collaborative browser tab.",
  preview_recording_stop: "Stop a tab recording and save it to a local evidence file.",
  preview_resize:
    "Set the viewport using mode=fill, freeform (width and height), or preset (device and orientation).",
  preview_snapshot:
    "Read a semantic tree with aria-ref locators; since returns patches to apply last to first, and save writes a PNG.",
  preview_wait_for: "Wait until a preview tab satisfies a condition.",
  qa_sandbox:
    "Start, check, or stop isolated T3 Code UI sandboxes with fake models and a background tab.",
  request_api_key:
    "Ask the user to enter a reusable named API key on a private card; never ask for its value in chat.",
  request_secret:
    "Ask privately for a secret; use the one-use secretRef for tools or delivery=file for shell use, and never print the value.",
  schedule_task:
    "Create a task with prompt and schedule. scheduledTaskId updates supplied fields. enabled=false pauses.",
  t3_queue:
    "List, read, edit, cancel, or reorder queued messages; promote_to_steer targets an active run.",
  search_x:
    "Search X posts using keywords or X operators. Defaults to 7 days. Use deep for older posts (1–4 min).",
  t3_pending_request_list: "List pending user questions for this or another accessible thread.",
  t3_pending_request_read: "Read a pending user question and its answer options.",
  t3_pending_request_respond: "Answer a pending user question by request ID and question IDs.",
  t3_thread_organize: "Pin, archive, settle, or snooze a thread; snooze needs snoozedUntil.",
  t3_thread_list:
    "List T3 threads and task IDs; filter by project and pass nextCursor as cursor to continue.",
  t3_thread_read:
    "Read bounded thread history or activity by threadId or child taskId; continue with afterPosition=nextPosition or beforePosition=prevPosition.",
  t3_thread_send:
    "Message a thread or child. Peer runs wake you on completion. Answer questions via t3_pending_request_respond. Use delegate_task for independent reviews.",
  t3_thread_update: "Edit thread metadata.",
  t3_thread_wait: "Wait for a thread run to finish without interrupting it on timeout.",
  task_cancel: "Stop an owned subagent, its later turns and nested work, or remove a queued send.",
  task_status:
    "Read an owned subagent’s status and report; continue a clipped report with nextSummaryOffset as summaryOffset.",
  usage_limits: "Read provider usage limits, remaining capacity, and reset times.",
  workflow: "Run or manage a multi-phase workflow using its action and action-specific fields.",
};

// Field guidance that carries a choice the shape cannot express. Keep shared
// fields here once, and put tool-specific mechanics in the description above.
const fieldGuidance: Readonly<Record<string, string>> = {
  attachmentPaths: "Workspace or attachment files, 50 MiB total.",
  bindToCurrentThread: "Default true; false starts a fresh thread per run.",
  grades: "[{taskId,score:1-6,note}] for work below the brief.",
  restartable: "Relaunch after a restart; read-only waits only.",
  silenceMs: "Wake once after this much silence; re-arms on output.",
  wakeOn: "Regex for matching lines plus exit; false for exit only.",
  expectMinutes: "Wake if the command runs well past this.",
  withEdits: "Include uncommitted edits in a worktree subagent.",
  userNamedModel: "User named this exact legacy or custom model.",
  userNamedAccount: "Exact user-named account.",
};

const toolFieldGuidance: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  delegate_task: {
    isolation: "shared by default; worktree starts at last commit and runs setup.",
    target: "Exact IDs from orchestrator_capabilities. Omit to inherit.",
    mode: "async by default; wait returns on result, question, or timeout.",
    repositoryPath: "Absolute checkout path; needed from a scratch chat.",
    runtimeMode: "Inherit by default; override only for user-requested supervision.",
    timeoutMs: "4 min default. Timeout leaves the subagent running.",
  },
  monitor_start: {
    durable: "Survives server restarts and returns logPath; default wake is exit only.",
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
