import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { parseModelRef } from "@t3tools/shared/modelRefs";
import type { ProviderInstanceId } from "@t3tools/contracts";

/** Current-model controls lead browsing; an active search leads with its results. */
export function threadSettingsListItems<T>(catalogItems: ReadonlyArray<T>, searchQuery: string) {
  return [
    ...(searchQuery.trim().length === 0 ? ([{ kind: "options", key: "options" }] as const) : []),
    ...catalogItems,
    { kind: "catalogSettings", key: "catalogSettings" } as const,
  ];
}

export function modelFavoriteKey(provider: ProviderInstanceId, model: string): string {
  return `${provider}:${model}`;
}

/** Keep catalog order within each group when favorites move to the front. */
export function favoritesFirst(
  models: ReadonlyArray<ModelOption>,
  favoriteKeys: ReadonlySet<string>,
): ReadonlyArray<ModelOption> {
  const favorites: ModelOption[] = [];
  const others: ModelOption[] = [];
  for (const model of models) {
    (favoriteKeys.has(model.key) ? favorites : others).push(model);
  }
  return [...favorites, ...others];
}

/** Match the terms a user can actually see or recognize in the model picker. */
export function modelMatchesCatalogQuery(input: {
  readonly model: ModelOption;
  readonly providerLabel: string;
  readonly query: string;
}): boolean {
  // A pasted OpenRouter or Hugging Face page searches by the model id it names.
  const ref = parseModelRef(input.query);
  const query = (ref !== null && ref.source !== "id" ? ref.id : input.query)
    .trim()
    .toLocaleLowerCase();
  if (query.length === 0) {
    return true;
  }

  // Every typed word must appear somewhere: "glm 5.3 flash" finds GLM-5.3-Flash.
  const text = [
    input.model.label,
    input.model.subtitle,
    input.model.selection.model,
    input.providerLabel,
  ]
    .join(" ")
    .toLocaleLowerCase();
  const spaced = text.replace(/[/_:,-]+/g, " ");
  const compact = text.replace(/[^a-z0-9.]/g, "");
  return query
    .split(/[\s/_:,-]+/)
    .filter((word) => word.length > 0)
    .every((word) => spaced.includes(word) || compact.includes(word));
}

/** Preserve staged provider options when the highlighted model is tapped again. */
export function pendingModelAfterPress(input: {
  readonly current: ModelOption | null;
  readonly pressed: ModelOption;
  readonly pressedIsApplied: boolean;
}): ModelOption | null {
  if (input.pressedIsApplied) {
    return null;
  }
  return input.current?.key === input.pressed.key ? input.current : input.pressed;
}

/** A model can disappear while the picker is open. */
export function canCommitPendingModel(
  pending: ModelOption,
  groups: ReadonlyArray<ProviderGroup>,
): boolean {
  return groups.some((group) =>
    group.models.some(
      (model) => model.key === pending.key && !model.isUnavailable && !model.isHidden,
    ),
  );
}

/**
 * Primary and selected providers start open; all other catalogs start closed.
 * A user's disclosure tap inverts that default until the picker is dismissed.
 */
export function providerSectionIsCollapsed(input: {
  readonly defaultExpanded: boolean;
  readonly hasExpansionOverride: boolean;
  readonly isNarrowed: boolean;
}): boolean {
  if (input.isNarrowed) {
    return false;
  }
  return input.defaultExpanded ? input.hasExpansionOverride : !input.hasExpansionOverride;
}
