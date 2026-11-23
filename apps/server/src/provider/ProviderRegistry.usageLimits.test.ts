import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
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
  auth: { status: "authenticated" },
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
          { provider: pending, refresh: Effect.succeed(pending) },
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
          // A second restart before the first probe still finds the saved reading.
          const onDisk = yield* readProviderStatusCache(`${caches}/codex_pending.json`);
          expect(onDisk?.usageLimits?.windows).toHaveLength(2);

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
