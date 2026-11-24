import { type ServerProvider, type ServerSettings } from "@t3tools/contracts";
import { readCustomModelEntries, supersededModelVersions } from "@t3tools/shared/model";
import {
  modelFamilySupersessions,
  modelRankingFamily,
  modelRankingSelectionKey,
} from "@t3tools/shared/modelRankings";
import { modelGeneration } from "@t3tools/shared/modelGenerations";
import { parseModelRef } from "@t3tools/shared/modelRefs";

import {
  canonicalModelId,
  DEVIN_ACP_AGENT_ID,
  defaultModelRoute,
  findMakerModel,
  groupModelsByMaker,
  modelMakerForFamily,
  modelMakerSearchNames,
  modelRouteHasSlug,
  modelVendorFamily,
  type ModelRouteRef,
  type ModelRouteSource,
} from "./modelMakers.ts";

export interface ModelPickerCatalogInput {
  /** Only the destination environment's catalog, before picker/continuation filters. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerInstances?: ServerSettings["providerInstances"] | undefined;
  readonly selected?: ReadonlyArray<ModelRouteRef> | undefined;
  /** Starred models. A star keeps a model that only search finds in the lists. */
  readonly favorites?: ReadonlyArray<ModelRouteRef> | undefined;
  readonly search?: string | undefined;
}

/** The picker's curation. Generation policy is `MODEL_GENERATION_RULES` in shared. */
export const MODEL_PICKER_CURATION: {
  readonly families: ReadonlySet<string>;
  readonly nativeOnlyFamilies: ReadonlySet<string>;
  /** Makers whose other harnesses' routes show beside the native one, under the same row. */
  readonly sharedRouteFamilies: ReadonlySet<string>;
  readonly publishers: ReadonlySet<string>;
  readonly excludedModels: RegExp;
} = {
  families: new Set([
    "codex",
    "claude",
    "grok",
    "gemini",
    "qwen",
    "kimi",
    "glm",
    "deepseek",
    "mistral",
    "minimax",
    "inkling",
    "composer",
    "muse",
  ]),
  nativeOnlyFamilies: new Set(["codex", "claude", "grok", "gemini", "composer"]),
  // Muse also runs through OpenCode (Zen and Go), which can work when Muse Code's own billing doesn't.
  sharedRouteFamilies: new Set(["muse"]),
  publishers: new Set([
    "openai",
    "anthropic",
    "x-ai",
    "xai",
    "google",
    "qwen",
    "moonshotai",
    "moonshot",
    "z-ai",
    "zai",
    "deepseek",
    "mistralai",
    "minimax",
    "minimaxai",
    "minimax-ai",
    "thinkingmachines",
    "thinking-machines",
    "meta",
    "meta-llama",
    "cursor",
    "muse",
  ]),
  // Gemma and Google's media makers (Omni video, Lyria, Nano Banana) are not coding models; DeepSeek Chat/R1 and MiniMax-01 are retired.
  excludedModels:
    /(?:\bllama\b|lunaris|euryale|aion[- ]?rp|\bgemini[- ][\d.-]+[- ]flash[- ]lite|\bgemma\b|\bgemini[- ]omni\b|\blyria\b|\bnano[- ]banana\b|\bimagen\b|\bveo\b|\bdeepseek[- ]?(?:chat|r\d|reasoner|coder)\b|\bminimax[- ]?01\b)/i,
};

// Which release retires which is shared with the agents' list (`MODEL_GENERATION_RULES`);
// only the picker also retires Qwen's other tiers.
function pickerGeneration(source: ModelRouteSource) {
  return modelGeneration(
    modelVendorFamily(source),
    `${source.slug} ${source.name}`,
    source.family?.split(":")[1],
  );
}

function isCuratedModel(source: ModelRouteSource) {
  const family = modelVendorFamily(source);
  if (!family || !MODEL_PICKER_CURATION.families.has(family)) return false;
  // Namespaced community finetunes should not enter merely by mentioning a curated maker.
  const parts = source.slug.toLowerCase().split("/");
  const publisher = parts.length >= 2 ? parts.at(-2)!.split(":").at(-1)! : null;
  return (
    publisher === null ||
    MODEL_PICKER_CURATION.publishers.has(publisher) ||
    publisher === "openrouter" ||
    publisher === "opencode" ||
    publisher === "opencode-go" ||
    publisher === "github-copilot"
  );
}

const routeKey = (ref: ModelRouteRef) => JSON.stringify([ref.instanceId, ref.slug]);

/** Original refs remain the mutation/order keys even when the picker displays a native route. */
export function resolveModelPickerFavorites(
  refs: ReadonlyArray<ModelRouteRef>,
  resolve: (ref: ModelRouteRef) => ModelRouteRef | null,
) {
  return refs.flatMap((original) => {
    const target = resolve(original);
    return target ? [{ original, target }] : [];
  });
}

function instanceConfig(value: unknown): {
  readonly agentId?: string;
  readonly customModels?: unknown;
} {
  if (typeof value !== "object" || value === null) return {};
  return {
    ...("agentId" in value && typeof value.agentId === "string" ? { agentId: value.agentId } : {}),
    ...("customModels" in value ? { customModels: value.customModels } : {}),
  };
}

/** Registry identity survives renaming an instance; older hosts also publish it in the icon. */
function registryAgentId(provider: ServerProvider, config: ReturnType<typeof instanceConfig>) {
  return (
    config.agentId ??
    /^https:\/\/cdn\.agentclientprotocol\.com\/registry\/v1\/latest\/([a-z0-9._-]+)\.svg$/.exec(
      provider.iconUrl ?? "",
    )?.[1]
  );
}

/** Exact model names/ids reopen old releases without a broad maker search exposing them all. */
/**
 * A search reaches every model the curation hides: each typed word must appear in the
 * model's id, name or maker ("inkling 2 small", "thinking machines", "glm5.3"). A pasted
 * model page searches by the id it names. Null when there is nothing to search.
 */
function modelSearchMatcher(search: string): ((source: ModelRouteSource) => boolean) | null {
  const query = (parseModelRef(search)?.id ?? search).trim().toLowerCase();
  const words = query.split(/[\s/_:,-]+/).filter((word) => word.length > 0);
  if (query.replace(/[^a-z0-9]/g, "").length < 2 || words.length === 0) return null;
  return (source) => {
    const family = modelVendorFamily(source);
    const maker = modelMakerForFamily(family);
    const text = [
      source.slug,
      source.name,
      canonicalModelId(source, family),
      modelMakerSearchNames(maker),
    ]
      .join(" ")
      .toLowerCase();
    const spaced = text.replace(/[/_:,-]+/g, " ");
    const compact = text.replace(/[^a-z0-9.]/g, "");
    return words.every((word) => spaced.includes(word) || compact.includes(word));
  };
}

/**
 * Shared web/mobile picker policy. Native routing and release comparisons use the whole
 * environment, so a locked chat cannot make a generic route look like the only harness.
 * Explicit customModels entries (including discovered slugs) and isCustom models
 * keep their open-model routes/releases. Closed frontier makers still use their native
 * harness. A custom instance name alone does not exempt its auto catalog.
 */
export function createModelPickerCatalog<T extends ModelRouteSource>(
  sources: ReadonlyArray<T>,
  input: ModelPickerCatalogInput,
) {
  const providers = new Map(
    input.providers.map((provider) => [provider.instanceId as string, provider]),
  );
  const configs = new Map(
    input.providers.map((provider) => [
      provider.instanceId as string,
      instanceConfig(input.providerInstances?.[provider.instanceId]?.config),
    ]),
  );
  const customSlugs = new Map(
    [...configs].map(([id, config]) => [
      id,
      new Set(readCustomModelEntries(config.customModels).map((model) => model.slug)),
    ]),
  );
  const inventory = input.providers.flatMap((provider) =>
    provider.models.map((model) => ({
      instanceId: provider.instanceId,
      driver: provider.driver,
      instanceName: provider.displayName ?? provider.driver,
      ...model,
    })),
  );
  const deliberateRefs = new Set(
    inventory
      .filter((source) => source.isCustom || customSlugs.get(source.instanceId)?.has(source.slug))
      .map(routeKey),
  );
  const isDeliberate = (source: ModelRouteSource) => deliberateRefs.has(routeKey(source));
  const oldGenerations = supersededModelVersions(
    inventory
      .filter((source) => !isDeliberate(source))
      .flatMap((source) => {
        const generation = pickerGeneration(source);
        return generation ? [generation] : [];
      }),
  );
  const aliases = new Map(
    inventory.flatMap((source) =>
      (source.aliases ?? []).map(
        (alias) =>
          [
            routeKey({ instanceId: source.instanceId, slug: alias }),
            { instanceId: source.instanceId, slug: source.slug },
          ] as const,
      ),
    ),
  );
  // This is the same cross-route release calculation used by orchestrator_capabilities.
  const superseded = modelFamilySupersessions(input.providers);
  const modelMetadata = new Map(
    input.providers.flatMap((provider) =>
      provider.models.map(
        (model) =>
          [
            routeKey({ instanceId: provider.instanceId, slug: model.slug }),
            {
              isOld:
                model.isLegacy ||
                superseded.has(
                  modelRankingSelectionKey({ instanceId: provider.instanceId, model: model.slug }),
                ),
            },
          ] as const,
      ),
    ),
  );
  const aliasIds = new Set(aliases.keys());
  const currentByFamily = new Map<string, typeof inventory>();
  const latestAlias = /(?:^|[-/.:])latest(?:$|[-/.:])/i;
  for (const source of inventory) {
    if (latestAlias.test(source.slug) || modelMetadata.get(routeKey(source))?.isOld) continue;
    const key = `${source.instanceId}:${modelRankingFamily(source, { driver: source.driver })}`;
    const models = currentByFamily.get(key) ?? [];
    models.push(source);
    currentByFamily.set(key, models);
  }
  const inventoryByRef = new Map(inventory.map((source) => [routeKey(source), source]));
  for (const source of inventory) {
    if (isDeliberate(source)) continue;
    // Prefer the rolling release over a dated copy when the catalog lists both.
    const rolling = source.slug.replace(/[-@](?:\d{4}-?\d{2}-?\d{2}|\d{4})$/, "");
    const base = inventoryByRef.get(routeKey({ instanceId: source.instanceId, slug: rolling }));
    if (base && base !== source) {
      aliasIds.add(routeKey(source));
      aliases.set(routeKey(source), { instanceId: base.instanceId, slug: base.slug });
    }
    if (!latestAlias.test(source.slug)) continue;
    const candidates =
      currentByFamily.get(
        `${source.instanceId}:${modelRankingFamily(source, { driver: source.driver })}`,
      ) ?? [];
    if (candidates.length === 0) continue;
    aliasIds.add(routeKey(source));
    const defaults = candidates.filter((candidate) => candidate.isDefault);
    const target =
      candidates.length === 1 ? candidates[0] : defaults.length === 1 ? defaults[0] : undefined;
    if (target && !aliases.has(routeKey(source)))
      aliases.set(routeKey(source), { instanceId: target.instanceId, slug: target.slug });
  }
  const isNative = (source: ModelRouteSource) => {
    const icon = modelMakerForFamily(modelVendorFamily(source)).icon;
    if (!icon || icon.driver !== source.driver) return false;
    if (!icon.acpAgentId) return true;
    const provider = providers.get(source.instanceId);
    return (
      provider !== undefined &&
      registryAgentId(provider, configs.get(source.instanceId) ?? {}) === icon.acpAgentId
    );
  };
  // Antigravity is Google's own harness for Gemini alongside Gemini CLI, though it does not hide
  // OpenCode Gemini gateways (its plan lacks models such as Carbon).
  const isOwnHarness = (source: ModelRouteSource) =>
    isNative(source) || (source.driver === "antigravity" && modelVendorFamily(source) === "gemini");
  const nativeFamilies = new Set<string>();
  for (const provider of input.providers) {
    if (
      !provider.enabled ||
      !provider.installed ||
      provider.availability === "unavailable" ||
      provider.status !== "ready" ||
      provider.auth.status === "unauthenticated"
    )
      continue;
    for (const model of provider.models) {
      const source = {
        instanceId: provider.instanceId,
        driver: provider.driver,
        instanceName: provider.displayName ?? provider.driver,
        ...model,
      };
      const family = modelVendorFamily(source);
      if (family && isNative(source)) nativeFamilies.add(family);
    }
  }
  // Devin, and Antigravity signed in to a Google AI plan, are plans that run other
  // makers' models (Google's includes Claude): their routes sit beside the native harness's
  // under the same rows (the native harness still leads), not hidden. Antigravity on an API
  // key or Vertex bills per token, like any gateway.
  const isPlanHarnessRoute = (source: ModelRouteSource) => {
    const provider = providers.get(source.instanceId);
    if (provider === undefined) return false;
    if (provider.driver === "antigravity") {
      // Its Gemini routes are the native ones.
      return (
        !isOwnHarness(source) &&
        (provider.auth.type === "oauth-personal" || provider.auth.type === "oauth-business")
      );
    }
    return registryAgentId(provider, configs.get(source.instanceId) ?? {}) === DEVIN_ACP_AGENT_ID;
  };
  // Devin's ids carry effort and variant suffixes ("gpt-5-4-none", "claude-opus-4-6-thinking-1m")
  // that no other route shares, so its frontier releases compare by name: an older line or
  // generation than the native harness's newest stays hidden (search still finds it).
  const planLine = (source: ModelRouteSource) =>
    source.name
      .toLowerCase()
      .replace(/\b(?:thinking|1m)\b/g, " ")
      .trim()
      .replace(/\s+/g, "-");
  const nameMajor = (source: ModelRouteSource) => {
    const match = /(\d+)(?:\.\d+)*/.exec(source.name);
    return match ? Number(match[1]) : null;
  };
  const oldPlanRoutes = new Set<string>();
  for (const family of MODEL_PICKER_CURATION.nativeOnlyFamilies) {
    const members = inventory.filter(
      (source) =>
        modelVendorFamily(source) === family && (isNative(source) || isPlanHarnessRoute(source)),
    );
    const newestNativeMajor = Math.max(
      -1,
      ...members.flatMap((source) => {
        const major = isNative(source) ? nameMajor(source) : null;
        return major === null ? [] : [major];
      }),
    );
    const superseded = supersededModelVersions(members.map(planLine));
    for (const source of members) {
      if (!isPlanHarnessRoute(source)) continue;
      const major = nameMajor(source);
      if (superseded.has(planLine(source)) || (major !== null && major < newestNativeMajor))
        oldPlanRoutes.add(routeKey(source));
    }
  }
  const nativeRoutingHides = (source: T) => {
    if (isPlanHarnessRoute(source)) return false;
    const family = modelVendorFamily(source);
    if (family !== null && MODEL_PICKER_CURATION.sharedRouteFamilies.has(family)) return false;
    if (
      family !== null &&
      !MODEL_PICKER_CURATION.nativeOnlyFamilies.has(family) &&
      isDeliberate(source)
    )
      return false;
    return family !== null && nativeFamilies.has(family) && !isOwnHarness(source);
  };
  const selected = new Set(input.selected?.map(routeKey));
  const curatedVisible = (source: T) => {
    const family = modelVendorFamily(source);
    if (
      family === "llama" ||
      MODEL_PICKER_CURATION.excludedModels.test(
        `${canonicalModelId(source, family)} ${source.name.split("/").at(-1)}`,
      )
    )
      return false;
    if (isDeliberate(source)) return true;
    if (!isOwnHarness(source) && !isCuratedModel(source)) return false;
    if (isAliasCopy(source)) return false;
    return !isOld(source);
  };
  const isOld = (source: T) => {
    const generation = pickerGeneration(source);
    return (
      source.isLegacy ||
      oldPlanRoutes.has(routeKey(source)) ||
      modelMetadata.get(routeKey(source))?.isOld ||
      (generation !== null && oldGenerations.has(generation))
    );
  };
  const isAliasCopy = (source: T) =>
    aliasIds.has(routeKey(source)) && aliases.get(routeKey(source))?.slug !== source.slug;
  const starred = new Set(
    input.favorites?.map((ref) => routeKey(aliases.get(routeKey(ref)) ?? ref)),
  );
  const searchMatches = modelSearchMatcher(input.search ?? "");
  const visibleSources = sources.filter((source) => {
    if (selected.has(routeKey(source))) return true;
    // Frontier makers stay in their own harness even in search.
    if (nativeRoutingHides(source)) return false;
    if (curatedVisible(source)) return true;
    if (isAliasCopy(source)) return false;
    // A star on a model found by search keeps it listed, until a newer version replaces it.
    if (starred.has(routeKey(source)) && !isOld(source)) return true;
    return searchMatches !== null && searchMatches(source);
  });
  const groups = groupModelsByMaker(visibleSources);
  const allGroups = groupModelsByMaker(sources);
  const visibleByKey = new Map(
    groups.flatMap((group) => group.models.map((model) => [model.key, model] as const)),
  );
  const sourceByRef = new Map(sources.map((source) => [routeKey(source), source]));
  return {
    sources: visibleSources,
    groups,
    /** Keep stored favorites untouched; stars and picks resolve through the surviving native route. */
    resolveFavorite(ref: ModelRouteRef): ModelRouteRef | null {
      const canonicalRef = aliases.get(routeKey(ref)) ?? ref;
      const original = findMakerModel(allGroups, canonicalRef);
      const model = original ? visibleByKey.get(original.key) : undefined;
      if (!model) return null;
      const source = sourceByRef.get(routeKey(canonicalRef));
      const existing = model.routes.find((route) => modelRouteHasSlug(route, canonicalRef));
      if (existing && (!source || !nativeRoutingHides(source))) return canonicalRef;
      const native = model.routes.filter((route) => isOwnHarness(route.source));
      const route = defaultModelRoute({ ...model, routes: native });
      return route ? { instanceId: route.source.instanceId, slug: route.source.slug } : null;
    },
  };
}
