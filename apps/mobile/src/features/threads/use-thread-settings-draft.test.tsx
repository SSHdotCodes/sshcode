// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderInstanceId, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { useThreadSettingsDraft } from "./use-thread-settings-draft";
import type { ModelOption } from "../../lib/modelOptions";

const descriptors: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "fastMode",
    label: "Fast",
    type: "boolean",
    currentValue: false,
  },
];
const selection = { instanceId: ProviderInstanceId.make("codex"), model: "current" };
const onSelectModel = vi.fn();
const onUpdateOptionSelections = vi.fn();
const onUpdateRuntimeMode = vi.fn();
let root: Root;
let draft: ReturnType<typeof useThreadSettingsDraft>;
let threadSelection = selection;
let threadRuntimeMode: "full-access" | "approval-required" = "full-access";
function Probe() {
  const state = useThreadSettingsDraft({
    selectedModel: threadSelection,
    optionDescriptors: descriptors,
    runtimeMode: threadRuntimeMode,
    onSelectModel,
    onUpdateOptionSelections,
    onUpdateRuntimeMode,
  });
  useLayoutEffect(() => {
    draft = state;
  });
  return null;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  threadRuntimeMode = "full-access";
  threadSelection = selection;
  root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("keeps option-only and runtime edits local until Save", () => {
  act(() => draft.applyOptionChange("fastMode", true));
  act(() => draft.setRuntimeMode("approval-required"));
  expect(draft.selection?.options).toEqual([{ id: "fastMode", value: true }]);
  expect(draft.descriptors[0]?.currentValue).toBe(true);
  expect(onUpdateOptionSelections).not.toHaveBeenCalled();
  expect(onUpdateRuntimeMode).not.toHaveBeenCalled();
  act(() => draft.save(draft.runtimeMode));
  expect(onUpdateOptionSelections).toHaveBeenCalledWith([{ id: "fastMode", value: true }]);
  expect(onUpdateRuntimeMode).toHaveBeenCalledWith("approval-required");
  expect(onSelectModel).not.toHaveBeenCalled();
});

it("discards all edits on Cancel and applies a model with its options on Save", () => {
  const model: ModelOption = {
    key: "codex:next",
    label: "Next",
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: { optionDescriptors: descriptors },
    selection: { ...selection, model: "next" },
  };
  act(() => {
    draft.setPendingModel(model);
    draft.setRuntimeMode("approval-required");
  });
  act(() => root.render(<Probe key="reopened" />));
  expect(draft.pendingModel).toBeNull();
  expect(draft.selection).toEqual(selection);
  expect(draft.runtimeMode).toBe("full-access");
  expect(onSelectModel).not.toHaveBeenCalled();
  expect(onUpdateOptionSelections).not.toHaveBeenCalled();
  expect(onUpdateRuntimeMode).not.toHaveBeenCalled();
  act(() => draft.setPendingModel(model));
  act(() => draft.applyOptionChange("fastMode", true));
  expect(onSelectModel).not.toHaveBeenCalled();
  act(() => draft.save(draft.runtimeMode));
  // A model picked alone does not pin its account.
  expect(onSelectModel).toHaveBeenCalledWith(
    {
      ...model,
      selection: { ...model.selection, options: [{ id: "fastMode", value: true }] },
    },
    false,
  );
  // An account picked by name is saved as a pin.
  act(() => draft.setPendingModel(model));
  act(() => draft.save(draft.runtimeMode, true));
  expect(onSelectModel).toHaveBeenLastCalledWith(model, true);
});

it("follows a mode another client changed while the sheet was open, and never saves the old one", () => {
  threadRuntimeMode = "approval-required";
  act(() => root.render(<Probe />));
  expect(draft.runtimeMode).toBe("approval-required");
  expect(draft.hasChanges).toBe(false);
  act(() => draft.save(draft.runtimeMode));
  expect(onUpdateRuntimeMode).not.toHaveBeenCalled();
  act(() => draft.setRuntimeMode("full-access"));
  expect(draft.hasChanges).toBe(true);
  act(() => draft.setRuntimeMode("approval-required"));
  expect(draft.hasChanges).toBe(false);
});

it("discards earlier unsaved options when another device changes the model", () => {
  act(() => draft.applyOptionChange("fastMode", true));
  threadSelection = { ...selection, model: "remote" };
  act(() => root.render(<Probe />));
  expect(draft.selection).toEqual(threadSelection);
  expect(draft.hasChanges).toBe(false);
  act(() => draft.save(draft.runtimeMode));
  expect(onSelectModel).not.toHaveBeenCalled();
  expect(onUpdateOptionSelections).not.toHaveBeenCalled();
  act(() => draft.applyOptionChange("fastMode", true));
  act(() => draft.save(draft.runtimeMode));
  expect(onUpdateOptionSelections).toHaveBeenCalledWith([{ id: "fastMode", value: true }]);
});

it("discards an older access pick after a remote change", () => {
  act(() => draft.setRuntimeMode("approval-required"));
  threadRuntimeMode = "approval-required";
  act(() => root.render(<Probe />));
  threadRuntimeMode = "full-access";
  act(() => root.render(<Probe />));
  expect(draft.runtimeMode).toBe("full-access");
  expect(draft.hasChanges).toBe(false);
});
