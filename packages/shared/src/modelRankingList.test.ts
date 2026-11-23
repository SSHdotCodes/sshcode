import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ModelRankings,
  ModelRankingTier,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelRankingCategory,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  emptyModelRankingCategory,
  migrateModelRankings,
  modelRankingCatalog,
  modelRankingRows,
  orderedModelRankingEntries,
  positionModelRankingEntry,
  resetModelRankingCategory,
} from "./modelRankings.ts";

const provider = (
  driver: string,
  models: ReadonlyArray<string>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: ProviderInstanceId.make(driver),
  driver: ProviderDriverKind.make(driver),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-27T00:00:00.000Z",
  models: models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
  slashCommands: [],
  skills: [],
  ...overrides,
});
const settingsFor = (providers: ReadonlyArray<ServerProvider>) => ({
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: Object.fromEntries(
    providers.map((item) => [item.instanceId, { driver: item.driver, enabled: true, config: {} }]),
  ),
});
const empty = emptyModelRankingCategory("implementation", "Implementation");
const rankedIds = (category: ModelRankingCategory) =>
  orderedModelRankingEntries(category).map((entry) => entry.id);

it("lists usable families without adding contenders and labels their current release", () => {
  const providers = [
    provider("codex", ["gpt-6-sol", "gpt-6.1-sol"]),
    provider("claudeAgent", [], {
      models: [
        {
          slug: "claude-opus-5-4",
          name: "Opus 5.4",
          isCustom: false,
          isDefault: true,
          capabilities: null,
        },
        { slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, capabilities: null },
      ],
    }),
    provider("grok", ["grok-5"], { enabled: false }),
    provider("kimi", ["kimi-k3"], { auth: { status: "unauthenticated" } }),
    provider("mistral", ["mistral-large"], { installed: false }),
    provider("gemini", ["gemini-4"], { availability: "unavailable" }),
    provider("minimax", ["minimax-m3"], { status: "error" }),
    provider("acpRegistry", ["default"]),
    provider("opencode", [
      "blackwell-internal/opaque",
      "mistral/large-3",
      "anthropic/claude-opus-5-5",
      "qwen/qwen3.8-27b",
    ]),
  ];
  const settings = {
    ...settingsFor(providers),
    providerModelPreferences: { opencode: { hiddenModels: ["qwen/qwen3.8-27b"], modelOrder: [] } },
  };
  const catalog = modelRankingCatalog(settings, providers);
  const rows = modelRankingRows(empty, catalog, providers);
  // Mistral comes only through an OpenCode route, so it waits behind Show all.
  expect(rows.map((row) => row.entry.label)).toEqual(["Claude Opus", "GPT Sol"]);
  expect(rows.find((row) => row.entry.id === "claude:opus")).toMatchObject({
    modelLabel: "Opus 5.5",
    rank: null,
    provider: { driver: "claudeAgent" },
  });
  expect(rows.find((row) => row.entry.id === "codex:sol")?.modelLabel).toBe("gpt-6.1-sol");
  expect(
    modelRankingRows(empty, catalog, providers, true).find((row) => row.entry.id === "mistral")
      ?.provider?.driver,
  ).toBe("opencode");
  // A router-only family the user has run subagents on shows without Show all.
  expect(
    modelRankingRows(empty, catalog, providers, false, new Set(["mistral"])).map(
      (row) => row.entry.label,
    ),
  ).toEqual(["Claude Opus", "GPT Sol", "Mistral"]);
  expect(empty.entries).toEqual([]);
  expect(modelRankingRows(empty, catalog, providers, true).map((row) => row.entry.id)).toContain(
    "provider:acpRegistry",
  );
  expect(modelRankingRows(empty, catalog, providers, true).map((row) => row.entry.id)).toContain(
    "provider:blackwell-internal",
  );
});

it("keeps saved unavailable families behind show all and excludes settings-disabled providers", () => {
  const providers = [provider("codex", ["gpt-6.1-sol"])];
  const settings = {
    ...settingsFor(providers),
    providerInstances: {
      codex: { driver: ProviderDriverKind.make("codex"), enabled: false, config: {} },
    },
  };
  const category = {
    ...empty,
    entries: [{ id: "gone", family: "claude", label: "Claude" }],
    order: ["gone"],
  };
  const catalog = modelRankingCatalog(settings, providers);
  expect(modelRankingRows(category, catalog, providers)).toEqual([]);
  expect(modelRankingRows(category, catalog, providers, true)[0]).toMatchObject({
    entry: { id: "gone" },
    rank: 0,
    modelLabel: null,
    unavailableReason: expect.any(String),
  });
  expect(category.order).toEqual(["gone"]);
});

const tiered: ModelRankingCategory = {
  ...empty,
  entries: [
    { id: "codex", family: "codex", label: "Codex", tier: "B", note: "Keep this note" },
    { id: "claude", family: "claude", label: "Claude", tier: "S" },
    { id: "grok", family: "grok", label: "Grok" },
  ],
  order: ["codex", "claude"],
  comparisons: [{ left: "codex", right: "claude", result: "right" }],
};

describe("tier board writes", () => {
  it.each(ModelRankingTier.literals)(
    "places a usable family directly in %s and can unrank and re-rank it",
    (tier) => {
      const providers = [provider("codex", ["gpt-6.1-sol"])];
      const catalog = modelRankingCatalog(settingsFor(providers), providers);
      const row = modelRankingRows(empty, catalog, providers)[0]!;
      expect(row).toMatchObject({ tier: null, tierIndex: null, rank: null });
      const ranked = positionModelRankingEntry(empty, row.entry, tier);
      expect(rankedIds(ranked)).toEqual(["codex:sol"]);
      expect(modelRankingRows(ranked, catalog, providers)[0]).toMatchObject({ tier, tierIndex: 0 });
      const unranked = positionModelRankingEntry(ranked, row.entry, null);
      expect(rankedIds(unranked)).toEqual([]);
      expect(unranked.entries[0]?.tier).toBeUndefined();
      const again = positionModelRankingEntry(unranked, row.entry, tier);
      expect(again.entries).toHaveLength(1);
      expect(again.entries[0]?.tier).toBe(tier);
      expect(empty.entries).toEqual([]);
    },
  );

  it("moves between tiers and reorders within a tier without flattening or clearing other preferences", () => {
    const moved = positionModelRankingEntry(tiered, tiered.entries[0]!, "S", 0);
    expect(rankedIds(moved)).toEqual(["codex", "claude"]);
    expect(moved.entries.map((entry) => entry.tier)).toEqual(["S", "S", undefined]);
    expect(moved.comparisons).toEqual(tiered.comparisons);
    const right = positionModelRankingEntry(moved, moved.entries[0]!, "S", 1);
    expect(rankedIds(right)).toEqual(["claude", "codex"]);
    const lower = positionModelRankingEntry(right, right.entries[1]!, "D");
    expect(rankedIds(lower)).toEqual(["codex", "claude"]);
    expect(lower.entries.map((entry) => entry.tier)).toEqual(["S", "D", undefined]);
    const added = positionModelRankingEntry(lower, lower.entries[2]!, "S", 0);
    expect(rankedIds(added)).toEqual(["grok", "codex", "claude"]);
    const unranked = positionModelRankingEntry(added, added.entries[0]!, null);
    expect(rankedIds(unranked)).toEqual(["grok", "claude"]);
    expect(unranked.entries[0]?.note).toBe("Keep this note");
    expect(unranked.entries[1]?.tier).toBe("D");
    expect(unranked.comparisons).toEqual([]);
    expect(resetModelRankingCategory(unranked).order).toEqual([]);
    expect(
      resetModelRankingCategory(unranked).entries.every((entry) => entry.tier === undefined),
    ).toBe(true);
    expect(tiered.entries[0]?.tier).toBe("B");
  });

  it("appends to a destination tier and clamps positions within that tier", () => {
    const first = positionModelRankingEntry(tiered, tiered.entries[2]!, "S");
    expect(rankedIds(first)).toEqual(["claude", "grok", "codex"]);
    const left = positionModelRankingEntry(first, first.entries[2]!, "S", -20);
    expect(rankedIds(left)).toEqual(["grok", "claude", "codex"]);
    const right = positionModelRankingEntry(left, left.entries[2]!, "S", 100);
    expect(rankedIds(right)).toEqual(["claude", "grok", "codex"]);
  });

  it("loads flat saved preferences in S and preserves their order when assigning another family", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(ModelRankings));
    const flat = decode(
      JSON.stringify([
        {
          ...tiered,
          entries: tiered.entries.map(({ tier: _tier, ...entry }) => entry),
          order: ["codex", "claude"],
          comparisons: [],
        },
      ]),
    )[0]!;
    const providers = [provider("codex", ["gpt-6.1-sol", "claude-opus-5-5", "grok-5"])];
    const catalog = modelRankingCatalog(settingsFor(providers), providers);
    expect(
      modelRankingRows(flat, catalog, providers).map((row) => [
        row.entry.id,
        row.tier,
        row.tierIndex,
      ]),
    ).toEqual([
      ["codex", "S", 0],
      ["claude", "S", 1],
      // Vendor-wide entries saved before lines existed still resolve; each line can be ranked too.
      ["claude:opus", null, null],
      ["codex:sol", null, null],
      ["grok", null, null],
    ]);
    const edited = positionModelRankingEntry(flat, flat.entries[2]!, "A");
    const loaded = decode(JSON.stringify([edited]))[0]!;
    expect(rankedIds(loaded)).toEqual(["codex", "claude", "grok"]);
    expect(loaded.entries.map((entry) => entry.tier)).toEqual(["S", "S", "A"]);
    expect(loaded.entries[0]?.note).toBe("Keep this note");
    expect(flat.entries.every((entry) => entry.tier === undefined)).toBe(true);
  });

  it("keeps hidden families in their tier order when a visible family moves", () => {
    const saved: ModelRankingCategory = {
      ...tiered,
      entries: tiered.entries.map((entry) => ({ ...entry, tier: "B" })),
      order: ["grok", "claude", "codex"],
    };
    const providers = [provider("codex", ["gpt-6.1-sol", "claude-opus-5-5"])];
    const rows = modelRankingRows(
      saved,
      modelRankingCatalog(settingsFor(providers), providers),
      providers,
    );
    expect(rows.map((row) => [row.entry.id, row.tierIndex])).toEqual([
      ["claude", 1],
      ["codex", 2],
      ["claude:opus", null],
      ["codex:sol", null],
    ]);
    const moved = positionModelRankingEntry(saved, rows[1]!.entry, "B", rows[0]!.tierIndex!);
    expect(rankedIds(moved)).toEqual(["grok", "codex", "claude"]);
  });

  it("loads tier-only saved entries and keeps flat ranked entries after explicit F choices", () => {
    const saved: ModelRankingCategory = {
      ...tiered,
      entries: [
        { ...tiered.entries[0]!, tier: "F" },
        { ...tiered.entries[1]!, tier: "S" },
        tiered.entries[2]!,
      ],
      order: ["grok", "codex"],
    };
    expect(rankedIds(saved)).toEqual(["claude", "codex", "grok"]);
    const edited = positionModelRankingEntry(saved, saved.entries[1]!, "A");
    expect(rankedIds(edited)).toEqual(["claude", "codex", "grok"]);
    expect(edited.entries.map((entry) => entry.tier)).toEqual(["F", "A", "F"]);
  });

  it("does not create an unranked entry or exceed the saved family limit", () => {
    const entry = { id: "new", family: "gemini", label: "Gemini" };
    expect(positionModelRankingEntry(empty, entry, null)).toBe(empty);
    const full = {
      ...empty,
      entries: Array.from({ length: 100 }, (_, index) => ({
        id: String(index),
        family: String(index),
        label: String(index),
      })),
    };
    expect(positionModelRankingEntry(full, entry, "S")).toBe(full);
    expect(positionModelRankingEntry(full, full.entries[0]!, "S").entries).toHaveLength(100);
  });

  it("round-trips older tiered rankings with notes and archived selections without flattening", () => {
    const decode = Schema.decodeSync(Schema.fromJsonString(ModelRankings));
    const old = decode(
      JSON.stringify([
        {
          ...tiered,
          entries: tiered.entries.map((entry) => ({
            ...entry,
            family: undefined,
            selection: {
              instanceId: "codex",
              model:
                entry.id === "claude"
                  ? "claude-opus-5-5"
                  : entry.id === "codex"
                    ? "gpt-6.1-sol"
                    : "grok-5",
            },
          })),
        },
      ]),
    );
    const migrated = migrateModelRankings(old);
    expect(rankedIds(migrated[0]!)).toEqual(["claude", "codex"]);
    const providers = [provider("codex", ["gpt-6.1-sol", "claude-opus-5-5", "grok-5"])];
    const rows = modelRankingRows(
      migrated[0]!,
      modelRankingCatalog(settingsFor(providers), providers),
      providers,
    );
    expect(rows.map((row) => [row.entry.id, row.tier])).toEqual([
      ["claude", "S"],
      ["codex", "B"],
      ["grok", null],
    ]);
    const edited = positionModelRankingEntry(migrated[0]!, rows[1]!.entry, "A", 0);
    const loaded = migrateModelRankings(decode(JSON.stringify([edited])))[0]!;
    expect(rankedIds(loaded)).toEqual(["claude", "codex"]);
    expect(loaded.entries.map((entry) => entry.tier)).toEqual(["A", "S", undefined]);
    expect(loaded.entries[0]?.note).toBe("Keep this note");
    expect(loaded.legacy?.entries).toHaveLength(3);
    expect(loaded.comparisons).toEqual(migrated[0]!.comparisons);
  });
});
