import {
  ScheduledTaskError,
  ScheduledTaskId,
  ScheduledTaskRunRecord,
  ScheduledTaskWebhookDeliveryId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ServerConfig from "../config.ts";

export const PendingWebhookDelivery = Schema.Struct({
  deliveryId: ScheduledTaskWebhookDeliveryId,
  taskId: ScheduledTaskId,
  taskCreatedAt: Schema.String,
  receivedAt: Schema.String,
  relayDeliveryId: Schema.NullOr(Schema.String),
  prompt: Schema.String,
});
export type PendingWebhookDelivery = typeof PendingWebhookDelivery.Type;

const StoredState = Schema.Struct({
  version: Schema.Literal(1),
  deliveries: Schema.Array(PendingWebhookDelivery),
  runs: Schema.Array(ScheduledTaskRunRecord),
});
type StoredState = typeof StoredState.Type;
const decodeStored = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredState));
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredState));

export class ScheduledTaskState extends Context.Service<
  ScheduledTaskState,
  {
    readonly read: Effect.Effect<StoredState>;
    readonly update: (
      f: (state: StoredState) => StoredState,
    ) => Effect.Effect<StoredState, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskState") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "scheduled-task-state.json");
  const initial = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeStored),
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed<StoredState>({ version: 1, deliveries: [], runs: [] }),
    ),
    Effect.mapError(
      (cause) => new ScheduledTaskError({ message: "Could not load scheduled task state.", cause }),
    ),
  );
  const state = yield* Ref.make(initial);
  const lock = yield* Semaphore.make(1);
  return ScheduledTaskState.of({
    read: Ref.get(state),
    update: (f) =>
      Effect.gen(function* () {
        const previous = yield* Ref.get(state);
        const next = f(previous);
        if (next === previous) return next;
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* fs.makeDirectory(config.stateDir, { recursive: true });
            const directory = yield* fs.makeTempDirectoryScoped({
              directory: config.stateDir,
              prefix: "scheduled-task-state-",
            });
            const temporary = path.join(directory, "state.json");
            const contents = yield* encodeStored(next);
            yield* fs.writeFileString(temporary, `${contents}\n`, { mode: 0o600 });
            yield* fs.rename(temporary, filePath);
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ScheduledTaskError({ message: "Could not save scheduled task state.", cause }),
          ),
        );
        yield* Ref.set(state, next);
        return next;
      }).pipe(lock.withPermits(1), Effect.uninterruptible),
  });
});

export const layer = Layer.effect(ScheduledTaskState, make);
