import { useEnvironmentDisplayLabels } from "../../state/environment-labels";
import { HomeControlsFade } from "./HomeControlsFade";
import { HomeInsights } from "./HomeInsights";
import { HomeSky } from "./HomeSky";
import { createInsightsViewport, InsightsViewportContext } from "./insightsViewport";
import { workflowListHiddenKeys } from "../workflows/workflowVisibility";
import { HomeShortcutChips, HomeShortcutsRow } from "./HomeShortcutsRow";
import { usePrivacyLabel } from "../../state/use-privacy-mode";
import { CLAUDE_RC_TAB } from "@t3tools/contracts";
import { ThreadSearchExtraMatches } from "../threads/ThreadSearchExtraMatches";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { pendingThreadSearchJumpAtom } from "@t3tools/client-runtime/state/thread-search";
import { appAtomRegistry } from "../../state/atom-registry";
import { groupComparisonThreads } from "@t3tools/client-runtime/state/model-comparison";
import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { harnessMascotIdentity } from "@t3tools/shared/harnessThemes";
import { markLoad } from "@t3tools/client-runtime/load-marks";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import type { ThreadMoveDestination } from "../threads/threadOrder";
import { computeThreadMoveAvailability } from "../threads/threadOrder";
import {
  LegendList,
  type LegendListRef,
  type OnViewableItemsChanged,
} from "@legendapp/list/react-native";
import {
  type EnvironmentProject,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  type EnvironmentThreadSearchMatch,
} from "@t3tools/client-runtime/state/thread-search";
import { useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import { use, useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  ActionSheetIOS,
  Alert,
  Dimensions,
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
  type ScrollViewProps,
  type ViewInstance,
  type GestureResponderEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { ScrollViewMarker } from "react-native-screens";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { useUiMode } from "../discord/useUiMode";
import { useHomeMachine } from "../discord/useHomeMachine";
import { HomeMachines } from "../discord/HomeMachineSelector";
import { homeMachineSummaries, visibleHomeMachine } from "../discord/homeMachineModel";
import { discordHomeList } from "../discord/discordHomeList";
import { cn } from "../../lib/cn";
import { EmptyState } from "../../components/EmptyState";
import { MaterialFloatingActionButton } from "../../components/MaterialFloatingActionButton";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { NativePrimaryColumnContext } from "../../native/v5-workspace-context";
import { nativeHeaderScrollEdgeEffects } from "../../native/scrollEdgeEffects";
import {
  useNativeColumnLayoutMetrics,
  useNativeLayoutMetrics,
} from "../../native/native-layout-metrics";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { useThreadSearch } from "../../state/queries";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { usePendingThreadOrder } from "../../state/thread-order";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { AppText as Text } from "../../components/AppText";
import { preloadPhoneThread } from "../../state/threads";
import { SessionBoxTile } from "../sessionBoxes/SessionBoxTile";
import { harnessMascotAgentId } from "@t3tools/shared/harnessMascots";
import {
  buildSessionBoxListItems,
  homeListItemsAreEqual,
  type HomeListItem,
  type SessionBoxEntry,
} from "../sessionBoxes/sessionBoxListItems";
import { useHomeListLayout } from "../sessionBoxes/useHomeListLayout";
import { HomeChatTabs, homeChatTabShows, useHomeChatTabs } from "../chatTabs/ChatTabs";
import { TerminalSessionsPanel } from "../terminalSessions/TerminalSessionsPanel";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SnoozedShelfHeader,
} from "../threads/thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "../threads/thread-provider-instance";
import {
  buildThreadListV2Items,
  rankedContentSearchMatches,
  getThreadListV2OrderedSection,
  buildThreadListV2ListItems,
  type ThreadListV2ListItem,
} from "../threads/threadListV2";
import { useThreadListV2ShelfPreferences } from "../threads/use-thread-list-v2-shelf-preferences";
import { refreshHomeThreads } from "./home-refresh";
import { deriveHomeEmptyState } from "./home-empty-state";
import { createSwipeRowActivation } from "./swipe-row-activation";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "./thread-swipe-actions";
import { useMaterialFabScroll } from "./MaterialFabScrollContext";
import { OutboxRecovery } from "./OutboxRecovery";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import type { PreviewCounts } from "../../state/shell-preview";

/* ─── Types ──────────────────────────────────────────────────────────── */

interface HomeScreenProps {
  readonly previewCounts?: PreviewCounts;
  readonly readOnlyEnvironmentIds?: ReadonlySet<import("@t3tools/contracts").EnvironmentId>;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly childThreads?: ReadonlyArray<EnvironmentThreadShell>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly catalogState: WorkspaceState;
  readonly environments: ReadonlyArray<
    Pick<WorkspaceEnvironment, "environmentId" | "connectionState">
  >;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onAddConnection: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onSnoozeThread: (
    thread: EnvironmentThreadShell,
    snoozedUntil: string,
  ) => Promise<boolean>;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onPinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onMoveThread: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => Promise<boolean>;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
}

/* ─── Layout constants ───────────────────────────────────────────────── */

// v2 rows are mixed-height: the old cards measured ~74dp single-line and
// ~94dp two-line on device (252px on the Pixel 10 Pro screenshot); dropping
// their ~23dp project line leaves ~51dp and ~71dp. The estimate seeds the
// recycler's initial container count,
// `ceil((scrollLength + 2 * INITIAL_DRAW_DISTANCE) / estimate)` with the
// initial draw distance capped at 50, so an estimate at or below the average
// row height starts the pool at or above the item count for the short lists
// that LegendList otherwise keeps pooling to exactly its item count — that is
// what stopped the dev-mode "no unused container available" warning on the
// seeded short-list device passes. It is a mitigation, not an elimination:
// after first layout the full drawDistance applies, and a sudden expansion
// past the pooled headroom (~25+ items appearing at once) still creates a
// container on demand with the dev-only warning one pass ahead of the
// measured-height pool expansion. A tallest-row estimate fired that warning on
// every ordinary shelf expand, so the average wins.
const ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT = 56;
// Rows away from the viewport are cheap dormant frames (see
// swipe-row-activation), so render further ahead: a fast fling then reaches
// rows that are already built instead of rows still being rebuilt.
const THREAD_LIST_V2_DRAW_DISTANCE = 1_000;
// Session box grid: gap between boxes and the list's side margin.
const BOX_GAP = 10;
const BOX_EDGE = 14;
/**
 * Top spacing between the list and the Android custom header. The Android
 * header is rendered in-flow above this screen and
 * already consumes the top safe-area inset, so the list only needs breathing
 * room here.
 */

function HomeTopContentSpacer() {
  return <View className="h-4" />;
}

function HomeScrollView(props: ComponentProps<typeof ScrollView>) {
  const insets = useSafeAreaInsets();
  const primaryColumn = use(NativePrimaryColumnContext);
  const [uiMode] = useUiMode();
  if (Platform.OS !== "ios") return <ScrollView {...props} />;

  // v5 needs the actual content scroll view registered with its screen controller.
  // The layout observer and header siblings prevent UIKit from finding it implicitly.
  return (
    <ScrollViewMarker
      style={{ flex: 1 }}
      scrollEdgeEffects={{
        ...nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version),
        // Retain the existing sidebar fade on iOS 26; iOS 27 uses the native bar material.
        top: Number.parseInt(String(Platform.Version), 10) >= 27 ? "automatic" : "soft",
      }}
    >
      <ScrollView
        {...props}
        // UIKit's scroll-edge material needs the scroll view's own surface color.
        className={cn(
          props.className,
          primaryColumn || uiMode === "discord" ? "bg-drawer" : "bg-screen",
        )}
        // Use the column's measured inset so UIKit recognizes the resting top.
        // Padding visually clears the bar but leaves the native scroll offset
        // past its edge, activating scroll-edge protection before any scroll.
        automaticallyAdjustContentInsets={false}
        contentInsetAdjustmentBehavior="never"
        contentOffset={props.contentOffset ?? { x: 0, y: -insets.top }}
      />
    </ScrollViewMarker>
  );
}

function renderHomeScrollView(props: ScrollViewProps) {
  // FlatList clones this element with its cells and ref. Keep the marker inside
  // the component so those cells remain children of the actual ScrollView.
  return <HomeScrollView {...props} />;
}

/* ─── Main screen ────────────────────────────────────────────────────── */

export function HomeScreen(props: HomeScreenProps) {
  const threads = useMemo(() => groupComparisonThreads(props.threads), [props.threads]);
  return <HomeScreenContent {...props} threads={threads} />;
}

function HomeScreenContent(allProps: HomeScreenProps) {
  const privateLabel = usePrivacyLabel();
  const { selectThread } = useAdaptiveWorkspaceLayout();
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const [storedMachine, selectMachine] = useHomeMachine();
  const machines = useMemo(
    () => homeMachineSummaries(allProps.threads, allProps.previewCounts),
    [allProps.threads, allProps.previewCounts],
  );
  const unknownCountEnvironments = useMemo(
    () =>
      new Set(
        [...(allProps.previewCounts ?? [])]
          .filter(([, counts]) => counts === null)
          .map(([id]) => id),
      ),
    [allProps.previewCounts],
  );
  const selectedMachine = visibleHomeMachine(
    storedMachine,
    discord
      ? new Map([
          ...machines,
          ...allProps.environments.map(
            (environment) =>
              [
                environment.environmentId,
                machines.get(environment.environmentId) ?? { needsYou: 0, unread: false },
              ] as const,
          ),
        ])
      : machines,
  );
  const filteredThreads = useMemo(
    () =>
      selectedMachine === null
        ? allProps.threads
        : allProps.threads.filter((thread) => thread.environmentId === selectedMachine),
    [allProps.threads, selectedMachine],
  );
  const filteredPending = useMemo(
    () =>
      selectedMachine === null
        ? allProps.pendingTasks
        : allProps.pendingTasks.filter((task) => task.environmentId === selectedMachine),
    [allProps.pendingTasks, selectedMachine],
  );
  const props = { ...allProps, threads: filteredThreads, pendingTasks: filteredPending };
  // Chat tabs narrow the list to one tab's chats; search always covers every tab.
  const connectionPhases = useMemo(
    () =>
      new Map(
        props.environments.map((environment) => [
          environment.environmentId,
          environment.connectionState,
        ]),
      ),
    [props.environments],
  );
  const chatTabs = useHomeChatTabs(props.threads, connectionPhases, selectedMachine);
  const [collapsedCategories, setCollapsedCategories] = useState<ReadonlySet<string>>(
    () => new Set(["Snoozed", "Settled"]),
  );
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const workspace = useWorkspaceTabs();
  const [initialScrollOffset] = useState(() => workspace?.getScrollOffset("threads") ?? 0);
  const primaryColumn = use(NativePrimaryColumnContext);
  const contentBackground = discord || primaryColumn ? "bg-drawer" : "bg-screen";
  const containerClassName = cn(
    "flex-1",
    Platform.OS === "android" ? "bg-header" : contentBackground,
  );
  const columnMetrics = useNativeColumnLayoutMetrics();
  const selectedThreadKey = primaryColumn?.selectedThreadKey ?? null;
  const fullSwipeWidth = primaryColumn && columnMetrics ? columnMetrics.width - 20 : undefined;
  const queuedThreadKeys = useQueuedThreadKeys();
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  // Let trackpad scrolling coexist with each row's horizontal swipe gesture.
  // This gesture only declares the native scroll relation. Keeping its event
  // handler on JS avoids freezing Reanimated handler refs shared with swipe rows.
  const homeScrollGesture = useNativeGesture({ disableReanimated: true });
  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const screenMetrics = useNativeLayoutMetrics();
  const contentSideInsets = usesNativeWorkspaceColumns
    ? (columnMetrics ?? screenMetrics)?.safeArea
    : undefined;
  // UIKit's column safe area already includes its bottom toolbar.
  const iosBottomClearance = Math.max(
    columnMetrics?.safeArea.bottom ?? insets.bottom,
    24,
    workspace?.bottomClearance ?? 0,
  );
  const searchEnvironmentIds = useMemo(
    () =>
      props.environments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    [props.environments],
  );
  const [refreshing, setRefreshing] = useState(false);
  const refreshInFlight = useRef(false);
  const refreshThreads = useCallback(() => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setRefreshing(true);
    void refreshHomeThreads(searchEnvironmentIds)
      .catch((error: unknown) => {
        Alert.alert(
          "Could not refresh chats",
          error instanceof Error ? error.message : "Try again.",
        );
      })
      .finally(() => {
        refreshInFlight.current = false;
        setRefreshing(false);
      });
  }, [searchEnvironmentIds]);
  const threadSearch = useThreadSearch(
    searchEnvironmentIds,
    chatTabs.selected === CLAUDE_RC_TAB ? "" : props.searchQuery,
  );
  const threadSearchMatchByKey = useMemo(() => {
    const matches = new Map<string, EnvironmentThreadSearchMatch>();
    for (const match of threadSearch.matches) {
      if (match.source === "user" || match.source === "assistant") {
        matches.set(threadSearchMatchKey(match), match);
      }
    }
    return matches;
  }, [threadSearch.matches]);
  const workflowHiddenKeys = useMemo(
    () => workflowListHiddenKeys(props.childThreads ?? props.threads),
    [props.childThreads, props.threads],
  );
  const extraSearchMatches = useMemo(
    () =>
      rankedContentSearchMatches(
        props.threads,
        threadSearch.matches.filter(
          (match) => !workflowHiddenKeys.has(threadSearchMatchKey(match)),
        ),
        props.searchQuery,
      ),
    [props.threads, threadSearch.matches, props.searchQuery, workflowHiddenKeys],
  );
  const handleSwipeableWillOpen = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current !== methods) {
      openSwipeableRef.current?.close();
      openSwipeableRef.current = methods;
    }
  }, []);

  const handleSwipeableClose = useCallback((methods: SwipeableMethods) => {
    if (openSwipeableRef.current === methods) {
      openSwipeableRef.current = null;
    }
  }, []);

  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const onMaterialFabScroll = useMaterialFabScroll();
  const listRef = useRef<LegendListRef>(null);
  // Insights live past the end of the chats: a spacer keeps them below the first screen
  // of a short list, they mount once the list has settled and they are near, and each
  // card arrives as it scrolls into view.
  // Made once, from the resting offset at mount; scroll events keep it current.
  const [insightsViewport] = useState(() =>
    createInsightsViewport(Platform.OS === "ios" ? -insets.top : 0),
  );
  const [insightsRevealed, setInsightsRevealed] = useState(false);
  const insightsRevealPending = useRef(false);
  const revealInsights = useCallback(() => {
    if (insightsRevealPending.current) return;
    insightsRevealPending.current = true;
    setTimeout(() => setInsightsRevealed(true), 450);
  }, []);
  const insightsAnchorRef = useRef<ViewInstance>(null);
  const listEndRef = useRef<ViewInstance>(null);
  const [insightsSpacer, setInsightsSpacer] = useState(0);
  const placeInsights = useCallback(() => {
    // Where the chats end with the list at rest: Insights start no higher than the bottom edge.
    listEndRef.current?.measureInWindow((_x, y) => {
      const atRest = y + insightsViewport.offset() + (Platform.OS === "ios" ? insets.top : 0);
      const spacer = Math.max(0, Math.round(Dimensions.get("window").height - atRest));
      setInsightsSpacer((current) => (Math.abs(current - spacer) > 4 ? spacer : current));
    });
  }, [insets.top, insightsViewport]);
  const checkInsightsInView = useCallback(() => {
    placeInsights();
    insightsViewport.remeasure();
    if (insightsRevealPending.current) return;
    insightsAnchorRef.current?.measureInWindow((_x, y, _width, height) => {
      // Near is enough to mount: the cards are ready by the time they scroll in.
      if (height > 0 && y < Dimensions.get("window").height * 1.4) revealInsights();
    });
  }, [insightsViewport, placeInsights, revealInsights]);
  // Rows settle into their measured heights over the first moments, moving the anchor
  // without a scroll or a layout of its own: look again while they do.
  useEffect(() => {
    const timers = [700, 1500, 3000].map((delay) => setTimeout(checkInsightsInView, delay));
    return () => timers.forEach(clearTimeout);
  }, [checkInsightsInView]);
  const listVisibleMarked = useRef(false);
  const markListVisible = useCallback<NonNullable<OnViewableItemsChanged<HomeListItem>>>(
    ({ viewableItems }) => {
      if (listVisibleMarked.current) return;
      if (!viewableItems.some(({ item }) => item.type === "v2-thread" || item.type === "box-row"))
        return;
      listVisibleMarked.current = true;
      markLoad("home.list.visible");
    },
    [],
  );
  const searchMode = workspace?.state.tabs.threads.searchMode;
  const restoredOffset = workspace?.state.tabs.threads.scrollOffset;
  useEffect(() => {
    if (searchMode !== "resting" || restoredOffset === undefined) return;
    listRef.current?.scrollToOffset({
      offset: restoredOffset - (Platform.OS === "ios" ? insets.top : 0),
      animated: false,
    });
  }, [searchMode, insets.top, restoredOffset]);
  const swipeRowActivation = useMemo(() => createSwipeRowActivation(), []);
  const activateVisibleRows = useCallback(
    (rows: ReadonlyArray<{ readonly key: string }>) => {
      const state = listRef.current?.getState();
      if (state === undefined || !(state.end >= 0)) return;
      swipeRowActivation.activate(
        rows.slice(Math.max(0, state.start - 2), state.end + 3).map((row) => row.key),
      );
    },
    [swipeRowActivation],
  );
  // Status-bar, accessibility and programmatic scrolls never arm the scroll
  // gate, so every scroll also activates the visible rows once it settles.
  const activationTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(activationTimerRef.current), []);
  const handleListScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onMaterialFabScroll?.(event);
      insightsViewport.setOffset(event.nativeEvent.contentOffset.y);
      if (workspace)
        workspace.recordScrollOffset(
          "threads",
          Math.max(0, event.nativeEvent.contentOffset.y + (Platform.OS === "ios" ? insets.top : 0)),
        );
      clearTimeout(activationTimerRef.current);
      activationTimerRef.current = setTimeout(() => {
        activateVisibleRows(listRef.current?.getState().data ?? []);
        checkInsightsInView();
      }, 200);
    },
    [
      activateVisibleRows,
      checkInsightsInView,
      insightsViewport,
      onMaterialFabScroll,
      workspace,
      insets.top,
    ],
  );
  const trackListTouches = useCallback(
    (event: GestureResponderEvent, started: boolean) => {
      const { changedTouches, touches } = event.nativeEvent;
      swipeRowActivation.trackTouches(
        started ? changedTouches.map((touch) => String(touch.identifier)) : [],
        touches.map((touch) => String(touch.identifier)),
      );
    },
    [swipeRowActivation],
  );
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: handleListScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });

  const hasSearchQuery = props.searchQuery.trim().length > 0;
  const handleSnoozeThread = useCallback(
    (thread: EnvironmentThreadShell, snoozedUntil: string) => {
      void props.onSnoozeThread(thread, snoozedUntil);
    },
    [props.onSnoozeThread],
  );
  const handleUnsnoozeThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnsnoozeThread(thread);
    },
    [props.onUnsnoozeThread],
  );
  const handlePinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onPinThread(thread);
    },
    [props.onPinThread],
  );
  const handleMoveThread = useCallback(
    (thread: EnvironmentThreadShell, direction: ThreadMoveDestination) => {
      void props.onMoveThread(thread, direction);
    },
    [props.onMoveThread],
  );
  const handleUnpinThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onUnpinThread(thread);
    },
    [props.onUnpinThread],
  );
  const handleRegenerateThreadTitle = useCallback(
    (thread: EnvironmentThreadShell) => {
      void props.onRegenerateThreadTitle(thread);
    },
    [props.onRegenerateThreadTitle],
  );
  const handleRenameThread = useCallback(
    (thread: EnvironmentThreadShell) => props.onRenameThread(thread),
    [props.onRenameThread],
  );
  const handleDeleteThread = props.onDeleteThread;
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    toggleSettledShelf,
    snoozedShelfExpanded,
    toggleSnoozedShelf,
  } = useThreadListV2ShelfPreferences();
  // The queued-start and snooze helpers need a clock while the list stays open.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useFocusEffect(
    useCallback(() => {
      // Refresh immediately on enable or focus because the previous value can be hours old.
      setNowMinute(new Date().toISOString().slice(0, 16));
      const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
      return () => clearInterval(id);
    }, []),
  );
  // Capabilities gate the row actions; settlement only decides whether a
  // stale settled pin leaves the pinned block (parity with web).
  const listEnvironments = useAtomValue(threadListEnvironmentsAtom);
  const {
    providersByEnvironmentId,
    settlementEnvironmentIds,
    snoozeEnvironmentIds,
    pinningEnvironmentIds,
    pinReorderEnvironmentIds,
    titleRegenerationEnvironmentIds,
  } = listEnvironments;
  const resolveProviderInstance = useThreadRowProviderInstanceResolver(providersByEnvironmentId);
  const pendingOrder = usePendingThreadOrder(nowMinute, snoozeWakeTick);
  // Up/down menu availability for every pinned row, computed once per rebuild
  // (see computeThreadMoveAvailability): per-thread planner calls made list
  // construction quadratic, and this list rebuilds on every minute tick. The
  // rest of the list orders itself by activity, so only pins can move.
  const threadMoveAvailability = useMemo(
    () =>
      computeThreadMoveAvailability({
        allThreads: props.threads,
        section: "pinned",
        pendingOrder,
        reorderableEnvironmentIds: pinReorderEnvironmentIds,
        ordered: getThreadListV2OrderedSection({
          threads: props.threads,
          section: "pinned",
          pendingOrder,
          now: new Date().toISOString(),
          settlementEnvironmentIds,
          snoozeEnvironmentIds,
          queuedThreadKeys,
        }),
      }),
    [
      pinReorderEnvironmentIds,
      props.threads,
      pendingOrder,
      queuedThreadKeys,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      nowMinute,
      snoozeWakeTick,
    ],
  );
  // Keep working sessions visible and fold settled history into its own shelf.
  const threadListV2Layout = useMemo(
    () =>
      buildThreadListV2Items({
        pendingOrder,
        threads: props.threads.filter(
          (thread) =>
            thread.archivedAt === null &&
            (hasSearchQuery || homeChatTabShows(chatTabs.selected, chatTabs.tabs, thread)),
        ),
        searchQuery: props.searchQuery,
        settlementEnvironmentIds,
        snoozeEnvironmentIds,
        queuedThreadKeys,
        now: new Date().toISOString(),
        settledShelfExpanded: discord || settledShelfExpanded,
        snoozedShelfExpanded: discord || snoozedShelfExpanded,
        selectedThreadKey,
      }),
    [
      discord,
      pendingOrder,
      selectedThreadKey,
      queuedThreadKeys,
      nowMinute,
      snoozeWakeTick,
      settledShelfExpanded,
      snoozedShelfExpanded,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      props.searchQuery,
      props.threads,
      hasSearchQuery,
      chatTabs.selected,
      chatTabs.tabs,
    ],
  );
  // Re-partition the moment the earliest snooze expires (clamped to the
  // signed-32-bit setTimeout range; far-future wakes re-arm at the clamp).
  const nextSnoozeWakeAt = threadListV2Layout.nextSnoozeWakeAt;
  useEffect(() => {
    if (nextSnoozeWakeAt === null) return;
    const wakeAtMs = Date.parse(nextSnoozeWakeAt);
    if (Number.isNaN(wakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, wakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => clearTimeout(id);
    // snoozeWakeTick must re-arm the timer even when nextSnoozeWakeAt is
    // unchanged: after a clamped fire (wake beyond the 32-bit setTimeout
    // range) the boundary string is identical and the chain would die.
  }, [nextSnoozeWakeAt, snoozeWakeTick]);
  // Queued tasks are not thread shells, so the v2 partition never sees them;
  // they are spliced in below live work and stay visible and deletable while
  // their environment is offline. Same search filter as the list itself.
  const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
  const v2PendingTasks = useMemo(
    () =>
      v2SearchQuery.length === 0
        ? props.pendingTasks
        : props.pendingTasks.filter((pendingTask) =>
            pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery),
          ),
    [props.pendingTasks, v2SearchQuery],
  );
  const threadListV2Items = useMemo(
    () =>
      buildThreadListV2ListItems({
        layout: threadListV2Layout,
        pendingTasks: v2PendingTasks,
        settledShelfExpanded: discord || settledShelfExpanded,
        snoozedShelfExpanded: discord || snoozedShelfExpanded,
        snoozeLabelNow: `${nowMinute}:00.000Z`,
        snoozeEnvironmentIds,
        queuedThreadKeys,
        moveAvailability: threadMoveAvailability,
        shelfPreferencesLoading: !shelfPreferencesLoaded,
      }),
    [
      nowMinute,
      queuedThreadKeys,
      threadMoveAvailability,
      shelfPreferencesLoaded,
      settledShelfExpanded,
      snoozedShelfExpanded,
      snoozeEnvironmentIds,
      threadListV2Layout,
      v2PendingTasks,
    ],
  );

  // Session boxes: rows of painted boxes grouped by what needs you. Search keeps the
  // boxes too, each showing where it matched.
  const [homeLayout] = useHomeListLayout();
  const [listWidth, setListWidth] = useState(0);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const boxLayoutActive = !discord && homeLayout === "boxes";
  const boxSearchQuery = props.searchQuery.trim();
  const boxSidePadding =
    (contentSideInsets?.left ?? 0) + (contentSideInsets?.right ?? 0) + (primaryColumn ? 16 : 0);
  const boxColumns = Math.max(
    3,
    Math.floor((listWidth - boxSidePadding - BOX_EDGE * 2 + BOX_GAP) / (124 + BOX_GAP)),
  );
  const boxSize =
    listWidth > 0
      ? Math.floor(
          (listWidth - boxSidePadding - BOX_EDGE * 2 - BOX_GAP * (boxColumns - 1)) / boxColumns,
        )
      : 0;
  const homeListItems = useMemo<ReadonlyArray<HomeListItem>>(
    () =>
      discord
        ? discordHomeList(
            threadListV2Items,
            collapsedCategories,
            allProps.childThreads ?? [],
            connectionPhases,
          )
        : boxLayoutActive && boxSize > 0
          ? buildSessionBoxListItems({
              items: threadListV2Items,
              columns: boxColumns,
              now: Date.parse(`${nowMinute}:00.000Z`),
              connectionPhases,
              ...(boxSearchQuery
                ? {
                    search: {
                      query: boxSearchQuery,
                      snippetFor: (thread: EnvironmentThreadShell) =>
                        threadSearchMatchByKey.get(
                          threadSearchMatchKey({
                            environmentId: thread.environmentId,
                            threadId: thread.id,
                          }),
                        )?.snippet ?? null,
                    },
                  }
                : {}),
            })
          : threadListV2Items,
    [
      discord,
      collapsedCategories,
      allProps.childThreads,
      boxLayoutActive,
      boxColumns,
      boxSearchQuery,
      boxSize,
      nowMinute,
      connectionPhases,
      threadListV2Items,
      threadSearchMatchByKey,
    ],
  );
  const environmentLabels = useEnvironmentDisplayLabels();
  const machineLabelFor = useCallback(
    (thread: EnvironmentThreadShell) =>
      serverConfigs.size > 1 ? (environmentLabels.get(thread.environmentId) ?? null) : null,
    [serverConfigs, environmentLabels],
  );
  const openBoxActions = useCallback(
    (entry: SessionBoxEntry) => {
      const thread = entry.thread;
      const actions: Array<{ label: string; run: () => void; destructive?: boolean }> = [
        { label: "Open", run: () => props.onSelectThread(thread) },
        entry.pinned
          ? { label: "Unpin", run: () => void props.onUnpinThread(thread) }
          : { label: "Pin", run: () => void props.onPinThread(thread) },
        { label: "Settle", run: () => void props.onSettleThread(thread) },
        { label: "Rename", run: () => props.onRenameThread(thread) },
        { label: "Archive", run: () => props.onArchiveThread(thread), destructive: true },
      ];
      if (Platform.OS === "ios") {
        ActionSheetIOS.showActionSheetWithOptions(
          {
            title: privateLabel("Chat", thread.id, thread.title),
            options: [...actions.map((action) => action.label), "Cancel"],
            cancelButtonIndex: actions.length,
            destructiveButtonIndex: actions.findIndex((action) => action.destructive === true),
          },
          (index) => actions[index]?.run(),
        );
        return;
      }
      Alert.alert(privateLabel("Chat", thread.id, thread.title), undefined, [
        ...actions.map((action) => ({
          text: action.label,
          onPress: action.run,
          ...(action.destructive ? { style: "destructive" as const } : {}),
        })),
        { text: "Cancel", style: "cancel" as const },
      ]);
    },
    [props, privateLabel],
  );

  const selectSearchThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      const match = threadSearchMatchByKey.get(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      );
      if (match?.messageId) appAtomRegistry.set(pendingThreadSearchJumpAtom, match);
      props.onSelectThread(thread);
    },
    [props.onSelectThread, threadSearchMatchByKey],
  );
  useThreadJumpShortcuts(threadListV2Items, selectSearchThread);
  useEffect(() => {
    if (swipeEnabled) activateVisibleRows(homeListItems);
  }, [activateVisibleRows, swipeEnabled, homeListItems]);

  const renderV2Item = useCallback(
    ({ item }: { readonly item: ThreadListV2ListItem }) => {
      if (item.type === "v2-pending") {
        return (
          <ThreadListV2PendingRow
            pendingTask={item.pendingTask}
            showTrailingDivider={item.showTrailingDivider}
            onSelectPendingTask={props.onSelectPendingTask}
            onDeletePendingTask={props.onDeletePendingTask}
          />
        );
      }
      if (item.type === "v2-settled-shelf") {
        return (
          <ThreadListV2SnoozedShelfHeader
            label="Settled"
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            searchExpanded={item.searchExpanded}
            onToggle={toggleSettledShelf}
          />
        );
      }
      if (item.type === "v2-snoozed-shelf") {
        return (
          <ThreadListV2SnoozedShelfHeader
            count={item.count}
            disabled={item.disabled}
            expanded={item.expanded}
            searchExpanded={item.searchExpanded}
            onToggle={toggleSnoozedShelf}
          />
        );
      }
      const thread = item.item.thread;
      return (
        <ThreadListV2Row
          readOnly={props.readOnlyEnvironmentIds?.has(thread.environmentId)}
          pane={primaryColumn ? "sidebar" : "screen"}
          selected={scopedThreadKey(thread.environmentId, thread.id) === selectedThreadKey}
          fullSwipeWidth={fullSwipeWidth}
          onNewThreadOnBranch={props.onNewThreadOnBranch}
          thread={thread}
          face={item.face}
          hasQueuedMessages={item.hasQueuedMessages}
          snoozed={item.item.snoozed}
          settled={item.item.settled}
          settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
          onSettleThread={props.onSettleThread}
          onUnsettleThread={props.onUnsettleThread}
          pinned={item.item.pinned}
          longRunningStatus={item.item.longRunningStatus}
          snoozePresetMinute={item.snoozePresetMinute ?? ""}
          snoozeWakeLabelText={item.snoozeWakeLabelText}
          timeLabel={item.timeLabel}
          showTrailingDivider={item.showTrailingDivider}
          providerInstance={resolveProviderInstance(thread)}
          providers={providersByEnvironmentId.get(thread.environmentId)}
          searchMatch={threadSearchMatchByKey.get(
            threadSearchMatchKey({
              environmentId: thread.environmentId,
              threadId: thread.id,
            }),
          )}
          searchQuery={props.searchQuery}
          onSelectThread={selectSearchThread}
          onDeleteThread={handleDeleteThread}
          onArchiveThread={props.onArchiveThread}
          onRenameThread={handleRenameThread}
          onRegenerateThreadTitle={handleRegenerateThreadTitle}
          titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
          snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
          pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
          reorderSupported={pinReorderEnvironmentIds.has(thread.environmentId)}
          canMoveUp={item.canMoveUp}
          canMoveDown={item.canMoveDown}
          onSnoozeThread={handleSnoozeThread}
          onUnsnoozeThread={handleUnsnoozeThread}
          onPinThread={handlePinThread}
          onUnpinThread={handleUnpinThread}
          onMoveThread={handleMoveThread}
          onSwipeableClose={handleSwipeableClose}
          onSwipeableWillOpen={handleSwipeableWillOpen}
          simultaneousSwipeGesture={homeScrollGesture}
          activationKey={item.key}
        />
      );
    },
    [
      handleDeleteThread,
      handleMoveThread,
      handlePinThread,
      handleRegenerateThreadTitle,
      handleRenameThread,
      handleSnoozeThread,
      handleUnpinThread,
      handleUnsnoozeThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      homeScrollGesture,
      pinningEnvironmentIds,
      pinReorderEnvironmentIds,
      props.onArchiveThread,
      props.readOnlyEnvironmentIds,
      props.onDeletePendingTask,
      props.onSelectPendingTask,
      selectSearchThread,
      primaryColumn,
      selectedThreadKey,
      fullSwipeWidth,
      props.onNewThreadOnBranch,
      resolveProviderInstance,
      providersByEnvironmentId,
      snoozeEnvironmentIds,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      toggleSnoozedShelf,
      toggleSettledShelf,
      settlementEnvironmentIds,
      props.onSettleThread,
      props.onUnsettleThread,
      props.searchQuery,
    ],
  );
  const renderHomeItem = useCallback(
    ({ item }: { readonly item: HomeListItem }) => {
      if (item.type === "discord-heading") {
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.type === "discord-heading" && item.key !== "all" ? privateLabel("Computer", item.key, item.label) : item.label}, ${item.count} chats`}
            accessibilityState={{ expanded: item.expanded }}
            onPress={() =>
              setCollapsedCategories((previous) => {
                const next = new Set(previous);
                if (next.has(item.label)) next.delete(item.label);
                else next.add(item.label);
                return next;
              })
            }
            className="min-h-11 flex-row items-center gap-1 px-2 pt-3 pb-1"
          >
            <SymbolView
              name={item.expanded ? "chevron.down" : "chevron.right"}
              size={10}
              tintColorClassName="accent-foreground-muted"
            />
            <Text
              style={{ fontSize: 12, fontWeight: "600", letterSpacing: 0.24 }}
              className="flex-1 uppercase text-foreground-muted"
            >
              {item.type === "discord-heading" && item.key !== "all"
                ? privateLabel("Computer", item.key, item.label)
                : item.label}
            </Text>
            <Text style={{ fontSize: 12 }} className="pr-3 text-foreground-muted">
              {item.count}
            </Text>
          </Pressable>
        );
      }
      if (item.type === "box-heading") {
        return (
          <View style={{ paddingHorizontal: BOX_EDGE, paddingTop: 14, paddingBottom: 7 }}>
            <Text className="font-t3-semibold text-xs tracking-wide text-foreground-muted uppercase">
              {item.label}
              <Text className="font-t3-regular text-xs text-foreground-muted"> {item.count}</Text>
            </Text>
          </View>
        );
      }
      if (item.type === "box-row") {
        return (
          <View
            style={{
              flexDirection: "row",
              gap: BOX_GAP,
              paddingHorizontal: BOX_EDGE,
              paddingBottom: BOX_GAP,
            }}
          >
            {item.entries.map((entry) => {
              const key = scopedThreadKey(entry.thread.environmentId, entry.thread.id);
              const provider = resolveProviderInstance(entry.thread);
              return (
                <SessionBoxTile
                  disabled={props.readOnlyEnvironmentIds?.has(entry.thread.environmentId)}
                  key={key}
                  box={entry.box}
                  identity={entry.thread.id}
                  machineIdentity={entry.thread.environmentId}
                  title={entry.thread.title}
                  {...harnessMascotIdentity({
                    driver: provider?.driverKind ?? null,
                    instanceId:
                      entry.thread.runtime?.providerInstanceId ??
                      entry.thread.modelSelection.instanceId,
                    model: entry.thread.modelSelection.model,
                    agentId: harnessMascotAgentId(
                      provider?.driverKind,
                      serverConfigs.get(entry.thread.environmentId)?.settings.providerInstances[
                        entry.thread.runtime?.providerInstanceId ??
                          entry.thread.modelSelection.instanceId
                      ]?.config,
                    ),
                  })}
                  size={boxSize}
                  selected={key === selectedThreadKey}
                  pinned={entry.pinned}
                  machineLabel={machineLabelFor(entry.thread)}
                  match={entry.match}
                  onPressIn={() => preloadPhoneThread(entry.thread.environmentId, entry.thread.id)}
                  onPress={() => props.onSelectThread(entry.thread)}
                  onLongPress={() => {
                    if (!props.readOnlyEnvironmentIds?.has(entry.thread.environmentId))
                      openBoxActions(entry);
                  }}
                />
              );
            })}
          </View>
        );
      }
      return renderV2Item({ item });
    },
    [
      boxSize,
      privateLabel,
      machineLabelFor,
      openBoxActions,
      props.onSelectThread,
      renderV2Item,
      props.readOnlyEnvironmentIds,
      resolveProviderInstance,
      selectedThreadKey,
      serverConfigs,
    ],
  );
  const v2KeyExtractor = useCallback((item: HomeListItem) => item.key, []);

  // FlatList/LegendList treat a changed extraData identity as "re-render every
  // visible row", so an inline object literal would invalidate all rows on
  // every HomeScreen render — and the minute clock must stay out of it for
  // the same reason: the clock text is precomputed per item instead.
  const v2ExtraData = useMemo(
    () => ({
      listEnvironments,
      searchQuery: props.searchQuery,
      selectedThreadKey,
      discord,
      threadSearchMatchByKey,
      readOnlyEnvironmentIds: props.readOnlyEnvironmentIds,
    }),
    [
      props.searchQuery,
      props.readOnlyEnvironmentIds,
      selectedThreadKey,
      listEnvironments,
      threadSearchMatchByKey,
      discord,
    ],
  );

  /* Empty states */
  // The signal must ignore the search: an active query that matches nothing
  // needs the in-list "No results" state, not the full-page "No threads yet".
  // Settled threads are unarchived live shells, so the archived-at check
  // already covers them.
  const hasAnyThreads =
    allProps.threads.some((thread) => thread.archivedAt === null) ||
    allProps.pendingTasks.length > 0;
  // Connection state surfaces in the header title slot
  // (WorkspaceConnectionTitle) — nothing renders inside the list, so
  // reconnects never shift the rows.
  const emptyState = deriveHomeEmptyState(props.catalogState);
  // While a saved environment is still connecting, adding another is not the
  // way forward.
  const offerAddEnvironment = !props.catalogState.hasReadyEnvironment && !emptyState.loading;

  const refreshControl = <RefreshControl refreshing={refreshing} onRefresh={refreshThreads} />;
  const chatTabStrip = (
    <HomeChatTabs
      tabs={chatTabs.tabs}
      selected={chatTabs.selected}
      onSelect={chatTabs.select}
      trailing={<HomeShortcutChips />}
    />
  );

  if (chatTabs.selected === CLAUDE_RC_TAB) {
    const terminalTop = Platform.OS === "ios" ? insets.top + 8 : 0;
    return (
      <View className={cn(containerClassName, discord && "flex-row")}>
        {discord ? (
          <HomeMachines
            unknownCountEnvironments={unknownCountEnvironments}
            rail
            machines={machines}
            configs={serverConfigs}
            selected={selectedMachine}
            onSelect={selectMachine}
            top={Platform.OS === "ios" ? insets.top : 0}
            bottom={iosBottomClearance}
          />
        ) : null}
        <View
          className={
            discord
              ? "flex-1 bg-drawer"
              : Platform.OS === "android"
                ? "flex-1 overflow-hidden rounded-t-[28px] bg-screen"
                : cn("flex-1", contentBackground)
          }
          style={{
            paddingTop: terminalTop,
            paddingBottom: Platform.OS === "ios" ? iosBottomClearance : insets.bottom,
          }}
        >
          {Platform.OS === "android" ? <HomeTopContentSpacer /> : null}
          {!discord && machines.size >= 2 ? (
            <HomeMachines
              unknownCountEnvironments={unknownCountEnvironments}
              rail={false}
              machines={machines}
              configs={serverConfigs}
              selected={selectedMachine}
              onSelect={selectMachine}
              top={0}
              bottom={0}
            />
          ) : null}
          {chatTabStrip}
          <TerminalSessionsPanel
            environments={allProps.environments}
            selectedMachineId={selectedMachine}
            searchQuery={props.searchQuery}
          />
        </View>
      </View>
    );
  }

  if (!hasAnyThreads && !hasSearchQuery) {
    return (
      <View className={containerClassName}>
        <ScrollView
          alwaysBounceVertical
          refreshControl={refreshControl}
          className={cn(
            "flex-1",
            contentBackground,
            Platform.OS === "android" && "overflow-hidden rounded-t-[28px]",
          )}
          contentContainerStyle={{
            flexGrow: 1,
            paddingBottom: Platform.OS === "ios" ? iosBottomClearance : Math.max(insets.bottom, 24),
            paddingTop: NATIVE_LIQUID_GLASS_SUPPORTED ? insets.top + 72 : 0,
          }}
        >
          {chatTabStrip}
          <View
            className="w-full max-w-[430px] flex-1 items-center justify-center self-center"
            style={{
              paddingLeft: 32 + (contentSideInsets?.left ?? 0),
              paddingRight: 32 + (contentSideInsets?.right ?? 0),
            }}
          >
            <OutboxRecovery threads={allProps.threads} />
            <EmptyState
              title={emptyState.title}
              detail={emptyState.detail}
              actionLabel={offerAddEnvironment ? "Add environment" : undefined}
              onAction={offerAddEnvironment ? props.onAddConnection : undefined}
              action={
                Platform.OS === "android" && offerAddEnvironment ? (
                  <MaterialFloatingActionButton
                    label="Add environment"
                    icon="plus"
                    variant="extended"
                    tone="primary"
                    onPress={props.onAddConnection}
                  />
                ) : undefined
              }
              variant="plain"
            />
            {emptyState.loading ? (
              <View className="mt-4 items-center">
                <AppActivityIndicator colorClassName="accent-icon-muted" />
              </View>
            ) : null}
          </View>
        </ScrollView>
      </View>
    );
  }

  const listChatTabStrip = hasSearchQuery ? null : chatTabStrip;
  // The phone's own home list; the iPad sidebar and the Discord layout keep to chats.
  const showsSky = Platform.OS === "ios" && !Platform.isPad && !discord && !primaryColumn;
  const showsInsights = showsSky && !hasSearchQuery;
  const v2ListHeader = discord ? (
    <>
      <OutboxRecovery threads={allProps.threads} />
      {!hasSearchQuery ? <HomeShortcutsRow /> : null}
    </>
  ) : Platform.OS === "ios" ? (
    <>
      {showsSky ? <HomeSky top={-insets.top - 8} /> : null}
      <OutboxRecovery threads={allProps.threads} />
      {!hasSearchQuery ? (
        <>
          {machines.size >= 2 ? (
            <HomeMachines
              unknownCountEnvironments={unknownCountEnvironments}
              rail={false}
              machines={machines}
              configs={serverConfigs}
              selected={selectedMachine}
              onSelect={selectMachine}
              top={0}
              bottom={0}
            />
          ) : null}
          {listChatTabStrip}
        </>
      ) : null}
    </>
  ) : (
    <>
      <HomeTopContentSpacer />
      <OutboxRecovery threads={allProps.threads} />
      {machines.size >= 2 ? (
        <HomeMachines
          unknownCountEnvironments={unknownCountEnvironments}
          rail={false}
          machines={machines}
          configs={serverConfigs}
          selected={selectedMachine}
          onSelect={selectMachine}
          top={0}
          bottom={0}
        />
      ) : null}
      {listChatTabStrip}
    </>
  );

  // Snoozed threads need no special empty state: their shelf header is a list
  // row even while collapsed.
  const v2ListEmpty =
    hasSearchQuery && threadSearch.isPending ? undefined : hasSearchQuery ? (
      <EmptyState
        title={threadSearch.failed ? "Search failed" : "No results"}
        detail={
          threadSearch.failed
            ? `Couldn't search messages for "${props.searchQuery}". Change the search to try again.`
            : `No chats matching "${props.searchQuery}".`
        }
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    ) : (
      <EmptyState
        title="No chats yet"
        detail={emptyState.detail}
        variant={Platform.OS === "android" ? "plain" : undefined}
      />
    );

  if (
    Platform.OS === "android" &&
    threadListV2Items.length === 0 &&
    extraSearchMatches.length === 0
  ) {
    return (
      <View className="flex-1 bg-header">
        <View
          className="flex-1 overflow-hidden rounded-t-[28px] bg-screen"
          style={{ paddingBottom: insets.bottom }}
        >
          <HomeTopContentSpacer />
          {hasSearchQuery ? null : <>{chatTabStrip}</>}
          <View className="flex-1 items-center justify-center px-4">
            <OutboxRecovery threads={allProps.threads} />
            {v2ListEmpty}
          </View>
        </View>
      </View>
    );
  }

  return (
    <View
      className={cn(containerClassName, discord && "flex-row")}
      onLayout={(event) => setListWidth(Math.round(event.nativeEvent.layout.width))}
    >
      {discord ? (
        <HomeMachines
          unknownCountEnvironments={unknownCountEnvironments}
          rail
          machines={machines}
          configs={serverConfigs}
          selected={selectedMachine}
          onSelect={selectMachine}
          top={Platform.OS === "ios" ? insets.top : 0}
          bottom={iosBottomClearance}
        />
      ) : null}
      <View
        className={
          discord
            ? "flex-1 bg-drawer"
            : Platform.OS === "android"
              ? "flex-1 overflow-hidden rounded-t-[28px] bg-screen"
              : cn("flex-1", contentBackground)
        }
      >
        {/* Shared with the iPad sidebar: cells are reused across data
            rebuilds and `itemsAreEqual` keeps a minute tick (or an unrelated
            shell update) from re-rendering untouched rows. */}
        <SwipeableScrollGateProvider enabled={swipeEnabled} activation={swipeRowActivation}>
          <GestureDetector gesture={homeScrollGesture}>
            <LegendList
              ref={listRef}
              onLoad={() => activateVisibleRows(homeListItems)}
              onViewableItemsChanged={markListVisible}
              onTouchStart={(event) => trackListTouches(event, true)}
              onTouchEnd={(event) => trackListTouches(event, false)}
              onTouchCancel={(event) => trackListTouches(event, false)}
              renderScrollComponent={Platform.OS === "ios" ? renderHomeScrollView : undefined}
              data={homeListItems}
              renderItem={renderHomeItem}
              keyExtractor={v2KeyExtractor}
              getItemType={(item) => item.type}
              itemsAreEqual={homeListItemsAreEqual}
              estimatedItemSize={ESTIMATED_THREAD_LIST_V2_ROW_HEIGHT}
              drawDistance={THREAD_LIST_V2_DRAW_DISTANCE}
              recycleItems
              extraData={v2ExtraData}
              ListHeaderComponent={v2ListHeader}
              ListEmptyComponent={extraSearchMatches.length ? null : v2ListEmpty}
              onEndReached={showsInsights ? revealInsights : undefined}
              onEndReachedThreshold={0.6}
              ListFooterComponent={
                <>
                  <ThreadSearchExtraMatches
                    matches={extraSearchMatches}
                    query={props.searchQuery}
                    onSelectThread={selectThread}
                  />
                  {showsInsights ? (
                    <InsightsViewportContext value={insightsViewport}>
                      <View ref={listEndRef} collapsable={false} onLayout={placeInsights} />
                      <View style={{ height: insightsSpacer }} />
                      <View
                        ref={insightsAnchorRef}
                        collapsable={false}
                        onLayout={checkInsightsInView}
                      >
                        <HomeInsights revealed={insightsRevealed} />
                      </View>
                    </InsightsViewportContext>
                  ) : null}
                </>
              }
              alwaysBounceVertical
              refreshControl={refreshControl}
              style={{ flex: 1 }}
              automaticallyAdjustsScrollIndicatorInsets={Platform.OS === "ios"}
              contentInsetAdjustmentBehavior="never"
              contentInset={Platform.OS === "ios" ? { top: insets.top } : undefined}
              contentInsetStartAdjustment={Platform.OS === "ios" ? insets.top : 0}
              initialScrollOffset={
                initialScrollOffset > 0
                  ? initialScrollOffset - (Platform.OS === "ios" ? insets.top : 0)
                  : undefined
              }
              showsVerticalScrollIndicator={false}
              keyboardDismissMode="on-drag"
              keyboardShouldPersistTaps="handled"
              {...scrollGateHandlers}
              scrollEventThrottle={16}
              contentContainerStyle={{
                // A little air between the large title and the first thread.
                paddingTop: Platform.OS === "ios" ? 8 : 0,
                paddingLeft: (contentSideInsets?.left ?? 0) + (primaryColumn ? 8 : 0),
                paddingRight: (contentSideInsets?.right ?? 0) + (primaryColumn ? 8 : 0),
                paddingBottom:
                  Platform.OS === "ios"
                    ? iosBottomClearance
                    : (workspace?.bottomClearance ??
                      Math.max(insets.bottom, 16) +
                        (Platform.OS === "android" ? fabClearance : 88)),
              }}
            />
          </GestureDetector>
        </SwipeableScrollGateProvider>
        {Platform.OS === "ios" && !Platform.isPad && !discord ? (
          <HomeControlsFade clearance={iosBottomClearance} />
        ) : null}
      </View>
    </View>
  );
}
