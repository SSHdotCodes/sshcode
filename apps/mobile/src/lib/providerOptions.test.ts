import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyProviderOptionSelection,
  fastModeControl,
  modelTraits,
  resolveProviderOptionDescriptors,
} from "./providerOptions";

const CODEX_CAPABILITIES: ModelCapabilities = {
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium", isDefault: true },
        { id: "high", label: "High" },
      ],
      currentValue: "medium",
    },
    {
      id: "serviceTier",
      label: "Service Tier",
      type: "select",
      options: [
        { id: "default", label: "Standard", isDefault: true },
        { id: "priority", label: "Fast" },
      ],
      currentValue: "default",
    },
  ],
};

describe("mobile provider options", () => {
  it("shows an ACP Speed (Devin's Lightning) as the fast switch under its own name", () => {
    const control = fastModeControl({
      id: "speed",
      label: "Speed",
      type: "select",
      options: [
        { id: "standard", label: "Standard" },
        { id: "fast", label: "Lightning" },
      ],
      currentValue: "fast",
    });
    expect(control).toMatchObject({
      enabled: true,
      onValue: "fast",
      offValue: "standard",
      choices: null,
      label: "Lightning",
      switchLabel: "Lightning",
    });
  });

  it("updates generic select options without knowing provider-specific ids", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: undefined,
    });

    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "priority" }),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "priority" },
    ]);
    // Choices the model doesn't advertise are rejected, not stored.
    expect(
      applyProviderOptionSelection(descriptors, { id: "serviceTier", value: "turbo" }),
    ).toBeNull();
    expect(applyProviderOptionSelection(descriptors, { id: "unknown", value: "high" })).toBeNull();
  });

  it("updates generic boolean options", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: {
        optionDescriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      },
      selections: undefined,
    });

    expect(applyProviderOptionSelection(descriptors, { id: "fastMode", value: true })).toEqual([
      { id: "fastMode", value: true },
    ]);
  });

  it("maps the native Fast switch to Codex priority and back without losing effort", () => {
    const descriptors = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: [],
    });
    const control = fastModeControl(descriptors[1]!);
    expect(control).toMatchObject({
      enabled: false,
      onValue: "priority",
      offValue: "default",
      choices: null,
    });
    const options = applyProviderOptionSelection(descriptors, {
      id: "serviceTier",
      value: control!.onValue,
    });
    const selection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt",
      options: options!,
    };
    expect(modelTraits({ capabilities: CODEX_CAPABILITIES, selection })).toEqual({
      effort: "Medium",
      speed: "Fast",
    });
    const enabled = resolveProviderOptionDescriptors({
      capabilities: CODEX_CAPABILITIES,
      selections: options,
    });
    expect(fastModeControl(enabled[1]!)?.enabled).toBe(true);
    expect(
      applyProviderOptionSelection(enabled, { id: "serviceTier", value: control!.offValue }),
    ).toEqual([
      { id: "reasoningEffort", value: "medium" },
      { id: "serviceTier", value: "default" },
    ]);
  });

  it("keeps Ultrafast as its own advertised tier instead of collapsing it to Fast", () => {
    const descriptor = CODEX_CAPABILITIES.optionDescriptors![1]!;
    if (descriptor.type !== "select") throw new Error("Expected service tiers");
    const capabilities = {
      optionDescriptors: [
        { ...descriptor, options: [...descriptor.options, { id: "rush", label: "Ultrafast" }] },
      ],
    };
    const selection = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt",
      options: [{ id: "serviceTier", value: "rush" }],
    };
    const resolved = resolveProviderOptionDescriptors({
      capabilities,
      selections: selection.options,
    });
    expect(fastModeControl(resolved[0]!)).toMatchObject({ enabled: true, label: "Ultrafast" });
    expect(fastModeControl(resolved[0]!)?.choices?.map(({ id, label }) => ({ id, label }))).toEqual(
      [
        { id: "default", label: "Off" },
        { id: "priority", label: "Fast" },
        { id: "rush", label: "Ultrafast" },
      ],
    );
    expect(modelTraits({ capabilities, selection }).speed).toBe("Ultrafast");
  });

  it.each(["claudeAgent", "cursor", "custom"])(
    "keeps boolean Fast opt-in for %s and displays explicit on and off",
    (instance) => {
      const capabilities: ModelCapabilities = {
        optionDescriptors: [
          { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue: true },
        ],
      };
      const selection = { instanceId: ProviderInstanceId.make(instance), model: "model" };
      expect(modelTraits({ capabilities, selection }).speed).toBeNull();
      for (const value of [true, false]) {
        const options = [{ id: "fastMode", value }];
        const descriptors = resolveProviderOptionDescriptors({ capabilities, selections: options });
        expect(fastModeControl(descriptors[0]!)?.enabled).toBe(value);
        expect(modelTraits({ capabilities, selection: { ...selection, options } }).speed).toBe(
          value ? "Fast" : null,
        );
      }
    },
  );

  it("leaves unrelated service tiers and models without Fast alone", () => {
    expect(
      fastModeControl({
        id: "serviceTier",
        label: "Service Tier",
        type: "select",
        options: [{ id: "default", label: "Standard" }],
      }),
    ).toBeNull();
    expect(modelTraits({ capabilities: null, selection: null })).toEqual({
      effort: undefined,
      speed: null,
    });
  });

  it.each([
    {
      name: "Antigravity / Devin thought_level",
      id: "thought_level",
      value: "high",
      label: "High",
    },
    {
      name: "Antigravity thinking_level",
      id: "thinking_level",
      value: "high",
      label: "High",
    },
    {
      name: "Pi / Kimi / Mistral thinking select",
      id: "thinking",
      value: "medium",
      label: "Medium",
    },
    {
      name: "Qwen reasoning_effort",
      id: "reasoning_effort",
      value: "high",
      label: "High",
    },
    {
      name: "custom reasoning role descriptor",
      id: "custom_depth",
      role: "reasoning" as const,
      value: "deep",
      label: "Deep",
    },
  ])("shows effort label for $name", ({ id, role, value, label }) => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [
        {
          id,
          label: "Reasoning",
          type: "select",
          ...(role ? { role } : {}),
          options: [{ id: value, label, isDefault: true }],
          currentValue: value,
        },
      ],
    };
    const selection = {
      instanceId: ProviderInstanceId.make("antigravity"),
      model: "gemini-4-neon",
      options: [{ id, value }],
    };
    expect(modelTraits({ capabilities, selection })).toEqual({
      effort: label,
      speed: null,
    });
  });

  it("ignores boolean thinking toggles when extracting effort", () => {
    const capabilities: ModelCapabilities = {
      optionDescriptors: [{ id: "thinking", label: "Thinking", type: "boolean" }],
    };
    const selection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude",
      options: [{ id: "thinking", value: true }],
    };
    expect(modelTraits({ capabilities, selection })).toEqual({
      effort: undefined,
      speed: null,
    });
  });
});
