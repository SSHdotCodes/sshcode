// @effect-diagnostics nodeBuiltinImport:off -- Tests mock statfs to exercise the disk-space gate.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeFSP from "node:fs/promises";
import { databaseStoragePreview, reclaimDatabaseSpace } from "./storageDatabase.ts";

vi.mock("node:fs/promises", async (original) => {
  const fs = await original<typeof NodeFSP>();
  return { ...fs, statfs: vi.fn(fs.statfs) };
});

it.live.each([false, true])(
  "reclaims free pages without changing history (incremental: %s)",
  (incremental) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "storage-db-" });
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (incremental) yield* sql`PRAGMA auto_vacuum = INCREMENTAL`;
        yield* sql`PRAGMA journal_mode = WAL`;
        yield* sql`CREATE TABLE history (id INTEGER PRIMARY KEY, body TEXT)`;
        yield* sql`INSERT INTO history (body) VALUES ('keep this conversation')`;
        yield* sql`INSERT INTO history (body) VALUES (zeroblob(2097152))`;
        yield* sql`DELETE FROM history WHERE id = 2`;
        yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
        const before = yield* databaseStoragePreview;
        expect(before.report.freelistBytes).toBeGreaterThan(1024 ** 2);
        expect(before.report.mode).toBe(incremental ? "incremental" : "vacuum");
        const after = yield* reclaimDatabaseSpace;
        expect(after.databaseBytes).toBeLessThan(before.report.databaseBytes);
        expect(after.reclaimedBytes).toBeGreaterThan(0);
        expect(yield* sql`SELECT body FROM history`).toEqual([{ body: "keep this conversation" }]);
        expect((yield* sql<{ auto_vacuum: number }>`PRAGMA auto_vacuum`)[0]?.auto_vacuum).toBe(
          incremental ? 2 : 0,
        );
        expect(yield* sql`PRAGMA integrity_check`).toEqual([{ integrity_check: "ok" }]);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: `${directory}/test.sqlite` })));
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("refuses VACUUM with insufficient disk space before changing the database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "storage-db-full-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE history (body TEXT)`;
      yield* sql`INSERT INTO history VALUES ('preserved')`;
      vi.mocked(NodeFSP.statfs).mockResolvedValueOnce({
        bavail: 0,
        bsize: 4096,
      } as unknown as Awaited<ReturnType<typeof NodeFSP.statfs>>);
      const result = yield* reclaimDatabaseSpace.pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure")
        expect(result.failure.message).toContain("Not enough free disk space");
      expect(yield* sql`SELECT * FROM history`).toEqual([{ body: "preserved" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: `${directory}/test.sqlite` })));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("budgets temporary copies using logical pages when growth is still in the WAL", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "storage-db-wal-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`PRAGMA wal_autocheckpoint = 0`;
      yield* sql`CREATE TABLE history (body TEXT)`;
      yield* sql`INSERT INTO history VALUES (zeroblob(2097152))`;
      const preview = yield* databaseStoragePreview;
      const pages = yield* sql<{ page_count: number }>`PRAGMA page_count`;
      const sizes = yield* sql<{ page_size: number }>`PRAGMA page_size`;
      const logicalBytes = pages[0]!.page_count * sizes[0]!.page_size;
      expect(logicalBytes).toBeGreaterThan(preview.report.databaseBytes);
      expect(preview.report.requiredFreeBytes).toBeGreaterThanOrEqual(
        2 * logicalBytes + 256 * 1024 ** 2,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: `${directory}/test.sqlite` })));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

it.live("pauses competing writers during reclamation and resumes them without losing writes", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "storage-db-writers-" });
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`PRAGMA journal_mode = WAL`;
      yield* sql`CREATE TABLE history (body TEXT)`;
      yield* sql`INSERT INTO history VALUES ('before')`;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const attempting = yield* Deferred.make<void>();
      const written = yield* Deferred.make<void>();
      const paused = new Proxy(sql, {
        get(target, property, receiver) {
          if (property === "reserve")
            return target.reserve.pipe(
              Effect.tap(() => Deferred.succeed(held, undefined)),
              Effect.tap(() => Deferred.await(release)),
            );
          return Reflect.get(target, property, receiver);
        },
      });
      const maintenance = yield* reclaimDatabaseSpace.pipe(
        Effect.provideService(SqlClient.SqlClient, paused),
        Effect.forkChild,
      );
      yield* Deferred.await(held);
      const writer = yield* Deferred.succeed(attempting, undefined).pipe(
        Effect.andThen(sql`INSERT INTO history VALUES ('during')`),
        Effect.andThen(Deferred.succeed(written, undefined)),
        Effect.forkChild,
      );
      yield* Deferred.await(attempting);
      expect(yield* Deferred.isDone(written)).toBe(false);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(maintenance);
      yield* Fiber.join(writer);
      expect(yield* sql`SELECT body FROM history ORDER BY rowid`).toEqual([
        { body: "before" },
        { body: "during" },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: `${directory}/test.sqlite` })));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
