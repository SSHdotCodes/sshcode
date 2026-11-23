import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId, HarnessDefaultsState } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as HarnessDefaultsService from "./HarnessDefaultsService.ts";

const decodeDefaults = Schema.decodeEffect(Schema.fromJsonString(HarnessDefaultsState));
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "harness-defaults-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const openService = HarnessDefaultsService.HarnessDefaultsService.pipe(
  Effect.provide(HarnessDefaultsService.layer),
);
const snapshot = (service: HarnessDefaultsService.HarnessDefaultsService["Service"]) =>
  service.subscribe().pipe(Stream.runHead, Effect.map(Option.getOrThrow));

describe("HarnessDefaultsService", () => {
  it.effect(
    "serializes concurrent clients, publishes saved states, and restores the JSON file",
    () =>
      Effect.gen(function* () {
        const service = yield* openService;
        const ready = yield* Deferred.make<void>();
        const observed = yield* service.subscribe().pipe(
          Stream.tap(() => Deferred.succeed(ready, undefined)),
          Stream.take(3),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(ready);
        const codex = ProviderInstanceId.make("codex");
        yield* Effect.all(
          [
            service.update({
              defaultHarness: codex,
              harnesses: { [codex]: { model: "gpt-6.1-sol" } },
            }),
            service.update({ harnesses: { [codex]: { options: { reasoningEffort: "high" } } } }),
          ],
          { concurrency: "unbounded" },
        );
        const updates = yield* Fiber.join(observed);
        expect(updates).toHaveLength(3);
        const state = yield* snapshot(service);
        expect(state).toEqual({
          defaultHarness: codex,
          harnesses: { [codex]: { model: "gpt-6.1-sol", options: { reasoningEffort: "high" } } },
        });
        const restored = yield* openService;
        expect(yield* snapshot(restored)).toEqual(state);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const contents = yield* fs.readFileString(
          path.join(config.stateDir, "harness-defaults.json"),
        );
        expect(yield* decodeDefaults(contents)).toEqual(state);
        yield* restored.update({ harnesses: { [codex]: { model: null } } });
        expect((yield* snapshot(yield* openService)).harnesses[codex]).toEqual({
          options: { reasoningEffort: "high" },
        });
        yield* restored.update({ defaultHarness: null, harnesses: { [codex]: null } });
        expect(yield* snapshot(yield* openService)).toEqual({ harnesses: {} });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("sets corrupt storage aside and starts empty rather than blocking startup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const filePath = path.join(config.stateDir, "harness-defaults.json");
      yield* fs.writeFileString(filePath, "{broken");
      const service = yield* openService;
      expect(yield* snapshot(service)).toEqual({ harnesses: {} });
      expect(yield* fs.readFileString(`${filePath}.unreadable`)).toBe("{broken");
      expect(yield* fs.exists(filePath)).toBe(false);
      yield* fs.writeFileString(filePath, "{broken-again");
      yield* openService;
      expect(yield* fs.readFileString(`${filePath}.unreadable`)).toBe("{broken");
      expect(yield* fs.readFileString(`${filePath}.unreadable.1`)).toBe("{broken-again");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not publish an operation whose atomic write failed", () =>
    Effect.gen(function* () {
      const service = yield* openService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(path.join(config.stateDir, "harness-defaults.json"));
      const error = yield* service
        .update({ defaultHarness: ProviderInstanceId.make("codex") })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "HarnessDefaultsError", operation: "write" });
      expect(yield* snapshot(service)).toEqual({ harnesses: {} });
      expect(
        (yield* fs.readDirectory(config.stateDir)).filter((name) =>
          name.startsWith("harness-defaults.json"),
        ),
      ).toEqual(["harness-defaults.json"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
