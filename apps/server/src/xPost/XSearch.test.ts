import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
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
const search = (
  query: string,
  saved: ReturnType<typeof key>,
  searcher: ReturnType<typeof grok>,
  fetch: typeof globalThis.fetch = async () => new Response("unused", { status: 500 }),
) =>
  Effect.gen(function* () {
    return yield* (yield* XSearch.XSearch).search(query);
  }).pipe(
    Effect.provide(XSearch.layer.pipe(Layer.provide(Layer.merge(saved, searcher)))),
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
  expect(XSearch.renderXApiPosts(encodeJson({ meta: { result_count: 0 } }))).toBeUndefined();
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

it.effect("falls back to Grok when the API refuses the query, finds nothing or has no key", () =>
  Effect.gen(function* () {
    const fromGrok = grok(Effect.succeed("@xai · post from Grok"));
    const refused = async () => new Response("{}", { status: 400 });
    const nothing = async () => new Response(encodeJson({ meta: { result_count: 0 } }));
    expect(yield* search("min_faves:100 grok", key("k"), fromGrok, refused)).toBe(
      "@xai · post from Grok",
    );
    expect(yield* search("what do people think", key("k"), fromGrok, nothing)).toBe(
      "@xai · post from Grok",
    );
    expect(yield* search("grok", key(undefined), fromGrok)).toBe("@xai · post from Grok");
  }),
);

it.effect("says plainly when nothing matched or nothing can search", () =>
  Effect.gen(function* () {
    const nothing = async () => new Response(encodeJson({ meta: { result_count: 0 } }));
    const failing = grok(
      Effect.fail(
        new ProviderDriverError({
          driver: ProviderDriverKind.make("grok"),
          instanceId: ProviderInstanceId.make("grok"),
          detail: "The X search timed out.",
        }),
      ),
    );
    expect(yield* search("zzqx", key("k"), noGrok, nothing)).toBe(XSearch.X_SEARCH_EMPTY);
    expect(yield* search("zzqx", key("k"), failing, nothing)).toBe(XSearch.X_SEARCH_EMPTY);
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
  }),
);
