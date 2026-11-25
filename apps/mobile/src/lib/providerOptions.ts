import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import { effortDisplay } from "@t3tools/client-runtime/composer-model-display";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionCurrentLabel,
  isClaudeUltrathinkPrompt,
  isReasoningSelectDescriptor,
} from "@t3tools/shared/model";

export function resolveProviderOptionDescriptors(input: {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  if (!input.capabilities) {
    return [];
  }
  return getProviderOptionDescriptors({
    caps: input.capabilities,
    // Match web: Fast is opt-in even when a harness advertises it as its default.
    selections: input.selections?.some((selection) => selection.id === "fastMode")
      ? input.selections
      : [...(input.selections ?? []), { id: "fastMode", value: false }],
  });
}

/** Native Fast controls retain the provider's wire values, including Ultrafast. */
export function fastModeControl(descriptor: ProviderOptionDescriptor) {
  if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
    return {
      enabled: descriptor.currentValue === true,
      onValue: true,
      offValue: false,
      choices: null,
      label: descriptor.currentValue === true ? "Fast" : "Off",
      switchLabel: "Fast",
    };
  }
  if (descriptor.id === "speed" && descriptor.type === "select") {
    // An ACP agent's Speed (Devin): "fast", which Devin's SWE models call Lightning.
    const on = descriptor.options.find((choice) => choice.id === "fast");
    const off = descriptor.options.find((choice) => choice.id === "standard");
    if (!on || !off) return null;
    const enabled = getProviderOptionCurrentValue(descriptor) === on.id;
    return {
      enabled,
      onValue: on.id,
      offValue: off.id,
      choices: null,
      label: enabled ? on.label : "Off",
      switchLabel: on.label,
    };
  }
  if (descriptor.id !== "serviceTier" || descriptor.type !== "select") return null;
  const fast = descriptor.options.find((choice) => choice.label === "Fast");
  const ultrafast = descriptor.options.find((choice) => choice.label === "Ultrafast");
  const off = descriptor.options.find((choice) => choice.id === "default");
  const on = fast ?? ultrafast;
  if (!on || !off) return null;
  const value = getProviderOptionCurrentValue(descriptor);
  const choices = descriptor.options.map((choice) => ({
    ...choice,
    label: choice.id === off.id ? "Off" : choice.label,
  }));
  return {
    enabled:
      (fast !== undefined && value === fast.id) ||
      (ultrafast !== undefined && value === ultrafast.id),
    onValue: on.id,
    offValue: off.id,
    choices: choices.length > 2 ? choices : null,
    label: choices.find((choice) => choice.id === value)?.label ?? "Off",
    switchLabel: "Fast",
  };
}

/** One interpretation of effort and speed for composers and read-only model summaries. */
type ModelTraitInput = {
  readonly capabilities: ModelCapabilities | null | undefined;
  readonly selection: ModelSelection | null;
  readonly reportedSelection?: ModelSelection | null | undefined;
};

function modelTraitDescriptors(input: ModelTraitInput) {
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: input.capabilities,
    selections: input.selection?.options,
  });
  const effort = descriptors.find(isReasoningSelectDescriptor);
  const speed = descriptors.map(fastModeControl).find((control) => control?.enabled);
  return { effort, speed: speed?.label ?? null };
}

export function modelTraits(input: ModelTraitInput) {
  const { effort, speed } = modelTraitDescriptors(input);
  return {
    effort: effort
      ? getProviderOptionCurrentLabel(effort, input.selection, input.reportedSelection)
      : undefined,
    speed,
  };
}

export function composerModelTraits(input: ModelTraitInput & { prompt?: string | undefined }) {
  const { effort, speed } = modelTraitDescriptors(input);
  const promptMode =
    effort?.promptInjectedValues?.includes("ultrathink") && isClaudeUltrathinkPrompt(input.prompt);
  return {
    effort: effort
      ? effortDisplay(
          effort.options,
          promptMode
            ? "ultrathink"
            : getProviderOptionCurrentValue(effort, input.selection, input.reportedSelection),
          promptMode
            ? "Ultrathink"
            : getProviderOptionCurrentLabel(effort, input.selection, input.reportedSelection),
        )
      : null,
    speed,
  };
}

/**
 * Applies one option change (by descriptor id) and returns the full selection
 * list to store on the model selection, or null when the change doesn't match
 * an advertised descriptor / choice.
 */
export function applyProviderOptionSelection(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
  change: ProviderOptionSelection,
): ReadonlyArray<ProviderOptionSelection> | null {
  const descriptor = descriptors.find((candidate) => candidate.id === change.id);
  if (!descriptor) {
    return null;
  }
  if (
    (descriptor.type === "boolean" && typeof change.value !== "boolean") ||
    (descriptor.type === "select" &&
      (typeof change.value !== "string" ||
        !descriptor.options.some((option) => option.id === change.value)))
  ) {
    return null;
  }

  const nextDescriptors = descriptors.map((candidate) =>
    candidate.id === descriptor.id
      ? {
          ...candidate,
          currentValue: change.value,
        }
      : candidate,
  ) as ReadonlyArray<ProviderOptionDescriptor>;

  return buildProviderOptionSelectionsFromDescriptors(nextDescriptors) ?? [];
}
