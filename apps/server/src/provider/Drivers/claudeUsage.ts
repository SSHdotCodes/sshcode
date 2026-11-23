/**
 * Usage history for Claude Code: the transcript format of its
 * `<home>/projects/**.jsonl` session files and where each instance keeps them.
 *
 * @module provider/Drivers/claudeUsage
 */

import type { ClaudeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Parses one line of a Claude Code transcript.
 *
 * SSHCode writes one record per assistant *content block*, and every one of
 * those records repeats the same complete `usage` object for the parent
 * message. Summing them overcounts by roughly 2.4x on a real workload, so the
 * caller must drop repeats by `dedupeKey` and keep the first.
 */
export function parseClaudeLine(line: string): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseClaudeRecord(parsed);
}

function parseClaudeRecord(parsed: unknown): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  if (record["type"] !== "assistant") return null;

  const message = record["message"];
  if (typeof message !== "object" || message === null) return null;
  const messageRecord = message as Record<string, unknown>;

  const usage = messageRecord["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const usageRecord = usage as Record<string, unknown>;

  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;

  const model = typeof messageRecord["model"] === "string" ? messageRecord["model"] : "";
  if (model.length === 0) return null;

  const messageId = typeof messageRecord["id"] === "string" ? messageRecord["id"] : null;
  const requestId = typeof record["requestId"] === "string" ? record["requestId"] : null;
  // Matches ccusage: prefer the message/request pair, fall back to whichever
  // half exists. Records with neither cannot be de-duplicated.
  const dedupeKey =
    messageId === null && requestId === null ? null : `${messageId ?? ""}:${requestId ?? ""}`;

  const cost = record["costUSD"];

  return {
    provider: "claude",
    timestampMs,
    model,
    sessionId: typeof record["sessionId"] === "string" ? record["sessionId"] : "",
    totals: {
      uncachedInputTokens: tokenCount(usageRecord["input_tokens"]),
      cachedInputTokens: tokenCount(usageRecord["cache_read_input_tokens"]),
      cacheCreationTokens: tokenCount(usageRecord["cache_creation_input_tokens"]),
      outputTokens: tokenCount(usageRecord["output_tokens"]),
      // Anthropic folds thinking tokens into output and does not break them out.
      reasoningTokens: 0,
    },
    reportedCostUsd: typeof cost === "number" && Number.isFinite(cost) ? cost : null,
    speed: usageRecord["speed"] === "fast" ? "fast" : "standard",
    dedupeKey,
  };
}

// Bound the resume state even for very long sessions. An evicted parent makes
// that response untimed; file adjacency is never a fallback for missing links.
const MAX_TIMING_LINKS = 64;
const ClaudeScanState = Schema.Struct({
  links: Schema.Record(
    Schema.String,
    Schema.mutableKey(Schema.Tuple([Schema.NullOr(Schema.Finite), Schema.NullOr(Schema.String)])),
  ),
  order: Schema.mutable(Schema.Array(Schema.String)),
});
type ClaudeScanState = typeof ClaudeScanState.Type;

function remember(state: ClaudeScanState, key: string, value: ClaudeScanState["links"][string]) {
  if (state.links[key] === undefined) state.order.push(key);
  state.links[key] = value;
  if (state.order.length > MAX_TIMING_LINKS) delete state.links[state.order.shift()!];
}

function parseTimedClaudeRecord(parsed: unknown, state: ClaudeScanState): readonly UsageRecord[] {
  if (typeof parsed !== "object" || parsed === null) return [];
  const row = parsed as Record<string, unknown>;
  const parent =
    typeof row.parentUuid === "string" ? state.links[`u:${row.parentUuid}`] : undefined;
  const record = parseClaudeRecord(parsed);
  let link: ClaudeScanState["links"][string] = [null, null];
  if (row.type === "user") {
    link = [parseTimestampMs(row.timestamp), null];
  } else if (row.type === "attachment") {
    // Attachments can sit between the user/tool result and the assistant.
    link = parent ?? link;
  } else if (record !== null) {
    const key = record.dedupeKey;
    const previous = key === null ? undefined : state.links[`m:${key}`];
    const startMs =
      previous !== undefined
        ? previous[0]
        : parent !== undefined && (parent[1] === null || parent[1] === key)
          ? parent[0]
          : null;
    link = previous ?? [startMs, key ?? ""];
    if (key !== null && previous === undefined) remember(state, `m:${key}`, link);
  }
  if (typeof row.uuid === "string") remember(state, `u:${row.uuid}`, link);
  if (record === null) return [];
  return [
    link[0] === null
      ? record
      : {
          ...record,
          responseTiming: { startMs: link[0], endMs: record.timestampMs },
        },
  ];
}

export const claudeUsageFormat: TranscriptUsageFormat<ClaudeScanState> = {
  // Keeps only link/usage metadata on oversized lines, never tool bodies.
  selectFields: {
    type: true,
    timestamp: true,
    uuid: true,
    parentUuid: true,
    requestId: true,
    sessionId: true,
    costUSD: true,
    message: { id: true, model: true, usage: true },
  },
  usageMarkers: ['"usage"'],
  metadataMarkers: ['"parentUuid"', '"uuid"'],
  parseLine: (line, state) => {
    try {
      return parseTimedClaudeRecord(JSON.parse(line), state);
    } catch {
      return [];
    }
  },
  parseProjected: parseTimedClaudeRecord,
  state: { initial: () => ({ links: {}, order: [] }), schema: ClaudeScanState },
};

export const claudeUsageReader: ProviderUsageReader<ClaudeSettings, Path.Path> = {
  kind: "transcripts",
  provider: "claude",
  format: claudeUsageFormat,
  directories: Effect.fn("claudeUsageReader.directories")(function* ({ config, environment }) {
    // An undecodable config has no trustworthy home to read.
    if (config === undefined) return [];
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const configured = config.homePath.trim();
    const home = configured
      ? expandHomePath(configured, homeDirectory)
      : environment.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDirectory, ".claude");
    return [{ dir: path.resolve(home, "projects") }];
  }),
};
