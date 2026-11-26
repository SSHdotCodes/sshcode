/**
 * Picks the best model for quality, value, speed and low cost from the
 * evidence a user actually has: their own usage (cost, tokens, measured
 * response speed), the grades their lead agents gave subagent work, their
 * live usage limits, and a dated table of public benchmarks.
 *
 * Pure and deterministic, so the phone and the desktop app agree and every
 * rule is testable. Runs on Hermes: no `toSorted`, `toReversed`, `findLast`.
 *
 * How each pick is made (the same words the UI shows):
 * - Quality: public benchmark scores at the effort the user runs, scaled
 *   against the best model and weighted by how much each benchmark tells
 *   models apart, blended with the user's own grades once there are enough.
 * - Value: the most quality per dollar the user really pays, among models
 *   within 15% of the best. On a flat-price plan that is the plan's price
 *   allocated over that account's priced work in the evidence window. Cost is for
 *   the same work: a model that spends more tokens on the same public tasks
 *   costs that much more, whatever its price per token.
 * - Speed: the model that finishes the same work soonest, among models at
 *   least half as good as the best: the tokens it spends on a fixed public
 *   task set divided by its output tokens per second, measured in the user's
 *   own responses when there are enough.
 * - Low cost: the best model among those close to free: the user's own GPU
 *   and anything whose real cost per million output tokens is a few cents,
 *   including input and cache costs. Better quality
 *   first, then faster. When nothing is that cheap, the cheapest.
 *
 * @module modelPicks
 */
import type { UsageTokenTotals } from "@t3tools/contracts";

export type ModelPickKind = "quality" | "value" | "speed" | "frugal";
export const MODEL_PICK_KINDS = ["quality", "value", "speed", "frugal"] as const;

/** Share of the best quality a model needs before it can win a pick. */
export const PICK_QUALITY_FLOOR: Readonly<Record<ModelPickKind, number>> = {
  quality: 0,
  value: 0.85,
  speed: 0.5,
  // Low cost has no floor: close to free competes on quality instead.
  frugal: 0,
};

/**
 * Real cost per million output tokens at or under which work is close to
 * free: the user's own GPU, and a plan's cheap models once its price is spread
 * over its recorded work.
 */
export const NEAR_FREE_PER_M_OUTPUT_USD = 0.1;

// Own grades count for at most half of quality, reaching that slowly.
const GRADE_WEIGHT_CAP = 0.5;
const GRADE_WEIGHT_HALF_AT = 20;
// A handful of grades says little: pull them toward everyone's average.
const GRADE_PRIOR_RUNS = 5;
// Quality points one grade point is worth when too few models have both.
const DEFAULT_POINTS_PER_GRADE = 8;
const MIN_TIMED_RESPONSES = 30;
const MIN_TIMED_OUTPUT_TOKENS = 20_000;
const MIN_COSTED_OUTPUT_TOKENS = 100_000;
// A limit this close to empty is no place to send work.
const MIN_REMAINING_PERCENT = 10;
// Below these the "dollars per percent" estimate is mostly rounding noise.
const MIN_BURN_PERCENT = 3;
const MIN_BURN_USD = 5;
// Counted day by day, a rise this small is still mostly rounding.
const MIN_RISE_PERCENT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30.4375 * DAY_MS;

export interface PickBenchmarkModel {
  /** Canonical id, such as `claude-opus-5-5`. */
  readonly id: string;
  readonly label: string;
  /** Other ids the same model goes by. */
  readonly aliases?: ReadonlyArray<string>;
  /** Metric id to score. Only higher-is-better metrics belong here. */
  readonly scores: Readonly<Record<string, number>>;
  /** The effort each score was measured at, when the table knows. */
  readonly scoreEfforts?: Readonly<Record<string, string>>;
  readonly outputTokensPerSecond?: number;
  readonly fastOutputTokensPerSecond?: number;
  /**
   * Output tokens, reasoning included, the model spends on one task of a fixed
   * public task set. Tokens per second alone says nothing about how soon work
   * is done: a model that spends three times the tokens needs three times the speed.
   */
  readonly outputTokensPerTask?: number;
  readonly price?: {
    readonly inputPerMTok: number;
    readonly outputPerMTok: number;
    readonly cachedInputPerMTok?: number;
    readonly cacheWritePerMTok?: number;
  };
  /**
   * Label of the version before this one, when these are its figures: a release
   * nobody has measured yet is taken to be as good as the one it replaces.
   */
  readonly figuresFrom?: string;
}

/** One model's figures at one reasoning effort. */
export interface PickBenchmarkVariant {
  /** Artificial Analysis's id for this effort; live figures are matched through it. */
  readonly aaSlug?: string;
  readonly scores?: Readonly<Record<string, number>>;
  readonly outputTokensPerSecond?: number;
  readonly outputTokensPerTask?: number;
}

/** A benchmark row as gathered: its headline figures plus each effort the publisher lists. */
export interface PickBenchmarkSource extends PickBenchmarkModel {
  /** Artificial Analysis's id for the headline figures; live figures are matched through it. */
  readonly aaSlug?: string;
  /** Keyed by effort as published, lower case: `max`, `xhigh`, `high`, ... or `default`. */
  readonly efforts?: Readonly<Record<string, PickBenchmarkVariant>>;
}

export interface PickBenchmarks {
  /** Day the table was gathered, `YYYY-MM-DD`. */
  readonly asOf: string;
  readonly metrics: Readonly<Record<string, { readonly label: string }>>;
  readonly models: ReadonlyArray<PickBenchmarkModel>;
}

export interface PickTiming {
  readonly outputTokens: number;
  readonly seconds: number;
  readonly responses: number;
}

/** One model on one provider instance, over the evidence window. */
export interface PickRoute {
  readonly model: string;
  readonly modelLabel?: string;
  readonly instanceId?: string;
  readonly environmentId?: string;
  /** Subscription identity; falls back to the instance for callers with a single machine. */
  readonly accountKey?: string;
  readonly routeLabel: string;
  /** Opaque to the picks: the UI's key for the route's icon and colour. */
  readonly provider?: string;
  /** Runs on the user's own hardware: no price and no limit. */
  readonly local: boolean;
  readonly costUsd: number;
  /** False when the tokens had no known rates, so `costUsd` is not a price. */
  readonly costKnown: boolean;
  readonly unpricedTokens?: number;
  readonly tokens: UsageTokenTotals;
  readonly responses: number;
  readonly timing?: PickTiming;
  readonly fastTiming?: PickTiming;
}

export interface PickGrades {
  readonly instanceId: string;
  readonly environmentId?: string;
  readonly model: string;
  readonly runs: number;
  /** Runs a lead graded. */
  readonly rated: number;
  /** Mean grade on the 1–10 scale; absent without rated runs. */
  readonly average?: number;
  readonly completed: number;
}

export interface PickLimitWindow {
  readonly instanceId: string;
  readonly accountKey?: string;
  readonly id: string;
  readonly label: string;
  readonly kind: "session" | "weekly" | "monthly" | "other";
  readonly usedPercent: number;
  readonly modelIds?: readonly string[];
  readonly providerIds?: readonly string[];
  readonly limited?: boolean;
  readonly resetsAtMs?: number;
  readonly durationMs?: number;
  /**
   * Points the reading rose on each recent day, counted across resets by the
   * server. Present (even empty) when the server counts: then nothing is
   * guessed from the window's own start.
   */
  readonly dailyRise?: ReadonlyArray<{ readonly day: string; readonly percent: number }>;
}

/** A flat-price plan the user pays for the models of one provider instance. */
export interface PickPlan {
  readonly instanceId: string;
  readonly accountKey?: string;
  readonly label: string;
  /** What the user pays a month; zero for a plan that is free. */
  readonly monthlyUsd: number;
  /** A month's work at API rates the plan itself promises, when it states one. */
  readonly includedMonthlyUsd?: number;
  readonly providerIds?: readonly string[];
}

export interface ModelPicksInput {
  readonly routes: ReadonlyArray<PickRoute>;
  /** All usage before candidate eligibility and version substitutions. */
  readonly usage?: ReadonlyArray<PickRoute>;
  readonly grades: ReadonlyArray<PickGrades>;
  readonly limits: ReadonlyArray<PickLimitWindow>;
  /** Plans with a known price. A limited instance without one has an unknown real cost. */
  readonly plans?: ReadonlyArray<PickPlan>;
  /** Subscriptions identified by sign-in even when their price and limits are unknown. */
  readonly subscriptionAccounts?: ReadonlySet<string>;
  readonly benchmarks: PickBenchmarks;
  /**
   * Usage since an instant, for working out what one percent of a limit is
   * worth. Day-level answers are fine. Absent: limits show only percent left.
   */
  readonly usageSince?: (sinceMs: number) => ReadonlyArray<PickRoute>;
  /** Usage from a calendar day (`YYYY-MM-DD`) on, whole days: set against a limit's daily rise. */
  readonly usageSinceDay?: (day: string) => ReadonlyArray<PickRoute>;
  /** Hidden routes still supply historical evidence for the model. */
  readonly canStart?: (route: PickRoute) => boolean;
  /**
   * The account a new session on a route's model would start on, where the
   * user's accounts of one provider share new work. Absent, or undefined for a
   * route: a session starts on the route's own account.
   */
  readonly startsOn?: (
    route: PickRoute,
  ) => { readonly instanceId: string; readonly environmentId?: string } | undefined;
  readonly now: number;
}

export interface PickCandidate {
  /** Canonical model key shared by every route of the same model. */
  readonly key: string;
  readonly label: string;
  /** The route the user sends this model the most work through. */
  readonly route: PickRoute;
  readonly used: boolean;

  /** 0–100, where 100 is the best model here. Absent without any evidence. */
  readonly quality?: number;
  readonly benchmarkQuality?: number;
  /** The benchmark behind `benchmarkQuality` with the widest coverage. */
  readonly headlineBenchmark?: {
    readonly label: string;
    readonly value: number;
    readonly effort?: string;
  };
  readonly grade?: { readonly average: number; readonly rated: number; readonly runs: number };
  /** The version before it, when the public figures shown are that version's. */
  readonly figuresFrom?: string;

  /** API-equivalent dollars per million output tokens, context included. */
  readonly costPerMOutput?: number;
  readonly costBasis?: "yours" | "other" | "list" | "local";
  /**
   * Dollars per million output tokens the user really pays: the API price on a
   * pay-per-token route, nothing on their own hardware, and on a plan its price
   * allocated by the API value of its recorded work. Absent without priced usage.
   */
  readonly paidPerMOutput?: number;
  /** Output tokens the model spends on one task of the public task set, at the effort the user runs. */
  readonly tokensPerTask?: number;
  /**
   * `tokensPerTask` against the typical model here: 1.5 is half again as many
   * tokens for the same work. Absent without a figure, which counts as typical.
   */
  readonly tokensForSameWork?: number;
  readonly plan?: PickPlanValue;

  readonly speed?: {
    readonly tokensPerSecond: number;
    readonly basis: "yours" | "public";
    readonly fast: boolean;
    readonly responses?: number;
    /** Output tokens the model spends on one task of the public task set. */
    readonly tokensPerTask?: number;
    /** `tokensPerTask / tokensPerSecond`: how long that task takes it. */
    readonly secondsPerTask?: number;
  };

  readonly limit?: {
    readonly label: string;
    readonly remainingPercent: number;
    readonly resetsAtMs?: number;
    /** API-equivalent dollars of work left before the tightest limit. */
    readonly remainingUsd?: number;
    /** Millions of output tokens of work left before the tightest limit. */
    readonly remainingMOutput?: number;
    /** Percent of the tightest limit one million output tokens uses up. */
    readonly percentPerMOutput?: number;
  };
  /** Subscription with limits, pay-per-token, or the user's own hardware. */
  readonly billing: "subscription" | "metered" | "local";
}

/** The account and priced work used to allocate its monthly fee. */
export interface PickPlanValue {
  readonly label: string;
  readonly monthlyUsd: number;
  readonly usedUsd: number;
}

/** One provider instance the user pays a flat price for, or that has limits. */
export interface PlanSummary {
  readonly instanceId: string;
  readonly accountKey?: string;
  readonly label: string;
  /** Absent when no price is known for it. */
  readonly monthlyUsd?: number;
  /** Work done through it over the evidence window, at API rates. */
  readonly usedUsd: number;
  /** Only records explicitly identifying a covered gateway provider count. */
  readonly scopedUsage?: boolean;
  /** Tokens it used on models with no API price, which `usedUsd` cannot count. */
  readonly unpricedTokens?: number;
  /**
   * A month of work at API rates it has room for, across all of its models: what
   * its limits add up to ("limit"), what the plan says it includes ("stated"), or
   * the work really done when that is more than the limits now suggest ("used").
   */
  readonly monthlyCapacityUsd?: number;
  readonly capacityBasis?: "limit" | "stated" | "used";
  /** What the limits alone add up to in a month, when they can be read. */
  readonly limitMonthlyUsd?: number;
  readonly hasLimits: boolean;
}

export interface ModelPick {
  readonly kind: ModelPickKind;
  readonly winner: PickCandidate | null;
  /** Best first, winner included; at most five. */
  readonly ranked: ReadonlyArray<PickCandidate>;
}

export interface ModelPicks {
  readonly picks: Readonly<Record<ModelPickKind, ModelPick>>;
  readonly candidates: ReadonlyArray<PickCandidate>;
  /** Plans and limited instances, the most used first. */
  readonly plans: ReadonlyArray<PlanSummary>;
  readonly bestQuality: number | null;
  readonly gradedRuns: number;
}

const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

// A score from further away than this says little about the effort wanted.
const MAX_EFFORT_DISTANCE = 2;

/**
 * The published effort closest to the one wanted, the lower of two equally
 * close. Nothing within reach means nothing usable: a low-effort score does
 * not stand in for a model run near its top setting.
 */
function closestEffort(available: ReadonlyArray<string>, wanted: string): string | undefined {
  if (available.includes(wanted)) return wanted;
  const rank = EFFORT_ORDER.indexOf(wanted);
  let best: string | undefined;
  let bestDistance = Infinity;
  if (rank >= 0) {
    for (const effort of available) {
      const at = EFFORT_ORDER.indexOf(effort);
      if (at < 0) continue;
      const distance = Math.abs(at - rank);
      if (distance > MAX_EFFORT_DISTANCE) continue;
      if (distance < bestDistance || (distance === bestDistance && at < rank)) {
        best = effort;
        bestDistance = distance;
      }
    }
  }
  // A publisher's single unnamed variant is the model as most people run it.
  return best ?? (available.includes("default") ? "default" : undefined);
}

/**
 * The table as it applies to someone who runs models at `effort`: every score
 * and speed comes from that effort where the publisher lists it, else from the
 * closest one, and each row says which. A top-effort score flatters a model
 * for anyone who does not run it that way. Without an effort, or for rows that
 * list none, the headline figures stand.
 */
export function benchmarksAtEffort<
  Table extends Omit<PickBenchmarks, "models"> & {
    readonly models: ReadonlyArray<PickBenchmarkSource>;
  },
>(table: Table, effort: string | undefined): PickBenchmarks {
  const wanted = effort?.toLowerCase();
  return {
    asOf: table.asOf,
    metrics: table.metrics,
    models: table.models.map((row) => {
      const { efforts, ...base } = row;
      if (wanted === undefined || efforts === undefined) return base;
      const scores: Record<string, number> = {};
      const scoreEfforts: Record<string, string> = {};
      const metrics = new Set(Object.keys(row.scores));
      for (const variant of Object.values(efforts)) {
        for (const metric of Object.keys(variant.scores ?? {})) metrics.add(metric);
      }
      for (const metric of metrics) {
        const having = Object.keys(efforts).filter(
          (name) => efforts[name]!.scores?.[metric] !== undefined,
        );
        const chosen = closestEffort(having, wanted);
        if (chosen !== undefined) {
          scores[metric] = efforts[chosen]!.scores![metric]!;
          scoreEfforts[metric] = chosen;
        } else if (having.length === 0 && row.scores[metric] !== undefined) {
          // Published without any effort breakdown: the headline figure is all there is.
          scores[metric] = row.scores[metric]!;
        }
      }
      const timed = Object.keys(efforts).filter(
        (name) => efforts[name]!.outputTokensPerSecond !== undefined,
      );
      const speedEffort = closestEffort(timed, wanted);
      const speed =
        speedEffort !== undefined
          ? efforts[speedEffort]!.outputTokensPerSecond
          : timed.length === 0
            ? base.outputTokensPerSecond
            : undefined;
      const counted = Object.keys(efforts).filter(
        (name) => efforts[name]!.outputTokensPerTask !== undefined,
      );
      const taskEffort = closestEffort(counted, wanted);
      // Mixing throughput at one effort with token use at another invents a task time.
      const perTask =
        speedEffort !== undefined && taskEffort !== undefined && speedEffort !== taskEffort
          ? undefined
          : taskEffort !== undefined
            ? efforts[taskEffort]!.outputTokensPerTask
            : counted.length === 0
              ? base.outputTokensPerTask
              : undefined;
      const {
        outputTokensPerSecond: _headlineSpeed,
        outputTokensPerTask: _headlineTask,
        ...rest
      } = base;
      return {
        ...rest,
        scores,
        scoreEfforts,
        ...(speed === undefined ? {} : { outputTokensPerSecond: speed }),
        ...(perTask === undefined ? {} : { outputTokensPerTask: perTask }),
      };
    }),
  };
}

/** Lower-case id without harness prefixes, account suffixes or punctuation variants. */
export function normalizeModelId(id: string): string {
  let value = id.toLowerCase();
  // Some harnesses key a model as a JSON pair: ["machine","model"].
  value = value.replace(/[[\]"]/g, "").replace(/,/g, "/");
  value = value.replace(/\([^)]*\)/g, "").replace(/@.*$/, "");
  value = value.slice(value.lastIndexOf("/") + 1);
  value = value.slice(value.lastIndexOf(":") + 1);
  return value
    .replace(/[._\s]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function containsAtBoundary(haystack: string, needle: string): boolean {
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : haystack[at - 1]!;
    const after = at + needle.length >= haystack.length ? "" : haystack[at + needle.length]!;
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
  return false;
}

/** The benchmark row for a model id; the longest matching name wins. */
export function benchmarkFor(
  model: string,
  benchmarks: PickBenchmarks,
): PickBenchmarkModel | undefined {
  const normalized = normalizeModelId(model);
  let best: PickBenchmarkModel | undefined;
  let bestLength = 0;
  for (const row of benchmarks.models) {
    for (const name of [row.id, ...(row.aliases ?? [])]) {
      const key = normalizeModelId(name);
      if (key.length > bestLength && containsAtBoundary(normalized, key)) {
        best = row;
        bestLength = key.length;
      }
    }
  }
  return best;
}

const GENERIC_WINDOW_WORDS = new Set([
  "all",
  "daily",
  "day",
  "days",
  "five",
  "hour",
  "hours",
  "limit",
  "models",
  "month",
  "monthly",
  "overall",
  "primary",
  "rolling",
  "secondary",
  "session",
  "seven",
  "subscription",
  "usage",
  "week",
  "weekly",
  "window",
]);

/**
 * Whether a limit window counts a model. Providers name model-specific
 * windows after the model line (`seven_day_<line>`), so a window whose id
 * carries such a word applies only to models whose id carries it too. Explicit
 * server coverage takes precedence over that legacy naming convention.
 */
export function limitWindowApplies(
  windowId: string,
  model: string,
  coverage?: Pick<PickLimitWindow, "modelIds" | "providerIds">,
): boolean {
  if (coverage?.modelIds !== undefined || coverage?.providerIds !== undefined) {
    return (
      (coverage.modelIds === undefined || coverage.modelIds.includes(model)) &&
      (coverage.providerIds === undefined ||
        coverage.providerIds.includes(model.split("/")[0] ?? ""))
    );
  }
  const modelWords = new Set(model.toLowerCase().split(/[^a-z0-9]+/));
  for (const word of windowId.toLowerCase().split(/[^a-z0-9]+/)) {
    if (word === "" || /^\d+$/.test(word) || GENERIC_WINDOW_WORDS.has(word)) continue;
    if (!modelWords.has(word)) return false;
  }
  return true;
}

function outputTokens(route: PickRoute): number {
  return route.tokens.outputTokens;
}

function totalTokens(route: PickRoute): number {
  const tokens = route.tokens;
  return (
    tokens.uncachedInputTokens +
    tokens.cachedInputTokens +
    tokens.cacheCreationTokens +
    tokens.outputTokens
  );
}

interface Group {
  readonly key: string;
  readonly label: string;
  readonly benchmark: PickBenchmarkModel | undefined;
  readonly routes: PickRoute[];
  readonly grades: PickGrades[];
}

function groupByModel(input: ModelPicksInput): Group[] {
  const groups = new Map<string, Group>();
  const groupFor = (model: string, label: string | undefined) => {
    const benchmark = benchmarkFor(model, input.benchmarks);
    const key = benchmark ? normalizeModelId(benchmark.id) : normalizeModelId(model);
    let group = groups.get(key);
    if (!group) {
      group = { key, label: benchmark?.label ?? label ?? model, benchmark, routes: [], grades: [] };
      groups.set(key, group);
    }
    return group;
  };
  for (const route of input.routes) groupFor(route.model, route.modelLabel).routes.push(route);
  for (const grades of input.grades) {
    // Grades without a route to run the model on cannot become a pick.
    const benchmark = benchmarkFor(grades.model, input.benchmarks);
    const key = benchmark ? normalizeModelId(benchmark.id) : normalizeModelId(grades.model);
    groups.get(key)?.grades.push(grades);
  }
  return [...groups.values()].filter((group) => group.routes.length > 0);
}

/** The user's overall token mix, for pricing a model they have not used. */
function tokenMix(routes: ReadonlyArray<PickRoute>) {
  let input = 0;
  let cached = 0;
  let written = 0;
  let output = 0;
  for (const route of routes) {
    if (route.local) continue;
    input += route.tokens.uncachedInputTokens;
    cached += route.tokens.cachedInputTokens;
    written += route.tokens.cacheCreationTokens;
    output += route.tokens.outputTokens;
  }
  // With no usage at all, assume a typical agent loop: mostly cached context.
  return output > 0
    ? { input, cached, written, output }
    : { input: 3, cached: 60, written: 3, output: 1 };
}

function listCostPerMOutput(
  price: NonNullable<PickBenchmarkModel["price"]>,
  mix: ReturnType<typeof tokenMix>,
): number {
  const cachedRate = price.cachedInputPerMTok ?? price.inputPerMTok;
  const writeRate = price.cacheWritePerMTok ?? price.inputPerMTok;
  return (
    (mix.input * price.inputPerMTok +
      mix.cached * cachedRate +
      mix.written * writeRate +
      mix.output * price.outputPerMTok) /
    mix.output
  );
}

function primaryRoute(routes: ReadonlyArray<PickRoute>): PickRoute {
  let best = routes[0]!;
  for (const route of routes) {
    if (totalTokens(route) > totalTokens(best)) best = route;
  }
  return best;
}

function measuredSpeed(timing: PickTiming | undefined): number | undefined {
  if (
    !timing ||
    timing.responses < MIN_TIMED_RESPONSES ||
    timing.outputTokens < MIN_TIMED_OUTPUT_TOKENS ||
    timing.seconds <= 0
  ) {
    return undefined;
  }
  return timing.outputTokens / timing.seconds;
}

function speedOf(
  route: PickRoute,
  benchmark: PickBenchmarkModel | undefined,
): PickCandidate["speed"] {
  const options: Array<NonNullable<PickCandidate["speed"]>> = [];
  const standard = measuredSpeed(route.timing);
  const fast = measuredSpeed(route.fastTiming);
  if (standard !== undefined) {
    options.push({
      tokensPerSecond: standard,
      basis: "yours",
      fast: false,
      responses: route.timing!.responses,
    });
  }
  if (fast !== undefined) {
    options.push({
      tokensPerSecond: fast,
      basis: "yours",
      fast: true,
      responses: route.fastTiming!.responses,
    });
  }
  // A local model's speed is its hardware's, which no public figure describes.
  if (options.length === 0 && !route.local) {
    if (benchmark?.outputTokensPerSecond !== undefined) {
      options.push({
        tokensPerSecond: benchmark.outputTokensPerSecond,
        basis: "public",
        fast: false,
      });
    }
    if (benchmark?.fastOutputTokensPerSecond !== undefined) {
      options.push({
        tokensPerSecond: benchmark.fastOutputTokensPerSecond,
        basis: "public",
        fast: true,
      });
    }
  }
  let best: PickCandidate["speed"];
  for (const option of options) {
    if (!best || option.tokensPerSecond > best.tokensPerSecond) best = option;
  }
  const perTask = benchmark?.outputTokensPerTask;
  return best && perTask !== undefined
    ? { ...best, tokensPerTask: perTask, secondsPerTask: perTask / best.tokensPerSecond }
    : best;
}

/**
 * Soonest to finish the same work first. A model nobody published token use for
 * cannot be placed on that scale, so it follows those that can, by raw speed.
 */
function speedOrder(a: PickCandidate, b: PickCandidate): number {
  const left = a.speed!;
  const right = b.speed!;
  if (left.secondsPerTask !== undefined && right.secondsPerTask !== undefined) {
    return left.secondsPerTask - right.secondsPerTask;
  }
  if (left.secondsPerTask !== undefined) return -1;
  if (right.secondsPerTask !== undefined) return 1;
  return right.tokensPerSecond - left.tokensPerSecond;
}

function windowDuration(window: PickLimitWindow): number | undefined {
  return (
    window.durationMs ??
    (window.kind === "weekly" ? WEEK_MS : window.kind === "monthly" ? MONTH_MS : undefined)
  );
}

function windowStart(window: PickLimitWindow): number | undefined {
  if (window.resetsAtMs === undefined) return undefined;
  const duration = windowDuration(window);
  return duration === undefined ? undefined : window.resetsAtMs - duration;
}

interface WindowBurn {
  readonly window: PickLimitWindow;
  readonly remainingPercent: number;
  /** API-rate dollars one percent of the window has been worth since it opened. */
  readonly usdPerPercent?: number;
  /** API-rate dollars of work the window's models did over the evidence window, about a month. */
  readonly doneUsd: number;
}

const accountOf = (value: { readonly accountKey?: string; readonly instanceId?: string }) =>
  value.accountKey ?? value.instanceId;

/**
 * Every limit window of an instance that counts a model, with what one percent
 * of it has been worth. Without a model: the windows that count all models.
 */
function windowBurns(
  instanceId: string,
  model: string | null,
  input: ModelPicksInput,
): WindowBurn[] {
  return input.limits
    .filter(
      (window) =>
        accountOf(window) === instanceId && limitWindowApplies(window.id, model ?? "", window),
    )
    .map((window) => {
      const remainingPercent = Math.max(0, window.limited ? 0 : 100 - window.usedPercent);
      let doneUsd = 0;
      for (const route of input.routes) {
        if (
          accountOf(route) === instanceId &&
          route.costKnown &&
          limitWindowApplies(window.id, route.model, window)
        ) {
          doneUsd += route.costUsd;
        }
      }
      const spentIn = (routes: ReadonlyArray<PickRoute>) => {
        let spent = 0;
        for (const used of routes) {
          if (
            accountOf(used) === accountOf(window) &&
            used.costKnown &&
            limitWindowApplies(window.id, used.model, window)
          ) {
            spent += used.costUsd;
          }
        }
        return spent;
      };
      const usdPerPercent =
        window.dailyRise !== undefined
          ? riseRate(window.dailyRise, input.usageSinceDay, spentIn)
          : sinceStartRate(window, input, spentIn);
      return usdPerPercent === undefined
        ? { window, remainingPercent, doneUsd }
        : { window, remainingPercent, doneUsd, usdPerPercent };
    });
}

/**
 * Dollars one percent bought, from how far the counter really rose on each day
 * against the work of those same days. Whole days on both sides: no guess about
 * when the window began, and none about how a day's work was spread.
 */
function riseRate(
  dailyRise: NonNullable<PickLimitWindow["dailyRise"]>,
  usageSinceDay: ModelPicksInput["usageSinceDay"],
  spentIn: (routes: ReadonlyArray<PickRoute>) => number,
): number | undefined {
  if (usageSinceDay === undefined || dailyRise.length === 0) return undefined;
  let first = dailyRise[0]!.day;
  let risen = 0;
  for (const entry of dailyRise) {
    if (entry.day < first) first = entry.day;
    risen += entry.percent;
  }
  if (risen < MIN_RISE_PERCENT) return undefined;
  const spent = spentIn(usageSinceDay(first));
  return spent < MIN_BURN_USD ? undefined : spent / risen;
}

/**
 * The older estimate, for a server that does not count the rise: everything
 * spent since the window's nominal start over what the window has used. Wrong
 * whenever the provider resets the counter mid-window.
 */
function sinceStartRate(
  window: PickLimitWindow,
  input: ModelPicksInput,
  spentIn: (routes: ReadonlyArray<PickRoute>) => number,
): number | undefined {
  const start = windowStart(window);
  if (
    input.usageSince === undefined ||
    start === undefined ||
    start > input.now ||
    window.usedPercent < MIN_BURN_PERCENT
  ) {
    return undefined;
  }
  const spent = spentIn(input.usageSince(start));
  return spent < MIN_BURN_USD ? undefined : spent / window.usedPercent;
}

function limitOf(
  burns: ReadonlyArray<WindowBurn>,
  costPerMOutput: number | undefined,
): PickCandidate["limit"] {
  if (burns.length === 0) return undefined;
  let tightest = burns[0]!;
  let remainingUsd: number | undefined;
  for (const burn of burns) {
    if (burn.remainingPercent < tightest.remainingPercent) tightest = burn;
    if (burn.usdPerPercent === undefined) continue;
    const left = burn.usdPerPercent * burn.remainingPercent;
    if (remainingUsd === undefined || left < remainingUsd) remainingUsd = left;
  }
  return {
    label: tightest.window.label,
    remainingPercent: tightest.remainingPercent,
    ...(tightest.window.resetsAtMs === undefined ? {} : { resetsAtMs: tightest.window.resetsAtMs }),
    ...(remainingUsd === undefined ? {} : { remainingUsd }),
    ...(remainingUsd !== undefined && costPerMOutput !== undefined && costPerMOutput > 0
      ? { remainingMOutput: remainingUsd / costPerMOutput }
      : {}),
    ...(tightest.usdPerPercent !== undefined && costPerMOutput !== undefined
      ? { percentPerMOutput: costPerMOutput / tightest.usdPerPercent }
      : {}),
  };
}

interface MonthlyCapacity {
  /** A month of work at API rates the plan has room for. */
  readonly monthlyUsd: number;
  /** "used" when the plan did more than its limits now suggest it allows. */
  readonly basis: "limit" | "used";
  /** What the limits alone add up to in a month. */
  readonly limitMonthlyUsd: number;
}

/**
 * A month of work at API rates the limits allow: the smallest of what each
 * window would add up to. A session window says how fast work may go, not how
 * much fits in a month, so windows shorter than a day are left out.
 *
 * One window's reading is rough early in the window, and limits get reset and
 * raised. So a window never counts for less than the work its models really did
 * in the evidence window: the plan allowed at least that.
 */
function monthlyCapacityOf(burns: ReadonlyArray<WindowBurn>): MonthlyCapacity | undefined {
  let capacity: MonthlyCapacity | undefined;
  for (const burn of burns) {
    const duration = windowDuration(burn.window);
    if (burn.usdPerPercent === undefined || duration === undefined || duration < DAY_MS) continue;
    const limitMonthlyUsd = burn.usdPerPercent * 100 * (MONTH_MS / duration);
    const monthlyUsd = Math.max(limitMonthlyUsd, burn.doneUsd);
    if (capacity === undefined || monthlyUsd < capacity.monthlyUsd) {
      capacity = {
        monthlyUsd,
        basis: burn.doneUsd > limitMonthlyUsd ? "used" : "limit",
        limitMonthlyUsd,
      };
    }
  }
  return capacity;
}

interface Draft {
  readonly group: Group;
  /** Where a new session on the model starts. */
  readonly route: PickRoute;
  /**
   * The route with the most use, hidden ones included: its recorded token costs
   * are the model's, so this record stands in where `route` has little of its own.
   */
  readonly record: PickRoute;
  readonly benchmarkQuality: number | undefined;
  readonly headlineBenchmark: PickCandidate["headlineBenchmark"];
  readonly grade:
    | { readonly average: number; readonly rated: number; readonly runs: number }
    | undefined;
}

// Weight for a benchmark too few models report to measure its spread.
const DEFAULT_METRIC_WEIGHT = 0.2;

/**
 * Each benchmark's best score and how much it tells models apart, over the
 * whole table so a model's quality does not shift with what else the user ran.
 * A benchmark's weight is its spread relative to its mean: one where every
 * model scores about the same is nearly saturated and says little.
 */
function metricScales(benchmarks: PickBenchmarks) {
  const values = new Map<string, number[]>();
  for (const row of benchmarks.models) {
    for (const [metric, value] of Object.entries(row.scores)) {
      if (!(value > 0)) continue;
      const list = values.get(metric);
      if (list) list.push(value);
      else values.set(metric, [value]);
    }
  }
  const scales = new Map<string, { readonly top: number; readonly weight: number }>();
  for (const [metric, list] of values) {
    let top = 0;
    let sum = 0;
    for (const value of list) {
      top = Math.max(top, value);
      sum += value;
    }
    const mean = sum / list.length;
    let squares = 0;
    for (const value of list) squares += (value - mean) ** 2;
    const weight =
      list.length < 3 ? DEFAULT_METRIC_WEIGHT : Math.sqrt(squares / list.length) / mean;
    scales.set(metric, { top, weight });
  }
  return scales;
}

function benchmarkQualities(groups: ReadonlyArray<Group>, benchmarks: PickBenchmarks) {
  const scales = metricScales(benchmarks);
  const coverage = new Map<string, number>();
  for (const group of groups) {
    for (const [metric, value] of Object.entries(group.benchmark?.scores ?? {})) {
      if (value > 0) coverage.set(metric, (coverage.get(metric) ?? 0) + 1);
    }
  }
  return (group: Group) => {
    let total = 0;
    let weight = 0;
    let headline: PickCandidate["headlineBenchmark"];
    let headlineCoverage = 0;
    let unweighted = 0;
    let count = 0;
    for (const [metric, value] of Object.entries(group.benchmark?.scores ?? {})) {
      const scale = scales.get(metric);
      if (!(value > 0) || scale === undefined) continue;
      const normalized = (value / scale.top) * 100;
      unweighted += normalized;
      count++;
      total += normalized * scale.weight;
      weight += scale.weight;
      const covered = coverage.get(metric) ?? 0;
      if (covered > headlineCoverage) {
        headlineCoverage = covered;
        const effort = group.benchmark?.scoreEfforts?.[metric];
        headline = {
          label: benchmarks.metrics[metric]?.label ?? metric,
          value,
          ...(effort === undefined ? {} : { effort }),
        };
      }
    }
    return {
      quality: weight > 0 ? total / weight : count > 0 ? unweighted / count : undefined,
      headline,
    };
  };
}

function mergedGrade(grades: ReadonlyArray<PickGrades>) {
  let runs = 0;
  let rated = 0;
  let sum = 0;
  for (const grade of grades) {
    runs += grade.runs;
    if (grade.average !== undefined && grade.rated > 0) {
      rated += grade.rated;
      sum += grade.average * grade.rated;
    }
  }
  return rated === 0 ? undefined : { average: sum / rated, rated, runs };
}

/**
 * Puts own grades on the benchmark quality scale. Grades bunch near the top of
 * 1–10 while benchmarks spread wide, so a grade is read relative to the models
 * that have both: their average grade maps to their average benchmark quality,
 * and one spread of grades to one spread of quality. Matching spreads, rather
 * than fitting a line, keeps the user's grades just as loud when they disagree
 * with the benchmarks, which is exactly when they matter.
 */
function gradeScale(drafts: ReadonlyArray<Draft>, priorGrade: number) {
  let weight = 0;
  let gradeSum = 0;
  let qualitySum = 0;
  const both: Array<{ grade: number; quality: number; weight: number }> = [];
  for (const draft of drafts) {
    if (!draft.grade || draft.benchmarkQuality === undefined) continue;
    const grade = shrunkGrade(draft.grade, priorGrade);
    both.push({ grade, quality: draft.benchmarkQuality, weight: draft.grade.rated });
    weight += draft.grade.rated;
    gradeSum += grade * draft.grade.rated;
    qualitySum += draft.benchmarkQuality * draft.grade.rated;
  }
  if (weight === 0) {
    // Nothing to anchor on: the average grade stands for a solidly good model.
    return (grade: number) => 90 + (grade - priorGrade) * DEFAULT_POINTS_PER_GRADE;
  }
  const meanGrade = gradeSum / weight;
  const meanQuality = qualitySum / weight;
  let pointsPerGrade = DEFAULT_POINTS_PER_GRADE;
  if (both.length >= 3 && weight >= 15) {
    let gradeVariance = 0;
    let qualityVariance = 0;
    for (const point of both) {
      gradeVariance += point.weight * (point.grade - meanGrade) ** 2;
      qualityVariance += point.weight * (point.quality - meanQuality) ** 2;
    }
    // Bounded so a few odd grades cannot flatten or explode the scale.
    if (gradeVariance > 0) {
      pointsPerGrade = Math.min(15, Math.max(2, Math.sqrt(qualityVariance / gradeVariance)));
    }
  }
  return (grade: number) => meanQuality + (grade - meanGrade) * pointsPerGrade;
}

function shrunkGrade(grade: { average: number; rated: number }, prior: number): number {
  return (
    (grade.average * grade.rated + prior * GRADE_PRIOR_RUNS) / (grade.rated + GRADE_PRIOR_RUNS)
  );
}

/** Quality per dollar of comparable work. Free routes share first place by quality. */
export function valueScore(candidate: PickCandidate): number {
  const cost = realCostForSameWork(candidate);
  if (candidate.quality === undefined || cost === undefined) return 0;
  return cost === 0 ? Infinity : candidate.quality / cost;
}

/**
 * Close to free first, and among those the better model, then the faster: a
 * free model that is much worse saves nothing over one that costs a few cents.
 * Past that line the cheapest work first, equal costs going to the better model.
 */
function frugalOrder(a: PickCandidate, b: PickCandidate): number {
  const costA = realCostForSameWork(a) ?? Infinity;
  const costB = realCostForSameWork(b) ?? Infinity;
  const nearA = realCostPerMOutput(a)! <= NEAR_FREE_PER_M_OUTPUT_USD;
  const nearB = realCostPerMOutput(b)! <= NEAR_FREE_PER_M_OUTPUT_USD;
  if (nearA !== nearB) return nearA ? -1 : 1;
  const quality = (b.quality ?? -1) - (a.quality ?? -1);
  if (nearA) {
    if (quality !== 0) return quality;
    const speed = (b.speed?.tokensPerSecond ?? 0) - (a.speed?.tokensPerSecond ?? 0);
    if (speed !== 0) return speed;
  }
  return costA - costB || quality;
}

/**
 * The model on its free route. A candidate stands on the route the user runs
 * most, which may be a paid one for a model their own GPU also serves; for
 * low cost that model is free.
 */
function onLocalRoute(
  candidate: PickCandidate,
  group: Group,
  canStart: ModelPicksInput["canStart"],
): PickCandidate {
  if (candidate.route.local) return candidate;
  const locals = group.routes.filter((route) => route.local && (canStart?.(route) ?? true));
  if (locals.length === 0) return candidate;
  const route = primaryRoute(locals);
  const speed = speedOf(route, group.benchmark);
  return {
    key: candidate.key,
    label: candidate.label,
    route,
    used: candidate.used,
    ...(candidate.quality === undefined ? {} : { quality: candidate.quality }),
    ...(candidate.benchmarkQuality === undefined
      ? {}
      : { benchmarkQuality: candidate.benchmarkQuality }),
    ...(candidate.headlineBenchmark ? { headlineBenchmark: candidate.headlineBenchmark } : {}),
    ...(candidate.grade ? { grade: candidate.grade } : {}),
    ...(candidate.figuresFrom === undefined ? {} : { figuresFrom: candidate.figuresFrom }),
    costPerMOutput: 0,
    costBasis: "local",
    paidPerMOutput: 0,
    ...(candidate.tokensPerTask === undefined ? {} : { tokensPerTask: candidate.tokensPerTask }),
    ...(candidate.tokensForSameWork === undefined
      ? {}
      : { tokensForSameWork: candidate.tokensForSameWork }),
    ...(speed ? { speed } : {}),
    billing: "local",
  };
}

/**
 * Estimated cost per million output tokens including context. Where the plan rate
 * is unknown, the API rate is shown explicitly as a proxy.
 */
export function realCostPerMOutput(candidate: PickCandidate): number | undefined {
  return candidate.paidPerMOutput ?? candidate.costPerMOutput;
}

/**
 * What the same work costs: the cost per million output tokens times how many
 * tokens the model spends against a typical one. Cheap tokens are no saving
 * when a model needs many more of them.
 */
export function realCostForSameWork(candidate: PickCandidate): number | undefined {
  const cost = realCostPerMOutput(candidate);
  return cost === undefined ? undefined : cost * (candidate.tokensForSameWork ?? 1);
}

function median(values: ReadonlyArray<number>): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function planSummaries(
  input: ModelPicksInput,
  plans: ReadonlyMap<string, PickPlan>,
  usedByInstance: ReadonlyMap<string, number>,
  unpricedTokensByInstance: ReadonlyMap<string, number> = new Map(),
): PlanSummary[] {
  const labels = new Map<string, string>();
  for (const route of input.routes) {
    if (route.instanceId !== undefined && !labels.has(accountOf(route)!)) {
      labels.set(accountOf(route)!, route.routeLabel);
    }
  }
  const instances = new Map<string, PickPlan | PickLimitWindow>(plans);
  for (const window of input.limits) instances.set(accountOf(window)!, window);
  const summaries = [...instances].map(([key, source]): PlanSummary => {
    const instanceId = source.instanceId;
    const plan = plans.get(key);
    const burns = windowBurns(key, null, input);
    const usedUsd = usedByInstance.get(key) ?? 0;
    const unpricedTokens = unpricedTokensByInstance.get(key) ?? 0;
    const fromLimit = monthlyCapacityOf(burns);
    const capacity =
      fromLimit !== undefined
        ? ({
            monthlyCapacityUsd: fromLimit.monthlyUsd,
            capacityBasis: fromLimit.basis,
            limitMonthlyUsd: fromLimit.limitMonthlyUsd,
          } as const)
        : plan?.includedMonthlyUsd !== undefined
          ? ({ monthlyCapacityUsd: plan.includedMonthlyUsd, capacityBasis: "stated" } as const)
          : {};
    return {
      instanceId,
      ...(source.accountKey === undefined ? {} : { accountKey: source.accountKey }),
      label: plan?.label ?? labels.get(key) ?? instanceId,
      ...(plan ? { monthlyUsd: plan.monthlyUsd } : {}),
      usedUsd,
      ...(plan?.providerIds ? { scopedUsage: true } : {}),
      ...(unpricedTokens > 0 ? { unpricedTokens } : {}),
      ...capacity,
      hasLimits: input.limits.some((window) => accountOf(window) === key),
    };
  });
  return summaries.sort((a, b) => b.usedUsd - a.usedUsd || a.label.localeCompare(b.label));
}

export function pickBestModels(input: ModelPicksInput): ModelPicks {
  const groups = groupByModel(input);
  const usage = input.usage ?? input.routes;
  const mix = tokenMix(usage);
  const plans = new Map<string, PickPlan>();
  for (const plan of input.plans ?? []) plans.set(accountOf(plan)!, plan);
  const usedByInstance = new Map<string, number>();
  const modelUsage = new Map<string, { usd: number; output: number }>();
  const usageKey = (route: PickRoute) =>
    JSON.stringify([accountOf(route), normalizeModelId(route.model)]);
  const unpricedTokensByInstance = new Map<string, number>();
  for (const route of usage) {
    const account = accountOf(route);
    if (account === undefined) continue;
    const plan = plans.get(account);
    if (plan?.providerIds && !limitWindowApplies("", route.model, plan)) continue;
    // A partially priced route still contributes its known dollars to the account total.
    usedByInstance.set(account, (usedByInstance.get(account) ?? 0) + route.costUsd);
    const unpriced = route.unpricedTokens ?? (route.costKnown ? 0 : totalTokens(route));
    if (unpriced > 0) {
      unpricedTokensByInstance.set(
        account,
        (unpricedTokensByInstance.get(account) ?? 0) + unpriced,
      );
    }
    if (!route.costKnown) continue;
    const key = usageKey(route);
    const observed = modelUsage.get(key) ?? { usd: 0, output: 0 };
    observed.usd += route.costUsd;
    observed.output += outputTokens(route);
    modelUsage.set(key, observed);
  }
  const benchmarkQuality = benchmarkQualities(groups, input.benchmarks);

  let gradedRuns = 0;
  let gradeTotal = 0;
  for (const grades of input.grades) {
    if (grades.average === undefined) continue;
    gradedRuns += grades.rated;
    gradeTotal += grades.average * grades.rated;
  }
  const priorGrade = gradedRuns > 0 ? gradeTotal / gradedRuns : 8;

  const drafts: Draft[] = groups.flatMap((group): Draft[] => {
    const { quality, headline } = benchmarkQuality(group);
    const record = primaryRoute(group.routes);
    const available = input.canStart ? group.routes.filter(input.canStart) : group.routes;
    if (!available.length) return [];
    const base = available.includes(record) ? record : primaryRoute(available);
    const start = base.local ? undefined : input.startsOn?.(base);
    const moved =
      start &&
      available.find(
        (route) =>
          !route.local &&
          route.instanceId === start.instanceId &&
          route.environmentId === start.environmentId,
      );
    return [
      {
        group,
        route: moved ?? base,
        record,
        benchmarkQuality: quality,
        headlineBenchmark: headline,
        grade: mergedGrade(group.grades),
      },
    ];
  });
  const toQuality = gradeScale(drafts, priorGrade);

  const candidates: PickCandidate[] = drafts.map((draft) => {
    const { group, route, record } = draft;
    const accountPlan = route.local ? undefined : plans.get(accountOf(route) ?? "");
    const paidFor =
      accountPlan?.providerIds && !limitWindowApplies("", route.model, accountPlan)
        ? undefined
        : accountPlan;
    const observed = paidFor && modelUsage.get(usageKey(route));
    const costed =
      route.costKnown && outputTokens(route) >= MIN_COSTED_OUTPUT_TOKENS ? route : record;
    let quality = draft.benchmarkQuality;
    if (draft.grade) {
      const own = Math.min(100, toQuality(shrunkGrade(draft.grade, priorGrade)));
      const weight =
        quality === undefined
          ? 1
          : Math.min(
              GRADE_WEIGHT_CAP,
              draft.grade.rated / (draft.grade.rated + GRADE_WEIGHT_HALF_AT),
            );
      quality = quality === undefined ? own : quality * (1 - weight) + own * weight;
    }

    let costPerMOutput: number | undefined;
    let costBasis: PickCandidate["costBasis"];
    if (route.local) {
      costPerMOutput = 0;
      costBasis = "local";
    } else if (observed && observed.usd > 0 && observed.output > 0) {
      costPerMOutput = (observed.usd / observed.output) * 1_000_000;
      costBasis = "yours";
    } else if (
      costed.costKnown &&
      outputTokens(costed) >= MIN_COSTED_OUTPUT_TOKENS &&
      (!paidFor || costed.costUsd > 0)
    ) {
      costPerMOutput = (costed.costUsd / outputTokens(costed)) * 1_000_000;
      costBasis = !paidFor && costed === route ? "yours" : "other";
    } else if (group.benchmark?.price) {
      costPerMOutput = listCostPerMOutput(group.benchmark.price, mix);
      costBasis = "list";
    }

    const burns =
      route.local || route.instanceId === undefined
        ? []
        : windowBurns(accountOf(route)!, route.model, input);
    const limit = limitOf(burns, costPerMOutput);
    const plan = paidFor && {
      label: paidFor.label,
      monthlyUsd: paidFor.monthlyUsd,
      usedUsd: usedByInstance.get(accountOf(paidFor)!) ?? 0,
    };
    const subscription =
      plan !== undefined ||
      limit !== undefined ||
      (accountPlan?.providerIds !== undefined && !route.model.includes("/")) ||
      input.subscriptionAccounts?.has(accountOf(route) ?? "");
    let paidPerMOutput: number | undefined;
    if (route.local) paidPerMOutput = 0;
    else if (plan?.monthlyUsd === 0) paidPerMOutput = 0;
    else if (plan) {
      if (plan.usedUsd > 0 && costPerMOutput !== undefined) {
        paidPerMOutput = (costPerMOutput * plan.monthlyUsd) / plan.usedUsd;
      }
    } else if (!subscription) paidPerMOutput = costPerMOutput;
    const speed = speedOf(route, group.benchmark);
    return {
      key: group.key,
      label: group.label,
      route,
      used:
        group.routes.some((candidate) => candidate.responses > 0) ||
        group.grades.some((grades) => grades.runs > 0),
      ...(quality === undefined ? {} : { quality }),
      ...(draft.benchmarkQuality === undefined ? {} : { benchmarkQuality: draft.benchmarkQuality }),
      ...(draft.headlineBenchmark ? { headlineBenchmark: draft.headlineBenchmark } : {}),
      ...(draft.grade ? { grade: draft.grade } : {}),
      ...(group.benchmark?.figuresFrom === undefined
        ? {}
        : { figuresFrom: group.benchmark.figuresFrom }),
      ...(costPerMOutput === undefined ? {} : { costPerMOutput }),
      ...(costBasis === undefined ? {} : { costBasis }),
      ...(paidPerMOutput === undefined ? {} : { paidPerMOutput }),
      ...(group.benchmark?.outputTokensPerTask === undefined
        ? {}
        : { tokensPerTask: group.benchmark.outputTokensPerTask }),
      ...(plan ? { plan } : {}),
      ...(speed ? { speed } : {}),
      ...(limit ? { limit } : {}),
      billing: route.local ? "local" : subscription ? "subscription" : "metered",
    };
  });

  // Every score reads against the best model here, so the top is always 100.
  let top = 0;
  for (const candidate of candidates) top = Math.max(top, candidate.quality ?? 0);
  // The typical model's tokens for the public task set: the yardstick for "the same work".
  const typicalTokens = median(
    candidates.flatMap((candidate) =>
      candidate.tokensPerTask === undefined ? [] : [candidate.tokensPerTask],
    ),
  );
  const scaled: PickCandidate[] = candidates.map((candidate) => ({
    ...candidate,
    ...(top > 0 && candidate.quality !== undefined
      ? { quality: (candidate.quality / top) * 100 }
      : {}),
    ...(typicalTokens !== undefined && typicalTokens > 0 && candidate.tokensPerTask !== undefined
      ? { tokensForSameWork: candidate.tokensPerTask / typicalTokens }
      : {}),
  }));

  const clears = (kind: ModelPickKind) => (candidate: PickCandidate) =>
    candidate.quality !== undefined && candidate.quality >= PICK_QUALITY_FLOOR[kind] * 100;

  const quality = scaled
    .filter(clears("quality"))
    .sort((a, b) => b.quality! - a.quality! || a.key.localeCompare(b.key));
  const value = quality
    .filter(clears("value"))
    .filter((c) => realCostForSameWork(c) !== undefined)
    .sort(
      (a, b) =>
        valueScore(b) - valueScore(a) || b.quality! - a.quality! || a.key.localeCompare(b.key),
    );
  const speed = scaled
    .filter(clears("speed"))
    .filter((c) => c.speed !== undefined)
    .sort((a, b) => speedOrder(a, b) || a.key.localeCompare(b.key));
  const groupByKey = new Map(drafts.map((draft) => [draft.group.key, draft.group]));
  const frugal = scaled
    .map((candidate) => {
      const group = groupByKey.get(candidate.key);
      return group ? onLocalRoute(candidate, group, input.canStart) : candidate;
    })
    .filter(
      (c) =>
        realCostPerMOutput(c) !== undefined &&
        // Anything recommended needs evidence it is usable; a local model the
        // user already runs is free whatever it would score.
        (c.quality !== undefined || (c.billing === "local" && c.used)) &&
        // A subscription about to run out is no place to send work.
        (c.limit === undefined || c.limit.remainingPercent >= MIN_REMAINING_PERCENT),
    )
    .sort((a, b) => frugalOrder(a, b) || a.key.localeCompare(b.key));

  const pick = (kind: ModelPickKind, ranked: ReadonlyArray<PickCandidate>): ModelPick => ({
    kind,
    winner: ranked[0] ?? null,
    ranked: ranked.slice(0, 5),
  });
  return {
    picks: {
      quality: pick("quality", quality),
      value: pick("value", value),
      speed: pick("speed", speed),
      frugal: pick("frugal", frugal),
    },
    candidates: scaled,
    plans: planSummaries(input, plans, usedByInstance, unpricedTokensByInstance),
    bestQuality: top > 0 ? top : null,
    gradedRuns,
  };
}
