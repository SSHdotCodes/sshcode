import { isWorkflowThread } from "../workflows/workflowVisibility";
import { withoutBotThreads } from "../bots/botVisibility";
import { useBotThreadKeys } from "../bots/state";
import { appAtomRegistry } from "../../state/atom-registry";
import { useUiMode } from "../discord/useUiMode";
import { resolveThreadListV2Status } from "../threads/threadListV2";
import { use } from "react";
import {
  NativePrimaryColumnContext,
  NativeWorkspaceTabActivityContext,
} from "../../native/v5-workspace-context";
import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Platform, View, useWindowDimensions } from "react-native";

import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { homeThreadShells, shellPreviewPresentation, threadFamilies } from "../../state/threads";
import { useAtomValue } from "@effect/atom-react";
import { usePendingNewTasks } from "../../state/use-pending-new-tasks";
import { useWorkspaceState } from "../../state/workspace";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { useNativeColumnLayoutMetrics } from "../../native/native-layout-metrics";
import { WorkspaceEmptyDetail } from "../layout/WorkspaceEmptyDetail";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { checkForAppUpdateOnLaunch, startAppUpdateForegroundRecheck } from "../updates/app-updates";
import { AndroidHomeFabLayout } from "./AndroidHomeFab";
import { HomeScreen } from "./HomeScreen";
import { HomeHeader } from "./HomeHeader";
import { useAtomValueWhileVisible, useHomeRouteVisible } from "../../state/home-route-visibility";
import { useHomeThreadSelection } from "./home-thread-navigation";
import { usePendingTaskListActions } from "./usePendingTaskListActions";
import { useThreadListActions } from "./useThreadListActions";
import { getConnectionAwareBrandHeaderOptions } from "./WorkspaceConnectionTitle";
import { useWorkspaceTabs } from "../workspace/WorkspaceTabsContext";
import { BedsideScreen } from "../bedside/BedsideScreen";
import { useBedsideIdle } from "../bedside/useBedsideScreen";

/* ─── Route screen ───────────────────────────────────────────────────── */

export function HomeRouteScreen() {
  const { width: windowWidth } = useWindowDimensions();
  const nativePrimaryColumn = use(NativePrimaryColumnContext);
  const columnMetrics = useNativeColumnLayoutMetrics();
  const headerWidth = nativePrimaryColumn ? (columnMetrics?.width ?? windowWidth) : windowWidth;
  const { layout, panes, primarySidebarSearchQuery, setPrimarySidebarSearchQuery } =
    useAdaptiveWorkspaceLayout();
  // Streaming turns rewrite thread shells many times a second. While a Thread
  // covers Home, rebuilding this list is invisible work.
  const visible = useHomeRouteVisible();
  // Focus is lost to pushed chats and sheets; the tab is inactive under Pull requests.
  const focused = useIsFocused();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const bedside = useBedsideIdle(
    focused && tabActive && !layout.usesSplitView && !nativePrimaryColumn,
  );
  const [uiMode] = useUiMode();
  const workspace = useWorkspaceTabs();
  const [localSearchQuery, setLocalSearchQuery] = useState("");
  const searchQuery =
    Platform.OS === "android"
      ? primarySidebarSearchQuery
      : (workspace?.state.tabs.threads.query ?? localSearchQuery);
  // Discord nests children under their parent. Search also needs them to recognize
  // workflow descendants. Other Home layouts only read top-level chats.
  const withChildren = uiMode === "discord" || searchQuery.trim().length > 0;
  const allThreads = useAtomValueWhileVisible(
    withChildren ? homeThreadShells.threadShellsAtom : homeThreadShells.topLevelThreadShellsAtom,
    visible,
  );
  const readOnlyEnvironmentIds = useAtomValue(shellPreviewPresentation.readOnlyEnvironmentIdsAtom);
  const previewCounts = useAtomValue(shellPreviewPresentation.countsAtom);
  // Bot home chats live in the Bots strip, never in the list, its search or its counts.
  const botThreadKeys = useBotThreadKeys();
  const threads = useMemo(
    () => withoutBotThreads(allThreads, botThreadKeys),
    [allThreads, botThreadKeys],
  );
  const navigationThreads = useMemo(
    () =>
      threads.filter(
        (thread) => thread.lineage.relationshipToParent !== "subagent" && !isWorkflowThread(thread),
      ),
    [threads],
  );
  const mountedFamilies = useRef(new Map<string, () => void>());
  useEffect(() => {
    const active = new Set<string>();
    if (visible && uiMode === "discord") {
      for (const thread of navigationThreads) {
        if (readOnlyEnvironmentIds.has(thread.environmentId)) continue;
        if (
          !["working", "waiting", "approval", "input"].includes(resolveThreadListV2Status(thread))
        )
          continue;
        const key = `${thread.environmentId}:${thread.id}`;
        active.add(key);
        if (!mountedFamilies.current.has(key))
          mountedFamilies.current.set(
            key,
            threadFamilies.mount(appAtomRegistry, thread.environmentId, thread.id),
          );
      }
    }
    for (const [key, unmount] of mountedFamilies.current) {
      if (active.has(key)) continue;
      unmount();
      mountedFamilies.current.delete(key);
    }
  }, [navigationThreads, readOnlyEnvironmentIds, uiMode, visible]);
  useEffect(() => {
    const families = mountedFamilies.current;
    return () => {
      for (const unmount of families.values()) unmount();
      families.clear();
    };
  }, []);
  const { environments: workspaceEnvironments, state: catalogState } = useWorkspaceState();
  const navigation = useNavigation();
  const setSearchQuery = (query: string) => {
    if (Platform.OS === "android") setPrimarySidebarSearchQuery(query);
    else if (workspace) workspace.dispatch({ type: "query", query, tab: "threads" });
    else setLocalSearchQuery(query);
  };
  const handleSelectThread = useHomeThreadSelection();
  const handleNewThreadOnBranch = useCallback(
    (thread: EnvironmentThreadShell) => {
      navigation.navigate("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          environmentId: String(thread.environmentId),
          projectId: String(thread.projectId),
          branch: thread.branch,
          worktreePath: thread.worktreePath,
        },
      });
    },
    [navigation],
  );

  useEffect(() => {
    void checkForAppUpdateOnLaunch();
    startAppUpdateForegroundRecheck();
  }, []);

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
  const pendingTasks = usePendingNewTasks(visible);
  const { openPendingTask, confirmDeletePendingTask } = usePendingTaskListActions();
  // In split layouts the persistent sidebar IS the thread list — Home becomes
  // an empty detail pane so selecting a thread never transitions layouts.
  if (layout.usesSplitView && !nativePrimaryColumn) {
    return (
      <>
        <NativeStackScreenOptions
          options={
            Platform.OS === "android"
              ? { headerShown: false }
              : {
                  title: "",
                  headerTitle: "",
                  unstable_headerLeftItems: () => [],
                  // Options survive layout changes; search and settings now belong to the sidebar.
                  headerSearchBarOptions: undefined,
                  unstable_headerRightItems: () => [],
                  unstable_headerToolbarItems: () => [],
                }
          }
        />
        {Platform.OS === "ios" ? (
          <NativeHeaderToolbar placement="left">
            <NativeHeaderToolbar.Button
              accessibilityLabel="New chat"
              icon="square.and.pencil"
              onPress={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            />
          </NativeHeaderToolbar>
        ) : null}
        {Platform.OS === "android" ? <AndroidScreenHeader title="Chats" /> : null}
        <WorkspaceEmptyDetail
          onAddConnection={
            Platform.OS === "android" && !catalogState.hasConnections
              ? () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironmentNew", initial: false },
                  })
              : undefined
          }
          onStartNewTask={
            Platform.OS === "android" && panes.primarySidebarVisible
              ? undefined
              : () => navigation.navigate("NewTaskSheet", { screen: "NewTask" })
          }
        />
      </>
    );
  }

  return (
    <AndroidHomeFabLayout
      disabled={workspace !== null && Platform.OS !== "android"}
      onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
    >
      <>
        {/* Restore the header after leaving split view; screen options are
            shallow-merged. The brand slot also doubles as the connection
            status surface while an environment reconnects. */}
        {workspace !== null && Platform.OS === "ios" ? null : (
          <NativeStackScreenOptions
            optionsVersion={headerWidth}
            options={{
              ...getConnectionAwareBrandHeaderOptions({
                headerWidth,
                trailingItemCount:
                  nativePrimaryColumn && Platform.OS === "ios" && Platform.isPad ? 2 : 1,
                onOpenEnvironments: () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "SettingsEnvironments", initial: false },
                  }),
              }),
              headerShown: Platform.OS !== "android",
            }}
          />
        )}
        <HomeHeader
          usesWorkspaceToolbar={workspace !== null}
          searchQuery={searchQuery}
          onOpenEnvironments={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "SettingsEnvironments", initial: false },
            })
          }
          onOpenSettings={() =>
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: "Settings" },
            })
          }
          onSearchQueryChange={setSearchQuery}
          onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
        />

        <BedsideScreen
          visible={bedside.shown}
          onExit={bedside.exit}
          onOpenThread={handleSelectThread}
        />
        {/* Every touch on the list restarts the bedside screen's idle minute. */}
        <View className="flex-1" onTouchStart={bedside.onTouchStart}>
          <HomeScreen
            readOnlyEnvironmentIds={readOnlyEnvironmentIds}
            previewCounts={previewCounts}
            catalogState={catalogState}
            environments={workspaceEnvironments}
            onAddConnection={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsEnvironmentNew", initial: false },
              })
            }
            onArchiveThread={archiveThread}
            onSettleThread={settleThread}
            onUnsettleThread={unsettleThread}
            onDeleteThread={confirmDeleteThread}
            onSnoozeThread={snoozeThread}
            onUnsnoozeThread={unsnoozeThread}
            onPinThread={pinThread}
            onUnpinThread={unpinThread}
            onMoveThread={moveThread}
            onRenameThread={renameThread}
            onRegenerateThreadTitle={regenerateThreadTitle}
            onOpenSettings={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "Settings" },
              })
            }
            onSearchQueryChange={setSearchQuery}
            onSelectThread={handleSelectThread}
            onSelectPendingTask={openPendingTask}
            onDeletePendingTask={confirmDeletePendingTask}
            onNewThreadOnBranch={handleNewThreadOnBranch}
            onNewThreadInProject={(project) => {
              navigation.navigate("NewTaskSheet", {
                screen: "NewTaskDraft",
                params: {
                  environmentId: String(project.environmentId),
                  projectId: String(project.id),
                  title: project.title,
                },
              });
            }}
            onStartNewTask={() => navigation.navigate("NewTaskSheet", { screen: "NewTask" })}
            pendingTasks={pendingTasks}
            searchQuery={searchQuery}
            childThreads={threads}
            threads={navigationThreads}
          />
        </View>
      </>
    </AndroidHomeFabLayout>
  );
}
