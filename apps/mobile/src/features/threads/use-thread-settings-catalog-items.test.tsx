// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: vi.fn(() => null), setItemSync: vi.fn() },
}));

import type { ModelOption } from "../../lib/modelOptions";
import { buildModelOptionMakerCatalog } from "./modelMakerCatalog";
import {
  useThreadSettingsCatalogItems,
  type ThreadSettingsCatalogRowItem,
  type ThreadSettingsCatalogSession,
} from "./use-thread-settings-catalog-items";

const NOW = Date.parse("2026-11-17T08:00:00.000Z");
const MODEL = "claude-opus-5-5";

function makeAccount(instanceId: string, displayName: string, usedPercent: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName,
    continuation: { groupKey: "claude:home:/synthetic/.claude" },
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-17T08:00:00.000Z",
    models: [{ slug: MODEL, name: "Claude Opus 5.5", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-17T08:00:00.000Z",
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          resetsAt: "2026-11-19T08:00:00.000Z",
          windowDurationMins: 10_080,
        },
      ],
    },
  };
}

function toOptions(providers: ReadonlyArray<ServerProvider>): ModelOption[] {
  return providers.map((provider) => ({
    key: `${provider.instanceId}:${MODEL}`,
    providerKey: provider.instanceId,
    providerDriver: provider.driver,
    providerLabel: provider.displayName ?? provider.driver,
    label: "Claude Opus 5.5",
    subtitle: "",
    isLegacy: false,
    isDefault: false,
    capabilities: null,
    selection: { instanceId: provider.instanceId, model: MODEL },
  }));
}

let root: Root;
let latestItems: ReadonlyArray<ThreadSettingsCatalogRowItem> = [];

function Probe({ session }: { readonly session: ThreadSettingsCatalogSession }) {
  const items = useThreadSettingsCatalogItems(session);
  useLayoutEffect(() => {
    latestItems = items;
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  latestItems = [];
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("useThreadSettingsCatalogItems", () => {
  it("updates model rows when account limits or the staged account/route change", () => {
    const first = makeAccount("claudeAgent", "Max 1", 90);
    const second = makeAccount("claudeAgent_max2", "Max 2", 10);
    const providers = [first, second];
    const allOptions = toOptions(providers);
    const catalog = buildModelOptionMakerCatalog(allOptions, { providers });

    const favoriteKeys = new Set<string>();
    const providerExpansionOverrides = new Set<string>();
    const isApplied = (option: ModelOption) => option.key === allOptions[0]!.key;
    const isDisplayed = (option: ModelOption) => option.key === allOptions[0]!.key;

    const baseSession: ThreadSettingsCatalogSession = {
      providers,
      accountSession: { now: NOW, instanceId: null, balance: true, selection: null },
      makerGroups: catalog.groups,
      providerGroups: [],
      displayedOption: null,
      routeMemory: {},
      favoriteKeys,
      isApplied,
      isDisplayed,
      manageHidden: false,
      providerExpansionOverrides,
      providerFilter: null,
      searchQuery: "",
      showLegacy: false,
    };

    act(() => root.render(<Probe session={baseSession} />));
    const initialModel = latestItems.find((item) => item.kind === "model");
    expect(initialModel?.kind === "model" && initialModel.option.selection.instanceId).toBe(
      "claudeAgent_max2",
    );

    // Switching accountSession (e.g. picking Max 1 in Runs in) must update the row immediately.
    act(() =>
      root.render(
        <Probe
          session={{
            ...baseSession,
            accountSession: { now: NOW, instanceId: "claudeAgent", balance: true, selection: null },
          }}
        />,
      ),
    );
    const afterAccountPin = latestItems.find((item) => item.kind === "model");
    expect(afterAccountPin?.kind === "model" && afterAccountPin.option.selection.instanceId).toBe(
      "claudeAgent",
    );

    // Updating provider usage limits while the sheet stays open must update the balanced route.
    const flippedProviders = [
      makeAccount("claudeAgent", "Max 1", 5),
      makeAccount("claudeAgent_max2", "Max 2", 95),
    ];
    act(() =>
      root.render(
        <Probe
          session={{
            ...baseSession,
            providers: flippedProviders,
          }}
        />,
      ),
    );
    const afterLimitsUpdate = latestItems.find((item) => item.kind === "model");
    expect(
      afterLimitsUpdate?.kind === "model" && afterLimitsUpdate.option.selection.instanceId,
    ).toBe("claudeAgent");
  });

  it("lists favorites in the order the user set, not by maker", () => {
    const claude = makeAccount("claudeAgent", "Max 1", 10);
    const codex: ServerProvider = {
      ...makeAccount("codex", "Codex Work", 10),
      driver: ProviderDriverKind.make("codex"),
      continuation: { groupKey: "codex:home:/synthetic/.codex" },
      models: [{ slug: "gpt-6.2-sol", name: "GPT-6.2-Sol", isCustom: false, capabilities: null }],
    };
    const providers = [claude, codex];
    const options: ModelOption[] = [
      ...toOptions([claude]),
      {
        ...toOptions([codex])[0]!,
        key: "codex:gpt-6.2-sol",
        label: "GPT-6.2-Sol",
        selection: { instanceId: codex.instanceId, model: "gpt-6.2-sol" },
      },
    ];
    const catalog = buildModelOptionMakerCatalog(options, { providers });
    const session = (favoriteKeys: ReadonlySet<string>): ThreadSettingsCatalogSession => ({
      providers,
      accountSession: { now: NOW, instanceId: null, balance: true, selection: null },
      makerGroups: catalog.groups,
      providerGroups: [],
      displayedOption: null,
      routeMemory: {},
      favoriteKeys,
      isApplied: () => false,
      isDisplayed: () => false,
      manageHidden: false,
      providerExpansionOverrides: new Set(),
      providerFilter: null,
      searchQuery: "",
      showLegacy: false,
    });
    const favoriteLabels = () =>
      latestItems.flatMap((item) =>
        item.kind === "model" && item.key.startsWith("favorite:") ? [item.option.label] : [],
      );

    for (const order of [
      ["claudeAgent:claude-opus-5-5", "codex:gpt-6.2-sol"],
      ["codex:gpt-6.2-sol", "claudeAgent:claude-opus-5-5"],
    ]) {
      act(() => root.render(<Probe session={session(new Set(order))} />));
      expect(favoriteLabels()).toEqual(
        order.map((key) => (key.startsWith("codex") ? "GPT-6.2-Sol" : "Claude Opus 5.5")),
      );
    }
  });
});
