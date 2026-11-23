import {
  AutoModelFeedback as Feedback,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { appendAutoModelRecord, canRecordAutoModelFeedback } from "./feedback.logic.ts";

const decodeFeedback = Schema.decodeUnknownEffect(Feedback);
const encodeFeedback = Schema.encodeEffect(Schema.fromJsonString(Feedback));

export class AutoModelFeedback extends Context.Service<
  AutoModelFeedback,
  {
    readonly record: (
      session: AuthenticatedSession,
      input: Feedback,
    ) => Effect.Effect<void, EnvironmentAuthorizationError>;
  }
>()("t3/autoModel/AutoModelFeedback") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const file = path.join(config.stateDir, "auto-model-feedback.ndjson");
  const lock = yield* Semaphore.make(1);
  const record = Effect.fn("AutoModelFeedback.record")(function* (
    session: AuthenticatedSession,
    input: Feedback,
  ) {
    if (!canRecordAutoModelFeedback(session)) {
      return yield* new EnvironmentAuthorizationError({
        message: "Only an owner session may record Auto model feedback.",
        ...authScopeRequiredResponse(AuthSettingsWriteScope),
      });
    }
    yield* lock
      .withPermits(1)(
        Effect.gen(function* () {
          // Decode again at the service boundary to strip unknown fields, including prompt text.
          const value = yield* decodeFeedback(input);
          const contents = yield* fs
            .readFileString(file)
            .pipe(
              Effect.catch((error) =>
                error.reason._tag === "NotFound" ? Effect.succeed("") : Effect.fail(error),
              ),
            );
          const encoded = yield* encodeFeedback(value);
          const next = appendAutoModelRecord(contents, encoded);
          if (next.rewrite) {
            yield* fs.writeFileString(`${file}.tmp`, next.contents);
            yield* fs.rename(`${file}.tmp`, file);
          } else {
            yield* fs.writeFileString(file, next.contents, { flag: "a" });
          }
        }),
      )
      .pipe(Effect.catch(() => Effect.logWarning("Auto model feedback could not be saved.")));
  });
  return AutoModelFeedback.of({ record });
});

export const layer = Layer.effect(AutoModelFeedback, make);
