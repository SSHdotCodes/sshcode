import { useMemo } from "react";
import { accountRouteStep, type AccountRouteSession } from "@t3tools/client-runtime/account-routes";
import {
  modelMakerSearchNames,
  type ModelMakerLogo,
  type ModelRouteMemory,
} from "@t3tools/client-runtime/model-makers";
import {
  providerHealthNotice,
  type ProviderHealthNotice,
} from "@t3tools/client-runtime/providerHealth";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import type { ServerProvider } from "@t3tools/contracts";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import {
  makerIcon,
  makerModelRoute,
  type ModelOptionMakerGroup,
  type ModelOptionRoute,
  routeOptions,
  routeRowOption,
} from "./modelMakerCatalog";
import {
  favoritesFirst,
  modelMatchesCatalogQuery,
  providerSectionIsCollapsed,
} from "./thread-settings-sheet-state";

/**
 * Everyday harnesses start expanded; every other provider (OpenRouter catalogs
 * and friends) starts folded so a 300-model catalog cannot bury the list. All
 * provider headers remain user-collapsible.
 */
export const PRIMARY_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "antigravity",
]);

/** Makers whose lists start open, like the everyday harnesses before them. */
const PRIMARY_MAKERS: ReadonlySet<string> = new Set(["openai", "anthropic"]);
export const FAVORITES_PROVIDER_FILTER = "@favorites";
export const MAKER_FILTER_PREFIX = "maker:";
const FAVORITES_SECTION_KEY = "@favorites-section";

export type MakerMarkProps = ReturnType<typeof makerIcon>;

export type ThreadSettingsProviderCatalog = {
  readonly key: string;
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly symbol?: "star.fill" | undefined;
  readonly logo?: ModelMakerLogo | undefined;
  readonly monogram?: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly models: ReadonlyArray<ModelOption>;
  /** Its latest run failed; shown under the header even while collapsed. */
  readonly health: ProviderHealthNotice | null;
};

export type ThreadSettingsCatalogRowItem =
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly provider: ThreadSettingsProviderCatalog;
    }
  | {
      readonly kind: "model";
      readonly key: string;
      readonly option: ModelOption;
      /** The maker's mark before the label, for lists that mix makers without headers. */
      readonly maker?: MakerMarkProps | undefined;
      /** A model row's routes; it reads as picked or starred when any of them is. */
      readonly routes?: ReadonlyArray<ModelOption> | undefined;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly text: string;
    };

export interface ThreadSettingsCatalogSession {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly accountSession: AccountRouteSession;
  readonly makerGroups: ReadonlyArray<ModelOptionMakerGroup>;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly displayedOption: ModelOption | null;
  readonly routeMemory: ModelRouteMemory;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  readonly manageHidden: boolean;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly providerFilter: string | null;
  readonly searchQuery: string;
  readonly showLegacy: boolean;
}

/**
 * The catalog by model maker. Browsing lists each model once, staging its best
 * route; search and favorites list every route, named "model" then "route".
 */
function makerCatalogItems(
  session: ThreadSettingsCatalogSession,
  withMaker = false,
): ReadonlyArray<ThreadSettingsCatalogRowItem> {
  const filter = session.providerFilter;
  const favoritesOnly = filter === FAVORITES_PROVIDER_FILTER;
  const searching = session.searchQuery.trim().length > 0;
  const perRoute = searching || favoritesOnly;
  const isNarrowed = filter !== null || searching;
  const account = accountRouteStep<ModelOptionRoute>(session.providers, session.accountSession);
  const items = session.makerGroups.flatMap((group): ThreadSettingsCatalogRowItem[] => {
    const key = `${MAKER_FILTER_PREFIX}${group.maker.id}`;
    if (filter !== null && !favoritesOnly && filter !== key) return [];
    type Row = { readonly option: ModelOption; readonly routes?: ReadonlyArray<ModelOption> };
    const rows = group.models.flatMap((model): Row[] => {
      const options = routeOptions(model);
      if (perRoute) {
        const runnable = model.routes.filter(
          (route) => !route.source.option.isUnavailable && !route.source.option.isHidden,
        );
        const shown = new Set<string>();
        return model.routes.flatMap((listed): Row[] => {
          const hasFavorite = listed.sources.some((source) =>
            session.favoriteKeys.has(source.option.key),
          );
          if (favoritesOnly && !hasFavorite) return [];
          const starred = routeRowOption(model, listed);
          // A provider's accounts are one row, on the account the chat would use: accounts
          // are picked by name under Runs in only.
          const route = account(listed, runnable.length > 0 ? runnable : model.routes) ?? listed;
          if (shown.has(route.key)) return [];
          const option = route === listed ? starred : routeRowOption(model, route);
          const matches = modelMatchesCatalogQuery({
            model: option,
            providerLabel: `${modelMakerSearchNames(group.maker)} ${route.source.option.providerLabel}`,
            query: session.searchQuery,
          });
          if (!matches) return [];
          shown.add(route.key);
          // The star stays the one the user set, whichever account the row shows.
          const routes = [
            ...route.sources.map((source) => source.option),
            ...(route === listed ? [] : listed.sources.map((source) => source.option)),
          ];
          return [{ option, routes }];
        });
      }
      const route = makerModelRoute(model, session.displayedOption, session.routeMemory, account);
      return route
        ? [{ option: routeRowOption(model, route, model.routes.length - 1), routes: options }]
        : [];
    });
    if (rows.length === 0) return [];
    const collapsed = providerSectionIsCollapsed({
      defaultExpanded:
        PRIMARY_MAKERS.has(group.maker.id) ||
        group.models.some((model) => routeOptions(model).some(session.isApplied)),
      hasExpansionOverride: session.providerExpansionOverrides.has(key),
      isNarrowed,
    });
    const icon = makerIcon(group);
    const shownRows = collapsed ? [] : rows;
    return [
      {
        kind: "provider",
        key: `provider:${key}`,
        provider: {
          key,
          driver: icon.driver,
          iconUrl: icon.iconUrl,
          logo: icon.logo,
          monogram: icon.monogram,
          label: group.maker.label,
          collapsible: !isNarrowed,
          collapsed,
          modelCount: rows.length,
          models: shownRows.map((row) => row.option),
          health: null,
        },
      },
      ...shownRows.map((row, index) => ({
        kind: "model" as const,
        key: `model:${row.option.key}`,
        option: row.option,
        maker: withMaker ? icon : undefined,
        routes: row.routes,
        isFirst: index === 0,
        isLast: index === shownRows.length - 1,
      })),
    ];
  });
  // Browsing every maker: the starred models first, as their own section, each on its
  // starred route; the makers below still list them in place.
  const favorites = filter === null && !searching ? favoriteCatalogItems(session, isNarrowed) : [];
  // Models a harness is too old to run name no maker until they arrive, so they list last.
  const notices = favoritesOnly
    ? []
    : session.providerGroups.flatMap((group) => {
        const text = group.updateRequired
          ? formatProviderUpdateRequiredNotice(group.updateRequired, session.searchQuery)
          : null;
        return text ? [{ kind: "notice" as const, key: `notice:${group.providerKey}`, text }] : [];
      });
  return [...favorites, ...items, ...notices];
}

/** The Favorites filter's rows as one section at the top of the full catalog. */
function favoriteCatalogItems(
  session: ThreadSettingsCatalogSession,
  isNarrowed: boolean,
): ReadonlyArray<ThreadSettingsCatalogRowItem> {
  // Favorites mix makers under one header, so each row carries its maker's mark. They keep
  // the order the user set (the Mac's drag order), not the makers' order.
  const order = new Map([...session.favoriteKeys].map((key, index) => [key, index]));
  const rank = (row: {
    readonly option: ModelOption;
    readonly routes?: ReadonlyArray<ModelOption>;
  }) =>
    Math.min(
      ...[row.option, ...(row.routes ?? [])].map(
        (option) => order.get(option.key) ?? Number.MAX_SAFE_INTEGER,
      ),
    );
  const rows = makerCatalogItems({ ...session, providerFilter: FAVORITES_PROVIDER_FILTER }, true)
    .flatMap((item) => (item.kind === "model" ? [item] : []))
    .sort((left, right) => rank(left) - rank(right));
  if (rows.length === 0) return [];
  const collapsed = providerSectionIsCollapsed({
    defaultExpanded: true,
    hasExpansionOverride: session.providerExpansionOverrides.has(FAVORITES_SECTION_KEY),
    isNarrowed,
  });
  const shown = collapsed ? [] : rows;
  return [
    {
      kind: "provider",
      key: `provider:${FAVORITES_SECTION_KEY}`,
      provider: {
        key: FAVORITES_SECTION_KEY,
        driver: undefined,
        iconUrl: undefined,
        symbol: "star.fill",
        label: "Favorites",
        collapsible: true,
        collapsed,
        modelCount: rows.length,
        models: shown.map((row) => row.option),
        health: null,
      },
    },
    // The same models list again under their makers, so these keys get their own prefix.
    ...shown.map((row, index) => ({
      ...row,
      key: `favorite:${row.key}`,
      isFirst: index === 0,
      isLast: index === shown.length - 1,
    })),
  ];
}

export function useThreadSettingsCatalogItems(
  session: ThreadSettingsCatalogSession,
): ReadonlyArray<ThreadSettingsCatalogRowItem> {
  const {
    accountSession,
    displayedOption,
    favoriteKeys,
    isApplied,
    isDisplayed,
    makerGroups,
    manageHidden,
    providerExpansionOverrides,
    providerFilter,
    providerGroups,
    providers,
    routeMemory,
    searchQuery,
    showLegacy,
  } = session;
  return useMemo(() => {
    const resolvedSession: ThreadSettingsCatalogSession = {
      accountSession,
      displayedOption,
      favoriteKeys,
      isApplied,
      isDisplayed,
      makerGroups,
      manageHidden,
      providerExpansionOverrides,
      providerFilter,
      providerGroups,
      providers,
      routeMemory,
      searchQuery,
      showLegacy,
    };
    return !manageHidden
      ? makerCatalogItems(resolvedSession)
      : providerGroups.flatMap((group) => {
          // Hiding is per harness, so managing hidden models keeps the harness list.
          if (
            providerFilter !== null &&
            providerFilter !== FAVORITES_PROVIDER_FILTER &&
            !providerFilter.startsWith(MAKER_FILTER_PREFIX) &&
            group.providerKey !== providerFilter
          ) {
            return [];
          }
          const driver = group.models[0]?.providerDriver ?? group.providerKey;
          const catalogModels =
            manageHidden || showLegacy || providerFilter === FAVORITES_PROVIDER_FILTER
              ? group.models
              : group.models.filter(
                  (model) => !model.isLegacy || isDisplayed(model) || favoriteKeys.has(model.key),
                );
          const visibleModels = favoritesFirst(
            catalogModels.filter(
              (model) =>
                (providerFilter !== FAVORITES_PROVIDER_FILTER || favoriteKeys.has(model.key)) &&
                modelMatchesCatalogQuery({
                  model,
                  providerLabel: group.providerLabel,
                  query: searchQuery,
                }),
            ),
            favoriteKeys,
          );
          // Favorites list only selectable models, so it never explains gated ones.
          const updateRequiredNotice =
            group.updateRequired && providerFilter !== FAVORITES_PROVIDER_FILTER
              ? formatProviderUpdateRequiredNotice(group.updateRequired, searchQuery)
              : null;
          if (visibleModels.length === 0 && !updateRequiredNotice) {
            return [];
          }
          const isPrimary = driver !== undefined && PRIMARY_PROVIDER_DRIVERS.has(driver);
          // Staging a model must not change disclosure state. The applied model
          // stays stable for the lifetime of this picker (Save closes it), so it
          // is safe to use as the initial selected-provider default.
          const containsAppliedSelection = group.models.some(isApplied);
          const isNarrowed = providerFilter !== null || searchQuery.trim().length > 0;
          const collapsible = !isNarrowed;
          const collapsed = providerSectionIsCollapsed({
            defaultExpanded: isPrimary || containsAppliedSelection,
            hasExpansionOverride: providerExpansionOverrides.has(group.providerKey),
            isNarrowed,
          });
          const provider: ThreadSettingsProviderCatalog = {
            key: group.providerKey,
            driver,
            iconUrl: group.models[0]?.providerIconUrl,
            label: group.providerLabel,
            collapsible,
            collapsed,
            modelCount: visibleModels.length,
            models: collapsed ? [] : visibleModels,
            health: group.recentFailure
              ? providerHealthNotice({ recentFailure: group.recentFailure }, accountSession.now)
              : null,
          };
          return [
            {
              kind: "provider" as const,
              key: `provider:${group.providerKey}`,
              provider,
            },
            ...provider.models.map((option, index) => ({
              kind: "model" as const,
              key: `model:${option.key}`,
              option,
              isFirst: index === 0,
              isLast: index === provider.models.length - 1,
            })),
            ...(!collapsed && updateRequiredNotice
              ? [
                  {
                    kind: "notice" as const,
                    key: `notice:${group.providerKey}`,
                    text: updateRequiredNotice,
                  },
                ]
              : []),
          ];
        });
  }, [
    accountSession,
    displayedOption,
    favoriteKeys,
    isApplied,
    isDisplayed,
    makerGroups,
    manageHidden,
    providerExpansionOverrides,
    providerFilter,
    providerGroups,
    providers,
    routeMemory,
    searchQuery,
    showLegacy,
  ]);
}
