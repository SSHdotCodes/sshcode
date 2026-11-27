import {
  abandonGenerationReply,
  endGenerationReply,
  type GenerationMeter,
  makeGenerationMeter,
  markGenerationOutput,
  markGenerationRequest,
} from "@t3tools/shared/generationRate";
import type * as DateTime from "effect/DateTime";

import {
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcRecord,
} from "./rpc.ts";

/**
 * Reply timing for one Pi turn. A reply is one assistant message: the request
 * goes out at `agent_start`/`turn_start` or once a tool's result is back, the
 * message's first streamed block is its first output, and `message_end`
 * carries its usage. Pi's thinking blocks can carry provider summaries.
 * Time reasoning output end-to-end when usage or a thinking block reports it.
 */
export interface PiGeneration {
  readonly meter: GenerationMeter;
  sawThinking: boolean;
}

export function makePiGeneration(startedAt: DateTime.Utc): PiGeneration {
  return { meter: makeGenerationMeter(startedAt), sawThinking: false };
}

const OUTPUT_EVENTS = new Set(["text_start", "text_delta", "toolcall_start", "toolcall_delta"]);

/** Feeds one Pi RPC event, observed at `at`; true when an assistant message ended. */
export function meterPiEvent(
  generation: PiGeneration,
  event: PiRpcRecord,
  at: DateTime.Utc,
): boolean {
  switch (event["type"]) {
    case "agent_start":
    case "turn_start":
    case "tool_execution_end":
      markGenerationRequest(generation.meter, at);
      return false;
    case "message_start":
      if (recordString(event["message"], "role") !== "assistant") return false;
      abandonGenerationReply(generation.meter);
      generation.sawThinking = false;
      return false;
    case "message_update": {
      const type = recordString(event["assistantMessageEvent"], "type");
      if (type === "thinking_start" || type === "thinking_delta") generation.sawThinking = true;
      if (type !== undefined && OUTPUT_EVENTS.has(type)) markGenerationOutput(generation.meter, at);
      return false;
    }
    case "message_end": {
      const message = event["message"];
      if (recordString(message, "role") !== "assistant") return false;
      const usage = recordField(message, "usage");
      const outputTokens = recordNumber(usage, "output");
      const stopReason = recordString(message, "stopReason");
      if (
        outputTokens === undefined ||
        !Number.isFinite(outputTokens) ||
        stopReason === "error" ||
        stopReason === "aborted"
      ) {
        abandonGenerationReply(generation.meter);
        return false;
      }
      const content = recordField(message, "content");
      const hiddenThinking =
        (recordNumber(usage, "reasoning") ?? 0) > 0 ||
        generation.sawThinking ||
        (Array.isArray(content) &&
          content.some((block) => recordString(block, "type") === "thinking"));
      endGenerationReply(generation.meter, {
        outputTokens,
        endedAt: at,
        firstOutputHidden: hiddenThinking,
      });
      generation.sawThinking = false;
      return true;
    }
    default:
      return false;
  }
}
