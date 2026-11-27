import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { Post } from "./schema.ts";
import * as XPostReader from "./XPostReader.ts";
import * as XSearch from "./XSearch.ts";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const reply = encodeJson({
  data: [
    {
      id: "2120186956642468232",
      author_id: "3980735590",
      created_at: "2026-11-10T16:08:56.000Z",
      text: "Carbon &amp; Argon are out",
      public_metrics: {
        like_count: 157,
        retweet_count: 11,
        reply_count: 19,
        impression_count: 6012,
      },
    },
    {
      id: "2120186517435900071",
      author_id: "3980735590",
      text: "cut short",
      note_tweet: { text: "The whole long post" },
    },
  ],
  includes: { users: [{ id: "3980735590", name: "TestingCatalog", username: "testingcatalog" }] },
  meta: { result_count: 2 },
});

const grok = (answer: Effect.Effect<string, ProviderDriverError>) =>
  Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
    listInstances: Effect.succeed([
      { enabled: true, xSearch: () => answer } as unknown as ProviderInstance,
    ]),
  });
const key = (value: string | undefined) =>
  Layer.mock(ApiKeyStore.ApiKeyStore)({
    shared: () => Effect.succeed(value === undefined ? undefined : Redacted.make(value)),
  });
const noGrok = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
  listInstances: Effect.succeed([]),
});
const unreadable = Layer.mock(XPostReader.XPostReader)({
  read: () => Effect.fail(new XPostReader.XPostReadError({ reason: "unavailable" })),
});
const search = (
  query: string,
  saved: ReturnType<typeof key>,
  searcher: ReturnType<typeof grok>,
  fetch: typeof globalThis.fetch = async () => new Response("unused", { status: 500 }),
  deep?: boolean,
  reader: Layer.Layer<XPostReader.XPostReader> = unreadable,
) =>
  Effect.gen(function* () {
    return yield* (yield* XSearch.XSearch).search(query, deep);
  }).pipe(
    Effect.provide(
      XSearch.layer.pipe(
        Layer.provide(Layer.mergeAll(saved, searcher, reader, ServerSettings.layerTest())),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

it("turns an X search into an API request", () => {
  const url = new URL(
    XSearch.xApiSearchUrl('from:xai  "grok 5" since:2026-11-08 until:2026-11-10'),
  );
  expect(url.origin + url.pathname).toBe("https://api.x.com/2/tweets/search/recent");
  expect(url.searchParams.get("query")).toBe('from:xai "grok 5" -is:retweet');
  expect(url.searchParams.get("start_time")).toBe("2026-11-08T00:00:00Z");
  expect(url.searchParams.get("end_time")).toBe("2026-11-10T00:00:00Z");
  expect(url.searchParams.get("max_results")).toBe("10");
  expect(new URL(XSearch.xApiSearchUrl("grok is:retweet")).searchParams.get("query")).toBe(
    "grok is:retweet",
  );
});

it("renders API posts with author, time, counts, full text and link", () => {
  expect(XSearch.renderXApiPosts(reply)).toBe(
    [
      "@testingcatalog (TestingCatalog) · 2026-11-10 16:08 UTC · 157 likes, 11 reposts, 19 replies, 6012 views",
      "Carbon & Argon are out",
      "https://x.com/testingcatalog/status/2120186956642468232",
      "",
      "@testingcatalog (TestingCatalog)",
      "The whole long post",
      "https://x.com/testingcatalog/status/2120186517435900071",
    ].join("\n"),
  );
  expect(XSearch.renderXApiPosts("not json")).toBeUndefined();
});

it.effect("answers from the X API when a key is saved, without starting Grok", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(reply));
    const posts = yield* search(
      "from:testingcatalog",
      key(" fake-bearer "),
      grok(Effect.die("Grok must not run")),
      fetch,
    );
    expect(posts).toContain("https://x.com/testingcatalog/status/2120186956642468232");
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toContain("query=from%3Atestingcatalog+-is%3Aretweet");
    expect(init?.headers).toMatchObject({ authorization: "Bearer fake-bearer" });
  }),
);

it.effect("returns an empty recent search without starting Grok", () =>
  Effect.gen(function* () {
    const callGrok = vi.fn(() => "Grok result");
    const nothing = async () => new Response(encodeJson({ meta: { result_count: 0 } }));
    const posts = yield* search("zzqx", key("k"), grok(Effect.sync(callGrok)), nothing);
    expect(callGrok).toHaveBeenCalledTimes(0);
    expect(posts).toBe(
      "No posts in the last 7 days. For older posts, call search_x again with deep: true (slower, 1-4 min).",
    );
  }),
);

it.effect("falls back to Grok when the API refuses, gives no usable answer or has no key", () =>
  Effect.gen(function* () {
    const fromGrok = grok(Effect.succeed("@xai · post from Grok"));
    const refused = async () => new Response("{}", { status: 400 });
    const recent = `@xai · post from Grok${"\n\nLast 7 days only; deep: true searches all dates."}`;
    expect(yield* search("min_faves:100 grok", key("k"), fromGrok, refused)).toBe(recent);
    const errorReply = encodeJson({ meta: { result_count: 0 }, errors: [{ title: "refused" }] });
    for (const body of ["invalid json", "{}", errorReply]) {
      expect(yield* search("grok", key("k"), fromGrok, async () => new Response(body))).toBe(
        recent,
      );
    }
    const offline = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new TypeError("offline"));
    expect(yield* search("grok", key("k"), fromGrok, offline)).toBe(recent);
    expect(yield* search("grok", key(undefined), fromGrok)).toBe(recent);
  }),
);

it.effect("reports the cause when no provider can answer", () =>
  Effect.gen(function* () {
    const failing = grok(
      Effect.fail(
        new ProviderDriverError({
          driver: ProviderDriverKind.make("grok"),
          instanceId: ProviderInstanceId.make("grok"),
          detail: "The X search timed out.",
        }),
      ),
    );
    expect(yield* search("grok", key(undefined), failing).pipe(Effect.flip)).toMatchObject({
      reason: "failed",
      message: "The X search timed out.",
    });
    expect(
      yield* search("grok", key("k"), noGrok, async () => new Response("{}", { status: 401 })).pipe(
        Effect.flip,
      ),
    ).toMatchObject({ reason: "failed", message: "The X API refused the search (HTTP 401)." });
    expect(yield* search("grok", key(undefined), noGrok).pipe(Effect.flip)).toMatchObject({
      reason: "unavailable",
      message: XSearch.X_SEARCH_UNAVAILABLE,
    });
    expect(
      yield* search("grok", key(undefined), noGrok, undefined, true).pipe(Effect.flip),
    ).toMatchObject({
      reason: "unavailable",
      message:
        "Searching older X posts needs Grok Build switched on and signed in (Settings > Providers).",
    });
    const noCredits = async () => new Response("{}", { status: 402 });
    expect(
      yield* search("grok", key("k"), noGrok, noCredits, true).pipe(Effect.flip),
    ).toMatchObject({
      reason: "failed",
      message: "The X API account is out of credits (HTTP 402).",
    });
  }),
);

const NOW = DateTime.makeUnsafe("2026-11-26T19:00:00Z");

it("sends history searches to the archive from X's first post unless since: says otherwise", () => {
  const all = new URL(XSearch.xApiSearchUrl("from:aitrackerbot nemotron", true));
  expect(all.origin + all.pathname).toBe("https://api.x.com/2/tweets/search/all");
  expect(all.searchParams.get("start_time")).toBe("2006-03-21T00:00:00Z");
  const bounded = new URL(XSearch.xApiSearchUrl("nemotron since:2026-11-01", true));
  expect(bounded.searchParams.get("start_time")).toBe("2026-11-01T00:00:00Z");
  expect(XSearch.isXHistorySearch("nemotron", NOW, true)).toBe(true);
  expect(XSearch.isXHistorySearch("nemotron since:2026-11-01", NOW)).toBe(true);
  expect(XSearch.isXHistorySearch("nemotron since:2026-11-22", NOW)).toBe(false);
  expect(XSearch.isXHistorySearch("nemotron", NOW)).toBe(false);
});

it("adds a Grok search ending six days back unless the bounds already settle the index", () => {
  expect(XSearch.grokXSearchQueries("from:a nemotron", NOW)).toEqual([
    "from:a nemotron",
    "from:a nemotron until:2026-11-20",
  ]);
  expect(XSearch.grokXSearchQueries("x since:2026-11-01 until:2026-11-25", NOW)).toEqual([
    "x since:2026-11-01 until:2026-11-25",
    "x since:2026-11-01 until:2026-11-20",
  ]);
  expect(XSearch.grokXSearchQueries("x until:2026-11-10", NOW)).toEqual(["x until:2026-11-10"]);
  expect(XSearch.grokXSearchQueries("x since:2026-11-22", NOW)).toEqual(["x since:2026-11-22"]);
});

it.effect("answers a deep search from the archive without starting Grok", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(reply));
    const posts = yield* search(
      "from:testingcatalog",
      key("k"),
      grok(Effect.die("Grok must not run")),
      fetch,
      true,
    );
    expect(posts).not.toContain("Last 7 days");
    expect(String(fetch.mock.calls[0]![0])).toContain("/2/tweets/search/all?");
  }),
);

it.effect("covers a deep Grok search with a last-week search and an archive search", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(DateTime.toEpochMillis(NOW));
    const queries: Array<string> = [];
    const searcher = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      listInstances: Effect.succeed([
        {
          enabled: true,
          xSearch: (query: string) =>
            Effect.sync(() => {
              queries.push(query);
              return query.includes("until:") ? "@a · Nov 18 post" : "@a · Nov 25 post";
            }),
        } as unknown as ProviderInstance,
      ]),
    });
    const empty = async () => new Response(encodeJson({ meta: { result_count: 0 } }));
    const posts = yield* search("from:a nemotron", key("k"), searcher, empty, true);
    expect(queries.toSorted()).toEqual(["from:a nemotron", "from:a nemotron until:2026-11-20"]);
    expect(posts).toBe(
      ["Last 7 days:", "@a · Nov 25 post", "", "Before 2026-11-20:", "@a · Nov 18 post"].join("\n"),
    );
    const failing = grok(
      Effect.fail(
        new ProviderDriverError({
          driver: ProviderDriverKind.make("grok"),
          instanceId: ProviderInstanceId.make("grok"),
          detail: "The X search timed out.",
        }),
      ),
    );
    expect(
      yield* search("from:a nemotron", key(undefined), failing, undefined, true).pipe(Effect.flip),
    ).toMatchObject({ message: "The X search timed out." });
  }),
);

it("finds each distinct post link in a Grok answer", () => {
  expect(
    XSearch.xPostLinks(
      [
        "https://x.com/aitrackerbot/status/2123181195538128898",
        "https://twitter.com/i/web/status/2122876371604996462 and again",
        "https://x.com/aitrackerbot/status/2123181195538128898",
      ].join("\n"),
    ),
  ).toEqual([
    { id: "2123181195538128898", url: "https://x.com/aitrackerbot/status/2123181195538128898" },
    { id: "2122876371604996462", url: "https://twitter.com/i/web/status/2122876371604996462" },
  ]);
});

it.effect("reads the posts Grok links to, keeping the link of one it can't read", () =>
  Effect.gen(function* () {
    const read = vi.fn((input: { readonly url: string }) =>
      input.url.endsWith("/1111111111")
        ? Effect.fail(new XPostReader.XPostReadError({ reason: "unavailable" }))
        : Effect.succeed({
            author: { name: "AI Tracker", handle: "aitrackerbot" },
            createdAt: "2026-11-18T22:26:58.000Z",
            counts: { likes: 19, views: 1417 },
            text: "Nemotron 3.5 Decision 8B",
            url: input.url,
            source: "syndication",
            limits: "",
          } as unknown as Post & { limits: string }),
    );
    const reader = Layer.mock(XPostReader.XPostReader)({ read } as never);
    const links = grok(
      Effect.succeed(
        "https://x.com/aitrackerbot/status/2123181195538128898\nhttps://x.com/a/status/1111111111",
      ),
    );
    const posts = yield* search(
      "from:aitrackerbot nemotron",
      key(undefined),
      links,
      undefined,
      false,
      reader,
    );
    expect(posts).toBe(
      [
        "@aitrackerbot (AI Tracker) · 2026-11-18 22:26 UTC · 19 likes, 1417 views\nNemotron 3.5 Decision 8B\nhttps://x.com/aitrackerbot/status/2123181195538128898",
        "https://x.com/a/status/1111111111",
        "Last 7 days only; deep: true searches all dates.",
      ].join("\n\n"),
    );
    expect(read).toHaveBeenCalledWith({
      url: "https://x.com/aitrackerbot/status/2123181195538128898",
      thread: false,
      includeImages: false,
    });
  }),
);

const twoGrokAccounts = (balanceAccounts: boolean) =>
  Effect.gen(function* () {
    const read = vi.fn((input: { readonly url: string }) =>
      Effect.succeed({
        author: { name: "a", handle: "a" },
        text: "post",
        url: input.url,
        source: "syndication",
        limits: "",
      } as unknown as Post & { limits: string }),
    );
    const reader = Layer.mock(XPostReader.XPostReader)({ read } as never);
    const calls: Array<string> = [];
    const accounts = Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
      listInstances: Effect.succeed(
        ["first", "second"].map(
          (name) =>
            ({
              enabled: true,
              xSearch: () =>
                Effect.suspend(() => {
                  calls.push(name);
                  return name === "first"
                    ? Effect.fail(
                        new ProviderDriverError({
                          driver: ProviderDriverKind.make("grok"),
                          instanceId: ProviderInstanceId.make(name),
                          detail: "limit reached",
                        }),
                      )
                    : Effect.succeed("https://x.com/a/status/2222222222");
                }),
            }) as unknown as ProviderInstance,
        ),
      ),
    });
    const program = Effect.gen(function* () {
      const xSearch = yield* XSearch.XSearch;
      const first = yield* xSearch.search("from:a");
      const second = yield* xSearch.search("from:a");
      return [first, second];
    }).pipe(
      Effect.provide(
        XSearch.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              key(undefined),
              accounts,
              reader,
              ServerSettings.layerTest({ balanceAccounts }),
            ),
          ),
        ),
      ),
      Effect.provideService(
        FetchHttpClient.Fetch,
        async () => new Response("unused", { status: 500 }),
      ),
    );
    return { result: yield* Effect.result(program), calls, read };
  });

it.effect(
  "with account balancing, reuses read posts and moves a failed search to the next account",
  () =>
    Effect.gen(function* () {
      const { result, calls, read } = yield* twoGrokAccounts(true);
      if (Result.isFailure(result)) throw new Error("the search failed");
      const [first, second] = result.success;
      expect(first).toContain("@a · post".replace(" · post", "\npost"));
      expect(second).toBe(first);
      expect(calls).toEqual(["first", "second", "second"]);
      expect(read).toHaveBeenCalledTimes(1);
    }),
);

it.effect("without account balancing, only the first Grok account searches", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* twoGrokAccounts(false);
    expect(Result.isFailure(result)).toBe(true);
    expect(calls).toEqual(["first"]);
  }),
);
