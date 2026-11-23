import { describe, expect, it } from "vite-plus/test";

import { modelGeneration } from "./modelGenerations.ts";

describe("modelGeneration", () => {
  it.each([
    ["gemini", "gemini-3.1-pro Gemini 3.1 Pro Preview", undefined, "gemini-flagship-3.1"],
    ["gemini", "gemini-4-argon", undefined, "gemini-flagship-4"],
    ["gemini", "gemini-4 Gemini 4", "argon", "gemini-flagship-4"],
    ["deepseek", "deepseek-v4-pro-0813 DeepSeek V4 Pro", undefined, "deepseek-model-4"],
    ["deepseek", "deepseek-v4.1-flash-1017", undefined, "deepseek-model-4.1"],
    ["deepseek", "deepseek-v4-1-flash", undefined, "deepseek-model-4-1"],
    ["deepseek", "deepseek/deepseek-chat DeepSeek Chat", undefined, "deepseek-model-1"],
    ["deepseek", "deepseek/deepseek-r1-0528 DeepSeek R1 0528", undefined, "deepseek-model-1"],
    ["deepseek", "deepseek/deepseek-chat-v3-0324 DeepSeek V3 0324", undefined, "deepseek-model-3"],
    ["deepseek", "~deepseek/deepseek-pro-latest DeepSeek Pro Latest", undefined, null],
    ["glm", "glm-5-3", undefined, "glm-model-5-3"],
    ["glm", "glm-4-9b-chat", undefined, "glm-model-4"],
    [
      "mistral",
      "mistral-small-24b-instruct-2501 Mistral Small 3",
      undefined,
      "mistral-mistral-small-3",
    ],
    ["mistral", "mistral-small-2603 Mistral Small 4", undefined, "mistral-mistral-small-4"],
    ["inkling", "inkling", undefined, "inkling-model-1"],
    ["codex", "gpt-6.1-sol", undefined, null],
  ] as const)("%s: %s", (maker, text, line, expected) => {
    expect(modelGeneration(maker, text, line)).toBe(expected);
  });
});
