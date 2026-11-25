import {
  ConnectionTransientError,
  PrimaryConnectionTarget,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ConnectionCatalogDocument, Persistence } from "@t3tools/client-runtime/platform";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { afterEach, vi } from "vite-plus/test";

import * as ConnectionStorage from "./storage";

const emptyCatalog = {
  schemaVersion: 1,
  targets: [],
  profiles: [],
  credentials: [],
  remoteDpopTokens: [],
  disabledEnvironmentIds: [],
} as const;
const decodeCatalog = Schema.decodeUnknownSync(Schema.fromJsonString(ConnectionCatalogDocument));
const encodeCatalog = Schema.encodeSync(Schema.fromJsonString(ConnectionCatalogDocument));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("thread cache draft protection", () => {
  it("protects persisted unsent prompts and attachments without pinning model-only preferences", () => {
    vi.stubGlobal("window", {
      localStorage: {
        getItem: () =>
          JSON.stringify({
            state: {
              draftsByThreadKey: {
                "first:prompt": { prompt: "unsent prompt" },
                "second:attachment": { prompt: "", attachments: [{ id: "upload" }] },
                "first:model-only": { prompt: "", modelSelectionByProvider: { codex: {} } },
              },
            },
          }),
      },
    });
    expect(ConnectionStorage.readPersistedThreadCacheProtection()).toEqual(
      new Set(["first:prompt", "second:attachment"]),
    );
  });

  it("disables eviction if draft protection cannot be read", () => {
    vi.stubGlobal("window", { localStorage: { getItem: () => "invalid json" } });
    expect(ConnectionStorage.readPersistedThreadCacheProtection()).toBeNull();
  });
});

describe("ConnectionStorage.makeCatalogStore", () => {
  it.effect("quarantines malformed catalogs and starts from an empty document", () =>
    Effect.gen(function* () {
      const writes: string[] = [];
      const quarantined: string[] = [];
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed("{not-json"),
        write: (raw) => Effect.sync(() => writes.push(raw)),
        quarantine: (raw) => Effect.sync(() => quarantined.push(raw)),
      });

      expect(yield* store.read).toEqual(emptyCatalog);
      expect(quarantined).toEqual(["{not-json"]);
      expect(writes).toHaveLength(1);
      expect(decodeCatalog(writes[0]!)).toEqual(emptyCatalog);
    }),
  );

  it.effect("does not hide catalog read failures", () =>
    Effect.gen(function* () {
      const failure = new ConnectionTransientError({
        reason: "remote-unavailable",
        detail: "permission denied",
      });
      const store = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.fail(failure),
        write: () => Effect.void,
      });

      expect(yield* Effect.flip(store.read)).toBe(failure);
    }),
  );
});

const fixedHandle = (database: IDBDatabase) => ({
  get: Effect.succeed(database),
  invalidate: () => Effect.void,
});

describe("thread cache IndexedDB accounting", () => {
  it("does not reopen storage for background maintenance after the owning runtime closes", async () => {
    const transaction = vi.fn();
    const controller = new AbortController();
    const backend = ConnectionStorage.makeThreadCacheBackend(
      fixedHandle({ transaction } as unknown as IDBDatabase),
      controller.signal,
    );
    controller.abort();
    await expect(backend.readIndex(EnvironmentId.make("env"))).rejects.toBeDefined();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("counts legacy snapshots without decoding their histories and preserves the environment boundary", async () => {
    const bound = vi.fn(() => ({}));
    vi.stubGlobal("IDBKeyRange", { bound });
    const request = <A>(result: A) => {
      const next = Object.assign(new EventTarget(), { result, error: null });
      queueMicrotask(() => next.dispatchEvent(new Event("success")));
      return next;
    };
    const cursor = Object.assign(new EventTarget(), { result: null as unknown });
    const rows = [
      { key: "env:old", value: "history" },
      { key: "env:old#preview", value: { version: 1, preview: null } },
    ];
    const advance = () =>
      queueMicrotask(() => {
        const row = rows.shift();
        cursor.result = row ? { ...row, continue: advance } : null;
        cursor.dispatchEvent(new Event("success"));
      });
    const database = {
      transaction: () => ({
        objectStore: () => ({
          get: () => request(undefined),
          openCursor: () => {
            advance();
            return cursor;
          },
        }),
      }),
    } as unknown as IDBDatabase;
    const backend = ConnectionStorage.makeThreadCacheBackend(fixedHandle(database));
    const index = await backend.readIndex(EnvironmentId.make("env"));
    expect(Object.keys(index.entries)).toEqual(["env:old"]);
    expect(index.entries["env:old"]!.bytes).toBeGreaterThan("history".length);
    expect(bound).toHaveBeenCalledWith("env:", "env:\uffff");
  });

  it("rejects an aborted snapshot/index commit so quota failures cannot be reported as successful", async () => {
    const transaction = Object.assign(new EventTarget(), {
      error: new DOMException("Quota exceeded", "QuotaExceededError"),
      objectStore: () => ({
        delete: vi.fn(),
        put: () => queueMicrotask(() => transaction.dispatchEvent(new Event("abort"))),
      }),
    });
    const database = { transaction: () => transaction } as unknown as IDBDatabase;
    const backend = ConnectionStorage.makeThreadCacheBackend(fixedHandle(database));
    await expect(
      backend.commit(
        EnvironmentId.make("env"),
        {
          version: 1,
          clock: 1,
          entries: {},
        },
        ["env:old"],
        {
          key: "env:new",
          snapshot: "new",
          preview: null,
        },
      ),
    ).rejects.toThrow("QuotaExceededError");
  });
});

describe("ConnectionStorage.makeCatalogBackend", () => {
  it.effect("reports a closed IndexedDB connection as a typed read and write failure", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const database = {
        transaction: () => {
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
      } as unknown as IDBDatabase;
      const backend = ConnectionStorage.makeCatalogBackend(fixedHandle(database));

      const readError = yield* Effect.flip(backend.read);
      const writeError = yield* Effect.flip(backend.write("{}"));

      expect(readError).toBeInstanceOf(ConnectionTransientError);
      expect(readError.message).toContain("The database connection is closing.");
      expect(writeError).toBeInstanceOf(ConnectionTransientError);
    }),
  );

  it.effect("fails writes when desktop secure storage declines the catalog", () =>
    Effect.gen(function* () {
      const setConnectionCatalog = vi.fn().mockResolvedValue(false);
      vi.stubGlobal("window", {
        desktopBridge: {
          getConnectionCatalog: vi.fn().mockResolvedValue(null),
          setConnectionCatalog,
        },
      });
      const backend = ConnectionStorage.makeCatalogBackend(fixedHandle({} as IDBDatabase));

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error).toBeInstanceOf(ConnectionTransientError);
      expect(error.message).toContain("Desktop secure storage is unavailable");
      expect(setConnectionCatalog).toHaveBeenCalledWith("{}");
    }),
  );

  it.effect("fails IndexedDB writes whose commit aborts", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const transaction = Object.assign(new EventTarget(), {
        error: null as DOMException | null,
        objectStore: () => ({
          put: () => {
            // A failed commit aborts the transaction without an "error" event.
            queueMicrotask(() => {
              transaction.error = new DOMException("Quota exceeded", "QuotaExceededError");
              transaction.dispatchEvent(new Event("abort"));
            });
          },
        }),
      });
      const backend = ConnectionStorage.makeCatalogBackend(
        fixedHandle({ transaction: () => transaction } as unknown as IDBDatabase),
      );

      const error = yield* backend.write("{}").pipe(Effect.flip);

      expect(error.message).toContain("QuotaExceededError");
    }),
  );
});

describe("environment cache removal", () => {
  it.effect("fails both removal operations when IndexedDB aborts their commits", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      vi.stubGlobal("IDBKeyRange", { bound: () => ({}) });
      const database = Object.assign(new EventTarget(), {
        transaction: () => {
          const transaction = Object.assign(new EventTarget(), {
            error: new DOMException("Commit aborted", "AbortError"),
            objectStore: () => ({
              delete: () => queueMicrotask(() => transaction.dispatchEvent(new Event("abort"))),
              openCursor: () => {
                queueMicrotask(() => transaction.dispatchEvent(new Event("abort")));
                return new EventTarget();
              },
            }),
          });
          return transaction;
        },
        close: vi.fn(),
      }) as unknown as IDBDatabase;
      const openRequest = Object.assign(new EventTarget(), { result: database, error: null });
      vi.stubGlobal("indexedDB", {
        open: () => {
          queueMicrotask(() => openRequest.dispatchEvent(new Event("success")));
          return openRequest;
        },
      });

      const [threadError, refsError] = yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        return [
          yield* Effect.flip(
            cache.removeThread(EnvironmentId.make("env"), ThreadId.make("thread")),
          ),
          yield* Effect.flip(cache.clearVcsRefs(EnvironmentId.make("env"))),
        ] as const;
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(threadError.message).toContain("Commit aborted");
      expect(refsError.message).toContain("Commit aborted");
      expect(database.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("IndexedDB connection recovery", () => {
  it.effect("reports an initial open failure from the cache operation", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const open = vi.fn(() => {
        throw new DOMException("Storage is unavailable", "InvalidStateError");
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        expect(open).not.toHaveBeenCalled();
        const error = yield* Effect.flip(
          cache.loadThread(EnvironmentId.make("env"), ThreadId.make("thread")),
        );
        expect(error.message).toContain("Storage is unavailable");
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(open).toHaveBeenCalledOnce();
    }),
  );

  it.effect("reopens after a forced close and finalizes the current connection", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const makeDatabase = () =>
        Object.assign(new EventTarget(), {
          close: vi.fn(),
          transaction: () => ({
            objectStore: () => ({
              get: () => {
                const request = Object.assign(new EventTarget(), {
                  result: undefined,
                  error: null,
                });
                queueMicrotask(() => request.dispatchEvent(new Event("success")));
                return request;
              },
            }),
          }),
        }) as unknown as IDBDatabase;
      const first = makeDatabase();
      const second = makeDatabase();
      const databases = [first, second];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const environmentId = EnvironmentId.make("env");
        const threadId = ThreadId.make("thread");
        expect(Option.isNone(yield* cache.loadThread(environmentId, threadId))).toBe(true);
        expect(open).toHaveBeenCalledTimes(1);

        first.dispatchEvent(new Event("close"));
        const recovered = yield* Effect.all(
          [cache.loadThread(environmentId, threadId), cache.loadThread(environmentId, threadId)],
          { concurrency: 2 },
        );
        expect(recovered.every(Option.isNone)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));

      expect(first.close).not.toHaveBeenCalled();
      expect(second.close).toHaveBeenCalledOnce();
    }),
  );
});

describe("IndexedDB connection closed without a close event", () => {
  it.effect("reopens and retries the failing operation once", () =>
    Effect.gen(function* () {
      vi.stubGlobal("window", {});
      const closing = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => {
          // Chromium force-closed this connection; this tab never saw "close".
          throw new DOMException("The database connection is closing.", "InvalidStateError");
        },
      }) as unknown as IDBDatabase;
      const fresh = Object.assign(new EventTarget(), {
        close: vi.fn(),
        transaction: () => ({
          objectStore: () => ({
            get: () => {
              const request = Object.assign(new EventTarget(), { result: undefined, error: null });
              queueMicrotask(() => request.dispatchEvent(new Event("success")));
              return request;
            },
          }),
        }),
      }) as unknown as IDBDatabase;
      const databases = [closing, fresh];
      let openCount = 0;
      const open = vi.fn(() => {
        const request = Object.assign(new EventTarget(), {
          result: databases[openCount++],
          error: null,
        });
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
        return request;
      });
      vi.stubGlobal("indexedDB", { open });

      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const loaded = yield* cache.loadThread(EnvironmentId.make("env"), ThreadId.make("thread"));
        expect(Option.isNone(loaded)).toBe(true);
        expect(open).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(ConnectionStorage.layer));
    }),
  );
});

describe("browser GitHub routing permissions", () => {
  it.effect("revokes across runtimes before storage events and resists stale catalog writes", () =>
    Effect.gen(function* () {
      const values = new Map<string, string>();
      const localStorage: Storage = {
        get length() {
          return values.size;
        },
        key: (index) => [...values.keys()][index] ?? null,
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
          values.set(key, value);
        },
        removeItem: (key) => {
          values.delete(key);
        },
        clear: () => {
          values.clear();
        },
      };
      const firstBrowser = Object.assign(new EventTarget(), { localStorage });
      const secondBrowser = Object.assign(new EventTarget(), { localStorage });
      const first = ConnectionStorage.makeBrowserGitHubRoutingPermissions(firstBrowser);
      const second = ConnectionStorage.makeBrowserGitHubRoutingPermissions(secondBrowser);
      const entry = {
        target: new PrimaryConnectionTarget({
          environmentId: EnvironmentId.make("first"),
          label: "First",
          httpBaseUrl: "http://localhost:3000",
          wsBaseUrl: "ws://localhost:3000",
        }),
        profile: Option.none(),
        enabled: true,
      };
      const other = {
        ...entry,
        target: new PrimaryConnectionTarget({
          ...entry.target,
          environmentId: EnvironmentId.make("second"),
        }),
      };
      expect(yield* first.get(entry)).toBe("off");
      yield* first.set(entry, "read-write");
      expect(yield* second.get(entry)).toBe("read-write");
      const oldPermissions = Option.getOrThrow(yield* Stream.runHead(first.changes));
      const staleCatalog = yield* ConnectionStorage.makeCatalogStore({
        read: Effect.succeed(
          encodeCatalog({ ...emptyCatalog, githubRoutingPermissions: oldPermissions }),
        ),
        write: () => Effect.void,
      });
      yield* staleCatalog.read;
      const listening = yield* Deferred.make<void>();
      const revoked = yield* Deferred.make<void>();
      yield* second.changes.pipe(
        Stream.runForEach((permissions) =>
          Deferred.succeed(permissions.length > 0 ? listening : revoked, undefined),
        ),
        Effect.forkChild,
      );
      yield* Deferred.await(listening);

      yield* first.set(entry, "off");
      expect(yield* second.get(entry)).toBe("off");
      secondBrowser.dispatchEvent(Object.assign(new Event("storage"), { key: null }));
      yield* Deferred.await(revoked);
      yield* second.set(other, "read");
      yield* staleCatalog.update((document) => ({ ...document, accountId: "updated" }));
      expect(yield* second.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      expect(
        yield* ConnectionStorage.makeBrowserGitHubRoutingPermissions(firstBrowser).get(entry),
      ).toBe("off");

      yield* first.set(entry, "read-write");
      yield* second.forget(entry.target.environmentId);
      expect(yield* first.get(entry)).toBe("off");
      expect(yield* first.get(other)).toBe("read");
      vi.spyOn(localStorage, "setItem").mockImplementation(() => {
        throw new Error("Storage unavailable");
      });
      expect(yield* first.set(entry, "read-write").pipe(Effect.flip)).toBeInstanceOf(
        ConnectionTransientError,
      );
      expect(yield* second.get(entry)).toBe("off");
    }).pipe(Effect.scoped),
  );
});

describe("cached thread previews", () => {
  /** A Map-backed IndexedDB with just the calls the cache store makes. */
  const installMemoryIndexedDb = () => {
    const stores = new Map<string, Map<IDBValidKey, unknown>>();
    const store = (name: string) => {
      let values = stores.get(name);
      if (!values) stores.set(name, (values = new Map()));
      return values;
    };
    const succeed = <T extends EventTarget>(target: T, type = "success") => {
      queueMicrotask(() => target.dispatchEvent(new Event(type)));
      return target;
    };
    const database = Object.assign(new EventTarget(), {
      close: vi.fn(),
      objectStoreNames: { contains: () => true },
      transaction: (name: string) => {
        const transaction = Object.assign(new EventTarget(), { error: null });
        return Object.assign(transaction, {
          objectStore: () => ({
            get: (key: IDBValidKey) =>
              succeed(
                Object.assign(new EventTarget(), { result: store(name).get(key), error: null }),
              ),
            put: (value: unknown, key: IDBValidKey) => {
              store(name).set(key, value);
              succeed(transaction, "complete");
            },
            delete: (key: IDBValidKey) => {
              store(name).delete(key);
              succeed(transaction, "complete");
            },
            openCursor: () => {
              const request = Object.assign(new EventTarget(), { result: null, error: null });
              succeed(request, "success");
              succeed(transaction, "complete");
              return request;
            },
          }),
        });
      },
    });
    vi.stubGlobal("window", {});
    vi.stubGlobal("indexedDB", {
      open: () => succeed(Object.assign(new EventTarget(), { result: database, error: null })),
    });
    return store;
  };

  it.effect("reads the last message of a thread cached before previews, then keeps it", () =>
    Effect.gen(function* () {
      const store = installMemoryIndexedDb();
      const environmentId = EnvironmentId.make("env");
      const threadId = ThreadId.make("thread");
      const item = (type: string, text: string) => ({ item: { type, text } });
      store("thread").set(
        "env:thread",
        JSON.stringify({
          schemaVersion: 1,
          environmentId,
          threadId,
          snapshot: {
            projection: {
              visibleTurnItems: [
                item("user_message", "Make it faster"),
                item("assistant_message", "Profiled it; the sidebar decoded whole chats."),
                item("command_execution", "ls"),
              ],
            },
          },
        }),
      );
      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        const expected = {
          role: "assistant",
          text: "Profiled it; the sidebar decoded whole chats.",
        };
        expect(yield* cache.loadThreadPreview!(environmentId, threadId)).toEqual(
          Option.some(expected),
        );
        // Kept beside the thread: later reads no longer need the thread body.
        store("thread").delete("env:thread");
        expect(yield* cache.loadThreadPreview!(environmentId, threadId)).toEqual(
          Option.some(expected),
        );
        yield* cache.removeThread(environmentId, threadId);
        expect(Option.isNone(yield* cache.loadThreadPreview!(environmentId, threadId))).toBe(true);
      }).pipe(Effect.provide(ConnectionStorage.layer));
    }),
  );

  it("finds the last user or assistant message in decoded or plain items", () => {
    expect(
      ConnectionStorage.lastMessagePreviewFromItems([
        { item: { type: "assistant_message", text: "earlier" } },
        { item: { type: "user_message", text: "  " } },
        { item: { type: "user_message", text: "latest" } },
        { item: { type: "dynamic_tool" } },
      ]),
    ).toEqual({ role: "user", text: "latest" });
    expect(ConnectionStorage.lastMessagePreviewFromItems(undefined)).toBeNull();
  });

  it.effect("persists and clears the last good route per environment", () =>
    Effect.gen(function* () {
      installMemoryIndexedDb();
      vi.stubGlobal("IDBKeyRange", { bound: () => ({}) });
      const environmentId = EnvironmentId.make("env-remote");
      yield* Effect.gen(function* () {
        const cache = yield* Persistence.EnvironmentCacheStore;
        expect(Option.isNone(yield* cache.loadLastRoute!(environmentId))).toBe(true);
        yield* cache.saveLastRoute!(environmentId, "relay:env-remote");
        expect(yield* cache.loadLastRoute!(environmentId)).toEqual(Option.some("relay:env-remote"));
        yield* cache.clear(environmentId);
        expect(Option.isNone(yield* cache.loadLastRoute!(environmentId))).toBe(true);
      }).pipe(Effect.provide(ConnectionStorage.layer));
    }),
  );
});
