/**
 * Usage history for Codex: the rollout format of `<home>/sessions/**.jsonl`
 * and where each instance's shared home keeps them.
 *
 * Codex compresses an idle rollout in place to `.jsonl.zst`, and archiving a
 * thread moves its rollout to `<home>/archived_sessions`, where it is later
 * compressed and eventually deleted. Both keep the file's mtime, and the
 * rollout's file name keeps its session id, which the scan cache uses to
 * carry a rollout's saved usage to its new path.
 *
 * @module provider/Drivers/codexUsage
 */
import type { CodexSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
  type UsageSpeed,
} from "@t3tools/provider-core/server/usage";
import type { UsageTokenTotals } from "@t3tools/contracts";

import { resolveCodexHomeLayout } from "./CodexHomeLayout.ts";

/**
 * Rolling state for a single Codex rollout file.
 *
 * Codex `token_count` events carry no model or service tier, so both are
 * carried forward: the model from the most recent `turn_context`, the tier from
 * the most recent `thread_settings_applied`. Sessions that switch either
 * mid-run attribute correctly from the switch onward.
 *
 * Persisted in the scan cache at each resume point. The field order is the
 * stored JSON's, so keep it stable.
 */
export const CodexScanState = Schema.Struct({
  model: Schema.mutableKey(Schema.String),
  triggerMs: Schema.mutableKey(Schema.NullOr(Schema.Finite)),
  responseStartMs: Schema.mutableKey(Schema.NullOr(Schema.Finite)),
  responseEndMs: Schema.mutableKey(Schema.NullOr(Schema.Finite)),
  speed: Schema.mutableKey(Schema.Literals(["standard", "fast", "ultrafast"])),
  sessionId: Schema.mutableKey(Schema.String),
  lastUsageSignature: Schema.mutableKey(Schema.NullOr(Schema.String)),
  sawSessionMeta: Schema.mutableKey(Schema.Boolean),
  /** While true, leading usage events are re-stamped copies of parent history. */
  suppressingForkCopies: Schema.mutableKey(Schema.Boolean),
  forkCopyAnchorMs: Schema.mutableKey(Schema.Finite),
});
export type CodexScanState = typeof CodexScanState.Type;

export function initialCodexScanState(): CodexScanState {
  return {
    model: "",
    triggerMs: null,
    responseStartMs: null,
    responseEndMs: null,
    speed: "standard",
    sessionId: "",
    lastUsageSignature: null,
    sawSessionMeta: false,
    suppressingForkCopies: false,
    forkCopyAnchorMs: 0,
  };
}

/**
 * A forked or subagent rollout opens with the parent's full history copied in,
 * every line re-stamped to the fork instant. Those copies are written in one
 * synchronous burst (observed gaps 0-40ms), while the child's first genuine
 * usage event only lands after a real model turn (observed 5s+). One second of
 * separation splits the two cleanly; `ccusage` uses the same threshold.
 */
const FORK_COPY_MAX_GAP_MS = 1000;

/** Whether a `session_meta` payload marks the rollout as a fork or subagent. */
function isForkedSessionMeta(payload: Record<string, unknown>): boolean {
  if (typeof payload["forked_from_id"] === "string") return true;
  const source = payload["source"];
  if (typeof source !== "object" || source === null) return false;
  const subagent = (source as Record<string, unknown>)["subagent"];
  if (typeof subagent !== "object" || subagent === null) return false;
  const spawn = (subagent as Record<string, unknown>)["thread_spawn"];
  if (typeof spawn !== "object" || spawn === null) return false;
  return typeof (spawn as Record<string, unknown>)["parent_thread_id"] === "string";
}

/**
 * Feeds one line of a Codex rollout into `state`, returning a record when the
 * line was a usage event.
 *
 * Deltas come from `last_token_usage`. Summing those across a session
 * reconciles with the session's final `total_token_usage`, provided
 * consecutive duplicate events are dropped, which this does.
 */
export function parseCodexLine(line: string, state: CodexScanState): UsageRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  return parseCodexRecord(parsed, state);
}

function parseCodexRecord(parsed: unknown, state: CodexScanState): UsageRecord | null {
  if (typeof parsed !== "object" || parsed === null) return null;

  const record = parsed as Record<string, unknown>;
  const payload = record["payload"];
  if (typeof payload !== "object" || payload === null) return null;
  const payloadRecord = payload as Record<string, unknown>;
  const payloadType = payloadRecord["type"];

  if (record["type"] === "session_meta") {
    // Only the first meta describes this file's own session. A forked rollout
    // repeats the ancestors' metas right after it; letting those through would
    // reassign every subsequent record to an ancestor session.
    if (state.sawSessionMeta) return null;
    state.sawSessionMeta = true;
    const id = payloadRecord["id"] ?? payloadRecord["session_id"];
    if (typeof id === "string") state.sessionId = id;
    const metaTimestampMs = parseTimestampMs(record["timestamp"]);
    if (metaTimestampMs !== null && isForkedSessionMeta(payloadRecord)) {
      state.suppressingForkCopies = true;
      state.forkCopyAnchorMs = metaTimestampMs;
    }
    return null;
  }

  if (record["type"] === "turn_context") {
    if (typeof payloadRecord["model"] === "string") state.model = payloadRecord["model"];
    return null;
  }

  if (payloadType === "thread_settings_applied") {
    const settings = payloadRecord["thread_settings"];
    if (typeof settings === "object" && settings !== null) {
      state.speed = codexSpeed((settings as Record<string, unknown>)["service_tier"]);
    }
    return null;
  }

  if (record["type"] === "response_item") {
    const timestampMs = parseTimestampMs(record["timestamp"]);
    // Re-stamped fork history cannot establish a request boundary.
    if (
      state.suppressingForkCopies &&
      timestampMs !== null &&
      timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS
    ) {
      state.triggerMs = null;
      state.responseStartMs = null;
      state.responseEndMs = null;
      return null;
    }
    if (
      (payloadType === "message" && payloadRecord["role"] === "user") ||
      payloadType === "function_call_output" ||
      payloadType === "custom_tool_call_output"
    ) {
      state.triggerMs = timestampMs;
    } else if (
      payloadType === "reasoning" ||
      payloadType === "function_call" ||
      payloadType === "custom_tool_call" ||
      (payloadType === "message" && payloadRecord["role"] === "assistant")
    ) {
      if (state.responseEndMs === null) {
        state.responseStartMs = state.triggerMs;
        state.triggerMs = null;
      }
      state.responseEndMs = timestampMs;
    }
    return null;
  }
  if (record["type"] === "event_msg" && payloadType === "user_message") {
    const threadId = payloadRecord["thread_id"];
    if (typeof threadId === "string" && state.sessionId !== "" && threadId !== state.sessionId)
      return null;
    const timestampMs = parseTimestampMs(record["timestamp"]);
    state.triggerMs =
      state.suppressingForkCopies &&
      timestampMs !== null &&
      timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS
        ? null
        : timestampMs;
    return null;
  }

  if (payloadType !== "token_count") return null;

  const info = payloadRecord["info"];
  if (typeof info !== "object" || info === null) return null;
  const last = (info as Record<string, unknown>)["last_token_usage"];
  if (typeof last !== "object" || last === null) return null;
  const lastRecord = last as Record<string, unknown>;

  // Only an event that is otherwise eligible may consume the duplicate
  // signature. A token_count arriving before its turn_context (no model yet)
  // must not poison it, or the re-emitted copy after the model is known would
  // be skipped as a duplicate and those tokens never counted.
  const timestampMs = parseTimestampMs(record["timestamp"]);
  if (timestampMs === null) return null;
  if (state.model.length === 0) return null;

  // Codex re-emits an unchanged token_count on some stream boundaries. Summing
  // those would double count, so identical consecutive payloads are skipped.
  const signature = JSON.stringify(lastRecord);
  if (signature === state.lastUsageSignature) {
    // An identical payload cannot tell a replay from an equal new response.
    // Do not let an ambiguous completion stretch the next measured response.
    state.responseStartMs = null;
    state.responseEndMs = null;
    return null;
  }
  state.lastUsageSignature = signature;

  // In a forked rollout the copied parent history was already counted from the
  // parent's own file. Drop the leading burst; the first usage event separated
  // from its predecessor by a real turn's worth of time ends it for good.
  if (state.suppressingForkCopies) {
    if (timestampMs - state.forkCopyAnchorMs < FORK_COPY_MAX_GAP_MS) {
      state.forkCopyAnchorMs = timestampMs;
      return null;
    }
    state.suppressingForkCopies = false;
  }

  // token_count may land AFTER tools have run. The response item's own
  // timestamp closes the measured interval; the tool output triggers the next.
  const responseTiming =
    state.responseStartMs !== null && state.responseEndMs !== null
      ? { startMs: state.responseStartMs, endMs: state.responseEndMs }
      : undefined;
  state.responseStartMs = null;
  state.responseEndMs = null;

  const inputTokens = tokenCount(lastRecord["input_tokens"]);
  const cachedInputTokens = tokenCount(lastRecord["cached_input_tokens"]);
  const cacheCreationTokens = tokenCount(lastRecord["cache_write_input_tokens"]);
  const outputTokens = tokenCount(lastRecord["output_tokens"]);

  const totals: UsageTokenTotals = {
    // Codex reports `input_tokens` inclusive of the cached portion.
    uncachedInputTokens: Math.max(0, inputTokens - cachedInputTokens - cacheCreationTokens),
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    // Reported inside output_tokens, surfaced separately for the token mix.
    reasoningTokens: Math.min(outputTokens, tokenCount(lastRecord["reasoning_output_tokens"])),
  };

  if (totalTokens(totals) === 0) return null;

  return {
    provider: "codex",
    timestampMs,
    model: state.model,
    sessionId: state.sessionId,
    totals,
    // Codex does not report cost in the rollout.
    reportedCostUsd: null,
    speed: state.speed,
    ...(responseTiming === undefined ? {} : { responseTiming }),
    // Events surviving the fork-copy suppression above are unique to this
    // rollout, so they need no global dedup.
    dedupeKey: null,
  };
}

/**
 * Maps a Codex `service_tier` to its billing speed. Codex omits the field when
 * no tier was requested, which bills as standard, as do `default` and
 * `standard`. `fast` is accepted as an alias of `priority`.
 */
function codexSpeed(serviceTier: unknown): UsageSpeed {
  if (serviceTier === "priority" || serviceTier === "fast") return "fast";
  if (serviceTier === "ultrafast") return "ultrafast";
  return "standard";
}

const orEmpty = (record: UsageRecord | null): readonly UsageRecord[] =>
  record === null ? [] : [record];

const ROLLOUT_IDENTITY =
  /(?:^|[\\/])rollout-[^\\/]*?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

/** The session id in a rollout's file name, which survives archiving and compression. */
export function codexRolloutIdentity(filePath: string): string | undefined {
  return ROLLOUT_IDENTITY.exec(filePath)?.[1]?.toLowerCase();
}

export const codexUsageFormat: TranscriptUsageFormat<CodexScanState> = {
  // Keeps the fields the reducer reads as well as the usage itself.
  selectFields: {
    type: true,
    timestamp: true,
    payload: {
      type: true,
      role: true,
      thread_id: true,
      id: true,
      session_id: true,
      model: true,
      thread_settings: { service_tier: true },
      forked_from_id: true,
      source: { subagent: { thread_spawn: { parent_thread_id: true } } },
      info: { last_token_usage: true },
    },
  },
  // `turn_context`, `thread_settings_applied` and `session_meta` lines hold no
  // usage, but they carry the model, tier and session the reducer needs.
  usageMarkers: ['"token_count"', '"turn_context"', '"thread_settings_applied"', '"session_meta"'],
  metadataMarkers: ['"response_item"', '"user_message"'],
  parseLine: (line, state) => orEmpty(parseCodexLine(line, state)),
  parseProjected: (projected, state) => orEmpty(parseCodexRecord(projected, state)),
  state: { initial: initialCodexScanState, schema: CodexScanState },
  fileIdentity: codexRolloutIdentity,
  // A rollout can briefly exist both plain and compressed, or in both homes.
  sharedSessionsAcrossFiles: true,
};

export const codexUsageReader: ProviderUsageReader<CodexSettings, Path.Path> = {
  kind: "transcripts",
  provider: "codex",
  format: codexUsageFormat,
  directories: Effect.fn("codexUsageReader.directories")(function* ({ config, environment }) {
    // An undecodable config has no trustworthy home to read.
    if (config === undefined) return [];
    const path = yield* Path.Path;
    const environmentHome = environment.CODEX_HOME?.trim();
    const layout = yield* resolveCodexHomeLayout(
      config.setupMode !== "managed" &&
        !config.homePath.trim() &&
        !config.shadowHomePath.trim() &&
        environmentHome
        ? { ...config, homePath: environmentHome }
        : config,
    );
    return [
      { dir: path.resolve(layout.sharedHomePath, "sessions") },
      { dir: path.resolve(layout.sharedHomePath, "archived_sessions") },
    ];
  }),
};
