import {
  abandonGenerationReply,
  endGenerationReply,
  type GenerationMeter,
  makeGenerationMeter,
  markGenerationOutput,
  markGenerationRequest,
} from "@t3tools/shared/generationRate";
import type * as DateTime from "effect/DateTime";

import type { OpenCode2StreamEvent } from "./OpenCode2Client.ts";

/**
 * Reply timing for one OpenCode turn. A reply is one step (one model call):
 * `session.step.started` sends its request, its first text, reasoning or tool
 * input is its first output, and `session.step.ended` ends it with the step's
 * own token counts. A step that reasoned without showing any reasoning had its
 * first token out of sight and is timed end-to-end.
 */
export interface OpenCodeGeneration {
  readonly meter: GenerationMeter;
  reasoningSeen: boolean;
}

export function makeOpenCodeGeneration(): OpenCodeGeneration {
  return { meter: makeGenerationMeter(), reasoningSeen: false };
}

/** Feeds one event of the turn's session, observed at `at`; true when a step ended. */
export function meterOpenCodeEvent(
  generation: OpenCodeGeneration,
  event: OpenCode2StreamEvent,
  at: DateTime.Utc,
): boolean {
  switch (event.type) {
    case "session.step.started":
      abandonGenerationReply(generation.meter);
      generation.reasoningSeen = false;
      markGenerationRequest(generation.meter, at);
      return false;
    case "session.reasoning.started":
    case "session.reasoning.delta":
      if (generation.meter.firstOutputAt === undefined) generation.reasoningSeen = true;
      markGenerationOutput(generation.meter, at);
      return false;
    case "session.text.started":
    case "session.text.delta":
    case "session.tool.input.started":
      markGenerationOutput(generation.meter, at);
      return false;
    case "session.step.failed":
      abandonGenerationReply(generation.meter);
      return false;
    case "session.step.ended": {
      const tokens = event.data.tokens;
      if (tokens === undefined) {
        abandonGenerationReply(generation.meter);
        return false;
      }
      // OpenCode counts reasoning apart from output.
      endGenerationReply(generation.meter, {
        outputTokens: tokens.output + tokens.reasoning,
        endedAt: at,
        firstOutputHidden: tokens.reasoning > 0 && !generation.reasoningSeen,
      });
      generation.reasoningSeen = false;
      return true;
    }
    default:
      return false;
  }
}
