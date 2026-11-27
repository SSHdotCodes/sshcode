import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as References from "effect/References";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as Identify from "./Identify.ts";

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

const sha256 = Effect.fn("test.sha256")(function* (value: string) {
  const crypto = yield* Crypto.Crypto;
  return Hex.encode(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.orDie),
  );
});

const makeCaptureLogger = (logs: CapturedLog[]) =>
  Logger.make(({ fiber, message }) => {
    logs.push({
      message,
      annotations: fiber.getRef(References.CurrentLogAnnotations),
    });
  });

const findIdentityLog = (logs: ReadonlyArray<CapturedLog>, errorTag: string) =>
  logs.find((log) => log.annotations.errorTag === errorTag);

it.layer(NodeServices.layer)("telemetry identity", (it) => {
  it.effect("uses the persisted anonymous id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const anonymousId = "persisted-anonymous-id";

      yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);

      const identifier = yield* Identify.getTelemetryIdentifier;

      assert.equal(identifier, yield* sha256(anonymousId));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-telemetry-identify-anonymous-",
        }),
      ),
    ),
  );

  it.effect("leaves no torn anonymous id behind when its write fails midway", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const tornWrites = FileSystem.FileSystem.of({
        ...fileSystem,
        writeFileString: (filePath, data, options) =>
          fileSystem
            .writeFileString(filePath, data.slice(0, Math.floor(data.length / 2)), options)
            .pipe(
              Effect.andThen(
                Effect.fail(
                  PlatformError.systemError({
                    _tag: "WriteZero",
                    module: "FileSystem",
                    method: "writeFileString",
                    pathOrDescriptor: filePath,
                  }),
                ),
              ),
            ),
      });

      const identifier = yield* Identify.getTelemetryIdentifier.pipe(
        Effect.provideService(FileSystem.FileSystem, tornWrites),
      );

      assert.isNull(identifier);
      assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-telemetry-identify-torn-",
        }),
      ),
    ),
  );

  it.effect("never reads Codex or Claude account files for the identifier", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const homeDirectory = path.join(config.baseDir, "home");
      const anonymousId = "install-local-anonymous-id";

      yield* fileSystem.makeDirectory(path.join(homeDirectory, ".codex"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(homeDirectory, ".codex", "auth.json"),
        `{"tokens":{"account_id":"codex-account"}}`,
      );
      yield* fileSystem.writeFileString(
        path.join(homeDirectory, ".claude.json"),
        `{"userID":"claude-user"}`,
      );
      yield* fileSystem.writeFileString(config.anonymousIdPath, anonymousId);

      const identifier = yield* Identify.getTelemetryIdentifier.pipe(
        Effect.provideService(HostProcess.HomeDirectory, homeDirectory),
      );

      assert.equal(identifier, yield* sha256(anonymousId));
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-telemetry-identify-accounts-",
        }),
      ),
    ),
  );

  it.effect("does not overwrite the anonymous id path after a non-NotFound read failure", () => {
    const logs: CapturedLog[] = [];
    const logger = makeCaptureLogger(logs);

    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;

      yield* fileSystem.makeDirectory(config.anonymousIdPath);

      const identifier = yield* Identify.getTelemetryIdentifier;

      assert.isNull(identifier);
      assert.deepEqual(yield* fileSystem.readDirectory(config.anonymousIdPath), []);

      const readLog = findIdentityLog(logs, "TelemetryIdentityReadError");
      assert.isDefined(readLog);
      assert.equal(readLog?.annotations.filePath, config.anonymousIdPath);
      assert.equal(readLog?.annotations.causeKind, "platform");
      assert.notEqual(readLog?.annotations.platformReason, "NotFound");
      assert.notProperty(readLog?.annotations ?? {}, "cause");
      const errorStack = readLog?.annotations.errorStack;
      assert.isString(errorStack);
      assert.include(errorStack, "Failed to read anonymous telemetry identity");
      assert.isUndefined(findIdentityLog(logs, "TelemetryAnonymousIdPersistenceError"));
    }).pipe(
      Effect.provide(
        Layer.merge(
          ServerConfig.layerTest(process.cwd(), {
            prefix: "t3-telemetry-identify-read-",
          }),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });
});
