import { useLegacyPlanModeState } from "./use-legacy-plan-mode-enabled";
import { acpWorkModeDescriptor, findAcpApprovalModes } from "@t3tools/shared/acpComposer";
import type { ProviderInteractionMode } from "@t3tools/contracts";
import { useThreadSettingsDraft } from "./use-thread-settings-draft";
import { createV5StackNavigator as createNativeStackNavigator } from "../../native/createV5StackNavigator";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId } from "@t3tools/contracts";
import {
  modelPreferencesMigrationPatch,
  resolveModelPreferences,
} from "@t3tools/shared/serverSettings";
import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
  RuntimeMode,
  ServerProvider,
  ServerSettings,
} from "@t3tools/contracts";
import type { LegendListRenderItemProps } from "@legendapp/list/react-native";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import {
  getProviderOptionCurrentLabel,
  getProviderOptionCurrentValue,
  isReasoningOptionId,
} from "@t3tools/shared/model";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { type NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Haptics from "expo-haptics";
import { AsyncResult } from "effect/reactivity";
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Alert,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  TextInput,
  View,
} from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { EmptyState } from "../../components/EmptyState";
import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AutoModelToggle } from "../autoModel/AutoModelToggle";
import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { MaterialButton } from "../../components/MaterialButton";
import { MaterialIconButton } from "../../components/MaterialIconButton";
import { MakerLogoIcon, ProviderIcon } from "../../components/ProviderIcon";
import type { ModelMakerLogo } from "@t3tools/client-runtime/model-makers";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { FastModeBolt } from "../../components/FastModeBolt";
import { cn } from "../../lib/cn";
import {
  buildModelOptions,
  groupByProvider,
  providerDisplayLabel,
  type ModelOption,
  type ProviderGroup,
  useModelListSelection,
} from "../../lib/modelOptions";
import { canAddModelsTo, unlistedSearchedModel } from "@t3tools/shared/modelRefs";
import { ModelManagerCard, type ModelManagerCardHarness } from "./ModelManagerCard";
import { fastModeControl } from "../../lib/providerOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  rememberModelOptions,
  withRememberedModelOptions,
} from "../../state/use-model-option-memory";
import {
  NativeHeaderToolbar,
  NativeStackScreenOptions,
  nativeHeaderScrollEdgeEffects,
} from "../../native/StackHeader";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { ChatGptSharingStatus } from "./ChatGptSharingStatus";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { mobilePreferencesAtom } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { useNewTaskFlow } from "./new-task-flow-provider";
import { MaterialScreenContent } from "../../components/MaterialScreenContent";
import {
  createProviderCatalogRefreshRunner,
  providerCatalogRefreshError,
} from "./provider-catalog-refresh";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
} from "../layout/native-mail-search-toolbar";
import { useNativeMailSearchToolbar } from "../../native/use-native-mail-search-toolbar";
import { ModelRow, ChoiceRow } from "./ThreadSettingsRows";
import { ThreadSettingsRowDivider } from "./ThreadSettingsRows.shared";
import { ThreadSettingsEffort } from "./ThreadSettingsEffort";
import {
  findMakerModel,
  makerUsesOf,
  type ModelRouteMemory,
} from "@t3tools/client-runtime/model-makers";
import { resolveModelPickerFavorites } from "@t3tools/client-runtime/model-picker-catalog";
import {
  accountPinAfterPick,
  rankAccountRoutes,
  routeStanding,
  type AccountRouteSession,
} from "@t3tools/client-runtime/account-routes";
import {
  buildModelOptionMakerCatalog,
  modelOptionRoute,
  orderMakerGroupsByUse,
  readModelRouteMemory,
  routeRowOption,
  routeAccountDetails,
  saveModelRoute,
  type ModelOptionMakerGroup,
  type ModelOptionMakerModel,
} from "./modelMakerCatalog";
import {
  compatibleRuntimeModeForChoices,
  runtimeModeChoicesForSupportedModes,
  selectableChoices,
} from "./thread-settings-options";
import {
  canCommitPendingModel,
  modelFavoriteKey,
  pendingModelAfterPress,
  threadSettingsListItems,
} from "./thread-settings-sheet-state";
import {
  FAVORITES_PROVIDER_FILTER,
  MAKER_FILTER_PREFIX,
  type MakerMarkProps,
  type ThreadSettingsCatalogRowItem,
  type ThreadSettingsProviderCatalog,
  useThreadSettingsCatalogItems,
} from "./use-thread-settings-catalog-items";

/**
 * Keep measured row changes stable, but let catalog mutations use the list's
 * native bounds so a filtered catalog that underflows returns to the top.
 */
const THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;
const THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_CATALOG_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_CATALOG_EXIT_TRANSITION = FadeOut.duration(120);
const THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION = LinearTransition.duration(180);
const THREAD_SETTINGS_OPTION_ENTER_TRANSITION = FadeIn.duration(140);
const THREAD_SETTINGS_OPTION_EXIT_TRANSITION = FadeOut.duration(100);
const THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(
  Platform.OS,
  Platform.Version,
);
const EMPTY_MODEL_FAVORITES: ReadonlyArray<{
  readonly provider: ProviderInstanceId;
  readonly model: string;
}> = [];
const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** A maker's mark: its harness glyph or registry icon, its own logo, or its initials. */
function MakerMark(props: MakerMarkProps & { readonly size: number }) {
  if (props.logo !== undefined) return <MakerLogoIcon logo={props.logo} size={props.size} />;
  if (props.monogram !== undefined)
    return (
      <View
        className="items-center justify-center rounded bg-subtle-strong px-0.5"
        style={{ height: props.size, minWidth: props.size }}
      >
        <Text className="text-3xs font-t3-bold text-foreground-muted">{props.monogram}</Text>
      </View>
    );
  return <ProviderIcon iconUrl={props.iconUrl} provider={props.driver} size={props.size} />;
}

/** Provider catalog header with its harness logo and disclosure state. */
function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly iconUrl: string | undefined;
  readonly symbol?: "star.fill" | undefined;
  readonly logo?: ModelMakerLogo | undefined;
  readonly monogram?: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const content = (
    <>
      {props.symbol !== undefined ? (
        <SymbolView
          name={props.symbol}
          size={14}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      ) : (
        <MakerMark
          driver={props.driver}
          iconUrl={props.iconUrl}
          logo={props.logo}
          monogram={props.monogram}
          size={15}
        />
      )}
      <Text
        className="min-w-0 flex-1 text-sm font-t3-medium text-foreground-muted"
        numberOfLines={1}
      >
        {props.label}
      </Text>
      {props.collapsible ? (
        <>
          {props.collapsed ? (
            <Text className="shrink-0 text-xs text-foreground-muted">{props.modelCount}</Text>
          ) : null}
          <SymbolView
            name={props.collapsed ? "chevron.down" : "chevron.up"}
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </>
      ) : null}
    </>
  );

  if (props.collapsible) {
    return (
      <Pressable
        accessibilityLabel={`${props.label}, ${props.modelCount} ${props.modelCount === 1 ? "model" : "models"}`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        className="mx-4 mt-1 min-h-[44px] flex-row items-center gap-2 rounded-xl px-1 pt-2 active:opacity-60 android:min-h-12"
        onPress={props.onToggle}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View accessibilityRole="header" className="mx-4 min-h-9 flex-row items-center gap-2 px-1 pt-1">
      {content}
    </View>
  );
}

/** Compact row that opens a single-choice submenu panel. */
function DisclosureRow(props: {
  readonly label: string;
  readonly fast?: boolean;
  readonly fastLit?: boolean;
  readonly value: string | undefined;
  readonly onPress: () => void;
  readonly isLast?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn(
        "min-h-[44px] flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle android:min-h-14",
        !props.isLast && "android:border-b android:border-border-subtle",
      )}
    >
      <Text className="min-w-0 shrink text-sm font-t3-medium text-foreground">{props.label}</Text>
      {props.fast ? <FastModeBolt lit={props.fastLit ?? true} /> : null}
      <View className="flex-1" />
      {props.value ? (
        <Text
          className="max-w-[44%] shrink text-right text-sm text-foreground-muted"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {props.value}
        </Text>
      ) : null}
      <SymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-icon-subtle"
        type="monochrome"
      />
      {props.isLast ? null : <ThreadSettingsRowDivider />}
    </Pressable>
  );
}

function SwitchRow(props: {
  readonly label: string;
  /** What switching it on means, under the label (a harness's own words). */
  readonly description?: string | undefined;
  readonly fast?: boolean;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly isLast?: boolean;
}) {
  return (
    <View
      className={cn(
        "min-h-[44px] flex-row items-center justify-between bg-grouped-card px-4 py-1",
        !props.isLast && "android:border-b android:border-border-subtle",
      )}
    >
      <View className="flex-1 pr-3">
        <View className="flex-row items-center gap-2">
          <Text className="min-w-0 shrink text-sm font-t3-medium text-foreground">
            {props.label}
          </Text>
          {props.fast ? <FastModeBolt lit={props.value} /> : null}
        </View>
        {props.description ? (
          <Text className="pb-1 pt-0.5 text-xs leading-4 text-foreground-muted">
            {props.description}
          </Text>
        ) : null}
      </View>
      {Platform.OS === "ios" ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityLabel={props.label}
          accessibilityHint={props.description}
          accessibilityState={{ checked: props.value }}
          onPress={() => props.onValueChange(!props.value)}
          className="-my-1 h-[44px] justify-center"
        >
          <View pointerEvents="none" accessibilityElementsHidden>
            <ThemedSwitch value={props.value} />
          </View>
        </Pressable>
      ) : (
        <ThemedSwitch
          accessibilityLabel={props.label}
          onValueChange={props.onValueChange}
          value={props.value}
        />
      )}
      {props.isLast ? null : <ThreadSettingsRowDivider />}
    </View>
  );
}

type ThreadSettingsSubmenuPage =
  | { readonly kind: "descriptor"; readonly id: string }
  | { readonly kind: "runtime" }
  | { readonly kind: "routes" };

type ThreadSettingsSessionProps = {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: ProjectId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  /** Only existing chats pin model changes to their current account. */
  readonly currentThreadInstanceId?: ProviderInstanceId | undefined;
  /** The user picked a new chat's account by name: it is kept while other models are tried. */
  readonly accountPinned?: boolean | undefined;
  readonly lockedProviderInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly selectedModel: ModelSelection | null;
  readonly reportedModelSelection?: ModelSelection | null;
  /** `accountPinned`: the account was picked by name under Runs in. */
  readonly onSelectModel: (option: ModelOption, accountPinned: boolean) => void;
  readonly optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly onUpdateOptionSelections: (selections: ReadonlyArray<ProviderOptionSelection>) => void;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly onUpdateInteractionMode?: (mode: ProviderInteractionMode) => void;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  /** A subagent works with its lead chat's access: the picker offers no runtime of its own. */
  readonly runtimeHidden?: boolean | undefined;
  readonly prompt?: string | undefined;
  readonly onPromptChange?: ((prompt: string) => void) | undefined;
};

export type ExistingThreadSettingsRouteSession = ThreadSettingsSessionProps & {
  readonly ownerId: string;
};

type ExistingThreadSettingsRouteContextValue = {
  readonly session: ExistingThreadSettingsRouteSession | null;
  readonly present: (session: ExistingThreadSettingsRouteSession) => void;
  readonly clear: (ownerId: string) => void;
};

const ExistingThreadSettingsRouteContext =
  createContext<ExistingThreadSettingsRouteContextValue | null>(null);

/** Bridges the active thread's settings state into the root native sheet route. */
export function ExistingThreadSettingsRouteProvider(props: { readonly children: ReactNode }) {
  const [session, setSession] = useState<ExistingThreadSettingsRouteSession | null>(null);
  const present = useCallback((nextSession: ExistingThreadSettingsRouteSession) => {
    setSession(nextSession);
  }, []);
  const clear = useCallback((ownerId: string) => {
    setSession((current) => (current?.ownerId === ownerId ? null : current));
  }, []);
  const value = useMemo(() => ({ session, present, clear }), [clear, present, session]);

  return (
    <ExistingThreadSettingsRouteContext.Provider value={value}>
      {props.children}
    </ExistingThreadSettingsRouteContext.Provider>
  );
}

export function useExistingThreadSettingsRoutePresentation() {
  const value = use(ExistingThreadSettingsRouteContext);
  if (!value) {
    throw new Error(
      "useExistingThreadSettingsRoutePresentation must be used inside ExistingThreadSettingsRouteProvider.",
    );
  }
  return value;
}

type ThreadSettingsSessionValue = {
  readonly environmentId: EnvironmentId | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerGroups: ReadonlyArray<ProviderGroup>;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly balanceAccounts: boolean;
  readonly accountSession: AccountRouteSession;
  /** Says where new chats start; a running chat has no such note. */
  readonly isNewChat: boolean;
  readonly favoriteKeys: ReadonlySet<string>;
  readonly favoritesLoaded: boolean;
  readonly toggleFavorite: (option: ModelOption) => void;
  readonly toggleHidden: (option: ModelOption) => void;
  readonly pendingHiddenKeys: ReadonlySet<string>;
  readonly manageHidden: boolean;
  readonly setManageHidden: (value: boolean) => void;
  readonly runtimeMode: RuntimeMode;
  readonly runtimeModeChoices: ReturnType<typeof runtimeModeChoicesForSupportedModes>;
  readonly onUpdateRuntimeMode: (mode: RuntimeMode) => void;
  readonly runtimeHidden: boolean;
  readonly displayedDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly displayedPrompt: string;
  readonly canChangePrompt: boolean;
  readonly displayedModelSelection: ModelSelection | null;
  readonly reportedModelSelection: ModelSelection | null;
  readonly providerExpansionOverrides: ReadonlySet<string>;
  readonly hasLegacyModels: boolean;
  readonly pendingModel: ModelOption | null;
  readonly hasPendingChanges: boolean;
  readonly providerFilter: string | null;
  readonly searchQuery: string;
  readonly showLegacy: boolean;
  readonly applyOptionChange: (id: string, value: string | boolean) => void;
  readonly commitPendingModel: () => boolean;
  readonly isApplied: (option: ModelOption) => boolean;
  readonly isDisplayed: (option: ModelOption) => boolean;
  /** `accountPick`: the row names an account (Runs in), not only a model. */
  readonly pressModel: (option: ModelOption, accountPick?: boolean) => void;
  /** Every provider group. */
  readonly allProviderGroups: ReadonlyArray<ProviderGroup>;
  /** Harnesses the Models chat can add models to, off ones included. */
  readonly modelManagerHarnesses: ReadonlyArray<ModelManagerCardHarness>;
  /** The catalog by model maker; a model reached through several harnesses is one entry. */
  readonly makerGroups: ReadonlyArray<ModelOptionMakerGroup>;
  readonly routeMemory: ModelRouteMemory;
  /** The model shown as picked (staged or applied), with all its routes. */
  readonly displayedMakerModel: ModelOptionMakerModel | null;
  readonly displayedOption: ModelOption | null;
  readonly setProviderFilter: (providerKey: string | null) => void;
  readonly setSearchQuery: (query: string) => void;
  readonly setShowLegacy: (showLegacy: boolean) => void;
  readonly toggleProvider: (providerKey: string) => void;
};

const ThreadSettingsSessionContext = createContext<ThreadSettingsSessionValue | null>(null);

/** Owns the staged model and option state for one picker presentation. */
function ThreadSettingsSessionProvider(
  props: ThreadSettingsSessionProps & { readonly children: ReactNode },
) {
  const registry = use(RegistryContext);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const { enabled: planModeEnabled } = useLegacyPlanModeState();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const config = props.environmentId ? configs.get(props.environmentId) : undefined;
  const settings = config?.settings;
  const providers = config?.providers ?? EMPTY_PROVIDERS;
  const balanceAccounts = settings?.balanceAccounts === true;
  const [manageHidden, setManageHidden] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const draft = useThreadSettingsDraft(props);
  const {
    pendingModel,
    setPendingModel,
    applyOptionChange: applyDraftOptionChange,
    save: saveDraft,
  } = draft;
  const pendingHidden = useRef(new Set<string>());
  const pendingFavorites = useRef(
    new Map<string, { favorite: boolean; settings: ServerSettings; pending: boolean }>(),
  );
  const [pendingHiddenKeys, setPendingHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const modelListSelection = useModelListSelection(props.selectedModel);
  const allProviderGroups = useMemo(
    () =>
      manageHidden && config
        ? groupByProvider(
            buildModelOptions(
              config,
              modelListSelection,
              props.lockedProviderInstanceId,
              props.projectId,
              true,
            ),
          )
        : props.providerGroups,
    [
      config,
      manageHidden,
      props.providerGroups,
      modelListSelection,
      props.lockedProviderInstanceId,
      props.projectId,
    ],
  );
  const providerGroups = allProviderGroups;
  const modelManagerHarnesses = useMemo<ReadonlyArray<ModelManagerCardHarness>>(
    () =>
      (config?.providers ?? [])
        .map((provider) => ({
          instanceId: provider.instanceId,
          driver: provider.driver,
          enabled: provider.enabled,
          label: providerDisplayLabel(provider),
        }))
        .filter(canAddModelsTo),
    [config],
  );
  // Keyed by which models are selected, not their options: rebuilding the
  // catalog of every model on each effort tap made option changes lag.
  const pendingListSelection = useModelListSelection(pendingModel?.selection ?? null);
  const legacyFavorites = AsyncResult.isSuccess(preferences)
    ? (preferences.value.modelFavorites ?? EMPTY_MODEL_FAVORITES)
    : EMPTY_MODEL_FAVORITES;
  const favoritesLoaded =
    settings !== undefined && (settings.favorites !== null || AsyncResult.isSuccess(preferences));
  const modelFavorites = useMemo(
    () =>
      resolveModelPreferences(settings ?? DEFAULT_SERVER_SETTINGS, { favorites: legacyFavorites })
        .favorites,
    [legacyFavorites, settings],
  );
  const catalog = useMemo(
    () =>
      buildModelOptionMakerCatalog(
        allProviderGroups.flatMap((group) => group.models),
        {
          providers: config?.providers ?? [],
          providerInstances: settings?.providerInstances,
          selected: [modelListSelection, pendingListSelection].flatMap((selection) =>
            selection ? [{ instanceId: selection.instanceId, slug: selection.model }] : [],
          ),
          favorites: modelFavorites.map((favorite) => ({
            instanceId: favorite.provider,
            slug: favorite.model,
          })),
          search: searchQuery,
        },
      ),
    [
      allProviderGroups,
      config?.providers,
      modelFavorites,
      pendingListSelection,
      modelListSelection,
      searchQuery,
      settings?.providerInstances,
    ],
  );
  // Read once per opening: the list must not reorder under a finger while chats update.
  const [makerUses] = useState(() => ({
    uses: makerUsesOf(appAtomRegistry.get(environmentThreadShells.threadShellsAtom)),
    now: Date.now(),
  }));
  const isNewChat = props.currentThreadInstanceId === undefined;
  // A running chat keeps its account; so does a new chat put on one by name.
  const appliedAccount =
    props.currentThreadInstanceId ??
    (props.accountPinned === true && props.selectedModel ? props.selectedModel.instanceId : null);
  // An account picked under Runs in holds for the models tried after it, before Save too.
  const [stagedAccount, setStagedAccount] = useState<string | null | undefined>(undefined);
  const keptAccount =
    pendingModel === null || stagedAccount === undefined ? appliedAccount : stagedAccount;
  const accountSession = useMemo(
    () => ({
      now: makerUses.now,
      instanceId: keptAccount,
      balance: balanceAccounts,
      selection: draft.selection,
    }),
    [balanceAccounts, keptAccount, makerUses.now, draft.selection],
  );
  const routeSources = useMemo(
    () => allProviderGroups.flatMap((group) => group.models.map(modelOptionRoute)),
    [allProviderGroups],
  );
  const makerGroups = useMemo(
    () => orderMakerGroupsByUse(catalog.groups, makerUses.uses, routeSources, makerUses.now),
    [catalog.groups, makerUses, routeSources],
  );
  const routeMemory = useMemo(() => readModelRouteMemory(), []);
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, "model favorites update");
  useEffect(() => {
    if (!props.environmentId || !settings || !AsyncResult.isSuccess(preferences)) return;
    const patch = modelPreferencesMigrationPatch(settings, { favorites: legacyFavorites });
    if (patch) void saveSettings({ environmentId: props.environmentId, input: { patch } });
  }, [legacyFavorites, preferences, props.environmentId, saveSettings, settings]);
  const favoriteKeys = useMemo(
    () =>
      new Set(
        resolveModelPickerFavorites(
          modelFavorites.map((favorite) => ({
            instanceId: favorite.provider,
            slug: favorite.model,
          })),
          catalog.resolveFavorite,
        ).map(({ target }) =>
          modelFavoriteKey(ProviderInstanceId.make(target.instanceId), target.slug),
        ),
      ),
    [catalog, modelFavorites],
  );
  const toggleFavorite = useCallback(
    async (option: ModelOption) => {
      if (!favoritesLoaded || !props.environmentId) return;
      const currentSettings = registry
        .get(environmentServerConfigsAtom)
        .get(props.environmentId)?.settings;
      if (!currentSettings) return;
      const favorites = resolveModelPreferences(currentSettings, {
        favorites: legacyFavorites,
      }).favorites;
      const key = JSON.stringify([
        props.environmentId,
        option.selection.instanceId,
        option.selection.model,
      ]);
      const previous = pendingFavorites.current.get(key);
      const matchingFavorites = favorites.filter((favorite) => {
        const target = catalog.resolveFavorite({
          instanceId: favorite.provider,
          slug: favorite.model,
        });
        return (
          target?.instanceId === option.selection.instanceId &&
          target.slug === option.selection.model
        );
      });
      const previousFavorite =
        previous && (previous.pending || previous.settings.favorites === currentSettings.favorites)
          ? previous.favorite
          : matchingFavorites.length > 0;
      const pending = { favorite: !previousFavorite, settings: currentSettings, pending: true };
      pendingFavorites.current.set(key, pending);
      void Haptics.selectionAsync();
      try {
        const result = await saveSettings({
          environmentId: props.environmentId,
          input: {
            patch: {
              setModelFavorites:
                !pending.favorite && matchingFavorites.length > 0
                  ? matchingFavorites.map((favorite) => ({ ...favorite, favorite: false }))
                  : [
                      {
                        provider: option.selection.instanceId,
                        model: option.selection.model,
                        favorite: pending.favorite,
                      },
                    ],
              ...(currentSettings.favorites === null
                ? { migrateModelPreferences: { favorites } }
                : {}),
            },
          },
        });
        if (
          AsyncResult.isSuccess(result) &&
          registry.get(environmentServerConfigsAtom).get(props.environmentId)?.settings
            .favorites === currentSettings.favorites
        ) {
          pending.pending = false;
        }
      } finally {
        if (pending.pending && pendingFavorites.current.get(key) === pending) {
          if (
            previous &&
            !previous.pending &&
            registry.get(environmentServerConfigsAtom).get(props.environmentId)?.settings
              .favorites === previous.settings.favorites
          ) {
            pendingFavorites.current.set(key, previous);
          } else {
            pendingFavorites.current.delete(key);
          }
        }
      }
    },
    [catalog, favoritesLoaded, legacyFavorites, props.environmentId, registry, saveSettings],
  );
  const toggleHidden = useCallback(
    (option: ModelOption) => {
      if (
        !settings ||
        !props.environmentId ||
        !option.canHide ||
        pendingHidden.current.has(option.key)
      )
        return;
      pendingHidden.current.add(option.key);
      setPendingHiddenKeys(new Set(pendingHidden.current));
      void Haptics.selectionAsync();
      void saveSettings({
        environmentId: props.environmentId,
        input: {
          patch: {
            setModelsHidden: [
              {
                provider: option.selection.instanceId,
                model: option.selection.model,
                hidden: !option.isHidden,
              },
            ],
          },
        },
      }).then(() => {
        pendingHidden.current.delete(option.key);
        setPendingHiddenKeys(new Set(pendingHidden.current));
      });
    },
    [props.environmentId, saveSettings, settings],
  );
  const [showLegacyToggle, setShowLegacyToggle] = useState(false);
  const [requestedProviderFilter, setProviderFilter] = useState<string | null>(null);
  const providerFilter =
    requestedProviderFilter?.startsWith(MAKER_FILTER_PREFIX) &&
    !makerGroups.some(
      (group) => `${MAKER_FILTER_PREFIX}${group.maker.id}` === requestedProviderFilter,
    )
      ? null
      : requestedProviderFilter;
  const [providerExpansionOverrides, setProviderExpansionOverrides] = useState<ReadonlySet<string>>(
    () => new Set(),
  );

  const isApplied = useCallback(
    (option: ModelOption) =>
      option.selection.instanceId === modelListSelection?.instanceId &&
      option.selection.model === modelListSelection.model,
    [modelListSelection],
  );
  // The list highlights the staged pick; Save turns it into the applied one.
  const pendingModelKey = pendingModel?.key ?? null;
  const isDisplayed = useCallback(
    (option: ModelOption) =>
      pendingModelKey !== null ? option.key === pendingModelKey : isApplied(option),
    [isApplied, pendingModelKey],
  );

  const approvalModes = useMemo(() => findAcpApprovalModes(draft.descriptors), [draft.descriptors]);
  const displayedDescriptors = useMemo(() => {
    if (!approvalModes) return draft.descriptors;
    return draft.descriptors.flatMap((descriptor) =>
      descriptor !== approvalModes.descriptor
        ? [descriptor]
        : approvalModes.workModes.length > 1
          ? [acpWorkModeDescriptor(approvalModes, props.interactionMode ?? "default")]
          : [],
    );
  }, [approvalModes, draft.descriptors, props.interactionMode]);
  const applyOptionChange = useCallback(
    (id: string, value: string | boolean) => {
      if (id === approvalModes?.descriptor.id && !pendingModel) {
        if (planModeEnabled && value === approvalModes.plan?.id && props.onUpdateInteractionMode) {
          props.onUpdateInteractionMode("plan");
          return;
        }
        if (props.interactionMode === "plan") props.onUpdateInteractionMode?.("default");
      }
      applyDraftOptionChange(id, value);
    },
    [
      approvalModes,
      applyDraftOptionChange,
      pendingModel,
      props.interactionMode,
      props.onUpdateInteractionMode,
      planModeEnabled,
    ],
  );
  const displayedModel = useMemo(
    () =>
      pendingModel ??
      props.providerGroups.flatMap((group) => group.models).find((option) => isApplied(option)) ??
      null,
    [isApplied, pendingModel, props.providerGroups],
  );
  const displayedOption = useMemo(
    () =>
      pendingModel ??
      allProviderGroups.flatMap((group) => group.models).find((option) => isApplied(option)) ??
      null,
    [allProviderGroups, isApplied, pendingModel],
  );
  const displayedMakerModel = useMemo(() => {
    const selection = pendingModel?.selection ?? props.selectedModel;
    return selection
      ? findMakerModel(makerGroups, { instanceId: selection.instanceId, slug: selection.model })
      : null;
  }, [makerGroups, pendingModel, props.selectedModel]);
  const runtimeModeChoices = useMemo(() => {
    const supported = runtimeModeChoicesForSupportedModes(displayedModel?.supportedRuntimeModes);
    if (!approvalModes) return supported;
    return supported.flatMap((choice) => {
      const native = approvalModes.approvals[choice.mode];
      return native ? [{ ...choice, description: native.description ?? choice.description }] : [];
    });
  }, [approvalModes, displayedModel?.supportedRuntimeModes]);
  const compatibleRuntimeMode = compatibleRuntimeModeForChoices(
    draft.runtimeMode,
    runtimeModeChoices,
  );

  const hasLegacyModels = useMemo(
    () =>
      manageHidden &&
      props.providerGroups.some((group) => group.models.some((model) => model.isLegacy)),
    [manageHidden, props.providerGroups],
  );
  const commitPendingModel = useCallback(() => {
    if (pendingModel) {
      if (!canCommitPendingModel(pendingModel, props.providerGroups)) {
        Alert.alert(
          "Model unavailable",
          "Set up this provider on web or desktop, or select another model.",
        );
        return false;
      }
      void Haptics.selectionAsync();
      rememberModelOptions(
        pendingModel.selection.instanceId,
        pendingModel.selection.model,
        pendingModel.selection.options ?? [],
      );
      const ref = {
        instanceId: pendingModel.selection.instanceId,
        slug: pendingModel.selection.model,
      };
      const model = findMakerModel(makerGroups, ref);
      if (model) saveModelRoute(model, ref, providers, balanceAccounts);
    }
    saveDraft(
      compatibleRuntimeMode,
      pendingModel !== null && isNewChat && keptAccount === pendingModel.selection.instanceId,
    );
    return true;
  }, [
    isNewChat,
    keptAccount,
    makerGroups,
    pendingModel,
    props.providerGroups,
    providers,
    balanceAccounts,
    saveDraft,
    compatibleRuntimeMode,
  ]);

  const toggleProvider = useCallback((providerKey: string) => {
    setProviderExpansionOverrides((current) => {
      const next = new Set(current);
      if (!next.delete(providerKey)) {
        next.add(providerKey);
      }
      return next;
    });
  }, []);

  const pressModel = useCallback(
    (option: ModelOption, accountPick = false) => {
      void Haptics.selectionAsync();
      const instanceId = option.selection.instanceId;
      const pinned = accountPinAfterPick({
        pinned: keptAccount !== null,
        previousInstanceId: keptAccount,
        nextInstanceId: instanceId,
        accountPick,
      });
      // Without a pin a running chat is back on its own account, a new chat on the balance.
      setStagedAccount(pinned ? instanceId : (props.currentThreadInstanceId ?? null));
      setPendingModel((current) =>
        pendingModelAfterPress({
          current,
          pressed: { ...option, selection: withRememberedModelOptions(option.selection) },
          // Naming the account a new chat is on by balance is a change too: it now stays.
          pressedIsApplied: isApplied(option) && (!accountPick || appliedAccount === instanceId),
        }),
      );
    },
    [appliedAccount, isApplied, keptAccount, props.currentThreadInstanceId, setPendingModel],
  );

  const value = useMemo<ThreadSettingsSessionValue>(
    () => ({
      environmentId: props.environmentId,
      providerInstanceId: props.providerInstanceId,
      providerGroups,
      providers,
      balanceAccounts,
      accountSession,
      isNewChat,
      manageHidden,
      setManageHidden,
      toggleHidden,
      pendingHiddenKeys,
      runtimeMode: compatibleRuntimeMode,
      runtimeModeChoices,
      onUpdateRuntimeMode: draft.setRuntimeMode,
      runtimeHidden: props.runtimeHidden === true,
      displayedDescriptors,
      displayedPrompt: draft.displayedPrompt,
      canChangePrompt: props.onPromptChange !== undefined,
      displayedModelSelection: draft.selection,
      reportedModelSelection:
        draft.selection !== props.selectedModel ? null : (props.reportedModelSelection ?? null),
      hasPendingChanges: draft.hasChanges,
      favoriteKeys,
      favoritesLoaded,
      providerExpansionOverrides,
      hasLegacyModels,
      pendingModel,
      providerFilter,
      searchQuery,
      showLegacy: showLegacyToggle,
      applyOptionChange,
      commitPendingModel,
      isApplied,
      isDisplayed,
      pressModel,
      allProviderGroups,
      modelManagerHarnesses,
      makerGroups,
      routeMemory,
      displayedMakerModel,
      displayedOption,
      setProviderFilter,
      setSearchQuery,
      setShowLegacy: setShowLegacyToggle,
      toggleProvider,
      toggleFavorite,
    }),
    [
      applyOptionChange,
      commitPendingModel,
      compatibleRuntimeMode,
      displayedDescriptors,
      draft.displayedPrompt,
      props.onPromptChange,
      favoriteKeys,
      favoritesLoaded,
      providerExpansionOverrides,
      hasLegacyModels,
      isApplied,
      isDisplayed,
      props.environmentId,
      props.selectedModel,
      props.reportedModelSelection,
      props.providerInstanceId,
      pendingModel,
      pressModel,
      allProviderGroups,
      modelManagerHarnesses,
      makerGroups,
      routeMemory,
      displayedMakerModel,
      displayedOption,
      providerFilter,
      draft.setRuntimeMode,
      draft.selection,
      draft.hasChanges,
      providerGroups,
      providers,
      balanceAccounts,
      accountSession,
      isNewChat,
      manageHidden,
      toggleHidden,
      pendingHiddenKeys,
      runtimeModeChoices,
      props.runtimeHidden,
      searchQuery,
      showLegacyToggle,
      toggleProvider,
      toggleFavorite,
    ],
  );

  return (
    <ThreadSettingsSessionContext.Provider value={value}>
      {props.children}
    </ThreadSettingsSessionContext.Provider>
  );
}

function useThreadSettingsSession() {
  const value = use(ThreadSettingsSessionContext);
  if (!value) {
    throw new Error("useThreadSettingsSession must be used inside ThreadSettingsSessionProvider.");
  }
  return value;
}

type ThreadSettingsCatalogItem =
  | ThreadSettingsCatalogRowItem
  | {
      readonly kind: "empty";
      readonly key: "empty";
    }
  | {
      readonly kind: "modelManager";
      readonly key: "modelManager";
      readonly environmentId: EnvironmentId;
      readonly harnesses: ReadonlyArray<ModelManagerCardHarness>;
      readonly browsingInstanceId: string | null;
      readonly searchedModel: ReturnType<typeof unlistedSearchedModel>;
    }
  | {
      readonly kind: "options";
      readonly key: "options";
    }
  | {
      readonly kind: "catalogSettings";
      readonly key: "catalogSettings";
    };

function ThreadSettingsModelListRow(props: {
  readonly option: ModelOption;
  readonly maker?: MakerMarkProps | undefined;
  readonly routes?: ReadonlyArray<ModelOption> | undefined;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const session = useThreadSettingsSession();
  const onPress = useCallback(
    () => session.pressModel(props.option),
    [props.option, session.pressModel],
  );
  const routes = props.routes ?? [props.option];
  const starred = routes.filter((option) => session.favoriteKeys.has(option.key));

  return (
    <ModelRow
      icon={props.maker ? <MakerMark {...props.maker} size={20} /> : undefined}
      isFirst={props.isFirst}
      isLast={props.isLast}
      onPress={onPress}
      isFavorite={starred.length > 0}
      favoritesLoaded={session.favoritesLoaded}
      // A model row stars its route; unstarring clears every route it starred.
      onToggleFavorite={() => {
        if (starred.length === 0) session.toggleFavorite(props.option);
        for (const option of starred) session.toggleFavorite(option);
      }}
      onToggleHidden={
        session.manageHidden && props.option.canHide
          ? () => session.toggleHidden(props.option)
          : undefined
      }
      hiddenUpdatePending={session.pendingHiddenKeys.has(props.option.key)}
      option={props.option}
      selected={routes.some(session.isDisplayed)}
    />
  );
}

function ThreadSettingsProviderListHeader(props: {
  readonly provider: ThreadSettingsProviderCatalog;
}) {
  const session = useThreadSettingsSession();
  const onToggle = useCallback(
    () => session.toggleProvider(props.provider.key),
    [props.provider.key, session.toggleProvider],
  );

  const header = (
    <ProviderHeader
      collapsible={props.provider.collapsible}
      collapsed={props.provider.collapsed}
      driver={props.provider.driver}
      iconUrl={props.provider.iconUrl}
      symbol={props.provider.symbol}
      logo={props.provider.logo}
      monogram={props.provider.monogram}
      label={props.provider.label}
      modelCount={props.provider.modelCount}
      onToggle={onToggle}
    />
  );
  const health = props.provider.health;
  if (!health) return header;
  return (
    <View>
      {header}
      <Text
        className={`mx-5 mb-1 text-xs ${
          health.outOfCredit || health.kind === "usage_limit"
            ? "text-warning-foreground"
            : "text-danger-foreground"
        }`}
        numberOfLines={2}
      >
        {health.outOfCredit ? "" : `${health.title}. `}
        <Text className="text-foreground-muted">{health.message}</Text>
      </Text>
    </View>
  );
}

function ThreadSettingsOptionsItem(props: {
  readonly animationsReady: boolean;
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const session = useThreadSettingsSession();
  const configs = useAtomValue(environmentServerConfigsAtom);
  const selectedProvider = session.environmentId
    ? (configs
        .get(session.environmentId)
        ?.providers.find((provider) => provider.instanceId === session.providerInstanceId) ?? null)
    : null;
  const hasRunsIn =
    session.displayedMakerModel !== null && session.displayedMakerModel.routes.length > 1;
  const lastDescriptor = session.displayedDescriptors.length - 1;
  const hasOptions = hasRunsIn || lastDescriptor >= 0 || !session.runtimeHidden;

  return (
    <View className="pb-4">
      <ChatGptSharingStatus provider={selectedProvider} />
      <Text
        accessibilityRole="header"
        className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted"
      >
        Current model
      </Text>
      <Animated.View
        className="mx-4 overflow-hidden rounded-2xl bg-grouped-card ios:rounded-[24px] ios:border-continuous"
        layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
      >
        <View
          className={cn(
            "min-h-11 justify-center px-4 py-2",
            hasOptions && "android:border-b android:border-border-subtle",
          )}
        >
          <Text className="text-base font-t3-medium text-foreground" numberOfLines={2}>
            {session.displayedMakerModel?.name ??
              session.displayedOption?.label ??
              session.displayedModelSelection?.model ??
              "No model selected"}
          </Text>
          {hasOptions ? <ThreadSettingsRowDivider /> : null}
        </View>
        {hasRunsIn ? (
          <DisclosureRow
            isLast={lastDescriptor < 0 && session.runtimeHidden}
            label="Runs in"
            value={
              session.displayedMakerModel?.routes.find((route) =>
                route.sources.some((source) => source.option.key === session.displayedOption?.key),
              )?.label
            }
            onPress={() => props.onOpenSubmenu({ kind: "routes" })}
          />
        ) : null}
        {session.displayedDescriptors.map((descriptor, index) => {
          const fast = fastModeControl(descriptor);
          const isLast = session.runtimeHidden && index === lastDescriptor;
          if (
            descriptor.type === "select" &&
            (descriptor.role === "reasoning" || isReasoningOptionId(descriptor.id))
          ) {
            // Prompt-typed modes (Ultrathink) stay out of the picker; the slider shows the
            // effort the model runs at.
            return (
              <ThreadSettingsEffort
                key={descriptor.id}
                label={descriptor.label}
                options={selectableChoices(descriptor)}
                value={getProviderOptionCurrentValue(
                  descriptor,
                  session.displayedModelSelection,
                  session.reportedModelSelection,
                )}
                isLast={isLast}
                onPick={(id) => session.applyOptionChange(descriptor.id, id)}
              />
            );
          }
          if (fast && !fast.choices) {
            return (
              <SwitchRow
                key={descriptor.id}
                isLast={isLast}
                label={fast.switchLabel}
                fast
                value={fast.enabled}
                onValueChange={(value) => {
                  // Switching Fast on lands with a sharp snap as the bolt strikes.
                  if (value) {
                    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Rigid).catch(() => undefined);
                  }
                  session.applyOptionChange(descriptor.id, value ? fast.onValue : fast.offValue);
                }}
              />
            );
          }
          if (descriptor.type === "select") {
            return (
              <Animated.View
                key={descriptor.id}
                entering={
                  props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined
                }
                exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
                layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
              >
                <DisclosureRow
                  isLast={isLast}
                  label={fast ? "Fast" : descriptor.label}
                  fast={fast !== null}
                  fastLit={fast?.enabled}
                  value={
                    fast?.label ??
                    getProviderOptionCurrentLabel(
                      descriptor,
                      session.displayedModelSelection,
                      session.reportedModelSelection,
                    )
                  }
                  onPress={() => props.onOpenSubmenu({ kind: "descriptor", id: descriptor.id })}
                />
              </Animated.View>
            );
          }
          return (
            <Animated.View
              key={descriptor.id}
              entering={props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined}
              exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
              layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
            >
              <SwitchRow
                isLast={isLast}
                label={descriptor.label}
                description={descriptor.description}
                value={descriptor.currentValue ?? false}
                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
              />
            </Animated.View>
          );
        })}
        {session.runtimeHidden ? null : (
          <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>
            <DisclosureRow
              isLast
              label="Runtime"
              value={
                session.runtimeModeChoices.find((choice) => choice.mode === session.runtimeMode)
                  ?.label
              }
              onPress={() => props.onOpenSubmenu({ kind: "runtime" })}
            />
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}

function ThreadSettingsCatalogSettingsItem() {
  const session = useThreadSettingsSession();

  return (
    <View>
      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">Catalog</Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-grouped-card ios:rounded-[24px] ios:border-continuous">
        <SwitchRow
          label="Manage hidden models"
          value={session.manageHidden}
          onValueChange={session.setManageHidden}
          isLast={Platform.OS === "ios" || !session.hasLegacyModels}
        />
        {Platform.OS !== "ios" && session.hasLegacyModels ? (
          <SwitchRow
            isLast
            label="Legacy models"
            onValueChange={session.setShowLegacy}
            value={session.showLegacy}
          />
        ) : null}
      </View>
    </View>
  );
}

/** Rediscovers every provider's models when the catalog is pulled to refresh. */
function useProviderCatalogRefresh(environmentId: EnvironmentId | null) {
  const refreshProvidersCommand = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refreshProviderCatalog = useMemo(
    () => createProviderCatalogRefreshRunner(refreshProvidersCommand),
    [refreshProvidersCommand],
  );
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(() => {
    if (!environmentId || refreshing) return;
    setRefreshing(true);
    void refreshProviderCatalog(environmentId).then((result) => {
      setRefreshing(false);
      const error = providerCatalogRefreshError(result);
      if (error) Alert.alert("Could not refresh models", error);
    });
  }, [environmentId, refreshing, refreshProviderCatalog]);
  return { refreshing, refresh };
}

/** One native scroll owner for the model catalog and its related settings. */
function ThreadSettingsMainContent(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
  readonly refreshingProviders: boolean;
  readonly onRefreshProviders: () => void;
}) {
  const insets = useSafeAreaInsets();
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const bottomToolbarInset = usesNativeMailSearchToolbar
    ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET
    : 0;
  const session = useThreadSettingsSession();
  const catalogItems = useThreadSettingsCatalogItems(session);
  const [animationsReady, setAnimationsReady] = useState(false);
  const hasActiveCatalogFilter =
    session.providerFilter !== null || session.searchQuery.trim().length > 0;
  const showModelManager =
    session.environmentId !== null &&
    session.modelManagerHarnesses.length > 0 &&
    session.providerFilter !== FAVORITES_PROVIDER_FILTER &&
    !session.manageHidden;
  const searchedModel = useMemo(
    () =>
      unlistedSearchedModel(
        session.searchQuery,
        session.allProviderGroups.flatMap((group) =>
          group.models.map((model) => model.selection.model),
        ),
      ),
    [session.allProviderGroups, session.searchQuery],
  );
  const listItems = useMemo<ReadonlyArray<ThreadSettingsCatalogItem>>(
    () =>
      threadSettingsListItems<ThreadSettingsCatalogItem>(
        [
          // The add card below already says no harness lists the searched model.
          ...(catalogItems.length === 0 && !(showModelManager && searchedModel !== null)
            ? ([{ kind: "empty", key: "empty" }] as const)
            : catalogItems),
          ...(showModelManager && session.environmentId !== null
            ? [
                {
                  kind: "modelManager" as const,
                  key: "modelManager" as const,
                  environmentId: session.environmentId,
                  harnesses: session.modelManagerHarnesses,
                  browsingInstanceId: session.providerFilter?.startsWith(MAKER_FILTER_PREFIX)
                    ? null
                    : session.providerFilter,
                  searchedModel,
                },
              ]
            : []),
        ],
        session.searchQuery,
      ),
    [
      catalogItems,
      searchedModel,
      session.environmentId,
      session.modelManagerHarnesses,
      session.providerFilter,
      session.searchQuery,
      showModelManager,
    ],
  );
  const renderCatalogItem = useCallback(
    (itemProps: LegendListRenderItemProps<ThreadSettingsCatalogItem>) => {
      const item = itemProps.item;
      let content: ReactNode;

      if (item.kind === "provider") {
        content = <ThreadSettingsProviderListHeader provider={item.provider} />;
      } else if (item.kind === "model") {
        content = (
          <ThreadSettingsModelListRow
            isFirst={item.isFirst}
            isLast={item.isLast}
            maker={item.maker}
            option={item.option}
            routes={item.routes}
          />
        );
      } else if (item.kind === "modelManager") {
        content = (
          <ModelManagerCard
            key={item.environmentId}
            environmentId={item.environmentId}
            harnesses={item.harnesses}
            browsingInstanceId={item.browsingInstanceId}
            searchedModel={item.searchedModel}
          />
        );
      } else if (item.kind === "notice") {
        content = <Text className="mx-8 mt-2 text-xs text-foreground-muted">{item.text}</Text>;
      } else if (item.kind === "empty") {
        const noFavorites =
          session.providerFilter === FAVORITES_PROVIDER_FILTER &&
          session.searchQuery.trim().length === 0;
        content =
          hasActiveCatalogFilter && !noFavorites ? (
            <View className="items-center px-8 py-14">
              <Text className="text-center text-sm text-foreground-muted">No matching models</Text>
            </View>
          ) : (
            <View className="px-4 py-3">
              <EmptyState
                variant="plain"
                title={noFavorites ? "No favorite models" : "No available models"}
                detail={
                  noFavorites
                    ? "Star a model to keep it here."
                    : "Check the environment’s provider accounts in Settings."
                }
              />
            </View>
          );
      } else if (item.kind === "options") {
        content = (
          <ThreadSettingsOptionsItem
            animationsReady={animationsReady}
            onOpenSubmenu={props.onOpenSubmenu}
          />
        );
      } else {
        content = <ThreadSettingsCatalogSettingsItem />;
      }

      return (
        <Animated.View
          key={item.key}
          entering={animationsReady ? THREAD_SETTINGS_CATALOG_ENTER_TRANSITION : undefined}
          exiting={animationsReady ? THREAD_SETTINGS_CATALOG_EXIT_TRANSITION : undefined}
        >
          {content}
        </Animated.View>
      );
    },
    [
      animationsReady,
      hasActiveCatalogFilter,
      props.onOpenSubmenu,
      session.providerFilter,
      session.searchQuery,
    ],
  );

  return (
    <AnimatedLegendList
      alwaysBounceVertical
      automaticallyAdjustsScrollIndicatorInsets
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{
        paddingTop: 4,
        paddingBottom: insets.bottom + bottomToolbarInset + 12,
      }}
      contentInsetAdjustmentBehavior="automatic"
      data={listItems}
      estimatedItemSize={Platform.OS === "android" ? 56 : 48}
      extraData={animationsReady}
      getItemType={(item) => item.kind}
      itemLayoutAnimation={THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION}
      keyExtractor={(item) => item.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION}
      ListHeaderComponent={
        <>
          {Platform.OS === "android" ? (
            <View className="flex-row items-center gap-2 px-4 pb-2 pt-3">
              <View
                className="min-w-0 flex-1 flex-row items-center rounded-full bg-input px-2"
                style={{ minHeight: 56 }}
              >
                <View pointerEvents="none" className="px-2">
                  <SymbolView
                    name="magnifyingglass"
                    size={24}
                    tintColorClassName="accent-icon-subtle"
                  />
                </View>
                <TextInput
                  accessibilityLabel="Find a model"
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-w-0 flex-1 px-2 py-0 text-base text-foreground"
                  style={{ minHeight: 56, includeFontPadding: false, textAlignVertical: "center" }}
                  onChangeText={session.setSearchQuery}
                  placeholder="Find a model"
                  placeholderTextColorClassName="accent-placeholder"
                  selectionColorClassName="accent-focus/32"
                  cursorColorClassName="accent-focus"
                  selectionHandleColorClassName="accent-focus"
                  value={session.searchQuery}
                />
                {session.searchQuery.length > 0 ? (
                  <MaterialIconButton
                    accessibilityLabel="Clear model search"
                    icon="xmark"
                    onPress={() => session.setSearchQuery("")}
                  />
                ) : null}
              </View>
              <AutoModelToggle />
            </View>
          ) : null}
        </>
      }
      recycleItems
      refreshControl={
        session.environmentId ? (
          <RefreshControl
            refreshing={props.refreshingProviders}
            onRefresh={props.onRefreshProviders}
          />
        ) : undefined
      }
      onLoad={() => setAnimationsReady(true)}
      renderItem={renderCatalogItem}
      showsVerticalScrollIndicator={false}
    />
  );
}

/** Compact choice page pushed by the picker navigator. */
function ThreadSettingsChoiceContent(props: {
  readonly submenu: ThreadSettingsSubmenuPage;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const descriptorId = props.submenu.kind === "descriptor" ? props.submenu.id : null;

  const activeDescriptor =
    descriptorId !== null
      ? session.displayedDescriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === descriptorId,
        )
      : undefined;

  const routesModel = props.submenu.kind === "routes" ? session.displayedMakerModel : null;
  const standings =
    routesModel &&
    rankAccountRoutes(
      routesModel.routes,
      session.providers,
      session.displayedModelSelection,
      session.accountSession.now,
      (route) => !route.source.option.isUnavailable && !route.source.option.isHidden,
    );
  const newChatNote = session.isNewChat && session.balanceAccounts ? standings?.newChatNote : null;
  const submenuContent = routesModel
    ? {
        // Where the model runs; picking one stages it like a model, and the options follow it.
        // The user's accounts come with the most room first, as new chats prefer them.
        rows: (standings?.routes ?? routesModel.routes).map((route) => {
          // A plan outside the pool (Google AI beside Claude Code) still says what it has left.
          const standing =
            standings?.byRoute.get(route.key) ??
            routeStanding(
              session.providers,
              route.source.instanceId,
              route.source.slug,
              session.accountSession.now,
            );
          return {
            id: route.key,
            label: route.label,
            icon: (
              <ProviderIcon
                iconUrl={route.source.option.providerIconUrl}
                provider={route.source.driver}
                size={20}
              />
            ),
            ...routeAccountDetails(route.source.option, standing, session.accountSession.now),
            selected: route.sources.some((source) => session.isDisplayed(source.option)),
            onPress: () => {
              // Runs in is where an account is picked by name.
              session.pressModel(routeRowOption(routesModel, route), true);
              props.onSelected();
            },
          };
        }),
      }
    : props.submenu.kind === "runtime"
      ? {
          rows: session.runtimeModeChoices.map((choice) => ({
            id: choice.mode,
            label: choice.label,
            description: choice.description,
            trailingText: null,
            selected: choice.mode === session.runtimeMode,
            onPress: () => {
              void Haptics.selectionAsync();
              session.onUpdateRuntimeMode(choice.mode);
              props.onSelected();
            },
          })),
        }
      : activeDescriptor?.type === "select"
        ? {
            rows: (
              fastModeControl(activeDescriptor)?.choices ?? selectableChoices(activeDescriptor)
            ).map((choice) => ({
              id: choice.id,
              label: choice.label,
              description: choice.description,
              trailingText: null,
              selected:
                choice.id ===
                getProviderOptionCurrentValue(
                  activeDescriptor,
                  session.displayedModelSelection,
                  session.reportedModelSelection,
                ),
              onPress: () => {
                void Haptics.selectionAsync();
                session.applyOptionChange(activeDescriptor.id, choice.id);
                props.onSelected();
              },
            })),
          }
        : null;

  if (!submenuContent) {
    return <View className="flex-1 bg-sheet" />;
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      style={
        Platform.OS === "android"
          ? { width: "100%", maxWidth: 720, alignSelf: "center" }
          : undefined
      }
      contentContainerStyle={{
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 16,
        paddingTop: 16,
      }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="overflow-hidden rounded-2xl bg-grouped-card ios:rounded-[24px] ios:border-continuous">
        {submenuContent.rows.map((row, index) => (
          <ChoiceRow
            key={row.id}
            description={row.description}
            icon={"icon" in row ? row.icon : undefined}
            isLast={index === submenuContent.rows.length - 1}
            label={row.label}
            trailingText={row.trailingText ?? undefined}
            selected={row.selected}
            onPress={row.onPress}
          />
        ))}
      </View>
      {newChatNote ? (
        <Text className="mx-4 mt-2 text-xs text-foreground-muted">{newChatNote}</Text>
      ) : null}
    </ScrollView>
  );
}

type ThreadSettingsPickerStackParams = {
  ThreadSettingsModels: undefined;
  ThreadSettingsChoice: ThreadSettingsSubmenuPage & { readonly title: string };
};

type ThreadSettingsPickerPresentation = {
  readonly onClose: () => void;
};

const ThreadSettingsPickerStack = createNativeStackNavigator<ThreadSettingsPickerStackParams>();
const ThreadSettingsPickerPresentationContext =
  createContext<ThreadSettingsPickerPresentation | null>(null);

function useThreadSettingsPickerPresentation() {
  const value = use(ThreadSettingsPickerPresentationContext);
  if (!value) {
    throw new Error(
      "useThreadSettingsPickerPresentation must be used inside ThreadSettingsPickerNavigator.",
    );
  }
  return value;
}

function ThreadSettingsModelsScreen() {
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const usesNativeMailSearchToolbar = useNativeMailSearchToolbar();
  const hasCustomCatalogFilter = session.providerFilter !== null || session.showLegacy;
  const catalogRefresh = useProviderCatalogRefresh(session.environmentId);
  const commitAndClose = useCallback(() => {
    if (!session.commitPendingModel()) return;
    presentation.onClose();
  }, [presentation, session]);
  const providerFilters = useMemo(
    () => [
      { id: "all-providers", title: "All makers", value: null },
      { id: "favorites", title: "Favorites", value: FAVORITES_PROVIDER_FILTER },
      ...session.makerGroups.map((group) => ({
        id: `${MAKER_FILTER_PREFIX}${group.maker.id}`,
        title: group.maker.label,
        value: `${MAKER_FILTER_PREFIX}${group.maker.id}`,
      })),
    ],
    [session.makerGroups],
  );
  const filterMenu = useMemo(
    () => ({
      title: "Model filters",
      items: [
        {
          type: "submenu" as const,
          title: "Maker",
          items: providerFilters.map((filter) => ({
            type: "action" as const,
            title: filter.title,
            state: session.providerFilter === filter.value ? ("on" as const) : ("off" as const),
            onPress: () => session.setProviderFilter(filter.value),
          })),
        },
        ...(session.hasLegacyModels
          ? [
              {
                type: "action" as const,
                title: "Show legacy models",
                state: session.showLegacy ? ("on" as const) : ("off" as const),
                onPress: () => session.setShowLegacy(!session.showLegacy),
              },
            ]
          : []),
      ],
    }),
    [providerFilters, session],
  );

  return (
    <>
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          trailing={
            <View className="flex-row items-center">
              <AndroidAnchoredMenu
                title="Model filters"
                actions={[
                  {
                    title: "Maker",
                    subactions: providerFilters.map((filter) => ({
                      id: filter.id,
                      title: filter.title,
                      state: session.providerFilter === filter.value ? "on" : "off",
                    })),
                  },
                  ...(session.hasLegacyModels
                    ? [
                        {
                          id: "show-legacy",
                          title: "Show legacy models",
                          state: session.showLegacy ? ("on" as const) : ("off" as const),
                        },
                      ]
                    : []),
                ]}
                onPressAction={({ nativeEvent }) => {
                  if (nativeEvent.event === "show-legacy") {
                    session.setShowLegacy(!session.showLegacy);
                  } else {
                    const filter = providerFilters.find((item) => item.id === nativeEvent.event);
                    if (filter) session.setProviderFilter(filter.value);
                  }
                }}
              >
                {(open) => (
                  <MaterialIconButton
                    accessibilityLabel="Filter models"
                    icon="line.3.horizontal.decrease"
                    selected={hasCustomCatalogFilter}
                    variant={hasCustomCatalogFilter ? "tonal" : "standard"}
                    onPress={open}
                  />
                )}
              </AndroidAnchoredMenu>
              {session.hasPendingChanges ? (
                <MaterialButton label="Save" tone="text" onPress={commitAndClose} />
              ) : null}
            </View>
          }
          onBack={presentation.onClose}
          title="Model"
          hideBottomBorder
        />
      ) : null}
      <NativeStackScreenOptions
        optionsVersion={[
          session.providerFilter,
          session.makerGroups.map((group) => group.maker.id),
          session.showLegacy,
        ]}
        options={{
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  filterButtonId: "thread-settings-model-filter",
                  filterMenu,
                  filterSystemImageName: hasCustomCatalogFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onSearchTextChange: session.setSearchQuery,
                  placeholder: "Find a model",
                  searchTextChangeId: "thread-settings-model-search-text",
                  showsSearchDismissButton: true,
                }),
                // After the search field: the sheet's corners keep Cancel and Done.
                { type: "custom", element: <AutoModelToggle />, hidesSharedBackground: true },
              ]
            : undefined,
          headerShown: Platform.OS !== "android",
          headerSearchBarOptions:
            Platform.OS === "ios" && !usesNativeMailSearchToolbar
              ? {
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => session.setSearchQuery(""),
                  onChangeText: (event) => session.setSearchQuery(event.nativeEvent.text),
                  placeholder: "Find a model",
                }
              : undefined,
        }}
      />
      <MaterialScreenContent>
        <ThreadSettingsMainContent
          refreshingProviders={catalogRefresh.refreshing}
          onRefreshProviders={catalogRefresh.refresh}
          onOpenSubmenu={(submenu) => {
            const descriptor =
              submenu.kind === "descriptor"
                ? session.displayedDescriptors.find((candidate) => candidate.id === submenu.id)
                : undefined;
            const title =
              submenu.kind === "routes"
                ? "Runs in"
                : submenu.kind === "runtime"
                  ? "Runtime"
                  : descriptor && fastModeControl(descriptor)
                    ? "Fast"
                    : (descriptor?.label ?? "Option");
            navigation.navigate("ThreadSettingsChoice", { ...submenu, title });
          }}
        />
      </MaterialScreenContent>
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button
          accessibilityLabel="Cancel model selection"
          label="Cancel"
          onPress={presentation.onClose}
        />
      </NativeHeaderToolbar>
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Button
          accessibilityLabel={session.hasPendingChanges ? "Save model selection" : "Done"}
          label={session.hasPendingChanges ? "Save" : "Done"}
          onPress={commitAndClose}
        />
      </NativeHeaderToolbar>
      {Platform.OS === "ios" && !usesNativeMailSearchToolbar ? (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter models"
            icon={
              hasCustomCatalogFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            separateBackground
            title="Model filters"
          >
            <NativeHeaderToolbar.Menu title="Maker">
              <NativeHeaderToolbar.Label>Maker</NativeHeaderToolbar.Label>
              {providerFilters.map((filter) => (
                <NativeHeaderToolbar.MenuAction
                  key={filter.id}
                  isOn={session.providerFilter === filter.value}
                  onPress={() => session.setProviderFilter(filter.value)}
                >
                  {filter.title}
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>
            {session.hasLegacyModels ? (
              <NativeHeaderToolbar.MenuAction
                isOn={session.showLegacy}
                onPress={() => session.setShowLegacy(!session.showLegacy)}
              >
                Show legacy models
              </NativeHeaderToolbar.MenuAction>
            ) : null}
          </NativeHeaderToolbar.Menu>
          <NativeHeaderToolbar.Custom>
            <AutoModelToggle />
          </NativeHeaderToolbar.Custom>
        </NativeHeaderToolbar>
      ) : null}
    </>
  );
}

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          title={route.params.title}
          onBack={() => navigation.goBack()}
          hideBottomBorder
        />
      ) : null}
      <MaterialScreenContent>
        <ThreadSettingsChoiceContent
          submenu={route.params}
          onSelected={() => navigation.goBack()}
        />
      </MaterialScreenContent>
    </>
  );
}

function ThreadSettingsPickerNavigator(props: ThreadSettingsPickerPresentation) {
  const theme = useUniwindTheme();
  const solidSheetBackground = theme["--color-sheet-solid"];
  const foreground = theme["--color-foreground"];
  const presentation = useMemo(
    () => ({
      onClose: props.onClose,
    }),
    [props.onClose],
  );

  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <ThreadSettingsPickerStack.Navigator
        initialRouteName="ThreadSettingsModels"
        screenOptions={{
          animation: Platform.OS === "android" ? "default" : "slide_from_right",
          contentStyle: { backgroundColor: solidSheetBackground },
          gestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerShown: Platform.OS !== "android",
          headerShadowVisible: false,
          headerStyle: {
            backgroundColor: NATIVE_LIQUID_GLASS_SUPPORTED ? "transparent" : solidSheetBackground,
          },
          headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
          headerTintColor: foreground,
          headerTitleStyle: { fontSize: 17, fontWeight: "700" },
          scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED
            ? THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS
            : undefined,
        }}
      >
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsModels"
          component={ThreadSettingsModelsScreen}
          options={{ headerBackVisible: false, title: "Model" }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsChoice"
          component={ThreadSettingsChoiceScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
      </ThreadSettingsPickerStack.Navigator>
    </ThreadSettingsPickerPresentationContext.Provider>
  );
}

/** Shared model catalog and option screens, bound to the caller's draft. */
export function ThreadSettingsPickerScreen(
  props: ThreadSettingsSessionProps & { readonly onClose: () => void },
) {
  return (
    <ThreadSettingsSessionProvider {...props}>
      <ThreadSettingsPickerNavigator onClose={props.onClose} />
    </ThreadSettingsSessionProvider>
  );
}

/** Existing-thread model picker hosted by the root RNS form-sheet route. */
export function ExistingThreadSettingsRouteScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const presentation = useExistingThreadSettingsRoutePresentation();
  const session = presentation.session;

  useEffect(() => {
    if (session) {
      return;
    }

    navigation.goBack();
  }, [navigation, session]);

  if (!session) {
    return <View className="flex-1 bg-sheet" />;
  }

  const { ownerId: _ownerId, ...settings } = session;

  return (
    <ThreadSettingsPickerScreen
      {...settings}
      currentThreadInstanceId={settings.providerInstanceId}
      onClose={() => navigation.goBack()}
    />
  );
}

/**
 * Native stack hosted by the New Task navigator's form-sheet route. Keeping
 * the sheet presentation in RNS gives UIKit ownership of nested dismissal,
 * while Reasoning and Runtime remain regular pushes inside this navigator.
 */
export function NewTaskThreadSettingsRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation<NativeStackNavigationProp<Record<string, object | undefined>>>();
  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: flow.selectedModelOption?.capabilities,
        selections: flow.selectedModel?.options,
      }),
    [flow.selectedModel?.options, flow.selectedModelOption?.capabilities],
  );

  return (
    <ThreadSettingsPickerScreen
      environmentId={flow.selectedEnvironmentId}
      projectId={flow.selectedProject?.id ?? null}
      {...(flow.selectedModel ? { providerInstanceId: flow.selectedModel.instanceId } : {})}
      providerGroups={flow.providerGroups}
      selectedModel={flow.selectedModel}
      accountPinned={flow.accountPinned}
      onSelectModel={(option, accountPinned) =>
        flow.setSelectedModelKey(option.key, option.selection.options, accountPinned)
      }
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={flow.setSelectedModelOptions}
      prompt={flow.prompt}
      onPromptChange={flow.setPrompt}
      runtimeMode={flow.runtimeMode}
      interactionMode={flow.interactionMode}
      onUpdateInteractionMode={flow.setInteractionMode}
      onUpdateRuntimeMode={flow.setRuntimeMode}
      onClose={() => navigation.goBack()}
    />
  );
}
