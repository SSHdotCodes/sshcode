// @effect-diagnostics nodeBuiltinImport:off -- Opt-in benchmark compares the actual old SQLite query with the disposable worker index.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { EmbeddingConfig } from "./ThreadSearchEmbeddings.ts";
const decodeConfig = Schema.decodeUnknownSync(Schema.fromJsonString(EmbeddingConfig));
const encodeMetrics = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
import { openSearchIndex } from "./ThreadSearchIndex.ts";

it.live.skipIf(process.env.SEARCH_BENCHMARK !== "1")(
  "benchmarks 50k synthetic messages and 768-dimensional vectors",
  () =>
    Effect.gen(function* () {
      const directory = process.env.SEARCH_BENCHMARK_DIR;
      if (!directory)
        throw new Error(
          "Set SEARCH_BENCHMARK_DIR to the isolated synthetic fixture userdata directory",
        );
      const source = new NodeSqlite.DatabaseSync(`${directory}/statev2.sqlite`, { readOnly: true });
      yield* Effect.addFinalizer(() => Effect.sync(() => source.close()));
      const index = yield* openSearchIndex(`${directory}/search-index-v1.sqlite`);
      yield* index.rebuild;
      const threads = source
        .prepare(
          "SELECT thread_id AS threadId,project_id AS projectId,title,archived_at IS NOT NULL AS archived FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL",
        )
        .all();
      const config = decodeConfig(
        NodeFS.readFileSync(`${directory}/search-index-config.json`, "utf8"),
      );
      yield* index.configure(`${config.url}|${config.model}|search-result-v1`);
      yield* index.syncThreads(
        threads.map((t) => ({
          threadId: String(t.threadId),
          projectId: String(t.projectId),
          title: String(t.title),
          archived: !!t.archived,
        })),
      );
      let cursor = 0;
      while (true) {
        const batch = source
          .prepare(
            "SELECT rowid AS rowId,message_id AS messageId,thread_id AS threadId,role AS source,json_extract(payload_json,'$.text') AS text,created_at AS createdAt,updated_at AS updatedAt FROM orchestration_v2_projection_messages WHERE rowid>? ORDER BY rowid LIMIT 500",
          )
          .all(cursor);
        if (!batch.length) break;
        yield* index.upsert(
          batch.map((d) => ({
            messageId: String(d.messageId),
            threadId: String(d.threadId),
            text: String(d.text),
            source: d.source === "user" ? ("user" as const) : ("assistant" as const),
            createdAt: String(d.createdAt),
            updatedAt: String(d.updatedAt),
          })),
        );
        cursor = Number(batch.at(-1)!.rowId);
      }
      while (true) {
        const chunks = yield* index.pending(128);
        if (!chunks.length) break;
        yield* index.storeVectors(
          chunks.map((c) => {
            const vector = Array<number>(768).fill(0);
            vector[
              c.text.includes("keychain")
                ? 0
                : c.text.includes("Network")
                  ? 1
                  : c.text.includes("garden")
                    ? 2
                    : 3
            ] = 1;
            return { ...c, vector };
          }),
        );
      }
      const legacy = source.prepare(`WITH candidate AS (
    SELECT t.thread_id,t.project_id,m.role,json_extract(m.payload_json,'$.text') AS match_text,m.created_at AS message_created_at,m.message_id,t.updated_at AS thread_updated_at
    FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_threads t ON t.thread_id=m.thread_id JOIN projection_projects p ON p.project_id=t.project_id
    WHERE t.deleted_at IS NULL AND t.archived_at IS NULL AND p.deleted_at IS NULL AND m.streaming=0 AND m.role IN ('user','assistant') AND json_extract(m.payload_json,'$.text') LIKE ? ESCAPE '!'
  ), ranked AS (SELECT *,CASE role WHEN 'user' THEN 0 ELSE 1 END AS match_rank,ROW_NUMBER() OVER(PARTITION BY thread_id ORDER BY CASE role WHEN 'user' THEN 0 ELSE 1 END,message_created_at DESC,message_id) AS n FROM candidate)
  SELECT * FROM ranked WHERE n=1 ORDER BY match_rank,thread_updated_at DESC,thread_id LIMIT 50`);
      const vector = Array<number>(768).fill(0);
      vector[0] = 1;
      const cold = performance.now();
      yield* index.semantic(vector);
      const coldVectorMs = performance.now() - cold;
      const times = { legacy: [] as number[], keyword: [] as number[], vector: [] as number[] };
      for (let n = 0; n < 20; n++) {
        const query = [
          "satisfiesSemverRange",
          "system keychain",
          "network retry",
          "nonexistentfragment",
        ][n % 4]!;
        let start = performance.now();
        legacy.all(`%${query}%`);
        times.legacy.push(performance.now() - start);
        start = performance.now();
        yield* index.keyword(query);
        times.keyword.push(performance.now() - start);
        start = performance.now();
        yield* index.semantic(vector);
        times.vector.push(performance.now() - start);
      }
      const summary = (xs: number[]) => {
        xs.sort((a, b) => a - b);
        return { p50: xs[Math.floor(xs.length / 2)], p95: xs[Math.floor(xs.length * 0.95)] };
      };
      const bytes = ["", "-wal", "-shm"].reduce(
        (n, suffix) =>
          n +
          (NodeFS.existsSync(`${directory}/search-index-v1.sqlite${suffix}`)
            ? NodeFS.statSync(`${directory}/search-index-v1.sqlite${suffix}`).size
            : 0),
        0,
      );
      const metrics = {
        messages: yield* index.count,
        ...(yield* index.stats),
        indexBytes: bytes,
        coldVectorMs,
        legacyMs: summary(times.legacy),
        keywordMs: summary(times.keyword),
        vectorMs: summary(times.vector),
      };
      NodeFS.writeFileSync(`${directory}/search-benchmark.json`, encodeMetrics(metrics));
    }).pipe(Effect.scoped),
  120_000,
);
