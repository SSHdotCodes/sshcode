// @effect-diagnostics nodeBuiltinImport:off globalConsole:off preferSchemaOverJson:off - standalone maintainer CLI; no server runtime.
/**
 * Turns `benchmarks.json` (every figure with its source, variant and date)
 * into the compact table the apps ship: `packages/shared/src/modelBenchmarks.ts`.
 *
 * To refresh: update `benchmarks.json` from the publishers' own pages, run
 * `node scripts/model-benchmarks/generate.ts`, then `vp fmt` the output.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

interface Sourced {
  readonly value: number | null;
}
interface SourceModel {
  readonly id: string;
  readonly label: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly scores?: Readonly<Record<string, Sourced | null>>;
  readonly outputTokensPerSecond?: Sourced | null;
  readonly fastOutputTokensPerSecond?: Sourced | null;
  /** Output tokens, reasoning included, spent on one task of a fixed public task set. */
  readonly outputTokensPerTask?: Sourced | null;
  /** The same figures at each reasoning effort the publisher lists. */
  readonly efforts?: Readonly<
    Record<
      string,
      {
        readonly scores?: Readonly<Record<string, Sourced | null>> | null;
        readonly outputTokensPerSecond?: Sourced | null;
        readonly outputTokensPerTask?: Sourced | null;
      } | null
    >
  >;
  readonly price?: {
    readonly inputPerMTok: number | null;
    readonly outputPerMTok: number | null;
    readonly cachedInputPerMTok?: number | null;
    readonly cacheWritePerMTok?: number | null;
  } | null;
}
interface Source {
  readonly asOf: string;
  readonly metrics: Readonly<
    Record<
      string,
      {
        readonly label: string;
        readonly version?: string;
        readonly publisher?: string;
        readonly url?: string;
        readonly higherIsBetter?: boolean;
      }
    >
  >;
  readonly models: ReadonlyArray<SourceModel>;
}

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const source = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "benchmarks.json"), "utf8"),
) as Source;

const number = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

function shortLabel(label: string, publisher: string | undefined): string {
  return publisher && label.startsWith(`${publisher} `) ? label.slice(publisher.length + 1) : label;
}

function shortVersion(label: string, version: string | undefined): string | undefined {
  const short = version?.split(" ")[0];
  return short === undefined || label.includes(short) ? undefined : short;
}

// The picks read every score as "higher is better", so other metrics stay out.
const metricIds = Object.entries(source.metrics)
  .filter(([, metric]) => metric.higherIsBetter !== false)
  .map(([id]) => id);

function scoresOf(scores: Readonly<Record<string, Sourced | null>> | null | undefined) {
  return Object.fromEntries(
    metricIds.flatMap((id) => {
      const value = number(scores?.[id]?.value);
      return value === undefined ? [] : [[id, value]];
    }),
  );
}

/**
 * Artificial Analysis's id for a row, read from the page its figures came from
 * (`.../models/<id>` or `.../models/<id>/providers`). The app refreshes those
 * figures from their API by this id.
 */
function aaSlugOf(...figures: ReadonlyArray<Sourced | null | undefined>): string | undefined {
  for (const figure of figures) {
    const match = /^https:\/\/artificialanalysis\.ai\/models\/([a-z0-9][a-z0-9-]*)/.exec(
      (figure as { readonly url?: string } | null | undefined)?.url ?? "",
    );
    if (match) return match[1];
  }
  return undefined;
}

/** Each effort's figures, leaving out efforts and fields nobody published. */
function effortsOf(model: SourceModel) {
  const efforts = Object.entries(model.efforts ?? {}).flatMap(([effort, variant]) => {
    const scores = scoresOf(variant?.scores);
    const speed = number(variant?.outputTokensPerSecond?.value);
    const perTask = number(variant?.outputTokensPerTask?.value);
    return Object.keys(scores).length === 0 && speed === undefined && perTask === undefined
      ? []
      : [
          [
            effort.toLowerCase(),
            defined({
              aaSlug: aaSlugOf(
                variant?.scores?.aaIntelligenceIndex,
                variant?.outputTokensPerSecond,
                variant?.outputTokensPerTask,
              ),
              scores: Object.keys(scores).length === 0 ? undefined : scores,
              outputTokensPerSecond: speed === undefined ? undefined : Math.round(speed * 10) / 10,
              outputTokensPerTask: perTask === undefined ? undefined : Math.round(perTask),
            }),
          ],
        ];
  });
  return efforts.length === 0 ? undefined : Object.fromEntries(efforts);
}

const table = {
  asOf: source.asOf,
  metrics: Object.fromEntries(
    metricIds.map((id) => {
      const metric = source.metrics[id]!;
      return [
        id,
        defined({
          // The publisher is shown separately, so the label need not repeat it.
          label: shortLabel(metric.label, metric.publisher),
          // "4.1 (dataset 4-1-0)" reads as "4.1" beside the label.
          version: shortVersion(metric.label, metric.version),
          publisher: metric.publisher,
          url: metric.url,
        }),
      ];
    }),
  ),
  models: source.models.map((model) => {
    const price = model.price;
    const input = number(price?.inputPerMTok);
    const output = number(price?.outputPerMTok);
    const speed = number(model.outputTokensPerSecond?.value);
    const fast = number(model.fastOutputTokensPerSecond?.value);
    const perTask = number(model.outputTokensPerTask?.value);
    return defined({
      id: model.id,
      label: model.label,
      aliases: model.aliases?.length ? model.aliases : undefined,
      aaSlug: aaSlugOf(
        model.scores?.aaIntelligenceIndex,
        model.outputTokensPerSecond,
        model.outputTokensPerTask,
      ),
      scores: scoresOf(model.scores),
      outputTokensPerSecond: speed === undefined ? undefined : Math.round(speed * 10) / 10,
      fastOutputTokensPerSecond: fast === undefined ? undefined : Math.round(fast * 10) / 10,
      outputTokensPerTask: perTask === undefined ? undefined : Math.round(perTask),
      efforts: effortsOf(model),
      price:
        input === undefined || output === undefined
          ? undefined
          : defined({
              inputPerMTok: input,
              outputPerMTok: output,
              cachedInputPerMTok: number(price?.cachedInputPerMTok),
              cacheWritePerMTok: number(price?.cacheWritePerMTok),
            }),
    });
  }),
};

const target = NodePath.resolve(here, "../../packages/shared/src/modelBenchmarks.ts");
NodeFS.writeFileSync(
  target,
  `/**
 * Public benchmark figures for the models people run here, gathered on \`asOf\`.
 *
 * Generated: edit \`scripts/model-benchmarks/benchmarks.json\` and run
 * \`node scripts/model-benchmarks/generate.ts\`. Every figure there carries its
 * source and date; a figure nobody published is simply absent.
 *
 * @module modelBenchmarks
 */
import type { PickBenchmarkSource } from "./modelPicks.ts";

export interface ModelBenchmarkMetric {
  readonly label: string;
  readonly version?: string;
  readonly publisher?: string;
  readonly url?: string;
}

/** Read it through \`benchmarksAtEffort\` to get the figures for the effort someone runs. */
export interface ModelBenchmarkTable {
  /** Day the table was gathered, \`YYYY-MM-DD\`. */
  readonly asOf: string;
  /** Set when live figures were laid over it: the publisher to credit beside them. */
  readonly liveSource?: string;
  readonly metrics: Readonly<Record<string, ModelBenchmarkMetric>>;
  readonly models: ReadonlyArray<PickBenchmarkSource>;
}

export const MODEL_BENCHMARKS: ModelBenchmarkTable = ${JSON.stringify(table, null, 2)};
`,
);
console.log(`Wrote ${table.models.length} models and ${metricIds.length} metrics to ${target}`);
