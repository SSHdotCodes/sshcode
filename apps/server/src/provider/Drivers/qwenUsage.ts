/** Qwen's chat requests are authoritative; usage_record.jsonl repeats session totals. */
import type { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
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

const Request = Schema.Struct({
  type: Schema.Literal("assistant"),
  uuid: Schema.NonEmptyString,
  sessionId: Schema.NonEmptyString,
  timestamp: Schema.String,
  model: Schema.NonEmptyString,
  usageMetadata: Schema.Struct({
    promptTokenCount: Schema.optional(Schema.Unknown),
    cachedContentTokenCount: Schema.optional(Schema.Unknown),
    candidatesTokenCount: Schema.optional(Schema.Unknown),
    thoughtsTokenCount: Schema.optional(Schema.Unknown),
  }),
});
const decodeRequest = Schema.decodeUnknownOption(Request);

function parseRecord(parsed: unknown): readonly UsageRecord[] {
  const decoded = decodeRequest(parsed);
  if (Option.isNone(decoded)) return [];
  const request = decoded.value;
  const timestampMs = parseTimestampMs(request.timestamp);
  if (timestampMs === null) return [];
  const usage = request.usageMetadata;
  const input = tokenCount(usage.promptTokenCount);
  const cachedInputTokens = Math.min(input, tokenCount(usage.cachedContentTokenCount));
  const reasoningTokens = tokenCount(usage.thoughtsTokenCount);
  const totals = {
    uncachedInputTokens: input - cachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens: 0,
    outputTokens: tokenCount(usage.candidatesTokenCount) + reasoningTokens,
    reasoningTokens,
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "qwen-code",
      timestampMs,
      model: request.model,
      sessionId: request.sessionId,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      // A resumed or forked chat can copy the request under another session id.
      dedupeKey: JSON.stringify(["qwen-code", request.uuid]),
    },
  ];
}

export const qwenUsageFormat: TranscriptUsageFormat<unknown> = {
  selectFields: {
    type: true,
    uuid: true,
    sessionId: true,
    timestamp: true,
    model: true,
    usageMetadata: true,
  },
  usageMarkers: ['"usageMetadata"'],
  parseLine: (line) => {
    try {
      return parseRecord(JSON.parse(line));
    } catch {
      return [];
    }
  },
  parseProjected: parseRecord,
};

export const qwenUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "qwen-code",
  format: qwenUsageFormat,
  directories: Effect.fn("qwenUsageReader.directories")(function* ({ config, environment }) {
    if (config?.agentId !== "qwen-code") return [];
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const qwenHome = environment.QWEN_HOME?.trim();
    return [
      {
        dir: path.resolve(
          qwenHome ? expandHomePath(qwenHome, home) : path.join(home, ".qwen"),
          "projects",
        ),
      },
    ];
  }),
};
