import {
  IsoDateTime,
  isHelperThreadId,
  MODEL_MANAGER_THREAD_ID_PREFIX,
  OVERVIEW_THREAD_ID_PREFIX,
  MessageId,
  ProjectId,
  PROVIDER_DISPLAY_NAMES,
  ProviderDriverKind,
  ThreadId,
  defaultInstanceIdForDriver,
  OrchestrationThreadSearchSource,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  type OrchestrationV2DomainEvent,
  type ThreadSearchStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as ServerConfig from "../config.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as EventSink from "./EventSink.ts";
import { openSearchIndex } from "./ThreadSearchIndex.ts";
import {
  DEFAULT_EMBEDDING_CONFIG,
  EmbeddingConfig,
  embed,
  fuseSearchResults,
} from "./ThreadSearchEmbeddings.ts";

/** Carries no query text: search input is user content. */
export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Thread search ${this.operation} failed.`;
  }
}
const ThreadRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  archived: Schema.Number,
  updatedAt: IsoDateTime,
  model: Schema.NullOr(Schema.String),
  providerInstanceId: Schema.NullOr(Schema.String),
});
const MessageRow = Schema.Struct({
  rowId: Schema.Number,
  messageId: MessageId,
  threadId: ThreadId,
  source: OrchestrationThreadSearchSource,
  text: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Set by the backfill scan: 1 when the chat no longer shows the message. */
  hidden: Schema.optionalKey(Schema.Number),
});
const decodeThreads = Schema.decodeUnknownEffect(Schema.Array(ThreadRow));
const decodeMessages = Schema.decodeUnknownEffect(Schema.Array(MessageRow));
const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(EmbeddingConfig));
const encodeConfig = Schema.encodeSync(Schema.fromJsonString(EmbeddingConfig));
const defaultHarnessLabels = new Map<string, string>(
  Object.entries(PROVIDER_DISPLAY_NAMES).flatMap(([driver, label]) =>
    label ? [[defaultInstanceIdForDriver(ProviderDriverKind.make(driver)), label] as const] : [],
  ),
);
const searchEvents = new Set<OrchestrationV2DomainEvent["type"]>([
  "message.updated",
  "run.updated",
  "thread.created",
  "thread.deleted",
  "thread.archived",
  "thread.unarchived",
  "thread.metadata-updated",
  "thread.model-selection-updated",
  "thread.provider-switched",
]);

export function tracksSearchEvent(type: OrchestrationV2DomainEvent["type"]) {
  return searchEvents.has(type);
}

export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
    readonly searchStream: (
      input: OrchestrationSearchThreadsInput,
    ) => Stream.Stream<OrchestrationSearchThreadsResult, ThreadSearchError>;
    readonly status: Effect.Effect<ThreadSearchStatus, ThreadSearchError>;
    readonly rebuild: Effect.Effect<void, ThreadSearchError>;
    readonly backfillBatch: Effect.Effect<boolean, ThreadSearchError>;
    readonly repair: Effect.Effect<void, ThreadSearchError>;
    readonly embedBatch: Effect.Effect<boolean, ThreadSearchError>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void, ThreadSearchError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope | EventSink.EventSinkV2>;
  }
>()("t3/orchestration-v2/ThreadSearch") {}

// Search finds the chats a person works in. A subagent chat repeats its lead's words (the
// brief, the report) and is opened from the lead's card, so its hits were noise; leaving
// subagents out also covers the agents inside a dedicated workflow lineage.
// Provenance already lives in projection JSON, so old indexes repair on sync.
const visibleSearchThread = (
  sql: SqlClient.SqlClient,
) => sql`json_extract(t.payload_json,'$.creationSource') IS NOT 'workflows'
  AND json_extract(t.payload_json,'$.lineage.relationshipToParent') IS NOT 'subagent'`;
// A chat no longer shows a rolled-back turn, nor a message of a stopped turn that no shown
// item carries, such as a queued prompt that never ran (unless storage maintenance kept it);
// search must not find them either.
const hiddenSearchMessage = (sql: SqlClient.SqlClient) => sql`EXISTS (
  SELECT 1 FROM orchestration_v2_projection_runs r
  WHERE r.run_id = m.run_id
    AND (
      r.status = 'rolled_back'
      OR (
        r.status = 'cancelled'
        AND COALESCE(json_extract(r.payload_json, '$.retainQueuedMessage'), 0) = 0
        AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items i
          WHERE i.run_id = r.run_id
            AND json_extract(i.payload_json, '$.messageId') = m.message_id
            AND json_extract(i.payload_json, '$.inputIntent') IS NOT 'queued_turn'
        )
      )
    )
)`;

/** One rowid window of searchable messages, before embedding or index writes. */
export const readSearchBackfillBatch = (sql: SqlClient.SqlClient, cursor: number) => sql`
  SELECT m.rowid AS "rowId", m.message_id AS "messageId", m.thread_id AS "threadId",
    m.role AS source, json_extract(m.payload_json, '$.text') AS text,
    m.created_at AS "createdAt", m.updated_at AS "updatedAt", ${hiddenSearchMessage(sql)} AS hidden
  FROM orchestration_v2_projection_messages m
  CROSS JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
  CROSS JOIN projection_projects p ON p.project_id = t.project_id
  WHERE m.rowid > ${cursor} AND m.streaming = 0 AND m.role IN ('user', 'assistant')
    AND t.deleted_at IS NULL AND p.deleted_at IS NULL AND ${visibleSearchThread(sql)}
  ORDER BY m.rowid LIMIT 100
`;

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const policy = yield* BackgroundPolicy.BackgroundPolicy;
  const filename = path.join(config.stateDir, "search-index-v1.sqlite");
  const configPath = path.join(config.stateDir, "search-index-config.json");
  yield* fs.makeDirectory(config.stateDir, { recursive: true }).pipe(Effect.orDie);
  const embeddingConfig = yield* fs.readFileString(configPath).pipe(
    Effect.flatMap(decodeConfig),
    Effect.orElseSucceed(() => DEFAULT_EMBEDDING_CONFIG),
  );
  if (!(yield* fs.exists(configPath)))
    yield* fs
      .writeFileString(configPath, encodeConfig(embeddingConfig), { mode: 0o600 })
      .pipe(Effect.ignore);
  const index = yield* openSearchIndex(filename).pipe(Effect.orDie);
  yield* index
    .configure(`${embeddingConfig.url}|${embeddingConfig.model}|search-result-v1`)
    .pipe(Effect.orDie);
  const mutex = yield* Semaphore.make(1);
  let cursor = 0;
  let backfillComplete = false;
  let repairSequence: number | undefined;
  let indexGeneration = yield* index.generation.pipe(Effect.orDie);
  let knownThreads = new Set<string>();
  const restoredThreads = new Set<string>();
  let modelStatus: ThreadSearchStatus["modelStatus"] = "checking";
  let retryEmbeddingsAt = 0;
  const streamingMessages = new Set<string>();
  const queryVectors = new Map<string, ReadonlyArray<number>>();
  const mapError = (cause: unknown) =>
    new ThreadSearchError({ operation: Schema.isSchemaError(cause) ? "decode" : "query", cause });
  const read = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(NodeSqliteClient.readOnly);
  const visibleThread = visibleSearchThread(sql);
  const hiddenMessage = hiddenSearchMessage(sql);
  const refreshThreads = Effect.gen(function* () {
    const rows = yield* read(
      sql`SELECT t.thread_id AS "threadId", t.project_id AS "projectId", t.title,
        t.archived_at IS NOT NULL AS archived, t.updated_at AS "updatedAt",
        json_extract(t.payload_json, '$.modelSelection.model') AS model,
        COALESCE(t.provider_instance_id, t.default_provider) AS "providerInstanceId"
        FROM orchestration_v2_projection_threads t
        JOIN projection_projects p ON p.project_id = t.project_id
        WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND ${visibleThread}
        ORDER BY t.updated_at DESC`,
    ).pipe(Effect.flatMap(decodeThreads));
    yield* index.syncThreads(
      rows
        .filter((t) => !isHelperThreadId(t.threadId))
        .map((t) => ({
          ...t,
          archived: !!t.archived,
          harness: t.providerInstanceId
            ? (defaultHarnessLabels.get(t.providerInstanceId) ??
              t.providerInstanceId.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " "))
            : null,
        })),
    );
    const nextThreads = new Set(
      rows.filter((t) => !isHelperThreadId(t.threadId)).map((t) => String(t.threadId)),
    );
    if (repairSequence !== undefined)
      for (const id of nextThreads) if (!knownThreads.has(id)) restoredThreads.add(id);
    knownThreads = nextThreads;
  });
  // Only the search settings screen needs the projection count.
  const [totalMessages, invalidateCount] = yield* Effect.cachedInvalidateWithTTL(
    read(
      sql<{
        count: number;
      }>`SELECT count(*) AS count FROM orchestration_v2_projection_messages m JOIN orchestration_v2_projection_threads t ON t.thread_id=m.thread_id JOIN projection_projects p ON p.project_id=t.project_id WHERE t.deleted_at IS NULL AND p.deleted_at IS NULL AND t.thread_id NOT GLOB ${`${MODEL_MANAGER_THREAD_ID_PREFIX}*`} AND t.thread_id NOT GLOB ${`${OVERVIEW_THREAD_ID_PREFIX}*`} AND m.streaming=0 AND m.role IN ('user','assistant') AND ${visibleThread}`,
    ).pipe(Effect.map((rows) => rows[0]?.count ?? 0)),
    Exit.match({ onSuccess: () => Duration.infinity, onFailure: () => Duration.zero }),
  );
  // Runs every 30 seconds on the one reader. Without the partial index the OR
  // planner scans every event (seconds, nearly a minute under load) and every
  // other read waits behind it; with it this is a single index seek.
  const latestSequence = read(sql<{ sequence: number }>`
    SELECT COALESCE(MAX(sequence), 0) AS sequence
    FROM orchestration_events INDEXED BY idx_orchestration_events_application_high_water
    WHERE aggregate_kind = 'project'
      OR (application_event_version = 2 AND aggregate_kind = 'thread')
  `).pipe(Effect.map((rows) => rows[0]?.sequence ?? 0));
  const checkIndex = Effect.gen(function* () {
    const generation = yield* index.generation;
    if (generation === indexGeneration) return;
    yield* index.configure(`${embeddingConfig.url}|${embeddingConfig.model}|search-result-v1`);
    indexGeneration = generation;
    cursor = 0;
    backfillComplete = false;
    repairSequence = undefined;
    restoredThreads.clear();
  });
  const backfillBatch = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        if (!(yield* policy.shouldRunOpportunisticWork)) return false;
        yield* checkIndex;
        if (repairSequence === undefined) {
          // Start before the scan so edits to rows already passed by the cursor
          // are still reconciled once startup repair finishes.
          const sequence = yield* latestSequence;
          yield* refreshThreads;
          yield* invalidateCount;
          repairSequence = sequence;
        }
        const rows = yield* read(readSearchBackfillBatch(sql, cursor)).pipe(
          Effect.flatMap(decodeMessages),
        );
        if (rows.some((row) => !knownThreads.has(row.threadId))) yield* refreshThreads;
        // Also clears hidden messages an index built before this rule still holds.
        for (const row of rows) if (row.hidden) yield* index.removeMessage(row.messageId);
        yield* index.upsert(rows.filter((row) => !row.hidden && knownThreads.has(row.threadId)));
        cursor = rows.at(-1)?.rowId ?? cursor;
        const completed = rows.length < 100;
        if (completed && !backfillComplete) yield* invalidateCount;
        backfillComplete = completed;
        return !backfillComplete;
      }),
    )
    .pipe(Effect.mapError(mapError));
  const repair = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        yield* checkIndex;
        if (!backfillComplete || repairSequence === undefined) return;
        const through = yield* latestSequence;
        if (through === repairSequence && restoredThreads.size === 0) return;
        // Only identities are read from the log. Large unchanged projection bodies
        // are never revisited, and timestamps need not be monotonic.
        const changes = yield* read(sql<{ message_id: string }>`
      SELECT DISTINCT json_extract(payload_json, '$.id') AS message_id
      FROM orchestration_events INDEXED BY idx_orchestration_events_application_sequence
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND sequence > ${repairSequence} AND sequence <= ${through}
        AND event_type = 'message.updated'
    `);
        yield* refreshThreads;
        const restored = [...restoredThreads];
        for (const threadId of restored) {
          if (!knownThreads.has(threadId)) continue;
          let createdAt = "",
            messageId = "";
          while (true) {
            const rows = yield* read(sql`
          SELECT m.rowid AS "rowId", m.message_id AS "messageId", m.thread_id AS "threadId",
            m.role AS source, json_extract(m.payload_json, '$.text') AS text,
            m.created_at AS "createdAt", m.updated_at AS "updatedAt"
          FROM orchestration_v2_projection_messages m
          WHERE m.thread_id = ${threadId} AND (m.created_at, m.message_id) > (${createdAt}, ${messageId})
            AND m.streaming = 0 AND m.role IN ('user','assistant') AND NOT ${hiddenMessage}
          ORDER BY m.created_at, m.message_id LIMIT 100
        `).pipe(Effect.flatMap(decodeMessages));
            if (knownThreads.has(threadId)) yield* index.upsert(rows);
            if (rows.length < 100) break;
            createdAt = rows.at(-1)!.createdAt;
            messageId = rows.at(-1)!.messageId;
          }
        }
        for (let start = 0; start < changes.length; start += 100) {
          const ids = changes.slice(start, start + 100).map((row) => row.message_id);
          const rows = yield* read(sql`
        SELECT m.rowid AS "rowId", m.message_id AS "messageId", m.thread_id AS "threadId",
          m.role AS source, json_extract(m.payload_json, '$.text') AS text,
          m.created_at AS "createdAt", m.updated_at AS "updatedAt"
        FROM orchestration_v2_projection_messages m
        JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
        JOIN projection_projects p ON p.project_id = t.project_id
        WHERE m.message_id IN ${sql.in(ids)} AND m.streaming = 0
          AND m.role IN ('user','assistant') AND t.deleted_at IS NULL
          AND p.deleted_at IS NULL AND ${visibleThread} AND NOT ${hiddenMessage}
      `).pipe(Effect.flatMap(decodeMessages));
          const present = new Set(
            rows.filter((row) => knownThreads.has(row.threadId)).map((row) => row.messageId),
          );
          for (const id of ids)
            if (!present.has(MessageId.make(id))) yield* index.removeMessage(id);
          yield* index.upsert(rows.filter((row) => knownThreads.has(row.threadId)));
        }
        yield* invalidateCount;
        repairSequence = through;
        for (const id of restored) restoredThreads.delete(id);
      }),
    )
    .pipe(Effect.mapError(mapError));
  const embedBatch = Effect.gen(function* () {
    if (
      !(yield* policy.shouldRunOpportunisticWork) ||
      (yield* Clock.currentTimeMillis) < retryEmbeddingsAt
    )
      return false;
    const pending = yield* index.pending(16);
    if (!pending.length) return false;
    const vectors = yield* embed(
      embeddingConfig,
      pending.map((p) => `title: ${p.title || "none"} | text: ${p.text}`),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.catch(() => Effect.succeed(null)),
    );
    if (vectors === null) {
      modelStatus = "unavailable";
      retryEmbeddingsAt = (yield* Clock.currentTimeMillis) + 60_000;
      return false;
    }
    modelStatus = "ready";
    yield* index.storeVectors(pending.map((p, i) => ({ ...p, vector: vectors[i]! })));
    return true;
  }).pipe(Effect.mapError(mapError));
  const status = Effect.gen(function* () {
    const indexedMessages = yield* index.count;
    const stats = yield* index.stats;
    return {
      indexedMessages,
      totalMessages: yield* totalMessages,
      ...stats,
      model: embeddingConfig.model,
      modelStatus,
      paused: !(yield* policy.shouldRunOpportunisticWork),
    };
  }).pipe(Effect.mapError(mapError));
  const readKeyword = (input: OrchestrationSearchThreadsInput) =>
    index.keyword(input.query, input.limit, input.cursor).pipe(
      Effect.map((result) => ({
        ...result,
        matches: result.matches.filter((match) => !isHelperThreadId(match.threadId)),
      })),
    );
  const searchWithBudget = (
    input: OrchestrationSearchThreadsInput,
    budget: "120 millis" | "1500 millis",
    keywordResult?: OrchestrationSearchThreadsResult,
  ) =>
    Effect.gen(function* () {
      const keyword = keywordResult ?? (yield* readKeyword(input));
      const limit = input.limit ?? 50;
      if (input.mode === "keyword" || input.cursor || keyword.matches.length >= limit)
        return keyword;
      let vector = queryVectors.get(input.query);
      if (!vector && (yield* Clock.currentTimeMillis) >= retryEmbeddingsAt) {
        const result = yield* embed(embeddingConfig, [
          `task: search result | query: ${input.query}`,
        ]).pipe(
          Effect.timeout(budget),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (result) {
          vector = result[0];
          modelStatus = "ready";
          if (vector) {
            if (queryVectors.size >= 64) queryVectors.delete(queryVectors.keys().next().value!);
            queryVectors.set(input.query, vector);
          }
        } else {
          modelStatus = "unavailable";
        }
      }
      const semantic = vector ? yield* index.semantic(vector, 50) : { matches: [] };
      const keywordIds = new Set(keyword.matches.map((match) => match.threadId));
      let semanticSlots = limit - keyword.matches.length;
      return {
        ...keyword,
        matches: fuseSearchResults(
          input.query,
          keyword.matches,
          semantic.matches.filter((match) => !isHelperThreadId(match.threadId)),
          keyword.matches.length + semantic.matches.length,
        ).filter((match) => keywordIds.has(match.threadId) || semanticSlots-- > 0),
      };
    }).pipe(Effect.mapError(mapError));
  const search: ThreadSearch["Service"]["search"] = (input) =>
    searchWithBudget(input, input.mode === "hybrid" ? "1500 millis" : "120 millis");
  const searchStream: ThreadSearch["Service"]["searchStream"] = (input) =>
    Stream.concat(
      input.cursor
        ? Stream.empty
        : Stream.fromEffect(index.names(input.query, input.limit)).pipe(
            Stream.mapError(mapError),
            Stream.map((result) => ({
              matches: result.matches.filter((match) => !isHelperThreadId(match.threadId)),
              complete: false,
            })),
            Stream.filter((result) => result.matches.length > 0),
          ),
      Stream.unwrap(
        readKeyword(input).pipe(
          Effect.mapError(mapError),
          Effect.map((keyword) =>
            Stream.concat(
              Stream.make({
                ...keyword,
                complete: input.mode === "keyword" || input.cursor !== undefined,
              }),
              input.mode === "keyword" || input.cursor
                ? Stream.empty
                : Stream.fromEffect(
                    searchWithBudget(input, "1500 millis", keyword).pipe(
                      Effect.map((result) => ({ ...result, complete: true })),
                    ),
                  ),
            ),
          ),
        ),
      ),
    );
  const handle: ThreadSearch["Service"]["handle"] = (event) =>
    mutex
      .withPermits(1)(
        Effect.gen(function* () {
          if (event.type === "message.updated") {
            const m = event.payload;
            if (isHelperThreadId(m.threadId)) return;
            if (m.streaming || (m.role !== "user" && m.role !== "assistant")) {
              if (!streamingMessages.has(m.id)) {
                yield* index.removeMessage(m.id);
                streamingMessages.add(m.id);
              }
              return;
            }
            streamingMessages.delete(m.id);
            if (!knownThreads.has(m.threadId)) yield* refreshThreads;
            if (!knownThreads.has(m.threadId)) return;
            yield* index.upsert([
              {
                messageId: m.id,
                threadId: m.threadId,
                text: m.text,
                source: m.role,
                createdAt: DateTime.formatIso(m.createdAt),
                updatedAt: DateTime.formatIso(m.updatedAt),
              },
            ]);
          } else if (event.type === "run.updated") {
            if (event.payload.status !== "rolled_back" && event.payload.status !== "cancelled")
              return;
            const hidden = yield* read(sql<{ messageId: string }>`
              SELECT m.message_id AS "messageId" FROM orchestration_v2_projection_messages m
              WHERE m.run_id = ${event.payload.id} AND ${hiddenMessage}
            `);
            for (const row of hidden) yield* index.removeMessage(row.messageId);
          } else if (event.type.startsWith("thread.")) yield* refreshThreads;
        }),
      )
      .pipe(Effect.mapError(mapError));
  const rebuild = mutex
    .withPermits(1)(
      Effect.gen(function* () {
        yield* index.rebuild;
        cursor = 0;
        backfillComplete = false;
        repairSequence = undefined;
        restoredThreads.clear();
        queryVectors.clear();
        retryEmbeddingsAt = 0;
        modelStatus = "checking";
      }),
    )
    .pipe(Effect.mapError(mapError));
  const start: ThreadSearch["Service"]["start"] = () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const sequence = yield* sink.latestSequence().pipe(Effect.orElseSucceed(() => 0));
      yield* sink.stream({ afterSequence: sequence }).pipe(
        Stream.filter(({ event }) => tracksSearchEvent(event.type)),
        Stream.runForEach(({ event }) => handle(event).pipe(Effect.ignore)),
        Effect.forkScoped,
      );
      yield* mutex.withPermits(1)(refreshThreads).pipe(Effect.ignore, Effect.forkScoped);
      yield* Effect.forever(
        Effect.gen(function* () {
          yield* backfillBatch.pipe(Effect.ignore);
          yield* embedBatch.pipe(Effect.ignore);
          yield* Effect.sleep("1 second");
        }),
      ).pipe(Effect.forkScoped);
      // Startup scans repair persisted caches; subsequent passes visit only
      // messages changed since that scan and refresh project/thread visibility.
      yield* Effect.forever(
        Effect.sleep("30 seconds").pipe(Effect.andThen(repair), Effect.ignore),
      ).pipe(Effect.forkScoped);
    });
  return ThreadSearch.of({
    search,
    searchStream,
    status,
    rebuild,
    backfillBatch,
    repair,
    embedBatch,
    handle,
    start,
  });
});
export const layer = Layer.effect(ThreadSearch, make);
