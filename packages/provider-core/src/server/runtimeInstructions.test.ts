import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeInstructions } from "./runtimeInstructions.ts";

describe("buildRuntimeInstructions", () => {
  it("only tells the agent that the app shows embedded images", () => {
    const instructions = buildRuntimeInstructions({ harness: "Codex" });
    expect(instructions).toMatch(/^<runtime_info>.*<\/runtime_info>$/s);
    expect(instructions).toContain("link in Markdown by absolute file path");
    expect(instructions).not.toContain("link_pull_request");
  });

  it("leaves the harness, model and effort out so the prompt matches the native app", () => {
    const instructions = buildRuntimeInstructions({
      harness: "Codex",
      model: "gpt-5.4",
      modelName: "GPT-5.4",
      reasoningEffort: "high",
    });
    expect(instructions).toBe(buildRuntimeInstructions({ harness: "Cursor" }));
    expect(instructions).not.toContain("Codex");
    expect(instructions).not.toContain("gpt-5.4");
    expect(instructions).not.toContain("reasoning effort");
  });
});
