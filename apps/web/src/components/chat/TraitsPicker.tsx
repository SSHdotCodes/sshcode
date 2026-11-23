import {
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  applyClaudePromptEffortPrefix,
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
  isReasoningSelectDescriptor,
  normalizeModelSlug,
} from "@t3tools/shared/model";
import { memo, useCallback } from "react";
import { BrainIcon } from "lucide-react";
import {
  Menu,
  MenuGroup,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities, keepsUnavailableModelOptions } from "../../providerModels";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ComposerControl,
  ComposerControlChevron,
  ComposerControlIcon,
  type ComposerControlSize,
} from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { TraitsSpeedBolt } from "./TraitsSpeed";
import { useComposerMenuState } from "./useComposerMenuState";

type ProviderOptions = ReadonlyArray<ProviderOptionSelection>;

const SAVED_OPTION_LABELS: Readonly<Record<string, string>> = {
  agent: "Agent",
  effort: "Effort",
  reasoningEffort: "Reasoning effort",
  variant: "Reasoning",
};

function savedOptionLabel(id: string): string {
  return (
    SAVED_OPTION_LABELS[id] ??
    id.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (character) => character.toUpperCase())
  );
}

/** Read-only descriptors for saved values whose OpenCode model metadata is unavailable. */
export function buildUnavailableModelOptionDescriptors(
  selections: ProviderOptions | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return (selections ?? []).map((selection) =>
    typeof selection.value === "boolean"
      ? {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "boolean" as const,
          currentValue: selection.value,
        }
      : {
          id: selection.id,
          label: savedOptionLabel(selection.id),
          type: "select" as const,
          options: [{ id: selection.value, label: selection.value }],
          currentValue: selection.value,
        },
  );
}

export interface TraitsPersistence {
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  onModelOptionsChange?: (nextOptions: ProviderOptions | undefined) => void;
}

const ULTRATHINK_PROMPT_PREFIX = "Ultrathink:\n";

function DefaultBadge() {
  return (
    <Badge variant="outline" size="sm" className="min-w-0">
      Default
    </Badge>
  );
}

function replaceDescriptorCurrentValue(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  descriptorId: string,
  currentValue: string | boolean | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  return descriptors.map((descriptor) =>
    descriptor.id !== descriptorId
      ? descriptor
      : descriptor.type === "boolean"
        ? {
            ...descriptor,
            ...(typeof currentValue === "boolean" ? { currentValue } : {}),
          }
        : {
            ...descriptor,
            ...(typeof currentValue === "string" ? { currentValue } : {}),
          },
  );
}

function getDescriptorStringValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }> | null,
  selection?: ModelSelection | null,
  reportedSelection?: ModelSelection | null,
): string | null {
  if (!descriptor) {
    return null;
  }
  const value = getProviderOptionCurrentValue(descriptor, selection, reportedSelection);
  return typeof value === "string" ? value : null;
}

function getSelectedTraits(
  provider: ProviderDriverKind,
  models: ReadonlyArray<ServerProviderModel>,
  model: string | null | undefined,
  prompt: string,
  modelOptions: ProviderOptions | null | undefined,
  allowPromptInjectedEffort: boolean,
  planModeEnabled: boolean,
) {
  const caps = getProviderModelCapabilities(models, model, provider, planModeEnabled);
  const modelIsUnavailable =
    keepsUnavailableModelOptions(provider, model) &&
    !models.some((candidate) => candidate.slug === normalizeModelSlug(model, provider));
  const descriptors = modelIsUnavailable
    ? buildUnavailableModelOptionDescriptors(
        provider !== "opencode" || planModeEnabled
          ? modelOptions
          : modelOptions?.filter((option) => option.id !== "agent" || option.value !== "plan"),
      )
    : getProviderOptionDescriptors({
        caps,
        selections: modelOptions,
      });
  const selectDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "select" }> =>
      descriptor.type === "select",
  );
  const booleanDescriptors = descriptors.filter(
    (descriptor): descriptor is Extract<ProviderOptionDescriptor, { type: "boolean" }> =>
      descriptor.type === "boolean",
  );
  const primarySelectDescriptor = selectDescriptors[0] ?? null;
  const contextWindowDescriptor =
    selectDescriptors.find((descriptor) => descriptor.id === "contextWindow") ?? null;
  const agentDescriptor = selectDescriptors.find((descriptor) => descriptor.id === "agent") ?? null;
  const fastModeDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "fastMode") ?? null;
  const thinkingDescriptor =
    booleanDescriptors.find((descriptor) => descriptor.id === "thinking") ?? null;

  // Prompt-controlled effort (e.g. ultrathink in prompt text)
  const ultrathinkPromptControlled =
    allowPromptInjectedEffort &&
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    isClaudeUltrathinkPrompt(prompt);

  // Check if "ultrathink" appears in the body text (not just our prefix)
  const ultrathinkInBodyText =
    ultrathinkPromptControlled && isClaudeUltrathinkPrompt(prompt.replace(/^Ultrathink:\s*/i, ""));
  const effort =
    (ultrathinkPromptControlled
      ? "ultrathink"
      : getDescriptorStringValue(primarySelectDescriptor)) ?? null;
  const thinkingEnabled =
    typeof thinkingDescriptor?.currentValue === "boolean" ? thinkingDescriptor.currentValue : null;
  const contextWindow = getDescriptorStringValue(contextWindowDescriptor);
  const selectedAgent = getDescriptorStringValue(agentDescriptor);
  const selectedAgentLabel = agentDescriptor
    ? getProviderOptionCurrentLabel(agentDescriptor)
    : null;

  return {
    caps,
    descriptors,
    selectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    contextWindowDescriptor,
    agentDescriptor,
    fastModeDescriptor,
    thinkingDescriptor,
    effort,
    thinkingEnabled,
    contextWindow,
    ultrathinkPromptControlled,
    ultrathinkInBodyText,
    selectedAgent,
    selectedAgentLabel,
    modelIsUnavailable,
  };
}

export function getTraitsSectionVisibility(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
}) {
  const selected = getSelectedTraits(
    input.provider,
    input.models,
    input.model,
    input.prompt,
    input.modelOptions,
    input.allowPromptInjectedEffort ?? true,
    input.planModeEnabled,
  );

  const showEffort = selected.primarySelectDescriptor !== null;
  const showThinking = selected.thinkingDescriptor !== null;
  const showFastMode = selected.fastModeDescriptor !== null;
  const showContextWindow = selected.contextWindowDescriptor !== null;
  const showAgent = selected.agentDescriptor !== null;

  return {
    ...selected,
    showEffort,
    showThinking,
    showFastMode,
    showContextWindow,
    showAgent,
    hasAnyControls:
      showEffort ||
      showThinking ||
      showFastMode ||
      showContextWindow ||
      showAgent ||
      (selected.modelIsUnavailable && selected.descriptors.length > 0),
  };
}

export function shouldRenderTraitsControls(input: {
  provider: ProviderDriverKind;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
}): boolean {
  return getTraitsSectionVisibility(input).hasAnyControls;
}

export interface TraitsMenuContentProps {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  modelOptions?: ProviderOptions | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  allowPromptInjectedEffort?: boolean;
  planModeEnabled: boolean;
  triggerClassName?: string;
  isComposerOwned?: boolean;
  /** The model picker's Reasoning column shows effort, so this control leaves it out. */
  omitReasoning?: boolean;
}

/**
 * The traits state and the handlers that change it, shared by the traits menu and the model
 * picker's Reasoning column so both persist choices the same way.
 */
export function useTraitsSelection({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  reportedModelSelection,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  ...persistence
}: Omit<TraitsMenuContentProps, "triggerClassName" | "isComposerOwned" | "omitReasoning"> &
  TraitsPersistence) {
  const modelSelection =
    instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const onModelOptionsChange = persistence.onModelOptionsChange;
  const threadTarget = persistence.threadRef ?? persistence.draftId;
  const updateModelOptions = useCallback(
    (nextOptions: ProviderOptions | undefined) => {
      if (onModelOptionsChange) {
        onModelOptionsChange(nextOptions);
        return;
      }
      if (!threadTarget) {
        return;
      }
      setProviderModelOptions(threadTarget, provider, nextOptions, {
        ...(instanceId ? { instanceId } : {}),
        model,
        persistSticky: true,
      });
    },
    [instanceId, model, onModelOptionsChange, provider, setProviderModelOptions, threadTarget],
  );
  const visibility = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
    planModeEnabled,
  });
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled, ultrathinkInBodyText } =
    visibility;
  // Always rebuild from every descriptor, so changing one option keeps the others.
  const updateDescriptors = (nextDescriptors: ReadonlyArray<ProviderOptionDescriptor>) => {
    updateModelOptions(buildProviderOptionSelectionsFromDescriptors(nextDescriptors));
  };
  const handleSelectChange = (
    descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
    value: string,
  ) => {
    if (!value) return;
    if (descriptor.promptInjectedValues?.includes(value)) {
      const nextPrompt =
        prompt.trim().length === 0
          ? ULTRATHINK_PROMPT_PREFIX
          : applyClaudePromptEffortPrefix(prompt, "ultrathink");
      onPromptChange(nextPrompt);
      return;
    }
    if (ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id) return;
    if (ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id) {
      const stripped = prompt.replace(/^Ultrathink:\s*/i, "");
      onPromptChange(stripped);
    }
    updateDescriptors(replaceDescriptorCurrentValue(descriptors, descriptor.id, value));
  };
  const selectValue = (descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>) =>
    ultrathinkPromptControlled && descriptor.id === primarySelectDescriptor?.id
      ? "ultrathink"
      : (getDescriptorStringValue(descriptor, modelSelection, reportedModelSelection) ?? "");
  return { ...visibility, modelSelection, updateDescriptors, handleSelectChange, selectValue };
}

/** The reasoning level's name for the model picker trigger, such as "High" or "Ultrathink". */
export function describeReasoningLevel(input: {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId | undefined;
  models: ReadonlyArray<ServerProviderModel>;
  model: string | null | undefined;
  prompt: string;
  modelOptions: ProviderOptions | null | undefined;
  reportedModelSelection?: ModelSelection | null | undefined;
  planModeEnabled: boolean;
}): string | null {
  const visibility = getTraitsSectionVisibility(input);
  const descriptor = visibility.selectDescriptors.find(isReasoningSelectDescriptor);
  if (!descriptor || visibility.modelIsUnavailable) return null;
  if (
    visibility.ultrathinkPromptControlled &&
    descriptor.id === visibility.primarySelectDescriptor?.id
  ) {
    return "Ultrathink";
  }
  const modelSelection =
    input.instanceId && input.model
      ? { instanceId: input.instanceId, model: input.model, options: input.modelOptions ?? [] }
      : null;
  const label = getProviderOptionCurrentLabel(
    descriptor,
    modelSelection,
    input.reportedModelSelection,
  );
  return typeof label === "string" && label.length > 0 ? label : null;
}

/** Whether the traits control has anything to show once the Reasoning column takes effort. */
export function hasTraitsBesidesReasoning(visibility: {
  readonly selectDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly booleanDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly modelIsUnavailable: boolean;
}): boolean {
  if (visibility.modelIsUnavailable) return false;
  return (
    visibility.booleanDescriptors.length > 0 ||
    visibility.selectDescriptors.some((descriptor) => !isReasoningSelectDescriptor(descriptor))
  );
}

export const TraitsMenuContent = memo(function TraitsMenuContentImpl({
  triggerClassName: _triggerClassName,
  isComposerOwned: _isComposerOwned,
  omitReasoning = false,
  ...input
}: TraitsMenuContentProps & TraitsPersistence) {
  const {
    descriptors,
    selectDescriptors: allSelectDescriptors,
    booleanDescriptors,
    primarySelectDescriptor,
    ultrathinkInBodyText,
    hasAnyControls,
    modelIsUnavailable,
    modelSelection,
    updateDescriptors,
    handleSelectChange,
    selectValue,
  } = useTraitsSelection(input);
  const { reportedModelSelection } = input;
  const selectDescriptors = omitReasoning
    ? allSelectDescriptors.filter((descriptor) => !isReasoningSelectDescriptor(descriptor))
    : allSelectDescriptors;

  if (
    !hasAnyControls ||
    (omitReasoning &&
      !hasTraitsBesidesReasoning({
        selectDescriptors: allSelectDescriptors,
        booleanDescriptors,
        modelIsUnavailable,
      }))
  ) {
    return null;
  }

  if (modelIsUnavailable) {
    return (
      <>
        {descriptors.map((descriptor, index) => {
          const value = getProviderOptionCurrentLabel(
            descriptor,
            modelSelection,
            reportedModelSelection,
          );
          if (!value) return null;
          return (
            <div key={descriptor.id}>
              {index > 0 ? <MenuDivider /> : null}
              <MenuGroup>
                <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                  {descriptor.label}
                </div>
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">{value}</div>
              </MenuGroup>
            </div>
          );
        })}
      </>
    );
  }

  return (
    <>
      {selectDescriptors.map((descriptor, index) => {
        const selectedValue = selectValue(descriptor);

        return (
          <div key={descriptor.id}>
            {index > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 pt-1.5 pb-1 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              {ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id ? (
                <div className="px-2 pb-1.5 text-muted-foreground/80 text-xs">
                  Your prompt contains &quot;ultrathink&quot; in the text. Remove it to change this
                  option.
                </div>
              ) : null}
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => handleSelectChange(descriptor, value)}
              >
                {descriptor.options.map((option) => (
                  <MenuRadioItem
                    key={option.id}
                    value={option.id}
                    hideIndicator
                    // Base UI keeps radio menus open by default. Close on pick so
                    // the traits menu behaves like the model picker.
                    closeOnClick
                    disabled={ultrathinkInBodyText && descriptor.id === primarySelectDescriptor?.id}
                  >
                    <span className="flex w-full min-w-0 flex-col">
                      <span className="flex w-full min-w-0 items-center justify-between gap-3">
                        <span className="min-w-0 truncate">
                          {option.label}
                          {option.isDefault ? (
                            <>
                              {" "}
                              <DefaultBadge />
                            </>
                          ) : null}
                        </span>
                      </span>
                      {option.description ? (
                        <span className="max-w-56 text-pretty text-muted-foreground/80 text-xs">
                          {option.description}
                        </span>
                      ) : null}
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
      {booleanDescriptors.map((descriptor, index) => {
        const selectedValue = descriptor.currentValue === true ? "on" : "off";

        return (
          <div key={descriptor.id}>
            {index > 0 || selectDescriptors.length > 0 ? <MenuDivider /> : null}
            <MenuGroup>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
                {descriptor.label}
              </div>
              <MenuRadioGroup
                value={selectedValue}
                onValueChange={(value) => {
                  updateDescriptors(
                    replaceDescriptorCurrentValue(descriptors, descriptor.id, value === "on"),
                  );
                }}
              >
                {(["on", "off"] as const).map((value) => (
                  <MenuRadioItem key={value} value={value} hideIndicator closeOnClick>
                    <span className="flex w-full min-w-0 items-center justify-between gap-3">
                      <span>{value === "on" ? "On" : "Off"}</span>
                    </span>
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </div>
        );
      })}
    </>
  );
});

export interface TraitsTriggerDisplay {
  /** Full text for the visible traits, with speed spelled out instead of a bolt. */
  label: string;
  /** Fast or Ultrafast, which the trigger draws as a bolt instead of the word. */
  speedIcon: "fast" | "ultrafast" | null;
  /** Visible text on either side of the bolt; `beforeSpeed` is the whole label without one. */
  beforeSpeed: string;
  afterSpeed: string;
}

function textTraitsTriggerDisplay(label: string): TraitsTriggerDisplay {
  return { label, speedIcon: null, beforeSpeed: label, afterSpeed: "" };
}

/** Pair speed with reasoning while keeping other traits separated. */
export function buildTraitsTriggerDisplay(input: {
  provider: ProviderDriverKind;
  descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  primarySelectDescriptorId: string | null;
  ultrathinkPromptControlled: boolean;
  modelSelection?: ModelSelection | null;
  reportedModelSelection?: ModelSelection | null | undefined;
}): TraitsTriggerDisplay {
  let fastModeFallbackLabel: string | null = null;
  let speedLabel: string | null = null;
  let reasoningLabelIndex = -1;
  const labels: Array<string> = [];
  for (const descriptor of input.descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      speedLabel = descriptor.currentValue === true ? "Fast" : null;
      fastModeFallbackLabel = speedLabel ?? "Normal";
      continue;
    }
    if (
      input.provider === "codex" &&
      descriptor.id === "serviceTier" &&
      descriptor.type === "select"
    ) {
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      const ultrafastTier = descriptor.options.find(({ label }) => label === "Ultrafast");
      if (
        ((fastTier || ultrafastTier) && currentValue === "default") ||
        (fastTier && currentValue === fastTier.id) ||
        (ultrafastTier && currentValue === ultrafastTier.id)
      ) {
        speedLabel =
          ultrafastTier && currentValue === ultrafastTier.id
            ? "Ultrafast"
            : fastTier && currentValue === fastTier.id
              ? "Fast"
              : null;
        fastModeFallbackLabel =
          descriptor.options.find(({ id }) => id === currentValue)?.label ?? "Normal";
        continue;
      }
    }
    const label =
      input.ultrathinkPromptControlled && descriptor.id === input.primarySelectDescriptorId
        ? "Ultrathink"
        : descriptor.type === "boolean"
          ? descriptor.currentValue === true
            ? `${descriptor.label} On`
            : null
          : getProviderOptionCurrentLabel(
              descriptor,
              input.modelSelection,
              input.reportedModelSelection,
            );
    if (typeof label === "string" && label.length > 0) {
      // Custom models retain descriptor order, so the primary select can be context.
      if (
        reasoningLabelIndex === -1 &&
        descriptor.type === "select" &&
        isReasoningSelectDescriptor(descriptor)
      ) {
        reasoningLabelIndex = labels.length;
      }
      labels.push(label);
    }
  }

  // Only fall back to text when fast mode is genuinely the sole trait. Keying
  // off an empty label list alone would also catch descriptors that resolved to
  // no label at all, printing a bogus "Normal" for a model without fast mode.
  const speedIcon =
    speedLabel === "Ultrafast" ? "ultrafast" : speedLabel === "Fast" ? "fast" : null;
  if (labels.length === 0 && fastModeFallbackLabel !== null) {
    return speedIcon
      ? { label: fastModeFallbackLabel, speedIcon, beforeSpeed: "", afterSpeed: "" }
      : textTraitsTriggerDisplay(fastModeFallbackLabel);
  }
  if (!speedLabel || !speedIcon) return textTraitsTriggerDisplay(labels.join(" · "));
  if (reasoningLabelIndex >= 0) {
    const beforeSpeed = labels.slice(0, reasoningLabelIndex + 1).join(" · ");
    const after = labels.slice(reasoningLabelIndex + 1);
    labels[reasoningLabelIndex] = `${labels[reasoningLabelIndex]} ${speedLabel}`;
    return {
      label: labels.join(" · "),
      speedIcon,
      beforeSpeed,
      afterSpeed: after.length > 0 ? ` · ${after.join(" · ")}` : "",
    };
  }
  return {
    label: [...labels, speedLabel].join(" · "),
    speedIcon,
    beforeSpeed: `${labels.join(" · ")} ·`,
    afterSpeed: "",
  };
}

/**
 * What the trigger says when no trait has a label of its own. A lone switch that
 * is off names itself ("Contributor mode Off"), so the control never reads as an
 * unexplained "Traits".
 */
export function traitsEmptyTriggerLabel(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): string {
  const off = descriptors.filter(
    (descriptor) => descriptor.type === "boolean" && descriptor.currentValue !== true,
  );
  return off.length === 1 && descriptors.length === 1 ? `${off[0]!.label} Off` : "Traits";
}

/** Disabled toggles stay discoverable without crowding the visible trigger. */
export function buildTraitsAccessibleLabel(
  label: string,
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): string {
  return [
    label,
    ...descriptors.flatMap((descriptor) =>
      descriptor.type === "boolean" && descriptor.currentValue !== true
        ? [`${descriptor.label} Off`]
        : [],
    ),
  ]
    .filter(Boolean)
    .join(" · ");
}

export const TraitsPicker = memo(function TraitsPicker({
  provider,
  instanceId,
  models,
  model,
  prompt,
  onPromptChange,
  modelOptions,
  reportedModelSelection,
  allowPromptInjectedEffort = true,
  planModeEnabled,
  triggerClassName,
  isComposerOwned,
  omitReasoning = false,
  size = "sm",
  hidden = false,
  disabled = false,
  ...persistence
}: TraitsMenuContentProps &
  TraitsPersistence & {
    size?: ComposerControlSize;
    hidden?: boolean;
    disabled?: boolean;
  }) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const [isMenuOpen, setIsMenuOpen] = useComposerMenuState(hidden || disabled);
  const visibility = getTraitsSectionVisibility({
    provider,
    models,
    model,
    prompt,
    modelOptions,
    allowPromptInjectedEffort,
    planModeEnabled,
  });
  const { descriptors, primarySelectDescriptor, ultrathinkPromptControlled } = visibility;
  if (!visibility.hasAnyControls || (omitReasoning && !hasTraitsBesidesReasoning(visibility))) {
    return null;
  }

  // The model picker names the effort when its Reasoning column has it.
  const triggerDescriptors = omitReasoning
    ? descriptors.filter((descriptor) => !isReasoningSelectDescriptor(descriptor))
    : descriptors;
  const triggerDisplay = buildTraitsTriggerDisplay({
    provider,
    descriptors: triggerDescriptors,
    primarySelectDescriptorId: primarySelectDescriptor?.id ?? null,
    ultrathinkPromptControlled,
    modelSelection: instanceId && model ? { instanceId, model, options: modelOptions ?? [] } : null,
    reportedModelSelection,
  });
  const triggerLabel = buildTraitsAccessibleLabel(triggerDisplay.label, descriptors) || "Traits";
  const visibleTriggerLabel = triggerDisplay.speedIcon ? (
    <>
      {triggerDisplay.beforeSpeed}
      <TraitsSpeedBolt
        provider={provider}
        speedIcon={triggerDisplay.speedIcon}
        size={size}
        spaced={triggerDisplay.beforeSpeed.length > 0}
      />
      {triggerDisplay.afterSpeed}
    </>
  ) : (
    triggerDisplay.label || traitsEmptyTriggerLabel(triggerDescriptors)
  );
  const isCodexStyle = provider === "codex";

  return (
    <Menu
      open={isMenuOpen}
      onOpenChange={(open) => {
        setIsMenuOpen(open && !disabled);
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  disabled={disabled}
                  aria-label={triggerLabel}
                  data-composer-shortcut={
                    isComposerOwned && !omitReasoning ? "composer.effort" : undefined
                  }
                  size={size}
                  className={cn(
                    isCodexStyle
                      ? "min-w-0 max-w-40 shrink justify-start overflow-hidden whitespace-nowrap sm:max-w-48"
                      : "shrink-0 whitespace-nowrap",
                    triggerClassName,
                  )}
                />
              }
            />
          }
        >
          {isCodexStyle ? (
            // The label truncates itself; clipping the wrapper too would cut off
            // the chevron, whose negative end margin overhangs the wrapper edge.
            <span
              className={cn(
                "flex min-w-0 w-full items-center",
                size === "xs" ? "gap-1" : "gap-1.5",
              )}
            >
              <ComposerControlIcon icon={BrainIcon} size={size} />
              <span data-composer-control-label className="min-w-0 truncate">
                {visibleTriggerLabel}
              </span>
              <ComposerControlChevron size={size} />
            </span>
          ) : (
            <>
              <ComposerControlIcon icon={BrainIcon} size={size} />
              <span data-composer-control-label>{visibleTriggerLabel}</span>
              <ComposerControlChevron size={size} />
            </>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{triggerLabel}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...(isComposerOwned ? composerFloatingLayerProps : {})}>
        <TraitsMenuContent
          provider={provider}
          {...(instanceId ? { instanceId } : {})}
          models={models}
          model={model}
          prompt={prompt}
          onPromptChange={onPromptChange}
          modelOptions={modelOptions}
          reportedModelSelection={reportedModelSelection}
          allowPromptInjectedEffort={allowPromptInjectedEffort}
          planModeEnabled={planModeEnabled}
          omitReasoning={omitReasoning}
          {...persistence}
        />
      </MenuPopup>
    </Menu>
  );
});
