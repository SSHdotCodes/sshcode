import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import {
  indexModelFamilies,
  adjacentModelPickerProvider,
  modelPickerEmptyState,
  resolveModelPickerSelectedModel,
  shouldIncludeModelPickerOption,
  shouldOfferModelPickerSetup,
} from "./ModelPickerContent";

function entry(status: ServerProvider["status"], driver = "opencode") {
  return deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make(`${driver}_work`),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      version: null,
      status,
      auth: { status: "authenticated" },
      checkedAt: "2026-08-28T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ])[0]!;
}

describe("shouldIncludeModelPickerOption", () => {
  it.each(["ready", "error"] as const)(
    "never offers the internal Antigravity default marker as a model when %s",
    (status) => {
      const providerEntry = entry(status, "antigravity");
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: ANTIGRAVITY_DEFAULT_MODEL,
            name: ANTIGRAVITY_DEFAULT_MODEL,
            isUnavailable: true,
          },
          activeInstanceId: providerEntry.instanceId,
          activeModel: ANTIGRAVITY_DEFAULT_MODEL,
        }),
      ).toBe(false);
    },
  );

  it.each([
    ["opencode", "error"],
    ["opencode", "warning"],
    ["antigravity", "error"],
    ["antigravity", "warning"],
  ] as const)(
    "keeps only the active synthetic %s row when the provider status is %s",
    (driver, status) => {
      const providerEntry = entry(status, driver);
      const activeInstanceId = providerEntry.instanceId;
      const activeModel = "missing-model";

      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: activeModel,
            name: activeModel,
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(true);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: "stale/model", name: "Stale model" },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: {
            slug: "other/missing",
            name: "Other missing",
            isUnavailable: true,
          },
          activeInstanceId,
          activeModel,
        }),
      ).toBe(false);
      expect(
        shouldIncludeModelPickerOption({
          entry: providerEntry,
          option: { slug: activeModel, name: activeModel, isUnavailable: true },
          activeInstanceId: ProviderInstanceId.make(`${driver}_personal`),
          activeModel,
        }),
      ).toBe(false);
    },
  );
});

describe("resolveModelPickerSelectedModel", () => {
  it("follows the catalog default for the marker but keeps an explicit native model", () => {
    const driverKind = ProviderDriverKind.make("antigravity");
    const previousOptions = [
      { slug: "gemini-fast", name: "Gemini Fast", aliases: [ANTIGRAVITY_DEFAULT_MODEL] },
      { slug: "gemini-pro", name: "Gemini Pro" },
    ];
    const nextOptions = [
      { slug: "gemini-fast", name: "Gemini Fast" },
      { slug: "gemini-pro", name: "Gemini Pro", aliases: [ANTIGRAVITY_DEFAULT_MODEL] },
    ];

    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: previousOptions,
      })?.slug,
    ).toBe("gemini-fast");
    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: nextOptions,
      })?.slug,
    ).toBe("gemini-pro");
    expect(
      resolveModelPickerSelectedModel({
        driverKind,
        model: "gemini-fast",
        options: nextOptions,
      })?.slug,
    ).toBe("gemini-fast");
  });

  it("does not guess the default from the first model in a catalog", () => {
    expect(
      resolveModelPickerSelectedModel({
        driverKind: ProviderDriverKind.make("antigravity"),
        model: ANTIGRAVITY_DEFAULT_MODEL,
        options: [{ slug: "gemini-fast", name: "Gemini Fast" }],
      }),
    ).toBeUndefined();
  });
});

describe("shouldOfferModelPickerSetup", () => {
  const availableModel = { slug: "gemini-3.1-pro", name: "Gemini 3.1 Pro" };

  it("offers setup before an Antigravity account has models", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "antigravity"), [])).toBe(true);
  });

  it("offers setup after sign-out even if a model remains cached", () => {
    const providerEntry = entry("ready", "antigravity");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: { ...providerEntry.snapshot, auth: { status: "unauthenticated" } },
        },
        [availableModel],
      ),
    ).toBe(true);
  });

  it("offers setup when the only model is an unavailable saved selection", () => {
    expect(
      shouldOfferModelPickerSetup(entry("ready", "antigravity"), [
        { ...availableModel, isUnavailable: true },
      ]),
    ).toBe(true);
  });

  it("does not offer setup for a ready account with available models", () => {
    expect(shouldOfferModelPickerSetup(entry("ready", "antigravity"), [availableModel])).toBe(
      false,
    );
  });

  it("does not restore a disabled provider while its status snapshot is stale", () => {
    expect(
      shouldOfferModelPickerSetup({ ...entry("error", "antigravity"), enabled: false }, []),
    ).toBe(false);
  });

  it("keeps providers without integrated setup on their existing path", () => {
    expect(shouldOfferModelPickerSetup(entry("error", "codex"), [])).toBe(false);
  });

  it("uses the environment's setup capability for other drivers", () => {
    const providerEntry = entry("error", "custom_driver");
    expect(
      shouldOfferModelPickerSetup(
        {
          ...providerEntry,
          snapshot: {
            ...providerEntry.snapshot,
            setup: { canAuthenticate: true, canInstall: false },
          },
        },
        [],
      ),
    ).toBe(true);
  });
});

describe("adjacentModelPickerProvider", () => {
  const rails = ["favorites", "maker:openai", "maker:anthropic"] as const;

  it("wraps through favorites and makers in rail order", () => {
    expect(adjacentModelPickerProvider({ rails, selected: "maker:openai", direction: 1 })).toBe(
      "maker:anthropic",
    );
    expect(adjacentModelPickerProvider({ rails, selected: "favorites", direction: -1 })).toBe(
      "maker:anthropic",
    );
    expect(adjacentModelPickerProvider({ rails, selected: "maker:anthropic", direction: 1 })).toBe(
      "favorites",
    );
  });

  it("handles an empty rail and a maker that left it", () => {
    expect(
      adjacentModelPickerProvider({ rails: [], selected: "maker:openai", direction: -1 }),
    ).toBe("favorites");
    expect(adjacentModelPickerProvider({ rails, selected: "maker:qwen", direction: 1 })).toBe(
      "favorites",
    );
    expect(adjacentModelPickerProvider({ rails, selected: "maker:qwen", direction: -1 })).toBe(
      "maker:anthropic",
    );
  });
});

describe("model picker empty states", () => {
  it("distinguishes a search miss from a provider with no models", () => {
    expect(modelPickerEmptyState(true, false)).toEqual({
      title: "No matching models",
      description: "Try a shorter name or another provider.",
    });
    expect(modelPickerEmptyState(false, false).description).toContain("Settings → Providers");
  });

  it("explains how to add favorites and treats a search miss separately", () => {
    expect(modelPickerEmptyState(false, true)).toEqual({
      title: "No favorite models",
      description: "Star a model to keep it here.",
    });
    expect(modelPickerEmptyState(true, true).title).toBe("No matching models");
  });
});

describe("model family index", () => {
  it("preserves first-match, missing and duplicate-slug families", () => {
    const models = [
      { slug: "a", family: undefined },
      { slug: "a", family: "later" },
      { slug: "b", family: "b-family" },
    ];
    const index = indexModelFamilies(models);
    for (const slug of ["a", "b", "missing"])
      expect(index.get(slug)).toBe(models.find((model) => model.slug === slug)?.family);
    const catalog = Array.from({ length: 5_000 }, (_, i) => ({
      slug: `model-${i}`,
      family: `family-${i % 8}`,
    }));
    const start = performance.now();
    const before = catalog.map(
      (option) => catalog.find((model) => model.slug === option.slug)?.family,
    );
    const middle = performance.now();
    const families = indexModelFamilies(catalog);
    const after = catalog.map((option) => families.get(option.slug));
    const end = performance.now();
    expect(after).toEqual(before);
    console.info("model families:5000 before/after (ms)", middle - start, end - middle);
  });
});
