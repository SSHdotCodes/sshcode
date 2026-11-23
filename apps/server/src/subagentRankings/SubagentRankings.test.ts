import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeId, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as Rankings from "./SubagentRankings.ts";
import {
  MAX_RUNS,
  RankingsState,
  WINDOW_MS,
  rankingsSnapshot,
  retainRuns,
  type RunRecord,
} from "./records.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "subagent-rankings-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const openService = Rankings.SubagentRankings.pipe(Effect.provide(Rankings.layer));
const decode = Schema.decodeEffect(Schema.fromJsonString(RankingsState));
const encodePublic = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const now = 1_000_000_000_000;
const run = (n = 0, extra: Partial<RunRecord> = {}): RunRecord => ({
  taskId: NodeId.make(`task-${n}`),
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  family: "codex",
  kind: "code",
  outcome: "completed",
  elapsedMs: 21 * 60000,
  fixRounds: 0,
  finishedAt: now + n,
  ...extra,
});
const filePath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  return path.join(config.stateDir, "subagent-rankings.json");
});

it("names the task kinds a model does clearly better or worse at, so leads can pick by kind", () => {
  const graded = (n: number, kind: RunRecord["kind"], score: number) =>
    run(n, { kind, grade: { score } });
  const runs = [
    ...[0, 1, 2, 3].map((n) => graded(n, "code", 9)),
    ...[4, 5, 6].map((n) => graded(n, "research", 6)),
    graded(7, "review", 8),
    graded(8, "review", 7),
  ];
  // Code 9.0 and research 6.0 against 7.7 overall. Review has only 2 grades, so it is not named.
  expect(rankingsSnapshot(runs, now + 8).models[0]?.yourRuns).toBe(
    "9 runs, 9 rated · 100% done · 7.7/10 · low grades 3/9 · 21m median · code 9.0/10 · research 6.0/10",
  );
  // Less than a point from the overall score says nothing useful.
  const close = [
    ...[0, 1, 2].map((n) => graded(n, "code", 9)),
    ...[3, 4, 5].map((n) => graded(n, "research", 8)),
  ];
  expect(rankingsSnapshot(close, now + 5).models[0]?.yourRuns).toBe(
    "6 runs, 6 rated · 100% done · 8.5/10 · 21m median",
  );
  // The same figures as numbers, for clients that compute with them.
  expect(rankingsSnapshot(close, now + 5).models[0]?.stats).toEqual({
    runs: 6,
    rated: 6,
    average: 8.5,
    completed: 6,
  });
  // An ungraded model reports no average rather than a zero.
  expect(
    rankingsSnapshot([run(0), run(1, { outcome: "failed" })], now + 2).models[0]?.stats,
  ).toEqual({ runs: 2, rated: 0, completed: 1 });
});

it("counts all four outcomes once and weights user thumbs above parent grades", () => {
  const runs = [
    run(0, { grade: { score: 1 }, thumb: "up" }),
    run(1, { outcome: "failed" }),
    run(2, { outcome: "cancelled" }),
    run(3, { outcome: "interrupted", kind: "review" }),
  ];
  const snapshot = rankingsSnapshot(runs, now + 3);
  expect(snapshot.models[0]?.yourRuns).toBe(
    "4 runs, 1 rated · 50% done · 8.2/10 · low grades 1/1 · 21m median · few runs",
  );
  // Runs stopped from outside never count against the model.
  expect(
    rankingsSnapshot(
      [run(0, { outcome: "interrupted" }), run(1, { outcome: "cancelled" })],
      now + 2,
    ).models[0]?.yourRuns,
  ).toBe("2 runs, 0 rated · 21m median · few runs");
  // Short runs read in seconds, not "0m".
  expect(rankingsSnapshot([run(0, { elapsedMs: 12_400 })], now + 1).models[0]?.yourRuns).toBe(
    "1 run, 0 rated · 100% done · 12s median · few runs",
  );
  expect(snapshot.models[0]?.byKind.map((r) => r.kind)).toEqual(["code", "review"]);
  expect(snapshot.models[0]?.byKind[1]?.yourRuns).toContain("few runs");
  expect(rankingsSnapshot([run()], now).models[0]?.yourRuns).not.toContain("/10");
  // Thumbs count toward rated runs and the score, but are not parent grades.
  expect(rankingsSnapshot([run(0, { thumb: "down" })], now).models[0]?.yourRuns).toBe(
    "1 run, 1 rated · 100% done · 1.0/10 · 21m median · few runs",
  );
});

it("counts only the last 60 days, omits old-only models and future records, and keeps feedback eligible", () => {
  const snapshot = rankingsSnapshot(
    [
      run(0, { finishedAt: now - WINDOW_MS }),
      run(1, { model: "old", finishedAt: now - WINDOW_MS - 1 }),
      run(2, { model: "future", finishedAt: now + 1 }),
    ],
    now,
  );
  expect(snapshot.models.map((m) => m.model)).toEqual(["gpt-6.1-sol"]);
  expect(snapshot.thumbs).toHaveLength(3);
  expect(snapshot.models[0]?.yourRuns).toContain("1 run, 0 rated ·");
});

it("retains the newest 3000 records regardless of arrival order", () => {
  const retained = retainRuns(Array.from({ length: MAX_RUNS + 3 }, (_, n) => run(n)).toReversed());
  expect(retained).toHaveLength(MAX_RUNS);
  expect(retained[0]?.taskId).toBe(`task-${MAX_RUNS + 2}`);
  expect(retained.at(-1)?.taskId).toBe("task-3");
});

describe("SubagentRankings", () => {
  it.effect("moves a version-1 file's 1–5 grades onto 1–10 and saves version 2", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const target = yield* filePath;
      const graded = (n: number, score: number) => ({ ...run(n), grade: { score } });
      yield* fs.writeFileString(
        target,
        JSON.stringify({ version: 1, runs: [graded(0, 1), graded(1, 4), graded(2, 5)] }),
      );
      const service = yield* openService;
      expect((yield* service.getSnapshot()).thumbs.map((t) => t.grade)).toEqual([10, 8, 1]);
      yield* service.toggleThumb(NodeId.make("task-0"), "up");
      const saved = JSON.parse(yield* fs.readFileString(target));
      expect(saved.version).toBe(2);
      expect(saved.runs.map((r: RunRecord) => r.grade?.score).toSorted()).toEqual([1, 10, 8]);
      // Reopening a version-2 file never converts again.
      expect((yield* (yield* openService).getSnapshot()).thumbs.map((t) => t.grade)).toEqual([
        10, 8, 1,
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "serializes feedback, toggles and switches thumbs, restores grades, and does not leak notes",
    () =>
      Effect.gen(function* () {
        const service = yield* openService;
        const at = DateTime.toEpochMillis(yield* DateTime.now);
        const record = run(0, { finishedAt: at });
        yield* service.record([record]);
        yield* Effect.all(
          [
            service.grade(record.taskId, { score: 2, note: "private feedback" }),
            service.toggleThumb(record.taskId, "up"),
          ],
          { concurrency: "unbounded" },
        );
        const before = yield* service.getSnapshot();
        expect(before.models[0]?.yourRuns).toContain("8.4/10");
        // The card shows the lead's score; the note never leaves the server.
        expect(before.thumbs).toEqual([{ taskId: record.taskId, thumb: "up", grade: 2 }]);
        expect(yield* (yield* openService).getSnapshot()).toEqual(before);
        yield* service.toggleThumb(record.taskId, "down");
        expect((yield* service.getSnapshot()).models[0]?.yourRuns).toContain("1.2/10");
        yield* service.toggleThumb(record.taskId, "down");
        expect((yield* service.getSnapshot()).thumbs).toEqual([
          { taskId: record.taskId, grade: 2 },
        ]);
        yield* service.record([record, record]);
        const fs = yield* FileSystem.FileSystem;
        const saved = yield* decode(yield* fs.readFileString(yield* filePath));
        expect(saved.runs).toHaveLength(1);
        expect(saved.runs[0]?.grade).toEqual({ score: 2, note: "private feedback" });
        const publicJson = yield* encodePublic(yield* service.getSnapshot());
        expect(publicJson).not.toContain("private feedback");
        expect(publicJson).not.toContain("finishedAt");
        expect(publicJson).not.toContain("fixRounds");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("validates grades and rejects unknown tasks clearly", () =>
    Effect.gen(function* () {
      const service = yield* openService;
      yield* service.record([run()]);
      for (const grade of [
        { score: 0 },
        { score: 11 },
        { score: 1.5 },
        { score: 10, note: "x".repeat(81) },
      ]) {
        expect(yield* service.grade(run().taskId, grade).pipe(Effect.flip)).toMatchObject({
          _tag: "SubagentRankingsError",
          operation: "grade",
        });
      }
      yield* service.grade(run().taskId, { score: 10, note: "x".repeat(80) });
      expect(
        yield* service.grade(NodeId.make("unknown"), { score: 3 }).pipe(Effect.flip),
      ).toMatchObject({
        operation: "grade",
        message: "This task has no retained subagent run to rate.",
      });
      expect(
        yield* service.toggleThumb(NodeId.make("unknown"), "up").pipe(Effect.flip),
      ).toMatchObject({ operation: "thumb" });
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("publishes saved snapshots and suppresses private-only or duplicate changes", () =>
    Effect.gen(function* () {
      const service = yield* openService;
      const ready = yield* Deferred.make<void>();
      const record = run(0, { finishedAt: DateTime.toEpochMillis(yield* DateTime.now) });
      const observed = yield* service.subscribe().pipe(
        Stream.tap(() => Deferred.succeed(ready, undefined)),
        Stream.take(4),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(ready);
      yield* service.record([record]);
      yield* service.grade(record.taskId, { score: 3 });
      yield* service.grade(record.taskId, { score: 3, note: "same visible score" });
      yield* service.record([{ ...record, fixRounds: 2 }]);
      yield* service.toggleThumb(record.taskId, "up");
      const snapshots = yield* Fiber.join(observed);
      expect(snapshots.map((s) => s.thumbs[0]?.thumb)).toEqual([
        undefined,
        undefined,
        undefined,
        "up",
      ]);
      expect(snapshots.at(-1)?.models[0]?.yourRuns).toContain("8.6/10");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("bounds persisted records and drops feedback for evicted records", () =>
    Effect.gen(function* () {
      const service = yield* openService;
      yield* service.record([run(0, { thumb: "up" })]);
      yield* service.record(Array.from({ length: MAX_RUNS + 1 }, (_, i) => run(i + 1)));
      const fs = yield* FileSystem.FileSystem;
      const saved = yield* decode(yield* fs.readFileString(yield* filePath));
      expect(saved.runs).toHaveLength(MAX_RUNS);
      expect(saved.runs.at(-1)?.taskId).toBe("task-2");
      expect((yield* service.getSnapshot()).thumbs.some((entry) => entry.taskId === "task-0")).toBe(
        false,
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("preserves corrupt storage and all earlier recovery copies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const target = yield* filePath;
      yield* fs.writeFileString(`${target}.unreadable`, "prior original");
      yield* fs.writeFileString(target, "{broken");
      const service = yield* openService;
      expect(yield* service.getSnapshot()).toEqual({ models: [], thumbs: [] });
      expect(yield* fs.readFileString(`${target}.unreadable`)).toBe("prior original");
      expect(yield* fs.readFileString(`${target}.unreadable.1`)).toBe("{broken");
      yield* service.record([run()]);
      expect((yield* decode(yield* fs.readFileString(target))).runs).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("never clobbers corrupt storage when its recovery rename fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const target = yield* filePath;
      yield* fs.writeFileString(target, "{irreplaceable");
      const faulty = FileSystem.FileSystem.of({
        ...fs,
        rename: () =>
          Effect.fail(
            new PlatformError.PlatformError(
              new PlatformError.SystemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "rename",
              }),
            ),
          ),
      });
      const service = yield* openService.pipe(Effect.provideService(FileSystem.FileSystem, faulty));
      expect(yield* service.record([run()]).pipe(Effect.flip)).toMatchObject({
        operation: "write",
      });
      expect(yield* fs.readFileString(target)).toBe("{irreplaceable");
      expect((yield* service.getSnapshot()).thumbs).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not publish or lose prior feedback when an atomic save fails", () =>
    Effect.gen(function* () {
      const service = yield* openService;
      const record = run();
      yield* service.record([record]);
      const before = yield* service.getSnapshot();
      const fs = yield* FileSystem.FileSystem;
      const target = yield* filePath;
      yield* fs.remove(target);
      yield* fs.makeDirectory(target);
      expect(yield* service.grade(record.taskId, { score: 5 }).pipe(Effect.flip)).toMatchObject({
        operation: "write",
      });
      expect(yield* service.getSnapshot()).toEqual(before);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

it.effect("saves a grade before its ranking record exists and applies it after reopening", () =>
  Effect.gen(function* () {
    const first = yield* openService;
    const entry = run(0, { finishedAt: DateTime.toEpochMillis(yield* DateTime.now) });
    const grader = { instanceId: ProviderInstanceId.make("claude-work"), family: "claude:opus" };
    yield* first.gradeMany([{ taskId: entry.taskId, score: 8, note: "checked", grader }]);
    const reopened = yield* openService;
    expect((yield* reopened.getSnapshot()).thumbs).toEqual([{ taskId: entry.taskId, grade: 8 }]);
    yield* reopened.record([entry]);
    expect((yield* reopened.getSnapshot()).thumbs).toEqual([{ taskId: entry.taskId, grade: 8 }]);
    const fs = yield* FileSystem.FileSystem;
    expect((yield* decode(yield* fs.readFileString(yield* filePath))).runs[0]?.grade).toEqual({
      score: 8,
      note: "checked",
      grader,
    });
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("persists a grade batch with one atomic save", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    let writes = 0;
    const service = yield* openService.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        writeFileString: (...args: Parameters<typeof fs.writeFileString>) =>
          Effect.sync(() => {
            writes++;
          }).pipe(Effect.andThen(fs.writeFileString(...args))),
      }),
    );
    yield* service.record([run(1), run(2)]);
    writes = 0;
    yield* service.gradeMany([
      { taskId: run(1).taskId, score: 8 },
      { taskId: run(2).taskId, score: 9 },
    ]);
    expect(writes).toBe(1);
    expect((yield* service.getSnapshot()).thumbs).toEqual([
      { taskId: run(2).taskId, grade: 9 },
      { taskId: run(1).taskId, grade: 8 },
    ]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it("bases few runs on distinct rated runs and counts only parent grades at or below six", () => {
  const runs = [
    run(0, { grade: { score: 6 }, thumb: "up" }),
    run(1, { grade: { score: 7 } }),
    run(2, { thumb: "down" }),
    run(3),
  ];
  const summary = rankingsSnapshot(runs, now + 3).models[0]!.yourRuns;
  expect(summary).toContain("4 runs, 3 rated");
  expect(summary).toContain("low grades 1/2");
  expect(summary).not.toContain("few runs");
  expect(rankingsSnapshot([run(0), run(1), run(2)], now + 3).models[0]!.yourRuns).toContain(
    "3 runs, 0 rated",
  );
  expect(rankingsSnapshot([run(0), run(1), run(2)], now + 3).models[0]!.yourRuns).toContain(
    "few runs",
  );
});
