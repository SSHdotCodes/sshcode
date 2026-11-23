import {
  HarnessDefaultsError,
  HarnessDefaultsState,
  type HarnessDefaultsPatch,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Equal from "effect/Equal";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import { patchHarnessDefaults } from "@t3tools/shared/harnessDefaults";

export class HarnessDefaultsService extends Context.Service<
  HarnessDefaultsService,
  {
    readonly update: (operation: HarnessDefaultsPatch) => Effect.Effect<void, HarnessDefaultsError>;
    readonly get: Effect.Effect<HarnessDefaultsState>;
    readonly subscribe: () => Stream.Stream<HarnessDefaultsState>;
  }
>()("t3/harnessDefaults/HarnessDefaultsService") {}

const defaultsJson = Schema.fromJsonString(HarnessDefaultsState);
const decodeDefaults = Schema.decodeEffect(defaultsJson);
const encodeDefaults = Schema.encodeEffect(defaultsJson);

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "harness-defaults.json");
  // Defaults must never keep the server from starting: an unreadable file is set
  // aside (so nothing is lost) and defaults start empty.
  const empty: HarnessDefaultsState = { harnesses: {} };
  const initial = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap((contents) => decodeDefaults(contents)),
    Effect.catchIf(
      (cause) => cause._tag === "PlatformError" && cause.reason._tag === "NotFound",
      () => Effect.succeed(empty),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Could not read harness defaults; using harness config.", { cause }).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const existing = new Set(yield* fs.readDirectory(config.stateDir));
            const backup = `${path.basename(filePath)}.unreadable`;
            let destination = backup;
            let suffix = 0;
            while (existing.has(destination)) destination = `${backup}.${++suffix}`;
            yield* fs.rename(filePath, path.join(config.stateDir, destination));
          }).pipe(Effect.ignore),
        ),
        Effect.as(empty),
      ),
    ),
  );
  const state = yield* SubscriptionRef.make<HarnessDefaultsState>(initial);
  const lock = yield* Semaphore.make(1);

  const update = Effect.fn("HarnessDefaultsService.update")(function* (
    operation: HarnessDefaultsPatch,
  ) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const next = patchHarnessDefaults(current, operation);
        if (Equal.equals(next, current)) return;
        // A failed save leaves the published state unchanged. Cancellation cannot
        // interrupt the gap between committing the file and notifying clients.
        const contents = yield* encodeDefaults(next).pipe(
          Effect.mapError((cause) => new HarnessDefaultsError({ operation: "write", cause })),
        );
        yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
          Effect.mapError((cause) => new HarnessDefaultsError({ operation: "write", cause })),
          Effect.andThen(SubscriptionRef.set(state, next)),
          Effect.uninterruptible,
        );
      }),
    );
  });

  return HarnessDefaultsService.of({
    update,
    get: SubscriptionRef.get(state),
    subscribe: () => SubscriptionRef.changes(state),
  });
});

export const layer = Layer.effect(HarnessDefaultsService, make);
