import { ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { resolveNewChatModelSelection } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import {
  fallbackHarnessDefaults,
  harnessDefaultsFromProviders,
} from "./harnessDefaultsFromProviders";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claudeAgent");
const effort = (currentValue: string, nativeValue: string) => ({
  optionDescriptors: [
    {
      id: "effort",
      type: "select",
      currentValue,
      nativeValue,
      options: [{ id: "low" }, { id: "high" }, { id: "max" }],
    },
  ],
});

// The snapshot a server sends after applying `defaultHarness: claude` and a
// Codex model and effort override on top of each harness's native config.
const providers = [
  {
    instanceId: codex,
    enabled: true,
    installed: true,
    nativeModelDefaults: { model: "native" },
    models: [
      { slug: "native", capabilities: effort("low", "high") },
      { slug: "pinned", isDefault: true, capabilities: effort("low", "max") },
    ],
  },
  {
    instanceId: claude,
    enabled: true,
    installed: true,
    isHarnessDefault: true,
    nativeModelDefaults: { model: "sonnet" },
    models: [
      { slug: "sonnet", isDefault: true, capabilities: effort("high", "high") },
      { slug: "opus", capabilities: effort("high", "high") },
    ],
  },
] as unknown as ReadonlyArray<ServerProvider>;

describe("harnessDefaultsFromProviders", () => {
  it("reads the explicit harness, model and options back out of the provider snapshot", () => {
    expect(harnessDefaultsFromProviders(providers)).toEqual({
      defaultHarness: claude,
      harnesses: { [codex]: { model: "pinned", options: { effort: "low" } } },
    });
  });

  it("keeps the explicit harness ahead of last used before the defaults stream arrives", () => {
    const history = {
      stickyActiveProvider: codex,
      stickyModelSelectionByProvider: { [codex]: { instanceId: codex, model: "native" } },
    };
    expect(resolveNewChatModelSelection({ providers, ...history })?.instanceId).toBe(codex);
    expect(
      resolveNewChatModelSelection({
        providers,
        ...history,
        harnessDefaults: harnessDefaultsFromProviders(providers),
      })?.instanceId,
    ).toBe(claude);
  });

  it("finds nothing explicit on a server without in-app defaults", () => {
    const native = providers.map((provider) =>
      Object.fromEntries(
        Object.entries(provider).filter(
          ([key]) => key !== "isHarnessDefault" && key !== "nativeModelDefaults",
        ),
      ),
    );
    expect(
      harnessDefaultsFromProviders(native as unknown as ReadonlyArray<ServerProvider>),
    ).toEqual({
      harnesses: {},
    });
  });

  it("keeps a remembered choice of the native default while the server still applies it", () => {
    const remembered = {
      defaultHarness: claude,
      harnesses: { [claude]: { model: "sonnet" }, [codex]: { options: { effort: "low" } } },
    };
    expect(fallbackHarnessDefaults(providers, remembered)).toEqual({
      defaultHarness: claude,
      harnesses: {
        [claude]: { model: "sonnet" },
        [codex]: { model: "pinned", options: { effort: "low" } },
      },
    });
  });

  it("drops a remembered choice the server no longer applies", () => {
    const remembered = { harnesses: { [claude]: { model: "opus" } } };
    expect(fallbackHarnessDefaults(providers, remembered).harnesses[claude]).toBeUndefined();
  });
});
