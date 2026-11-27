import {
  NodeId,
  NonNegativeInt,
  RunId,
  TeamBoardError,
  TeamBoardFile,
  TeamBoardPost,
  ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import {
  emptyLedger,
  foldLedger,
  pruneLedger,
  POST_LIMIT,
  RETENTION_MS,
  type BoardStats,
  type Ledger,
  type LedgerEntry,
} from "./model.ts";

const Stats = Schema.Struct({
  claims: NonNegativeInt,
  conflicts: NonNegativeInt,
  postsWritten: NonNegativeInt,
  postsRead: NonNegativeInt,
  lateNotices: NonNegativeInt,
});
const Claim = Schema.Struct({
  repo: Schema.String,
  file: Schema.String,
  post: Schema.String,
  memberId: NodeId,
  runId: RunId,
});
const StoredPost = Schema.Struct({
  repo: Schema.String,
  pushId: Schema.optionalKey(Schema.String),
  post: TeamBoardPost,
  requestId: Schema.optionalKey(Schema.String),
  replaces: Schema.optionalKey(Schema.String),
});
const Claims = Schema.Array(Claim);
const Closed = Schema.Struct({ at: NonNegativeInt, files: Schema.Array(TeamBoardFile) });
const PushMetadata = Schema.Struct({
  repo: Schema.String,
  repoName: Schema.optionalKey(Schema.String),
  startedAt: NonNegativeInt,
  members: Schema.Record(Schema.String, Schema.String),
});
const StoredEdit = Schema.Struct({
  head: Schema.String,
  committed: Schema.Array(Schema.String),
  signature: Schema.String,
  changedAt: NonNegativeInt,
  stale: Schema.optionalKey(Schema.Boolean),
  files: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      ranges: Schema.Array(Schema.Struct({ start: NonNegativeInt, end: NonNegativeInt })),
      newFile: Schema.optionalKey(Schema.Literal(true)),
    }),
  ),
});
const OpenPush = Schema.Struct({
  ...PushMetadata.fields,
  namesByThread: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  implicitNotices: Schema.optionalKey(Schema.Record(Schema.String, NonNegativeInt)),
  liveEdits: Schema.optionalKey(
    Schema.Array(Schema.Struct({ threadId: ThreadId, edit: StoredEdit })),
  ),
  pairs: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        a: NodeId,
        b: NodeId,
        path: Schema.String,
        severity: NonNegativeInt,
        confirmed: Schema.optionalKey(Schema.Boolean),
      }),
    ),
  ),
  ended: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        member: Schema.Struct({
          taskId: NodeId,
          threadId: ThreadId,
          name: Schema.String,
          cwd: Schema.String,
          runId: Schema.optionalKey(RunId),
          base: Schema.optionalKey(Schema.String),
          worktree: Schema.Boolean,
        }),
        claims: Schema.Array(Schema.String),
        edit: Schema.optionalKey(StoredEdit),
      }),
    ),
  ),
});
const ArchivedPush = Schema.Struct({
  ...PushMetadata.fields,
  id: Schema.String,
  endedAt: NonNegativeInt,
  posts: Schema.Array(StoredPost),
  files: Schema.Array(TeamBoardFile),
  overlapCount: NonNegativeInt,
});
const Snapshot = Schema.Struct({
  closed: Schema.optionalKey(Closed),
  posts: Schema.Array(StoredPost),
  claims: Claims,
  reads: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  stats: Schema.Record(Schema.String, Stats),
  open: Schema.optionalKey(Schema.Record(Schema.String, OpenPush)),
  history: Schema.optionalKey(Schema.Array(ArchivedPush)),
});
const statsLine = Schema.fromJsonString(
  Schema.Struct({
    cohort: Schema.String,
    leadThreadId: Schema.String,
    at: NonNegativeInt,
    ...Stats.fields,
  }),
);
const entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: Snapshot }),
  Schema.Struct({ type: Schema.Literal("closed"), closed: Closed }),
  Schema.Struct({ type: Schema.Literal("open"), id: Schema.String, push: OpenPush }),
  Schema.Struct({ type: Schema.Literal("archive"), push: ArchivedPush }),
  Schema.Struct({ type: Schema.Literal("post"), stored: StoredPost, claims: Claims }),
  Schema.Struct({ type: Schema.Literal("claims"), claims: Claims }),
  Schema.Struct({
    type: Schema.Literal("read"),
    reader: Schema.String,
    read: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("stats"),
    cohort: Schema.String,
    stats: Schema.optionalKey(Stats),
  }),
]);
const row = Schema.fromJsonString(Schema.toCodecJson(Schema.Array(entry)));
const decodeRow = Schema.decodeOption(row);
const encodeRow = Schema.encodeSync(row);
const decodeStatsLine = Schema.decodeOption(statsLine);
const encodeStatsLine = Schema.encodeEffect(statsLine);
const Notices = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      threadId: ThreadId,
      runId: RunId,
      at: NonNegativeInt,
      text: Schema.String,
      pushId: Schema.optionalKey(Schema.String),
      batchAt: Schema.optionalKey(NonNegativeInt),
      batchCount: Schema.optionalKey(NonNegativeInt),
      attachOnly: Schema.optionalKey(Schema.Boolean),
      postIds: Schema.optionalKey(Schema.Array(Schema.String)),
      from: Schema.optionalKey(ThreadId),
      guidance: Schema.optionalKey(Schema.Boolean),
      leadGuidance: Schema.optionalKey(Schema.Boolean),
      fallbackText: Schema.optionalKey(Schema.String),
      late: Schema.optionalKey(
        Schema.Struct({ leadId: ThreadId, repo: Schema.String, file: Schema.String }),
      ),
    }),
  ),
);
const decodeNotices = Schema.decodeUnknownEffect(Notices);
const encodeNotices = Schema.encodeEffect(Notices);
const BoardCatalog = Schema.fromJsonString(
  Schema.Record(Schema.String, Schema.Array(Schema.String)),
);
const decodeBoardCatalog = Schema.decodeOption(BoardCatalog);
const encodeBoardCatalog = Schema.encodeSync(BoardCatalog);
export type TeamBoardNotice = (typeof Notices.Type)[number];
const MAX_ROWS = 384;
const MAX_BYTES = 2_000_000;

export class TeamBoardJournal extends Context.Service<
  TeamBoardJournal,
  {
    readonly load: (leadId: ThreadId) => Effect.Effect<Ledger, TeamBoardError>;
    readonly isIndexed: (leadId: ThreadId) => boolean;
    readonly append: (
      leadId: ThreadId,
      entries: ReadonlyArray<LedgerEntry>,
      next: Ledger,
    ) => Effect.Effect<void, TeamBoardError>;
    readonly finish: (
      leadId: ThreadId,
      cohort: string,
      stats: BoardStats,
    ) => Effect.Effect<void, TeamBoardError>;
    readonly sweep: (active: ReadonlySet<ThreadId>) => Effect.Effect<void, TeamBoardError>;
    readonly checkpointOnRestart: Effect.Effect<
      ReadonlyMap<ThreadId, ReadonlySet<string>>,
      TeamBoardError
    >;
    readonly loadNotices: Effect.Effect<ReadonlyArray<TeamBoardNotice>, TeamBoardError>;
    readonly saveNotices: (
      notices: ReadonlyArray<TeamBoardNotice>,
    ) => Effect.Effect<void, TeamBoardError>;
  }
>()("t3/teamBoard/TeamBoardJournal") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const files = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const replace = (input: Parameters<typeof writeFileStringAtomically>[0]) =>
    writeFileStringAtomically(input).pipe(Effect.provideContext(files));
  const directory = path.join(config.stateDir, "boards");
  const statsPath = path.join(directory, "stats.jsonl");
  const noticesPath = path.join(directory, "undelivered.json");
  const catalogPath = path.join(directory, "catalog.json");
  const sizes = new Map<ThreadId, { readonly rows: number; readonly bytes: number }>();
  const catalog = new Map<ThreadId, ReadonlyArray<string>>();
  const boardPath = (leadId: ThreadId) =>
    path.join(directory, `${encodeURIComponent(leadId)}.jsonl`);
  const ensureDirectory = fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
  const read = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.catchIf(
        (cause) => cause.reason._tag === "NotFound",
        () => Effect.succeed(""),
      ),
    );
  const load: TeamBoardJournal["Service"]["load"] = Effect.fnUntraced(
    function* (leadId) {
      const source = yield* read(boardPath(leadId));
      const lines = source.split("\n").filter(Boolean);
      let state = emptyLedger;
      for (const line of lines) {
        const decoded = decodeRow(line);
        if (decoded._tag === "Some") state = decoded.value.reduce(foldLedger, state);
      }
      sizes.set(leadId, { rows: lines.length, bytes: Buffer.byteLength(source) });
      const next = pruneLedger(state, yield* Clock.currentTimeMillis);
      // An append interrupted by process loss must not consume the following row.
      if (
        (source !== "" && !source.endsWith("\n")) ||
        next.posts.length !== state.posts.length ||
        next.history?.length !== state.history?.length ||
        next.closed !== state.closed
      ) {
        const contents = `${encodeRow([{ type: "snapshot", snapshot: next }])}\n`;
        yield* replace({ filePath: boardPath(leadId), contents });
        sizes.set(leadId, { rows: 1, bytes: Buffer.byteLength(contents) });
      }
      return next;
    },
    Effect.mapError(
      (cause) => new TeamBoardError({ message: "Could not read team board.", cause }),
    ),
  );
  const saveCatalog = (leadId: ThreadId, repos: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const next = new Map(catalog);
      next.set(leadId, repos);
      yield* replace({
        filePath: catalogPath,
        contents: encodeBoardCatalog(Object.fromEntries(next)),
      });
      catalog.set(leadId, repos);
    });
  const append: TeamBoardJournal["Service"]["append"] = Effect.fnUntraced(
    function* (leadId, entries, next) {
      if (entries.length === 0) return;
      yield* ensureDirectory;
      const before = catalog.get(leadId);
      const after = [...new Set(Object.values(next.open ?? {}).map(({ repo }) => repo))];
      const indexed = [...new Set([...(before ?? []), ...after])];
      // Index a newly opened push before appending it. A crash can leave a
      // redundant index entry, but cannot leave a committed open push hidden.
      if (before === undefined || before.length < indexed.length)
        yield* saveCatalog(leadId, indexed);
      const size = sizes.get(leadId);
      const count = (size?.rows ?? 0) + 1;
      const entry = `\n${encodeRow(entries)}\n`;
      const bytes = (size?.bytes ?? 0) + Buffer.byteLength(entry);
      if (
        count > MAX_ROWS ||
        bytes > MAX_BYTES ||
        entries.some((entry) => entry.type === "archive") ||
        (next.posts.length >= POST_LIMIT && entries.some((entry) => entry.type === "post"))
      ) {
        const contents = `${encodeRow([{ type: "snapshot", snapshot: next }])}\n`;
        yield* replace({ filePath: boardPath(leadId), contents });
        sizes.set(leadId, { rows: 1, bytes: Buffer.byteLength(contents) });
      } else {
        yield* fs.writeFileString(boardPath(leadId), entry, {
          flag: "a",
          mode: 0o600,
        });
        sizes.set(leadId, { rows: count, bytes });
      }
      // Removing a stale entry is recoverable from the authoritative journal.
      if (after.length < indexed.length) yield* saveCatalog(leadId, after).pipe(Effect.ignore);
    },
    Effect.mapError(
      (cause) => new TeamBoardError({ message: "Could not save team board.", cause }),
    ),
  );
  const finish: TeamBoardJournal["Service"]["finish"] = Effect.fnUntraced(
    function* (leadId, cohort, stats) {
      yield* ensureDirectory;
      const now = yield* Clock.currentTimeMillis;
      const old = yield* read(statsPath);
      const rows = old.split("\n").map((line) => ({ line, stats: decodeStatsLine(line) }));
      if (
        rows.some(
          ({ stats: row }) =>
            row._tag === "Some" &&
            row.value.leadThreadId === leadId &&
            row.value.cohort === cohort &&
            row.value.at > now - RETENTION_MS &&
            Object.entries(stats).every(
              ([key, value]) => row.value[key as keyof BoardStats] === value,
            ),
        )
      )
        return;
      const kept = rows
        .flatMap(({ line, stats: parsed }) =>
          parsed._tag === "Some" &&
          parsed.value.at > now - RETENTION_MS &&
          !(parsed.value.leadThreadId === leadId && parsed.value.cohort === cohort)
            ? [line]
            : [],
        )
        .slice(-8191);
      const line = yield* encodeStatsLine({ leadThreadId: leadId, cohort, at: now, ...stats });
      if (kept.length === 0 && old === "") {
        yield* fs.writeFileString(statsPath, `${line}\n`, { flag: "a", mode: 0o600 });
      } else {
        yield* replace({ filePath: statsPath, contents: [...kept, line].join("\n") + "\n" });
      }
    },
    Effect.mapError(
      (cause) => new TeamBoardError({ message: "Could not save team board statistics.", cause }),
    ),
  );
  const sweep: TeamBoardJournal["Service"]["sweep"] = Effect.fnUntraced(
    function* (active) {
      if (!(yield* fs.exists(directory))) return;
      const cutoff = (yield* Clock.currentTimeMillis) - RETENTION_MS;
      for (const name of yield* fs.readDirectory(directory)) {
        if (
          !name.endsWith(".jsonl") ||
          name === "stats.jsonl" ||
          [...active].some((id) => path.basename(boardPath(id)) === name)
        )
          continue;
        const file = path.join(directory, name);
        const info = yield* fs.stat(file);
        if (info.type !== "File") continue;
        if (info.mtime._tag === "Some" && info.mtime.value.getTime() < cutoff)
          yield* fs.remove(file);
        else if (Number(info.size) > MAX_BYTES)
          yield* Effect.logWarning("Large team board journal", { bytes: Number(info.size) });
      }
    },
    Effect.mapError(
      (cause) => new TeamBoardError({ message: "Could not prune team boards.", cause }),
    ),
  );
  const checkpointOnRestart = Effect.gen(function* () {
    const repos = new Map<ThreadId, ReadonlySet<string>>();
    if (!(yield* fs.exists(directory))) return repos;
    const index = Option.getOrElse(decodeBoardCatalog(yield* read(catalogPath)), () => ({}));
    for (const [id, openRepos] of Object.entries(index)) catalog.set(ThreadId.make(id), openRepos);
    for (const name of yield* fs.readDirectory(directory)) {
      if (!name.endsWith(".jsonl") || name === "stats.jsonl") continue;
      let leadId: ThreadId;
      try {
        leadId = ThreadId.make(decodeURIComponent(name.slice(0, -6)));
      } catch {
        continue;
      }
      if (!catalog.has(leadId)) repos.set(leadId, new Set());
    }
    for (const [leadId, indexed] of catalog) {
      if (indexed.length === 0) {
        repos.set(leadId, new Set());
        continue;
      }
      const result = yield* Effect.option(load(leadId));
      if (Option.isNone(result)) continue;
      const ledger = result.value;
      for (const [id, stats] of Object.entries(ledger.stats)) yield* finish(leadId, id, stats);
      const openRepos = new Set(Object.values(ledger.open ?? {}).map(({ repo }) => repo));
      repos.set(leadId, openRepos);
      if (openRepos.size !== indexed.length || indexed.some((repo) => !openRepos.has(repo)))
        yield* saveCatalog(leadId, [...openRepos]).pipe(Effect.ignore);
    }
    return repos;
  }).pipe(
    Effect.mapError(
      (cause) => new TeamBoardError({ message: "Could not checkpoint board statistics.", cause }),
    ),
  );
  const loadNotices = read(noticesPath).pipe(
    Effect.flatMap((contents) => (contents === "" ? Effect.succeed([]) : decodeNotices(contents))),
    Effect.mapError(
      (cause) => new TeamBoardError({ message: "Could not read team board notices.", cause }),
    ),
  );
  const saveNotices = (notices: ReadonlyArray<TeamBoardNotice>) =>
    ensureDirectory.pipe(
      Effect.andThen(encodeNotices(notices)),
      Effect.flatMap((contents) => replace({ filePath: noticesPath, contents })),
      Effect.mapError(
        (cause) => new TeamBoardError({ message: "Could not save team board notices.", cause }),
      ),
    );
  return TeamBoardJournal.of({
    load,
    isIndexed: (leadId) => catalog.has(leadId),
    append,
    finish,
    sweep,
    checkpointOnRestart,
    loadNotices,
    saveNotices,
  });
});

export const layer = Layer.effect(TeamBoardJournal, make);
