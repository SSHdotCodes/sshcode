import { describe, expect, it } from "@effect/vitest";
import { generationSnapshot } from "@t3tools/shared/generationRate";
import * as DateTime from "effect/DateTime";

import { makeOpenCodeGeneration, meterOpenCodeEvent } from "./generation.ts";
import type { OpenCode2StreamEvent } from "./OpenCode2Client.ts";

const event = (type: string, data: Record<string, unknown> = {}, created = 0) =>
  ({
    id: `evt-${type}`,
    created,
    type,
    location: { directory: "/workspace" },
    data: { sessionID: "ses-generation", ...data },
  }) as unknown as OpenCode2StreamEvent;

const tokens = (output: number, reasoning: number) => ({
  input: 1_000,
  output,
  reasoning,
  cache: { read: 0, write: 0 },
});

describe("OpenCode step timing", () => {
  it("times visible steps from first output, and hidden-reasoning steps end to end", () => {
    const generation = makeOpenCodeGeneration();
    const timeline: ReadonlyArray<readonly [number, OpenCode2StreamEvent]> = [
      [0, event("session.step.started")],
      // Reasoning that shows from its start is the step's first output.
      [800, event("session.reasoning.started", { reasoningID: "r1" })],
      [900, event("session.reasoning.delta", { reasoningID: "r1", delta: "Plan" })],
      [2_000, event("session.tool.input.started", { id: "call-1", name: "bash" })],
      [4_800, event("session.step.ended", { finish: "tool-calls", tokens: tokens(300, 100) })],
      // The tool runs; the next step's request goes out at 9 s.
      [9_000, event("session.step.started")],
      // This step reasoned with nothing to show before its text.
      [13_000, event("session.text.started", { textID: "t1" })],
      [13_100, event("session.text.delta", { textID: "t1", delta: "Done" })],
      [14_000, event("session.step.ended", { finish: "stop", tokens: tokens(100, 400) })],
    ];
    const ended: Array<number> = [];
    for (const [ms, frame] of timeline) {
      if (meterOpenCodeEvent(generation, frame, DateTime.makeUnsafe(ms))) ended.push(ms);
    }

    expect(ended).toEqual([4_800, 14_000]);
    expect(generationSnapshot(generation.meter)).toEqual({
      basis: "end-to-end",
      // 400 tokens over 0–4.8 s, then 500 over 9–14 s.
      outputTokens: 900,
      generatingMs: 9_800,
      replies: 2,
      totalOutputTokens: 900,
      lastReply: {
        outputTokens: 500,
        generatingMs: 5_000,
        endedAt: DateTime.formatIso(DateTime.makeUnsafe(14_000)),
      },
      updatedAt: DateTime.formatIso(DateTime.makeUnsafe(14_000)),
    });
  });

  it("rates a turn of visible steps by decode time", () => {
    const generation = makeOpenCodeGeneration();
    meterOpenCodeEvent(generation, event("session.step.started"), DateTime.makeUnsafe(0));
    meterOpenCodeEvent(generation, event("session.text.started"), DateTime.makeUnsafe(1_500));
    meterOpenCodeEvent(
      generation,
      event("session.step.ended", { finish: "stop", tokens: tokens(400, 0) }),
      DateTime.makeUnsafe(6_500),
    );
    expect(generationSnapshot(generation.meter)).toMatchObject({
      basis: "decode",
      outputTokens: 400,
      generatingMs: 5_000,
      lastReply: { firstTokenMs: 1_500 },
    });
  });

  it("uses end-to-end timing when a reasoning stream only contains a summary", () => {
    const generation = makeOpenCodeGeneration();
    meterOpenCodeEvent(generation, event("session.step.started"), DateTime.makeUnsafe(0));
    meterOpenCodeEvent(generation, event("session.reasoning.started"), DateTime.makeUnsafe(3_900));
    meterOpenCodeEvent(
      generation,
      event("session.reasoning.delta", { delta: "A summary" }),
      DateTime.makeUnsafe(4_000),
    );
    meterOpenCodeEvent(generation, event("session.text.started"), DateTime.makeUnsafe(4_100));
    meterOpenCodeEvent(
      generation,
      event("session.step.ended", { finish: "stop", tokens: tokens(91, 258) }),
      DateTime.makeUnsafe(4_825),
    );
    expect(generationSnapshot(generation.meter)).toMatchObject({
      basis: "end-to-end",
      outputTokens: 349,
      generatingMs: 4_825,
    });
  });

  it("uses the native request and response boundaries even when the frames arrive together", () => {
    const generation = makeOpenCodeGeneration();
    const receivedAt = DateTime.makeUnsafe(50_000);
    for (const frame of [
      event("session.step.started", { started: 1_000 }, 6_000),
      event("session.text.started", {}, 6_100),
      event("session.step.streamed", {}, 7_000),
      event("session.step.ended", { tokens: tokens(91, 258), finish: "tool-calls" }, 49_000),
    ]) {
      meterOpenCodeEvent(generation, frame, receivedAt);
    }
    expect(generationSnapshot(generation.meter)).toMatchObject({
      basis: "end-to-end",
      outputTokens: 349,
      generatingMs: 6_000,
    });
  });

  it("drops a failed step without counting it", () => {
    const generation = makeOpenCodeGeneration();
    meterOpenCodeEvent(generation, event("session.step.started"), DateTime.makeUnsafe(0));
    meterOpenCodeEvent(generation, event("session.text.started"), DateTime.makeUnsafe(500));
    meterOpenCodeEvent(generation, event("session.step.failed"), DateTime.makeUnsafe(2_000));
    expect(generation.meter.replies).toBe(0);
    expect(generationSnapshot(generation.meter)).toBeUndefined();
  });
});
