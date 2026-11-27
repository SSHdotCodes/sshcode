import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { ProviderDriverKind, RunAttemptId, RunId } from "@t3tools/contracts";

import {
  combineGenerations,
  endGenerationReply,
  formatGenerationRate,
  formatGenerationTokens,
  generationRateDetails,
  generationSnapshot,
  generationsByRun,
  makeGenerationMeter,
  markGenerationOutput,
  markGenerationRequest,
} from "./generationRate.ts";

const at = (ms: number) => DateTime.makeUnsafe(Date.UTC(2026, 10, 20, 12, 0, 0) + ms);

describe("generation meter", () => {
  it("times decode from the first output to the reply end, summed over replies", () => {
    const meter = makeGenerationMeter(at(0));
    markGenerationOutput(meter, at(1_400));
    markGenerationOutput(meter, at(2_000));
    endGenerationReply(meter, { outputTokens: 400, endedAt: at(6_400) });
    // A tool runs for 10 s; its result goes back at 16.4 s.
    markGenerationRequest(meter, at(16_400));
    markGenerationOutput(meter, at(17_400));
    endGenerationReply(meter, { outputTokens: 184, endedAt: at(19_400) });

    expect(generationSnapshot(meter)).toEqual({
      basis: "decode",
      outputTokens: 584,
      generatingMs: 7_000,
      replies: 2,
      totalOutputTokens: 584,
      lastReply: {
        outputTokens: 184,
        generatingMs: 2_000,
        firstTokenMs: 1_000,
        endedAt: DateTime.formatIso(at(19_400)),
      },
      updatedAt: DateTime.formatIso(at(19_400)),
    });
  });

  it("counts short or burst replies without rating them", () => {
    const meter = makeGenerationMeter(at(0));
    markGenerationOutput(meter, at(500));
    endGenerationReply(meter, { outputTokens: 23, endedAt: at(2_000) });
    expect(generationSnapshot(meter)).toBeUndefined();

    markGenerationOutput(meter, at(3_000));
    endGenerationReply(meter, { outputTokens: 500, endedAt: at(3_299) });
    expect(generationSnapshot(meter)).toBeUndefined();

    markGenerationOutput(meter, at(4_000));
    endGenerationReply(meter, { outputTokens: 24, endedAt: at(4_300) });
    expect(generationSnapshot(meter)).toMatchObject({
      outputTokens: 24,
      generatingMs: 300,
      replies: 3,
      totalOutputTokens: 547,
    });
  });

  it("falls back to end-to-end once a reply reasons out of sight", () => {
    const meter = makeGenerationMeter(at(0));
    markGenerationOutput(meter, at(1_000));
    endGenerationReply(meter, { outputTokens: 200, endedAt: at(3_000) });
    expect(generationSnapshot(meter)?.basis).toBe("decode");

    markGenerationRequest(meter, at(5_000));
    // Reasoning ran from 5 s; the first visible text came at 9 s.
    markGenerationOutput(meter, at(9_000));
    endGenerationReply(meter, { outputTokens: 600, endedAt: at(10_000), firstOutputHidden: true });

    const generation = generationSnapshot(meter);
    expect(generation).toMatchObject({
      basis: "end-to-end",
      outputTokens: 800,
      generatingMs: 8_000,
      replies: 2,
      lastReply: { outputTokens: 600, generatingMs: 5_000 },
    });
    expect(generation?.lastReply?.firstTokenMs).toBeUndefined();
  });

  it("ignores request marks while a reply streams", () => {
    const meter = makeGenerationMeter(at(0));
    markGenerationOutput(meter, at(2_000));
    markGenerationRequest(meter, at(2_500));
    endGenerationReply(meter, { outputTokens: 100, endedAt: at(3_000) });
    expect(generationSnapshot(meter)?.lastReply?.firstTokenMs).toBe(2_000);
  });

  it("reports no first-token delay for output from before the turn started", () => {
    // A frame replayed into a later turn keeps the time it arrived.
    const meter = makeGenerationMeter(at(5_000));
    markGenerationOutput(meter, at(1_000));
    endGenerationReply(meter, { outputTokens: 100, endedAt: at(3_000) });
    expect(generationSnapshot(meter)).toMatchObject({ outputTokens: 100, generatingMs: 2_000 });
    expect(generationSnapshot(meter)?.lastReply?.firstTokenMs).toBeUndefined();
  });

  it("keeps a subagent's replies out of the parent turn when fed to its own meter", () => {
    // Adapters give each owner (the turn, each subagent) its own meter.
    const parent = makeGenerationMeter(at(0));
    const subagent = makeGenerationMeter(at(500));
    markGenerationOutput(parent, at(1_000));
    markGenerationOutput(subagent, at(1_100));
    endGenerationReply(subagent, { outputTokens: 5_000, endedAt: at(11_100) });
    endGenerationReply(parent, { outputTokens: 100, endedAt: at(2_000) });

    expect(generationSnapshot(parent)).toMatchObject({
      outputTokens: 100,
      generatingMs: 1_000,
      replies: 1,
    });
    expect(generationSnapshot(subagent)).toMatchObject({ outputTokens: 5_000, replies: 1 });
  });
});

describe("generation formatting", () => {
  const decode = {
    basis: "decode" as const,
    outputTokens: 9_800,
    generatingMs: 116_667,
    replies: 12,
    totalOutputTokens: 9_820,
    lastReply: {
      outputTokens: 920,
      generatingMs: 10_000,
      firstTokenMs: 1_400,
      endedAt: "2026-11-20T12:00:00.000Z",
    },
    updatedAt: "2026-11-20T12:00:00.000Z",
  };

  it("rounds the rate and marks end-to-end", () => {
    expect(formatGenerationRate(decode)).toBe("84 tok/s");
    expect(formatGenerationRate({ ...decode, basis: "end-to-end" })).toBe("~84 tok/s");
    expect(formatGenerationRate({ ...decode, generatingMs: 0 })).toBeUndefined();
    expect(formatGenerationRate(undefined)).toBeUndefined();
  });

  it("compacts token counts", () => {
    expect([950, 1_000, 9_820, 12_400, 98_000, 1_240_000].map(formatGenerationTokens)).toEqual([
      "950",
      "1K",
      "9.8K",
      "12K",
      "98K",
      "1.2M",
    ]);
  });

  it("writes the tooltip lines", () => {
    expect(generationRateDetails(decode)).toEqual([
      "84 tok/s while writing · 12 replies, 9.8K tokens",
      "Last reply 92 tok/s · first token after 1.4 s",
    ]);
    const { firstTokenMs: _, ...lastWithoutFirstToken } = decode.lastReply;
    expect(
      generationRateDetails({
        ...decode,
        basis: "end-to-end",
        replies: 1,
        lastReply: lastWithoutFirstToken,
      }),
    ).toEqual([
      "~84 tok/s · 1 reply, 9.8K tokens",
      "Last reply ~92 tok/s",
      "Includes waiting for the first token",
    ]);
    expect(
      generationRateDetails({
        ...decode,
        lastReply: { ...decode.lastReply, firstTokenMs: 850 },
      })[1],
    ).toBe("Last reply 92 tok/s · first token after 850 ms");
  });
});

describe("run rates", () => {
  const generation = (
    basis: "decode" | "end-to-end",
    outputTokens: number,
    generatingMs: number,
    updatedAt: string,
  ) => ({
    basis,
    outputTokens,
    generatingMs,
    replies: 2,
    totalOutputTokens: outputTokens + 10,
    updatedAt,
  });

  it("sums a run's provider turns and leaves subagent turns out", () => {
    const run = RunId.make("run-1");
    const byRun = generationsByRun(
      [
        { id: RunAttemptId.make("attempt-1"), runId: run },
        { id: RunAttemptId.make("attempt-2"), runId: run },
      ],
      [
        {
          runAttemptId: RunAttemptId.make("attempt-1"),
          generation: generation("decode", 400, 5_000, "2026-11-20T12:00:01.000Z"),
        },
        {
          runAttemptId: RunAttemptId.make("attempt-2"),
          generation: generation("decode", 600, 5_000, "2026-11-20T12:00:02.000Z"),
        },
        {
          runAttemptId: null,
          generation: generation("decode", 9_000, 1_000, "2026-11-20T12:00:03.000Z"),
        },
        { runAttemptId: RunAttemptId.make("attempt-2") },
      ],
    );
    expect(byRun.get(run)).toMatchObject({
      basis: "decode",
      outputTokens: 1_000,
      generatingMs: 10_000,
      replies: 4,
      totalOutputTokens: 1_020,
      updatedAt: "2026-11-20T12:00:02.000Z",
    });
  });

  it("reports only the newest turn when the bases differ", () => {
    const newest = generation("end-to-end", 600, 10_000, "2026-11-20T12:00:02.000Z");
    expect(
      combineGenerations([generation("decode", 400, 2_000, "2026-11-20T12:00:01.000Z"), newest]),
    ).toEqual(newest);
  });

  it("uses the stored prompt window for a legacy ACP rate that counted hidden reasoning", () => {
    const runId = RunId.make("run-neon");
    const attemptId = RunAttemptId.make("attempt-neon");
    const endedAt = DateTime.formatIso(at(21_818));
    const persistedTurn = {
      runAttemptId: attemptId,
      nativeTurnRef: {
        driver: ProviderDriverKind.make("antigravity"),
        nativeId: "neon-turn",
        strength: "weak",
      },
      startedAt: at(0),
      generation: {
        basis: "decode",
        outputTokens: 349,
        generatingMs: 725,
        replies: 1,
        totalOutputTokens: 349,
        lastReply: { outputTokens: 349, generatingMs: 725, endedAt },
        updatedAt: endedAt,
      },
      turnTokenUsage: {
        inputTokens: 1_000,
        outputTokens: 349,
        reasoningTokens: 258,
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
      },
    } as const;
    const attempts = [{ id: attemptId, runId }];

    const corrected = generationsByRun(attempts, [persistedTurn]).get(runId);
    expect(corrected).toMatchObject({ basis: "end-to-end", generatingMs: 21_818 });
    expect(formatGenerationRate(corrected)).toBe("~16 tok/s");
    expect(formatGenerationRate(persistedTurn.generation)).toBe("481 tok/s");

    const withoutStart = generationsByRun(attempts, [{ ...persistedTurn, startedAt: null }]);
    expect(withoutStart.has(runId)).toBe(false);
  });
});
