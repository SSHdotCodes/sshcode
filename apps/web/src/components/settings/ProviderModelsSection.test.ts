import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  describeModelCapabilities,
  groupModelsForDisplay,
  nextHiddenModelsForBulkToggle,
} from "./ProviderModelsSection";

function model(slug: string, isCustom = false): ServerProviderModel {
  return { slug, name: slug, isCustom, capabilities: null };
}

describe("groupModelsForDisplay", () => {
  it("lists favorites first, then visible models in user order, then hidden ones", () => {
    const models = [model("a"), model("b"), model("c"), model("d"), model("custom", true)];

    const display = groupModelsForDisplay(models, {
      favoriteModels: new Set(["c"]),
      hiddenModels: new Set(["a", "custom"]),
      modelOrder: ["d", "b"],
    });

    // A custom model is never hidden, even if its slug is in the hidden set.
    expect(display.map((entry) => entry.slug)).toEqual(["c", "d", "b", "custom", "a"]);
  });
});

describe("nextHiddenModelsForBulkToggle", () => {
  it("hides every built-in model without hiding custom models", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a"])).toEqual(["a", "b"]);
  });

  it("shows every built-in model while preserving unrelated hidden entries", () => {
    const models = [model("a"), model("b"), model("custom", true)];

    expect(nextHiddenModelsForBulkToggle(models, ["a", "b", "legacy", "custom"])).toEqual([
      "legacy",
      "custom",
    ]);
  });
});

describe("describeModelCapabilities", () => {
  it("reports Reasoning for Antigravity thought_level and other reasoning select descriptors", () => {
    expect(
      describeModelCapabilities({
        slug: "gemini-3.8-pro",
        name: "Gemini 3.8 Pro",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thought_level",
              label: "Thinking",
              type: "select",
              options: [
                { id: "low", label: "Low" },
                { id: "high", label: "High" },
              ],
              currentValue: "high",
            },
          ],
        },
      }),
    ).toEqual(["Reasoning"]);

    expect(
      describeModelCapabilities({
        slug: "claude-opus-5",
        name: "Claude Opus 5",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking_level",
              label: "Thinking",
              type: "select",
              options: [{ id: "high", label: "High" }],
              currentValue: "high",
            },
          ],
        },
      }),
    ).toEqual(["Reasoning"]);
  });
});
