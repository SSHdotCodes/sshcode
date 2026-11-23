import { describe, expect, it } from "vite-plus/test";

import {
  forgetUnavailableModel,
  MAX_UNAVAILABLE_MODELS,
  rememberUnavailableModel,
  UNAVAILABLE_MODEL_TTL_MS,
} from "./unavailableModels.ts";

const now = Date.parse("2026-11-16T00:00:00.000Z");
const entry = (model: string, at = now) => ({ instanceId: "opencode", model, reason: "gone", at });

describe("unavailable models", () => {
  it("keeps at most the newest entries, refreshes a repeat and drops expired ones", () => {
    let entries = rememberUnavailableModel([], entry("old", now - UNAVAILABLE_MODEL_TTL_MS), now);
    expect(entries.map((saved) => saved.model)).toEqual(["old"]);
    entries = rememberUnavailableModel(entries, entry("a"), now);
    expect(entries.map((saved) => saved.model)).toEqual(["a"]);
    for (let index = 0; index < MAX_UNAVAILABLE_MODELS + 5; index++)
      entries = rememberUnavailableModel(entries, entry(`m${index}`), now);
    expect(entries).toHaveLength(MAX_UNAVAILABLE_MODELS);
    expect(entries[0]!.model).toBe("m5");
    entries = rememberUnavailableModel(entries, entry("m5"), now);
    expect(entries.at(-1)!.model).toBe("m5");
    expect(entries).toHaveLength(MAX_UNAVAILABLE_MODELS);
  });

  it("bounds the provider's words and skips oversized ids", () => {
    const [saved] = rememberUnavailableModel(
      [],
      { ...entry("a"), reason: `  Model a\n has been deprecated. ${"x".repeat(400)}` },
      now,
    );
    expect(saved!.reason.startsWith("Model a has been deprecated.")).toBe(true);
    expect(saved!.reason).toHaveLength(200);
    expect(rememberUnavailableModel([], entry("x".repeat(300)), now)).toEqual([]);
  });

  it("forgets one model and leaves the list untouched when it was not listed", () => {
    const entries = [entry("a"), entry("b")];
    expect(forgetUnavailableModel(entries, "opencode", "a").map((saved) => saved.model)).toEqual([
      "b",
    ]);
    expect(forgetUnavailableModel(entries, "opencode", "c")).toBe(entries);
  });
});
