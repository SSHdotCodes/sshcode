import { NodeServices } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { readClaudeKeepWarmRestore } from "./ClaudeKeepWarmRestore.ts";

const MIN = 60_000;
const now = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-20T15:00:00.000Z"));
const iso = (minutesAgo: number) => DateTime.formatIso(DateTime.makeUnsafe(now - minutesAgo * MIN));
const selection = {
  instanceId: "claudeAgent",
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
};

// Rows shaped like the live projection's, with no message content.
const seed = Effect.fnUntraced(function* (input: {
  readonly thread: string;
  readonly driver?: string;
  readonly runs: ReadonlyArray<{
    readonly ordinal: number;
    readonly status: string;
    readonly completedMinutesAgo: number;
    readonly providerTurns: ReadonlyArray<{
      readonly status: string;
      readonly usedTokens: number;
      readonly promptCacheTtlMs?: number;
      readonly touchedMinutesAgo: number;
    }>;
  }>;
}) {
  const sql = yield* SqlClient.SqlClient;
  const providerThreadId = `provider-thread:${input.thread}`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads
      (provider_thread_id, thread_id, provider, provider_session_id, status, updated_at, payload_json, driver, provider_instance_id)
    VALUES (${providerThreadId}, ${input.thread}, 'claudeAgent', ${`provider-session:${input.thread}`}, 'idle', ${iso(0)}, '{}', ${input.driver ?? "claudeAgent"}, 'claudeAgent')
  `;
  for (const run of input.runs) {
    const runId = `run:${input.thread}:${run.ordinal}`;
    const attemptId = `${runId}:attempt:1`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json, provider_instance_id)
      VALUES (${runId}, ${input.thread}, ${run.ordinal}, 'claudeAgent', ${providerThreadId}, ${run.status}, ${iso(run.completedMinutesAgo + 1)}, ${iso(run.completedMinutesAgo)}, ${JSON.stringify({ activeAttemptId: attemptId, modelSelection: selection })}, 'claudeAgent')
    `;
    for (const [index, turn] of run.providerTurns.entries()) {
      yield* sql`
        INSERT INTO orchestration_v2_projection_provider_turns
          (provider_turn_id, thread_id, provider_thread_id, node_id, run_attempt_id, ordinal, status, started_at, completed_at, payload_json)
        VALUES (${`${attemptId}:turn:${index}`}, ${input.thread}, ${providerThreadId}, 'node', ${attemptId}, ${run.ordinal * 10 + index}, ${turn.status}, ${iso(turn.touchedMinutesAgo + 1)}, ${iso(turn.touchedMinutesAgo)}, ${JSON.stringify(
          {
            tokenUsage: {
              usedTokens: turn.usedTokens,
              maxTokens: 1_000_000,
              ...(turn.promptCacheTtlMs === undefined
                ? {}
                : { promptCacheTtlMs: turn.promptCacheTtlMs }),
              updatedAt: iso(turn.touchedMinutesAgo),
            },
          },
        )})
      `;
    }
  }
});
const completed = (
  completedMinutesAgo: number,
  turn: Partial<{ usedTokens: number; promptCacheTtlMs: number; status: string }> = {},
) => ({
  ordinal: 1,
  status: "completed",
  completedMinutesAgo,
  providerTurns: [
    {
      status: "completed",
      usedTokens: 300_000,
      promptCacheTtlMs: 60 * MIN,
      touchedMinutesAgo: completedMinutesAgo,
      ...turn,
    },
  ],
});
const pingRow = (thread: string, minutesAgo: number) =>
  JSON.stringify({
    type: "assistant",
    timestamp: iso(minutesAgo),
    sessionId: `keep-warm:${thread}`,
    message: {
      id: `${thread}:${minutesAgo}`,
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 299_000,
        cache_creation_input_tokens: 400,
        output_tokens: 2,
      },
    },
  });

it.layer(Layer.mergeAll(SqlitePersistence.layerMemory, NodeServices.layer))(
  "keep-warm restore read",
  (it) => {
    it.effect("finds the chats whose last completed Claude turn is still warm", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const usageLogFile = `${yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-keep-warm-restore-" })}/usage.jsonl`;
        yield* seed({ thread: "warm", runs: [completed(20)] });
        // Pinged at 50 minutes, so still warm 70 minutes after the turn.
        yield* seed({ thread: "pinged", runs: [completed(70)] });
        yield* seed({ thread: "expired", runs: [completed(58)] });
        yield* seed({ thread: "small", runs: [completed(5, { usedTokens: 90_000 })] });
        yield* seed({ thread: "short-cache", runs: [completed(5, { promptCacheTtlMs: 5 * MIN })] });
        yield* seed({ thread: "codex", driver: "codex", runs: [completed(5)] });
        // A newer run that did not complete leaves the cache's owner unclear.
        yield* seed({
          thread: "newer-failed",
          runs: [completed(30), { ...completed(10), ordinal: 2, status: "failed" }],
        });
        // The run's last provider turn decides, as the turn's end does live.
        yield* seed({
          thread: "steered",
          runs: [
            {
              ...completed(10),
              providerTurns: [
                {
                  status: "completed",
                  usedTokens: 300_000,
                  promptCacheTtlMs: 60 * MIN,
                  touchedMinutesAgo: 12,
                },
                {
                  status: "cancelled",
                  usedTokens: 310_000,
                  promptCacheTtlMs: 60 * MIN,
                  touchedMinutesAgo: 10,
                },
              ],
            },
          ],
        });
        yield* fileSystem.writeFileString(
          usageLogFile,
          `${pingRow("pinged", 20)}\nnot json\n${pingRow("expired", 70)}\n`,
        );
        const restore = yield* readClaudeKeepWarmRestore({
          sql: yield* SqlClient.SqlClient,
          fileSystem,
          usageLogFile,
          now,
        });
        assert.sameDeepMembers(
          [...restore.chats],
          [
            {
              threadId: ThreadId.make("warm"),
              contextTokens: 300_000,
              touchedAtMs: now - 20 * MIN,
              pings: 0,
            },
            {
              threadId: ThreadId.make("pinged"),
              contextTokens: 300_000,
              touchedAtMs: now - 20 * MIN,
              pings: 1,
            },
          ],
        );
        assert.deepEqual(restore.targets.get(ThreadId.make("warm")), {
          providerThreadId: "provider-thread:warm",
          modelSelection: selection,
        } as never);
      }),
    );
    it.effect("reads nothing when there is no usage log", () =>
      Effect.gen(function* () {
        const restore = yield* readClaudeKeepWarmRestore({
          sql: yield* SqlClient.SqlClient,
          fileSystem: yield* FileSystem.FileSystem,
          usageLogFile: "/nonexistent/claude-keep-warm/usage.jsonl",
          now,
        });
        assert.isArray(restore.chats);
      }),
    );
  },
);
