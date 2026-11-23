import {
  createModelPickerCatalog,
  type ModelPickerCatalogInput,
} from "@t3tools/client-runtime/model-picker-catalog";
import { modelFamilySupersessions, modelRankingSelectionKey } from "@t3tools/shared/modelRankings";
import { rankComposerModelMentions } from "@t3tools/client-runtime/composerModelMentions";
import type { ServerSettings, ProviderInstanceId } from "@t3tools/contracts";

import { isProviderInstancePickerReady, type ProviderInstanceEntry } from "../../providerInstances";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { getDisplayModelName, type ModelEsque } from "./providerIconUtils";

type ComposerModelItem = Extract<ComposerCommandItem, { type: "model" }>;

type ComposerModelMentionProvider = Pick<
  ProviderInstanceEntry,
  | "instanceId"
  | "driverKind"
  | "displayName"
  | "acpRegistryAgentId"
  | "acpRegistryIconUrl"
  | "enabled"
  | "isAvailable"
  | "status"
  | "snapshot"
>;

export function matchComposerModelItems(input: {
  readonly instanceEntries: ReadonlyArray<ComposerModelMentionProvider>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  readonly query: string;
  readonly modelPreferences?: ServerSettings["providerModelPreferences"];
  readonly catalogInput?: Omit<ModelPickerCatalogInput, "providers" | "selected" | "search">;
}): ComposerModelItem[] {
  if (!input.query.trim()) return [];
  const superseded = modelFamilySupersessions(input.instanceEntries.map((entry) => entry.snapshot));
  const candidates: Array<{ entry: ComposerModelMentionProvider; option: ModelEsque }> = [];
  for (const entry of input.instanceEntries) {
    if (!isProviderInstancePickerReady(entry)) continue;
    const options = input.modelOptionsByInstance.get(entry.instanceId) ?? [];
    for (const option of options) {
      // The picker hides legacy models by default; skip them so they don't fill the result cap.
      if (
        input.modelPreferences?.[entry.instanceId]?.hiddenModels?.includes(option.slug) ||
        option.isLegacy ||
        option.isUnavailable ||
        superseded.has(
          modelRankingSelectionKey({ instanceId: entry.instanceId, model: option.slug }),
        ) ||
        option.supersededBy
      )
        continue;
      candidates.push({ entry, option });
    }
  }

  const catalog = createModelPickerCatalog(
    candidates.map(({ entry, option }) => ({
      instanceId: entry.instanceId,
      driver: entry.driverKind,
      instanceName: entry.displayName,
      slug: option.slug,
      name: option.name,
      subProvider: option.subProvider,
      family: entry.snapshot.models.find((model) => model.slug === option.slug)?.family,
      isLegacy: option.isLegacy,
      entry,
      option,
    })),
    { ...input.catalogInput, providers: input.instanceEntries.map((entry) => entry.snapshot) },
  );
  const favorites = new Map(
    (input.catalogInput?.favorites ?? []).map((ref, index) => {
      const resolved = catalog.resolveFavorite(ref) ?? ref;
      return [JSON.stringify([resolved.instanceId, resolved.slug]), index];
    }),
  );
  const ordered = [...catalog.sources].sort(
    (a, b) =>
      (favorites.get(JSON.stringify([a.instanceId, a.slug])) ?? Infinity) -
      (favorites.get(JSON.stringify([b.instanceId, b.slug])) ?? Infinity),
  );
  return rankComposerModelMentions(ordered, input.query, ({ entry, option }) => ({
    name: option.name,
    ...(option.shortName ? { shortName: option.shortName } : {}),
    ...(option.subProvider ? { subProvider: option.subProvider } : {}),
    driverKind: entry.driverKind,
    providerDisplayName: entry.displayName,
  })).map(({ entry, option }) => ({
    id: `model:${entry.instanceId}:${option.slug}`,
    type: "model",
    instanceId: entry.instanceId,
    model: option.slug,
    driverKind: entry.driverKind,
    providerDisplayName: entry.displayName,
    acpRegistryAgentId: entry.acpRegistryAgentId,
    acpRegistryIconUrl: entry.acpRegistryIconUrl,
    label: getDisplayModelName(option),
    description: entry.displayName,
  }));
}
