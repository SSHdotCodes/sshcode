import { hasRuntimeModelCatalog } from "../../providerModels";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import {
  defaultModelRoute,
  findMakerModel,
  type MakerModel,
  type ModelRoute,
  type ModelRouteRef,
  type ModelRouteSource,
  modelMakerForFamily,
  modelMakerSearchNames,
  modelRouteHasSlug,
  modelVendorFamily,
  makerUsesOf,
  orderMakerModelsByUse,
  orderMakersByUse,
  OTHER_MAKER_ID,
} from "@t3tools/client-runtime/model-makers";
import { readThreadShells } from "../../state/entities";
import {
  createModelPickerCatalog,
  resolveModelPickerFavorites,
} from "@t3tools/client-runtime/model-picker-catalog";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { providerHealthNotice } from "@t3tools/client-runtime/providerHealth";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { useNavigate } from "@tanstack/react-router";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { AsyncResult } from "effect/reactivity";
import {
  memo,
  type ReactNode,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { ChevronRightIcon, PlusIcon, SparklesIcon } from "lucide-react";
import { ModelListRow, SortableModelRow } from "./ModelListRow";
import {
  makerRailSelection,
  ModelPickerSidebar,
  type ModelPickerRailSelection,
} from "./ModelPickerSidebar";
import { ModelPickerRunsIn, type ModelPickerRunsInRoute } from "./ModelPickerRunsIn";
import { ModelPickerStackedColumnContext } from "./ModelPickerReasoningColumn";
import { readModelRouteMemory, saveModelRoute } from "../../modelRouteMemory";
import {
  accountRoomLabel,
  accountRouteStep,
  rankAccountRoutes,
  routeStanding,
  sameAccountPool,
} from "@t3tools/client-runtime/account-routes";
import { getProviderStatusMessage, hasProviderSetup } from "./ProviderStatusBanner";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import {
  listMakerRoutesFirst,
  makerNamedByQuery,
  makerRoutesBestFirst,
  rankModelPickerSearch,
} from "@t3tools/client-runtime/model-search";
import { ModelManagerPanel, modelManagerHarnesses } from "./ModelManagerPanel";
import { parseModelRef, unlistedSearchedModel } from "@t3tools/shared/modelRefs";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { ModelEsque } from "./providerIconUtils";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { primaryServerKeybindingsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import {
  useEnvironmentModelPreferences,
  useEnvironmentServerSettings,
  useToggleEnvironmentModelFavorite,
  useUpdateEnvironmentModelPreferences,
} from "~/hooks/useSettings";
import { modelRankingTierLookup } from "@t3tools/shared/modelRankings";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipProvider, TooltipTrigger } from "../ui/tooltip";
import { RefreshIcon } from "../ui/refresh-icon";
import { InlineButton } from "../ui/button";
import { ListState } from "../ui/list-state";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { moveFavoriteModel, providerModelKey, sortProviderModelItems } from "../../modelOrdering";

export function modelPickerEmptyState(searching: boolean, favorites: boolean, canAdd = false) {
  if (searching && canAdd) {
    return {
      title: "No harness lists this model yet",
      description: "Add it to one below.",
    };
  }
  if (searching) {
    return {
      title: "No matching models",
      description: "Try a shorter name or another provider.",
    };
  }
  if (favorites) {
    return {
      title: "No favorite models",
      description: "Star a model to keep it here.",
    };
  }
  return {
    title: "No models available",
    description: "Check the selected provider in Settings → Providers.",
  };
}

export function resolveModelPickerSelectedModel(input: {
  driverKind: ProviderDriverKind | undefined;
  model: string;
  options: ReadonlyArray<ModelEsque>;
}) {
  if (input.driverKind === "antigravity" && input.model === ANTIGRAVITY_DEFAULT_MODEL) {
    const availableModels = input.options.filter(
      (option) => option.slug !== ANTIGRAVITY_DEFAULT_MODEL && !option.isUnavailable,
    );
    return (
      availableModels.find((option) => option.aliases?.includes(ANTIGRAVITY_DEFAULT_MODEL)) ??
      availableModels.find((option) => option.isDefault)
    );
  }
  return input.options.find((option) => option.slug === input.model);
}

export function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (input.entry.driverKind === "antigravity" && input.option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return false;
  }
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    hasRuntimeModelCatalog(input.entry.driverKind) &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}

export function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    hasProviderSetup(entry.snapshot) &&
    (!isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      entry.snapshot.auth.status === "unauthenticated" ||
      !options.some((option) => !option.isUnavailable))
  );
}

/** One picker row: a route (search, favorites) or a model with all its routes (a maker's list). */
type ModelPickerItem = {
  slug: string;
  name: string;
  /** The instance's own name for the model, matched by search ("z-ai/glm-5.3-flash"). */
  listedName: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  /** The row's second line: the route ("Hermes · OpenRouter"), with how many more there are. */
  rowLabel: string;
  /** Who made the model ("Thinking Machines"), so search finds a maker's models. */
  makerLabel?: string;
  instanceAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
  /** Routes whose favorite stars this row; a model row has several. */
  favoriteRefs: ReadonlyArray<ModelRouteRef>;
  disabledReason?: string | null;
};

/** A catalog model as one instance lists it, with what the picker needs to show and pick it. */
type PickerRouteSource = ModelRouteSource & {
  readonly instanceId: ProviderInstanceId;
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  /** Why it can't be picked now (the harness isn't ready), or null. */
  readonly unavailableReason: string | null;
};

const routeRefKey = (ref: ModelRouteRef) => `${ref.instanceId}\u0000${ref.slug}`;

/** Chats the user started, for putting the makers they use most at the top of the rail. */
/** The rail entries in order; arrows cycle through them. */
export function adjacentModelPickerProvider(input: {
  rails: ReadonlyArray<ModelPickerRailSelection>;
  selected: ModelPickerRailSelection;
  direction: 1 | -1;
}): ModelPickerRailSelection {
  const rails: ReadonlyArray<ModelPickerRailSelection> =
    input.rails.length > 0 ? input.rails : ["favorites"];
  const index = rails.indexOf(input.selected);
  return rails[
    index < 0
      ? input.direction === 1
        ? 0
        : rails.length - 1
      : (index + input.direction + rails.length) % rails.length
  ]!;
}

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const MODEL_LIST_ESTIMATED_ITEM_SIZE = 52;
const FAVORITE_DRAG_MODIFIERS = [restrictToVerticalAxis, restrictToFirstScrollableAncestor];

function ModelListSeparator() {
  return <div className="h-0.5" />;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  environmentId: EnvironmentId | null;
  /** With its setter: a small Auto chip in the search row (the composer's picker only). */
  autoModelEnabled?: boolean;
  onAutoModelEnabledChange?: (enabled: boolean) => void;
  /** The instance currently selected in the composer (combobox "value"). */
  activeInstanceId: ProviderInstanceId;
  model: string;
  /** The composer selection's options. */
  activeModelOptions?: ReadonlyArray<ProviderOptionSelection> | undefined;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  /**
   * When set, the picker is locked to the given driver kind — typically
   * because the user is editing a previously-sent message and can't change
   * which driver served the turn. Only routes through instances of that kind
   * (and continuation group) are offered.
   */
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  /** All configured provider instances in display order. */
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /**
   * The chat this pick is for, where the user has two accounts of one provider. A running
   * chat keeps its account when its model changes: another account would re-read the chat
   * without its cache. Absent for pickers that set a default instead of starting work.
   */
  accountSession?: "new" | "running" | undefined;
  /** A new chat's model opens on the account with the most to spare, and says so. */
  balanceAccounts?: boolean | undefined;
  /** The user picked a new chat's account by name: it is kept while other models are tried. */
  accountPinned?: boolean | undefined;
  keybindings?: ResolvedKeybindingsConfig;
  /** Model options per instance, keyed by `ProviderInstanceId`. */
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  /** The selected model's effort levels, shown beside the list under Runs in. */
  reasoningColumn?: ReactNode;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (
    instanceId: ProviderInstanceId,
    model: string,
    options?: ReadonlyArray<ProviderOptionSelection>,
    /** True when the pick named the account (a Runs in row), not only the model. */
    accountPick?: boolean,
  ) => void;
}) {
  const {
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    onToggleModel,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  // Asks every provider for its current models, so a new release shows up now.
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, "Refresh models");
  const [refreshingModels, setRefreshingModels] = useState(false);
  const [modelManagerOpen, setModelManagerOpen] = useState(false);
  const refreshModels = useCallback(() => {
    const environmentId = props.environmentId;
    if (environmentId === null || refreshingModels) return;
    setRefreshingModels(true);
    void refreshProviders({ environmentId, input: { refreshModels: true } }).finally(() =>
      setRefreshingModels(false),
    );
  }, [props.environmentId, refreshProviders, refreshingModels]);
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const modelListRef = useRef<LegendListRef | null>(null);
  const pickerContentRef = useRef<HTMLDivElement>(null);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const { favorites } = useEnvironmentModelPreferences(props.environmentId);
  const serverSettings = useEnvironmentServerSettings(props.environmentId);
  const saveModelPreferences = useUpdateEnvironmentModelPreferences(props.environmentId);
  // A dragged favorite keeps its new place until the saved order arrives.
  const [pendingFavoriteOrder, setPendingFavoriteOrder] = useState<{
    readonly base: typeof favorites;
    readonly order: typeof favorites;
  } | null>(null);
  const orderedFavorites =
    pendingFavoriteOrder?.base === favorites ? pendingFavoriteOrder.order : favorites;
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  // Memoized so the React Compiler knows the resolved model is settled: it otherwise assumes the
  // helpers below may change it, cannot keep the memos that depend on it, and skips the picker.
  const activeModel = useMemo(
    () =>
      resolveModelPickerSelectedModel({
        driverKind: activeEntry?.driverKind,
        model: props.model,
        options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
      }),
    [activeEntry?.driverKind, modelOptionsByInstance, props.activeInstanceId, props.model],
  );
  const activeModelSlug =
    activeModel?.slug ?? (props.model === ANTIGRAVITY_DEFAULT_MODEL ? "" : props.model);
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const selectedModelKeys = useMemo(
    () =>
      props.selectedModels?.map((selection) => {
        const entry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
        const model = resolveModelPickerSelectedModel({
          driverKind: entry?.driverKind,
          model: selection.model,
          options: modelOptionsByInstance.get(selection.instanceId) ?? [],
        });
        return modelPickerModelKey(selection.instanceId, model?.slug ?? selection.model);
      }),
    [instanceEntries, modelOptionsByInstance, props.selectedModels],
  );
  const selectedModelKeySet = useMemo(
    () => new Set(selectedModelKeys ?? (activeModelKey ? [activeModelKey] : [])),
    [selectedModelKeys, activeModelKey],
  );
  const activeInstanceHasSelectableUnavailableModel =
    activeEntry !== undefined &&
    (modelOptionsByInstance.get(props.activeInstanceId) ?? []).some((option) =>
      shouldIncludeModelPickerOption({
        entry: activeEntry,
        option,
        activeInstanceId: props.activeInstanceId,
        activeModel: activeModelSlug,
      }),
    ) &&
    !isProviderInstancePickerReady(activeEntry);
  const activeInstanceNeedsSetup =
    props.onOpenProviderSetup !== undefined &&
    activeEntry !== undefined &&
    shouldOfferModelPickerSetup(
      activeEntry,
      modelOptionsByInstance.get(props.activeInstanceId) ?? [],
    );
  const isLocked = props.lockedProvider !== null;
  const matchesLockedProvider = useCallback(
    (entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">): boolean => {
      if (props.lockedProvider === null) return true;
      if (entry.driverKind !== props.lockedProvider) return false;
      if (!props.lockedContinuationGroupKey) return true;
      return entry.continuationGroupKey === props.lockedContinuationGroupKey;
    },
    [props.lockedContinuationGroupKey, props.lockedProvider],
  );

  // Every enabled instance's models as routes. A locked chat sees only the routes it can take.
  const allRouteSources = useMemo(() => {
    const out: PickerRouteSource[] = [];
    for (const entry of instanceEntries) {
      if (!isProviderInstancePickerVisible(entry) || !matchesLockedProvider(entry)) continue;
      const familyBySlug = indexModelFamilies(entry.models);
      const seenSlugs = new Set<string>();
      for (const option of modelOptionsByInstance.get(entry.instanceId) ?? []) {
        if (seenSlugs.has(option.slug)) continue;
        seenSlugs.add(option.slug);
        if (entry.driverKind === "antigravity" && option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
          continue;
        }
        const selectable = shouldIncludeModelPickerOption({
          entry,
          option,
          activeInstanceId: props.activeInstanceId,
          activeModel: activeModelSlug,
        });
        out.push({
          instanceId: entry.instanceId,
          driver: entry.driverKind,
          instanceName: entry.displayName,
          slug: option.slug,
          name: option.name,
          subProvider: option.subProvider,
          family: familyBySlug.get(option.slug),
          isLegacy: option.isLegacy,
          entry,
          option,
          unavailableReason: selectable ? null : getProviderStatusMessage(entry.snapshot),
        });
      }
    }
    return out;
  }, [
    activeModelSlug,
    instanceEntries,
    matchesLockedProvider,
    modelOptionsByInstance,
    props.activeInstanceId,
  ]);
  const activeRef = useMemo(
    () => ({ instanceId: props.activeInstanceId, slug: activeModelSlug }),
    [activeModelSlug, props.activeInstanceId],
  );
  const catalog = useMemo(
    () =>
      createModelPickerCatalog(allRouteSources, {
        providers: instanceEntries.map((entry) => entry.snapshot),
        providerInstances: serverSettings?.providerInstances,
        selected: [
          activeRef,
          ...(props.selectedModels ?? []).map((selection) => ({
            instanceId: selection.instanceId,
            slug: selection.model,
          })),
        ],
        favorites: favorites.map((favorite) => ({
          instanceId: favorite.provider,
          slug: favorite.model,
        })),
        search: searchQuery,
      }),
    [
      activeRef,
      allRouteSources,
      favorites,
      instanceEntries,
      props.selectedModels,
      searchQuery,
      serverSettings?.providerInstances,
    ],
  );
  const { sources: routeSources, groups: makerGroups } = catalog;
  /** Every listed slug → its model and route. */
  const routeIndex = useMemo(() => {
    const index = new Map<
      string,
      { model: MakerModel<PickerRouteSource>; route: ModelRoute<PickerRouteSource> }
    >();
    for (const group of makerGroups) {
      for (const model of group.models) {
        for (const route of model.routes) {
          for (const source of route.sources) index.set(routeRefKey(source), { model, route });
        }
      }
    }
    return index;
  }, [makerGroups]);
  const [routeMemory, setRouteMemory] = useState(readModelRouteMemory);
  const routeDisabledReason = useCallback(
    (route: ModelRoute<PickerRouteSource>) =>
      route.source.unavailableReason ??
      getModelDisabledReason?.(route.source.instanceId, route.source.slug) ??
      null,
    [getModelDisabledReason],
  );
  const activeMakerModel = useMemo(
    () => findMakerModel(makerGroups, activeRef),
    [activeRef, makerGroups],
  );
  // Read once per opening, like the rail's order: limits must not move rows under the pointer.
  const [openedAt] = useState(() => Date.now());
  const accountProviders = useMemo(
    () => instanceEntries.map((entry) => entry.snapshot),
    [instanceEntries],
  );
  const balancesAccounts = props.accountSession === "new" && props.balanceAccounts === true;
  const accountStep = useMemo(
    () =>
      props.accountSession === undefined
        ? undefined
        : accountRouteStep<PickerRouteSource>(accountProviders, {
            now: openedAt,
            selection: {
              instanceId: props.activeInstanceId,
              model: activeModelSlug,
              options: props.activeModelOptions,
            },
            // A running chat keeps its account; so does a new chat put on one by name.
            instanceId:
              props.accountSession === "running" || props.accountPinned === true
                ? props.activeInstanceId
                : null,
            balance: props.balanceAccounts === true,
          }),
    [
      accountProviders,
      activeModelSlug,
      props.activeModelOptions,
      openedAt,
      props.accountPinned,
      props.accountSession,
      props.activeInstanceId,
      props.balanceAccounts,
    ],
  );
  /**
   * Search and favorites name a route. Between the user's accounts of one provider that is
   * the account the chat would use: accounts are picked by name under Runs in only.
   */
  const accountRef = useCallback(
    (ref: ModelRouteRef): ModelRouteRef => {
      const hit = accountStep ? routeIndex.get(routeRefKey(ref)) : undefined;
      if (!hit || !accountStep) return ref;
      const moved = accountStep(
        hit.route,
        hit.model.routes.filter((route) => routeDisabledReason(route) === null),
      );
      const source = moved?.sources.find((candidate) => candidate.slug === ref.slug);
      return source ? { instanceId: source.instanceId, slug: source.slug } : ref;
    },
    [accountStep, routeDisabledReason, routeIndex],
  );
  /** The route a model row picks: the active one for the active model, else the best. */
  const rowRouteFor = useCallback(
    (model: MakerModel<PickerRouteSource>) =>
      (model === activeMakerModel
        ? model.routes.find((route) => modelRouteHasSlug(route, activeRef))
        : undefined) ??
      defaultModelRoute(model, {
        lastUsed: routeMemory[model.key],
        isAvailable: (route) => routeDisabledReason(route) === null,
        account: accountStep,
      }),
    [accountStep, activeMakerModel, activeRef, routeDisabledReason, routeMemory],
  );

  // Read once per opening: the rail and model lists must not reorder under the pointer while chats update.
  const [makerUses] = useState(() => ({
    uses: makerUsesOf(readThreadShells()),
    now: Date.now(),
  }));
  const orderedMakerGroups = useMemo(
    () => orderMakerModelsByUse(makerGroups, makerUses.uses, allRouteSources, makerUses.now),
    [allRouteSources, makerGroups, makerUses],
  );
  const makers = useMemo(
    () =>
      orderMakersByUse(
        orderedMakerGroups.map((group) => group.maker),
        makerUses.uses,
        allRouteSources,
        makerUses.now,
      ),
    [allRouteSources, makerUses, orderedMakerGroups],
  );
  const railOrder = useMemo(
    (): ReadonlyArray<ModelPickerRailSelection> => [
      "favorites",
      ...makers.map((maker) => makerRailSelection(maker.id)),
    ],
    [makers],
  );
  const activeMakerRail = activeMakerModel ? makerRailSelection(activeMakerModel.makerId) : null;
  const [requestedRail, setRequestedRail] = useState<ModelPickerRailSelection>(() => {
    if (
      favorites.length > 0 &&
      !isLocked &&
      !activeInstanceHasSelectableUnavailableModel &&
      !activeInstanceNeedsSetup
    ) {
      return "favorites";
    }
    return activeMakerRail ?? "favorites";
  });
  // A maker can leave the rail (its last harness turned off); fall back to the active model's.
  const selectedInstanceId: ModelPickerRailSelection = railOrder.includes(requestedRail)
    ? requestedRail
    : (activeMakerRail ?? "favorites");
  const selectedMakerId = selectedInstanceId.startsWith("maker:")
    ? selectedInstanceId.slice("maker:".length)
    : null;
  const [expandedLegacyMakers, setExpandedLegacyMakers] = useState(
    () => new Set<string>(activeMakerModel?.isLegacy ? [activeMakerModel.makerId] : []),
  );
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const navigate = useNavigate();
  const toggleFavorite = useToggleEnvironmentModelFavorite(props.environmentId);

  const focusSearchInput = useCallback(() => {
    searchInputRef.current?.focus({ preventScroll: true });
  }, []);

  const handleSelectInstance = useCallback(
    (selection: ModelPickerRailSelection) => {
      setRequestedRail(selection);
      window.requestAnimationFrame(() => {
        focusSearchInput();
      });
    },
    [focusSearchInput],
  );

  useLayoutEffect(() => {
    focusSearchInput();
    const frame = window.requestAnimationFrame(() => {
      focusSearchInput();
    });
    const timeout = window.setTimeout(() => {
      focusSearchInput();
    }, 0);
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timeout);
    };
  }, [focusSearchInput]);

  // Favorites are keyed by `${instanceId}:${slug}`; pre-migration ones keyed by driver
  // slugs still resolve, since the default instance id equals the driver slug.
  const favoritesSet = useMemo(() => {
    return new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  }, [favorites]);
  const favoriteRoutes = useMemo(
    () =>
      resolveModelPickerFavorites(
        orderedFavorites.map((favorite) => ({
          instanceId: favorite.provider,
          slug: favorite.model,
        })),
        // A model starred on one account is the model on the user's accounts.
        (ref) => {
          const target = catalog.resolveFavorite(ref);
          return target ? accountRef(target) : null;
        },
      ),
    [accountRef, catalog, orderedFavorites],
  );
  const favoriteOrder = useMemo(
    () =>
      favoriteRoutes.map(({ target }) =>
        providerModelKey(target.instanceId as ProviderInstanceId, target.slug),
      ),
    [favoriteRoutes],
  );
  const resolvedFavoritesSet = useMemo(() => new Set(favoriteOrder), [favoriteOrder]);

  const entryByInstanceId = useMemo(
    () => new Map(instanceEntries.map((entry) => [entry.instanceId, entry])),
    [instanceEntries],
  );

  const selectableUnavailableInstanceIds = useMemo(() => {
    const instanceIds = new Set<ProviderInstanceId>();
    if (activeInstanceHasSelectableUnavailableModel) {
      instanceIds.add(props.activeInstanceId);
    }
    if (props.onOpenProviderSetup) {
      for (const entry of instanceEntries) {
        if (
          shouldOfferModelPickerSetup(entry, modelOptionsByInstance.get(entry.instanceId) ?? [])
        ) {
          instanceIds.add(entry.instanceId);
        }
      }
    }
    return instanceIds;
  }, [
    activeInstanceHasSelectableUnavailableModel,
    instanceEntries,
    modelOptionsByInstance,
    props.activeInstanceId,
    props.onOpenProviderSetup,
  ]);

  const itemForRoute = useCallback(
    (
      source: PickerRouteSource,
      name: string,
      rowLabel: string,
      favoriteRefs: ReadonlyArray<ModelRouteRef>,
    ): ModelPickerItem => ({
      slug: source.slug,
      name,
      listedName: source.name,
      ...(source.option.subProvider ? { subProvider: source.option.subProvider } : {}),
      ...(source.option.badge ? { badge: source.option.badge } : {}),
      ...(source.option.isLegacy ? { isLegacy: true } : {}),
      ...(source.option.isUnavailable ? { isUnavailable: true } : {}),
      instanceId: source.instanceId,
      driverKind: source.entry.driverKind,
      instanceDisplayName: source.entry.displayName,
      rowLabel,
      ...(source.entry.accentColor ? { instanceAccentColor: source.entry.accentColor } : {}),
      ...(source.entry.acpRegistryAgentId
        ? { acpRegistryAgentId: source.entry.acpRegistryAgentId }
        : {}),
      ...(source.entry.acpRegistryIconUrl
        ? { acpRegistryIconUrl: source.entry.acpRegistryIconUrl }
        : {}),
      ...(source.entry.continuationGroupKey
        ? { continuationGroupKey: source.entry.continuationGroupKey }
        : {}),
      favoriteRefs: [
        ...new Map(
          [
            ...favoriteRefs,
            ...favoriteRoutes
              .filter(({ target }) =>
                favoriteRefs.some((ref) => routeRefKey(ref) === routeRefKey(target)),
              )
              .map(({ original }) => original),
          ].map((ref) => [routeRefKey(ref), ref]),
        ).values(),
      ],
    }),
    [favoriteRoutes],
  );

  const makerLabels = useMemo(
    () =>
      new Map(
        makerGroups
          .filter((group) => group.maker.id !== OTHER_MAKER_ID)
          .map((group) => [group.maker.id, modelMakerSearchNames(group.maker)] as const),
      ),
    [makerGroups],
  );
  // Search and favorites list routes: one row per (model, harness, gateway), named alike.
  const flatModels = useMemo(() => {
    const out: ModelPickerItem[] = [];
    for (const source of routeSources) {
      if (source.unavailableReason !== null) continue;
      const hit = routeIndex.get(routeRefKey(source));
      if (!hit) continue;
      const isRouteSlug = hit.route.source === source;
      // Effort variants (`…-max`) list only when the user starred one.
      if (
        !isRouteSlug &&
        !resolvedFavoritesSet.has(providerModelKey(source.instanceId, source.slug))
      ) {
        continue;
      }
      out.push({
        ...itemForRoute(source, hit.model.name, hit.route.label, [source]),
        ...(makerLabels.has(hit.model.makerId)
          ? { makerLabel: makerLabels.get(hit.model.makerId)! }
          : {}),
      });
    }
    return out;
  }, [resolvedFavoritesSet, itemForRoute, makerLabels, routeIndex, routeSources]);

  // A maker's list: one row per model, picking its best route.
  const makerModels = useMemo(() => {
    const group = orderedMakerGroups.find((candidate) => candidate.maker.id === selectedMakerId);
    if (!group) return [];
    const rows = group.models.flatMap((model): ModelPickerItem[] => {
      const route = rowRouteFor(model);
      if (!route) return [];
      const reasons = model.routes.map(routeDisabledReason);
      const more = model.routes.length - 1;
      const item = itemForRoute(
        route.source,
        model.name,
        more > 0 ? `${route.label} +${more}` : route.label,
        model.routes.flatMap((candidate) => candidate.sources),
      );
      return [
        {
          ...item,
          isLegacy: model.isLegacy,
          isUnavailable: model.routes.every((candidate) => candidate.source.option.isUnavailable),
          ...(model.routes.some((candidate) =>
            candidate.sources.some((source) => source.option.badge === "new"),
          )
            ? { badge: "new" as const }
            : {}),
          disabledReason: reasons.every((reason) => reason !== null) ? reasons[0]! : null,
        },
      ];
    });
    // Starred models lead their maker's list; the rest keep their order by use.
    const starred = (item: ModelPickerItem) =>
      item.favoriteRefs.some((ref) =>
        favoritesSet.has(providerModelKey(ref.instanceId as ProviderInstanceId, ref.slug)),
      );
    return [...rows.filter(starred), ...rows.filter((item) => !starred(item))];
  }, [
    favoritesSet,
    itemForRoute,
    orderedMakerGroups,
    routeDisabledReason,
    rowRouteFor,
    selectedMakerId,
  ]);

  const isSearching = searchQuery.trim().length > 0;
  // A pasted model page searches by its id; "Add <id> to …" appears when no harness lists it.
  const searchedRef = useMemo(() => parseModelRef(searchQuery), [searchQuery]);
  const rankingQuery =
    searchedRef !== null && searchedRef.source !== "id" ? searchedRef.id : searchQuery;
  const searchedModel = useMemo(
    () =>
      unlistedSearchedModel(
        searchQuery,
        allRouteSources.map((source) => source.slug),
      ),
    [allRouteSources, searchQuery],
  );
  const modelManagerHarnessEntries = useMemo(
    () => modelManagerHarnesses(instanceEntries),
    [instanceEntries],
  );
  const showSidebar = !isSearching && makers.length > 0;
  const instanceOrder = useMemo(
    () => instanceEntries.map((entry) => entry.instanceId),
    [instanceEntries],
  );
  const isFavoriteItem = useCallback(
    (item: ModelPickerItem) =>
      item.favoriteRefs.some((ref) =>
        favoritesSet.has(providerModelKey(ref.instanceId as ProviderInstanceId, ref.slug)),
      ),
    [favoritesSet],
  );

  const filteredModels = useMemo(() => {
    if (isSearching) {
      // One row for a provider's accounts: the account the chat would use.
      const listed = new Set(
        flatModels.map((item) => providerModelKey(item.instanceId, item.slug)),
      );
      const searchable = flatModels.filter((item) => {
        const shown = accountRef({ instanceId: item.instanceId, slug: item.slug });
        return (
          shown.instanceId === item.instanceId ||
          !listed.has(providerModelKey(shown.instanceId as ProviderInstanceId, shown.slug))
        );
      });
      const ranked = rankModelPickerSearch(searchable, rankingQuery, (model) => ({
        name: model.name,
        slug: model.slug,
        shortName: model.listedName,
        ...(model.subProvider ? { subProvider: model.subProvider } : {}),
        driverKind: model.driverKind,
        providerDisplayName: `${model.instanceDisplayName} ${model.rowLabel} ${model.makerLabel ?? ""}`,
        isFavorite: isFavoriteItem(model),
      }));
      // A maker's name ("meta") lists that maker as its own list does: each model on its
      // best route (the plan's) first, then the other ways to run them.
      const maker = makerNamedByQuery(makerGroups, rankingQuery);
      if (maker === null) return ranked;
      return listMakerRoutesFirst(
        ranked,
        makerRoutesBestFirst(maker.models).map((route) =>
          providerModelKey(route.source.instanceId, route.source.slug),
        ),
        (item) => providerModelKey(item.instanceId, item.slug),
      );
    }
    if (selectedInstanceId === "favorites") {
      return sortProviderModelItems(
        flatModels.filter((item) =>
          resolvedFavoritesSet.has(providerModelKey(item.instanceId, item.slug)),
        ),
        {
          favoriteModelKeys: resolvedFavoritesSet,
          favoriteOrder,
          instanceOrder,
        },
      );
    }
    return makerModels;
  }, [
    accountRef,
    favoriteOrder,
    flatModels,
    instanceOrder,
    isFavoriteItem,
    isSearching,
    makerGroups,
    makerModels,
    rankingQuery,
    resolvedFavoritesSet,
    selectedInstanceId,
  ]);

  const legacySection = useMemo(() => {
    if (isSearching || selectedMakerId === null) {
      return null;
    }
    const currentModels = filteredModels.filter((model) => !model.isLegacy);
    const legacyModels = filteredModels.filter((model) => model.isLegacy);
    if (legacyModels.length === 0) {
      return null;
    }
    return {
      key: modelPickerLegacySectionKey(selectedMakerId),
      currentModels,
      legacyModels,
      isExpanded: expandedLegacyMakers.has(selectedMakerId),
    };
  }, [expandedLegacyMakers, filteredModels, isSearching, selectedMakerId]);

  const visibleModels = useMemo(() => {
    if (!legacySection) {
      return filteredModels;
    }
    return [
      ...legacySection.currentModels,
      ...(legacySection.isExpanded ? legacySection.legacyModels : []),
    ];
  }, [filteredModels, legacySection]);

  // Harnesses behind this maker's models that need setup; favorites shows any when it's empty.
  const providerSetupEntries =
    !isSearching && props.onOpenProviderSetup
      ? instanceEntries.filter(
          (entry) =>
            matchesLockedProvider(entry) &&
            shouldOfferModelPickerSetup(
              entry,
              modelOptionsByInstance.get(entry.instanceId) ?? [],
            ) &&
            (selectedMakerId !== null
              ? makerGroups
                  .find((group) => group.maker.id === selectedMakerId)
                  ?.models.some((model) =>
                    model.routes.some((route) => route.source.instanceId === entry.instanceId),
                  ) === true
              : selectedInstanceId === "favorites" && filteredModels.length === 0),
        )
      : [];

  // Models the manifest announces that a harness's installed CLI is too old to run. A search
  // spans every harness; a maker's list names only that maker's.
  const updateRequiredNotices = (
    isSearching || selectedMakerId !== null ? instanceEntries.filter(matchesLockedProvider) : []
  ).flatMap((entry) => {
    const models = isSearching
      ? entry.snapshot.updateRequiredModels
      : entry.snapshot.updateRequiredModels?.filter(
          (model) =>
            modelMakerForFamily(
              modelVendorFamily({
                instanceId: entry.instanceId,
                driver: entry.driverKind,
                instanceName: entry.displayName,
                slug: model.slug,
                name: model.name,
              }),
            ).id === selectedMakerId,
        );
    const notice = formatProviderUpdateRequiredNotice(
      { driver: entry.snapshot.driver, updateRequiredModels: models ?? [] },
      searchQuery,
    );
    return notice ? [{ instanceId: entry.instanceId, notice }] : [];
  });

  // The selected model's harness: its latest run failed. The models still list, with the reason.
  const healthNotice =
    !isSearching &&
    activeEntry !== undefined &&
    selectedMakerId !== null &&
    activeMakerModel?.makerId === selectedMakerId
      ? providerHealthNotice(activeEntry.snapshot, openedAt, activeModelSlug)
      : null;

  const toggleLegacySection = useCallback((makerId: string) => {
    setExpandedLegacyMakers((expanded) => {
      const next = new Set(expanded);
      if (next.has(makerId)) {
        next.delete(makerId);
      } else {
        next.add(makerId);
      }
      return next;
    });
  }, []);

  const rememberRoute = useCallback(
    (ref: ModelRouteRef) => {
      const hit = routeIndex.get(routeRefKey(ref));
      if (!hit) return;
      saveModelRoute(
        hit.model,
        ref,
        (route) => routeDisabledReason(route) === null,
        // With balancing on, an account picked over the other is for this chat only.
        props.balanceAccounts === true ? sameAccountPool(accountProviders) : undefined,
      );
      setRouteMemory(readModelRouteMemory());
    },
    [accountProviders, props.balanceAccounts, routeDisabledReason, routeIndex],
  );

  const handleModelSelect = useCallback(
    (modelSlug: string, instanceId: ProviderInstanceId, additive = false, accountPick = false) => {
      if (getModelDisabledReason?.(instanceId, modelSlug)) {
        return;
      }
      const options = modelOptionsByInstance.get(instanceId);
      if (!options) {
        return;
      }
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        return;
      }
      // `resolveSelectableModel` uses the driver kind for normalization
      // (slug casing etc.). Custom instances share their driver's
      // normalization rules, so pass the driver kind here.
      const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
      if (resolvedModel) {
        if (additive && onToggleModel) {
          onToggleModel(instanceId, resolvedModel);
        } else {
          rememberRoute({ instanceId, slug: resolvedModel });
          onInstanceModelChange(instanceId, resolvedModel, undefined, accountPick);
        }
      }
    },
    [
      entryByInstanceId,
      getModelDisabledReason,
      modelOptionsByInstance,
      onInstanceModelChange,
      onToggleModel,
      rememberRoute,
    ],
  );

  /** Picks a route; the active route keeps its current effort. */
  const selectRoute = useCallback(
    (
      model: MakerModel<PickerRouteSource>,
      route: ModelRoute<PickerRouteSource>,
      accountPick = false,
    ) => {
      const instanceId = route.source.instanceId;
      if (modelRouteHasSlug(route, activeRef)) {
        handleModelSelect(activeModelSlug, instanceId, false, accountPick);
        return;
      }
      const remembered = routeMemory[model.key];
      handleModelSelect(
        remembered && modelRouteHasSlug(route, remembered) ? remembered.slug : route.source.slug,
        instanceId,
        false,
        accountPick,
      );
    },
    [activeModelSlug, activeRef, handleModelSelect, routeMemory],
  );

  /** A row's key, picked by click, Enter or shortcut. */
  const pickModelKey = useCallback(
    (modelKey: string, additive = false) => {
      const model = parseModelPickerModelKey(modelKey);
      if (!model) return;
      const hit = routeIndex.get(routeRefKey(model));
      if (!additive && hit && hit.route.source.slug === model.slug) {
        selectRoute(hit.model, hit.route);
        return;
      }
      handleModelSelect(model.slug, model.instanceId, additive);
    },
    [handleModelSelect, routeIndex, selectRoute],
  );

  const modelJumpCommandByKey = useMemo(() => {
    const mapping = new Map<
      string,
      NonNullable<ReturnType<typeof modelPickerJumpCommandForIndex>>
    >();
    let selectableModelIndex = 0;
    for (const model of visibleModels) {
      if (model.disabledReason || getModelDisabledReason?.(model.instanceId, model.slug)) {
        continue;
      }
      const jumpCommand = modelPickerJumpCommandForIndex(selectableModelIndex);
      if (!jumpCommand) {
        return mapping;
      }
      mapping.set(modelPickerModelKey(model.instanceId, model.slug), jumpCommand);
      selectableModelIndex += 1;
    }
    return mapping;
  }, [getModelDisabledReason, visibleModels]);
  const modelJumpModelKeys = useMemo(
    () => [...modelJumpCommandByKey.keys()],
    [modelJumpCommandByKey],
  );
  const allItemKeys = useMemo(
    (): string[] => [
      ...new Set([
        ...routeSources.map((source) => modelPickerModelKey(source.instanceId, source.slug)),
        ...makerGroups.map((group) => modelPickerLegacySectionKey(group.maker.id)),
      ]),
    ],
    [makerGroups, routeSources],
  );
  const filteredItemKeys = useMemo((): string[] => {
    const modelKeys = visibleModels.map((model) =>
      modelPickerModelKey(model.instanceId, model.slug),
    );
    if (!legacySection) {
      return modelKeys;
    }
    modelKeys.splice(legacySection.currentModels.length, 0, legacySection.key);
    return modelKeys;
  }, [legacySection, visibleModels]);
  // Favorites can be dragged into the order their shortcuts follow.
  const canReorderFavorites =
    selectedInstanceId === "favorites" &&
    !isSearching &&
    props.environmentId !== null &&
    visibleModels.length > 1;
  const reorderableModelKeys = useMemo(
    () =>
      canReorderFavorites
        ? visibleModels.map((model) => modelPickerModelKey(model.instanceId, model.slug))
        : [],
    [canReorderFavorites, visibleModels],
  );
  const moveFavorite = useCallback(
    (fromModelKey: string, toModelKey: string) => {
      const from = parseModelPickerModelKey(fromModelKey);
      const to = parseModelPickerModelKey(toModelKey);
      if (!from || !to) return;
      const storedRef = (ref: ModelRouteRef) =>
        favoriteRoutes.find(({ target }) => routeRefKey(target) === routeRefKey(ref))?.original ??
        ref;
      const storedFrom = storedRef(from);
      const storedTo = storedRef(to);
      const shown = visibleModels
        .flatMap((model) => model.favoriteRefs)
        .filter((ref) =>
          favoritesSet.has(providerModelKey(ref.instanceId as ProviderInstanceId, ref.slug)),
        )
        .map((ref) => ({ provider: ref.instanceId as ProviderInstanceId, model: ref.slug }));
      const order = moveFavoriteModel(
        orderedFavorites,
        new Set(shown.map((ref) => providerModelKey(ref.provider, ref.model))),
        providerModelKey(storedFrom.instanceId as ProviderInstanceId, storedFrom.slug),
        providerModelKey(storedTo.instanceId as ProviderInstanceId, storedTo.slug),
      );
      if (!order) return;
      setPendingFavoriteOrder({ base: favorites, order });
      void saveModelPreferences({
        moveModelFavorite: {
          from: { provider: storedFrom.instanceId as ProviderInstanceId, model: storedFrom.slug },
          to: { provider: storedTo.instanceId as ProviderInstanceId, model: storedTo.slug },
          shown,
        },
      }).then((result) => {
        if (!result || !AsyncResult.isSuccess(result)) setPendingFavoriteOrder(null);
      });
    },
    [
      favoriteRoutes,
      favorites,
      favoritesSet,
      orderedFavorites,
      saveModelPreferences,
      visibleModels,
    ],
  );
  const favoriteDragSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleFavoriteDragEnd = useCallback(
    ({ active, over }: DragEndEvent) => {
      if (over && active.id !== over.id) moveFavorite(String(active.id), String(over.id));
    },
    [moveFavorite],
  );
  /** A model row stars its picked route; unstarring clears every route it starred. */
  const toggleItemFavorite = useCallback(
    (item: ModelPickerItem) => {
      const starred = item.favoriteRefs.filter((ref) =>
        favoritesSet.has(providerModelKey(ref.instanceId as ProviderInstanceId, ref.slug)),
      );
      if (starred.length === 0) {
        toggleFavorite(item.instanceId, item.slug);
        return;
      }
      for (const ref of starred) toggleFavorite(ref.instanceId as ProviderInstanceId, ref.slug);
    },
    [favoritesSet, toggleFavorite],
  );
  const filteredModelByKey = useMemo(
    (): ReadonlyMap<string, ModelPickerItem> =>
      new Map(
        visibleModels.map(
          (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
        ),
      ),
    [visibleModels],
  );
  const [modelListContentSize, setModelListContentSize] = useState(
    () => filteredItemKeys.length * MODEL_LIST_ESTIMATED_ITEM_SIZE,
  );
  const [searchHeight, setSearchHeight] = useState(0);
  // Listen from when the list mounts, starting from an estimate of its rows.
  useLayoutEffect(() => {
    const state = modelListRef.current?.getState();
    if (state === undefined) return;
    setModelListContentSize(
      state.contentLength > 0
        ? state.contentLength
        : filteredItemKeys.length * MODEL_LIST_ESTIMATED_ITEM_SIZE,
    );
    return state.listen("totalSize", setModelListContentSize);
    // Row changes arrive through the listener.
  }, []);
  // Fit the list to its rows plus the combobox list `py-1` and LegendList `py-1.5`.
  const modelListHeight =
    filteredItemKeys.length === 0 ? 0 : `calc(${modelListContentSize}px + var(--spacing) * 5)`;
  const updateModelListScrollFades = useCallback(() => {
    const scrollElement = modelListRef.current?.getScrollableNode();
    if (!(scrollElement instanceof HTMLElement)) {
      return;
    }
    const maxScrollOffset = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
    setShowTopScrollFade(scrollElement.scrollTop > 1);
    setShowBottomScrollFade(maxScrollOffset - scrollElement.scrollTop > 1);
  }, []);
  const modelJumpShortcutContext = useMemo(
    () =>
      ({
        terminalFocus: false,
        terminalOpen: props.terminalOpen,
        modelPickerOpen: true,
      }) as const,
    [props.terminalOpen],
  );
  const modelJumpLabelByKey = useMemo((): ReadonlyMap<string, string> => {
    if (modelJumpCommandByKey.size === 0) {
      return EMPTY_MODEL_JUMP_LABELS;
    }
    const shortcutLabelOptions = {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    };
    const mapping = new Map<string, string>();
    for (const [modelKey, command] of modelJumpCommandByKey) {
      const label = shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
      if (label) {
        mapping.set(modelKey, label);
      }
    }
    return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
  }, [keybindings, modelJumpCommandByKey, modelJumpShortcutContext]);
  // The user's Implementation tiers (Settings > Model family rankings) beside each model.
  const rankingTierOf = useMemo(
    () =>
      modelRankingTierLookup(
        serverSettings?.modelRankings ?? [],
        serverSettings?.providerInstances ?? {},
        instanceEntries.map((entry) => entry.snapshot),
        "implementation",
      ),
    [instanceEntries, serverSettings?.modelRankings, serverSettings?.providerInstances],
  );
  const activeMakerModelKey = activeMakerModel?.key ?? null;
  const modelListExtraData = useMemo(
    () => ({
      // One key can show as a model row or a route row; redraw when the rows change.
      filteredModelByKey,
      favoritesSet,
      modelJumpLabelByKey,
      activeModelKey,
      activeMakerModelKey,
      selectedModelKeySet,
      rankingTierOf,
    }),
    [
      filteredModelByKey,
      favoritesSet,
      modelJumpLabelByKey,
      activeModelKey,
      activeMakerModelKey,
      selectedModelKeySet,
      rankingTierOf,
    ],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isCommandPaletteOpen()) {
        return;
      }

      const command = resolveShortcutCommand(event, keybindings, {
        platform: navigator.platform,
        context: modelJumpShortcutContext,
      });
      if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
        event.preventDefault();
        event.stopPropagation();
        const next = adjacentModelPickerProvider({
          rails: railOrder,
          selected: selectedInstanceId,
          direction: command === "modelPicker.nextProvider" ? 1 : -1,
        });
        setSearchQuery("");
        handleSelectInstance(next);
        return;
      }
      const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
      if (jumpIndex === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      const targetModelKey = modelJumpModelKeys[jumpIndex];
      if (targetModelKey) pickModelKey(targetModelKey);
    };

    window.addEventListener("keydown", onWindowKeyDown, true);

    return () => {
      window.removeEventListener("keydown", onWindowKeyDown, true);
    };
  }, [
    handleSelectInstance,
    keybindings,
    modelJumpModelKeys,
    modelJumpShortcutContext,
    pickModelKey,
    railOrder,
    selectedInstanceId,
  ]);

  useLayoutEffect(() => {
    setShowTopScrollFade(false);
    setShowBottomScrollFade(filteredItemKeys.length > 5);
    let nestedFrame = 0;
    const frame = window.requestAnimationFrame(() => {
      updateModelListScrollFades();
      nestedFrame = window.requestAnimationFrame(updateModelListScrollFades);
    });
    return () => {
      window.cancelAnimationFrame(frame);
      window.cancelAnimationFrame(nestedFrame);
    };
  }, [filteredItemKeys, updateModelListScrollFades]);

  // The side column: where the selected model runs, then its effort. Comparing several models
  // has no single selection to describe.
  const comparing = props.selectedModels !== undefined;
  const activeRoute =
    activeMakerModel?.routes.find((route) => modelRouteHasSlug(route, activeRef)) ?? null;
  const showRunsIn = !comparing && activeMakerModel !== null && activeMakerModel.routes.length > 1;
  const sideReasoning: ReactNode = comparing ? null : (props.reasoningColumn ?? null);
  const accounts = useMemo(() => {
    if (!showRunsIn || activeMakerModel === null || props.accountSession === undefined) return null;
    return rankAccountRoutes(
      activeMakerModel.routes,
      accountProviders,
      activeRoute
        ? {
            instanceId: activeRoute.source.instanceId,
            model: activeRoute.source.slug,
            options: props.activeModelOptions,
          }
        : null,
      openedAt,
      (route) => routeDisabledReason(route) === null,
    );
  }, [
    accountProviders,
    activeMakerModel,
    activeRoute,
    props.activeModelOptions,
    openedAt,
    props.accountSession,
    routeDisabledReason,
    showRunsIn,
  ]);
  const runsInRoutes = useMemo((): ReadonlyArray<ModelPickerRunsInRoute> => {
    if (!showRunsIn || activeMakerModel === null) return [];
    // The user's accounts: the one with the most room first, as new chats prefer them.
    return (accounts?.routes ?? activeMakerModel.routes).map((route) => {
      const { entry } = route.source;
      const health = providerHealthNotice(entry.snapshot, openedAt, route.source.slug);
      return {
        key: route.key,
        label: route.label,
        driverKind: entry.driverKind,
        displayName: entry.displayName,
        acpRegistryAgentId: entry.acpRegistryAgentId,
        acpRegistryIconUrl: entry.acpRegistryIconUrl,
        selected: route === activeRoute,
        // A plan outside the pool (Google AI beside Claude Code) still says what it has left.
        room: accountRoomLabel(
          accounts?.byRoute.get(route.key) ??
            routeStanding(accountProviders, route.source.instanceId, route.source.slug, openedAt),
          openedAt,
        ),
        disabledReason: routeDisabledReason(route),
        canOpenSetup:
          props.onOpenProviderSetup !== undefined &&
          route.source.unavailableReason !== null &&
          selectableUnavailableInstanceIds.has(route.source.instanceId),
        health: health
          ? {
              kind: health.kind,
              title: health.outOfCredit ? health.message : health.title,
              outOfCredit: health.outOfCredit,
            }
          : null,
      };
    });
  }, [
    accountProviders,
    accounts,
    activeMakerModel,
    activeRoute,
    openedAt,
    props.onOpenProviderSetup,
    routeDisabledReason,
    selectableUnavailableInstanceIds,
    showRunsIn,
  ]);
  const showSideColumn = showRunsIn || sideReasoning !== null;

  return (
    <TooltipProvider delay={0}>
      <div className={cn(showSideColumn && "flex max-sm:flex-col")}>
        <div
          ref={pickerContentRef}
          className="relative flex min-h-44 max-h-86.5 w-screen max-w-90 flex-row overflow-hidden"
          // Hold the height from when the search started; results scroll instead of resizing.
          style={isSearching ? { height: searchHeight } : undefined}
          data-model-picker-content="true"
        >
          {/* Sidebar */}
          {showSidebar && (
            <ModelPickerSidebar
              selectedInstanceId={selectedInstanceId}
              onSelectInstance={handleSelectInstance}
              onFocusSearch={focusSearchInput}
              makers={makers}
              showFavorites
            />
          )}
          {/* Main content area */}
          <>
            <Combobox<string, boolean>
              inline
              items={allItemKeys}
              filteredItems={filteredItemKeys}
              filter={null}
              autoHighlight
              open
              virtualized
              multiple={onToggleModel !== undefined}
              value={onToggleModel ? [...selectedModelKeySet] : activeModelKey}
              onItemHighlighted={(modelKey, eventDetails) => {
                highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
                if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
                  void modelListRef.current?.scrollIndexIntoView?.({
                    index: eventDetails.index,
                    animated: false,
                  });
                }
              }}
              onValueChange={(value, details) => {
                const modelKey = Array.isArray(value)
                  ? (value.find((key) => !selectedModelKeySet.has(key)) ??
                    [...selectedModelKeySet].find((key) => !value.includes(key)))
                  : value;
                if (typeof modelKey !== "string") {
                  return;
                }
                const legacyMakerId = parseModelPickerLegacySectionKey(modelKey);
                if (legacyMakerId) {
                  toggleLegacySection(legacyMakerId);
                  return;
                }
                pickModelKey(
                  modelKey,
                  "shiftKey" in details.event && details.event.shiftKey === true,
                );
              }}
            >
              <div
                className={cn(
                  "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
                  showSidebar && "border-l border-border/70",
                )}
              >
                <ComboboxSearchInput
                  ref={searchInputRef}
                  placeholder="Search models..."
                  trailing={
                    props.environmentId !== null ? (
                      <span className="flex items-center gap-0.5">
                        {props.autoModelEnabled !== undefined && props.onAutoModelEnabledChange ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  aria-label="Auto: suggest a model for a new chat's first message"
                                  aria-pressed={props.autoModelEnabled}
                                  className="mr-0.5 inline-flex h-5.5 cursor-pointer items-center gap-1 rounded-full px-1.5 text-2xs font-medium text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:bg-foreground/8 aria-pressed:text-foreground"
                                  // Keeps focus, and so keyboard navigation, in the search field.
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() =>
                                    props.onAutoModelEnabledChange?.(!props.autoModelEnabled)
                                  }
                                >
                                  <SparklesIcon className="size-3" aria-hidden />
                                  Auto
                                </button>
                              }
                            />
                            <TooltipPopup side="top">
                              {props.autoModelEnabled
                                ? "Auto is on: suggests a model for a new chat's first message"
                                : "Auto is off"}
                            </TooltipPopup>
                          </Tooltip>
                        ) : null}
                        {modelManagerHarnessEntries.length > 0 ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  aria-label="Add or remove models"
                                  aria-pressed={modelManagerOpen}
                                  className="inline-flex size-6.5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring aria-pressed:text-foreground"
                                  // Keeps focus in the search field until the form takes it.
                                  onMouseDown={(event) => event.preventDefault()}
                                  onClick={() => setModelManagerOpen((value) => !value)}
                                >
                                  <PlusIcon className="size-3.5" />
                                </button>
                              }
                            />
                            <TooltipPopup side="top">Add or remove models</TooltipPopup>
                          </Tooltip>
                        ) : null}
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                aria-label={
                                  refreshingModels ? "Refreshing models" : "Refresh models"
                                }
                                aria-busy={refreshingModels}
                                disabled={refreshingModels}
                                className="inline-flex size-6.5 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default"
                                // Keeps focus, and so keyboard navigation, in the search field.
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={refreshModels}
                              >
                                <RefreshIcon refreshing={refreshingModels} size="sm" />
                              </button>
                            }
                          />
                          <TooltipPopup side="top">
                            {refreshingModels ? "Checking for new models…" : "Check for new models"}
                          </TooltipPopup>
                        </Tooltip>
                      </span>
                    ) : undefined
                  }
                  value={searchQuery}
                  onChange={(e) => {
                    if (!isSearching) setSearchHeight(pickerContentRef.current?.offsetHeight ?? 0);
                    setSearchQuery(e.target.value);
                  }}
                  onKeyDown={(e) => {
                    if (
                      showSidebar &&
                      !e.altKey &&
                      !e.ctrlKey &&
                      !e.metaKey &&
                      ((e.key === "ArrowLeft" && !e.shiftKey && searchQuery.length === 0) ||
                        (e.key === "Tab" && e.shiftKey))
                    ) {
                      const sidebar = e.currentTarget
                        .closest("[data-model-picker-content]")
                        ?.querySelector("[data-model-picker-sidebar]");
                      const button =
                        sidebar?.querySelector<HTMLButtonElement>(
                          'button[aria-pressed="true"]:not(:disabled)',
                        ) ?? sidebar?.querySelector<HTMLButtonElement>("button:not(:disabled)");
                      if (button) {
                        e.preventDefault();
                        e.stopPropagation();
                        button.focus();
                        return;
                      }
                    }
                    if (e.key === "Escape") {
                      e.preventDefault();
                      e.stopPropagation();
                      props.onRequestClose?.();
                      return;
                    }
                    if (e.key === "Enter" && highlightedModelKeyRef.current) {
                      (
                        e as typeof e & { preventBaseUIHandler?: () => void }
                      ).preventBaseUIHandler?.();
                      e.preventDefault();
                      e.stopPropagation();
                      const legacyMakerId = parseModelPickerLegacySectionKey(
                        highlightedModelKeyRef.current,
                      );
                      if (legacyMakerId) {
                        toggleLegacySection(legacyMakerId);
                        return;
                      }
                      pickModelKey(highlightedModelKeyRef.current, e.shiftKey);
                      return;
                    }
                    e.stopPropagation();
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onTouchStart={(e) => e.stopPropagation()}
                />

                {/* Model list */}
                <div
                  className="relative min-h-0 overflow-hidden pr-px"
                  style={{ height: modelListHeight }}
                >
                  <ComboboxListVirtualized>
                    <DndContext
                      sensors={favoriteDragSensors}
                      collisionDetection={closestCenter}
                      modifiers={FAVORITE_DRAG_MODIFIERS}
                      onDragEnd={handleFavoriteDragEnd}
                    >
                      <SortableContext
                        items={reorderableModelKeys}
                        strategy={verticalListSortingStrategy}
                      >
                        <LegendList<string>
                          ref={modelListRef}
                          data={filteredItemKeys}
                          extraData={modelListExtraData}
                          keyExtractor={(modelKey) => modelKey}
                          renderItem={({ item: modelKey, index }) => {
                            if (legacySection?.key === modelKey) {
                              return (
                                <div
                                  className={cn(index > 0 && "mt-1 border-t border-border/60 pt-1")}
                                >
                                  <ComboboxItem
                                    hideIndicator
                                    index={index}
                                    value={modelKey}
                                    aria-expanded={legacySection.isExpanded}
                                    className="group w-full cursor-pointer"
                                  >
                                    <div className="min-w-0 flex-1 text-left">
                                      <div className="text-xs font-medium leading-snug">
                                        Legacy models
                                      </div>
                                      <div className="mt-1 text-xs font-normal leading-snug text-muted-foreground/70">
                                        {legacySection.legacyModels.length} models
                                      </div>
                                    </div>
                                    <ChevronRightIcon
                                      className={cn(
                                        "size-4 transition-transform",
                                        legacySection.isExpanded && "rotate-90",
                                      )}
                                    />
                                  </ComboboxItem>
                                </div>
                              );
                            }
                            const model = filteredModelByKey.get(modelKey);
                            if (!model) {
                              return null;
                            }
                            const disabledReason =
                              model.disabledReason ??
                              getModelDisabledReason?.(model.instanceId, model.slug) ??
                              null;
                            const health = providerHealthNotice(
                              entryByInstanceId.get(model.instanceId)?.snapshot ?? {},
                              openedAt,
                              model.slug,
                            );
                            const row = (reorderHandle?: ReactNode) => (
                              <ModelListRow
                                key={modelKey}
                                index={index}
                                model={{ slug: model.slug, name: model.name }}
                                instanceId={model.instanceId}
                                driverKind={model.driverKind}
                                providerDisplayName={model.rowLabel}
                                providerAccentColor={model.instanceAccentColor}
                                acpRegistryAgentId={model.acpRegistryAgentId}
                                acpRegistryIconUrl={model.acpRegistryIconUrl}
                                isFavorite={isFavoriteItem(model)}
                                isSelected={
                                  selectedModelKeys !== undefined
                                    ? selectedModelKeySet.has(modelKey)
                                    : modelKey === activeModelKey
                                }
                                showSelection={selectedModelKeys !== undefined}
                                showProvider
                                useTriggerLabel={false}
                                showNewBadge={model.badge === "new"}
                                rankingTier={rankingTierOf(model.instanceId, model.slug)}
                                unavailable={model.isUnavailable === true}
                                creditWarning={health?.outOfCredit ? health.message : undefined}
                                jumpLabel={modelJumpLabelByKey.get(modelKey) ?? null}
                                disabledReason={disabledReason}
                                reorderHandle={reorderHandle}
                                onToggleFavorite={() => toggleItemFavorite(model)}
                              />
                            );
                            return canReorderFavorites ? (
                              <SortableModelRow key={modelKey} id={modelKey}>
                                {row}
                              </SortableModelRow>
                            ) : (
                              row()
                            );
                          }}
                          estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
                          drawDistance={480}
                          recycleItems
                          contentContainerClassName="pl-2 pr-px"
                          ItemSeparatorComponent={ModelListSeparator}
                          onLayout={updateModelListScrollFades}
                          onScroll={updateModelListScrollFades}
                          className={cn(
                            "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
                            getVirtualizedScrollFadeClassName({
                              top: showTopScrollFade,
                              bottom: showBottomScrollFade,
                            }),
                          )}
                        />
                      </SortableContext>
                    </DndContext>
                  </ComboboxListVirtualized>
                </div>
                {providerSetupEntries.length > 0 ? (
                  <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
                    {providerSetupEntries.map((entry) => (
                      <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
                        <p className="line-clamp-3 text-muted-foreground">
                          {getProviderStatusMessage(entry.snapshot)}
                        </p>
                        <InlineButton
                          className="mt-1"
                          onClick={() => {
                            props.onRequestClose?.();
                            props.onOpenProviderSetup?.(entry.instanceId);
                          }}
                        >
                          {providerSetupEntries.length > 1
                            ? `Set up ${entry.displayName}`
                            : "Open provider setup"}
                        </InlineButton>
                      </div>
                    ))}
                  </div>
                ) : (
                  <ComboboxEmpty className="empty:h-0">
                    <ListState
                      size="compact"
                      align="center"
                      {...modelPickerEmptyState(
                        isSearching,
                        selectedInstanceId === "favorites",
                        searchedModel !== null && modelManagerHarnessEntries.length > 0,
                      )}
                    />
                  </ComboboxEmpty>
                )}
                {healthNotice && !healthNotice.outOfCredit ? (
                  <p
                    className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
                    data-model-picker-health={healthNotice.kind}
                  >
                    <span
                      className={cn(
                        "font-medium",
                        healthNotice.outOfCredit || healthNotice.kind === "usage_limit"
                          ? "text-warning-foreground"
                          : "text-destructive-foreground",
                      )}
                    >
                      {healthNotice.outOfCredit ? "" : `${healthNotice.title}.`}
                    </span>{" "}
                    <span className="line-clamp-2 break-words">{healthNotice.message}</span>
                  </p>
                ) : null}
                {props.environmentId !== null ? (
                  <ModelManagerPanel
                    key={props.environmentId}
                    environmentId={props.environmentId}
                    harnesses={modelManagerHarnessEntries}
                    browsingInstanceId={
                      isSearching || selectedMakerId === null ? null : props.activeInstanceId
                    }
                    searchedModel={isSearching ? searchedModel : null}
                    open={modelManagerOpen}
                    onOpenChange={setModelManagerOpen}
                    onRequestClose={props.onRequestClose}
                  />
                ) : null}
                {updateRequiredNotices.map(({ instanceId, notice }) => (
                  <p
                    key={instanceId}
                    className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
                  >
                    {notice}{" "}
                    <InlineButton
                      onClick={() => {
                        props.onRequestClose?.();
                        void navigate({ to: "/settings/providers" });
                      }}
                    >
                      Provider settings
                    </InlineButton>
                  </p>
                ))}
              </div>
            </Combobox>
          </>
        </div>
        {showSideColumn ? (
          <div
            className={cn(
              "flex max-h-86.5 min-h-0 shrink-0 flex-col border-l border-border/70 bg-muted/40 max-sm:h-56 max-sm:w-full max-sm:border-t max-sm:border-l-0",
              // The effort slider's six stop labels (Low … Ultra) need this much room; route
              // names ("Hermes · OpenCode Go") a little more.
              showRunsIn ? "w-56" : "w-52",
            )}
            data-model-picker-side="true"
          >
            {showRunsIn && activeMakerModel ? (
              <ModelPickerRunsIn
                modelName={activeMakerModel.name}
                routes={runsInRoutes}
                note={balancesAccounts ? accounts?.newChatNote : null}
                onPick={(routeKey) => {
                  const route = activeMakerModel.routes.find(
                    (candidate) => candidate.key === routeKey,
                  );
                  // Runs in is where an account is picked by name.
                  if (route && routeDisabledReason(route) === null)
                    selectRoute(activeMakerModel, route, true);
                }}
                onOpenSetup={
                  props.onOpenProviderSetup
                    ? (routeKey) => {
                        const route = activeMakerModel.routes.find(
                          (candidate) => candidate.key === routeKey,
                        );
                        if (!route) return;
                        props.onRequestClose?.();
                        props.onOpenProviderSetup?.(route.source.instanceId);
                      }
                    : undefined
                }
              />
            ) : null}
            <ModelPickerStackedColumnContext value={showRunsIn}>
              {sideReasoning}
            </ModelPickerStackedColumnContext>
          </div>
        ) : null}
      </div>
    </TooltipProvider>
  );
});

/** Preserve the first catalog entry for aliases sharing a slug, as Array.find does. */
export function indexModelFamilies<
  T extends { readonly slug: string; readonly family?: string | undefined },
>(models: ReadonlyArray<T>): ReadonlyMap<string, T["family"] | undefined> {
  const families = new Map<string, T["family"] | undefined>();
  for (const model of models) {
    if (!families.has(model.slug)) families.set(model.slug, model.family);
  }
  return families;
}
