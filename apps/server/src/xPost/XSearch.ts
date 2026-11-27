/**
 * XSearch — searches X for agents.
 *
 * Recent searches use the X API's last-week endpoint. History searches (deep,
 * or a since: day over a week back) use its full archive. Grok answers when the
 * API cannot.
 *
 * @module xPost/XSearch
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ApiKeyStore from "../secrets/ApiKeyStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { Post } from "./schema.ts";
import * as XPostReader from "./XPostReader.ts";

export const X_API_KEY_NAME = "X_API_BEARER_TOKEN";
export const X_SEARCH_UNAVAILABLE = `X search needs Grok Build switched on and signed in (Settings > Providers), or an X API bearer token saved for all sessions as ${X_API_KEY_NAME}.`;
const X_SEARCH_EMPTY =
  "No posts in the last 7 days. For older posts, call search_x again with deep: true (slower, 1-4 min).";
const X_SEARCH_RECENT_NOTE = "Last 7 days only; deep: true searches all dates.";
const X_SEARCH_NONE = "No matching posts on X.";
const X_API_RECENT_URL = "https://api.x.com/2/tweets/search/recent";
const X_API_ARCHIVE_URL = "https://api.x.com/2/tweets/search/all";
/** Without a start time the archive endpoint only reaches 30 days back. */
const X_ARCHIVE_START = "2006-03-21T00:00:00Z";
const RECENT_DAYS = 7;
/**
 * Grok's X search reads only its last-week index unless the query ends a few
 * days back (measured 11-26: until: 3.8 days back reached older posts, 0.8 days
 * back did not). Six days back overlaps the last-week index by under a day.
 */
const GROK_ARCHIVE_UNTIL_DAYS = 6;
/** Grok answers with links; each post is then read from X's free embed endpoints. */
const POST_LINK =
  /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:[A-Za-z0-9_]{1,15}|i(?:\/web)?)\/status\/(\d{5,25})/giu;
const POST_READ_TIMEOUT = "8 seconds";
const POST_READ_CONCURRENCY = 5;
/** Searches repeat (an agent checking an account every few minutes); read posts are reused briefly. */
const POST_CACHE_TTL_MS = 10 * 60_000;
const POST_CACHE_MAX = 500;

/** The distinct post links in a Grok answer, in its order. */
export function xPostLinks(
  text: string,
): ReadonlyArray<{ readonly id: string; readonly url: string }> {
  const links = new Map<string, string>();
  for (const [url, id] of text.matchAll(POST_LINK)) {
    if (id !== undefined && !links.has(id)) links.set(id, url);
  }
  return [...links].map(([id, url]) => ({ id, url }));
}
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
    readonly search: (query: string, deep?: boolean) => Effect.Effect<string, XSearchError>;
  }
>()("t3/xPost/XSearch") {}

const Count = Schema.optional(Schema.Number);
const XApiSearchResponse = Schema.Struct({
  meta: Schema.optional(Schema.Struct({ result_count: Count })),
  errors: Schema.optional(Schema.Array(Schema.Unknown)),
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

function dayBounds(query: string): { readonly since?: string; readonly until?: string } {
  const bounds: { since?: string; until?: string } = {};
  for (const [, , operator, day] of query.matchAll(DAY_OPERATOR)) {
    if (day !== undefined) bounds[operator === "since" ? "since" : "until"] = day;
  }
  return bounds;
}

const daysAgo = (now: DateTime.Utc, days: number) =>
  DateTime.formatIso(DateTime.subtract(now, { days })).slice(0, 10);

/** Deep searches and ones whose `since:` day is over a week back search all of X. */
export function isXHistorySearch(query: string, now: DateTime.Utc, deep?: boolean): boolean {
  const { since } = dayBounds(query);
  return deep === true || (since !== undefined && since < daysAgo(now, RECENT_DAYS));
}

/**
 * The Grok searches that cover a history search: the query as given, which
 * Grok answers from the last week, and, unless the bounds already settle it,
 * the same query ending six days back, which reaches its full archive.
 */
export function grokXSearchQueries(query: string, now: DateTime.Utc): ReadonlyArray<string> {
  const { since, until } = dayBounds(query);
  const archiveUntil = daysAgo(now, GROK_ARCHIVE_UNTIL_DAYS);
  if (until !== undefined && until <= archiveUntil) return [query];
  if (since !== undefined && since >= daysAgo(now, RECENT_DAYS)) return [query];
  const rest = query
    .replace(DAY_OPERATOR, (match, lead: string, operator: string) =>
      operator === "until" ? lead : match,
    )
    .replace(/\s+/gu, " ")
    .trim();
  return [query, `${rest} until:${archiveUntil}`];
}

/**
 * The API request for a query written the way people search X. `since:` and
 * `until:` days become its time bounds, and reposts are left out: they are cut
 * short and billed like any other post. Archive requests start at X's first
 * post unless `since:` says otherwise.
 */
export function xApiSearchUrl(query: string, archive = false): string {
  const url = new URL(archive ? X_API_ARCHIVE_URL : X_API_RECENT_URL);
  const words = query
    .replace(DAY_OPERATOR, (_match, lead: string, operator: string, day: string) => {
      url.searchParams.set(operator === "since" ? "start_time" : "end_time", `${day}T00:00:00Z`);
      return lead;
    })
    .replace(/\s+/gu, " ")
    .trim();
  if (archive && !url.searchParams.has("start_time")) {
    url.searchParams.set("start_time", X_ARCHIVE_START);
  }
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

/** Render a search result, including a confirmed empty result. */
export function renderXApiPosts(body: string, empty = X_SEARCH_EMPTY): string | undefined {
  const decoded = decodeResponse(body);
  if (Option.isNone(decoded)) return undefined;
  const { data, errors, includes, meta } = decoded.value;
  if (!data?.length) {
    const count = meta?.result_count ?? data?.length;
    return count === 0 && !errors?.length ? empty : undefined;
  }
  const users = new Map((includes?.users ?? []).map((user) => [user.id, user] as const));
  const posts = data.map((post) => {
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
  return posts.join("\n\n");
}

/** A post read from X's embed endpoints, laid out like an X API search result. */
export function renderSearchPost(post: Post): string {
  const counts = post.counts;
  const heading = [
    `@${post.author.handle}${post.author.name && post.author.name !== post.author.handle ? ` (${post.author.name})` : ""}`,
    postTime(post.createdAt),
    (
      [
        [counts?.likes, "likes"],
        [counts?.reposts, "reposts"],
        [counts?.replies, "replies"],
        [counts?.views, "views"],
      ] as const
    )
      .flatMap(([count, label]) => (count === undefined ? [] : [`${count} ${label}`]))
      .join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
  const quoted = post.quoted
    ? `Quoting @${post.quoted.author.handle}: ${post.quoted.text ?? ""}`.trim()
    : undefined;
  const article = post.article ? `Article: ${post.article.title}` : undefined;
  return [heading, post.text, article, quoted, post.url].filter(Boolean).join("\n");
}

type ApiOutcome =
  | { readonly kind: "answered"; readonly text: string }
  | { readonly kind: "failed"; readonly detail: string }
  | { readonly kind: "no-key" };

const make = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const keys = yield* ApiKeyStore.ApiKeyStore;
  const settings = yield* ServerSettings.ServerSettingsService;
  const fetch = yield* FetchHttpClient.Fetch;
  const reader = yield* XPostReader.XPostReader;
  const postCache = new Map<string, { readonly at: number; readonly text: string }>();
  let nextSearcher = 0;

  const readPost = (id: string, url: string) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const cached = postCache.get(id);
      if (cached !== undefined && now - cached.at < POST_CACHE_TTL_MS) return cached.text;
      const text = yield* reader.read({ url, thread: false, includeImages: false }).pipe(
        Effect.map(renderSearchPost),
        Effect.timeoutOption(POST_READ_TIMEOUT),
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (text === undefined) return url;
      postCache.delete(id);
      postCache.set(id, { at: now, text });
      if (postCache.size > POST_CACHE_MAX) postCache.delete(postCache.keys().next().value!);
      return text;
    });

  /** Replace a Grok answer's links with the posts themselves; a post that can't be read keeps its link. */
  const readLinkedPosts = (text: string, skip: Set<string> = new Set()) =>
    Effect.gen(function* () {
      const links = xPostLinks(text).filter(({ id }) => !skip.has(id));
      if (links.length === 0) return xPostLinks(text).length > 0 ? "No other posts." : text;
      for (const { id } of links) skip.add(id);
      const posts = yield* Effect.forEach(links, ({ id, url }) => readPost(id, url), {
        concurrency: POST_READ_CONCURRENCY,
      });
      return posts.join("\n\n");
    });

  const searchApi = (query: string, archive: boolean): Effect.Effect<ApiOutcome> =>
    Effect.gen(function* () {
      const token = yield* keys.shared(X_API_KEY_NAME).pipe(Effect.orElseSucceed(() => undefined));
      if (token === undefined) return { kind: "no-key" } as const;
      const reply = yield* Effect.tryPromise(async (signal) => {
        const response = await fetch(xApiSearchUrl(query, archive), {
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
          detail:
            reply.value.status === 402
              ? "The X API account is out of credits (HTTP 402)."
              : `The X API refused the search (HTTP ${reply.value.status}).`,
        } as const;
      }
      const text = renderXApiPosts(reply.value.body, archive ? X_SEARCH_NONE : X_SEARCH_EMPTY);
      return text === undefined
        ? ({ kind: "failed", detail: "The X API returned an invalid search response." } as const)
        : ({ kind: "answered", text } as const);
    });

  return XSearch.of({
    search: (query, deep) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        const history = isXHistorySearch(query, now, deep);
        const api = yield* searchApi(query, history);
        if (api.kind === "answered") {
          if (!history) {
            return api.text === X_SEARCH_EMPTY
              ? api.text
              : `${api.text}\n\n${X_SEARCH_RECENT_NOTE}`;
          }
          // An empty archive answer still lets Grok try a looser search.
          if (api.text !== X_SEARCH_NONE) return api.text;
        }
        const instances = yield* registry.listInstances;
        const signedIn = instances.flatMap((instance) =>
          instance.enabled && instance.xSearch !== undefined ? [instance.xSearch] : [],
        );
        // Spreading searches over several Grok accounts is account balancing, off by default:
        // then the first account answers every search.
        const balance = yield* settings.getSettings.pipe(
          Effect.map((current) => current.balanceAccounts),
          Effect.orElseSucceed(() => false),
        );
        const searchers = balance ? signedIn : signedIn.slice(0, 1);
        if (searchers.length === 0) {
          if (api.kind === "answered") return api.text;
          if (api.kind === "failed") {
            return yield* new XSearchError({ reason: "failed", detail: api.detail });
          }
          return yield* new XSearchError({
            reason: "unavailable",
            detail: history
              ? "Searching older X posts needs Grok Build switched on and signed in (Settings > Providers)."
              : X_SEARCH_UNAVAILABLE,
          });
        }
        // With balancing, searches alternate between Grok accounts and a failed one moves to the next.
        const grokSearch = (text: string) => {
          const first = nextSearcher++ % searchers.length;
          const second = (first + 1) % searchers.length;
          return searchers[first]!(text).pipe(
            Effect.catch((error) =>
              second === first ? Effect.fail(error) : searchers[second]!(text),
            ),
            Effect.mapError(
              (error) => new XSearchError({ reason: "failed", detail: error.detail }),
            ),
          );
        };
        if (!history) {
          return `${yield* readLinkedPosts(yield* grokSearch(query))}\n\n${X_SEARCH_RECENT_NOTE}`;
        }
        const [recentQuery, olderQuery] = grokXSearchQueries(query, now);
        if (olderQuery === undefined)
          return yield* readLinkedPosts(yield* grokSearch(recentQuery!));
        const [recent, older] = yield* Effect.all(
          [Effect.result(grokSearch(recentQuery!)), Effect.result(grokSearch(olderQuery))],
          { concurrency: "unbounded" },
        );
        if (Result.isFailure(recent) && Result.isFailure(older)) {
          return yield* recent.failure;
        }
        const seen = new Set<string>();
        const recentPosts = Result.isSuccess(recent)
          ? yield* readLinkedPosts(recent.success, seen)
          : `Search failed: ${recent.failure.detail}`;
        const olderPosts = Result.isSuccess(older)
          ? yield* readLinkedPosts(older.success, seen)
          : `Search failed: ${older.failure.detail}`;
        const olderLabel = `Before ${olderQuery.slice(olderQuery.lastIndexOf("until:") + 6)}:`;
        return ["Last 7 days:", recentPosts, "", olderLabel, olderPosts].join("\n");
      }),
  });
});

export const layer = Layer.effect(XSearch, make);
