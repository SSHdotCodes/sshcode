/**
 * What a server start needs to keep warm the idle Claude chats a restart cut off: each chat's
 * last completed turn, read from the projection on the database reader, and the pings the
 * keep-warm usage log records since that turn.
 */
import { ModelSelection, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { claudeKeepWarmRestoredChats, type ClaudeKeepWarmRestoredChat } from "./ClaudeKeepWarm.ts";

// A turn can be pinged once and still be warm a full window after that ping.
const LOOKBACK_MS = 2 * 57 * 60_000;

const TurnRow = Schema.Struct({
  threadId: ThreadId,
  providerThreadId: ProviderThreadId,
  modelSelection: Schema.fromJsonString(ModelSelection),
  contextTokens: Schema.Number,
  cacheTtlMs: Schema.NullOr(Schema.Number),
  touchedAt: Schema.String,
});
const decodeTurnRow = Schema.decodeUnknownOption(TurnRow);

const PingRow = Schema.fromJsonString(
  Schema.Struct({
    timestamp: Schema.String,
    sessionId: Schema.String,
    message: Schema.Struct({
      usage: Schema.Struct({
        cache_read_input_tokens: Schema.Number,
        cache_creation_input_tokens: Schema.Number,
      }),
    }),
  }),
);
const decodePingRow = Schema.decodeUnknownOption(PingRow);

const epochMillis = (iso: string) =>
  Option.map(DateTime.make(iso), DateTime.toEpochMillis).pipe(Option.getOrUndefined);

export interface ClaudeKeepWarmRestore {
  readonly chats: ReadonlyArray<ClaudeKeepWarmRestoredChat>;
  /** The provider thread and selection each chat's last turn ran with; its cache is theirs. */
  readonly targets: ReadonlyMap<
    ThreadId,
    { readonly providerThreadId: ProviderThreadId; readonly modelSelection: ModelSelection }
  >;
}

export const readClaudeKeepWarmRestore = Effect.fn("ClaudeKeepWarmRestore.read")(function* (input: {
  readonly sql: SqlClient.SqlClient;
  readonly fileSystem: FileSystem.FileSystem;
  readonly usageLogFile: string;
  readonly now: number;
}) {
  const since = DateTime.formatIso(DateTime.makeUnsafe(input.now - LOOKBACK_MS));
  // Each chat's newest run, when it completed with a completed last provider turn on Claude.
  const rows = yield* input.sql`
    SELECT
      r.thread_id AS "threadId",
      r.provider_thread_id AS "providerThreadId",
      json_extract(r.payload_json, '$.modelSelection') AS "modelSelection",
      json_extract(p.payload_json, '$.tokenUsage.usedTokens') AS "contextTokens",
      json_extract(p.payload_json, '$.tokenUsage.promptCacheTtlMs') AS "cacheTtlMs",
      json_extract(p.payload_json, '$.tokenUsage.updatedAt') AS "touchedAt"
    FROM orchestration_v2_projection_runs r
    JOIN orchestration_v2_projection_provider_threads pt
      ON pt.provider_thread_id = r.provider_thread_id
    JOIN orchestration_v2_projection_provider_turns p
      ON p.thread_id = r.thread_id
      AND p.run_attempt_id = json_extract(r.payload_json, '$.activeAttemptId')
    WHERE r.status = 'completed'
      AND r.completed_at >= ${since}
      AND pt.driver = 'claudeAgent'
      AND p.status = 'completed'
      AND r.ordinal = (
        SELECT MAX(latest.ordinal) FROM orchestration_v2_projection_runs latest
        WHERE latest.thread_id = r.thread_id
      )
      AND p.ordinal = (
        SELECT MAX(last.ordinal) FROM orchestration_v2_projection_provider_turns last
        WHERE last.thread_id = r.thread_id AND last.run_attempt_id = p.run_attempt_id
      )
  `.pipe(NodeSqliteClient.readOnly);
  const turns = rows.flatMap((row) => {
    const turn = Option.getOrUndefined(decodeTurnRow(row));
    const touchedAtMs = turn === undefined ? undefined : epochMillis(turn.touchedAt);
    return turn === undefined || touchedAtMs === undefined ? [] : [{ ...turn, touchedAtMs }];
  });
  const log = yield* input.fileSystem
    .readFileString(input.usageLogFile)
    .pipe(Effect.orElseSucceed(() => ""));
  const pings = log.split("\n").flatMap((line) => {
    const row = Option.getOrUndefined(decodePingRow(line));
    const atMs = row === undefined ? undefined : epochMillis(row.timestamp);
    if (row === undefined || atMs === undefined || !row.sessionId.startsWith("keep-warm:"))
      return [];
    return [
      {
        threadId: row.sessionId.slice("keep-warm:".length),
        atMs,
        cacheReadTokens: row.message.usage.cache_read_input_tokens,
        cacheWriteTokens: row.message.usage.cache_creation_input_tokens,
      },
    ];
  });
  return {
    chats: claudeKeepWarmRestoredChats({ turns, pings, now: input.now }),
    targets: new Map(
      turns.map((turn) => [
        turn.threadId,
        { providerThreadId: turn.providerThreadId, modelSelection: turn.modelSelection },
      ]),
    ),
  } satisfies ClaudeKeepWarmRestore;
});
