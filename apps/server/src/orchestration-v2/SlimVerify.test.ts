// Opens a slimmed statev2 copy with the server's own store and reads every chat the
// way the apps do. Skipped unless SLIM_DB names the copy (never the live file).
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const path = process.env.SLIM_DB;

it.effect.skipIf(path === undefined || path.endsWith("/statev2.sqlite"))(
  "every chat in the slimmed copy reads like the apps read it",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const ids = (yield* sql<{ readonly thread_id: string }>`
        SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NULL
      `).map((row) => ThreadId.make(row.thread_id));
      const failures: string[] = [];
      let read = 0;
      for (const threadId of ids) {
        const outcome = yield* Effect.exit(
          Effect.all([
            store.getThreadShell(threadId),
            store.getThreadSnapshotWindow(threadId, { userTurnLimit: 20, rowLimit: 400 }),
            store.getThreadProjection(threadId),
          ]),
        );
        if (outcome._tag === "Failure")
          failures.push(`${threadId}: ${String(outcome.cause).slice(0, 300)}`);
        else read += 1;
      }
      const shell = yield* store.getShellSnapshot({ location: "active" });
      yield* Effect.logInfo(
        JSON.stringify({
          chats: ids.length,
          read,
          failures: failures.length,
          shellThreads: shell.threads.length,
        }),
      );
      for (const failure of failures.slice(0, 20)) yield* Effect.logWarning(failure);
      assert.deepEqual(failures, []);
      // An empty or unreadable copy must not pass as "every chat read".
      assert.isAbove(read, 0);
      assert.isAbove(shell.threads.length, 0);
    }).pipe(
      Effect.provide(
        ProjectionStore.layer.pipe(
          Layer.provideMerge(Sqlite.layerFromPath(path ?? ":memory:")),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  60 * 60 * 1000,
);
