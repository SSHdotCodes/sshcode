import * as ExecutionResources from "../execution/ExecutionResources.ts";
import {
  MonitorError,
  type MonitorInfo,
  type MonitorStartInput,
  type OrchestrationV2Notification,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { publishAppMonitors } from "./appMonitorCounts.ts";
import * as DurableJobProcess from "./DurableJobProcess.ts";
import * as ErrorLoop from "./ErrorLoop.ts";
import { markJobLogDelivered, sweepCompletedJobLogs } from "./CompletedJobLogs.ts";
import * as WakeMatcher from "./WakeMatcher.ts";

import * as ServerConfig from "../config.ts";
import { darwinAgentCommand } from "../process/agentScope.ts";

export interface MonitorEvent {
  readonly monitorId: string;
  readonly threadId: ThreadId;
  readonly generation: number;
  readonly sequence: number;
  readonly durable?: boolean;
  /** A job that looks stuck: delivered at once, like its end. */
  readonly urgent?: boolean;
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
}

type EndReason = "stopped" | "timeout" | "runaway";

interface RunningMonitor {
  readonly info: MonitorInfo;
  readonly generation: number;
  readonly stop: Deferred.Deferred<EndReason>;
  readonly done: Deferred.Deferred<void, MonitorError>;
  readonly cwd: string;
  readonly shutdown?: Effect.Effect<void, MonitorError>;
}

/** How a thread whose monitors outlived a restart can take them back. */
export type MonitorRecoveryAccess = "ok" | "denied" | "gone" | "retry";

/**
 * A private journal in the state dir adopts durable jobs without relaunching,
 * relaunches restartable watchers, and reports ordinary watchers lost at restart.
 */
export class MonitorService extends Context.Service<
  MonitorService,
  {
    readonly start: (
      input: MonitorStartInput & {
        readonly threadId: ThreadId;
        readonly cwd: string;
        readonly requestNamespace: string;
      },
    ) => Effect.Effect<{ readonly monitorId: string; readonly logPath?: string }, MonitorError>;
    /**
     * Adopts recoverable durable jobs and relaunches `restartable` monitors whose
     * thread still allows them and wakes the others' threads with a notice.
     */
    readonly recover: (
      access: (threadId: ThreadId) => Effect.Effect<MonitorRecoveryAccess>,
    ) => Effect.Effect<void>;
    readonly stop: (threadId: ThreadId, monitorId: string) => Effect.Effect<boolean, MonitorError>;
    /** Cancels delivery too: user Stop must never wake the thread again. */
    readonly stopThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly list: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<MonitorInfo>>;
    readonly stream: (threadId: ThreadId) => Stream.Stream<ReadonlyArray<MonitorInfo>>;
    readonly events: Stream.Stream<MonitorEvent>;
    readonly hasOpenWork: (threadId: ThreadId) => boolean;
    /** Running or recoverable jobs keep their checkout, including a nested cwd. */
    readonly ownsCwd: (directory: string) => boolean;
    readonly acknowledge: (event: MonitorEvent) => Effect.Effect<void>;
    readonly settled: Stream.Stream<ThreadId>;
    readonly canDeliver: (event: Pick<MonitorEvent, "threadId" | "generation">) => boolean;
  }
>()("t3/monitors/MonitorService") {}

const MAX_TEXT = 8_000;
const MAX_LINES = 50;
const DURABLE_WAKE_DETAIL_LIMIT = 1_500;
const TRUNCATED_LINE = " [line truncated]";
const DEFAULT_TIMEOUT_MS = 3_600_000;
/** Hashes of reported lines a relaunched monitor skips; older ones may repeat. */
const MAX_DELIVERED_HASHES = 500;

const MonitorJournalEntry = Schema.Struct({
  monitorId: Schema.String,
  threadId: ThreadId,
  command: Schema.String,
  description: Schema.String,
  cwd: Schema.String,
  startedAt: Schema.Number,
  timeoutMs: Schema.NullOr(Schema.Number),
  persistent: Schema.Boolean,
  restartable: Schema.Boolean,
  silenceMs: Schema.NullOr(Schema.Number),
  /** The last notification sequence used; a relaunch continues after it, so its ids stay new. */
  sequence: Schema.Number,
  delivered: Schema.Array(Schema.String),
  job: Schema.optional(DurableJobProcess.DurableJob),
  wakeOn: Schema.optional(Schema.Union([Schema.String, Schema.Literal(false)])),
  requestKey: Schema.optional(Schema.String),
  fingerprint: Schema.optional(Schema.String),
  generation: Schema.optional(Schema.Number),
  stopRequested: Schema.optional(Schema.Boolean),
  expectMinutes: Schema.optional(Schema.Number),
  /** The overdue wake went out; a restart never repeats it. */
  overdue: Schema.optional(Schema.Boolean),
  errors: Schema.optional(Schema.Array(ErrorLoop.ErrorLoopEntry)),
  completion: Schema.optional(
    Schema.Struct({
      summary: Schema.String,
      detail: Schema.String,
      outcome: Schema.Literals(["completed", "failed", "cancelled"]),
    }),
  ),
});
type MonitorJournalEntry = typeof MonitorJournalEntry.Type;
const MonitorJournalFile = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), monitors: Schema.Array(MonitorJournalEntry) }),
);
const decodeJournal = Schema.decodeUnknownOption(MonitorJournalFile);
const encodeJournal = Schema.encodeSync(MonitorJournalFile);

const requestPart = (part: string) => `${part.length}:${part}`;

// Old durable receipts included the provider session between the thread and request id.
const restoreReceipt = (entry: MonitorJournalEntry): MonitorJournalEntry => {
  if (entry.job === undefined || entry.requestKey === undefined) return entry;
  const thread = requestPart(entry.threadId);
  const tail = entry.requestKey.slice(thread.length);
  const length = /^(\d+):/.exec(tail);
  if (length === null) return entry;
  const request = tail.slice(length[0].length + Number(length[1]));
  return request ? { ...entry, requestKey: thread + request } : entry;
};

/** A short, stable fingerprint of a reported line (FNV-1a plus length). */
const lineHash = (line: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < line.length; index++) {
    hash ^= line.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${line.length}:${hash.toString(16)}`;
};

const formatQuiet = (ms: number) =>
  ms % 3_600_000 === 0
    ? `${ms / 3_600_000} h`
    : ms >= 3_600_000
      ? `${Math.round(ms / 360_000) / 10} h`
      : `${Math.round(ms / 60_000)} min`;
/** Longer descriptions are accepted and shortened, so an agent never fails on a long label. */
const MAX_DESCRIPTION_LENGTH = 200;

const make = Effect.gen(function* () {
  const ownership = yield* ExecutionResources.ExecutionResources;
  const jobs = yield* DurableJobProcess.DurableJobProcess;
  const retryJobIo = <A>(effect: Effect.Effect<A, MonitorError>) =>
    effect.pipe(
      Effect.tapError((error) => Effect.logWarning("Durable job I/O failed; retrying", error)),
      Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 2 }))),
    );
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const environment = yield* HostProcess.Environment;
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Scope.Scope;
  const roster = yield* SubscriptionRef.make<ReadonlyArray<MonitorInfo>>([]);
  const events = yield* Queue.unbounded<MonitorEvent>();
  const running = new Map<string, RunningMonitor>();
  const startingCwds = new Map<symbol, { cwd: string; threadId: ThreadId }>();
  const pending = new Map<string, ThreadId>();
  const settled = yield* Queue.unbounded<ThreadId>();
  const eventKey = (event: Pick<MonitorEvent, "monitorId" | "sequence">) =>
    `${event.monitorId}:${event.sequence}`;
  const publishWatcherEvent = (
    entry: Pick<
      MonitorJournalEntry,
      "monitorId" | "threadId" | "description" | "generation" | "sequence"
    >,
    summary: string,
    detail: string,
    outcome: OrchestrationV2Notification["outcome"],
    urgent = false,
  ) =>
    Effect.gen(function* () {
      const { monitorId, threadId, description, generation = 0, sequence } = entry;
      const event: MonitorEvent = {
        monitorId,
        threadId,
        generation,
        sequence,
        ...(urgent ? { urgent } : {}),
        text: `Monitor "${description}" (${monitorId}): ${summary}${detail ? `\n${detail}` : ""}`,
        notification: {
          source: { kind: "monitor" },
          outcome,
          summary: `${description}: ${summary}`,
          ...(detail ? { detail } : {}),
        },
      };
      pending.set(eventKey(event), threadId);
      yield* Queue.offer(events, event);
    });
  // A monitor that outlived a restart counts until `recover` relaunches it or
  // reports it, so a delegated task waiting on it is not settled in between.
  const hasOpenWork = (threadId: ThreadId) =>
    [...startingCwds.values()].some((entry) => entry.threadId === threadId) ||
    [...running.values()].some((entry) => entry.info.threadId === threadId) ||
    [...pending.values()].some((id) => id === threadId) ||
    [...recoverable.values()].some((entry) => entry.threadId === threadId);
  const notifySettled = (threadId: ThreadId) =>
    hasOpenWork(threadId) ? Effect.void : Queue.offer(settled, threadId).pipe(Effect.asVoid);
  const generations = new Map<ThreadId, number>();
  const requests = new Map<
    string,
    { readonly fingerprint: string; readonly monitorId: string; readonly logPath?: string }
  >();
  const lock = yield* Semaphore.make(1);

  // Ordinary watchers use best-effort persistence; durable work starts only after a saved receipt.
  const serverConfig = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
  const pathService = yield* Path.Path;
  const stateDir = Option.isSome(serverConfig) ? serverConfig.value.stateDir : undefined;
  const journalPath =
    stateDir !== undefined && Option.isSome(fileSystem)
      ? pathService.join(stateDir, "monitors.json")
      : undefined;
  const journal = new Map<string, MonitorJournalEntry>();
  const journalLock = yield* Semaphore.make(1);
  const persistJournal = Effect.gen(function* () {
    if (journalPath === undefined || stateDir === undefined || Option.isNone(fileSystem)) return;
    const fs = fileSystem.value;
    const partial = `${journalPath}.partial`;
    yield* fs
      .makeDirectory(stateDir, { recursive: true })
      .pipe(
        Effect.andThen(
          fs.writeFileString(
            partial,
            encodeJournal({ version: 1, monitors: [...journal.values()] }),
            { mode: 0o600 },
          ),
        ),
        Effect.andThen(fs.chmod(partial, 0o600)),
        Effect.andThen(fs.rename(partial, journalPath)),
      );
  }).pipe(journalLock.withPermits(1));
  const writeJournal = persistJournal.pipe(
    Effect.timeoutOption("5 seconds"),
    Effect.asVoid,
    Effect.catchCause((cause) => Effect.logWarning("Could not save the monitor journal", cause)),
  );
  const journalPut = (entry: MonitorJournalEntry, required = false) =>
    journalPath === undefined
      ? Effect.void
      : Effect.suspend(() => {
          journal.set(entry.monitorId, entry);
          return required
            ? persistJournal.pipe(
                Effect.mapError((cause) => new MonitorError({ reason: "storage", cause })),
                Effect.timeoutOrElse({
                  duration: "5 seconds",
                  orElse: () => Effect.fail(new MonitorError({ reason: "storage" })),
                }),
              )
            : writeJournal;
        });
  const journalRemove = (monitorId: string) =>
    journalPath === undefined || !journal.has(monitorId)
      ? Effect.void
      : Effect.suspend(() => {
          journal.delete(monitorId);
          return writeJournal;
        });
  // Monitors the previous server left running, until `recover` takes them back.
  const recoverable = new Map<string, MonitorJournalEntry>();
  let journalUnavailable = false;
  if (journalPath !== undefined && Option.isSome(fileSystem)) {
    const saved = yield* fileSystem.value.readFileString(journalPath).pipe(
      Effect.map((text) => {
        const decoded = decodeJournal(text);
        journalUnavailable = Option.isNone(decoded);
        return decoded;
      }),
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(Option.none()),
      ),
      Effect.catch(() =>
        Effect.sync(() => {
          journalUnavailable = true;
          return Option.none();
        }),
      ),
    );
    if (Option.isSome(saved)) {
      for (const savedEntry of saved.value.monitors) {
        const entry = restoreReceipt(savedEntry);
        recoverable.set(entry.monitorId, entry);
        journal.set(entry.monitorId, entry);
        if (entry.generation !== undefined)
          generations.set(
            entry.threadId,
            Math.max(generations.get(entry.threadId) ?? 0, entry.generation),
          );
        if (entry.requestKey !== undefined && entry.fingerprint !== undefined) {
          requests.set(entry.requestKey, {
            fingerprint: entry.fingerprint,
            monitorId: entry.monitorId,
            ...(entry.job ? { logPath: entry.job.logPath } : {}),
          });
        }
      }
    }
  }
  const cleanCompletedLogs = lock
    .withPermit(
      Effect.gen(function* () {
        // An unreadable journal cannot authorize deleting unknown recovery state.
        if (
          journalUnavailable ||
          stateDir === undefined ||
          journalPath === undefined ||
          Option.isNone(fileSystem)
        )
          return;
        const now = yield* Clock.currentTimeMillis;
        const persisted = yield* fileSystem.value.readFileString(journalPath).pipe(
          Effect.map(decodeJournal),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound",
            () => Effect.succeed(null),
          ),
        );
        if (persisted !== null && Option.isNone(persisted)) return;
        const diskProtected = new Set(
          (persisted === null ? [] : persisted.value.monitors).flatMap((entry) =>
            entry.job === undefined ? [] : [pathService.dirname(entry.job.logPath)],
          ),
        );
        const protects = (logPath: string | undefined, directory: string) =>
          logPath !== undefined && pathService.dirname(logPath) === directory;
        yield* Effect.tryPromise(() =>
          sweepCompletedJobLogs({
            root: pathService.join(stateDir, "jobs"),
            now,
            includeLegacy: persisted !== null,
            isProtected: (directory) =>
              diskProtected.has(directory) ||
              [...journal.values(), ...recoverable.values()].some((entry) =>
                protects(entry.job?.logPath, directory),
              ) ||
              [...running.values()].some((entry) => protects(entry.info.logPath, directory)),
          }),
        );
      }),
    )
    .pipe(
      Effect.catch((cause) => Effect.logWarning("Could not expire completed job logs", { cause })),
    );
  yield* cleanCompletedLogs;
  yield* Effect.sleep("1 hour").pipe(
    Effect.andThen(cleanCompletedLogs),
    Effect.forever,
    Effect.forkIn(serviceScope),
  );
  const savedMonitorInfo = (saved: MonitorJournalEntry): MonitorInfo => ({
    monitorId: saved.monitorId,
    threadId: saved.threadId,
    description: saved.description,
    startedAt: saved.startedAt,
    timeoutMs: saved.timeoutMs,
    persistent: saved.persistent,
    ...(saved.job === undefined
      ? { restartable: saved.restartable, silenceMs: saved.silenceMs }
      : { durable: true, logPath: saved.job.logPath }),
  });
  const publishRoster = () =>
    Effect.suspend(() => {
      const entries: ReadonlyArray<MonitorInfo> = [
        ...[...running.values()].map((entry) => entry.info),
        ...[...recoverable.values()].flatMap((saved) =>
          (saved.job === undefined && !saved.restartable) || saved.completion !== undefined
            ? []
            : [
                {
                  ...savedMonitorInfo(saved),
                  state:
                    saved.stopRequested === true ? ("stopping" as const) : ("recovering" as const),
                },
              ],
        ),
      ];
      // The chat list reads these counts: a chat waiting only on its monitors is long-running.
      publishAppMonitors(entries.map((entry) => entry.threadId));
      return SubscriptionRef.set(roster, entries);
    });
  yield* publishRoster();

  const followDurable = (
    saved: MonitorJournalEntry & { readonly job: DurableJobProcess.DurableJob },
  ) =>
    Effect.gen(function* () {
      const info = savedMonitorInfo(saved);
      const stop = yield* Deferred.make<EndReason>();
      const done = yield* Deferred.make<void, MonitorError>();
      const shutdown = yield* Effect.cached(jobs.stop(saved.job));
      const generation = generations.get(saved.threadId) ?? saved.generation ?? 0;
      generations.set(saved.threadId, generation);
      running.set(saved.monitorId, { info, stop, done, generation, cwd: saved.cwd, shutdown });
      recoverable.delete(saved.monitorId);
      yield* publishRoster();
      let current = saved;
      const watch = Effect.gen(function* () {
        let cursor = current.job;
        let lines: string[] = [];
        let length = 0;
        let lastFlush = yield* Clock.currentTimeMillis;
        const publish = (
          summary: string,
          detail: string,
          outcome: OrchestrationV2Notification["outcome"],
          sequence = current.sequence,
          urgent = false,
        ) =>
          Effect.gen(function* () {
            const event: MonitorEvent = {
              monitorId: saved.monitorId,
              threadId: saved.threadId,
              generation,
              sequence,
              durable: true,
              ...(urgent ? { urgent } : {}),
              text: `Monitor "${saved.description}" (${saved.monitorId}): ${summary}${detail ? `\n${detail}` : ""}`,
              notification: {
                source: { kind: "monitor" },
                outcome,
                summary: `${saved.description}: ${summary}`,
                ...(detail ? { detail } : {}),
              },
            };
            pending.set(eventKey(event), saved.threadId);
            yield* Queue.offer(events, event);
          });
        const emit = (
          summary: string,
          detail: string,
          outcome: OrchestrationV2Notification["outcome"],
          urgent = false,
        ) =>
          Effect.gen(function* () {
            current = {
              ...current,
              sequence: current.sequence + 1,
              ...(outcome === "completed" || outcome === "failed" || outcome === "cancelled"
                ? { completion: { summary, detail, outcome } }
                : {}),
            };
            yield* retryJobIo(journalPut(current, true));
            yield* publish(summary, detail, outcome, current.sequence, urgent);
          });
        if (current.completion !== undefined) {
          // Reuse the event id until delivery acknowledges it; orchestration deduplicates it.
          yield* publish(
            current.completion.summary,
            current.completion.detail,
            current.completion.outcome,
          );
          return;
        }
        // Saved with the cursor: the restored state covers exactly the lines before it.
        const errors = ErrorLoop.makeDetector({ rewake: true, saved: saved.errors });
        const withErrors = (entry: typeof current) => {
          const list = errors.snapshot();
          return list.length === 0 ? entry : { ...entry, errors: list };
        };
        const overdueAt =
          saved.expectMinutes === undefined
            ? undefined
            : saved.startedAt + ErrorLoop.overdueAfterMs(saved.expectMinutes);
        const flushMatches = Effect.gen(function* () {
          const next = withErrors({ ...current, sequence: current.sequence + 1, job: cursor });
          // Leave the checkpoint behind a batch until it has entered the delivery queue.
          yield* publish("output", lines.join("\n"), "updated", next.sequence);
          yield* retryJobIo(journalPut(next, true));
          current = next;
          lines = [];
          length = 0;
          lastFlush = yield* Clock.currentTimeMillis;
        }).pipe(Effect.uninterruptible);
        /** A stuck-job wake, after the matches batched before it and with their checkpoint. */
        const notice = (summary: string, update: Partial<MonitorJournalEntry> = {}) =>
          Effect.gen(function* () {
            if (lines.length > 0) yield* flushMatches;
            current = withErrors({ ...current, ...update, job: cursor });
            yield* emit(summary, "", "updated", true);
          });
        const follow = Effect.gen(function* () {
          let match =
            typeof saved.wakeOn !== "string"
              ? undefined
              : yield* WakeMatcher.make(saved.wakeOn).pipe(
                  Effect.catch((error) =>
                    Effect.logWarning("Could not start monitor output matcher", error).pipe(
                      Effect.as(undefined),
                    ),
                  ),
                );
          while (true) {
            const read = yield* retryJobIo(jobs.read(cursor));
            const parts = (cursor.partial + read.output).split("\n");
            const partial = parts.pop()!.slice(0, MAX_TEXT);
            const complete = parts.map((line) => line.slice(0, MAX_TEXT).replace(/\r$/, ""));
            if (match !== undefined && complete.length > 0) {
              const matched = yield* match(complete).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    match = undefined;
                    yield* Effect.logWarning("Monitor output matching disabled", {
                      monitorId: saved.monitorId,
                      error,
                    });
                    yield* emit(
                      "wakeOn disabled",
                      "Output matching failed or took too long. The job is still running; its log and exit notice remain available.",
                      "updated",
                    );
                    return [];
                  }),
                ),
              );
              for (const bounded of matched) {
                const separatorLength = lines.length > 0 ? 1 : 0;
                const available = DURABLE_WAKE_DETAIL_LIMIT - length - separatorLength;
                if (
                  lines.length === 10 ||
                  (bounded.length > available && available < TRUNCATED_LINE.length)
                )
                  break;
                const detail =
                  bounded.length <= available
                    ? bounded
                    : bounded.slice(0, available - TRUNCATED_LINE.length) + TRUNCATED_LINE;
                length += separatorLength + detail.length;
                lines.push(detail);
              }
            }
            cursor = { ...saved.job, offset: read.offset, partial };
            const now = yield* Clock.currentTimeMillis;
            errors.observe(complete, now);
            const ended =
              read.end && (read.exitCode !== undefined || !(yield* retryJobIo(jobs.alive(cursor))));
            if (
              lines.length > 0 &&
              (ended || (now - lastFlush >= 5_000 && (yield* Queue.size(events)) < 128))
            ) {
              yield* flushMatches;
            }
            if (ended) return read.exitCode;
            // A backlog read after the job exited is not news; its exit notice follows.
            if (read.exitCode === undefined) {
              const loop = errors.take(now);
              if (loop !== undefined) yield* notice(ErrorLoop.loopSummary(loop));
              if (overdueAt !== undefined && current.overdue !== true && now >= overdueAt) {
                const tail = yield* jobs.tail(cursor).pipe(Effect.orElseSucceed(() => ""));
                yield* notice(
                  ErrorLoop.overdueSummary({
                    ranMs: now - saved.startedAt,
                    expectMinutes: saved.expectMinutes!,
                    lastLine: ErrorLoop.lastOutputLine(tail),
                  }),
                  { overdue: true },
                );
              }
            }
            if (lines.length === 0) {
              current = withErrors({ ...current, job: cursor });
              if (read.end && cursor.offset !== journal.get(saved.monitorId)?.job?.offset)
                yield* retryJobIo(journalPut(current, true));
            }
            if (!read.end) {
              yield* Effect.yieldNow;
              continue;
            }
            yield* Effect.sleep("1 second");
          }
        }).pipe(Effect.scoped);
        const remaining =
          saved.timeoutMs === null
            ? Effect.never
            : Effect.sleep(
                Math.max(0, saved.startedAt + saved.timeoutMs - (yield* Clock.currentTimeMillis)),
              ).pipe(Effect.as("timeout" as const));
        const result = yield* Effect.raceFirst(
          follow.pipe(Effect.map((exitCode) => ({ exitCode }))),
          Effect.raceFirst(Deferred.await(stop), remaining).pipe(
            Effect.map((reason) => ({ reason })),
          ),
        );
        yield* shutdown;
        const tail = yield* jobs
          .tail(current.job)
          .pipe(
            Effect.orElseSucceed(() => "Output unavailable; read the log after storage recovers."),
          );
        yield* emit(
          "reason" in result
            ? result.reason === "stopped"
              ? "stopped"
              : "timed out"
            : result.exitCode !== undefined
              ? `exited with code ${result.exitCode}`
              : "process disappeared without an exit receipt",
          `Log: ${current.job.logPath}\n${tail}`,
          "reason" in result && result.reason === "stopped"
            ? "cancelled"
            : "exitCode" in result && result.exitCode === 0
              ? "completed"
              : "failed",
        );
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            // Failed reads or storage writes retain ownership and can be adopted again.
            // Scope shutdown leaves the detached process and the on-disk receipt untouched.
            if (Exit.isFailure(exit) && journal.has(saved.monitorId))
              recoverable.set(saved.monitorId, {
                ...current,
                ...(journal.get(saved.monitorId)?.stopRequested === true
                  ? { stopRequested: true }
                  : {}),
              });
            running.delete(saved.monitorId);
            yield* publishRoster();
            yield* notifySettled(saved.threadId);
            yield* Deferred.done(done, exit);
          }),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Durable monitor follower failed; job retained for recovery", {
                monitorId: saved.monitorId,
                cause,
              }),
        ),
      );
      yield* Effect.forkIn(watch, serviceScope);
    });

  const admitStart =
    (input: { cwd: string; threadId: ThreadId }) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) => {
      const key = Symbol();
      return Effect.acquireUseRelease(
        Effect.sync(() => startingCwds.set(key, input)),
        () => lock.withPermit(effect),
        () =>
          Effect.suspend(() => {
            startingCwds.delete(key);
            return notifySettled(input.threadId);
          }),
      );
    };

  const start = (
    input: Parameters<MonitorService["Service"]["start"]>[0] & {
      /** Relaunching a journaled monitor after a restart: same id, clock and history. */
      readonly resume?: MonitorJournalEntry;
    },
  ): Effect.Effect<{ readonly monitorId: string; readonly logPath?: string }, MonitorError> =>
    admitStart(input)(
      Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          // Never overwrite receipts we could not read, or call unknown ownership empty.
          if (journalUnavailable) return yield* new MonitorError({ reason: "storage" });
          const resume = input.resume;
          if (
            resume !== undefined &&
            (!recoverable.has(resume.monitorId) ||
              (generations.get(resume.threadId) ?? 0) !== (resume.generation ?? 0))
          ) {
            return { monitorId: resume.monitorId };
          }
          if (
            input.durable === true &&
            (input.restartable === true || input.silenceMs !== undefined)
          ) {
            return yield* new MonitorError({ reason: "invalid-options" });
          }
          if (typeof input.wakeOn === "string") {
            const source = input.wakeOn;
            yield* Effect.try({
              try: () => new RegExp(source),
              catch: () => new MonitorError({ reason: "invalid-options" }),
            });
          }
          let requestKey = resume?.requestKey;
          let fingerprint = resume?.fingerprint;
          if (input.clientRequestId !== undefined) {
            // Recoverable jobs belong to the chat across provider sessions.
            requestKey = (
              input.restartable === true || input.durable === true
                ? [input.threadId, input.clientRequestId]
                : [input.threadId, input.requestNamespace, input.clientRequestId]
            )
              .map(requestPart)
              .join("");
            fingerprint = yield* crypto
              .digest(
                "SHA-256",
                new TextEncoder().encode(
                  [
                    input.command,
                    input.description,
                    String(input.timeoutMs ?? ""),
                    String(input.persistent ?? false),
                    String(input.restartable ?? false),
                    String(input.durable ?? false),
                    input.wakeOn === undefined
                      ? "none"
                      : input.wakeOn === false
                        ? "exit"
                        : `regex:${input.wakeOn}`,
                    String(input.silenceMs ?? ""),
                    input.cwd,
                    // Absent for older receipts, so their fingerprints still match.
                    ...(input.expectMinutes === undefined ? [] : [`expect:${input.expectMinutes}`]),
                  ]
                    .map((part) => `${part.length}:${part}`)
                    .join(""),
                ),
              )
              .pipe(
                Effect.map(Hex.encode),
                Effect.mapError((cause) => new MonitorError({ reason: "spawn", cause })),
              );
            // The in-memory cache is bounded. The journal still owns a live watcher's receipt.
            const cached = requests.get(requestKey);
            const previous =
              cached ??
              (input.restartable === true || input.durable === true
                ? [...journal.values()].find((entry) => entry.requestKey === requestKey)
                : undefined);
            if (previous !== undefined) {
              if (previous.fingerprint !== fingerprint) {
                return yield* new MonitorError({ reason: "invalid-request" });
              }
              const logPath = "job" in previous ? previous.job?.logPath : cached?.logPath;
              return {
                monitorId: previous.monitorId,
                ...(logPath === undefined ? {} : { logPath }),
              };
            }
          }
          const receipt =
            requestKey === undefined || fingerprint === undefined
              ? undefined
              : { requestKey, fingerprint };
          if (
            [...running.values()].filter((entry) => entry.info.threadId === input.threadId).length +
              [...recoverable.values()].filter(
                (entry) =>
                  entry.threadId === input.threadId && entry.monitorId !== input.resume?.monitorId,
              ).length >=
            8
          ) {
            return yield* new MonitorError({ reason: "limit" });
          }
          const monitorId =
            input.resume?.monitorId ??
            `monitor:${yield* crypto.randomUUIDv4().pipe(Effect.mapError((cause) => new MonitorError({ reason: "spawn", cause })))}`;
          if (input.durable === true) {
            if (stateDir === undefined || journalPath === undefined) {
              return yield* new MonitorError({ reason: "spawn" });
            }
            const job = yield* jobs.start({
              directory: pathService.join(stateDir, "jobs", monitorId.replace(":", "-")),
              command: input.command,
              cwd: input.cwd,
            });
            const saved = {
              monitorId,
              threadId: input.threadId,
              command: input.command,
              description: input.description.slice(0, MAX_DESCRIPTION_LENGTH),
              cwd: input.cwd,
              startedAt: yield* Clock.currentTimeMillis,
              timeoutMs: input.timeoutMs ?? null,
              persistent: input.persistent ?? true,
              restartable: false,
              silenceMs: null,
              sequence: 0,
              delivered: [],
              job,
              generation: generations.get(input.threadId) ?? 0,
              ...(input.wakeOn === undefined ? {} : { wakeOn: input.wakeOn }),
              ...(input.expectMinutes === undefined ? {} : { expectMinutes: input.expectMinutes }),
              ...receipt,
            };
            yield* journalPut(saved, true).pipe(
              Effect.andThen(jobs.release(job)),
              Effect.onError(() =>
                jobs.stop(job).pipe(
                  Effect.andThen(journalRemove(monitorId)),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Could not clean up a failed durable start", cause),
                  ),
                ),
              ),
            );
            if (receipt !== undefined)
              requests.set(receipt.requestKey, {
                fingerprint: receipt.fingerprint,
                monitorId,
                logPath: job.logPath,
              });
            yield* followDurable(saved);
            return { monitorId, logPath: job.logPath };
          }
          const childScope = yield* Scope.fork(serviceScope, "sequential");
          const shell =
            platform === "win32"
              ? (environment.ComSpec ?? "cmd.exe")
              : (environment.SHELL ?? "/bin/sh");
          // The server prepares the login environment at boot. A login shell also applies the
          // user's shell setup; terminals inherit the same complete environment.
          const shellArgs =
            platform === "win32" ? ["/d", "/s", "/c", input.command] : ["-l", "-c", input.command];
          // Agents start monitors, so they get the agents' lower priority on macOS.
          const launch =
            platform === "darwin"
              ? darwinAgentCommand(shell, shellArgs, input.threadId)
              : { command: shell, args: shellArgs };
          const command = ChildProcess.make(launch.command, launch.args, {
            cwd: input.cwd,
            // Python watcher scripts print each line as it happens, not at exit.
            env: { PYTHONUNBUFFERED: "1", ...environment },
            extendEnv: true,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            forceKillAfter: "1 second",
          });
          const child = yield* restore(
            spawner.spawn(command).pipe(Effect.provideService(Scope.Scope, childScope)),
          ).pipe(
            Effect.onError(() => Scope.close(childScope, Exit.void)),
            Effect.mapError((cause) => new MonitorError({ reason: "spawn", cause })),
          );
          const stop = yield* Deferred.make<EndReason>();
          const done = yield* Deferred.make<void, MonitorError>();
          const info: MonitorInfo = {
            monitorId,
            threadId: input.threadId,
            description:
              input.description.length > MAX_DESCRIPTION_LENGTH
                ? `${input.description.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`
                : input.description,
            startedAt: input.resume?.startedAt ?? (yield* Clock.currentTimeMillis),
            timeoutMs: input.timeoutMs ?? (input.persistent === true ? null : DEFAULT_TIMEOUT_MS),
            persistent: input.persistent ?? false,
            restartable: input.restartable ?? false,
            silenceMs: input.silenceMs ?? null,
          };
          // A relaunched monitor keeps its original deadline.
          const remainingMs =
            info.timeoutMs === null
              ? null
              : Math.max(0, info.timeoutMs - ((yield* Clock.currentTimeMillis) - info.startedAt));
          const expectMinutes = input.expectMinutes;
          // Watchers that already wake on all output get one wake per error line.
          const errors = ErrorLoop.makeDetector({
            rewake: input.wakeOn !== undefined,
            saved: input.resume?.errors,
          });
          let overdue = input.resume?.overdue === true;
          const errorState = () => {
            const list = errors.snapshot();
            return list.length === 0 ? {} : { errors: list };
          };
          const journalEntry = (
            sequence: number,
            delivered: ReadonlyArray<string>,
          ): MonitorJournalEntry => ({
            monitorId,
            threadId: info.threadId,
            command: input.command,
            description: info.description,
            cwd: input.cwd,
            startedAt: info.startedAt,
            timeoutMs: info.timeoutMs,
            persistent: info.persistent,
            restartable: info.restartable === true,
            silenceMs: info.silenceMs ?? null,
            ...(input.wakeOn === undefined ? {} : { wakeOn: input.wakeOn }),
            ...(info.restartable === true ? receipt : undefined),
            sequence,
            delivered,
            generation: generations.get(info.threadId) ?? 0,
            ...(expectMinutes === undefined ? {} : { expectMinutes }),
            ...(overdue ? { overdue } : {}),
            ...errorState(),
          });
          if (!generations.has(input.threadId)) generations.set(input.threadId, 0);
          const entry: RunningMonitor = {
            info,
            cwd: input.cwd,
            stop,
            done,
            generation: generations.get(input.threadId) ?? 0,
          };
          running.set(monitorId, entry);
          if (receipt !== undefined) {
            requests.set(receipt.requestKey, { fingerprint: receipt.fingerprint, monitorId });
            // Bound restart-local receipts without retaining commands forever.
            if (requests.size > 4096) requests.delete(requests.keys().next().value!);
          }
          recoverable.delete(monitorId);
          yield* publishRoster();
          yield* journalPut(
            journalEntry(input.resume?.sequence ?? 0, input.resume?.delivered ?? []),
          );

          const watch = Effect.gen(function* () {
            const outputReady = yield* Queue.dropping<void>(1);
            let sequence = input.resume?.sequence ?? 0;
            // Lines a relaunched command prints again (a grep over a whole log) are not news.
            const replayed = new Set(input.resume?.delivered ?? []);
            const delivered = [...(input.resume?.delivered ?? [])];
            let lastActivity = info.startedAt;
            let silenceReported = false;
            let lines: string[] = [];
            let lineCount = 0;
            let textLength = 0;
            let partial = "";
            let truncatedLine = false;
            let stderr = "";
            let stderrPartial = "";
            let output = "";
            let publishedOutput = "";
            let matchedOutput = "";
            let lastOutput = info.startedAt;
            let batchStartedAt = info.startedAt;
            let lastFlush = info.startedAt;
            let windowStart = info.startedAt;
            let windowBytes = 0;
            let windowLines = 0;
            let windowWakes = 0;
            const emit = (
              summary: string,
              detail: string,
              outcome: OrchestrationV2Notification["outcome"],
              urgent = false,
            ) =>
              Effect.gen(function* () {
                // Taken before saving: another fiber's notice may take the next one meanwhile.
                const eventSequence = ++sequence;
                const saved = {
                  ...journalEntry(eventSequence, delivered),
                  generation: entry.generation,
                  ...(outcome === "completed" || outcome === "failed"
                    ? { completion: { summary, detail, outcome } }
                    : {}),
                };
                // Keep an exit until delivery acknowledges it. Recovery can reuse its id.
                yield* journalPut(saved);
                yield* publishWatcherEvent(saved, summary, detail, outcome, urgent);
              });
            let exited = false;
            const checkErrors = (lines: ReadonlyArray<string>, now: number, stream: string) =>
              Effect.suspend(() => {
                errors.observe(lines, now, stream);
                const loop = exited ? undefined : errors.take(now);
                return loop === undefined
                  ? Effect.void
                  : emit(ErrorLoop.loopSummary(loop), "", "updated", true);
              });
            const resetWindow = (now: number) => {
              if (now - windowStart < 60_000) return;
              windowStart = now;
              windowBytes = 0;
              windowLines = 0;
              windowWakes = 0;
            };
            let match =
              typeof input.wakeOn === "string"
                ? yield* WakeMatcher.make(input.wakeOn).pipe(
                    Effect.catch(() =>
                      emit(
                        "wakeOn disabled",
                        "Output matching failed. The monitor is still running; output is available in monitor_list and exit always wakes you.",
                        "updated",
                      ).pipe(Effect.as(undefined)),
                    ),
                  )
                : undefined;
            const matchLock = yield* Semaphore.make(1);
            const matchLines = (lines: ReadonlyArray<string>) =>
              Effect.gen(function* () {
                if (match === undefined || lines.length === 0) return;
                const matched = yield* match(lines).pipe(
                  Effect.catch(() =>
                    Effect.gen(function* () {
                      match = undefined;
                      yield* emit(
                        "wakeOn disabled",
                        "Output matching failed or took too long. The monitor is still running; output is available in monitor_list and exit always wakes you.",
                        "updated",
                      );
                      return [];
                    }),
                  ),
                );
                if (matched.length > 0)
                  matchedOutput = [matchedOutput, ...matched]
                    .filter((line) => line.length > 0)
                    .join("\n")
                    .slice(-MAX_TEXT);
              }).pipe(matchLock.withPermit);
            /** The batched lines as one notification detail; empties the batch. */
            const takeBatch = () => {
              const omitted = lineCount - lines.length;
              const detail = [
                ...lines,
                ...(omitted > 0 ? [`[${omitted} lines omitted]`] : []),
              ].join("\n");
              lines = [];
              lineCount = 0;
              textLength = 0;
              return detail;
            };
            const flush = Effect.gen(function* () {
              lastFlush = yield* Clock.currentTimeMillis;
              if (output !== publishedOutput) {
                publishedOutput = output;
                running.set(monitorId, { ...entry, info: { ...info, output } });
                yield* publishRoster();
              }
              const batch = takeBatch();
              const detail = input.wakeOn === undefined ? batch : matchedOutput;
              matchedOutput = "";
              if (detail.length === 0) return;
              const now = yield* Clock.currentTimeMillis;
              resetWindow(now);
              if (++windowWakes > 30 || (yield* Queue.size(events)) >= 128) {
                yield* Deferred.succeed(stop, "runaway");
                return;
              }
              lastFlush = now;
              yield* emit("output", detail, "updated");
            });
            const addLine = (line: string) => {
              const bounded = line.replace(/\r$/, "");
              if (info.restartable === true) {
                const hash = lineHash(bounded);
                if (replayed.has(hash)) return undefined;
                delivered.push(hash);
                if (delivered.length > MAX_DELIVERED_HASHES) delivered.shift();
              }
              lineCount++;
              windowLines++;
              if (lines.length < MAX_LINES && textLength + bounded.length + 1 <= MAX_TEXT) {
                lines.push(bounded);
                textLength += bounded.length + 1;
              }
              return bounded;
            };
            const stdout = child.stdout.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis;
                  resetWindow(now);
                  lastOutput = now;
                  lastActivity = now;
                  silenceReported = false;
                  if (lineCount === 0 && matchedOutput === "" && output === publishedOutput)
                    batchStartedAt = now;
                  output = (output + chunk).slice(-MAX_TEXT);
                  windowBytes += Buffer.byteLength(chunk);
                  const completeLines: string[] = [];
                  for (const part of chunk.split(/(?<=\n)/)) {
                    const complete = part.endsWith("\n");
                    const available = Math.max(0, MAX_TEXT - 32 - partial.length);
                    partial += part.slice(0, available);
                    if (part.length > available) truncatedLine = true;
                    if (complete) {
                      const line = addLine(
                        `${partial.replace(/\n$/, "")}${truncatedLine ? " [line truncated]" : ""}`,
                      );
                      if (line !== undefined) completeLines.push(line);
                      partial = "";
                      truncatedLine = false;
                    }
                  }
                  yield* matchLines(completeLines);
                  yield* checkErrors(completeLines, now, "stdout");
                  yield* Queue.offer(outputReady, undefined);
                  if (windowBytes > 1_048_576 || windowLines > 10_000)
                    yield* Deferred.succeed(stop, "runaway");
                }),
              ),
            );
            const stderrReader = child.stderr.pipe(
              Stream.decodeText(),
              Stream.runForEach((chunk) =>
                Effect.gen(function* () {
                  const now = yield* Clock.currentTimeMillis;
                  resetWindow(now);
                  lastActivity = now;
                  silenceReported = false;
                  if (lineCount === 0 && matchedOutput === "" && output === publishedOutput)
                    batchStartedAt = now;
                  lastOutput = now;
                  output = (output + chunk).slice(-MAX_TEXT);
                  windowBytes += Buffer.byteLength(chunk);
                  stderr = (stderr + chunk).slice(-4_000);
                  const parts = (stderrPartial + chunk).split("\n");
                  stderrPartial = parts.pop()!.slice(-MAX_TEXT);
                  const complete = parts.map((line) => line.slice(0, MAX_TEXT).replace(/\r$/, ""));
                  yield* matchLines(complete);
                  yield* checkErrors(complete, now, "stderr");
                  yield* Queue.offer(outputReady, undefined);
                  if (windowBytes > 1_048_576) yield* Deferred.succeed(stop, "runaway");
                }),
              ),
            );
            const stdoutFiber = yield* Effect.forkScoped(stdout);
            const stderrFiber = yield* Effect.forkScoped(stderrReader);
            const flushFiber = yield* Effect.forkScoped(
              Effect.forever(
                Queue.take(outputReady).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      if (output === publishedOutput && lineCount === 0 && matchedOutput === "")
                        return;
                      while (true) {
                        const now = yield* Clock.currentTimeMillis;
                        const wait = Math.max(
                          1_000 - (now - lastFlush),
                          Math.min(1_000 - (now - lastOutput), 5_000 - (now - batchStartedAt)),
                        );
                        if (wait <= 0 || (lineCount >= MAX_LINES && now - lastFlush >= 1_000))
                          break;
                        yield* Effect.sleep(wait);
                      }
                      yield* flush;
                    }),
                  ),
                ),
              ),
            );
            const silenceMs = info.silenceMs ?? null;
            const silenceFiber =
              silenceMs === null
                ? undefined
                : yield* Effect.forkScoped(
                    Effect.forever(
                      Effect.gen(function* () {
                        const quiet = (yield* Clock.currentTimeMillis) - lastActivity;
                        if (!silenceReported && quiet >= silenceMs) {
                          silenceReported = true;
                          yield* emit(
                            `no output for ${formatQuiet(silenceMs)}`,
                            "It is still running but printed nothing on stdout or stderr; the job may be stuck. This wakes you again after its next output and another quiet stretch.",
                            "updated",
                          );
                        }
                        yield* Effect.sleep(
                          Math.max(1_000, silenceReported ? silenceMs : silenceMs - quiet),
                        );
                      }),
                    ),
                  );
            const overdueFiber =
              expectMinutes === undefined || overdue
                ? undefined
                : yield* Effect.forkScoped(
                    Effect.gen(function* () {
                      // Relaunches keep startedAt, so the deadline survives a restart.
                      const dueAt = info.startedAt + ErrorLoop.overdueAfterMs(expectMinutes);
                      yield* Effect.sleep(Math.max(0, dueAt - (yield* Clock.currentTimeMillis)));
                      if (exited) return;
                      overdue = true;
                      yield* emit(
                        ErrorLoop.overdueSummary({
                          ranMs: (yield* Clock.currentTimeMillis) - info.startedAt,
                          expectMinutes,
                          lastLine: ErrorLoop.lastOutputLine(output),
                        }),
                        "",
                        "updated",
                        true,
                      );
                    }),
                  );
            const stopped = Deferred.await(stop).pipe(Effect.map((reason) => ({ reason })));
            const deadline =
              remainingMs === null
                ? Effect.never
                : Effect.sleep(remainingMs).pipe(Effect.as({ reason: "timeout" as const }));
            const result = yield* Effect.raceFirst(
              child.exitCode.pipe(
                Effect.map((code) => ({ code: Number(code) })),
                Effect.catch((error) => Effect.succeed({ error })),
              ),
              Effect.raceFirst(stopped, deadline),
            );
            exited = true;
            yield* Fiber.interrupt(flushFiber);
            if (silenceFiber !== undefined) yield* Fiber.interrupt(silenceFiber);
            if (overdueFiber !== undefined) yield* Fiber.interrupt(overdueFiber);
            // Scope release kills the process group, including descendants left holding pipes
            // after their shell exited. The platform spawner escalates to SIGKILL.
            yield* Scope.close(childScope, Exit.void);
            yield* Effect.all([Fiber.await(stdoutFiber), Fiber.await(stderrFiber)]).pipe(
              Effect.timeoutOption("1 second"),
            );
            yield* Fiber.interrupt(stdoutFiber);
            yield* Fiber.interrupt(stderrFiber);
            if (partial.length > 0 || truncatedLine)
              addLine(`${partial}${truncatedLine ? " [line truncated]" : ""}`);
            // Output still batched when the process ends goes out with its end,
            // so a check that prints its answer and exits wakes the agent once.
            const finalOutput = input.wakeOn === undefined ? takeBatch() : output;
            const termination = (yield* Deferred.isDone(stop))
              ? { reason: yield* Deferred.await(stop) }
              : result;
            const signal =
              "error" in termination
                ? /signal: '([^']+)'/.exec(String(termination.error.reason.cause))?.[1]
                : undefined;
            const summary =
              "reason" in termination
                ? termination.reason === "timeout"
                  ? "timed out"
                  : termination.reason === "runaway"
                    ? "stopped: output rate limit exceeded"
                    : "stopped"
                : "code" in termination
                  ? `exited with code ${termination.code}`
                  : signal !== undefined
                    ? `exited on signal ${signal}`
                    : "process failed";
            yield* emit(
              summary,
              [
                finalOutput,
                input.wakeOn === undefined && stderr.length > 0 ? `Stderr tail:\n${stderr}` : "",
              ]
                .filter((part) => part.length > 0)
                .join("\n"),
              "reason" in termination && termination.reason === "stopped"
                ? "cancelled"
                : "code" in termination && termination.code === 0
                  ? "completed"
                  : "failed",
            );
            if ("reason" in termination && termination.reason === "stopped") {
              yield* journalRemove(monitorId);
            }
          }).pipe(
            Effect.scoped,
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Scope.close(childScope, Exit.void);
                running.delete(monitorId);
                yield* publishRoster();
                yield* notifySettled(info.threadId);
                yield* Deferred.succeed(done, undefined);
              }),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logWarning("Monitor failed", { monitorId, cause }),
            ),
          );
          yield* Effect.forkIn(watch, serviceScope);
          return { monitorId };
        }),
      ),
    );

  // Claim saved receipts under the admission lock. Recovery may already be checking access.
  const requestSavedStop = (saved: MonitorJournalEntry) => {
    if (saved.job === undefined) {
      recoverable.delete(saved.monitorId);
      return false;
    }
    const stopping = { ...saved, stopRequested: true };
    recoverable.set(saved.monitorId, stopping);
    journal.set(saved.monitorId, stopping);
    return true;
  };

  const stop: MonitorService["Service"]["stop"] = (threadId, monitorId) =>
    Effect.gen(function* () {
      const entry = yield* lock.withPermit(
        Effect.gen(function* () {
          const entry = running.get(monitorId);
          const saved = recoverable.get(monitorId);
          if ((entry?.info.threadId ?? saved?.threadId ?? threadId) !== threadId)
            return yield* new MonitorError({ reason: "not-found" });
          if (entry !== undefined) yield* Deferred.succeed(entry.stop, "stopped");
          if (entry === undefined && saved !== undefined) requestSavedStop(saved);
          return entry ?? saved;
        }),
      );
      if (entry === undefined) return false;
      if ("info" in entry) {
        // Kill independently of a follower blocked reading output or saving notifications.
        if (entry.shutdown !== undefined) yield* entry.shutdown;
        yield* Deferred.await(entry.done);
      } else {
        if (entry.job !== undefined) {
          yield* writeJournal;
          yield* jobs.stop(entry.job);
        }
        recoverable.delete(monitorId);
        yield* publishRoster();
        yield* journalRemove(monitorId);
        yield* notifySettled(threadId);
      }
      return true;
    }).pipe(Effect.uninterruptible);
  const stopThread: MonitorService["Service"]["stopThread"] = (threadId) =>
    Effect.gen(function* () {
      // A start holds admission across process spawning. Wait for it to enroll
      // before taking the stop snapshot, or that process can survive user Stop.
      const { stopping, savedJobs } = yield* lock.withPermit(
        Effect.sync(() => {
          generations.set(threadId, (generations.get(threadId) ?? 0) + 1);
          let savedJobs = false;
          for (const saved of recoverable.values()) {
            if (saved.threadId === threadId && requestSavedStop(saved)) savedJobs = true;
          }
          return {
            stopping: [...running.values()].filter((entry) => entry.info.threadId === threadId),
            savedJobs,
          };
        }),
      );
      if (savedJobs) yield* writeJournal;
      yield* Effect.forEach(
        stopping,
        (entry) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(entry.stop, "stopped");
            if (entry.shutdown !== undefined) yield* entry.shutdown;
            yield* Deferred.await(entry.done);
          }).pipe(
            Effect.catch((error) => Effect.logWarning("Could not finish stopping monitor", error)),
          ),
        { concurrency: "unbounded", discard: true },
      );
      // Keep failed stops owned and retry only shutdown on recovery, never adoption.
      const savedMonitors = new Map([...journal, ...recoverable]);
      for (const saved of savedMonitors.values()) {
        if (saved.threadId !== threadId || saved.generation === generations.get(threadId)) continue;
        if (saved.job !== undefined) {
          // A live follower can return its receipt if shutdown failed.
          if (saved.stopRequested !== true) {
            requestSavedStop(saved);
            yield* writeJournal;
          }
          const stopped = yield* jobs.stop(saved.job).pipe(
            Effect.as(true),
            Effect.catch((error) =>
              Effect.logWarning(
                "Could not stop durable job; retaining it for recovery",
                error,
              ).pipe(Effect.as(false)),
            ),
          );
          if (!stopped) continue;
        }
        recoverable.delete(saved.monitorId);
        yield* journalRemove(saved.monitorId);
      }
      // Stop invalidates notices emitted while the processes were shutting down too.
      for (const [key, id] of pending) {
        if (id === threadId) pending.delete(key);
      }
      yield* publishRoster();
      yield* notifySettled(threadId);
    }).pipe(Effect.uninterruptible);
  /** Wakes a monitor's thread once with how the restart ended it. */
  const reportLost = (saved: MonitorJournalEntry, summary: string, detail: string) =>
    publishWatcherEvent({ ...saved, sequence: saved.sequence + 1 }, summary, detail, "failed");

  const recoveryRetries = new Set<string>();
  const recover: MonitorService["Service"]["recover"] = (access) =>
    Effect.gen(function* () {
      const savedMonitors = [...recoverable.values()];
      for (const saved of savedMonitors) {
        if (recoveryRetries.has(saved.monitorId)) continue;
        const recoverEntry = Effect.gen(function* () {
          // Stop or a start with the same id may have taken it since.
          if (!recoverable.has(saved.monitorId)) return;
          const allowed = yield* access(saved.threadId);
          if (allowed === "retry" || recoverable.get(saved.monitorId) !== saved) return;
          const now = yield* Clock.currentTimeMillis;
          const expired = saved.timeoutMs !== null && now >= saved.startedAt + saved.timeoutMs;
          if (saved.job !== undefined) {
            // Adoption never invokes start, even if the PID is gone or the command failed.
            const stopped =
              saved.stopRequested === true ||
              (generations.get(saved.threadId) ?? 0) !== (saved.generation ?? 0);
            if (allowed !== "ok" || stopped) {
              yield* jobs.stop(saved.job);
              if (recoverable.get(saved.monitorId) !== saved) return;
              recoverable.delete(saved.monitorId);
              yield* publishRoster();
              yield* journalRemove(saved.monitorId);
              if (allowed === "denied" && !stopped)
                yield* reportLost(saved, "stopped", "This thread no longer allows shell monitors.");
              yield* notifySettled(saved.threadId);
              return;
            }
            yield* lock.withPermit(
              Effect.gen(function* () {
                if (
                  recoverable.get(saved.monitorId) !== saved ||
                  (generations.get(saved.threadId) ?? 0) !== (saved.generation ?? 0)
                )
                  return;
                if (saved.completion === undefined) yield* jobs.release(saved.job!);
                yield* followDurable({ ...saved, job: saved.job! });
              }),
            );
            return;
          }
          if (allowed === "gone") {
            recoverable.delete(saved.monitorId);
            yield* publishRoster();
            yield* journalRemove(saved.monitorId);
            yield* notifySettled(saved.threadId);
            return;
          }
          if (saved.completion !== undefined && allowed === "ok") {
            recoverable.delete(saved.monitorId);
            const { summary, detail, outcome } = saved.completion;
            yield* publishWatcherEvent(saved, summary, detail, outcome);
            return;
          }
          if (saved.restartable && allowed === "ok" && !expired) {
            const relaunched = yield* start({
              command: saved.command,
              description: saved.description,
              ...(saved.timeoutMs === null ? {} : { timeoutMs: saved.timeoutMs }),
              persistent: saved.persistent,
              restartable: true,
              ...(saved.silenceMs === null ? {} : { silenceMs: saved.silenceMs }),
              ...(saved.wakeOn === undefined ? {} : { wakeOn: saved.wakeOn }),
              ...(saved.expectMinutes === undefined ? {} : { expectMinutes: saved.expectMinutes }),
              threadId: saved.threadId,
              cwd: saved.cwd,
              requestNamespace: "restart",
              resume: saved,
            }).pipe(
              Effect.as(true),
              Effect.catch((error) =>
                Effect.logWarning("Could not relaunch a monitor after restart", {
                  monitorId: saved.monitorId,
                  reason: error.reason,
                }).pipe(Effect.as(false)),
              ),
            );
            if (relaunched) return;
          }
          recoverable.delete(saved.monitorId);
          yield* publishRoster();
          yield* journalRemove(saved.monitorId);
          yield* reportLost(
            saved,
            expired
              ? "ended: the server restarted, and its time limit passed while it was down"
              : "ended: the server restarted before it reported a result",
            expired
              ? "Check the job's state yourself."
              : saved.restartable && allowed === "denied"
                ? "It was not relaunched because this thread no longer allows shell monitors. Check the job's state yourself."
                : saved.restartable
                  ? "Relaunching it failed. Check the job's state and start it again if you still need it."
                  : "Check the job's state and start it again if you still need it; restartable:true relaunches a read-only wait by itself.",
          );
        });
        yield* recoverEntry.pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("Could not recover monitor; retaining it for retry", {
                monitorId: saved.monitorId,
                cause,
              });
              recoveryRetries.add(saved.monitorId);
              yield* recoverEntry.pipe(
                Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ times: 2 }))),
                Effect.delay("1 second"),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Monitor recovery retries failed", {
                    monitorId: saved.monitorId,
                    cause,
                  }),
                ),
                Effect.ensuring(Effect.sync(() => recoveryRetries.delete(saved.monitorId))),
                Effect.forkIn(serviceScope),
              );
            }),
          ),
        );
      }
    }).pipe(Effect.withSpan("MonitorService.recover"));

  yield* ownership.register("monitor", {
    query: (query) =>
      Effect.suspend(() => {
        // Cleanup can't trust an unreadable journal, but Stop still stops what is known.
        if (journalUnavailable && query.pinsOnly === true)
          return Effect.fail(new MonitorError({ reason: "storage" }));
        const resource = (
          monitorId: string,
          threadId: ThreadId,
          cwd: string,
          state: ExecutionResources.ExecutionResource["state"],
          cleanupPin = true,
        ): ExecutionResources.ExecutionResource => ({
          id: monitorId,
          owner: { threadId, taskId: monitorId },
          workspace: { type: "local", cwd },
          state,
          cleanupPin,
          stop: { type: "monitor", monitorId },
        });
        return Effect.succeed([
          ...[...startingCwds.values()].map((entry, index) =>
            resource(`admission:${index}`, entry.threadId, entry.cwd, "admitted"),
          ),
          ...[...recoverable.values()].map((entry) =>
            resource(
              entry.monitorId,
              entry.threadId,
              entry.cwd,
              entry.stopRequested === true ? "stopping" : "recovering",
              entry.completion === undefined,
            ),
          ),
          ...[...running.values()].map((entry) =>
            resource(
              entry.info.monitorId,
              entry.info.threadId,
              entry.cwd,
              "running",
              journal.get(entry.info.monitorId)?.completion === undefined,
            ),
          ),
        ]);
      }),
    stop: (_, request) =>
      Effect.gen(function* () {
        yield* stopThread(request.threadId);
        if (
          [...recoverable.values()].some(
            (entry) => entry.threadId === request.threadId && entry.stopRequested === true,
          )
        ) {
          return yield* new MonitorError({ reason: "stop" });
        }
      }),
  });

  return MonitorService.of({
    start,
    recover,
    stop,
    stopThread,
    list: (threadId) =>
      SubscriptionRef.get(roster).pipe(
        Effect.map((entries) => entries.filter((entry) => entry.threadId === threadId)),
      ),
    stream: (threadId) =>
      SubscriptionRef.changes(roster).pipe(
        Stream.map((entries) => entries.filter((entry) => entry.threadId === threadId)),
        Stream.changesWith(
          (left, right) =>
            left.length === right.length &&
            left.every(
              (entry, index) =>
                entry.monitorId === right[index]?.monitorId &&
                entry.state === right[index]?.state &&
                entry.output === right[index]?.output,
            ),
        ),
      ),
    hasOpenWork,
    ownsCwd: (directory) => {
      const root = pathService.resolve(directory);
      const contains = (cwd: string) => {
        const relative = pathService.relative(root, pathService.resolve(cwd));
        return (
          relative === "" ||
          (relative !== ".." &&
            !relative.startsWith(`..${pathService.sep}`) &&
            !pathService.isAbsolute(relative))
        );
      };
      return (
        [...startingCwds.values()].some((entry) => contains(entry.cwd)) ||
        [...running.values()].some((entry) => contains(entry.cwd)) ||
        [...recoverable.values()].some(
          (entry) =>
            entry.job !== undefined && entry.completion === undefined && contains(entry.cwd),
        )
      );
    },
    acknowledge: (event) =>
      Effect.gen(function* () {
        if (!pending.delete(eventKey(event))) return;
        const saved = journal.get(event.monitorId);
        if (saved?.completion !== undefined && saved.sequence === event.sequence) {
          if (saved.job !== undefined) {
            const now = yield* Clock.currentTimeMillis;
            yield* Effect.tryPromise(() => markJobLogDelivered(saved.job!.logPath, now)).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Could not record delivered job log retention", { cause }),
              ),
            );
          }
          yield* journalRemove(event.monitorId);
        }
        yield* notifySettled(event.threadId);
      }),
    settled: Stream.fromQueue(settled),
    events: Stream.fromQueue(events),
    canDeliver: (event) => event.generation === (generations.get(event.threadId) ?? 0),
  });
});

export const layerWithJobs = Layer.effect(MonitorService, make).pipe(
  Layer.provideMerge(ExecutionResources.layer),
);
export const layer = layerWithJobs.pipe(Layer.provide(DurableJobProcess.layer));
