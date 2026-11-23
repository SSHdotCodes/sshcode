// @effect-diagnostics nodeBuiltinImport:off - exercise real JSONL/resume boundaries in isolated files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import { TEST_FORMATS, TEST_FORMAT_MAP } from "./usageTestFormats.ts";
import { readTranscriptRecords, type TranscriptParsePosition } from "./usageTranscriptReader.ts";
import { decodeScanCache, dedupeWithinFile, encodeScanCache } from "./usageScanCache.ts";
import { UsageAggregator } from "./usageAggregation.ts";

let dir: string;
beforeEach(async () => {
  dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "usage-timing-test-"));
});
afterEach(async () => {
  await NodeFSP.rm(dir, { recursive: true, force: true });
});
const stamp = (seconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.parse("2026-08-01T10:00:00Z") + seconds * 1000));
const lines = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const user = (uuid: string, seconds: number, parentUuid: string | null = null) => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: stamp(seconds),
  message: { role: "user", content: "tool result or prompt" },
});
const assistant = (
  uuid: string,
  parentUuid: string,
  id: string,
  seconds: number,
  speed = "standard",
) => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: stamp(seconds),
  sessionId: "s",
  message: { id, model: "claude-test", usage: { input_tokens: 10, output_tokens: 100, speed } },
});
const codex = (seconds: number, type: string, payload: unknown) => ({
  timestamp: stamp(seconds),
  type,
  payload,
});
const output = (seconds: number, type = "message") =>
  codex(seconds, "response_item", { type, role: "assistant" });
const toolResult = (seconds: number) =>
  codex(seconds, "response_item", { type: "function_call_output" });
const prompt = (seconds: number) =>
  codex(seconds, "response_item", { type: "message", role: "user" });
const context = codex(0, "turn_context", { model: "codex-test" });
const count = (seconds: number, outputTokens = 100) =>
  codex(seconds, "event_msg", {
    type: "token_count",
    info: { last_token_usage: { input_tokens: 10, output_tokens: outputTokens } },
  });
const tier = (seconds: number, service_tier: string) =>
  codex(seconds, "event_msg", {
    type: "thread_settings_applied",
    thread_settings: { service_tier },
  });
function aggregate(records: readonly UsageRecord[]) {
  const a = new UsageAggregator({
    timeZone: "UTC",
    sinceDay: "2026-08-01",
    untilDay: "2026-08-01",
    rates: new Map(),
  });
  for (const record of records) a.add(record);
  return a.finish().buckets[0]!;
}
async function read(
  provider: "claude" | "codex",
  rows: string,
  position?: TranscriptParsePosition,
  streaming = false,
) {
  const path = NodePath.join(dir, provider + ".jsonl");
  if (position) await NodeFSP.appendFile(path, rows);
  else await NodeFSP.writeFile(path, rows);
  const result = await readTranscriptRecords(
    path,
    TEST_FORMATS[provider],
    position,
    streaming ? { streamingThresholdBytes: 32 } : {},
  );
  expect(result).not.toBeNull();
  return result!;
}

describe("measured response timing", () => {
  it.each([false, true])(
    "joins Claude parents and split messages with interleaved sidechains (projection=%s)",
    async (streaming) => {
      const parsed = await read(
        "claude",
        lines(
          user("root", 0),
          assistant("a1", "root", "a", 1),
          user("side-root", 2),
          assistant("b1", "side-root", "b", 4, "fast"),
          assistant("a2", "a1", "a", 5),
          user("tool", 6, "a2"),
          { type: "attachment", uuid: "attachment", parentUuid: "tool", timestamp: stamp(6) },
          assistant("c1", "attachment", "c", 8),
        ),
        undefined,
        streaming,
      );
      const records = dedupeWithinFile(parsed.records);
      expect(records).toHaveLength(3);
      const bucket = aggregate(records);
      expect(bucket.totals.outputTokens).toBe(300);
      expect(bucket.timing).toEqual({ outputTokens: 200, seconds: 7, responses: 2 });
      expect(bucket.fastTiming).toEqual({ outputTokens: 100, seconds: 2, responses: 1 });
    },
  );

  it("matches the streaming parser on projected UTF-8 response bodies", async () => {
    const response = {
      ...assistant("a", "u", "a", 5),
      message: {
        ...assistant("a", "u", "a", 5).message,
        model: "claude-é",
        content: '工具 " nested timestamp "'.repeat(2000),
      },
    };
    const body = lines(user("u", 0), response);
    const native = await read("claude", body);
    const streaming = await read("claude", body, undefined, true);
    expect(native.records).toEqual(streaming.records);
    expect(aggregate(native.records).timing).toEqual({
      outputTokens: 100,
      seconds: 5,
      responses: 1,
    });
    expect(native.records[0]?.model).toBe("claude-é");
  });
  it("keeps Claude starts across resume and extends split timing without mutating the base", async () => {
    const first = await read("claude", lines(user("u", 0)));
    const second = await read("claude", lines(assistant("a1", "u", "a", 2)), first.position);
    expect(second.resumed).toBe(true);
    expect(aggregate(second.records).timing?.seconds).toBe(2);
    const third = await read("claude", lines(assistant("a2", "a1", "a", 5)), second.position);
    const stitched = dedupeWithinFile([...second.records, ...third.records]);
    expect(aggregate(stitched).timing).toEqual({ outputTokens: 100, seconds: 5, responses: 1 });
    expect(aggregate(second.records).timing?.seconds).toBe(2);
    const whole = await readTranscriptRecords(
      NodePath.join(dir, "claude.jsonl"),
      TEST_FORMATS.claude,
    );
    expect(stitched).toEqual(dedupeWithinFile(whole!.records));
  });
  it("keeps unfinished split timing out of the committed base until replay", async () => {
    const first = await read(
      "claude",
      lines(user("u", 0), assistant("a1", "u", "a", 2)) +
        JSON.stringify(assistant("a2", "a1", "a", 5)),
    );
    expect(aggregate(first.records).timing?.seconds).toBe(2);
    expect(
      aggregate(dedupeWithinFile([...first.records, ...first.tailRecords])).timing?.seconds,
    ).toBe(5);
    const next = await read("claude", "\n", first.position);
    expect(aggregate(dedupeWithinFile([...first.records, ...next.records])).timing?.seconds).toBe(
      5,
    );
  });
  it.each([false, true])(
    "times Codex through its last item, excluding tool execution (projection=%s)",
    async (streaming) => {
      const parsed = await read(
        "codex",
        lines(
          context,
          prompt(0),
          output(1, "reasoning"),
          codex(2, "event_msg", {
            type: "item_completed",
            thread_id: "sidechain",
            started_at_ms: 1,
            completed_at_ms: 2,
          }),
          output(5, "function_call"),
          toolResult(100),
          count(100),
          tier(100, "priority"),
          output(102),
          count(102, 200),
          tier(103, "ultrafast"),
          prompt(103),
          output(106),
          count(106, 300),
        ),
        undefined,
        streaming,
      );
      const bucket = aggregate(parsed.records);
      expect(bucket.records).toBe(3);
      expect(bucket.timing).toEqual({ outputTokens: 100, seconds: 5, responses: 1 });
      expect(bucket.fastTiming).toEqual({ outputTokens: 500, seconds: 5, responses: 2 });
    },
  );
  it("restores Codex triggers and partly completed responses between scans", async () => {
    const first = await read("codex", lines(context, prompt(0)));
    const second = await read("codex", lines(output(2, "reasoning")), first.position);
    const third = await read("codex", lines(output(5), count(5)), second.position);
    expect(third.resumed).toBe(true);
    expect(aggregate(third.records).timing).toEqual({
      outputTokens: 100,
      seconds: 5,
      responses: 1,
    });
  });
  it.each(["claude", "codex"] as const)(
    "leaves %s missing, zero, negative and over-15-minute durations untimed",
    async (provider) => {
      const rows =
        provider === "claude"
          ? lines(
              assistant("a", "missing", "a", 1),
              user("u2", 2),
              assistant("b", "u2", "b", 2),
              user("u3", 4),
              assistant("c", "u3", "c", 3),
              user("u4", 5),
              assistant("d", "u4", "d", 906),
            )
          : lines(
              context,
              output(1),
              count(1),
              prompt(2),
              output(2),
              count(2, 200),
              prompt(4),
              output(3),
              count(3, 300),
              prompt(5),
              output(906),
              count(906, 400),
            );
      const bucket = aggregate(dedupeWithinFile((await read(provider, rows)).records));
      expect(bucket.records).toBe(4);
      expect(bucket.totals.outputTokens).toBe(provider === "claude" ? 400 : 1000);
      expect(bucket.timing).toBeUndefined();
      expect(bucket.fastTiming).toBeUndefined();
    },
  );

  it("keeps Codex tool-result triggers separate when resuming before delayed usage", async () => {
    const first = await read(
      "codex",
      lines(context, prompt(0), output(5, "function_call"), toolResult(100)),
    );
    const second = await read(
      "codex",
      lines(count(100), tier(100, "priority"), output(102), count(102, 200)),
      first.position,
    );
    const bucket = aggregate(second.records);
    expect(bucket.timing).toEqual({ outputTokens: 100, seconds: 5, responses: 1 });
    expect(bucket.fastTiming).toEqual({ outputTokens: 200, seconds: 2, responses: 1 });
  });

  it("does not time Codex responses from re-stamped fork history or sidechain user events", async () => {
    const parsed = await read(
      "codex",
      lines(
        codex(0, "session_meta", { id: "own", forked_from_id: "parent" }),
        context,
        prompt(0),
        output(0),
        count(0),
        output(5),
        count(5, 200),
        // This is not an input to the own rollout, even though it arrives last.
        codex(6, "event_msg", { type: "user_message", thread_id: "another-agent" }),
        output(8),
        count(8, 300),
      ),
    );
    expect(parsed.records).toHaveLength(2);
    expect(aggregate(parsed.records).timing).toBeUndefined();
  });

  it("invalidates a split response whose final line exceeds the timing limit", async () => {
    const parsed = await read(
      "claude",
      lines(user("u", 0), assistant("a1", "u", "a", 10), assistant("a2", "a1", "a", 901)),
    );
    const bucket = aggregate(dedupeWithinFile(parsed.records));
    expect(bucket.records).toBe(1);
    expect(bucket.totals.outputTokens).toBe(100);
    expect(bucket.timing).toBeUndefined();
  });

  it("does not treat an unidentified Claude assistant as a new request trigger", async () => {
    const first = assistant("a", "u", "unused", 2);
    const second = assistant("b", "a", "unused", 5);
    const parsed = await read(
      "claude",
      lines(
        user("u", 0),
        { ...first, message: { model: first.message.model, usage: first.message.usage } },
        { ...second, message: { model: second.message.model, usage: second.message.usage } },
      ),
    );
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[1]?.responseTiming).toBeUndefined();
    expect(aggregate(parsed.records).timing).toEqual({
      outputTokens: 100,
      seconds: 2,
      responses: 1,
    });
  });
  it("round trips timing and resume state through the scan cache", async () => {
    for (const provider of ["claude", "codex"] as const) {
      const first = await read(
        provider,
        provider === "claude"
          ? lines(user("u", 0), assistant("a1", "u", "a", 2))
          : lines(context, prompt(0), output(2), count(2), toolResult(3)),
      );
      const path = NodePath.join(dir, provider + ".jsonl");
      const cache = new Map([
        [
          path,
          {
            provider,
            size: 10,
            mtimeMs: 1,
            records: first.records,
            tailRecords: [],
            position: first.position,
          },
        ],
      ]);
      const restored = decodeScanCache(
        JSON.parse(JSON.stringify(encodeScanCache(cache))),
        TEST_FORMAT_MAP,
      );
      expect(restored).toEqual(cache);
      const second = await read(
        provider,
        provider === "claude"
          ? lines(assistant("a2", "a1", "a", 5))
          : lines(output(5), count(5, 200)),
        restored.get(path)!.position,
      );
      expect(second.resumed).toBe(true);
      expect(
        aggregate(dedupeWithinFile([...first.records, ...second.records])).timing?.seconds,
      ).toBe(provider === "claude" ? 5 : 4);
    }
  });
});
