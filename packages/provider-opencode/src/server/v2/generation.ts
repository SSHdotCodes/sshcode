import {
  abandonGenerationReply,
  endGenerationReply,
  type GenerationMeter,
  makeGenerationMeter,
  markGenerationOutput,
  markGenerationRequest,
} from "@t3tools/shared/generationRate";
import * as DateTime from "effect/DateTime";

import type { OpenCode2StreamEvent } from "./OpenCode2Client.ts";

/**
 * Reply timing for one OpenCode turn. Use native event timestamps so queued
 * SSE frames do not compress the observed window, and stop timing when the
 * response body finishes even if step usage arrives after tools settle.
 * Reasoning deltas can be summaries, so time steps that count it end-to-end.
 */
export interface OpenCodeGeneration {
  readonly meter: GenerationMeter;
  responseEndedAt: DateTime.Utc | undefined;
}

export function makeOpenCodeGeneration(): OpenCodeGeneration {
  return { meter: makeGenerationMeter(), responseEndedAt: undefined };
}

function eventTime(event: OpenCode2StreamEvent, receivedAt: DateTime.Utc): DateTime.Utc {
  return "created" in event && event.created > 0
    ? DateTime.makeUnsafe(Math.round(event.created))
    : receivedAt;
}

/** Feeds one event of the turn's session, observed at `at`; true when a step ended. */
export function meterOpenCodeEvent(
  generation: OpenCodeGeneration,
  event: OpenCode2StreamEvent,
  at: DateTime.Utc,
): boolean {
  switch (event.type) {
    case "session.step.started": {
      abandonGenerationReply(generation.meter);
      generation.responseEndedAt = undefined;
      const started = event.data.started;
      const occurredAt = eventTime(event, at);
      markGenerationRequest(
        generation.meter,
        started > 0 && started <= DateTime.toEpochMillis(occurredAt)
          ? DateTime.makeUnsafe(started)
          : occurredAt,
      );
      return false;
    }
    case "session.step.streamed":
      generation.responseEndedAt ??= eventTime(event, at);
      return false;
    case "session.text.started":
    case "session.text.delta":
    case "session.tool.input.started":
      markGenerationOutput(generation.meter, eventTime(event, at));
      return false;
    case "session.step.failed":
      abandonGenerationReply(generation.meter);
      generation.responseEndedAt = undefined;
      return false;
    case "session.step.ended": {
      const endedAt = generation.responseEndedAt ?? eventTime(event, at);
      generation.responseEndedAt = undefined;
      const tokens = event.data.tokens;
      if (tokens === undefined) {
        abandonGenerationReply(generation.meter);
        return false;
      }
      // OpenCode counts reasoning apart from output.
      endGenerationReply(generation.meter, {
        outputTokens: tokens.output + tokens.reasoning,
        endedAt,
        firstOutputHidden: tokens.reasoning > 0,
      });
      return true;
    }
    default:
      return false;
  }
}
