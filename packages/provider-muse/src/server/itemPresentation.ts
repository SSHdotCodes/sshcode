import type {
  OrchestrationV2FileChangeDetail,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemStatus,
} from "@t3tools/contracts";
import { workspaceRelativeFilePath } from "@t3tools/shared/path";
import { resolveT3McpDispatch } from "@t3tools/shared/t3McpToolPresentation";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { MuseItem } from "./protocol.ts";

const decodeToolArgs = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);
/** Muse's `web_search` tool output: the query and its hits, as JSON. */
const decodeWebSearchOutput = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      results: Schema.Array(
        Schema.Struct({
          url: Schema.optional(Schema.String),
          title: Schema.optional(Schema.String),
          snippet: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
);

const patchCoordinate = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const decodePatch = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      files: Schema.Array(
        Schema.Struct({
          path: Schema.String.check(Schema.isMinLength(1)),
          hunks: Schema.Array(
            Schema.Struct({
              oldStart: patchCoordinate,
              oldLines: patchCoordinate,
              newStart: patchCoordinate,
              newLines: patchCoordinate,
              lines: Schema.Array(Schema.String),
            }),
          ),
        }),
      ),
    }),
  ),
);

type Fields<
  T extends OrchestrationV2TurnItem["type"],
  K extends keyof Extract<OrchestrationV2TurnItem, { type: T }>,
> = Pick<Extract<OrchestrationV2TurnItem, { type: T }>, K>;
type MuseToolPresentation = {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly title: string | null;
} & (
  | Fields<"command_execution", "type" | "input" | "output" | "exitCode">
  | Fields<
      "file_change",
      "type" | "fileName" | "oldStr" | "newStr" | "diffStr" | "additions" | "deletions" | "changes"
    >
  | Fields<"web_search", "type" | "patterns" | "results">
  | Fields<"dynamic_tool", "type" | "toolName" | "input" | "output">
);

/** Converts the stored native hunks to the same unified diff used by other providers. */
export function museFilePatch(content: string, workspaceRoot: string) {
  const patch = Option.getOrUndefined(decodePatch(content));
  if (patch === undefined) return undefined;
  let additions = 0;
  let deletions = 0;
  const changes: OrchestrationV2FileChangeDetail[] = [];
  const files = patch.files.flatMap(({ path, hunks }) => {
    if (path.trim().length === 0 || hunks.length === 0) return [];
    const filePath = workspaceRelativeFilePath(path, workspaceRoot) ?? path;
    changes.push({ operation: "modify", path: filePath });
    const before = JSON.stringify(`a/${filePath}`);
    const after = JSON.stringify(`b/${filePath}`);
    const lines = [`diff --git ${before} ${after}`, `--- ${before}`, `+++ ${after}`];
    for (const hunk of hunks) {
      lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
      for (const line of hunk.lines) {
        if (line.startsWith("+")) additions++;
        if (line.startsWith("-")) deletions++;
        lines.push(line);
      }
    }
    return [lines.join("\n")];
  });
  const fileName = changes[0]?.path;
  if (fileName === undefined) return undefined;
  return { fileName, diffStr: `${files.join("\n")}\n`, additions, deletions, changes };
}

/** Unrecognized native terminal states must not appear as successful work. */
export function museItemStatus(item: MuseItem): OrchestrationV2TurnItemStatus {
  if (item.status === "inProgress") return "running";
  if (item.status === "cancelled") return "cancelled";
  if (
    item.status === "completed" &&
    !(item.kind === "compaction" && item.outcome && item.outcome !== "compacted")
  )
    return "completed";
  return "failed";
}

/** Converts native tool details into the shared timeline fields used by every client. */
export function museToolPresentation(
  item: MuseItem,
  status = museItemStatus(item),
  nativePatch?: ReturnType<typeof museFilePatch>,
): MuseToolPresentation {
  let args: Record<string, unknown> | undefined;
  if (item.args) {
    try {
      args = decodeToolArgs(item.args);
    } catch {
      // Streaming model-authored arguments may not be valid JSON yet.
    }
  }
  const stringArg = (...keys: string[]) => {
    for (const key of keys) {
      const value = args?.[key];
      if (typeof value === "string") return value;
    }
    return undefined;
  };
  const toolName = item.tool ?? item.kind;
  const dispatched = item.kind === "toolCall" ? resolveT3McpDispatch(toolName, args) : undefined;
  if (dispatched) {
    return {
      status,
      title: dispatched.lookup ? `Look up ${dispatched.tool} schema` : null,
      type: "dynamic_tool",
      toolName: `t3-code.${dispatched.tool}`,
      input: dispatched.input,
      output: item.visibleOutput ?? item.result?.summary ?? item.failureReason ?? "",
    };
  }
  const title =
    item.kind === "subagent"
      ? item.objective || item.role || "Muse agent"
      : item.kind === "workflow"
        ? item.entryId || "Workflow"
        : toolName;
  const detail =
    status === "failed" ? item.failureReason || `Muse reported ${item.status}.` : undefined;
  const shared = { status, title: detail ? `${title}: ${detail}` : title };
  if (nativePatch !== undefined) {
    return { ...shared, type: "file_change", ...nativePatch };
  }
  const text =
    item.visibleOutput ??
    item.result?.summary ??
    item.text ??
    item.summary?.join("\n") ??
    item.finalSummary ??
    item.fallbackText ??
    item.objective ??
    "";
  const output = detail ? [detail, text].filter(Boolean).join("\n") : text;

  if (item.kind === "userShell" || /shell|bash|exec_command/i.test(item.tool ?? "")) {
    return {
      ...shared,
      type: "command_execution",
      input: item.commandText ?? stringArg("command", "cmd") ?? item.args ?? "",
      output,
      ...(item.exitCode === undefined ? {} : { exitCode: item.exitCode }),
    };
  }
  if (item.kind === "toolCall" && /write|edit|patch/i.test(toolName)) {
    const fileName = stringArg("file_path", "path", "filePath")?.trim();
    if (fileName) {
      const oldStr = stringArg("old_string", "old_str", "oldStr", "oldText");
      const newStr = stringArg("new_string", "new_str", "newStr", "newText", "content");
      const diffStr = stringArg("diff", "patch", "diffStr");
      return {
        ...shared,
        type: "file_change",
        fileName,
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
        ...(diffStr === undefined ? {} : { diffStr }),
      };
    }
  }
  if (item.kind === "toolCall" && /web|browse|fetch/i.test(toolName)) {
    const query = stringArg("query", "url", "pattern")?.trim();
    const pageUrl = stringArg("url")?.trim();
    // A search lists its hits; a page fetch (or a failure) shows its text under the page's link.
    const hits =
      item.tool === "web_search" && !detail
        ? Option.getOrUndefined(decodeWebSearchOutput(text))?.results.map(
            ({ url, title, snippet }) => ({
              ...(url?.trim() ? { url: url.trim() } : {}),
              ...(title?.trim() ? { title: title.trim() } : {}),
              ...(snippet ? { snippet } : {}),
            }),
          )
        : undefined;
    const results =
      hits ?? (output ? [{ ...(pageUrl ? { url: pageUrl } : {}), snippet: output }] : []);
    return {
      ...shared,
      type: "web_search",
      ...(query ? { patterns: [query] } : {}),
      ...(results.length ? { results } : {}),
    };
  }
  return {
    ...shared,
    type: "dynamic_tool",
    toolName,
    input: args ?? item.args ?? "",
    output,
  };
}
