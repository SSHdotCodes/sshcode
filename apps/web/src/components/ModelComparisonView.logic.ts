import type { ModelSelection, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { getAppModelOptionsForInstance } from "../modelSelection";
import { deriveProviderInstanceEntries } from "../providerInstances";
import { getComposerProviderState } from "./chat/composerProviderState";
import { resolveModelPickerSelectedModel } from "./chat/ModelPickerContent";
import { getTriggerDisplayModelName } from "./chat/providerIconUtils";
import { buildTraitsTriggerDisplay, getTraitsSectionVisibility } from "./chat/TraitsPicker";

/** Resolve the same instance-scoped model name and traits as the composer picker. */
export function comparisonModelPresentation(input: {
  provider: ServerProvider | undefined;
  selection: ModelSelection;
  settings: UnifiedSettings;
}) {
  const { provider, selection } = input;
  if (!provider || provider.instanceId !== selection.instanceId) {
    return { name: selection.model, traits: null };
  }
  const entry = deriveProviderInstanceEntries([provider])[0]!;
  const models = getAppModelOptionsForInstance(input.settings, entry, selection.model);
  const model = models.some((option) => option.slug === selection.model)
    ? selection.model
    : (normalizeModelSlug(selection.model, provider.driver) ?? selection.model);
  const named =
    resolveModelPickerSelectedModel({
      driverKind: provider.driver,
      model,
      options: models,
    }) ??
    resolveModelPickerSelectedModel({
      driverKind: provider.driver,
      model,
      options: provider.models,
    });
  const planModeEnabled = input.settings.planModeEnabled;
  const state = getComposerProviderState({
    provider: provider.driver,
    model,
    models: provider.models,
    modelOptions: selection.options,
    planModeEnabled,
  });
  const traits = getTraitsSectionVisibility({
    provider: provider.driver,
    model,
    models: provider.models,
    prompt: "",
    modelOptions: state.modelOptionsForDispatch,
    allowPromptInjectedEffort: false,
    planModeEnabled,
  });
  return {
    name: (named && getTriggerDisplayModelName(named).trim()) || selection.model,
    traits: traits.hasAnyControls
      ? buildTraitsTriggerDisplay({
          provider: provider.driver,
          descriptors: traits.descriptors,
          primarySelectDescriptorId: traits.primarySelectDescriptor?.id ?? null,
          ultrathinkPromptControlled: false,
          modelSelection: selection,
        })
      : null,
  };
}
