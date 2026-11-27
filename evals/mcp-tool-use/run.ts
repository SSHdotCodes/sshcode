#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off, preferSchemaOverJson:off, cryptoRandomUUIDInEffect:off -- dev-only request/response transport and serialized VM bridge.
/**
 * Replays synthetic threads against T3's MCP tools using the real Codex CLI or an
 * OpenAI-compatible API. See README.md for isolation, sampling and case authoring.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeUtil from "node:util";
import * as NodeVM from "node:vm";
import { requireChatGptLogin, runCliSample } from "./codex-cli.ts";
import {
  requireInstructionsApplied,
  setInstructionsOverride,
  withInstructionsOverride,
} from "./instructionsOverride.ts";
import * as NodeZlib from "node:zlib";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { OrchestratorMcpTaskRole, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Tool } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import { advertisedJsonSchema } from "../../apps/server/src/mcp/advertisedJsonSchema.ts";
import { agentToolkits } from "../../apps/server/src/mcp/AgentToolCatalog.ts";

import { buildCodexAdditionalContext } from "../../apps/server/src/provider/CodexDeveloperInstructions.ts";
import { AttachmentToolkit } from "../../apps/server/src/mcp/toolkits/attachment/tools.ts";
import { DeviceToolkit } from "../../apps/server/src/mcp/toolkits/device/tools.ts";
import { ComputerToolkit } from "../../apps/server/src/mcp/toolkits/computer/tools.ts";
import { ModelPreferencesToolkit } from "../../apps/server/src/mcp/toolkits/modelPreferences/tools.ts";
import { EnvironmentToolkit } from "../../apps/server/src/mcp/toolkits/environment/tools.ts";
import { HtmlToolkit } from "../../apps/server/src/mcp/toolkits/html/tools.ts";
import { OrchestratorToolkit } from "../../apps/server/src/mcp/toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "../../apps/server/src/mcp/toolkits/preview/tools.ts";
import { PreviewControlsToolkit } from "../../apps/server/src/mcp/toolkits/previewControls/tools.ts";
import { ProjectToolkit } from "../../apps/server/src/mcp/toolkits/project/tools.ts";
import { PullRequestsToolkit } from "../../apps/server/src/mcp/toolkits/pullRequests/tools.ts";
import { ThreadToolkit } from "../../apps/server/src/mcp/toolkits/thread/tools.ts";
import { WorktreeToolkit } from "../../apps/server/src/mcp/toolkits/worktree/tools.ts";
import {
  CLAUDE_PROVIDER,
  makeClaudeQueryOptions,
} from "../../apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
// Eval models are chosen at the command line from the endpoint's live catalog.
type Model = string;
const isCodex = (model: Model) => !model.startsWith("claude-");
const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
type Usage = { input: number; output: number; cacheWrite: number; cacheRead: number };
const T3_PREFIX = "mcp__t3-code__";
const RUNTIME_MARKER = "<runtime_info>";
const TOOL_LOADED = "Tool loaded.";
const DEFERRED_LIST =
  /(The following deferred tools are now available via ToolSearch\.[^\n]*\n)((?:[^\n]+\n)*)/;
const MODEL_LINE = /You are powered by the model named .+?\. The exact model ID is [\w.-]+\./;
// API keys can be billed differently for requests that open with Claude Code's identity line,
// so every copy of it becomes a neutral line. The rest of the captured prompt is unchanged.
const IDENTITY =
  /You are Claude Code, Anthropic's official CLI for Claude(?:, running within the Claude Agent SDK)?\./g;
const NEUTRAL_IDENTITY = "You are an AI coding agent running in the user's terminal.";

type Block = { readonly type: string; readonly [key: string]: unknown };
type ApiMessage = { readonly role: "user" | "assistant"; readonly content: ReadonlyArray<Block> };
type ApiTool = { readonly name: string; readonly [key: string]: unknown };
type Call = { readonly step: number; readonly tool: string; readonly input: unknown };
export type SampleRun = {
  readonly calls: ReadonlyArray<Call>;
  text: string;
  stopReason: string;
  /** PRs linked to the thread when the sample ends, by the agent or by T3. */
  readonly linked?: ReadonlyArray<string>;
};

const Rest = [Schema.Record(Schema.String, Schema.Unknown)] as const;

const PriorToolCall = Schema.Struct({
  tool: Schema.String,
  input: Schema.Unknown,
  result: Schema.Unknown,
});

/**
 * One expected call. `args` match partially: `~text` is a case-insensitive substring,
 * `"<=N"` / `">=N"` bound a number, and keys may be dotted paths.
 */
const McpToolUseCall = Schema.Struct({
  tool: Schema.String,
  args: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
type McpToolUseCall = typeof McpToolUseCall.Type;

/** Grading rules. Tool names are bare: `delegate_task`, `Bash`, `Agent`. */
const McpToolUseExpect = Schema.Struct({
  /** Each entry needs one matching call. */
  calls: Schema.optional(Schema.Array(McpToolUseCall)),
  /** Each group needs one call matching any of its entries. */
  callsOneOf: Schema.optional(Schema.Array(Schema.Array(McpToolUseCall))),
  /** No call may match any entry. */
  callsMustNot: Schema.optional(Schema.Array(McpToolUseCall)),
  notCalls: Schema.optional(Schema.Array(Schema.String)),
  /** First calls of these tools happen in this order. */
  order: Schema.optional(Schema.Array(Schema.String)),
  minCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  maxCalls: Schema.optional(Schema.Record(Schema.String, Schema.Number)),
  /** The last step with tool calls includes this tool, then the turn ends. */
  endsTurnAfter: Schema.optional(Schema.String),
  /** Regexes that no shell command may match. */
  shellMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Case-sensitive regexes on the agent's visible text. */
  textMust: Schema.optional(Schema.Array(Schema.String)),
  textMustNot: Schema.optional(Schema.Array(Schema.String)),
  /** Each entry matches a PR URL linked at the end, as `args` values match. */
  linked: Schema.optional(Schema.Array(Schema.String)),
});

/**
 * The agent's machine, as the shell simulator and the gitStatus reminder see it. Only these keys
 * are typed; others (files, diff, prs, pages) are free-form facts for the simulator.
 */
const McpToolUseWorld = Schema.StructWithRest(
  Schema.Struct({
    /** GitHub `owner/name`. Defaults to `acme/app`. */
    repo: Schema.optional(Schema.String),
    branch: Schema.optional(Schema.String),
    /** `git status --short` lines. */
    status: Schema.optional(Schema.String),
    /** Newest first. On a branch other than main, these are the commits main lacks. */
    commits: Schema.optional(
      Schema.Array(
        Schema.StructWithRest(Schema.Struct({ sha: Schema.String, subject: Schema.String }), Rest),
      ),
    ),
  }),
  Rest,
);

/** One fake thread, one JSON object per line in a case file. */
export const McpToolUseCase = Schema.Struct({
  id: Schema.String,
  area: Schema.String,
  kind: Schema.Literals(["bad", "guard", "control"]),
  pattern: Schema.String,
  experience: Schema.String,
  rule: Schema.optional(Schema.String),
  privacy: Schema.optional(Schema.Literals(["commit-safe", "private"])),
  setup: Schema.Struct({
    role: Schema.Literals(["top", "delegated-child", "native-subagent"]),
    /** Runs only on this harness, for cases whose right answer depends on it. */
    harness: Schema.optional(Schema.Literals(["claude", "codex"])),
    /** delegate_task `role` for a delegated child. T3 builds the child's first message from it. */
    delegateRole: Schema.optional(OrchestratorMcpTaskRole),
    context: Schema.optional(Schema.String),
    priorTurns: Schema.optional(
      Schema.Array(
        Schema.Struct({
          role: Schema.Literals(["user", "assistant"]),
          text: Schema.optional(Schema.String),
          toolCalls: Schema.optional(Schema.Array(PriorToolCall)),
        }),
      ),
    ),
    world: Schema.optional(McpToolUseWorld),
    /** Canned tool results by bare name, T3 or native. `"default"` uses the runner's result. */
    mocks: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    /** Regexes on one part of a shell command. A match wins over the shell simulator. */
    shellMocks: Schema.optional(
      Schema.Array(Schema.Struct({ match: Schema.String, output: Schema.String })),
    ),
  }),
  prompt: Schema.String,
  expect: McpToolUseExpect,
  /** Model calls this case may need. Overrides `--max-steps`. */
  maxSteps: Schema.optional(Schema.Number),
  source: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  notes: Schema.optional(Schema.String),
});
export type McpToolUseCase = typeof McpToolUseCase.Type;
const AnyBlock = Schema.StructWithRest(
  Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  Rest,
);
const Content = Schema.Union([Schema.String, Schema.Array(AnyBlock)]);
const MessagesRequest = Schema.Struct({
  system: Schema.optional(Content),
  messages: Schema.Array(Schema.Struct({ role: Schema.String, content: Content })),
  tools: Schema.Array(Schema.StructWithRest(Schema.Struct({ name: Schema.String }), Rest)),
});
// A CLIProxyAPI capture keeps the Anthropic body at request.provider_native.
const Capture = Schema.Struct({ request: Schema.Struct({ provider_native: MessagesRequest }) });
const ResponsesRequest = Schema.StructWithRest(
  Schema.Struct({
    input: Schema.Array(AnyBlock),
    reasoning: Schema.StructWithRest(Schema.Struct({ effort: Schema.String }), Rest),
  }),
  Rest,
);
const CodexCapture = Schema.Struct({
  request: Schema.Struct({ provider_native: ResponsesRequest }),
});
const ToolUse = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Unknown,
});
const isToolUse = Schema.is(ToolUse);
const isText = Schema.is(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }));
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const Count = Schema.optional(Schema.NullOr(Schema.Number));
const ApiResponse = Schema.Struct({
  content: Schema.Array(AnyBlock),
  stop_reason: Schema.NullOr(Schema.String),
  usage: Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
    cache_creation_input_tokens: Count,
    cache_read_input_tokens: Count,
  }),
});

const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const addUsage = (total: Usage, usage: typeof ApiResponse.Type.usage) => {
  total.input += usage.input_tokens;
  total.output += usage.output_tokens;
  total.cacheWrite += usage.cache_creation_input_tokens ?? 0;
  total.cacheRead += usage.cache_read_input_tokens ?? 0;
};

const text = (value: string): Block => ({ type: "text", text: value });
const reminder = (value: string) => text(`<system-reminder>\n${value}\n</system-reminder>`);
const valueText = (value: unknown) =>
  typeof value === "string" ? value : (JSON.stringify(value) ?? "");
const toolResult = (id: string, content: unknown): Block => ({
  type: "tool_result",
  tool_use_id: id,
  content: valueText(content),
});
const texts = (content: typeof Content.Type) =>
  typeof content === "string" ? [content] : content.flatMap((block) => block.text ?? []);
const isT3Name = (name: string) => name.startsWith(T3_PREFIX) || name.startsWith("mcp__t3_code__");
const hasTool = (tools: ReadonlyArray<ApiTool>, name: string) =>
  tools.some((tool) => tool.name === name);

/** Grading name: T3 tools lose their MCP prefix, native tools keep the part after the last `_`. */
const CODEX_NAMES: Readonly<Record<string, string>> = {
  exec_command: "Bash",
  shell_command: "Bash",
  shell: "Bash",
  spawn_agent: "Agent",
  apply_patch: "Edit",
  write_stdin: "write_stdin",
  web__run: "WebFetch",
};
export const normalizeToolName = (name: string) => {
  const bare = name.slice(name.lastIndexOf(".") + 1);
  return isT3Name(bare)
    ? bare.slice(T3_PREFIX.length)
    : (CODEX_NAMES[bare] ??
        (bare.startsWith("t3_") ||
        bare.startsWith("preview_") ||
        allToolkits.some((toolkit) => Object.hasOwn(toolkit.tools, bare))
          ? bare
          : bare.slice(bare.lastIndexOf("_") + 1)));
};
export const normalizeToolInput = (name: string, input: unknown) =>
  normalizeToolName(name) === "Bash" && isRecord(input)
    ? { ...input, command: input.command ?? input.cmd }
    : typeof input === "string" && normalizeToolName(name) === "Edit"
      ? { patch: input }
      : input;

/** Keep case expectations stable across action-tool migrations. */
export const canonicalCall = (name: string, args: unknown) => {
  let tool = normalizeToolName(name);
  let input = normalizeToolInput(name, args);
  if (isRecord(input)) {
    const action = valueText(input.action);
    if (["preview_act", "t3_queue", "t3_pending_request"].includes(tool))
      tool = `${tool === "preview_act" ? "preview" : tool}_${action}`;
    else if (tool === "t3_thread_transfer") {
      tool =
        (
          {
            fork: "t3_thread_fork",
            merge_back: "t3_thread_merge_back",
            status: "t3_thread_transfers",
          } as Record<string, string>
        )[action] ?? tool;
      if (action === "merge_back") input = { ...input, sourceThreadId: input.threadId };
    } else if (tool === "t3_thread_configure" && input.modelSelection === undefined)
      tool = "t3_thread_configuration";
    else if (tool === "schedule_task" && input.scheduledTaskId !== undefined)
      tool = "update_scheduled_task";
  }
  return { tool, input };
};

// McpHttpServer advertises each tool's JSON schema, and Claude Code passes the MCP name,
// description, and schema through unchanged.
const allToolkits = [
  OrchestratorToolkit,
  ThreadToolkit,
  AttachmentToolkit,
  ProjectToolkit,
  EnvironmentToolkit,
  PreviewControlsToolkit,
  WorktreeToolkit,
  PullRequestsToolkit,
  PreviewToolkit,
  DeviceToolkit,
  HtmlToolkit,
  ComputerToolkit,
  ModelPreferencesToolkit,
];
let surface: "agent" | "all" = "agent";
const sourceTools = () =>
  (surface === "all" ? allToolkits : agentToolkits).flatMap((toolkit): ReadonlyArray<Tool.Any> =>
    Object.values(toolkit.tools),
  );
const makeT3Tools = (): ReadonlyArray<ApiTool> =>
  sourceTools().map((tool) => ({
    name: `${T3_PREFIX}${tool.name}`,
    description: Tool.getDescription(tool) ?? "",
    input_schema: advertisedJsonSchema(tool),
  }));
// T3 does not offer these to a delegated child, so its harness never lists them.
const hiddenFromSubagents = new Set<string>();
const visibleT3Tools = (subagent: boolean) => {
  const tools = makeT3Tools();
  return subagent ? tools.filter((tool) => !hiddenFromSubagents.has(tool.name)) : tools;
};

/** Text T3 appends to Claude Code's system prompt. Delegated children get the same text. */
export const t3SystemAppend = (model: Model) => {
  const { systemPrompt } = makeClaudeQueryOptions({
    modelSelection: { instanceId: ProviderInstanceId.make(CLAUDE_PROVIDER), model },
    nativeThreadId: "mcp-tool-use-eval",
    resume: false,
    cwd: null,
    mcpServers: { "t3-code": { type: "http", url: "http://127.0.0.1/mcp" } },
  });
  if (isRecord(systemPrompt) && systemPrompt.type === "preset" && systemPrompt.append) {
    const append = withInstructionsOverride(systemPrompt.append);
    requireInstructionsApplied([append]);
    return append;
  }
  throw new Error("makeClaudeQueryOptions no longer appends T3 text to a preset prompt.");
};

/**
 * Size of the context T3 adds: the system text every Claude thread gets, and the tool
 * descriptions and schemas (loaded on demand here, sent up front by harnesses without
 * deferred tools). Tokens are estimated at 4 characters each.
 */
const t3ContextReport = (model: Model) => {
  const size = (chars: number) => `${chars} chars (~${Math.round(chars / 4)} tokens)`;
  const t3Tools = makeT3Tools();
  const descriptions = t3Tools.reduce((sum, tool) => sum + valueText(tool.description).length, 0);
  const schemas = JSON.stringify(t3Tools).length;
  return [
    `- T3 context: system text ${size(
      (isCodex(model)
        ? Object.values(
            buildCodexAdditionalContext(
              { model, reasoningEffort: "xhigh" },
              { browser: true, device: true },
            ),
          )
            .map((entry) => entry.value)
            .join("")
        : t3SystemAppend(model)
      ).length,
    )}`,
    `tool descriptions ${size(descriptions)}`,
    `full tool schemas ${size(schemas)} across ${t3Tools.length} tools.`,
  ].join(", ");
};

const stringProperty = (description: string) => ({ type: "string", description });
const NATIVE_SCHEMAS: Readonly<Record<string, Omit<ApiTool, "name">>> = {
  WebFetch: {
    description: "Fetches content from a URL and answers the prompt about it.",
    input_schema: {
      type: "object",
      properties: {
        url: stringProperty("The URL to fetch"),
        prompt: stringProperty("What to extract"),
      },
      required: ["url", "prompt"],
    },
  },
  WebSearch: {
    description: "Searches the web and returns result titles, links, and snippets.",
    input_schema: {
      type: "object",
      properties: { query: stringProperty("The search query") },
      required: ["query"],
    },
  },
};

/** Rebuilds the parts of a captured request that every case shares. */
export const buildBase = (
  template: typeof MessagesRequest.Type,
  options: {
    readonly model: Model;
    readonly keepUserInstructions: boolean;
    readonly subagent?: boolean;
  },
) => {
  const t3 = visibleT3Tools(options.subagent === true);
  const firstAssistant = template.messages.findIndex((message) => message.role === "assistant");
  const head = template.messages.slice(0, firstAssistant === -1 ? undefined : firstAssistant);
  const systemTexts = [
    template.system ?? [],
    ...head.flatMap((m) => (m.role === "system" ? [m.content] : [])),
  ]
    .flatMap(texts)
    .filter((value) => !value.startsWith("x-anthropic-billing-header:"));
  const deferredList = DEFERRED_LIST.exec(systemTexts.join("\n"))?.[2];
  if (systemTexts.filter((value) => value.includes(RUNTIME_MARKER)).length !== 1 || !deferredList) {
    throw new Error(`The template needs one ${RUNTIME_MARKER} block and a deferred tool list.`);
  }
  const nativeDeferred = deferredList.split("\n").filter((name) => name && !isT3Name(name));
  const names = [...nativeDeferred, ...t3.map((tool) => tool.name)].toSorted().join("\n");
  const { model } = options;
  const append = t3SystemAppend(model);
  const modelLine = `You are powered by the model named ${model}. The exact model ID is ${model}.`;
  const joined = systemTexts.join("\n");
  // The capture's home directory names its user. Cases use `/home/user` paths instead.
  const cwd = /Primary working directory: (\S+)/.exec(joined)?.[1] ?? "/home/user/app";
  const home = /^\/(?:home|Users)\/[^/]+/.exec(cwd)?.[0];
  const anonymize = (value: string) =>
    home === undefined ? value : value.replaceAll(home, home.replace(/[^/]+$/, "user"));
  const system = systemTexts.map((value) => {
    // T3's append is the tail of its block: runtime info, PR linking, then orchestration.
    const at = value.indexOf(RUNTIME_MARKER);
    return anonymize(at === -1 ? value : value.slice(0, at) + append)
      .replace(DEFERRED_LIST, (_, header: string) => `${header}${names}\n`)
      .replace(MODEL_LINE, modelLine)
      .replace(IDENTITY, NEUTRAL_IDENTITY);
  });
  const [first] = template.messages;
  // The last block is the captured prompt.
  const reminders = (first?.role === "user" ? texts(first.content).slice(0, -1) : []).filter(
    (value) =>
      options.keepUserInstructions || !value.includes("Codebase and user instructions are"),
  );
  // gitStatus names a real repo state. Each case gets one built from its fake world instead.
  const gitStatusAt = reminders.findIndex((value) => value.includes("# gitStatus"));
  // Claude Code sends no schema for tools it only names. Web tools get their usual one, the
  // rest load open.
  const open = { type: "object", additionalProperties: true };
  const nativeSchema = (name: string) =>
    NATIVE_SCHEMAS[name] ?? { description: name, input_schema: open };
  return {
    model,
    system: system.map(text),
    reminders: reminders.filter((_, i) => i !== gitStatusAt).map((value) => text(anonymize(value))),
    gitStatusAt: gitStatusAt === -1 ? reminders.length : gitStatusAt,
    /** The shell simulator's cwd and OS follow the template's environment section. */
    environment: {
      cwd: anonymize(cwd),
      platform: /Platform: (\w+)/.exec(joined)?.[1] ?? "linux",
      date: /Today's date is ([\d-]+)/.exec(reminders.join("\n"))?.[1],
    },
    nativeTools: template.tools.filter((tool) => !isT3Name(tool.name)),
    /** Tools ToolSearch loads: T3 tools from source, and native tools the template only names. */
    t3,
    deferred: [...t3, ...nativeDeferred.map((name) => ({ name, ...nativeSchema(name) }))],
  };
};

type Base = ReturnType<typeof buildBase> & { readonly codex?: typeof ResponsesRequest.Type };

/** Keep the captured harness prompt and tools; replace app-owned context and the real user. */
export const buildCodexBase = (
  template: typeof ResponsesRequest.Type,
  options: {
    readonly model: Model;
    readonly keepUserInstructions: boolean;
    readonly effort?: string | undefined;
    readonly subagent?: boolean;
  },
): Base => {
  const t3 = visibleT3Tools(options.subagent === true);
  const contentText = (item: Block) =>
    Array.isArray(item.content)
      ? item.content.map((block: Block) => valueText(block.text)).join("\n")
      : valueText(item.content);
  const joined = template.input.map(contentText).join("\n");
  if (!joined.includes("<t3_code_runtime>"))
    throw new Error("Codex template needs full T3 context.");
  const cwd = /<cwd>(.*?)<\/cwd>/.exec(joined)?.[1] ?? "/home/user/app";
  const home = /^\/(?:home|Users)\/[^/]+/.exec(cwd)?.[0];
  const clean = (s: string) => (home ? s.replaceAll(home, home.replace(/[^/]+$/, "user")) : s);
  const effort = options.effort ?? template.reasoning.effort;
  const message = (value: string, role = "developer") => ({
    type: "message",
    role,
    content: [{ type: "input_text", text: value }],
  });
  // The captured <collaboration_mode> message stays: Codex supplies its own mode text natively.
  const input = template.input.flatMap((item) => {
    const content = contentText(item);
    if (content.includes("<t3_code_")) return [];
    if (item.role === "user") {
      const env = /<environment_context>[\s\S]*?<\/environment_context>/.exec(content)?.[0];
      return env ? [message(clean(options.keepUserInstructions ? content : env), "user")] : [];
    }
    // Only harness messages and tools. A captured turn's answers and tool calls would leak into
    // every case.
    if (item.type !== "message" && item.type !== "additional_tools") return [];
    if (item.role === "assistant") return [];
    return [JSON.parse(clean(JSON.stringify(item))) as Block];
  });
  const context = buildCodexAdditionalContext(
    { model: options.model, reasoningEffort: effort },
    { browser: true, device: true },
  );
  const contextPieces = Object.entries(context).map(
    ([key, entry]) => [key, withInstructionsOverride(entry.value)] as const,
  );
  requireInstructionsApplied(contextPieces.map(([, value]) => value));
  input.push(...contextPieces.map(([key, value]) => message(`<${key}>${value}</${key}>`)));
  const nativeTools = input
    .flatMap((item) =>
      item.type === "additional_tools" && Array.isArray(item.tools)
        ? item.tools.flatMap((ns: unknown) =>
            isRecord(ns) && Array.isArray(ns.tools) ? ns.tools : [],
          )
        : [],
    )
    .filter((tool): tool is ApiTool => isRecord(tool) && typeof tool.name === "string");
  if (!nativeTools.some((tool) => tool.name === "exec"))
    throw new Error("Codex template needs code-mode exec.");
  return {
    model: options.model,
    system: [],
    reminders: [],
    gitStatusAt: 0,
    environment: {
      cwd: clean(cwd),
      platform: cwd.startsWith("/Users/") ? "darwin" : "linux",
      date: /<current_date>(.*?)<\/current_date>/.exec(joined)?.[1],
    },
    nativeTools,
    t3,
    deferred: [...t3],
    codex: { ...template, input, reasoning: { ...template.reasoning, effort } },
  };
};

/** Replay prior calls in Codex's wire format, including Claude-shaped file operations. */
const codexCall = (name: string, input: unknown) => {
  const args = isRecord(input) ? input : {};
  if (name === "Bash")
    return `text(await tools.exec_command(${JSON.stringify({ ...args, cmd: args.command })}));`;
  if (["Read", "Write", "Edit"].includes(name)) {
    const file = valueText(args.file_path);
    const command =
      name === "Read"
        ? `cat ${JSON.stringify(file)}`
        : name === "Write"
          ? `cat > ${JSON.stringify(file)} <<'EVAL_EOF'\n${valueText(args.content)}\nEVAL_EOF`
          : `python3 -c ${JSON.stringify(`from pathlib import Path; p=Path(${JSON.stringify(file)}); p.write_text(p.read_text().replace(${JSON.stringify(args.old_string)}, ${JSON.stringify(args.new_string)}))`)}`;
    return `text(await tools.exec_command(${JSON.stringify({ cmd: command })}));`;
  }
  return `text(await tools.${name.replace("mcp__t3-code__", "mcp__t3_code__")}(${JSON.stringify(input)}));`;
};
const codexMessages = (messages: ReadonlyArray<ApiMessage>): Array<Block> =>
  messages.flatMap((message) =>
    message.content.map((block): Block =>
      block.type === "tool_use"
        ? {
            type: "custom_tool_call",
            call_id: block.id,
            name: "exec",
            input: codexCall(valueText(block.name), block.input),
          }
        : block.type === "tool_result"
          ? {
              type: "custom_tool_call_output",
              call_id: block.tool_use_id,
              output: valueText(block.content),
            }
          : {
              type: "message",
              role: message.role,
              content: [
                {
                  type: message.role === "user" ? "input_text" : "output_text",
                  text: valueText(block.text),
                },
              ],
            },
    ),
  );
/** One tool call the shell simulator has answered, or one from the case's prior turns. */
type ShellEntry = { readonly tool: string; readonly input: unknown; readonly output: string };
/** PRs T3 links by itself because a shell command created them, as `gh pr create` does. */
const createdPullRequests = (_entry: ShellEntry): Array<string> => [];
/**
 * One sample's state. ToolSearch adds loaded schemas to `tools`, like Claude Code. `shell` is the
 * history the simulator keeps consistent with; `linked` and `nextTask` do the same for T3 results.
 */
type Sample = {
  readonly testCase: McpToolUseCase;
  readonly base: Base;
  readonly tools: Array<ApiTool>;
  readonly repo: string;
  readonly shell: Array<ShellEntry>;
  readonly shellUsage: Usage;
  readonly linked: Set<string>;
  readonly codeStore: Record<string, unknown>;
  answeredRequests: Set<string>;
  nextTask: number;
};

const SHELL_TOOLS = new Set(["Bash", "Read", "Edit", "Write", "WebFetch"]);

export const makeSample = (testCase: McpToolUseCase, base: Base): Sample => {
  const prior = testCase.setup.priorTurns ?? [];
  const priorCalls = prior.flatMap((turn) => turn.toolCalls ?? []);
  const repo = testCase.setup.world?.repo ?? "acme/app";
  const urls = priorCalls.flatMap((call) =>
    ["link_pull_request", "watch_pull_request"].includes(call.tool) && isRecord(call.input)
      ? [pullRequest(repo, call.input).url]
      : [],
  );
  const taskNumbers = [...valueText(prior).matchAll(/task-(\d+)/g)].map((match) =>
    Number(match[1]),
  );
  const shell = priorCalls
    .filter((call) => SHELL_TOOLS.has(call.tool))
    .map(({ tool, input, result }) => ({ tool, input, output: valueText(result) }));
  return {
    testCase,
    base,
    tools: [...base.nativeTools],
    repo: testCase.setup.world?.repo ?? "acme/app",
    shell,
    shellUsage: emptyUsage(),
    linked: new Set([...urls, ...shell.flatMap(createdPullRequests)]),
    codeStore: {},
    answeredRequests: new Set<string>(),
    nextTask: Math.max(0, ...taskNumbers) + 1,
  };
};

// Main's history under every case's world.
const MAIN_COMMITS = [
  { sha: "9f2c1ab", subject: "feat(web): show the model name in the thread header" },
  { sha: "4e7d2c0", subject: "fix(server): retry provider start once on ENOENT" },
  { sha: "b81f3d9", subject: "chore: update dependencies" },
];

/**
 * The gitStatus Claude Code shows when a session starts, built from the case's world. Commits and
 * a branch that the prior turns made (their tool results show it) came later, so they are left out.
 */
const gitStatus = ({ setup }: McpToolUseCase) => {
  const prior = valueText(setup.priorTurns ?? []);
  const branch = setup.world?.branch ?? "main";
  const commits = [...(setup.world?.commits ?? []), ...MAIN_COMMITS].filter(
    (commit) => !prior.includes(` ${commit.sha}] `),
  );
  return [
    "As you answer the user's questions, you can use the following context:",
    "# gitStatus",
    "This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.",
    "",
    `Current branch: ${prior.includes(`Switched to a new branch '${branch}'`) ? "main" : branch}`,
    "",
    "Main branch (you will usually use this for PRs): main",
    "",
    "Status:",
    setup.world?.status || "(clean)",
    "",
    "Recent commits:",
    ...commits.slice(0, 5).map((commit) => `${commit.sha} ${commit.subject}`),
    "",
    "Claude Code attached this context automatically; it isn't part of the user's message. It describes the user's own account and workspace, so they don't need it reported back.",
  ].join("\n");
};

const findTool = (base: Base, bare: string) =>
  [...base.nativeTools, ...base.deferred].find((tool) => normalizeToolName(tool.name) === bare) ??
  (base.codex ? { name: bare } : undefined);

/** Adds deferred schemas to `tools` and returns the ToolSearch result Claude Code sends. */
const loadTools = (tools: Array<ApiTool>, id: string, found: ReadonlyArray<ApiTool>): Block => {
  for (const tool of found) {
    if (!hasTool(tools, tool.name)) tools.push({ ...tool, defer_loading: true });
  }
  const content = found.map((tool) => ({ type: "tool_reference", tool_name: tool.name }));
  return { type: "tool_result", tool_use_id: id, content };
};

/** Messages for a case: reminders, context, prior turns with real tool blocks, then the prompt. */
export const buildMessages = (sample: Sample) => {
  const { testCase, base, tools } = sample;
  const messages: Array<ApiMessage> = [];
  const push = (role: ApiMessage["role"], ...blocks: ReadonlyArray<Block>) => {
    const last = messages.at(-1);
    if (last?.role !== role) messages.push({ role, content: blocks });
    else messages[messages.length - 1] = { role, content: [...last.content, ...blocks] };
  };
  const { role, context, priorTurns = [] } = testCase.setup;
  const notes = [
    role === "native-subagent"
      ? "You are a subagent started by the parent agent's Agent tool. Your final message goes to the parent agent, not to the user."
      : undefined,
    context,
  ];
  const reminders = base.reminders.toSpliced(base.gitStatusAt, 0, reminder(gitStatus(testCase)));
  push("user", ...reminders, ...notes.flatMap((note) => (note ? [reminder(note)] : [])));
  const toolSearch = findTool(base, "ToolSearch")?.name ?? "ToolSearch";
  let nextId = 0;
  for (const turn of priorTurns) {
    const calls = (turn.toolCalls ?? []).map((call) => {
      const tool = findTool(base, call.tool);
      if (tool === undefined) throw new Error(`${testCase.id}: unknown prior tool ${call.tool}.`);
      return { ...call, id: `toolu_prior_${nextId++}`, name: tool.name, tool };
    });
    // Prior T3 calls load their schemas first, as in a real deferred session.
    const unloaded = [...new Set(calls.map((call) => call.tool))].filter(
      (tool) => !hasTool(tools, tool.name),
    );
    if (unloaded.length > 0 && !base.codex) {
      const id = `toolu_prior_${nextId++}`;
      const query = `select:${unloaded.map((tool) => tool.name).join(",")}`;
      const input = { query, max_results: unloaded.length };
      push("assistant", { type: "tool_use", id, name: toolSearch, input });
      push("user", loadTools(tools, id, unloaded), text(TOOL_LOADED));
    }
    // One call per step, as most real turns run them.
    for (const { id, name, input, result, tool } of calls) {
      push("assistant", { type: "tool_use", id, name, input });
      const replayed =
        normalizeToolName(tool.name) === "orchestrator_capabilities"
          ? capabilities(sample, result)
          : result;
      push("user", toolResult(id, replayed));
    }
    if (turn.text) push(turn.role, text(turn.text));
  }
  const { prompt } = testCase;
  // A subagent receives its brief as written (the role is data on the task, not text).
  const childPrompt = () => prompt;
  push("user", text(role === "delegated-child" ? childPrompt() : prompt));
  return messages;
};

// Results for T3 tools a case does not mock. The model ids are public in this repo's catalog.
const claudeModel = (id: string) => ({ id, options: [{ id: "effort", values: EFFORTS }] });
const codexModel = (id: string) => ({ id, options: [{ id: "reasoningEffort", values: EFFORTS }] });
// Mirrors the real catalog's main models, so a case's named model is not missing by accident.
const PROVIDERS = [
  {
    providerInstanceId: "claudeAgent",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5"].map(
      claudeModel,
    ),
  },
  {
    providerInstanceId: "codex",
    models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].map(codexModel),
  },
  { providerInstanceId: "muse", models: ["muse-wonder-full", "muse-wonder"].map(codexModel) },
  { providerInstanceId: "grok", models: ["grok-4.7"].map(codexModel) },
];
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DEFAULT_THREAD = {
  title: "Fix the flaky reconnect test",
  status: "idle",
  items: [
    {
      position: 1,
      createdBy: "user",
      text: "The reconnect test in src/session.test.ts fails about 1 in 10 runs. Fix it.",
    },
    {
      position: 2,
      createdBy: "assistant",
      text: "Fixed. The test now waits for the socket close event before it reconnects. 20 runs in a row pass.",
    },
  ],
};
const HTML_RENDERED =
  "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.";

/** Pull request identity from a `url` or `repository` plus `number` input, like T3's results. */
const pullRequest = (repo: string, input: Readonly<Record<string, unknown>>) => {
  const url = typeof input.url === "string" ? input.url : "";
  const repository =
    /github\.com\/([^/]+\/[^/]+)\/pull/.exec(url)?.[1] ?? valueText(input.repository ?? repo);
  const number = Number(/(\d+)\/?$/.exec(url)?.[1] ?? input.number);
  return {
    host: "github.com",
    repository,
    number,
    url: url || `https://github.com/${repository}/pull/${number}`,
  };
};

/** A believable T3 result for a tool the case does not mock. */
const t3Default = (sample: Sample, name: string, input: Readonly<Record<string, unknown>>) => {
  const pr = () => pullRequest(sample.repo, input);
  switch (name) {
    case "orchestrator_capabilities":
      return {
        inheritedProviderInstanceId: "claudeAgent",
        inheritedModel: sample.base.model,
        providers: PROVIDERS,
      };
    case "delegate_task": {
      const n = sample.nextTask++;
      const target = isRecord(input.target) ? input.target : {};
      return {
        taskId: `task-${n}`,
        childThreadId: uuid(n),
        childRunId: `run-${n}`,
        status: "running",
        workState: "working",
        hasPendingChildRuns: false,
        providerInstanceId:
          target.providerInstanceId ?? (sample.base.codex ? "codex" : "claudeAgent"),
        model: target.model ?? sample.base.model,
        summary: null,
        hasPendingQuestion: false,
        pendingApproval: null,
      };
    }
    case "task_status":
      return {
        taskId: input.taskId,
        status: "running",
        workState: "working",
        hasPendingChildRuns: false,
        summary: null,
      };
    case "task_cancel":
      return { taskId: input.taskId, status: "cancel_requested" };
    case "link_pull_request": {
      const alreadyLinked = sample.linked.has(pr().url);
      sample.linked.add(pr().url);
      return { ...pr(), alreadyLinked };
    }
    case "request_secret": {
      // T3 names both a ref and a file with 32 hex characters, and keeps files in its secrets dir.
      const id = "5f0c9e2a7b4d4183a6e1c8d2b9f07a64";
      const home =
        /^\/(?:home|Users)\/[^/]+/.exec(sample.base.environment.cwd)?.[0] ?? "/home/user";
      return input.delivery === "file"
        ? { status: "saved", file: `${home}/.t3/userdata/secrets/files/${id}` }
        : { status: "saved", secretRef: `secret-ref:${id}` };
    }
    case "unlink_pull_request":
      return { ...pr(), wasLinked: sample.linked.delete(pr().url) };
    case "watch_pull_request":
      sample.linked.add(pr().url);
      return { ...pr(), watching: true, wasWatching: false };
    case "unwatch_pull_request":
      return { ...pr(), watching: false, wasWatching: true };
    case "list_thread_pull_requests":
      return {
        pullRequests: [...sample.linked].map((url) => ({
          ...pullRequest(sample.repo, { url }),
          source: "agent",
          watching: false,
          state: "open",
        })),
        chains: [],
      };
    case "t3_thread_read": {
      const threadId = valueText(input.threadId);
      const { title, status, items } = DEFAULT_THREAD;
      return { thread: { threadId, title, status }, items, nextPosition: 3, hasMore: false };
    }
    case "html_preview":
      return { width: 728, contentHeight: 560, capturedHeight: 560, consoleMessages: [] };
    case "html_render":
      return {
        htmlRender: { attachmentId: "att-1", title: input.title ?? "Visual", height: 560 },
        message: HTML_RENDERED,
      };
    case "monitor_start":
      // Mirrors MonitorService: a durable job cannot also be restartable or use silenceMs.
      if (input.durable === true && (input.restartable === true || input.silenceMs !== undefined))
        return {
          error: {
            code: "invalid_request",
            message:
              "Use a valid wakeOn regex or false; durable jobs cannot use restartable or silenceMs.",
          },
        };
      return { monitorId: "monitor-1" };
    case "preview_status":
      return {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      };
    default:
      return { ok: true };
  }
};

/** Cases mock a Claude caller, so the inherited fields follow the model under test. */
const capabilities = ({ base }: Sample, value: unknown) =>
  isRecord(value)
    ? {
        ...value,
        inheritedModel: base.model,
        ...(base.codex
          ? {
              inheritedProviderInstanceId: "codex",
              inheritedOptions: [{ id: "reasoningEffort", value: base.codex.reasoning.effort }],
            }
          : {}),
      }
    : value;

/** ToolSearch: `select:a,b` loads those tools. Other queries load tools whose name has a word. */
const searchTools = (base: Base, query: string, max: number) => {
  if (query.startsWith("select:")) {
    const wanted = query.slice("select:".length).split(",");
    return base.deferred.filter((tool) =>
      wanted.some((name) => [tool.name, normalizeToolName(tool.name)].includes(name.trim())),
    );
  }
  const words = query
    .toLowerCase()
    .split(/[\s+]+/)
    .filter(Boolean);
  const hits = (tool: ApiTool) => words.filter((word) => tool.name.toLowerCase().includes(word));
  const found = base.deferred.filter((tool) => hits(tool).length > 0);
  return found.toSorted((a, b) => hits(b).length - hits(a).length).slice(0, max);
};

const SUBAGENT_WATCH_ERROR =
  "This thread is a subagent, so it cannot watch pull requests. Its parent thread owns the pull request: finish your task and report back instead.";

/** Result for a native tool the case does not mock, other than shell, file, and web tools. */
const nativeResult = (name: string, input: Readonly<Record<string, unknown>>) => {
  const skill = valueText(input.skill);
  const results: Readonly<Record<string, string>> = {
    Agent: "The agent finished. Summary: the task is done and nothing else needs attention.",
    Skill: `Launching skill: ${skill}\n\nBase directory for this skill: ~/.claude/skills/${skill}\n\nThis skill adds no steps for this task. Do it with your usual tools.`,
    WebSearch: "No results found.",
  };
  return results[name] ?? "OK";
};

const SHELL_PROMPT = `You play the computer a coding agent works on. You get a description of the machine, the agent's tool calls so far with their outputs, and one new call. Reply in JSON. In "facts", note briefly what the output must agree with. In "output", put only the call's output, exactly as the tool prints it: no notes, headings, code fences, or corrections. The agent sees "output" unchanged.

- Bash: what the command prints in a real terminal (git, gh, ls, cat, grep, package managers). If it fails, start with "Exit code N", then the error. If it prints nothing, reply "(Bash completed with no output)".
- Read: the file with numbered lines, like \`cat -n\`. Write: "File created successfully at: <path>". Edit: "The file <path> has been updated successfully." Edit may instead supply a Codex apply_patch patch; apply its additions, deletions and hunks. A missing file, or an Edit whose old_string is not in the file: "<tool_use_error>reason</tool_use_error>".
- WebFetch: the page's text.

Stay consistent with the machine and with earlier outputs: edits, commits, pushes, and new PRs show in later output. Where the description is silent, invent plausible small details that fit it (file contents, SHAs, test names) rather than printing nothing. Commands succeed unless the description says otherwise, including git push, gh pr create, installs, builds, and tests. A new PR gets the next number after the highest one in the description or the history, or 124 if there is none.`;

const ShellReply = Schema.Struct({ facts: Schema.String, output: Schema.String });
const SHELL_REPLY_SCHEMA = {
  ...Schema.toJsonSchemaDocument(ShellReply).schema,
  additionalProperties: false,
};
const decodeShellReply = Schema.decodeUnknownOption(Schema.fromJsonString(ShellReply));

const callText = ({ tool, input }: Omit<ShellEntry, "output">) =>
  `<call>${tool} ${valueText(input)}</call>`;

/** The simulator's request: the machine, this sample's earlier calls, then the new call. */
export const shellRequest = (sample: Sample, call: Omit<ShellEntry, "output">, model: string) => {
  const { testCase, base, repo, shell } = sample;
  const { world, context, shellMocks = [] } = testCase.setup;
  const { cwd, platform, date } = base.environment;
  const machine = [
    `Working directory: ${cwd} on ${platform}, a git checkout of github.com/${repo}.${date ? ` Today is ${date}.` : ""}`,
    gitStatus(testCase),
    `World: ${valueText(world ?? {})}`,
    ...(shellMocks.length > 0
      ? [`Commands that match these regexes print exactly this output: ${valueText(shellMocks)}`]
      : []),
    ...(context ? [`The agent was told: ${context}`] : []),
    `The agent's task: ${testCase.prompt}`,
  ];
  const history = shell.map((entry) => `${callText(entry)}\n<output>\n${entry.output}\n</output>`);
  return {
    model,
    max_tokens: 8_000,
    // The "facts" field keeps the simulator's reasoning out of the output the agent sees.
    output_config: { effort: "low", format: { type: "json_schema", schema: SHELL_REPLY_SCHEMA } },
    system: SHELL_PROMPT,
    messages: [
      {
        role: "user",
        content: [machine, [...history, `New call:\n${callText(call)}`]].map((part) =>
          text(part.join("\n\n")),
        ),
      },
    ],
  };
};

/** The tool output in the simulator's JSON reply, or its raw text if that is not JSON. */
export const shellOutput = (content: ReadonlyArray<Block>) => {
  const reply = content.flatMap((block) => (isText(block) ? [block.text] : [])).join("");
  return Option.match(decodeShellReply(reply), {
    onNone: () => reply.trim(),
    onSome: ({ output }) => output.trim(),
  });
};

/** A shell mock's output, when the command is one simple command that the mock matches. */
export const mockOutput = (sample: Sample, command: string) =>
  /&&|\|\||[;|\n]/.test(command.trim())
    ? undefined
    : sample.testCase.setup.shellMocks?.find((mock) => new RegExp(mock.match).test(command))
        ?.output;

type Config = {
  readonly apiKey: string;
  readonly model: Model;
  readonly proxy?: { readonly url: string; readonly headers: Readonly<Record<string, string>> };
  readonly effort: string;
  readonly maxSteps: number;
  readonly shellModel: string;
  readonly sessionId: string;
};

/** Output for a shell, file, or web tool: a matching shell mock, else the shell simulator. */
const simulate = Effect.fn("evaluateMcpToolUse.simulate")(function* (
  sample: Sample,
  config: Config,
  call: Omit<ShellEntry, "output">,
) {
  const command = call.tool === "Bash" && isRecord(call.input) ? call.input.command : undefined;
  let output = typeof command === "string" ? mockOutput(sample, command) : undefined;
  if (output === undefined) {
    const body = shellRequest(sample, call, config.shellModel);
    const response = yield* callModel(config.apiKey, body, config.proxy);
    addUsage(sample.shellUsage, response.usage);
    output = shellOutput(response.content);
  }
  if (call.tool === "Bash" && output === "") output = "(Bash completed with no output)";
  const entry = { ...call, output };
  sample.shell.push(entry);
  for (const url of createdPullRequests(entry)) sample.linked.add(url);
  return output;
});

/** The result for one tool call. */
export const answerToolCall = Effect.fn("evaluateMcpToolUse.answerToolCall")(function* (
  sample: Sample,
  config: Config,
  call: typeof ToolUse.Type,
) {
  const { testCase, base, tools } = sample;
  const canonical = canonicalCall(call.name, call.input);
  let name = canonical.tool;
  let input = isRecord(canonical.input) ? canonical.input : {};
  if (call.name === "web__run") {
    const open = Array.isArray(input.open) ? input.open[0] : undefined;
    const search = Array.isArray(input.search_query) ? input.search_query[0] : undefined;
    name = open ? "WebFetch" : "WebSearch";
    input = isRecord(open)
      ? { url: open.ref_id, prompt: "Return the page content." }
      : isRecord(search)
        ? { query: search.q }
        : input;
  }
  const failed = (error: string): Block => ({ ...toolResult(call.id, error), is_error: true });
  if (!base.codex && !hasTool(tools, call.name)) {
    const error = `InputValidationError: ${call.name} is deferred. Load it with ToolSearch first.`;
    return failed(`<tool_use_error>${error}</tool_use_error>`);
  }
  if (name === "ToolSearch") {
    const max = typeof input.max_results === "number" ? input.max_results : 5;
    const found = searchTools(base, valueText(input.query), max);
    if (found.length === 0) return toolResult(call.id, "No matching deferred tools found");
    return loadTools(tools, call.id, found);
  }
  if (name === "t3_pending_request_respond") {
    sample.answeredRequests.add(valueText(input.requestId));
    return toolResult(call.id, { sequence: 1 });
  }
  if (name === "t3_pending_request_list" && sample.answeredRequests.size > 0)
    return toolResult(call.id, { requestIds: [] });
  const mock = testCase.setup.mocks?.[name];
  if (mock !== undefined && mock !== "default")
    return toolResult(
      call.id,
      name === "orchestrator_capabilities" ? capabilities(sample, mock) : mock,
    );
  if (isT3Name(call.name)) {
    // T3 refuses a watch from a delegated child.
    if (name === "watch_pull_request" && testCase.setup.role === "delegated-child") {
      return failed(SUBAGENT_WATCH_ERROR);
    }
    const value = t3Default(sample, name, input);
    return toolResult(
      call.id,
      name === "orchestrator_capabilities" ? capabilities(sample, value) : value,
    );
  }
  if (call.name === "clock__curr_time")
    return toolResult(call.id, {
      current_time: `${base.environment.date ?? "2026-01-01"} 12:00:00 UTC`,
    });
  if (!SHELL_TOOLS.has(name)) return toolResult(call.id, nativeResult(name, input));
  const output = yield* simulate(sample, config, { tool: name, input });
  // Claude Code marks a failed command or file call as an error.
  return /^(Exit code [1-9]|<tool_use_error>)/.test(output)
    ? failed(output)
    : toolResult(call.id, output);
});

const BOUND = /^([<>]=)(-?\d+(?:\.\d+)?)$/;
/** Partial match: `~text` is a case-insensitive substring, `<=N` / `>=N` bound a number. */
const matches = (expected: unknown, actual: unknown): boolean => {
  const bound = typeof expected === "string" ? BOUND.exec(expected) : null;
  if (bound !== null) {
    const limit = Number(bound[2]);
    return typeof actual === "number" && (bound[1] === "<=" ? actual <= limit : actual >= limit);
  }
  if (typeof expected === "string" && expected.startsWith("~")) {
    return valueText(actual).toLowerCase().includes(expected.slice(1).toLowerCase());
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) && expected.every((item) => actual.some((at) => matches(item, at)))
    );
  }
  if (!isRecord(expected)) return expected === actual;
  const at = (path: string) =>
    path
      .split(".")
      .reduce<unknown>(
        (value, key) =>
          Array.isArray(value) && /^\d+$/.test(key)
            ? value[Number(key)]
            : isRecord(value)
              ? value[key]
              : undefined,
        actual,
      );
  return Object.entries(expected).every(([path, value]) => matches(value, at(path)));
};

/** delegate_task takes `target.options` as an object or `[{id, value}]`. Grade both as an object. */
const withOptionsObject = (input: unknown) => {
  if (!isRecord(input) || !isRecord(input.target) || !Array.isArray(input.target.options)) {
    return input;
  }
  const options = Object.fromEntries(
    input.target.options.flatMap((option) =>
      isRecord(option) ? [[valueText(option.id), option.value]] : [],
    ),
  );
  return { ...input, target: { ...input.target, options } };
};

export const gradeSample = (expect: McpToolUseCase["expect"], run: SampleRun) => {
  const checks: Array<{ readonly check: string; readonly pass: boolean }> = [];
  const add = (check: string, pass: boolean) => checks.push({ check, pass });
  if (run.stopReason === "cli_error") add("CLI completed", false);
  const calls = run.calls.map((call) => ({ ...call, input: withOptionsObject(call.input) }));
  const count = (tool: string) => calls.filter((call) => call.tool === tool).length;
  // `tool` may list alternatives, as in "link_pull_request|watch_pull_request".
  const found = ({ tool, args = {} }: McpToolUseCall) =>
    calls.some((call) => tool.split("|").includes(call.tool) && matches(args, call.input));
  const label = ({ tool, args }: McpToolUseCall) => (args ? `${tool} ${valueText(args)}` : tool);
  for (const call of expect.calls ?? []) add(`calls ${label(call)}`, found(call));
  for (const group of expect.callsOneOf ?? [])
    add(`callsOneOf ${group.map(label).join(" | ")}`, group.some(found));
  for (const call of expect.callsMustNot ?? []) add(`callsMustNot ${label(call)}`, !found(call));
  for (const tool of expect.notCalls ?? []) add(`notCalls ${tool}`, count(tool) === 0);
  if (expect.order !== undefined) {
    const firsts = expect.order.map((tool) => calls.findIndex((call) => call.tool === tool));
    const inOrder = firsts.every((at, i) => at > (firsts[i - 1] ?? -1));
    add(`order ${expect.order.join(" > ")}`, inOrder);
  }
  for (const [t, n] of Object.entries(expect.minCalls ?? {}))
    add(`minCalls ${t} >= ${n}`, count(t) >= n);
  for (const [t, n] of Object.entries(expect.maxCalls ?? {}))
    add(`maxCalls ${t} <= ${n}`, count(t) <= n);
  if (expect.endsTurnAfter !== undefined) {
    const lastStep = Math.max(-1, ...calls.map((call) => call.step));
    const last = calls.filter((call) => call.step === lastStep).map((call) => call.tool);
    const ended = run.stopReason === "end_turn" && last.includes(expect.endsTurnAfter);
    add(`endsTurnAfter ${expect.endsTurnAfter}`, ended);
  }
  // Bash and Monitor both take a shell `command`.
  const shell = calls.flatMap((call) =>
    isRecord(call.input) && typeof call.input.command === "string" ? [call.input.command] : [],
  );
  const test = (pattern: string, value: string) => new RegExp(pattern).test(value);
  for (const p of expect.shellMustNot ?? [])
    add(`shellMustNot /${p}/`, !shell.some((c) => test(p, c)));
  for (const p of expect.textMust ?? []) add(`textMust /${p}/`, test(p, run.text));
  for (const p of expect.textMustNot ?? []) add(`textMustNot /${p}/`, !test(p, run.text));
  const isLinked = (url: string) => (run.linked ?? []).some((at) => matches(url, at));
  for (const url of expect.linked ?? []) add(`linked ${url}`, isLinked(url));
  return checks;
};

// Checks that can only go from pass to fail as a sample goes on.
const SETTLED = /^(notCalls|callsMustNot|shellMustNot|maxCalls|textMustNot) /;
/** True once the sample has failed for good, so the rest of it cannot change the result. */
export const failedEarly = (expect: McpToolUseCase["expect"], run: SampleRun) =>
  gradeSample(expect, run).some((check) => !check.pass && SETTLED.test(check.check));

const requestBody = ({ base, tools }: Sample, effort: string, messages: unknown) => ({
  model: base.model,
  max_tokens: 16_000,
  thinking: { type: "adaptive", display: "summarized" },
  output_config: { effort },
  cache_control: { type: "ephemeral" },
  // Like Claude Code, cache the shared system prompt so every sample reuses it.
  system: base.system.map((block, i) =>
    i === base.system.length - 1 ? { ...block, cache_control: { type: "ephemeral" } } : block,
  ),
  tools,
  messages,
});

const codexRequest = (base: Base, input: ReadonlyArray<Block>) => ({
  model: base.model,
  stream: true,
  store: false,
  parallel_tool_calls: true,
  reasoning: base.codex?.reasoning,
  instructions: base.codex?.instructions,
  text: base.codex?.text,
  tool_choice: base.codex?.tool_choice,
  include: ["reasoning.encrypted_content"],
  mcpTools: base.t3,
  input: [...(base.codex?.input ?? []), ...input],
});

/** The bridge only accepts serialized data. Model code never receives host objects/functions. */
export const executeCodex = async (
  code: string,
  catalog: ReadonlyArray<{ name: string; description: string }>,
  answer: (name: string, input: unknown) => Promise<unknown>,
  saved: Record<string, unknown> = {},
) => {
  const pending: Array<{ name: string; input: string; resolve: (value: string) => void }> = [];
  const bridge = Object.setPrototypeOf(
    (name: string, input: string, resolve: (value: string) => void) =>
      pending.push({ name, input, resolve }),
    null,
  );
  const context = NodeVM.createContext(
    { __bridge: bridge, __catalog: JSON.stringify(catalog), __storeJson: JSON.stringify(saved) },
    { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" },
  );
  const run = (source: string) => NodeVM.runInContext(source, context, { timeout: 250 });
  run(`((bridge, catalog) => {
    delete globalThis.__bridge; delete globalThis.__catalog;
    globalThis.ALL_TOOLS = catalog;
    globalThis.tools = Object.fromEntries(catalog.map(({name}) => [name, (input) => new Promise(resolve => bridge(name, JSON.stringify(input ?? {}), value => resolve(JSON.parse(value))))]));
    globalThis.__output = []; globalThis.__done = false;
    globalThis.text = globalThis.notify = value => __output.push(typeof value === 'string' ? value : JSON.stringify(value));
    globalThis.__stored = JSON.parse(__storeJson); delete globalThis.__storeJson;
    globalThis.store = (k,v) => __stored[k] = v; globalThis.load = k => __stored[k];
  })(__bridge, JSON.parse(__catalog));
  (async () => { ${code}\n })().then(() => { __done = true; }, e => { text(String(e)); __done = true; });`);
  // Unawaited calls still run, as they do in Codex, so they are answered and graded too.
  for (let count = 0; !context.__done || pending.length > 0; count++) {
    if (count === 128) throw new Error("Code cell exceeded 128 tool calls.");
    const job = pending.shift();
    if (!job) throw new Error("Code cell stalled without a tool call.");
    const result = await answer(job.name, JSON.parse(job.input));
    context.__resolve = job.resolve;
    context.__result = JSON.stringify(result ?? null);
    run("__resolve(__result); delete globalThis.__resolve; delete globalThis.__result;");
  }
  Object.assign(saved, JSON.parse(run("JSON.stringify(__stored)")));
  return valueText(context.__output.join("\n"));
};

const codexCatalog = (base: Base) => [
  ...base.t3.map((tool) => ({
    name: tool.name.replace("mcp__t3-code__", "mcp__t3_code__"),
    description: `${valueText(tool.description)}\nInput JSON schema: ${JSON.stringify(tool.input_schema)}`,
  })),
  ...[
    ...valueText(base.nativeTools.find((tool) => tool.name === "exec")?.description).matchAll(
      /### `([^`]+)`/g,
    ),
  ].map((match) => ({ name: match[1]!, description: match[1]! })),
];

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const decodeJsonEffect = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** The capture stays intact; this adapter translates its wire format for chat-completions APIs. */
export const compatibleRequest = (body: Record<string, unknown>) => {
  const input = Array.isArray(body.input) ? (body.input as Array<Block>) : [];
  const tools: Array<unknown> = [];
  const messages: Array<Record<string, unknown>> = [];
  if (body.instructions) messages.push({ role: "system", content: body.instructions });
  for (const item of input) {
    if (item.type === "additional_tools" && Array.isArray(item.tools)) {
      for (const ns of item.tools) {
        if (!isRecord(ns) || !Array.isArray(ns.tools)) continue;
        for (const tool of ns.tools) {
          if (!isRecord(tool)) continue;
          tools.push({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters:
                tool.type === "custom"
                  ? { type: "object", properties: { code: { type: "string" } }, required: ["code"] }
                  : tool.parameters,
            },
          });
        }
      }
    } else if (item.type === "message") {
      const content = Array.isArray(item.content)
        ? item.content.map((part: Block) => valueText(part.text)).join("\n")
        : valueText(item.content);
      messages.push({ role: item.role === "developer" ? "system" : item.role, content });
    } else if (item.type === "function_call" || item.type === "custom_tool_call") {
      const args =
        item.type === "custom_tool_call" ? JSON.stringify({ code: item.input }) : item.arguments;
      const last = messages.at(-1);
      const call = {
        id: item.call_id,
        type: "function",
        function: { name: item.name, arguments: args },
      };
      if (last?.role === "assistant" && Array.isArray(last.tool_calls)) last.tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] });
    } else if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      messages.push({ role: "tool", tool_call_id: item.call_id, content: valueText(item.output) });
    }
  }
  if (Array.isArray(body.mcpTools))
    for (const tool of body.mcpTools as ReadonlyArray<ApiTool>) {
      tools.push({
        type: "function",
        function: {
          name: tool.name.replace(T3_PREFIX, "mcp__t3_code__"),
          description: tool.description,
          parameters: tool.input_schema,
        },
      });
    }
  return {
    model: body.model,
    messages,
    tools,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 4096,
    reasoning_effort: (body.reasoning as { effort?: string } | undefined)?.effort ?? "low",
  };
};

type CompletionToolCall = { id: string; function: { name: string; arguments: string } };
type CompletionReply = {
  choices: Array<{ message: { content?: string | null; tool_calls?: Array<CompletionToolCall> } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
};

/** Reassemble OpenAI-compatible SSE deltas without exposing reasoning as visible text. */
export const parseCompletion = (raw: string): CompletionReply => {
  if (!raw.trimStart().startsWith("data:")) return JSON.parse(raw) as CompletionReply;
  const tools = new Map<number, CompletionToolCall>();
  let content = "";
  let usage: CompletionReply["usage"];
  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    const chunk = JSON.parse(data) as {
      error?: unknown;
      choices?: Array<{
        delta?: {
          content?: string;
          tool_calls?: Array<{
            index: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      usage?: CompletionReply["usage"];
    };
    if (chunk.error) throw new Error(`Model API stream error: ${valueText(chunk.error)}`);
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      content += choice.delta?.content ?? "";
      for (const part of choice.delta?.tool_calls ?? []) {
        const tool = tools.get(part.index) ?? { id: "", function: { name: "", arguments: "" } };
        tool.id ||= part.id ?? "";
        tool.function.name += part.function?.name ?? "";
        tool.function.arguments += part.function?.arguments ?? "";
        tools.set(part.index, tool);
      }
    }
  }
  return {
    choices: [
      {
        message: {
          content,
          tool_calls: [...tools].toSorted(([a], [b]) => a - b).map(([, call]) => call),
        },
      },
    ],
    ...(usage ? { usage } : {}),
  };
};

const callCodex = Effect.fn("evaluateMcpToolUse.callCodex")(function* (
  config: Config,
  body: Record<string, unknown>,
) {
  const raw = yield* postModel(
    config.apiKey,
    compatibleRequest(body),
    config.proxy,
    true,
    config.sessionId,
  );
  const response = yield* Effect.try(() => parseCompletion(raw));
  const message = response.choices[0]?.message;
  if (!message) return yield* Effect.die(new Error("Model returned no choice."));
  const content: Array<Block> = message.content ? [text(message.content)] : [];
  const output: Array<Block> = message.content
    ? [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: message.content }],
        },
      ]
    : [];
  for (const call of message.tool_calls ?? []) {
    const args = (yield* decodeJsonEffect(call.function.arguments)) as Record<string, unknown>;
    const custom = call.function.name === "exec";
    content.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input: custom ? args.code : args,
    });
    output.push({
      type: custom ? "custom_tool_call" : "function_call",
      call_id: call.id,
      name: call.function.name,
      ...(custom ? { input: args.code } : { arguments: call.function.arguments }),
    });
  }
  const cached = response.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    raw: output,
    content,
    stop_reason: message.tool_calls?.length ? "tool_use" : "end_turn",
    usage: {
      input_tokens: (response.usage?.prompt_tokens ?? 0) - cached,
      output_tokens: response.usage?.completion_tokens ?? 0,
      cache_read_input_tokens: cached,
    },
  };
});

const postModel = Effect.fn("evaluateMcpToolUse.postModel")(function* (
  apiKey: string,
  body: unknown,
  proxy?: Config["proxy"],
  responses = false,
  sessionId = "sshcode-eval-shell",
) {
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.retryTransient({
      retryOn: "errors-and-responses",
      schedule: Schedule.exponential("2 seconds"),
      times: 4,
    }),
  );
  const response = yield* HttpClientRequest.post(
    `${proxy?.url ?? "https://api.anthropic.com/v1"}/${responses ? "chat/completions" : "messages"}`,
  ).pipe(
    HttpClientRequest.setHeaders({
      ...(apiKey ? { "x-api-key": apiKey } : {}),
      "anthropic-version": "2023-06-01",
      // Claude Code sends this beta for `defer_loading` tools and `tool_reference` results.
      "anthropic-beta": "advanced-tool-use-2025-11-20",
      "User-Agent": "SSHCode-tool-eval/1.0",
      "x-opencode-session": sessionId,
      ...proxy?.headers,
    }),
    HttpClientRequest.bodyJson(body),
    Effect.flatMap(client.execute),
  );
  if (response.status !== 200) {
    const body = yield* response.text;
    return yield* Effect.die(new Error(`Model API ${response.status}: ${body}`));
  }
  return yield* response.text;
}, Effect.timeout("3 minutes"));
// The shell simulator uses the same prepared OpenAI-compatible key, never Claude.
const callModel = (apiKey: string, body: unknown, proxy?: Config["proxy"]) =>
  Effect.gen(function* () {
    const request = body as { model: string; system: string; messages: unknown };
    const raw = yield* postModel(
      apiKey,
      {
        model: request.model,
        max_tokens: 2048,
        messages: [
          { role: "system", content: request.system },
          ...(request.messages as Array<unknown>),
        ],
      },
      proxy,
      true,
    );
    const result = (yield* decodeJsonEffect(raw)) as {
      choices: Array<{ message: { content: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      content: [text(result.choices[0]?.message.content ?? "")],
      stop_reason: "end_turn",
      usage: {
        input_tokens: result.usage?.prompt_tokens ?? 0,
        output_tokens: result.usage?.completion_tokens ?? 0,
      },
    };
  });

/** A tool call as graded. Claude Code runs an `Agent` in the background unless told otherwise. */
const recordedCall = (step: number, use: typeof ToolUse.Type): Call => {
  const { tool, input } = canonicalCall(use.name, use.input);
  const claudeAgent = tool === "Agent" && !use.name.endsWith("spawn_agent") && isRecord(input);
  return { step, tool, input: claudeAgent ? { run_in_background: true, ...input } : input };
};

/** Calls that ran. Claude Code rejects a deferred tool that was not loaded, so it never runs. */
export const ranCalls = (
  { base, tools }: Sample,
  step: number,
  uses: ReadonlyArray<typeof ToolUse.Type>,
) =>
  uses
    .filter((use) => base.codex !== undefined || hasTool(tools, use.name))
    .map((use) => recordedCall(step, use));

/**
 * Runs one sample until the model ends its turn, uses up its steps, or fails a check that no
 * later step can undo.
 */
const runSample = Effect.fn("evaluateMcpToolUse.runSample")(function* (
  testCase: McpToolUseCase,
  config: Config,
  base: Base,
) {
  const sample = makeSample(testCase, base);
  const runPromise = Effect.runPromiseWith(yield* Effect.context<HttpClient.HttpClient>());
  const messages = buildMessages(sample);
  const input = base.codex ? codexMessages(messages) : undefined;
  const transcript: Array<unknown> = [];
  const start = messages.length;
  const calls: Array<Call> = [];
  const said: Array<string> = [];
  const usage = emptyUsage();
  let stopReason = "max_steps";
  // Codex's code-mode cells take more model calls, so a case's own budget grows for it too.
  const extra = isCodex(config.model) ? 4 : 0;
  const maxSteps = testCase.maxSteps === undefined ? config.maxSteps : testCase.maxSteps + extra;
  for (let step = 0; step < maxSteps; step++) {
    const response = input
      ? yield* callCodex(config, codexRequest(base, input))
      : yield* callModel(config.apiKey, requestBody(sample, config.effort, messages));
    addUsage(usage, response.usage);
    if ("raw" in response && Array.isArray(response.raw)) {
      input?.push(...response.raw);
      transcript.push(...response.raw);
    }
    messages.push({ role: "assistant", content: response.content });
    said.push(...response.content.filter(isText).map((block) => block.text));
    const uses = response.content.filter(isToolUse);
    calls.push(...ranCalls(sample, step, uses));
    if (response.stop_reason !== "tool_use") {
      stopReason = response.stop_reason ?? "unknown";
      break;
    }
    if (failedEarly(testCase.expect, { calls, text: said.join("\n\n"), stopReason })) {
      stopReason = "failed_early";
      break;
    }
    const results = yield* Effect.forEach(uses, (use) =>
      Effect.gen(function* () {
        if (!input) return yield* answerToolCall(sample, config, use);
        const answer = (name: string, args: unknown, record = true) => {
          const { tool, input: normalized } = canonicalCall(name, args);
          if (record) calls.push({ step, tool, input: normalized });
          const call = { ...use, name, input: normalized };
          return answerToolCall(sample, config, call).pipe(
            Effect.map((result) => {
              const output = valueText(result.content);
              if (isT3Name(name))
                return {
                  content: [text(output)],
                  ...(!result.is_error
                    ? { structuredContent: Option.getOrElse(decodeJson(output), () => output) }
                    : { isError: true }),
                };
              return tool === "Bash"
                ? {
                    output,
                    exit_code: /^Exit code [1-9]/.test(output) ? 1 : 0,
                    wall_time_seconds: 0,
                  }
                : output;
            }),
            runPromise,
          );
        };
        return yield* Effect.tryPromise(async () => {
          const output =
            use.name === "exec"
              ? await executeCodex(
                  valueText(use.input),
                  codexCatalog(base),
                  answer,
                  sample.codeStore,
                )
              : await answer(use.name, use.input, false);
          const item = {
            type: use.name === "exec" ? "custom_tool_call_output" : "function_call_output",
            call_id: use.id,
            output: valueText(output),
          };
          input.push(item);
          transcript.push(item);
          return toolResult(use.id, output);
        });
      }),
    );
    // Claude Code adds this text after a ToolSearch that loaded tools.
    const loaded = results.some((result) => Array.isArray(result.content));
    messages.push({ role: "user", content: [...results, ...(loaded ? [text(TOOL_LOADED)] : [])] });
    if (failedEarly(testCase.expect, { calls, text: said.join("\n\n"), stopReason })) {
      stopReason = "failed_early";
      break;
    }
  }
  // The transcript (model turns and tool results) shows what the agent saw when a case fails.
  return {
    calls,
    text: said.join("\n\n"),
    stopReason,
    linked: [...sample.linked],
    usage,
    shellUsage: sample.shellUsage,
    transcript: input ? transcript : messages.slice(start),
  };
});

type ResultRow = Pick<McpToolUseCase, "id" | "kind" | "pattern"> & {
  readonly role: string;
  readonly pass: boolean;
  readonly usage: Usage;
  readonly shellUsage: Usage;
  readonly stopReason?: string | undefined;
  readonly error?: unknown;
};

const passRate = (rows: ReadonlyArray<{ readonly pass: boolean }>) =>
  rows.filter((row) => row.pass).length / rows.length;
const percent = (rate: number) => `${Math.round(rate * 100)}%`;
const groups = <A>(rows: ReadonlyArray<A>, key: (row: A) => string) =>
  [...Map.groupBy(rows, key)].toSorted(([left], [right]) => left.localeCompare(right));

/** Changed outcomes need three samples even when a resumed run's first two agreed. */
export const requiredSamples = (
  rows: ReadonlyArray<{ readonly pass: boolean }>,
  options: { readonly samples?: number | undefined; readonly baseline?: number | undefined } = {},
) =>
  options.samples ??
  (new Set(rows.map((row) => row.pass)).size > 1 ||
  (rows.length > 0 && options.baseline !== undefined && passRate(rows) !== options.baseline)
    ? 3
    : 2);

/** A resumed run must keep failing for already-completed baseline-pass regressions. */
export const regressedCases = (
  rows: ReadonlyArray<{ readonly id: string; readonly pass: boolean }>,
  baseline: ReadonlyMap<string, number>,
  samples?: number,
) =>
  groups(rows, (row) => row.id)
    .filter(
      ([id, members]) =>
        (baseline.get(id) ?? 0) > 0.5 &&
        members.length >= requiredSamples(members, { samples, baseline: baseline.get(id) }) &&
        passRate(members) <= 0.5,
    )
    .map(([id]) => id);

/** Provider/transport failures have no quality outcome; preserve them separately before retrying. */
export const failedToRun = (row: {
  readonly stopReason?: string | undefined;
  readonly error?: unknown;
}) =>
  row.stopReason === "cli_error" ||
  /TimeoutError|HttpClientError|Model API (?:429|5\d\d)/.test(valueText(row.error));

const USAGE_KEYS = ["input", "output", "cacheWrite", "cacheRead"] as const;
/** Token totals and their cost in USD at one model's prices. Proxy runs have no price. */
const spend = (usages: ReadonlyArray<Usage>, _model: string | undefined) => {
  const total = (key: keyof Usage) => usages.reduce((sum, usage) => sum + usage[key], 0);
  const cost = 0;
  return { cost, tokens: USAGE_KEYS.map((key) => `${key} ${total(key)}`).join(", ") };
};

/** Markdown report. With a baseline, each case shows its earlier pass rate and the change. */
const summarize = (
  rows: Array<ResultRow>,
  options: {
    readonly header: string;
    readonly shellModel: string;
    readonly model: Model;
    readonly runner: "api" | "codex-cli";
  },
  before?: Map<string, number>,
) => {
  const codex = isCodex(options.model);
  const agent = spend(
    rows.map((row) => row.usage),
    codex ? undefined : options.model,
  );
  const shell = spend(
    rows.map((row) => row.shellUsage),
    options.shellModel,
  );
  const cost = agent.cost + shell.cost;
  const table = (title: string, key: (row: ResultRow) => string, compare = false) => [
    `## ${title}\n`,
    compare ? "| Group | Pass | Baseline | Delta |" : "| Group | Pass |",
    compare ? "| --- | --- | --- | --- |" : "| --- | --- |",
    ...groups(rows, key).map(([group, members]) => {
      const now = passRate(members);
      const was = before?.get(group);
      const delta =
        was === undefined ? "new | |" : `${percent(was)} | ${Math.round((now - was) * 100)} pts |`;
      return `| ${group} | ${percent(now)} of ${members.length} |${compare ? ` ${delta}` : ""}`;
    }),
    "",
  ];
  const nativeNote =
    "- native-subagent cases are approximate: the harness gives subagents their own system prompt, which this runner does not rebuild.";
  const identityNote = `- The captured Claude Code identity line is replaced with "${NEUTRAL_IDENTITY}"`;
  return [
    "# MCP tool-use eval\n",
    `- ${options.header}`,
    `- Pass: ${percent(passRate(rows))} of ${rows.length} samples. Resuming archives provider/transport failures in infrastructure.jsonl for retry.`,
    codex
      ? "- Cost: subscription allowance; prices are not inferred. No proxy is used."
      : `- Estimated cost $${cost.toFixed(2)}, $${(cost / rows.length).toFixed(3)} per sample.`,
    `- Agent tokens: ${agent.tokens}${codex ? "." : ` ($${agent.cost.toFixed(2)}).`}`,
    ...(options.runner === "codex-cli"
      ? [
          "- Installed Codex CLI, disposable writable fixture, offline native commands and local mock MCP.",
        ]
      : [
          `- Shell simulator (${options.shellModel}) tokens: ${shell.tokens} (usage only; no price estimate).`,
        ]),
    ...(options.runner === "codex-cli"
      ? []
      : codex
        ? [
            "- Code-mode tools use case mocks and a simulated machine. Native subagent prompts and asynchronous notifications are approximate.",
          ]
        : [identityNote]),
    ...(rows.some((row) => row.role === "native-subagent") ? [nativeNote] : []),
    "",
    ...table("Cases", (row) => row.id, before !== undefined),
    ...table("By kind", (row) => row.kind),
    ...table("By pattern", (row) => row.pattern),
  ].join("\n");
};

const PositiveInt = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThan(0));
const PositiveIntOrZero = Schema.FiniteFromString.check(
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
);
const Flags = Schema.Struct({
  model: Schema.String,
  resume: Schema.Boolean,
  runner: Schema.Literals(["api", "codex-cli"]),
  "fixture-root": Schema.String,
  "base-url": Schema.String,
  "api-key-env": Schema.String,
  surface: Schema.Literals(["agent", "all"]),
  template: Schema.String,
  cases: Schema.optional(Schema.Array(Schema.String)),
  out: Schema.optional(Schema.String),
  baseline: Schema.optional(Schema.String),
  case: Schema.optional(Schema.Array(Schema.String)),
  samples: Schema.optional(PositiveInt),
  concurrency: PositiveInt,
  "max-steps": Schema.optional(PositiveInt),
  effort: Schema.optional(Schema.Literals(EFFORTS)),
  "shell-model": Schema.String,
  "user-instructions": Schema.Literals(["keep", "drop"]),
  "dry-run": Schema.Boolean,
  "stop-on-regression": Schema.Boolean,
  "regression-budget": Schema.optional(PositiveIntOrZero),
  "native-agents": Schema.Boolean,
  context: Schema.Boolean,
  instructions: Schema.optional(Schema.String),
});
const decodeFlags = Schema.decodeUnknownEffect(Flags);
const decodeCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(Capture));
const decodeCodexCapture = Schema.decodeUnknownEffect(Schema.fromJsonString(CodexCapture));
const decodeCase = Schema.decodeUnknownEffect(Schema.fromJsonString(McpToolUseCase));
const decodeBaselineRow = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ id: Schema.String, pass: Schema.Boolean })),
);
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const string = { type: "string" } as const;

const main = Effect.gen(function* () {
  const { values } = NodeUtil.parseArgs({
    options: {
      model: string,
      resume: { type: "boolean", default: false },
      runner: { ...string, default: "api" },
      "fixture-root": { ...string, default: process.env.TMPDIR ?? "" },
      "base-url": { ...string, default: "https://opencode.ai/zen/go/v1" },
      "api-key-env": { ...string, default: "OPENCODE_GO_API_KEY" },
      surface: { ...string, default: "agent" },
      template: string,
      cases: { ...string, multiple: true },
      out: string,
      baseline: string,
      case: { ...string, multiple: true },
      // Unset: 2 samples per case, and a 3rd when those 2 disagree.
      samples: string,
      // Samples in flight at once, across all cases.
      concurrency: { ...string, default: "2" },
      // Unset: 6 for Claude, 10 for Codex, whose code-mode cells take more steps.
      "max-steps": string,
      effort: string,
      "shell-model": string,
      // T3's text must work for every user, so the captured CLAUDE.md is dropped by default.
      "user-instructions": { ...string, default: "drop" },
      "dry-run": { type: "boolean", default: false },
      "stop-on-regression": { type: "boolean", default: false },
      "regression-budget": string,
      // Keep Codex's native multi-agent mode & <multi_agent_mode> prompt enabled.
      "native-agents": { type: "boolean", default: false },
      // Prints the size of T3's text and tool schemas, then exits. Needs no template or key.
      context: { type: "boolean", default: false },
      // A file with a candidate orchestration section, swapped into every prompt.
      instructions: string,
    },
  });
  const flags = yield* decodeFlags({
    template: "",
    model: "eval-model",
    "shell-model": values.model ?? "eval-model",
    ...values,
  });
  surface = flags.surface;
  if (flags.instructions !== undefined) {
    const fsForOverride = yield* FileSystem.FileSystem;
    setInstructionsOverride(yield* fsForOverride.readFileString(flags.instructions));
  }
  if (flags.context) {
    process.stdout.write(`${t3ContextReport(flags.model)}\n`);
    return;
  }
  if (flags["stop-on-regression"] && flags.baseline === undefined) {
    return yield* Effect.die(new Error("--stop-on-regression needs --baseline."));
  }
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readNdjson = <A, E>(file: string, decode: (line: string) => Effect.Effect<A, E>) =>
    fs.readFileString(file).pipe(
      Effect.map((content) => content.split("\n").filter((line) => line.trim() !== "")),
      Effect.flatMap((lines) => Effect.forEach(lines, (line) => decode(line))),
    );
  const casesDir = path.join(import.meta.dirname, "cases");
  const caseFiles =
    flags.cases ??
    (yield* fs.readDirectory(casesDir))
      .filter((name) => name.endsWith(".ndjson"))
      .toSorted()
      .map((name) => path.join(casesDir, name));
  const cases = (yield* Effect.forEach(caseFiles, (file) => readNdjson(file, decodeCase))).flat();
  const wanted = flags.case?.flatMap((ids) => ids.split(","));
  const codex = isCodex(flags.model);
  const harness = codex ? "codex" : "claude";
  const selected = cases.filter(
    ({ id, setup }) =>
      (wanted === undefined || wanted.includes(id)) &&
      (setup.harness === undefined || setup.harness === harness),
  );
  if (selected.length === 0) return yield* Effect.die(new Error("No case matches --case."));
  // Trimmed captures without user data ship beside the cases. `--template` also takes a raw
  // CLIProxyAPI capture.
  const templatePath =
    flags.template ||
    path.join(import.meta.dirname, "templates", codex ? "codex.json.gz" : "claude.json.gz");
  const templateBytes = yield* fs.readFile(templatePath);
  const template = new TextDecoder().decode(
    templatePath.endsWith(".gz") ? NodeZlib.gunzipSync(templateBytes) : templateBytes,
  );
  const keepUserInstructions = flags["user-instructions"] === "keep";
  const buildFor = (subagent: boolean): Effect.Effect<Base, Schema.SchemaError> =>
    codex
      ? decodeCodexCapture(template).pipe(
          Effect.map((capture) =>
            buildCodexBase(capture.request.provider_native, {
              model: flags.model,
              keepUserInstructions,
              effort: flags.effort,
              subagent,
            }),
          ),
        )
      : decodeCapture(template).pipe(
          Effect.map((capture) =>
            buildBase(capture.request.provider_native, {
              model: flags.model,
              keepUserInstructions,
              subagent,
            }),
          ),
        );
  const base = yield* buildFor(false);
  const childBase = yield* buildFor(true);
  const baseFor = (testCase: McpToolUseCase) =>
    testCase.setup.role === "delegated-child" ? childBase : base;
  const effort = flags.effort ?? base.codex?.reasoning.effort ?? "high";
  if (flags["dry-run"]) {
    // One JSON line per case. Without --case this also checks that every case builds.
    for (const testCase of selected) {
      const sample = makeSample(testCase, baseFor(testCase));
      const messages = buildMessages(sample);
      const body = base.codex
        ? compatibleRequest(codexRequest(baseFor(testCase), codexMessages(messages)))
        : requestBody(sample, effort, messages);
      process.stdout.write(`${yield* encodeJson(body)}\n`);
    }
    return;
  }
  if (!codex)
    return yield* Effect.die(
      new Error("Claude eval calls are disabled. The claude template is available with --dry-run."),
    );
  if (
    [flags.model, flags["shell-model"]].some((model) =>
      /claude|anthropic|(?:^|[/-])(?:opus|sonnet|haiku)(?:[-/]|$)/i.test(model),
    )
  )
    return yield* Effect.die(new Error("Claude eval models and shell simulators are disabled."));
  const apiKey = flags.runner === "api" ? (process.env[flags["api-key-env"]] ?? "") : "";
  const out = flags.out;
  if ((!apiKey && flags.runner === "api") || out === undefined) {
    const message =
      "Provide a prepared key via --api-key-env and pass --out <directory>. Harness credentials are never read.";
    return yield* Effect.die(new Error(message));
  }
  const codexHome =
    flags.runner === "codex-cli" ? yield* Effect.tryPromise(requireChatGptLogin) : undefined;
  const config: Config = {
    apiKey,
    model: flags.model,
    proxy: {
      url: flags["base-url"].replace(/\/$/, ""),
      headers: { Authorization: `Bearer ${apiKey}` },
    },
    sessionId: `sshcode-eval-${NodeCrypto.randomUUID()}`,
    effort,
    maxSteps: flags["max-steps"] ?? (codex ? 10 : 6),
    shellModel: flags["shell-model"],
  };
  yield* fs.makeDirectory(out, { recursive: true });
  const resultsPath = path.join(out, "results.jsonl");
  const resumedRaw =
    flags.resume && (yield* fs.exists(resultsPath))
      ? ((yield* readNdjson(resultsPath, decodeJsonEffect)) as Array<ResultRow>)
      : [];
  const infrastructure = resumedRaw.filter(failedToRun);
  if (infrastructure.length > 0) {
    yield* fs.writeFileString(
      path.join(out, "infrastructure.jsonl"),
      infrastructure.map((row) => JSON.stringify(row)).join("\n") + "\n",
      { flag: "a" },
    );
  }
  const resumed = resumedRaw.filter((row) => !failedToRun(row));
  const previous =
    flags.baseline === undefined ? [] : yield* readNdjson(flags.baseline, decodeBaselineRow);
  const baseline = new Map(groups(previous, (row) => row.id).map(([id, r]) => [id, passRate(r)]));
  const complete = new Set(
    groups(resumed, (row) => row.id)
      .filter(
        ([id, members]) =>
          members.length >=
          requiredSamples(members, { samples: flags.samples, baseline: baseline.get(id) }),
      )
      .map(([id]) => id),
  );
  const retained = resumed;
  yield* fs.writeFileString(
    resultsPath,
    retained.map((row) => JSON.stringify(row)).join("\n") + (retained.length ? "\n" : ""),
  );
  const passedBefore = (id: string) => (baseline.get(id) ?? 0) > 0.5;
  // Before the paid runs, so a missing git cannot lose their results.
  const commit = yield* Effect.try(() =>
    NodeChildProcess.execFileSync("git", ["describe", "--always", "--dirty"], {
      encoding: "utf8",
    }).trim(),
  ).pipe(Effect.orElseSucceed(() => "unknown"));
  const inFlight = yield* Semaphore.make(flags.concurrency);
  const runOne = (testCase: McpToolUseCase) => {
    const { id, kind, pattern } = testCase;
    const identity = { id, kind, pattern, role: testCase.setup.role };
    const usage = { usage: emptyUsage(), shellUsage: emptyUsage() };
    const privateValues = [config.apiKey, ...Object.values(config.proxy?.headers ?? {})]
      .flatMap((value) => [value, value.replace(/^Bearer /i, "")])
      .filter(Boolean);
    const baseForCase = baseFor(testCase);
    const sampleConfig = { ...config, sessionId: `sshcode-eval-${NodeCrypto.randomUUID()}` };
    const cliSample = makeSample(testCase, baseForCase);
    const sampleEffect: Effect.Effect<
      SampleRun & { usage: Usage; shellUsage: Usage; transcript: ReadonlyArray<unknown> },
      { readonly _tag: string } | Error,
      HttpClient.HttpClient
    > =
      codexHome !== undefined
        ? Effect.tryPromise(() =>
            runCliSample(testCase, {
              model: flags.model,
              effort,
              fixtureRoot: flags["fixture-root"],
              codexHome,
              nativeAgents: flags["native-agents"],
              definitions: baseForCase.t3.map((tool) => ({
                name: normalizeToolName(tool.name),
                description: valueText(tool.description),
                inputSchema: tool.input_schema,
              })),
              answer: async (name, input) => {
                const result = await Effect.runPromise(
                  answerToolCall(cliSample, config, {
                    type: "tool_use",
                    id: "cli",
                    name: `${T3_PREFIX}${name}`,
                    input,
                  }).pipe(Effect.provide(FetchHttpClient.layer)),
                );
                return typeof result.content === "string"
                  ? JSON.parse(result.content)
                  : result.content;
              },
            }),
          ).pipe(
            Effect.map((sample) => ({
              ...sample,
              linked: [...cliSample.linked],
              calls: sample.calls.map((call) => ({
                ...call,
                ...canonicalCall(call.tool, call.input),
              })),
            })),
          )
        : runSample(testCase, sampleConfig, baseForCase);
    return sampleEffect.pipe(
      inFlight.withPermits(1),
      Effect.matchCause({
        onFailure: (cause) => ({
          ...identity,
          ...usage,
          pass: false,
          error: privateValues.reduce(
            (message, value) => message.replaceAll(value, "[redacted]"),
            Cause.pretty(cause),
          ),
        }),
        onSuccess: (sample) => {
          const checks = gradeSample(testCase.expect, sample);
          return { ...identity, pass: checks.every((check) => check.pass), checks, ...sample };
        },
      }),
      Effect.tap((row) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(
            path.join(out, "results.jsonl"),
            `${yield* encodeJson(row)}\n`,
            { flag: "a" },
          );
          yield* Effect.log(`${row.id}: ${row.pass ? "pass" : "FAIL"}`);
        }),
      ),
    );
  };
  // Without --samples, a case whose 2 samples disagree gets a 3rd to settle it.
  const runCase = Effect.fn("evaluateMcpToolUse.runCase")(function* (testCase: McpToolUseCase) {
    const earlier = retained.filter((row) => row.id === testCase.id);
    const sampling = { samples: flags.samples, baseline: baseline.get(testCase.id) };
    const samples = Array.from(
      { length: Math.max(0, requiredSamples(earlier, sampling) - earlier.length) },
      () => testCase,
    );
    const fresh = yield* Effect.forEach(samples, runOne, { concurrency: "unbounded" });
    const first = [...earlier, ...fresh];
    return first.length < requiredSamples(first, sampling)
      ? [...fresh, yield* runOne(testCase)]
      : fresh;
  });
  // Stop admitting cases on regression, then drain active sample groups without cancelling CLIs.
  // The semaphore limits samples; cases passing the baseline majority run first.
  const stopEarly = flags["stop-on-regression"];
  const budget = flags["regression-budget"] ?? 0;
  const pending = selected.filter((testCase) => !complete.has(testCase.id));
  const ordered = stopEarly
    ? pending.toSorted((a, b) => Number(passedBefore(b.id)) - Number(passedBefore(a.id)))
    : pending;
  const rows = [...retained] as Array<Effect.Success<ReturnType<typeof runOne>>>;
  const regressions = stopEarly ? regressedCases(retained, baseline, flags.samples) : [];
  yield* Effect.forEach(
    regressions.length > budget ? [] : ordered,
    (testCase) =>
      Effect.suspend(() =>
        regressions.length > budget
          ? Effect.void
          : runCase(testCase).pipe(
              Effect.flatMap((caseRows) => {
                rows.push(...caseRows);
                if (
                  !stopEarly ||
                  !passedBefore(testCase.id) ||
                  passRate(rows.filter((row) => row.id === testCase.id)) > 0.5
                ) {
                  return Effect.void;
                }
                regressions.push(testCase.id);
                return Effect.void;
              }),
            ),
      ),
    {
      concurrency: stopEarly
        ? Math.max(1, Math.floor(flags.concurrency / (flags.samples ?? 2)))
        : flags.concurrency,
      discard: true,
    },
  ).pipe(Effect.ignore);
  const samples = flags.samples === undefined ? "2-3 (adaptive)" : flags.samples;
  const header = `Runner ${flags.runner}. Commit \`${commit}\`, ${flags.model} at ${effort} effort, user instructions ${flags["user-instructions"]}, ${samples} samples per case, template \`${path.basename(templatePath)}\``;
  const finished = new Set(rows.map((row) => row.id)).size;
  const stopped =
    regressions.length === 0
      ? []
      : [
          `- Regressions (passed the baseline majority, now fail): ${regressions.map((id) => `\`${id}\``).join(", ")}.${regressions.length > budget ? ` Stopped with ${finished} of ${selected.length} cases finished.` : ""}`,
        ];
  const summary = summarize(
    rows,
    {
      header: [header, t3ContextReport(flags.model), ...stopped].join("\n"),
      shellModel: config.shellModel,
      model: config.model,
      runner: flags.runner,
    },
    flags.baseline === undefined ? undefined : baseline,
  );
  yield* fs.makeDirectory(out, { recursive: true });
  const lines = yield* Effect.forEach(rows, (row) => encodeJson(row));
  yield* fs.writeFileString(path.join(out, "results.jsonl"), `${lines.join("\n")}\n`);
  yield* fs.writeFileString(path.join(out, "summary.md"), summary);
  yield* Effect.log(`Wrote ${rows.length} samples to ${out}.\n\n${summary}`);
  if (regressions.length > budget) process.exitCode = 1;
});

if (import.meta.main) {
  main.pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer)),
    NodeRuntime.runMain,
  );
}
