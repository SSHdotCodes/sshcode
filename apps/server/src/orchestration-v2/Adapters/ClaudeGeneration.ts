import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  abandonGenerationReply,
  endGenerationReply,
  type GenerationMeter,
  makeGenerationMeter,
  markGenerationOutput,
  markGenerationRequest,
} from "@t3tools/shared/generationRate";
import type * as DateTime from "effect/DateTime";

export interface ClaudeGeneration {
  readonly meter: GenerationMeter;
  hiddenThinking: boolean;
}

export function makeClaudeGeneration(startedAt: DateTime.Utc): ClaudeGeneration {
  return { meter: makeGenerationMeter(startedAt), hiddenThinking: false };
}

/**
 * Feeds one Claude SDK frame, observed at `at`, to the root turn's meter and
 * reports whether a reply ended. A reply is one API message: it starts with
 * `message_start` and `message_delta` ends it with the API's output count.
 * Thinking is omitted, redacted or summarized while usage counts the original
 * tokens, so those replies are timed end-to-end. Subagent frames are excluded.
 */
export function meterClaudeGenerationFrame(
  generation: ClaudeGeneration,
  message: SDKMessage,
  at: DateTime.Utc,
): boolean {
  if ("parent_tool_use_id" in message && message.parent_tool_use_id != null) return false;
  const { meter } = generation;
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
      generation.hiddenThinking = false;
      return false;
    case "content_block_start": {
      const type = event.content_block.type;
      if (type === "thinking" || type === "redacted_thinking") {
        generation.hiddenThinking = true;
        return false;
      }
      markGenerationOutput(meter, at);
      return false;
    }
    case "content_block_delta": {
      const type = event.delta.type;
      if (type === "thinking_delta" || type === "signature_delta") {
        generation.hiddenThinking = true;
        return false;
      }
      markGenerationOutput(meter, at);
      return false;
    }
    case "message_delta": {
      const usage: typeof event.usage & {
        readonly output_tokens_details?: { readonly thinking_tokens?: number } | null;
      } = event.usage;
      const outputTokens = usage.output_tokens;
      if (typeof outputTokens !== "number" || !Number.isFinite(outputTokens)) return false;
      endGenerationReply(meter, {
        outputTokens,
        endedAt: at,
        firstOutputHidden:
          generation.hiddenThinking || (usage.output_tokens_details?.thinking_tokens ?? 0) > 0,
      });
      generation.hiddenThinking = false;
      return true;
    }
    default:
      return false;
  }
}
