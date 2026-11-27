export type T3McpToolLogo = "t3-code";

export interface T3McpToolPresentation {
  readonly displayName: string;
  readonly logo: T3McpToolLogo;
}

export type T3McpToolSummaryAction =
  | "x-post-read"
  | "x-search"
  | "debug-log"
  | "monitor-start"
  | "monitor-stop"
  | "monitor-list"
  | "model-preferences"
  | "progress-report"
  | "team-board"
  | "capabilities"
  | "usage-limits"
  | "delegate"
  | "council"
  | "task-status"
  | "task-cancel"
  | "schedule-run"
  | "schedule-create"
  | "schedule-list"
  | "schedule-history"
  | "webhook-preview"
  | "schedule-update"
  | "schedule-delete"
  | "thread-create"
  | "thread-list"
  | "thread-read"
  | "thread-send"
  | "thread-wait"
  | "thread-interrupt"
  | "workflow-stop"
  | "thread-configuration"
  | "thread-configure"
  | "thread-fork"
  | "thread-merge"
  | "thread-search"
  | "thread-transfers"
  | "thread-organize"
  | "thread-update"
  | "queue-list"
  | "queue-read"
  | "queue-edit"
  | "queue-cancel"
  | "queue-reorder"
  | "queue-steer"
  | "question-ask"
  | "question-list"
  | "question-read"
  | "question-respond"
  | "secret-request"
  | "worktree-handoff"
  | "worktree-list"
  | "worktree-status"
  | "project-list"
  | "project-read"
  | "project-create"
  | "project-update"
  | "project-delete"
  | "project-clone"
  | "environment-read"
  | "environment-update"
  | "attachment-prepare"
  | "attachment-discard"
  | "attachment-send"
  | "link-pr"
  | "unlink-pr"
  | "list-prs"
  | "watch-pr"
  | "unwatch-pr"
  | "write-pr-guides"
  | "read-pr-guide"
  | "browser"
  | "computer"
  | "device"
  | "workflow"
  | "html-preview"
  | "html-render"
  | "bot-memory"
  | "bot-watch"
  | "bot-message"
  | "card";

export interface T3McpToolDefinition {
  readonly displayName: string;
  readonly labels: readonly [action: string, running: string, completed: string, detail: string];
  readonly icon: "t3-code" | "browser" | "computer" | "device" | "pull-request" | "x-logo";
  readonly summaryAction: T3McpToolSummaryAction;
}

function tool(
  labels: T3McpToolDefinition["labels"],
  summaryAction: T3McpToolSummaryAction,
  icon: T3McpToolDefinition["icon"] = "t3-code",
  displayName = `${labels[0]} ${labels[3]}`,
): T3McpToolDefinition {
  return { displayName, labels, icon, summaryAction };
}

const T3_MCP_SERVER_ALIASES = new Set(["t3-code", "t3_code", "t3code"]);

// Cards, activity rows, summaries, and provider identity recovery share this inventory.
const T3_MCP_TOOLS: Readonly<Record<string, T3McpToolDefinition>> = {
  read_x_post: tool(["Read", "Reading", "Read", "an X post"], "x-post-read", "x-logo"),
  search_x: tool(["Search", "Searching", "Searched", "X"], "x-search", "x-logo"),
  monitor_start: tool(["Start", "Starting", "Started", "a monitor"], "monitor-start"),
  monitor_stop: tool(["Stop", "Stopping", "Stopped", "a monitor"], "monitor-stop"),
  monitor_list: tool(["Check", "Checking", "Checked", "monitors"], "monitor-list"),
  link_pull_request: tool(
    ["Link", "Linking", "Linked", "a pull request"],
    "link-pr",
    "pull-request",
  ),
  unlink_pull_request: tool(
    ["Unlink", "Unlinking", "Unlinked", "a pull request"],
    "unlink-pr",
    "pull-request",
  ),
  list_thread_pull_requests: tool(
    ["Check", "Checking", "Checked", "linked pull requests"],
    "list-prs",
    "pull-request",
  ),
  watch_pull_request: tool(
    ["Watch", "Watching", "Watching", "a pull request"],
    "watch-pr",
    "pull-request",
  ),
  unwatch_pull_request: tool(
    ["Stop watching", "Stopping watching", "Stopped watching", "a pull request"],
    "unwatch-pr",
    "pull-request",
  ),
  write_pull_request_guides: tool(
    ["Write", "Writing", "Started", "review guides"],
    "write-pr-guides",
    "pull-request",
  ),
  read_pull_request_guide: tool(
    ["Read", "Reading", "Read", "a review guide"],
    "read-pr-guide",
    "pull-request",
  ),
  orchestrator_capabilities: tool(
    ["Get", "Getting", "Got", "orchestration capabilities"],
    "capabilities",
  ),
  debug_log: tool(["Capture", "Capturing", "Captured", "debug logs"], "debug-log"),
  model_preferences: tool(["Read", "Reading", "Read", "model preferences"], "model-preferences"),
  report_progress: tool(["Report", "Reporting", "Reported", "progress"], "progress-report"),
  team_board: tool(["Use", "Using", "Used", "the team board"], "team-board"),
  usage_limits: tool(["Check", "Checking", "Checked", "provider usage limits"], "usage-limits"),
  delegate_task: tool(["Delegate", "Delegating", "Delegated", "a child task"], "delegate"),
  council: tool(["Consult", "Consulting", "Consulted", "other models"], "council"),
  task_status: tool(["Get", "Getting", "Got", "delegated task status"], "task-status"),
  t3_tool: tool(["Look up", "Looking up", "Looked up", "a T3 tool"], "task-status"),
  task_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "delegated task"],
    "task-cancel",
  ),
  schedule_task: tool(
    ["Schedule", "Scheduling", "Scheduled", "a recurring task"],
    "schedule-create",
  ),
  list_scheduled_tasks: tool(["List", "Listing", "Listed", "scheduled tasks"], "schedule-list"),
  scheduled_task_runs: tool(
    ["Read", "Reading", "Read", "scheduled task history"],
    "schedule-history",
  ),
  webhook_preview: tool(
    ["Preview", "Previewing", "Previewed", "a webhook prompt"],
    "webhook-preview",
  ),
  update_scheduled_task: tool(
    ["Update", "Updating", "Updated", "a scheduled task"],
    "schedule-update",
  ),
  delete_scheduled_task: tool(
    ["Delete", "Deleting", "Requested deletion of", "a scheduled task"],
    "schedule-delete",
  ),
  ask_user: tool(["Ask", "Asking", "Asked", "the user"], "question-ask"),
  request_api_key: tool(["Ask for", "Asking for", "Asked for", "an API key"], "secret-request"),
  list_api_keys: tool(["List", "Listing", "Listed", "API keys"], "secret-request"),
  prepare_api_key: tool(["Prepare", "Preparing", "Prepared", "an API key"], "secret-request"),
  request_secret: tool(["Ask for", "Asking for", "Asked for", "a secret"], "secret-request"),
  bot_memory: tool(["Update", "Updating", "Updated", "its memory"], "bot-memory"),
  watch_chats: tool(["Watch", "Watching", "Watching", "chats"], "bot-watch"),
  unwatch_chats: tool(
    ["Stop watching", "Stopping watching", "Stopped watching", "chats"],
    "bot-watch",
  ),
  message_bot: tool(["Message", "Messaging", "Messaged", "the bot"], "bot-message"),
  create_threads: tool(["Create", "Creating", "Created", "chats"], "thread-create"),
  t3_thread_start: tool(["Start", "Starting", "Started", "a chat"], "thread-create"),
  t3_thread_list: tool(["List", "Listing", "Listed", "chats"], "thread-list"),
  t3_thread_read: tool(["Read", "Reading", "Read", "a chat"], "thread-read"),
  t3_thread_send: tool(["Send", "Sending", "Sent", "to a chat"], "thread-send"),
  t3_thread_wait: tool(["Wait", "Waiting", "Waited", "for a chat"], "thread-wait"),
  t3_workflow_stop: tool(
    ["Stop", "Stopping", "Requested a stop for", "a workflow"],
    "workflow-stop",
  ),
  t3_thread_interrupt: tool(
    ["Interrupt", "Interrupting", "Requested an interrupt of", "a chat"],
    "thread-interrupt",
  ),
  t3_worktree_handoff: tool(
    ["Hand off", "Handing off", "Handed off", "thread to a git worktree"],
    "worktree-handoff",
  ),
  t3_worktree_status: tool(["Get", "Getting", "Got", "thread worktree status"], "worktree-status"),
  qa_sandbox: tool(
    ["Manage", "Managing", "Managed", "QA sandbox"],
    "browser",
    "browser",
    "QA sandbox",
  ),
  preview_status: tool(["Get", "Getting", "Got", "preview browser status"], "browser", "browser"),
  preview_open: tool(
    ["Open", "Opening", "Opened", "a page in the preview browser"],
    "browser",
    "browser",
  ),
  preview_navigate: tool(
    ["Navigate", "Navigating", "Navigated", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_dialog: tool(
    ["Respond", "Responding", "Responded", "to a preview browser dialog"],
    "browser",
    "browser",
  ),
  preview_snapshot: tool(
    ["Take a snapshot of", "Taking a snapshot of", "Took a snapshot of", "the preview page"],
    "browser",
    "browser",
    "Snapshot the preview page",
  ),
  preview_act: tool(["Use", "Using", "Used", "the preview browser"], "browser", "browser"),
  preview_click: tool(
    ["Click", "Clicking", "Clicked", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_press: tool(
    ["Press", "Pressing", "Pressed", "a key in the preview browser"],
    "browser",
    "browser",
  ),
  preview_type: tool(["Type", "Typing", "Typed", "in the preview browser"], "browser", "browser"),
  preview_hover: tool(
    ["Hover", "Hovering", "Hovered", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_select: tool(
    ["Choose", "Choosing", "Chose", "an option in the preview browser"],
    "browser",
    "browser",
  ),
  preview_drag: tool(
    ["Drag", "Dragging", "Dragged", "in the preview browser"],
    "browser",
    "browser",
  ),
  preview_upload: tool(
    ["Upload", "Uploading", "Uploaded", "files to the preview browser"],
    "browser",
    "browser",
  ),
  preview_scroll: tool(
    ["Scroll", "Scrolling", "Scrolled", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_resize: tool(
    ["Resize", "Resizing", "Resized", "the preview browser"],
    "browser",
    "browser",
  ),
  preview_evaluate: tool(
    ["Evaluate", "Evaluating", "Evaluated", "script in the preview browser"],
    "browser",
    "browser",
  ),
  preview_wait_for: tool(
    ["Wait", "Waiting", "Waited", "for the preview page"],
    "browser",
    "browser",
  ),
  preview_set_appearance: tool(
    ["Set", "Setting", "Set", "preview browser appearance"],
    "browser",
    "browser",
  ),
  preview_recording_start: tool(
    ["Start", "Starting", "Started", "recording the preview browser"],
    "browser",
    "browser",
  ),
  preview_recording_stop: tool(
    ["Stop", "Stopping", "Stopped", "recording the preview browser"],
    "browser",
    "browser",
  ),
  device_list: tool(["List", "Listing", "Listed", "simulators and emulators"], "device", "device"),
  device_open: tool(
    ["Open", "Opening", "Opened", "a device in the Device panel"],
    "device",
    "device",
  ),
  device_screenshot: tool(
    ["Take a screenshot of", "Taking a screenshot of", "Took a screenshot of", "the device"],
    "device",
    "device",
  ),
  device_close: tool(["Close", "Closing", "Closed", "a device"], "device", "device"),
  computer_status: tool(
    ["Check", "Checking", "Checked", "computer access"],
    "computer",
    "computer",
  ),
  computer_open: tool(
    ["Open", "Opening", "Opened", "an app on the computer"],
    "computer",
    "computer",
  ),
  computer_snapshot: tool(
    ["Inspect", "Inspecting", "Inspected", "the app on the computer"],
    "computer",
    "computer",
  ),
  computer_action: tool(
    ["Act in", "Acting in", "Acted in", "the app on the computer"],
    "computer",
    "computer",
  ),
  computer_release: tool(
    ["Release", "Releasing", "Released", "computer control"],
    "computer",
    "computer",
  ),
  computer_screenshot: tool(
    [
      "Take a screenshot of",
      "Taking a screenshot of",
      "Took a screenshot of",
      "the app on the computer",
    ],
    "computer",
    "computer",
    "Screenshot the app on the computer",
  ),
  workflow: tool(["Manage", "Managing", "Managed", "an agent team"], "workflow"),
  run_scheduled_task_now: tool(
    ["Run", "Running", "Requested a run of", "a scheduled task"],
    "schedule-run",
  ),
  t3_queue: tool(["Manage", "Managing", "Managed", "queued messages"], "queue-edit"),
  t3_queue_list: tool(["List", "Listing", "Listed", "queued messages"], "queue-list"),
  t3_queue_read: tool(["Read", "Reading", "Read", "a queued message"], "queue-read"),
  t3_queue_edit: tool(["Edit", "Editing", "Edited", "a queued message"], "queue-edit"),
  t3_queue_cancel: tool(
    ["Cancel", "Canceling", "Requested cancellation of", "a queued run"],
    "queue-cancel",
  ),
  t3_queue_reorder: tool(["Reorder", "Reordering", "Reordered", "a queued run"], "queue-reorder"),
  t3_queue_promote_to_steer: tool(
    ["Steer with", "Steering with", "Requested steering with", "a queued message"],
    "queue-steer",
  ),
  t3_pending_request_list: tool(
    ["List", "Listing", "Listed", "pending questions"],
    "question-list",
  ),
  t3_pending_request_read: tool(["Read", "Reading", "Read", "pending questions"], "question-read"),
  t3_pending_request_respond: tool(
    ["Answer", "Answering", "Answered", "pending questions"],
    "question-respond",
  ),
  t3_thread_configuration: tool(
    ["Read", "Reading", "Read", "thread configuration"],
    "thread-configuration",
  ),
  t3_thread_configure: tool(["Set", "Setting", "Set", "thread model"], "thread-configure"),
  t3_thread_transfer: tool(["Use", "Using", "Used", "thread transfers"], "thread-fork"),
  t3_thread_fork: tool(["Fork", "Forking", "Requested a fork of", "this thread"], "thread-fork"),
  t3_thread_merge_back: tool(
    ["Merge", "Merging", "Requested a merge of", "thread context"],
    "thread-merge",
  ),
  t3_thread_search: tool(["Search", "Searching", "Searched", "thread content"], "thread-search"),
  t3_thread_transfers: tool(["Read", "Reading", "Read", "thread transfers"], "thread-transfers"),
  t3_thread_organize: tool(["Organize", "Organizing", "Organized", "a thread"], "thread-organize"),
  t3_thread_update: tool(["Update", "Updating", "Updated", "chat details"], "thread-update"),
  t3_worktree_list: tool(["List", "Listing", "Listed", "workspace branches"], "worktree-list"),
  t3_preview_list: tool(["List", "Listing", "Listed", "preview tabs"], "browser", "browser"),
  t3_preview_close: tool(["Close", "Closing", "Closed", "a preview tab"], "browser", "browser"),
  t3_environment_read: tool(
    ["Read", "Reading", "Read", "environment preferences"],
    "environment-read",
  ),
  t3_environment_preferences_update: tool(
    ["Update", "Updating", "Updated", "environment preferences"],
    "environment-update",
  ),
  t3_thread_launch: tool(["Launch", "Launching", "Launched", "a project thread"], "thread-create"),
  t3_project_list: tool(["List", "Listing", "Listed", "projects"], "project-list"),
  t3_project_read: tool(["Read", "Reading", "Read", "a project"], "project-read"),
  t3_project_create: tool(["Register", "Registering", "Registered", "a project"], "project-create"),
  t3_project_update: tool(["Update", "Updating", "Updated", "a project"], "project-update"),
  t3_project_delete: tool(["Delete", "Deleting", "Deleted", "a project"], "project-delete"),
  t3_project_clone: tool(["Clone", "Cloning", "Cloned", "a repository"], "project-clone"),
  t3_attachment_prepare_upload: tool(
    ["Prepare", "Preparing", "Prepared", "an attachment upload"],
    "attachment-prepare",
  ),
  t3_attachment_discard: tool(
    ["Discard", "Discarding", "Discarded", "a pending attachment"],
    "attachment-discard",
  ),
  t3_thread_send_attachments: tool(["Send", "Sending", "Sent", "attachments"], "attachment-send"),
  html_preview: tool(["Preview", "Previewing", "Previewed", "an HTML page"], "html-preview"),
  html_render: tool(["Render", "Rendering", "Rendered", "an HTML page"], "html-render"),
  show_card: tool(["Show", "Showing", "Showed", "a card"], "card"),
};

/**
 * The T3 orchestration tool inventory, used to gate loose name matching on
 * both the server (ACP MCP identity recovery) and the client (logo branding).
 */
export const T3_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(Object.keys(T3_MCP_TOOLS));

function normalizeT3McpToolLabel(value: string): string {
  return value
    .replace(/^\s*Run(?:ning)?\s+/i, "")
    .replace(/\?\s*$/, "")
    .replace(/\s+(?:complete|completed)\s*$/i, "")
    .trim();
}

/**
 * ACP agents disagree on how the injected SSHCode server prefixes its tools:
 * `mcp__t3-code__x` (Claude/Cursor), `t3-code.x` (Codex), plus single
 * underscore, colon, slash, dash, and space separators seen from registry
 * agents. The prefix match is deliberately loose because the display-name
 * inventory is the real gate; unknown tools stay on the generic renderer.
 */
function resolveT3McpToolName(value: string): string | null {
  const label = normalizeT3McpToolLabel(value);
  const mcpMatch = /^mcp__(?<server>.+?)__(?<tool>.+)$/i.exec(label);
  if (mcpMatch?.groups) {
    const { server, tool } = mcpMatch.groups;
    return server !== undefined &&
      tool !== undefined &&
      T3_MCP_SERVER_ALIASES.has(server.toLowerCase())
      ? tool
      : null;
  }

  const namespaceMatch = /^(?<server>t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*)(?<tool>.+)$/i.exec(
    label,
  );
  if (namespaceMatch?.groups) {
    return namespaceMatch.groups.tool ?? null;
  }

  const prefixed = /^(?:mcp[-_]{1,2})?(?:t3[-_ ]?code|sshcode)(?:__|[-_.:/ ])(?<tool>.+)$/i.exec(
    label,
  );
  const candidate = prefixed?.groups?.tool ?? label;
  if (Object.hasOwn(T3_MCP_TOOLS, candidate)) return candidate;
  // OpenCode 2 registers one server per thread, `t3-code-<thread>`, and joins
  // it to the tool with `_`. Thread ids can hold `_` too, so take the longest
  // known tool name that ends the label.
  if (!/^t3-code-/i.test(label)) return null;
  let longest: string | null = null;
  for (const tool of Object.keys(T3_MCP_TOOLS)) {
    if (label.endsWith(`_${tool}`) && tool.length > (longest?.length ?? 0)) longest = tool;
  }
  return longest;
}

const resolvedToolIds = new Map<string, string | null>();
const MAX_RESOLVED_TOOL_IDS = 512;

/** The bare T3 tool name (`html_render`) for any provider's spelling of it. */
export function resolveT3McpToolId(toolName: string | null | undefined): string | null {
  if (toolName == null) return null;
  if (T3_MCP_TOOL_NAMES.has(toolName)) return toolName;
  const cached = resolvedToolIds.get(toolName);
  if (cached !== undefined) return cached;

  const name = resolveT3McpToolName(toolName);
  const id = name !== null && T3_MCP_TOOL_NAMES.has(name) ? name : null;
  // Rows reuse tool names, including generic ones, while rendering several labels per call.
  if (toolName.length <= 256) {
    resolvedToolIds.set(toolName, id);
    if (resolvedToolIds.size > MAX_RESOLVED_TOOL_IDS) {
      const oldest = resolvedToolIds.keys().next();
      if (!oldest.done) resolvedToolIds.delete(oldest.value);
    }
  }
  return id;
}

export const T3_MCP_DISPATCH_TOOL = "t3_tool";

/** Recover a deferred call's canonical identity for provider timeline events. */
export function resolveT3McpDispatch(toolName: string | undefined, value: unknown) {
  if (resolveT3McpToolId(toolName) !== T3_MCP_DISPATCH_TOOL) return undefined;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  const args =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  const tool = args?.name;
  if (typeof tool !== "string" || tool === T3_MCP_DISPATCH_TOOL || !T3_MCP_TOOL_NAMES.has(tool))
    return undefined;
  const input = args?.input;
  if (input !== undefined && (typeof input !== "object" || input === null || Array.isArray(input)))
    return undefined;
  return { tool, input: (input ?? {}) as Record<string, unknown>, lookup: input === undefined };
}

type SummaryInput = Readonly<Record<string, unknown>>;

const asSummaryInput = (input: unknown): SummaryInput | undefined =>
  typeof input === "object" && input !== null ? (input as SummaryInput) : undefined;

/** Action tools present each call as the single-purpose tool its action replaced. */
const ACTION_TOOLS: Readonly<Record<string, (action: string) => string | undefined>> = {
  preview_act: (action) => `preview_${action}`,
  t3_queue: (action) => `t3_queue_${action}`,
  t3_thread_transfer: (action) =>
    ({ fork: "t3_thread_fork", merge_back: "t3_thread_merge_back", status: "t3_thread_transfers" })[
      action
    ],
};

/** Pass the call's input so an action tool resolves to the labels and summary of its action. */
export function resolveT3McpToolDefinition(
  toolName: string | null | undefined,
  input?: unknown,
): T3McpToolDefinition | null {
  const name = resolveT3McpToolId(toolName);
  if (name === null) return null;
  const fields = asSummaryInput(input);
  if (name === "schedule_task" && fields?.scheduledTaskId !== undefined)
    return T3_MCP_TOOLS.update_scheduled_task!;
  if (name === "t3_thread_configure" && fields && fields.modelSelection === undefined)
    return T3_MCP_TOOLS.t3_thread_configuration!;
  const action = fields?.action;
  const actionTool = typeof action === "string" ? ACTION_TOOLS[name]?.(action) : undefined;
  return actionTool !== undefined && Object.hasOwn(T3_MCP_TOOLS, actionTool)
    ? T3_MCP_TOOLS[actionTool]!
    : T3_MCP_TOOLS[name]!;
}

export function resolveT3McpToolSummaryAction(
  toolName: string | null | undefined,
  input?: unknown,
): T3McpToolSummaryAction | null {
  return resolveT3McpToolDefinition(toolName, input)?.summaryAction ?? null;
}

export function resolveT3McpToolPresentation(
  toolName: string | null | undefined,
  input?: unknown,
): T3McpToolPresentation | null {
  const definition = resolveT3McpToolDefinition(toolName, input);
  return definition === null ? null : { displayName: definition.displayName, logo: "t3-code" };
}
