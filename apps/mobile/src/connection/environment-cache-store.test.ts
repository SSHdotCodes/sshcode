import { ORCHESTRATION_CACHE_SCHEMA_VERSION } from "@t3tools/client-runtime/platform";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadDetailSnapshot,
  type ThreadPullRequestLink,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";

import * as MobileDatabase from "../persistence/mobile-database";
import { projectFaviconDatabaseCache } from "../lib/projectFaviconDatabaseCache";
import { make } from "./environment-cache-store";
import { cachedConfigFixture } from "./server-config-cache.test-fixtures";
import { MOBILE_THREAD_CACHE_SCHEMA_VERSION } from "./thread-cache-encoding";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");
const NOW = DateTime.makeUnsafe("2026-07-29T12:00:00.000Z");
const SHELL_SNAPSHOT: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 3,
  projects: [
    {
      id: PROJECT_ID,
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-07-29T12:00:00.000Z",
      updatedAt: "2026-07-29T12:00:00.000Z",
    },
  ],
  threads: [
    {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      modelSelection: {
        instanceId: PROVIDER_INSTANCE_ID,
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: THREAD_ID,
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "mobile",
      latestRunId: null,
      activeRunId: null,
      status: "idle",
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: NOW,
      activityRunStartedAt: NOW,
      activityRunStatus: "running",
      hasActionableProposedPlan: false,
      itemCount: 0,
      visibleItemCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: NOW,
      unsettledAt: NOW,
      lastVisitedAt: null,
      titleRegeneration: {
        requestId: CommandId.make("title-regeneration-1"),
        startedAt: NOW,
      },
      deletedAt: null,
    },
  ],
  archivedThreads: [],
};
const THREAD_SNAPSHOT: OrchestrationV2ThreadDetailSnapshot = {
  snapshotSequence: 4,
  projection: {
    thread: {
      id: THREAD_ID,
      projectId: PROJECT_ID,
      title: "Thread",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      modelSelection: {
        instanceId: PROVIDER_INSTANCE_ID,
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: THREAD_ID,
        parentThreadId: null,
        relationshipToParent: null,
      },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "mobile",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: NOW,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
  },
};
const REFS: VcsListRefsResult = {
  refs: [
    {
      name: "main",
      current: true,
      isDefault: true,
      worktreePath: "/repo",
    },
  ],
  isRepo: true,
  hasPrimaryRemote: true,
  nextCursor: null,
  totalCount: 1,
};

function cacheId(
  environmentId: EnvironmentId,
  kind: MobileDatabase.ClientCacheKind,
  cacheKey: string,
) {
  return `${environmentId}:${kind}:${cacheKey}`;
}

function makeDatabase() {
  const values = new Map<string, string>();
  const schemaVersions = new Map<string, number>();
  const removed: Array<string> = [];
  const database = MobileDatabase.MobileDatabase.of({
    loadCache: (environmentId, kind, cacheKey, field) =>
      Effect.sync(() => {
        const raw = values.get(cacheId(environmentId, kind, cacheKey));
        if (raw === undefined || field === undefined) return Option.fromUndefinedOr(raw);
        const parsed = JSON.parse(raw);
        return Option.fromUndefinedOr(
          parsed.firstScreen ?? (raw.length <= 65536 ? raw : undefined),
        );
      }),
    listCache: (kind) =>
      Effect.sync(() =>
        [...values.entries()]
          .filter(([key]) => key.split(":")[1] === kind)
          .map(([, payload]) => payload),
      ),
    saveCache: (environmentId, kind, cacheKey, schemaVersion, payload) =>
      Effect.sync(() => {
        const id = cacheId(environmentId, kind, cacheKey);
        values.set(id, payload);
        schemaVersions.set(id, schemaVersion);
      }),
    removeCache: (environmentId, kind, cacheKey) =>
      Effect.sync(() => {
        const id = cacheId(environmentId, kind, cacheKey);
        removed.push(id);
        values.delete(id);
      }),
    clearCacheKind: (environmentId, kind) =>
      Effect.sync(() => {
        for (const key of values.keys()) {
          if (key.startsWith(`${environmentId}:${kind}:`)) values.delete(key);
        }
      }),
    clearEnvironmentCache: (environmentId) =>
      Effect.sync(() => {
        for (const key of values.keys()) {
          if (key.startsWith(`${environmentId}:`)) values.delete(key);
        }
      }),
    clearAllCaches: Effect.sync(() => values.clear()),
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.succeed(Option.none()),
    savePreferencesJson: () => Effect.void,
  });
  return { database, removed, schemaVersions, values };
}

describe("mobile SQLite environment cache store", () => {
  it.live("lets first-screen cache reads finish before decoding cached provider catalogs", () =>
    Effect.gen(function* () {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
        frames.push(callback),
      );
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      yield* store.saveShell(ENVIRONMENT_ID, SHELL_SNAPSHOT);
      const configKey = cacheId(ENVIRONMENT_ID, "server-config", "config");
      // A failed decode removes the corrupt record, making its execution observable.
      memory.values.set(configKey, "{");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const config = yield* store
        .loadServerConfig(ENVIRONMENT_ID)
        .pipe(Effect.forkChild({ startImmediately: true }));
      expect(frames).toHaveLength(1);
      const preview = Option.getOrThrow(yield* store.loadShellPreview!(ENVIRONMENT_ID));
      expect(preview.threads[0]?.id).toBe(THREAD_ID);
      expect(memory.removed).not.toContain(configKey);
      frames[0]!(0);
      expect(memory.removed).not.toContain(configKey);
      frames[1]!(16);
      expect(Option.isNone(yield* Fiber.join(config))).toBe(true);
      expect(memory.removed).toContain(configKey);
      expect(vi.getTimerCount()).toBe(0);
    }),
  );

  it.effect("keeps the display preview separate from the complete legacy cache", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const full = {
        ...SHELL_SNAPSHOT,
        threads: Array.from({ length: 150 }, (_, index) => ({
          ...SHELL_SNAPSHOT.threads[0]!,
          id: ThreadId.make(`thread-${index}`),
        })),
      };
      yield* store.saveShell(ENVIRONMENT_ID, full);
      const preview = Option.getOrThrow(yield* store.loadShellPreview!(ENVIRONMENT_ID));
      expect(preview.threads).toHaveLength(64);
      expect(preview.previewCounts?.visibleChats).toBe(150);
      expect(Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID))).not.toHaveProperty(
        "previewCounts",
      );
      expect(Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID)).threads).toHaveLength(150);
      // Existing installations have only the original snapshot key.
      memory.values.delete(cacheId(ENVIRONMENT_ID, "shell", "first-screen"));
      expect(Option.isNone(yield* store.loadShellPreview!(ENVIRONMENT_ID))).toBe(true);
      expect(Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID)).threads).toHaveLength(150);
      yield* store.saveShell(ENVIRONMENT_ID, full);
      memory.values.set(cacheId(ENVIRONMENT_ID, "shell", "first-screen"), "corrupt");
      expect(Option.isNone(yield* store.loadShellPreview!(ENVIRONMENT_ID))).toBe(true);
      expect(Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID)).threads).toHaveLength(150);
      yield* store.clear(ENVIRONMENT_ID);
      expect(memory.values.size).toBe(0);
    }),
  );
  it.effect("returns cached threads without waiting for project icons to hydrate", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      yield* store.saveShell(ENVIRONMENT_ID, SHELL_SNAPSHOT);
      const hydration = Promise.withResolvers<void>();
      const spy = vi
        .spyOn(projectFaviconDatabaseCache, "hydrate")
        .mockReturnValue(hydration.promise);
      try {
        const shell = Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID));
        expect(shell.threads[0]?.id).toBe(THREAD_ID);
      } finally {
        hydration.resolve();
        spy.mockRestore();
      }
    }),
  );

  it.effect("round-trips V2 shell and thread DateTime fields with the shared cache schema", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );

      yield* store.saveShell(ENVIRONMENT_ID, SHELL_SNAPSHOT);
      yield* store.saveThread(ENVIRONMENT_ID, THREAD_SNAPSHOT);

      const shell = Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID));
      const thread = Option.getOrThrow(yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID));

      expect(DateTime.formatIso(shell.threads[0]!.updatedAt)).toBe("2026-07-29T12:00:00.000Z");
      expect(DateTime.formatIso(shell.threads[0]!.latestUserMessageAt!)).toBe(
        "2026-07-29T12:00:00.000Z",
      );
      expect(DateTime.formatIso(shell.threads[0]!.titleRegeneration!.startedAt)).toBe(
        "2026-07-29T12:00:00.000Z",
      );
      // Working and unsettled threads are exactly what a backgrounded app
      // caches; a decode failure here discards the whole shell on relaunch.
      expect(DateTime.formatIso(shell.threads[0]!.activityRunStartedAt!)).toBe(
        "2026-07-29T12:00:00.000Z",
      );
      expect(DateTime.formatIso(shell.threads[0]!.unsettledAt!)).toBe("2026-07-29T12:00:00.000Z");
      expect(DateTime.formatIso(thread.projection.thread.updatedAt)).toBe(
        "2026-07-29T12:00:00.000Z",
      );
      expect(memory.schemaVersions.get(cacheId(ENVIRONMENT_ID, "shell", "snapshot"))).toBe(
        ORCHESTRATION_CACHE_SCHEMA_VERSION,
      );
      expect(memory.schemaVersions.get(cacheId(ENVIRONMENT_ID, "thread", THREAD_ID))).toBe(
        MOBILE_THREAD_CACHE_SCHEMA_VERSION,
      );
    }),
  );

  it.live("returns cached threads before their pull request links, which load after", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const link: ThreadPullRequestLink = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 42,
        url: "https://github.com/pingdotgg/t3code/pull/42",
        source: "agent",
        linkedAt: "2026-07-29T12:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      const linked = { ...SHELL_SNAPSHOT.threads[0]!, pullRequests: [link] };
      const unlinked = { ...SHELL_SNAPSHOT.threads[0]!, id: ThreadId.make("thread-2") };
      yield* store.saveShell(ENVIRONMENT_ID, {
        ...SHELL_SNAPSHOT,
        threads: [linked, unlinked],
      });

      const shell = Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID));
      expect(shell.threads.map((thread) => thread.pullRequests)).toEqual([undefined, undefined]);
      const links = yield* shell.loadPullRequests!;
      expect([...links]).toEqual([[THREAD_ID, [link]]]);
    }),
  );

  it.live("keeps cached threads when their pull request links cannot be read", () => {
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      messages.push(message);
    });
    return Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const link: ThreadPullRequestLink = {
        host: "github.com",
        repository: "pingdotgg/t3code",
        number: 5,
        url: "https://github.com/pingdotgg/t3code/pull/5",
        source: "agent",
        linkedAt: "2026-07-29T12:00:00.000Z",
        snapshot: null,
        stack: null,
      };
      const readable = {
        ...SHELL_SNAPSHOT.threads[0]!,
        id: ThreadId.make("thread-2"),
        pullRequests: [link],
      };
      yield* store.saveShell(ENVIRONMENT_ID, {
        ...SHELL_SNAPSHOT,
        threads: [SHELL_SNAPSHOT.threads[0]!, readable],
      });
      const id = cacheId(ENVIRONMENT_ID, "shell", "snapshot");
      const payload = JSON.parse(memory.values.get(id)!);
      payload.snapshot.threads[0].pullRequests = [{ number: -1 }];
      memory.values.set(id, JSON.stringify(payload));

      const shell = Option.getOrThrow(yield* store.loadShell(ENVIRONMENT_ID));
      expect(shell.threads.map((thread) => thread.id)).toEqual([THREAD_ID, readable.id]);
      // Only the thread with the unreadable link loses its links.
      expect([...(yield* shell.loadPullRequests!)]).toEqual([[readable.id, [link]]]);
      expect(messages).toHaveLength(1);
      expect(memory.removed).toEqual([]);
    }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it.effect("round-trips schema-validated VCS refs", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );

      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.some(REFS));
    }),
  );

  it.effect("deletes a corrupt cache record and treats it as a miss", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const id = cacheId(ENVIRONMENT_ID, "vcs-refs", "/repo");
      memory.values.set(id, "{not-json");

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(memory.removed).toEqual([id]);
    }),
  );

  it.effect("removes one persisted VCS ref snapshot", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);

      yield* store.removeVcsRefs(ENVIRONMENT_ID, "/repo");

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(memory.removed).toContain(cacheId(ENVIRONMENT_ID, "vcs-refs", "/repo"));
    }),
  );

  it.effect("clears every persisted VCS ref snapshot in one environment", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const otherEnvironmentId = EnvironmentId.make("environment-2");
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo-worktree", REFS);
      yield* store.saveVcsRefs(otherEnvironmentId, "/repo", REFS);

      yield* store.clearVcsRefs(ENVIRONMENT_ID);

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo-worktree")).toEqual(Option.none());
      expect(yield* store.loadVcsRefs(otherEnvironmentId, "/repo")).toEqual(Option.some(REFS));
    }),
  );

  it.effect("clears one environment without touching another", () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const otherEnvironmentId = EnvironmentId.make("environment-2");
      yield* store.saveVcsRefs(ENVIRONMENT_ID, "/repo", REFS);
      yield* store.saveVcsRefs(otherEnvironmentId, "/repo", REFS);

      yield* store.clear(ENVIRONMENT_ID);

      expect(yield* store.loadVcsRefs(ENVIRONMENT_ID, "/repo")).toEqual(Option.none());
      expect(yield* store.loadVcsRefs(otherEnvironmentId, "/repo")).toEqual(Option.some(REFS));
    }),
  );
});

it.effect("does not restore a thread removed or replaced during a yielding save", () =>
  Effect.gen(function* () {
    const rows = Array.from({ length: 80 }, (_, index) => ({
      id: TurnItemId.make(`notice-${index}`),
      threadId: THREAD_ID,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index,
      status: "completed" as const,
      title: null,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
      type: "system_notice" as const,
      message: "settled",
    }));
    const large = {
      ...THREAD_SNAPSHOT,
      projection: { ...THREAD_SNAPSHOT.projection, turnItems: rows },
    };
    for (const action of ["remove", "clear", "replace"] as const) {
      const memory = makeDatabase();
      const store = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
      );
      const pending = yield* store
        .saveThread(ENVIRONMENT_ID, large)
        .pipe(Effect.forkChild({ startImmediately: true }));
      if (action === "remove") yield* store.removeThread(ENVIRONMENT_ID, THREAD_ID);
      else if (action === "clear") yield* store.clear(ENVIRONMENT_ID);
      else yield* store.saveThread(ENVIRONMENT_ID, { ...THREAD_SNAPSHOT, snapshotSequence: 99 });
      yield* Fiber.join(pending);
      const loaded = yield* store.loadThread(ENVIRONMENT_ID, THREAD_ID);
      if (action === "replace") expect(Option.getOrThrow(loaded).snapshotSequence).toBe(99);
      else expect(Option.isNone(loaded)).toBe(true);
    }
  }),
);

it.effect("persists and clears the last good route id per environment", () =>
  Effect.gen(function* () {
    const memory = makeDatabase();
    const store = yield* make().pipe(
      Effect.provideService(MobileDatabase.MobileDatabase, memory.database),
    );
    expect(Option.isNone(yield* store.loadLastRoute!(ENVIRONMENT_ID))).toBe(true);
    yield* store.saveLastRoute!(ENVIRONMENT_ID, "learned:environment-1:https://mac.ts.net:3773");
    expect(yield* store.loadLastRoute!(ENVIRONMENT_ID)).toEqual(
      Option.some("learned:environment-1:https://mac.ts.net:3773"),
    );
    yield* store.clear(ENVIRONMENT_ID);
    expect(Option.isNone(yield* store.loadLastRoute!(ENVIRONMENT_ID))).toBe(true);
  }),
);

it.live(
  "coalesces concurrent loadServerConfig calls and caches the decoded config until saved or cleared",
  () =>
    Effect.gen(function* () {
      const memory = makeDatabase();
      let dbReads = 0;
      const countedDatabase = MobileDatabase.MobileDatabase.of({
        ...memory.database,
        loadCache: (environmentId, kind, cacheKey, field) =>
          Effect.sync(() => {
            if (kind === "server-config" && cacheKey === "config") dbReads++;
          }).pipe(Effect.andThen(memory.database.loadCache(environmentId, kind, cacheKey, field))),
      });
      // Seed the database through a first store instance, then simulate cold launch on a fresh one.
      const config = cachedConfigFixture(2, 2);
      const writer = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, countedDatabase),
      );
      yield* writer.saveServerConfig(ENVIRONMENT_ID, config);

      const reader = yield* make().pipe(
        Effect.provideService(MobileDatabase.MobileDatabase, countedDatabase),
      );
      // Concurrent cold-launch reads (e.g. RpcSessionFactory heldCatalogs + EnvironmentServerConfigState).
      const [first, second] = yield* Effect.all(
        [reader.loadServerConfig(ENVIRONMENT_ID), reader.loadServerConfig(ENVIRONMENT_ID)],
        { concurrency: 2 },
      );
      expect(dbReads).toBe(1);
      expect(Option.getOrThrow(first)).toBe(Option.getOrThrow(second));

      // Subsequent read uses the cached decoded object without touching SQLite again.
      const third = yield* reader.loadServerConfig(ENVIRONMENT_ID);
      expect(dbReads).toBe(1);
      expect(Option.getOrThrow(third)).toBe(Option.getOrThrow(first));

      // Clearing invalidates the in-memory cache so the next read queries SQLite again.
      yield* reader.clear(ENVIRONMENT_ID);
      const afterClear = yield* reader.loadServerConfig(ENVIRONMENT_ID);
      expect(dbReads).toBe(2);
      expect(Option.isNone(afterClear)).toBe(true);
    }),
);
