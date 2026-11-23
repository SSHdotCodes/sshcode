import { expect, it } from "@effect/vitest";
import { QA_MODELS, qaConfigOptions } from "./qaFixture.ts";

it("advertises selectable models and default reasoning, speed and context", () => {
  expect(new Set(QA_MODELS.map((model) => model.value)).size).toBe(3);
  const options = qaConfigOptions({
    model: "qa-balanced",
    reasoning: "medium",
    fast: false,
    context: "272k",
  });
  const reasoning = options.find((option) => option.category === "thought_level");
  expect(reasoning).toMatchObject({
    type: "select",
    currentValue: "medium",
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  });
  expect(options.find((option) => option.configId === "fast")).toMatchObject({
    type: "boolean",
    currentValue: false,
  });
  expect(options.find((option) => option.configId === "context")).toMatchObject({
    currentValue: "272k",
    options: [
      { value: "272k", name: "272K" },
      { value: "1m", name: "1M" },
    ],
  });
});
