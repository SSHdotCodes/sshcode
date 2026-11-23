import {
  endGenerationReply,
  type GenerationMeter,
  makeGenerationMeter,
  markGenerationOutput,
  markGenerationRequest,
} from "@t3tools/shared/generationRate";
import type * as DateTime from "effect/DateTime";

/**
 * Reply timing for one Codex turn. A reply is one model response, and its
 * `thread/tokenUsage/updated` report carries the response's own (`last`)
 * output count, reasoning included. That report only comes once the
 * response's tools have run, so it cannot end the reply's window:
 * `turn/moderationMetadata` arrives as the response finishes, and the first
 * tool starting is the fallback. Codex delivers reasoning items whole, so a
 * reply that reasoned without streaming raw reasoning text had its first
 * token out of sight and is timed end-to-end.
 */
export interface CodexGeneration {
  readonly meter: GenerationMeter;
  responseEndedAt: DateTime.Utc | undefined;
  firstToolStartedAt: DateTime.Utc | undefined;
  reasoningStreamed: boolean;
  observed: boolean;
}

export function makeCodexGeneration(startedAt: DateTime.Utc): CodexGeneration {
  return {
    meter: makeGenerationMeter(startedAt),
    responseEndedAt: undefined,
    firstToolStartedAt: undefined,
    reasoningStreamed: false,
    observed: false,
  };
}

/** Streamed model output: message text, plan text, or raw reasoning text. */
export function observeCodexOutput(
  generation: CodexGeneration,
  at: DateTime.Utc,
  kind: "text" | "reasoning",
): void {
  if (generation.responseEndedAt !== undefined) return;
  if (kind === "reasoning" && generation.meter.firstOutputAt === undefined) {
    generation.reasoningStreamed = true;
  }
  generation.observed = true;
  markGenerationOutput(generation.meter, at);
}

/** Codex reported the response's moderation metadata: the response is done. */
export function observeCodexResponseEnd(generation: CodexGeneration, at: DateTime.Utc): void {
  generation.observed = true;
  generation.responseEndedAt ??= at;
}

/** A tool item started: the model finished writing that call. */
export function observeCodexToolStart(generation: CodexGeneration, at: DateTime.Utc): void {
  generation.observed = true;
  generation.firstToolStartedAt ??= at;
}

/**
 * A usage report for a new response, received at `at`. Ends the reply and
 * starts the next request: Codex sends it as soon as this report is out.
 */
export function endCodexReply(
  generation: CodexGeneration,
  report: {
    readonly outputTokens: number;
    readonly reasoningOutputTokens: number;
    readonly at: DateTime.Utc;
  },
): void {
  endGenerationReply(generation.meter, {
    outputTokens: report.outputTokens,
    endedAt: generation.responseEndedAt ?? generation.firstToolStartedAt ?? report.at,
    firstOutputHidden: report.reasoningOutputTokens > 0 && !generation.reasoningStreamed,
  });
  markGenerationRequest(generation.meter, report.at);
  generation.responseEndedAt = undefined;
  generation.firstToolStartedAt = undefined;
  generation.reasoningStreamed = false;
  generation.observed = false;
}
