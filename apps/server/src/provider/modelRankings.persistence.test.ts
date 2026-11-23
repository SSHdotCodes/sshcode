import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings as SettingsSchema,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  compareModelRankingEntries,
  emptyModelRankingCategory,
  moveModelRankingEntry,
  migrateModelRankings,
  resetModelRankingCategory,
  updateModelRankingEntry,
} from "@t3tools/shared/modelRankings";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Cause from "effect/Cause";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

it.effect(
  "saves comparison order, user tiers, notes, options and stale provider entries on disk, then resets them",
  () =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const entries = ["alpha", "bravo", "charlie"].map((id) => ({
        id,
        label: id,
        note: `Useful for ${id} work`,
        selection: {
          instanceId: ProviderInstanceId.make("removed-provider"),
          model: id,
          options: [{ id: "effort", value: "high" }],
        },
      }));
      const category = {
        ...emptyModelRankingCategory("implementation", "My implementation"),
        entries,
      };
      const compared = compareModelRankingEntries(category, "alpha", "bravo", "left");
      const reordered = moveModelRankingEntry(compared, "bravo", -1);
      const ranked = updateModelRankingEntry(reordered, { ...entries[2]!, tier: "S" });
      yield* settings.updateSettings({ modelRankings: [ranked] });
      const readFile = fs
        .readFileString(config.settingsPath)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SettingsSchema))));
      expect((yield* readFile).modelRankings).toEqual(migrateModelRankings([ranked]));
      const migrated = (yield* readFile).modelRankings[0]!;
      expect(migrated.entries).toEqual([
        {
          id: "charlie",
          family: "provider:removed-provider",
          pendingLegacyIds: ["charlie", "bravo", "alpha"],
          label: "removed-provider",
          note: "Useful for charlie work",
          tier: "S",
        },
      ]);
      expect(migrated.legacy).toEqual({
        entries: ranked.entries,
        order: ranked.order,
        comparisons: ranked.comparisons,
      });
      yield* settings.updateSettings({ branchNamePrefix: "unrelated" });
      expect((yield* readFile).modelRankings).toEqual(migrateModelRankings([ranked]));
      const reset = resetModelRankingCategory(ranked);
      yield* settings.updateSettings({ modelRankings: [reset] });
      expect((yield* readFile).modelRankings).toEqual(migrateModelRankings([reset]));
      yield* settings.updateSettings({ modelRankings: [] });
      expect((yield* readFile).modelRankings).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "model-rankings-persistence-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "rejects stale and unguarded client rankings inside persistence while unrelated settings still save",
  () =>
    Effect.gen(function* () {
      const service = yield* ServerSettings.ServerSettingsService;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const initial = [
        emptyModelRankingCategory("implementation", "Implementation"),
        emptyModelRankingCategory("review", "Review"),
      ];
      // Trusted internal initialization remains compatible.
      yield* service.updateSettings({ modelRankings: initial });
      const baseA = (yield* service.getSettings).modelRankings;
      const baseB = (yield* service.getSettings).modelRankings;
      const editA = baseA.map((category) =>
        category.id === "review" ? { ...category, name: "Review A" } : category,
      );
      const editB = baseB.map((category) =>
        category.id === "implementation" ? { ...category, name: "Implementation B" } : category,
      );
      const locked = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* service
        .withSettingsSnapshot(() =>
          Deferred.succeed(locked, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(locked);
      const startedA = yield* Deferred.make<void>();
      const startedB = yield* Deferred.make<void>();
      const clientA = yield* Deferred.succeed(startedA, undefined).pipe(
        Effect.andThen(
          service.updateSettings({ modelRankings: editA }, { expectedModelRankings: baseA }),
        ),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(startedA);
      const clientB = yield* Deferred.succeed(startedB, undefined).pipe(
        Effect.andThen(
          service.updateSettings({ modelRankings: editB }, { expectedModelRankings: baseB }),
        ),
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(startedB);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const outcomes = [yield* Fiber.join(clientA), yield* Fiber.join(clientB)];
      expect(outcomes.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(outcomes.filter((result) => result._tag === "Failure")).toHaveLength(1);
      const winner = outcomes.find((result) => result._tag === "Success")!;
      const loser = outcomes.find((result) => result._tag === "Failure")!;
      expect(Cause.squash(loser.cause)).toMatchObject({
        _tag: "ModelRankingsSaveError",
        reason: "conflict",
      });
      const saved = winner.value.modelRankings;
      expect([editA, editB]).toContainEqual(saved);
      expect((yield* service.getSettings).modelRankings).toEqual(saved);
      // Both clients still hold the original snapshot after the successful write.
      expect(
        yield* service
          .updateSettings({ modelRankings: editB }, { expectedModelRankings: baseB })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ModelRankingsSaveError", reason: "conflict" });
      // Older RPC clients do not supply a base. A present transport guard is mandatory.
      expect(
        yield* service
          .updateSettings({ modelRankings: editB }, { expectedModelRankings: undefined })
          .pipe(Effect.flip),
      ).toMatchObject({ _tag: "ModelRankingsSaveError", reason: "base-required" });
      const instanceId = ProviderInstanceId.make("should-not-be-created");
      expect(
        yield* service
          .updateProviderInstance(
            {
              operation: "create",
              instanceId,
              instance: { driver: ProviderDriverKind.make("codex"), config: {} },
            },
            { modelRankings: editB },
            { expectedModelRankings: undefined },
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "base-required" });
      expect((yield* service.getSettings).providerInstances[instanceId]).toBeUndefined();
      // Unrelated writes neither require nor validate a ranking base.
      yield* service.updateSettings(
        { branchNamePrefix: "still-works" },
        { expectedModelRankings: baseB },
      );
      yield* service.updateSettings(
        { branchNamePrefix: "old-client" },
        { expectedModelRankings: undefined },
      );
      expect((yield* service.getSettings).modelRankings).toEqual(saved);
      const reapplied = saved.map((category) => ({
        ...category,
        name: category.id === "implementation" ? "Implementation B" : "Review A",
      }));
      yield* service.updateSettings({ modelRankings: reapplied }, { expectedModelRankings: saved });
      const persisted = yield* fs
        .readFileString(config.settingsPath)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SettingsSchema))));
      expect(persisted.modelRankings).toEqual(reapplied);
      expect(persisted.branchNamePrefix).toBe("old-client");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "model-rankings-conflict-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "migrates a saved individual-model file on load and preserves conflicts through later guarded saves",
  () =>
    Effect.gen(function* () {
      const service = yield* ServerSettings.ServerSettingsService;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const original = {
        ...emptyModelRankingCategory("review", "Review"),
        entries: [
          {
            id: "old",
            label: "Old",
            selection: {
              instanceId: "codex",
              model: "gpt-6-sol",
              options: [{ id: "effort", value: "high" }],
            },
            note: "Original note",
            tier: "F",
          },
          {
            id: "new",
            label: "New",
            selection: { instanceId: "codex", model: "gpt-6.1-sol" },
            note: "Preferred note",
            tier: "S",
          },
        ],
        order: ["old", "new"],
        comparisons: [{ left: "old", right: "new", result: "left" }],
      };
      yield* fs.makeDirectory((yield* Path.Path).dirname(config.settingsPath), { recursive: true });
      yield* fs.writeFileString(config.settingsPath, JSON.stringify({ modelRankings: [original] }));
      const loaded = (yield* service.getSettings).modelRankings;
      expect(loaded[0]?.entries).toEqual([
        { id: "new", family: "codex:sol", label: "GPT Sol", note: "Preferred note", tier: "S" },
      ]);
      expect(loaded[0]?.legacy).toEqual({
        entries: original.entries,
        order: original.order,
        comparisons: original.comparisons,
      });
      const readFile = fs
        .readFileString(config.settingsPath)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SettingsSchema))));
      expect((yield* readFile).modelRankings).toEqual(loaded);
      const edited = loaded.map((category) => ({
        ...category,
        entries: category.entries.map((entry) => ({ ...entry, note: "Family note" })),
      }));
      yield* service.updateSettings({ modelRankings: edited }, { expectedModelRankings: loaded });
      expect((yield* readFile).modelRankings).toEqual(edited);
      expect((yield* readFile).modelRankings[0]?.legacy).toEqual(loaded[0]?.legacy);
      expect(
        yield* service
          .updateSettings({ modelRankings: loaded }, { expectedModelRankings: loaded })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "conflict" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "model-family-migration-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);

it.effect(
  "persists catalog reconciliation of a previously saved fallback with the original CAS base",
  () =>
    Effect.gen(function* () {
      const service = yield* ServerSettings.ServerSettingsService;
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const instanceId = ProviderInstanceId.make("opaque");
      const provider: ServerProvider = {
        instanceId,
        driver: ProviderDriverKind.make("opencode"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-27T00:00:00.000Z",
        models: [
          {
            slug: "version-123",
            name: "Opaque",
            family: "claude",
            isCustom: false,
            capabilities: null,
          },
          {
            slug: "version-456",
            name: "Other opaque",
            family: "codex",
            isCustom: false,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      };
      yield* service.updateSettings({
        providerInstances: { [instanceId]: { driver: provider.driver, enabled: true } },
        modelRankings: [
          {
            ...emptyModelRankingCategory("review", "Review"),
            entries: [
              {
                id: "opaque",
                label: "Opaque",
                selection: { instanceId, model: "version-123" },
                tier: "S",
                note: "Original note",
              },
              {
                id: "second",
                label: "Other opaque",
                selection: { instanceId, model: "version-456" },
                tier: "A",
                note: "Codex note",
              },
            ],
            order: ["opaque", "second"],
          },
        ],
      });
      const before = yield* service.getSettings;
      expect(before.modelRankings[0]?.entries[0]).toMatchObject({ family: "provider:opencode" });
      const canonical = migrateModelRankings(before.modelRankings, before.providerInstances, [
        provider,
      ]);
      expect(canonical[0]?.entries).toHaveLength(2);
      expect(canonical[0]?.entries[1]).toMatchObject({
        family: "codex",
        tier: "A",
        note: "Codex note",
      });
      expect(canonical[0]?.entries[0]).toMatchObject({
        id: "opaque",
        family: "claude",
        tier: "S",
        note: "Original note",
      });
      expect((yield* service.getSettings).modelRankings).toEqual(before.modelRankings);
      yield* service.updateSettings(
        { modelRankings: canonical },
        { expectedModelRankings: before.modelRankings },
      );
      const persisted = yield* fs
        .readFileString(config.settingsPath)
        .pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(SettingsSchema))));
      expect(persisted.modelRankings).toEqual(canonical);
      expect(persisted.modelRankings[0]?.legacy?.entries).toEqual(
        before.modelRankings[0]?.legacy?.entries,
      );
      expect(persisted.modelRankings[0]?.legacy?.families).toEqual(
        before.modelRankings[0]?.entries,
      );
      expect(
        yield* service
          .updateSettings(
            { modelRankings: before.modelRankings },
            { expectedModelRankings: before.modelRankings },
          )
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "conflict" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerSettings.layer.pipe(
          Layer.provide(ServerSecretStore.layer),
          Layer.provideMerge(SqlitePersistence.layerMemory),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "model-family-reconcile-" }),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
);
