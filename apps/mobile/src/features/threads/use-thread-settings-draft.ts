import { useMemo, useState } from "react";
import type {
  ModelSelection,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
} from "@t3tools/contracts";
import type { ModelOption } from "../../lib/modelOptions";
import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";

/** All model controls belong to one presentation; dismissing it discards the draft. */
export function useThreadSettingsDraft(props: {
  readonly selectedModel: ModelSelection | null;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly runtimeMode: RuntimeMode;
  /** `accountPinned`: the account was picked by name, so a new chat stays on it. */
  readonly onSelectModel: (option: ModelOption, accountPinned: boolean) => void;
  readonly onUpdateOptionSelections: (options: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
}) {
  const [pendingModel, setPendingModel] = useState<ModelOption | null>(null);
  const [pendingOptions, setPendingOptions] =
    useState<ReadonlyArray<ProviderOptionSelection> | null>(null);
  // Only an explicit pick overrides the thread's mode; otherwise follow it, so a
  // mode another client changed while the sheet was open is never saved back.
  const [pendingRuntimeMode, setPendingRuntimeMode] = useState<RuntimeMode | null>(null);
  const modelKey = JSON.stringify(props.selectedModel);
  const [previousModelKey, setPreviousModelKey] = useState(modelKey);
  const [previousRuntimeMode, setPreviousRuntimeMode] = useState(props.runtimeMode);
  // A choice made before a remote change cannot be saved back over that change.
  // The sheet owns only settings, so this never touches the composer's text.
  if (modelKey !== previousModelKey) {
    setPreviousModelKey(modelKey);
    setPendingModel(null);
    setPendingOptions(null);
  }
  if (props.runtimeMode !== previousRuntimeMode) {
    setPreviousRuntimeMode(props.runtimeMode);
    setPendingRuntimeMode(null);
  }
  const runtimeMode = pendingRuntimeMode ?? props.runtimeMode;
  const setRuntimeMode = (mode: RuntimeMode) =>
    setPendingRuntimeMode(mode === props.runtimeMode ? null : mode);
  const selection = useMemo(
    () =>
      pendingModel?.selection ??
      (props.selectedModel && pendingOptions
        ? { ...props.selectedModel, options: pendingOptions }
        : props.selectedModel),
    [pendingModel, pendingOptions, props.selectedModel],
  );
  const descriptors = useMemo(() => {
    if (pendingModel)
      return resolveProviderOptionDescriptors({
        capabilities: pendingModel.capabilities,
        selections: pendingModel.selection.options,
      });
    return props.optionDescriptors.map((descriptor) => {
      const value = pendingOptions?.find((option) => option.id === descriptor.id)?.value;
      if (descriptor.type === "boolean" && typeof value === "boolean")
        return { ...descriptor, currentValue: value };
      if (descriptor.type === "select" && typeof value === "string")
        return { ...descriptor, currentValue: value };
      return descriptor;
    });
  }, [pendingModel, pendingOptions, props.optionDescriptors]);
  const applyOptionChange = (id: string, value: string | boolean) => {
    const next = applyProviderOptionSelection(descriptors, { id, value });
    if (!next) return;
    if (pendingModel)
      setPendingModel({ ...pendingModel, selection: { ...pendingModel.selection, options: next } });
    else setPendingOptions(next);
  };
  const save = (compatibleRuntimeMode: RuntimeMode, accountPinned = false) => {
    if (pendingModel) props.onSelectModel(pendingModel, accountPinned);
    else if (pendingOptions) props.onUpdateOptionSelections(pendingOptions);
    if (compatibleRuntimeMode !== props.runtimeMode)
      props.onUpdateRuntimeMode(compatibleRuntimeMode);
  };
  return {
    pendingModel,
    setPendingModel,
    selection,
    descriptors,
    runtimeMode,
    setRuntimeMode,
    applyOptionChange,
    save,
    hasChanges:
      pendingModel !== null || pendingOptions !== null || runtimeMode !== props.runtimeMode,
  };
}
