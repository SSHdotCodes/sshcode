import { T3_MCP_DISPATCH_TOOL } from "@t3tools/shared/t3McpToolPresentation";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ChatControls from "../sessionBoxes/chatControls.ts";
import {
  agentToolListVisible,
  type ToolsCatalogTransform,
  withoutGrades,
} from "./AgentToolCatalog.ts";
import { currentAgentToolPolicyState } from "./AgentToolPolicy.ts";
import * as TeamBoard from "../teamBoard/TeamBoard.ts";
import { TEAM_BOARD_TOOL } from "../teamBoard/model.ts";
import { withCompactAgentCatalog } from "./EagerAgentToolCatalog.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";

export function deferredMcpHarness(
  instances: Readonly<
    Record<string, { readonly driver: string; readonly config?: unknown } | undefined>
  >,
  id: string | undefined,
): "devin" | "muse" | undefined {
  if (id === undefined) return undefined;
  const instance = instances[id];
  const driver = instance?.driver ?? id;
  if (driver === "muse") return "muse";
  if (driver !== "acpRegistry") return undefined;
  const config = instance?.config;
  if (typeof config !== "object" || config === null) return undefined;
  return ("agentId" in config &&
    typeof config.agentId === "string" &&
    config.agentId.trim() === "devin") ||
    ("commandPath" in config &&
      typeof config.commandPath === "string" &&
      /(?:^|[/\\])devin(?:\.exe|\.cmd)?$/iu.test(config.commandPath.trim()))
    ? "devin"
    : undefined;
}

// Includes every identifiable Muse call in the sample and 57% of the broader
// T3 calls. The small search and preview schemas keep the full fixture below 10 KB.
const eagerTools = new Set([
  TEAM_BOARD_TOOL,
  "delegate_task",
  "task_status",
  "t3_thread_read",
  "monitor_start",
  "search_x",
  "preview_evaluate",
  "preview_snapshot",
]);

const purposes: Readonly<Record<string, string>> = {
  ask_user: "Ask on a card",
  bot_memory: "Edit your saved notes",
  cloud_session_move: "Move chat to cloud",
  cloud_session_return: "Return chat to Mac",
  cloud_session_status: "Cloud progress and cost",
  computer_action: "Click or type in an app",
  computer_open: "Lease desktop control",
  computer_release: "Release desktop lease",
  computer_screenshot: "Capture an app image",
  computer_snapshot: "Read app accessibility",
  computer_status: "Check desktop lease",
  council: "Compare subagent answers",
  create_threads: "Create top-level chats",
  debug_log: "Read chat runtime logs",
  delegate_task: "Start an owned subagent",
  delete_scheduled_task: "Delete a schedule",
  device_close: "Close a device panel",
  device_list: "List device hosts and sims",
  device_open: "Open simulator controls",
  device_screenshot: "Capture device image",
  list_api_keys: "List saved key names",
  list_scheduled_tasks: "List project schedules",
  message_bot: "Tell the user's bot",
  model_preferences: "Read user model rankings",
  monitor_list: "List monitors and logs",
  monitor_start: "Run a background waiter",
  monitor_stop: "Stop process group",
  orchestrator_capabilities: "Find models and accounts",
  prepare_api_key: "Use a saved key privately",
  preview_act: "Click or type in a tab",
  preview_dialog: "Handle a browser dialog",
  preview_evaluate: "Run JS in preview tab",
  preview_navigate: "Go to a URL or local port",
  preview_open: "Open browser preview",
  preview_recording_start: "Start recording a tab",
  preview_recording_stop: "Save tab recording",
  preview_resize: "Set browser viewport",
  preview_set_appearance: "Set light or dark mode",
  preview_snapshot: "Read browser snapshot",
  preview_status: "List browser tabs",
  preview_wait_for: "Await browser condition",
  qa_sandbox: "Test UI with fake models",
  read_x_post: "Read an X post by URL",
  report_progress: "Update live progress card",
  request_api_key: "Request a reusable key",
  request_secret: "Ask for a private secret",
  schedule_task: "Create or edit a schedule",
  scheduled_task_runs: "List schedule outcomes",
  search_x: "Search X posts",
  show_card: "Show a native card",
  t3_pending_request_list: "List unanswered cards",
  t3_pending_request_read: "Read a question's options",
  t3_pending_request_respond: "Answer a question card",
  t3_project_list: "List registered projects",
  t3_thread_interrupt: "Interrupt a running turn",
  t3_thread_list: "List chats and task IDs",
  t3_thread_read: "Read chat history/activity",
  t3_thread_send: "Message a chat or subagent",
  t3_thread_update: "Edit chat metadata",
  t3_thread_wait: "Wait for a run to finish",
  t3_workflow_stop: "Stop a Claude workflow",
  unwatch_chats: "Stop watching chats",
  task_cancel: "Cancel subagent work",
  task_status: "Read subagent status/report",
  usage_limits: "Check quotas and resets",
  watch_chats: "Wake on chat events",
  webhook_preview: "Test a webhook template",
  workflow: "Run a multi-phase workflow",
};

const argumentsSchema = Schema.Struct({
  name: Schema.String,
  input: Schema.optionalKey(Schema.JsonObject),
});
const decodeArguments = Schema.decodeUnknownOption(argumentsSchema);
const encodeLookup = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const dispatcher = new McpSchema.Tool({
  name: T3_MCP_DISPATCH_TOOL,
  description: "Run a tool below with input ({} for no args). Omit input for its schema.",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" }, input: { type: "object", additionalProperties: true } },
    required: ["name"],
    additionalProperties: false,
  },
});

const makeDeferMcpCatalog =
  (keepEager: ReadonlySet<string>): ToolsCatalogTransform =>
  (tools) => {
    const eager = [];
    const index: string[] = [];
    for (const tool of tools) {
      if (
        typeof tool !== "object" ||
        tool === null ||
        !("name" in tool) ||
        typeof tool.name !== "string"
      )
        continue;
      if (tool.name === T3_MCP_DISPATCH_TOOL) continue;
      if (keepEager.has(tool.name)) {
        const annotations: { readonly title?: unknown } =
          "annotations" in tool && typeof tool.annotations === "object" && tool.annotations !== null
            ? tool.annotations
            : {};
        const { title: _title, ...hints } = annotations;
        // Preserve the input and permission hints. Calls still return structured results.
        eager.push({
          name: tool.name,
          description: "description" in tool ? tool.description : undefined,
          inputSchema: "inputSchema" in tool ? tool.inputSchema : undefined,
          annotations: hints,
        });
        continue;
      }
      const sentence =
        "description" in tool && typeof tool.description === "string"
          ? (tool.description.split(/(?<=[.!?])\s|\n/u, 1)[0] ?? "")
          : "";
      index.push(`${tool.name}: ${purposes[tool.name] ?? sentence}`);
    }
    return index.length === 0
      ? eager
      : [
          ...eager,
          { ...dispatcher, description: `${dispatcher.description}\n${index.join("\n")}` },
        ];
  };

/** Index only the tools visible to this caller. Direct definitions retain their inputs. */
export const deferMcpCatalog: ToolsCatalogTransform = makeDeferMcpCatalog(eagerTools);

/** Settings > Agents Token use = Low: defer every SSHCode tool behind `t3_tool` until needed. */
export const deferMcpCatalogLow: ToolsCatalogTransform = makeDeferMcpCatalog(new Set());

const eagerToolsWithCards = new Set([...eagerTools, "show_card"]);
const onlyCards = new Set(["show_card"]);
const onlyBoard = new Set([TEAM_BOARD_TOOL]);
const cardsAndBoard = new Set(["show_card", TEAM_BOARD_TOOL]);

/**
 * Low defers the ordinary catalog. Eager cards and a live team board retain
 * their direct definitions when available to this caller.
 */
export const deferMcpCatalogFor = (options: {
  readonly low: boolean;
  readonly eagerCards: boolean;
  readonly eagerTeamBoard?: boolean;
}): ToolsCatalogTransform => {
  if (!options.low)
    return options.eagerCards ? makeDeferMcpCatalog(eagerToolsWithCards) : deferMcpCatalog;
  if (options.eagerTeamBoard)
    return makeDeferMcpCatalog(options.eagerCards ? cardsAndBoard : onlyBoard);
  return options.eagerCards ? makeDeferMcpCatalog(onlyCards) : deferMcpCatalogLow;
};

const errorResult = (text: string) =>
  new McpSchema.CallToolResult({ isError: true, content: [{ type: "text", text }] });

/** Re-enter the ordinary MCP tool handler with the authenticated caller. */
export const layerDeferredMcpDispatcher = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    yield* server.addTool({
      tool: dispatcher,
      annotations: Context.empty(),
      handle: (payload) =>
        Effect.withFiber((fiber) =>
          Effect.gen(function* () {
            const args = decodeArguments(payload);
            if (Option.isNone(args))
              return errorResult("Provide a tool name and optional input object.");
            const { name, input } = args.value;
            const scope = Context.getOrUndefined(
              fiber.context,
              McpInvocationContext.McpInvocationContext,
            );
            const settings = yield* currentAgentToolPolicyState;
            if (
              !settings.available ||
              (settings.agentBehavior.tokens !== "low" &&
                !deferredMcpHarness(settings.providerInstances, scope?.thread?.providerInstanceId))
            )
              return errorResult("Deferred tools are unavailable for this chat.");
            const chatControls = Context.getOrUndefined(
              fiber.context,
              ChatControls.ChatControls,
            ) ?? { subagentsEnabled: () => true };
            const entry = server.tools.find(({ tool }) => tool.name === name);
            const board = Context.getOrUndefined(fiber.context, TeamBoard.TeamBoard);
            if (
              name === T3_MCP_DISPATCH_TOOL ||
              !entry ||
              !agentToolListVisible(
                settings.policy,
                name,
                scope,
                chatControls,
                settings.agentBehavior,
                board?.toolListed,
              )
            )
              return errorResult("Tool is unavailable. Use a name from the catalog.");
            const client = Context.getOrUndefined(fiber.context, McpSchema.McpServerClient);
            const enabledWhen = Context.getOrUndefined(entry.annotations, McpSchema.EnabledWhen);
            if (!client || (enabledWhen && !enabledWhen(client.initializePayload)))
              return errorResult("Tool is unavailable. Use a name from the catalog.");
            if (input !== undefined)
              return yield* server
                .callTool({ name, arguments: input })
                .pipe(Effect.provideService(McpSchema.McpServerClient, client));
            const compact = withCompactAgentCatalog({ ...entry.tool });
            const tool = settings.grading ? compact : withoutGrades(compact);
            return new McpSchema.CallToolResult({
              content: [
                {
                  type: "text",
                  text: encodeLookup({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                  }),
                },
              ],
            });
          }),
        ),
    });
  }),
);
