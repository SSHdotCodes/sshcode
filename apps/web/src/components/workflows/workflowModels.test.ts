import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { changeWorkflowModel, describeModel, prettifyModelSlug } from "./workflowModels";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { buildServerProvider } from "@t3tools/provider-core/server/snapshotProbe";

const instanceId = ProviderInstanceId.make("claudeAgent");
const entries = deriveProviderInstanceEntries([
  {
    ...buildServerProvider({
      presentation: { displayName: "Claude" },
      enabled: true,
      checkedAt: "2026-11-06T00:00:00.000Z",
      models: [
        {
          slug: "fable",
          name: "Fable 5.2",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [
                  { id: "max", label: "Max" },
                  { id: "high", label: "High" },
                ],
              },
            ],
          },
        },
        {
          slug: "other",
          name: "Other",
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "effort",
                label: "Effort",
                type: "select",
                options: [{ id: "high", label: "High" }],
              },
            ],
          },
        },
        { slug: "plain", name: "Plain", isCustom: false, capabilities: null },
      ],
      probe: { installed: true, version: null, status: "ready", auth: { status: "authenticated" } },
    }),
    instanceId,
    driver: ProviderDriverKind.make("claudeAgent"),
  },
]);

it("drops unsupported effort on model changes and keeps a supported explicit choice", () => {
  const selection = { instanceId, model: "fable", options: [{ id: "effort", value: "max" }] };
  expect(changeWorkflowModel(entries, selection, instanceId, "other")).toEqual({
    instanceId,
    model: "other",
  });
  expect(changeWorkflowModel(entries, selection, instanceId, "plain")).toEqual({
    instanceId,
    model: "plain",
  });
  expect(
    changeWorkflowModel(
      entries,
      { ...selection, options: [{ id: "effort", value: "high" }] },
      instanceId,
      "other",
    ),
  ).toEqual({ instanceId, model: "other", options: [{ id: "effort", value: "high" }] });
  expect(changeWorkflowModel(entries, { instanceId, model: "fable" }, instanceId, "other")).toEqual(
    { instanceId, model: "other" },
  );
});

it("shows explicit effort after the canvas model name, including an unavailable model", () => {
  expect(describeModel(entries, instanceId, "fable", [{ id: "effort", value: "max" }]).name).toBe(
    "Fable 5.2 · Max",
  );
  expect(describeModel(entries, instanceId, "fable").name).toBe("Fable 5.2");
  expect(
    describeModel([], instanceId, "claude-fable-5-2", [{ id: "effort", value: "max" }]).name,
  ).toBe("Fable 5.2 · max");
});

describe("prettifyModelSlug", () => {
  it("turns catalog slugs into names people say", () => {
    expect(prettifyModelSlug("claude-opus-5-5")).toBe("Opus 5.5");
    expect(prettifyModelSlug("gpt-6.1-sol")).toBe("GPT 6.1 Sol");
    expect(prettifyModelSlug("claude-haiku-5-5")).toBe("Haiku 5.5");
  });
});

describe("describeModel", () => {
  it("still names a model whose provider isn't connected", () => {
    const description = describeModel(
      [],
      ProviderInstanceId.make("claudeAgent"),
      "claude-opus-5-5",
    );
    expect(description).toMatchObject({ name: "Opus 5.5", driverKind: "claudeAgent", entry: null });
  });

  it("guesses the provider logo from an unknown instance's slug", () => {
    expect(
      describeModel([], ProviderInstanceId.make("work_claude"), "claude-haiku-5-5").driverKind,
    ).toBe("claudeAgent");
  });
});
