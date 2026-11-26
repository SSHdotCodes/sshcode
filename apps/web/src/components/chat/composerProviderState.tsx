import { withDefaultSelectOptions } from "@t3tools/shared/harnessDefaults";
import {
  type ModelCapabilities,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildExplicitProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import type { ReactNode } from "react";

import type { DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities, keepsUnavailableModelOptions } from "../../providerModels";
import type { ComposerControlSize } from "./ComposerControl";
import {
  describeReasoningLevel,
  getTraitsSectionVisibility,
  hasTraitsBesidesReasoning,
  TraitsMenuContent,
  TraitsPicker,
} from "./TraitsPicker";
import { ModelPickerReasoningColumn } from "./ModelPickerReasoningColumn";
import { getTriggerDisplayModelName } from "./providerIconUtils";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  promptInjectionState?: ComposerPromptInjectionState;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  planModeEnabled: boolean;
};

export type ComposerPromptInjectionState = "none" | "ultrathink";

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  onModelOptionsChange?: (options: ReadonlyArray<ProviderOptionSelection> | undefined) => void;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  planModeEnabled: boolean;
  size?: ComposerControlSize;
  hidden?: boolean;
  triggerClassName?: string;
  isComposerOwned?: boolean;
  /** The model picker's Reasoning column shows effort; the traits control leaves it out. */
  omitReasoning?: boolean;
  acpSection?: Parameters<typeof getTraitsSectionVisibility>[0]["acpSection"];
  acpMode?: Parameters<typeof getTraitsSectionVisibility>[0]["acpMode"];
};

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "none";
}

/**
 * Cursor ACP can report `fastMode: true` as the provider default. T3 only
 * treats Fast as selected when the user chose it (draft/sticky/settings).
 * Otherwise inject an explicit `false` so new chats stay Normal and the
 * send path can overwrite a prior Fast session — descriptor defaults are
 * otherwise omitted by `buildExplicitProviderOptionSelectionsFromDescriptors`.
 */
export function withImplicitFastModeDefault(
  caps: ModelCapabilities,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const hasExplicitFastMode = modelOptions?.some((selection) => selection.id === "fastMode");
  if (hasExplicitFastMode) {
    return modelOptions ?? undefined;
  }
  const hasFastModeDescriptor = caps.optionDescriptors?.some(
    (descriptor) => descriptor.type === "boolean" && descriptor.id === "fastMode",
  );
  if (!hasFastModeDescriptor) {
    return modelOptions ?? undefined;
  }
  return [...(modelOptions ?? []), { id: "fastMode", value: false }];
}

function resolveComposerOptionSelections(
  models: ReadonlyArray<ServerProviderModel>,
  model: string,
  provider: ProviderDriverKind,
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  planModeEnabled: boolean,
): {
  caps: ModelCapabilities;
  selections: ReadonlyArray<ProviderOptionSelection> | undefined;
} {
  const caps = getProviderModelCapabilities(models, model, provider, planModeEnabled);
  return { caps, selections: withImplicitFastModeDefault(caps, modelOptions) };
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const {
    provider,
    model,
    models,
    modelOptions,
    promptInjectionState = "none",
    planModeEnabled,
  } = input;
  if (keepsUnavailableModelOptions(provider, model)) {
    const normalizedModel = normalizeModelSlug(model, provider);
    const modelIsInCatalog = models.some((candidate) => candidate.slug === normalizedModel);
    if (!modelIsInCatalog) {
      const preservedOptions = modelOptions?.filter(
        (option) =>
          provider !== "opencode" ||
          planModeEnabled ||
          option.id !== "agent" ||
          option.value !== "plan",
      );
      return {
        provider,
        promptEffort: null,
        modelOptionsForDispatch:
          preservedOptions && preservedOptions.length > 0 ? preservedOptions : undefined,
      };
    }
  }
  const { caps, selections } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
    planModeEnabled,
  );
  const descriptors = getProviderOptionDescriptors({ caps, selections });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === "ultrathink";

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildExplicitProviderOptionSelectionsFromDescriptors(
      descriptors,
      withDefaultSelectOptions(descriptors, selections),
    ),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

function renderTraitsControl(
  Component: typeof TraitsMenuContent | typeof TraitsPicker,
  input: TraitsRenderInput,
): ReactNode {
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    reportedModelSelection,
    prompt,
    onPromptChange,
    planModeEnabled,
    size,
    hidden,
    triggerClassName,
    isComposerOwned,
    omitReasoning,
    acpSection,
    acpMode,
  } = input;
  const hasTarget =
    threadRef !== undefined || draftId !== undefined || input.onModelOptionsChange !== undefined;
  const { selections: resolvedModelOptions } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
    planModeEnabled,
  );
  const visibility = getTraitsSectionVisibility({
    provider,
    models,
    model,
    modelOptions: resolvedModelOptions,
    prompt,
    planModeEnabled,
    ...(acpSection ? { acpSection } : {}),
    ...(acpMode ? { acpMode } : {}),
  });
  if (
    !hasTarget ||
    !visibility.hasAnyControls ||
    (omitReasoning && !hasTraitsBesidesReasoning(visibility))
  ) {
    return null;
  }
  return (
    <Component
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      {...(input.onModelOptionsChange ? { onModelOptionsChange: input.onModelOptionsChange } : {})}
      model={model}
      modelOptions={resolvedModelOptions}
      reportedModelSelection={reportedModelSelection}
      prompt={prompt}
      onPromptChange={onPromptChange}
      planModeEnabled={planModeEnabled}
      {...(size !== undefined ? { size } : {})}
      {...(hidden !== undefined ? { hidden } : {})}
      {...(triggerClassName !== undefined ? { triggerClassName } : {})}
      {...(isComposerOwned ? { isComposerOwned } : {})}
      {...(omitReasoning ? { omitReasoning } : {})}
      {...(acpSection ? { acpSection } : {})}
      {...(acpMode ? { acpMode } : {})}
    />
  );
}

/** The model picker's Reasoning column for the composer's model, or null with no target. */
export function renderProviderReasoningColumn(
  input: TraitsRenderInput & { readonly onPicked?: () => void },
): ReactNode {
  const {
    provider,
    instanceId,
    threadRef,
    draftId,
    model,
    models,
    modelOptions,
    reportedModelSelection,
    prompt,
    onPromptChange,
    planModeEnabled,
    onPicked,
  } = input;
  if (threadRef === undefined && draftId === undefined && !input.onModelOptionsChange) return null;
  const { selections: resolvedModelOptions } = resolveComposerOptionSelections(
    models,
    model,
    provider,
    modelOptions,
    planModeEnabled,
  );
  const selectedModel = models.find((candidate) => candidate.slug === model);
  return (
    <ModelPickerReasoningColumn
      provider={provider}
      {...(instanceId ? { instanceId } : {})}
      models={models}
      {...(threadRef ? { threadRef } : {})}
      {...(draftId ? { draftId } : {})}
      {...(input.onModelOptionsChange ? { onModelOptionsChange: input.onModelOptionsChange } : {})}
      model={model}
      modelOptions={resolvedModelOptions}
      reportedModelSelection={reportedModelSelection}
      prompt={prompt}
      onPromptChange={onPromptChange}
      planModeEnabled={planModeEnabled}
      modelLabel={selectedModel ? getTriggerDisplayModelName(selectedModel) : model}
      {...(onPicked ? { onPicked } : {})}
    />
  );
}

/** The composer model's current effort for the picker trigger. */
export function providerEffortDisplay(input: TraitsRenderInput) {
  const { selections: resolvedModelOptions } = resolveComposerOptionSelections(
    input.models,
    input.model,
    input.provider,
    input.modelOptions,
    input.planModeEnabled,
  );
  return describeReasoningLevel({
    provider: input.provider,
    instanceId: input.instanceId,
    models: input.models,
    model: input.model,
    prompt: input.prompt,
    modelOptions: resolvedModelOptions,
    reportedModelSelection: input.reportedModelSelection,
    planModeEnabled: input.planModeEnabled,
  });
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsMenuContent, input);
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  return renderTraitsControl(TraitsPicker, input);
}
