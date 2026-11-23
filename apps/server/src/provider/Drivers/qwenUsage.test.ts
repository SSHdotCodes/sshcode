// @effect-diagnostics nodeBuiltinImport:off -- Synthetic transcripts live in disposable test homes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { totalTokens } from "@t3tools/provider-core/server/usage";
import { readTranscriptRecords } from "../../usage/usageTranscriptReader.ts";
import { UsageAggregator } from "../../usage/usageAggregation.ts";
import { qwenUsageFormat } from "./qwenUsage.ts";

const request = {
  type: "assistant",
  uuid: "request-1",
  sessionId: "session-1",
  model: "unknown-qwen-model",
  timestamp: "2026-11-05T12:00:00Z",
  usageMetadata: {
    promptTokenCount: 100,
    cachedContentTokenCount: 80,
    candidatesTokenCount: 12,
    thoughtsTokenCount: 8,
  },
};

describe("qwen usage", () => {
  it("streams requests once, splits cached input and includes thoughts in output", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "qwen-usage-"));
    try {
      const file = NodePath.join(home, "chat.jsonl");
      NodeFS.writeFileSync(
        file,
        [
          JSON.stringify(request),
          JSON.stringify({ ...request, sessionId: "fork-session" }),
          "{bad json",
          // The session summary is not another request.
          JSON.stringify({
            sessionId: "session-1",
            models: { "unknown-qwen-model": { inputTokens: 100, outputTokens: 20 } },
          }),
          JSON.stringify({ ...request, type: "user" }),
          "",
        ].join("\n"),
      );
      const parsed = await readTranscriptRecords(file, qwenUsageFormat);
      expect(parsed?.records).toHaveLength(2);
      expect(parsed?.records[0]?.totals).toEqual({
        uncachedInputTokens: 20,
        cachedInputTokens: 80,
        cacheCreationTokens: 0,
        outputTokens: 20,
        reasoningTokens: 8,
      });
      expect(totalTokens(parsed!.records[0]!.totals)).toBe(120);
      const aggregator = new UsageAggregator({
        timeZone: "UTC",
        sinceDay: "2026-11-01",
        untilDay: "2026-11-07",
        rates: new Map(),
      });
      for (const record of parsed!.records) aggregator.add(record);
      expect(aggregator.finish()).toMatchObject({
        duplicatesDropped: 1,
        buckets: [
          {
            provider: "qwen-code",
            records: 1,
            sessions: 1,
            costSource: "unpriced",
            unpricedRecords: 1,
          },
        ],
      });
      expect(qwenUsageFormat.parseProjected(request, undefined)).toEqual(
        parsed?.records.slice(0, 1),
      );
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("clamps invalid counters and rejects incomplete records", () => {
    expect(
      qwenUsageFormat.parseProjected(
        {
          ...request,
          usageMetadata: {
            promptTokenCount: 5,
            cachedContentTokenCount: 20,
            candidatesTokenCount: -10,
            thoughtsTokenCount: NaN,
          },
        },
        undefined,
      )[0]?.totals,
    ).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 5,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
    for (const value of [
      { ...request, timestamp: "bad" },
      { ...request, uuid: "" },
      { ...request, usageMetadata: {} },
      null,
    ]) {
      expect(qwenUsageFormat.parseProjected(value, undefined)).toEqual([]);
    }
  });
});
