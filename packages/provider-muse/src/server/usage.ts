/** Native Muse model-call usage, including subagents and approval reviews. */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import type { MuseSettings } from "../settings.ts";

const Entry = Schema.Struct({
  record_type: Schema.Literal("event"),
  payload_type: Schema.Literal("runtime.session"),
  recorded_at: Schema.Finite,
  stream: Schema.Struct({ id: Schema.NonEmptyString }),
  payload: Schema.Struct({
    kind: Schema.Literal("run"),
    event: Schema.Struct({
      kind: Schema.Literal("model_completed"),
      // Approval-review streams omit the model, but still incur token usage.
      model: Schema.optional(Schema.NullOr(Schema.NonEmptyString)),
      usage: Schema.Struct({
        input_tokens: Schema.optional(Schema.Unknown),
        output_tokens: Schema.optional(Schema.Unknown),
        cached_tokens: Schema.optional(Schema.Unknown),
        cache_read_tokens: Schema.optional(Schema.Unknown),
        cache_write_tokens: Schema.optional(Schema.Unknown),
        reasoning_tokens: Schema.optional(Schema.Unknown),
      }),
    }),
  }),
});
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.recorded_at <= 0) return [];
  const event = entry.payload.event;
  const usage = event.usage;
  const inputTokens = tokenCount(usage.input_tokens);
  // Muse's cached_tokens aliases cache_read_tokens; both are included in input.
  const cachedInputTokens = Math.min(
    inputTokens,
    tokenCount(usage.cache_read_tokens ?? usage.cached_tokens),
  );
  const cacheCreationTokens = Math.min(
    inputTokens - cachedInputTokens,
    tokenCount(usage.cache_write_tokens),
  );
  const outputTokens = tokenCount(usage.output_tokens);
  const totals = {
    uncachedInputTokens: inputTokens - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoning_tokens)),
  };
  if (totalTokens(totals) === 0) return [];
  return [
    {
      provider: "muse",
      timestampMs: Math.trunc(entry.recorded_at / 1_000),
      model: event.model ?? "muse",
      // Resellers list Muse models too, at other rates; Meta's own are the reference.
      ...(event.model ? { rateModel: `meta/${event.model}` } : {}),
      sessionId: entry.stream.id,
      totals,
      reportedCostUsd: null,
      speed: "standard",
      // Parent, fork and subagent logs have distinct records and stream IDs.
      dedupeKey: null,
    },
  ];
}

export const museUsageFormat: TranscriptUsageFormat<unknown> = {
  selectFields: {
    record_type: true,
    payload_type: true,
    recorded_at: true,
    stream: { id: true },
    payload: { kind: true, event: { kind: true, model: true, usage: true } },
  },
  // goal_usage_attribution repeats the same call and must not be counted again.
  usageMarkers: ['"model_completed"'],
  parseLine: (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed);
  },
  parseProjected: parseRecord,
};

export const museUsageReader = {
  kind: "transcripts",
  provider: "muse",
  format: museUsageFormat,
  directories: Effect.fn("museUsageReader.directories")(function* ({ environment }) {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const dataHome = environment.XDG_DATA_HOME?.trim();
    return [
      {
        dir: path.resolve(
          dataHome ? expandHomePath(dataHome, home) : path.join(home, ".local", "share"),
          "muse",
          "sessions",
        ),
      },
    ];
  }),
} satisfies ProviderUsageReader<MuseSettings, Path.Path>;
