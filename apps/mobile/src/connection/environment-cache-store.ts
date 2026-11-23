import {
  orchestrationShellCacheSchemaVersion,
  ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
  Persistence,
  makeStoredShellSnapshotEncoder,
  makeThreadCacheWriteOrder,
} from "@t3tools/client-runtime/platform";
import { type EnvironmentId, type ServerConfig, VcsListRefsResult } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as MobileDatabase from "../persistence/mobile-database";
import {
  attachProjectFaviconDatabase,
  projectFaviconDatabaseCache,
} from "../lib/projectFaviconDatabaseCache";
import {
  decodeStoredShellSnapshot,
  decodeStoredShellPreview,
  firstScreenShellSnapshot,
  encodeStoredShellPreview,
} from "./shell-cache-decoding";
import {
  decodeStoredThreadSnapshot,
  makeStoredThreadSnapshotEncoder,
  MOBILE_THREAD_CACHE_SCHEMA_VERSION,
} from "./thread-cache-encoding";
import { markLoad } from "@t3tools/client-runtime/load-marks";
import { afterFirstPaint } from "../lib/after-first-paint";

import {
  SERVER_CONFIG_CACHE_SCHEMA_VERSION,
  encodeStoredServerConfig,
  decodeStoredServerConfig,
} from "./server-config-cache";
const VCS_REFS_CACHE_SCHEMA_VERSION = 1;
const StoredVcsRefs = Schema.Struct({
  schemaVersion: Schema.Literal(VCS_REFS_CACHE_SCHEMA_VERSION),
  environmentId: Schema.String,
  cwd: Schema.String,
  refs: VcsListRefsResult,
});

const decodeStoredVcsRefs = Schema.decodeUnknownEffect(Schema.fromJsonString(StoredVcsRefs));
const encodeStoredVcsRefs = Schema.encodeEffect(Schema.fromJsonString(StoredVcsRefs));

type CacheOperation = Persistence.ConnectionPersistenceError["operation"];

function persistenceError(operation: CacheOperation, cause: unknown) {
  return new Persistence.ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

function mapDatabaseError(operation: CacheOperation) {
  return (error: MobileDatabase.MobileDatabaseError) => persistenceError(operation, error);
}

function loadDecodedCache<A, B>(input: {
  readonly database: MobileDatabase.MobileDatabase["Service"];
  readonly environmentId: EnvironmentId;
  readonly kind: MobileDatabase.ClientCacheKind;
  readonly cacheKey: string;
  readonly field?: "firstScreen";
  readonly operation: CacheOperation;
  readonly beforeDecode?: Effect.Effect<void>;
  readonly decode: (raw: string) => Effect.Effect<A, unknown>;
  readonly select: (value: A) => Option.Option<B>;
}): Effect.Effect<Option.Option<B>, Persistence.ConnectionPersistenceError> {
  const startedAt = performance.now();
  return input.database
    .loadCache(input.environmentId, input.kind, input.cacheKey, input.field)
    .pipe(
      Effect.mapError(mapDatabaseError(input.operation)),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<B>()),
          onSome: (raw) => {
            const readAt = performance.now();
            return (input.beforeDecode ?? Effect.void).pipe(
              Effect.andThen(
                Effect.suspend(() => {
                  const decodeAt = performance.now();
                  return input.decode(raw).pipe(
                    Effect.tap(() =>
                      Effect.sync(() =>
                        markLoad(
                          input.field === "firstScreen"
                            ? "cache.firstScreen.decoded"
                            : "cache.decoded",
                          {
                            kind: input.kind,
                            chars: raw.length,
                            readMs: Math.round(readAt - startedAt),
                            waitMs: Math.round(decodeAt - readAt),
                            decodeMs: Math.round(performance.now() - decodeAt),
                          },
                        ),
                      ),
                    ),
                    Effect.map(input.select),
                    Effect.catch((cause) =>
                      Effect.logWarning("Discarding corrupt mobile client cache record.", {
                        environmentId: input.environmentId,
                        kind: input.kind,
                        cacheKey: input.cacheKey,
                        cause: String(cause),
                      }).pipe(
                        Effect.andThen(
                          // A bad preview must not delete valid offline history.
                          input.field === "firstScreen"
                            ? Effect.void
                            : input.database
                                .removeCache(input.environmentId, input.kind, input.cacheKey)
                                .pipe(Effect.catch(() => Effect.void)),
                        ),
                        Effect.as(Option.none<B>()),
                      ),
                    ),
                  );
                }),
              ),
            );
          },
        }),
      ),
    );
}

export const make = Effect.fn("MobileEnvironmentCacheStore.make")(function* () {
  const database = yield* MobileDatabase.MobileDatabase;
  attachProjectFaviconDatabase(database);
  // Warm icons alongside the shell load so rows rarely paint a placeholder,
  // without making cached threads wait on them.
  void projectFaviconDatabaseCache.hydrate();
  const encodeStoredShellSnapshot = makeStoredShellSnapshotEncoder();
  const encodeStoredThreadSnapshot = makeStoredThreadSnapshotEncoder();
  const threadWriteOrder = makeThreadCacheWriteOrder();
  // Both RpcSessionFactory (heldCatalogs) and EnvironmentServerConfigState read
  // the cached server config at cold launch. Share one decode per environment
  // until a newer config is saved or the environment cache is cleared.
  const serverConfigCache = new Map<EnvironmentId, Option.Option<ServerConfig>>();
  const serverConfigGeneration = new Map<EnvironmentId, number>();
  const LEADER_INTERRUPTED = Symbol("server-config-load-interrupted");
  const pendingServerConfigLoads = new Map<
    EnvironmentId,
    Deferred.Deferred<
      Option.Option<ServerConfig>,
      Persistence.ConnectionPersistenceError | typeof LEADER_INTERRUPTED
    >
  >();
  const bumpServerConfigGeneration = (environmentId: EnvironmentId) => {
    const next = (serverConfigGeneration.get(environmentId) ?? 0) + 1;
    serverConfigGeneration.set(environmentId, next);
    return next;
  };
  const loadServerConfigCached = (
    environmentId: EnvironmentId,
  ): Effect.Effect<Option.Option<ServerConfig>, Persistence.ConnectionPersistenceError> =>
    Effect.suspend(() => {
      if (serverConfigCache.has(environmentId)) {
        return Effect.succeed(serverConfigCache.get(environmentId)!);
      }
      const pending = pendingServerConfigLoads.get(environmentId);
      if (pending !== undefined) {
        return Deferred.await(pending).pipe(
          Effect.catch((error) =>
            error === LEADER_INTERRUPTED
              ? loadServerConfigCached(environmentId)
              : Effect.fail(error),
          ),
        );
      }
      return Effect.gen(function* () {
        const deferred = yield* Deferred.make<
          Option.Option<ServerConfig>,
          Persistence.ConnectionPersistenceError | typeof LEADER_INTERRUPTED
        >();
        pendingServerConfigLoads.set(environmentId, deferred);
        const generation = serverConfigGeneration.get(environmentId) ?? 0;
        return yield* loadDecodedCache({
          database,
          environmentId,
          kind: "server-config",
          cacheKey: "config",
          operation: "load-server-config",
          // Provider catalogs are large. Let pending shell reads and the first
          // screen paint before validating a cached configuration.
          beforeDecode: afterFirstPaint,
          decode: decodeStoredServerConfig,
          select: (stored) =>
            stored.environmentId === environmentId ? Option.some(stored.config) : Option.none(),
        }).pipe(
          Effect.onExit((exit) =>
            Effect.gen(function* () {
              if (pendingServerConfigLoads.get(environmentId) === deferred) {
                pendingServerConfigLoads.delete(environmentId);
              }
              if (Exit.isSuccess(exit)) {
                if ((serverConfigGeneration.get(environmentId) ?? 0) === generation) {
                  serverConfigCache.set(environmentId, exit.value);
                }
                yield* Deferred.succeed(deferred, exit.value);
              } else if (Cause.hasInterruptsOnly(exit.cause)) {
                yield* Deferred.fail(deferred, LEADER_INTERRUPTED);
              } else {
                yield* Deferred.failCause(deferred, exit.cause);
              }
            }),
          ),
        );
      });
    });
  return Persistence.EnvironmentCacheStore.of({
    yieldAfterThreadFirstScreen: afterFirstPaint,
    loadThreadFirstScreen: (environmentId, threadId) =>
      loadDecodedCache({
        database,
        environmentId,
        kind: "thread",
        cacheKey: threadId,
        field: "firstScreen",
        operation: "load-thread",
        decode: decodeStoredThreadSnapshot,
        select: (stored) =>
          stored.environmentId === environmentId &&
          stored.threadId === threadId &&
          stored.snapshot.projection.thread.id === threadId
            ? Option.some(stored.snapshot)
            : Option.none(),
      }),
    yieldAfterShellPreview: afterFirstPaint,
    loadShellPreview: (environmentId) =>
      loadDecodedCache({
        database,
        environmentId,
        kind: "shell",
        cacheKey: "first-screen",
        operation: "load-shell",
        decode: decodeStoredShellPreview,
        select: (stored) =>
          stored.environmentId === environmentId ? Option.some(stored.snapshot) : Option.none(),
      }),
    loadShell: Effect.fn("MobileEnvironmentCache.loadShell")((environmentId) =>
      loadDecodedCache({
        database,
        environmentId,
        kind: "shell",
        cacheKey: "snapshot",
        operation: "load-shell",
        decode: decodeStoredShellSnapshot,
        select: (stored) =>
          stored.environmentId === environmentId ? Option.some(stored.snapshot) : Option.none(),
      }),
    ),
    saveShell: Effect.fn("MobileEnvironmentCache.saveShell")(function* (environmentId, snapshot) {
      const schemaVersion = orchestrationShellCacheSchemaVersion(snapshot);
      const payload = yield* encodeStoredShellSnapshot({
        schemaVersion,
        environmentId,
        snapshot,
      }).pipe(Effect.mapError((cause) => persistenceError("save-shell", cause)));
      yield* database
        .saveCache(environmentId, "shell", "snapshot", schemaVersion, payload)
        .pipe(Effect.mapError(mapDatabaseError("save-shell")));
      const preview = yield* encodeStoredShellPreview({
        schemaVersion,
        environmentId,
        snapshot: firstScreenShellSnapshot(snapshot, environmentId),
      }).pipe(Effect.mapError((cause) => persistenceError("save-shell", cause)));
      yield* database
        .saveCache(environmentId, "shell", "first-screen", schemaVersion, preview)
        .pipe(Effect.mapError(mapDatabaseError("save-shell")));
    }),
    loadThread: Effect.fn("MobileEnvironmentCache.loadThread")((environmentId, threadId) =>
      loadDecodedCache({
        database,
        environmentId,
        kind: "thread",
        cacheKey: threadId,
        operation: "load-thread",
        decode: decodeStoredThreadSnapshot,
        select: (stored) =>
          stored.environmentId === environmentId &&
          stored.threadId === threadId &&
          stored.snapshot.projection.thread.id === threadId
            ? Option.some(stored.snapshot)
            : Option.none(),
      }),
    ),
    saveThread: Effect.fn("MobileEnvironmentCache.saveThread")(function* (environmentId, snapshot) {
      const threadId = snapshot.projection.thread.id;
      const isLatest = threadWriteOrder.beginSave(environmentId, threadId);
      const payload = yield* encodeStoredThreadSnapshot({
        schemaVersion: ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION,
        environmentId,
        threadId,
        snapshot,
      }).pipe(Effect.mapError((cause) => persistenceError("save-thread", cause)));
      if (!isLatest()) return;
      yield* (
        payload === undefined
          ? database.removeCache(environmentId, "thread", threadId)
          : database.saveCache(
              environmentId,
              "thread",
              threadId,
              MOBILE_THREAD_CACHE_SCHEMA_VERSION,
              payload,
            )
      ).pipe(Effect.mapError(mapDatabaseError("save-thread")));
    }),
    removeThread: Effect.fn("MobileEnvironmentCache.removeThread")((environmentId, threadId) => {
      threadWriteOrder.removeThread(environmentId, threadId);
      return database
        .removeCache(environmentId, "thread", threadId)
        .pipe(Effect.mapError(mapDatabaseError("remove-thread")));
    }),
    loadServerConfig: Effect.fn("MobileEnvironmentCache.loadServerConfig")((environmentId) =>
      loadServerConfigCached(environmentId),
    ),
    saveServerConfig: Effect.fn("MobileEnvironmentCache.saveServerConfig")(
      function* (environmentId, config) {
        const generation = bumpServerConfigGeneration(environmentId);
        const payload = yield* encodeStoredServerConfig({
          schemaVersion: SERVER_CONFIG_CACHE_SCHEMA_VERSION,
          environmentId,
          config,
        }).pipe(Effect.mapError((cause) => persistenceError("save-server-config", cause)));
        yield* database
          .saveCache(
            environmentId,
            "server-config",
            "config",
            SERVER_CONFIG_CACHE_SCHEMA_VERSION,
            payload,
          )
          .pipe(Effect.mapError(mapDatabaseError("save-server-config")));
        if ((serverConfigGeneration.get(environmentId) ?? 0) === generation) {
          serverConfigCache.set(environmentId, Option.some(config));
        }
      },
    ),
    loadVcsRefs: Effect.fn("MobileEnvironmentCache.loadVcsRefs")((environmentId, cwd) =>
      loadDecodedCache({
        database,
        environmentId,
        kind: "vcs-refs",
        cacheKey: cwd,
        operation: "load-vcs-refs",
        decode: decodeStoredVcsRefs,
        select: (stored) =>
          stored.environmentId === environmentId && stored.cwd === cwd
            ? Option.some(stored.refs)
            : Option.none(),
      }),
    ),
    saveVcsRefs: Effect.fn("MobileEnvironmentCache.saveVcsRefs")(
      function* (environmentId, cwd, refs) {
        const payload = yield* encodeStoredVcsRefs({
          schemaVersion: VCS_REFS_CACHE_SCHEMA_VERSION,
          environmentId,
          cwd,
          refs,
        }).pipe(Effect.mapError((cause) => persistenceError("save-vcs-refs", cause)));
        yield* database
          .saveCache(environmentId, "vcs-refs", cwd, VCS_REFS_CACHE_SCHEMA_VERSION, payload)
          .pipe(Effect.mapError(mapDatabaseError("save-vcs-refs")));
      },
    ),
    removeVcsRefs: Effect.fn("MobileEnvironmentCache.removeVcsRefs")((environmentId, cwd) =>
      database
        .removeCache(environmentId, "vcs-refs", cwd)
        .pipe(Effect.mapError(mapDatabaseError("remove-vcs-refs"))),
    ),
    clearVcsRefs: Effect.fn("MobileEnvironmentCache.clearVcsRefs")((environmentId) =>
      database
        .clearCacheKind(environmentId, "vcs-refs")
        .pipe(Effect.mapError(mapDatabaseError("clear-vcs-refs"))),
    ),
    loadLastRoute: Effect.fn("MobileEnvironmentCache.loadLastRoute")((environmentId) =>
      database
        .loadCache(environmentId, "server-config", "last-route")
        .pipe(
          Effect.mapError(mapDatabaseError("load-server-config")),
          Effect.map(Option.filter((value) => value.length > 0)),
        ),
    ),
    saveLastRoute: Effect.fn("MobileEnvironmentCache.saveLastRoute")((environmentId, routeId) =>
      database
        .saveCache(environmentId, "server-config", "last-route", 1, routeId)
        .pipe(Effect.mapError(mapDatabaseError("save-server-config"))),
    ),
    clear: Effect.fn("MobileEnvironmentCache.clear")((environmentId) => {
      bumpServerConfigGeneration(environmentId);
      serverConfigCache.delete(environmentId);
      threadWriteOrder.clearEnvironment(environmentId);
      return Effect.promise(() => projectFaviconDatabaseCache.clearEnvironment(environmentId)).pipe(
        Effect.andThen(database.clearEnvironmentCache(environmentId)),
        Effect.mapError(mapDatabaseError("clear-environment")),
      );
    }),
  });
});

export const layer = Layer.effect(Persistence.EnvironmentCacheStore, make());
