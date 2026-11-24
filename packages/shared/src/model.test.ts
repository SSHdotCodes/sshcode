import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type ModelCapabilities } from "@t3tools/contracts";

import {
  applyClaudePromptEffortPrefix,
  buildExplicitProviderOptionSelectionsFromDescriptors,
  buildProviderOptionSelectionsFromDescriptors,
  createModelCapabilities,
  createModelSelection,
  formatCodexModelName,
  formatModelSlugName,
  getProviderOptionCurrentLabel,
  getExplicitModelEffortLabel,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
  toCustomModelSetting,
  getProviderOptionBooleanSelectionValue,
  getProviderOptionStringSelectionValue,
  normalizeCustomModelSlug,
  normalizeModelSlug,
  modelSelectionsEqual,
  pickModelSelection,
  supersededModelVersions,
} from "./model.ts";

it("recognizes Antigravity thinking_level choices as effort", () => {
  expect(
    getExplicitModelEffortLabel(
      {
        instanceId: ProviderInstanceId.make("antigravity"),
        model: "gemini",
        options: [{ id: "thinking_level", value: "high" }],
      },
      {
        optionDescriptors: [
          {
            id: "thinking_level",
            label: "Thinking",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    ),
  ).toBe("High");
});

it("names only explicitly saved effort, including provider-defined reasoning ids", () => {
  const selection = { instanceId: ProviderInstanceId.make("custom"), model: "custom" };
  const caps: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "thought_level",
        label: "Thought level",
        type: "select",
        role: "reasoning",
        currentValue: "fast",
        options: [{ id: "fast", label: "Fast" }],
      },
      {
        id: "custom_depth",
        label: "Depth",
        type: "select",
        role: "reasoning",
        options: [{ id: "deep", label: "Deep" }],
      },
    ],
  };
  expect(getExplicitModelEffortLabel(selection, caps)).toBeUndefined();
  expect(
    getExplicitModelEffortLabel(
      { ...selection, options: [{ id: "thought_level", value: "fast" }] },
      caps,
    ),
  ).toBe("Fast");
  expect(
    getExplicitModelEffortLabel(
      { ...selection, options: [{ id: "custom_depth", value: "deep" }] },
      caps,
    ),
  ).toBe("Deep");
  expect(
    getExplicitModelEffortLabel({
      ...selection,
      options: [{ id: "thought_level", value: "high" }],
    }),
  ).toBe("high");
  expect(
    getExplicitModelEffortLabel({
      ...selection,
      options: [{ id: "reasoning_effort", value: "high" }],
    }),
  ).toBe("high");
  expect(
    getExplicitModelEffortLabel({ ...selection, options: [{ id: "effort", value: "max" }] }),
  ).toBe("max");
  expect(
    getExplicitModelEffortLabel({ ...selection, options: [{ id: "thinking", value: true }] }),
  ).toBeUndefined();
});

it("keeps the Codex catalog display formatting", () => {
  expect(formatCodexModelName("gpt-5.3-codex-spark")).toBe("GPT-5.3-Codex-Spark");
  expect(formatCodexModelName("GPT Test")).toBe("GPT Test");
});

it.each([
  ["gpt-5.4", "GPT-5.4"],
  ["claude-opus-4-6", "Claude Opus 4.6"],
  ["claude-sonnet-4-20250514", "Claude Sonnet 4 20250514"],
  ["claude-opus-4-6[1m]", "Claude Opus 4.6[1m]"],
  ["openai/gpt-5.4-mini", "openai/GPT-5.4-Mini"],
  ["gemini-2.5-pro-preview-06-05", "Gemini 2.5 Pro Preview 06 05"],
  ["custom/model-v2", "custom/model-v2"],
  ["gpt-proxy", "gpt-proxy"],
  ["My Custom Model", "My Custom Model"],
])("formats a known model ID without losing its qualifiers: %s", (slug, expected) => {
  expect(formatModelSlugName(slug)).toBe(expected);
});

const codexCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "reasoningEffort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "xhigh", label: "Extra High" },
        { id: "high", label: "High", isDefault: true },
      ],
      currentValue: "high",
    },
    {
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    },
  ],
});

describe("model slug normalization", () => {
  it("preserves exact custom slugs instead of expanding provider aliases", () => {
    // Claude aliases now resolve through the model catalog (#9084), so the
    // provider alias table passes unknown slugs through unchanged.
    const claude = ProviderDriverKind.make("claudeAgent");

    expect(normalizeModelSlug("opus", claude)).toBe("opus");
    expect(normalizeCustomModelSlug(" opus ")).toBe("opus");
  });
});

const claudeCaps: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [
    {
      id: "effort",
      label: "Reasoning",
      type: "select",
      options: [
        { id: "medium", label: "Medium" },
        { id: "high", label: "High", isDefault: true },
        { id: "ultrathink", label: "Ultrathink" },
      ],
      currentValue: "high",
      promptInjectedValues: ["ultrathink"],
    },
    {
      id: "contextWindow",
      label: "Context Window",
      type: "select",
      options: [
        { id: "200k", label: "200k" },
        { id: "1m", label: "1M", isDefault: true },
      ],
      currentValue: "1m",
    },
  ],
});

describe("descriptor helpers", () => {
  it("applies selection values to capability descriptors", () => {
    expect(
      getProviderOptionDescriptors({
        caps: claudeCaps,
        selections: [
          { id: "effort", value: "medium" },
          { id: "contextWindow", value: "200k" },
        ],
      }),
    ).toEqual([
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High", isDefault: true },
          { id: "ultrathink", label: "Ultrathink" },
        ],
        currentValue: "medium",
        promptInjectedValues: ["ultrathink"],
      },
      {
        id: "contextWindow",
        label: "Context Window",
        type: "select",
        options: [
          { id: "200k", label: "200k" },
          { id: "1m", label: "1M", isDefault: true },
        ],
        currentValue: "200k",
      },
    ]);
  });

  it("builds wire-format option selections from descriptors", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });

    expect(buildProviderOptionSelectionsFromDescriptors(descriptors)).toEqual([
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
  });

  it("builds dispatch options only from explicit selections", () => {
    const descriptors = getProviderOptionDescriptors({
      caps: codexCaps,
      selections: [{ id: "fastMode", value: true }],
    });

    expect(buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, undefined)).toBe(
      undefined,
    );
    expect(
      buildExplicitProviderOptionSelectionsFromDescriptors(descriptors, [
        { id: "fastMode", value: true },
      ]),
    ).toEqual([{ id: "fastMode", value: true }]);
  });

  it("stores option selection arrays in model selections", () => {
    expect(
      createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
      options: [
        { id: "reasoningEffort", value: "high" },
        { id: "fastMode", value: true },
      ],
    });
  });

  it("reads typed option selection values", () => {
    const selection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);

    expect(getProviderOptionStringSelectionValue(selection.options, "reasoningEffort")).toBe(
      "high",
    );
    expect(getProviderOptionStringSelectionValue(selection.options, "fastMode")).toBeUndefined();
    expect(getProviderOptionBooleanSelectionValue(selection.options, "fastMode")).toBe(true);
    expect(
      getProviderOptionBooleanSelectionValue(selection.options, "reasoningEffort"),
    ).toBeUndefined();
    expect(getModelSelectionStringOptionValue(selection, "reasoningEffort")).toBe("high");
    expect(getModelSelectionBooleanOptionValue(selection, "fastMode")).toBe(true);
  });

  it("compares complete model selections independent of option ordering", () => {
    const left = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
      { id: "fastMode", value: true },
    ]);
    const reordered = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5.4", [
      { id: "fastMode", value: true },
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(modelSelectionsEqual(left, reordered)).toBe(true);
    expect(
      modelSelectionsEqual(left, {
        ...reordered,
        options: [
          { id: "fastMode", value: true },
          { id: "reasoningEffort", value: "medium" },
        ],
      }),
    ).toBe(false);
    expect(modelSelectionsEqual(left, { ...reordered, model: "gpt-5.5" })).toBe(false);
  });

  it("keeps the options when the current model is picked again", () => {
    const codex = ProviderInstanceId.make("codex");
    const current = createModelSelection(codex, "gpt-5.4", [
      { id: "reasoningEffort", value: "high" },
    ]);

    expect(pickModelSelection(current, codex, "gpt-5.4")).toBe(current);
    expect(pickModelSelection(current, codex, "gpt-5.5")).toEqual({
      instanceId: "codex",
      model: "gpt-5.5",
    });
    expect(pickModelSelection(current, ProviderInstanceId.make("codex_work"), "gpt-5.4")).toEqual({
      instanceId: "codex_work",
      model: "gpt-5.4",
    });
    expect(pickModelSelection(null, codex, "gpt-5.4")).toEqual({
      instanceId: "codex",
      model: "gpt-5.4",
    });
  });
});

describe("applyClaudePromptEffortPrefix", () => {
  it("keeps slash commands intact when ultrathink is selected", () => {
    expect(applyClaudePromptEffortPrefix("/compact", "ultrathink")).toBe("/compact");
    expect(applyClaudePromptEffortPrefix(" /compact keep recent errors ", "ultrathink")).toBe(
      "/compact keep recent errors",
    );
    expect(applyClaudePromptEffortPrefix(" /review src/model.ts ", "ultrathink")).toBe(
      "/review src/model.ts",
    );
    expect(applyClaudePromptEffortPrefix("/security-review", "ultrathink")).toBe(
      "/security-review",
    );
    expect(applyClaudePromptEffortPrefix("/plugin:skill run", "ultrathink")).toBe(
      "/plugin:skill run",
    );
    expect(applyClaudePromptEffortPrefix("/deploy.prod to staging", "ultrathink")).toBe(
      "/deploy.prod to staging",
    );
  });

  it("still adds the ultrathink prefix to ordinary prompts", () => {
    expect(applyClaudePromptEffortPrefix("Investigate this failure", "ultrathink")).toBe(
      "Ultrathink:\nInvestigate this failure",
    );
    expect(applyClaudePromptEffortPrefix("/home/theo/app.ts crashed on load", "ultrathink")).toBe(
      "Ultrathink:\n/home/theo/app.ts crashed on load",
    );
  });
});

describe("readCustomModelEntries", () => {
  const capabilities: ModelCapabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: [{ id: "high", label: "High", isDefault: true }],
        currentValue: "high",
      },
    ],
  };

  it("resolves bare slugs and entries, trimming and deduplicating on slug", () => {
    expect(
      readCustomModelEntries([
        " bare ",
        { slug: "named", name: " Named ", capabilities },
        "bare",
        { slug: "named", name: "Second" },
        "",
        { name: "no slug" },
        42,
      ]),
    ).toEqual([
      { slug: "bare", name: "bare", capabilities: null },
      { slug: "named", name: "Named", capabilities },
    ]);
  });

  it("drops unparseable capabilities but keeps the entry", () => {
    expect(
      readCustomModelEntries([{ slug: "x", capabilities: { optionDescriptors: "nope" } }]),
    ).toEqual([{ slug: "x", name: "x", capabilities: null }]);
    expect(readCustomModelEntries("not a list")).toEqual([]);
  });

  it("writes the compact stored shape back", () => {
    expect(toCustomModelSetting({ slug: "x", name: "x", capabilities: null })).toBe("x");
    expect(
      toCustomModelSetting({ slug: "x", name: "x", capabilities: { optionDescriptors: [] } }),
    ).toBe("x");
    expect(toCustomModelSetting({ slug: "x", name: "X", capabilities })).toEqual({
      slug: "x",
      name: "X",
      capabilities,
    });
  });
});

describe("provider-reported option display", () => {
  const selection = createModelSelection(ProviderInstanceId.make("opencode"), "ling");
  const reported = { ...selection, options: [{ id: "variant", value: "default" }] };
  const descriptor = {
    id: "variant",
    label: "Reasoning",
    type: "select" as const,
    options: [
      { id: "none", label: "None" },
      { id: "thinking", label: "Thinking" },
    ],
  };

  it("shows explicit reports without adding a choice or a dispatch option", () => {
    expect(getProviderOptionCurrentLabel(descriptor, selection, reported)).toBe("Default");
    expect(
      getProviderOptionCurrentLabel(descriptor, selection, {
        ...reported,
        options: [{ id: "variant", value: "thinking" }],
      }),
    ).toBe("Thinking");
    expect(
      getProviderOptionCurrentLabel(
        { ...descriptor, currentValue: "none" },
        { ...selection, options: [{ id: "variant", value: "none" }] },
        reported,
      ),
    ).toBe("None");
    expect(descriptor.options.map((option) => option.id)).toEqual(["none", "thinking"]);
    expect(buildProviderOptionSelectionsFromDescriptors([descriptor])).toBeUndefined();
    expect(getProviderOptionCurrentLabel(descriptor, selection)).toBe("Unknown");
    const effortDescriptor = { ...descriptor, id: "effort", currentValue: "default" };
    expect(getProviderOptionCurrentLabel(effortDescriptor, selection)).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        model: "other",
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBeUndefined();
    expect(
      getProviderOptionCurrentLabel(effortDescriptor, selection, {
        ...reported,
        options: [{ id: "effort", value: "default" }],
      }),
    ).toBe("Default");
    expect(
      getProviderOptionCurrentLabel({ ...descriptor, currentValue: "thinking" }, selection),
    ).toBe("Unknown");
  });

  it.each([
    { ...selection, model: "other" },
    { ...selection, instanceId: ProviderInstanceId.make("other") },
    { ...selection, options: [{ id: "variant", value: "none" }] },
  ])("ignores reports after changing the model, instance, or option: %j", (selected) => {
    expect(getProviderOptionCurrentLabel(descriptor, selected, reported)).toBe("Unknown");
  });
});

describe("supersededModelVersions", () => {
  it("maps each older version of a line to its newest, keeping other lines current", () => {
    const superseded = supersededModelVersions([
      "gpt-6.1-sol",
      "gpt-6-astra",
      "gpt-6-sol",
      "gpt-6-luna",
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
    ]);
    expect(Object.fromEntries(superseded)).toEqual({
      "gpt-6-sol": "gpt-6.1-sol",
      "gpt-5.6-sol": "gpt-6.1-sol",
      "gpt-5.6-luna": "gpt-6-luna",
    });
  });

  it("reads Claude's dashed versions and ignores snapshot dates", () => {
    const superseded = supersededModelVersions([
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-opus-5",
      "claude-opus-4-8",
      "claude-opus-4-5-20251101",
      "claude-sonnet-4-6",
      "claude-haiku-5-5",
      "claude-haiku-4-5",
      "claude-haiku-5-5-20260901",
    ]);
    expect(Object.fromEntries(superseded)).toEqual({
      "claude-fable-5": "claude-fable-5-1",
      "claude-opus-5": "claude-opus-5-5",
      "claude-opus-4-8": "claude-opus-5-5",
      "claude-opus-4-5-20251101": "claude-opus-5-5",
      "claude-sonnet-4-6": "claude-sonnet-5-5",
      "claude-haiku-4-5": "claude-haiku-5-5",
    });
  });

  it("reads 4.20 as 4.2 and retires a release's modes with it", () => {
    const superseded = supersededModelVersions([
      "grok-4.7",
      "grok-4.7-build-fast",
      "grok-4.20",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
      "grok-4.20-multi-agent",
      "grok-4.20-multi-agent-0309",
      "grok-4.3",
      "grok-build",
    ]);
    expect(Object.fromEntries(superseded)).toEqual({
      "grok-4.20": "grok-4.7",
      "grok-4.20-0309-reasoning": "grok-4.7",
      "grok-4.20-0309-non-reasoning": "grok-4.7",
      "grok-4.20-multi-agent": "grok-4.7",
      "grok-4.20-multi-agent-0309": "grok-4.7",
      "grok-4.3": "grok-4.7",
    });
  });

  it("reads a trailing effort as a mode of the release", () => {
    const superseded = supersededModelVersions([
      "swe-2-high",
      "swe-2-flash-medium",
      "swe-1-7-medium",
      "swe-1-6",
      "gemini-3.8-flash-high",
      "gemini-3.8-flash-low",
      "qwen3-max",
      "qwen3.5",
    ]);
    expect(Object.fromEntries(superseded)).toEqual({
      "swe-1-7-medium": "swe-2-high",
      "swe-1-6": "swe-2-high",
    });
  });

  it("keeps the newest release current in every mode and spelling", () => {
    const superseded = supersededModelVersions([
      "grok-4.7",
      "grok-4.7-reasoning",
      "grok-4.7-non-reasoning",
      "claude-sonnet-5-5",
      "claude-sonnet-5.5",
      "gemini-3.7-flash",
      "gemini-3.7-flash-preview",
      "gemini-3.5-flash-preview",
    ]);
    expect(Object.fromEntries(superseded)).toEqual({
      "gemini-3.5-flash-preview": "gemini-3.7-flash",
    });
  });

  it("keeps tiers, sizes and variants apart", () => {
    const superseded = supersededModelVersions([
      "grok-4.7",
      "grok-4.7-build-fast",
      "grok-4.6",
      "grok-build",
      "kimi-code/k3",
      "kimi-code/k3,thinking",
      "kimi-code/k3.1-pro",
      "kimi-code/k3-256k",
      "muse-spark-1.3",
      "muse-spark-1.2-contributor",
      "muse-spark-1.3-contributor",
      "qwen2.5-coder-7b",
      "qwen3-coder-32b",
      "qwen3-coder-7b",
      "gpt-4o",
      "o3",
      "o4-mini",
      "default",
    ]);
    expect(Object.fromEntries(superseded)).toEqual({
      "grok-4.6": "grok-4.7",
      "muse-spark-1.2-contributor": "muse-spark-1.3-contributor",
      "qwen2.5-coder-7b": "qwen3-coder-7b",
    });
  });
});
