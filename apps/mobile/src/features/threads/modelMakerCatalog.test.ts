import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { accountRouteStep, routeStanding } from "@t3tools/client-runtime/account-routes";
import { groupModelsByMaker } from "@t3tools/client-runtime/model-makers";
import Storage from "expo-sqlite/kv-store";
import { describe, expect, it, vi } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import {
  buildModelOptionMakerCatalog,
  makerModelRoute,
  modelOptionRoute,
  orderMakerGroupsByUse,
  readModelRouteMemory,
  routeRowOption,
  routeAccountDetails,
  saveModelRoute,
} from "./modelMakerCatalog";

vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: vi.fn(() => null), setItemSync: vi.fn() },
}));

const model = "claude-opus-5-5";
const provider = (instanceId: string, driver: string, slug: string): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make(driver),
  displayName: driver,
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-07T00:00:00.000Z",
  models: [{ slug, name: "Claude Opus 5.5", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
});

describe("mobile account routes", () => {
  const now = Date.parse("2026-11-17T08:00:00.000Z");
  const account = (instanceId: string, usedPercent: number): ServerProvider => ({
    ...provider(instanceId, "claudeAgent", model),
    continuation: { groupKey: "claude:home:/synthetic/.claude" },
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
  });
  const first = account("claudeAgent", 90);
  const second = account("claudeAgent_work", 10);
  const providers = [first, second];
  const all = options(providers);
  const makerModel = buildModelOptionMakerCatalog(all, { providers }).groups[0]!.models[0]!;

  it("keeps the window reset beside an active health notice", () => {
    const option = {
      ...all[0]!,
      providerRecentFailure: {
        kind: "usage_limit" as const,
        message: "Family limit reached",
        occurredAt: "2026-11-17T08:00:00.000Z",
        resetAt: "2026-11-17T09:00:00.000Z",
      },
    };
    const standing = routeStanding(providers, first.instanceId, model, now);
    expect(routeAccountDetails(option, standing, now)).toEqual({
      description: expect.stringContaining("At its usage limit"),
      trailingText: "10% left · resets Thu",
    });
    expect(routeAccountDetails(all[0]!, standing, now)).toEqual({
      description: "10% left · resets Thu",
      trailingText: null,
    });
  });

  it("starts on the roomier account only when balancing is enabled", () => {
    expect(
      makerModelRoute(makerModel, null, {}, accountRouteStep(providers, { now }))?.source
        .instanceId,
    ).toBe(second.instanceId);
    expect(makerModelRoute(makerModel, null, {})?.source.instanceId).toBe(first.instanceId);
  });

  it("keeps a running chat's account even when memory names the other account", () => {
    const rememberedSecond = { [makerModel.key]: { instanceId: second.instanceId, slug: model } };
    expect(
      makerModelRoute(
        makerModel,
        null,
        rememberedSecond,
        accountRouteStep(providers, { now, instanceId: first.instanceId }),
      )?.source.instanceId,
    ).toBe(first.instanceId);
    expect(
      makerModelRoute(
        makerModel,
        null,
        {},
        accountRouteStep(providers, { now, instanceId: second.instanceId }),
      )?.source.instanceId,
    ).toBe(second.instanceId);
  });

  it("preserves a displayed manual choice in new and running chats", () => {
    expect(
      makerModelRoute(makerModel, all[0]!, {}, accountRouteStep(providers, { now }))?.source.option,
    ).toBe(all[0]);
    expect(
      makerModelRoute(
        makerModel,
        all[1]!,
        {},
        accountRouteStep(providers, { now, instanceId: first.instanceId }),
      )?.source.option,
    ).toBe(all[1]);
  });

  it.each(["isHidden", "isUnavailable"] as const)(
    "passes over a roomier account whose model is %s",
    (flag) => {
      const restricted = all.map((option) =>
        option.selection.instanceId === second.instanceId ? { ...option, [flag]: true } : option,
      );
      const model = buildModelOptionMakerCatalog(restricted, { providers }).groups[0]!.models[0]!;
      expect(
        makerModelRoute(model, null, {}, accountRouteStep(providers, { now }))?.source.instanceId,
      ).toBe(first.instanceId);
    },
  );

  it("forgets account preferences while balancing, and remembers other route choices", () => {
    const secondRef = { instanceId: second.instanceId, slug: model };
    saveModelRoute(makerModel, secondRef, providers, false);
    expect(readModelRouteMemory()[makerModel.key]).toMatchObject(secondRef);
    expect(makerModelRoute(makerModel, null, readModelRouteMemory())?.source.instanceId).toBe(
      second.instanceId,
    );

    saveModelRoute(makerModel, secondRef, providers, true);
    expect(readModelRouteMemory()[makerModel.key]).toBeUndefined();
    expect(Storage.setItemSync).toHaveBeenLastCalledWith(expect.any(String), "{}");

    const gateway = provider("opencode", "opencode", model);
    const withGateway = [...providers, gateway];
    const routesModel = groupModelsByMaker(options(withGateway).map(modelOptionRoute))[0]!
      .models[0]!;
    const gatewayRef = { instanceId: gateway.instanceId, slug: model };
    saveModelRoute(routesModel, gatewayRef, withGateway, true);
    expect(readModelRouteMemory()[routesModel.key]).toMatchObject(gatewayRef);
  });
});

function options(providers: ReadonlyArray<ServerProvider>): ModelOption[] {
  return providers.flatMap((provider) =>
    provider.models.map((entry) => ({
      key: `${provider.instanceId}:${entry.slug}`,
      providerKey: provider.instanceId,
      providerDriver: provider.driver,
      providerLabel: provider.driver,
      label: entry.name,
      subtitle: "",
      isLegacy: entry.isLegacy === true,
      isDefault: false,
      capabilities: null,
      selection: { instanceId: provider.instanceId, model: entry.slug },
    })),
  );
}

describe("mobile maker catalog", () => {
  it("lists the makers used most lately first, like the web rail", () => {
    const providers = [
      provider("codex", "codex", "gpt-6.1-sol"),
      provider("claudeAgent", "claudeAgent", model),
    ];
    const all = options(providers);
    const catalog = buildModelOptionMakerCatalog(all, { providers });
    const now = Date.parse("2026-11-13T07:00:00.000Z");
    const ordered = orderMakerGroupsByUse(
      catalog.groups,
      [
        { instanceId: "claudeAgent", slug: model, at: now - 86_400_000 },
        { instanceId: "claudeAgent", slug: model, at: now - 2 * 86_400_000 },
        { instanceId: "codex", slug: "gpt-6.1-sol", at: now - 86_400_000 },
      ],
      all.map(modelOptionRoute),
      now,
    );
    expect(ordered.map((group) => group.maker.id)).toEqual(["anthropic", "openai"]);
    expect(catalog.groups.map((group) => group.maker.id)).toEqual(["openai", "anthropic"]);
  });

  it("orders models within each maker by recent chat starts", () => {
    const claude = {
      ...provider("claudeAgent", "claudeAgent", "claude-sonnet-5-5"),
      models: [
        {
          slug: "claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          isCustom: false,
          capabilities: null,
        },
        {
          slug: "claude-opus-5-5",
          name: "Claude Opus 5.5",
          isCustom: false,
          capabilities: null,
        },
      ],
    };
    const all = options([claude]);
    const catalog = buildModelOptionMakerCatalog(all, { providers: [claude] });
    const now = Date.parse("2026-11-13T07:00:00.000Z");
    const ordered = orderMakerGroupsByUse(
      catalog.groups,
      [{ instanceId: "claudeAgent", slug: "claude-opus-5-5", at: now - 86_400_000 }],
      all.map(modelOptionRoute),
      now,
    );
    expect(ordered[0]!.models.map((entry) => entry.name)).toEqual([
      "Claude Opus 5.5",
      "Claude Sonnet 5.5",
    ]);
  });

  it("uses the shared native routing policy for rows and remapped favorites", () => {
    const providers = [
      provider("claudeAgent", "claudeAgent", model),
      provider("opencode", "opencode", `anthropic/${model}`),
    ];
    const catalog = buildModelOptionMakerCatalog(options(providers), { providers });
    const makerModel = catalog.groups[0]!.models[0]!;
    expect(makerModel.routes).toHaveLength(1);
    const row = routeRowOption(makerModel, makerModel.routes[0]!, makerModel.routes.length - 1);
    expect(row.selection).toEqual({ instanceId: "claudeAgent", model });
    expect(row.subtitle).toBe("claudeAgent");
    expect(catalog.resolveFavorite({ instanceId: "opencode", slug: `anthropic/${model}` })).toEqual(
      { instanceId: "claudeAgent", slug: model },
    );
  });

  it("keeps a selected legacy phone option while hiding the rest", () => {
    const native = provider("claudeAgent", "claudeAgent", model);
    const providers = [
      {
        ...native,
        models: [
          ...native.models,
          { ...native.models[0]!, slug: "claude-opus-5", name: "Claude Opus 5", isLegacy: true },
          {
            ...native.models[0]!,
            slug: "claude-opus-4-8",
            name: "Claude Opus 4.8",
            isLegacy: true,
          },
        ],
      },
    ];
    const selected = { instanceId: "claudeAgent", slug: "claude-opus-5" };
    const catalog = buildModelOptionMakerCatalog(options(providers), {
      providers,
      selected: [selected],
    });
    expect(catalog.sources.map((source) => source.option.selection.model)).toEqual([
      model,
      selected.slug,
    ]);
  });
});
