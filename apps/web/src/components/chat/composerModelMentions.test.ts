import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerModelItems } from "./composerModelMentions";
import type { ModelEsque } from "./providerIconUtils";

const traex = {
  snapshot: {
    instanceId: ProviderInstanceId.make("traex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    auth: { status: "authenticated" as const },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
  instanceId: ProviderInstanceId.make("traex"),
  driverKind: ProviderDriverKind.make("codex"),
  displayName: "Traex",
  acpRegistryAgentId: undefined,
  acpRegistryIconUrl: undefined,
  continuationGroupKey: undefined,
  enabled: true,
  isAvailable: true,
  status: "ready" as const,
};
const opencode = {
  ...traex,
  instanceId: ProviderInstanceId.make("opencode"),
  driverKind: ProviderDriverKind.make("opencode"),
  displayName: "OpenCode",
};
const claude = {
  ...traex,
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driverKind: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
};

const modelOptionsByInstance = new Map<ProviderInstanceId, ReadonlyArray<ModelEsque>>([
  [
    traex.instanceId,
    [
      { slug: "gpt-6.1", name: "GPT-6.1" },
      { slug: "gpt-5", name: "GPT-5", isLegacy: true },
    ],
  ],
  [
    opencode.instanceId,
    [
      { slug: "traex/gpt-6.1", name: "GPT-6.1", subProvider: "Traex" },
      { slug: "anthropic/opus", name: "Claude Opus 5.5", subProvider: "Anthropic" },
    ],
  ],
  [claude.instanceId, [{ slug: "claude-opus-5-5", name: "Claude Opus 5.5" }]],
]);

function match(
  query: string,
  overrides: Partial<Parameters<typeof matchComposerModelItems>[0]> = {},
): string[] {
  const options = overrides.modelOptionsByInstance ?? modelOptionsByInstance;
  return matchComposerModelItems({
    query,
    ...overrides,
    modelOptionsByInstance: options,
    instanceEntries: (overrides.instanceEntries ?? [traex, opencode, claude]).map((entry) => ({
      ...entry,
      snapshot: {
        ...entry.snapshot,
        instanceId: entry.instanceId,
        driver: entry.driverKind,
        status: entry.status,
        enabled: entry.enabled,
        models: (options.get(entry.instanceId) ?? []).map((model) => ({
          ...model,
          isCustom: false,
          capabilities: {},
        })),
      },
    })),
  }).map((item) => `${item.instanceId}:${item.model}`);
}

describe("matchComposerModelItems", () => {
  it("uses the picker's native route and skips legacy and hidden routes", () => {
    expect(match("gpt")).toEqual(["traex:gpt-6.1"]);
  });

  it("leaves out providers that are not ready and routes hidden by the picker", () => {
    expect(
      match("gpt", { instanceEntries: [{ ...traex, status: "error" as const }, opencode] }),
    ).toEqual([]);
  });
});

describe("fork model catalogs", () => {
  it("does not offer superseded versions, explicit replacements, or unavailable providers", () => {
    expect(
      match("gpt", {
        instanceEntries: [traex],
        modelOptionsByInstance: new Map([
          [
            traex.instanceId,
            [
              { slug: "gpt-6-sol", name: "GPT-6 Sol" },
              { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
              { slug: "gpt-old", name: "GPT Old", supersededBy: "gpt-6.1-sol" },
            ],
          ],
        ]),
      }),
    ).toEqual(["traex:gpt-6.1-sol"]);
    expect(match("gpt", { instanceEntries: [{ ...traex, enabled: false }] })).toEqual([]);
    expect(match("gpt", { instanceEntries: [{ ...traex, isAvailable: false }] })).toEqual([]);
  });
  it("offers extra instances using their instance reference", () => {
    const studio = {
      ...traex,
      instanceId: ProviderInstanceId.make("studio_pi"),
      driverKind: ProviderDriverKind.make("pi"),
      displayName: "Studio Pi",
    };
    expect(
      match("studio", {
        instanceEntries: [studio],
        modelOptionsByInstance: new Map([
          [studio.instanceId, [{ slug: "qwen/new", name: "Qwen" }]],
        ]),
      }),
    ).toEqual(["studio_pi:qwen/new"]);
  });
});

it("keeps favorites first in picker order, caps the group, and excludes hidden models", () => {
  const muse = {
    ...traex,
    instanceId: ProviderInstanceId.make("muse"),
    driverKind: ProviderDriverKind.make("muse"),
    displayName: "Muse Account",
  };
  const options = new Map([
    [
      muse.instanceId,
      ["alpha", "beta", "gamma", "delta", "epsilon", "zeta"].map((word) => ({
        slug: `ember-${word}`,
        name: `Muse Ember ${word}`,
      })),
    ],
  ]);
  const input = {
    instanceEntries: [muse],
    modelOptionsByInstance: options,
    catalogInput: {
      favorites: [
        { instanceId: muse.instanceId, slug: "ember-zeta" },
        { instanceId: muse.instanceId, slug: "ember-gamma" },
      ],
    },
    modelPreferences: { [muse.instanceId]: { hiddenModels: ["ember-alpha"], modelOrder: [] } },
  };
  for (const query of ["mu", "ember", "muse", "MU"]) {
    expect(match(query, input)).toEqual([
      "muse:ember-zeta",
      "muse:ember-gamma",
      "muse:ember-beta",
      "muse:ember-delta",
    ]);
  }
  expect(match("", input)).toEqual([]);
  expect(match("src", input)).toEqual([]);
});
