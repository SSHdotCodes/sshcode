import { describe, expect, it } from "vite-plus/test";

import {
  canAddModelsTo,
  defaultModelManagerHarness,
  modelManagerRequestText,
  parseModelRef,
  unlistedSearchedModel,
} from "./modelRefs.ts";

describe("parseModelRef", () => {
  it("reads OpenRouter model pages", () => {
    expect(parseModelRef("https://openrouter.ai/tencent/hy4")).toEqual({
      source: "openrouter",
      id: "tencent/hy4",
    });
    expect(parseModelRef("openrouter.ai/qwen/qwen3.8-27b:nitro/providers")).toEqual({
      source: "openrouter",
      id: "qwen/qwen3.8-27b:nitro",
    });
    expect(parseModelRef("https://www.openrouter.ai/tencent/hy4?tab=api")).toEqual({
      source: "openrouter",
      id: "tencent/hy4",
    });
  });

  it("rejects OpenRouter pages that are not models", () => {
    expect(parseModelRef("https://openrouter.ai/models?q=hy4")).toBeNull();
    expect(parseModelRef("https://openrouter.ai/docs/quickstart")).toBeNull();
    expect(parseModelRef("https://openrouter.ai/tencent")).toBeNull();
  });

  it("reads Hugging Face model repos", () => {
    expect(parseModelRef("https://huggingface.co/Qwen/Qwen3.8-27B/tree/main")).toEqual({
      source: "huggingface",
      id: "Qwen/Qwen3.8-27B",
    });
    expect(parseModelRef("https://huggingface.co/datasets/foo/bar")).toBeNull();
  });

  it("reads bare ids and openrouter-prefixed ids", () => {
    expect(parseModelRef("tencent/hy4")).toEqual({ source: "id", id: "tencent/hy4" });
    expect(parseModelRef("openrouter/tencent/hy4")).toEqual({
      source: "openrouter",
      id: "tencent/hy4",
    });
  });

  it("ignores ordinary searches", () => {
    expect(parseModelRef("sonnet")).toBeNull();
    expect(parseModelRef("gpt 6")).toBeNull();
    expect(parseModelRef("a/b/c/d")).toBeNull();
    expect(parseModelRef("https://example.com/tencent/hy4")).toBeNull();
  });
});

describe("model manager helpers", () => {
  const harnesses = [
    { instanceId: "codex", driver: "codex", enabled: true },
    { instanceId: "opencode", driver: "opencode", enabled: true },
    { instanceId: "pi", driver: "pi", enabled: false },
    { instanceId: "cursor", driver: "cursor", enabled: false },
  ];

  it("offers local harnesses that are on, plus Pi and OpenCode when off", () => {
    expect(harnesses.filter(canAddModelsTo).map((harness) => harness.instanceId)).toEqual([
      "codex",
      "opencode",
      "pi",
    ]);
  });

  it("starts with the browsed harness, else the first general one that is on", () => {
    const offered = harnesses.filter(canAddModelsTo);
    expect(defaultModelManagerHarness(offered, "pi")).toBe("pi");
    expect(defaultModelManagerHarness(offered, null)).toBe("opencode");
    expect(defaultModelManagerHarness([], null)).toBeNull();
  });

  it("asks to add a pasted model and passes other requests through", () => {
    expect(modelManagerRequestText(" https://openrouter.ai/tencent/hy4 ")).toBe(
      "Add https://openrouter.ai/tencent/hy4",
    );
    expect(modelManagerRequestText("remove hy4 from pi")).toBe("remove hy4 from pi");
  });

  it("names a searched model only when no harness lists it", () => {
    expect(unlistedSearchedModel("openrouter.ai/tencent/hy4", ["gpt-6.1-terra"])).toEqual({
      ref: { source: "openrouter", id: "tencent/hy4" },
      query: "openrouter.ai/tencent/hy4",
    });
    expect(
      unlistedSearchedModel("openrouter.ai/tencent/hy4", ["openrouter/tencent/hy4"]),
    ).toBeNull();
    expect(unlistedSearchedModel("sonnet", [])).toBeNull();
  });
});
