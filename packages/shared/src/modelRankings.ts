import {
  ModelRankingTier,
  type ModelFamilyRankingEntry,
  type LegacyModelRankingEntry,
  type ServerProviderModel,
  type ModelRankingCategory,
  type ModelRankingEntry,
  type ModelRankings,
  type ModelSelection,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { supersededModelVersions } from "./model.ts";
import { MODEL_GENERATION_RULES, modelGeneration } from "./modelGenerations.ts";
import { isModelSelectionProviderEnabled } from "./serverSettings.ts";

export const BUILT_IN_MODEL_RANKING_CATEGORIES = [
  {
    id: "implementation",
    name: "Implementation",
    terms: "implement coding code backend refactor debugging fix",
  },
  { id: "review", name: "Review", terms: "review audit correctness security critique" },
  { id: "ui-design", name: "UI & design", terms: "ui ux design frontend visual interface css" },
  { id: "research", name: "Research", terms: "research search investigate browse documentation" },
  {
    id: "computer-use",
    name: "Computer use",
    terms: "computer browser automation desktop interact",
  },
  { id: "quick-tasks", name: "Quick tasks", terms: "quick fast small simple lightweight" },
] as const;

export function modelRankingCategories(rankings: ModelRankings): ModelRankings {
  return [
    ...BUILT_IN_MODEL_RANKING_CATEGORIES.map(
      (category) =>
        rankings.find((saved) => saved.id === category.id) ??
        emptyModelRankingCategory(category.id, category.name),
    ),
    ...rankings.filter(
      (saved) => !BUILT_IN_MODEL_RANKING_CATEGORIES.some((category) => category.id === saved.id),
    ),
  ];
}

export function emptyModelRankingCategory(id: string, name: string): ModelRankingCategory {
  return { id, name, entries: [], order: [], comparisons: [] };
}

export function replaceModelRankingCategory(
  rankings: ModelRankings,
  category: ModelRankingCategory,
): ModelRankings {
  return rankings.some((saved) => saved.id === category.id)
    ? rankings.map((saved) => (saved.id === category.id ? category : saved))
    : [...rankings, category];
}

const tierPosition = (entry: ModelRankingEntry) =>
  entry.tier === undefined ? 6 : ModelRankingTier.literals.indexOf(entry.tier);

/** Rankings saved before tiers show in S, or after F choices once the category has tiers. */
export function rankedEntryTier(
  category: ModelRankingCategory,
  entry: ModelRankingEntry,
): ModelRankingTier {
  return entry.tier ?? (category.entries.some((saved) => saved.tier !== undefined) ? "F" : "S");
}

/**
 * The kinds of work that have at least one ranked entry, as agents are told
 * them: plain lowercase words, a few at most.
 */
export function rankedModelRankingKinds(
  categories: ReadonlyArray<ModelRankingCategory>,
): ReadonlyArray<string> {
  return categories
    .filter((category) => orderedModelRankingEntries(category).length > 0)
    .map((category) =>
      category.name
        .replace(/[^\p{L}\p{N} -]/gu, "")
        .trim()
        .toLowerCase()
        .slice(0, 24),
    )
    .filter((name) => name.length > 0)
    .slice(0, 6);
}

/** Tiers are user assigned. Comparisons and manual moves only order entries within a tier. */
export function orderedModelRankingEntries(
  category: ModelRankingCategory,
): ReadonlyArray<ModelRankingEntry> {
  const positions = new Map(category.order.map((id, index) => [id, index]));
  return category.entries
    .filter((entry) => positions.has(entry.id) || entry.tier !== undefined)
    .sort(
      (a, b) =>
        tierPosition(a) - tierPosition(b) ||
        (positions.get(a.id) ?? 100) - (positions.get(b.id) ?? 100),
    );
}

/**
 * Insert contenders in their added order, asking about the middle of the remaining
 * earlier choices. Only explicit same-tier results establish transitive order;
 * the displayed manual order breaks selection ties and is never rewritten here.
 * Skipped pairs advance without establishing a relation. Cycles imply no order.
 */
export function nextModelRankingPair(
  category: ModelRankingCategory,
): readonly [ModelRankingEntry, ModelRankingEntry] | null {
  const entries = new Map(category.entries.map((entry) => [entry.id, entry]));
  const compared = new Set<string>();
  const edges = new Map<string, Set<string>>();
  for (const comparison of category.comparisons) {
    const left = entries.get(comparison.left);
    const right = entries.get(comparison.right);
    if (!left || !right || left.tier !== right.tier) continue;
    compared.add(JSON.stringify([left.id, right.id].sort()));
    if (comparison.result === "skip") continue;
    const winner = comparison.result === "left" ? left.id : right.id;
    const loser = comparison.result === "left" ? right.id : left.id;
    const successors = edges.get(winner) ?? new Set<string>();
    successors.add(loser);
    edges.set(winner, successors);
  }
  const reachable = new Map<string, Set<string>>();
  for (const entry of category.entries) {
    const found = new Set<string>();
    const pending = [...(edges.get(entry.id) ?? [])];
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (found.has(id)) continue;
      found.add(id);
      pending.push(...(edges.get(id) ?? []));
    }
    reachable.set(entry.id, found);
  }
  const positions = new Map(
    orderedModelRankingEntries(category).map((entry, index) => [entry.id, index]),
  );
  for (let index = 1; index < category.entries.length; index++) {
    const candidate = category.entries[index]!;
    const unresolved = category.entries.slice(0, index).filter((entry) => {
      if (entry.tier !== candidate.tier) return false;
      if (compared.has(JSON.stringify([entry.id, candidate.id].sort()))) return false;
      const before = reachable.get(entry.id)!.has(candidate.id);
      const after = reachable.get(candidate.id)!.has(entry.id);
      return before === after;
    });
    unresolved.sort((a, b) => (positions.get(a.id) ?? 100) - (positions.get(b.id) ?? 100));
    const pivot = unresolved[Math.floor((unresolved.length - 1) / 2)];
    if (pivot) return [pivot, candidate];
  }
  return null;
}

/** The latest choice moves the winner just ahead of the loser, keeping all other relative order. */
export function compareModelRankingEntries(
  category: ModelRankingCategory,
  left: string,
  right: string,
  result: "left" | "right" | "skip",
): ModelRankingCategory {
  const a = category.entries.find((entry) => entry.id === left);
  const b = category.entries.find((entry) => entry.id === right);
  if (!a || !b || left === right || a.tier !== b.tier) return category;
  let order = [...category.order];
  if (result !== "skip") {
    for (const id of [left, right]) if (!order.includes(id)) order.push(id);
    const winner = result === "left" ? left : right;
    const loser = result === "left" ? right : left;
    if (order.indexOf(winner) > order.indexOf(loser)) {
      order = order.filter((id) => id !== winner);
      order.splice(order.indexOf(loser), 0, winner);
    }
  }
  return {
    ...category,
    order,
    comparisons: [
      ...category.comparisons.filter(
        (c) => !(c.left === left && c.right === right) && !(c.left === right && c.right === left),
      ),
      { left, right, result },
    ],
  };
}

export function moveModelRankingEntry(
  category: ModelRankingCategory,
  id: string,
  direction: -1 | 1,
): ModelRankingCategory {
  const ordered = [...orderedModelRankingEntries(category)];
  const index = ordered.findIndex((entry) => entry.id === id);
  const adjacent = ordered[index + direction];
  const entry = ordered[index];
  if (!entry || !adjacent || entry.tier !== adjacent.tier) return category;
  [ordered[index], ordered[index + direction]] = [adjacent, entry];
  return { ...category, order: ordered.map((item) => item.id) };
}

export function updateModelRankingEntry(
  category: ModelRankingCategory,
  entry: ModelRankingEntry,
): ModelRankingCategory {
  const previous = category.entries.find((saved) => saved.id === entry.id);
  return {
    ...category,
    entries: category.entries.map((saved) => (saved.id === entry.id ? entry : saved)),
    order:
      entry.tier !== undefined && !category.order.includes(entry.id)
        ? [...category.order, entry.id]
        : category.order,
    comparisons:
      previous && modelRankingEntryKey(previous) !== modelRankingEntryKey(entry)
        ? category.comparisons.filter(
            (comparison) => comparison.left !== entry.id && comparison.right !== entry.id,
          )
        : category.comparisons,
  };
}

export function unrankModelRankingEntry(
  category: ModelRankingCategory,
  id: string,
): ModelRankingCategory {
  return {
    ...category,
    entries: category.entries.map((entry) => {
      const { tier: _tier, ...rest } = entry;
      return entry.id === id ? rest : entry;
    }),
    order: category.order.filter((entry) => entry !== id),
    comparisons: category.comparisons.filter((c) => c.left !== id && c.right !== id),
  };
}

export function removeModelRankingEntry(
  category: ModelRankingCategory,
  id: string,
): ModelRankingCategory {
  return {
    ...unrankModelRankingEntry(category, id),
    entries: category.entries.filter((entry) => entry.id !== id),
  };
}

export function resetModelRankingCategory(category: ModelRankingCategory): ModelRankingCategory {
  return {
    ...category,
    entries: category.entries.map(({ tier: _tier, ...entry }) => entry),
    order: [],
    comparisons: [],
  };
}

export function modelRankingSelectionKey(selection: ModelSelection): string {
  return JSON.stringify([
    selection.instanceId,
    selection.model,
    [...(selection.options ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
  ]);
}

const FAMILY_LABELS: Readonly<Record<string, string>> = {
  codex: "Codex",
  claude: "Claude",
  grok: "Grok",
  kimi: "Kimi",
  gemini: "Gemini",
  composer: "Composer",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  llama: "Llama",
  glm: "GLM",
  minimax: "MiniMax",
  mistral: "Mistral",
  muse: "Muse",
};

/** Vendors whose models come in named lines (Claude Opus, GPT Sol), keyed by the token before the line. */
const LINE_MARKERS: Readonly<Record<string, string>> = {
  claude: "claude",
  codex: "gpt",
  gemini: "gemini",
};
const LINE_LABELS: Readonly<Record<string, string>> = { codex: "GPT" };
const NOT_A_LINE = new Set(["latest", "preview", "beta", "exp", "experimental", "chat", "free"]);

/** A vendor family narrowed to the model's line: claude-opus-5-5 is `claude:opus`, gpt-6.1-sol `codex:sol`. */
export function modelRankingLineFamily(family: string, slug: string): string {
  const marker = LINE_MARKERS[family];
  if (!marker) return family;
  const tokens = slug.toLowerCase().split(/[^a-z0-9]+/);
  const start = tokens.lastIndexOf(marker);
  if (start < 0) return family;
  for (const token of tokens.slice(start + 1)) {
    if (/^\d+$/.test(token) || NOT_A_LINE.has(token)) continue;
    return /^[a-z]+$/.test(token) ? `${family}:${token}` : family;
  }
  return family;
}

/** The vendor family a line belongs to (`claude:opus` → `claude`). */
const vendorFamily = (family: string) => {
  const vendor = family.split(":")[0]!;
  return LINE_MARKERS[vendor] ? vendor : family;
};

export function modelFamilyLabel(family: string): string {
  const [vendor, line] = family.split(":");
  if (line && LINE_MARKERS[vendor!])
    return `${LINE_LABELS[vendor!] ?? FAMILY_LABELS[vendor!]} ${line[0]!.toUpperCase()}${line.slice(1)}`;
  return FAMILY_LABELS[family] ?? family.replace(/^provider:/, "");
}

/**
 * A maker's names as they appear in a model id, in the order they are tried. Built once: the
 * model picker asks for a family several times per model, for every model, each time it opens.
 */
const FAMILY_PATTERNS = [
  ["codex", /(?:^|[/. _-])(?:gpt|openai|codex)(?:[/. _-]|$)/],
  ["claude", /(?:^|[/. _-])(?:claude|anthropic)(?:[/. _-]|$)/],
  ["grok", /(?:^|[/. _-])(?:grok|xai)(?:[/. _-]|$)/],
  ["kimi", /(?:^|[/. _-])(?:kimi|moonshot)(?:[/. _-]|$)/],
  ["gemini", /(?:^|[/. _-])(?:gemini|google)(?:[/. _-]|$)/],
  ...["composer", "deepseek", "qwen", "llama", "glm", "minimax", "mistral", "muse"].map(
    (family) => [family, new RegExp(`(?:^|[/. _-])${family}(?:[/. _-]|\\d|$)`)] as const,
  ),
] as const;

/** Identify the model maker before the harness: Cursor/OpenCode can host several families. */
export function modelRankingFamily(
  model: Pick<ServerProviderModel, "slug" | "subProvider" | "family">,
  provider: { readonly driver: string; readonly displayName?: string | undefined },
): string {
  if (model.family) return model.family;
  const name = `${model.subProvider ?? ""}/${model.slug}`.toLowerCase();
  for (const [family, pattern] of FAMILY_PATTERNS)
    if (pattern.test(name)) return modelRankingLineFamily(family, name);
  const driverFamily = provider.driver === "claudeAgent" ? "claude" : provider.driver;
  if (FAMILY_LABELS[driverFamily]) return driverFamily;
  // Registry harnesses often expose a generic "default" model. Their display
  // name identifies the configured agent while the registry driver does not.
  const label = provider.displayName?.toLowerCase() ?? "";
  for (const family of ["kimi", "claude", "grok", "gemini", "codex"])
    if (label.includes(family)) return family;
  const namespace = model.subProvider ?? model.slug.split("/").slice(0, -1).join("/");
  return `provider:${namespace || provider.driver}`.slice(0, 120);
}

export function modelRankingEntryKey(entry: ModelRankingEntry): string {
  return "family" in entry ? entry.family : modelRankingSelectionKey(entry.selection);
}

/** Resolve opaque legacy identities from a catalog without coupling settings to the registry. */
function legacyModelRankingFamily(
  entry: LegacyModelRankingEntry,
  instances: ServerSettings["providerInstances"],
  providers: ReadonlyArray<ServerProvider>,
): string {
  const provider = providers.find((item) => item.instanceId === entry.selection.instanceId);
  const model = provider?.models.find((item) => item.slug === entry.selection.model);
  return modelRankingFamily(
    model ?? { slug: entry.selection.model },
    provider ?? {
      driver: instances[entry.selection.instanceId]?.driver ?? entry.selection.instanceId,
      displayName: instances[entry.selection.instanceId]?.displayName,
    },
  );
}

/**
 * The earliest ranked member supplies a family's tier/note. Archives preserve
 * conflicting choices, including edits made before an opaque family resolves.
 * Registry snapshots are optional at boot; readers reconcile provisional
 * provider families when metadata arrives, and only user saves persist edits.
 */
export function migrateModelRankings(
  rankings: ModelRankings,
  instances: ServerSettings["providerInstances"] = {},
  providers: ReadonlyArray<ServerProvider> = [],
): ModelRankings {
  let changed = false;
  const next = rankings.map((category) => {
    const legacy = category.entries.filter(
      (entry): entry is LegacyModelRankingEntry => "selection" in entry,
    );
    const sourceEntries = [...category.entries];
    const sourceOrder = [...category.order];
    const restoredRanked = new Set<string>();
    const originalOrder = category.legacy?.order ?? [];
    const catalogModel = (entry: LegacyModelRankingEntry) =>
      providers
        .find((provider) => provider.instanceId === entry.selection.instanceId)
        ?.models.find((model) => model.slug === entry.selection.model);
    // Initial releases collapsed all opaque models under one provider family.
    // Recover that active group once, then carry only its still-unresolved IDs.
    // Vendor families (Claude, Codex) later split into lines (Claude Opus, GPT Sol); recover them the same way.
    for (const entry of category.entries) {
      if (
        !("family" in entry) ||
        !(entry.family.startsWith("provider:") || LINE_MARKERS[entry.family])
      )
        continue;
      const original = category.legacy?.entries.find((saved) => saved.id === entry.id);
      if (!original) continue;
      const members = (category.legacy?.entries ?? []).filter((saved) =>
        entry.pendingLegacyIds
          ? entry.pendingLegacyIds.includes(saved.id)
          : vendorFamily(legacyModelRankingFamily(saved, instances, [])) === entry.family,
      );
      if (
        !members.some(
          (saved) =>
            catalogModel(saved) &&
            legacyModelRankingFamily(saved, instances, providers) !== entry.family,
        )
      )
        continue;
      const ranked = entry.tier !== undefined || category.order.includes(entry.id);
      const expanded = members
        .filter(
          (saved) =>
            saved.id === entry.id || !category.entries.some((active) => active.id === saved.id),
        )
        .map((saved) => {
          const { tier: _tier, note: _note, ...rest } = saved;
          if (saved.id === entry.id)
            return {
              ...rest,
              ...(entry.tier ? { tier: entry.tier } : {}),
              ...(entry.note !== undefined ? { note: entry.note } : {}),
            };
          if (ranked && (saved.tier !== undefined || originalOrder.includes(saved.id)))
            restoredRanked.add(saved.id);
          return {
            ...rest,
            ...(ranked && saved.tier ? { tier: saved.tier } : {}),
            ...(saved.note !== undefined ? { note: saved.note } : {}),
          };
        });
      const index = sourceEntries.findIndex((saved) => saved.id === entry.id);
      sourceEntries.splice(index, 1, ...expanded);
    }
    // Insert recovered choices next to their surviving original predecessors;
    // current rows keep their user-edited positions, tiers and notes.
    for (const id of [...restoredRanked].sort(
      (a, b) =>
        (originalOrder.indexOf(a) < 0 ? 100 : originalOrder.indexOf(a)) -
        (originalOrder.indexOf(b) < 0 ? 100 : originalOrder.indexOf(b)),
    )) {
      const oldIndex = originalOrder.indexOf(id);
      const predecessor =
        oldIndex < 0
          ? undefined
          : originalOrder.slice(0, oldIndex).findLast((saved) => sourceOrder.includes(saved));
      sourceOrder.splice(
        predecessor ? sourceOrder.indexOf(predecessor) + 1 : oldIndex < 0 ? sourceOrder.length : 0,
        0,
        id,
      );
    }
    const sourceComparisons = [
      ...category.comparisons,
      ...(category.legacy?.comparisons ?? []).filter(
        (comparison) => restoredRanked.has(comparison.left) || restoredRanked.has(comparison.right),
      ),
    ];
    const sourceCategory = {
      ...category,
      entries: sourceEntries,
      order: sourceOrder,
      comparisons: sourceComparisons,
    };
    const resolved = new Map<string, string>();
    for (const entry of sourceEntries) {
      if ("selection" in entry)
        resolved.set(entry.id, legacyModelRankingFamily(entry, instances, providers));
    }
    if (!resolved.size) return category;
    changed = true;
    const byFamily = new Map<string, ModelFamilyRankingEntry>();
    const ids = new Map<string, string>();
    // Keep the edited representative of an unresolved group until that exact
    // source resolves. A secondary's archived tier must not replace its edits.
    const activeProvisional = sourceEntries.filter((entry) =>
      category.entries.some(
        (active) =>
          "family" in active &&
          active.id === entry.id &&
          active.family.startsWith("provider:") &&
          resolved.get(entry.id) === active.family,
      ),
    );
    for (const entry of [
      ...activeProvisional,
      ...orderedModelRankingEntries(sourceCategory),
      ...sourceEntries,
    ]) {
      const family = resolved.get(entry.id) ?? ("family" in entry ? entry.family : "");
      let saved = byFamily.get(family);
      if (!saved) {
        saved = {
          id: entry.id,
          family,
          label: resolved.has(entry.id) ? modelFamilyLabel(family) : entry.label,
          ...(entry.tier ? { tier: entry.tier } : {}),
          ...(entry.note !== undefined ? { note: entry.note } : {}),
          ...("pendingLegacyIds" in entry && entry.pendingLegacyIds
            ? { pendingLegacyIds: entry.pendingLegacyIds }
            : {}),
        };
        byFamily.set(family, saved);
      }
      if ("selection" in entry && family.startsWith("provider:") && !catalogModel(entry)?.family) {
        const pending = [...(saved.pendingLegacyIds ?? [])];
        if (!pending.includes(entry.id)) pending.push(entry.id);
        saved = { ...saved, pendingLegacyIds: pending };
        byFamily.set(family, saved);
      }
      ids.set(entry.id, saved.id);
    }
    const entriesById = new Map([...byFamily.values()].map((entry) => [entry.id, entry]));
    const entries = [...new Set(sourceEntries.map((entry) => ids.get(entry.id)!))].map((id) =>
      entriesById.get(id)!,
    );
    const order = [
      ...new Set(orderedModelRankingEntries(sourceCategory).map((entry) => ids.get(entry.id)!)),
    ];
    const comparisons: ModelRankingCategory["comparisons"][number][] = [];
    for (const comparison of sourceComparisons) {
      const left = ids.get(comparison.left);
      const right = ids.get(comparison.right);
      if (
        !left ||
        !right ||
        left === right ||
        comparisons.some(
          (saved) =>
            (saved.left === left && saved.right === right) ||
            (saved.left === right && saved.right === left),
        )
      )
        continue;
      comparisons.push({ ...comparison, left, right });
    }
    const families = category.entries.filter(
      (entry): entry is ModelFamilyRankingEntry => "family" in entry,
    );
    return {
      ...category,
      entries,
      order,
      comparisons,
      legacy: {
        entries: [...(category.legacy?.entries ?? []), ...legacy],
        ...(families.length
          ? { families: [...(category.legacy?.families ?? []), ...families] }
          : category.legacy?.families
            ? { families: category.legacy.families }
            : {}),
        order: [...(category.legacy?.order ?? []), ...category.order],
        comparisons: [...(category.legacy?.comparisons ?? []), ...category.comparisons],
      },
    };
  });
  return changed ? next : rankings;
}

/** Route namespaces identify transport, not a different release of a model line. */
function normalizedFamilyModelId(slug: string): string {
  return slug
    .toLowerCase()
    .split("/")
    .at(-1)!
    .replace(/^(?:openai|anthropic|google|xai|moonshot)[.:]/, "");
}

export type ModelFamilyReplacement = {
  readonly instanceId: ServerProvider["instanceId"];
  readonly model: string;
};

/** Compare releases across every instance/route in each family before ranking routes. */
export function modelFamilySupersessions(providers: ReadonlyArray<ServerProvider>) {
  const inventory = providers
    .flatMap((provider) =>
      provider.models.map((model) => ({
        family: modelRankingFamily(model, provider),
        identity: normalizedFamilyModelId(model.slug),
        generation: sharedGeneration(model, provider),
        instanceId: provider.instanceId,
        model: model.slug,
        isDefault: model.isDefault === true,
        // A user's custom id or an already-retired release never retires a current one.
        canReplace: model.isCustom !== true && model.isLegacy !== true,
      })),
    )
    .sort(
      (a, b) =>
        Number(b.isDefault) - Number(a.isDefault) ||
        a.instanceId.localeCompare(b.instanceId) ||
        a.model.localeCompare(b.model),
    );
  const byFamily = new Map<string, typeof inventory>();
  for (const model of inventory) {
    const family = byFamily.get(model.family) ?? [];
    family.push(model);
    byFamily.set(model.family, family);
  }
  const superseded = new Map<string, ModelFamilyReplacement>();
  for (const models of byFamily.values()) {
    const versions = supersededModelVersions(
      models.map((model) => model.identity),
      new Set(models.filter((model) => model.canReplace).map((model) => model.identity)),
    );
    for (const model of models) {
      const newer = versions.get(model.identity);
      if (!newer) continue;
      const replacement = models.find(
        (candidate) => candidate.identity === newer && candidate.canReplace,
      )!;
      superseded.set(
        modelRankingSelectionKey({ instanceId: model.instanceId, model: model.model }),
        { instanceId: replacement.instanceId, model: replacement.model },
      );
    }
  }
  // A newer generation retires older tiers too (Gemini 4 Argon retires 3.1 Pro).
  const generations = supersededModelVersions(
    inventory.flatMap((model) => (model.generation ? [model.generation] : [])),
    new Set(
      inventory.flatMap((model) =>
        model.generation && model.canReplace ? [model.generation] : [],
      ),
    ),
  );
  for (const model of inventory) {
    const newer = model.generation ? generations.get(model.generation) : undefined;
    const key = modelRankingSelectionKey({ instanceId: model.instanceId, model: model.model });
    if (!newer || superseded.has(key)) continue;
    const candidates = inventory.filter(
      (candidate) => candidate.generation === newer && candidate.canReplace,
    );
    const replacement =
      candidates.find((candidate) => candidate.instanceId === model.instanceId) ?? candidates[0]!;
    superseded.set(key, { instanceId: replacement.instanceId, model: replacement.model });
  }
  return superseded;
}

/**
 * The shared generation id agents compare across tiers. Custom models are the user's
 * deliberate picks, so, as in the picker, they neither retire nor get retired here.
 */
function sharedGeneration(
  model: Pick<ServerProviderModel, "slug" | "name" | "subProvider" | "family" | "isCustom">,
  provider: Pick<ServerProvider, "instanceId" | "driver" | "displayName">,
): string | null {
  if (model.isCustom) return null;
  const [maker, line] = modelRankingFamily(model, provider).split(":");
  if (!maker || MODEL_GENERATION_RULES[maker]?.pickerOnly) return null;
  return modelGeneration(maker, `${model.slug} ${model.name}`, line);
}

/**
 * Marks every built-in model a newer release of its line replaces (on any
 * instance or route) as legacy, so pickers file it with older models and
 * defaults skip it, as agents already do. Custom models stay as the user set them.
 */
export function markSupersededModelsLegacy(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> {
  const superseded = modelFamilySupersessions(providers);
  if (superseded.size === 0) return providers;
  return providers.map((provider) => {
    let changed = false;
    const models = provider.models.map((model) => {
      if (model.isLegacy || model.isCustom) return model;
      const key = modelRankingSelectionKey({ instanceId: provider.instanceId, model: model.slug });
      if (!superseded.has(key)) return model;
      changed = true;
      return { ...model, isLegacy: true };
    });
    return changed ? { ...provider, models } : provider;
  });
}

export type ModelRankingContender = {
  readonly family: string;
  readonly selection: ModelSelection;
  readonly label: string;
  readonly providerLabel: string;
  readonly isDefault: boolean;
  readonly unavailableReason: string | null;
  /** Provider driver; OpenCode routes (OpenRouter, Copilot, …) rank behind native harnesses. */
  readonly driver?: string;
};

/** OpenCode re-serves hundreds of models through routers; native harnesses are the user's own. */
const isRouted = (item: ModelRankingContender) => item.driver === "opencode";

/**
 * Release numbers from a model's name or id ("Kimi K3.1 Pro" → [3, 0.1]); dates
 * and sizes skipped. Parts after the first are decimals: Grok 4.20 is older than 4.7.
 */
function releaseOf(item: ModelRankingContender): number[] {
  for (const text of [item.label, item.selection.model]) {
    const match = /(?:^|[^\d.])(\d{1,2}(?:\.\d{1,2})*)(?![\d.]|[bkm]\b)/iu.exec(text);
    if (match) {
      return match[1]!
        .split(".")
        .map((part, index) => (index === 0 ? Number(part) : Number(`0.${part}`)));
    }
  }
  return [];
}

const newerFirst = (a: ModelRankingContender, b: ModelRankingContender) => {
  const left = releaseOf(a);
  const right = releaseOf(b);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (right[index] ?? -1) - (left[index] ?? -1);
    if (diff) return diff;
  }
  return 0;
};

/** Concrete candidates are always resolved from the live catalog, never saved version IDs. */
export function modelRankingCatalog(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ModelRankingContender> {
  const superseded = modelFamilySupersessions(providers);
  return providers.flatMap((provider) => {
    const hidden = settings.providerModelPreferences?.[provider.instanceId]?.hiddenModels ?? [];
    // Hidden successors still supersede old versions. A preference must never
    // silently fall back to an obsolete version because its successor is hidden.
    return provider.models.map((model) => {
      const selection = { instanceId: provider.instanceId, model: model.slug };
      const providerLabel = provider.displayName ?? provider.instanceId;
      const replacement = superseded.get(modelRankingSelectionKey(selection));
      const unavailableReason =
        provider.availability === "unavailable"
          ? "Provider unavailable"
          : !provider.enabled || !isModelSelectionProviderEnabled(settings, selection)
            ? "Provider disabled"
            : !provider.installed
              ? "Provider not installed"
              : provider.auth.status === "unauthenticated"
                ? "Sign in to provider"
                : provider.status === "error" || provider.status === "disabled"
                  ? "Provider not ready"
                  : hidden.includes(model.slug) && !model.isCustom
                    ? "Hidden in model settings"
                    : replacement
                      ? `Superseded by ${replacement.model} on ${replacement.instanceId}`
                      : model.isLegacy
                        ? "Legacy model; choose a current model"
                        : null;
      return {
        family: modelRankingFamily(model, provider),
        selection,
        label: model.name,
        providerLabel,
        isDefault: model.isDefault === true,
        unavailableReason,
        driver: provider.driver,
      };
    });
  });
}

export function modelRankingFamilyCatalog(catalog: ReadonlyArray<ModelRankingContender>) {
  return [...new Set(catalog.map((item) => item.family))]
    .map((family) => ({
      family,
      label: modelFamilyLabel(family),
      unavailableReason: catalog.some((item) => item.family === family && !item.unavailableReason)
        ? null
        : "No current models available in this family",
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function currentModelRankingCandidate(
  entry: ModelRankingEntry,
  catalog: ReadonlyArray<ModelRankingContender>,
): ModelRankingContender | undefined {
  if (!("family" in entry)) return undefined;
  // A vendor family saved before lines existed (Codex, Claude) still covers all its lines.
  const vendorWide = LINE_MARKERS[entry.family] !== undefined;
  return catalog
    .filter(
      (item) =>
        (item.family === entry.family ||
          (vendorWide && vendorFamily(item.family) === entry.family)) &&
        !item.unavailableReason,
    )
    .sort(
      (a, b) =>
        Number(isRouted(a)) - Number(isRouted(b)) ||
        Number(b.isDefault) - Number(a.isDefault) ||
        newerFirst(a, b) ||
        a.selection.instanceId.localeCompare(b.selection.instanceId) ||
        a.selection.model.localeCompare(b.selection.model),
    )[0];
}

export function modelRankingEntryAvailability(
  entry: ModelRankingEntry,
  catalog: ReadonlyArray<ModelRankingContender>,
): string | null {
  return currentModelRankingCandidate(entry, catalog)
    ? null
    : "No current models available in this family";
}

export type ModelRankingRow = {
  readonly entry: ModelRankingEntry;
  readonly rank: number | null;
  readonly tier: ModelRankingTier | null;
  readonly tierIndex: number | null;
  readonly modelLabel: string | null;
  readonly provider: ServerProvider | undefined;
  readonly unavailableReason: string | null;
};

/** Major version after the vendor's marker token: claude-opus-5-5 → 5, gpt-6.1-sol → 6. */
function lineMajorVersion(vendor: string, slug: string): number | undefined {
  const tokens = slug.toLowerCase().split(/[^a-z0-9]+/);
  const start = tokens.lastIndexOf(LINE_MARKERS[vendor]!);
  if (start < 0) return undefined;
  // The first numeric token is the release (gpt-4o-2024-08-06 is 4); sizes and dates aren't (gpt-oss-120b).
  const release = /^(\d{1,2})o?$/.exec(tokens.slice(start + 1).find((t) => /^\d/.test(t)) ?? "");
  return release ? Number(release[1]) : undefined;
}

/** Lined vendors' families from an older generation (GPT-3.5 Turbo beside GPT-6 lines) or unversioned. */
function olderGenerationFamilies(
  catalog: ReadonlyArray<ModelRankingContender>,
): ReadonlySet<string> {
  const newest = new Map<string, number>();
  for (const item of catalog) {
    const vendor = vendorFamily(item.family).split(":")[0]!;
    if (!LINE_MARKERS[vendor] || item.unavailableReason) continue;
    const major = lineMajorVersion(vendor, item.selection.model);
    if (major !== undefined) newest.set(item.family, Math.max(newest.get(item.family) ?? 0, major));
  }
  const vendorNewest = new Map<string, number>();
  for (const [family, major] of newest) {
    const vendor = family.split(":")[0]!;
    vendorNewest.set(vendor, Math.max(vendorNewest.get(vendor) ?? 0, major));
  }
  return new Set(
    catalog
      .map((item) => item.family)
      .filter((family) => {
        const vendor = family.split(":")[0]!;
        return LINE_MARKERS[vendor] && (newest.get(family) ?? -1) < (vendorNewest.get(vendor) ?? 0);
      }),
  );
}

/**
 * Show usable families immediately, without creating preferences until the user ranks one.
 * `used` holds families the user has run subagents on: those show even when only a router
 * (OpenCode) serves them, since the user plainly uses that route.
 */
export function modelRankingRows(
  category: ModelRankingCategory,
  catalog: ReadonlyArray<ModelRankingContender>,
  providers: ReadonlyArray<ServerProvider>,
  showAll = false,
  used: ReadonlySet<string> = new Set(),
): ReadonlyArray<ModelRankingRow> {
  const ordered = orderedModelRankingEntries(category);
  const positions = new Map(ordered.map((entry, index) => [entry.id, index]));
  const tierPositions = new Map<string, number>();
  for (const tier of ModelRankingTier.literals)
    ordered
      .filter((entry) => rankedEntryTier(category, entry) === tier)
      .forEach((entry, index) => tierPositions.set(entry.id, index));
  const families = new Map(
    category.entries.flatMap((entry) =>
      "family" in entry ? [[entry.family, entry] as const] : [],
    ),
  );
  const ids = new Set(category.entries.map((entry) => entry.id));
  const older = showAll ? new Set<string>() : olderGenerationFamilies(catalog);
  // Families the user can run on a native harness; router-only ones wait behind Show all.
  const native = new Set(
    catalog.filter((item) => !item.unavailableReason && !isRouted(item)).map((item) => item.family),
  );
  for (const item of modelRankingFamilyCatalog(catalog)) {
    if (families.has(item.family)) continue;
    let id = item.family;
    for (let suffix = 2; ids.has(id); suffix++) id = `${item.family.slice(0, 110)}:${suffix}`;
    ids.add(id);
    families.set(item.family, { id, family: item.family, label: item.label.slice(0, 200) });
  }
  return [...families]
    .flatMap(([family, entry]) => {
      const candidate = currentModelRankingCandidate(entry, catalog);
      const internal = /^(?:provider:)?(?:acpRegistry|blackwell(?:[-:]|$))/i.test(family);
      const background =
        older.has(family) ||
        family.startsWith("provider:") ||
        (!native.has(family) && !used.has(family));
      if (!showAll && (!candidate || internal || (background && !positions.has(entry.id))))
        return [];
      const display = candidate ?? catalog.find((item) => item.family === family);
      return [
        {
          entry,
          rank: positions.get(entry.id) ?? null,
          tier: positions.has(entry.id) ? rankedEntryTier(category, entry) : null,
          tierIndex: tierPositions.get(entry.id) ?? null,
          modelLabel: display?.label ?? null,
          provider: providers.find(
            (provider) => provider.instanceId === display?.selection.instanceId,
          ),
          unavailableReason: candidate ? null : "No current models available in this family",
        },
      ];
    })
    .sort(
      (a, b) =>
        (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.entry.label.localeCompare(b.entry.label),
    );
}

/**
 * The tier the user gave each model's family in one category, for showing beside
 * models. A vendor family ranked before lines existed (Claude) covers its lines.
 * Models whose family isn't ranked there get null.
 */
export function modelRankingTierLookup(
  rankings: ModelRankings,
  instances: ServerSettings["providerInstances"],
  providers: ReadonlyArray<ServerProvider>,
  categoryId: string,
): (instanceId: string, slug: string) => ModelRankingTier | null {
  const category = migrateModelRankings(rankings, instances, providers).find(
    (saved) => saved.id === categoryId,
  );
  const ranked = category
    ? orderedModelRankingEntries(category).flatMap((entry) => ("family" in entry ? [entry] : []))
    : [];
  if (!category || ranked.length === 0) return () => null;
  return (instanceId, slug) => {
    const provider = providers.find((item) => item.instanceId === instanceId);
    if (!provider) return null;
    const family = modelRankingFamily(
      provider.models.find((item) => item.slug === slug) ?? { slug },
      provider,
    );
    const entry =
      ranked.find((saved) => saved.family === family) ??
      ranked.find(
        (saved) =>
          LINE_MARKERS[saved.family] !== undefined && vendorFamily(family) === saved.family,
      );
    return entry ? rankedEntryTier(category, entry) : null;
  };
}

/** Place a family within a tier. Flat saved rankings keep their order in their shown tier. */
export function positionModelRankingEntry(
  category: ModelRankingCategory,
  entry: ModelRankingEntry,
  tier: ModelRankingTier | null,
  position = Infinity,
): ModelRankingCategory {
  const exists = category.entries.some((saved) => saved.id === entry.id);
  if (tier === null) return exists ? unrankModelRankingEntry(category, entry.id) : category;
  if (!exists && category.entries.length >= 100) return category;
  const ordered = orderedModelRankingEntries(category);
  const ranked = new Set(ordered.map((saved) => saved.id));
  const order = ModelRankingTier.literals.flatMap((currentTier) => {
    const ids = ordered
      .filter((saved) => saved.id !== entry.id && rankedEntryTier(category, saved) === currentTier)
      .map((saved) => saved.id);
    if (currentTier === tier) ids.splice(Math.max(0, Math.min(position, ids.length)), 0, entry.id);
    return ids;
  });
  return {
    ...category,
    entries: (exists ? category.entries : [...category.entries, entry]).map((saved) =>
      saved.id === entry.id
        ? { ...saved, tier }
        : ranked.has(saved.id) && saved.tier === undefined
          ? { ...saved, tier: rankedEntryTier(category, saved) }
          : saved,
    ),
    order,
  };
}

/** Prefer category names and phrases over incidental synonyms; never pick an unrelated default. */
export function matchModelRankingCategory(
  rankings: ModelRankings,
  task: string,
): ModelRankingCategory | null {
  const normalize = (text: string) =>
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean)
      .join(" ");
  const query = normalize(task);
  if (!query) return null;
  const words = new Set(query.split(" ").filter((word) => word.length > 1));
  const matches = rankings.map((category) => {
    const builtin = BUILT_IN_MODEL_RANKING_CATEGORIES.find((item) => item.id === category.id);
    const names = [normalize(category.name), normalize(category.id)];
    const phraseLength = Math.max(
      0,
      ...names
        .filter((name) => ` ${query} `.includes(` ${name} `))
        .map((name) => name.split(" ").length),
    );
    const terms = normalize(`${category.name} ${category.id} ${builtin?.terms ?? ""}`).split(" ");
    return {
      category,
      exact: Number(names.includes(query)),
      phraseLength,
      words: new Set(terms.filter((term) => words.has(term))).size,
      ranked: Number(orderedModelRankingEntries(category).length > 0),
      builtin: Number(builtin !== undefined),
    };
  });
  matches.sort(
    (a, b) =>
      b.exact - a.exact ||
      b.phraseLength - a.phraseLength ||
      b.words - a.words ||
      b.ranked - a.ranked ||
      b.builtin - a.builtin ||
      a.category.id.localeCompare(b.category.id),
  );
  const best = matches[0];
  return best && (best.exact || best.phraseLength || best.words) ? best.category : null;
}
