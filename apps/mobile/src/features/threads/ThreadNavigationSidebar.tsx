import { useWithoutBotThreads } from "../bots/state";
import { ThreadSearchResultRow } from "./ThreadSearchResultRow";
import { ThreadSearchMoreButton } from "./thread-search-match";
import { pendingThreadSearchJumpAtom } from "@t3tools/client-runtime/state/thread-search";
import { appAtomRegistry } from "../../state/atom-registry";
import { DefaultHarnessMascot } from "../../components/DefaultHarnessMascot";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { computeThreadMoveAvailability } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  threadSearchMatchKey,
  threadSearchContextTerms,
} from "@t3tools/client-runtime/state/thread-search";
import { LegendList } from "@legendapp/list/react-native";
import { useAtomValue } from "@effect/atom-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LayoutChangeEvent, TextInputInstance } from "react-native";
import { Platform, StyleSheet, TextInput, View } from "react-native";
import { GestureDetector, useNativeGesture } from "react-native-gesture-handler";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { SearchBarCommands } from "react-native-screens";

import { AppText as Text } from "../../components/AppText";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { SymbolView } from "../../components/AppSymbol";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useNavigationThreadShells, useProjects } from "../../state/entities";
import { useThreadSearch } from "../../state/queries";
import { useThreadListV2ShelfPreferences } from "./use-thread-list-v2-shelf-preferences";
import { usePendingThreadOrder } from "../../state/thread-order";
import { threadListEnvironmentsAtom } from "../../state/presentation";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useQueuedThreadKeys } from "../../state/use-thread-outbox";
import { useWorkspaceState } from "../../state/workspace";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useThreadJumpShortcuts } from "../keyboard/threadKeyboardShortcuts";
import { SwipeableScrollGateProvider, useSwipeableScrollGate } from "../home/thread-swipe-actions";
import { usePendingTaskListActions } from "../home/usePendingTaskListActions";
import { useThreadListActions } from "../home/useThreadListActions";
import {
  getConnectionAwareBrandHeaderOptions,
  WorkspaceConnectionTitle,
} from "../home/WorkspaceConnectionTitle";
import { SidebarHeaderActions } from "./sidebar-header-actions";
import { MaterialThreadListToolbar } from "../home/MaterialThreadListToolbar";
import { useMaterialToolbarLayout } from "../../components/useMaterialToolbarLayout";
import { useMaterialFabScroll } from "../home/MaterialFabScrollContext";
import { createSidebarHeaderItems } from "./sidebar-native-header-items";
import { SidebarNavigationShell } from "./sidebar-navigation-shell";
import {
  ThreadListV2PendingRow,
  ThreadListV2Row,
  ThreadListV2SnoozedShelfHeader,
} from "./thread-list-v2-items";
import { useThreadRowProviderInstanceResolver } from "./thread-provider-instance";
import {
  buildThreadListV2Items,
  mergeMobileThreadSearchResults,
  type ThreadListV2SearchListItem,
  getThreadListV2OrderedSection,
  buildThreadListV2ListItems,
  threadListV2ListItemsAreEqual,
  type ThreadListV2ListItem,
} from "./threadListV2";

const SIDEBAR_STICKY_HEADER_HEIGHT = 106;

interface ThreadNavigationSidebarProps {
  readonly width: number;
  readonly visible: boolean;
  readonly selectedThreadKey: string | null;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadInProject: (project: EnvironmentProject) => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
  readonly onRequestVisibility: () => void;
  readonly searchQuery: string;
}

/**
 * iPad/large-width sidebar column.
 *
 * On iOS the pane is hosted inside its own navigation-inert single-screen
 * native stack (SidebarNavigationShell) so the header is a real
 * UINavigationBar: large title, native bar-button items, and a
 * UISearchController search field — the same chrome a UISplitViewController
 * column gets. Other platforms keep the custom header chrome.
 */
export function ThreadNavigationSidebar(props: ThreadNavigationSidebarProps) {
  if (Platform.OS !== "ios") {
    return <ThreadNavigationSidebarPane {...props} nativeChrome={false} />;
  }
  return <NativeSidebarContainer {...props} />;
}

function NativeSidebarContainer(props: ThreadNavigationSidebarProps) {
  return (
    <View
      testID="thread-navigation-sidebar"
      className="flex-1 border-border bg-drawer"
      style={{ borderRightWidth: StyleSheet.hairlineWidth, width: props.width }}
    >
      <SidebarNavigationShell>
        <ThreadNavigationSidebarPane {...props} nativeChrome />
      </SidebarNavigationShell>
    </View>
  );
}

function ThreadNavigationSidebarPane(
  props: ThreadNavigationSidebarProps & { readonly nativeChrome: boolean },
) {
  const { themeVariables: materialTheme } = useAppearancePreferences();
  const drawerColor = materialTheme["--color-drawer"];

  const insets = useSafeAreaInsets();
  const { fabClearance } = useAndroidControlSizing();
  const threads = useWithoutBotThreads(useNavigationThreadShells());
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const searchInputRef = useRef<TextInputInstance>(null);
  const searchBarRef = useRef<SearchBarCommands>(null);
  const openSwipeableRef = useRef<SwipeableMethods | null>(null);
  const sidebarScrollGesture = useNativeGesture();
  const {
    archiveThread,
    settleThread,
    unsettleThread,
    confirmDeleteThread,
    snoozeThread,
    unsnoozeThread,
    pinThread,
    unpinThread,
    moveThread,
    renameThread,
    regenerateThreadTitle,
  } = useThreadListActions();
  const pendingTasks = usePendingNewTasks();
  const queuedThreadKeys = useQueuedThreadKeys();
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  const searchEnvironmentIds = useMemo(
    () =>
      workspaceEnvironments
        .filter((environment) => environment.connectionState === "connected")
        .map((environment) => environment.environmentId),
    [workspaceEnvironments],
  );
  const threadSearch = useThreadSearch(searchEnvironmentIds, props.searchQuery);
  const searchMatches = threadSearch.matches;
  const threadSearchMatchByKey = useMemo(
    () => new Map(searchMatches.map((match) => [threadSearchMatchKey(match), match] as const)),
    [searchMatches],
  );
  const projects = useProjects();
  const projectByKey = useMemo(
    () =>
      new Map(
        projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
      ),
    [projects],
  );
  const searchContextOf = useCallback(
    (thread: EnvironmentThreadShell) =>
      threadSearchContextTerms(
        thread,
        projectByKey.get(`${thread.environmentId}:${thread.projectId}`),
      ),
    [projectByKey],
  );
  // Same flat list as the compact Home list (HomeScreen.tsx): pinned, then
  // live work, then everything else by recent activity.
  const {
    loaded: shelfPreferencesLoaded,
    settledShelfExpanded,
    toggleSettledShelf,
    snoozedShelfExpanded,
    toggleSnoozedShelf,
  } = useThreadListV2ShelfPreferences();
  // The queued-start and snooze helpers need a clock while the pane stays open.
  const [nowMinute, setNowMinute] = useState(() => new Date().toISOString().slice(0, 16));
  // Snooze wake times are second-precise; a counter bumped exactly at the
  // next wake boundary re-runs the partition with a fresh clock so a woken
  // thread reappears immediately instead of on the next minute tick.
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  useEffect(() => {
    // Refresh immediately because the mount-time value can be hours old.
    setNowMinute(new Date().toISOString().slice(0, 16));
    const id = setInterval(() => setNowMinute(new Date().toISOString().slice(0, 16)), 60_000);
    return () => clearInterval(id);
  }, []);
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
        allThreads: threads,
        section: "pinned",
        pendingOrder,
        reorderableEnvironmentIds: pinReorderEnvironmentIds,
        ordered: getThreadListV2OrderedSection({
          threads,
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
      threads,
      pendingOrder,
      queuedThreadKeys,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      nowMinute,
      snoozeWakeTick,
    ],
  );
  const threadListV2Layout = useMemo(
    () =>
      buildThreadListV2Items({
        pendingOrder,
        threads: threads.filter((thread) => thread.archivedAt === null),
        searchQuery: props.searchQuery,
        searchContextOf,
        matchedThreadKeys: threadSearchMatchByKey,
        settlementEnvironmentIds,
        snoozeEnvironmentIds,
        queuedThreadKeys,
        now: new Date().toISOString(),
        settledShelfExpanded,
        snoozedShelfExpanded,
        selectedThreadKey: props.selectedThreadKey ?? null,
      }),
    [
      pendingOrder,
      queuedThreadKeys,
      nowMinute,
      snoozeWakeTick,
      settledShelfExpanded,
      snoozedShelfExpanded,
      props.selectedThreadKey,
      props.searchQuery,
      searchContextOf,
      threadSearchMatchByKey,
      settlementEnvironmentIds,
      snoozeEnvironmentIds,
      threads,
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
  const listItems = useMemo(() => {
    // Queued offline tasks are not thread shells, so the v2 item builder
    // never sees them; the shared splice puts them below live work (mirrors
    // the compact Home v2 list) where they stay visible and deletable while
    // their environment is offline. Same search filter as the list.
    const v2SearchQuery = props.searchQuery.trim().toLocaleLowerCase();
    return buildThreadListV2ListItems({
      layout: threadListV2Layout,
      pendingTasks:
        v2SearchQuery.length === 0
          ? pendingTasks
          : pendingTasks.filter((pendingTask) =>
              pendingTask.title.toLocaleLowerCase().includes(v2SearchQuery),
            ),
      settledShelfExpanded,
      snoozedShelfExpanded,
      snoozeLabelNow: `${nowMinute}:00.000Z`,
      queuedThreadKeys,
      moveAvailability: threadMoveAvailability,
      shelfPreferencesLoading: !shelfPreferencesLoaded,
    });
  }, [
    nowMinute,
    pendingTasks,
    props.searchQuery,
    queuedThreadKeys,
    threadMoveAvailability,
    shelfPreferencesLoaded,
    settledShelfExpanded,
    snoozedShelfExpanded,
    threadListV2Layout,
  ]);
  const searchListItems = useMemo(
    () =>
      props.searchQuery.trim()
        ? mergeMobileThreadSearchResults({
            items: listItems,
            matches: searchMatches,
            query: props.searchQuery,
            contextOf: searchContextOf,
          })
        : listItems,
    [listItems, searchMatches, props.searchQuery, searchContextOf],
  );

  const [measuredHeaderHeight, setMeasuredHeaderHeight] = useState<number | null>(null);
  const { height, paddingTop, paddingBottom } = useMaterialToolbarLayout();
  // The sticky header (title row, search field, optional connection status)
  // is measured so the list inset always matches its real height — no
  // hardcoded per-variant constants.
  const stickyHeaderHeight =
    measuredHeaderHeight ??
    (Platform.OS === "android"
      ? paddingTop + height + paddingBottom
      : insets.top + SIDEBAR_STICKY_HEADER_HEIGHT);
  const topListInset = stickyHeaderHeight + 6;
  const handleStickyHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    setMeasuredHeaderHeight((current) => (current === nextHeight ? current : nextHeight));
  }, []);
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
  const handleSelectThread = useCallback(
    (thread: EnvironmentThreadShell) => {
      const match = threadSearchMatchByKey.get(
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
      );
      appAtomRegistry.set(pendingThreadSearchJumpAtom, match?.messageId ? match : null);
      props.onSelectThread(thread);
      openSwipeableRef.current?.close();
    },
    [props.onSelectThread, threadSearchMatchByKey],
  );
  const handleScrollBeginDrag = useCallback(() => {
    openSwipeableRef.current?.close();
  }, []);
  const onMaterialFabScroll = useMaterialFabScroll();
  const { swipeEnabled, scrollGateHandlers } = useSwipeableScrollGate({
    onScroll: onMaterialFabScroll,
    onScrollBeginDrag: handleScrollBeginDrag,
  });
  // The capability and search maps feed row props, so they have to bust the
  // recycler's memoization. The minute clock deliberately stays out: its
  // per-row text lives on the items, so a tick only re-renders rows whose
  // displayed text actually moved.
  const listExtraData = useMemo(
    () => ({
      selectedThreadKey: props.selectedThreadKey ?? "",
      listEnvironments,
      threadSearchMatchByKey,
    }),
    [props.selectedThreadKey, listEnvironments, threadSearchMatchByKey],
  );
  useThreadJumpShortcuts(searchListItems, handleSelectThread);
  const focusSearch = useCallback(() => {
    if (Platform.OS === "android") return false;
    const focus = () => {
      if (props.nativeChrome) {
        searchBarRef.current?.focus();
        return;
      }
      searchInputRef.current?.focus();
    };
    if (!props.visible) {
      props.onRequestVisibility();
      setTimeout(focus, 240);
    } else {
      focus();
    }
    return true;
  }, [props.nativeChrome, props.onRequestVisibility, props.visible]);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const renderListItem = useCallback(
    ({ item }: { readonly item: ThreadListV2ListItem | ThreadListV2SearchListItem }) => {
      switch (item.type) {
        case "v2-search-match":
          return (
            <ThreadSearchResultRow
              match={item.match}
              query={props.searchQuery}
              onSelectThread={props.onSelectThread}
            />
          );
        case "v2-pending":
          return (
            <ThreadListV2PendingRow
              pendingTask={item.pendingTask}
              pane="sidebar"
              onSelectPendingTask={openPendingTask}
              onDeletePendingTask={confirmDeletePendingTask}
            />
          );
        case "v2-thread": {
          const thread = item.item.thread;
          // Intentional difference from Home: the sidebar never passes
          // `showTrailingDivider` because its rows render no Home-style row
          // hairline at all — rows carry tonal containers in this pane (the
          // hairline branch is !sidebarPane-only). The stamp still rides the
          // shared list items because Home's boundary suppression consumes
          // it; the sidebar's only cost is the occasional divider-only
          // equality invalidation, which re-renders identically.
          return (
            <ThreadListV2Row
              onNewThreadOnBranch={props.onNewThreadOnBranch}
              thread={thread}
              face={item.face}
              hasQueuedMessages={item.hasQueuedMessages}
              snoozed={item.item.snoozed}
              settled={item.item.settled}
              settlementSupported={settlementEnvironmentIds.has(thread.environmentId)}
              onSettleThread={settleThread}
              onUnsettleThread={unsettleThread}
              pinned={item.item.pinned}
              longRunningStatus={item.item.longRunningStatus}
              snoozeWakeLabelText={item.snoozeWakeLabelText}
              timeLabel={item.timeLabel}
              providerInstance={resolveProviderInstance(thread)}
              providers={providersByEnvironmentId.get(thread.environmentId)}
              searchMatch={threadSearchMatchByKey.get(
                threadSearchMatchKey({
                  environmentId: thread.environmentId,
                  threadId: thread.id,
                }),
              )}
              searchQuery={props.searchQuery}
              pane="sidebar"
              selected={
                scopedThreadKey(thread.environmentId, thread.id) === props.selectedThreadKey
              }
              fullSwipeWidth={props.width - 20}
              onSelectThread={handleSelectThread}
              onDeleteThread={confirmDeleteThread}
              onArchiveThread={archiveThread}
              onRenameThread={renameThread}
              onRegenerateThreadTitle={regenerateThreadTitle}
              titleRegenerationSupported={titleRegenerationEnvironmentIds.has(thread.environmentId)}
              snoozeSupported={snoozeEnvironmentIds.has(thread.environmentId)}
              pinningSupported={pinningEnvironmentIds.has(thread.environmentId)}
              reorderSupported={pinReorderEnvironmentIds.has(thread.environmentId)}
              canMoveUp={item.canMoveUp}
              canMoveDown={item.canMoveDown}
              onSnoozeThread={snoozeThread}
              onUnsnoozeThread={unsnoozeThread}
              onPinThread={pinThread}
              onUnpinThread={unpinThread}
              onMoveThread={moveThread}
              onSwipeableClose={handleSwipeableClose}
              onSwipeableWillOpen={handleSwipeableWillOpen}
              simultaneousSwipeGesture={sidebarScrollGesture}
            />
          );
        }
        case "v2-settled-shelf":
          return (
            <ThreadListV2SnoozedShelfHeader
              label="Settled"
              count={item.count}
              disabled={item.disabled}
              expanded={item.expanded}
              searchExpanded={item.searchExpanded}
              onToggle={toggleSettledShelf}
              pane="sidebar"
            />
          );
        case "v2-snoozed-shelf":
          return (
            <ThreadListV2SnoozedShelfHeader
              count={item.count}
              disabled={item.disabled}
              expanded={item.expanded}
              searchExpanded={item.searchExpanded}
              onToggle={toggleSnoozedShelf}
              pane="sidebar"
            />
          );
      }
    },
    [
      props.onSelectThread,
      archiveThread,
      confirmDeletePendingTask,
      confirmDeleteThread,
      handleSelectThread,
      handleSwipeableClose,
      handleSwipeableWillOpen,
      moveThread,
      openPendingTask,
      pinReorderEnvironmentIds,
      pinThread,
      pinningEnvironmentIds,
      regenerateThreadTitle,
      renameThread,
      props.onNewThreadOnBranch,
      props.searchQuery,
      props.selectedThreadKey,
      props.width,
      resolveProviderInstance,
      providersByEnvironmentId,
      threadSearchMatchByKey,
      titleRegenerationEnvironmentIds,
      sidebarScrollGesture,
      snoozeEnvironmentIds,
      snoozeThread,
      toggleSettledShelf,
      settlementEnvironmentIds,
      settleThread,
      unsettleThread,
      toggleSnoozedShelf,
      unpinThread,
      unsnoozeThread,
    ],
  );
  const nativeHeaderItems = useMemo(
    () => createSidebarHeaderItems({ onOpenSettings: props.onOpenSettings }),
    [props.onOpenSettings],
  );
  // Snoozed threads need no special case: the shelf header is a list row
  // even while collapsed.
  const listEmpty = (
    <View className="items-center">
      {!catalogState.isLoadingConnections && props.searchQuery.trim().length === 0 ? (
        <DefaultHarnessMascot size={64} visible={props.visible} />
      ) : null}
      <Text
        className={
          Platform.OS === "android"
            ? "px-4 py-4 text-center text-sm text-drawer-foreground-muted"
            : "px-2 py-4 text-sm text-drawer-foreground-muted"
        }
      >
        {catalogState.isLoadingConnections
          ? "Loading chats…"
          : Platform.OS === "android" && !catalogState.hasConnections
            ? "No environments connected"
            : props.searchQuery.trim().length > 0
              ? threadSearch.isPending
                ? "Searching chat messages…"
                : threadSearch.failed
                  ? "Couldn't search thread messages"
                  : "No matching chats"
              : "No chats yet"}
      </Text>
    </View>
  );

  if (props.nativeChrome) {
    return (
      <>
        <NativeStackScreenOptions
          optionsVersion={[nativeHeaderItems, props.width]}
          options={{
            // Re-applies the shell's static brand slot with the
            // connection-status swap so reconnects surface in the header
            // instead of shifting the list.
            ...getConnectionAwareBrandHeaderOptions({
              headerWidth: props.width,
              trailingItemCount: nativeHeaderItems.length,
              onOpenEnvironments: props.onOpenEnvironmentSettings,
              fallbackTitleStyle: { fontSize: 18, fontWeight: "800" },
            }),
            headerSearchBarOptions: {
              ref: searchBarRef,
              autoCapitalize: "none",
              hideNavigationBar: false,
              // Keep the search bar pinned under the title — UIKit's default
              // hidesSearchBarWhenScrolling collapses it on scroll.
              hideWhenScrolling: false,
              obscureBackground: false,
              placeholder: "Search",
              placement: "stacked",
              onCancelButtonPress: () => {
                props.onSearchQueryChange("");
              },
              onChangeText: (event) => {
                props.onSearchQueryChange(event.nativeEvent.text);
              },
            },
            unstable_headerRightItems: () => nativeHeaderItems,
          }}
        />
        <View className="flex-1">
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <LegendList
                data={searchListItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={threadListV2ListItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                automaticallyAdjustsScrollIndicatorInsets={NATIVE_LIQUID_GLASS_SUPPORTED}
                contentInsetAdjustmentBehavior={
                  NATIVE_LIQUID_GLASS_SUPPORTED ? "automatic" : "never"
                }
                contentContainerStyle={[
                  styles.threadListContent,
                  Platform.OS === "android" ? { paddingHorizontal: 0 } : null,
                  {
                    paddingBottom: Math.max(insets.bottom, 16) + 16,
                    paddingTop: 6,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={threadSearch.pagination ? null : listEmpty}
                ListFooterComponent={
                  <ThreadSearchMoreButton pagination={threadSearch.pagination} />
                }
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
        </View>
      </>
    );
  }

  return (
    <View
      testID="thread-navigation-sidebar"
      className={
        Platform.OS === "android" ? "flex-1 bg-header" : "flex-1 border-r border-border bg-drawer"
      }
      style={{ width: props.width }}
    >
      <View
        className="flex-1"
        style={
          Platform.OS === "android"
            ? {
                marginTop: stickyHeaderHeight,
                marginHorizontal: 4,
                paddingBottom: insets.bottom,
                backgroundColor: drawerColor,
                borderTopLeftRadius: 28,
                borderTopRightRadius: 28,
                overflow: "hidden",
              }
            : { paddingBottom: insets.bottom }
        }
      >
        {Platform.OS === "android" && searchListItems.length === 0 && !threadSearch.pagination ? (
          <View className="flex-1 items-center justify-center">{listEmpty}</View>
        ) : (
          <SwipeableScrollGateProvider enabled={swipeEnabled}>
            <GestureDetector gesture={sidebarScrollGesture}>
              <LegendList
                data={searchListItems}
                drawDistance={500}
                estimatedItemSize={64}
                extraData={listExtraData}
                getItemType={(item) => item.type}
                itemsAreEqual={threadListV2ListItemsAreEqual}
                keyExtractor={(item) => item.key}
                renderItem={renderListItem}
                contentContainerStyle={[
                  styles.threadListContent,
                  Platform.OS === "android" ? { paddingHorizontal: 0 } : null,
                  {
                    paddingBottom:
                      Platform.OS === "android"
                        ? Math.max(insets.bottom, 16) + fabClearance - insets.bottom
                        : 16 + insets.bottom,
                    paddingTop: Platform.OS === "android" ? 6 : topListInset,
                  },
                ]}
                keyboardDismissMode="on-drag"
                keyboardShouldPersistTaps="handled"
                {...scrollGateHandlers}
                recycleItems
                scrollEventThrottle={16}
                showsVerticalScrollIndicator={false}
                style={styles.threadList}
                ListEmptyComponent={threadSearch.pagination ? null : listEmpty}
                ListFooterComponent={
                  <ThreadSearchMoreButton pagination={threadSearch.pagination} />
                }
              />
            </GestureDetector>
          </SwipeableScrollGateProvider>
        )}
      </View>

      {Platform.OS === "android" ? (
        <MaterialThreadListToolbar
          sidebar
          onLayout={handleStickyHeaderLayout}
          searchQuery={props.searchQuery}
          onSearchQueryChange={props.onSearchQueryChange}
          onOpenSettings={props.onOpenSettings}
          onOpenEnvironments={props.onOpenEnvironmentSettings}
          onRequestVisibility={props.onRequestVisibility}
        />
      ) : (
        <View
          className="absolute inset-x-0 top-0 z-[4] bg-drawer"
          collapsable={false}
          onLayout={handleStickyHeaderLayout}
          pointerEvents="auto"
          style={{ paddingTop: insets.top }}
        >
          <View className="h-[50px] flex-row items-end gap-0.5 pr-2 pl-5">
            {/* Title slot doubles as the connection status surface: while an
              environment reconnects, the brand fades to a status label in
              place (no layout shift in the list below). */}
            <WorkspaceConnectionTitle
              grow
              onPress={props.onOpenEnvironmentSettings}
              size="pageTitle"
              brand={
                <View className="h-11 flex-1 justify-center">
                  <CompactBrandTitle allowFontScaling={false} />
                </View>
              }
            />
            <SidebarHeaderActions onOpenSettings={props.onOpenSettings} />
          </View>

          <View className="mx-4 mt-[9px] h-[38px] flex-row items-center gap-1.5 rounded-xl bg-sidebar-search pr-2.5 pl-[11px]">
            <SymbolView
              name="magnifyingglass"
              size={15}
              tintColorClassName="accent-drawer-foreground-muted"
              type="monochrome"
            />
            <TextInput
              ref={searchInputRef}
              accessibilityLabel="Search chats"
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              onChangeText={props.onSearchQueryChange}
              placeholder="Search"
              placeholderTextColorClassName="accent-placeholder"
              selectionColorClassName={undefined}
              cursorColorClassName={undefined}
              selectionHandleColorClassName={undefined}
              returnKeyType="search"
              className="h-[34px] flex-1 px-0 py-0 font-sans text-base text-drawer-foreground"
              value={props.searchQuery}
            />
          </View>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  threadList: {
    flex: 1,
  },
  threadListContent: {
    paddingHorizontal: 8,
  },
});
