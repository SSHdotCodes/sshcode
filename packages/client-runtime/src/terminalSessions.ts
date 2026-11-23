// @effect-diagnostics globalDate:off -- Pure client relative labels accept an injectable clock.
import type {
  ClaudeRcItem,
  ClaudeRcSession,
  EnvironmentId,
  ToolActivitySource,
} from "@t3tools/contracts";
import {
  classifyClaudeNativeTool,
  type ClaudeToolItemType,
} from "@t3tools/shared/claudeNativeTools";
import {
  classifyToolActivity,
  collectToolFilePaths,
  dynamicToolTitle,
  formatReadToolLabel,
  formatSearchToolLabel,
} from "@t3tools/shared/toolActivity";

export const TERMINAL_SESSION_LABEL = "Terminal session";
/** Older servers omit `claudeRemoteControl`. Do not call the Remote Control RPCs. */
export const TERMINAL_HOST_UPDATE_MESSAGE =
  "Update SSHCode on this machine to use Terminal sessions.";
export const TERMINAL_MESSAGE_MAX_LENGTH = 100_000;

export type TerminalHostPhase =
  | "ready"
  | "loading"
  | "unsupported"
  | "disconnected"
  | "reconnecting"
  | "absent";

/**
 * One host only. All uses the primary host so the same Claude login is not
 * listed once for every connected computer. A chosen machine replaces that.
 */
export function terminalListEnvironmentId(
  selectedMachineId: string | null,
  primaryEnvironmentId: EnvironmentId | null,
  environmentIds: readonly EnvironmentId[],
  /** This client has a machine of its own that has not registered yet: wait for it. */
  primaryPending = false,
): EnvironmentId | null {
  if (selectedMachineId !== null && selectedMachineId !== "all") {
    return environmentIds.find((id) => id === selectedMachineId) ?? null;
  }
  if (primaryEnvironmentId !== null && environmentIds.some((id) => id === primaryEnvironmentId)) {
    return primaryEnvironmentId;
  }
  // Another saved machine can load first after a restart. Listing its sessions
  // as "All" would show the wrong computer until this one arrives.
  if (primaryPending) return null;
  return environmentIds[0] ?? null;
}

export function terminalHostPhase(input: {
  readonly environmentId: EnvironmentId | null;
  readonly connected: boolean;
  readonly connecting: boolean;
  readonly configLoaded: boolean;
  readonly claudeRemoteControl: boolean | undefined;
  /** No machine yet because this client's own one is still starting. */
  readonly starting?: boolean;
}): { readonly phase: TerminalHostPhase; readonly message: string | null } {
  if (input.environmentId === null) {
    return input.starting === true
      ? { phase: "loading", message: null }
      : { phase: "absent", message: "No machine is connected." };
  }
  if (!input.connected) {
    return input.connecting
      ? { phase: "reconnecting", message: "Reconnecting…" }
      : {
          phase: "disconnected",
          message: "Disconnected. Sessions appear again when this machine reconnects.",
        };
  }
  if (!input.configLoaded) return { phase: "loading", message: null };
  if (input.claudeRemoteControl !== true) {
    return { phase: "unsupported", message: TERMINAL_HOST_UPDATE_MESSAGE };
  }
  return { phase: "ready", message: null };
}

/** Local title filter. Session ids are unique across hosts that share a Claude login. */
export function filterTerminalSessions(
  sessions: readonly ClaudeRcSession[],
  query: string,
): readonly ClaudeRcSession[] {
  const seen = new Set<string>();
  const unique: ClaudeRcSession[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    unique.push(session);
  }
  const needle = query.trim().toLocaleLowerCase();
  const matched =
    needle.length === 0
      ? unique
      : unique.filter((session) => session.title.toLocaleLowerCase().includes(needle));
  return matched.sort(
    (left, right) =>
      Number(right.working) - Number(left.working) ||
      Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
      left.id.localeCompare(right.id),
  );
}

export function terminalSessionRelativeTime(at: string, now = Date.now()): string {
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return "";
  const minutes = Math.max(0, Math.floor((now - parsed) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1_440) return `${Math.floor(minutes / 60)}h ago`;
  return `${Math.floor(minutes / 1_440)}d ago`;
}

/** Keep the draft when the send fails. Clear it only when that same draft succeeded. */
export function composerTextAfterSend(current: string, draft: string, success: boolean): string {
  if (!success) return current;
  return current.trim() === draft ? "" : current;
}

export function terminalCommandFailure(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

export type TerminalSessionRow =
  | { readonly kind: "item"; readonly item: ClaudeRcItem }
  | { readonly kind: "tools"; readonly id: string; readonly items: readonly ClaudeRcItem[] };

/** Back-to-back tool calls form one work group, as in a chat. */
export function terminalSessionRows(items: readonly ClaudeRcItem[]): TerminalSessionRow[] {
  const rows: TerminalSessionRow[] = [];
  let tools: ClaudeRcItem[] | null = null;
  for (const item of items) {
    if (item.role !== "tool") {
      tools = null;
      rows.push({ kind: "item", item });
    } else if (tools) {
      tools.push(item);
    } else {
      tools = [item];
      rows.push({ kind: "tools", id: item.id, items: tools });
    }
  }
  return rows;
}

/** The fields a chat's work-log entry has, so both apps reuse their row labels and icons. */
export interface TerminalToolEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly label: string;
  readonly tone: "tool";
  readonly itemType: ClaudeToolItemType;
  readonly toolTitle: string;
  readonly toolData: {
    readonly toolName: string;
    readonly input: unknown;
    readonly output?: string;
  };
  readonly toolLifecycleStatus: "inProgress" | "completed" | "failed";
  readonly command?: string;
  readonly rawCommand?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly detail?: string;
  readonly toolSource?: ToolActivitySource;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const field = (value: unknown, key: string) => {
  const text = record(value)[key];
  return typeof text === "string" && text.trim() ? text.trim() : undefined;
};

/** Sessions have no workspace root to show paths against; the home folder is the long part. */
function withHomeRelativePaths(value: unknown): unknown {
  const input = record(value);
  const paths = ["file_path", "notebook_path", "path"].filter(
    (key) => typeof input[key] === "string",
  );
  if (paths.length === 0) return value;
  const shortened = { ...input };
  for (const key of paths)
    shortened[key] = (input[key] as string).replace(/^\/(?:Users|home)\/[^/]+(?=\/)/u, "~");
  return shortened;
}

/** Servers before tool pairing sent "Name\n{input}" calls and bare output as separate items. */
function legacyTool(item: ClaudeRcItem): NonNullable<ClaudeRcItem["tool"]> {
  const newline = item.text.indexOf("\n");
  if (newline > 0) {
    try {
      const input: unknown = JSON.parse(item.text.slice(newline + 1));
      if (typeof input === "object" && input !== null && !Array.isArray(input))
        return { name: item.text.slice(0, newline), input };
    } catch {
      // Output, not a call.
    }
  }
  return { name: "", output: item.text, done: true };
}

function claudeToolTitle(tool: NonNullable<ClaudeRcItem["tool"]>, input: unknown): string {
  if (tool.title) return tool.title;
  const name = tool.name;
  const normalized = name.toLowerCase().replaceAll(/[\s_-]/g, "");
  if (normalized === "agent" || normalized === "task") {
    const description = field(input, "description");
    return description ? `Subagent: ${description}` : "Subagent";
  }
  if (normalized === "todowrite") return "Updated to-do list";
  if (normalized === "toolsearch") return "Loaded tools";
  if (!name) return "Tool output";
  return dynamicToolTitle(name, input) ?? name;
}

/** Mirrors how a Claude chat's adapter and work log describe the same call. */
export function terminalToolEntry(item: ClaudeRcItem, live: boolean): TerminalToolEntry {
  const tool = item.tool ?? legacyTool(item);
  const input = withHomeRelativePaths(tool.input ?? {});
  const classification = classifyClaudeNativeTool(tool.name);
  const common = {
    ...(tool.source ? { toolSource: tool.source } : {}),
    id: item.id,
    createdAt: "",
    tone: "tool" as const,
    itemType: classification.itemType,
    toolData: {
      toolName: tool.name,
      input,
      ...(tool.output === undefined ? {} : { output: tool.output }),
    },
    toolLifecycleStatus: tool.failed
      ? ("failed" as const)
      : tool.done || !live
        ? ("completed" as const)
        : ("inProgress" as const),
  };
  switch (classification.itemType) {
    case "command_execution": {
      const command = field(input, "command");
      return {
        ...common,
        label: "Ran command",
        toolTitle: "Command",
        ...(command ? { command, rawCommand: command } : {}),
      };
    }
    case "file_change": {
      const path = field(input, "file_path") ?? field(input, "notebook_path");
      const verb = classification.normalizedName === "write" ? "Wrote" : "Edited";
      return {
        ...common,
        label: path ? `${verb} ${path}` : "Changed files",
        toolTitle: "File change",
        ...(path ? { changedFiles: [path] } : {}),
      };
    }
    case "web_search": {
      const query = field(input, "query");
      const url = field(input, "url");
      const target = query ?? url;
      // React Native's URL has no hostname, so read it directly.
      const host = url
        ? /^[a-z][a-z\d+.-]*:\/\/(?:[^@/?#]*@)?([^/?#:]+)/iu.exec(url)?.[1]?.replace(/^www\./iu, "")
        : undefined;
      const title = host
        ? `Fetched ${host}`
        : query
          ? `Searched the web for “${query}”`
          : "Web search";
      return {
        ...common,
        label: title,
        toolTitle: title,
        ...(target ? { detail: target } : {}),
      };
    }
    case "dynamic_tool": {
      const title = claudeToolTitle(tool, input);
      const classified = classifyToolActivity({
        itemType: "dynamic_tool_call",
        data: { toolName: tool.name, input },
      });
      const [readPath] = collectToolFilePaths({ input });
      return {
        ...common,
        label:
          classified === "read" && readPath
            ? formatReadToolLabel(readPath)
            : classified === "search"
              ? (formatSearchToolLabel({ input }) ?? title)
              : title,
        toolTitle: title,
      };
    }
  }
}

/** The output a row expands to, with the call itself when the label does not already show it. */
export function terminalToolDetails(item: ClaudeRcItem, label: string): string | null {
  const tool = item.tool ?? legacyTool(item);
  const parts: string[] = [];
  const input = record(withHomeRelativePaths(tool.input));
  const command = field(input, "command");
  if (command && command !== label.trim()) parts.push(command);
  // Reads and searches are named by their label; other tools show what they were given.
  const activity = classifyToolActivity({
    itemType: "dynamic_tool_call",
    data: { toolName: tool.name, input },
  });
  if (
    !command &&
    Object.keys(input).length > 0 &&
    classifyClaudeNativeTool(tool.name).itemType === "dynamic_tool" &&
    activity !== "read" &&
    activity !== "search"
  )
    parts.push(JSON.stringify(input, null, 2));
  const output = tool.output?.trim();
  if (output) parts.push(output);
  return parts.length > 0 ? parts.join("\n\n") : null;
}
