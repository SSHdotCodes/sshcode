import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, describe, expect, it } from "@effect/vitest";
import { type OrchestrationV2DomainEvent, type ServerSettings, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import {
  LIVE_PROGRESS_PACE_FILE,
  LiveProgress,
  PACE_MODELS_MAX,
  PACE_SAMPLES_PER_MODEL,
  layer,
  layerReactor,
  paceForModel,
  recordPaceSamples,
} from "./LiveProgress.ts";
import { liveProgressFor, resetLiveProgressStoreForTest } from "./liveProgressStore.ts";

const MINUTE = 60_000;
const THREAD = ThreadId.make("thread-pace");

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "live-progress-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => resetLiveProgressStoreForTest({ enabled: true }));

describe("pace history", () => {
  it("keeps the newest samples per model and drops the model updated longest ago", () => {
    const models = new Map<
      string,
      { samples: Array<readonly [number, number]>; updatedAt: number }
    >();
    for (let index = 0; index < PACE_SAMPLES_PER_MODEL + 5; index++)
      recordPaceSamples(models, "model-a", [{ estimatedMinutes: 1, actualMinutes: index }], index);
    expect(models.get("model-a")?.samples).toHaveLength(PACE_SAMPLES_PER_MODEL);
    expect(models.get("model-a")?.samples[0]).toEqual([1, 5]);

    for (let index = 0; index < PACE_MODELS_MAX; index++)
      recordPaceSamples(
        models,
        `model-${index}`,
        [{ estimatedMinutes: 2, actualMinutes: 2 }],
        100 + index,
      );
    expect(models.size).toBe(PACE_MODELS_MAX);
    // model-a was touched at 24, before every other model.
    expect(models.has("model-a")).toBe(false);
    expect(paceForModel(models, "unknown")).toBe(1);

    // Non-finite samples must be ignored rather than polluting the JSON file with null.
    recordPaceSamples(
      models,
      "bad-model",
      [
        { estimatedMinutes: Number.POSITIVE_INFINITY, actualMinutes: 2 },
        { estimatedMinutes: 2, actualMinutes: Number.POSITIVE_INFINITY },
        { estimatedMinutes: Number.NaN, actualMinutes: 2 },
      ],
      999,
    );
    expect(models.has("bad-model")).toBe(false);
  });
});

describe("LiveProgress", () => {
  it.effect("learns a model's pace from finished stages and keeps it across restarts", () =>
    Effect.gen(function* () {
      const service = yield* LiveProgress.pipe(Effect.provide(layer));
      const stage = (status: "active" | "done") => ({
        stages: [{ title: "Build", status, minutes: 5 }],
      });
      yield* service.report({
        threadId: THREAD,
        model: "slow-model",
        workStartedAt: 0,
        report: stage("active"),
      });
      yield* TestClock.adjust(20 * MINUTE);
      yield* service.report({
        threadId: THREAD,
        model: "slow-model",
        workStartedAt: 0,
        report: stage("done"),
      });

      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const saved = JSON.parse(
        yield* fs.readFileString(path.join(config.stateDir, LIVE_PROGRESS_PACE_FILE)),
      );
      expect(saved.models["slow-model"].samples).toEqual([[5, 20]]);

      // A fresh service reads the file; the next estimate for that model runs slower.
      const reopened = yield* LiveProgress.pipe(Effect.provide(layer));
      yield* reopened.report({
        threadId: THREAD,
        model: "slow-model",
        workStartedAt: 0,
        report: { stages: [{ title: "Ship", status: "pending", minutes: 10 }] },
      });
      // (15 + 20) / (15 + 5) = 1.75
      expect(liveProgressFor(THREAD)?.pace).toBeCloseTo(1.75);
      expect(liveProgressFor(THREAD)?.etaAt).toBe(20 * MINUTE + 17.5 * MINUTE);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "recovers from corrupt pace files, enforces caps on load, and serializes concurrent writes",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const pacePath = path.join(config.stateDir, LIVE_PROGRESS_PACE_FILE);
        yield* fs.makeDirectory(config.stateDir, { recursive: true });

        // Corrupt JSON falls back cleanly to pace 1 and overwrites on next save.
        yield* fs.writeFileString(pacePath, "{not valid json");
        const fromCorrupt = yield* LiveProgress.pipe(Effect.provide(layer));
        yield* fromCorrupt.report({
          threadId: THREAD,
          model: "m-recover",
          workStartedAt: 0,
          report: { stages: [{ title: "Step", status: "active", minutes: 4 }] },
        });
        expect(liveProgressFor(THREAD)?.pace).toBeUndefined();

        // Oversized file with invalid samples is filtered and clamped on load.
        const bigModels: Record<string, { samples: Array<[number, number]>; updatedAt: number }> =
          {};
        for (let i = 0; i < PACE_MODELS_MAX + 10; i += 1) {
          bigModels[`m-${i}`] = {
            samples: [
              [-5, 1],
              [0, 1],
              ...Array.from({ length: PACE_SAMPLES_PER_MODEL + 5 }, (_, s): [number, number] => [
                2,
                s + 1,
              ]),
            ],
            updatedAt: i,
          };
        }
        yield* fs.writeFileString(pacePath, JSON.stringify({ version: 1, models: bigModels }));
        const fromOversized = yield* LiveProgress.pipe(Effect.provide(layer));
        // Concurrent reports serialize cleanly and write a bounded file.
        yield* Effect.all(
          Array.from({ length: 4 }, (_, idx) => {
            const tid = ThreadId.make(`thread-concurrent-${idx}`);
            return Effect.gen(function* () {
              yield* fromOversized.report({
                threadId: tid,
                model: `concurrent-${idx}`,
                workStartedAt: 0,
                report: { stages: [{ title: "Work", status: "active", minutes: 5 }] },
              });
              yield* fromOversized.report({
                threadId: tid,
                model: `concurrent-${idx}`,
                workStartedAt: 0,
                report: { stages: [{ title: "Work", status: "done", minutes: 5 }] },
              });
            });
          }),
          { concurrency: "unbounded" },
        );
        const saved = JSON.parse(yield* fs.readFileString(pacePath)) as {
          models: Record<string, { samples: Array<[number, number]> }>;
        };
        expect(Object.keys(saved.models).length).toBeLessThanOrEqual(PACE_MODELS_MAX);
        for (const entry of Object.values(saved.models)) {
          expect(entry.samples.length).toBeLessThanOrEqual(PACE_SAMPLES_PER_MODEL);
          for (const [est, act] of entry.samples) {
            expect(est).toBeGreaterThan(0);
            expect(act).toBeGreaterThanOrEqual(0);
          }
        }
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

describe("layerReactor", () => {
  it.effect("turns a running run's todo list into progress once token use is High", () =>
    Effect.gen(function* () {
      resetLiveProgressStoreForTest();
      const done = yield* Deferred.make<void>();
      const settingsRead = yield* Deferred.make<void>();
      const at = DateTime.makeUnsafe(10 * MINUTE);
      const run = {
        id: "run-1",
        threadId: THREAD,
        status: "running",
        requestedAt: DateTime.makeUnsafe(0),
        startedAt: DateTime.makeUnsafe(MINUTE),
      };
      const events = [
        { type: "run.updated", threadId: THREAD, occurredAt: at, payload: run },
        {
          type: "turn-item.updated",
          threadId: THREAD,
          occurredAt: at,
          payload: {
            type: "todo_list",
            threadId: THREAD,
            runId: "run-1",
            steps: [
              { id: "a", text: "Read", status: "completed", durationMs: 2 * MINUTE },
              { id: "b", text: "Write", status: "running" },
            ],
          },
        },
        // A todo list from an older run of the chat is not this work's.
        {
          type: "turn-item.updated",
          threadId: THREAD,
          occurredAt: at,
          payload: { type: "todo_list", threadId: THREAD, runId: "run-0", steps: [] },
        },
      ] as unknown as ReadonlyArray<OrchestrationV2DomainEvent>;
      const dependencies = Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromIterable(events).pipe(
            Stream.ensuring(Deferred.succeed(done, undefined)),
          ),
        }),
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed({ agentBehavior: { tokens: "high" } } as ServerSettings),
          // Ends right after the first value is applied.
          subscribeChanges: Effect.succeed(
            Stream.empty.pipe(Stream.ensuring(Deferred.succeed(settingsRead, undefined))),
          ),
        }),
      );
      yield* Layer.build(layerReactor.pipe(Layer.provide(dependencies)));
      yield* Deferred.await(done);
      yield* Deferred.await(settingsRead);
      expect(liveProgressFor(THREAD)).toMatchObject({
        source: "todo",
        startedAt: MINUTE,
        stages: [
          { title: "Read", status: "done", durationMs: 2 * MINUTE },
          { title: "Write", status: "active", startedAt: 10 * MINUTE },
        ],
        percent: 50,
      });
    }).pipe(Effect.scoped),
  );
});
