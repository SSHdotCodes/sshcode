// @effect-diagnostics nodeBuiltinImport:off -- Transcript reducer initialization is synchronous.
import * as NodePath from "node:path";

import type { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

const KimiState = Schema.Struct({ sessionId: Schema.String });
const Entry = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("usage.record"),
    agentId: Schema.String,
    model: Schema.NonEmptyString,
    time: Schema.Finite,
    usage: Schema.Struct({
      inputOther: Schema.optional(Schema.Unknown),
      output: Schema.optional(Schema.Unknown),
      inputCacheRead: Schema.optional(Schema.Unknown),
      inputCacheCreation: Schema.optional(Schema.Unknown),
    }),
  }),
  Schema.Struct({
    timestamp: Schema.Finite,
    message: Schema.Struct({
      type: Schema.Literal("StatusUpdate"),
      payload: Schema.Struct({
        message_id: Schema.NonEmptyString,
        token_usage: Schema.Struct({
          input_other: Schema.optional(Schema.Unknown),
          output: Schema.optional(Schema.Unknown),
          input_cache_read: Schema.optional(Schema.Unknown),
          input_cache_creation: Schema.optional(Schema.Unknown),
        }),
      }),
    }),
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown, state: typeof KimiState.Type): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  const current = "usage" in entry;
  const usage = current ? entry.usage : entry.message.payload.token_usage;
  const timestampMs = current ? entry.time : Math.trunc(entry.timestamp * 1_000);
  if (timestampMs <= 0) return [];
  // inputOther, cache read and cache creation are disjoint counters in both wire versions.
  const totals = {
    uncachedInputTokens: tokenCount(
      "inputOther" in usage ? usage.inputOther : "input_other" in usage ? usage.input_other : 0,
    ),
    cachedInputTokens: tokenCount(
      "inputCacheRead" in usage
        ? usage.inputCacheRead
        : "input_cache_read" in usage
          ? usage.input_cache_read
          : 0,
    ),
    cacheCreationTokens: tokenCount(
      "inputCacheCreation" in usage
        ? usage.inputCacheCreation
        : "input_cache_creation" in usage
          ? usage.input_cache_creation
          : 0,
    ),
    outputTokens: tokenCount(usage.output),
    reasoningTokens: 0,
  };
  if (totalTokens(totals) === 0) return [];
  // The old wire never persisted a model. Today's config cannot identify a historical call.
  const model = current ? entry.model : "Kimi Code (model unknown)";
  return [
    {
      provider: "kimi",
      timestampMs,
      model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: JSON.stringify(
        current
          ? ["kimi", state.sessionId, entry.agentId, entry.time, entry.model, totals]
          : ["kimi", entry.message.payload.message_id],
      ),
    },
  ];
}

export const kimiUsageFormat: TranscriptUsageFormat<typeof KimiState.Type> = {
  selectFields: {
    type: true,
    agentId: true,
    model: true,
    time: true,
    usage: true,
    timestamp: true,
    message: { type: true, payload: { message_id: true, token_usage: true } },
  },
  usageMarkers: ['"usage.record"', '"StatusUpdate"'],
  parseLine: (line, state) => {
    try {
      return parseRecord(JSON.parse(line), state);
    } catch {
      return [];
    }
  },
  parseProjected: parseRecord,
  state: {
    initial: (filePath) => {
      const dir = NodePath.dirname(filePath);
      const sessionDir =
        NodePath.basename(NodePath.dirname(dir)) === "agents"
          ? NodePath.resolve(dir, "..", "..")
          : dir;
      return { sessionId: NodePath.basename(sessionDir) };
    },
    schema: KimiState,
  },
};

export const kimiUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "kimi",
  format: kimiUsageFormat,
  directories: Effect.fn("kimiUsageReader.directories")(function* ({ config, environment }) {
    if (config?.agentId !== "kimi") return [];
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const kimiHome = environment.KIMI_SHARE_DIR?.trim() || environment.KIMI_CODE_HOME?.trim();
    return [
      {
        dir: path.resolve(
          kimiHome ? expandHomePath(kimiHome, home) : path.join(home, ".kimi"),
          "sessions",
        ),
        fileName: "wire.jsonl",
      },
    ];
  }),
};
