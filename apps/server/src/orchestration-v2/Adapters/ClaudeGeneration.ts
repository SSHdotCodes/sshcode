import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  abandonGenerationReply,
  endGenerationReply,
  type GenerationMeter,
  markGenerationOutput,
  markGenerationRequest,
} from "@t3tools/shared/generationRate";
import type * as DateTime from "effect/DateTime";

/**
 * Feeds one Claude SDK frame, observed at `at`, to the root turn's meter and
 * reports whether a reply ended. A reply is one API message: it starts with
 * `message_start`, its first content block (thinking included, even when the
 * display omits its text) is its first output, and `message_delta` ends it with
 * the API's output count. Frames with a `parent_tool_use_id` belong to a
 * subagent and never touch the parent's rate.
 */
export function meterClaudeGenerationFrame(
  meter: GenerationMeter,
  message: SDKMessage,
  at: DateTime.Utc,
): boolean {
  if ("parent_tool_use_id" in message && message.parent_tool_use_id != null) return false;
  if (message.type === "user") {
    // Tool results going back; the CLI sends the next request right after.
    markGenerationRequest(meter, at);
    return false;
  }
  if (message.type === "system" && message.subtype === "status") {
    if (message.status === "requesting") markGenerationRequest(meter, at);
    return false;
  }
  if (message.type !== "stream_event") return false;
  const event = message.event;
  switch (event.type) {
    case "message_start":
      // A message that started while another streamed means the first broke off.
      abandonGenerationReply(meter);
      return false;
    case "content_block_start":
    case "content_block_delta":
      markGenerationOutput(meter, at);
      return false;
    case "message_delta": {
      const outputTokens = event.usage.output_tokens;
      if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens)) return false;
      endGenerationReply(meter, { outputTokens, endedAt: at });
      return true;
    }
    default:
      return false;
  }
}
