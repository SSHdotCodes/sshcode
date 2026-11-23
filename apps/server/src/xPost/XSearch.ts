/**
 * XSearch — searches X for agents.
 *
 * With an X API key saved for all sessions (`X_API_BEARER_TOKEN`) a search is
 * one API request: about a second, billed per post. Otherwise, or when the API
 * refuses the query or finds nothing, the search runs on a provider instance
 * that can search X with the user's own account (Grok): no key, but slower.
 *
 * @module xPost/XSearch
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";

export const X_API_KEY_NAME = "X_API_BEARER_TOKEN";
export const X_SEARCH_UNAVAILABLE = `X search needs Grok Build switched on and signed in (Settings > Providers), or an X API bearer token saved for all sessions as ${X_API_KEY_NAME}.`;
export const X_SEARCH_EMPTY = "No posts matched.";
const X_API_SEARCH_URL = "https://api.x.com/2/tweets/search/recent";
const X_API_TIMEOUT = "15 seconds";
/** The API's smallest page; each returned post is billed. */
const X_API_PAGE_SIZE = "10";

export class XSearchError extends Schema.TaggedError<XSearchError>()("XSearchError", {
  reason: Schema.Literals(["unavailable", "failed"]),
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}

export class XSearch extends Context.Service<
  XSearch,
  {
    /** Posts matching the query, as text with links. */
    readonly search: (query: string) => Effect.Effect<string, XSearchError>;
  }
>()("t3/xPost/XSearch") {}

const Count = Schema.optional(Schema.Number);
const XApiSearchResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        text: Schema.String,
        author_id: Schema.optional(Schema.String),
        created_at: Schema.optional(Schema.String),
        note_tweet: Schema.optional(Schema.Struct({ text: Schema.optional(Schema.String) })),
        public_metrics: Schema.optional(
          Schema.Struct({
            like_count: Count,
            retweet_count: Count,
            reply_count: Count,
            impression_count: Count,
          }),
        ),
      }),
    ),
  ),
  includes: Schema.optional(
    Schema.Struct({
      users: Schema.optional(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            username: Schema.String,
            name: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
});
const decodeResponse = Schema.decodeUnknownOption(Schema.fromJsonString(XApiSearchResponse));

const DAY_OPERATOR = /(^|\s)(since|until):(\d{4}-\d{2}-\d{2})(?=\s|$)/gu;

/**
 * The API request for a query written the way people search X. `since:` and
 * `until:` days become its time bounds, and reposts are left out: they are cut
 * short and billed like any other post.
 */
export function xApiSearchUrl(query: string): string {
  const url = new URL(X_API_SEARCH_URL);
  const words = query
    .replace(DAY_OPERATOR, (_match, lead: string, operator: string, day: string) => {
      url.searchParams.set(operator === "since" ? "start_time" : "end_time", `${day}T00:00:00Z`);
      return lead;
    })
    .replace(/\s+/gu, " ")
    .trim();
  url.searchParams.set("query", /\bis:retweet\b/u.test(words) ? words : `${words} -is:retweet`);
  url.searchParams.set("max_results", X_API_PAGE_SIZE);
  url.searchParams.set("tweet.fields", "created_at,public_metrics,note_tweet");
  url.searchParams.set("expansions", "author_id");
  url.searchParams.set("user.fields", "username,name");
  return url.toString();
}

const ENTITIES: Readonly<Record<string, string>> = { "&amp;": "&", "&lt;": "<", "&gt;": ">" };
const decodeEntities = (text: string) =>
  text.replace(/&(?:amp|lt|gt);/gu, (entity) => ENTITIES[entity] ?? entity);

function postTime(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed)
    ? `${DateTime.formatIso(parsed.value).slice(0, 16).replace("T", " ")} UTC`
    : undefined;
}

/** The posts as text, or undefined when the reply holds none. */
export function renderXApiPosts(body: string): string | undefined {
  const decoded = decodeResponse(body);
  if (Option.isNone(decoded)) return undefined;
  const users = new Map(
    (decoded.value.includes?.users ?? []).map((user) => [user.id, user] as const),
  );
  const posts = (decoded.value.data ?? []).map((post) => {
    const author = post.author_id === undefined ? undefined : users.get(post.author_id);
    const metrics = post.public_metrics;
    const counts = [
      [metrics?.like_count, "likes"],
      [metrics?.retweet_count, "reposts"],
      [metrics?.reply_count, "replies"],
      [metrics?.impression_count, "views"],
    ] as const;
    const heading = [
      author === undefined
        ? undefined
        : `@${author.username}${author.name ? ` (${author.name})` : ""}`,
      postTime(post.created_at),
      counts
        .flatMap(([count, label]) => (count === undefined ? [] : [`${count} ${label}`]))
        .join(", "),
    ]
      .filter(Boolean)
      .join(" · ");
    return [
      heading,
      decodeEntities(post.note_tweet?.text ?? post.text),
      `https://x.com/${author?.username ?? "i"}/status/${post.id}`,
    ]
      .filter(Boolean)
      .join("\n");
  });
  return posts.length === 0 ? undefined : posts.join("\n\n");
}

type ApiOutcome =
  | { readonly kind: "posts"; readonly text: string }
  | { readonly kind: "empty" }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "no-key" };

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const keys = yield* ApiKeyStore.ApiKeyStore;
  const fetch = yield* FetchHttpClient.Fetch;

  const searchApi = (query: string): Effect.Effect<ApiOutcome> =>
    Effect.gen(function* () {
      const token = yield* keys.shared(X_API_KEY_NAME).pipe(Effect.orElseSucceed(() => undefined));
      if (token === undefined) return { kind: "no-key" } as const;
      const reply = yield* Effect.tryPromise(async (signal) => {
        const response = await fetch(xApiSearchUrl(query), {
          signal,
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: {
            authorization: `Bearer ${Redacted.value(token).trim()}`,
            accept: "application/json",
          },
        });
        return { status: response.status, body: await response.text() };
      }).pipe(Effect.timeoutOption(X_API_TIMEOUT), Effect.option, Effect.map(Option.flatten));
      if (Option.isNone(reply)) {
        return { kind: "failed", detail: "The X API did not answer." } as const;
      }
      if (reply.value.status !== 200) {
        return {
          kind: "failed",
          detail: `The X API refused the search (HTTP ${reply.value.status}).`,
        } as const;
      }
      const text = renderXApiPosts(reply.value.body);
      return text === undefined ? ({ kind: "empty" } as const) : ({ kind: "posts", text } as const);
    });

  return XSearch.of({
    search: (query) =>
      Effect.gen(function* () {
        const api = yield* searchApi(query);
        if (api.kind === "posts") return api.text;
        const instances = yield* registry.listInstances;
        const searcher = instances.find(
          (instance) => instance.enabled && instance.xSearch !== undefined,
        )?.xSearch;
        if (searcher === undefined) {
          if (api.kind === "empty") return X_SEARCH_EMPTY;
          return yield* api.kind === "failed"
            ? new XSearchError({ reason: "failed", detail: api.detail })
            : new XSearchError({ reason: "unavailable", detail: X_SEARCH_UNAVAILABLE });
        }
        return yield* searcher(query).pipe(
          Effect.catch((error) =>
            api.kind === "empty"
              ? Effect.succeed(X_SEARCH_EMPTY)
              : Effect.fail(new XSearchError({ reason: "failed", detail: error.detail })),
          ),
        );
      }),
  });
});

export const layer = Layer.effect(XSearch, make);
