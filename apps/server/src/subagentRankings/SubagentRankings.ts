import {
  NodeId,
  SubagentGrade,
  SubagentRankingsError,
  SubagentRankingsSnapshot,
  type SubagentThumb,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ServerConfig from "../config.ts";
import {
  MAX_RUNS,
  attachGrades,
  currentRuns,
  RankingsState,
  RecordedGrade,
  rankingsSnapshot,
  retainRuns,
  type RunRecord,
  withFollowUp,
} from "./records.ts";

export interface FinishedFollowUp {
  readonly taskId: NodeId;
  readonly runTaskId: NodeId;
  readonly outcome: RunRecord["outcome"];
  readonly finishedAt: number;
}

export class SubagentRankings extends Context.Service<
  SubagentRankings,
  {
    readonly grade: (
      taskId: NodeId,
      grade: SubagentGrade,
    ) => Effect.Effect<void, SubagentRankingsError>;
    /**
     * MCP grades may arrive before the terminal projection hook records the run; those wait.
     * A follow-up's grade names its original run in `runTaskId`, which was recorded when the
     * original finished, so one without a retained run is returned as unmatched.
     */
    readonly gradeMany: (
      grades: ReadonlyArray<
        RecordedGrade & { readonly taskId: NodeId; readonly runTaskId?: NodeId }
      >,
    ) => Effect.Effect<{ readonly unmatched: ReadonlyArray<NodeId> }, SubagentRankingsError>;
    /**
     * Startup: `resolve` maps waiting task ids to the run each belongs to (itself, or a
     * follow-up's original); waiting grades whose run is retained are attached.
     */
    readonly attachPending: <E>(
      resolve: (taskIds: ReadonlyArray<NodeId>) => Effect.Effect<ReadonlyMap<NodeId, NodeId>, E>,
    ) => Effect.Effect<
      { readonly attached: number; readonly remaining: number },
      SubagentRankingsError | E
    >;
    /** A follow-up's thumb lands on the original run `runTaskId` names, like its grade. */
    readonly toggleThumb: (
      taskId: NodeId,
      thumb: SubagentThumb,
      runTaskId?: NodeId,
    ) => Effect.Effect<void, SubagentRankingsError>;
    readonly subscribe: () => Stream.Stream<SubagentRankingsSnapshot>;
    readonly getSnapshot: () => Effect.Effect<SubagentRankingsSnapshot>;
    /**
     * Projection hook, awaited after commit and before publishing the terminal event.
     * Finished follow-ups land on their original run; one whose run is not retained is dropped.
     */
    readonly record: (
      runs: ReadonlyArray<RunRecord>,
      followUps?: ReadonlyArray<FinishedFollowUp>,
    ) => Effect.Effect<void, SubagentRankingsError>;
  }
>()("t3/subagentRankings/SubagentRankings") {}

const codec = Schema.fromJsonString(RankingsState);
const decode = Schema.decodeEffect(codec);
const encode = Schema.encodeEffect(codec);
const decodeGrade = Schema.decodeUnknownEffect(SubagentGrade);
const decodeGrades = Schema.decodeEffect(
  Schema.Array(
    Schema.Struct({
      taskId: NodeId,
      runTaskId: Schema.optionalKey(NodeId),
      ...RecordedGrade.fields,
    }),
  ),
);
const sameState = Schema.toEquivalence(RankingsState);
const sameSnapshot = Schema.toEquivalence(SubagentRankingsSnapshot);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "subagent-rankings.json");
  let writable = true;
  const empty: RankingsState = { version: 2, runs: [] };
  const initial = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decode),
    Effect.catchIf(
      (cause) => cause._tag === "PlatformError" && cause.reason._tag === "NotFound",
      () => Effect.succeed(empty),
    ),
    Effect.catch((cause) =>
      Effect.gen(function* () {
        yield* Effect.logWarning(
          "Could not read subagent rankings; preserving the original file.",
          { cause },
        );
        const preserved = yield* Effect.gen(function* () {
          const existing = new Set(yield* fs.readDirectory(config.stateDir));
          let suffix = 0;
          let name = "subagent-rankings.json.unreadable";
          while (existing.has(name)) name = `subagent-rankings.json.unreadable.${++suffix}`;
          yield* fs.rename(filePath, path.join(config.stateDir, name));
          return true;
        }).pipe(Effect.orElseSucceed(() => false));
        // A failed rename must never allow the next completion to overwrite corrupt data.
        writable = preserved;
        return empty;
      }),
    ),
  );
  let current: RankingsState = {
    version: 2,
    runs: retainRuns(currentRuns(initial)),
    ...(initial.pendingGrades === undefined
      ? {}
      : { pendingGrades: initial.pendingGrades.slice(-MAX_RUNS) }),
  };
  const now = () => DateTime.now.pipe(Effect.map(DateTime.toEpochMillis));
  const snapshotAt = (time: number) => rankingsSnapshot(current.runs, time, current.pendingGrades);
  const published = yield* SubscriptionRef.make(snapshotAt(yield* now()));
  const lock = yield* Semaphore.make(1);
  const refresh = Effect.fnUntraced(function* () {
    const snapshot = snapshotAt(yield* now());
    if (!sameSnapshot(snapshot, yield* SubscriptionRef.get(published)))
      yield* SubscriptionRef.set(published, snapshot);
    return snapshot;
  });
  const save = Effect.fnUntraced(function* (next: RankingsState) {
    if (sameState(current, next)) return;
    if (!writable)
      return yield* new SubagentRankingsError({
        operation: "write",
        message:
          "Subagent rankings are read-only because the original file could not be preserved.",
      });
    const contents = yield* encode(next).pipe(
      Effect.mapError(
        (cause) =>
          new SubagentRankingsError({
            operation: "write",
            message: "Could not encode subagent rankings.",
            cause,
          }),
      ),
    );
    yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(
        (cause) =>
          new SubagentRankingsError({
            operation: "write",
            message: "Could not save subagent rankings.",
            cause,
          }),
      ),
    );
    current = next;
    yield* refresh();
  });
  const commit = (
    runs: ReadonlyArray<RunRecord>,
    pending: NonNullable<RankingsState["pendingGrades"]>,
  ) => {
    const attached = attachGrades(runs, pending);
    const waiting = attached.unattached.slice(-MAX_RUNS);
    return save({
      version: 2,
      runs: attached.runs,
      ...(waiting.length ? { pendingGrades: waiting } : {}),
    }).pipe(Effect.as(attached.unattached));
  };
  const update = (
    change: (
      runs: ReadonlyArray<RunRecord>,
    ) => Effect.Effect<ReadonlyArray<RunRecord>, SubagentRankingsError>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const changed = yield* change(current.runs);
        yield* commit(changed, current.pendingGrades ?? []);
      }).pipe(Effect.uninterruptible),
    );
  const notRanked = (operation: "grade" | "thumb") =>
    Effect.fail(new SubagentRankingsError({ operation, message: "Not ranked." }));
  const feedback = (
    taskId: NodeId,
    operation: "grade" | "thumb",
    change: (run: RunRecord) => RunRecord,
  ) =>
    update((runs) => {
      if (!runs.some((r) => r.taskId === taskId)) return notRanked(operation);
      return Effect.succeed(runs.map((r) => (r.taskId === taskId ? change(r) : r)));
    });
  const toggle = <A extends { readonly thumb?: SubagentThumb }>(turn: A, thumb: SubagentThumb) => {
    const { thumb: previous, ...rest } = turn;
    return (previous === thumb ? rest : { ...rest, thumb }) as A;
  };
  return SubagentRankings.of({
    grade: Effect.fn("SubagentRankings.grade")(function* (taskId, grade) {
      const checked = yield* decodeGrade(grade).pipe(
        Effect.mapError(
          (cause) =>
            new SubagentRankingsError({
              operation: "grade",
              message: "Grade must be 1–10 with a note of at most 80 characters.",
              cause,
            }),
        ),
      );
      yield* feedback(taskId, "grade", (run) => ({ ...run, grade: checked }));
    }),
    gradeMany: (grades) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const checked = yield* decodeGrades(grades).pipe(
            Effect.mapError(
              (cause) =>
                new SubagentRankingsError({ operation: "grade", message: "Invalid grade.", cause }),
            ),
          );
          const retained = new Set(current.runs.map((run) => run.taskId));
          const unmatched = checked.filter(
            (grade) =>
              grade.runTaskId !== undefined &&
              grade.runTaskId !== grade.taskId &&
              !retained.has(grade.runTaskId),
          );
          const incoming = checked.filter((grade) => !unmatched.includes(grade));
          const replaced = new Set(incoming.map((grade) => grade.taskId));
          yield* commit(current.runs, [
            ...(current.pendingGrades ?? []).filter((grade) => !replaced.has(grade.taskId)),
            ...incoming,
          ]);
          return { unmatched: unmatched.map((grade) => grade.taskId) };
        }).pipe(Effect.uninterruptible),
      ),
    attachPending: (resolve) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const pending = current.pendingGrades ?? [];
          const unresolved = pending.filter((grade) => grade.runTaskId === undefined);
          if (unresolved.length === 0) return { attached: 0, remaining: pending.length };
          const runFor = yield* resolve(unresolved.map((grade) => grade.taskId));
          const remaining = yield* commit(
            current.runs,
            pending.map((grade) => {
              const runTaskId = grade.runTaskId ?? runFor.get(grade.taskId);
              return runTaskId === undefined || runTaskId === grade.taskId
                ? grade
                : { ...grade, runTaskId };
            }),
          );
          return { attached: pending.length - remaining.length, remaining: remaining.length };
        }).pipe(Effect.uninterruptible),
      ),
    toggleThumb: (taskId, thumb, runTaskId) =>
      update((runs) => {
        if (runs.some((run) => run.taskId === taskId))
          return Effect.succeed(
            runs.map((run) => (run.taskId === taskId ? toggle(run, thumb) : run)),
          );
        const original =
          runs.find((run) => run.followUps?.some((followUp) => followUp.taskId === taskId)) ??
          (runTaskId === undefined || runTaskId === taskId
            ? undefined
            : runs.find((run) => run.taskId === runTaskId));
        if (original === undefined) return notRanked("thumb");
        return Effect.succeed(
          runs.map((run) =>
            run === original
              ? withFollowUp(run, taskId, (followUp) => toggle(followUp, thumb))
              : run,
          ),
        );
      }),
    record: (runs, followUps = []) =>
      runs.length === 0 && followUps.length === 0
        ? Effect.void
        : update((existing) => {
            const byId = new Map(existing.map((run) => [run.taskId, run]));
            for (const run of runs) {
              const previous = byId.get(run.taskId);
              byId.set(run.taskId, { ...previous, ...run });
            }
            for (const { taskId, runTaskId, outcome, finishedAt } of followUps) {
              const original = byId.get(runTaskId);
              if (original === undefined) continue;
              byId.set(
                runTaskId,
                withFollowUp(original, taskId, (followUp) => ({
                  ...followUp,
                  outcome,
                  finishedAt,
                })),
              );
            }
            return Effect.succeed(retainRuns([...byId.values()]));
          }),
    getSnapshot: () => lock.withPermits(1)(refresh()),
    subscribe: () =>
      Stream.unwrap(
        lock
          .withPermits(1)(refresh())
          .pipe(Effect.as(SubscriptionRef.changes(published))),
      ),
  });
});

export const layer = Layer.effect(SubagentRankings, make);
