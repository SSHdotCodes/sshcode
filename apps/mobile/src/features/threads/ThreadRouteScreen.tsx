import { describeThreadHelpers } from "@t3tools/client-runtime/stop-helpers";
import { useThreadMonitors } from "./ThreadMonitors";
import { ThreadFindBar } from "./ThreadFindBar";
import { threadFindEntryId, threadFindMode, type ThreadFindAnchorReader } from "./thread-find";
import {
  pendingThreadSearchJumpAtom,
  searchJumpTarget,
} from "@t3tools/client-runtime/state/thread-search";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  matchesTimelineJump,
  type TimelineJumpRequest,
} from "@t3tools/client-runtime/state/thread-search";
import {
  threadHasMedia,
  threadMediaIndex,
  type ThreadMediaItem,
} from "@t3tools/client-runtime/thread-media";
import { useAtomValue } from "@effect/atom-react";
import { markLoad } from "@t3tools/client-runtime/load-marks";
import { PendingSendNotice } from "../connection/PendingSendNotice";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";
import { generationsByRun } from "@t3tools/shared/generationRate";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { makeTurnCommandMetadata } from "../../lib/commandMetadata";
import { buildProjectThreadStartTurnInput } from "../../lib/projectThreadStartTurn";
import { useWorktreeSetup } from "./use-worktree-setup";
import { worktreeSetupAgentStarted } from "@t3tools/client-runtime/worktree-setup";
import { ScreenHeader } from "../../components/ScreenHeader";
import {
  StackActions,
  useFocusEffect,
  useNavigation,
  type StaticScreenProps,
} from "@react-navigation/native";
import { HeaderHeightContext } from "@react-navigation/elements";
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as Option from "effect/Option";
import {
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  MessageId,
  ThreadId,
  TurnItemId,
  sideChatKindForDriver,
  type ProjectScript,
} from "@t3tools/contracts";
import {
  deriveSteerWait,
  sameSteerWait,
  sendSteerNow as requestSendSteerNow,
  type SteerWait,
} from "@t3tools/client-runtime/state/steer-wait";
import { orchestrationEnvironment } from "../../state/orchestration";
import {
  projectScriptCwd,
  projectScriptRuntimeEnv,
  resolveProjectScripts,
} from "@t3tools/shared/projectScripts";
import { ActionSheetIOS, Alert, Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useConnectionsReady, useWorkspaceEnvironments } from "../../state/workspace";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import { useEnvironmentShellReadiness } from "../../state/shell";
import { restoredNewTaskDraftKey } from "../../state/new-task-draft-key";
import { clearPendingThreadCreationOutcome } from "../../state/pending-thread-creation";
import { recoverFailedThreadDraft } from "../../state/recover-failed-thread-draft";
import {
  dismissGitActionResult,
  useGitActionProgress,
  useVcsActionState,
} from "../../state/use-vcs-action-state";
import { vcsEnvironment } from "../../state/vcs";
import { EmptyState } from "../../components/EmptyState";
import { LoadingScreen } from "../../components/LoadingScreen";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { connectionTone } from "../connection/connectionTone";
import {
  useRemoteConnections,
  useRemoteConnectionStatus,
  useRemoteEnvironmentRuntime,
} from "../../state/use-remote-environment-registry";
import { useKnownTerminalSessions } from "../../state/use-terminal-session";
import { uuidv4 } from "../../lib/uuid";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useSelectedThreadDetailState } from "../../state/use-thread-detail";
import { useThreadSelection } from "../../state/use-thread-selection";
import { GitActionProgressOverlay } from "./GitActionProgressOverlay";
import {
  buildTerminalMenuSessions,
  nextOpenTerminalId,
  resolveProjectScriptTerminalId,
} from "../terminal/terminalMenu";
import {
  resolvePreferredThreadWorktreePath,
  stagePendingTerminalLaunch,
} from "../terminal/terminalLaunchContext";
import { terminalDebugLog } from "../terminal/terminalDebugLog";
import { ThreadDetailScreen, type ThreadDetailScreenProps } from "./ThreadDetailScreen";
import { GitOverviewSheet } from "./git/GitOverviewSheet";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectedThreadGitActions } from "../../state/use-selected-thread-git-actions";
import { useSelectedThreadRequests } from "../../state/use-selected-thread-requests";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadComposerState } from "../../state/use-thread-composer-state";
import { resolveMergeBackTargetThreadId } from "@t3tools/client-runtime/state/thread-relationships";
import { resolveLatestMergeBackRun } from "@t3tools/client-runtime/state/thread-workflows";
import { threadEnvironment, threadMediaPageCommand, useThreadFamily } from "../../state/threads";
import { projectThreadContentPresentation } from "./threadContentPresentation";
import {
  HarnessThemeScope,
  useAppearancePreferences,
} from "../settings/appearance/AppearancePreferencesProvider";
import { resolveMobileHarnessDriver } from "../../lib/harnessThemes";
import {
  useAdaptiveWorkspaceLayout,
  useAdaptiveWorkspacePaneRole,
  useRegisterWorkspaceInspector,
} from "../layout/AdaptiveWorkspaceLayout";
import { ThreadFileNavigatorPane } from "../files/thread-file-navigator-pane";
import {
  ThreadInspectorContentStack,
  type ThreadInspectorMode,
} from "./thread-inspector-content-stack";
import { threadRouteIsHydrating } from "./thread-route-hydration";
import { useThreadPromptLink } from "../prompt-links/useThreadPromptLink";
import { ThreadHeader } from "./ThreadHeader";
import { ThreadMediaGallery } from "./ThreadMediaGallery";
import { useUiMode } from "../discord/useUiMode";
import {
  useAndroidWorkspaceBack,
  useWorkspaceListNavigation,
} from "../workspace/useAndroidWorkspaceNavigation";

interface ThreadInspectorSelection {
  readonly routeThreadIdentity: string | null;
  readonly mode: ThreadInspectorMode;
}

function InspectorPaneRoleActivation() {
  useAdaptiveWorkspacePaneRole("inspector");
  return null;
}

// A blank param (a hand-typed deep link) is treated as missing, since branded
// IDs reject whitespace-only values.
function firstRouteParam(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first === undefined || first.trim().length === 0 ? null : first;
}

function ThreadPane(props: { readonly children: ReactNode }) {
  return (
    <View className="flex-1 bg-screen android:overflow-hidden android:rounded-t-[28px] android:bg-thread-canvas">
      {props.children}
    </View>
  );
}

function ThreadRouteFallbackLayout(props: { readonly children: ReactNode }) {
  const returnToList = useWorkspaceListNavigation("threads");
  const { layout } = useAdaptiveWorkspaceLayout();
  const { themeVariables } = useAppearancePreferences();
  if (Platform.OS !== "android") return props.children;

  return (
    <>
      <ScreenHeader
        title="Chat"
        options={{ contentStyle: { backgroundColor: themeVariables["--color-header"] } }}
        onBack={layout.usesSplitView ? undefined : returnToList}
        hideBottomBorder
      />
      <ThreadPane>{props.children}</ThreadPane>
    </>
  );
}

function OpeningThreadLoadingScreen() {
  return (
    <ThreadRouteFallbackLayout>
      <LoadingScreen
        message="Opening chat…"
        messagePlacement="above-spinner"
        embedded={Platform.OS === "android"}
      />
    </ThreadRouteFallbackLayout>
  );
}

type ThreadRouteScreenRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  /** A prompt link's draft text. See useThreadPromptLink. */
  readonly prompt?: string | string[];
}>;

interface ThreadRouteScreenProps extends ThreadRouteScreenRouteProps {
  readonly onReturnToThread?: () => void;
  readonly renderInspector?: (headerInset: number) => ReactNode;
}

/** Shows recovery only after the target route has reached a terminal unavailable state. */
function ThreadUnavailableScreen(props: {
  readonly actionLabel: string;
  readonly onAction: () => void;
}) {
  return (
    <ThreadRouteFallbackLayout>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          flexGrow: 1,
          justifyContent: "center",
          paddingHorizontal: 24,
          paddingVertical: 32,
        }}
        className="bg-screen flex-1 android:bg-transparent"
      >
        <EmptyState
          title="Chat unavailable"
          detail="This chat is not available in the current mobile snapshot."
          actionLabel={props.actionLabel}
          onAction={props.onAction}
        />
      </ScrollView>
    </ThreadRouteFallbackLayout>
  );
}

export function ThreadRouteScreen(props: ThreadRouteScreenProps) {
  useAndroidWorkspaceBack("threads");
  const connectionsReady = useConnectionsReady();
  const { connectionState } = useRemoteConnectionStatus();
  const { selectedThread } = useThreadSelection();
  const params = props.route.params;
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const threadIdRaw = firstRouteParam(params.threadId);
  useFocusEffect(
    useCallback(() => {
      if (threadIdRaw)
        markLoad("chat.opened", {
          thread: threadIdRaw.slice(0, 8),
          ...(environmentIdRaw ? { environment: environmentIdRaw.slice(0, 8) } : {}),
        });
    }, [threadIdRaw, environmentIdRaw]),
  );
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const [uiMode] = useUiMode();
  const routeLineage =
    selectedThread?.id === threadIdRaw && selectedThread.environmentId === environmentId
      ? selectedThread.lineage
      : null;
  // The Agents sheet reads the full family on demand. The parent transcript
  // uses live children from the shell and looks up individual linked chats.
  useThreadFamily(
    environmentId,
    routeLineage && (uiMode === "discord" || routeLineage.relationshipToParent === "subagent")
      ? routeLineage.rootThreadId
      : null,
  );
  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeEnvironmentShellState = useEnvironmentShellReadiness(environmentId);
  const { onReconnectEnvironment } = useRemoteConnections();
  const navigation = useNavigation();
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeThreadKey =
    environmentId !== null && threadIdRaw !== null
      ? scopedThreadKey(environmentId, ThreadId.make(threadIdRaw))
      : null;
  const selectedThreadKey =
    selectedThread === null
      ? null
      : scopedThreadKey(selectedThread.environmentId, selectedThread.id);
  const selectedThreadDetailState = useSelectedThreadDetailState();
  useThreadPromptLink(params, routeThreadKey);

  if (environmentId === null || threadIdRaw === null) {
    return <OpeningThreadLoadingScreen />;
  }

  // Render the full thread chrome (header, feed, composer) as soon as the
  // thread SHELL is known — no blocking on message detail. The feed shows a
  // loading placeholder while messages fetch, the floating pill above the
  // composer reports loading/syncing, and the composer's connection pill
  // reports connecting/reconnecting status.
  if (selectedThread !== null && selectedThreadKey === routeThreadKey) {
    return <ThreadRouteContent {...props} selectedThreadDetailState={selectedThreadDetailState} />;
  }

  const stillHydrating = threadRouteIsHydrating({
    isLoadingConnections: !connectionsReady,
    connectionState: routeConnectionState,
    shellStatus: routeEnvironmentShellState.status,
    shellHasError: routeEnvironmentShellState.hasError,
    detailStatus: selectedThreadDetailState.status,
    detailHasError: Option.isSome(selectedThreadDetailState.error),
  });

  if (stillHydrating) {
    return <OpeningThreadLoadingScreen />;
  }

  return (
    <ThreadUnavailableScreen
      actionLabel={
        routeEnvironmentRuntime === null ? "Manage environments" : "Reconnect environment"
      }
      onAction={() => {
        if (routeEnvironmentRuntime !== null) {
          onReconnectEnvironment(environmentId);
          return;
        }
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: { screen: "SettingsEnvironments" },
        });
      }}
    />
  );
}

function ThreadRouteContent(
  props: ThreadRouteScreenProps & {
    readonly selectedThreadDetailState: ReturnType<typeof useSelectedThreadDetailState>;
  },
) {
  const { fileInspector, layout, panes, showAuxiliaryPane, toggleAuxiliaryPane } =
    useAdaptiveWorkspaceLayout();
  const { connectionState } = useRemoteConnectionStatus();
  const { onReconnectEnvironment } = useRemoteConnections();
  const {
    selectedThread,
    selectedThreadCreation,
    selectedThreadDetailRef,
    selectedThreadProject,
    selectedEnvironmentConnection,
  } = useThreadSelection();
  const canOperateThread = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthOrchestrationOperateScope,
  );
  const canReadTerminal = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthTerminalReadScope,
  );
  const canOperateTerminal = useEnvironmentScope(
    selectedThread?.environmentId ?? null,
    AuthTerminalOperateScope,
  );
  const selectedThreadDetailState = props.selectedThreadDetailState;
  const selectedThreadDetail = Option.getOrNull(selectedThreadDetailState.data);
  const markedEnvironmentId = selectedThread?.environmentId.slice(0, 8);
  const messagesMarked = useRef<string | null>(null);
  useEffect(() => {
    if (selectedThreadDetail === null) return;
    const id = selectedThreadDetail.thread.id;
    if (messagesMarked.current === id) return;
    messagesMarked.current = id;
    markLoad("chat.messages.ready", {
      thread: id.slice(0, 8),
      ...(markedEnvironmentId ? { environment: markedEnvironmentId } : {}),
      rows: selectedThreadDetail.visibleTurnItems.length,
    });
  }, [selectedThreadDetail, markedEnvironmentId]);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const [mediaOpen, setMediaOpen] = useState(false);
  const [mediaSearch, setMediaSearch] = useState(false);
  const [mediaSeed, setMediaSeed] = useState<{
    items: readonly ThreadMediaItem[];
    cursor: string | null;
    partial: boolean;
  } | null>(null);
  const currentMediaThreadKey = selectedThread
    ? scopedThreadKey(selectedThread.environmentId, selectedThread.id)
    : null;
  const mediaSearchKey = useRef(currentMediaThreadKey);
  useLayoutEffect(() => {
    mediaSearchKey.current = currentMediaThreadKey;
  }, [currentMediaThreadKey]);
  const loadMediaPage = useAtomCommand(threadMediaPageCommand, { reportFailure: false });
  const [mediaJump, setMediaJump] = useState<
    (TimelineJumpRequest & { readonly threadKey: string }) | null
  >(null);
  const mediaJumpSequence = useRef(0);
  const [findOpen, setFindOpen] = useState(false);
  const findAnchorReader = useRef<ThreadFindAnchorReader | null>(null);
  const findContent = selectedThreadDetail?.visibleTurnItems;
  const readFindAnchor = useCallback(() => {
    const viewport = findAnchorReader.current?.();
    if (viewport) return viewport;
    const entry = findContent?.findLast((row) => threadFindEntryId(row) !== undefined);
    const entryId = threadFindEntryId(entry);
    return entryId ? { entryId, occurrence: 0 } : undefined;
  }, [findContent]);
  const openFindInChat = useCallback(() => setFindOpen(true), []);
  const closeFindInChat = useCallback(() => setFindOpen(false), []);
  const hasThreadMedia = useMemo(
    () =>
      selectedThreadDetail !== null &&
      threadHasMedia(selectedThreadDetail, { workspaceRoot: selectedThreadCwd }),
    [selectedThreadDetail?.visibleTurnItems, selectedThreadDetail?.messages, selectedThreadCwd],
  );
  const threadMedia = useMemo(
    () =>
      mediaOpen && selectedThreadDetail
        ? threadMediaIndex(selectedThreadDetail, { workspaceRoot: selectedThreadCwd })
        : [],
    [
      mediaOpen,
      selectedThreadDetail?.visibleTurnItems,
      selectedThreadDetail?.messages,
      selectedThreadCwd,
    ],
  );
  const openMedia = async () => {
    if (!selectedThread || mediaSearch) return;
    const key = currentMediaThreadKey;
    let cursor = selectedThreadDetailState.history.historyCursor;
    if (hasThreadMedia) {
      setMediaSeed({ items: [], cursor, partial: false });
      setMediaOpen(true);
      return;
    }
    setMediaSearch(true);
    let partial = false;
    while (cursor) {
      const result = await loadMediaPage({
        environmentId: selectedThread.environmentId,
        input: { threadId: selectedThread.id, cursor },
      });
      if (mediaSearchKey.current !== key) return;
      if (result._tag === "Failure") {
        setMediaSearch(false);
        Alert.alert("Could not load earlier media");
        return;
      }
      partial ||= result.value.partial === true;
      cursor = result.value.nextCursor;
      if (result.value.items.length) {
        setMediaSeed({ items: result.value.items, cursor, partial });
        setMediaSearch(false);
        setMediaOpen(true);
        return;
      }
    }
    setMediaSearch(false);
    Alert.alert(partial ? "Some older media is unavailable" : "No media in this chat");
  };
  const showMediaInChat = useCallback(
    (item: ThreadMediaItem) => {
      setMediaOpen(false);
      if (selectedThread)
        setMediaJump({
          item,
          sequence: ++mediaJumpSequence.current,
          threadKey: scopedThreadKey(selectedThread.environmentId, selectedThread.id),
        });
    },
    [selectedThread],
  );
  useEffect(() => {
    setFindOpen(false);
    setMediaOpen(false);
    setMediaSearch(false);
    setMediaSeed(null);
    setMediaJump(null);
  }, [selectedThread?.id, selectedThread?.environmentId]);
  const revealFindEntry = useCallback(
    (entryId: string) => {
      if (!selectedThread) return;
      setMediaJump({
        item: { sourceItemId: TurnItemId.make(entryId), messageId: MessageId.make(entryId) },
        highlight: true,
        sequence: ++mediaJumpSequence.current,
        threadKey: scopedThreadKey(selectedThread.environmentId, selectedThread.id),
      });
    },
    [selectedThread],
  );

  const composer = useThreadComposerState();
  const selectedThreadGitTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    [selectedThread?.environmentId, selectedThreadCwd],
  );
  // Only read local git action progress here; source-control discovery and branch
  // lists belong to the Git sheets and Review header so opening/reconnecting a
  // thread does not fire server.discoverSourceControl or vcs.listRefs.
  const gitActionState = useVcsActionState(selectedThreadGitTarget);
  const gitActions = useSelectedThreadGitActions({ observeRepository: false });
  const requests = useSelectedThreadRequests(composer.composerDraftKey);
  const interruptThreadTurn = useAtomCommand(threadEnvironment.interruptTurn, "thread interrupt");
  const loadEarlierHistory = useAtomCommand(threadEnvironment.loadEarlierHistory, {
    label: "load earlier thread history",
    reportFailure: false,
  });
  const pendingSearchJump = useAtomValue(pendingThreadSearchJumpAtom);
  useEffect(() => {
    if (
      !pendingSearchJump ||
      !selectedThread ||
      pendingSearchJump.environmentId !== selectedThread.environmentId ||
      pendingSearchJump.threadId !== selectedThread.id
    )
      return;
    const item = searchJumpTarget(pendingSearchJump);
    if (item)
      setMediaJump({
        item,
        highlight: true,
        sequence: ++mediaJumpSequence.current,
        threadKey: scopedThreadKey(selectedThread.environmentId, selectedThread.id),
      });
    appAtomRegistry.set(pendingThreadSearchJumpAtom, null);
  }, [pendingSearchJump, selectedThread]);
  useEffect(() => {
    const history = selectedThreadDetailState.history;
    if (
      !mediaJump ||
      !selectedThread ||
      mediaJump.threadKey !== scopedThreadKey(selectedThread.environmentId, selectedThread.id) ||
      !selectedThreadDetail ||
      !history.hasMoreHistory ||
      history.loading ||
      history.error
    )
      return;
    if (
      selectedThreadDetail.visibleTurnItems.some((row) => matchesTimelineJump(row, mediaJump.item))
    )
      return;
    void loadEarlierHistory({
      environmentId: selectedThread.environmentId,
      input: {
        threadId: selectedThread.id,
        throughEntryId: mediaJump.item.messageId ?? mediaJump.item.sourceItemId,
      },
    });
  }, [
    mediaJump,
    selectedThread,
    selectedThreadDetail,
    selectedThreadDetailState.history,
    loadEarlierHistory,
  ]);
  const historyControls = useMemo(() => {
    const history = selectedThreadDetailState.history;
    if (!selectedThread) {
      return undefined;
    }
    if (!history.hasMoreHistory && history.error === null) {
      return undefined;
    }
    return {
      hasMoreHistory: history.hasMoreHistory,
      loading: history.loading,
      error: history.error,
      onLoadEarlier: () => {
        void loadEarlierHistory({
          environmentId: selectedThread.environmentId,
          input: { threadId: selectedThread.id },
        });
      },
    };
  }, [loadEarlierHistory, selectedThread, selectedThreadDetailState.history]);
  const navigation = useNavigation();
  const openPullRequest = useOpenPullRequest();
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack, "merge thread back");
  const mergeBackTargetThreadId = resolveMergeBackTargetThreadId(selectedThreadDetail);
  const mergeBackRun =
    selectedThreadDetail === null ? null : resolveLatestMergeBackRun(selectedThreadDetail);
  const mergeBackBusyRef = useRef(false);
  const handleMergeBack = useCallback(async () => {
    if (
      mergeBackBusyRef.current ||
      !selectedThread ||
      mergeBackTargetThreadId === null ||
      mergeBackRun === null
    ) {
      return;
    }
    mergeBackBusyRef.current = true;
    try {
      const result = await mergeBack({
        environmentId: selectedThread.environmentId,
        input: {
          sourceThreadId: selectedThread.id,
          targetThreadId: mergeBackTargetThreadId,
          runId: mergeBackRun.id,
          creationSource: "mobile",
        },
      });
      if (result._tag !== "Success") return;
      navigation.navigate("Thread", {
        environmentId: selectedThread.environmentId,
        threadId: mergeBackTargetThreadId,
      });
    } finally {
      mergeBackBusyRef.current = false;
    }
  }, [mergeBack, mergeBackRun, mergeBackTargetThreadId, navigation, selectedThread]);
  const turnItems = selectedThreadDetail?.turnItems;
  const derivedSteerWait = useMemo(
    () => (turnItems === undefined ? null : deriveSteerWait(turnItems)),
    [turnItems],
  );
  const [stableSteerWait, setStableSteerWait] = useState<SteerWait | null>(derivedSteerWait);
  if (!sameSteerWait(stableSteerWait, derivedSteerWait)) {
    setStableSteerWait(derivedSteerWait);
  }
  const steerWait = sameSteerWait(stableSteerWait, derivedSteerWait)
    ? stableSteerWait
    : derivedSteerWait;
  const backgroundToolCall = useAtomCommand(orchestrationEnvironment.backgroundToolCall, {
    reportFailure: false,
  });
  const sendSteerNow = useCallback(
    async (toolItemIds: ReadonlyArray<TurnItemId>) => {
      if (!selectedThread) return;
      const error = await requestSendSteerNow(selectedThread.id, toolItemIds, (input) =>
        backgroundToolCall({ environmentId: selectedThread.environmentId, input }),
      );
      if (error !== undefined) {
        Alert.alert("Couldn't send now", error instanceof Error ? error.message : "Try again.");
      }
    },
    [backgroundToolCall, selectedThread],
  );
  const params = props.route.params;
  const environmentIdRaw = firstRouteParam(params.environmentId);
  const environmentId = environmentIdRaw ? EnvironmentId.make(environmentIdRaw) : null;
  const threadId = firstRouteParam(params.threadId);
  const routeThreadIdentity =
    environmentIdRaw !== null && threadId !== null ? `${environmentIdRaw}:${threadId}` : null;
  const [inspectorSelection, setInspectorSelection] = useState<ThreadInspectorSelection | null>(
    () => (props.renderInspector ? { routeThreadIdentity, mode: "route" } : null),
  );
  const inspectorMode = (() => {
    if (inspectorSelection?.routeThreadIdentity === routeThreadIdentity) {
      if (inspectorSelection.mode === "files" && selectedThreadCwd === null) {
        return null;
      }
      return inspectorSelection.mode;
    }
    return null;
  })();
  useEffect(() => {
    if (
      fileInspector.supported &&
      selectedThreadCwd === null &&
      inspectorMode === null &&
      panes.auxiliaryPaneVisible
    ) {
      toggleAuxiliaryPane();
    }
  }, [
    fileInspector.supported,
    inspectorMode,
    panes.auxiliaryPaneVisible,
    selectedThreadCwd,
    toggleAuxiliaryPane,
  ]);

  useEffect(() => {
    setInspectorSelection((current) => {
      if (props.renderInspector === undefined) {
        if (current === null || current.mode === "route") {
          return null;
        }
        return { ...current, routeThreadIdentity };
      }

      if (current === null || current.mode === "route") {
        return { routeThreadIdentity, mode: "route" };
      }

      return { ...current, routeThreadIdentity };
    });
  }, [props.renderInspector, routeThreadIdentity]);

  useFocusEffect(
    useCallback(() => {
      return () => {
        if (props.renderInspector === undefined) {
          // Inspectors are contextual to this chat destination. Clear the
          // hidden chat copy after a native push so returning from Files,
          // Review, or Terminal cannot reserve an empty trailing pane.
          setInspectorSelection(null);
        }
      };
    }, [props.renderInspector]),
  );

  const routeEnvironmentRuntime = useRemoteEnvironmentRuntime(environmentId);
  const routeConnectionState =
    routeEnvironmentRuntime?.connectionState ?? (environmentId ? "available" : connectionState);
  const routeConnectionError = routeEnvironmentRuntime?.connectionError ?? null;
  const selectedThreadWithDraftSettings = useMemo(
    () =>
      selectedThread
        ? {
            ...selectedThread,
            modelSelection: composer.modelSelection ?? selectedThread.modelSelection,
            runtimeMode: composer.runtimeMode ?? selectedThread.runtimeMode,
            interactionMode: composer.interactionMode ?? selectedThread.interactionMode,
          }
        : null,
    [composer.interactionMode, composer.modelSelection, composer.runtimeMode, selectedThread],
  );

  const { threadHeaderItems } = useAppearancePreferences();
  const showsTerminalHeaderItem = threadHeaderItems.includes("terminal");
  /* ─── Native header theming ──────────────────────────────────────── */
  const usesNativeHeaderGlass = NATIVE_LIQUID_GLASS_SUPPORTED;
  // SSHCode has no projects to speak of: a chat in its machine's scratch folder names only the machine.
  const headerProjectTitle =
    selectedThreadProject &&
    !isScratchProject(
      selectedThreadProject,
      routeEnvironmentRuntime?.serverConfig?.scratchWorkspaceRoot ?? null,
    )
      ? selectedThreadProject.title
      : null;
  // With one machine, every chat is on it; its name would only repeat under each title.
  const hasOtherMachines = useWorkspaceEnvironments().length > 1;
  const headerSubtitle = [
    headerProjectTitle,
    hasOtherMachines || !headerProjectTitle
      ? (selectedEnvironmentConnection?.environmentLabel ?? null)
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const { sessions: knownTerminalSessions } = useKnownTerminalSessions({
    environmentId: showsTerminalHeaderItem ? (selectedThread?.environmentId ?? null) : null,
    threadId: showsTerminalHeaderItem ? (selectedThread?.id ?? null) : null,
  });
  const terminalMenuSessions = useMemo(
    () =>
      buildTerminalMenuSessions({
        knownSessions: knownTerminalSessions ?? [],
        workspaceRoot: selectedThreadProject?.workspaceRoot ?? null,
      }),
    [knownTerminalSessions, selectedThreadProject?.workspaceRoot],
  );
  const selectedThreadDetailWorktreePath = selectedThreadDetail?.thread.worktreePath ?? null;
  const handleReconnectEnvironment = useCallback(() => {
    if (!environmentId) {
      return;
    }
    onReconnectEnvironment(environmentId);
  }, [environmentId, onReconnectEnvironment]);

  /* ─── Git action progress (for overlay banner) ──────────────────── */
  const gitActionProgressTarget = useMemo(
    () => ({
      environmentId: selectedThread?.environmentId ?? null,
      cwd: selectedThreadCwd,
    }),
    [selectedThread?.environmentId, selectedThreadCwd],
  );
  const gitActionProgress = useGitActionProgress(gitActionProgressTarget);

  const handleOpenGitInspector = useCallback(() => {
    if (!fileInspector.supported) {
      if (selectedThread === null) {
        return;
      }
      navigation.navigate("GitOverview", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    setInspectorSelection({ routeThreadIdentity, mode: "git" });
    showAuxiliaryPane("inspector");
  }, [fileInspector.supported, navigation, routeThreadIdentity, selectedThread, showAuxiliaryPane]);
  const handleOpenFilesInspector = useCallback(() => {
    if (selectedThread === null || selectedThreadCwd === null) {
      return;
    }
    if (!fileInspector.supported) {
      navigation.navigate("ThreadFiles", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
      });
      return;
    }
    setInspectorSelection({
      routeThreadIdentity,
      mode: props.renderInspector === undefined ? "files" : "route",
    });
    showAuxiliaryPane("inspector");
  }, [
    fileInspector.supported,
    navigation,
    props.renderInspector,
    routeThreadIdentity,
    selectedThread,
    selectedThreadCwd,
    showAuxiliaryPane,
  ]);
  const inspectorToggleActionRef = useRef({
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  });
  inspectorToggleActionRef.current = {
    inspectorMode,
    openFilesInspector: handleOpenFilesInspector,
    toggleAuxiliaryPane,
  };
  const handleToggleInspector = useCallback(() => {
    const action = inspectorToggleActionRef.current;
    if (action.inspectorMode === null) {
      action.openFilesInspector();
      return;
    }
    action.toggleAuxiliaryPane();
  }, []);
  const handleSelectInspectorFile = useCallback(
    (path: string) => {
      if (selectedThread === null) {
        return;
      }
      const params = {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        path: path.split("/").filter((segment) => segment.length > 0),
      };
      if (fileInspector.supported) {
        navigation.navigate("ThreadFile", params);
        return;
      }
      navigation.navigate("ThreadFile", params);
    },
    [fileInspector.supported, navigation, selectedThread],
  );
  // The workspace inspector column spans the full window height. On iOS the
  // panes bring their own nested native headers (which underlap the status
  // bar); elsewhere the pane content pads itself below the top inset.
  const safeAreaInsets = useSafeAreaInsets();
  // The chat header floats over the content, so notices start below it.
  const navigationHeaderHeight = useContext(HeaderHeightContext) ?? safeAreaInsets.top + 44;
  const inspectorHeaderInset = Platform.OS === "ios" ? 0 : safeAreaInsets.top;
  const GitInspector = useCallback(
    () => (
      <GitOverviewSheet
        headerInset={inspectorHeaderInset}
        presentation="inspector"
        route={{ params: props.route.params }}
      />
    ),
    [inspectorHeaderInset, props.route.params],
  );
  const FilesInspector = useCallback(
    () =>
      selectedThread !== null && selectedThreadCwd !== null ? (
        <ThreadFileNavigatorPane
          cwd={selectedThreadCwd}
          environmentId={selectedThread.environmentId}
          headerInset={inspectorHeaderInset}
          projectName={selectedThreadProject?.title ?? "Files"}
          selectedPath={null}
          onSelectFile={handleSelectInspectorFile}
        />
      ) : null,
    [
      handleSelectInspectorFile,
      inspectorHeaderInset,
      selectedThread,
      selectedThreadCwd,
      selectedThreadProject?.title,
    ],
  );
  const RouteInspector = useCallback(
    () => props.renderInspector?.(inspectorHeaderInset),
    [inspectorHeaderInset, props.renderInspector],
  );
  const renderInspectorStack = useCallback(
    () =>
      inspectorMode === null ? null : (
        <ThreadInspectorContentStack
          renderFiles={FilesInspector}
          renderGit={GitInspector}
          mode={inspectorMode}
          resetKeys={[routeThreadIdentity, selectedThreadCwd]}
          renderRoute={props.renderInspector ? RouteInspector : undefined}
        />
      ),
    [
      FilesInspector,
      GitInspector,
      RouteInspector,
      inspectorMode,
      props.renderInspector,
      routeThreadIdentity,
      selectedThreadCwd,
    ],
  );
  const activeInspectorRenderer = inspectorMode === null ? undefined : renderInspectorStack;
  // Hand the inspector to the workspace so it renders beside the navigator,
  // outside this screen's native header — the terminal/git/files toolbar
  // stays anchored to the chat pane instead of floating above the inspector.
  useRegisterWorkspaceInspector(activeInspectorRenderer);

  const handleOpenConnectionEditor = useCallback(() => {
    void navigation.navigate("Connections");
  }, [navigation]);
  const stopMonitors = useThreadMonitors(
    composer.interruptibleRunId !== null ? (selectedThread?.environmentId ?? null) : null,
    composer.interruptibleRunId !== null ? (selectedThread?.id ?? null) : null,
  );
  const stopHelperSummary = describeThreadHelpers({
    subagents: selectedThreadDetail?.subagents ?? [],
    monitors: stopMonitors,
    pullRequests: selectedThreadDetail?.thread.pullRequests ?? [],
  });
  const handleStopThread = useCallback(() => {
    if (
      !selectedThread ||
      !readEnvironmentScope(selectedThread.environmentId, AuthOrchestrationOperateScope) ||
      composer.interruptibleRunId === null
    )
      return;
    const runId = composer.interruptibleRunId;
    const stop = (keepHelpers = false) =>
      void interruptThreadTurn({
        environmentId: selectedThread.environmentId,
        input: {
          threadId: selectedThread.id,
          runId,
          ...(keepHelpers ? { keepHelpers: true } : {}),
        },
      });
    if (stopHelperSummary === null) return stop();
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["Stop reply", "Stop everything", "Cancel"],
          message: stopHelperSummary,
          destructiveButtonIndex: 1,
          cancelButtonIndex: 2,
        },
        (index) => {
          if (index === 0) stop(true);
          else if (index === 1) stop();
        },
      );
    } else {
      Alert.alert("Stop", stopHelperSummary, [
        { text: "Stop reply", onPress: () => stop(true) },
        { text: "Stop everything", style: "destructive", onPress: () => stop() },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }, [composer.interruptibleRunId, interruptThreadTurn, selectedThread, stopHelperSummary]);

  const handleOpenTerminal = useCallback(
    (nextTerminalId?: string | null) => {
      terminalDebugLog("terminal-menu:open-existing", {
        terminalId: nextTerminalId ?? null,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (
        !selectedThread ||
        !selectedThreadProject?.workspaceRoot ||
        (!readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope) &&
          !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope))
      ) {
        return;
      }

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        ...(nextTerminalId ? { terminalId: nextTerminalId } : {}),
      });
    },
    [navigation, selectedThread, selectedThreadProject?.workspaceRoot],
  );

  const handleOpenNewTerminal = useCallback(() => {
    terminalDebugLog("terminal-menu:open-new", {
      hasThread: Boolean(selectedThread),
      hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
    });

    if (
      !selectedThread ||
      !selectedThreadProject?.workspaceRoot ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)
    ) {
      return;
    }

    const nextId = nextOpenTerminalId({
      listedTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
      ...(knownTerminalSessions === null ||
      !readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope)
        ? { uniqueSuffix: uuidv4() }
        : {}),
    });
    void navigation.navigate("ThreadTerminal", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      terminalId: nextId,
    });
  }, [
    knownTerminalSessions,
    navigation,
    selectedThread,
    selectedThreadProject?.workspaceRoot,
    terminalMenuSessions,
  ]);

  const handleRunProjectScript = useCallback(
    async (script: ProjectScript) => {
      terminalDebugLog("project-script:press", {
        scriptId: script.id,
        command: script.command,
        hasThread: Boolean(selectedThread),
        hasWorkspaceRoot: Boolean(selectedThreadProject?.workspaceRoot),
      });

      if (
        !selectedThread ||
        !selectedThreadProject?.workspaceRoot ||
        !readEnvironmentScope(selectedThread.environmentId, AuthTerminalOperateScope)
      ) {
        terminalDebugLog("project-script:abort", {
          scriptId: script.id,
          reason: "no-thread-workspace-or-terminal-access",
        });
        return;
      }

      const targetTerminalId = resolveProjectScriptTerminalId({
        existingTerminalIds: terminalMenuSessions.map((session) => session.terminalId),
        ...(knownTerminalSessions === null ||
        !readEnvironmentScope(selectedThread.environmentId, AuthTerminalReadScope)
          ? { uniqueSuffix: uuidv4() }
          : {}),
        hasRunningTerminal: terminalMenuSessions.some(
          (session) => session.status === "running" || session.status === "starting",
        ),
      });
      const preferredWorktreePath = resolvePreferredThreadWorktreePath({
        threadShellWorktreePath: selectedThread.worktreePath ?? null,
        threadDetailWorktreePath: selectedThreadDetailWorktreePath,
      });
      const cwd = projectScriptCwd({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      const env = projectScriptRuntimeEnv({
        project: { cwd: selectedThreadProject.workspaceRoot },
        worktreePath: preferredWorktreePath,
      });
      stagePendingTerminalLaunch({
        target: {
          environmentId: selectedThread.environmentId,
          threadId: selectedThread.id,
          terminalId: targetTerminalId,
        },
        launch: {
          cwd,
          worktreePath: preferredWorktreePath,
          env,
          initialInput: `${script.command}\r`,
        },
      });
      terminalDebugLog("project-script:staged", {
        scriptId: script.id,
        terminalId: targetTerminalId,
        cwd,
        worktreePath: preferredWorktreePath,
      });

      void navigation.navigate("ThreadTerminal", {
        environmentId: String(selectedThread.environmentId),
        threadId: String(selectedThread.id),
        terminalId: targetTerminalId,
      });
    },
    [
      navigation,
      selectedThread,
      selectedThreadDetailWorktreePath,
      selectedThreadProject,
      terminalMenuSessions,
      knownTerminalSessions,
    ],
  );
  // Same side chat `/btw` and `/side` open from the composer, with an empty
  // question, so it can be found without knowing the command.
  const sideChatKind = sideChatKindForDriver(
    routeEnvironmentRuntime?.serverConfig?.providers.find(
      (provider) => provider.instanceId === selectedThread?.modelSelection.instanceId,
    )?.driver,
  );
  const openSideChat = useCallback(() => {
    if (!selectedThread || sideChatKind === null) return;
    navigation.navigate("ThreadSideChat", {
      environmentId: String(selectedThread.environmentId),
      threadId: String(selectedThread.id),
      kind: sideChatKind,
    });
  }, [navigation, selectedThread, sideChatKind]);
  const headerSideChat = useMemo(
    () =>
      sideChatKind === null || !canOperateThread
        ? null
        : {
            label: sideChatKind === "btw" ? "Ask a side question (btw)" : "Open a side chat",
            onOpen: openSideChat,
          },
    [canOperateThread, openSideChat, sideChatKind],
  );
  const threadGitControlProps = {
    environmentId: environmentIdRaw ?? "",
    threadId: threadId ?? "",
    auxiliaryPaneControl:
      !layout.usesSplitView && fileInspector.supported && selectedThreadCwd !== null
        ? {
            accessibilityLabel: "Toggle inspector",
            onPress: handleToggleInspector,
          }
        : undefined,
    onOpenFilesInspector:
      fileInspector.supported && selectedThreadCwd !== null ? handleOpenFilesInspector : undefined,
    onOpenGitInspector: fileInspector.supported ? handleOpenGitInspector : undefined,
    onMergeBack:
      mergeBackTargetThreadId !== null && mergeBackRun !== null
        ? () => void handleMergeBack()
        : undefined,
    currentBranch: selectedThread?.branch ?? null,
    gitStatus: null,
    gitOperationLabel: gitActionState.currentLabel,
    canOpenTerminal:
      Boolean(selectedThreadProject?.workspaceRoot) && (canReadTerminal || canOperateTerminal),
    canOperateTerminal,
    canOpenFiles: Boolean(selectedThreadProject?.workspaceRoot),
    projectScripts: selectedThreadProject
      ? resolveProjectScripts(
          routeEnvironmentRuntime?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS,
          selectedThreadProject,
        )
      : [],
    terminalSessions: terminalMenuSessions,
    showDirectFileControl: layout.usesSplitView,
    onOpenTerminal: handleOpenTerminal,
    onOpenNewTerminal: handleOpenNewTerminal,
    onRunProjectScript: handleRunProjectScript,
    onPull: gitActions.onPullSelectedThreadBranch,
    onRunAction: gitActions.onRunSelectedThreadGitAction,
  };
  const handleEditFailedCreation = useCallback(async () => {
    const creation = selectedThreadCreation?.message;
    if (!creation?.creation || routeThreadIdentity === null) {
      return;
    }
    // The drain restored the prompt and attachments into the recovery draft
    // the rejected creation owns. Open that draft by id: without it the sheet
    // mints a fresh empty one and the restored content is unreachable.
    try {
      await recoverFailedThreadDraft(creation);
    } catch (error) {
      Alert.alert(
        "Could not restore draft",
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    clearPendingThreadCreationOutcome(routeThreadIdentity);
    navigation.dispatch(
      StackActions.replace("NewTaskSheet", {
        screen: "NewTaskDraft",
        params: {
          draftId: restoredNewTaskDraftKey(creation.messageId),
          environmentId: String(creation.environmentId),
          projectId: String(creation.creation.projectId),
          ...(selectedThreadProject ? { title: selectedThreadProject.title } : {}),
        },
      }),
    );
  }, [navigation, routeThreadIdentity, selectedThreadCreation, selectedThreadProject]);
  const setupTurnStartedAt = composer.selectedThreadActivityRun?.startedAt ?? null;
  const userMessageCount = useMemo(() => {
    let count = 0;
    for (const entry of composer.selectedThreadFeed) {
      if (entry.type === "message" && entry.message.role === "user") {
        count += 1;
      }
    }
    return count;
  }, [composer.selectedThreadFeed]);
  const { snapshot: worktreeSetupSnapshot, visible: worktreeSetup } = useWorktreeSetup({
    environmentId: selectedThread?.environmentId ?? null,
    threadId: selectedThread?.id ?? null,
    preparing:
      composer.selectedThreadActivityRun?.status === "preparing" ||
      selectedThread?.runtime?.status === "preparing" ||
      selectedThread?.worktreePath != null ||
      (selectedThreadCreation?.message.creation?.workspaceMode === "worktree" &&
        selectedThreadCreation.outcome == null),
    turnStarted: setupTurnStartedAt !== null,
    followUpSent: userMessageCount + composer.selectedThreadQueueCount > 1,
  });
  const awaitingBootstrapTurn =
    worktreeSetup !== null
      ? worktreeSetup.phase === "running" && !worktreeSetupAgentStarted(worktreeSetup)
      : (selectedThreadDetail?.runs.some((run) => run.status === "preparing") ?? false);
  const cancelWorktreeSetup = useAtomCommand(vcsEnvironment.cancelWorktreeSetup);
  const handleCancelWorktreeSetup = useCallback(() => {
    if (!selectedThread) return;
    void cancelWorktreeSetup({
      environmentId: selectedThread.environmentId,
      input: { threadId: selectedThread.id },
    });
  }, [cancelWorktreeSetup, selectedThread]);
  const startLocalThread = useAtomCommand(threadEnvironment.startTurn, "work locally");
  const localResendBusy = useRef(false);
  const setupMessage = selectedThreadDetail?.messages.find((message) => message.role === "user");
  const handleWorkLocally = useCallback(async () => {
    if (!selectedThread || !selectedThreadProject || !setupMessage || localResendBusy.current)
      return;
    localResendBusy.current = true;
    try {
      const result = await cancelWorktreeSetup({
        environmentId: selectedThread.environmentId,
        input: { threadId: selectedThread.id },
      });
      if (result._tag !== "Success" || !result.value.cancelled) return;
      // V2 accepts the launch before setup runs, so cancellation never rejects
      // the original outbox delivery. Reuse the server-owned prompt and uploads.
      const metadata = makeTurnCommandMetadata();
      const launched = await startLocalThread({
        environmentId: selectedThread.environmentId,
        input: buildProjectThreadStartTurnInput({
          ...metadata,
          projectId: selectedThread.projectId,
          projectCwd: selectedThreadProject.workspaceRoot,
          text: setupMessage.text,
          ...(setupMessage.context ? { context: setupMessage.context } : {}),
          uploadedAttachments: setupMessage.attachments,
          modelSelection: selectedThread.modelSelection,
          runtimeMode: selectedThread.runtimeMode,
          interactionMode: selectedThread.interactionMode,
          workspaceMode: "local",
          branch: null,
          worktreePath: null,
          startFromOrigin: false,
          worktreeBranchName: "",
        }),
      });
      if (launched._tag !== "Success") return;
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: String(selectedThread.environmentId),
          threadId: metadata.threadId,
        }),
      );
    } finally {
      localResendBusy.current = false;
    }
  }, [
    cancelWorktreeSetup,
    navigation,
    selectedThread,
    selectedThreadProject,
    setupMessage,
    startLocalThread,
  ]);
  const creationState = useMemo((): ThreadDetailScreenProps["creationState"] => {
    if (selectedThreadCreation === null) {
      return awaitingBootstrapTurn
        ? { kind: "preparing", preparingWorktree: true, serverOwned: true }
        : null;
    }
    if (selectedThreadCreation.outcome?.kind === "failed") {
      return {
        kind: "failed",
        reason: selectedThreadCreation.outcome.reason,
        onEditTask: handleEditFailedCreation,
      };
    }
    return {
      kind: "preparing",
      preparingWorktree: selectedThreadCreation.message.creation?.workspaceMode === "worktree",
      serverOwned: false,
    };
  }, [awaitingBootstrapTurn, handleEditFailedCreation, selectedThreadCreation]);
  // A queued creation renders as ready content: its prompt is the whole
  // conversation until the server creates the thread. The subscription's
  // not-found error for that window is expected, not a load failure.
  const hasDetail = selectedThreadDetail !== null;
  const detailError = Option.getOrNull(selectedThreadDetailState.error);
  const detailDeleted = selectedThreadDetailState.status === "deleted";
  const contentPresentation = useMemo(
    () =>
      creationState !== null
        ? { kind: "ready" as const }
        : projectThreadContentPresentation({
            hasDetail,
            detailError,
            detailDeleted,
            connectionState: routeConnectionState,
          }),
    [creationState, hasDetail, detailError, detailDeleted, routeConnectionState],
  );
  const providerTurns = selectedThreadDetail?.providerTurns;
  const providerThreads = selectedThreadDetail?.providerThreads;
  const activeProviderThreadId = selectedThreadDetail?.thread.activeProviderThreadId;
  const usageContext = useMemo(() => {
    let latest: import("@t3tools/contracts").OrchestrationV2ProviderTurnTokenUsage | null = null;
    let latestUpdatedAt = -Infinity;
    if (providerTurns) {
      for (const turn of providerTurns) {
        if (!turn.tokenUsage) continue;
        const updatedAt = Date.parse(turn.tokenUsage.updatedAt);
        if (!latest || updatedAt >= latestUpdatedAt) {
          latest = turn.tokenUsage;
          latestUpdatedAt = updatedAt;
        }
      }
    }
    if (latest) return latest;
    return providerThreads?.find((p) => p.id === activeProviderThreadId)?.contextUsage ?? null;
  }, [providerTurns, providerThreads, activeProviderThreadId]);
  const attempts = selectedThreadDetail?.attempts;
  const runningGeneration = useMemo(() => {
    if (!providerTurns || !attempts) return undefined;
    // The newest running turn: an older one left "running" must not lend its rate.
    const running = providerTurns.findLast(
      (turn) => turn.runAttemptId !== null && isOrchestrationV2WorkActive(turn.status),
    );
    const runId = attempts.find((attempt) => attempt.id === running?.runAttemptId)?.runId;
    return runId === undefined ? undefined : generationsByRun(attempts, providerTurns).get(runId);
  }, [attempts, providerTurns]);
  const handleMediaJumpHandled = useCallback((sequence: number) => {
    setMediaJump((current) => (current?.sequence === sequence ? null : current));
  }, []);
  const hasLocalWorktreeFallback = Boolean(setupMessage && selectedThreadProject);
  const worktreeSetupWorking = composer.activeWorkStartedAt !== null;
  const worktreeSetupProp = useMemo(
    () =>
      worktreeSetup
        ? {
            snapshot: worktreeSetup,
            turnStartedAt: setupTurnStartedAt,
            working: worktreeSetupWorking,
            turnStarted: setupTurnStartedAt !== null,
            onCancel: handleCancelWorktreeSetup,
            onWorkLocally: hasLocalWorktreeFallback ? handleWorkLocally : null,
          }
        : null,
    [
      worktreeSetup,
      setupTurnStartedAt,
      worktreeSetupWorking,
      handleCancelWorktreeSetup,
      hasLocalWorktreeFallback,
      handleWorkLocally,
    ],
  );
  const activePendingUserInputRequestId = requests.activePendingUserInput?.requestId ?? null;
  const visibleRequestIds = useMemo(
    () => (activePendingUserInputRequestId ? [activePendingUserInputRequestId] : []),
    [activePendingUserInputRequestId],
  );
  if (!environmentId || !threadId) {
    return <OpeningThreadLoadingScreen />;
  }

  if (!selectedThread) {
    return <OpeningThreadLoadingScreen />;
  }

  const serverConfig = routeEnvironmentRuntime?.serverConfig ?? null;
  const findMode = threadFindMode(serverConfig);
  const renderThreadRouteBody = () => (
    <>
      <GitActionProgressOverlay
        progress={gitActionProgress}
        onDismiss={dismissGitActionResult}
        onOpenPullRequest={openPullRequest}
      />

      <PendingSendNotice
        top={navigationHeaderHeight + 8}
        environmentId={environmentId}
        threadId={selectedThread.id}
        visibleRequestIds={visibleRequestIds}
        onOpenSideChat={openSideChat}
      />
      <ThreadPane>
        <ThreadDetailScreen
          usageContext={usageContext}
          canOperateThread={canOperateThread}
          selectedThread={selectedThreadWithDraftSettings ?? selectedThread}
          selectedThreadDetailRef={selectedThreadDetailRef}
          mediaJump={
            mediaJump?.threadKey ===
            scopedThreadKey(selectedThread.environmentId, selectedThread.id)
              ? mediaJump
              : null
          }
          onMediaJumpHandled={handleMediaJumpHandled}
          findAnchorReader={findOpen && findMode ? findAnchorReader : undefined}
          findBar={
            findOpen && selectedThreadDetailRef && findMode ? (
              <ThreadFindBar
                key={scopedThreadKey(selectedThread.environmentId, selectedThread.id)}
                environmentId={selectedThread.environmentId}
                threadId={selectedThread.id}
                progressive={findMode === "progressive"}
                contentRevision={findContent ?? null}
                readAnchor={readFindAnchor}
                onReveal={revealFindEntry}
                onClose={closeFindInChat}
              />
            ) : null
          }
          contentPresentation={contentPresentation}
          screenTone={connectionTone(routeConnectionState)}
          connectionError={routeConnectionError}
          environmentLabel={selectedEnvironmentConnection?.environmentLabel ?? null}
          feedbackSubmissions={composer.feedbackSubmissions}
          onDismissFeedback={composer.dismissFeedback}
          selectedThreadFeed={composer.selectedThreadFeed}
          pendingHandoff={composer.pendingHandoff}
          activityRun={composer.selectedThreadActivityRun}
          avatarRuns={selectedThreadDetail?.runs}
          feedbackRuns={selectedThreadDetail?.runs ?? null}
          activeWorkStartedAt={
            creationState?.kind === "preparing" ||
            (worktreeSetup !== null && setupTurnStartedAt === null)
              ? null
              : composer.activeWorkStartedAt
          }
          runningGeneration={runningGeneration}
          isCompacting={composer.isCompacting}
          runlessWorkActive={composer.runlessWorkActive}
          providerSubagentStatus={composer.providerSubagentStatus}
          creationState={creationState}
          setupWorkingStartedAt={
            composer.activeWorkStartedAt !== null &&
            worktreeSetupSnapshot !== null &&
            userMessageCount <= 1
              ? composer.activeWorkStartedAt
              : null
          }
          worktreeSetup={worktreeSetupProp}
          activePendingApproval={requests.activePendingApproval}
          respondingApprovalId={requests.respondingApprovalId}
          activePendingUserInput={requests.activePendingUserInput}
          activePendingUserInputQuestionId={requests.activePendingUserInputQuestionId}
          activePendingUserInputDrafts={requests.activePendingUserInputDrafts}
          activePendingUserInputAnswers={requests.activePendingUserInputAnswers}
          respondingUserInputId={requests.respondingUserInputId}
          userInputDeliveryStatus={requests.userInputDeliveryStatus}
          draftMessage={composer.draftMessage}
          draftAttachments={composer.draftAttachments}
          connectionStateLabel={routeConnectionState}
          threadSyncStatus={selectedThreadDetailState.status}
          historyControls={historyControls}
          activeThreadBusy={composer.activeThreadBusy}
          canStopThread={awaitingBootstrapTurn || composer.interruptibleRunId !== null}
          queuedRunEdit={composer.queuedRunEdit}
          composerDraftKey={composer.composerDraftKey}
          followUpBehavior={composer.followUpBehavior}
          canSteerActiveTurn={composer.canSteerActiveTurn}
          steerWait={steerWait}
          onSendSteerNow={sendSteerNow}
          isSavingQueuedEdit={composer.isSavingQueuedEdit}
          onCancelQueuedRunEdit={composer.cancelQueuedRunEdit}
          onRemoveQueuedEditAttachment={composer.onRemoveQueuedEditAttachment}
          environmentId={selectedThread.environmentId}
          projectWorkspaceRoot={selectedThreadProject?.workspaceRoot ?? null}
          threadCwd={selectedThreadCwd}
          selectedThreadQueueCount={composer.selectedThreadQueueCount}
          queuedMessages={composer.selectedThreadQueuedMessages}
          dispatchingMessageId={composer.dispatchingQueuedMessageId}
          layoutVariant={layout.variant}
          usesAutomaticContentInsets={usesNativeHeaderGlass}
          onOpenConnectionEditor={handleOpenConnectionEditor}
          onChangeDraftMessage={composer.onChangeDraftMessage}
          onPickDraftMedia={composer.onPickDraftMedia}
          onPickDraftFiles={composer.onPickDraftFiles}
          onNativePasteImages={composer.onNativePasteImages}
          onNativePasteText={composer.onNativePasteText}
          onRemoveDraftImage={composer.onRemoveDraftImage}
          serverConfig={serverConfig}
          onStopThread={awaitingBootstrapTurn ? handleCancelWorktreeSetup : handleStopThread}
          onSendMessage={composer.onSendMessage}
          onReconnectEnvironment={handleReconnectEnvironment}
          canSwitchThreadProvider={composer.canSwitchThreadProvider}
          onUpdateThreadModelSelection={composer.onUpdateModelSelection}
          onUpdateThreadRuntimeMode={composer.onUpdateRuntimeMode}
          onUpdateThreadInteractionMode={composer.onUpdateInteractionMode}
          onRespondToApproval={requests.onRespondToApproval}
          onSelectUserInputOption={requests.onSelectUserInputOption}
          onChangeUserInputCustomAnswer={requests.onChangeUserInputCustomAnswer}
          onSubmitUserInput={requests.onSubmitUserInput}
          onDismissUserInput={requests.onDismissUserInput}
        />
      </ThreadPane>
    </>
  );

  const harnessDriver = resolveMobileHarnessDriver({
    thread: selectedThreadWithDraftSettings ?? selectedThread,
    providers: serverConfig?.providers ?? [],
    providerInstances: serverConfig?.settings.providerInstances,
  });
  return (
    <HarnessThemeScope driver={harnessDriver}>
      {activeInspectorRenderer ? <InspectorPaneRoleActivation /> : null}
      <ThreadHeader
        title={selectedThread.title}
        subtitle={headerSubtitle}
        usesNativeHeaderGlass={usesNativeHeaderGlass}
        gitControls={threadGitControlProps}
        hasThreadCwd={selectedThreadCwd !== null}
        hasWorkspaceRoot={Boolean(selectedThreadProject?.workspaceRoot)}
        fileInspectorSupported={fileInspector.supported}
        inspectorMode={inspectorMode}
        onToggleInspector={handleToggleInspector}
        onOpenGitInspector={handleOpenGitInspector}
        onOpenFilesInspector={handleOpenFilesInspector}
        onReturnToThread={props.onReturnToThread}
        sideChat={headerSideChat}
        onFindInChat={selectedThreadDetailRef && findMode ? openFindInChat : undefined}
        onOpenMedia={
          !mediaSearch && (hasThreadMedia || selectedThreadDetailState.history.historyCursor)
            ? () => void openMedia()
            : undefined
        }
      />
      {mediaOpen ? (
        <ThreadMediaGallery
          items={threadMedia}
          environmentId={selectedThread.environmentId}
          threadId={selectedThread.id}
          historyCursor={mediaSeed?.cursor ?? null}
          initialItems={mediaSeed?.items ?? []}
          initialPartial={mediaSeed?.partial ?? false}
          onClose={() => setMediaOpen(false)}
          onShowInChat={showMediaInChat}
        />
      ) : null}

      {renderThreadRouteBody()}
    </HarnessThemeScope>
  );
}
