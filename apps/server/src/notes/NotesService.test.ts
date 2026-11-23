import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NoteId, NotesState } from "@t3tools/contracts";
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
import * as NotesService from "./NotesService.ts";

const decodeNotes = Schema.decodeEffect(Schema.fromJsonString(NotesState));
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "notes-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const openService = NotesService.NotesService.pipe(Effect.provide(NotesService.layer));
const snapshot = (service: NotesService.NotesService["Service"]) =>
  service.subscribe().pipe(Stream.runHead, Effect.map(Option.getOrThrow));

describe("NotesService", () => {
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
        const a = NoteId.make("mac");
        const b = NoteId.make("phone");
        yield* Effect.all(
          [
            service.mutate({ type: "add", id: a, text: "From the Mac" }),
            service.mutate({ type: "add", id: b, text: "From the phone" }),
          ],
          { concurrency: "unbounded" },
        );
        const updates = yield* Fiber.join(observed);
        expect(updates.map((state) => state.items.length)).toEqual([0, 1, 2]);
        yield* Effect.all(
          [
            service.mutate({ type: "updateText", id: a, text: "Updated" }),
            service.mutate({ type: "setDone", id: a, done: true }),
          ],
          { concurrency: "unbounded" },
        );
        yield* service.mutate({ type: "reorder", id: b, beforeId: a });
        const state = yield* snapshot(service);
        expect(state.items.map((item) => item.id)).toEqual([b, a]);
        expect(state.items[1]).toMatchObject({ text: "Updated", done: true });
        const restored = yield* openService;
        expect(yield* snapshot(restored)).toEqual(state);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const contents = yield* fs.readFileString(path.join(config.stateDir, "notes.json"));
        expect(yield* decodeNotes(contents)).toEqual(state);
        yield* restored.mutate({ type: "clearDone" });
        expect((yield* snapshot(yield* openService)).items.map((item) => item.id)).toEqual([b]);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("sets corrupt storage aside and starts empty rather than blocking startup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const filePath = path.join(config.stateDir, "notes.json");
      yield* fs.writeFileString(filePath, "{broken");
      const service = yield* openService;
      expect((yield* snapshot(service)).items).toEqual([]);
      expect(yield* fs.readFileString(`${filePath}.unreadable`)).toBe("{broken");
      expect(yield* fs.exists(filePath)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("preserves earlier recovery files when storage is corrupt again", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const filePath = path.join(config.stateDir, "notes.json");
      yield* fs.writeFileString(`${filePath}.unreadable`, "first recovery");
      yield* fs.writeFileString(`${filePath}.unreadable.1`, "second recovery");
      yield* fs.writeFileString(filePath, "{broken again");

      expect((yield* snapshot(yield* openService)).items).toEqual([]);
      expect(yield* fs.readFileString(`${filePath}.unreadable`)).toBe("first recovery");
      expect(yield* fs.readFileString(`${filePath}.unreadable.1`)).toBe("second recovery");
      expect(yield* fs.readFileString(`${filePath}.unreadable.2`)).toBe("{broken again");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("does not publish an operation whose atomic write failed", () =>
    Effect.gen(function* () {
      const service = yield* openService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* fs.makeDirectory(path.join(config.stateDir, "notes.json"));
      const error = yield* service
        .mutate({ type: "add", id: NoteId.make("a"), text: "Idea" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "NotesError", operation: "write" });
      expect((yield* snapshot(service)).items).toEqual([]);
      expect(
        (yield* fs.readDirectory(config.stateDir)).filter((name) => name.startsWith("notes.json")),
      ).toEqual(["notes.json"]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
