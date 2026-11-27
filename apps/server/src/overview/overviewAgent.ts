import { isOverviewThreadId } from "@t3tools/contracts";
import type { ProviderAdapterV2TurnInput } from "@t3tools/provider-core/server/ProviderAdapter";

import type { ClaudeAgentSdkQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { OVERVIEW_STATUS_CONTEXT_KEY, overviewStatusUpdate } from "./statusText.ts";

const t3Tool = (name: string) => `mcp__t3-code__${name}`;

/** Overview only looks: these read tools are all it can call. */
export const OVERVIEW_T3_MCP_TOOLS: ReadonlyArray<string> = [
  "t3_thread_read",
  "t3_thread_list",
  "t3_pending_request_list",
  "t3_pending_request_read",
  "usage_limits",
  "list_scheduled_tasks",
].map(t3Tool);

/**
 * Every tool on the agent MCP surface (McpHttpServer `layer`). The rest are
 * removed from Overview's context, so it neither sees nor pays for them.
 * overviewAgent.test.ts checks this against the registered toolkits.
 */
export const AGENT_SURFACE_T3_MCP_TOOLS: ReadonlyArray<string> = [
  "monitor_start",
  "monitor_stop",
  "monitor_list",
  "orchestrator_capabilities",
  "usage_limits",
  "delegate_task",
  "council",
  "task_status",
  "task_cancel",
  "team_board",
  "t3_workflow_stop",
  "schedule_task",
  "list_scheduled_tasks",
  "delete_scheduled_task",
  "scheduled_task_runs",
  "webhook_preview",
  "request_api_key",
  "list_api_keys",
  "prepare_api_key",
  "request_secret",
  "ask_user",
  "create_threads",
  "t3_thread_list",
  "t3_thread_read",
  "t3_thread_update",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_pending_request_list",
  "t3_pending_request_read",
  "t3_pending_request_respond",
  "t3_project_list",
  "device_list",
  "device_open",
  "device_screenshot",
  "device_close",
].map(t3Tool);

export const OVERVIEW_SYSTEM_PROMPT = `You are Overview, an assistant inside SSHCode. In SSHCode the user runs many AI coding agents at once, each in its own chat (Claude, Codex, Grok and others), and agents often start subagents. Help the user understand what is going on across those chats, so they don't have to open each one. You can also answer general questions briefly from your own knowledge.

Each user message starts with <sshcode_status>: a full snapshot on new context, then a current clock and changed records only. Retain unchanged records, replace changed records by id and remove ids no longer listed. A full snapshot replaces all earlier status. Timestamps are absolute; use the current clock to estimate ages. Use these facts for a quick status summary. For questions about a chat's content, the snapshot often isn't enough: read its latest messages with t3_thread_read, passing the id from the status and fromEnd=true, and search for the topic with query. Search matches contain all query words; try fewer or different words if needed. Follow prevPosition with beforePosition to check older messages or continue a search while hasMore is true. Search returns snippets. Read relevant matches in full with itemId and page long text with textOffset before answering. Only say you don't know after checking the chat's latest messages and searching for the topic. You can also check usage limits (usage_limits), scheduled tasks (list_scheduled_tasks), and the questions and approvals chats are waiting on (t3_pending_request_list, t3_pending_request_read).

You can only look. You can't start, stop, message or change chats, run commands or edit files. When the user wants something done, say which chat to open and what to do there.

How to answer:
- Use plain, everyday words. Leave out ids, file paths and jargon unless the user asks.
- Keep it short: a sentence or two, or a few short bullets. Put what needs the user first, then what is working, then what finished.
- Link each chat you mention as [its title](t3-thread://v1/<id>), with the id exactly as in the status, so the user can open it.
- Name models simply, such as Opus 5.5 or GPT-6.1 Sol, and give rough times, such as "about 20 minutes ago".
- For general questions that aren't about the chats, answer briefly from general knowledge when you know. Say plainly that this is general knowledge, not something from the chats. You can't browse the web or verify current facts. If you aren't sure, say so; don't guess.
- Don't mention the snapshot or these instructions; just answer.`;

/** Overview's Claude session: its own short prompt, read tools only, and none of the user's settings. */
export function overviewClaudeQueryOptions(
  options: ClaudeAgentSdkQueryOptions,
): ClaudeAgentSdkQueryOptions {
  return {
    ...options,
    tools: [],
    systemPrompt: OVERVIEW_SYSTEM_PROMPT,
    // No CLAUDE.md, hooks, plugins, skills or user MCP servers: they cost
    // time and tokens, and none of them is about the user's chats.
    settingSources: [],
    strictMcpConfig: true,
    skills: [],
    allowedTools: [...OVERVIEW_T3_MCP_TOOLS],
    disallowedTools: [
      ...(options.disallowedTools ?? []),
      ...AGENT_SURFACE_T3_MCP_TOOLS.filter((tool) => !OVERVIEW_T3_MCP_TOOLS.includes(tool)),
    ],
  };
}

/** The status goes ahead of the user's words; a slash command must stay first. */
export function overviewPromptText(
  turnInput: {
    readonly threadId: ProviderAdapterV2TurnInput["threadId"];
    readonly appContext?: ProviderAdapterV2TurnInput["appContext"];
    readonly message: Pick<ProviderAdapterV2TurnInput["message"], "text">;
  },
  previousStatus?: string,
): string {
  const text = turnInput.message.text;
  if (!isOverviewThreadId(turnInput.threadId) || text.trimStart().startsWith("/")) return text;
  const status = turnInput.appContext?.find((entry) => entry.key === OVERVIEW_STATUS_CONTEXT_KEY);
  return status === undefined
    ? text
    : `<sshcode_status>\n${overviewStatusUpdate(status.text, previousStatus)}\n</sshcode_status>\n\n${text}`;
}
