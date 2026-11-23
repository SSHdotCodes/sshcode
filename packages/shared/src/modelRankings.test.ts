import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
  ServerSettings,
  ModelRankingEntry,
  type ModelRankingCategory,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { applyServerSettingsPatch } from "./serverSettings.ts";
import {
  compareModelRankingEntries,
  emptyModelRankingCategory,
  matchModelRankingCategory,
  modelRankingCategories,
  moveModelRankingEntry,
  nextModelRankingPair,
  orderedModelRankingEntries,
  rankedModelRankingKinds,
  removeModelRankingEntry,
  resetModelRankingCategory,
  replaceModelRankingCategory,
  unrankModelRankingEntry,
  updateModelRankingEntry,
} from "./modelRankings.ts";

const decodeRankingEntry = Schema.decodeSync(ModelRankingEntry);
const encodeSettings = Schema.encodeSync(Schema.fromJsonString(ServerSettings));
const decodeSettings = Schema.decodeSync(Schema.fromJsonString(ServerSettings));

const entries = ["a", "b", "c"].map((id) => ({
  id,
  label: id,
  selection: {
    instanceId: ProviderInstanceId.make("removed-provider"),
    model: id,
    options: [{ id: "reasoning_effort", value: "high" }],
  },
}));
const category = { ...emptyModelRankingCategory("review", "Review"), entries };
const ids = (next: ModelRankingCategory) =>
  orderedModelRankingEntries(next).map((entry) => entry.id);

describe("user model rankings", () => {
  it.each([
    { preference: ["c", "a", "e", "b", "d"], maxComparisons: 6 },
    { preference: ["f", "a", "h", "c", "g", "b", "e", "d"], maxComparisons: 16 },
  ])(
    "adaptively recovers $preference with at most $maxComparisons choices",
    ({ preference, maxComparisons }) => {
      const added = [...preference].sort();
      let next: ModelRankingCategory = {
        ...emptyModelRankingCategory("review", "Review"),
        entries: added.map((id) => ({ ...entries[0]!, id, label: id })),
      };
      const allPairs = (added.length * (added.length - 1)) / 2;
      let count = 0;
      let pair = nextModelRankingPair(next);
      while (pair && count < allPairs) {
        expect(nextModelRankingPair(next)).toEqual(pair);
        next = compareModelRankingEntries(
          next,
          pair[0].id,
          pair[1].id,
          preference.indexOf(pair[0].id) < preference.indexOf(pair[1].id) ? "left" : "right",
        );
        count++;
        pair = nextModelRankingPair(next);
      }
      expect(pair).toBeNull();
      expect(ids(next)).toEqual(preference);
      expect(count).toBeLessThanOrEqual(maxComparisons);
      expect(count).toBeLessThan(allPairs);
      expect(next.entries.every((entry) => entry.tier === undefined)).toBe(true);
    },
  );

  it("skips transitively known pairs and compares a new contender near the middle", () => {
    const ordered = compareModelRankingEntries(
      compareModelRankingEntries(category, "a", "b", "left"),
      "b",
      "c",
      "left",
    );
    expect(nextModelRankingPair(ordered)).toBeNull();
    const extended = {
      ...ordered,
      entries: [...ordered.entries, { ...entries[0]!, id: "d", label: "d" }],
    };
    expect(nextModelRankingPair(extended)?.map((entry) => entry.id)).toEqual(["b", "d"]);
    // A manual move remains authoritative; inference only suppresses questions.
    const manual = moveModelRankingEntry(extended, "b", -1);
    expect(nextModelRankingPair(manual)?.map((entry) => entry.id)).toEqual(["a", "d"]);
    expect(ids(manual)).toEqual(["b", "a", "c"]);
    expect(manual.comparisons).toHaveLength(2);
  });

  it("only infers from explicit results within the current tier, not skips", () => {
    const skipped = compareModelRankingEntries(
      compareModelRankingEntries(category, "a", "b", "skip"),
      "b",
      "c",
      "left",
    );
    expect(nextModelRankingPair(skipped)?.map((entry) => entry.id)).toEqual(["a", "c"]);
    const crossed = {
      ...compareModelRankingEntries(
        compareModelRankingEntries(category, "a", "b", "left"),
        "b",
        "c",
        "left",
      ),
      entries: category.entries.map((entry) =>
        entry.id === "b" ? entry : { ...entry, tier: "S" as const },
      ),
    };
    expect(nextModelRankingPair(crossed)?.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("does not treat a cycle of contradictory choices as an implied order", () => {
    const cyclic: ModelRankingCategory = {
      ...category,
      entries: [...category.entries, { ...entries[0]!, id: "d", label: "d" }],
      order: ["a", "b", "c", "d"],
      comparisons: [
        { left: "a", right: "b", result: "left" },
        { left: "b", right: "c", result: "left" },
        { left: "c", right: "d", result: "left" },
        { left: "d", right: "a", result: "left" },
      ],
    };
    expect(nextModelRankingPair(cyclic)?.map((entry) => entry.id)).toEqual(["a", "c"]);
  });

  it("preserves full notes through comparisons, moves, resets and persistence", () => {
    const note = "Useful for difficult reviews. ".repeat(16);
    expect(note.length).toBeLessThanOrEqual(500);
    const annotated = {
      ...category,
      entries: category.entries.map((entry) => ({ ...entry, note })),
    };
    const compared = compareModelRankingEntries(annotated, "a", "b", "left");
    const moved = moveModelRankingEntry(compared, "b", -1);
    const reset = resetModelRankingCategory(moved);
    for (const state of [compared, moved, reset])
      expect(state.entries.every((entry) => entry.note === note)).toBe(true);
    const restored = decodeSettings(
      encodeSettings(applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { modelRankings: [reset] })),
    );
    expect(restored.modelRankings[0]?.entries[0]?.note).toBe(note.trim());
    expect(() => decodeRankingEntry({ ...entries[0]!, note: "x".repeat(501) })).toThrow();
    const edited = updateModelRankingEntry(compared, {
      ...compared.entries[0]!,
      note: "Edited note",
    });
    expect(edited.order).toEqual(compared.order);
    expect(edited.comparisons).toEqual(compared.comparisons);
  });

  it("starts with empty preferences and unranked contenders", () => {
    expect(DEFAULT_SERVER_SETTINGS.modelRankings).toEqual([]);
    expect(modelRankingCategories([])).toHaveLength(6);
    expect(ids(category)).toEqual([]);
    expect(nextModelRankingPair(category)?.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("records pair choices as a stable order without inventing tiers", () => {
    const first = compareModelRankingEntries(category, "a", "b", "right");
    expect(ids(first)).toEqual(["b", "a"]);
    expect(first.entries.every((entry) => entry.tier === undefined)).toBe(true);
    const second = compareModelRankingEntries(first, "a", "c", "right");
    expect(ids(second)).toEqual(["b", "c", "a"]);
    const revised = compareModelRankingEntries(second, "a", "b", "left");
    expect(ids(revised)).toEqual(["a", "b", "c"]);
    expect(revised.comparisons).toHaveLength(2);
    expect(compareModelRankingEntries(revised, "a", "missing", "left")).toBe(revised);
  });

  it("skip advances without ranking; manual tiers and order remain editable", () => {
    const skipped = compareModelRankingEntries(category, "a", "b", "skip");
    expect(ids(skipped)).toEqual([]);
    expect(nextModelRankingPair(skipped)?.map((entry) => entry.id)).toEqual(["a", "c"]);
    let ranked = compareModelRankingEntries(category, "a", "b", "left");
    ranked = moveModelRankingEntry(ranked, "b", -1);
    expect(ids(ranked)).toEqual(["b", "a"]);
    ranked = updateModelRankingEntry(ranked, { ...ranked.entries[2]!, tier: "S" });
    expect(ids(ranked)).toEqual(["c", "b", "a"]);
    expect(ids(unrankModelRankingEntry(ranked, "c"))).toEqual(["b", "a"]);
    expect(ids(resetModelRankingCategory(ranked))).toEqual([]);
    expect(resetModelRankingCategory(ranked).entries).toEqual(entries);
    expect(removeModelRankingEntry(ranked, "b").comparisons).toEqual([]);
  });

  it("persists comparisons, explicit tiers and options including missing providers, and fully resets", () => {
    const next = updateModelRankingEntry(compareModelRankingEntries(category, "a", "b", "right"), {
      ...entries[2]!,
      tier: "F",
    });
    const patched = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { modelRankings: [next] });
    const json = encodeSettings(patched);
    const restored = decodeSettings(json);
    expect(restored.modelRankings).toEqual([next]);
    expect(applyServerSettingsPatch(restored, { modelRankings: [] }).modelRankings).toEqual([]);
    expect(applyServerSettingsPatch(restored, { branchNamePrefix: "other" }).modelRankings).toEqual(
      [next],
    );
  });

  it("keeps category positions stable when preferences are edited", () => {
    const first = emptyModelRankingCategory("custom-one", "First");
    const second = emptyModelRankingCategory("custom-two", "Second");
    expect(
      replaceModelRankingCategory([first, second], { ...first, name: "Edited" }).map(
        (item) => item.id,
      ),
    ).toEqual(["custom-one", "custom-two"]);
  });

  it("matches only relevant saved categories including user categories", () => {
    const custom = emptyModelRankingCategory("custom", "Translation");
    expect(matchModelRankingCategory([category, custom], "security review")?.id).toBe("review");
    expect(matchModelRankingCategory([category, custom], "translation")?.id).toBe("custom");
    expect(matchModelRankingCategory([category], "computer automation")).toBeNull();
  });

  it.each(["code review", "review code", "please review this code"])(
    "prefers the Review name over Implementation's code synonym for %s",
    (task) => {
      const implementation = { ...category, id: "implementation", name: "Implementation" };
      expect(matchModelRankingCategory([implementation, category], task)?.id).toBe("review");
      expect(matchModelRankingCategory([category, implementation], task)?.id).toBe("review");
    },
  );

  it("uses useful saved preferences to resolve duplicate exact names deterministically", () => {
    const rankedReview = { ...category, order: ["a"] };
    const emptyDuplicate = emptyModelRankingCategory("aaa-custom", "Review");
    const rankedDuplicate = { ...rankedReview, id: "zzz-custom" };
    expect(matchModelRankingCategory([emptyDuplicate, rankedReview], "review")).toEqual(
      rankedReview,
    );
    expect(matchModelRankingCategory([rankedReview, emptyDuplicate], "review")).toEqual(
      rankedReview,
    );
    expect(matchModelRankingCategory([emptyDuplicate, rankedDuplicate], "review")).toEqual(
      rankedDuplicate,
    );
    expect(matchModelRankingCategory([rankedDuplicate, emptyDuplicate], "review")).toEqual(
      rankedDuplicate,
    );
    expect(matchModelRankingCategory([rankedDuplicate, rankedReview], "review")).toEqual(
      rankedReview,
    );
  });

  it("prefers a specific named phrase and keeps word boundaries", () => {
    const custom = { ...category, id: "custom", name: "Code review" };
    expect(matchModelRankingCategory([category, custom], "please do a code review")).toEqual(
      custom,
    );
    expect(matchModelRankingCategory([category], "preview decoder")).toBeNull();
    expect(matchModelRankingCategory([category], "   ")).toBeNull();
  });
});

describe("durable model family rankings", () => {
  it("recognizes families across harnesses, new versions and explicit catalog metadata", async () => {
    const { modelRankingFamily } = await import("./modelRankings.ts");
    for (const [slug, family] of [
      ["openai/gpt-42-sol", "codex:sol"],
      ["gpt-6.1", "codex"],
      ["gpt-4o-mini", "codex"],
      ["claude-fable-99-1", "claude:fable"],
      ["openrouter/anthropic/claude-opus-5.5", "claude:opus"],
      ["claude-3-5-sonnet-20241022", "claude:sonnet"],
      ["claude-haiku-latest", "claude:haiku"],
      ["moonshot/k9", "kimi"],
      ["google/gemini-12-pro", "gemini:pro"],
      ["xai/grok-20", "grok"],
      ["qwen9-coder", "qwen"],
    ] as const)
      expect(modelRankingFamily({ slug }, { driver: "opencode" })).toBe(family);
    expect(
      modelRankingFamily({ slug: "default" }, { driver: "acpRegistry", displayName: "Kimi CLI" }),
    ).toBe("kimi");
    expect(modelRankingFamily({ slug: "new-123", family: "my-family" }, { driver: "fork" })).toBe(
      "my-family",
    );
    const { modelFamilyLabel } = await import("./modelRankings.ts");
    expect(["codex:sol", "claude:opus", "gemini:pro", "claude"].map(modelFamilyLabel)).toEqual([
      "GPT Sol",
      "Claude Opus",
      "Gemini Pro",
      "Claude",
    ]);
  });

  it("splits a saved vendor family back into the lines its archived choices came from", async () => {
    const { migrateModelRankings, modelRankingCatalog, modelRankingRows } =
      await import("./modelRankings.ts");
    const codex = ProviderInstanceId.make("codex");
    const claude = ProviderInstanceId.make("claudeAgent");
    const pick = (id: string, instanceId: typeof codex, model: string) => ({
      id,
      label: model,
      selection: { instanceId, model },
    });
    const archived = [
      pick("sol", codex, "gpt-6.1-sol"),
      pick("astra", codex, "gpt-6-astra"),
      pick("opus", claude, "claude-opus-5-5"),
      pick("sonnet", claude, "claude-sonnet-5-5"),
    ];
    const saved: ModelRankingCategory = {
      ...emptyModelRankingCategory("review", "Review"),
      entries: [
        { id: "sol", family: "codex", label: "Codex" },
        { id: "opus", family: "claude", label: "Claude", note: "Lead" },
      ],
      order: ["sol", "opus"],
      legacy: { entries: archived, order: ["sol", "opus"], comparisons: [] },
    };
    const providers = [
      {
        instanceId: codex,
        driver: ProviderDriverKind.make("codex"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        checkedAt: "2026-11-06T00:00:00.000Z",
        models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
        slashCommands: [],
        skills: [],
      },
      {
        instanceId: claude,
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        version: null,
        status: "ready" as const,
        auth: { status: "authenticated" as const },
        checkedAt: "2026-11-06T00:00:00.000Z",
        models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: null,
        })),
        slashCommands: [],
        skills: [],
      },
    ];
    const instances = {
      [codex]: { driver: ProviderDriverKind.make("codex"), enabled: true },
      [claude]: { driver: ProviderDriverKind.make("claudeAgent"), enabled: true },
    };
    const [migrated] = migrateModelRankings([saved], instances, providers);
    expect(migrated!.entries.map((e) => ("family" in e ? e.family : ""))).toEqual([
      "codex:sol",
      "codex:astra",
      "claude:opus",
      "claude:sonnet",
    ]);
    expect(migrated!.order).toEqual(["sol", "opus"]);
    expect(migrated!.entries.find((e) => e.id === "opus")).toMatchObject({ note: "Lead" });
    const settings = { ...DEFAULT_SERVER_SETTINGS, providerInstances: instances };
    const rows = modelRankingRows(migrated!, modelRankingCatalog(settings, providers), providers);
    expect(rows.map((row) => row.entry.label).toSorted()).toEqual([
      "Claude Haiku",
      "Claude Opus",
      "Claude Sonnet",
      "GPT Astra",
      "GPT Luna",
      "GPT Sol",
    ]);
    // Older generations and unversioned lines hide until shown or ranked.
    const extra = {
      ...providers[0]!,
      models: ["gpt-3.5-turbo", "gpt-5.4-mini", "gpt-oss-120b", "gpt-4o-2024-08-06"].map(
        (slug) => ({ slug, name: slug, isCustom: false, capabilities: null }),
      ),
      instanceId: ProviderInstanceId.make("router"),
    };
    const all = [...providers, extra];
    const wide = { ...settings, providerInstances: { ...instances, router: instances[codex] } };
    const labels = (category: ModelRankingCategory, showAll = false) =>
      modelRankingRows(category, modelRankingCatalog(wide, all), all, showAll).map(
        (row) => row.entry.label,
      );
    expect(labels(migrated!)).not.toContain("GPT Turbo");
    expect(labels(migrated!)).not.toContain("GPT Mini");
    expect(labels(migrated!)).not.toContain("GPT Oss");
    expect(labels(migrated!, true)).toEqual(expect.arrayContaining(["GPT Turbo", "GPT Mini"]));
    const ranked = {
      ...migrated!,
      entries: [...migrated!.entries, { id: "mini", family: "codex:mini", label: "GPT Mini" }],
      order: [...migrated!.order, "mini"],
    };
    expect(labels(ranked)).toContain("GPT Mini");
  });

  it("represents a family by its native, newest model", async () => {
    const { currentModelRankingCandidate } = await import("./modelRankings.ts");
    const item = (model: string, label: string, driver: string, isDefault = false) => ({
      family: "kimi",
      selection: { instanceId: ProviderInstanceId.make(driver), model },
      label,
      providerLabel: driver,
      isDefault,
      unavailableReason: null,
      driver,
    });
    const pick = (...items: ReturnType<typeof item>[]) =>
      currentModelRankingCandidate({ id: "kimi", family: "kimi", label: "Kimi" }, items)?.label;
    expect(
      pick(
        item("kimi-k2.7-code", "Kimi K2.7 Code", "acp"),
        item("kimi-k3.1-pro", "K3.1 Pro", "acp"),
      ),
    ).toBe("K3.1 Pro");
    expect(
      pick(item("openrouter/kimi-k3.2", "Kimi K3.2", "opencode"), item("kimi-k3.1", "K3.1", "acp")),
    ).toBe("K3.1");
    expect(
      pick(
        item("qwen3.7-plus", "Qwen3.7 Plus", "acp"),
        item("invite-1102", "Qwen4 (early access)", "acp"),
      ),
    ).toBe("Qwen4 (early access)");
  });

  it("collapses conflicting legacy choices deterministically and archives every original field", async () => {
    const { migrateModelRankings } = await import("./modelRankings.ts");
    const legacy: ModelRankingCategory = {
      id: "review",
      name: "Review",
      entries: [
        {
          id: "old",
          label: "Old",
          selection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-6-sol",
            options: [{ id: "effort", value: "high" }],
          },
          tier: "F",
          note: "Keep this original note",
        },
        {
          id: "claude",
          label: "Claude",
          selection: { instanceId: ProviderInstanceId.make("cursor"), model: "claude-fable-5-1" },
          tier: "A",
        },
        {
          id: "new",
          label: "New",
          selection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
          tier: "S",
          note: "Prefer this note",
        },
      ],
      order: ["old", "claude", "new"],
      comparisons: [
        { left: "old", right: "claude", result: "left" },
        { left: "new", right: "old", result: "right" },
      ],
    };
    const migrated = migrateModelRankings([legacy]);
    expect(migrated[0]?.entries).toEqual([
      { id: "new", family: "codex:sol", label: "GPT Sol", tier: "S", note: "Prefer this note" },
      { id: "claude", family: "claude:fable", label: "Claude Fable", tier: "A" },
    ]);
    expect(migrated[0]?.order).toEqual(["new", "claude"]);
    expect(migrated[0]?.legacy).toEqual({
      entries: legacy.entries,
      order: legacy.order,
      comparisons: legacy.comparisons,
    });
    expect(migrateModelRankings(migrated)).toEqual(migrated);
    const restored = decodeSettings(
      encodeSettings(
        applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, { modelRankings: migrated }),
      ),
    );
    expect(restored.modelRankings).toEqual(migrated);
    expect(resetModelRankingCategory(migrated[0]!).legacy).toEqual(migrated[0]?.legacy);
  });

  it("uses configured instance metadata to migrate opaque models to a durable family", async () => {
    const { migrateModelRankings } = await import("./modelRankings.ts");
    const instanceId = ProviderInstanceId.make("work-account");
    const original = {
      ...category,
      entries: [{ id: "opaque", label: "Default", selection: { instanceId, model: "default" } }],
      order: ["opaque"],
    };
    expect(
      migrateModelRankings([original], {
        [instanceId]: {
          driver: ProviderDriverKind.make("acpRegistry"),
          displayName: "Kimi CLI",
          config: {},
        },
      })[0]?.entries[0],
    ).toMatchObject({ family: "kimi", id: "opaque" });
  });
});

describe("family inventories and late metadata", () => {
  const snapshot = (instanceId: string, models: ServerProvider["models"]): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-27T00:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  });
  const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });

  it.each(["another instance", "another route"])(
    "chooses the newest family release on %s before defaults or lexical ordering",
    async (location) => {
      const { modelRankingCatalog, currentModelRankingCandidate } =
        await import("./modelRankings.ts");
      const old = { ...model("openai/gpt-6-sol"), isDefault: true };
      const newer = model("openrouter/openai/gpt-6.1-sol");
      const astra = model("gpt-6-astra");
      const providers =
        location === "another instance"
          ? [snapshot("a-old", [old, astra]), snapshot("z-new", [newer])]
          : [snapshot("a-old", [old, astra, newer])];
      const settings = {
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: Object.fromEntries(
          providers.map((provider) => [
            provider.instanceId,
            { driver: provider.driver, enabled: true },
          ]),
        ),
      };
      const catalog = modelRankingCatalog(settings, providers);
      expect(
        catalog.find((entry) => entry.selection.model === old.slug)?.unavailableReason,
      ).toContain("Superseded by openrouter/openai/gpt-6.1-sol");
      expect(
        catalog.find((entry) => entry.selection.model === newer.slug)?.unavailableReason,
      ).toBeNull();
      expect(
        catalog.find((entry) => entry.selection.model === astra.slug)?.unavailableReason,
      ).toBeNull();
      const candidates = catalog.filter((entry) => entry.selection.model !== astra.slug);
      expect(
        currentModelRankingCandidate(
          { id: "sol", family: "codex:sol", label: "GPT Sol" },
          candidates,
        )?.selection.model,
      ).toBe(newer.slug);
    },
  );

  it.each([{ family: "claude" }, { subProvider: "anthropic" }])(
    "uses live opaque-model metadata $family$subProvider and reconciles already saved fallback families",
    async (metadata) => {
      const { migrateModelRankings } = await import("./modelRankings.ts");
      const provider = snapshot("opaque", [{ ...model("version-123"), ...metadata }]);
      const instances = { [provider.instanceId]: { driver: provider.driver, enabled: true } };
      const original: ModelRankingCategory = {
        ...emptyModelRankingCategory("review", "Review"),
        entries: [
          {
            id: "opaque",
            label: "Old",
            selection: { instanceId: provider.instanceId, model: "version-123" },
            tier: "S",
            note: "Original note",
          },
        ],
        order: ["opaque"],
      };
      const direct = migrateModelRankings([original], instances, [provider]);
      expect(direct[0]?.entries[0]).toMatchObject({
        id: "opaque",
        family: "claude",
        tier: "S",
        note: "Original note",
      });
      const provisional = migrateModelRankings([original], instances);
      expect(provisional[0]?.entries[0]).toMatchObject({ family: "provider:opencode" });
      const edited = provisional.map((category) => ({
        ...category,
        entries: category.entries.map((entry) => ({
          ...entry,
          tier: "B" as const,
          note: "Edited after migration",
        })),
      }));
      const reconciled = migrateModelRankings(edited, instances, [provider]);
      expect(reconciled[0]?.entries[0]).toEqual({
        id: "opaque",
        family: "claude",
        label: "Claude",
        tier: "B",
        note: "Edited after migration",
      });
      expect(reconciled[0]?.legacy?.entries).toEqual(original.entries);
      expect(reconciled[0]?.legacy?.families).toEqual(edited[0]?.entries);
      expect(migrateModelRankings(reconciled, instances, [provider])).toBe(reconciled);
      expect(
        migrateModelRankings([{ ...edited[0]!, entries: [], order: [] }], instances, [provider])[0]
          ?.entries,
      ).toEqual([]);
      const reset = migrateModelRankings([resetModelRankingCategory(edited[0]!)], instances, [
        provider,
      ]);
      expect(orderedModelRankingEntries(reset[0]!)).toEqual([]);
      expect(reset[0]?.entries[0]?.note).toBe("Edited after migration");
    },
  );

  it("keeps active notes and their conflict archive when a provisional identity joins an existing family", async () => {
    const { migrateModelRankings } = await import("./modelRankings.ts");
    const provider = snapshot("opaque", [{ ...model("version-123"), family: "claude" }]);
    const instances = { [provider.instanceId]: { driver: provider.driver, enabled: true } };
    const provisional = migrateModelRankings(
      [
        {
          ...emptyModelRankingCategory("review", "Review"),
          entries: [
            {
              id: "opaque",
              label: "Old",
              selection: { instanceId: provider.instanceId, model: "version-123" },
              tier: "A",
              note: "Legacy note",
            },
          ],
          order: ["opaque"],
        },
      ],
      instances,
    )[0]!;
    const active: ModelRankingCategory = {
      ...provisional,
      entries: [
        ...provisional.entries,
        { id: "claude", family: "claude", label: "Claude", tier: "S", note: "New family note" },
      ],
      order: ["claude", "opaque"],
    };
    const reconciled = migrateModelRankings([active], instances, [provider]);
    expect(reconciled[0]?.entries).toEqual([
      { id: "claude", family: "claude", label: "Claude", tier: "S", note: "New family note" },
    ]);
    expect(reconciled[0]?.legacy?.families).toEqual(active.entries);
    expect(reconciled[0]?.legacy?.entries).toEqual(provisional.legacy?.entries);
    expect(
      decodeSettings(encodeSettings({ ...DEFAULT_SERVER_SETTINGS, modelRankings: reconciled }))
        .modelRankings,
    ).toEqual(reconciled);
  });
});

describe("opaque family group reconciliation", () => {
  const instanceId = ProviderInstanceId.make("opaque");
  const instances = {
    [instanceId]: { driver: ProviderDriverKind.make("opencode"), enabled: true },
  };
  const original: ModelRankingCategory = {
    ...emptyModelRankingCategory("review", "Review"),
    entries: [
      {
        id: "claude-old",
        label: "First",
        selection: { instanceId, model: "version-123" },
        tier: "S",
        note: "Claude note",
      },
      {
        id: "codex-old",
        label: "Second",
        selection: { instanceId, model: "version-456" },
        tier: "A",
        note: "Codex note",
      },
      {
        id: "grok-old",
        label: "Third",
        selection: { instanceId, model: "version-789" },
        tier: "B",
        note: "Grok note",
      },
    ],
    order: ["claude-old", "codex-old", "grok-old"],
    comparisons: [{ left: "claude-old", right: "codex-old", result: "left" }],
  };
  const snapshot = (families = ["claude", "codex", "grok"]): ServerProvider => ({
    instanceId,
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-27T00:00:00.000Z",
    models: families.map((family) => ({
      slug:
        family === "claude" ? "version-123" : family === "codex" ? "version-456" : "version-789",
      name: family,
      family,
      isCustom: false,
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  });

  it.each(["current boot", "initial fallback archive"])(
    "recovers all families, ranks, notes, order and comparisons after %s",
    async (shape) => {
      const { migrateModelRankings } = await import("./modelRankings.ts");
      const boot = migrateModelRankings([original], instances);
      const persisted =
        shape === "initial fallback archive"
          ? boot.map((category) => ({
              ...category,
              entries: category.entries.map((entry) => {
                if (!("family" in entry)) return entry;
                const { pendingLegacyIds: _pending, ...rest } = entry;
                return rest;
              }),
            }))
          : boot;
      const late = migrateModelRankings(persisted, instances, [snapshot()]);
      const direct = migrateModelRankings([original], instances, [snapshot()]);
      expect(late.map(({ legacy: _legacy, ...category }) => category)).toEqual(
        direct.map(({ legacy: _legacy, ...category }) => category),
      );
      expect(late[0]?.entries).toEqual([
        { id: "claude-old", family: "claude", label: "Claude", tier: "S", note: "Claude note" },
        { id: "codex-old", family: "codex", label: "Codex", tier: "A", note: "Codex note" },
        { id: "grok-old", family: "grok", label: "Grok", tier: "B", note: "Grok note" },
      ]);
      expect(migrateModelRankings(late, instances, [snapshot()])).toBe(late);
      const removed = [removeModelRankingEntry(late[0]!, "codex-old")];
      expect(migrateModelRankings(removed, instances, [snapshot()])).toBe(removed);
      expect(
        migrateModelRankings([resetModelRankingCategory(late[0]!)], instances, [snapshot()])[0]
          ?.order,
      ).toEqual([]);
    },
  );

  it("preserves edits to the active primary while restoring untouched secondary families", async () => {
    const { migrateModelRankings } = await import("./modelRankings.ts");
    const boot = migrateModelRankings([original], instances);
    const edited = [
      {
        ...boot[0]!,
        entries: boot[0]!.entries.map((entry) => ({
          ...entry,
          tier: "C" as const,
          note: "Edited primary note",
        })),
      },
    ];
    const late = migrateModelRankings(edited, instances, [snapshot()]);
    expect(late[0]?.entries[0]).toMatchObject({
      family: "claude",
      tier: "C",
      note: "Edited primary note",
    });
    expect(late[0]?.entries[1]).toMatchObject({ family: "codex", tier: "A", note: "Codex note" });
    expect(late[0]?.order).toEqual(["codex-old", "grok-old", "claude-old"]);
    const partial = migrateModelRankings(edited, instances, [snapshot(["codex"])]);
    expect(partial[0]?.entries[0]).toMatchObject({
      id: "claude-old",
      family: "provider:opencode",
      tier: "C",
      note: "Edited primary note",
    });
    const completed = migrateModelRankings(partial, instances, [snapshot()]);
    expect(completed[0]?.entries.find((entry) => entry.id === "claude-old")).toMatchObject({
      family: "claude",
      tier: "C",
      note: "Edited primary note",
    });
    expect(completed[0]?.entries.find((entry) => entry.id === "grok-old")).toMatchObject({
      family: "grok",
      tier: "B",
      note: "Grok note",
    });
    for (const cleared of [
      resetModelRankingCategory(boot[0]!),
      unrankModelRankingEntry(boot[0]!, "claude-old"),
    ])
      expect(
        orderedModelRankingEntries(migrateModelRankings([cleared], instances, [snapshot()])[0]!),
      ).toEqual([]);
    const removed = [removeModelRankingEntry(boot[0]!, "claude-old")];
    expect(migrateModelRankings(removed, instances, [snapshot()])).toBe(removed);
  });

  it("tracks only unresolved sources across partial metadata so removed canonical families never return", async () => {
    const { migrateModelRankings } = await import("./modelRankings.ts");
    const boot = migrateModelRankings([original], instances);
    const partial = migrateModelRankings(boot, instances, [snapshot(["claude"])]);
    expect(partial[0]?.entries[1]).toMatchObject({
      id: "codex-old",
      family: "provider:opencode",
      pendingLegacyIds: ["codex-old", "grok-old"],
    });
    const removed = [removeModelRankingEntry(partial[0]!, "claude-old")];
    const late = migrateModelRankings(removed, instances, [snapshot()]);
    expect(late[0]?.entries.map((entry) => ("family" in entry ? entry.family : "legacy"))).toEqual([
      "codex",
      "grok",
    ]);
    expect(
      orderedModelRankingEntries(
        migrateModelRankings([resetModelRankingCategory(partial[0]!)], instances, [snapshot()])[0]!,
      ),
    ).toEqual([]);
    const removePending = [removeModelRankingEntry(partial[0]!, "codex-old")];
    expect(migrateModelRankings(removePending, instances, [snapshot()])).toBe(removePending);
    expect(
      decodeSettings(encodeSettings({ ...DEFAULT_SERVER_SETTINGS, modelRankings: partial }))
        .modelRankings,
    ).toEqual(partial);
  });
});

describe("modelRankingTierLookup", () => {
  const provider = (instanceId: string, slugs: ReadonlyArray<string>): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(instanceId === "claude" ? "claudeAgent" : "codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-06T00:00:00.000Z",
    models: slugs.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
    slashCommands: [],
    skills: [],
  });
  const providers = [
    provider("claude", ["claude-opus-5-5", "claude-haiku-5-5"]),
    provider("codex", ["gpt-6.1-sol", "gpt-6.1-astra"]),
  ];
  const implementation = (
    entries: ModelRankingCategory["entries"],
    order: ReadonlyArray<string>,
  ): ModelRankingCategory => ({
    ...emptyModelRankingCategory("implementation", "Implementation"),
    entries,
    order,
  });

  it("gives each model its ranked family's tier in the category", async () => {
    const { modelRankingTierLookup } = await import("./modelRankings.ts");
    const tierOf = modelRankingTierLookup(
      [
        implementation(
          [
            { id: "opus", family: "claude:opus", label: "Claude Opus", tier: "S" },
            { id: "sol", family: "codex:sol", label: "GPT Sol", tier: "B" },
          ],
          ["opus", "sol"],
        ),
      ],
      {},
      providers,
      "implementation",
    );
    expect(tierOf("claude", "claude-opus-5-5")).toBe("S");
    expect(tierOf("codex", "gpt-6.1-sol")).toBe("B");
    expect(tierOf("claude", "claude-haiku-5-5")).toBeNull();
    expect(tierOf("codex", "gpt-6.1-astra")).toBeNull();
    expect(tierOf("missing", "claude-opus-5-5")).toBeNull();
  });

  it("lets a vendor-wide family cover its lines, behind a ranked line", async () => {
    const { modelRankingTierLookup } = await import("./modelRankings.ts");
    const tierOf = modelRankingTierLookup(
      [
        implementation(
          [
            { id: "claude", family: "claude", label: "Claude", tier: "A" },
            { id: "haiku", family: "claude:haiku", label: "Claude Haiku", tier: "C" },
          ],
          ["claude", "haiku"],
        ),
      ],
      {},
      providers,
      "implementation",
    );
    expect(tierOf("claude", "claude-opus-5-5")).toBe("A");
    expect(tierOf("claude", "claude-haiku-5-5")).toBe("C");
  });

  it("shows nothing for a category the user hasn't ranked", async () => {
    const { modelRankingTierLookup } = await import("./modelRankings.ts");
    const tierOf = modelRankingTierLookup([], {}, providers, "implementation");
    expect(tierOf("claude", "claude-opus-5-5")).toBeNull();
  });
});

describe("markSupersededModelsLegacy", () => {
  const provider = (
    instanceId: string,
    driver: string,
    models: ReadonlyArray<{
      readonly slug: string;
      readonly isCustom?: boolean;
      readonly isLegacy?: boolean;
    }>,
  ): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-09T00:00:00.000Z",
    models: models.map(({ slug, isCustom, isLegacy }) => ({
      slug,
      name: slug,
      isCustom: isCustom === true,
      ...(isLegacy ? { isLegacy: true } : {}),
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  });

  it("files older Grok routes as legacy beside the current Grok Build model", async () => {
    const { markSupersededModelsLegacy } = await import("./modelRankings.ts");
    const marked = markSupersededModelsLegacy([
      provider("grok_grok_build", "grok", [{ slug: "grok-4.7" }, { slug: "grok-4.7-build-fast" }]),
      provider("opencode", "opencode", [
        { slug: "openrouter/x-ai/grok-4.20" },
        { slug: "xai/grok-4.20-0309-reasoning" },
        { slug: "xai/grok-4.20-multi-agent-0309" },
        { slug: "xai/grok-4.7" },
        { slug: "xai/grok-4.6", isCustom: true },
      ]),
    ]);
    const legacy = marked.flatMap((entry) =>
      entry.models.filter((model) => model.isLegacy).map((model) => model.slug),
    );
    expect(legacy).toEqual([
      "openrouter/x-ai/grok-4.20",
      "xai/grok-4.20-0309-reasoning",
      "xai/grok-4.20-multi-agent-0309",
    ]);
  });

  it("never lets a custom id or a retired release retire a current model", async () => {
    const { markSupersededModelsLegacy } = await import("./modelRankings.ts");
    const marked = markSupersededModelsLegacy([
      provider("codex", "codex", [
        { slug: "gpt-6.1-sol" },
        { slug: "gpt-6-sol" },
        { slug: "gpt-99-sol", isCustom: true },
        { slug: "gpt-6.2-sol-preview", isLegacy: true },
      ]),
    ]);
    const legacy = marked[0]!.models.filter((model) => model.isLegacy).map((model) => model.slug);
    expect(legacy).toEqual(["gpt-6-sol", "gpt-6.2-sol-preview"]);
  });

  it("returns the same providers when nothing is replaced", async () => {
    const { markSupersededModelsLegacy } = await import("./modelRankings.ts");
    const providers = [
      provider("codex", "codex", [{ slug: "gpt-6.1-sol" }, { slug: "gpt-6-astra" }]),
    ];
    expect(markSupersededModelsLegacy(providers)).toBe(providers);
  });
});

describe("shared generation rules on the agents' side", () => {
  const opencode = (
    models: ReadonlyArray<{
      readonly slug: string;
      readonly name?: string;
      readonly family?: string;
    }>,
    instanceId = "opencode",
  ): ServerProvider => ({
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-09T00:00:00.000Z",
    models: models.map(({ slug, name, family }) => ({
      slug,
      name: name ?? slug,
      isCustom: false,
      ...(family ? { family } : {}),
      capabilities: null,
    })),
    slashCommands: [],
    skills: [],
  });
  const retired = async (providers: ReadonlyArray<ServerProvider>) => {
    const { modelFamilySupersessions } = await import("./modelRankings.ts");
    return Object.fromEntries(
      [...modelFamilySupersessions(providers)].map(([key, newer]) => [
        (JSON.parse(key) as [string, string])[1],
        newer.model,
      ]),
    );
  };

  it("retires Gemini 3.1 Pro by the newest flagship although Gemini 4 renamed its lines", async () => {
    expect(
      await retired([
        opencode([
          { slug: "opencode/gemini-3.1-pro", name: "Gemini 3.1 Pro Preview", family: "gemini:pro" },
          { slug: "opencode/gemini-3.8-flash", family: "gemini:flash" },
          { slug: "opencode/gemini-3.7-flash", family: "gemini:flash" },
          { slug: "opencode/gemini-4-argon", family: "gemini:argon" },
          { slug: "opencode/gemini-4-carbon", family: "gemini:carbon" },
          { slug: "opencode/gemini-4-hydrogen", family: "gemini:hydrogen" },
        ]),
      ]),
    ).toEqual({
      "opencode/gemini-3.7-flash": "opencode/gemini-3.8-flash",
      "opencode/gemini-3.1-pro": "opencode/gemini-4-argon",
    });
    // The provider's line names the flagship when the id does not.
    expect(
      await retired([
        opencode([
          { slug: "gemini-3.1-pro", family: "gemini:pro" },
          { slug: "gemini-4", family: "gemini:argon" },
        ]),
      ]),
    ).toEqual({ "gemini-3.1-pro": "gemini-4" });
  });

  it("retires every older DeepSeek tier by a newer release; tiers and dated snapshots of one release coexist", async () => {
    expect(
      await retired([
        opencode([
          { slug: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro" },
          { slug: "deepseek-v4-flash" },
          { slug: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" },
          { slug: "deepseek-v4.1-flash" },
          { slug: "deepseek-v4.1-pro" },
        ]),
      ]),
    ).toEqual({
      "deepseek-v4-pro-0813": "deepseek-v4.1-pro",
      "deepseek-v4-flash": "deepseek-v4.1-flash",
    });
    // The real case: only V4.1 Flash is newer, and it still retires V4 Pro.
    expect(
      await retired([
        opencode([
          { slug: "deepseek-v4-pro-0813", name: "DeepSeek V4 Pro" },
          { slug: "deepseek-v4.1-flash-1017", name: "DeepSeek V4.1 Flash" },
        ]),
      ]),
    ).toEqual({ "deepseek-v4-pro-0813": "deepseek-v4.1-flash-1017" });
    // The names from before the numbered releases are older still; a "latest" alias stays.
    expect(
      await retired([
        opencode([
          { slug: "openrouter/deepseek/deepseek-chat", name: "DeepSeek Chat" },
          { slug: "openrouter/deepseek/deepseek-r1-0528", name: "DeepSeek R1 0528" },
          { slug: "openrouter/~deepseek/deepseek-pro-latest", name: "DeepSeek Pro Latest" },
          { slug: "deepseek/deepseek-flash", name: "DeepSeek V4.1 Flash 1017" },
        ]),
      ]),
    ).toEqual({
      "openrouter/deepseek/deepseek-chat": "deepseek/deepseek-flash",
      "openrouter/deepseek/deepseek-r1-0528": "deepseek/deepseek-flash",
    });
  });

  it("keeps comparing Qwen per line for agents", async () => {
    expect(
      await retired([
        opencode([{ slug: "qwen4-max" }, { slug: "qwen3.8-max" }, { slug: "qwen3.8-flash" }]),
      ]),
    ).toEqual({ "qwen3.8-max": "qwen4-max" });
  });
});

describe("ranked kinds of work", () => {
  it("lists only categories with a ranked entry, as plain lowercase words", () => {
    const ranked = { ...category, name: "Review `now`\n", order: [entries[0]!.id] };
    const unranked = { ...emptyModelRankingCategory("implementation", "Implementation"), entries };
    expect(rankedModelRankingKinds([ranked, unranked])).toEqual(["review now"]);
    expect(rankedModelRankingKinds([unranked])).toEqual([]);
  });
});
