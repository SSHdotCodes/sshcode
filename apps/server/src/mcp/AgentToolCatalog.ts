import { XPostToolkit } from "./toolkits/xPost/tools.ts";
import { DebugToolkit } from "./toolkits/debug/tools.ts";
import { WorkflowToolkit } from "./toolkits/workflows/tools.ts";
import { workflowsBetaEnabled } from "../workflows/workflowsBeta.ts";
import { modelPreferencesInUse } from "@t3tools/provider-core/server/orchestrationInstructions";
import { ModelPreferencesToolkit } from "./toolkits/modelPreferences/tools.ts";
import { ComputerToolkit } from "./toolkits/computer/tools.ts";
import { AgentToolDescriptor, type AgentToolPolicy, isAgentToolEnabled } from "@t3tools/contracts";
import { isSubagentOrchestrationTool } from "@t3tools/shared/chatControls";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import { Tool } from "effect/ai";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import type * as ChatControls from "../sessionBoxes/chatControls.ts";
import { DeviceToolkit } from "./toolkits/device/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { ProjectListToolkit } from "./toolkits/project/tools.ts";
import { PendingRequestToolkit } from "./toolkits/thread/tools.ts";

/**
 * The settings catalog is the agent surface: orchestration, pending
 * questions, read-only project listing, devices, and the browser. It is walked
 * from those toolkits. Latent application toolkits (worktrees, pull requests,
 * HTML, mutating project tools) stay off this list even though `layerAllTools`
 * can register them.
 */
const AGENT_TOOL_GROUPS = [
  ["orchestration", OrchestratorToolkit],
  ["workflows", WorkflowToolkit],
  ["models", ModelPreferencesToolkit],
  ["web", XPostToolkit],
  ["debug", DebugToolkit],
  ["questions", PendingRequestToolkit],
  ["projects", ProjectListToolkit],
  ["device", DeviceToolkit],
  ["browser", PreviewToolkit],
  ["computer", ComputerToolkit],
] as const;

/** The definitions advertised by the provider MCP surface, also used by tool-use evals. */
export const agentToolkits = AGENT_TOOL_GROUPS.map(([, toolkit]) => toolkit);

const GROUP_RANK = new Map<string, number>(
  AGENT_TOOL_GROUPS.map(([group], index) => [group, index]),
);

const humanizeToolName = (name: string) => {
  const words = name.replaceAll("_", " ");
  return words.slice(0, 1).toUpperCase() + words.slice(1);
};

type AgentToolDescriptorShape = typeof AgentToolDescriptor.Type;

const descriptorsFrom = (
  group: string,
  toolkit: { readonly tools: Record<string, Tool.Any> },
): ReadonlyArray<AgentToolDescriptorShape> =>
  Object.values(toolkit.tools).map((tool) => ({
    name: tool.name,
    title: Option.getOrElse(Context.getOption(tool.annotations, Tool.Title), () =>
      humanizeToolName(tool.name),
    ),
    description: Tool.getDescription(tool) ?? "",
    group,
    readonly: Context.get(tool.annotations, Tool.Readonly),
  }));

const namesOf = (toolkit: { readonly tools: Record<string, Tool.Any> }) =>
  new Set(Object.keys(toolkit.tools));

/** Device tools stay hidden unless the credential carries the device capability and a thread. */
export const deviceAgentToolNames = namesOf(DeviceToolkit);

/** Browser tools stay hidden unless the credential carries preview and a thread. */
export const previewAgentToolNames = namesOf(PreviewToolkit);
const computerAgentToolNames = namesOf(ComputerToolkit);

export const agentToolCatalog: ReadonlyArray<AgentToolDescriptorShape> = AGENT_TOOL_GROUPS.flatMap(
  ([group, toolkit]) => descriptorsFrom(group, toolkit),
).toSorted((left, right) => {
  const groupDelta =
    (GROUP_RANK.get(left.group) ?? GROUP_RANK.size) -
    (GROUP_RANK.get(right.group) ?? GROUP_RANK.size);
  return groupDelta === 0 ? left.name.localeCompare(right.name) : groupDelta;
});

/** The native discovery prompt uses the purpose of each tool as its index. */
export const agentToolDiscoveryCatalog = (visible: (name: string) => boolean) =>
  agentToolCatalog
    .filter(({ name }) => visible(name))
    .map(({ name, description, title }) => {
      const purpose = description.split(/(?<=[.!?])\s|\n/u, 1)[0]?.trim();
      return `${name} — ${purpose && purpose.length <= 120 ? purpose : title}`;
    })
    .join("\n");

/**
 * Policy is the user's tool toggle. Device and preview capabilities stay the
 * credential gate (`enableAgentBrowserAccess`, project overrides, device
 * onboarding). A policy that allows a tool does not grant either capability.
 * External clients have no thread, so they follow the global policy and never
 * see device or browser tools.
 */
export const agentToolListVisible = (
  policy: AgentToolPolicy,
  name: string,
  scope: McpInvocationScope | undefined,
  chatControls: Pick<ChatControls.ChatControls["Service"], "subagentsEnabled">,
) => {
  if (!isAgentToolEnabled(policy, name, scope?.thread?.providerInstanceId)) return false;
  // No thread means an external client; the per-chat switch does not apply.
  if (
    isSubagentOrchestrationTool(name) &&
    scope?.thread !== undefined &&
    !chatControls.subagentsEnabled(scope.thread.threadId)
  ) {
    return false;
  }
  if (name === "workflow") {
    // Listed only while the Workflows beta is on, so other agents never pay for it.
    return (
      scope?.thread !== undefined &&
      scope.capabilities.has("orchestration") &&
      workflowsBetaEnabled()
    );
  }
  if (name === "model_preferences") {
    // Listed only while the user has ranked something, so nobody pays for an empty answer.
    return (
      scope?.thread !== undefined &&
      scope.capabilities.has("orchestration") &&
      modelPreferencesInUse()
    );
  }
  if (name === "debug_log" || computerAgentToolNames.has(name)) {
    return scope?.thread !== undefined && scope.capabilities.has("orchestration");
  }
  if (deviceAgentToolNames.has(name)) {
    return scope?.thread !== undefined && scope.capabilities.has("device");
  }
  if (previewAgentToolNames.has(name)) {
    return scope?.thread !== undefined && scope.capabilities.has("preview");
  }
  return true;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Ids of `tools/list` requests in one HTTP body. Undefined when the body is not a list. */
export const toolsListRequestIds = (raw: string): ReadonlySet<string> | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const ids = new Set<string>();
  for (const message of messages) {
    if (!isRecord(message) || message.method !== "tools/list") continue;
    if (typeof message.id === "string" || typeof message.id === "number")
      ids.add(String(message.id));
  }
  return ids.size === 0 ? undefined : ids;
};

/** Changes one listed tool; returns the same object when nothing changes. */
export type ToolsListTransform = (tool: Record<string, unknown>) => Record<string, unknown>;
export type ToolsCatalogTransform = (tools: ReadonlyArray<unknown>) => ReadonlyArray<unknown>;

/** The tools whose input carries `grades` (Settings' grading switch). */
const GRADED_TOOLS: ReadonlySet<string> = new Set([
  "delegate_task",
  "t3_thread_send",
  "task_status",
]);

/** Removes the `grades` input from the subagent tools, for when Settings turns grading off. */
export const withoutGrades: ToolsListTransform = (tool) => {
  const schema = tool.inputSchema;
  if (typeof tool.name !== "string" || !GRADED_TOOLS.has(tool.name) || !isRecord(schema)) {
    return tool;
  }
  const properties = schema.properties;
  if (!isRecord(properties) || !("grades" in properties)) return tool;
  const { grades: _grades, ...rest } = properties;
  return { ...tool, inputSchema: { ...schema, properties: rest } };
};

/** Drivers whose models read tool schemas through Gemini's API. */
const GEMINI_SCHEMA_DRIVERS: ReadonlySet<string> = new Set(["antigravity"]);

/** A built-in instance is listed under its driver's name and may be missing from settings. */
export const callerReadsGeminiSchemas = (
  instances: Readonly<Record<string, { readonly driver: string } | undefined>>,
  instanceId: string | undefined,
): boolean =>
  instanceId !== undefined &&
  GEMINI_SCHEMA_DRIVERS.has(instances[instanceId]?.driver ?? instanceId);

const geminiSafeSchema = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    let changed = false;
    const items = value.map((item) => {
      const next = geminiSafeSchema(item);
      changed ||= next !== item;
      return next;
    });
    return changed ? items : value;
  }
  if (!isRecord(value)) return value;
  let result: Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(value)) {
    // Values, not schemas: nothing inside them is a keyword.
    if (key === "const" || key === "default" || key === "examples") continue;
    if (key === "enum" && Array.isArray(child)) {
      const kept = child.filter((choice) => choice !== null && choice !== "");
      if (kept.length === child.length) continue;
      result ??= { ...value };
      if (kept.length === 0) delete result.enum;
      else result.enum = kept;
      continue;
    }
    const next = geminiSafeSchema(child);
    if (next === child) continue;
    result ??= { ...value };
    result[key] = next;
  }
  return result ?? value;
};

/**
 * Gemini refuses a whole request when any tool lists `null` or `""` as an
 * `enum` choice. A nullable field keeps `null` in its `type`, so it can still be
 * cleared.
 */
export const withGeminiSafeEnums: ToolsListTransform = (tool) => {
  const next = geminiSafeSchema(tool.inputSchema);
  return next === tool.inputSchema ? tool : { ...tool, inputSchema: next };
};

const rewriteToolsListValue = (
  value: unknown,
  ids: ReadonlySet<string>,
  visible: (name: string) => boolean,
  transform?: ToolsListTransform,
  transformCatalog?: ToolsCatalogTransform,
): { readonly value: unknown; readonly changed: boolean } => {
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const rewritten = rewriteToolsListValue(item, ids, visible, transform, transformCatalog);
      changed ||= rewritten.changed;
      return rewritten.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }
  if (!isRecord(value)) return { value, changed: false };
  const id = value.id;
  const idKey = typeof id === "string" || typeof id === "number" ? String(id) : undefined;
  if (idKey === undefined || !ids.has(idKey)) return { value, changed: false };
  const result = value.result;
  if (!isRecord(result) || !Array.isArray(result.tools)) return { value, changed: false };
  let changed = false;
  const tools = result.tools.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") return [tool];
    if (!visible(tool.name)) {
      changed = true;
      return [];
    }
    const next = transform ? transform(tool) : tool;
    if (next !== tool) changed = true;
    return [next];
  });
  const catalog = transformCatalog?.(tools) ?? tools;
  if (!changed && catalog === tools) return { value, changed: false };
  return { value: { ...value, result: { ...result, tools: catalog } }, changed: true };
};

const rewriteJsonDocument = (
  raw: string,
  ids: ReadonlySet<string>,
  visible: (name: string) => boolean,
  transform?: ToolsListTransform,
  transformCatalog?: ToolsCatalogTransform,
): string | undefined => {
  const body = raw.trim();
  if (body.length === 0) return undefined;
  try {
    const rewritten = rewriteToolsListValue(
      JSON.parse(body),
      ids,
      visible,
      transform,
      transformCatalog,
    );
    if (!rewritten.changed) return raw;
    const prefix = raw.slice(0, raw.indexOf(body));
    const suffix = raw.slice(raw.indexOf(body) + body.length);
    return `${prefix}${JSON.stringify(rewritten.value)}${suffix}`;
  } catch {
    return undefined;
  }
};

/**
 * Drop tools the caller must not see from a `tools/list` HTTP body.
 * JSON, newline-delimited JSON, and `data:` SSE frames are covered.
 * Bodies that are not a list result are returned unchanged.
 */
export const rewriteToolsListBody = (
  text: string,
  ids: ReadonlySet<string>,
  visible: (name: string) => boolean,
  transform?: ToolsListTransform,
  transformCatalog?: ToolsCatalogTransform,
): string => {
  // A JSON tool description can contain the letters "data:", so only a body
  // that begins as an event stream is framed that way.
  const trimmedStart = text.trimStart();
  if (
    trimmedStart.startsWith("data:") ||
    trimmedStart.startsWith("event:") ||
    trimmedStart.startsWith(":")
  ) {
    let changed = false;
    const next = text
      .split("\n\n")
      .map((block) =>
        block
          .split("\n")
          .map((line) => {
            if (!line.startsWith("data:")) return line;
            const payload = line.slice("data:".length).trimStart();
            const rewritten = rewriteJsonDocument(
              payload,
              ids,
              visible,
              transform,
              transformCatalog,
            );
            if (rewritten === undefined || rewritten === payload) return line;
            changed = true;
            return `data: ${rewritten.trim()}`;
          })
          .join("\n"),
      )
      .join("\n\n");
    return changed ? next : text;
  }
  const whole = rewriteJsonDocument(text, ids, visible, transform, transformCatalog);
  if (whole !== undefined) return whole;
  if (!text.includes("\n")) return text;
  let changed = false;
  const lines = text.split("\n").map((line) => {
    if (line.trim().length === 0) return line;
    const rewritten = rewriteJsonDocument(line, ids, visible, transform, transformCatalog);
    if (rewritten === undefined || rewritten === line) return line;
    changed = true;
    return rewritten.trim();
  });
  return changed ? lines.join("\n") : text;
};
