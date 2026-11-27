import { expect, it } from "@effect/vitest";

import { analyticsModelLabel } from "./ModelLabel.ts";

it("reports catalog models by slug and anything else as custom:<driver>", () => {
  expect(analyticsModelLabel("claudeAgent", "claude-opus-5-5")).toBe("claude-opus-5-5");
  expect(analyticsModelLabel("opencode", "anthropic/claude-opus-5-5")).toBe("claude-opus-5-5");
  expect(analyticsModelLabel("claudeAgent", "claude-opus-5-5-20261101")).toBe("claude-opus-5-5");
  expect(analyticsModelLabel("claudeAgent", "my-private-finetune")).toBe("custom:claudeAgent");
  expect(analyticsModelLabel("opencode", "ollama/acme-internal")).toBe("custom:opencode");
  expect(analyticsModelLabel("pi", "/Users/someone/models/local.gguf")).toBe("custom:pi");
});
