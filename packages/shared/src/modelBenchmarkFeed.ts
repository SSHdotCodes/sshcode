// @effect-diagnostics globalDate:off -- The read is dated by the local calendar day the reader sees.
/**
 * Live public figures laid over the built-in benchmark table.
 *
 * The table is gathered by hand and ships with the app, so it ages between
 * builds. The server reads Artificial Analysis's API once a day; this replaces
 * the scores and speeds that API carries, fills in prices the table lacks, and
 * adds a row for a model the user can run that the table has never heard of.
 * Everything else in the table (other benchmarks, tokens per task) stands.
 *
 * @module modelBenchmarkFeed
 */
import type { ModelBenchmarkTable } from "./modelBenchmarks.ts";
import {
  benchmarkFor,
  normalizeModelId,
  type PickBenchmarkSource,
  type PickBenchmarkVariant,
} from "./modelPicks.ts";

export interface BenchmarkFeedRowLike {
  readonly slug: string;
  readonly name: string;
  readonly intelligenceIndex: number | null;
  readonly outputTokensPerSecond: number | null;
  readonly price: {
    readonly inputPerMTok: number;
    readonly outputPerMTok: number;
    readonly cachedInputPerMTok: number | null;
    readonly cacheWritePerMTok: number | null;
  } | null;
}

export interface BenchmarkFeedLike {
  readonly source: string;
  readonly fetchedAt: string;
  readonly rows: ReadonlyArray<BenchmarkFeedRowLike>;
}

const INTELLIGENCE = "aaIntelligenceIndex";
const FIRST_VERSION = "-1-0";

/** How the publisher ends the id of one effort of a model, and what the table calls it. */
const EFFORT_SUFFIXES: ReadonlyArray<readonly [suffix: string, effort: string]> = [
  ["-non-reasoning", "none"],
  ["-minimal", "minimal"],
  ["-medium", "medium"],
  ["-xhigh", "xhigh"],
  ["-high", "high"],
  ["-low", "low"],
  ["-max", "max"],
];

function splitEffort(slug: string): { readonly base: string; readonly effort?: string } {
  for (const [suffix, effort] of EFFORT_SUFFIXES) {
    if (slug.length > suffix.length && slug.endsWith(suffix)) {
      return { base: slug.slice(0, -suffix.length), effort };
    }
  }
  return { base: slug };
}

/** "Claude Fable 5.2 (Max, Default Fallback)" runs at `max`; a name without a note is `default`. */
function effortInName(name: string): string {
  const note = /\(([^)]*)\)\s*$/.exec(name)?.[1]?.toLowerCase() ?? "";
  const first = note.split(/[,\s]/)[0] ?? "";
  if (first === "non-reasoning") return "none";
  return ["max", "xhigh", "high", "medium", "low", "minimal"].includes(first) ? first : "default";
}

function score(value: number | null): number | undefined {
  return value !== null && Number.isFinite(value) && value > 0 && value <= 100
    ? Math.round(value)
    : undefined;
}

function speed(value: number | null): number | undefined {
  return value !== null && Number.isFinite(value) && value > 0 && value < 100_000
    ? Math.round(value * 10) / 10
    : undefined;
}

function amount(value: number | null | undefined): number | undefined {
  return value !== null && value !== undefined && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * A price the table already has stands: it is taken from the maker's own price
 * list and knows things the feed does not (a launch discount, which cache write
 * is meant). The feed's price only fills a gap.
 */
function priceOf(
  row: BenchmarkFeedRowLike,
  before: PickBenchmarkSource["price"],
): PickBenchmarkSource["price"] {
  if (before !== undefined) return before;
  const input = amount(row.price?.inputPerMTok);
  const output = amount(row.price?.outputPerMTok);
  if (input === undefined || output === undefined) return undefined;
  const cached = amount(row.price?.cachedInputPerMTok);
  const write = amount(row.price?.cacheWritePerMTok);
  return {
    inputPerMTok: input,
    outputPerMTok: output,
    ...(cached === undefined ? {} : { cachedInputPerMTok: cached }),
    ...(write === undefined ? {} : { cacheWritePerMTok: write }),
  };
}

function withFigures<Row extends PickBenchmarkVariant>(
  row: Row,
  live: BenchmarkFeedRowLike | undefined,
): Row {
  if (live === undefined) return row;
  const index = score(live.intelligenceIndex);
  const perSecond = speed(live.outputTokensPerSecond);
  return {
    ...row,
    ...(index === undefined ? {} : { scores: { ...row.scores, [INTELLIGENCE]: index } }),
    ...(perSecond === undefined ? {} : { outputTokensPerSecond: perSecond }),
  };
}

/**
 * The publisher's id for a table row. A row gathered before the publisher
 * listed the model names none, so it is found the way an unknown model is: by
 * its own id written their way. Without this such a row kept its empty scores
 * for good, and hid the publisher's row for the same model behind it.
 */
function feedSlugOf(row: Pick<PickBenchmarkSource, "id" | "aaSlug">): string {
  return row.aaSlug ?? normalizeModelId(row.id);
}

/** Every publisher id the table's own rows are matched through. */
export function benchmarkFeedSlugs(table: ModelBenchmarkTable): ReadonlySet<string> {
  const slugs = new Set<string>();
  for (const row of table.models) {
    slugs.add(feedSlugOf(row));
    for (const variant of Object.values(row.efforts ?? {})) {
      if (variant.aaSlug !== undefined) slugs.add(variant.aaSlug);
    }
  }
  return slugs;
}

/**
 * The part of a full read worth sending to a screen: the table's own rows, and
 * models the user can run that the table lacks, found by the publisher's id
 * matching the model's (`gpt-6.2-sol` is `gpt-6-2-sol` there, `muse-ember-1.0` is
 * `muse-ember`).
 */
export function benchmarkFeedRowsFor<Row extends BenchmarkFeedRowLike>(
  table: ModelBenchmarkTable,
  modelIds: Iterable<string>,
  rows: ReadonlyArray<Row>,
): ReadonlyArray<Row> {
  const known = benchmarkFeedSlugs(table);
  const wanted = new Set<string>();
  for (const id of modelIds) {
    if (benchmarkFor(id, table) !== undefined) continue;
    const normalized = normalizeModelId(id);
    wanted.add(normalized);
    // The publisher leaves a first version unnumbered: `muse-ember-1.0` is `muse-ember` there.
    if (normalized.endsWith(FIRST_VERSION)) wanted.add(normalized.slice(0, -FIRST_VERSION.length));
  }
  return rows.filter(
    (row) => known.has(row.slug) || wanted.has(normalizeModelId(splitEffort(row.slug).base)),
  );
}

function localDay(iso: string): string | undefined {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return undefined;
  const date = new Date(time);
  const two = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The table with the feed's figures in place, dated by the read. No feed, no change. */
export function applyBenchmarkFeed(
  table: ModelBenchmarkTable,
  feed: BenchmarkFeedLike | null | undefined,
): ModelBenchmarkTable {
  if (!feed || feed.rows.length === 0) return table;
  const bySlug = new Map(feed.rows.map((row) => [row.slug, row] as const));
  const known = benchmarkFeedSlugs(table);

  const models: Array<PickBenchmarkSource> = table.models.map((row) => {
    const live = bySlug.get(feedSlugOf(row));
    const next = withFigures(row, live);
    const efforts =
      row.efforts === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(row.efforts).map(([effort, variant]) => [
              effort,
              withFigures(
                variant,
                variant.aaSlug === undefined ? undefined : bySlug.get(variant.aaSlug),
              ),
            ]),
          );
    const price = live === undefined ? row.price : priceOf(live, row.price);
    return {
      ...next,
      ...(efforts === undefined ? {} : { efforts }),
      ...(price === undefined ? {} : { price }),
    };
  });

  // Models the table lacks: one row per model, its efforts gathered under it.
  const added = new Map<string, PickBenchmarkSource>();
  for (const row of feed.rows) {
    if (known.has(row.slug)) continue;
    const split = splitEffort(row.slug);
    // "-high" names an effort only beside the plain id; alone it is the model's own name.
    const isEffort = split.effort !== undefined && bySlug.has(split.base);
    const base = isEffort ? split.base : row.slug;
    if (known.has(base)) continue;
    const effort = isEffort ? split.effort! : effortInName(row.name);
    const variant = withFigures<PickBenchmarkVariant>({ aaSlug: row.slug }, row);
    const before = added.get(base);
    const head = bySlug.get(base) ?? row;
    const headFigures = withFigures<PickBenchmarkVariant>({}, head);
    const price = priceOf(head, undefined);
    added.set(base, {
      id: base,
      label: head.name.replace(/\s*\([^)]*\)\s*$/, ""),
      aaSlug: base,
      scores: headFigures.scores ?? {},
      ...(headFigures.outputTokensPerSecond === undefined
        ? {}
        : { outputTokensPerSecond: headFigures.outputTokensPerSecond }),
      ...(price === undefined ? {} : { price }),
      efforts: { ...before?.efforts, [effort]: variant },
    });
  }
  for (const row of added.values()) {
    // Without a score the picks cannot rank it; a bare price row would only add noise.
    if (row.scores[INTELLIGENCE] !== undefined) models.push(row);
  }

  return {
    ...table,
    asOf: localDay(feed.fetchedAt) ?? table.asOf,
    liveSource: feed.source,
    models,
  };
}
