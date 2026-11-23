import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { HarnessDefaultsPatch, HarnessDefaultsState } from "./harnessDefaults.ts";

const state = Schema.decodeUnknownSync(HarnessDefaultsState);
const patch = Schema.decodeUnknownSync(HarnessDefaultsPatch);

describe("harness defaults contracts", () => {
  it("accepts native-config defaults and per-instance model/option overrides", () => {
    expect(state({ harnesses: {} })).toEqual({ harnesses: {} });
    expect(
      state({
        defaultHarness: "codex",
        harnesses: { codex: { model: "gpt-6.1-sol", options: { reasoningEffort: "high" } } },
      }),
    ).toMatchObject({ defaultHarness: "codex" });
  });
  it("supports field resets, option resets and harness resets in patches", () => {
    expect(
      patch({
        defaultHarness: null,
        harnesses: { codex: { model: null, options: { reasoningEffort: null } }, claude: null },
      }),
    ).toMatchObject({ defaultHarness: null });
  });
  it("rejects malformed persisted values and empty model/option names", () => {
    for (const value of [
      { harnesses: { codex: { options: { effort: 3 } } } },
      { harnesses: { codex: { model: " " } } },
      { defaultHarness: "", harnesses: {} },
    ]) {
      expect(() => state(value)).toThrow();
    }
  });
});
