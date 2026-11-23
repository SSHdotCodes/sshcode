import * as Schema from "effect/Schema";

/** One model as Artificial Analysis lists it, cut down to what the Usage picks read. */
export const BenchmarkFeedRow = Schema.Struct({
  /** Their id for the model at one effort, such as `gpt-6-1-sol-high`. */
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
});
export type BenchmarkFeedRow = typeof BenchmarkFeedRow.Type;

/**
 * Current public figures, read by the server from the publisher's API once a
 * day. Their terms ask for a visible credit wherever the figures are shown.
 */
export const BenchmarkFeed = Schema.Struct({
  source: Schema.Literal("Artificial Analysis"),
  /** ISO time of the read. */
  fetchedAt: Schema.String,
  rows: Schema.Array(BenchmarkFeedRow),
});
export type BenchmarkFeed = typeof BenchmarkFeed.Type;
