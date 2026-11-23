import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { totalTokens } from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { museUsageFormat, museUsageReader } from "./usage.ts";

/** Shaped after a real Muse runtime.session model_completed record. */
function modelCompleted(usage: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    id: "19b6d531-0ef2-430c-920d-8ce719f92f90",
    stream: { kind: "session", id: "01a138c8-27b9-73c3-a592-87ce7d5b4655" },
    sequence: 66,
    recorded_at: 1_792_040_823_840_487,
    record_type: "event",
    payload_type: "runtime.session",
    payload: {
      kind: "run",
      run_id: "run-1",
      event: {
        kind: "model_completed",
        usage: {
          input_tokens: 55_803,
          output_tokens: 338,
          cached_tokens: 55_156,
          cache_write_tokens: 0,
          cache_read_tokens: 55_156,
          reasoning_tokens: 317,
          ...usage,
        },
        duration_ms: 4_552,
        model: "muse-wonder-1.0",
      },
    },
  };
}

const parse = (record: unknown) => museUsageFormat.parseLine(JSON.stringify(record), undefined);

describe("museUsageFormat", () => {
  it("counts model calls once with disjoint input buckets and reasoning inside output", () => {
    const records = parse(modelCompleted());

    expect(records).toEqual([
      {
        provider: "muse",
        timestampMs: 1_792_040_823_840,
        model: "muse-wonder-1.0",
        rateModel: "meta/muse-wonder-1.0",
        sessionId: "01a138c8-27b9-73c3-a592-87ce7d5b4655",
        totals: {
          uncachedInputTokens: 647,
          cachedInputTokens: 55_156,
          cacheCreationTokens: 0,
          outputTokens: 338,
          reasoningTokens: 317,
        },
        reportedCostUsd: null,
        speed: "standard",
        dedupeKey: null,
      },
    ]);
    expect(totalTokens(records[0]!.totals)).toBe(56_141);
  });

  it("ignores the duplicate goal attribution and unrelated events", () => {
    const record = modelCompleted();
    const attribution = {
      ...record,
      payload: {
        ...record.payload,
        event: {
          kind: "goal_usage_attribution",
          record: {
            schema_version: 1,
            usage_id: "usage-1",
            usage_family: "provider",
            quantity: {
              unit: "tokens",
              reported: true,
              input_tokens: 55_803,
              output_tokens: 338,
              cached_tokens: 55_156,
              reasoning_tokens: 317,
              main_llm_steps: 1,
            },
            owner: { session_id: record.stream.id, run_id: "run-1" },
            goal_attribution: { mode: "none" },
          },
        },
      },
    };

    expect([record, attribution].flatMap(parse)).toHaveLength(1);
    expect(parse({ ...record, record_type: "session.fork.turn" })).toEqual([]);
    expect(parse({ ...record, payload_type: "other" })).toEqual([]);
    expect(parse({ ...record, payload: { kind: "other", event: record.payload.event } })).toEqual(
      [],
    );
    expect(
      parse({ ...record, payload: { ...record.payload, event: { kind: "started" } } }),
    ).toEqual([]);
  });

  it("uses cached_tokens when the explicit cache-read counter is absent", () => {
    const record = modelCompleted({ cache_read_tokens: undefined });
    expect(parse(record)[0]?.totals.cachedInputTokens).toBe(55_156);
    expect(parse(modelCompleted({ cached_tokens: 100, cache_read_tokens: 0 }))[0]?.totals).toEqual({
      uncachedInputTokens: 55_803,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 338,
      reasoningTokens: 317,
    });
  });

  it("partitions cache writes within input without adding the cache aliases twice", () => {
    const records = parse(
      modelCompleted({
        input_tokens: 100,
        cached_tokens: 30,
        cache_read_tokens: 30,
        cache_write_tokens: 20,
        output_tokens: 10,
        reasoning_tokens: 4,
      }),
    );
    expect(records[0]?.totals).toEqual({
      uncachedInputTokens: 50,
      cachedInputTokens: 30,
      cacheCreationTokens: 20,
      outputTokens: 10,
      reasoningTokens: 4,
    });
    expect(totalTokens(records[0]!.totals)).toBe(110);
  });

  it("clamps invalid or overlapping counters and keeps reasoning a subset of output", () => {
    expect(
      parse(
        modelCompleted({
          input_tokens: 100.9,
          cached_tokens: 400,
          cache_read_tokens: 200,
          cache_write_tokens: 300,
          output_tokens: 10.9,
          reasoning_tokens: 20,
        }),
      )[0]?.totals,
    ).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 100,
      cacheCreationTokens: 0,
      outputTokens: 10,
      reasoningTokens: 10,
    });
    expect(
      parse(
        modelCompleted({
          input_tokens: "100",
          cached_tokens: -10,
          cache_read_tokens: null,
          cache_write_tokens: -20,
          output_tokens: 10,
          reasoning_tokens: -5,
        }),
      )[0]?.totals,
    ).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 10,
      reasoningTokens: 0,
    });
  });

  it("keeps subagent stream IDs and counts approval-review usage without a model", () => {
    const record = modelCompleted();
    expect(
      parse({ ...record, stream: { kind: "session", id: "subagent-session" } })[0]?.sessionId,
    ).toBe("subagent-session");
    expect(
      parse({
        ...record,
        stream: { kind: "approval.review.runtime", id: "review-session" },
        payload: { ...record.payload, event: { ...record.payload.event, model: undefined } },
      })[0],
    ).toMatchObject({ sessionId: "review-session", model: "muse" });
  });

  it("ignores malformed records, invalid timestamps and empty usage", () => {
    expect(museUsageFormat.parseLine("{bad json", undefined)).toEqual([]);
    for (const record of [
      null,
      [],
      {},
      { ...modelCompleted(), recorded_at: "1792040823840487" },
      { ...modelCompleted(), recorded_at: 0 },
      { ...modelCompleted(), recorded_at: -1 },
      { ...modelCompleted(), stream: { id: "" } },
      { ...modelCompleted(), payload: { kind: "run", event: { kind: "model_completed" } } },
      modelCompleted({
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        reasoning_tokens: 0,
      }),
    ]) {
      expect(parse(record)).toEqual([]);
    }
    expect(
      museUsageFormat.parseProjected({ ...modelCompleted(), recorded_at: Infinity }, undefined),
    ).toEqual([]);
  });

  it("reads projected oversized records using only the selected fields", () => {
    const record = modelCompleted();
    const projected = {
      record_type: record.record_type,
      payload_type: record.payload_type,
      recorded_at: record.recorded_at,
      stream: { id: record.stream.id },
      payload: { kind: record.payload.kind, event: record.payload.event },
    };
    expect(museUsageFormat.parseProjected(projected, undefined)).toEqual(parse(record));
  });
});

describe("museUsageReader", () => {
  it.effect("returns the recursive sessions root under the default or overridden data home", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const home = path.resolve("muse-usage-test-home");
      const readDirectories = (environment: NodeJS.ProcessEnv) =>
        museUsageReader
          .directories({
            instanceId: ProviderInstanceId.make("muse-test"),
            config: undefined,
            environment,
            configured: false,
          })
          .pipe(Effect.provideService(HostProcess.HomeDirectory, home));

      for (const dataHome of [undefined, "", "   "]) {
        expect(yield* readDirectories({ XDG_DATA_HOME: dataHome })).toEqual([
          { dir: path.join(home, ".local", "share", "muse", "sessions") },
        ]);
      }
      expect(yield* readDirectories({ XDG_DATA_HOME: "  ~/custom-data  " })).toEqual([
        { dir: path.join(home, "custom-data", "muse", "sessions") },
      ]);
      const customData = path.resolve("custom-data");
      expect(yield* readDirectories({ XDG_DATA_HOME: customData })).toEqual([
        { dir: path.join(customData, "muse", "sessions") },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
