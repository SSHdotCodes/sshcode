import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { collectUsageLimits } from "../mcp/OrchestratorUsageLimits.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import { readProviderStatusCache, writeProviderStatusCache } from "./providerStatusCache.ts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";

const provider = (id: string, checkedAt = "1970-01-01T00:00:00.000Z"): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "account@example.test" },
  checkedAt,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt,
    windows: [
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 50,
        resetsAt: "1970-01-08T00:00:00.000Z",
      },
    ],
  },
});

const withRegistry = <A, E, R>(
  entries: readonly { provider: ServerProvider; refresh: Effect.Effect<ServerProvider> }[],
  test: Effect.Effect<A, E, R | ProviderRegistry.ProviderRegistry>,
  baseDir?: string,
) => {
  const instances = entries.map(({ provider, refresh }) => ({
    instanceId: provider.instanceId,
    driverKind: provider.driver,
    continuationIdentity: { driverKind: provider.driver, continuationKey: provider.instanceId },
    displayName: undefined,
    enabled: provider.enabled,
    snapshot: {
      getSnapshot: Effect.succeed(provider),
      refresh,
      streamChanges: Stream.empty,
      applyUsageLimits: () => Effect.void,
      resolveMaintenance: () => Effect.die("unused"),
    },
    orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
    textGeneration: {} as ProviderInstance["textGeneration"],
  })) satisfies ProviderInstance[];
  const registryLayer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
    listInstances: Effect.succeed(instances),
    listUnavailable: Effect.succeed([]),
    getInstance: (id) => Effect.succeed(instances.find((instance) => instance.instanceId === id)),
    streamChanges: Stream.empty,
    subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
  });
  return test.pipe(
    Effect.provide(
      ProviderRegistry.layer.pipe(
        Layer.provide(registryLayer),
        Layer.provide(ModelManifest.layerTest),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), baseDir ?? { prefix: "t3-usage-refresh-" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
};

it.effect("serves saved models and quota before independently refreshing two providers", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-restart-" });
    const caches = `${baseDir}/caches`;
    yield* fs.makeDirectory(caches, { recursive: true });
    yield* TestClock.setTime(60_000);
    const now = DateTime.formatIso(yield* DateTime.now);
    const { usageLimits: _limits, ...base } = provider("codex");
    const model = {
      slug: "detected",
      name: "Detected",
      isCustom: false,
      capabilities: { optionDescriptors: [{ id: "fast", label: "Fast", type: "boolean" }] },
    } satisfies ServerProvider["models"][number];
    const previous = { ...provider("codex"), models: [model] };
    const other = { ...previous, instanceId: ProviderInstanceId.make("codex_other") };
    for (const cached of [previous, other]) {
      yield* writeProviderStatusCache({
        filePath: `${caches}/${cached.instanceId}.json`,
        provider: cached,
      });
    }
    const oldOnDisk = yield* readProviderStatusCache(`${caches}/codex.json`);
    const slowStarted = yield* Deferred.make<void>();
    const releaseSlow = yield* Deferred.make<void>();
    const pending: ServerProvider = {
      ...base,
      auth: { ...base.auth, status: "unknown" },
      installed: false,
      status: "warning",
      refreshing: true,
      checkedAt: now,
      models: [{ ...model, capabilities: null }],
    };
    const fail = {
      ...previous,
      checkedAt: now,
      usageLimits: makeUnavailableUsageLimits({ checkedAt: now, reason: "probeFailed" }),
    };
    yield* withRegistry(
      [
        {
          provider: pending,
          refresh: Deferred.succeed(slowStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseSlow)),
            Effect.as(fail),
          ),
        },
        {
          provider: { ...pending, instanceId: other.instanceId },
          refresh: Effect.succeed({
            ...other,
            checkedAt: now,
            usageLimits: { ...other.usageLimits!, checkedAt: now },
          }),
        },
      ],
      Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        expect(yield* registry.getProviders).toMatchObject(
          [previous, other].map((cached) => ({
            instanceId: cached.instanceId,
            refreshing: true,
            installed: true,
            status: "ready",
            models: cached.models,
            usageLimits: { ...cached.usageLimits, refreshing: true },
          })),
        );
        expect(yield* readProviderStatusCache(`${caches}/codex.json`)).toEqual(oldOnDisk);
        const failure = {
          kind: "billing_error",
          outOfCredit: true,
          occurredAt: now,
          message: "Out of credit",
        } as const;
        yield* registry.setProviderRecentFailure({ instanceId: previous.instanceId, failure });
        expect((yield* registry.getProviders)[0]?.recentFailure).toEqual(failure);
        expect((yield* readProviderStatusCache(`${caches}/codex.json`))?.recentFailure).toEqual(
          failure,
        );
        yield* registry.setProviderRecentFailure({
          instanceId: previous.instanceId,
          failure: null,
        });
        expect((yield* registry.getProviders)[0]?.recentFailure).toBeUndefined();
        expect(yield* readProviderStatusCache(`${caches}/codex.json`)).toEqual(oldOnDisk);

        const slowRefresh = yield* registry
          .refreshInstance(previous.instanceId)
          .pipe(Effect.forkChild);
        yield* Deferred.await(slowStarted);
        const fast = yield* registry.refreshInstance(other.instanceId);
        expect(fast[1]?.refreshing).toBeUndefined();
        expect(fast[1]?.usageLimits?.checkedAt).toBe(now);
        expect(fast[0]?.refreshing).toBe(true);
        yield* Deferred.succeed(releaseSlow, undefined);
        const failed = yield* Fiber.join(slowRefresh);
        expect(failed[0]?.usageLimits).toMatchObject({ ...previous.usageLimits, refreshing: true });
        expect(failed[0]?.usageLimits?.unavailable).toBeUndefined();
      }),
      baseDir,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "expires cached readiness after consecutive incomplete probes and resets on success",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-readiness-" });
      const caches = `${baseDir}/caches`;
      yield* fs.makeDirectory(caches, { recursive: true });
      const { usageLimits: _limits, ...ready } = provider("codex");
      const saved: ServerProvider = {
        ...ready,
        models: [{ slug: "detected", name: "Detected", isCustom: false, capabilities: null }],
      };
      yield* writeProviderStatusCache({ filePath: `${caches}/codex.json`, provider: saved });
      const incomplete: ServerProvider = {
        ...ready,
        installed: false,
        auth: { status: "unknown" },
        status: "warning",
        refreshing: true,
        message: "Provider check timed out.",
      };
      const current = yield* Ref.make(incomplete);
      const refresh = Effect.gen(function* () {
        return { ...(yield* Ref.get(current)), checkedAt: DateTime.formatIso(yield* DateTime.now) };
      });
      yield* TestClock.setTime(60_000);
      yield* withRegistry(
        [{ provider: incomplete, refresh }],
        Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          expect((yield* registry.getProviders)[0]).toMatchObject({
            status: "ready",
            refreshing: true,
            models: saved.models,
          });
          yield* TestClock.adjust("1 minute");
          expect((yield* registry.refreshInstance(saved.instanceId))[0]?.status).toBe("ready");
          yield* TestClock.adjust("1 minute");
          expect((yield* registry.refreshInstance(saved.instanceId))[0]).toMatchObject({
            status: "warning",
            installed: false,
            auth: incomplete.auth,
            message: incomplete.message,
            models: saved.models,
          });
          yield* TestClock.adjust("1 minute");
          expect((yield* registry.refreshInstance(saved.instanceId))[0]?.status).toBe("warning");

          yield* Ref.set(current, saved);
          expect((yield* registry.refreshInstance(saved.instanceId))[0]).toMatchObject({
            status: "ready",
            installed: true,
          });
          yield* Ref.set(current, incomplete);
          expect((yield* registry.refreshInstance(saved.instanceId))[0]?.status).toBe("ready");
          yield* TestClock.adjust("1 minute");
          expect((yield* registry.refreshInstance(saved.instanceId))[0]?.status).toBe("ready");
          yield* TestClock.adjust("1 minute");
          expect((yield* registry.refreshInstance(saved.instanceId))[0]?.status).toBe("warning");
        }),
        baseDir,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("does not refresh a fresh reading even when provider health is old", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    yield* TestClock.setTime(11 * 60_000);
    const current = {
      ...provider("codex"),
      usageLimits: {
        ...provider("codex").usageLimits!,
        checkedAt: "1970-01-01T00:11:00.000Z",
      },
    };
    yield* withRegistry(
      [{ provider: current, refresh: Ref.update(calls, (n) => n + 1).pipe(Effect.as(current)) }],
      Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const result = yield* registry.getProvidersForUsageLimits();
        expect(result[0]?.usageLimits?.checkedAt).toBe(current.usageLimits!.checkedAt);
        expect(yield* Ref.get(calls)).toBe(0);
      }),
    );
  }),
);

it.effect(
  "refreshes stale providers in parallel and returns fresh answers within the shared deadline",
  () =>
    Effect.gen(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const hungStarted = yield* Deferred.make<void>();
      const releaseHung = yield* Deferred.make<void>();
      const completed = yield* Deferred.make<void>();
      const fresh = provider("codex", "1970-01-01T00:11:01.000Z");
      yield* withRegistry(
        [
          {
            provider: provider("codex"),
            refresh: Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Deferred.await(hungStarted)),
              Effect.andThen(Deferred.succeed(completed, undefined)),
              Effect.as(fresh),
            ),
          },
          {
            provider: provider("codex_work"),
            refresh: Deferred.succeed(hungStarted, undefined).pipe(
              Effect.andThen(Effect.uninterruptible(Deferred.await(releaseHung))),
              Effect.as(provider("codex_work")),
            ),
          },
        ],
        Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          yield* TestClock.setTime(11 * 60_000);
          const persisted = yield* registry.streamChanges.pipe(
            Stream.filter((providers) =>
              providers.some((row) => row.usageLimits?.checkedAt === fresh.usageLimits!.checkedAt),
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          const start = yield* Clock.currentTimeMillis;
          const fiber = yield* registry.getProvidersForUsageLimits().pipe(Effect.forkChild);
          yield* Deferred.await(firstStarted);
          yield* Deferred.await(hungStarted);
          yield* Deferred.await(completed);
          yield* Fiber.join(persisted);
          yield* TestClock.adjust("3 seconds");
          const result = yield* Fiber.join(fiber);
          expect((yield* Clock.currentTimeMillis) - start).toBe(3000);
          const report = collectUsageLimits(result, [], yield* Clock.currentTimeMillis, {});
          expect(report.providers.map((row) => row.stale)).toEqual([false, true]);
          expect(report.providers[0]?.checkedAt).toBe(fresh.usageLimits!.checkedAt);
        }).pipe(Effect.ensuring(Deferred.succeed(releaseHung, undefined))),
      );
    }),
);

it.effect("only refreshes the requested enabled instance and also rechecks expired resets", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    const expired = {
      ...provider("codex"),
      usageLimits: {
        ...provider("codex").usageLimits!,
        windows: [
          { ...provider("codex").usageLimits!.windows[0]!, resetsAt: "1970-01-01T00:00:00.000Z" },
        ],
      },
    };
    const disabled = { ...provider("codex_disabled"), enabled: false };
    yield* withRegistry(
      [expired, provider("codex_work"), disabled].map((p) => ({
        provider: p,
        refresh: Effect.sync(() => {
          calls.push(p.instanceId);
          return p;
        }),
      })),
      Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        yield* registry.getProvidersForUsageLimits(expired.instanceId);
        expect(calls).toEqual([expired.instanceId]);
        yield* registry.getProvidersForUsageLimits(disabled.instanceId);
        expect(calls).toEqual([expired.instanceId]);
        yield* TestClock.setTime(12 * 60_000);
        yield* registry.getProvidersForUsageLimits([expired.instanceId, disabled.instanceId]);
        expect(calls).toEqual([expired.instanceId, expired.instanceId]);
      }),
    );
  }),
);

it.effect("starts at most one probe a minute for a reading that stays stale", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    yield* TestClock.setTime(11 * 60_000);
    const stuck = provider("codex");
    yield* withRegistry(
      [{ provider: stuck, refresh: Ref.update(calls, (n) => n + 1).pipe(Effect.as(stuck)) }],
      Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        yield* registry.getProvidersForUsageLimits();
        yield* registry.getProvidersForUsageLimits();
        expect(yield* Ref.get(calls)).toBe(1);
        yield* TestClock.adjust("1 minute");
        yield* registry.getProvidersForUsageLimits();
        expect(yield* Ref.get(calls)).toBe(2);
      }),
    );
  }),
);

it.effect("does not show the old workspace's quota after switching workspaces", () =>
  Effect.gen(function* () {
    const original = provider("codex");
    const auth = { ...original.auth, email: "account@example.test", workspaceId: "personal" };
    const live = { ...original, auth };
    const failedAt = {
      ...original,
      usageLimits: makeUnavailableUsageLimits({
        checkedAt: "1970-01-01T00:01:00.000Z",
        reason: "probeFailed",
      }),
    };
    const current = yield* Ref.make(live);
    yield* withRegistry(
      [{ provider: live, refresh: Ref.get(current) }],
      Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        yield* TestClock.setTime(60_000);
        yield* Ref.set(current, { ...failedAt, auth });
        const sameWorkspace = yield* registry.refreshInstance(live.instanceId);
        expect(sameWorkspace[0]?.usageLimits?.windows).toHaveLength(1);
        yield* Ref.set(current, { ...failedAt, auth: { ...auth, workspaceId: "work" } });
        const newWorkspace = yield* registry.refreshInstance(live.instanceId);
        expect(newWorkspace[0]?.usageLimits).toEqual(failedAt.usageLimits);
      }),
    );
  }),
);

it.effect(
  "carries quota for the same credential fingerprint only when account identity is absent",
  () =>
    Effect.gen(function* () {
      const setup = (id: string, credentialFingerprint?: string) => {
        const original = provider(id);
        return {
          ...original,
          auth: { status: "authenticated", type: "oauth" },
          usageLimits: { ...original.usageLimits!, credentialFingerprint },
        } satisfies ServerProvider;
      };
      const matched = setup("codex", "fixture-account");
      const changed = setup("codex_changed", "old-fixture-account");
      const unidentified = setup("codex_unidentified");
      const entries = [
        { original: matched, fingerprint: "fixture-account", expectedWindows: 1 },
        { original: changed, fingerprint: "new-fixture-account", expectedWindows: 0 },
        { original: unidentified, fingerprint: undefined, expectedWindows: 0 },
      ].map(({ original, fingerprint, expectedWindows }) => {
        const failed = {
          ...original,
          usageLimits: {
            ...makeUnavailableUsageLimits({
              checkedAt: "1970-01-01T00:01:00.000Z",
              reason: "probeFailed",
            }),
            credentialFingerprint: fingerprint,
          },
        };
        return { provider: original, refresh: Effect.succeed(failed), expectedWindows };
      });
      yield* withRegistry(
        entries,
        Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          yield* TestClock.setTime(60_000);
          for (const entry of entries) {
            const result = yield* registry.refreshInstance(entry.provider.instanceId);
            expect(
              result.find((row) => row.instanceId === entry.provider.instanceId)?.usageLimits
                ?.windows,
            ).toHaveLength(entry.expectedWindows);
          }
        }),
      );
    }),
);

it.effect(
  "invalidates Claude readiness and quota on a credential change live and across boot",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-credential-cache-" });
      const driverKind = ProviderDriverKind.make("claudeAgent");
      const instanceId = ProviderInstanceId.make("claude_token");
      const config = (value: string) => ({
        [instanceId]: {
          driver: driverKind,
          environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value, sensitive: true }],
          config: { alwaysUseToken: true },
        },
      });
      const alpha = config("synthetic-a");
      const beta = config("synthetic-b");
      const cached: ServerProvider = {
        ...provider(instanceId),
        driver: driverKind,
        auth: { status: "authenticated" },
      };
      const { usageLimits: _cachedLimits, ...status } = cached;
      const pending: ServerProvider = {
        ...status,
        installed: false,
        status: "warning",
        auth: { status: "unknown" },
        refreshing: true,
      };
      const probeStarted = yield* Deferred.make<void>();
      const finishOldProbe = yield* Deferred.make<void>();
      const driver = {
        driverKind,
        metadata: { displayName: "Claude", supportsMultipleInstances: true },
        configSchema: Schema.Struct({ alwaysUseToken: Schema.Boolean }),
        defaultConfig: () => ({ alwaysUseToken: true }),
        create: ({ environment, enabled }) => {
          const first = environment[0]?.value === "synthetic-a";
          return Effect.succeed({
            instanceId,
            driverKind,
            continuationIdentity: { driverKind, continuationKey: "same-home" },
            displayName: undefined,
            enabled,
            snapshot: {
              getSnapshot: Effect.succeed(pending),
              refresh: first
                ? Deferred.succeed(probeStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishOldProbe)),
                    Effect.as(cached),
                  )
                : Effect.succeed(pending),
              streamChanges: Stream.empty,
              applyUsageLimits: () => Effect.void,
              resolveMaintenance: () => Effect.die("unused"),
            },
            orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
            textGeneration: {} as ProviderInstance["textGeneration"],
          });
        },
      } satisfies ProviderDriver<{ readonly alwaysUseToken: boolean }>;
      const makeRegistry = (configMap: ReturnType<typeof config>) =>
        ProviderInstanceRegistry.makeProviderInstanceRegistry({ drivers: [driver], configMap });
      const withInstances = <A, E, R>(
        instances: ProviderInstanceRegistry.ProviderInstanceRegistry["Service"],
        effect: Effect.Effect<A, E, R | ProviderRegistry.ProviderRegistry>,
      ) =>
        effect.pipe(
          Effect.provide(
            ProviderRegistry.layer.pipe(
              Layer.provide(
                Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, instances),
              ),
              Layer.provide(ModelManifest.layerTest),
              Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
              Layer.provide(NodeServices.layer),
            ),
          ),
          Effect.scoped,
        );
      const old = yield* makeRegistry(alpha);
      const credentialFingerprint = (yield* old.registry.getInstance(instanceId))
        ?.credentialSettings?.fingerprint;
      expect(credentialFingerprint).toMatch(/^[a-f\d]{64}$/);
      const filePath = `${baseDir}/caches/${instanceId}.json`;
      yield* fs.makeDirectory(`${baseDir}/caches`, { recursive: true });
      yield* writeProviderStatusCache({
        filePath,
        provider: cached,
        configuredCredentialFingerprint: credentialFingerprint,
      });
      const assertPending = (snapshot: ServerProvider | undefined) => {
        expect(snapshot).toMatchObject({ status: "warning", installed: false, auth: pending.auth });
        expect(snapshot?.usageLimits).toBeUndefined();
      };
      const replacement = yield* makeRegistry(beta);
      yield* withInstances(
        replacement.registry,
        Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          assertPending((yield* registry.getProviders)[0]);
        }),
      );
      yield* withInstances(
        old.registry,
        Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          expect((yield* registry.getProviders)[0]).toMatchObject({
            status: "ready",
            usageLimits: { refreshing: true, windows: cached.usageLimits?.windows },
          });
          const oldProbe = yield* registry.refreshInstance(instanceId).pipe(Effect.forkChild);
          yield* Deferred.await(probeStarted);
          const newSnapshot = yield* registry.streamChanges.pipe(
            Stream.flatMap(Stream.fromIterable),
            Stream.filter((snapshot) => snapshot.instanceId === instanceId && !snapshot.installed),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* old.mutator.reconcile(beta);
          yield* Fiber.join(newSnapshot);
          yield* Deferred.succeed(finishOldProbe, undefined);
          assertPending((yield* Fiber.join(oldProbe))[0]);
          assertPending((yield* registry.getProviders)[0]);
          expect(yield* readProviderStatusCache(filePath)).toBeUndefined();
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "serves the reading saved before a restart while probes read nothing, until a live one",
  () =>
    Effect.gen(function* () {
      const HOUR = 3_600_000;
      const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-usage-fallback-" });
      const caches = `${baseDir}/caches`;
      yield* fs.makeDirectory(caches, { recursive: true });
      const saved = (id: string): ServerProvider => ({
        ...provider(id, iso(0)),
        usageLimits: {
          checkedAt: iso(0),
          windows: [
            {
              id: "five_hour",
              kind: "session",
              label: "5-hour",
              usedPercent: 80,
              resetsAt: iso(HOUR),
            },
            { ...provider(id).usageLimits!.windows[0]!, usedPercent: 40 },
          ],
        },
      });
      for (const id of ["codex", "codex_pending"]) {
        yield* writeProviderStatusCache({ filePath: `${caches}/${id}.json`, provider: saved(id) });
      }
      yield* TestClock.setTime(2 * HOUR);
      const failedAt = (id: string, ms: number): ServerProvider => ({
        ...provider(id, iso(ms)),
        usageLimits: makeUnavailableUsageLimits({
          checkedAt: iso(ms),
          reason: "probeFailed",
          message: "Limits show again the next time it runs.",
        }),
      });
      const current = yield* Ref.make(failedAt("codex", 2 * HOUR));
      // Never read before this process and not readable now: only the notice remains.
      const unread = failedAt("codex_work", 2 * HOUR);
      // Published before its first probe, so it carries no limits yet.
      const { usageLimits: _none, ...pending } = provider("codex_pending", iso(2 * HOUR));
      yield* withRegistry(
        [
          { provider: yield* Ref.get(current), refresh: Ref.get(current) },
          { provider: unread, refresh: Effect.succeed(unread) },
          {
            provider: { ...pending, auth: { status: "unknown" }, refreshing: true },
            refresh: Effect.succeed(pending),
          },
        ],
        Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          const limitsOf = (providers: ReadonlyArray<ServerProvider>, id: string) =>
            providers.find((row) => row.instanceId === id)?.usageLimits;

          const booted = yield* registry.getProviders;
          const older = limitsOf(booted, "codex");
          expect(older?.checkedAt).toBe(iso(0));
          expect(older?.unavailable?.message).toBe("Limits show again the next time it runs.");
          // The five-hour window reset an hour ago, so its 80% says nothing now.
          expect(older?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
            ["weekly", 40],
          ]);
          expect(limitsOf(booted, "codex_work")).toEqual(unread.usageLimits);
          expect(limitsOf(booted, "codex_pending")).toBeUndefined();
          yield* registry.setProviderRecentUse(new Map([[pending.instanceId, 1]]));
          expect(limitsOf(yield* registry.getProviders, "codex_pending")).toBeUndefined();
          // A second restart before the first probe still finds the saved reading.
          const onDisk = yield* readProviderStatusCache(`${caches}/codex_pending.json`);
          expect(onDisk?.usageLimits?.windows).toHaveLength(2);
          const identified = yield* registry.refreshInstance(pending.instanceId);
          expect(limitsOf(identified, "codex_pending")?.windows).toHaveLength(1);

          const live = provider("codex", iso(2 * HOUR));
          yield* Ref.set(current, live);
          const refreshed = yield* registry.getProvidersForUsageLimits(
            ProviderInstanceId.make("codex"),
          );
          expect(limitsOf(refreshed, "codex")?.unavailable).toBeUndefined();
          expect(limitsOf(refreshed, "codex")?.windows.map((window) => window.usedPercent)).toEqual(
            [50],
          );

          // The next failure falls back to that live reading, not the one from before the restart.
          yield* TestClock.setTime(3 * HOUR);
          yield* Ref.set(current, failedAt("codex", 3 * HOUR));
          const failedAgain = yield* registry.getProvidersForUsageLimits(
            ProviderInstanceId.make("codex"),
          );
          expect(limitsOf(failedAgain, "codex")?.checkedAt).toBe(iso(2 * HOUR));
          expect(limitsOf(failedAgain, "codex")?.unavailable?.reason).toBe("probeFailed");
          expect(
            limitsOf(failedAgain, "codex")?.windows.map((window) => window.usedPercent),
          ).toEqual([50]);
        }),
        baseDir,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
