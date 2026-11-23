import Storage from "expo-sqlite/kv-store";
import type { AccountStanding } from "@t3tools/shared/accountBalance";
import { providerHealthNotice } from "@t3tools/client-runtime/providerHealth";
import {
  accountRoomLabel,
  type accountRouteStep,
  sameAccountPool,
} from "@t3tools/client-runtime/account-routes";
import {
  defaultModelRoute,
  type MakerGroup,
  type MakerModel,
  type ModelRoute,
  type ModelRouteMemory,
  type ModelRouteRef,
  type ModelMakerLogo,
  type ModelMakerUse,
  type ModelRouteSource,
  orderMakersByUse,
  parseModelRouteMemory,
  rememberChosenModelRoute,
} from "@t3tools/client-runtime/model-makers";
import {
  createModelPickerCatalog,
  type ModelPickerCatalogInput,
} from "@t3tools/client-runtime/model-picker-catalog";
import { officialAcpRegistryIconUrlForAgentId, type ServerProvider } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";

/** A catalog option as one route of a model. */
export type ModelOptionRoute = ModelRouteSource & { readonly option: ModelOption };
export type ModelOptionMakerGroup = MakerGroup<ModelOptionRoute>;
export type ModelOptionMakerModel = MakerModel<ModelOptionRoute>;

/** The catalog by model maker, the same grouping web uses. */
export function buildModelOptionMakerCatalog(
  options: ReadonlyArray<ModelOption>,
  input: ModelPickerCatalogInput,
) {
  return createModelPickerCatalog(options.map(modelOptionRoute), input);
}

/** A catalog option as the route the shared maker code reads. */
export function modelOptionRoute(option: ModelOption): ModelOptionRoute {
  return {
    instanceId: option.selection.instanceId,
    driver: option.providerDriver,
    instanceName: option.providerLabel,
    slug: option.selection.model,
    name: option.label,
    ...(option.subtitle ? { subProvider: option.subtitle } : {}),
    ...(option.family ? { family: option.family } : {}),
    isLegacy: option.isLegacy,
    option,
  };
}

/**
 * The maker groups, the ones used most lately first (chats someone started, recent ones
 * counting more): the same order as the web rail. Makers never used keep their places.
 */
export function orderMakerGroupsByUse(
  groups: ReadonlyArray<ModelOptionMakerGroup>,
  uses: ReadonlyArray<ModelMakerUse>,
  sources: ReadonlyArray<ModelRouteSource>,
  now: number,
): ModelOptionMakerGroup[] {
  const byMaker = new Map(groups.map((group) => [group.maker, group]));
  return orderMakersByUse(
    groups.map((group) => group.maker),
    uses,
    sources,
    now,
  ).map((maker) => byMaker.get(maker)!);
}

export const routeOptions = (model: ModelOptionMakerModel) =>
  model.routes.map((route) => route.source.option);

/** A route's row: the model's shared name, then where it runs. */
export function routeRowOption(
  model: ModelOptionMakerModel,
  route: ModelRoute<ModelOptionRoute>,
  more = 0,
): ModelOption {
  return {
    ...route.source.option,
    label: model.name,
    subtitle: more > 0 ? `${route.label} +${more}` : route.label,
  };
}

/** A health notice takes the description line; the account's remaining room moves beside it. */
export function routeAccountDetails(
  option: ModelOption,
  standing: AccountStanding | undefined,
  now: number,
) {
  const health =
    option.providerRecentFailure &&
    providerHealthNotice(
      { recentFailure: option.providerRecentFailure },
      now,
      option.selection.model,
    );
  const trouble = health?.outOfCredit ? health.message : health?.title;
  const room = accountRoomLabel(standing, now);
  return {
    description: trouble ?? room ?? undefined,
    trailingText: trouble ? room : null,
  };
}

/** The route a model row stages: the displayed one, else the last used here, else the best. */
export function makerModelRoute(
  model: ModelOptionMakerModel,
  displayed: ModelOption | null,
  memory: ModelRouteMemory,
  account?: ReturnType<typeof accountRouteStep<ModelOptionRoute>>,
): ModelRoute<ModelOptionRoute> | null {
  return (
    (displayed ? model.routes.find((route) => route.source.option.key === displayed.key) : null) ??
    defaultModelRoute(model, {
      lastUsed: memory[model.key],
      isAvailable: (route) => !route.source.option.isUnavailable && !route.source.option.isHidden,
      account,
    })
  );
}

/** The maker's mark for headers: a harness glyph or its registry icon. */
export function makerIcon(group: ModelOptionMakerGroup): {
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  /** The maker's own mark when no harness glyph stands for it (DeepSeek). */
  readonly logo: ModelMakerLogo | undefined;
  /** Initials for a maker with neither (Flint). */
  readonly monogram: string | undefined;
} {
  const icon = group.maker.icon;
  const logo = icon ? undefined : group.maker.logo;
  return {
    driver: icon?.driver,
    iconUrl: officialAcpRegistryIconUrlForAgentId(icon?.acpAgentId) ?? undefined,
    logo,
    monogram: icon || logo ? undefined : group.maker.monogram,
  };
}

// v1 recorded every pick; v2 holds only routes chosen over a model's default.
const STORAGE_KEY = "t3code:model-picker-routes:v2";
let memory: ModelRouteMemory | null = null;

/** The route each model last ran on, on this device. */
export function readModelRouteMemory(): ModelRouteMemory {
  if (memory === null) {
    try {
      memory = parseModelRouteMemory(Storage.getItemSync(STORAGE_KEY));
    } catch {
      memory = {};
    }
  }
  return memory;
}

export function saveModelRoute(
  model: ModelOptionMakerModel,
  route: ModelRouteRef,
  providers: ReadonlyArray<ServerProvider>,
  balanceAccounts: boolean,
): void {
  const current = readModelRouteMemory();
  const next = rememberChosenModelRoute(
    current,
    model,
    route,
    (candidate) => !candidate.source.option.isUnavailable && !candidate.source.option.isHidden,
    balanceAccounts ? sameAccountPool(providers) : undefined,
  );
  if (next === current) return;
  memory = next;
  try {
    Storage.setItemSync(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The next pick falls back to the best route.
  }
}
