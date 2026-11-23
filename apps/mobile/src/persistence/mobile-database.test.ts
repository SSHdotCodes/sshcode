import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { vi } from "vite-plus/test";

const openDatabaseAsync = vi.hoisted(() => vi.fn());

vi.mock("expo-sqlite", () => ({ openDatabaseAsync }));

import { retainThreadCache } from "./thread-cache-retention";
import * as MobileDatabase from "./mobile-database";

describe("mobile database legacy cache migration", () => {
  it.effect("keeps acquisition failures typed on database operations", () =>
    Effect.scoped(
      Effect.gen(function* () {
        openDatabaseAsync.mockRejectedValueOnce(new Error("SQLite unavailable"));

        const database = yield* MobileDatabase.make;
        const result = yield* Effect.result(database.loadPreferencesJson);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "MobileDatabaseError", operation: "open" },
        });
      }),
    ),
  );

  it("maps legacy thread records to their SQLite identity", () => {
    const payload = JSON.stringify({
      schemaVersion: 2,
      environmentId: "environment-1",
      threadId: "thread-1",
      snapshot: {},
    });

    expect(MobileDatabase.decodeLegacyCacheRecord("connection-thread-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "thread",
      cacheKey: "thread-1",
      schemaVersion: 2,
      payload,
    });
  });

  it("preserves the old shell payload for schema decoding after migration", () => {
    const payload = JSON.stringify({
      schemaVersion: 1,
      environmentId: "environment-1",
      snapshotReceivedAt: "2026-07-01T00:00:00.000Z",
      snapshot: {},
    });

    expect(MobileDatabase.decodeLegacyCacheRecord("shell-snapshots", payload)).toEqual({
      environmentId: "environment-1",
      kind: "shell",
      cacheKey: "snapshot",
      schemaVersion: 1,
      payload,
    });
  });

  it("skips malformed legacy records", () => {
    expect(MobileDatabase.decodeLegacyCacheRecord("connection-vcs-refs", "{not-json")).toBeNull();
    expect(
      MobileDatabase.decodeLegacyCacheRecord(
        "connection-vcs-refs",
        JSON.stringify({ schemaVersion: 1, environmentId: "environment-1" }),
      ),
    ).toBeNull();
  });
});

// Exercise the production SQL against SQLite, including the eviction window functions.
describe("offline pull request cache", () => {
  const environmentId = "cached-environment" as import("@t3tools/contracts").EnvironmentId;
  const otherEnvironment = "other-environment" as import("@t3tools/contracts").EnvironmentId;

  async function sqliteDatabase() {
    const { DatabaseSync } = await import("node:sqlite");
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA user_version = 1");
    const database = {
      execAsync: async (sql: string) => {
        sqlite.exec(sql);
      },
      runAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).run(...args),
      getFirstAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).get(...args),
      getAllAsync: async (sql: string, ...args: Array<string | number>) =>
        sqlite.prepare(sql).all(...args),
      withExclusiveTransactionAsync: async (run: (transaction: unknown) => Promise<void>) => {
        await run(database);
      },
      closeAsync: async () => {
        sqlite.close();
      },
    };
    openDatabaseAsync.mockResolvedValueOnce(database);
    return sqlite;
  }

  it.effect("restores saved records and clears them with the environment", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        yield* database.saveCache(environmentId, "pull-request", "v1:list", 1, '{"entries":[]}');
        yield* database.saveCache(otherEnvironment, "pull-request", "v1:list", 1, "other");
        expect(yield* database.loadCache(environmentId, "pull-request", "v1:list")).toEqual(
          Option.some('{"entries":[]}'),
        );
        yield* database.clearEnvironmentCache(environmentId);
        expect((yield* database.loadCache(environmentId, "pull-request", "v1:list"))._tag).toBe(
          "None",
        );
        expect((yield* database.loadCache(otherEnvironment, "pull-request", "v1:list"))._tag).toBe(
          "Some",
        );
      }),
    ),
  );

  it.effect(
    "reads only the atomically saved first screen and preserves the complete offline copy",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.promise(sqliteDatabase);
          const database = yield* MobileDatabase.make;
          const first = '{"threadId":"one","snapshotSequence":2}';
          const full = JSON.stringify({ firstScreen: first, history: "older".repeat(100_000) });
          yield* database.saveCache(environmentId, "thread", "one", 6, full);
          expect(yield* database.loadCache(environmentId, "thread", "one", "firstScreen")).toEqual(
            Option.some(first),
          );
          expect(
            yield* database.loadCache(otherEnvironment, "thread", "one", "firstScreen"),
          ).toEqual(Option.none());
          expect(yield* database.loadCache(environmentId, "thread", "two", "firstScreen")).toEqual(
            Option.none(),
          );
          expect(yield* database.loadCache(environmentId, "thread", "one")).toEqual(
            Option.some(full),
          );
          yield* database.saveCache(environmentId, "thread", "one", 6, '{"snapshotSequence":3}');
          expect(yield* database.loadCache(environmentId, "thread", "one", "firstScreen")).toEqual(
            Option.some('{"snapshotSequence":3}'),
          );
          yield* database.saveCache(environmentId, "thread", "one", 6, "invalid");
          expect(yield* database.loadCache(environmentId, "thread", "one", "firstScreen")).toEqual(
            Option.none(),
          );
          yield* database.removeCache(environmentId, "thread", "one");
          expect(yield* database.loadCache(environmentId, "thread", "one", "firstScreen")).toEqual(
            Option.none(),
          );
        }),
      ),
  );

  it.effect(
    "expires old records and bounds count and payload size without evicting other cache kinds",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const sqlite = yield* Effect.promise(sqliteDatabase);
          const database = yield* MobileDatabase.make;
          yield* database.saveCache(environmentId, "thread", "thread", 1, "thread");
          yield* database.saveCache(environmentId, "pull-request", "old", 1, "old");
          sqlite.prepare("UPDATE client_cache SET updated_at = 0 WHERE cache_key = 'old'").run();
          expect((yield* database.loadCache(environmentId, "pull-request", "old"))._tag).toBe(
            "None",
          );
          for (let i = 0; i < 260; i++)
            yield* database.saveCache(environmentId, "pull-request", `page-${i}`, 1, "page");
          expect((yield* database.listCache("pull-request")).length).toBe(256);
          const large = "x".repeat(4 * 1024 * 1024);
          for (let i = 0; i < 10; i++)
            yield* database.saveCache(environmentId, "pull-request", `diff-${i}`, 1, large);
          const summary = yield* database.inspectCaches;
          const prs = summary.find((row) => row.kind === "pull-request");
          expect(prs?.payloadBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
          expect(prs?.recordCount).toBeLessThanOrEqual(256);
          expect((yield* database.loadCache(environmentId, "thread", "thread"))._tag).toBe("Some");
          yield* database.saveCache(environmentId, "pull-request", "oversized", 1, large + "x");
          expect((yield* database.loadCache(environmentId, "pull-request", "oversized"))._tag).toBe(
            "None",
          );
        }),
      ),
  );
  it.effect("bounds thread caches with LRU eviction while retaining the open chat", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        const releaseFirst = retainThreadCache(environmentId, "thread-0");
        const releaseSecond = retainThreadCache(environmentId, "thread-0");
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releaseFirst();
            releaseSecond();
          }),
        );
        for (let index = 0; index < 100; index++) {
          yield* database.saveCache(
            environmentId,
            "thread",
            `thread-${index}`,
            1,
            `payload-${index}`,
          );
        }
        // Reading an old chat makes it recent; the next oldest unprotected chat goes.
        yield* database.loadCache(environmentId, "thread", "thread-1");
        releaseFirst();
        yield* database.saveCache(otherEnvironment, "thread", "thread-100", 1, "other");
        expect((yield* database.listCache("thread")).length).toBe(100);
        expect((yield* database.loadCache(environmentId, "thread", "thread-2"))._tag).toBe("None");
        expect((yield* database.loadCache(environmentId, "thread", "thread-1"))._tag).toBe("Some");
        // Inspect the pinned record without refreshing its LRU position.
        expect(yield* database.listCache("thread")).toContain("payload-0");
        releaseSecond();
        yield* database.saveCache(otherEnvironment, "thread", "thread-101", 1, "new");
        expect((yield* database.loadCache(environmentId, "thread", "thread-0"))._tag).toBe("None");
      }),
    ),
  );

  it.effect("bounds thread payload bytes without evicting the open chat or other cache kinds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.promise(sqliteDatabase);
        const database = yield* MobileDatabase.make;
        const release = retainThreadCache(environmentId, "open");
        yield* Effect.addFinalizer(() => Effect.sync(release));
        const payload = "é".repeat(4 * 1024 * 1024);
        yield* database.saveCache(environmentId, "thread", "open", 1, "open chat");
        yield* database.saveCache(environmentId, "shell", "shell", 1, "shell");
        for (let index = 0; index < 9; index++) {
          yield* database.saveCache(environmentId, "thread", `large-${index}`, 1, payload);
        }
        const summary = (yield* database.inspectCaches).find((row) => row.kind === "thread");
        expect(summary?.payloadBytes).toBeLessThanOrEqual(64 * 1024 * 1024);
        expect(yield* database.loadCache(environmentId, "thread", "open")).toEqual(
          Option.some("open chat"),
        );
        expect(yield* database.loadCache(environmentId, "shell", "shell")).toEqual(
          Option.some("shell"),
        );
        yield* database.saveCache(environmentId, "thread", "oversized", 1, payload + "é");
        expect((yield* database.loadCache(environmentId, "thread", "oversized"))._tag).toBe("None");
        expect((yield* database.loadCache(environmentId, "thread", "large-8"))._tag).toBe("Some");
      }),
    ),
  );
});
