import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRankingCategory,
  type ModelRankings,
  type ServerProvider,
  type ServerSettings as Settings,
} from "@t3tools/contracts";
import { positionModelRankingEntry } from "@t3tools/shared/modelRankings";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ServerSettings from "../serverSettings.ts";
import * as ModelPreferences from "./ModelPreferences.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

it.effect("skips an unavailable account and resumes recommendations after recheck", () =>
  Effect.gen(function* () {
    const service = yield* ModelPreferences.ModelPreferences;
    const result = yield* service.lookup({ task: "review" });
    expect(result.recommendations).toEqual([]);
    expect(result.unavailableCount).toBe(1);
    yield* TestClock.setTime(Date.parse("2999-01-01T00:00:00.000Z"));
    expect((yield* service.lookup({ task: "review" })).recommendations[0]?.providerInstanceId).toBe(
      instanceId,
    );
  }).pipe(
    Effect.provide(
      dependencies(
        [category],
        [
          {
            ...provider(),
            recentFailure: {
              kind: "permission_error",
              message: "Permission denied.",
              occurredAt: "2000-01-01T00:00:00.000Z",
              resetAt: "2999-01-01T00:00:00.000Z",
            },
          },
        ],
      ),
    ),
  ),
);

const instanceId = ProviderInstanceId.make("codex-personal");
const provider = (models = ["gpt-6-sol", "gpt-6.1-sol"]): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-27T00:00:00.000Z",
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
});
const category: ModelRankingCategory = {
  id: "review",
  name: "Review",
  entries: [{ id: "codex", family: "codex", label: "Codex", tier: "S" }],
  order: ["codex"],
  comparisons: [],
};
const dependencies = (
  modelRankings: ModelRankings = [category],
  providers: ReadonlyArray<ServerProvider> = [provider()],
  settings: Partial<Settings> = {},
) =>
  ModelPreferences.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ServerSettings.layerTest({
          providerInstances: Object.fromEntries(
            providers.map((item) => [
              item.instanceId,
              { driver: item.driver, enabled: true, config: {} },
            ]),
          ),
          ...settings,
          modelRankings,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
      ),
    ),
  );

it.effect("new releases inherit the family preference and never return a superseded version", () =>
  Effect.gen(function* () {
    const service = yield* ModelPreferences.ModelPreferences;
    const result = yield* service.lookup({ task: "code review" });
    expect(result.matchedCategory?.id).toBe("review");
    expect(result.recommendations).toEqual([
      { family: "codex", providerInstanceId: instanceId, model: "gpt-6.1-sol", tier: "S" },
    ]);
    expect(
      (yield* (yield* ServerSettings.ServerSettingsService).getSettings).modelRankings,
    ).toEqual([category]);
    expect((yield* service.lookup({ task: "translation" })).matchedCategory).toBeNull();
    expect(result.notes.join(" ")).toContain("concrete valid reason");
  }).pipe(Effect.provide(dependencies())),
);

it.effect("prefers a current provider default within a family without pinning its version", () =>
  Effect.gen(function* () {
    const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({ task: "review" });
    expect(result.recommendations[0]?.model).toBe("gpt-6-astra");
  }).pipe(
    Effect.provide(
      dependencies(
        [category],
        [
          {
            ...provider(["gpt-6.1-sol", "gpt-6-astra"]),
            models: provider(["gpt-6.1-sol", "gpt-6-astra"]).models.map((model) => ({
              ...model,
              isDefault: model.slug === "gpt-6-astra",
            })),
          },
        ],
      ),
    ),
  ),
);

it.effect(
  "skips an unavailable family's rank and resolves the next family from another harness",
  () =>
    Effect.gen(function* () {
      const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({
        task: "review",
        limit: 1,
      });
      expect(result.recommendations).toEqual([
        {
          family: "claude",
          providerInstanceId: ProviderInstanceId.make("cursor"),
          model: "claude-fable-5-1",
        },
      ]);
      expect(result.unavailableCount).toBe(1);
    }).pipe(
      Effect.provide(
        dependencies(
          [
            {
              ...category,
              entries: [...category.entries, { id: "claude", family: "claude", label: "Claude" }],
              order: ["codex", "claude"],
            },
          ],
          [
            { ...provider(), enabled: false },
            {
              ...provider(["claude-fable-5-1"]),
              instanceId: ProviderInstanceId.make("cursor"),
              driver: ProviderDriverKind.make("cursor"),
            },
          ],
        ),
      ),
    ),
);

it.effect("hidden successors never make superseded or legacy models recommendations", () =>
  Effect.gen(function* () {
    const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({ task: "review" });
    expect(result.recommendations).toEqual([]);
    expect(result.unavailableCount).toBe(1);
    expect(result.notes.join(" ")).toContain("fallback");
  }).pipe(
    Effect.provide(
      dependencies(
        [category],
        [
          {
            ...provider(),
            models: [
              ...provider().models,
              {
                slug: "gpt-legacy",
                name: "Old model",
                isCustom: false,
                isLegacy: true,
                capabilities: null,
              },
            ],
          },
        ],
        {
          providerModelPreferences: {
            [instanceId]: { hiddenModels: ["gpt-6.1-sol"], modelOrder: [] },
          },
        },
      ),
    ),
  ),
);

it.effect("unranked family contenders never imply a preference", () =>
  Effect.gen(function* () {
    const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({ task: "review" });
    expect(result.recommendations).toEqual([]);
    expect(result.notes.join(" ")).toContain("no ranked families");
  }).pipe(
    Effect.provide(
      dependencies([
        { ...category, entries: [{ id: "codex", family: "codex", label: "Codex" }], order: [] },
      ]),
    ),
  ),
);

it.effect("returns compact family notes while preserving their full saved text", () => {
  const note = `Useful for difficult reviews.\n${"x".repeat(450)}`;
  return Effect.gen(function* () {
    const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({ task: "review" });
    expect(result.recommendations[0]?.note).toBe(`${note.replace(/\s+/g, " ").slice(0, 179)}…`);
    expect(
      (yield* (yield* ServerSettings.ServerSettingsService).getSettings).modelRankings[0]
        ?.entries[0]?.note,
    ).toBe(note);
  }).pipe(
    Effect.provide(dependencies([{ ...category, entries: [{ ...category.entries[0]!, note }] }])),
  );
});

it.effect("bounds lookup to five ranked families and matches the task category", () => {
  const families = ["codex", "claude", "grok", "kimi", "gemini", "qwen"];
  const review: ModelRankingCategory = {
    ...category,
    entries: families.map((family) => ({ id: family, family, label: family })),
    order: families,
  };
  return Effect.gen(function* () {
    const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({
      task: "code review",
      limit: 5,
    });
    expect(result.recommendations.map((entry) => entry.family)).toEqual(families.slice(0, 5));
  }).pipe(
    Effect.provide(
      dependencies(
        [{ ...category, id: "implementation", name: "Implementation" }, review],
        [provider(["gpt-6.1-sol", "claude-fable-5-1", "grok-5", "kimi-k3", "gemini-4", "qwen-4"])],
      ),
    ),
  );
});

it.effect.each([{ family: "claude" }, { subProvider: "anthropic" }])(
  "uses late live metadata for an opaque migrated preference without agent writes: %s",
  (metadata) => {
    const snapshot: ServerProvider = {
      ...provider(),
      driver: ProviderDriverKind.make("opencode"),
      models: [
        { slug: "version-123", name: "Opaque", isCustom: false, capabilities: null, ...metadata },
      ],
    };
    const saved: ModelRankingCategory = {
      ...category,
      entries: [
        {
          id: "opaque",
          label: "Opaque",
          selection: { instanceId, model: "version-123" },
          tier: "S",
          note: "Keep my note",
        },
      ],
      order: ["opaque"],
    };
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const before = (yield* settings.getSettings).modelRankings;
      expect(before[0]?.entries[0]).toMatchObject({ family: "provider:opencode" });
      const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({ task: "review" });
      expect(result.recommendations).toEqual([
        {
          family: "claude",
          providerInstanceId: instanceId,
          model: "version-123",
          tier: "S",
          note: "Keep my note",
        },
      ]);
      expect((yield* settings.getSettings).modelRankings).toEqual(before);
    }).pipe(Effect.provide(dependencies([saved], [snapshot])));
  },
);

it.effect(
  "prefers a newer release on another instance even when the older route is default",
  () => {
    const old: ServerProvider = {
      ...provider(["openai/gpt-6-sol"]),
      driver: ProviderDriverKind.make("opencode"),
      models: provider(["openai/gpt-6-sol"]).models.map((model) => ({ ...model, isDefault: true })),
    };
    const newer: ServerProvider = {
      ...provider(["openrouter/openai/gpt-6.1-sol"]),
      instanceId: ProviderInstanceId.make("z-new"),
      driver: ProviderDriverKind.make("opencode"),
    };
    return Effect.gen(function* () {
      const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({ task: "review" });
      expect(result.recommendations[0]).toMatchObject({
        family: "codex",
        providerInstanceId: newer.instanceId,
        model: "openrouter/openai/gpt-6.1-sol",
      });
    }).pipe(Effect.provide(dependencies([category], [old, newer])));
  },
);

it.effect(
  "reads all ranked opaque families after snapshot-free boot without writing the archive",
  () => {
    const snapshot: ServerProvider = {
      ...provider(),
      driver: ProviderDriverKind.make("opencode"),
      models: [
        {
          slug: "version-123",
          name: "First",
          family: "claude",
          isCustom: false,
          capabilities: null,
        },
        {
          slug: "version-456",
          name: "Second",
          family: "codex",
          isCustom: false,
          capabilities: null,
        },
      ],
    };
    const saved: ModelRankingCategory = {
      ...category,
      entries: [
        {
          id: "first",
          label: "First",
          selection: { instanceId, model: "version-123" },
          tier: "S",
          note: "Claude note",
        },
        {
          id: "second",
          label: "Second",
          selection: { instanceId, model: "version-456" },
          tier: "A",
          note: "Codex note",
        },
      ],
      order: ["first", "second"],
    };
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const before = (yield* settings.getSettings).modelRankings;
      expect(before[0]?.entries).toHaveLength(1);
      const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({ task: "review" });
      expect(result.recommendations).toEqual([
        {
          family: "claude",
          providerInstanceId: instanceId,
          model: "version-123",
          tier: "S",
          note: "Claude note",
        },
        {
          family: "codex",
          providerInstanceId: instanceId,
          model: "version-456",
          tier: "A",
          note: "Codex note",
        },
      ]);
      expect((yield* settings.getSettings).modelRankings).toEqual(before);
    }).pipe(Effect.provide(dependencies([saved], [snapshot])));
  },
);

it.effect(
  "returns tier order before within-tier order after moves, excluding unranked families",
  () => {
    const saved: ModelRankingCategory = {
      ...category,
      entries: [
        { id: "codex", family: "codex", label: "Codex", tier: "A" },
        { id: "claude", family: "claude", label: "Claude", tier: "B" },
        { id: "grok", family: "grok", label: "Grok", tier: "S" },
        { id: "kimi", family: "kimi", label: "Kimi", tier: "F" },
        { id: "gemini", family: "gemini", label: "Gemini", tier: "D" },
      ],
      order: ["kimi", "codex", "grok", "claude", "gemini"],
    };
    const promoted = positionModelRankingEntry(saved, saved.entries[1]!, "S", 0);
    const reordered = positionModelRankingEntry(promoted, promoted.entries[1]!, "S", 1);
    const unranked = positionModelRankingEntry(reordered, reordered.entries[4]!, null);
    // Deliberately interleave tiers in storage to verify lookup, independently of the writer.
    const final = { ...unranked, order: ["kimi", "codex", "grok", "claude"] };
    return Effect.gen(function* () {
      const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({
        task: "review",
        limit: 5,
      });
      expect(result.recommendations).toEqual([
        { family: "grok", providerInstanceId: instanceId, model: "grok-5", tier: "S" },
        { family: "claude", providerInstanceId: instanceId, model: "claude-opus-5-5", tier: "S" },
        { family: "codex", providerInstanceId: instanceId, model: "gpt-6.1-sol", tier: "A" },
        { family: "kimi", providerInstanceId: instanceId, model: "kimi-k3", tier: "F" },
      ]);
      expect(result.unavailableCount).toBe(0);
      expect(
        (yield* (yield* ServerSettings.ServerSettingsService).getSettings).modelRankings,
      ).toEqual([final]);
    }).pipe(
      Effect.provide(
        dependencies(
          [final],
          [provider(["gpt-6.1-sol", "claude-opus-5-5", "grok-5", "kimi-k3", "gemini-4"])],
        ),
      ),
    );
  },
);

it.effect("keeps a recommendation whose account is limited only on another model", () =>
  Effect.gen(function* () {
    const result = yield* (yield* ModelPreferences.ModelPreferences).lookup({ task: "review" });
    expect(result.recommendations[0]?.model).toBe("gpt-6.1-sol");
    expect(result.unavailableCount).toBe(0);
  }).pipe(
    Effect.provide(
      dependencies(
        [category],
        [
          {
            ...provider(),
            recentFailure: {
              kind: "usage_limit",
              message: "Model limit reached.",
              modelIds: ["gpt-6-sol"],
              occurredAt: "2000-01-01T00:00:00.000Z",
              resetAt: "2999-01-01T00:00:00.000Z",
            },
          },
        ],
      ),
    ),
  ),
);
