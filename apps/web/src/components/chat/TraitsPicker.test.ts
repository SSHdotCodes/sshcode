import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
} from "@t3tools/contracts";
import {
  buildTraitsAccessibleLabel,
  buildTraitsTriggerDisplay,
  traitsEmptyTriggerLabel,
  buildUnavailableModelOptionDescriptors,
} from "./TraitsPicker";

function selectDescriptor(
  id: string,
  options: ReadonlyArray<{ id: string; label: string; isDefault?: boolean }>,
  currentValue: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return { id, label: id, type: "select", options: [...options], currentValue };
}

function fastModeDescriptor(
  currentValue: boolean,
): Extract<ProviderOptionDescriptor, { type: "boolean" }> {
  return { id: "fastMode", label: "Fast Mode", type: "boolean", currentValue };
}

function serviceTierDescriptor(
  currentValue: "default" | "priority" | "ultrafast" | "flex",
): Extract<ProviderOptionDescriptor, { type: "select" }> {
  return {
    id: "serviceTier",
    label: "Service Tier",
    type: "select",
    options: [
      { id: "default", label: "Standard", isDefault: true },
      { id: "priority", label: "Fast" },
      { id: "ultrafast", label: "Ultrafast" },
      { id: "flex", label: "Flex" },
    ],
    currentValue,
  };
}

const EFFORT = selectDescriptor(
  "reasoningEffort",
  [
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  "high",
);
const CONTEXT_WINDOW = selectDescriptor(
  "contextWindow",
  [
    { id: "200k", label: "200k" },
    { id: "1m", label: "1M" },
  ],
  "1m",
);

const CODEX = ProviderDriverKind.make("codex");

function display(descriptors: ReadonlyArray<ProviderOptionDescriptor>) {
  return buildTraitsTriggerDisplay({
    provider: CODEX,
    descriptors,
    primarySelectDescriptorId: "reasoningEffort",
    ultrathinkPromptControlled: false,
  });
}

describe("buildTraitsTriggerDisplay", () => {
  it("omits fast mode from the label entirely when it is off", () => {
    expect(display([EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW])).toMatchObject({
      label: "High · 1M",
    });
  });

  it("omits disabled booleans from the visible label but names them for accessibility", () => {
    const descriptors: ProviderOptionDescriptor[] = [
      { id: "fast", label: "Fast", type: "boolean", currentValue: false },
      { id: "thinking", label: "Thinking", type: "boolean", currentValue: false },
      CONTEXT_WINDOW,
    ];
    expect(display(descriptors).label).toBe("1M");
    expect(buildTraitsAccessibleLabel(display(descriptors).label, descriptors)).toBe(
      "1M · Fast Off · Thinking Off",
    );
    expect(display(descriptors.slice(0, 2)).label).toBe("");
  });

  it("names a lone switch that is off instead of saying Traits", () => {
    const contributor: ProviderOptionDescriptor = {
      id: "contributorMode",
      label: "Contributor mode",
      type: "boolean",
      currentValue: false,
    };
    expect(display([contributor]).label).toBe("");
    expect(traitsEmptyTriggerLabel([contributor])).toBe("Contributor mode Off");
    expect(display([{ ...contributor, currentValue: true }]).label).toBe("Contributor mode On");
    // Several switches have no single name to show.
    expect(
      traitsEmptyTriggerLabel([
        contributor,
        { id: "thinking", label: "Thinking", type: "boolean", currentValue: false },
      ]),
    ).toBe("Traits");
  });

  it("keeps enabled toggles and speed readable without repeating them in the accessible label", () => {
    const descriptors = [EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW];
    expect(buildTraitsAccessibleLabel(display(descriptors).label, descriptors)).toBe(
      "High Fast · 1M",
    );
    const disabledSpeed = [EFFORT, fastModeDescriptor(false)];
    expect(buildTraitsAccessibleLabel(display(disabledSpeed).label, disabledSpeed)).toBe(
      "High · Fast Mode Off",
    );
  });

  it("pairs fast mode with reasoning before the context window", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toMatchObject({
      label: "High Fast · 1M",
    });
    expect(display([EFFORT, CONTEXT_WINDOW, fastModeDescriptor(true)])).toMatchObject({
      label: "High Fast · 1M",
    });
  });

  it.each(["reasoningEffort", "reasoning", "effort", "variant", "thinking", "thinking_level"])(
    "pairs Fast with %s even when context is the primary select",
    (id) => {
      for (const speed of [fastModeDescriptor(true), serviceTierDescriptor("priority")]) {
        expect(
          buildTraitsTriggerDisplay({
            provider: CODEX,
            descriptors: [
              selectDescriptor("profile", [{ id: "balanced", label: "Balanced" }], "balanced"),
              CONTEXT_WINDOW,
              { ...EFFORT, id },
              speed,
            ],
            primarySelectDescriptorId: "profile",
            ultrathinkPromptControlled: false,
          }),
        ).toMatchObject({ label: "Balanced · 1M · High Fast" });
      }
      expect(
        buildTraitsTriggerDisplay({
          provider: CODEX,
          descriptors: [CONTEXT_WINDOW, { ...EFFORT, id }, serviceTierDescriptor("ultrafast")],
          primarySelectDescriptorId: CONTEXT_WINDOW.id,
          ultrathinkPromptControlled: false,
        }),
      ).toMatchObject({ label: "1M · High Ultrafast" });
    },
  );

  it("pairs Cursor Fast with reasoning rather than the thinking toggle", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: ProviderDriverKind.make("cursor"),
        descriptors: [
          { ...EFFORT, id: "reasoning" },
          fastModeDescriptor(true),
          { id: "thinking", label: "Thinking", type: "boolean", currentValue: true },
        ],
        primarySelectDescriptorId: "reasoning",
        ultrathinkPromptControlled: false,
      }),
    ).toMatchObject({ label: "High Fast · Thinking On" });
  });

  it.each([true, false])("keeps boolean thinking %s independent of Fast", (currentValue) => {
    const thinking = {
      id: "thinking",
      label: "Thinking",
      type: "boolean" as const,
      currentValue,
    };
    const label = currentValue ? "Thinking On" : "";
    expect(display([thinking, fastModeDescriptor(true)])).toMatchObject({
      label: currentValue ? `${label} · Fast` : "Fast",
    });
    expect(
      display([thinking, { ...EFFORT, id: "reasoning" }, fastModeDescriptor(true)]),
    ).toMatchObject({
      label: currentValue ? `${label} · High Fast` : "High Fast",
    });
    expect(display([thinking, fastModeDescriptor(false)])).toMatchObject({
      label: currentValue ? label : "Normal",
    });
  });

  it("keeps speed separate when there is no reasoning descriptor", () => {
    expect(display([CONTEXT_WINDOW, fastModeDescriptor(true)])).toMatchObject({
      label: "1M · Fast",
    });
  });

  it.each(["Low", "Medium", "High", "Extra High", "Max", "Ultra"])(
    "preserves %s reasoning with Fast across harnesses",
    (label) => {
      for (const provider of ["codex", "claudeAgent", "cursor"]) {
        expect(
          buildTraitsTriggerDisplay({
            provider: ProviderDriverKind.make(provider),
            descriptors: [
              { ...EFFORT, options: [{ id: "effort", label }], currentValue: "effort" },
              fastModeDescriptor(true),
            ],
            primarySelectDescriptorId: EFFORT.id,
            ultrathinkPromptControlled: false,
          }),
        ).toMatchObject({ label: `${label} Fast` });
      }
    },
  );

  it("treats Codex standard and fast service tiers as fast mode states", () => {
    expect(display([EFFORT, serviceTierDescriptor("default")])).toMatchObject({ label: "High" });
    expect(display([EFFORT, serviceTierDescriptor("priority")])).toMatchObject({
      label: "High Fast",
    });
  });

  it("keeps Codex Ultrafast distinct from Fast", () => {
    expect(display([EFFORT, serviceTierDescriptor("ultrafast")])).toMatchObject({
      label: "High Ultrafast",
    });
  });

  it("uses Ultrafast without requiring a Fast tier", () => {
    const descriptor = serviceTierDescriptor("ultrafast");
    expect(
      display([
        EFFORT,
        { ...descriptor, options: descriptor.options.filter(({ id }) => id !== "priority") },
      ]),
    ).toMatchObject({ label: "High Ultrafast" });
  });

  it("keeps other Codex service tiers in the label", () => {
    expect(display([EFFORT, serviceTierDescriptor("flex")])).toMatchObject({
      label: "High · Flex",
    });
  });

  it("keeps Standard as text for models without speed tiers", () => {
    const descriptor = serviceTierDescriptor("default");
    const nonSpeedDescriptor = {
      ...descriptor,
      options: descriptor.options.filter(({ id }) => id === "default" || id === "flex"),
    };
    expect(display([EFFORT, nonSpeedDescriptor])).toMatchObject({ label: "High · Standard" });
    expect(display([nonSpeedDescriptor])).toMatchObject({ label: "Standard" });
  });

  it("keeps the Codex service tier readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("default")])).toMatchObject({ label: "Standard" });
    expect(display([serviceTierDescriptor("priority")])).toMatchObject({ label: "Fast" });
  });

  it("keeps Ultrafast readable when it is the only trait", () => {
    expect(display([serviceTierDescriptor("ultrafast")])).toMatchObject({ label: "Ultrafast" });
  });

  it("keeps non-fastMode booleans as text labels", () => {
    const thinking: Extract<ProviderOptionDescriptor, { type: "boolean" }> = {
      id: "thinking",
      label: "Thinking",
      type: "boolean",
      currentValue: true,
    };
    expect(display([EFFORT, thinking])).toMatchObject({ label: "High · Thinking On" });
  });

  it("falls back to a text label when fast mode is the only trait", () => {
    expect(display([fastModeDescriptor(true)])).toMatchObject({ label: "Fast" });
    expect(display([fastModeDescriptor(false)])).toMatchObject({ label: "Normal" });
  });

  it("does not add Fast to a model without a speed option", () => {
    expect(display([EFFORT, CONTEXT_WINDOW])).toMatchObject({ label: "High · 1M" });
  });

  it("stays blank when descriptors resolve to no label and there is no fast mode", () => {
    // A select with neither a currentValue nor an isDefault option yields no
    // label. Without a fastMode descriptor present that must stay blank rather
    // than falling through to a bogus "Normal".
    const unresolved: Extract<ProviderOptionDescriptor, { type: "select" }> = {
      id: "effort",
      label: "effort",
      type: "select",
      options: [
        { id: "low", label: "Low" },
        { id: "high", label: "High" },
      ],
    };
    expect(display([unresolved])).toMatchObject({ label: "" });
  });

  it("still renders prompt-controlled ultrathink with Fast", () => {
    expect(
      buildTraitsTriggerDisplay({
        provider: CODEX,
        descriptors: [EFFORT, fastModeDescriptor(true)],
        primarySelectDescriptorId: "reasoningEffort",
        ultrathinkPromptControlled: true,
      }),
    ).toMatchObject({ label: "Ultrathink Fast" });
  });

  it("draws Fast and Ultrafast as a bolt beside the reasoning label", () => {
    expect(display([EFFORT, fastModeDescriptor(true), CONTEXT_WINDOW])).toEqual({
      label: "High Fast · 1M",
      speedIcon: "fast",
      beforeSpeed: "High",
      afterSpeed: " · 1M",
    });
    expect(display([EFFORT, serviceTierDescriptor("ultrafast")])).toEqual({
      label: "High Ultrafast",
      speedIcon: "ultrafast",
      beforeSpeed: "High",
      afterSpeed: "",
    });
  });

  it("separates the bolt from labels that are not reasoning", () => {
    expect(display([CONTEXT_WINDOW, fastModeDescriptor(true)])).toEqual({
      label: "1M · Fast",
      speedIcon: "fast",
      beforeSpeed: "1M ·",
      afterSpeed: "",
    });
  });

  it("shows only the bolt when fast mode is the only trait", () => {
    expect(display([serviceTierDescriptor("priority")])).toEqual({
      label: "Fast",
      speedIcon: "fast",
      beforeSpeed: "",
      afterSpeed: "",
    });
  });

  it("keeps labels without a speed as plain text", () => {
    for (const descriptors of [
      [EFFORT, fastModeDescriptor(false), CONTEXT_WINDOW],
      [fastModeDescriptor(false)],
      [EFFORT, serviceTierDescriptor("flex")],
    ]) {
      const result = display(descriptors);
      expect(result).toEqual({
        label: result.label,
        speedIcon: null,
        beforeSpeed: result.label,
        afterSpeed: "",
      });
    }
  });
});

describe("buildUnavailableModelOptionDescriptors", () => {
  it("shows only saved values without inventing alternatives", () => {
    expect(
      buildUnavailableModelOptionDescriptors([
        { id: "variant", value: "max" },
        { id: "agent", value: "build" },
        { id: "fastMode", value: true },
      ]),
    ).toEqual([
      {
        id: "variant",
        label: "Reasoning",
        type: "select",
        options: [{ id: "max", label: "max" }],
        currentValue: "max",
      },
      {
        id: "agent",
        label: "Agent",
        type: "select",
        options: [{ id: "build", label: "build" }],
        currentValue: "build",
      },
      {
        id: "fastMode",
        label: "Fast Mode",
        type: "boolean",
        currentValue: true,
      },
    ]);
  });
});

it("shows Unknown until a matching provider report provides Default", () => {
  const selection = {
    instanceId: ProviderInstanceId.make("opencode"),
    model: "ling",
    options: [],
  };
  const input = {
    provider: ProviderDriverKind.make("opencode"),
    descriptors: [
      selectDescriptor(
        "variant",
        [
          { id: "none", label: "None" },
          { id: "thinking", label: "Thinking" },
        ],
        "",
      ),
    ],
    primarySelectDescriptorId: "variant",
    ultrathinkPromptControlled: false,
    modelSelection: selection,
  };
  expect(buildTraitsTriggerDisplay(input).label).toBe("Unknown");
  expect(
    buildTraitsTriggerDisplay({
      ...input,
      reportedModelSelection: { ...selection, options: [{ id: "variant", value: "default" }] },
    }).label,
  ).toBe("Default");
});
