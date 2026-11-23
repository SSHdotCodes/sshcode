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
  currentRuns,
  RankingsState,
  RecordedGrade,
  rankingsSnapshot,
  retainRuns,
  type RunRecord,
} from "./records.ts";

export class SubagentRankings extends Context.Service<
  SubagentRankings,
  {
    readonly grade: (
      taskId: NodeId,
      grade: SubagentGrade,
    ) => Effect.Effect<void, SubagentRankingsError>;
    /** MCP grades may arrive before the terminal projection hook records the run. */
    readonly gradeMany: (
      grades: ReadonlyArray<RecordedGrade & { readonly taskId: NodeId }>,
    ) => Effect.Effect<void, SubagentRankingsError>;
    readonly toggleThumb: (
      taskId: NodeId,
      thumb: SubagentThumb,
    ) => Effect.Effect<void, SubagentRankingsError>;
    readonly subscribe: () => Stream.Stream<SubagentRankingsSnapshot>;
    readonly getSnapshot: () => Effect.Effect<SubagentRankingsSnapshot>;
    /** Projection hook, awaited after commit and before publishing the terminal event. */
    readonly record: (runs: ReadonlyArray<RunRecord>) => Effect.Effect<void, SubagentRankingsError>;
  }
>()("t3/subagentRankings/SubagentRankings") {}

const codec = Schema.fromJsonString(RankingsState);
const decode = Schema.decodeEffect(codec);
const encode = Schema.encodeEffect(codec);
const decodeGrade = Schema.decodeUnknownEffect(SubagentGrade);
const decodeGrades = Schema.decodeEffect(
  Schema.Array(Schema.Struct({ taskId: NodeId, ...RecordedGrade.fields })),
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
  const update = (
    change: (
      runs: ReadonlyArray<RunRecord>,
    ) => Effect.Effect<ReadonlyArray<RunRecord>, SubagentRankingsError>,
  ) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const changed = yield* change(current.runs);
        const pending = new Map(
          (current.pendingGrades ?? []).map(({ taskId, ...grade }) => [taskId, grade]),
        );
        const runs = changed.map((run) => {
          const grade = pending.get(run.taskId);
          pending.delete(run.taskId);
          return grade === undefined ? run : { ...run, grade };
        });
        yield* save({
          version: 2,
          runs,
          ...(pending.size
            ? { pendingGrades: [...pending].map(([taskId, grade]) => ({ taskId, ...grade })) }
            : {}),
        });
      }).pipe(Effect.uninterruptible),
    );
  const feedback = (
    taskId: NodeId,
    operation: "grade" | "thumb",
    change: (run: RunRecord) => RunRecord,
  ) =>
    update((runs) => {
      if (!runs.some((r) => r.taskId === taskId))
        return Effect.fail(
          new SubagentRankingsError({
            operation,
            message: "This task has no retained subagent run to rate.",
          }),
        );
      return Effect.succeed(runs.map((r) => (r.taskId === taskId ? change(r) : r)));
    });
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
          const pending = new Map(
            (current.pendingGrades ?? []).map(({ taskId, ...grade }) => [taskId, grade]),
          );
          for (const { taskId, ...grade } of checked) pending.set(taskId, grade);
          const runs = current.runs.map((run) => {
            const grade = pending.get(run.taskId);
            pending.delete(run.taskId);
            return grade === undefined ? run : { ...run, grade };
          });
          yield* save({
            version: 2,
            runs,
            ...(pending.size
              ? {
                  pendingGrades: [...pending]
                    .slice(-MAX_RUNS)
                    .map(([taskId, grade]) => ({ taskId, ...grade })),
                }
              : {}),
          });
        }).pipe(Effect.uninterruptible),
      ),
    toggleThumb: (taskId, thumb) =>
      feedback(taskId, "thumb", (run) => {
        const { thumb: previous, ...rest } = run;
        return previous === thumb ? rest : { ...rest, thumb };
      }),
    record: (runs) =>
      runs.length === 0
        ? Effect.void
        : update((existing) => {
            const byId = new Map(existing.map((run) => [run.taskId, run]));
            for (const run of runs) {
              const previous = byId.get(run.taskId);
              byId.set(run.taskId, { ...previous, ...run });
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
