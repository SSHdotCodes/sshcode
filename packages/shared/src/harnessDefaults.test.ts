import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import {
  harnessDefaultsControls,
  harnessDefaultsSummary,
  patchHarnessDefaults,
  withDefaultSelectOptions,
} from "./harnessDefaults.ts";

const id = ProviderInstanceId.make("codex");
const provider = {
  instanceId: id,
  nativeModelDefaults: { model: "native", options: { reasoningEffort: "high" } },
  models: [
    {
      slug: "native",
      name: "Native model",
      isDefault: true,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select",
            currentValue: "xhigh",
            nativeValue: "high",
            options: [
              { id: "high", label: "High" },
              { id: "xhigh", label: "Extra high", isDefault: true },
            ],
          },
        ],
      },
    },
  ],
} as unknown as ServerProvider;

describe("shared Mac and iPhone defaults controls", () => {
  it("retains independent model and option edits and resets only the requested choice", () => {
    const state = {
      harnesses: {
        [id]: { model: "native", options: { reasoningEffort: "xhigh", serviceTier: "fast" } },
      },
    };
    expect(
      patchHarnessDefaults(state, { harnesses: { [id]: { options: { reasoningEffort: null } } } }),
    ).toEqual({ harnesses: { [id]: { model: "native", options: { serviceTier: "fast" } } } });
    expect(
      patchHarnessDefaults(state, { harnesses: { [id]: { model: null } } }).harnesses[id]?.options,
    ).toEqual(state.harnesses[id]?.options);
    expect(patchHarnessDefaults(state, { harnesses: { [id]: null } })).toEqual({ harnesses: {} });
  });
  it("sums a harness up in one line for its folded row", () => {
    const summary = (harnesses: Record<string, unknown>) =>
      harnessDefaultsSummary(harnessDefaultsControls(provider, { harnesses } as never));
    expect(summary({})).toBe("Last used");
    expect(summary({ [id]: { options: { reasoningEffort: "xhigh" } } })).toBe("Extra high");
    expect(summary({ [id]: { model: "native", options: { reasoningEffort: "high" } } })).toBe(
      "Native model · High",
    );
    expect(summary({ [id]: { model: "retired" } })).toBe("retired");
  });
  it("shows the resolved native model and native effort separately from the app's choices", () => {
    const controls = harnessDefaultsControls(provider, {
      harnesses: { [id]: { options: { reasoningEffort: "xhigh" } } },
    });
    expect(controls.nativeModelLabel).toBe("Native model");
    expect(controls.options[0]).toMatchObject({ currentValue: "xhigh", nativeValue: "high" });
    expect(controls.warnings).toEqual([]);
  });
  it("explains stale models and unsupported option values without offering them", () => {
    const controls = harnessDefaultsControls(provider, {
      harnesses: {
        [id]: { model: "retired", options: { reasoningEffort: "max", removed: "yes" } },
      },
    });
    expect(controls.model?.slug).toBe("native");
    expect(controls.warnings).toHaveLength(3);
    expect(controls.warnings[0]).toContain("retired");
  });
  it("sends displayed select defaults, preserving explicit choices and leaving booleans alone", () => {
    const descriptors = provider.models[0]!.capabilities!.optionDescriptors!;
    expect(withDefaultSelectOptions(descriptors, undefined)).toEqual([
      { id: "reasoningEffort", value: "xhigh" },
    ]);
    expect(
      withDefaultSelectOptions(descriptors, [{ id: "reasoningEffort", value: "high" }]),
    ).toEqual([{ id: "reasoningEffort", value: "high" }]);
  });
});
