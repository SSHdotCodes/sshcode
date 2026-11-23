/**
 * Port of `@effect/sql-sqlite-node` that uses the native `node:sqlite`
 * bindings instead of `better-sqlite3`.
 *
 * @module SqliteClient
 */
import * as NodeSqlite from "node:sqlite";
import * as NodeWorkerThreads from "node:worker_threads";

import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as Reactivity from "effect/reactivity/Reactivity";
import * as Client from "effect/sql/SqlClient";
import type { Connection } from "effect/sql/SqlConnection";
import { SqlError, classifySqliteError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";

const ATTR_DB_SYSTEM_NAME = "db.system.name";

export interface SqliteClientConfig {
  readonly filename: string;
  readonly readonly?: boolean | undefined;
  readonly allowExtension?: boolean | undefined;
  readonly prepareCacheSize?: number | undefined;
  readonly prepareCacheTTL?: Duration.Input | undefined;
  readonly spanAttributes?: Record<string, unknown> | undefined;
  readonly transformResultNames?: ((str: string) => string) | undefined;
  readonly transformQueryNames?: ((str: string) => string) | undefined;
  /**
   * Run transactions marked with `readOnly` on read-only connections in worker
   * threads, so long reads block neither the event loop, writes, nor other
   * concurrent reads. Ignored for in-memory databases, which a second
   * connection cannot share.
   */
  readonly readerWorker?: boolean | undefined;
  /**
   * Maximum number of concurrent read-only WAL worker connections when
   * `readerWorker` is enabled. Extra workers start lazily only when existing
   * readers are busy. Default 3.
   */
  readonly readerPoolSize?: number | undefined;
  /** How long a reader worker may take to open the database before reads use the writer. Default 10 seconds. */
  readonly readerStartupTimeout?: Duration.Input | undefined;
  /**
   * Run WAL checkpoints on a read-write connection in a worker thread, so
   * copying pages into the database and syncing it never block the event loop.
   * Ignored for in-memory databases.
   */
  readonly checkpointWorker?: boolean | undefined;
}

/**
 * Set by `readOnly`. A top-level transaction started while it is true runs on
 * the reader worker when the client has one, and on the writer otherwise.
 */
const ReadOnly = Context.Reference<boolean>("@t3tools/shared/nodeSqliteClient/ReadOnly", {
  defaultValue: () => false,
});

/**
 * Marks the SQL in `effect` as read-only. Wrap the whole transaction, as in
 * `sql.withTransaction(reads).pipe(readOnly)`. Inside an open write
 * transaction the reads keep using the writer, and a write attempted on the
 * reader fails with "attempt to write a readonly database".
 */
export const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, ReadOnly, true);

/**
 * Which connection ran the SQL, and how long it waited for that connection's
 * lock. The wait is time queued behind other SQL, not time the event loop was
 * blocked.
 */
interface Acquired {
  readonly connection: "writer" | "reader";
  readonly lockWaitMs: number;
}

const annotateAcquired = (span: Tracer.AnySpan | undefined, acquired: Acquired | undefined) => {
  if (span?._tag !== "Span" || acquired === undefined) return;
  span.attribute("db.connection", acquired.connection);
  span.attribute("db.lock_wait_ms", acquired.lockWaitMs);
};

/**
 * Provided by the client's `withTransaction`. Effect acquires a transaction's
 * connection before it makes the `sql.transaction` span current, so the acquire
 * leaves its result here and the transaction body puts it on the span.
 */
const TransactionAcquire = Context.Reference<{ acquired?: Acquired } | undefined>(
  "@t3tools/shared/nodeSqliteClient/TransactionAcquire",
  { defaultValue: () => undefined },
);

export class UnsupportedNodeSqliteVersionError extends Schema.TaggedError<UnsupportedNodeSqliteVersionError>()(
  "UnsupportedNodeSqliteVersionError",
  {
    nodeVersion: Schema.String,
    requirement: Schema.String,
  },
) {
  override get message(): string {
    return `Node.js ${this.nodeVersion} is missing required node:sqlite APIs. Upgrade to ${this.requirement}.`;
  }
}

export class UnsupportedNodeSqliteOperationError extends Schema.TaggedError<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "Node SQLite does not support executeStream.";
  }
}

/**
 * Verify that the current Node.js version includes the `node:sqlite` APIs
 * used by `NodeSqliteClient` — specifically `StatementSync.columns()` (added
 * in Node 22.16.0 / 23.11.0).
 *
 * @see https://github.com/nodejs/node/pull/57490
 */
const checkNodeSqliteCompat = () => {
  const parts = process.versions.node.split(".").map(Number);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const supported = (major === 22 && minor >= 16) || (major === 23 && minor >= 11) || major >= 24;

  if (!supported) {
    return Effect.die(
      new UnsupportedNodeSqliteVersionError({
        nodeVersion: process.versions.node,
        requirement: "Node.js >=22.16, >=23.11, or >=24",
      }),
    );
  }
  return Effect.void;
};

/**
 * `node:sqlite` reports the SQLite result code as `errcode`, while
 * `classifySqliteError` reads `errno`. Copy it across so busy, locked and
 * constraint failures get their own reasons instead of `UnknownError`.
 */
const classifyError = (cause: unknown, message: string, operation: string) => {
  if (
    Predicate.hasProperty(cause, "errcode") &&
    typeof cause.errcode === "number" &&
    !Predicate.hasProperty(cause, "errno")
  ) {
    Object.assign(cause, { errno: cause.errcode });
  }
  return classifySqliteError(cause, { message, operation });
};

/**
 * SQLite keeps its copy of a statement's text and blob parameters until the
 * statement is bound again or finalized, and `node:sqlite` cannot clear them.
 * A cached statement would hold its last payload for as long as it stays
 * cached, so executions binding more than this many string code units and
 * blob bytes, or a named parameter behind a getter, get a throwaway statement
 * instead.
 */
const LARGE_BINDING_SIZE = 64 * 1024;

// `node:sqlite` binds buffer views as blobs, but not raw ArrayBuffers.
const isBlob = (value: unknown): value is ArrayBufferView => ArrayBuffer.isView(value);

const bindingSize = (value: unknown): number => {
  if (typeof value === "string") {
    return value.length;
  }
  return isBlob(value) ? value.byteLength : 0;
};

/** A synchronous statement this slow blocked the event loop worth naming. */
export const SLOW_STATEMENT_MS = 250;

/** The slowest blocking statement since the last take: time and redacted text. */
export interface SlowStatement {
  readonly ms: number;
  readonly sql: string;
}

let slowestStatement: SlowStatement | undefined;

/**
 * Statement text safe to record: whitespace collapsed, string literals and
 * numbers over 3 digits replaced by `?`, at most 160 characters. Statements
 * bind their values, so this only guards against values inlined in SQL.
 */
export const redactStatement = (sql: string): string =>
  sql
    .replace(/\s+/g, " ")
    .trim()
    // An unterminated literal runs to the end, so a cut never leaks its tail.
    .replace(/'(?:[^']|'')*(?:'|$)/g, "?")
    .replace(/\b\d{4,}(?:\.\d+)?\b/g, "?")
    .slice(0, 160);

/**
 * Records a main-thread statement's wall time. Allocates only for a statement
 * slower than SLOW_STATEMENT_MS and slower than the one already held.
 */
export const noteStatementTime = (statement: { readonly sourceSQL: string }, ms: number) => {
  if (ms < SLOW_STATEMENT_MS || (slowestStatement !== undefined && ms <= slowestStatement.ms))
    return;
  slowestStatement = { ms, sql: redactStatement(statement.sourceSQL) };
};

/**
 * Hands over the slowest statement that ran on the main thread since the
 * previous call, so the event loop monitor can name the query behind a stall.
 */
export const takeSlowestStatement = (): SlowStatement | undefined => {
  const taken = slowestStatement;
  slowestStatement = undefined;
  return taken;
};

const hasLargeBinding = (params: ReadonlyArray<unknown>): boolean => {
  try {
    let size = 0;
    for (const param of params) {
      if (
        (typeof param === "object" || typeof param === "function") &&
        param !== null &&
        !isBlob(param)
      ) {
        // `node:sqlite` takes named parameters as one object, callable or not.
        // Read data properties only: calling a getter here would run it twice.
        for (const property of Object.values(Object.getOwnPropertyDescriptors(param))) {
          if (!property.enumerable) continue;
          if (!("value" in property)) return true;
          size += bindingSize(property.value);
        }
      } else {
        size += bindingSize(param);
      }
    }
    return size > LARGE_BINDING_SIZE;
  } catch {
    // A parameter that cannot be measured is left for the statement to report.
    return true;
  }
};

// Evaluated source instead of a worker file, so the reader also starts from
// bundles and single-executable builds that have no module file on disk.
const readerWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
let db;
try {
  // A read-only open cannot be undone by SQL, unlike PRAGMA query_only.
  const next = new DatabaseSync(workerData.filename, {
    readOnly: true,
    allowExtension: workerData.allowExtension,
  });
  next.exec("PRAGMA busy_timeout = 5000;");
  // Without WAL a reader's shared lock blocks the writer's commits, so refuse.
  const mode = String(next.prepare("PRAGMA journal_mode").get().journal_mode).toLowerCase();
  if (mode !== "wal") throw new Error("database uses journal_mode " + mode + ", not wal");
  db = next;
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  parentPort.postMessage({ type: "unavailable", message: String(error && error.message ? error.message : error) });
}
const statements = new Map();
const prepare = (sql, cached) => {
  if (!cached) return db.prepare(sql);
  let statement = statements.get(sql);
  if (statement === undefined) {
    statement = db.prepare(sql);
    if (statements.size >= workerData.prepareCacheSize) statements.delete(statements.keys().next().value);
  } else {
    statements.delete(sql);
  }
  statements.set(sql, statement);
  return statement;
};
parentPort.on("message", ({ id, sql, params, cached, values, raw, safeIntegers }) => {
  let operation = "open";
  try {
    if (db === undefined) throw new Error("database reader is unavailable");
    operation = "prepare";
    const statement = prepare(sql, cached);
    operation = "execute";
    statement.setReadBigInts(safeIntegers);
    if (statement.columns().length > 0) {
      statement.setReturnArrays(values);
      parentPort.postMessage({ id, rows: statement.all(...params) });
    } else {
      const result = statement.run(...params);
      parentPort.postMessage({ id, rows: raw ? result : [] });
    }
  } catch (error) {
    parentPort.postMessage({
      id,
      error: {
        operation,
        message: String(error && error.message ? error.message : error),
        code: error && error.code,
        errcode: error && error.errcode,
        errstr: error && error.errstr,
      },
    });
  }
});
`;

interface ReaderRequest {
  readonly sql: string;
  readonly params: ReadonlyArray<unknown>;
  readonly cached: boolean;
  readonly values: boolean;
  readonly raw: boolean;
}

type ReaderStartup =
  | { readonly type: "ready" }
  | { readonly type: "unavailable"; readonly message: string };

type ReaderReply =
  | { readonly id: number; readonly rows: ReadonlyArray<any> }
  | {
      readonly id: number;
      readonly error: {
        readonly operation: "open" | "prepare" | "execute";
        readonly message: string;
        readonly code?: unknown;
        readonly errcode?: unknown;
        readonly errstr?: unknown;
      };
    };

const readerFailureMessages = {
  open: "Failed to open database",
  prepare: "Failed to prepare statement",
  execute: "Failed to execute statement",
} as const;

const failed = (cause: unknown, message: string, operation: string) =>
  new SqlError({ reason: classifyError(cause, message, operation) });

// COMMIT, ROLLBACK and ROLLBACK TO SAVEPOINT. On a reader they change nothing,
// so they succeed once the worker is gone instead of failing the cleanup.
const endsReadTransaction = (sql: string) => /^\s*ROLLBACK\b|^\s*COMMIT\b/i.test(sql);

/**
 * One connection's lock, taken in arrival order. Effect's Semaphore wakes a
 * waiter on a later tick, so a fiber that frees it and reads again at once
 * takes it first, and a loop of reads kept every queued read waiting until the
 * loop ended. Here a free lock goes to the oldest waiter.
 */
interface ConnectionLock {
  /** Takes the lock when it is free and nobody is waiting for it. */
  readonly takeIfAvailable: () => boolean;
  /**
   * Waits for the lock behind earlier waiters, then takes it. Run it where a
   * taken lock cannot be interrupted, with `restore` for the wait alone.
   */
  readonly take: (
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<void>;
  readonly release: Effect.Effect<void>;
}

const makeConnectionLock = (): ConnectionLock => {
  let held = false;
  const waiting: Array<{ wake: () => void }> = [];
  const wakeFirst = () => {
    if (!held) waiting[0]?.wake();
  };
  const leave = (waiter: { wake: () => void }) => {
    const index = waiting.indexOf(waiter);
    if (index === -1) return;
    waiting.splice(index, 1);
    if (index === 0) wakeFirst();
  };
  const takeIfAvailable = () => {
    if (held || waiting.length > 0) return false;
    held = true;
    return true;
  };
  const take: ConnectionLock["take"] = (restore) =>
    Effect.suspend(() => {
      if (takeIfAvailable()) return Effect.void;
      const waiter = { wake: () => {} };
      waiting.push(waiter);
      const turn = Effect.callback<void>((resume) => {
        if (!held && waiting[0] === waiter) return resume(Effect.void);
        waiter.wake = () => resume(Effect.void);
        return Effect.sync(() => {
          waiter.wake = () => {};
        });
      });
      // Only the wait is interruptible; the lock is taken after it, so an
      // interrupted waiter only leaves the line and passes the turn on.
      const takeTurn: Effect.Effect<void> = Effect.flatMap(restore(turn), () => {
        if (held || waiting[0] !== waiter) return takeTurn;
        waiting.shift();
        held = true;
        return Effect.void;
      });
      return takeTurn.pipe(Effect.onInterrupt(() => Effect.sync(() => leave(waiter))));
    });
  return {
    takeIfAvailable,
    take,
    release: Effect.sync(() => {
      held = false;
      wakeFirst();
    }),
  };
};

const DEFAULT_READER_POOL_SIZE = 3;

interface ReaderSlotWorker {
  readonly worker: NodeWorkerThreads.Worker;
  readonly connection: Connection;
  /** Started while no worker had shown that the database supports WAL readers. */
  readonly verifying: boolean;
  /** Resolves once startup is decided: true when this worker serves reads. */
  readonly settled: Promise<boolean>;
  phase: "starting" | "ready" | "retired";
}

interface ReaderSlot {
  held: boolean;
  instance: ReaderSlotWorker | undefined;
}

interface ReaderLease {
  readonly connection: Connection;
  readonly release: Effect.Effect<void>;
}

/**
 * Pool of read-only WAL worker connections, taken in FIFO arrival order. The
 * first worker verifies that the database supports WAL readers; until one has,
 * only that one starts, so a database that cannot use them falls back to the
 * writer after one attempt and one warning. Extra workers (up to
 * `readerPoolSize`) start only when every ready worker is busy.
 *
 * Every worker's startup is settled in one place, with the startup deadline: a
 * worker that reports unavailable, misses the deadline or exits is terminated
 * and its slot cleared. When no worker is ready or starting and reads are
 * queued, the pool starts one for them; if that fails, the reader turns off
 * for the life of the client and every queued read uses the writer.
 *
 * Each worker gets its own `Connection`, so a transaction stays on the worker
 * it began on: once that worker exits, its statements fail rather than
 * silently continuing outside the transaction on a replacement.
 */
const makeReaderPool = Effect.fnUntraced(function* (options: SqliteClientConfig) {
  const poolSize = Math.max(1, Math.floor(options.readerPoolSize ?? DEFAULT_READER_POOL_SIZE));
  const slots: Array<ReaderSlot> = Array.from({ length: poolSize }, () => ({
    held: false,
    instance: undefined,
  }));
  const waiting: Array<{ wake: () => void }> = [];
  const startupTimeout = Duration.fromInputUnsafe(
    options.readerStartupTimeout ?? Duration.seconds(10),
  );
  // Worker events arrive outside any fiber; this keeps the client's clock and loggers.
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const clock = Context.get(context, Clock.Clock);
  let unavailable = false;
  let closed = false;
  let verifiedReady = false;
  // After an extra worker fails to start, contention does not respawn one at once.
  let extraStartsBlockedUntil = Number.NEGATIVE_INFINITY;
  let nextRequestId = 0;

  const pickReadyIdleSlot = (): ReaderSlot | undefined =>
    slots.find((slot) => !slot.held && slot.instance?.phase === "ready");
  const isStarting = () => slots.some((slot) => slot.instance?.phase === "starting");
  const hasLiveWorker = () => slots.some((slot) => slot.instance !== undefined);
  const wakeFirst = () => {
    if (pickReadyIdleSlot() !== undefined) waiting[0]?.wake();
  };
  // Woken waiters see the reader is off or closed and leave for the writer. A
  // copy, because a waiter that resumes at once removes itself from the line.
  const wakeAll = () => {
    for (const waiter of waiting.slice()) waiter.wake();
  };
  const remove = (waiter: { wake: () => void }) => {
    const index = waiting.indexOf(waiter);
    if (index !== -1) waiting.splice(index, 1);
    return index;
  };
  const leave = (waiter: { wake: () => void }) => {
    if (remove(waiter) === 0) wakeFirst();
  };
  const blockExtraStarts = () => {
    extraStartsBlockedUntil = clock.currentTimeMillisUnsafe() + Duration.toMillis(startupTimeout);
  };

  /** Terminates a worker and frees its slot for a new one. */
  const retire = (slot: ReaderSlot, instance: ReaderSlotWorker) => {
    instance.phase = "retired";
    if (slot.instance === instance) slot.instance = undefined;
    void instance.worker.terminate();
  };

  const turnOff = (reason: string) => {
    if (unavailable || closed) return;
    unavailable = true;
    verifiedReady = false;
    // Before the waiters resume, so the warning precedes their reads on the writer.
    runFork(
      Effect.logWarning("SQLite reader worker unavailable; reads use the main connection", {
        reason,
      }),
    );
    // Held workers finish their transaction first; release retires them.
    for (const slot of slots) {
      if (!slot.held && slot.instance !== undefined) retire(slot, slot.instance);
    }
    wakeAll();
  };

  const pickEmptySlot = (): ReaderSlot | undefined =>
    slots.find((slot) => !slot.held && slot.instance === undefined) ??
    slots.find((slot) => slot.instance === undefined);

  /**
   * With reads queued and no worker ready or starting, nothing would ever wake
   * them: start a worker that verifies the database again, or turn the reader off.
   */
  const ensureWorkerForWaiters = () => {
    if (closed || unavailable || hasLiveWorker()) return;
    verifiedReady = false;
    if (waiting.length === 0) return;
    const slot = pickEmptySlot();
    if (slot === undefined) return;
    try {
      startWorker(slot, true);
    } catch (cause) {
      turnOff(String(cause));
    }
  };

  const settleStartup = (
    slot: ReaderSlot,
    instance: ReaderSlotWorker,
    startup: Option.Option<ReaderStartup>,
    settle: (ready: boolean) => void,
  ) => {
    if (instance.phase !== "starting" || slot.instance !== instance) return settle(false);
    if (Option.isSome(startup) && startup.value.type === "ready") {
      if (closed || unavailable) {
        retire(slot, instance);
        return settle(false);
      }
      instance.phase = "ready";
      verifiedReady = true;
      settle(true);
      return wakeFirst();
    }
    // Unavailable, timed out, or exited before it was ready.
    retire(slot, instance);
    settle(false);
    if (closed) return;
    const reason =
      Option.isSome(startup) && startup.value.type === "unavailable"
        ? startup.value.message
        : `worker did not open the database within ${Duration.toMillis(startupTimeout)} ms`;
    if (instance.verifying || (!hasLiveWorker() && waiting.length > 0)) return turnOff(reason);
    blockExtraStarts();
    // Nobody is waiting: the next acquire verifies a new worker.
    if (!hasLiveWorker()) verifiedReady = false;
  };

  const startWorker = (slot: ReaderSlot, verifying: boolean): ReaderSlotWorker => {
    if (closed) throw new Error("database reader pool is closed");
    const worker = new NodeWorkerThreads.Worker(readerWorkerSource, {
      eval: true,
      workerData: {
        filename: options.filename,
        allowExtension: options.allowExtension ?? false,
        prepareCacheSize: options.prepareCacheSize ?? 200,
      },
    });
    let announce: (startup: ReaderStartup) => void = () => {};
    const started = new Promise<ReaderStartup>((resolve) => {
      announce = resolve;
    });
    let settle: (ready: boolean) => void = () => {};
    const settled = new Promise<boolean>((resolve) => {
      settle = resolve;
    });
    let stoppedMessage: string | undefined;
    const pending = new Map<
      number,
      { readonly endsTransaction: boolean; readonly resume: (reply: ReaderReply) => void }
    >();
    const stop = (message: string) => {
      stoppedMessage = message;
      // A worker still starting is settled as a failed startup by its watcher.
      announce({ type: "unavailable", message });
      if (instance.phase === "ready") {
        retire(slot, instance);
        ensureWorkerForWaiters();
      }
      for (const [id, request] of pending) {
        request.resume(
          request.endsTransaction
            ? { id, rows: [] }
            : { id, error: { operation: "execute", message } },
        );
      }
      pending.clear();
    };
    worker.on("message", (reply: ReaderReply | ReaderStartup) => {
      if ("type" in reply) {
        announce(reply);
        // An idle reader must not keep the process alive.
        if (pending.size === 0) worker.unref();
        return;
      }
      const request = pending.get(reply.id);
      if (request === undefined) return;
      pending.delete(reply.id);
      if (pending.size === 0) worker.unref();
      request.resume(reply);
    });
    worker.on("error", (cause) => stop(`Database reader failed: ${cause.message}`));
    worker.on("exit", (code) => stop(`Database reader exited with code ${code}`));

    const request = (input: ReaderRequest) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const endsTransaction = endsReadTransaction(input.sql);
        if (stoppedMessage !== undefined) {
          return endsTransaction
            ? Effect.succeed([])
            : Effect.fail(
                failed(new Error(stoppedMessage), readerFailureMessages.execute, "execute"),
              );
        }
        const safeIntegers = Boolean(Context.get(fiber.context, Client.SafeIntegers));
        return Effect.callback<ReadonlyArray<any>, SqlError>((resume) => {
          const id = nextRequestId++;
          pending.set(id, {
            endsTransaction,
            resume: (reply) => {
              if ("rows" in reply) {
                resume(Effect.succeed(reply.rows));
                return;
              }
              const { operation, message, ...codes } = reply.error;
              resume(
                Effect.fail(
                  failed(
                    Object.assign(new Error(message), codes),
                    readerFailureMessages[operation],
                    operation,
                  ),
                ),
              );
            },
          });
          if (pending.size === 1) worker.ref();
          // The worker's statement cache would pin large parameters the same way.
          const cached = input.cached && !hasLargeBinding(input.params);
          // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
          worker.postMessage({ id, safeIntegers, ...input, cached });
        });
      });

    const connection = identity<Connection>({
      execute(sql, params, rowTransform) {
        const effect = request({ sql, params, cached: true, values: false, raw: false });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeRaw(sql, params) {
        return request({ sql, params, cached: true, values: false, raw: true });
      },
      executeValues(sql, params) {
        return request({ sql, params, cached: true, values: true, raw: false });
      },
      executeValuesUnprepared(sql, params) {
        return request({ sql, params: params ?? [], cached: false, values: true, raw: false });
      },
      executeUnprepared(sql, params, rowTransform) {
        // A read-only connection rejects BEGIN IMMEDIATE and BEGIN EXCLUSIVE,
        // and a deferred BEGIN is all a read snapshot needs.
        const statement = /^\s*BEGIN\b/i.test(sql) ? "BEGIN" : sql;
        const effect = request({
          sql: statement,
          params: params ?? [],
          cached: false,
          values: false,
          raw: false,
        });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
    const instance: ReaderSlotWorker = {
      worker,
      connection,
      verifying,
      settled,
      phase: "starting",
    };
    slot.instance = instance;
    // The deadline runs whether or not anyone waits, so a stuck start never
    // holds its slot, or blocks other starts, for good.
    runFork(
      Effect.timeoutOption(
        Effect.promise(() => started),
        startupTimeout,
      ).pipe(
        Effect.flatMap((startup) =>
          Effect.sync(() => settleStartup(slot, instance, startup, settle)),
        ),
      ),
    );
    return instance;
  };

  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      closed = true;
      const workers = slots.flatMap((slot) => {
        const instance = slot.instance;
        if (instance === undefined) return [];
        instance.phase = "retired";
        slot.instance = undefined;
        return [instance.worker];
      });
      wakeAll();
      await Promise.all(workers.map((worker) => worker.terminate()));
    }),
  );

  /**
   * Whether reads can use the pool, waiting for a worker to verify WAL readers
   * when none has yet (concurrent first callers share one start). False means
   * reads use the writer.
   */
  const ensureAvailable: Effect.Effect<boolean> = Effect.suspend(() => {
    if (unavailable || closed) return Effect.succeed(false);
    if (verifiedReady) return Effect.succeed(true);
    let verifier = slots.find(
      (slot) => slot.instance?.verifying === true && slot.instance.phase === "starting",
    )?.instance;
    if (verifier === undefined) {
      const slot = pickEmptySlot();
      if (slot === undefined) return Effect.succeed(false);
      try {
        verifier = startWorker(slot, true);
      } catch (cause) {
        turnOff(String(cause));
        return Effect.succeed(false);
      }
    }
    const { settled } = verifier;
    // SqlClient acquires transaction connections uninterruptibly. Waiting for the
    // worker happens before any lock is taken, so let a cancelled request leave.
    return Effect.interruptible(Effect.promise(() => settled));
  });

  const maybeWarmExtraSlot = () => {
    if (closed || unavailable || !verifiedReady || isStarting()) return;
    if (clock.currentTimeMillisUnsafe() < extraStartsBlockedUntil) return;
    const emptySlot = slots.find((slot) => !slot.held && slot.instance === undefined);
    if (emptySlot === undefined) return;
    try {
      startWorker(emptySlot, false);
    } catch {
      // Existing ready workers keep serving reads.
      blockExtraStarts();
    }
  };

  const lease = (slot: ReaderSlot, instance: ReaderSlotWorker): ReaderLease => {
    slot.held = true;
    let released = false;
    return {
      connection: instance.connection,
      release: Effect.sync(() => {
        if (released) return;
        released = true;
        slot.held = false;
        if ((unavailable || closed) && slot.instance === instance) retire(slot, instance);
        wakeFirst();
      }),
    };
  };

  /** Takes a ready idle reader when nobody is waiting ahead of this caller. */
  const takeSlotIfAvailable = (): ReaderLease | undefined => {
    if (unavailable || closed || waiting.length > 0) return undefined;
    const slot = pickReadyIdleSlot();
    return slot?.instance === undefined ? undefined : lease(slot, slot.instance);
  };

  /**
   * Waits in FIFO order for a ready reader, starting an extra worker when every
   * ready one is busy, so the caller gets whichever frees first: a warm worker
   * finishing its read, or the new one. Undefined when the reader turned off or
   * closed while waiting: the caller uses the writer.
   */
  const takeSlot = (
    restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
  ): Effect.Effect<ReaderLease | undefined> =>
    Effect.suspend(() => {
      if (unavailable || closed) return Effect.succeed(undefined);
      const immediate = takeSlotIfAvailable();
      if (immediate !== undefined) return Effect.succeed(immediate);
      maybeWarmExtraSlot();
      const waiter = { wake: () => {} };
      waiting.push(waiter);
      ensureWorkerForWaiters();
      const turn = Effect.callback<void>((resume) => {
        if (unavailable || closed || (waiting[0] === waiter && pickReadyIdleSlot() !== undefined)) {
          return resume(Effect.void);
        }
        waiter.wake = () => resume(Effect.void);
        return Effect.sync(() => {
          waiter.wake = () => {};
        });
      });
      const takeTurn: Effect.Effect<ReaderLease | undefined> = Effect.flatMap(restore(turn), () => {
        if (unavailable || closed) {
          remove(waiter);
          return Effect.succeed(undefined);
        }
        if (waiting[0] !== waiter) return takeTurn;
        const slot = pickReadyIdleSlot();
        if (slot?.instance === undefined) return takeTurn;
        waiting.shift();
        const taken = lease(slot, slot.instance);
        // Another ready slot may also be free for the next queued waiter.
        wakeFirst();
        return Effect.succeed(taken);
      });
      return takeTurn.pipe(Effect.onInterrupt(() => Effect.sync(() => leave(waiter))));
    });

  return {
    ensureAvailable,
    takeSlotIfAvailable,
    takeSlot,
  };
});

// SQLite's default wal_autocheckpoint, in WAL frames (pages).
const CHECKPOINT_FRAMES = 1000;
// While the worker runs, the writer still checkpoints a WAL this long. Writes
// with no pause leave the worker behind, and the WAL can only restart once
// every frame is checkpointed, so this keeps the file from growing forever.
const WRITER_BACKSTOP_FRAMES = 10 * CHECKPOINT_FRAMES;
// How long writes must pause before the worker checkpoints the rest of a long WAL.
const CHECKPOINT_IDLE_MS = 100;

// Each message asks the worker to checkpoint if CHECKPOINT_FRAMES frames are
// waiting, and it replies with the same message when done. Once writes pause, it also checkpoints the
// frames that arrived during its last checkpoint, so the writer can restart the
// WAL. NOOP only counts frames. SQLite before 3.51 reads NOOP as PASSIVE and
// would checkpoint on every request, so the worker refuses to start there and
// the writer keeps checkpointing.
const checkpointWorkerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.filename);
const version = db.prepare("SELECT sqlite_version() AS version").get().version;
const [major, minor] = version.split(".").map(Number);
if (major < 3 || (major === 3 && minor < 51)) throw new Error("SQLite " + version + " has no NOOP checkpoint");
// macOS fsync() does not flush the drive cache; F_FULLFSYNC does. Other platforms ignore this.
db.exec("PRAGMA checkpoint_fullfsync = ON;");
const frames = db.prepare("PRAGMA wal_checkpoint(NOOP)");
const checkpoint = db.prepare("PRAGMA wal_checkpoint(PASSIVE)");
const finish = () => {
  const { log, checkpointed } = frames.get();
  if (log >= workerData.frames && checkpointed < log) checkpoint.get();
};
let idle;
parentPort.on("message", (request) => {
  const { log, checkpointed } = frames.get();
  if (log - checkpointed >= workerData.frames) checkpoint.get();
  clearTimeout(idle);
  idle = setTimeout(finish, workerData.idleMs);
  parentPort.postMessage(request);
});
`;

/**
 * Moves the writer's WAL checkpoints to a worker. Call the returned function
 * after each statement on the writer. While the worker runs, the writer only
 * checkpoints at WRITER_BACKSTOP_FRAMES. If the worker cannot start, fails or
 * exits, the writer goes back to SQLite's default and one warning says why.
 */
const startCheckpointWorker = Effect.fnUntraced(function* (
  filename: string,
  writer: NodeSqlite.DatabaseSync,
) {
  const warn = (reason: string) =>
    Effect.logWarning(
      "SQLite checkpoint worker unavailable; checkpoints run on the main connection",
      { reason },
    );
  let worker: NodeWorkerThreads.Worker;
  try {
    worker = new NodeWorkerThreads.Worker(checkpointWorkerSource, {
      eval: true,
      workerData: { filename, frames: CHECKPOINT_FRAMES, idleMs: CHECKPOINT_IDLE_MS },
    });
  } catch (cause) {
    // No worker threads here: the writer keeps checkpointing.
    yield* warn(String(cause));
    return undefined;
  }
  writer.exec(`PRAGMA wal_autocheckpoint = ${WRITER_BACKSTOP_FRAMES};`);
  // Worker events arrive outside any fiber; this keeps the client's loggers.
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  let stopped = false;
  let checking = false;
  let checkAgain = false;
  const handBack = (reason: string) => {
    if (stopped) return;
    stopped = true;
    try {
      writer.exec(`PRAGMA wal_autocheckpoint = ${CHECKPOINT_FRAMES};`);
    } catch {
      // The writer is already closed.
    }
    runFork(warn(reason));
  };
  // A worker that throws, such as on SQLite before 3.51, emits "error" before "exit".
  worker.on("error", (cause) => handBack(cause.message));
  worker.on("exit", (code) => handBack(`exited with code ${code}`));
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      // A normal shutdown: the writer closes next, so there is nothing to hand back or report.
      stopped = true;
      return worker.terminate();
    }),
  );

  // At most one request is in flight. A statement that runs during it asks for
  // one more check, so the frames of a last commit before idle still get one.
  const check = () => {
    if (stopped) return;
    if (checking) {
      checkAgain = true;
      return;
    }
    checking = true;
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a target origin.
    worker.postMessage(null);
  };
  worker.on("message", () => {
    checking = false;
    if (checkAgain) {
      checkAgain = false;
      check();
    }
  });
  // After the listeners: adding a "message" listener refs the worker again.
  // A checkpoint in progress must not keep the process alive.
  worker.unref();
  return check;
});

const make = Effect.fn("makeWithDatabase")(function* (
  options: SqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  yield* checkNodeSqliteCompat();

  const compiler = Statement.makeCompilerSqlite(options.transformQueryNames);
  const isFileDatabase = options.filename !== ":memory:" && options.filename !== "";
  const transformRows = options.transformResultNames
    ? Statement.defaultTransforms(options.transformResultNames).array
    : undefined;

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const db = yield* Effect.try({
      try: () =>
        new NodeSqlite.DatabaseSync(options.filename, {
          readOnly: options.readonly ?? false,
          allowExtension: options.allowExtension ?? false,
        }),
      catch: (cause) =>
        new SqlError({
          reason: classifyError(cause, "Failed to open database", "open"),
        }),
    });
    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => db.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to close database", "close"),
          }),
      }).pipe(Effect.orDie),
    );
    // Started after the close finalizer, so the worker stops before the writer closes.
    const checkpoint =
      options.checkpointWorker && isFileDatabase
        ? yield* startCheckpointWorker(options.filename, db)
        : undefined;

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }
      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => db.prepare(sql),
        catch: (cause) =>
          new SqlError({
            reason: classifyError(cause, "Failed to prepare statement", "prepare"),
          }),
      });

    const prepareCache = yield* Cache.makeWith(prepare, {
      capacity: options.prepareCacheSize ?? 200,
      // A transient prepare failure must not outlive the lock or missing schema.
      timeToLive: (exit) =>
        Exit.isSuccess(exit) ? (options.prepareCacheTTL ?? Duration.minutes(10)) : Duration.zero,
    });

    const statementFor = (sql: string, params: ReadonlyArray<unknown>) =>
      hasLargeBinding(params) ? prepare(sql) : Cache.get(prepareCache, sql);

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      raw: boolean,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        const startedAt = performance.now();
        try {
          statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
          if (hasRows(statement)) {
            const rows = statement.all(...(params as any));
            checkpoint?.();
            return Effect.succeed(rows);
          }
          const result = statement.run(...(params as any));
          checkpoint?.();
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifyError(cause, "Failed to execute statement", "execute"),
            }),
          );
        } finally {
          // Failures count too: a busy timeout blocks the loop before it throws.
          noteStatementTime(statement, performance.now() - startedAt);
        }
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(statementFor(sql, params), (s) => runStatement(s, params, raw));

    const runStatementValues = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
    ) =>
      Effect.acquireUseRelease(
        Effect.succeed(statement),
        (statement) =>
          Effect.try({
            try: () => {
              statement.setReadBigInts(
                Boolean(Context.get(Fiber.getCurrent()!.context, Client.SafeIntegers)),
              );
              const startedAt = performance.now();
              try {
                if (hasRows(statement)) {
                  statement.setReturnArrays(true);
                  // Safe to cast to array after we've setReturnArrays(true)
                  const rows = statement.all(...(params as any)) as unknown as ReadonlyArray<
                    ReadonlyArray<unknown>
                  >;
                  checkpoint?.();
                  return rows;
                }
                statement.run(...(params as any));
                checkpoint?.();
                return [];
              } finally {
                noteStatementTime(statement, performance.now() - startedAt);
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(cause, "Failed to execute statement", "execute"),
              }),
          }),
        (statement) =>
          Effect.try({
            try: () => {
              if (hasRows(statement)) {
                statement.setReturnArrays(false);
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyError(
                  cause,
                  "Failed to reset statement result mode",
                  "resetResultMode",
                ),
              }),
          }).pipe(Effect.orDie),
      );

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(statementFor(sql, params), (statement) =>
        runStatementValues(statement, params),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatementValues(statement, params ?? []),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = Effect.suspend(() => {
          // SQLITE_FULL can roll back the transaction itself. Effect still
          // runs its rollback finalizer; a second ROLLBACK would replace the
          // original storage error with a defect and prevent safe retries.
          // `=== false`, not falsy: a runtime without `isTransaction` must still roll back.
          if (/^\s*ROLLBACK\b/i.test(sql) && db.isTransaction === false) {
            return Effect.succeed([]);
          }
          return prepare(sql).pipe(
            Effect.flatMap((statement) => runStatement(statement, params ?? [], false)),
            Effect.catchTags({
              SqlError: (error) =>
                // A failed COMMIT can leave the transaction open. Clean it up
                // while this connection is still exclusively owned, before a
                // caller retries or the next writer acquires it.
                // The COMMIT's own error is the one to report, whatever the cleanup does.
                /^\s*COMMIT\b/i.test(sql) && db.isTransaction === true
                  ? run("ROLLBACK", []).pipe(Effect.ignore, Effect.andThen(Effect.fail(error)))
                  : Effect.fail(error),
            }),
          );
        });
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const connection = yield* makeConnection;
  const readerPool =
    options.readerWorker && isFileDatabase ? yield* makeReaderPool(options) : undefined;

  const writer = { name: "writer" as const, lock: makeConnectionLock(), connection };

  const acquired = (name: Acquired["connection"], clock: Clock.Clock, start: bigint): Acquired => ({
    connection: name,
    lockWaitMs: Number((clock.monotonicTimeNanosUnsafe() - start) / 1000n) / 1000,
  });

  const acquireWriterStatement = Effect.withFiber<Connection>((fiber) => {
    if (!fiber.getRef(References.TracerEnabled)) {
      return Effect.uninterruptibleMask((restore) =>
        Effect.as(
          Effect.andThen(writer.lock.take(restore), writer.lock.release),
          writer.connection,
        ),
      );
    }
    const clock = fiber.getRef(Clock.Clock);
    const start = clock.monotonicTimeNanosUnsafe();
    const span = fiber.getRef(Statement.SpanPropagationEnabled)
      ? Context.getOrUndefined(fiber.context, Tracer.ParentSpan)
      : undefined;
    const use = Effect.sync(() => {
      annotateAcquired(span, acquired(writer.name, clock, start));
      return writer.connection;
    });
    return Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() =>
        writer.lock.takeIfAvailable()
          ? Effect.void
          : writer.lock.take(restore).pipe(
              Effect.withSpan("sqlite.statement.wait", {
                attributes: { "db.connection": writer.name },
              }),
            ),
      ).pipe(Effect.andThen(Effect.ensuring(use, writer.lock.release))),
    );
  });

  const acquireWriterTransaction = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    const clock = fiber.getRef(Clock.Clock);
    const start = clock.monotonicTimeNanosUnsafe();
    const acquire = Effect.suspend(() =>
      writer.lock.takeIfAvailable()
        ? Effect.void
        : writer.lock.take(restore).pipe(
            Effect.withSpan("sqlite.transaction.wait", {
              attributes: { "db.connection": writer.name },
            }),
          ),
    );
    return Effect.as(
      Effect.tap(acquire, () => {
        const pending = fiber.getRef(TransactionAcquire);
        if (pending !== undefined) pending.acquired = acquired(writer.name, clock, start);
        return Scope.addFinalizer(scope, writer.lock.release);
      }),
      writer.connection,
    );
  });

  // A statement holds a slot only while it waits out open transactions. An
  // undefined connection from the reader means it turned off: use the writer.
  const acquirer = Effect.withFiber<Connection>((fiber) => {
    if (readerPool === undefined || !Context.get(fiber.context, ReadOnly)) {
      return acquireWriterStatement;
    }
    return Effect.flatMap(readerPool.ensureAvailable, (available) => {
      if (!available) return acquireWriterStatement;
      if (!fiber.getRef(References.TracerEnabled)) {
        return Effect.uninterruptibleMask((restore) =>
          Effect.flatMap(readerPool.takeSlot(restore), (lease) =>
            lease === undefined ? Effect.undefined : Effect.as(lease.release, lease.connection),
          ),
        ).pipe(
          Effect.flatMap((connection) =>
            connection === undefined ? acquireWriterStatement : Effect.succeed(connection),
          ),
        );
      }
      const clock = fiber.getRef(Clock.Clock);
      const start = clock.monotonicTimeNanosUnsafe();
      const span = fiber.getRef(Statement.SpanPropagationEnabled)
        ? Context.getOrUndefined(fiber.context, Tracer.ParentSpan)
        : undefined;
      return Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() => {
          const immediate = readerPool.takeSlotIfAvailable();
          return immediate !== undefined
            ? Effect.succeed(immediate)
            : readerPool.takeSlot(restore).pipe(
                Effect.withSpan("sqlite.statement.wait", {
                  attributes: { "db.connection": "reader" },
                }),
              );
        }).pipe(
          Effect.flatMap((lease) => {
            if (lease === undefined) return Effect.undefined;
            const use = Effect.sync(() => {
              annotateAcquired(span, acquired("reader", clock, start));
              return lease.connection;
            });
            return Effect.ensuring(use, lease.release);
          }),
        ),
      ).pipe(
        Effect.flatMap((connection) =>
          connection === undefined ? acquireWriterStatement : Effect.succeed(connection),
        ),
      );
    });
  });

  const transactionAcquirer = Effect.withFiber<Connection, never, Scope.Scope>((fiber) => {
    if (readerPool === undefined || !Context.get(fiber.context, ReadOnly)) {
      return acquireWriterTransaction;
    }
    return Effect.flatMap(readerPool.ensureAvailable, (available) => {
      if (!available) return acquireWriterTransaction;
      return Effect.uninterruptibleMask((restore) => {
        const scope = Context.getUnsafe(fiber.context, Scope.Scope);
        const clock = fiber.getRef(Clock.Clock);
        const start = clock.monotonicTimeNanosUnsafe();
        const acquireSlot = Effect.suspend(() => {
          const immediate = readerPool.takeSlotIfAvailable();
          return immediate !== undefined
            ? Effect.succeed(immediate)
            : readerPool.takeSlot(restore).pipe(
                Effect.withSpan("sqlite.transaction.wait", {
                  attributes: { "db.connection": "reader" },
                }),
              );
        });
        return acquireSlot.pipe(
          Effect.flatMap((lease) => {
            if (lease === undefined) return acquireWriterTransaction;
            const pending = fiber.getRef(TransactionAcquire);
            if (pending !== undefined) pending.acquired = acquired("reader", clock, start);
            return Effect.as(Scope.addFinalizer(scope, lease.release), lease.connection);
          }),
        );
      });
    });
  });

  const client = yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    // A deferred BEGIN only takes the write lock at the first write. If another
    // process commits after this transaction's first read, that write fails at
    // once with SQLITE_BUSY_SNAPSHOT, which busy_timeout cannot wait out. Taking
    // the lock up front makes it wait instead, at the cost of serializing
    // read-only transactions behind other processes' writers. Read-only
    // connections cannot write, so they keep the deferred BEGIN.
    beginTransaction: options.readonly === true ? "BEGIN" : "BEGIN IMMEDIATE",
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [ATTR_DB_SYSTEM_NAME, "sqlite"],
    ],
    transformRows,
  });
  const withTransaction = client.withTransaction;
  return Object.assign(client, {
    // Each run gets its own holder, so a reused transaction Effect never
    // carries an earlier run's attributes.
    withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.suspend(() => {
        const pending: { acquired?: Acquired } = {};
        // The body runs with the `sql.transaction` span current. A nested
        // transaction acquires nothing, so its span gets no attributes.
        const body = Effect.withFiber<A, E, R>((fiber) => {
          annotateAcquired(
            Context.getOrUndefined(fiber.context, Tracer.ParentSpan),
            pending.acquired,
          );
          return effect;
        });
        return withTransaction(body).pipe(Effect.provideService(TransactionAcquire, pending));
      }),
  });
});

export const layer = (config: SqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(config)).pipe(Layer.provide(Reactivity.layer));
