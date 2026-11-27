/**
 * Live progress for Settings > Agents token use High (see liveProgressStore.ts).
 *
 * `LiveProgress` takes `report_progress` calls and learns each model's pace: how long its stages
 * really took against the minutes it estimated. The pace lives in progress-pace.json in the
 * state dir, bounded per model and in models, so estimates improve across restarts.
 *
 * `layerReactor` follows the orchestrator: a run of new work clears old progress, a todo or plan
 * list becomes fallback stages, and the token level decides whether shells carry any of it.
 */
import {
  agentBehaviorLevels,
  orchestrationV2RunWorkStartedAt,
  type ReportProgressInput,
  type ThreadId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import { liveProgressPace, type LiveProgressPaceSample } from "@t3tools/shared/liveProgress";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  applyLiveProgressReport,
  applyLiveProgressTodo,
  beginLiveProgressWork,
  forgetLiveProgress,
  liveProgressWorkStart,
  setLiveProgressEnabled,
} from "./liveProgressStore.ts";

export const LIVE_PROGRESS_PACE_FILE = "progress-pace.json";
/** Finished stages remembered per model; older ones stop counting. */
export const PACE_SAMPLES_PER_MODEL = 20;
/** Models remembered; the one updated longest ago is dropped first. */
export const PACE_MODELS_MAX = 50;
const MODEL_KEY_MAX = 120;

const PaceFile = Schema.Struct({
  version: Schema.Literal(1),
  models: Schema.Record(
    Schema.String,
    Schema.Struct({
      /** [estimated minutes, actual minutes], oldest first. */
      samples: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
      updatedAt: Schema.Number,
    }),
  ),
});
type PaceFile = typeof PaceFile.Type;
const paceCodec = Schema.fromJsonString(PaceFile);
const decodePace = Schema.decodeUnknownEffect(paceCodec);
const encodePace = Schema.encodeEffect(paceCodec);

type PaceModels = Map<string, { samples: Array<readonly [number, number]>; updatedAt: number }>;

/** Adds finished stages to a model's history, within the per-model and model caps. */
export function recordPaceSamples(
  models: PaceModels,
  model: string,
  samples: ReadonlyArray<LiveProgressPaceSample>,
  nowMs: number,
) {
  if (!Number.isFinite(nowMs)) return;
  const key = model.slice(0, MODEL_KEY_MAX);
  const existing = models.get(key);
  const valid: Array<readonly [number, number]> = [];
  for (const sample of samples) {
    if (
      !Number.isFinite(sample.estimatedMinutes) ||
      !Number.isFinite(sample.actualMinutes) ||
      !(sample.estimatedMinutes > 0) ||
      !(sample.actualMinutes >= 0)
    )
      continue;
    valid.push([sample.estimatedMinutes, sample.actualMinutes]);
  }
  if (valid.length === 0) return;
  const entry = existing ?? { samples: [], updatedAt: nowMs };
  entry.samples.push(...valid);
  entry.samples = entry.samples.slice(-PACE_SAMPLES_PER_MODEL);
  entry.updatedAt = nowMs;
  models.delete(key);
  models.set(key, entry);
  while (models.size > PACE_MODELS_MAX) {
    let oldest: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [name, value] of models) {
      if (value.updatedAt < oldestAt) {
        oldest = name;
        oldestAt = value.updatedAt;
      }
    }
    if (oldest === undefined) break;
    models.delete(oldest);
  }
}

export const paceForModel = (models: PaceModels, model: string | null) => {
  const entry = model === null ? undefined : models.get(model.slice(0, MODEL_KEY_MAX));
  return liveProgressPace(
    (entry?.samples ?? []).map(([estimatedMinutes, actualMinutes]) => ({
      estimatedMinutes,
      actualMinutes,
    })),
  );
};

export class LiveProgress extends Context.Service<
  LiveProgress,
  {
    /** One `report_progress` call from a chat's agent. */
    readonly report: (input: {
      readonly threadId: ThreadId;
      /** The calling chat's model, whose pace calibrates the estimate. */
      readonly model: string | null;
      /** The start of the chat's current work, when it has a live run. */
      readonly workStartedAt: number | null;
      readonly report: ReportProgressInput;
    }) => Effect.Effect<void>;
  }
>()("t3/liveProgress/LiveProgress") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, LIVE_PROGRESS_PACE_FILE);
  const loaded = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodePace),
    // Calibration only sharpens estimates: an unreadable file starts over at 1.
    Effect.orElseSucceed((): PaceFile => ({ version: 1, models: {} })),
  );
  const models: PaceModels = new Map();
  const loadedEntries = Object.entries(loaded.models)
    .filter(([, value]) => Number.isFinite(value.updatedAt))
    .toSorted(([, left], [, right]) => left.updatedAt - right.updatedAt);
  for (const [name, value] of loadedEntries) {
    const validSamples = value.samples
      .filter(
        ([estimatedMinutes, actualMinutes]) =>
          Number.isFinite(estimatedMinutes) &&
          Number.isFinite(actualMinutes) &&
          estimatedMinutes > 0 &&
          actualMinutes >= 0,
      )
      .slice(-PACE_SAMPLES_PER_MODEL);
    if (validSamples.length === 0) continue;
    const key = name.slice(0, MODEL_KEY_MAX);
    models.delete(key);
    models.set(key, { samples: validSamples, updatedAt: value.updatedAt });
  }
  while (models.size > PACE_MODELS_MAX) {
    const oldestKey = models.keys().next().value;
    if (oldestKey === undefined) break;
    models.delete(oldestKey);
  }
  const lock = yield* Semaphore.make(1);
  const save = Effect.gen(function* () {
    const contents = yield* encodePace({
      version: 1,
      models: Object.fromEntries(models),
    });
    yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not save progress pace", { cause })),
  );

  return LiveProgress.of({
    report: (input) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const nowMs = yield* Clock.currentTimeMillis;
          const applied = applyLiveProgressReport({
            threadId: input.threadId,
            workStartedAt: input.workStartedAt ?? liveProgressWorkStart(input.threadId) ?? nowMs,
            nowMs,
            report: input.report,
            pace: paceForModel(models, input.model),
          });
          if (applied.samples.length === 0 || input.model === null) return;
          recordPaceSamples(models, input.model, applied.samples, nowMs);
          yield* save;
        }),
      ),
  });
});

export const layer = Layer.effect(LiveProgress, make);

const LIVE_RUN_STATUSES = new Set(["starting", "running", "waiting"]);

/**
 * Follows runs and todo lists for the store, and the token level for what shells show. Each
 * chat's current run is tracked so a todo list from an older run is not taken for new work.
 */
export const layerReactor = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const settings = yield* ServerSettings.ServerSettingsService;
    const liveRuns = new Map<string, { readonly runId: string; readonly workStartedAt: number }>();

    // Subscribe before the snapshot so a change in between is not lost.
    const settingsChanges = yield* settings.subscribeChanges;
    yield* forkParked(
      Stream.concat(Stream.fromEffect(settings.getSettings), settingsChanges).pipe(
        Stream.map((value) => agentBehaviorLevels(value.agentBehavior).tokens === "high"),
        Stream.changes,
        Stream.runForEach((high) => Effect.sync(() => setLiveProgressEnabled(high))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Live progress stopped following settings", { cause }),
        ),
      ),
    );

    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        Effect.sync(() => {
          if (event.type === "run.created" || event.type === "run.updated") {
            const run = event.payload;
            if (LIVE_RUN_STATUSES.has(run.status)) {
              const workStartedAt = DateTime.toEpochMillis(orchestrationV2RunWorkStartedAt(run));
              beginLiveProgressWork(run.threadId, workStartedAt);
              liveRuns.set(run.threadId, { runId: run.id, workStartedAt });
            } else if (liveRuns.get(run.threadId)?.runId === run.id) {
              liveRuns.delete(run.threadId);
            }
            return;
          }
          if (event.type === "turn-item.updated" && event.payload.type === "todo_list") {
            const item = event.payload;
            const run = liveRuns.get(item.threadId);
            if (run !== undefined && item.runId !== null && item.runId !== run.runId) return;
            const nowMs = DateTime.toEpochMillis(event.occurredAt);
            applyLiveProgressTodo({
              threadId: item.threadId,
              workStartedAt: run?.workStartedAt ?? liveProgressWorkStart(item.threadId) ?? nowMs,
              nowMs,
              steps: item.steps,
            });
            return;
          }
          if (event.type === "thread.deleted" || event.type === "thread.archived") {
            liveRuns.delete(event.threadId);
            forgetLiveProgress(event.threadId);
          }
        }),
      ).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Live progress reactor stopped", { cause })),
      ),
    );
  }),
);
