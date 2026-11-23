/**
 * Current public model figures for the Usage picks, read from Artificial
 * Analysis's API with the key saved for all sessions as
 * `ARTIFICIAL_ANALYSIS_API_KEY`.
 *
 * Their free tier allows 100 requests a day; one read is a handful of pages and
 * happens at most once a day, and only when a screen asks. The last read is
 * kept in memory and in one small file so a restart costs no request. Without
 * a key nothing is fetched and the built-in table stands.
 *
 * @module BenchmarkFeed
 */
import type { BenchmarkFeed, BenchmarkFeedRow } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { benchmarkFeedRowsFor } from "@t3tools/shared/modelBenchmarkFeed";
import { MODEL_BENCHMARKS } from "@t3tools/shared/modelBenchmarks";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";

export const BENCHMARK_FEED_KEY_NAME = "ARTIFICIAL_ANALYSIS_API_KEY";
const FEED_URL = "https://artificialanalysis.ai/api/v2/language/models/free";
const FRESH_FOR_MS = 24 * 60 * 60 * 1000;
/** A failed read is not tried again at once: the daily allowance is small. */
const RETRY_AFTER_MS = 60 * 60 * 1000;
const MAX_PAGES = 8;
const PAGE_TIMEOUT = "30 seconds";
const MAX_BODY_BYTES = 4_000_000;
/** The whole list is about 100 KB; anything far larger is not this file. */
const MAX_CACHE_BYTES = 1_000_000;

const Figure = Schema.optional(Schema.NullOr(Schema.Number));
const Page = Schema.Struct({
  pagination: Schema.optional(Schema.Struct({ total_pages: Schema.optional(Schema.Number) })),
  data: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      name: Schema.String,
      evaluations: Schema.optional(
        Schema.NullOr(Schema.Struct({ artificial_analysis_intelligence_index: Figure })),
      ),
      pricing: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            price_1m_input_tokens: Figure,
            price_1m_output_tokens: Figure,
            price_1m_cache_hit_tokens: Figure,
            price_1m_cache_write_tokens: Figure,
          }),
        ),
      ),
      performance_v3: Schema.optional(
        Schema.NullOr(Schema.Struct({ mean_output_tokens_per_second: Figure })),
      ),
    }),
  ),
});
const decodePage = Schema.decodeUnknownOption(Schema.fromJsonString(Page));

const Stored = Schema.Struct({
  fetchedAtMs: Schema.Number,
  rows: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      name: Schema.String,
      intelligenceIndex: Schema.NullOr(Schema.Number),
      outputTokensPerSecond: Schema.NullOr(Schema.Number),
      price: Schema.NullOr(
        Schema.Struct({
          inputPerMTok: Schema.Number,
          outputPerMTok: Schema.Number,
          cachedInputPerMTok: Schema.NullOr(Schema.Number),
          cacheWritePerMTok: Schema.NullOr(Schema.Number),
        }),
      ),
    }),
  ),
});
type Stored = typeof Stored.Type;
const decodeStored = Schema.decodeUnknownOption(Schema.fromJsonString(Stored));
const encodeStored = Schema.encodeSync(Schema.fromJsonString(Stored));

/** One page of the publisher's list as the rows the apps read; undefined when it is not that. */
export function benchmarkFeedPage(
  body: string,
): { readonly rows: ReadonlyArray<BenchmarkFeedRow>; readonly totalPages: number } | undefined {
  const page = decodePage(body);
  if (Option.isNone(page)) return undefined;
  return {
    totalPages: page.value.pagination?.total_pages ?? 1,
    rows: page.value.data.map((model) => {
      const input = model.pricing?.price_1m_input_tokens ?? null;
      const output = model.pricing?.price_1m_output_tokens ?? null;
      return {
        slug: model.slug,
        name: model.name,
        intelligenceIndex: model.evaluations?.artificial_analysis_intelligence_index ?? null,
        outputTokensPerSecond: model.performance_v3?.mean_output_tokens_per_second ?? null,
        price:
          input === null || output === null
            ? null
            : {
                inputPerMTok: input,
                outputPerMTok: output,
                cachedInputPerMTok: model.pricing?.price_1m_cache_hit_tokens ?? null,
                cacheWritePerMTok: model.pricing?.price_1m_cache_write_tokens ?? null,
              },
      };
    }),
  };
}

// One server, one feed: the last read, shared by every screen that asks.
let stored: Stored | undefined;
let readFromDisk = false;
let lastAttemptMs: number | undefined;
let reading = false;

/** Tests start from nothing. */
export function resetBenchmarkFeedForTest(): void {
  stored = undefined;
  readFromDisk = false;
  lastAttemptMs = undefined;
  reading = false;
}

const cacheFile = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return path.join(config.providerStatusCacheDir, "benchmark-feed.json");
});

const readCache = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const raw = yield* fs.readFileString(yield* cacheFile).pipe(Effect.orElseSucceed(() => ""));
  return raw.length === 0 || raw.length > MAX_CACHE_BYTES
    ? undefined
    : Option.getOrUndefined(decodeStored(raw));
});

const readPublisher = (key: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const fetch = yield* FetchHttpClient.Fetch;
    const rows: Array<BenchmarkFeedRow> = [];
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page += 1) {
      const body = yield* Effect.tryPromise(async (signal) => {
        const response = await fetch(`${FEED_URL}?page=${page}`, {
          signal,
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { "x-api-key": Redacted.value(key).trim(), accept: "application/json" },
        });
        if (response.status !== 200) return undefined;
        const text = await response.text();
        return text.length > MAX_BODY_BYTES ? undefined : text;
      }).pipe(Effect.timeoutOption(PAGE_TIMEOUT), Effect.option, Effect.map(Option.flatten));
      const parsed = Option.isSome(body) && body.value ? benchmarkFeedPage(body.value) : undefined;
      // Half a list would silently drop models, so a failed page fails the read.
      if (parsed === undefined) return undefined;
      rows.push(...parsed.rows);
      totalPages = parsed.totalPages;
    }
    return rows.length === 0 ? undefined : rows;
  });

const refresh = Effect.gen(function* () {
  const keys = yield* ApiKeyStore.ApiKeyStore;
  const key = yield* keys
    .shared(BENCHMARK_FEED_KEY_NAME)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (key === undefined) return;
  const rows = yield* readPublisher(key);
  if (rows === undefined) return;
  stored = { fetchedAtMs: yield* Clock.currentTimeMillis, rows };
  const contents = encodeStored(stored);
  if (contents.length <= MAX_CACHE_BYTES) {
    yield* writeFileStringAtomically({ filePath: yield* cacheFile, contents }).pipe(Effect.ignore);
  }
}).pipe(
  Effect.ensuring(
    Effect.sync(() => {
      reading = false;
    }),
  ),
);

/**
 * The feed for this server's models, or null when there is none yet. A first
 * read is waited for, so the screen that asked gets live figures; a stale one
 * is returned as it is and refreshed behind it.
 */
export const getBenchmarkFeed: Effect.Effect<
  BenchmarkFeed | null,
  never,
  | ApiKeyStore.ApiKeyStore
  | FileSystem.FileSystem
  | Path.Path
  | ProviderRegistry.ProviderRegistry
  | ServerConfig.ServerConfig
> = Effect.gen(function* () {
  if (!readFromDisk) {
    readFromDisk = true;
    stored = (yield* readCache) ?? stored;
  }
  const now = yield* Clock.currentTimeMillis;
  const stale = stored === undefined || now - stored.fetchedAtMs > FRESH_FOR_MS;
  if (stale && !reading && (lastAttemptMs === undefined || now - lastAttemptMs > RETRY_AFTER_MS)) {
    lastAttemptMs = now;
    reading = true;
    if (stored === undefined) yield* refresh;
    else yield* Effect.forkDetach(refresh);
  }
  if (stored === undefined) return null;
  const providers = yield* (yield* ProviderRegistry.ProviderRegistry).getProviders;
  const modelIds = providers.flatMap((provider) => provider.models.map((model) => model.slug));
  return {
    source: "Artificial Analysis" as const,
    fetchedAt: DateTime.formatIso(DateTime.makeUnsafe(stored.fetchedAtMs)),
    rows: benchmarkFeedRowsFor(MODEL_BENCHMARKS, modelIds, stored.rows),
  };
});
