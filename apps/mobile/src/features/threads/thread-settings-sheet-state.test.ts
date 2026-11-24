import { describe, expect, it } from "vite-plus/test";

import { ProviderInstanceId, type ProviderOptionSelection } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import {
  canCommitPendingModel,
  favoritesFirst,
  modelMatchesCatalogQuery,
  orderFavoriteRows,
  pendingModelAfterPress,
  providerSectionIsCollapsed,
  threadSettingsListItems,
} from "./thread-settings-sheet-state";

function modelOption(
  model: string,
  options: ReadonlyArray<ProviderOptionSelection> = [],
): ModelOption {
  return {
    key: `codex:${model}`,
    label: model,
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: null,
    selection: {
      instanceId: ProviderInstanceId.make("codex"),
      model,
      options,
    },
  };
}

describe("thread settings sheet state", () => {
  const catalogItems = [
    { kind: "provider", key: "provider:openai" },
    { kind: "model", key: "model:gpt-next" },
    { kind: "provider", key: "provider:anthropic" },
    { kind: "model", key: "model:claude-next" },
    { kind: "studio", key: "studio" },
    { kind: "modelManager", key: "modelManager" },
  ];

  it("puts current model options before the entire catalog when browsing", () => {
    expect(threadSettingsListItems(catalogItems, "")).toEqual([
      { kind: "options", key: "options" },
      ...catalogItems,
      { kind: "catalogSettings", key: "catalogSettings" },
    ]);
  });

  it("leads with results and hides current model options during a search", () => {
    const results = catalogItems.slice(0, 2);

    expect(threadSettingsListItems(results, "gpt")).toEqual([
      ...results,
      { kind: "catalogSettings", key: "catalogSettings" },
    ]);
  });

  it("keeps current model options accessible when no catalog models are available", () => {
    expect(threadSettingsListItems([{ kind: "empty", key: "empty" }], "   ")).toEqual([
      { kind: "options", key: "options" },
      { kind: "empty", key: "empty" },
      { kind: "catalogSettings", key: "catalogSettings" },
    ]);
  });

  it("keeps favorites in catalog order ahead of other models", () => {
    const models = [
      modelOption("first"),
      modelOption("second"),
      modelOption("third"),
      modelOption("fourth"),
    ];
    const favorites = new Set([models[2]!.key, models[0]!.key]);

    expect(favoritesFirst(models, favorites).map((model) => model.selection.model)).toEqual([
      "first",
      "third",
      "second",
      "fourth",
    ]);
    expect(models.map((model) => model.selection.model)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ]);
  });

  it("orders favorite rows by the saved stars even when a row displays another route", () => {
    const gpt = modelOption("gpt-next");
    const claude = modelOption("claude-next");
    const claudeAlternate = { ...claude, key: "claudeAgent_max2:claude-next" };
    const rows = [{ option: gpt }, { option: claude, routes: [claudeAlternate] }];

    expect(orderFavoriteRows(rows, new Set([claudeAlternate.key, gpt.key]))).toEqual([
      rows[1],
      rows[0],
    ]);
    expect(orderFavoriteRows(rows, new Set([gpt.key, claudeAlternate.key]))).toEqual(rows);
  });

  it("matches visible model and provider terms", () => {
    const model = modelOption("gpt-next");

    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "NEXT" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "codex" })).toBe(true);
    expect(modelMatchesCatalogQuery({ model, providerLabel: "Codex", query: "claude" })).toBe(
      false,
    );
  });

  it("matches every typed word across name, id and maker, ignoring separators", () => {
    const model = {
      ...modelOption("opencode/inkling-2-small-free"),
      label: "Inkling 2 Small Free",
    };
    const label = "Thinking Machines OpenCode Zen";
    const matches = (query: string) =>
      modelMatchesCatalogQuery({ model, providerLabel: label, query });

    expect(matches("inkling 2 small")).toBe(true);
    expect(matches("small inkling")).toBe(true);
    expect(matches("thinking machines")).toBe(true);
    expect(matches("inkling2")).toBe(true);
    expect(matches("inkling 3")).toBe(false);
  });

  it("finds a listed model from its pasted OpenRouter page", () => {
    const model = modelOption("openrouter/tencent/hy4");

    expect(
      modelMatchesCatalogQuery({
        model,
        providerLabel: "OpenCode",
        query: "https://openrouter.ai/tencent/hy4",
      }),
    ).toBe(true);
    expect(
      modelMatchesCatalogQuery({
        model: modelOption("gpt-next"),
        providerLabel: "OpenCode",
        query: "https://openrouter.ai/tencent/hy4",
      }),
    ).toBe(false);
  });

  it("treats whitespace-only catalog searches as empty", () => {
    expect(
      modelMatchesCatalogQuery({
        model: modelOption("gpt-next"),
        providerLabel: "Codex",
        query: "   ",
      }),
    ).toBe(true);
  });

  it("matches the upstream provider's display name", () => {
    const model = {
      ...modelOption("opencode/claude-fable-5"),
      label: "Claude Fable 5",
      subtitle: "OpenCode Zen",
    };

    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: " ZEN " })).toBe(
      true,
    );
    expect(modelMatchesCatalogQuery({ model, providerLabel: "OpenCode", query: "copilot" })).toBe(
      false,
    );
  });

  it("clears staging when the applied model is pressed", () => {
    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed: modelOption("gpt-current"),
        pressedIsApplied: true,
      }),
    ).toBeNull();
  });

  it("preserves staged options when the highlighted model is pressed again", () => {
    const pending = modelOption("gpt-next", [{ id: "effort", value: "high" }]);

    expect(
      pendingModelAfterPress({
        current: pending,
        pressed: modelOption("gpt-next"),
        pressedIsApplied: false,
      }),
    ).toBe(pending);
  });

  it("stages a different model", () => {
    const pressed = modelOption("gpt-other");

    expect(
      pendingModelAfterPress({
        current: modelOption("gpt-next"),
        pressed,
        pressedIsApplied: false,
      }),
    ).toBe(pressed);
  });

  it("cannot select a hidden model exposed only for visibility management", () => {
    const pending = modelOption("gpt-next");
    expect(
      canCommitPendingModel(pending, [
        { providerKey: "codex", providerLabel: "Codex", models: [{ ...pending, isHidden: true }] },
      ]),
    ).toBe(false);
  });

  it("cannot save a staged model after sign-out removes it from the catalog", () => {
    const pending = modelOption("gemini-native");
    const group = { providerKey: "codex", providerLabel: "Codex", models: [pending] };

    expect(canCommitPendingModel(pending, [group])).toBe(true);
    expect(canCommitPendingModel(pending, [])).toBe(false);
    expect(
      canCommitPendingModel(pending, [
        {
          ...group,
          models: [{ ...pending, isUnavailable: true }],
        },
      ]),
    ).toBe(false);
  });
});

describe("provider disclosure", () => {
  it("keeps a default-collapsed section closed until expanded", () => {
    expect(
      providerSectionIsCollapsed({
        defaultExpanded: false,
        hasExpansionOverride: false,
        isNarrowed: false,
      }),
    ).toBe(true);
    expect(
      providerSectionIsCollapsed({
        defaultExpanded: false,
        hasExpansionOverride: true,
        isNarrowed: false,
      }),
    ).toBe(false);
  });

  it("opens matching results while searching, then respects the disclosure choice", () => {
    expect(
      providerSectionIsCollapsed({
        defaultExpanded: false,
        hasExpansionOverride: false,
        isNarrowed: true,
      }),
    ).toBe(false);
    expect(
      providerSectionIsCollapsed({
        defaultExpanded: true,
        hasExpansionOverride: true,
        isNarrowed: false,
      }),
    ).toBe(true);
  });
});
