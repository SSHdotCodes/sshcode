import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlError from "effect/sql/SqlError";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "./Sqlite.ts";
import { retrySqliteFull } from "./retrySqliteFull.ts";

it.effect(
  "retries a real SQLITE_FULL transaction after space returns, without holding the reader",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE full_probe (id INTEGER PRIMARY KEY, data BLOB)`;
      const pages = yield* sql<{ page_count: number }>`PRAGMA page_count`;
      yield* sql.unsafe(`PRAGMA max_page_count = ${pages[0]!.page_count}`);
      const failed = yield* Deferred.make<void>();
      const write = yield* sql
        .withTransaction(sql`INSERT INTO full_probe VALUES (1, zeroblob(1000000))`)
        .pipe(
          Effect.tapError(() => Deferred.succeed(failed, undefined)),
          retrySqliteFull,
          Effect.forkScoped,
        );
      yield* Deferred.await(failed);
      // The only reader is available while the write waits. Raising its limit
      // simulates freeing disk space without filling the developer's disk.
      assert.equal((yield* sql`SELECT * FROM full_probe`).length, 0);
      yield* sql`PRAGMA max_page_count = 1000000`;
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(write);
      const rows = yield* sql<{ id: number; bytes: number }>`
      SELECT id, length(data) AS bytes FROM full_probe
    `;
      assert.deepEqual([...rows], [{ id: 1, bytes: 1000000 }]);
    }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("does not retry constraint failures or unknown defects", () =>
  Effect.gen(function* () {
    for (const error of [
      new SqlError.SqlError({ reason: new SqlError.ConstraintError({ cause: null }) }),
      new SqlError.SqlError({ reason: new SqlError.UnknownError({ cause: { errcode: 10 } }) }),
    ]) {
      let attempts = 0;
      const exit = yield* Effect.suspend(() => {
        attempts++;
        return Effect.fail(error);
      }).pipe(retrySqliteFull, Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(attempts, 1);
    }
  }),
);

it.effect("retains a SQLITE_FULL commit defect until its transaction can be retried", () =>
  Effect.gen(function* () {
    const failed = yield* Deferred.make<void>();
    let attempts = 0;
    const fiber = yield* Effect.suspend(() => {
      attempts++;
      return attempts === 1
        ? Deferred.succeed(failed, undefined).pipe(
            Effect.andThen(
              Effect.die(
                new SqlError.SqlError({
                  reason: new SqlError.UnknownError({ cause: { errcode: 13 } }),
                }),
              ),
            ),
          )
        : Effect.succeed("committed");
    }).pipe(retrySqliteFull, Effect.forkScoped);
    yield* Deferred.await(failed);
    yield* TestClock.adjust("1 second");
    assert.equal(yield* Fiber.join(fiber), "committed");
    assert.equal(attempts, 2);
  }).pipe(Effect.scoped),
);
