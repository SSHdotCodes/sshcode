import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as TestClock from "effect/testing/TestClock";
import { ThreadId, type ProviderSessionId } from "@t3tools/contracts";
import * as ExecutionResources from "./execution/ExecutionResources.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import { readChatTempStates, readStaleQueuedRuns } from "./storageCleanup.ts";

it.effect(
  "held queues and stale session rows do not pin tmp; live shared runtimes and execution do",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const ownership = yield* ExecutionResources.ExecutionResources;
      yield* sql`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT, archived_at TEXT, deleted_at TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_runs (thread_id TEXT, status TEXT, run_id TEXT, requested_at TEXT, payload_json TEXT, ordinal INTEGER)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_messages (thread_id TEXT, message_id TEXT, payload_json TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_provider_sessions (provider_session_id TEXT, thread_id TEXT, status TEXT)`;
      yield* sql`CREATE TABLE orchestration_v2_projection_provider_threads (provider_session_id TEXT, thread_id TEXT)`;
      for (const id of ["held", "stale-ready", "live", "shared", "monitor", "archived"]) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads VALUES (${id}, ${id === "archived" ? "2026-01-01" : null}, NULL)`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES (${id}, 'queued', ${id}, '2026-11-01T00:00:00.000Z', ${JSON.stringify({ userMessageId: id })}, 1)`;
        yield* sql`INSERT INTO orchestration_v2_projection_messages VALUES (${id}, ${id}, '{}')`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions VALUES ('stale', 'stale-ready', 'running'), ('live-session', 'live', 'ready')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_threads VALUES ('live-session', 'shared')`;
      yield* ownership.register("monitor", {
        query: () =>
          Effect.succeed([
            {
              id: "job",
              owner: { threadId: ThreadId.make("monitor"), taskId: "job" },
              workspace: { type: "local", cwd: "/checkout" },
              state: "recovering",
              cleanupPin: true,
              stop: { type: "monitor", monitorId: "job" },
            },
          ]),
        stop: () => Effect.void,
      });
      expect(yield* readChatTempStates).toEqual([
        { threadId: "held", active: false, removed: false },
        { threadId: "stale-ready", active: false, removed: false },
        { threadId: "live", active: true, removed: false },
        { threadId: "shared", active: true, removed: false },
        { threadId: "monitor", active: true, removed: false },
        { threadId: "archived", active: false, removed: true },
      ]);
      yield* TestClock.setTime(Date.parse("2026-11-08T00:00:00.000Z"));
      // Recent queued input and automatic completions are never stale user queues.
      yield* sql`INSERT INTO orchestration_v2_projection_messages VALUES ('held', 'new', '{}'), ('held', 'automatic', '{"delegatedCompletion": {}}'), ('held', 'nullable', '{"delegatedCompletion": null}')`;
      for (const [id, requested] of [
        ["new", "2026-11-08T00:00:00.000Z"],
        ["automatic", "2026-11-01T00:00:00.000Z"],
        ["nullable", "2026-11-01T00:00:00.000Z"],
      ]) {
        yield* sql`INSERT INTO orchestration_v2_projection_runs VALUES ('held', 'queued', ${id}, ${requested}, ${JSON.stringify({ userMessageId: id })}, 2)`;
      }
      expect((yield* readStaleQueuedRuns).map((run) => run.runId).sort()).toEqual([
        "archived",
        "held",
        "nullable",
        "stale-ready",
      ]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" }), ExecutionResources.layer),
      ),
      Effect.provideService(ProviderSessionManager.ProviderSessionManagerV2, {
        isLive: (id: ProviderSessionId) => Effect.succeed(id === "live-session"),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
      Effect.scoped,
    ),
);
