/**
 * Devin keeps each model reply's token counts in its local session database
 * (`cli/sessions.db`, shared by the CLI and the daemon ACP clients use): every
 * assistant node's `chat_message` carries `metadata.generation_model` and
 * `metadata.metrics`. `input_tokens` excludes cache reads.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off - a plain stat is the cache fingerprint, as in the Antigravity reader.
import * as NodeFSP from "node:fs/promises";

import type { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type ProviderUsageScan,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as SqlClient from "effect/sql/SqlClient";

/** Rows per statement: each row's JSON is parsed, so pages stay small and yield between them. */
const PAGE_ROWS = 256;
/** While Devin is writing, a re-read waits this long unless the caller asks to wait for fresh data. */
const REFRESH_INTERVAL_MS = 60_000;

const PAGE_QUERY = `SELECT row_id, session_id, node_id, created_at,
  json_extract(chat_message, '$.metadata.generation_model') AS model,
  json_extract(chat_message, '$.metadata.metrics.input_tokens') AS input_tokens,
  json_extract(chat_message, '$.metadata.metrics.output_tokens') AS output_tokens,
  json_extract(chat_message, '$.metadata.metrics.cache_read_tokens') AS cache_read_tokens,
  json_extract(chat_message, '$.metadata.metrics.cache_creation_tokens') AS cache_creation_tokens,
  json_extract(chat_message, '$.metadata.metrics.reasoning_tokens') AS reasoning_tokens
FROM message_nodes
WHERE row_id > ? AND created_at >= ?
ORDER BY row_id
LIMIT ?`;

interface DevinUsageRow {
  readonly row_id: number;
  readonly session_id: unknown;
  readonly node_id: unknown;
  readonly created_at: unknown;
  readonly model: unknown;
  readonly input_tokens: unknown;
  readonly output_tokens: unknown;
  readonly cache_read_tokens: unknown;
  readonly cache_creation_tokens: unknown;
  readonly reasoning_tokens: unknown;
}

/** Devin stores seconds; a millisecond value is taken as is. */
function timestampMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

export function devinUsageRecord(row: DevinUsageRow): UsageRecord | null {
  if (row.output_tokens === null || row.output_tokens === undefined) return null;
  const at = timestampMs(row.created_at);
  if (at === null) return null;
  if (typeof row.session_id !== "string" || row.session_id.length === 0) return null;
  const model = typeof row.model === "string" && row.model.trim() ? row.model.trim() : "devin";
  const outputTokens = tokenCount(row.output_tokens);
  const totals = {
    uncachedInputTokens: tokenCount(row.input_tokens),
    cachedInputTokens: tokenCount(row.cache_read_tokens),
    cacheCreationTokens: tokenCount(row.cache_creation_tokens),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(row.reasoning_tokens)),
  };
  if (totalTokens(totals) === 0) return null;
  return {
    provider: "devin",
    timestampMs: at,
    model,
    sessionId: row.session_id,
    totals,
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: JSON.stringify(["devin", row.session_id, String(row.node_id)]),
  };
}

/** Reads every reply since `sinceMs`, a page at a time, from a read-only connection. */
export const readDevinUsage = Effect.fn("readDevinUsage")(function* (
  database: string,
  sinceMs: number,
) {
  const read = Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe("PRAGMA busy_timeout = 100");
    const tables = yield* sql.unsafe<{ readonly name: unknown }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'message_nodes'",
    );
    if (tables.length === 0) return [] as UsageRecord[];
    const sinceSeconds = Math.floor(sinceMs / 1000);
    const records: UsageRecord[] = [];
    let after = -1;
    while (true) {
      const rows = yield* sql
        .unsafe<DevinUsageRow>(PAGE_QUERY, [after, sinceSeconds, PAGE_ROWS])
        .pipe(Effect.withTracerEnabled(false));
      for (const row of rows) {
        const record = devinUsageRecord(row);
        if (record !== null) records.push(record);
      }
      if (rows.length < PAGE_ROWS) break;
      after = rows[rows.length - 1]!.row_id;
      yield* Effect.yieldNow;
    }
    return records;
  });
  return yield* read.pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: database, readonly: true })),
  );
});

interface CachedRead {
  readonly fingerprint: string;
  readonly sinceMs: number;
  readonly readAtMs: number;
  readonly records: readonly UsageRecord[];
}

const fingerprintOf = (file: string) =>
  Effect.tryPromise(() => NodeFSP.stat(file)).pipe(
    Effect.map((stat) => `${stat.size}:${stat.mtimeMs}`),
    Effect.option,
  );

/** `XDG_DATA_HOME/devin`, else `~/.local/share/devin`, as the CLI resolves it. */
const devinDatabase = Effect.fn("devinDatabase")(function* (environment: NodeJS.ProcessEnv) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const dataHome = environment.XDG_DATA_HOME?.trim();
  const root = dataHome
    ? path.join(expandHomePath(dataHome, home), "devin")
    : path.join(home, ".local", "share", "devin");
  return { dir: path.join(root, "cli"), database: path.join(root, "cli", "sessions.db") };
});

export const makeDevinUsageReader = (): ProviderUsageReader<AcpRegistrySettings, Path.Path> => {
  const cache = new Map<string, CachedRead>();
  return {
    kind: "scan",
    provider: "devin",
    scan: Effect.fn("devinUsageReader.scan")(function* ({
      instances,
      retentionCutoffMs,
      windowStartMs,
      awaitRefresh,
      settings,
    }) {
      const scans: ProviderUsageScan[] = [];
      const seen = new Set<string>();
      for (const instance of instances) {
        if (instance.config?.agentId !== "devin") continue;
        const { dir, database } = yield* devinDatabase(instance.environment);
        // The account column shows this; without it the page falls back to the instance id.
        const displayName =
          settings.providerInstances?.[instance.instanceId]?.displayName?.trim() || "Devin";
        if (seen.has(database)) continue;
        seen.add(database);
        const main = yield* fingerprintOf(database);
        if (main._tag === "None") {
          scans.push({ dir, instanceId: instance.instanceId, displayName, files: null });
          continue;
        }
        const wal = yield* fingerprintOf(`${database}-wal`);
        const fingerprint = `${main.value}/${wal._tag === "Some" ? wal.value : "-"}`;
        const sinceMs = Math.min(retentionCutoffMs, windowStartMs);
        const now = yield* Clock.currentTimeMillis;
        const cached = cache.get(database);
        const usable =
          cached !== undefined &&
          cached.sinceMs <= sinceMs &&
          (cached.fingerprint === fingerprint ||
            (!awaitRefresh && now - cached.readAtMs < REFRESH_INTERVAL_MS));
        let records = usable ? cached.records : null;
        if (records === null) {
          const read = yield* readDevinUsage(database, sinceMs).pipe(Effect.result);
          if (Result.isFailure(read)) {
            scans.push({
              dir,
              instanceId: instance.instanceId,
              displayName,
              status: "partial",
              message: "Devin's usage history could not be read.",
              files:
                cached === undefined
                  ? []
                  : [
                      {
                        path: database,
                        records: cached.records.filter(
                          (record) => record.timestampMs >= windowStartMs,
                        ),
                      },
                    ],
            });
            continue;
          }
          records = read.success;
          cache.set(database, { fingerprint, sinceMs, readAtMs: now, records });
        }
        scans.push({
          dir,
          instanceId: instance.instanceId,
          displayName,
          files: [
            {
              path: database,
              records: records.filter((record) => record.timestampMs >= windowStartMs),
            },
          ],
        });
      }
      return scans;
    }),
  };
};

export const devinUsageReader = makeDevinUsageReader();
