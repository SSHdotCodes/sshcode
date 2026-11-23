import type { OrchestrationV2TurnItem, ProviderRequestKind } from "@t3tools/contracts";

/** Claude Code's own tools, shared by the chat adapter and Remote Control sessions. */
export type ClaudeToolItemType = Extract<
  OrchestrationV2TurnItem["type"],
  "command_execution" | "file_change" | "dynamic_tool" | "web_search"
>;

export interface ClaudeToolClassification {
  readonly known: boolean;
  readonly normalizedName: string;
  readonly itemType: ClaudeToolItemType;
  readonly requestKind: ProviderRequestKind;
}

function normalizedClaudeToolName(toolName: string): string {
  return toolName.toLowerCase().replaceAll(/[\s_-]/g, "");
}

const CLAUDE_KNOWN_TOOL_CLASSIFICATIONS: Record<
  string,
  {
    readonly itemType: ClaudeToolItemType;
    readonly requestKind: ProviderRequestKind;
  }
> = {
  agent: { itemType: "dynamic_tool", requestKind: "command" },
  bash: { itemType: "command_execution", requestKind: "command" },
  edit: { itemType: "file_change", requestKind: "file-change" },
  glob: { itemType: "dynamic_tool", requestKind: "file-read" },
  grep: { itemType: "dynamic_tool", requestKind: "file-read" },
  ls: { itemType: "dynamic_tool", requestKind: "file-read" },
  monitor: { itemType: "dynamic_tool", requestKind: "command" },
  multiedit: { itemType: "file_change", requestKind: "file-change" },
  notebookedit: { itemType: "file_change", requestKind: "file-change" },
  read: { itemType: "dynamic_tool", requestKind: "file-read" },
  sendmessage: { itemType: "dynamic_tool", requestKind: "command" },
  task: { itemType: "dynamic_tool", requestKind: "command" },
  taskstop: { itemType: "dynamic_tool", requestKind: "command" },
  todowrite: { itemType: "dynamic_tool", requestKind: "command" },
  toolsearch: { itemType: "dynamic_tool", requestKind: "command" },
  webfetch: { itemType: "web_search", requestKind: "command" },
  websearch: { itemType: "web_search", requestKind: "command" },
  write: { itemType: "file_change", requestKind: "file-change" },
};

export function classifyClaudeNativeTool(toolName: string): ClaudeToolClassification {
  const normalizedName = normalizedClaudeToolName(toolName);
  const known = CLAUDE_KNOWN_TOOL_CLASSIFICATIONS[normalizedName];
  return known === undefined
    ? {
        known: false,
        normalizedName,
        itemType: "dynamic_tool",
        requestKind: "command",
      }
    : {
        known: true,
        normalizedName,
        ...known,
      };
}
