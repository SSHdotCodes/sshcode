import type { OrchestrationThreadSearchMatch } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

// One default, not a model catalog. Operators can override it in search-index-config.json.
export const DEFAULT_SEARCH_MODEL = "embeddinggemma-2:270m-nvfp4-text";
export const EmbeddingConfig = Schema.Struct({
  model: Schema.String,
  url: Schema.String,
});
export const DEFAULT_EMBEDDING_CONFIG = {
  model: DEFAULT_SEARCH_MODEL,
  url: "http://127.0.0.1:11434/v1",
};
const Reply = Schema.Struct({
  data: Schema.Array(Schema.Struct({ index: Schema.Int, embedding: Schema.Array(Schema.Number) })),
});

const decodeReply = HttpClientResponse.schemaBodyJson(Reply);

export class EmbeddingError extends Schema.TaggedError<EmbeddingError>()("EmbeddingError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Local search embeddings are unavailable.";
  }
}

export const embed = Effect.fnUntraced(function* (
  config: typeof EmbeddingConfig.Type,
  input: ReadonlyArray<string>,
) {
  const url = yield* Effect.try({
    try: () => {
      const url = new URL(`${config.url.replace(/\/$/, "")}/embeddings`);
      if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Embeddings must stay on this machine");
      return url.href;
    },
    catch: (cause) => new EmbeddingError({ cause }),
  });
  const decoded = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.post(url).pipe(
        HttpClientRequest.bodyJsonUnsafe({ model: config.model, input }),
      ),
    );
    yield* HttpClientResponse.filterStatusOk(response);
    return yield* decodeReply(response);
  }).pipe(
    Effect.scoped,
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.mapError((cause) => new EmbeddingError({ cause })),
  );
  return yield* Effect.try({
    try: () => {
      const rows = [...decoded.data].sort((a, b) => a.index - b.index);
      if (rows.length !== input.length || rows.some((r, i) => r.index !== i))
        throw new Error("Incomplete embedding batch");
      const dimensions = rows[0]?.embedding.length;
      return rows.map((row) => {
        if (
          !dimensions ||
          dimensions > 4096 ||
          row.embedding.length !== dimensions ||
          row.embedding.some((n) => !Number.isFinite(n))
        )
          throw new Error("Invalid vector");
        const norm = Math.hypot(...row.embedding);
        if (!Number.isFinite(norm) || !norm) throw new Error("Empty vector");
        return row.embedding.map((n) => n / norm);
      });
    },
    catch: (cause) => new EmbeddingError({ cause }),
  });
});

export function fuseSearchResults(
  query: string,
  keyword: ReadonlyArray<OrchestrationThreadSearchMatch>,
  semantic: ReadonlyArray<OrchestrationThreadSearchMatch>,
  limit: number,
) {
  const merged = new Map<
    string,
    { match: OrchestrationThreadSearchMatch; score: number; exact: boolean; bestScore: number }
  >();
  for (const [kind, matches] of [keyword, semantic].entries()) {
    matches.forEach((match, rank) => {
      const score = 1 / (60 + rank + 1);
      const exact =
        kind === 0 &&
        (match.snippet.toLowerCase().includes(query.toLowerCase()) ||
          match.title?.toLowerCase().includes(query.toLowerCase()) === true);
      const old = merged.get(match.threadId);
      const keepOld = old && (old.exact || (!exact && old.bestScore >= score));
      merged.set(match.threadId, {
        match: keepOld ? old.match : match,
        bestScore: keepOld ? old.bestScore : score,
        score: (old?.score ?? 0) + score,
        exact: old?.exact === true || exact,
      });
    });
  }
  return [...merged.values()]
    .sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score)
    .slice(0, limit)
    .map((r) => r.match);
}
