/**
 * Output speed of a turn, measured per model reply (one API response).
 *
 * Adapters feed a {@link GenerationMeter} the moments they observe, and the
 * provider's own output count when a reply ends; the meter never estimates
 * tokens. Clients format the resulting `generation` field on the provider turn.
 *
 * @module generationRate
 */
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderTurnGeneration,
  OrchestrationV2RunAttempt,
  RunId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Replies under this many output tokens count toward the turn but stay out of the rate. */
export const GENERATION_MIN_RATED_TOKENS = 24;
/** Replies whose window is shorter than this count toward the turn but stay out of the rate. */
export const GENERATION_MIN_RATED_MS = 300;

interface GenerationSum {
  outputTokens: number;
  generatingMs: number;
  replies: number;
  last: NonNullable<OrchestrationV2ProviderTurnGeneration["lastReply"]> | undefined;
}

export interface GenerationMeter {
  /** When the next reply's request went out, when known. */
  requestStartedAt: DateTime.Utc | undefined;
  /** First observed output of the reply in flight. */
  firstOutputAt: DateTime.Utc | undefined;
  replies: number;
  totalOutputTokens: number;
  readonly decode: GenerationSum;
  readonly endToEnd: GenerationSum;
  /**
   * A reply long enough to rate began with output nobody could see (silent
   * reasoning). Its decode window would be too short, so the turn reports
   * end-to-end from then on.
   */
  firstTokenHidden: boolean;
  updatedAt: DateTime.Utc | undefined;
}

const emptySum = (): GenerationSum => ({
  outputTokens: 0,
  generatingMs: 0,
  replies: 0,
  last: undefined,
});

/** One meter per provider turn. `startedAt` is the turn's first request, when known. */
export function makeGenerationMeter(startedAt?: DateTime.Utc): GenerationMeter {
  return {
    requestStartedAt: startedAt,
    firstOutputAt: undefined,
    replies: 0,
    totalOutputTokens: 0,
    decode: emptySum(),
    endToEnd: emptySum(),
    firstTokenHidden: false,
    updatedAt: undefined,
  };
}

/**
 * A request went out: the turn's prompt, or tool results sent back. The latest
 * one before a reply's first output is that reply's start; marks during a reply
 * belong to no request and are ignored.
 */
export function markGenerationRequest(meter: GenerationMeter, at: DateTime.Utc): void {
  if (meter.firstOutputAt !== undefined) return;
  if (meter.requestStartedAt === undefined || DateTime.isGreaterThan(at, meter.requestStartedAt)) {
    meter.requestStartedAt = at;
  }
}

/** Output of the reply in flight was observed (text, thinking or tool input). Only the first counts. */
export function markGenerationOutput(meter: GenerationMeter, at: DateTime.Utc): void {
  if (meter.firstOutputAt === undefined) meter.firstOutputAt = at;
}

/** Drops the reply in flight without counting it, for a stream that broke off. */
export function abandonGenerationReply(meter: GenerationMeter): void {
  meter.firstOutputAt = undefined;
}

const windowMs = (from: DateTime.Utc | undefined, to: DateTime.Utc): number | undefined =>
  from === undefined
    ? undefined
    : Math.max(0, DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from));

const rated = (outputTokens: number, ms: number | undefined): ms is number =>
  ms !== undefined && outputTokens >= GENERATION_MIN_RATED_TOKENS && ms >= GENERATION_MIN_RATED_MS;

/**
 * Ends the reply in flight with the provider's output count for it, reasoning
 * included. Pass `firstOutputHidden` when the reply reasoned before anything
 * observable streamed, so its first observed output is not its first token.
 * The next reply's request starts here unless a later request mark moves it.
 */
export function endGenerationReply(
  meter: GenerationMeter,
  reply: {
    readonly outputTokens: number;
    readonly endedAt: DateTime.Utc;
    readonly firstOutputHidden?: boolean;
  },
): void {
  const outputTokens = Math.max(0, Math.round(reply.outputTokens));
  const hidden = reply.firstOutputHidden === true || meter.firstOutputAt === undefined;
  const decodeMs = hidden ? undefined : windowMs(meter.firstOutputAt, reply.endedAt);
  const endToEndMs = windowMs(meter.requestStartedAt, reply.endedAt);
  // A frame replayed into a later turn can predate that turn's start: no delay to report.
  const firstTokenMs =
    hidden ||
    meter.firstOutputAt === undefined ||
    meter.requestStartedAt === undefined ||
    DateTime.isLessThan(meter.firstOutputAt, meter.requestStartedAt)
      ? undefined
      : windowMs(meter.requestStartedAt, meter.firstOutputAt);
  const endedAt = DateTime.formatIso(reply.endedAt);

  meter.replies += 1;
  meter.totalOutputTokens += outputTokens;
  if (rated(outputTokens, decodeMs)) {
    addToSum(meter.decode, {
      outputTokens,
      generatingMs: decodeMs,
      ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
      endedAt,
    });
  }
  if (rated(outputTokens, endToEndMs)) {
    addToSum(meter.endToEnd, {
      outputTokens,
      generatingMs: endToEndMs,
      ...(firstTokenMs === undefined ? {} : { firstTokenMs }),
      endedAt,
    });
    if (hidden) meter.firstTokenHidden = true;
  }
  meter.updatedAt = reply.endedAt;
  meter.requestStartedAt = reply.endedAt;
  meter.firstOutputAt = undefined;
}

function addToSum(sum: GenerationSum, reply: NonNullable<GenerationSum["last"]>): void {
  sum.outputTokens += reply.outputTokens;
  sum.generatingMs += reply.generatingMs;
  sum.replies += 1;
  sum.last = reply;
}

/** The provider turn's `generation` field, once a reply has made it into the rate. */
export function generationSnapshot(
  meter: GenerationMeter,
): OrchestrationV2ProviderTurnGeneration | undefined {
  const basis = meter.firstTokenHidden ? "end-to-end" : "decode";
  const sum = basis === "decode" ? meter.decode : meter.endToEnd;
  if (sum.replies === 0 || meter.updatedAt === undefined) return undefined;
  return {
    basis,
    outputTokens: sum.outputTokens,
    generatingMs: sum.generatingMs,
    replies: meter.replies,
    totalOutputTokens: meter.totalOutputTokens,
    ...(sum.last === undefined ? {} : { lastReply: sum.last }),
    updatedAt: DateTime.formatIso(meter.updatedAt),
  };
}

/**
 * One rate for several provider turns, such as a run whose goal spanned
 * several native turns. Turns timed on different bases do not add up, so a
 * mix reports only the newest turn.
 */
export function combineGenerations(
  generations: ReadonlyArray<OrchestrationV2ProviderTurnGeneration>,
): OrchestrationV2ProviderTurnGeneration | undefined {
  let latest: OrchestrationV2ProviderTurnGeneration | undefined;
  for (const generation of generations) {
    if (latest === undefined || generation.updatedAt > latest.updatedAt) latest = generation;
  }
  if (latest === undefined || generations.length === 1) return latest;
  if (generations.some((generation) => generation.basis !== latest.basis)) return latest;
  let outputTokens = 0;
  let generatingMs = 0;
  let replies = 0;
  let totalOutputTokens = 0;
  for (const generation of generations) {
    outputTokens += generation.outputTokens;
    generatingMs += generation.generatingMs;
    replies += generation.replies;
    totalOutputTokens += generation.totalOutputTokens;
  }
  return { ...latest, outputTokens, generatingMs, replies, totalOutputTokens };
}

/** Each run's rate, over the provider turns of all its attempts. Subagent turns belong to no run. */
export function generationsByRun(
  attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>,
  providerTurns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "runAttemptId" | "generation">>,
): ReadonlyMap<RunId, OrchestrationV2ProviderTurnGeneration> {
  const runByAttempt = new Map<string, RunId>();
  for (const attempt of attempts) runByAttempt.set(attempt.id, attempt.runId);
  const byRun = new Map<RunId, Array<OrchestrationV2ProviderTurnGeneration>>();
  for (const turn of providerTurns) {
    if (turn.generation === undefined || turn.runAttemptId === null) continue;
    const runId = runByAttempt.get(turn.runAttemptId);
    if (runId === undefined) continue;
    const list = byRun.get(runId);
    if (list === undefined) byRun.set(runId, [turn.generation]);
    else list.push(turn.generation);
  }
  const result = new Map<RunId, OrchestrationV2ProviderTurnGeneration>();
  for (const [runId, list] of byRun) {
    const combined = combineGenerations(list);
    if (combined !== undefined) result.set(runId, combined);
  }
  return result;
}

// --- Display -----------------------------------------------------------------

type GenerationRateInput = Pick<
  OrchestrationV2ProviderTurnGeneration,
  "basis" | "outputTokens" | "generatingMs"
>;

/** Tokens per second, or undefined when nothing has been timed. */
export function generationTokensPerSecond(
  generation: Pick<OrchestrationV2ProviderTurnGeneration, "outputTokens" | "generatingMs">,
): number | undefined {
  if (generation.generatingMs <= 0 || generation.outputTokens <= 0) return undefined;
  return generation.outputTokens / (generation.generatingMs / 1000);
}

/** `84 tok/s`, or `~84 tok/s` when the rate includes waiting for the first token. */
export function formatGenerationRate(
  generation: GenerationRateInput | undefined,
): string | undefined {
  if (generation === undefined) return undefined;
  const rate = generationTokensPerSecond(generation);
  if (rate === undefined) return undefined;
  return `${generation.basis === "end-to-end" ? "~" : ""}${Math.round(rate)} tok/s`;
}

/** `950`, `9.8K`, `98K`, `1.2M`. */
export function formatGenerationTokens(value: number): string {
  const rounded = Math.round(value);
  if (rounded < 1_000) return String(rounded);
  if (rounded < 10_000) return `${trimTenths(rounded / 1_000)}K`;
  if (rounded < 1_000_000) return `${Math.round(rounded / 1_000)}K`;
  return `${trimTenths(rounded / 1_000_000)}M`;
}

const trimTenths = (value: number) => value.toFixed(1).replace(/\.0$/, "");

/** `1.4 s`, `850 ms`. */
function formatFirstTokenDelay(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)} ms` : `${trimTenths(ms / 1_000)} s`;
}

/**
 * Tooltip lines for a turn's rate:
 * `84 tok/s while writing · 12 replies, 9.8K tokens`,
 * `Last reply 92 tok/s · first token after 1.4 s`, and for end-to-end rates
 * `Includes waiting for the first token`.
 */
export function generationRateDetails(
  generation: OrchestrationV2ProviderTurnGeneration | undefined,
): ReadonlyArray<string> {
  const rate = formatGenerationRate(generation);
  if (generation === undefined || rate === undefined) return [];
  const replies = `${generation.replies} ${generation.replies === 1 ? "reply" : "replies"}`;
  const lines = [
    `${rate}${generation.basis === "decode" ? " while writing" : ""} · ${replies}, ${formatGenerationTokens(generation.totalOutputTokens)} tokens`,
  ];
  const last = generation.lastReply;
  const lastRate = last === undefined ? undefined : generationTokensPerSecond(last);
  if (last !== undefined && lastRate !== undefined) {
    lines.push(
      `Last reply ${generation.basis === "end-to-end" ? "~" : ""}${Math.round(lastRate)} tok/s${
        last.firstTokenMs === undefined
          ? ""
          : ` · first token after ${formatFirstTokenDelay(last.firstTokenMs)}`
      }`,
    );
  }
  if (generation.basis === "end-to-end") lines.push("Includes waiting for the first token");
  return lines;
}
