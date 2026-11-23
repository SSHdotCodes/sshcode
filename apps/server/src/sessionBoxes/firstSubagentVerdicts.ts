/**
 * The user's answers on a chat's first subagent, kept as labels for tuning the
 * subagent rules. Saved in first-subagent-verdicts.json in the state dir, newest
 * last; only the latest MAX_VERDICTS are kept.
 */
import {
  ChatControlsError,
  FirstSubagentVerdict,
  type FirstSubagentVerdictInput,
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

import * as ServerConfig from "../config.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ChatControls } from "./chatControls.ts";

export const VERDICTS_FILE = "first-subagent-verdicts.json";
export const MAX_VERDICTS = 1000;

const Side = Schema.Struct({ instanceId: Schema.String, model: Schema.NullOr(Schema.String) });
const VerdictRecord = Schema.Struct({
  threadId: Schema.String,
  taskId: Schema.String,
  verdict: FirstSubagentVerdict,
  lead: Side,
  child: Side,
  at: Schema.String,
});
export type VerdictRecord = typeof VerdictRecord.Type;
const VerdictsFile = Schema.Struct({
  version: Schema.Literal(1),
  verdicts: Schema.Array(VerdictRecord),
});
const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(VerdictsFile));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(VerdictsFile));

export class FirstSubagentVerdicts extends Context.Service<
  FirstSubagentVerdicts,
  {
    /** Saves the label and closes the ask. A chat that already answered is left alone. */
    readonly answer: (input: FirstSubagentVerdictInput) => Effect.Effect<void, ChatControlsError>;
  }
>()("t3/sessionBoxes/firstSubagentVerdicts") {}

const failure = (message: string) => (cause: unknown) => new ChatControlsError({ message, cause });

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const chatControls = yield* ChatControls;
  const projections = yield* ProjectionStoreV2;
  const filePath = path.join(config.stateDir, VERDICTS_FILE);
  const lock = yield* Semaphore.make(1);

  // An unreadable file is set aside, never overwritten.
  const readVerdicts = fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeFile),
    Effect.map((file) => file.verdicts),
    Effect.catchIf(
      (cause) => cause._tag === "PlatformError" && cause.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read first-subagent verdicts; starting a new file.", {
        cause,
      }).pipe(
        Effect.andThen(fs.rename(filePath, `${filePath}.unreadable`)),
        Effect.mapError(failure("Could not set aside the unreadable verdicts file.")),
        Effect.as([] as ReadonlyArray<VerdictRecord>),
      ),
    ),
  );

  const answer = Effect.fn("FirstSubagentVerdicts.answer")(function* (
    input: FirstSubagentVerdictInput,
  ) {
    if (chatControls.firstSubagentAnswered(input.threadId)) return;
    const projection = yield* projections
      .getThreadRecords(input.threadId, ["subagents"])
      .pipe(Effect.mapError(failure("Could not read this chat.")));
    const task = projection.subagents.find(
      (candidate) => candidate.id === input.taskId && candidate.origin === "app_owned",
    );
    if (task === undefined)
      return yield* new ChatControlsError({ message: "This chat has no such subagent." });
    const parentRun =
      task.runId === null
        ? undefined
        : (yield* projections
            .getThreadRecords(input.threadId, ["runs"], { runIds: [task.runId] })
            .pipe(Effect.mapError(failure("Could not read this chat.")))).runs[0];
    const lead = parentRun?.modelSelection ?? projection.thread.modelSelection;
    const record: VerdictRecord = {
      threadId: input.threadId,
      taskId: input.taskId,
      verdict: input.verdict,
      lead: { instanceId: lead.instanceId, model: lead.model },
      child: {
        instanceId: task.modelSelection?.instanceId ?? task.providerInstanceId,
        model: task.modelSelection?.model ?? task.model,
      },
      at: DateTime.formatIso(yield* DateTime.now),
    };
    const verdicts = [...(yield* readVerdicts), record].slice(-MAX_VERDICTS);
    const contents = yield* encodeFile({ version: 1, verdicts }).pipe(
      Effect.mapError(failure("Could not encode first-subagent verdicts.")),
    );
    yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.mapError(failure("Could not save first-subagent verdicts.")),
    );
    chatControls.answerFirstSubagent(input.threadId, input.verdict);
  });

  return FirstSubagentVerdicts.of({
    answer: (input) => lock.withPermits(1)(answer(input)),
  });
});

export const layer = Layer.effect(FirstSubagentVerdicts, make);
