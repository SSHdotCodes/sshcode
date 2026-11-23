// @effect-diagnostics nodeBuiltinImport:off -- Synthetic transcripts live in disposable test homes.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { readTranscriptRecords } from "../../usage/usageTranscriptReader.ts";
import { dedupeWithinFile } from "../../usage/usageScanCache.ts";
import { kimiUsageFormat } from "./kimiUsage.ts";

const usage = { inputOther: 11, inputCacheRead: 70, inputCacheCreation: 5, output: 9 };
const current = {
  type: "usage.record",
  agentId: "main",
  model: "kimi-code/k3.1-pro",
  usageScope: "turn",
  time: 1_793_880_000_000,
  usage,
};

describe("kimi usage", () => {
  it("reads modern agent wires, ignores context estimates and counts model calls once", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kimi-usage-"));
    try {
      const file = NodePath.join(home, "session-one", "agents", "main", "wire.jsonl");
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(
        file,
        [
          JSON.stringify(current),
          JSON.stringify(current),
          JSON.stringify({ ...current, model: "other/model", time: current.time + 1 }),
          JSON.stringify({ type: "token_counting.measured", tokens: 1000 }),
          "bad json",
          "",
        ].join("\n"),
      );
      const parsed = await readTranscriptRecords(file, kimiUsageFormat);
      const records = dedupeWithinFile(parsed!.records);
      expect(records).toHaveLength(2);
      expect(records[0]).toMatchObject({
        provider: "kimi",
        model: current.model,
        sessionId: "session-one",
        timestampMs: current.time,
        totals: {
          uncachedInputTokens: 11,
          cachedInputTokens: 70,
          cacheCreationTokens: 5,
          outputTokens: 9,
          reasoningTokens: 0,
        },
      });
      expect(records[1]?.model).toBe("other/model");
      expect(kimiUsageFormat.parseProjected(current, { sessionId: "session-one" })).toEqual(
        records.slice(0, 1),
      );
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reads legacy StatusUpdate request usage without inventing model attribution", () => {
    const entry = {
      timestamp: 1_793_880_000.125,
      message: {
        type: "StatusUpdate",
        payload: {
          message_id: "request-legacy",
          context_tokens: 99999,
          token_usage: { input_other: 7, input_cache_read: 20, input_cache_creation: 3, output: 4 },
        },
      },
    };
    const state = kimiUsageFormat.state!.initial("/kimi/sessions/project/session-two/wire.jsonl");
    expect(kimiUsageFormat.parseProjected(entry, state)[0]).toMatchObject({
      sessionId: "session-two",
      model: "Kimi Code (model unknown)",
      timestampMs: 1_793_880_000_125,
      totals: {
        uncachedInputTokens: 7,
        cachedInputTokens: 20,
        cacheCreationTokens: 3,
        outputTokens: 4,
        reasoningTokens: 0,
      },
    });
    expect(
      kimiUsageFormat.parseProjected(
        { ...entry, message: { ...entry.message, payload: { token_usage: null } } },
        state,
      ),
    ).toEqual([]);
    expect(
      kimiUsageFormat.parseProjected(
        { ...current, usage: { inputOther: -3, output: Infinity } },
        state,
      ),
    ).toEqual([]);
  });
});
