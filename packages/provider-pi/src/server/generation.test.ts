import { describe, expect, it } from "@effect/vitest";
import { generationSnapshot } from "@t3tools/shared/generationRate";
import * as DateTime from "effect/DateTime";

import { makePiGeneration, meterPiEvent } from "./generation.ts";
import type { PiRpcRecord } from "./rpc.ts";

const update = (type: string): PiRpcRecord => ({
  type: "message_update",
  assistantMessageEvent: { type, contentIndex: 0, delta: "…" },
});
const assistantEnd = (
  output: number,
  content: ReadonlyArray<string>,
  stopReason = "toolUse",
  reasoning?: number,
): PiRpcRecord => ({
  type: "message_end",
  message: {
    role: "assistant",
    stopReason,
    content: content.map((type) => ({ type })),
    usage: {
      input: 900,
      output,
      reasoning,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 900 + output,
    },
  },
});

describe("Pi message timing", () => {
  it("times streamed thought summaries and hidden thinking end to end", () => {
    const generation = makePiGeneration(DateTime.makeUnsafe(0));
    const timeline: ReadonlyArray<readonly [number, PiRpcRecord]> = [
      [0, { type: "agent_start" }],
      [1_200, { type: "message_start", message: { role: "assistant" } }],
      [1_200, update("thinking_start")],
      [1_300, update("thinking_delta")],
      [2_000, update("toolcall_start")],
      [4_200, assistantEnd(330, ["thinking", "toolCall"])],
      [4_300, { type: "tool_execution_start" }],
      // The tool's result goes back at 7 s.
      [7_000, { type: "tool_execution_end" }],
      [7_000, { type: "turn_start" }],
      [10_000, { type: "message_start", message: { role: "assistant" } }],
      // It thought without streaming it; only its text showed.
      [10_000, update("text_start")],
      [11_000, assistantEnd(500, ["thinking", "text"], "stop")],
    ];
    const ended: Array<number> = [];
    for (const [ms, event] of timeline) {
      if (meterPiEvent(generation, event, DateTime.makeUnsafe(ms))) {
        ended.push(ms);
        if (ms === 4_200) {
          expect(generationSnapshot(generation.meter)).toMatchObject({
            basis: "end-to-end",
            generatingMs: 4_200,
          });
        }
      }
    }

    expect(ended).toEqual([4_200, 11_000]);
    expect(generationSnapshot(generation.meter)).toEqual({
      basis: "end-to-end",
      // 330 tokens over 0–4.2 s, then 500 over 7–11 s.
      outputTokens: 830,
      generatingMs: 8_200,
      replies: 2,
      totalOutputTokens: 830,
      lastReply: {
        outputTokens: 500,
        generatingMs: 4_000,
        endedAt: DateTime.formatIso(DateTime.makeUnsafe(11_000)),
      },
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(11_000)),
    });
  });

  it("rates streamed messages by decode time and skips errored ones", () => {
    const generation = makePiGeneration(DateTime.makeUnsafe(0));
    meterPiEvent(generation, { type: "agent_start" }, DateTime.makeUnsafe(0));
    meterPiEvent(
      generation,
      { type: "message_start", message: { role: "assistant" } },
      DateTime.makeUnsafe(900),
    );
    meterPiEvent(generation, update("text_start"), DateTime.makeUnsafe(1_000));
    meterPiEvent(generation, assistantEnd(250, ["text"], "error"), DateTime.makeUnsafe(2_000));
    expect(generation.meter.replies).toBe(0);

    meterPiEvent(
      generation,
      { type: "message_start", message: { role: "assistant" } },
      DateTime.makeUnsafe(3_000),
    );
    meterPiEvent(generation, update("text_start"), DateTime.makeUnsafe(3_500));
    meterPiEvent(generation, assistantEnd(250, ["text"], "stop"), DateTime.makeUnsafe(6_000));
    expect(generationSnapshot(generation.meter)).toMatchObject({
      basis: "decode",
      outputTokens: 250,
      generatingMs: 2_500,
      replies: 1,
    });
  });

  it("uses end-to-end timing when usage counts thinking with no thinking block", () => {
    const generation = makePiGeneration(DateTime.makeUnsafe(0));
    meterPiEvent(generation, update("text_start"), DateTime.makeUnsafe(4_000));
    meterPiEvent(generation, assistantEnd(349, ["text"], "stop", 258), DateTime.makeUnsafe(4_725));
    expect(generationSnapshot(generation.meter)).toMatchObject({
      basis: "end-to-end",
      outputTokens: 349,
      generatingMs: 4_725,
    });
  });
});
