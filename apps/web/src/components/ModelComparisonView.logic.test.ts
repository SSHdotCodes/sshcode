import { describe, expect, it } from "vite-plus/test";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { comparisonModelPresentation } from "./ModelComparisonView.logic";

function provider(
  instanceId = "account",
  models: ReadonlyArray<ServerProviderModel> = [],
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-26T12:00:00.000Z",
    models,
    slashCommands: [],
    skills: [],
  };
}
const model: ServerProviderModel = {
  slug: "live-model-id",
  name: "Catalog Model",
  shortName: "Short Name",
  isCustom: false,
  capabilities: {},
};
const selection = { instanceId: ProviderInstanceId.make("account"), model: model.slug };
const display = (snapshot: ServerProvider | undefined, selected = selection) =>
  comparisonModelPresentation({
    provider: snapshot,
    selection: selected,
    settings: DEFAULT_UNIFIED_SETTINGS,
  });

describe("comparison model presentation", () => {
  it("uses the picker's short name and responds to live catalog updates", () => {
    expect(display(provider("account", [model])).name).toBe("Short Name");
    expect(display(provider("account", [{ ...model, shortName: "Updated Name" }])).name).toBe(
      "Updated Name",
    );
  });
  it("keeps names scoped to the selected provider instance", () => {
    const other = provider("other", [{ ...model, shortName: "Other Account Name" }]);
    expect(display(other).name).toBe(model.slug);
    expect(display(other, { ...selection, instanceId: other.instanceId }).name).toBe(
      "Other Account Name",
    );
  });
  it("falls back to the id only when the instance or model name is missing", () => {
    expect(display(undefined).name).toBe(model.slug);
    expect(display(provider()).name).toBe(model.slug);
    const { shortName: _shortName, ...named } = model;
    expect(display(provider("account", [named])).name).toBe("Catalog Model");
  });
  it("retains a live catalog name when an instance reports a custom model", () => {
    expect(display(provider("account", [{ ...model, isCustom: true }])).name).toBe("Short Name");
  });
  it("strips the same provider qualifier as the picker", () => {
    expect(
      display(
        provider("account", [{ ...model, subProvider: "Vendor", shortName: "Vendor / Short" }]),
      ).name,
    ).toBe("Short");
  });
  it("shows catalog option labels and defaults instead of raw saved values", () => {
    const snapshot = provider("account", [
      {
        ...model,
        capabilities: {
          optionDescriptors: [
            {
              id: "effort",
              label: "Effort",
              type: "select",
              options: [
                { id: "balanced", label: "Balanced", isDefault: true },
                { id: "deep", label: "Deep" },
              ],
            },
          ],
        },
      },
    ]);
    expect(display(snapshot).traits?.label).toBe("Balanced");
    const selected = comparisonModelPresentation({
      provider: snapshot,
      selection: { ...selection, options: [{ id: "effort", value: "deep" }] },
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
    expect(selected.traits?.label).toBe("Deep");
    expect(display(provider("account", [model])).traits).toBeNull();
  });
  it("preserves the picker's speed icon presentation", () => {
    const snapshot = provider("account", [
      {
        ...model,
        capabilities: { optionDescriptors: [{ id: "fastMode", label: "Fast", type: "boolean" }] },
      },
    ]);
    const result = comparisonModelPresentation({
      provider: snapshot,
      selection: { ...selection, options: [{ id: "fastMode", value: true }] },
      settings: DEFAULT_UNIFIED_SETTINGS,
    });
    expect(result.traits).toMatchObject({ label: "Fast", speedIcon: "fast" });
  });
});
