import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { isReasoningSelectDescriptor } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";
import {
  describeReasoningLevel,
  getTraitsSectionVisibility,
  hasTraitsBesidesReasoning,
} from "./TraitsPicker";

const CODEX = ProviderDriverKind.make("codex");
const INSTANCE = ProviderInstanceId.make("codex");

const EFFORT: ProviderOptionDescriptor = {
  id: "reasoningEffort",
  label: "Reasoning",
  type: "select",
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium", isDefault: true },
    { id: "high", label: "High" },
  ],
  currentValue: "high",
};
const FAST: ProviderOptionDescriptor = {
  id: "fastMode",
  label: "Fast Mode",
  type: "boolean",
  currentValue: false,
};

function model(descriptors: ReadonlyArray<ProviderOptionDescriptor>): ServerProviderModel {
  return {
    slug: "gpt-6.1-sol",
    name: "GPT-6.1-Sol",
    capabilities: { optionDescriptors: [...descriptors] },
  } as unknown as ServerProviderModel;
}

function visibility(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return getTraitsSectionVisibility({
    provider: CODEX,
    models: [model(descriptors)],
    model: "gpt-6.1-sol",
    prompt: "",
    modelOptions: [],
    planModeEnabled: false,
  });
}

describe("Reasoning column", () => {
  it("recognizes effort ids and an agent's own reasoning control", () => {
    expect(isReasoningSelectDescriptor(EFFORT)).toBe(true);
    expect(
      isReasoningSelectDescriptor({
        id: "thought_level",
        label: "Thought level",
        type: "select",
        options: [{ id: "deep", label: "Deep" }],
        role: "reasoning",
      }),
    ).toBe(true);
    expect(isReasoningSelectDescriptor(FAST)).toBe(false);
  });

  it("leaves the traits control only when something besides effort remains", () => {
    expect(hasTraitsBesidesReasoning(visibility([EFFORT]))).toBe(false);
    expect(hasTraitsBesidesReasoning(visibility([EFFORT, FAST]))).toBe(true);
  });

  it("names the model's effort for the picker trigger", () => {
    expect(
      describeReasoningLevel({
        provider: CODEX,
        instanceId: INSTANCE,
        models: [model([EFFORT])],
        model: "gpt-6.1-sol",
        prompt: "",
        modelOptions: [],
        planModeEnabled: false,
      }),
    ).toEqual({ label: "High", barCount: 3, filledBars: 3, fx: 1, accent: undefined });
    expect(
      describeReasoningLevel({
        provider: CODEX,
        instanceId: INSTANCE,
        models: [model([FAST])],
        model: "gpt-6.1-sol",
        prompt: "",
        modelOptions: [],
        planModeEnabled: false,
      }),
    ).toBeNull();
  });
});

describe("ProviderModelPicker effort meter", () => {
  const provider: ServerProvider = {
    instanceId: INSTANCE,
    driver: CODEX,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-03T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
  const render = (
    selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>,
  ) =>
    renderToStaticMarkup(
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={INSTANCE}
        model="gpt-6.1-sol"
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries([provider])}
        modelOptionsByInstance={
          new Map([[INSTANCE, [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" }]]])
        }
        onInstanceModelChange={() => {}}
        reasoningColumn={<div />}
        triggerEffort={{ label: "High", barCount: 3, filledBars: 3, fx: 1 }}
        triggerShortcut="composer.effort"
        {...(selectedModels ? { selectedModels } : {})}
      />,
    );

  it("follows the model name and takes the effort shortcut", () => {
    const markup = render();
    expect(markup).toContain('data-chat-provider-model-picker-effort="true"');
    expect(markup).toContain('aria-label="GPT-6.1-Sol, Effort: High"');
    expect(markup).toContain('data-composer-shortcut="composer.effort"');
  });

  it("is left out while comparing models", () => {
    const markup = render([{ instanceId: INSTANCE, model: "gpt-6.1-sol" }]);
    expect(markup).not.toContain('data-chat-provider-model-picker-effort="true"');
  });
});
