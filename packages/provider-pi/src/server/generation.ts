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
 * carries its usage. Pi's output count includes thinking but does not split
 * it out, so a message holding a thinking block that never streamed is timed
 * end-to-end.
 */
export interface PiGeneration {
  readonly meter: GenerationMeter;
  thinkingSeen: boolean;
}

export function makePiGeneration(startedAt: DateTime.Utc): PiGeneration {
  return { meter: makeGenerationMeter(startedAt), thinkingSeen: false };
}

const OUTPUT_EVENTS = new Set([
  "text_start",
  "text_delta",
  "thinking_start",
  "thinking_delta",
  "toolcall_start",
  "toolcall_delta",
]);

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
      generation.thinkingSeen = false;
      return false;
    case "message_update": {
      const type = recordString(event["assistantMessageEvent"], "type");
      if (type === undefined || !OUTPUT_EVENTS.has(type)) return false;
      if (type.startsWith("thinking_") && generation.meter.firstOutputAt === undefined) {
        generation.thinkingSeen = true;
      }
      markGenerationOutput(generation.meter, at);
      return false;
    }
    case "message_end": {
      const message = event["message"];
      if (recordString(message, "role") !== "assistant") return false;
      const outputTokens = recordNumber(recordField(message, "usage"), "output");
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
      const thought =
        Array.isArray(content) &&
        content.some((block) => recordString(block, "type") === "thinking");
      endGenerationReply(generation.meter, {
        outputTokens,
        endedAt: at,
        firstOutputHidden: thought && !generation.thinkingSeen,
      });
      generation.thinkingSeen = false;
      return true;
    }
    default:
      return false;
  }
}
