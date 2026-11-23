import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import { beforeEach, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
import {
  BENCHMARK_FEED_KEY_NAME,
  benchmarkFeedPage,
  getBenchmarkFeed,
  resetBenchmarkFeedForTest,
} from "./BenchmarkFeed.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const model = (slug: string, index: number | null) => ({
  id: slug,
  name: `${slug} (Max)`,
  slug,
  evaluations: { artificial_analysis_intelligence_index: index },
  pricing: {
    price_1m_input_tokens: 2,
    price_1m_output_tokens: 10,
    price_1m_cache_hit_tokens: 0.1,
    price_1m_cache_write_tokens: null,
  },
  performance: { median_output_tokens_per_second: 80 },
  performance_v3: { mean_output_tokens_per_second: 56.04 },
});
const page = (models: ReadonlyArray<unknown>, totalPages = 1) =>
  new Response(
    encodeJson({ tier: "free", pagination: { total_pages: totalPages }, data: models }),
    {
      headers: { "content-type": "application/json" },
    },
  );

beforeEach(() => resetBenchmarkFeedForTest());

const run = (options: {
  readonly fetch: typeof globalThis.fetch;
  readonly key?: string;
  readonly dir: string;
}) =>
  getBenchmarkFeed.pipe(
    Effect.provideService(FetchHttpClient.Fetch, options.fetch),
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(ApiKeyStore.ApiKeyStore)({
          shared: (name) =>
            Effect.succeed(
              name === BENCHMARK_FEED_KEY_NAME && options.key !== undefined
                ? Redacted.make(options.key)
                : undefined,
            ),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            { models: [{ slug: "gpt-6.1-sol" }, { slug: "brand-new-9" }] },
          ] as never),
        }),
        Layer.mock(ServerConfig.ServerConfig)({ providerStatusCacheDir: options.dir } as never),
      ),
    ),
  );

it("reads one page of the publisher's list into the rows the apps use", () => {
  const parsed = benchmarkFeedPage(
    encodeJson({
      pagination: { total_pages: 4 },
      data: [model("gpt-6-1-sol", 54.6), { slug: "bare", name: "Bare" }],
    }),
  );
  expect(parsed?.totalPages).toBe(4);
  expect(parsed?.rows).toEqual([
    {
      slug: "gpt-6-1-sol",
      name: "gpt-6-1-sol (Max)",
      intelligenceIndex: 54.6,
      outputTokensPerSecond: 56.04,
      price: {
        inputPerMTok: 2,
        outputPerMTok: 10,
        cachedInputPerMTok: 0.1,
        cacheWritePerMTok: null,
      },
    },
    {
      slug: "bare",
      name: "Bare",
      intelligenceIndex: null,
      outputTokensPerSecond: null,
      price: null,
    },
  ]);
  expect(benchmarkFeedPage("<html>busy</html>")).toBeUndefined();
  expect(benchmarkFeedPage(encodeJson({ error: "rate limited" }))).toBeUndefined();
});

it.effect("fetches nothing without a saved key", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const fetch = vi.fn<typeof globalThis.fetch>(async () => page([]));
    expect(yield* run({ fetch, dir })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reads every page once a day, keeps this server's models and survives a restart", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).endsWith("page=1")
        ? page([model("gpt-6-1-sol", 54.6), model("gpt-6-1-sol-high", 50.3)], 2)
        : page([model("brand-new-9", 70), model("nobody-runs-this", 33)], 2),
    );
    const first = yield* run({ fetch, key: "test-key", dir });
    expect(first?.source).toBe("Artificial Analysis");
    expect(first?.rows.map((row) => row.slug)).toEqual([
      "gpt-6-1-sol",
      "gpt-6-1-sol-high",
      "brand-new-9",
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://artificialanalysis.ai/api/v2/language/models/free?page=1");
    expect(init).toMatchObject({
      redirect: "error",
      credentials: "omit",
      headers: { "x-api-key": "test-key" },
    });

    // Asked again the same day: no request.
    yield* TestClock.adjust("6 hours");
    expect((yield* run({ fetch, key: "test-key", dir }))?.fetchedAt).toBe(first?.fetchedAt);
    expect(fetch).toHaveBeenCalledTimes(2);

    // A restarted server reads its file instead of the publisher.
    resetBenchmarkFeedForTest();
    const afterRestart = yield* run({ fetch, key: "test-key", dir });
    expect(afterRestart?.rows).toEqual(first?.rows);
    expect(fetch).toHaveBeenCalledTimes(2);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("a failed read is not cached and is not retried at once", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response("slow down", { status: 429 }),
    );
    expect(yield* run({ fetch, key: "test-key", dir })).toBeNull();
    expect(yield* run({ fetch, key: "test-key", dir })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    yield* TestClock.adjust("61 minutes");
    fetch.mockImplementation(async () => page([model("gpt-6-1-sol", 55)]));
    expect((yield* run({ fetch, key: "test-key", dir }))?.rows).toHaveLength(1);
  }).pipe(Effect.provide(NodeServices.layer)),
);
