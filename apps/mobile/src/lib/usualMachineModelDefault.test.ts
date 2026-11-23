import {
  ProviderInstanceId,
  type ModelSelection,
  type ProviderOptionSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { resolveNewChatModelSelection } from "@t3tools/shared/projectSettings";
import { describe, expect, it } from "vite-plus/test";

import { borrowDefaultModelSelection, withDefaultModelSelection } from "./usualMachineModelDefault";

const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");

const effort = (currentValue: string) => ({
  optionDescriptors: [
    {
      id: "effort",
      type: "select",
      currentValue,
      options: [{ id: "low" }, { id: "medium" }, { id: "high" }, { id: "xhigh" }],
    },
  ],
});

function claudeProvider(instanceId: string, defaultEffort: string) {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: "claudeAgent",
    enabled: true,
    installed: true,
    models: [
      { slug: "claude-opus-5-5", isDefault: true, capabilities: effort(defaultEffort) },
      { slug: "claude-sonnet-5-5", capabilities: effort(defaultEffort) },
    ],
  };
}

const codexProvider = {
  instanceId: codex,
  driver: "codex",
  enabled: true,
  installed: true,
  models: [{ slug: "gpt-6", isDefault: true, capabilities: effort("medium") }],
};

const macDefault: ModelSelection = {
  instanceId: claude,
  model: "claude-opus-5-5",
  options: [{ id: "effort", value: "xhigh" }],
};

const mac = {
  providers: [claudeProvider("claudeAgent", "xhigh")] as unknown as ReadonlyArray<ServerProvider>,
  settings: { defaultModelSelection: macDefault, providerInstances: {} },
};

// Studio has no default of its own, and its Claude Code starts on medium effort.
const studio = {
  providers: [
    claudeProvider("claudeAgent", "medium"),
    codexProvider,
  ] as unknown as ReadonlyArray<ServerProvider>,
};

/** What a new chat on `target` starts on, the way the new-chat sheet resolves it. */
function newChatOn(
  target: { readonly providers: ReadonlyArray<ServerProvider> },
  history: {
    readonly stickyActiveProvider?: ProviderInstanceId;
    readonly stickyModelSelectionByProvider?: Partial<Record<ProviderInstanceId, ModelSelection>>;
    readonly stickyOptionsByModelByProvider?: Partial<
      Record<ProviderInstanceId, Partial<Record<string, ReadonlyArray<ProviderOptionSelection>>>>
    >;
  } = {},
) {
  const borrowed = borrowDefaultModelSelection(mac, target);
  return resolveNewChatModelSelection({
    providers: withDefaultModelSelection(target.providers, borrowed),
    fallbackSelection: borrowed,
    ...history,
  });
}

describe("borrowDefaultModelSelection", () => {
  it("carries the usual machine's model and effort to a machine with the same harness", () => {
    expect(borrowDefaultModelSelection(mac, studio)).toEqual(macDefault);
  });

  it("follows the harness kind when the machine names its instance differently", () => {
    const renamed = {
      providers: [
        claudeProvider("claude_studio", "medium"),
      ] as unknown as ReadonlyArray<ServerProvider>,
    };
    expect(borrowDefaultModelSelection(mac, renamed)).toEqual({
      ...macDefault,
      instanceId: ProviderInstanceId.make("claude_studio"),
    });
  });

  it("borrows nothing a machine does not offer, and only the options it does", () => {
    expect(
      borrowDefaultModelSelection(mac, {
        providers: [codexProvider] as unknown as ReadonlyArray<ServerProvider>,
      }),
    ).toBeNull();
    expect(
      borrowDefaultModelSelection(
        {
          ...mac,
          settings: {
            ...mac.settings,
            defaultModelSelection: { ...macDefault, model: "claude-mythos" },
          },
        },
        studio,
      ),
    ).toBeNull();
    expect(
      borrowDefaultModelSelection(
        {
          ...mac,
          settings: {
            ...mac.settings,
            defaultModelSelection: {
              ...macDefault,
              options: [
                { id: "effort", value: "max" },
                { id: "thinking", value: "on" },
              ],
            },
          },
        },
        studio,
      ),
    ).toEqual({ instanceId: claude, model: "claude-opus-5-5" });
    expect(
      borrowDefaultModelSelection(
        { ...mac, settings: { ...mac.settings, defaultModelSelection: null } },
        studio,
      ),
    ).toBeNull();
  });
});

describe("a new chat on a machine without its own default", () => {
  it("starts on the usual machine's default instead of the machine's own medium effort", () => {
    expect(
      resolveNewChatModelSelection({ providers: studio.providers, fallbackSelection: null }),
    ).toBeNull();
    expect(newChatOn(studio)).toEqual(macDefault);
  });

  it("keeps the usual machine's effort when this device last used the same model", () => {
    expect(
      newChatOn(studio, {
        stickyActiveProvider: claude,
        stickyModelSelectionByProvider: {
          [claude]: { instanceId: claude, model: "claude-opus-5-5" },
        },
      }),
    ).toEqual(macDefault);
  });

  it("lets the device's own choices win", () => {
    // An effort chosen on this device for the model.
    expect(
      newChatOn(studio, {
        stickyActiveProvider: claude,
        stickyOptionsByModelByProvider: {
          [claude]: { "claude-opus-5-5": [{ id: "effort", value: "high" }] },
        },
      }),
    ).toEqual({
      instanceId: claude,
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    // A harness this device last used.
    expect(
      newChatOn(studio, {
        stickyActiveProvider: codex,
        stickyModelSelectionByProvider: { [codex]: { instanceId: codex, model: "gpt-6" } },
      }),
    ).toEqual({ instanceId: codex, model: "gpt-6", options: [{ id: "effort", value: "medium" }] });
  });
});
