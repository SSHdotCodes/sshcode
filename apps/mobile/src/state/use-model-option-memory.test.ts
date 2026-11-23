import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { appAtomRegistry } from "./atom-registry";
import { modelOptionMemoryAtom } from "./use-composer-drafts";
import {
  rememberModelOptions,
  rememberedModelOptions,
  withRememberedModelOptions,
} from "./use-model-option-memory";

// The draft store reaches the pending-send outbox, whose ids come from expo-crypto.
vi.mock("../lib/uuid", () => ({ uuidv4: () => "uuid", randomHex: () => "0000" }));

const XHIGH = [{ id: "thinking", value: "xhigh" }] as const;
const HIGH = [{ id: "thinking", value: "high" }] as const;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  appAtomRegistry.set(modelOptionMemoryAtom, {});
});

describe("model option memory state", () => {
  it("records and looks up options per instance and model", () => {
    rememberModelOptions("codex", "gpt-5.3-codex", [...XHIGH]);
    rememberModelOptions("codex", "gpt-5.4", [...HIGH]);
    expect(rememberedModelOptions("codex", "gpt-5.3-codex")).toEqual(XHIGH);
    expect(rememberedModelOptions("codex", "gpt-5.4")).toEqual(HIGH);
    expect(rememberedModelOptions("pi", "gpt-5.3-codex")).toBeUndefined();
  });

  it("ignores empty option sets when recording", () => {
    rememberModelOptions("codex", "gpt-5.4", []);
    expect(rememberedModelOptions("codex", "gpt-5.4")).toBeUndefined();
  });
});

describe("withRememberedModelOptions", () => {
  it.each([true, false])(
    "saves a staged Fast %s above a conflicting remembered choice",
    (value) => {
      rememberModelOptions("claude", "opus", [{ id: "fastMode", value: !value }]);
      const options = [{ id: "fastMode", value }];
      expect(withRememberedModelOptions({ instanceId: "claude", model: "opus" }, options)).toEqual({
        instanceId: "claude",
        model: "opus",
        options,
      });
    },
  );
  it("restores Fast per model across switches and remembers an explicit Off", () => {
    rememberModelOptions("codex", "gpt", [{ id: "serviceTier", value: "priority" }]);
    rememberModelOptions("claude", "opus", [{ id: "fastMode", value: true }]);
    expect(
      withRememberedModelOptions({ instanceId: "codex", model: "gpt", options: undefined }).options,
    ).toEqual([{ id: "serviceTier", value: "priority" }]);
    expect(
      withRememberedModelOptions({ instanceId: "claude", model: "opus", options: undefined })
        .options,
    ).toEqual([{ id: "fastMode", value: true }]);
    rememberModelOptions("codex", "gpt", [{ id: "serviceTier", value: "default" }]);
    rememberModelOptions("claude", "opus", [{ id: "fastMode", value: false }]);
    expect(
      withRememberedModelOptions({ instanceId: "codex", model: "gpt", options: undefined }).options,
    ).toEqual([{ id: "serviceTier", value: "default" }]);
    expect(
      withRememberedModelOptions({ instanceId: "claude", model: "opus", options: undefined })
        .options,
    ).toEqual([{ id: "fastMode", value: false }]);
  });
  it("restores the remembered options over descriptor defaults", () => {
    rememberModelOptions("codex", "gpt-5.3-codex", [...XHIGH]);
    expect(
      withRememberedModelOptions({
        instanceId: "codex",
        model: "gpt-5.3-codex",
        options: [{ id: "reasoningEffort", value: "low" }],
      }),
    ).toEqual({ instanceId: "codex", model: "gpt-5.3-codex", options: XHIGH });
  });

  it("keeps incoming selections that already match memory", () => {
    rememberModelOptions("pi", "xai/grok-4.6", [...XHIGH]);
    const selection = { instanceId: "pi", model: "xai/grok-4.6", options: [...XHIGH] };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });

  it("keeps incoming selections when nothing is remembered", () => {
    const selection = { instanceId: "pi", model: "openai-codex/gpt-5.6-sol" };
    expect(withRememberedModelOptions(selection)).toBe(selection);
  });
});
