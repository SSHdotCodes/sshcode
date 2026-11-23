import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BoxNamer from "./BoxNamer.ts";
import { boxNamerCache, lookupBoxNaming, subscribeBoxNamed } from "./boxNamerCache.ts";

// Runs the real pipeline (llama-server on a socket, the prompt, the cache file) against a
// GGUF from BOX_NAMER_TEST_MODEL; skipped without one. Any small GGUF proves the plumbing;
// the trained box-namer also proves its output parses.
const model = process.env.BOX_NAMER_TEST_MODEL;
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const layer = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ServerConfig.layerTest(process.cwd(), { prefix: "box-namer-test-" }),
  Layer.succeed(HostProcess.Platform, "darwin"),
  Layer.succeed(HostProcess.Environment, {}),
).pipe(Layer.provideMerge(NodeServices.layer));

it.layer(layer)("BoxNamer with a real model", (it) => {
  it.effect.skipIf(model === undefined)(
    "starts llama-server, names a chat and saves it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const sql = yield* SqlClient.SqlClient;
        const dir = path.join(config.stateDir, "models", "box-namer");
        yield* fs.makeDirectory(dir, { recursive: true });
        yield* fs.symlink(model!, path.join(dir, "model.gguf"));
        yield* fs.writeFileString(
          path.join(dir, "manifest.json"),
          encodeJson({ format: "box-v1", file: "model.gguf" }),
        );
        const payload = encodeJson({
          createdBy: "user",
          creationSource: "mobile",
          text: "on iphone going to search and coming back got rid of the boxes",
        });
        yield* sql`
          INSERT INTO orchestration_v2_projection_messages
            (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
          VALUES ('m1', 't1', NULL, NULL, 'user', 0, '2026-10-23T10:00:00.000Z',
            '2026-10-23T10:00:00.000Z', ${payload})
        `;

        const named = yield* Deferred.make<string>();
        const unsubscribe = subscribeBoxNamed((threadId) =>
          Deferred.doneUnsafe(named, Effect.succeed(threadId)),
        );
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Layer.build(BoxNamer.layer);
            // It turns itself on in the background once it has found the model.
            yield* Effect.sync(() => boxNamerCache.isActive()).pipe(
              Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (on) => on }),
              Effect.timeout("10 seconds"),
            );
            const basis = { title: "Streamline SSHCode Harness and Mobile UX", requestId: "m1" };
            assert.isNull(lookupBoxNaming("t1", basis));
            assert.equal(yield* Deferred.await(named).pipe(Effect.timeout("90 seconds")), "t1");
            const entry = new Map(boxNamerCache.entries()).get("t1");
            assert.equal(entry?.requestId, "m1");
            yield* Effect.logInfo("box namer output", { name: entry?.name, now: entry?.now });
            // Announced as soon as it's cached; the file is written right after.
            const saved = yield* fs
              .readFileString(path.join(config.stateDir, "box-names.json"))
              .pipe(Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 50 }));
            assert.include(saved, '"t1"');
          }),
        );
        unsubscribe();
        // The layer's scope closed: the namer is off again.
        assert.isNull(lookupBoxNaming("t1", { title: "x", requestId: "m1" }));
      }).pipe(TestClock.withLive),
    120_000,
  );
});
